const { createI18n } = require('./helpers/i18n.cjs');
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
const initialPreferences = (id = '', language = 'system') => ({ memory_enabled: true, computer_default: false, preferred_model_id: id, language });

// Execute the actual provider state/actions; native rendering is verified separately.
function harness({ restoredUser = '', optionalReadFailure = false } = {}) {
  const slots = [], effects = [], contexts = [], writes = [], reads = [];
  let cursor = 0, dirty = true, tree, origin = 'https://one.example', actor = restoredUser, delayRead = false;
  const saved = new Map();
  const systemLocales = [{ languageTag: 'en-US' }];
  let localization;
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
    useSyncExternalStore(subscribe, getSnapshot) {
      const subscription = react.useRef(null);
      subscription.current ??= subscribe(() => { dirty = true; });
      return getSnapshot();
    },
    useEffect(callback, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || !same(previous.deps, deps)) effects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; });
    },
  };
  const optionalStore = { getItemAsync: async () => { if (optionalReadFailure) throw new Error('optional preference unavailable'); return null; }, setItemAsync: async () => {} };
  localization = createI18n({ locale: 'system', react, ...(optionalReadFailure ? { secureStore: optionalStore } : {}) });
  const api = {
    async me() { return { id: actor, username: actor }; },
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
      require(name) {
        const translated = localization.importFor(name); if (translated) return translated;
 if (name in imports) return imports[name]; throw new Error(`Unexpected import ${name}`); },
    });
    return moduleValue.exports;
  }
  const selection = load('web/src/lib/modelSelection.ts');
  const { AppProvider } = load('mobile/src/providers/AppProvider.tsx', {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) },
    'react-native': { Appearance: { setColorScheme() {} }, useColorScheme: () => 'light', AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } },
    'expo-secure-store': optionalStore,
    'expo-system-ui': { setBackgroundColorAsync: async () => {} },
    'expo-localization': { getLocales: () => systemLocales, useLocales: () => systemLocales },
    '../lib/api': { api, getAPIBaseURL: () => origin, setAPIBaseURL: async (next) => { origin = next; }, clearCredentials: async () => {}, restoreCredentials: async () => Boolean(restoredUser), setUnauthorizedHandler() {} },
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
  return { render, writes, reads, saved, localization, setDelayRead(value) { delayRead = value; } };
}

test('native authentication still restores when optional language and appearance storage reads fail', async () => {
  const h = harness({ restoredUser: 'alice', optionalReadFailure: true });
  h.saved.set('https://one.example:alice', initialPreferences('chosen', 'zh-TW'));
  h.render(); await flush();
  assert.equal(h.render().authReady, true);
  assert.equal(h.render().authError, '');
  assert.equal(h.render().user.id, 'alice');
  assert.equal(h.render().locale, 'zh-TW');
  assert.equal(h.render().preferredModel.id, 'chosen');
});

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

test('native language preference applies immediately before login, then follows each account and backend without changing model or memory choices', async () => {
  const h = harness(); h.render(); await flush(); h.render();
  assert.equal(h.render().locale, 'en');
  await h.render().selectLanguage('zh-TW');
  assert.equal(h.render().language, 'zh-TW');
  assert.equal(h.render().locale, 'zh-TW');
  assert.equal(h.localization.storage.get('ochi.language.v1'), 'zh-TW');
  assert.equal(h.writes.length, 0, 'signed-out choice is local only');
  h.saved.set('https://one.example:alice', { ...initialPreferences('chosen', 'zh-CN'), memory_enabled: false });
  await h.render().signIn('alice', 'not-a-credential');
  assert.equal(h.render().locale, 'zh-CN');
  assert.equal(h.render().preferredModel.id, 'chosen');
  assert.equal(h.render().preferences.memory_enabled, false);
  await h.render().signOut(); await h.render().signIn('bob', 'not-a-credential');
  assert.equal(h.render().language, 'system');
  assert.equal(h.render().locale, 'en');
  await h.render().signOut(); await h.render().signIn('alice', 'not-a-credential', 'https://two.example');
  assert.equal(h.render().language, 'system', 'an identically named account on another server does not inherit language');
});

test('native rapid language changes serialize writes and a failed latest choice rolls back to the last confirmed language', async () => {
  const h = harness(); h.render(); await flush(); await h.render().signIn('alice', 'not-a-credential');
  const first = h.render().selectLanguage('zh-TW');
  const second = h.render().selectLanguage('zh-CN');
  assert.equal(h.render().locale, 'zh-CN'); await flush();
  assert.equal(h.writes.length, 1);
  assert.deepEqual({ ...h.writes[0].patch }, { language: 'zh-TW' });
  h.writes[0].resolve(initialPreferences('', 'zh-TW')); await first; await flush();
  assert.equal(h.render().locale, 'zh-CN', 'older save cannot flash the previous language');
  assert.equal(h.writes.length, 2);
  const rejected = assert.rejects(second, /offline/);
  h.writes[1].reject(new Error('offline')); await rejected; await flush();
  assert.equal(h.render().locale, 'zh-TW');
  assert.equal(h.localization.storage.get('ochi.language.v1'), 'zh-TW');
  assert.equal(h.render().preferences.memory_enabled, true);
});

test('language rollback is independent of later model writes and old-account completions cannot switch the new account language', async () => {
  const h = harness(); h.render(); await flush(); await h.render().signIn('alice', 'not-a-credential');
  const language = h.render().selectLanguage('zh-TW');
  const model = h.render().selectPreferredModel('chosen'); await flush();
  const rejected = assert.rejects(language, /offline/);
  h.writes[0].reject(new Error('offline')); await rejected; await flush();
  assert.equal(h.render().language, 'system');
  assert.equal(h.render().preferredModel.id, 'chosen', 'rolling language back preserves an unrelated optimistic model choice');
  h.writes[1].resolve(initialPreferences('chosen')); await model;
  const late = h.render().selectLanguage('zh-CN'); await flush();
  await h.render().signOut();
  h.saved.set('https://one.example:bob', initialPreferences('', 'en'));
  await h.render().signIn('bob', 'not-a-credential');
  h.writes[2].resolve(initialPreferences('chosen', 'zh-CN')); await late;
  assert.equal(h.render().locale, 'en');
  assert.equal(h.render().preferences.language, 'en');
});
