const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { createI18nHarness } = require("./i18n-harness.cjs");

const read = (file) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
function evaluate(source, imports = {}, globals = {}) {
  const module = { exports: {} };
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  vm.runInNewContext(output, {
    module, exports: module.exports, Intl, URLSearchParams, ...globals,
    require(name) {
      if (name in imports) return imports[name];
      if (name === "./messages.process") return evaluate(read("src/lib/messages.process.ts"));
      throw new Error(`Unexpected fixture dependency: ${name}`);
    },
  });
  return module.exports;
}

test("browser language restores before login, persists immediately and follows system changes only in system mode", () => {
  const i18n = createI18nHarness("system");
  i18n.runtime.setSystemLanguages(["en-US"]);
  const storage = new Map([["ochi.language", "zh-TW"]]), listeners = new Map();
  const document = { documentElement: { lang: "" } };
  let subscription;
  const wrapper = evaluate(read("src/lib/i18n.ts"), {
    react: { useSyncExternalStore(subscribe, snapshot) { subscription = subscribe; return snapshot(); } },
    "../../../shared/i18n": i18n.runtime,
    "./messages": evaluate(read("src/lib/messages.ts")),
  }, {
    document, navigator: { languages: ["zh-CN"] },
    window: {
      location: { pathname: "/", search: "" },
      localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
      addEventListener: (event, listener) => listeners.set(event, listener),
    },
  });
  assert.equal(document.documentElement.lang, "zh-TW");
  assert.equal(wrapper.t("common.close"), "關閉");
  assert.equal(wrapper.useI18n().language, "zh-TW");
  let renders = 0;
  const unsubscribe = subscription(() => renders++);
  wrapper.setLanguage("en");
  assert.equal(document.documentElement.lang, "en");
  assert.equal(storage.get("ochi.language"), "en");
  listeners.get("languagechange")();
  assert.equal(wrapper.getLocale(), "en", "explicit English survives an OS language change");
  wrapper.setLanguage("system");
  assert.equal(wrapper.getLocale(), "zh-CN");
  assert.equal(storage.get("ochi.language"), "system");
  assert.equal(renders, 2);
  unsubscribe();
});

test("blocked browser storage does not prevent language switching or document language updates", () => {
  const i18n = createI18nHarness("en");
  const document = { documentElement: { lang: "" } };
  const wrapper = evaluate(read("src/lib/i18n.ts"), {
    react: { useSyncExternalStore() {} },
    "../../../shared/i18n": i18n.runtime,
    "./messages": evaluate(read("src/lib/messages.ts")),
  }, {
    document, navigator: { languages: ["en"] },
    window: {
      location: { pathname: "/", search: "" },
      localStorage: { getItem() { throw new Error("Disabled"); }, setItem() { throw new Error("Disabled"); } },
      addEventListener() {},
    },
  });
  wrapper.setLanguage("zh-TW");
  assert.equal(document.documentElement.lang, "zh-TW");
  assert.equal(wrapper.t("common.cancel"), "取消");
});

