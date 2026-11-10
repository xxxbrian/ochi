const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://client.example.invalid/" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  sessionStorage: dom.window.sessionStorage, HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.setInterval = globalThis.setInterval;
window.clearInterval = globalThis.clearInterval;
const React = require("react");
const { render, act, cleanup, fireEvent } = require("@testing-library/react");
const { createLoader } = require("../../shared/conversation/test-loader.cjs");
const { createI18nHarness } = require("./i18n-harness.cjs");
const root = path.resolve(__dirname, "../..");
const filename = (file) => path.join(root, "web", file);
const bareLoad = createLoader(require("typescript"), require);
const { createPreferencesOwner } = bareLoad(filename("src/lib/preferences.ts"));
const preferences = (patch = {}) => ({
  memory_enabled: true, computer_default: false, preferred_model_id: "A", language: "en", ...patch,
});
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
test.afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/"); });

test("partial preference writes serialize, keep newer optimistic fields and roll back only the failed edit", async () => {
  const calls = [];
  const owner = createPreferencesOwner("account", {
    preferences: async () => preferences(),
    updatePreferences: (patch) => { const result = deferred(); calls.push({ patch, ...result }); return result.promise; },
  });
  await owner.load();
  const first = owner.update({ preferred_model_id: "B" });
  const second = owner.update({ preferred_model_id: "C" });
  const third = owner.update({ computer_default: true });
  const secondFailure = assert.rejects(second, /Not saved/);
  await flush();
  assert.deepEqual(calls.map((call) => call.patch), [{ preferred_model_id: "B" }]);
  assert.deepEqual(owner.getSnapshot().preferences, preferences({ preferred_model_id: "C", computer_default: true }));
  calls[0].resolve(preferences({ preferred_model_id: "B" }));
  await first; await flush();
  assert.equal(owner.getSnapshot().preferences.preferred_model_id, "C");
  assert.equal(owner.getSnapshot().preferences.computer_default, true);
  calls[1].reject(new Error("Not saved"));
  await secondFailure; await flush();
  assert.deepEqual(calls[2].patch, { computer_default: true });
  assert.deepEqual(owner.getSnapshot().preferences, preferences({ preferred_model_id: "B", computer_default: true }));
  calls[2].resolve(preferences({ preferred_model_id: "B", computer_default: true }));
  await third;
  assert.deepEqual(owner.getSnapshot().preferences, preferences({ preferred_model_id: "B", computer_default: true }));
});

test("an in-flight bootstrap read keeps subsequent optimistic defaults and a stale account never dispatches queued writes", async () => {
  const read = deferred(), write = deferred(), calls = [];
  const owner = createPreferencesOwner("old", {
    preferences: () => read.promise,
    updatePreferences: (patch) => { calls.push(patch); return write.promise; },
  });
  const initial = owner.load();
  const edited = owner.update({ preferred_model_id: "B" });
  assert.equal(owner.load(), initial, "settings reuse the account read");
  read.resolve(preferences());
  await initial; await flush();
  assert.equal(owner.getSnapshot().preferences.preferred_model_id, "B");
  const queued = owner.update({ computer_default: true });
  owner.deactivate();
  write.resolve(preferences({ preferred_model_id: "B" }));
  assert.equal(await edited, null);
  assert.equal(await queued, null);
  assert.equal(calls.length, 1, "queued old-account requests are never sent");
  assert.equal(owner.getSnapshot().preferences, null);
});

test("StrictMode reactivation has an independent queue and ignores the previous generation's response", async () => {
  const old = deferred();
  let reads = 0;
  const owner = createPreferencesOwner("account", {
    preferences: () => ++reads === 1 ? old.promise : Promise.resolve(preferences({ preferred_model_id: "B" })),
    updatePreferences: async (patch) => preferences(patch),
  });
  const stale = owner.load();
  await flush();
  owner.deactivate();
  owner.activate();
  await owner.load();
  old.resolve(preferences());
  assert.equal(await stale, null);
  assert.equal(owner.getSnapshot().preferences.preferred_model_id, "B");
});

