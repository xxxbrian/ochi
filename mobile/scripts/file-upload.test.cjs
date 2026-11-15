const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { createI18n, testI18n } = require("./helpers/i18n.cjs");

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const response = (status, value) => ({ info: () => ({ status }), json: () => value });
const artifact = { id: "uploaded", name: "Report.bin", mime_type: "application/octet-stream", size: 137, url: "/api/files/uploaded" };

async function uploadHarness(t, { size = 137, sourceType = "application/x-local", locale = "en" } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ochi-native-upload-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cache = path.join(directory, "cache");
  fs.mkdirSync(cache);
  const sourcePath = path.join(directory, "本地 Résumé 🚀.bin");
  const descriptor = fs.openSync(sourcePath, "w");
  fs.ftruncateSync(descriptor, size);
  fs.writeSync(descriptor, "begin", 0, "utf8");
  fs.writeSync(descriptor, "end", size - 3, "utf8");
  fs.closeSync(descriptor);
  const file = { uri: pathToFileURL(sourcePath).href, name: "报告 Résumé 🚀.bin" };
  const storage = new Map([["ochi.server.v1", "https://api.example"], ["ochi.auth.v1", "fixture-token"]]);
  const state = { bytesCalls: 0, response: response(200, artifact), loginToken: "next-token" };
  const calls = { requests: [], events: [], jsonRequests: [] };
  const started = deferred();
  const BlobUtil = {
    fs: {
      dirs: { CacheDir: cache },
      async createFile(destination, data, encoding) {
        calls.events.push({ kind: "create", destination, data, encoding });
        assert.equal(encoding, "utf8");
        await fs.promises.writeFile(destination, data, encoding);
      },
      async stat(local) {
        const stat = await fs.promises.stat(local);
        return { size: stat.size, type: stat.isFile() ? "file" : "directory" };
      },
      async appendFile(destination, data, encoding) {
        calls.events.push({ kind: "append", destination, data, encoding });
        if (encoding === "uri") {
          await state.beforeCopy?.();
          if (state.copyFailure) throw state.copyFailure;
          // The native boundary copies disk streams; no file payload enters api.ts.
          await pipeline(fs.createReadStream(data, state.shortCopy ? { end: 31 } : {}), fs.createWriteStream(destination, { flags: "a" }));
          return fs.statSync(data).size;
        }
        assert.equal(encoding, "utf8");
        await fs.promises.appendFile(destination, data, encoding);
        return Buffer.byteLength(data);
      },
      async unlink(destination) {
        calls.events.push({ kind: "unlink", destination });
        await fs.promises.unlink(destination);
        await state.beforeUnlink?.();
      },
    },
    wrap(local) { return `ReactNativeBlobUtil-file://${local}`; },
    config(config) {
      return { async fetch(method, url, headers, body) {
        assert.equal(typeof body, "string", "request body must be a native file reference");
        assert.ok(body.startsWith("ReactNativeBlobUtil-file://"));
        const call = { config, method, url, headers, body, path: body.slice("ReactNativeBlobUtil-file://".length) };
        calls.requests.push(call);
        calls.events.push({ kind: "fetch" });
        started.resolve(call);
        if (state.transportFailure) throw state.transportFailure;
        return state.fetch ? state.fetch(call) : state.response;
      } };
    },
  };
  const h = createI18n({ locale, secureStore: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
    getItemAsync: async (key) => storage.get(key) ?? null,
    setItemAsync: async (key, value) => { storage.set(key, value); },
    deleteItemAsync: async (key) => { storage.delete(key); },
  }, imports: {
    "expo/fetch": { async fetch(url, init) {
      calls.jsonRequests.push({ url, ...init });
      return { ok: true, status: 200, json: async () => ({ id: "next-account", access_token: state.loginToken }) };
    } },
    "expo-file-system": { File: class {
      constructor(uri) { this.uri = uri; }
      get size() { return fs.statSync(sourcePath).size; }
      get type() { return sourceType; }
      bytes() { state.bytesCalls++; throw new Error("whole-file JS reads are forbidden"); }
    } },
    "react-native-blob-util": { __esModule: true, default: BlobUtil },
  } });
  const api = h.load("src/lib/api.ts");
  await api.restoreCredentials();
  return { ...h, api, state, calls, file, cache, sourcePath, storage, started: started.promise };
}

