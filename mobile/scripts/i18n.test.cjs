const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');
const { createI18n } = require('./helpers/i18n.cjs');

const root = path.resolve(__dirname, '..');
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const placeholders = (value) => [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((match) => match[1]).sort();

test('every native semantic message has all three translations with valid plural branches and matching placeholders', () => {
  const h = createI18n();
  const { messages } = h.load('src/lib/messages.ts');
  assert.ok(Object.keys(messages).length > 300);
  for (const [key, values] of Object.entries(messages)) {
    assert.deepEqual(Object.keys(values).sort(), ['en', 'zh-CN', 'zh-TW'], key);
    const base = typeof values.en === 'string' ? [values.en] : [values.en.one, values.en.other];
    for (const locale of h.core.locales) {
      const value = values[locale];
      const branches = typeof value === 'string' ? [value] : [value.one, value.other];
      if (typeof value !== 'string') assert.deepEqual(Object.keys(value).sort(), ['one', 'other'], `${key}: plural branches ${locale}`);
      for (const branch of branches) {
        assert.ok(branch.trim(), `${key}: empty ${locale}`);
        for (const source of base) assert.deepEqual(placeholders(branch), placeholders(source), `${key}: params ${locale}`);
      }
      h.core.setLanguage(locale);
      assert.doesNotThrow(() => h.native.t(key, { count: 1, name: 'fixture', level: 'fixture' }));
      assert.doesNotThrow(() => h.native.t(key, { count: 2, name: 'fixture', level: 'fixture' }));
    }
  }
});

test('native language bootstrap resolves scripts/regions, restores explicit choices and keeps system mode dynamic', async () => {
  const h = createI18n({ locale: 'system' });
  await h.native.restoreLanguage(['zh-HK', 'en-US']);
  assert.equal(h.native.getLocale(), 'zh-TW');
  h.core.setSystemLanguages(['zh-SG']);
  assert.equal(h.native.getLocale(), 'zh-CN');
  await h.native.rememberLanguage('en');
  h.core.setSystemLanguages(['zh-Hant-TW']);
  assert.equal(h.native.getLocale(), 'en');
  const restart = createI18n({ locale: 'system', secureStore: {
    getItemAsync: async (key) => h.storage.get(key) ?? null,
    setItemAsync: async () => {},
  } });
  await restart.native.restoreLanguage(['zh-Hant-TW']);
  assert.equal(restart.native.getLanguage(), 'en');
  assert.equal(restart.native.getLocale(), 'en');
  restart.core.setLanguage('system');
  assert.equal(restart.native.getLocale(), 'zh-TW');
  assert.equal(h.native.thinkingLevelLabel('high'), 'High');
  assert.equal(h.native.thinkingLevelLabel('on'), 'On');
});

test('language storage serializes quick selections without delaying immediate UI updates', async () => {
  const writes = [];
  const h = createI18n({ secureStore: {
    getItemAsync: async () => null,
    setItemAsync(key, value) { return new Promise((resolve) => writes.push({ key, value, resolve })); },
  } });
  const first = h.native.rememberLanguage('zh-TW');
  const second = h.native.rememberLanguage('en');
  assert.equal(h.native.getLocale(), 'en');
  await flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].value, 'zh-TW');
  writes[0].resolve(); await first; await flush();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].value, 'en');
  writes[1].resolve(); await second;
  assert.equal(h.native.getLocale(), 'en');
});

test('an unavailable optional language preference does not block authentication bootstrap', async () => {
  const h = createI18n({ locale: 'system', secureStore: {
    getItemAsync: async () => { throw new Error('optional preference unavailable'); },
    setItemAsync: async () => {},
  } });
  await h.native.restoreLanguage(['zh-Hant-TW']);
  assert.equal(h.native.getLanguage(), 'system');
  assert.equal(h.native.getLocale(), 'zh-TW');
});

test('native error notices retain semantic keys and follow language changes without exposing platform diagnostics', () => {
  const h = createI18n({ locale: 'en' });
  const { localizedError, errorForDisplay, errorText } = h.load('src/lib/errors.ts');
  const local = localizedError('error.cameraPermission');
  const unknown = errorForDisplay(new Error('KeyChainException: /private/path token=fixture-secret'), 'error.login');
  assert.equal(errorText(local), h.native.t('error.cameraPermission'));
  assert.equal(errorText(unknown), h.native.t('error.login'));
  for (const locale of ['zh-CN', 'zh-TW', 'en']) {
    h.core.setLanguage(locale);
    assert.equal(errorText(local), h.native.t('error.cameraPermission'));
    assert.equal(errorText(unknown), h.native.t('error.login'));
    assert.doesNotMatch(errorText(unknown), /KeyChain|private|fixture-secret/);
    assert.equal(errorForDisplay(local, 'error.save'), local);
  }
});