test("mounted Computer permission choices follow language changes without resetting an in-flight answer", async () => {
  const i18n = createI18nHarness("en");
  const state = [];
  let cursor = 0;
  const jsx = (type, props) => ({ type, props });
  const { WaitingInputCard } = evaluate(read("src/components/WaitingInputCard.tsx"), {
    "../lib/i18n": i18n.web,
    react: {
      useState(initial) {
        const index = cursor++;
        if (!(index in state)) state[index] = initial;
        return [state[index], (value) => { state[index] = value; }];
      },
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "lucide-react": new Proxy({}, { get: (_, name) => String(name) }),
    "../lib/computerAction": { permissionAnswerDecision: (value) => (value === "deny" ? "denied" : value === "allow_once" ? "once" : "conversation") },
    "./ComputerSteps": { PermissionResult: () => null },
    "./waiting-input.css": {},
  });
  const answers = [];
  let complete;
  const props = {
    waiting: { kind: "computer_permission", question: "Original model question" },
    runId: "R",
    onResume: (runId, answer) => {
      answers.push({ runId, answer });
      return new Promise((resolve) => { complete = resolve; });
    },
  };
  const render = () => { cursor = 0; return WaitingInputCard(props); };
  const buttons = (node) => {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return Array.from(node).flatMap(buttons);
    return node.type === "button" ? [node] : buttons(node.props?.children);
  };
  let actions = buttons(render());
  assert.deepEqual(actions.map((button) => button.props.children), [
    i18n.web.t("permission.deny"), i18n.web.t("permission.once"), i18n.web.t("permission.conversation"),
  ]);
  actions[1].props.onClick();
  assert.deepEqual(answers, [{ runId: "R", answer: "allow_once" }]);
  i18n.runtime.setLanguage("zh-TW");
  actions = buttons(render());
  assert.deepEqual(actions.map((button) => button.props.children), [
    i18n.web.t("permission.deny"), i18n.web.t("permission.once"), i18n.web.t("permission.conversation"),
  ]);
  assert.ok(actions.every((button) => button.props.disabled), "the existing pending answer stays pending");
  complete();
  await new Promise(setImmediate);
  assert.ok(buttons(render()).every((button) => !button.props.disabled));
});

test("native Computer locale bootstrap and live events stay transient and do not change Web preferences", () => {
  const i18n = createI18nHarness("system");
  i18n.runtime.setSystemLanguages(["en-US"]);
  const storage = new Map([["ochi.language", "zh-CN"]]), listeners = new Map();
  const document = { documentElement: { lang: "" } };
  const wrapper = evaluate(read("src/lib/i18n.ts"), {
    react: { useSyncExternalStore() {} },
    "../../../shared/i18n": i18n.runtime,
    "./messages": evaluate(read("src/lib/messages.ts")),
  }, {
    document, navigator: { languages: ["en-US"] },
    window: {
      location: { pathname: "/native/computer", search: "?locale=zh-TW" },
      localStorage: {
        getItem() { assert.fail("a native viewer must not read the Web preference"); },
        setItem() { assert.fail("a native viewer must not write the Web preference"); },
      },
      addEventListener: (event, listener) => listeners.set(event, listener),
    },
  });
  assert.equal(wrapper.getLocale(), "zh-TW");
  assert.equal(document.documentElement.lang, "zh-TW");
  const update = listeners.get("ochi:native-locale");
  assert.equal(typeof update, "function");
  update({ detail: { locale: "en" } });
  assert.equal(wrapper.getLocale(), "en");
  assert.equal(document.documentElement.lang, "en");
  update({ detail: { locale: "zh-Hant" } });
  update({ detail: { locale: "system" } });
  update({ detail: { locale: "fr" } });
  update({});
  assert.equal(wrapper.getLocale(), "en", "only canonical resolved locales can be injected");
  update({ detail: { locale: "zh-CN" } });
  assert.equal(wrapper.getLocale(), "zh-CN");
  assert.equal(storage.get("ochi.language"), "zh-CN");
});

test("native locale queries and events cannot override an ordinary Web or admin page preference", () => {
  for (const pathname of ["/", "/admin/providers", "/native/computer/"]) {
    const i18n = createI18nHarness("en"), listeners = new Map();
    const wrapper = evaluate(read("src/lib/i18n.ts"), {
      react: { useSyncExternalStore() {} },
      "../../../shared/i18n": i18n.runtime,
      "./messages": evaluate(read("src/lib/messages.ts")),
    }, {
      document: { documentElement: { lang: "" } }, navigator: { languages: ["en-US"] },
      window: {
        location: { pathname, search: "?locale=zh-TW" },
        localStorage: { getItem: () => "en", setItem() {} },
        addEventListener: (event, listener) => listeners.set(event, listener),
      },
    });
    assert.equal(wrapper.getLocale(), "en", pathname);
    assert.equal(listeners.has("ochi:native-locale"), false, pathname);
  }
});

test("API requests send the current language and errors resolve in the current locale after a preference rollback", async () => {
  const i18n = createI18nHarness("en");
  const source = ts.createSourceFile("api.ts", read("src/lib/api.ts"), ts.ScriptTarget.Latest, true);
  const declarations = source.statements.filter((node) =>
    ts.isFunctionDeclaration(node) && ["request", "userFacingError"].includes(node.name?.text));
  const calls = [];
  let status = 200, body = { ok: true }, networkFailure = false;
  const api = evaluate(declarations.map((node) => node.getText(source)).join("\n"), {}, {
    API_BASE: "", getLocale: i18n.runtime.getLocale, t: i18n.web.t,
    translateError: i18n.errors.translateError, FormData,
    console: { error() {} },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (networkFailure) throw new Error("Private network diagnostics");
      return { ok: status < 400, status, json: async () => body };
    },
  });
  assert.equal((await api.request("/api/models")).ok, true);
  assert.equal(calls[0].init.headers["Accept-Language"], "en");
  assert.equal(calls[0].init.credentials, "include");
  i18n.runtime.setLanguage("zh-TW");
  status = 503;
  body = { error: "private provider traceback", code: "run_timeout" };
  let codedError;
  await assert.rejects(api.request("/api/runs/R"), (error) => {
    codedError = error;
    assert.equal(error.message, i18n.errors.translateError("run_timeout"));
    assert.equal(error.code, "run_timeout");
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(calls[1].init.headers["Accept-Language"], "zh-TW");
  i18n.runtime.setLanguage("en");
  assert.equal(codedError.message, i18n.errors.translateError("run_timeout"),
    "a language save failure is read after the preference rolls back");
  body = { error: "private 中文 provider traceback" };
  let fallbackError;
  await assert.rejects(api.request("/api/models"), (error) => {
    fallbackError = error;
    assert.equal(error.message, i18n.web.t("error.unavailable"));
    assert.doesNotMatch(error.message, /private|traceback/);
    return true;
  });
  i18n.runtime.setLanguage("zh-TW");
  assert.equal(fallbackError.message, i18n.web.t("error.unavailable"));
  networkFailure = true;
  let connectionError;
  await assert.rejects(api.request("/api/models"), (error) => {
    connectionError = error;
    assert.equal(error.message, i18n.web.t("error.connect"));
    return true;
  });
  i18n.runtime.setLanguage("en");
  assert.equal(connectionError.message, i18n.web.t("error.connect"));
  assert.doesNotMatch(connectionError.message, /Private|diagnostics/);
});

test("account language writes serialize and an old account failure cannot roll back the new account", async () => {
  const i18n = createI18nHarness("en");
  const source = ts.createSourceFile("App.tsx", read("src/App.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "changeLanguage") declaration = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(declaration);
  const { createPreferencesOwner } = evaluate(read("src/lib/preferences.ts"));
  const requests = [];
  const owner = createPreferencesOwner("old-account", {
    preferences: async () => ({ language: "en" }),
    updatePreferences: (patch) => new Promise((resolve, reject) => requests.push({ patch, resolve, reject })),
  });
  const ownerRef = { current: owner };
  owner.subscribe(() => {
    const value = owner.getSnapshot().preferences;
    if (value && ownerRef.current === owner) i18n.runtime.setLanguage(value.language);
  });
  await owner.load();
  const { changeLanguage } = evaluate(`export const ${declaration.getText(source)};`, {}, {
    useCallback: (callback) => callback,
    preferencesOwnerRef: ownerRef,
  });
  const first = changeLanguage("zh-CN");
  const second = changeLanguage("zh-TW");
  await Promise.resolve();
  assert.equal(requests.length, 1);
  assert.equal(i18n.runtime.getLanguage(), "zh-TW");
  requests[0].resolve({ language: "zh-CN" });
  await first;
  await Promise.resolve();
  assert.equal(requests.length, 2);
  owner.deactivate();
  ownerRef.current = createPreferencesOwner("new-account", {
    preferences: async () => ({ language: "en" }),
    updatePreferences: async (patch) => patch,
  });
  i18n.runtime.setLanguage("en");
  requests[1].reject(new Error("Old account failed"));
  await second;
  assert.equal(i18n.runtime.getLanguage(), "en");
});