async function digest(readable) {
  const hash = createHash("sha256");
  for await (const chunk of readable) hash.update(chunk);
  return hash.digest("hex");
}

test("a real file above 32MiB uses native disk multipart and preserves Unicode without reading JS bytes", async (t) => {
  const size = (40 << 20) + 137;
  const f = await uploadHarness(t, { size, locale: "zh-TW" });
  f.state.fetch = async (call) => {
    const prefix = f.calls.events.find((event) => event.kind === "create").data;
    const suffix = f.calls.events.findLast((event) => event.kind === "append" && event.encoding === "utf8").data;
    assert.match(prefix, /filename="报告 Résumé 🚀\.bin"/);
    assert.doesNotMatch(prefix, /%E6|%F0|%C3/i);
    assert.match(prefix, /Content-Type: application\/x-local\r\n/);
    const offset = Buffer.byteLength(prefix);
    assert.equal(fs.statSync(call.path).size, offset + size + Buffer.byteLength(suffix));
    assert.equal(
      await digest(fs.createReadStream(call.path, { start: offset, end: offset + size - 1 })),
      await digest(fs.createReadStream(f.sourcePath)),
    );
    const handle = await fs.promises.open(call.path);
    try {
      const ending = Buffer.alloc(Buffer.byteLength(suffix));
      await handle.read(ending, 0, ending.length, offset + size);
      assert.equal(ending.toString("utf8"), suffix);
    } finally { await handle.close(); }
    return response(200, { ...artifact, size });
  };
  const result = await f.api.api.upload(f.file);
  assert.equal(result.size, size);
  assert.equal(f.state.bytesCalls, 0);
  const call = f.calls.requests[0];
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://api.example/api/files");
  assert.equal(call.headers.Authorization, "Bearer fixture-token");
  assert.equal(call.headers["Accept-Language"], "zh-TW");
  assert.equal(call.headers["X-Client-Timezone"], Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  assert.match(call.headers["Content-Type"], /^multipart\/form-data; boundary=ochi-/);
  assert.equal(call.headers["Transfer-Encoding"], "chunked", "iOS must use HTTPBodyStream rather than NSData");
  assert.equal(call.config.followRedirect, false);
  assert.equal(call.config.trusty, false);
  assert.ok(call.config.timeout >= 600000);
  assert.equal(f.calls.events.filter((event) => event.encoding === "uri")[0].data, f.sourcePath);
  assert.deepEqual(fs.readdirSync(f.cache), []);
});

test("multipart metadata retains explicit MIME, sanitizes header delimiters and falls back to octet stream", async (t) => {
  for (const sourceType of ["application/x-local", ""]) {
    const f = await uploadHarness(t, { sourceType });
    await f.api.api.upload({ ...f.file, name: '报告"\\\r\n.bin', mimeType: "video/mp4\r\n" });
    const prefix = f.calls.events.find((event) => event.kind === "create").data;
    assert.match(prefix, /filename="报告____\.bin"/);
    assert.match(prefix, /Content-Type: video\/mp4\r\n\r\n$/);
    f.calls.events.length = 0;
    await f.api.api.upload(f.file);
    assert.ok(f.calls.events[0].data.includes(`Content-Type: ${sourceType || "application/octet-stream"}\r\n`));
    assert.equal(f.state.bytesCalls, 0);
    assert.deepEqual(fs.readdirSync(f.cache), []);
  }
});

test("native upload failures retain typed 401/413 public errors without showing private diagnostics", async (t) => {
  const f = await uploadHarness(t, { locale: "zh-TW" });
  let expired = 0;
  f.api.setUnauthorizedHandler(() => { expired++; });
  for (const [status, code] of [[413, "payload_too_large"], [401, undefined], [500, "unrecognized"]]) {
    f.state.response = response(status, { code, params: { max: 1073741824 }, error: "private upstream /data/file token=secret" });
    await assert.rejects(f.api.api.upload(f.file), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.equal(error.params.max, 1073741824);
      assert.equal(error.detail, "private upstream /data/file token=secret");
      assert.doesNotMatch(error.message, /private upstream|\/data|secret/);
      const translated = f.load("../shared/i18n/errors.ts").translateError(code, error.params);
      assert.equal(error.message, translated || f.native.t(status === 401 ? "error.signInAgain" : "error.serviceUnavailable"));
      return true;
    });
  }
  assert.equal(expired, 1);
  assert.deepEqual(fs.readdirSync(f.cache), []);
});

