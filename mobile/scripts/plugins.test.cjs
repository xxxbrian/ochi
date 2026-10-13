const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const walk = (node) => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object' && 'type' in node ? [node, ...walk(node.props.children)] : [];
const find = (tree, type) => walk(tree).find((node) => node.type === type);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const plugin = (id, patch = {}) => ({ id, name: id, description: 'Plugin description', enabled: true, default_enabled: false, effective_enabled: false, locked: false, skill_ids: [], mcp_ids: [], ...patch });

function harness(platform = 'ios') {
  const slots = [], effects = [], listeners = new Set();
  let cursor = 0, dirty = false, tree, focused = true, user = { id: 'A' }, server = 'https://ochi.example';
  const requests = [], mutations = [];
  const equal = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const hooks = {
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial, set(next) { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; dirty = true; } };
      return [slots[index].value, slots[index].set];
    },
    useCallback(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || !equal(slots[index].dependencies, dependencies)) slots[index] = { callback, dependencies };
      return slots[index].callback;
    },
    useEffect(callback, dependencies) {
      const index = cursor++, previous = slots[index];
      if (!previous || !equal(previous.dependencies, dependencies)) effects.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: callback() }; });
    },
  };
  const output = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/screens/PluginsScreen.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module, exports: module.exports, AbortController, Map, Error,
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'react-native') return {
        ...Object.fromEntries(['ActivityIndicator', 'FlatList', 'Switch', 'View'].map((name) => [name, name])),
        Platform: { OS: platform }, StyleSheet: { create: (value) => value, hairlineWidth: 0.5 },
        AppState: { addEventListener(_event, listener) { listeners.add(listener); return { remove() { listeners.delete(listener); } }; } },
      };
      if (name === 'expo-router') return { useFocusEffect(callback) { hooks.useEffect(() => focused ? callback() : undefined, [callback, focused]); } };
      if (name === 'react-native-safe-area-context') return { useSafeAreaInsets: () => ({ bottom: 34 }) };
      if (name === 'lucide-react-native') return { LockKeyhole: 'LockKeyhole', Puzzle: 'Puzzle' };
      if (name === '../providers/AppProvider') return { useApp: () => ({ user, colors: { text: '#fff', raised: '#222', muted: '#aaa', border: '#444' }, dark: true }) };
      if (name === '../lib/api') return {
        getAPIBaseURL: () => server,
        api: {
          plugins(signal) { const request = { owner: user?.id, server, signal, ...deferred() }; requests.push(request); return request.promise; },
          updatePlugin(id, enabled, signal) { const request = { id, enabled, owner: user?.id, server, signal, ...deferred() }; mutations.push(request); return request.promise; },
        },
      };
      if (name === '../components/ScreenChrome' || name === '../components/SettingsChrome') return new Proxy({ settingsStyles: { content: {} } }, { get: (target, key) => target[key] ?? key });
      throw new Error(`Unexpected import ${name}`);
    },
  }, { filename: 'PluginsScreen.tsx' });
  function render() { cursor = 0; dirty = false; tree = module.exports.PluginsScreen(); }
  function commit() { effects.splice(0).forEach((effect) => effect()); }
  async function settle() { for (let index = 0; index < 12; index++) { await Promise.resolve(); if (dirty) render(); if (effects.length) commit(); } }
  render(); commit();
  return {
    requests, mutations, settle,
    get list() { return find(tree, 'FlatList').props; },
    get error() { return this.list.ListHeaderComponent.props.error; },
    row(id) { const list = this.list, index = list.data.findIndex((item) => item.id === id); return list.renderItem({ item: list.data[index], index }); },
    switch(id) { return find(this.row(id), 'Switch').props; },
    foreground() { listeners.forEach((listener) => listener('active')); },
    async focus(next) { focused = next; render(); commit(); await settle(); },
    async account(id, url = server) { user = id ? { id } : null; server = url; render(); commit(); await settle(); },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

test('mandatory plugins cannot be toggled; optional switches save optimistically and prevent repeated taps', async () => {
  const h = harness();
  h.requests[0].resolve([plugin('mandatory', { default_enabled: true }), plugin('optional')]);
  await h.settle();
  const mandatory = h.switch('mandatory');
  assert.equal(mandatory.value, true);
  assert.equal(mandatory.disabled, true);
  assert.equal(mandatory.thumbColor, undefined);
  mandatory.onValueChange(false);
  assert.equal(h.mutations.length, 0);
  const optional = h.switch('optional');
  optional.onValueChange(true); optional.onValueChange(true);
  await h.settle();
  assert.equal(h.mutations.length, 1);
  assert.equal(h.mutations[0].enabled, true);
  assert.equal(h.switch('optional').value, true);
  assert.equal(h.switch('optional').disabled, true);
  h.mutations[0].resolve(plugin('optional', { effective_enabled: true }));
  await h.settle();
  assert.equal(h.switch('optional').value, true);
  assert.equal(h.switch('optional').disabled, false);
  h.unmount();
});

test('failed mutations roll back and retry refreshes authoritative admin policy without hiding visible rows', async () => {
  const h = harness('android');
  h.requests[0].resolve([plugin('optional')]); await h.settle();
  h.switch('optional').onValueChange(true); await h.settle();
  assert.equal(h.switch('optional').thumbColor, '#ffffff');
  h.mutations[0].reject(new Error('保存失败')); await h.settle();
  assert.equal(h.switch('optional').value, false);
  assert.equal(h.switch('optional').disabled, false);
  assert.equal(h.error, '保存失败');
  h.list.ListHeaderComponent.props.retry(); await h.settle();
  assert.equal(h.list.data.length, 1);
  assert.equal(h.list.refreshing, true);
  h.requests[1].resolve([plugin('optional', { default_enabled: true }), plugin('unavailable', { enabled: false })]); await h.settle();
  assert.equal(h.list.data.length, 1);
  assert.equal(h.switch('optional').value, true);
  assert.equal(h.switch('optional').disabled, true);
  assert.equal(h.error, '');
  h.unmount();
});

test('account/server switches abort old reads and writes, reject stale UI callbacks and never show prior account data', async () => {
  const h = harness();
  const first = h.requests[0];
  await h.account('B');
  assert.equal(first.signal.aborted, true);
  first.reject(new Error('A request failed'));
  h.requests[1].resolve([plugin('same')]); await h.settle();
  assert.equal(h.error, '');
  const oldSwitch = h.switch('same');
  oldSwitch.onValueChange(true); await h.settle();
  const oldWrite = h.mutations[0];
  await h.account('B', 'https://other.example');
  assert.equal(oldWrite.signal.aborted, true);
  assert.equal(h.list.data.length, 0);
  h.requests[2].resolve([plugin('same')]); oldWrite.resolve(plugin('same', { effective_enabled: true })); await h.settle();
  oldSwitch.onValueChange(true); await h.settle();
  assert.equal(h.mutations.length, 1);
  assert.equal(h.switch('same').value, false);
  await h.account(null);
  assert.equal(h.list.data.length, 0);
  assert.equal(h.requests.length, 3);
  h.unmount();
});

test('stale refreshes cannot undo a switch and returning to the page or foreground refreshes persisted preferences', async () => {
  const h = harness();
  h.requests[0].resolve([plugin('optional')]); await h.settle();
  h.list.onRefresh(); await h.settle();
  const oldRead = h.requests[1];
  h.switch('optional').onValueChange(true); await h.settle();
  assert.equal(oldRead.signal.aborted, true);
  oldRead.resolve([plugin('optional')]);
  h.mutations[0].resolve(plugin('optional', { effective_enabled: true })); await h.settle();
  assert.equal(h.switch('optional').value, true);
  h.switch('optional').onValueChange(false); await h.settle();
  const oldWrite = h.mutations[1];
  await h.focus(false);
  assert.equal(oldWrite.signal.aborted, true);
  await h.focus(true);
  oldWrite.reject(new Error('Old write failed'));
  h.requests[2].resolve([plugin('optional', { effective_enabled: true })]); await h.settle();
  assert.equal(h.switch('optional').value, true);
  assert.equal(h.switch('optional').disabled, false);
  assert.equal(h.error, '');
  h.foreground(); await h.settle();
  h.requests[3].resolve([]); await h.settle();
  assert.equal(h.list.data.length, 0);
  assert.equal(h.list.ListEmptyComponent.props.text, '暂无可用插件');
  h.unmount();
});