test("the actual preference hook survives StrictMode and isolates a later account from old responses", async () => {
  const oldWrite = deferred();
  let reads = 0, owner;
  const load = createLoader(require("typescript"), require, {
    [filename("src/lib/api.ts")]: { api: {
      preferences: async () => preferences({ preferred_model_id: ++reads === 1 ? "A" : "C" }),
      updatePreferences: () => oldWrite.promise,
    } },
  });
  const { useAccountPreferences } = load(filename("src/hooks/useAccountPreferences.ts"));
  function View({ account }) {
    const state = useAccountPreferences(account);
    owner = state.owner;
    React.useEffect(() => { void state.owner.load(); }, [state.owner]);
    return React.createElement("output", {}, state.preferences?.preferred_model_id);
  }
  let view;
  const element = (account) => React.createElement(React.StrictMode, {}, React.createElement(View, { account }));
  await act(async () => { view = render(element("old-account")); await flush(); });
  assert.equal(view.getByRole("status").textContent, "A");
  let pending;
  await act(async () => { pending = owner.update({ preferred_model_id: "B" }); await flush(); });
  assert.equal(view.getByRole("status").textContent, "B");
  await act(async () => { view.rerender(element("new-account")); await flush(); });
  assert.equal(view.getByRole("status").textContent, "C");
  await act(async () => { oldWrite.reject(new Error("Old account write failed")); await pending; await flush(); });
  assert.equal(view.getByRole("status").textContent, "C");
  assert.equal(owner.account, "new-account");
  assert.equal(owner.getSnapshot().error, "");
});

