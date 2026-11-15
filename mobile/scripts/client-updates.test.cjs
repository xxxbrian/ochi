const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function load(file, imports = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module, exports: module.exports, URL, Date, Error, AbortController, setTimeout, clearTimeout,
    require(name) {
      if (!(name in imports)) throw new Error(`Unexpected import ${name}`);
      return imports[name];
    },
  }, { filename: file });
  return module.exports;
}
const core = load("src/lib/clientUpdates.ts");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(setImmediate);
const sha = "a".repeat(64);
const release = {
  version_name: "0.2.0", version_code: 14, size_bytes: 1000, sha256: sha,
  download_url: `/api/client-releases/android/${sha}.apk`, release_notes: "Synthetic release",
  published_at: "2026-11-16T00:00:00Z",
};
const manifest = (android = release) => ({ android, ios: { url: "https://distribution.example/ios" } });
function fixture(platform = "android") {
  const calls = { checks: [], downloads: [], removed: [], installs: [], permissions: 0, opened: [], verifies: 0, clears: 0 };
  const state = { now: 1, version: 13, allowed: false, replies: [], download: null, verifyError: null };
  const driver = {
    platform, now: () => state.now,
    installed: async () => ({ packageName: "co.bojin.ochi", versionName: "0.1.0", versionCode: state.version }),
    releases: async (server, signal) => {
      calls.checks.push({ server, signal });
      const reply = state.replies.shift() ?? manifest();
      if (reply instanceof Error) throw reply;
      return reply.promise ?? reply;
    },
    download: async (...args) => {
      calls.downloads.push(args);
      return state.download ? state.download.promise : "/cache/client-updates/one/update.apk";
    },
    verify: async () => { calls.verifies++; if (state.verifyError) throw state.verifyError; },
    remove: async (path) => { calls.removed.push(path); },
    clearCache: async () => { calls.clears++; },
    canInstall: async () => state.allowed,
    openPermissionSettings: async () => { calls.permissions++; },
    openInstaller: async (path) => { calls.installs.push(path); },
    openIOS: async (url) => { calls.opened.push(url); },
  };
  return { calls, state, driver, controller: core.createClientUpdateController(driver) };
}

test("automatic checks follow the selected backend, throttle success/failure and ignore old backend responses", async () => {
  const f = fixture();
  await f.controller.configure("https://one.example");
  await f.controller.foreground();
  await f.controller.foreground();
  assert.equal(f.calls.checks.length, 1);
  assert.equal(f.controller.getSnapshot().showNotice, true);
  await f.controller.check(true);
  assert.equal(f.calls.checks.length, 2);
  const pending = deferred();
  f.state.replies.push(pending);
  const old = f.controller.check(true);
  await flush();
  await f.controller.configure("http://self-hosted.example");
  assert.equal(f.calls.checks.at(-1).signal.aborted, true);
  f.state.replies.push(new Error("offline"));
  await f.controller.foreground();
  assert.equal(f.controller.getSnapshot().error, "check");
  await f.controller.foreground();
  assert.equal(f.calls.checks.length, 4);
  f.state.now += 15 * 60 * 1000;
  await f.controller.foreground();
  assert.equal(f.calls.checks.length, 5);
  assert.equal(f.calls.checks.at(-1).server, "http://self-hosted.example");
  pending.resolve(manifest({ ...release, version_code: 999 }));
  await old;
  assert.equal(f.controller.getSnapshot().releases.android.version_code, 14);
});

test("versionCode controls availability and dismissing a notice does not hide a later release", async () => {
  const f = fixture();
  await f.controller.configure("https://one.example");
  for (const code of [12, 13]) {
    f.state.replies.push(manifest({ ...release, version_code: code }));
    await f.controller.check(true);
    assert.equal(core.availableAndroidRelease(f.controller.getSnapshot()), null);
  }
  await f.controller.check(true);
  f.controller.dismissNotice();
  await f.controller.check(true);
  assert.equal(f.controller.getSnapshot().showNotice, false);
  f.state.replies.push(manifest({ ...release, version_code: 15, sha256: "b".repeat(64) }));
  await f.controller.check(true);
  assert.equal(f.controller.getSnapshot().showNotice, true);
});

test("iOS never checks automatically and only opens the administrator link after an explicit action", async () => {
  const f = fixture("ios");
  await f.controller.configure("https://one.example");
  await f.controller.foreground();
  await f.controller.check();
  assert.equal(f.calls.checks.length, 0);
  await f.controller.check(true);
  assert.equal(f.controller.getSnapshot().showNotice, false);
  assert.equal(f.calls.opened.length, 0);
  await f.controller.openIOS();
  assert.equal(f.calls.opened[0], "https://distribution.example/ios");
  assert.equal(f.calls.downloads.length, 0);
});

