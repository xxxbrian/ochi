const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
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
const filePath = (relative) => path.join(root, "web/src", relative);
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 25)); };
const empty = () => ({ android: null, ios: null });
const published = () => ({
  android: { version_name: "0.1.9", version_code: 19, size_bytes: 94371840, sha256: "a".repeat(64), published_at: "2026-01-01T12:00:00Z", download_url: `/api/client-releases/android/${"a".repeat(64)}.apk`, release_notes: "Synthetic release notes" },
  ios: { url: "https://testflight.apple.com/join/synthetic" },
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup({ api = {}, adminApi = {}, locale = "en" } = {}) {
  const language = createI18nHarness(locale);
  const load = createLoader(ts, require, {
    [filePath("lib/i18n.ts")]: language.web,
    [filePath("pages/admin/i18n.ts")]: language.admin,
    [filePath("lib/api.ts")]: { API_BASE: "", api, adminApi },
  });
  return {
    ...load(filePath("components/ClientDownloads.tsx")),
    ...load(filePath("components/LoginScreen.tsx")),
    ...load(filePath("pages/admin/ClientReleasesCard.tsx")),
    helpers: load(filePath("lib/clientReleases.ts")),
    t: language.admin.t, webT: language.web.t,
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
  await act(async () => { await flush(); });
}
async function change(element, value) { await act(async () => { fireEvent.change(element, { target: { value } }); await flush(); }); }
function apk() { return new dom.window.File(["synthetic APK fixture"], "fixture.apk", { type: "application/vnd.android.package-archive" }); }
test.afterEach(cleanup);

for (const locale of ["en", "zh-CN", "zh-TW"]) {
  test(`public downloads explain both unconfigured platforms without dead links in ${locale}`, async () => {
    const { ClientDownloads, webT } = setup({ locale, api: { clientReleases: async () => empty() } });
    const view = await mount(ClientDownloads, { onClose() {} });
    const dialog = view.getByRole("dialog", { name: webT("clientDownloads.title") });
    assert.ok(within(dialog).getByText(webT("clientDownloads.androidUnavailable")));
    assert.ok(within(dialog).getByText(webT("clientDownloads.iosUnavailable")));
    assert.equal(within(dialog).queryAllByRole("link").length, 0);
  });
}

test("public downloads use the immutable APK path and external Apple link, retain notes as plain text, and retry failed loads", async () => {
  let calls = 0;
  const value = published();
  value.android.release_notes = "<script>synthetic</script>";
  const { ClientDownloads, webT } = setup({ api: { clientReleases: async () => { if (++calls === 1) throw new Error("Synthetic offline"); return value; } } });
  const view = await mount(ClientDownloads, { onClose() {} });
  assert.equal(view.getByRole("alert").textContent.includes("Synthetic offline"), true);
  await click(view.getByRole("button", { name: webT("common.retry") }));
  const android = view.getByRole("link", { name: webT("clientDownloads.android") });
  assert.equal(android.getAttribute("href"), value.android.download_url);
  assert.equal(android.getAttribute("download"), "Ochi-0.1.9.apk");
  const ios = view.getByRole("link", { name: webT("clientDownloads.ios") });
  assert.equal(ios.getAttribute("target"), "_blank");
  assert.match(ios.getAttribute("rel"), /noopener/);
  assert.ok(view.getByText("<script>synthetic</script>"));
  assert.equal(document.querySelector("script"), null);
});

test("download URL validation rejects foreign APK URLs and unsafe iOS links while accepting HTTPS landing pages", () => {
  const { helpers } = setup();
  const value = published().android;
  assert.equal(helpers.androidReleaseURL({ ...value, download_url: "https://external.example.invalid/file.apk" }), undefined);
  assert.equal(helpers.androidReleaseURL({ ...value, sha256: "b".repeat(64) }), undefined);
  for (const url of ["javascript:alert(1)", "http://testflight.apple.com/join/synthetic", "https://user:pass@apps.apple.com/app/id1"]) {
    assert.equal(helpers.iosReleaseURL(url), undefined);
  }
  assert.equal(helpers.iosReleaseURL("https://apps.apple.com/app/id1"), "https://apps.apple.com/app/id1");
  assert.equal(helpers.iosReleaseURL("https://download.example.invalid/ios"), "https://download.example.invalid/ios");
});

test("the login download entry opens the shared dialog without submitting credentials", async () => {
  let logins = 0;
  const { LoginScreen, webT } = setup({ api: { clientReleases: async () => empty(), login: async () => { logins++; } } });
  const view = await mount(LoginScreen, { onLogin() {} });
  await click(view.getByRole("button", { name: webT("clientDownloads.title") }));
  assert.ok(view.getByRole("dialog", { name: webT("clientDownloads.title") }));
  assert.equal(logins, 0);
});

test("admin upload reports real progress, cancels once, and rereads publication when cancellation races completion", async () => {
  let reads = 0, calls = 0, aborted = 0;
  let report;
  const { ClientReleasesCard, t } = setup({ adminApi: {
    clientReleases: async () => ++reads === 1 ? empty() : published(),
    uploadAndroidRelease: (file, notes, progress, signal) => {
      calls++;
      assert.equal(file.name, "fixture.apk");
      assert.equal(notes, "Draft notes");
      report = progress;
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => { aborted++; reject(new DOMException("Aborted", "AbortError")); }, { once: true }));
    },
  } });
  const view = await mount(ClientReleasesCard);
  await act(async () => { fireEvent.change(view.getByLabelText(t("clientReleases.apk")), { target: { files: [apk()] } }); await flush(); });
  await change(view.getByRole("textbox", { name: t("clientReleases.notes") }), "Draft notes");
  await click(view.getByRole("button", { name: t("clientReleases.publish") }));
  assert.equal(calls, 1);
  await act(async () => { report(37.5); await flush(); });
  assert.equal(view.getByRole("progressbar").getAttribute("aria-valuenow"), "37");
  assert.equal(view.getByRole("button", { name: t("clientReleases.uploading", { percent: "37" }) }).disabled, true);
  await click(view.getByRole("button", { name: t("cancel"), exact: true }));
  assert.equal(aborted, 1);
  assert.equal(reads, 2);
  assert.ok(view.getByText("0.1.9", { exact: false }));
  assert.ok(view.getByText(t("clientReleases.cancelled")));
  assert.equal(view.getByRole("textbox", { name: t("clientReleases.notes") }).value, "Draft notes");
});

test("admin upload failure retains the selected file and notes, retry publishes parsed metadata, and removal failure remains in its confirmation", async () => {
  let uploads = 0, removes = 0;
  const remove = deferred();
  const { ClientReleasesCard, t } = setup({ adminApi: {
    clientReleases: async () => empty(),
    uploadAndroidRelease: async () => { if (++uploads === 1) throw new Error("Synthetic APK validation failure"); return published(); },
    removeAndroidRelease: () => { removes++; return removes === 1 ? remove.promise : Promise.resolve(empty()); },
  } });
  const view = await mount(ClientReleasesCard);
  await act(async () => { fireEvent.change(view.getByLabelText(t("clientReleases.apk")), { target: { files: [apk()] } }); await flush(); });
  await change(view.getByRole("textbox", { name: t("clientReleases.notes") }), "Retained notes");
  await click(view.getByRole("button", { name: t("clientReleases.publish") }));
  assert.ok(view.getByRole("alert").textContent.includes("Synthetic APK validation failure"));
  assert.equal(view.getByRole("textbox", { name: t("clientReleases.notes") }).value, "Retained notes");
  assert.equal(view.getByRole("button", { name: t("clientReleases.publish") }).disabled, false);
  await click(view.getByRole("button", { name: t("clientReleases.publish") }));
  assert.equal(uploads, 2);
  assert.ok(view.getByText("0.1.9", { exact: false }));
  await click(view.getByRole("button", { name: t("clientReleases.remove") }));
  const dialog = view.getByRole("dialog", { name: t("clientReleases.removeQuestion") });
  await click(within(dialog).getByRole("button", { name: t("clientReleases.remove") }));
  assert.equal(within(dialog).getByRole("button", { name: "Close" }).disabled, true);
  await act(async () => { remove.reject(new Error("Synthetic deletion failure")); await flush(); });
  assert.equal(within(dialog).getByRole("alert").textContent.includes("Synthetic deletion failure"), true);
  await click(within(dialog).getByRole("button", { name: t("clientReleases.remove") }));
  assert.equal(view.queryByRole("dialog"), null);
  assert.ok(view.getByText(t("clientReleases.noAndroid")));
});

test("iOS link updates are explicit and independent, server errors retain the draft, and clearing the saved link is supported", async () => {
  const calls = [];
  const { ClientReleasesCard, t } = setup({ adminApi: {
    clientReleases: async () => empty(),
    saveIOSRelease: async (url) => {
      calls.push(url);
      if (calls.length === 1) throw new Error("Synthetic URL rejection");
      return { ...empty(), ios: url ? { url } : null };
    },
  } });
  const view = await mount(ClientReleasesCard);
  const field = view.getByRole("textbox", { name: t("clientReleases.iosURL") });
  await change(field, "https://testflight.apple.com/join/synthetic");
  await click(view.getByRole("button", { name: t("save"), exact: true }));
  assert.ok(view.getByRole("alert").textContent.includes("Synthetic URL rejection"));
  assert.equal(field.value, calls[0]);
  await click(view.getByRole("button", { name: t("save"), exact: true }));
  assert.equal(view.getByRole("button", { name: t("save"), exact: true }).disabled, true);
  await change(field, "");
  await click(view.getByRole("button", { name: t("save"), exact: true }));
  assert.deepEqual(calls, ["https://testflight.apple.com/join/synthetic", "https://testflight.apple.com/join/synthetic", ""]);
});

test("leaving the administration page aborts its in-flight upload and ignores a late completion", async () => {
  const gate = deferred();
  let signal;
  const { ClientReleasesCard, t } = setup({ adminApi: {
    clientReleases: async () => empty(),
    uploadAndroidRelease: (_file, _notes, _progress, value) => { signal = value; return gate.promise; },
  } });
  const view = await mount(ClientReleasesCard);
  await act(async () => { fireEvent.change(view.getByLabelText(t("clientReleases.apk")), { target: { files: [apk()] } }); await flush(); });
  await click(view.getByRole("button", { name: t("clientReleases.publish") }));
  view.unmount();
  assert.equal(signal.aborted, true);
  await act(async () => { gate.resolve(published()); await flush(); });
  assert.equal(document.querySelector(".client-releases-card"), null);
});

function uploadTransport() {
  const language = createI18nHarness("en");
  const source = ts.createSourceFile("api.ts", fs.readFileSync(filePath("lib/api.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const functions = source.statements.filter((node) => ts.isFunctionDeclaration(node) && ["userFacingError", "responseError", "uploadAndroidRelease"].includes(node.name?.text));
  const instances = [];
  class XHR {
    constructor() { this.upload = {}; this.headers = {}; instances.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) { this.body = body; }
    abort() { this.aborted = true; this.onabort(); }
    respond(status, body) { this.status = status; this.responseText = typeof body === "string" ? body : JSON.stringify(body); this.onload(); }
  }
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(functions.map((node) => node.getText(source)).join("\n"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, API_BASE: "", XMLHttpRequest: XHR, FormData: dom.window.FormData, DOMException,
    Intl, Error, JSON, Promise, t: language.web.t, getLocale: language.runtime.getLocale, translateError: language.errors.translateError,
  });
  return { upload: module.exports.uploadAndroidRelease, instances, language };
}

test("XHR sends the original multipart file with credentials, locale headers and actual byte progress", async () => {
  const h = uploadTransport(), controller = new AbortController(), progress = [], file = apk();
  const result = h.upload(file, "Notes", (value) => progress.push(value), controller.signal);
  const xhr = h.instances[0];
  assert.equal(xhr.url, "/api/admin/client-releases/android");
  assert.equal(xhr.method, "POST");
  assert.equal(xhr.withCredentials, true);
  assert.equal(xhr.headers["Accept-Language"], h.language.runtime.getLocale());
  assert.equal(xhr.headers["Content-Type"], undefined);
  assert.equal(xhr.body.get("file"), file);
  assert.equal(xhr.body.get("release_notes"), "Notes");
  xhr.upload.onprogress({ lengthComputable: true, loaded: 25, total: 100 });
  xhr.upload.onprogress({ lengthComputable: true, loaded: 100, total: 100 });
  assert.deepEqual(progress, [25, 100]);
  xhr.respond(200, published());
  assert.equal((await result).android.version_code, 19);
  controller.abort();
  assert.equal(xhr.aborted, undefined);
});

test("XHR supports preflight/active cancellation and localizes HTTP errors without exposing response content", async () => {
  const h = uploadTransport(), before = new AbortController();
  before.abort();
  await assert.rejects(h.upload(apk(), "", () => {}, before.signal), (error) => error.name === "AbortError");
  assert.equal(h.instances.length, 0);
  const active = new AbortController();
  const pending = h.upload(apk(), "", () => {}, active.signal);
  active.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(h.instances[0].aborted, true);
  const failure = h.upload(apk(), "", () => {}, new AbortController().signal);
  h.instances[1].respond(413, { error: "Private upstream details" });
  await assert.rejects(failure, (error) => error.status === 413 && error.message !== "Private upstream details");
});