function appFixture({ delayedWrites = false, delayedModels = false } = {}) {
  const modelsGate = deferred();
  const locale = createI18nHarness("en");
  const calls = [], pending = [], sessionUpdates = [];
  let value = preferences(), reads = 0;
  const historical = { id: "history", title: "History", model_id: "A", computer_enabled: false, effort: "low" };
  const models = ["A", "B", "C"].map((id) => ({
    id, name: id, model: id, provider_id: "provider", provider_name: "Provider",
    enabled: true, kind: "chat", default_effort: "low", efforts: ["low", "high"],
  }));
  const transport = {
    me: async () => ({ id: "account", username: "qa", role: "user" }),
    sessionsPage: async () => ({ items: [historical] }),
    models: async () => delayedModels ? modelsGate.promise : models,
    projects: async () => [],
    preferences: async () => { reads++; return value; },
    updatePreferences: (patch) => {
      calls.push(patch);
      if (!delayedWrites) { value = { ...value, ...patch }; return Promise.resolve(value); }
      const result = deferred();
      pending.push({ patch, ...result });
      return result.promise;
    },
    logout: async () => undefined,
  };
  let currentSession = null;
  const controller = {
    getSnapshot: () => ({ session: currentSession }),
    updateSession: async (patch) => { sessionUpdates.push(patch); Object.assign(historical, patch); return historical; },
  };
  const host = (tag = "div") => ({ children }) => React.createElement(tag, {}, children);
  const button = (name, onClick) => React.createElement("button", { onClick, type: "button" }, name);
  let load;
  const overrides = {
    [filename("src/lib/i18n.ts")]: locale.web,
    [filename("src/lib/api.ts")]: { api: transport, isActiveStatus: (status) => status === "running" },
    [filename("src/lib/router.ts")]: { useRouter() {
      const [route, setRoute] = React.useState({ kind: "chat", ...(window.location.pathname === "/c/history" ? { id: "history" } : {}) });
      const navigate = React.useCallback((url) => setRoute({ kind: "chat", ...(url.startsWith("/c/") ? { id: url.slice(3) } : {}) }), []);
      return { route, navigate };
    } },
    [filename("src/hooks/useConversation.ts")]: { useConversation(_account, id) {
      currentSession = id ? historical : null;
      return {
        controller, session: currentSession, messages: [], run: null, owner: { origin: "fixture" },
        instructions: { items: [], canSend: false }, pending: [], loading: false, posting: false,
      };
    } },
    [filename("src/lib/pinnedSessions.ts")]: { usePinnedSessions: () => ({ pinned: [], toggle() {}, forget() {} }) },
    [filename("src/lib/artifactDock.ts")]: { closeArtifact() {}, setArtifactOwner() {}, useArtifactDock: () => ({ file: null }) },
    [filename("src/components/Sidebar.tsx")]: {
      modKey: "Ctrl",
      MobileMenuButton: () => null,
      Sidebar: ({ onCreate, onSelect, onSettings, onLogout }) => React.createElement("nav", {},
        button("Start new draft", onCreate), button("History", () => onSelect("history")),
        button("Settings", onSettings), button("Logout", onLogout)),
    },
    [filename("src/components/Composer.tsx")]: { Composer: (props) => {
      const [draft, setDraft] = React.useState("");
      return React.createElement("section", { "data-testid": "composer" },
        React.createElement("input", { "aria-label": "Draft", value: draft, onChange: (event) => setDraft(event.target.value) }),
        React.createElement("output", { "data-testid": "model" }, props.modelId),
        React.createElement("output", { "data-testid": "computer" }, String(props.computerEnabled)),
        button("Composer computer", () => { void props.onComputer(!props.computerEnabled); }),
        ...models.map((model) => button(`Composer ${model.id}`, () => { void props.onModel(model.id); })));
    } },
    [filename("src/components/UserSettings.tsx")]: { default: ({ onClose, onLanguage }) => {
      const { GeneralTab } = load(filename("src/components/settings/GeneralTab.tsx"));
      const { ModelsTab } = load(filename("src/components/settings/ModelsTab.tsx"));
      return React.createElement("section", { "aria-label": "Settings" },
        React.createElement(GeneralTab, { onLanguage }), React.createElement(ModelsTab),
        button("Close settings", onClose));
    } },
    [filename("src/components/ui/Select.tsx")]: { SelectField: ({ value, label, onChange, disabled, options }) =>
      React.createElement("select", { value, "aria-label": label, disabled, onChange: (event) => onChange(event.target.value) },
        options.map((option) => React.createElement("option", { key: option.value, value: option.value }, option.label))) },
    [filename("src/components/settings/ui.tsx")]: {
      Card: host(), Sec: host(), Row: ({ children, title }) => React.createElement("label", {}, title, children),
      Collapse: host(), Empty: () => null, Skeleton: () => null, Seg: () => null,
      ErrorAlert: ({ message }) => React.createElement("p", { role: "alert" }, message),
      Toggle: ({ checked, label, onChange, disabled }) => React.createElement("input", {
        type: "checkbox", checked, disabled, "aria-label": label, onChange: (event) => onChange(event.target.checked),
      }),
      useSaved: () => ({ saved() {} }),
    },
    [filename("src/components/BrandIcon.tsx")]: { BrandIcon: () => null },
    [filename("src/components/ui/Menu.tsx")]: { ActionMenu: host(), MenuAction: host("span") },
    [filename("src/components/ui/Toast.tsx")]: { ToastHost: () => null, toast() {} },
    [filename("src/components/EmptyHero.tsx")]: { EmptyHero: () => null },
    [filename("src/components/LoginScreen.tsx")]: { LoginScreen: () => null },
    [filename("src/components/MessageList.tsx")]: { MessageList: () => null },
    [filename("src/components/RunInstructionStatus.tsx")]: { RunInstructionStatus: () => null },
    [filename("src/components/ComputerPanel.tsx")]: { ComputerPanel: () => null },
    [filename("src/components/ArtifactDock.tsx")]: { ArtifactDock: () => null },
    [filename("src/components/Modal.tsx")]: { Modal: host() },
    [filename("src/components/QueueTray.tsx")]: { QueueTray: () => null },
    [filename("src/components/ui/Loading.tsx")]: { LoadingDots: () => null, SkelRows: () => null },
  };
  load = createLoader(require("typescript"), require, overrides);
  return {
    App: load(filename("src/App.tsx")).default, locale, calls, pending, sessionUpdates,
    historical, resolveModels: () => modelsGate.resolve(models),
    get reads() { return reads; },
    confirm(index) { value = { ...value, ...pending[index].patch }; pending[index].resolve(value); },
  };
}
async function mount(App) {
  let view;
  await act(async () => { view = render(React.createElement(App)); await flush(); });
  return view;
}
async function click(element) {
  await act(async () => { fireEvent.click(element); await flush(); });
}
async function change(element, value) {
  await act(async () => { fireEvent.change(element, { target: { value } }); await flush(); });
}