test("cancel and backend changes discard late downloads without keeping or installing old files", async () => {
  const f = fixture();
  await f.controller.configure("https://one.example"); await f.controller.check();
  f.state.download = deferred();
  const operation = f.controller.download();
  await flush();
  f.calls.downloads[0][3](450);
  assert.equal(f.controller.getSnapshot().received, 450);
  f.controller.cancel();
  assert.equal(f.calls.downloads[0][2].aborted, true);
  f.state.download.resolve("/cache/client-updates/cancelled/update.apk");
  await operation;
  assert.equal(f.controller.getSnapshot().localPath, null);
  assert.ok(f.calls.removed.includes("/cache/client-updates/cancelled/update.apk"));
  f.state.download = deferred();
  const next = f.controller.download();
  await flush();
  await f.controller.configure("https://two.example");
  f.state.download.resolve("/cache/client-updates/old-server/update.apk");
  await next;
  assert.equal(f.controller.getSnapshot().server, "https://two.example");
  assert.equal(f.controller.getSnapshot().localPath, null);
  assert.equal(f.calls.installs.length, 0);
});

test("failed downloads retry and a verification failure can never launch the installer", async () => {
  const f = fixture();
  await f.controller.configure("https://one.example"); await f.controller.check();
  f.state.download = deferred();
  const attempt = f.controller.download(); await flush();
  f.state.download.reject(new core.ClientUpdateError("integrity")); await attempt;
  assert.equal(f.controller.getSnapshot().error, "integrity");
  await f.controller.install();
  assert.equal(f.calls.installs.length, 0);
  f.state.download = null;
  await f.controller.download();
  f.state.verifyError = new core.ClientUpdateError("integrity");
  await f.controller.install();
  assert.equal(f.calls.verifies, 1);
  assert.equal(f.controller.getSnapshot().localPath, null);
  assert.equal(f.calls.installs.length, 0);
});

test("an unavailable APK refreshes its manifest once and requires an explicit download of the replacement", async () => {
  const f = fixture();
  await f.controller.configure("https://one.example"); await f.controller.check();
  const replacement = {
    ...release, version_code: 15, sha256: "b".repeat(64),
    download_url: `/api/client-releases/android/${"b".repeat(64)}.apk`,
  };
  f.state.download = deferred();
  f.state.replies.push(manifest(replacement));
  const attempt = f.controller.download(); await flush();
  f.state.download.reject(new core.ClientReleaseUnavailableError());
  await attempt;
  assert.equal(f.calls.checks.length, 2);
  assert.equal(f.calls.downloads.length, 1);
  assert.equal(f.controller.getSnapshot().releases.android.sha256, replacement.sha256);
  assert.equal(f.controller.getSnapshot().error, "download");
  assert.equal(f.controller.getSnapshot().checking, false);
  f.state.download = null;
  await f.controller.download();
  assert.equal(f.calls.downloads.length, 2);
  assert.equal(f.calls.downloads.at(-1)[1].sha256, replacement.sha256);
});

test("an unpublished APK removes the stale candidate while a failed recovery remains a check failure", async () => {
  for (const outcome of ["unpublished", "offline"]) {
    const f = fixture();
    await f.controller.configure("https://one.example"); await f.controller.check();
    f.state.download = deferred();
    f.state.replies.push(outcome === "unpublished" ? manifest(null) : new Error("offline"));
    const attempt = f.controller.download(); await flush();
    f.state.download.reject(new core.ClientReleaseUnavailableError());
    await attempt;
    const state = f.controller.getSnapshot();
    assert.equal(f.calls.checks.length, 2);
    assert.equal(state.releases.android, null);
    assert.equal(state.checked, outcome === "unpublished");
    assert.equal(state.error, outcome === "unpublished" ? "download" : "check");
    assert.equal(state.checking, false);
    assert.equal(state.showNotice, false);
    await f.controller.download();
    assert.equal(f.calls.downloads.length, 1);
    if (outcome === "offline") {
      await f.controller.check(true);
      assert.equal(f.controller.getSnapshot().error, null);
      assert.equal(f.controller.getSnapshot().releases.android.sha256, release.sha256);
      assert.equal(f.calls.downloads.length, 1);
    }
  }
});