test("redirects are rejected once and neither file bytes nor authorization are forwarded", async (t) => {
  const f = await uploadHarness(t);
  f.state.response = {
    info: () => ({ status: 307, headers: { Location: "https://external.invalid/private" } }),
    json() { throw new Error("redirect HTML is not JSON"); },
  };
  await assert.rejects(f.api.api.upload(f.file), (error) => error.status === 307 && !error.message.includes("external.invalid"));
  assert.equal(f.calls.requests.length, 1);
  assert.equal(f.calls.requests[0].url, "https://api.example/api/files");
  assert.equal(f.calls.requests[0].config.followRedirect, false);
  assert.deepEqual(fs.readdirSync(f.cache), []);
  for (const uri of ["https://external.invalid/file", "http://external.invalid/file", "file://external.invalid/private"]) {
    await assert.rejects(f.api.api.upload({ ...f.file, uri }));
  }
  assert.equal(f.calls.requests.length, 1);
});

test("transport, partial spool and malformed success failures clear their temporary files and hide native diagnostics", async (t) => {
  for (const phase of ["copy", "short-copy", "transport", "json"]) {
    const f = await uploadHarness(t);
    const privateFailure = new Error("native failure /private/path token=secret https://private.invalid");
    if (phase === "copy") f.state.copyFailure = privateFailure;
    if (phase === "short-copy") f.state.shortCopy = true;
    if (phase === "transport") f.state.transportFailure = privateFailure;
    if (phase === "json") f.state.response = { info: () => ({ status: 200 }), json() { throw privateFailure; } };
    await assert.rejects(f.api.api.upload(f.file), (error) => {
      assert.equal(error.message, f.native.t(phase === "transport" ? "error.connection" : "error.upload"));
      assert.doesNotMatch(error.message, /private|secret/);
      return true;
    });
    if (phase === "copy" || phase === "short-copy") assert.equal(f.calls.requests.length, 0);
    assert.deepEqual(fs.readdirSync(f.cache), []);
  }
});

test("late successful or unauthorized replies from an old backend cannot enter the current account", async (t) => {
  for (const status of [200, 401]) {
    const f = await uploadHarness(t);
    const late = deferred();
    f.state.fetch = () => late.promise;
    let expired = 0;
    f.api.setUnauthorizedHandler(() => { expired++; });
    const pending = f.api.api.upload(f.file);
    const rejected = assert.rejects(pending, (error) => error.status === undefined && error.message === f.native.t("error.upload"));
    await f.started;
    await f.api.setAPIBaseURL("https://next.example");
    await f.api.api.login("next", "fixture");
    late.resolve(response(status, artifact));
    await rejected;
    assert.equal(expired, 0);
    assert.equal(f.api.authHeaders().Authorization, "Bearer next-token");
    assert.equal(f.calls.requests.length, 1);
    assert.equal(f.calls.requests[0].headers.Authorization, "Bearer fixture-token");
    assert.deepEqual(fs.readdirSync(f.cache), []);
  }
});

test("account changes during response parsing, spooling or cleanup invalidate the whole upload operation", async (t) => {
  for (const phase of ["json", "copy", "cleanup", "cleanup-401"]) {
    const f = await uploadHarness(t);
    const entered = deferred(), release = deferred();
    if (phase === "json") f.state.response = { info: () => ({ status: 401 }), json() { entered.resolve(); return release.promise; } };
    if (phase === "copy") f.state.beforeCopy = () => { entered.resolve(); return release.promise; };
    if (phase.startsWith("cleanup")) f.state.beforeUnlink = () => { entered.resolve(); return release.promise; };
    if (phase === "cleanup-401") f.state.response = response(401, { error: "private expired account" });
    let expired = 0;
    f.api.setUnauthorizedHandler(() => { expired++; });
    const pending = f.api.api.upload(f.file);
    const rejected = assert.rejects(pending, (error) => error.status === undefined);
    await entered.promise;
    await f.api.clearCredentials();
    // Returning to the same origin/token still represents a newer operation owner.
    f.storage.set("ochi.auth.v1", "fixture-token");
    await f.api.restoreCredentials();
    release.resolve(artifact);
    await rejected;
    assert.equal(expired, 0);
    if (phase === "copy") assert.equal(f.calls.requests.length, 0);
    assert.deepEqual(fs.readdirSync(f.cache), []);
  }
});