test("actual settings update New Chat defaults immediately, share the account read and keep the current draft mounted", async () => {
  const fixture = appFixture();
  const view = await mount(fixture.App);
  const draft = view.getByRole("textbox", { name: "Draft" });
  await change(draft, "Keep this draft");
  draft.focus();
  await click(view.getByRole("button", { name: "Settings", exact: true }));
  await change(view.getByLabelText(fixture.locale.web.t("settings.defaultModel")), "B");
  await click(view.getByRole("checkbox", { name: fixture.locale.web.t("settings.computerDefault") }));
  assert.equal(view.getByTestId("model").textContent, "B");
  assert.equal(view.getByTestId("computer").textContent, "true");
  assert.equal(view.getByRole("textbox", { name: "Draft" }), draft);
  assert.equal(draft.value, "Keep this draft");
  assert.equal(document.activeElement, draft);
  assert.equal(fixture.reads, 1, "settings do not fetch an unrelated preference copy");
  await click(view.getByRole("button", { name: "Close settings" }));
  await click(view.getByRole("button", { name: "Start new draft", exact: true }));
  assert.equal(view.getByTestId("model").textContent, "B");
  assert.equal(view.getByTestId("computer").textContent, "true");
  assert.deepEqual(fixture.calls, [{ preferred_model_id: "B" }, { computer_default: true }]);
});

test("changing defaults from the model catalog preserves a historical session, then applies them to New Chat", async () => {
  const fixture = appFixture();
  const view = await mount(fixture.App);
  await click(view.getByRole("button", { name: "History", exact: true }));
  await click(view.getByRole("button", { name: "Settings", exact: true }));
  await click(view.getAllByRole("button", { name: fixture.locale.web.t("settings.setDefault") })[0]);
  await click(view.getByRole("checkbox", { name: fixture.locale.web.t("settings.computerDefault") }));
  assert.equal(view.getByTestId("model").textContent, "A");
  assert.equal(view.getByTestId("computer").textContent, "false");
  assert.deepEqual(fixture.sessionUpdates, []);
  await click(view.getByRole("button", { name: "Close settings" }));
  await click(view.getByRole("button", { name: "Start new draft", exact: true }));
  assert.equal(view.getByTestId("model").textContent, "B");
  assert.equal(view.getByTestId("computer").textContent, "true");
});

test("actual App and both settings tabs share optimistic selection, serialized writes and failure rollback", async () => {
  const fixture = appFixture({ delayedWrites: true });
  const view = await mount(fixture.App);
  await click(view.getByRole("button", { name: "Settings", exact: true }));
  const modelSelect = view.getByLabelText(fixture.locale.web.t("settings.defaultModel"));
  await change(modelSelect, "B");
  await change(modelSelect, "C");
  assert.equal(fixture.calls.length, 1);
  assert.equal(view.getByTestId("model").textContent, "C");
  await act(async () => { fixture.confirm(0); await flush(); });
  assert.equal(fixture.calls.length, 2);
  assert.equal(modelSelect.value, "C");
  assert.equal(view.getByTestId("model").textContent, "C");
  await act(async () => { fixture.pending[1].reject(new Error("Preference save failed")); await flush(); });
  assert.equal(modelSelect.value, "B");
  assert.equal(view.getByTestId("model").textContent, "B");
  assert.ok(view.getAllByRole("alert").some((alert) => alert.textContent === "Preference save failed"));
  await click(view.getByRole("button", { name: "Close settings" }));
  await click(view.getByRole("button", { name: "Start new draft", exact: true }));
  assert.equal(view.getByTestId("model").textContent, "B");
});

test("a Composer save cannot replace a newer Computer default edited in settings", async () => {
  const fixture = appFixture({ delayedWrites: true });
  const view = await mount(fixture.App);
  await click(view.getByRole("button", { name: "Composer computer" }));
  assert.equal(view.getByTestId("computer").textContent, "true");
  await click(view.getByRole("button", { name: "Settings", exact: true }));
  await click(view.getByRole("checkbox", { name: fixture.locale.web.t("settings.computerDefault") }));
  assert.equal(view.getByTestId("computer").textContent, "false");
  await act(async () => { fixture.confirm(0); await flush(); });
  assert.equal(view.getByTestId("computer").textContent, "false");
  await act(async () => { fixture.confirm(1); await flush(); });
  assert.equal(view.getByTestId("computer").textContent, "false");
  assert.deepEqual(fixture.calls, [{ computer_default: true }, { computer_default: false }]);
});

test("a direct historical link keeps its own model when its session arrives before the catalog", async () => {
  window.history.replaceState(null, "", "/c/history");
  const fixture = appFixture({ delayedModels: true });
  fixture.historical.model_id = "C";
  const view = await mount(fixture.App);
  await act(async () => { fixture.resolveModels(); await flush(); });
  assert.equal(view.getByTestId("model").textContent, "C");
  assert.equal(view.getByTestId("computer").textContent, "false");
  assert.deepEqual(fixture.calls, [], "loading history never changes the account default");
});
