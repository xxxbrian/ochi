const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, imports, globals = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module, exports: module.exports, URL, URLSearchParams, Intl, FormData, TextEncoder, Uint8Array,
    ...globals,
    require(name) {
      if (name in imports) return imports[name];
      throw new Error(`Unexpected import ${name}`);
    },
  }, { filename: file });
  return module.exports;
}

function apiHarness({ saved = {}, override, dev = false } = {}) {
  const storage = new Map(Object.entries(saved));
  const requests = [];
  const api = load('src/lib/api.ts', {
    'expo/fetch': { async fetch(url, init) {
      requests.push({ url, ...init });
      return { ok: true, status: 200, json: async () => url.endsWith('/login') ? { id: 'user', access_token: 'test-token', expires_at: 'future' } : { id: 'user' } };
    } },
    'expo-file-system': { File: class {} },
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
      getItemAsync: async (key) => storage.get(key) ?? null,
      setItemAsync: async (key, value) => { storage.set(key, value); },
      deleteItemAsync: async (key) => { storage.delete(key); },
    },
  }, { process: { env: { EXPO_PUBLIC_API_URL: override } }, __DEV__: dev });
  return { ...api, storage, requests };
}

test('fresh release and development clients use Ochi without setup; explicit build overrides still work', async () => {
  for (const dev of [false, true]) {
    const api = apiHarness({ dev });
    assert.equal(api.getAPIBaseURL(), 'https://ochi.bojin.co');
    assert.equal(api.isConfiguredAPIBaseURL(), true);
    assert.equal(await api.restoreCredentials(), false);
    await api.api.me();
    assert.equal(api.requests[0].url, 'https://ochi.bojin.co/api/auth/me');
  }
  assert.equal(apiHarness({ override: ' http://127.0.0.1:8090/api/ ' }).getAPIBaseURL(), 'http://127.0.0.1:8090');
  assert.equal(apiHarness({ override: 'not a URL' }).isConfiguredAPIBaseURL(), false);
});

test('self-hosted HTTP and HTTPS origins normalize on release builds and reject credential/path/query URLs', async () => {
  const api = apiHarness();
  for (const [input, origin] of [
    [' http://192.168.1.10:8090/api/ ', 'http://192.168.1.10:8090'],
    ['https://self.example/api', 'https://self.example'],
    ['http://[::1]:8090/', 'http://[::1]:8090'],
  ]) {
    await api.setAPIBaseURL(input);
    assert.equal(api.getAPIBaseURL(), origin);
    assert.equal(api.storage.get('ochi.server.v1'), origin);
  }
  for (const invalid of ['', 'ftp://self.example', 'ws://self.example', 'file:///tmp/test', 'https://user:pass@self.example', 'https://self.example/chat', 'https://self.example/?key=value', 'https://self.example/#fragment']) {
    assert.equal(api.isConfiguredAPIBaseURL(invalid), false, invalid);
    await assert.rejects(api.setAPIBaseURL(invalid), /请输入/);
    assert.equal(api.getAPIBaseURL(), 'http://[::1]:8090');
  }
});

test('saved self-hosted HTTP keeps its own token across builds; auth is never sent to another resource origin', async () => {
  const api = apiHarness({ override: 'https://different-build.example', saved: { 'ochi.server.v1': 'http://self.example:8090', 'ochi.auth.v1': 'saved-test-token' } });
  assert.equal(await api.restoreCredentials(), true);
  assert.equal(api.getAPIBaseURL(), 'http://self.example:8090');
  await api.api.me();
  assert.equal(api.requests[0].url, 'http://self.example:8090/api/auth/me');
  assert.equal(api.requests[0].headers.Authorization, 'Bearer saved-test-token');
  assert.equal(api.resourceHeaders('/api/files/test').Authorization, 'Bearer saved-test-token');
  assert.deepEqual({ ...api.resourceHeaders('https://self.example:8090/image') }, {});
  assert.deepEqual({ ...api.resourceHeaders('https://external.example/image') }, {});
  await api.setAPIBaseURL('http://self.example:8090/api/');
  assert.equal(api.authHeaders().Authorization, 'Bearer saved-test-token');
  await api.setAPIBaseURL(api.DEFAULT_API_BASE_URL);
  assert.deepEqual({ ...api.authHeaders() }, {});
  assert.equal(api.storage.has('ochi.auth.v1'), false);
  await api.api.me();
  assert.equal(api.requests[1].headers.Authorization, undefined);
});

test('an unpaired or invalid saved origin never inherits credentials onto the new default', async () => {
  const unpaired = apiHarness({ saved: { 'ochi.auth.v1': 'unpaired-test-token' } });
  assert.equal(await unpaired.restoreCredentials(), false);
  assert.equal(unpaired.getAPIBaseURL(), unpaired.DEFAULT_API_BASE_URL);
  assert.deepEqual({ ...unpaired.authHeaders() }, {});
  const invalid = apiHarness({ saved: { 'ochi.server.v1': 'https://self.example/private', 'ochi.auth.v1': 'invalid-origin-test-token' } });
  assert.equal(await invalid.restoreCredentials(), false);
  assert.deepEqual({ ...invalid.authHeaders() }, {});
  await assert.rejects(invalid.api.me(), /请先设置服务地址/);
  assert.equal(invalid.requests.length, 0);
});