test('coded native request errors remain localized after the failed request has finished', () => {
  const h = createI18n({ locale: 'en' });
  const { errorForDisplay, errorText } = h.load('src/lib/errors.ts');
  const { translateError } = h.load('../shared/i18n/errors.ts');
  const failure = errorForDisplay({ code: 'invalid_credentials', message: 'private upstream detail' }, 'error.login');
  for (const locale of ['en', 'zh-TW', 'zh-CN']) {
    h.core.setLanguage(locale);
    assert.equal(errorText(failure), translateError('invalid_credentials'));
  }
});

function apiHarness(locale = 'en') {
  const requests = [];
  let reply = { ok: true, status: 200, json: async () => ({}) };
  const h = createI18n({ locale, secureStore: {
    getItemAsync: async (key) => ({ 'ochi.server.v1': 'https://api.example', 'ochi.auth.v1': 'fixture-token' })[key] ?? null,
    setItemAsync: async () => {}, deleteItemAsync: async () => {},
  }, imports: {
    'expo/fetch': { fetch: async (url, init) => { requests.push({ url, ...init }); return reply; } },
    'expo-file-system': { File: class {} },
  } });
  return { ...h, api: h.load('src/lib/api.ts'), requests,
    fail(status, body) { reply = { ok: false, status, json: async () => body }; },
  };
}

test('native API, authenticated resources, SSE and own-origin WebViews use the selected locale without leaking credentials externally', async () => {
  const h = apiHarness(); await h.api.restoreCredentials();
  await h.api.api.me();
  assert.equal(h.requests[0].headers['Accept-Language'], 'en');
  h.core.setLanguage('zh-TW');
  await h.api.api.me();
  assert.equal(h.requests[1].headers['Accept-Language'], 'zh-TW');
  assert.equal(h.api.webViewSource('/admin/providers').headers['Accept-Language'], 'zh-TW');
  assert.equal(h.api.resourceHeaders('/api/files/fixture')['Accept-Language'], 'zh-TW');
  assert.equal(h.api.resourceHeaders('/api/files/fixture').Authorization, 'Bearer fixture-token');
  assert.deepEqual(h.api.resourceHeaders('https://external.example/picture'), {});
  h.fail(403, { code: 'permission_denied', error: 'private upstream failure' });
  let closed;
  h.load('src/lib/sse.ts').connectRunStream('https://api.example/api/runs/fixture/events', {
    onOpen() { assert.fail('rejected stream cannot open'); }, onEvent() { assert.fail('no event'); },
    onClose(error) { closed = error; },
  });
  await flush();
  assert.equal(h.requests.at(-1).headers['Accept-Language'], 'zh-TW');
  assert.equal(closed.status, 403);
  assert.doesNotMatch(closed.message, /private upstream/);
});

test('API errors retain machine identity, translate known codes, hide unknown diagnostics and preserve login unauthorized semantics', async () => {
  const h = apiHarness('zh-TW'); await h.api.restoreCredentials();
  h.fail(502, { code: 'model_billing', error: 'quota exceeded for private-tenant' });
  await assert.rejects(h.api.api.me(), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.code, 'model_billing');
    assert.equal(error.message, h.importFor('../shared/i18n/errors').translateError('model_billing'));
    assert.doesNotMatch(error.message, /private-tenant/);
    return true;
  });
  h.core.setLanguage('en');
  h.fail(500, { code: 'unrecognized', error: 'internal Chinese or English diagnostic: fixture-secret' });
  await assert.rejects(h.api.api.me(), (error) => {
    assert.equal(error.message, h.native.t('error.serviceUnavailable'));
    assert.doesNotMatch(error.message, /fixture-secret/);
    return true;
  });
  let expired = 0;
  h.api.setUnauthorizedHandler(() => { expired++; });
  h.fail(401, { error: 'not public' });
  await assert.rejects(h.api.api.login('fixture', 'fixture'), /username|password/i);
  assert.equal(expired, 0);
  await assert.rejects(h.api.api.me(), /sign in/i);
  assert.equal(expired, 1);
});

test('native date/weekday rendering and run error projection change locale without changing model or user text', () => {
  const h = apiHarness('en');
  const content = 'Keep this exact user/model text: 简体中文 繁體中文.';
  assert.equal(h.native.weekdayNames('long')[0], 'Monday');
  const english = h.api.userFacingRunError('raw provider text', false, 'model_stream');
  h.core.setLanguage('zh-TW');
  assert.notEqual(h.native.weekdayNames('long')[0], 'Monday');
  assert.notEqual(h.api.userFacingRunError('raw provider text', false, 'model_stream'), english);
  assert.equal(h.api.userFacingRunError('private diagnostic'), h.native.t('error.run'));
  assert.equal(content, 'Keep this exact user/model text: 简体中文 繁體中文.');
});

