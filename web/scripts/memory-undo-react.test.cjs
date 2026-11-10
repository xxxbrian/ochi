const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://client.example.invalid/" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback) => setTimeout(callback, 1), cancelAnimationFrame: clearTimeout,
});
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const React = require("react");
const { render, act, cleanup, fireEvent } = require("@testing-library/react");
const { createLoader } = require("../../shared/conversation/test-loader.cjs");
const { createI18nHarness } = require("./i18n-harness.cjs");
const root = path.resolve(__dirname, "../..");
const memory = (id) => ({ id, content: `Memory ${id}`, kind: "fact", admission: "curated", source: "user", created_at: "2026-11-01T00:00:00Z" });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(t, api = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const locale = createI18nHarness("en");
  const load = createLoader(require("typescript"), require, {
    [path.join(root, "web/src/lib/i18n.ts")]: locale.web,
    [path.join(root, "web/src/lib/api.ts")]: { api: {
      memories: async () => [memory("A"), memory("B")],
      deleteMemory: async (id) => { calls.push(id); },
      ...api,
    } },
    [path.join(root, "web/src/components/settings/usePreferences.ts")]: { usePreferences: () => ({
      preferences: { memory_enabled: true }, error: "", update: async () => true,
    }) },
    [path.join(root, "web/src/components/ui/Select.tsx")]: { SelectField: () => null },
  });
  const { ToastHost, toast } = load(path.join(root, "web/src/components/ui/Toast.tsx"));
  const { useMemories, releaseMemoryOwner } = load(path.join(root, "web/src/components/settings/memoryStore.ts"));
  const { MemoryTab } = load(path.join(root, "web/src/components/settings/MemoryTab.tsx"));
  let current;
  function Probe({ account }) {
    current = useMemories(account);
    return React.createElement("div", {},
      ...current.memories.map((value) => React.createElement("button", { key: value.id, onClick: () => current.remove(value) }, value.content)),
      current.error && React.createElement("p", { role: "alert" }, current.error));
  }
  function Shell({ show = true, host = true, account = "fixture-A", actual = false }) {
    return React.createElement(React.Fragment, {},
      host && React.createElement(ToastHost, { key: account }),
      show && React.createElement(actual ? MemoryTab : Probe, { account, accountId: account, projects: [], onClose: () => undefined }));
  }
  t.after(() => {
    cleanup();
    releaseMemoryOwner("fixture-A");
    releaseMemoryOwner("fixture-B");
  });
  return { Shell, calls, toast, releaseMemoryOwner, current: () => current, t: locale.web.t };
}
async function mount(Shell, props = {}) {
  let view;
  await act(async () => { view = render(React.createElement(Shell, props)); await flush(); });
  return view;
}
async function click(element) {
  await act(async () => { fireEvent.click(element); await flush(); });
}
async function tick(t, ms) {
  await act(async () => { t.mock.timers.tick(ms); await flush(); });
}

test("one row owns one collapse and Undo action even after a duplicate delete", async (t) => {
  const value = setup(t);
  const view = await mount(value.Shell);
  await act(async () => {
    const state = value.current();
    state.remove(state.memories[0]);
    state.remove(state.memories[0]);
  });
  assert.equal(value.current().leaving.size, 1);
  await tick(t, 300);
  assert.equal(view.queryByText("Memory A"), null);
  assert.equal(view.getAllByRole("button", { name: "Undo" }).length, 1);
  await click(view.getByRole("button", { name: "Undo" }));
  assert.ok(view.getByText("Memory A"));
  await tick(t, 10_000);
  assert.deepEqual(value.calls, []);
  assert.equal(view.queryByRole("button", { name: "Undo" }), null);
});

test("closing and reopening the real Memory tab preserves a usable Undo without an early DELETE", async (t) => {
  const value = setup(t);
  const view = await mount(value.Shell, { actual: true });
  await click(view.getAllByRole("button", { name: value.t("memory.delete") })[0]);
  await tick(t, 300);
  await act(async () => { view.rerender(React.createElement(value.Shell, { show: false, actual: true })); });
  assert.deepEqual(value.calls, []);
  assert.ok(view.getByRole("button", { name: "Undo" }));
  await act(async () => { view.rerender(React.createElement(value.Shell, { actual: true })); await flush(); });
  assert.equal(view.queryByText("Memory A"), null, "a remount GET cannot make an optimistically deleted row reappear");
  await click(view.getByRole("button", { name: "Undo" }));
  assert.equal(view.getAllByText("Memory A").length, 1);
  await tick(t, 10_000);
  assert.deepEqual(value.calls, []);
});

test("deleting a second row does not commit the first or change its independent Undo window", async (t) => {
  const value = setup(t);
  const view = await mount(value.Shell);
  await click(view.getByText("Memory A"));
  await tick(t, 300);
  await tick(t, 1000);
  await click(view.getByText("Memory B"));
  await tick(t, 300);
  assert.deepEqual(value.calls, []);
  const undo = view.getAllByRole("button", { name: "Undo" });
  await click(undo[0]);
  await click(undo[1]);
  assert.deepEqual(value.current().memories.map((entry) => entry.id), ["A", "B"], "Undo preserves collection order");
  await tick(t, 10_000);
  assert.deepEqual(value.calls, []);
});