const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const walk = (node) => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object' && 'type' in node ? [node, ...walk(node.props.children)] : [];
const find = (tree, type, predicate = () => true) => walk(tree).find((node) => node.type === type && predicate(node));
const text = (node) => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : node ? text(node.props?.children) : '';

function loginHarness(api, { loading = false } = {}) {
  const slots = [], calls = [], routes = [];
  let cursor = 0, tree;
  const { LoginScreen } = load('src/screens/LoginScreen.tsx', {
    react: { useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    } },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Pressable: 'Pressable', View: 'View', StyleSheet: { create: (value) => value }, useWindowDimensions: () => ({ width: 393, height: 852 }) },
    'lucide-react-native': { ChevronDown: 'ChevronDown', ChevronUp: 'ChevronUp' },
    'expo-router': { router: { replace: (route) => routes.push(route) } },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }) },
    'react-native-keyboard-controller': { KeyboardAwareScrollView: 'KeyboardAwareScrollView' },
    '../lib/api': api,
    '../providers/AppProvider': { useApp: () => ({ colors: { canvas: '#fff', muted: '#666' }, loading, authError: '', async signIn(username, password, server) {
      calls.push({ username, password, server });
      await api.setAPIBaseURL(server);
      return api.api.login(username, password);
    } }) },
    '../../brand.config': { brand: { displayName: 'Ochi' } },
    '../components/ScreenChrome': { AppText: 'AppText', Button: 'Button', ErrorNotice: 'ErrorNotice', Field: 'Field' },
  });
  function render() { cursor = 0; tree = LoginScreen(); return tree; }
  render();
  return {
    calls, routes, render,
    field: (label) => find(tree, 'Field', (node) => node.props.label === label)?.props,
    pressable: (label) => find(tree, 'Pressable', (node) => text(node) === label)?.props,
    button: () => find(tree, 'Button').props,
    text: () => text(tree),
  };
}

test('login starts ready for Ochi; the self-hosted editor is optional and does not apply drafts before login', async () => {
  const api = apiHarness(), screen = loginHarness(api);
  assert.equal(screen.field('服务地址'), undefined);
  assert.ok(screen.pressable('使用自部署后端'));
  screen.pressable('使用自部署后端').onPress(); screen.render();
  assert.equal(screen.field('服务地址').value, api.DEFAULT_API_BASE_URL);
  screen.field('服务地址').onChangeText('http://192.168.1.10:8090'); screen.render();
  assert.equal(api.getAPIBaseURL(), api.DEFAULT_API_BASE_URL);
  assert.equal(api.storage.size, 0);
  assert.match(screen.text(), /HTTP 不加密/);
  screen.field('账号').onChangeText(' admin '); screen.field('密码').onChangeText('test-password'); screen.render();
  assert.equal(screen.button().disabled, false);
  screen.button().onPress();
  // The UI handler returns void; drain the login promise chain before asserting navigation.
  await new Promise(setImmediate);
  assert.equal(screen.calls[0].username, 'admin');
  assert.equal(api.getAPIBaseURL(), 'http://192.168.1.10:8090');
  assert.equal(api.storage.get('ochi.server.v1'), 'http://192.168.1.10:8090');
  assert.equal(api.requests[0].url, 'http://192.168.1.10:8090/api/auth/login');
  assert.equal(screen.routes[0], '/');
});

test('saved self-hosted login opens its editor; restoring the Ochi draft only applies on submission', async () => {
  const api = apiHarness({ saved: { 'ochi.server.v1': 'https://self.example' } });
  await api.restoreCredentials();
  const screen = loginHarness(api);
  assert.equal(screen.field('服务地址').value, 'https://self.example');
  screen.pressable('使用 Ochi 默认服务').onPress(); screen.render();
  assert.equal(screen.field('服务地址'), undefined);
  assert.equal(api.getAPIBaseURL(), 'https://self.example');
  screen.field('账号').onChangeText('admin'); screen.field('密码').onChangeText('test-password'); screen.render();
  screen.button().onPress();
  await new Promise(setImmediate);
  assert.equal(api.getAPIBaseURL(), api.DEFAULT_API_BASE_URL);
  assert.equal(api.requests[0].url, 'https://ochi.bojin.co/api/auth/login');
});

test('invalid self-hosted drafts cannot submit and backend editing is disabled while signing in', () => {
  const api = apiHarness(), screen = loginHarness(api);
  screen.pressable('使用自部署后端').onPress(); screen.render();
  screen.field('账号').onChangeText('admin'); screen.field('密码').onChangeText('test-password');
  screen.field('服务地址').onChangeText('ftp://self.example'); screen.render();
  assert.equal(screen.button().disabled, true);
  screen.button().onPress();
  assert.equal(screen.calls.length, 0);
  const busy = loginHarness(api, { loading: true });
  assert.equal(busy.pressable('使用自部署后端').disabled, true);
});