test("Composer sends large picker files through upload without a second 32MiB rejection", async () => {
  const React = require("react");
  const { create, act } = require("react-test-renderer");
  const { createLoader } = require("../../shared/conversation/test-loader.cjs");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = path.resolve(__dirname, "../..");
  const selected = { uri: "file:///cache/large.mov", name: "large.mov", size: 80 << 20, mimeType: "video/quicktime" };
  const uploaded = [];
  const primitive = new Proxy({}, { get: (_target, key) => key });
  const load = createLoader(require("typescript"), require, {
    "react-native": {
      ...Object.fromEntries(["View", "Text", "TextInput", "Pressable", "ScrollView", "Switch", "ActivityIndicator"].map((name) => [name, name])),
      Platform: { OS: "android" }, StyleSheet: { create: (value) => value, hairlineWidth: 0.5 },
      useWindowDimensions: () => ({ width: 393, height: 852, fontScale: 1 }),
    },
    "lucide-react-native": primitive,
    "expo-document-picker": { getDocumentAsync: async () => ({ canceled: false, assets: [selected] }) },
    "expo-image-picker": {},
    "expo-secure-store": { getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
    [path.join(root, "mobile/src/lib/i18n.ts")]: testI18n.native,
    [path.join(root, "mobile/src/lib/errors.ts")]: testI18n.load("src/lib/errors.ts"),
    [path.join(root, "mobile/src/lib/api.ts")]: { api: { upload: async (file) => { uploaded.push(file); return artifact; } } },
    [path.join(root, "mobile/src/providers/AppProvider.tsx")]: { useTheme: () => ({ dark: false, colors: {}, fonts: {} }) },
    [path.join(root, "mobile/src/ui/GlassSurface.tsx")]: { GlassSurface: "GlassSurface" },
    [path.join(root, "mobile/src/ui/AnchoredMenu.tsx")]: { AnchoredMenu: "AnchoredMenu" },
    [path.join(root, "mobile/src/ui/Sheet.tsx")]: { Sheet: "Sheet" },
    [path.join(root, "mobile/src/ui/IconButton.tsx")]: { IconButton: "IconButton" },
    [path.join(root, "mobile/src/components/ScreenChrome.tsx")]: {
      AppText: "AppText", ActionIcon: "ActionIcon", ErrorNotice: "ErrorNotice", Field: "Field", Button: "Button",
    },
    [path.join(root, "mobile/src/components/Artifacts.tsx")]: { ArtifactCards: "ArtifactCards" },
    [path.join(root, "mobile/src/components/ModelIcon.tsx")]: { ModelIcon: "ModelIcon" },
  });
  const { Composer } = load(path.join(root, "mobile/src/components/Composer.tsx"));
  const noop = () => {};
  let tree;
  await act(async () => {
    tree = create(React.createElement(Composer, {
      draftKey: "upload-fixture", models: [], modelId: "", effort: "", onModel: noop, onEffort: noop,
      computerEnabled: false, onComputer: noop, memoryEnabled: true, memoryGloballyEnabled: true,
      memoryFixed: false, onMemory: noop, onStop: noop, onSubmit: async () => {},
    }), { createNodeMock: () => ({ measureInWindow: (callback) => callback(0, 0, 44, 44) }) });
  });
  try {
    await act(async () => tree.root.findAllByType("Pressable").find((node) =>
      node.props.accessibilityLabel === testI18n.native.t("chat.composerOptions")).props.onPress());
    await act(async () => {
      tree.root.findByType("AnchoredMenu").props.items.find((item) => item.key === "files").onPress();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    assert.deepEqual(uploaded, [selected]);
    assert.deepEqual(tree.root.findByType("ArtifactCards").props.files, [artifact]);
  } finally { await act(async () => tree.unmount()); }
});