test("ordinary download failures keep explicit retry without refreshing the manifest", async () => {
  const f = fixture();
  await f.controller.configure("https://one.example"); await f.controller.check();
  f.state.download = deferred();
  const attempt = f.controller.download(); await flush();
  f.state.download.reject(new core.ClientUpdateError("download")); await attempt;
  assert.equal(f.calls.checks.length, 1);
  assert.equal(f.controller.getSnapshot().releases.android.sha256, release.sha256);
  assert.equal(f.controller.getSnapshot().error, "download");
});

test("cancelling stale-release recovery or changing backend aborts it and ignores its late manifest", async () => {
  for (const change of ["cancel", "backend"]) {
    const f = fixture();
    await f.controller.configure("https://one.example"); await f.controller.check();
    const pending = deferred();
    f.state.replies.push(pending);
    f.state.download = deferred();
    const attempt = f.controller.download(); await flush();
    f.state.download.reject(new core.ClientReleaseUnavailableError()); await flush();
    assert.equal(f.controller.getSnapshot().checking, true);
    const recoverySignal = f.calls.checks.at(-1).signal;
    if (change === "cancel") f.controller.cancel();
    else {
      await f.controller.configure("https://two.example");
      f.state.replies.push(manifest(null));
      await f.controller.check(true);
    }
    assert.equal(recoverySignal.aborted, true);
    pending.resolve(manifest({ ...release, version_code: 999 }));
    await attempt;
    const state = f.controller.getSnapshot();
    assert.equal(state.checking, false);
    assert.equal(state.releases.android, null);
    assert.equal(state.server, change === "cancel" ? "https://one.example" : "https://two.example");
    assert.equal(state.error, null);
    assert.equal(f.calls.downloads.length, 1);
  }
});

test("permission return and installer cancellation leave explicit retry, while a completed update clears the cache", async () => {
  const f = fixture();
  await f.controller.configure("https://one.example"); await f.controller.check(); await f.controller.download();
  await f.controller.install();
  assert.equal(f.controller.getSnapshot().phase, "permission");
  assert.equal(f.calls.installs.length, 0);
  await f.controller.openPermissionSettings();
  assert.equal(f.calls.permissions, 1);
  f.state.allowed = true;
  await f.controller.foreground();
  assert.equal(f.controller.getSnapshot().phase, "ready");
  assert.equal(f.calls.installs.length, 0);
  await f.controller.install();
  await f.controller.foreground();
  assert.equal(f.controller.getSnapshot().phase, "ready");
  await f.controller.install();
  assert.equal(f.calls.installs.length, 2);
  f.state.version = 14;
  await f.controller.foreground();
  assert.equal(f.controller.getSnapshot().localPath, null);
  assert.equal(f.controller.getSnapshot().showNotice, false);
  assert.equal(f.calls.clears, 1);
});

test("cancelling verification or changing backend before native permission resolves cannot open an installer", async () => {
  for (const change of ["cancel", "backend"]) {
    const f = fixture();
    const pending = deferred();
    f.driver.verify = () => pending.promise;
    f.state.allowed = true;
    await f.controller.configure("https://one.example"); await f.controller.check(); await f.controller.download();
    const installing = f.controller.install();
    await flush();
    if (change === "cancel") f.controller.cancel();
    else await f.controller.configure("https://two.example");
    pending.resolve(); await installing;
    assert.equal(f.calls.installs.length, 0);
  }
});

function nativeFixture() {
  const calls = { requests: [], removed: [], opened: [], manifests: [], progress: null, cancels: 0 };
  const state = { size: 1000, digest: sha, archive: { packageName: "co.bojin.ochi", versionName: "0.2.0", versionCode: 14 }, reply: null };
  const native = {
    getInstalledVersion: async () => ({ packageName: "co.bojin.ochi", versionName: "0.1.0", versionCode: 13 }),
    inspectApk: async () => state.archive, canRequestPackageInstalls: async () => true,
    openInstallPermissionSettings: async () => {},
  };
  const BlobUtil = {
    fs: { hash: async () => state.digest },
    android: { actionViewIntent: async (...args) => { calls.opened.push(args); } },
    config: (config) => ({ fetch(...args) {
      calls.requests.push({ config, args });
      const task = state.reply?.promise ?? Promise.resolve({ info: () => ({ status: 200 }) });
      task.progress = (_config, callback) => { calls.progress = callback; return task; };
      task.cancel = async () => { calls.cancels++; state.reply?.reject(new Error("cancelled")); };
      return task;
    } }),
  };
  const module = load("src/lib/clientUpdateNative.ts", {
    "./clientUpdates": core,
    "expo/fetch": { fetch: async (...args) => { calls.manifests.push(args); return { ok: true, json: async () => manifest() }; } },
    "expo-file-system/legacy": {
      cacheDirectory: "file:///private/cache/", makeDirectoryAsync: async () => {},
      getInfoAsync: async () => ({ exists: true, size: state.size }),
      deleteAsync: async (path) => { calls.removed.push(path); },
    },
    "react-native": { Platform: { OS: "android" }, NativeModules: { OchiClientInstaller: native }, Linking: { openURL: async (url) => { calls.opened.push(url); } } },
    "react-native-blob-util": { __esModule: true, default: BlobUtil },
  });
  return { ...module, calls, state };
}