test('the native Computer bootstraps its locale and updates a mounted viewer without reloading its authenticated source', () => {
  const h = createI18n({ locale: 'en' });
  const slots = [], effects = [], scripts = [];
  let cursor = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useMemo(create, deps) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { value: create(), deps };
      return slots[index].value;
    },
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: initial };
      return [slots[index].value, (next) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) { slots[index] = { deps }; effects.push(callback); }
    },
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const treeNodes = (node) => Array.isArray(node) ? node.flatMap(treeNodes) : node && typeof node === 'object' && 'type' in node ? [node, ...treeNodes(node.props.children)] : [];
  const module = { exports: {} };
  const output = ts.transpileModule(fs.readFileSync(path.join(root, 'src/screens/ComputerScreen.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.compileFunction(output, ['module', 'exports', 'require'], { filename: 'ComputerScreen.tsx' })(module, module.exports, (name) => {
    const translated = h.importFor(name); if (translated) return translated;
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react-native') return { ActivityIndicator: 'ActivityIndicator', View: 'View', StyleSheet: { absoluteFill: {} } };
    if (name === 'lucide-react-native') return { RefreshCw: 'RefreshCw' };
    if (name === 'react-native-webview') return { WebView: 'WebView' };
    if (name === 'react-native-safe-area-context') return { useSafeAreaInsets: () => ({ left: 0, right: 0, bottom: 0 }) };
    if (name === '../providers/AppProvider') return { useTheme: () => ({ colors: { canvas: '#fff', muted: '#888' }, dark: false }) };
    if (name === '../lib/api') return { getAPIBaseURL: () => 'https://api.example', isConfiguredAPIBaseURL: () => true, webViewSource: (next) => ({ uri: `https://api.example/api/auth/webview?next=${encodeURIComponent(next)}` }) };
    if (name === '../components/ScreenChrome') return { ActionIcon: 'ActionIcon', ErrorNotice: 'ErrorNotice', PageHeader: 'PageHeader' };
    throw new Error(`Unexpected viewer import ${name}`);
  });
  const webView = { injectJavaScript: (script) => scripts.push(script) };
  function render() {
    const shell = module.exports.ComputerScreen();
    cursor = 0;
    const tree = shell.type(shell.props);
    const nodes = treeNodes(tree), viewer = nodes.find((node) => node.type === 'WebView');
    viewer.props.ref.current = webView;
    effects.splice(0).forEach((callback) => callback());
    return { viewer, header: nodes.find((node) => node.type === 'PageHeader') };
  }
  const first = render();
  assert.equal(new URL(first.viewer.props.source.uri).searchParams.get('next'), '/native/computer?locale=en');
  h.core.setLanguage('zh-TW');
  const changed = render();
  assert.equal(changed.viewer.props.source, first.viewer.props.source);
  assert.equal(changed.viewer.key, first.viewer.key);
  assert.equal(changed.viewer.props.ref.current, webView);
  assert.match(scripts.at(-1), /ochi:native-locale/);
  assert.match(scripts.at(-1), /"zh-TW"/);
  changed.viewer.props.onLoadEnd();
  assert.match(scripts.at(-1), /"zh-TW"/);
  changed.header.props.right.props.onPress();
  const retried = render();
  assert.notEqual(retried.viewer.key, first.viewer.key);
  assert.notEqual(retried.viewer.props.source, first.viewer.props.source);
  assert.equal(new URL(retried.viewer.props.source.uri).searchParams.get('next'), '/native/computer?locale=zh-TW');
});

test('native UI literals use the catalog except language autonyms, and permission/native locale resources cover all three languages', () => {
  const allowed = new Set(['简体中文', '繁體中文']);
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      if (!/\.tsx?$/.test(file) || file.endsWith('/messages.ts')) continue;
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      function inspect(node) {
        if ((ts.isStringLiteralLike(node) || ts.isJsxText(node)) && /\p{Script=Han}/u.test(node.text)) assert.ok(allowed.has(node.text.trim()), `${file}: untranslated ${node.text}`);
        ts.forEachChild(node, inspect);
      }
      inspect(source);
    }
  }
  visit(path.join(root, 'src'));
  for (const locale of ['en', 'zh-Hans', 'zh-Hant']) {
    const permission = JSON.parse(fs.readFileSync(path.join(root, `locales/${locale}.json`), 'utf8')).ios;
    for (const key of ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription', 'NSLocalNetworkUsageDescription', 'NSFaceIDUsageDescription']) assert.ok(permission[key]);
    assert.ok(fs.existsSync(path.join(root, `ios/Ochi/Supporting/${locale}.lproj/InfoPlist.strings`)));
  }
  const manifest = fs.readFileSync(path.join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  assert.match(manifest, /android:localeConfig="@xml\/locales_config"/);
  assert.match(manifest, /configChanges="[^"]*\|locale\|layoutDirection"/);
  assert.match(fs.readFileSync(path.join(root, 'src/components/ScheduleTimePicker.ios.tsx'), 'utf8'), /environment\("locale", getLocale\(\)\)/);
});
