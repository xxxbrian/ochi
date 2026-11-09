const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://client.example.invalid/" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback) => setTimeout(callback, 1), cancelAnimationFrame: clearTimeout,
});
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const React = require("react");
const { render, act, cleanup, fireEvent, within } = require("@testing-library/react");
const { createLoader } = require("../../shared/conversation/test-loader.cjs");
const { createI18nHarness } = require("./i18n-harness.cjs");
const root = path.resolve(__dirname, "../..");
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const locale = createI18nHarness("en");
  const load = createLoader(require("typescript"), require, {
    [path.join(root, "web/src/lib/i18n.ts")]: locale.web,
  });
  const { Modal } = load(path.join(root, "web/src/components/Modal.tsx"));
  const { ToastHost, toast } = load(path.join(root, "web/src/components/ui/Toast.tsx"));
  const reasons = [];
  let actions = 0;
  let closed = 0;
  function Shell({ modal = true, nested = false, globalHost = true }) {
    return React.createElement(React.Fragment, {},
      modal && React.createElement(Modal, { title: "Settings", onClose: () => closed++ },
        React.createElement("input", { "aria-label": "Draft", defaultValue: "Unchanged text" }),
        nested && React.createElement(Modal, { title: "Nested editor", onClose: () => closed++ }, "Nested content")),
      // The app host mounts after modal descendants; modal priority must still win.
      globalHost && React.createElement(ToastHost));
  }
  t.after(cleanup);
  return {
    Shell, reasons, actions: () => actions, closed: () => closed,
    notify: () => toast("Memory deleted", {
      action: { label: "Undo", run: () => actions++ },
      onDismiss: (reason) => reasons.push(reason),
    }),
  };
}
async function tick(t, ms) {
  await act(async () => { t.mock.timers.tick(ms); await flush(); });
}
async function mount(t, Shell, props = {}) {
  let view;
  await act(async () => { view = render(React.createElement(Shell, props)); await flush(); });
  await tick(t, 10);
  await tick(t, 10);
  return view;
}
async function notify(t, value) {
  await act(async () => { value.notify(); await flush(); });
  await tick(t, 2);
  await tick(t, 2);
}
async function rerender(t, view, Shell, props) {
  await act(async () => { view.rerender(React.createElement(Shell, props)); await flush(); });
  await tick(t, 10);
  await tick(t, 10);
}

test("actual Base UI modal owns the only Undo action and keeps its editor open", async (t) => {
  const value = setup(t);
  const view = await mount(t, value.Shell);
  await notify(t, value);
  const dialog = view.getByRole("dialog", { name: "Settings" });
  const action = within(dialog).getByRole("button", { name: "Undo" });
  assert.equal(view.getAllByRole("button", { name: "Undo" }).length, 1);
  assert.equal(action.closest(".toasts").dataset.modal, "true");
  await act(async () => { fireEvent.click(action); fireEvent.click(action); await flush(); });
  assert.equal(value.actions(), 1);
  assert.deepEqual(value.reasons, ["action"]);
  assert.equal(view.getByRole("dialog"), dialog);
  assert.equal(within(dialog).getByRole("textbox", { name: "Draft" }).value, "Unchanged text");
  assert.equal(value.closed(), 0);
  await tick(t, 10_000);
  assert.deepEqual(value.reasons, ["action"]);
});

test("closing a modal hands Undo to the app without restarting its original deadline", async (t) => {
  const value = setup(t);
  const view = await mount(t, value.Shell);
  await notify(t, value);
  await tick(t, 3000);
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Close" })); await flush(); });
  await tick(t, 10);
  await tick(t, 10);
  const action = view.getByRole("button", { name: "Undo" });
  assert.equal(action.closest('[role="dialog"]'), null);
  assert.equal(value.closed(), 1);
  assert.deepEqual(value.reasons, []);
  await tick(t, 2900);
  assert.ok(view.getByRole("button", { name: "Undo" }));
  await tick(t, 100);
  assert.equal(view.queryByRole("button", { name: "Undo" }), null);
  assert.deepEqual(value.reasons, ["timeout"]);
  assert.equal(value.actions(), 0);
});

test("the same pending action remains usable after closing and reopening Settings", async (t) => {
  const value = setup(t);
  const view = await mount(t, value.Shell);
  await notify(t, value);
  await rerender(t, view, value.Shell, { modal: false });
  await rerender(t, view, value.Shell, { modal: true });
  const dialog = view.getByRole("dialog", { name: "Settings" });
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Undo" })); await flush(); });
  assert.equal(value.actions(), 1);
  assert.deepEqual(value.reasons, ["action"]);
});

test("nested modals route pending actions to the deepest boundary and back without duplicates", async (t) => {
  const value = setup(t);
  const view = await mount(t, value.Shell);
  await rerender(t, view, value.Shell, { nested: true });
  await tick(t, 10);
  await notify(t, value);
  const nested = view.getByRole("dialog", { name: "Nested editor" });
  assert.ok(within(nested).getByRole("button", { name: "Undo" }));
  assert.equal(document.querySelectorAll(".toast-act").length, 1);
  await rerender(t, view, value.Shell, { nested: false });
  const settings = view.getByRole("dialog", { name: "Settings" });
  assert.ok(within(settings).getByRole("button", { name: "Undo" }));
  assert.equal(document.querySelectorAll(".toast-act").length, 1);
  assert.deepEqual(value.reasons, []);
});

test("only removal of the final host cancels a pending action", async (t) => {
  const value = setup(t);
  const view = await mount(t, value.Shell);
  await notify(t, value);
  await rerender(t, view, value.Shell, { modal: false, globalHost: true });
  assert.deepEqual(value.reasons, []);
  const oldAction = view.getByRole("button", { name: "Undo" });
  await rerender(t, view, value.Shell, { modal: false, globalHost: false });
  assert.deepEqual(value.reasons, ["unmount"]);
  await act(async () => { fireEvent.click(oldAction); await flush(); });
  await tick(t, 10_000);
  assert.equal(value.actions(), 0);
  assert.deepEqual(value.reasons, ["unmount"]);
});