test("manifest validation accepts self-hosted HTTP and arbitrary HTTPS iOS links but rejects unsafe metadata and origins", () => {
  const f = nativeFixture();
  assert.equal(f.androidDownloadURL("http://self.example", release), `http://self.example${release.download_url}`);
  assert.equal(f.iosDistributionURL("https://landing.example/get-app"), "https://landing.example/get-app");
  for (const url of ["javascript:alert(1)", "http://example.com", "data:abc", "https://user:pass@example.com"])
    assert.throws(() => f.iosDistributionURL(url));
  for (const patch of [
    { download_url: `https://other.example${release.download_url}` }, { download_url: `${release.download_url}?token=private` },
    { download_url: "/other.apk" }, { sha256: "bad" }, { size_bytes: -1 }, { version_code: 1.1 }, { published_at: "bad" },
  ]) assert.throws(() => f.parseClientReleases(manifest({ ...release, ...patch }), "https://one.example"));
  assert.throws(() => f.parseClientReleases({ ios: null }, "https://one.example"));
});

test("native manifest version bounds match the server's safe integers and Unicode codepoint limit", () => {
  const f = nativeFixture();
  for (const version_code of [2100000001, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
    for (const version_name of ["v".repeat(1024), "🐾".repeat(1024)]) {
      const candidate = { ...release, version_code, version_name };
      assert.equal(f.parseClientReleases(manifest(candidate), "https://one.example").android, candidate);
    }
  }
  for (const patch of [
    { version_code: 0 }, { version_code: Number.MAX_SAFE_INTEGER + 1 },
    { version_name: "v".repeat(1025) }, { version_name: "🐾".repeat(1025) },
    { version_name: "\t " }, { version_name: "version\0name" },
    { version_name: "version\rname" }, { version_name: "version\nname" },
  ]) assert.throws(() => f.parseClientReleases(manifest({ ...release, ...patch }), "https://one.example"));
});

test("manifest checks are anonymous and APK bytes stream into private native cache without following redirects", async () => {
  const f = nativeFixture();
  const signal = new AbortController().signal;
  await f.clientUpdateDriver.releases("https://one.example", signal);
  assert.equal(f.calls.manifests[0][0], "https://one.example/api/client-releases");
  assert.equal(f.calls.manifests[0][1].credentials, "omit");
  assert.equal(f.calls.manifests[0][1].redirect, "error");
  const local = await f.clientUpdateDriver.download("https://one.example", release, signal, () => {}, () => {});
  assert.match(local, /^\/private\/cache\/client-updates\/.+\/update\.apk$/);
  assert.equal(f.calls.requests[0].config.followRedirect, false);
  assert.equal(f.calls.requests[0].config.trusty, false);
  assert.equal(f.calls.requests[0].args[2].Authorization, undefined);
  assert.equal(f.calls.opened.length, 0);
});

test("size, SHA256 and APK identity mismatches remove downloaded bytes and never open installation", async () => {
  for (const patch of [
    { size: 999 }, { digest: "b".repeat(64) }, { archive: { packageName: "other.app", versionName: "0.2.0", versionCode: 14 } },
    { archive: { packageName: "co.bojin.ochi", versionName: "0.2.0", versionCode: 13 } },
  ]) {
    const f = nativeFixture();
    Object.assign(f.state, patch);
    await assert.rejects(f.clientUpdateDriver.download("https://one.example", release, new AbortController().signal, () => {}, () => {}));
    assert.equal(f.calls.removed.length, 1);
    assert.equal(f.calls.opened.length, 0);
  }
});

test("native download cancellation and oversized streaming responses cancel and remove partial files", async () => {
  for (const mode of ["cancel", "oversize"]) {
    const f = nativeFixture();
    f.state.reply = deferred();
    const controller = new AbortController();
    const downloading = f.clientUpdateDriver.download("https://one.example", release, controller.signal, () => {}, () => {});
    await flush();
    if (mode === "cancel") controller.abort();
    else f.calls.progress(1001, 1001);
    await assert.rejects(downloading);
    assert.equal(f.calls.cancels, 1);
    assert.equal(f.calls.removed.length, 1);
    assert.equal(f.calls.opened.length, 0);
  }
});

test("only unavailable APK responses classify the publication as stale and all failures clean partial bytes", async () => {
  for (const status of [404, 410, 500]) {
    const f = nativeFixture();
    f.state.reply = { promise: Promise.resolve({ info: () => ({ status }) }) };
    await assert.rejects(
      f.clientUpdateDriver.download("https://one.example", release, new AbortController().signal, () => {}, () => {}),
      (error) => error instanceof core.ClientUpdateError &&
        (error instanceof core.ClientReleaseUnavailableError) === (status !== 500),
    );
    assert.equal(f.calls.removed.length, 1);
    assert.equal(f.calls.opened.length, 0);
  }
});

function updateScreen(f, platform) {
  const React = require("react");
  const { createI18n } = require("./helpers/i18n.cjs");
  const locale = createI18n({ locale: "en", react: React });
  const primitive = new Proxy({}, { get: (_target, key) => key });
  return load("src/screens/ClientUpdatesScreen.tsx", {
    react: React, "react/jsx-runtime": require("react/jsx-runtime"),
    "react-native": { ...primitive, Platform: { OS: platform }, ScrollView: "ScrollView", View: "View", StyleSheet: { create: (value) => value } },
    "lucide-react-native": primitive, "../lib/i18n": locale.native, "../lib/clientUpdates": core,
    "../providers/AppProvider": { useTheme: () => ({ colors: {} }) },
    "../providers/ClientReleaseProvider": { useClientUpdates: () => ({
      controller: f.controller,
      state: React.useSyncExternalStore(f.controller.subscribe, f.controller.getSnapshot),
    }) },
    "../components/ScreenChrome": { AppText: "AppText", Button: "Button", SettingRow: "SettingRow", Surface: "Surface" },
    "../components/SettingsChrome": { SettingsHeader: "SettingsHeader", SettingsPage: "SettingsPage", settingsStyles: {} },
    "../components/artifactFiles": { fileSize: () => "1 KB" },
  }).ClientUpdatesScreen;
}

test("the actual Android settings screen exposes progress/cancel, permission instructions and a retryable install action", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require("react");
  const { create, act } = require("react-test-renderer");
  const f = fixture();
  await f.controller.configure("https://one.example");
  const Screen = updateScreen(f, "android");
  let tree;
  await act(async () => { tree = create(React.createElement(Screen)); await flush(); });
  try {
    const button = (label) => tree.root.findAllByType("Button").find((node) => node.props.children === label);
    f.state.download = deferred();
    await act(async () => { button("Download update").props.onPress(); await flush(); });
    assert.ok(button("Cancel"));
    await act(async () => f.calls.downloads[0][3](500));
    assert.equal(tree.root.findByProps({ accessibilityRole: "progressbar" }).props.accessibilityValue.now, 50);
    await act(async () => { f.state.download.resolve("/cache/client-updates/one/update.apk"); await flush(); });
    await act(async () => { button("Install update").props.onPress(); await flush(); });
    assert.ok(button("Open installation settings"));
    assert.equal(f.calls.installs.length, 0);
    await act(async () => { f.state.allowed = true; await f.controller.foreground(); });
    assert.ok(button("Install update"));
    assert.equal(f.calls.installs.length, 0);
  } finally { await act(async () => tree.unmount()); }
});

test("the actual iOS settings screen only offers its HTTPS distribution link and never an APK action", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require("react");
  const { create, act } = require("react-test-renderer");
  const f = fixture("ios");
  await f.controller.configure("https://one.example");
  const Screen = updateScreen(f, "ios");
  let tree;
  await act(async () => { tree = create(React.createElement(Screen)); await flush(); });
  try {
    assert.equal(tree.root.findAllByType("Button").length, 0);
    assert.equal(f.calls.opened.length, 0);
    const link = tree.root.findAllByType("SettingRow").find((node) => node.props.title === "Open iOS download link");
    await act(async () => { link.props.onPress(); await flush(); });
    assert.equal(f.calls.opened[0], "https://distribution.example/ios");
    assert.equal(f.calls.downloads.length, 0);
  } finally { await act(async () => tree.unmount()); }
});
