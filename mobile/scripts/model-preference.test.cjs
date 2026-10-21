const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let index = 0; index < 24; index++) await Promise.resolve(); };
const catalog = [{ id: 'first', is_default: false }, { id: 'initial', is_default: true }, { id: 'chosen', is_default: false }];
const initialPreferences = (id = '') => ({ memory_enabled: true, computer_default: false, preferred_model_id: id });

// Execute the actual provider state/actions; native rendering is verified separately.
function harness() {
  const slots = [], effects = [], contexts = [], writes = [], reads = [];
  let cursor = 0, dirty = true, tree, origin = 'https://one.example', actor = '', delayRead = false;
  const saved = new Map();
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    createContext() { const context = { Provider: `Provider${contexts.length}` }; contexts.push(context); return context; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (next) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; dirty = true; }];
    },
    useMemo(factory, deps) { const index = cursor++; if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { deps, value: factory() }; return slots[index].value; },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(callback, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || !same(previous.deps, deps)) effects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; });
    },
  };
  const api = {
    async login(username) { actor = username; return { id: username, username }; },
    async logout() { actor = ''; },
    async models() { return catalog; },
    preferences() {
      const key = `${origin}:${actor}`;
      if (!delayRead) return Promise.resolve(saved.get(key) ?? initialPreferences());
      const request = deferred(); reads.push({ ...request, key }); return request.promise;
    },
    updatePreferences(patch) { const request = deferred(); writes.push({ ...request, patch, key: `${origin}:${actor}` }); return request.promise; },
  };
  function load(file, imports = {}) {
    const output = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const moduleValue = { exports: {} };
    vm.runInNewContext(output, { module: moduleValue, exports: moduleValue.exports, setInterval: () => 1, clearInterval() {},
      require(name) { if (name in imports) return imports[name]; throw new Error(`Unexpected import ${name}`); },
    });
    return moduleValue.exports;
  }
  const selection = load('web/src/lib/modelSelection.ts');
  const { AppProvider } = load('mobile/src/providers/AppProvider.tsx', {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) },
    'react-native': { Appearance: { setColorScheme() {} }, useColorScheme: () => 'light', AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } },
    'expo-secure-store': { getItemAsync: async () => null, setItemAsync: async () => {} },
    'expo-system-ui': { setBackgroundColorAsync: async () => {} },
    '../lib/api': { api, getAPIBaseURL: () => origin, setAPIBaseURL: async (next) => { origin = next; }, clearCredentials: async () => {}, restoreCredentials: async () => false, setUnauthorizedHandler() {} },
    '../lib/sessionList': { createSessionListCache: () => ({ refresh: async () => {}, cancel() {} }) },
    '../lib/theme': { fonts: {}, themeColors: () => ({ canvas: '#fff' }) },
    '../../../web/src/lib/modelSelection': selection,
  });
  function render() {
    for (let count = 0; dirty || !tree; count++) {
      assert.ok(count < 30, 'provider render loop'); dirty = false; cursor = 0; tree = AppProvider({ children: null });
      for (const effect of effects.splice(0)) effect();
    }
    return tree.props.value;
  }
  return { render, writes, reads, saved, setDelayRead(value) { delayRead = value; } };
}

test('native new-session model waits for persisted preferences and resolves after restart/account login', async () => {
  const h = harness(); h.render(); await flush(); h.render();
  h.saved.set('https://one.example:alice', initialPreferences('chosen'));
  h.setDelayRead(true);
  const signIn = h.render().signIn('alice', 'not-a-credential'); await flush();
  assert.equal(h.render().preferredModel, undefined, 'do not prematurely initialize a draft with provider order/default');
  h.reads[0].resolve(initialPreferences('chosen')); await signIn;
  assert.equal(h.render().preferredModel.id, 'chosen');
  await h.render().signOut(); h.setDelayRead(false);
  await h.render().signIn('alice', 'not-a-credential');
  assert.equal(h.render().preferredModel.id, 'chosen');
  await h.render().signOut(); await h.render().signIn('bob', 'not-a-credential');
  assert.equal(h.render().preferredModel.id, 'initial');
  await h.render().signOut(); await h.render().signIn('alice', 'not-a-credential', 'https://two.example');
  assert.equal(h.render().preferredModel.id, 'initial', 'same username on a different origin must not reuse selection');
});

test('native rapid model selections are optimistic and serialized; a failed latest save restores last confirmed preference', async () => {
  const h = harness(); h.render(); await flush(); await h.render().signIn('alice', 'not-a-credential');
  const first = h.render().selectPreferredModel('chosen');
  const second = h.render().selectPreferredModel('first');
  assert.equal(h.render().preferredModel.id, 'first'); await flush();
  assert.equal(h.writes.length, 1, 'second selection cannot race the first server write');
  h.writes[0].resolve(initialPreferences('chosen')); await first; await flush();
  assert.equal(h.render().preferredModel.id, 'first', 'older success must not reset the current selection');
  assert.equal(h.writes.length, 2);
  const rejected = assert.rejects(second, /offline/);
  h.writes[1].reject(new Error('offline')); await rejected;
  assert.equal(h.render().preferredModel.id, 'chosen');
});

test('native stale preference reads and old-account write completions cannot erase the current choice', async () => {
  const h = harness(); h.render(); await flush(); await h.render().signIn('alice', 'not-a-credential');
  h.setDelayRead(true);
  const read = h.render().refreshPreferences(); await flush();
  const chosen = h.render().selectPreferredModel('chosen'); await flush();
  h.reads[0].resolve(initialPreferences('first')); await read;
  assert.equal(h.render().preferredModel.id, 'chosen');
  await h.render().signOut(); h.setDelayRead(false);
  await h.render().signIn('bob', 'not-a-credential');
  h.writes[0].resolve(initialPreferences('chosen')); await chosen;
  assert.equal(h.render().preferredModel.id, 'initial');
});
