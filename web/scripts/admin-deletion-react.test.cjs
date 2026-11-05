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
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function screens(api, language = "en") {
  const locale = createI18nHarness(language);
  const load = createLoader(require("typescript"), require, {
    [path.join(root, "web/src/pages/admin/i18n.ts")]: locale.admin,
    [path.join(root, "web/src/lib/i18n.ts")]: locale.web,
    [path.join(root, "web/src/lib/api.ts")]: { adminApi: api },
    [path.join(root, "web/src/lib/router.ts")]: { statusLabel: (status) => status },
    [path.join(root, "web/src/components/ui/Select.tsx")]: { SelectField: () => null },
    [path.join(root, "web/src/components/ProcessDetails.tsx")]: { StepList: () => null },
    [path.join(root, "web/src/components/FileCards.tsx")]: { FileCards: () => null },
    [path.join(root, "web/src/pages/admin/RequestDiagnostics.tsx")]: { RequestDiagnostics: () => null },
    [path.join(root, "web/src/pages/admin/UpdateCard.tsx")]: { UpdateCard: () => null },
  });
  return { ...load(path.join(root, "web/src/pages/admin/SystemPages.tsx")), t: locale.admin.t };
}
async function mount(Page, props = {}) {
  let view;
  await act(async () => { view = render(React.createElement(Page, props)); await flush(); });
  return view;
}
async function click(element) {
  await act(async () => { fireEvent.click(element); await flush(); });
}
test.afterEach(() => cleanup());
const accounts = [
  { id: "admin-qa", username: "admin", display_name: "Current admin", role: "admin", enabled: true },
  { id: "typo-qa", username: "typo", display_name: "Mistyped account", role: "user", enabled: true },
];
const workspace = (id, kind = "workspace") => ({
  kind, user_id: id, container: `fixture-${id}`, running: false, state: "exited",
  image: "workspace-fixture", configured_image: "workspace-fixture", update_available: false,
});

test("user deletion keeps pending confirmation open, shows failures inside it, and removes the target after retry", async () => {
  let values = accounts;
  let result = deferred();
  const calls = [];
  const { UsersPage, t } = screens({
    users: async () => values,
    remove: (kind, id) => { calls.push({ kind, id }); return result.promise; },
  });
  const view = await mount(UsersPage, { currentUserID: "admin-qa" });
  const ownDelete = view.getByRole("button", { name: t("deleteUserNamed", { name: "Current admin" }) });
  assert.equal(ownDelete.disabled, true);
  assert.equal(ownDelete.title, t("cannotDeleteCurrentUser"));
  await click(view.getByRole("button", { name: t("deleteUserNamed", { name: "Mistyped account" }) }));
  let dialog = view.getByRole("dialog", { name: t("deleteUserQuestion") });
  assert.ok(within(dialog).getByText(t("deleteUserDescription")));
  await click(within(dialog).getByRole("button", { name: t("delete"), exact: true }));
  assert.deepEqual(calls, [{ kind: "users", id: "typo-qa" }]);
  assert.equal(within(dialog).getByRole("button", { name: t("deletingEllipsis") }).disabled, true);
  assert.equal(within(dialog).getByRole("button", { name: t("cancel") }).disabled, true);
  assert.equal(within(dialog).getByRole("button", { name: "Close" }).disabled, true);
  await act(async () => { fireEvent.keyDown(dialog, { key: "Escape" }); await flush(); });
  assert.equal(view.getByRole("dialog"), dialog);
  await act(async () => { result.reject(new Error("Stop the active run first")); await flush(); });
  assert.equal(within(dialog).getByRole("alert").textContent, "Stop the active run first");
  assert.equal(within(dialog).getByRole("button", { name: t("delete"), exact: true }).disabled, false);
  result = deferred();
  await click(within(dialog).getByRole("button", { name: t("delete"), exact: true }));
  assert.equal(within(dialog).queryByRole("alert"), null);
  values = accounts.slice(0, 1);
  await act(async () => { result.resolve(); await flush(); });
  assert.equal(view.queryByRole("dialog"), null);
  assert.equal(view.queryByText("Mistyped account"), null);
  assert.ok(view.getByText("Current admin"));
  assert.deepEqual(calls, [
    { kind: "users", id: "typo-qa" }, { kind: "users", id: "typo-qa" },
  ]);
});