test("expiry removes the action before fading and submits exactly one DELETE", async (t) => {
  const pending = deferred();
  const calls = [];
  const value = setup(t, { deleteMemory: (id) => { calls.push(id); return pending.promise; } });
  const view = await mount(value.Shell);
  await click(view.getByText("Memory A"));
  await tick(t, 300);
  const oldButton = view.getByRole("button", { name: "Undo" });
  await tick(t, 6000);
  assert.deepEqual(calls, ["A"]);
  assert.equal(view.queryByRole("button", { name: "Undo" }), null);
  await click(oldButton);
  assert.equal(view.queryByText("Memory A"), null);
  await act(async () => { pending.resolve(); await flush(); });
  await tick(t, 10_000);
  assert.deepEqual(calls, ["A"]);
});

test("a failed DELETE restores its row and supports a new explicit retry", async (t) => {
  let fail = true;
  const calls = [];
  const value = setup(t, { deleteMemory: async (id) => {
    calls.push(id);
    if (fail) throw new Error("Synthetic deletion failure");
  } });
  const view = await mount(value.Shell);
  await click(view.getByText("Memory A"));
  await tick(t, 300);
  await tick(t, 6000);
  assert.ok(view.getByText("Memory A"));
  assert.equal(view.getByRole("alert").textContent, "Synthetic deletion failure");
  fail = false;
  await click(view.getByText("Memory A"));
  await tick(t, 300);
  await tick(t, 6000);
  assert.deepEqual(calls, ["A", "A"]);
  assert.equal(view.queryByText("Memory A"), null);
});

test("a GET crossing DELETE completion cannot restore the server's stale row", async (t) => {
  const deleting = deferred();
  const reading = deferred();
  let reads = 0;
  const value = setup(t, {
    memories: () => ++reads === 1 ? Promise.resolve([memory("A"), memory("B")]) : reading.promise,
    deleteMemory: () => deleting.promise,
  });
  const view = await mount(value.Shell);
  await click(view.getByText("Memory A"));
  await tick(t, 300);
  await tick(t, 6000);
  await act(async () => { void value.current().reload(); await flush(); });
  await act(async () => { deleting.resolve(); await flush(); });
  await act(async () => { reading.resolve([memory("A"), memory("B")]); await flush(); });
  assert.deepEqual(value.current().memories.map((entry) => entry.id), ["B"]);
});

test("host removal or owner release cancels pending Undo rather than deleting under a new account", async (t) => {
  const value = setup(t);
  const view = await mount(value.Shell);
  await click(view.getByText("Memory A"));
  await tick(t, 300);
  await act(async () => { view.rerender(React.createElement(value.Shell, { show: false, host: false })); });
  await tick(t, 10_000);
  assert.deepEqual(value.calls, []);
  await act(async () => { view.rerender(React.createElement(value.Shell)); await flush(); });
  assert.ok(view.getByText("Memory A"));
  await click(view.getByText("Memory A"));
  await act(async () => { value.releaseMemoryOwner("fixture-A"); view.rerender(React.createElement(value.Shell, { account: "fixture-B" })); await flush(); });
  await tick(t, 10_000);
  assert.deepEqual(value.calls, []);
  assert.deepEqual(value.current().memories.map((entry) => entry.id), ["A", "B"]);
});

test("a late result from a released owner cannot update the new account's collection", async (t) => {
  const deleting = deferred();
  const value = setup(t, { deleteMemory: () => deleting.promise });
  const view = await mount(value.Shell);
  await click(view.getByText("Memory A"));
  await tick(t, 300);
  await tick(t, 6000);
  await act(async () => { value.releaseMemoryOwner("fixture-A"); view.rerender(React.createElement(value.Shell, { account: "fixture-B" })); await flush(); });
  await act(async () => { deleting.reject(new Error("Old account response")); await flush(); });
  assert.deepEqual(value.current().memories.map((entry) => entry.id), ["A", "B"]);
  assert.equal(view.queryByRole("alert"), null);
});

test("a toast action runs once and cannot survive its host unmount", async (t) => {
  const value = setup(t);
  const view = await mount(value.Shell, { show: false });
  let actions = 0;
  const reasons = [];
  await act(async () => { value.toast("Action fixture", { action: { label: "Act", run: () => actions++ }, onDismiss: (reason) => reasons.push(reason) }); });
  const action = view.getByRole("button", { name: "Act" });
  await click(action);
  await click(action);
  assert.equal(actions, 1);
  assert.deepEqual(reasons, ["action"]);
  await act(async () => { value.toast("Unmount fixture", { action: { label: "Act again", run: () => actions++ }, onDismiss: (reason) => reasons.push(reason) }); });
  await act(async () => { view.rerender(React.createElement(value.Shell, { show: false, host: false })); });
  await tick(t, 10_000);
  assert.equal(actions, 1);
  assert.deepEqual(reasons, ["action", "unmount"]);
  assert.equal(view.queryByRole("button", { name: "Act again" }), null);
});
