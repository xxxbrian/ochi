const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://client.example.invalid/" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
});
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const React = require("react");
const { render, act, cleanup, fireEvent, within } = require("@testing-library/react");
const { createLoader } = require("../../shared/conversation/test-loader.cjs");
const { createI18nHarness } = require("./i18n-harness.cjs");
const root = path.resolve(__dirname, "../..");
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 35)); for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(api = {}) {
  const locale = createI18nHarness("en");
  const load = createLoader(require("typescript"), require, {
    [path.join(root, "web/src/lib/i18n.ts")]: locale.web,
    [path.join(root, "web/src/pages/admin/i18n.ts")]: locale.admin,
    [path.join(root, "web/src/lib/api.ts")]: { adminApi: api },
    [path.join(root, "web/src/pages/admin/IntegrationsPage.tsx")]: { SkillsPage: () => null, MCPPage: () => null },
  });
  return {
    ...load(path.join(root, "web/src/components/Modal.tsx")),
    PluginsPage: load(path.join(root, "web/src/pages/admin/PluginsPage.tsx")).default,
    t: locale.admin.t,
  };
}
async function mount(Component, props = {}) {
  let view;
  await act(async () => { view = render(React.createElement(Component, props)); await flush(); });
  await act(async () => { await flush(); });
  return view;
}
async function click(element) {
  await act(async () => { fireEvent.click(element); await flush(); });
}
async function escape(element) {
  await act(async () => { fireEvent.keyDown(element, { key: "Escape" }); await flush(); });
}
async function backdrop() {
  const node = document.querySelector(".scrim");
  assert.ok(node);
  await act(async () => {
    fireEvent.mouseDown(node, { button: 0 });
    fireEvent.mouseUp(node, { button: 0 });
    fireEvent.click(node, { button: 0 });
    await flush();
  });
}
test.afterEach(cleanup);

test("Base UI dismissal cannot hide a non-dismissible modal before the owner accepts it", async () => {
  const { Modal } = setup();
  let closed = 0;
  const props = { title: "Pending fixture", dismissible: false, onClose: () => closed++, children: React.createElement("input", { "aria-label": "Fixture editor", defaultValue: "Unsaved text" }) };
  const view = await mount(Modal, props);
  const dialog = view.getByRole("dialog");
  const editor = view.getByRole("textbox", { name: "Fixture editor" });
  assert.equal(view.getByRole("button", { name: "Close" }).disabled, true);
  await click(view.getByRole("button", { name: "Close" }));
  await escape(dialog);
  await backdrop();
  assert.equal(view.getByRole("dialog"), dialog);
  assert.equal(view.getByRole("textbox", { name: "Fixture editor" }), editor);
  assert.equal(editor.value, "Unsaved text");
  assert.equal(closed, 0);
  await act(async () => { view.rerender(React.createElement(Modal, { ...props, dismissible: true })); await flush(); });
  await escape(dialog);
  assert.equal(closed, 1);
  assert.equal(view.queryByRole("dialog"), null);
});

test("a plugin save failure retains its actual editor after Escape, X and backdrop attempts", async () => {
  const plugin = { id: "fixture", name: "Synthetic Plugin", description: "Fixture description", enabled: true, default_enabled: false, skill_ids: ["skill-fixture"], mcp_ids: [] };
  let result = deferred();
  const calls = [];
  const { PluginsPage, t } = setup({
    plugins: async () => [plugin],
    pluginComponents: async () => ({ skills: [{ id: "skill-fixture", name: "Synthetic skill" }], mcp: [] }),
    savePlugin: (value, existing) => { calls.push({ value, existing }); return result.promise; },
  });
  const view = await mount(PluginsPage, { section: "plugins", onNavigate: () => undefined });
  await click(view.getByRole("button", { name: /^Synthetic Plugin/ }));
  const dialog = view.getByRole("dialog", { name: t("editPlugin") });
  const name = within(dialog).getByRole("textbox", { name: t("name") });
  await act(async () => { fireEvent.change(name, { target: { value: "Changed Plugin" } }); });
  await click(within(dialog).getByRole("button", { name: t("save"), exact: true }));
  assert.equal(calls.length, 1);
  assert.equal(within(dialog).getByRole("button", { name: "Close" }).disabled, true);
  await click(within(dialog).getByRole("button", { name: "Close" }));
  await escape(dialog);
  await backdrop();
  assert.equal(view.getByRole("dialog"), dialog);
  await act(async () => { result.reject(new Error("Synthetic save failure")); await flush(); });
  assert.equal(view.getByRole("dialog"), dialog);
  assert.equal(within(dialog).getByRole("alert").textContent, "Synthetic save failure");
  assert.equal(within(dialog).getByRole("textbox", { name: t("name") }).value, "Changed Plugin");
  result = deferred();
  await click(within(dialog).getByRole("button", { name: t("save"), exact: true }));
  await act(async () => { result.resolve({ ...plugin, name: "Changed Plugin" }); await flush(); });
  assert.equal(calls.length, 2);
  assert.equal(view.queryByRole("dialog"), null);
  assert.ok(view.getByRole("button", { name: /^Changed Plugin/ }));
});