test("workspace deletion targets only a private workspace, preserves its account, and supports retry after visible failure", async () => {
  let values = [workspace("__admin__", "control"), workspace("typo-qa")];
  let result = deferred();
  const calls = [];
  const { WorkspacesPage, t } = screens({
    users: async () => accounts,
    workspaces: async () => values,
    remove: (kind, id) => { calls.push({ kind, id }); return result.promise; },
  });
  const view = await mount(WorkspacesPage);
  assert.equal(view.getAllByRole("button", { name: /Delete workspace for/ }).length, 1);
  await click(view.getByRole("button", { name: t("deleteWorkspaceNamed", { name: "Mistyped account" }) }));
  let dialog = view.getByRole("dialog", { name: t("deleteWorkspaceQuestion") });
  assert.ok(within(dialog).getByText(t("deleteWorkspaceDescription")));
  await click(within(dialog).getByRole("button", { name: t("cancel") }));
  assert.equal(view.queryByRole("dialog"), null);
  assert.deepEqual(calls, []);
  await click(view.getByRole("button", { name: t("deleteWorkspaceNamed", { name: "Mistyped account" }) }));
  dialog = view.getByRole("dialog");
  await click(within(dialog).getByRole("button", { name: t("delete"), exact: true }));
  assert.equal(within(dialog).getByRole("button", { name: "Close" }).disabled, true);
  assert.ok(view.getAllByRole("button", { name: t("rebuild"), hidden: true }).every((button) => button.disabled));
  await act(async () => { result.reject(new Error("Stop the background job first")); await flush(); });
  assert.equal(within(dialog).getByRole("alert").textContent, "Stop the background job first");
  result = deferred();
  await click(within(dialog).getByRole("button", { name: t("delete"), exact: true }));
  values = [values[0], { ...values[1], state: "not_created" }];
  await act(async () => { result.resolve(); await flush(); });
  assert.deepEqual(calls, [
    { kind: "workspaces", id: "typo-qa" }, { kind: "workspaces", id: "typo-qa" },
  ]);
  assert.equal(view.queryByRole("dialog"), null);
  assert.ok(view.getByText("Mistyped account"));
  assert.ok(view.getByText(t("notStarted")));
});

test("workspace rebuild and deletion retain distinct HTTP actions and confirmations", async () => {
  const calls = [];
  const { WorkspacesPage, t } = screens({
    users: async () => accounts,
    workspaces: async () => [workspace("typo-qa")],
    workspace: async (id, action) => { calls.push({ id, action }); },
    remove: async () => assert.fail("Rebuild must preserve workspace data"),
  });
  const view = await mount(WorkspacesPage);
  await click(view.getByRole("button", { name: t("rebuild"), exact: true }));
  const dialog = view.getByRole("dialog", { name: t("rebuildWorkspaceQuestion") });
  assert.equal(within(dialog).queryByText(t("deleteWorkspaceDescription")), null);
  await click(within(dialog).getByRole("button", { name: t("rebuild"), exact: true }));
  assert.deepEqual(calls, [{ id: "typo-qa", action: "rebuild" }]);
  assert.equal(view.queryByRole("dialog"), null);
});

for (const language of ["en", "zh-CN", "zh-TW"]) {
  test(`destructive confirmations and failure feedback use the ${language} catalog`, async () => {
    const { WorkspacesPage, t } = screens({
      users: async () => accounts,
      workspaces: async () => [workspace("typo-qa")],
      remove: async () => { throw new Error(t("operationFailed")); },
    }, language);
    const view = await mount(WorkspacesPage);
    await click(view.getByRole("button", { name: t("deleteWorkspaceNamed", { name: "Mistyped account" }) }));
    const dialog = view.getByRole("dialog", { name: t("deleteWorkspaceQuestion") });
    assert.ok(within(dialog).getByText(t("deleteWorkspaceDescription")));
    await click(within(dialog).getByRole("button", { name: t("delete"), exact: true }));
    assert.equal(within(dialog).getByRole("alert").textContent, t("operationFailed"));
    assert.equal(within(dialog).getByRole("button", { name: t("cancel") }).disabled, false);
  });
}
