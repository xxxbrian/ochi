const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const walk = (node) => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object' && 'type' in node ? [node, ...walk(node.props.children)] : [];
const find = (tree, type, predicate = () => true) => walk(tree).find((node) => node.type === type && predicate(node.props));
const style = (value) => typeof value === 'function' ? value() : Array.isArray(value) ? Object.assign({}, ...value.map(style)) : value ?? {};
const fixture = (id) => ({ id, title: id, updated_at: '2026-10-12T00:00:00Z' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function harness(platform = 'ios', drawer = false) {
  const scopes = new Map(), effects = [], timers = new Map(), frames = new Map(), listeners = new Map();
  let current, cursor, dirty = false, timerId = 0, frameId = 0, focused = true, searchTree, drawerTree, nav;
  const calls = [], requests = [], keyboard = { handler: null, dismissals: 0 };
  const dimensions = { width: 393, height: 852, fontScale: 1 };
  const insets = { top: 59, bottom: 34, left: 0, right: 0 };
  const props = { visible: true, onClose() { props.visible = false; dirty = true; }, onSelect(item) { calls.push({ name: 'selected', id: item.id }); } };
  const drawerProps = { open: true, sessionId: 'A' };
  const snapshot = { page: { items: [fixture('A'), fixture('B')] }, refreshing: false, error: '' };
  const cache = { refresh: async () => snapshot.page };
  const equal = (a, b) => a && b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
  const hooks = {
    useRef(initial) { const index = cursor++; current[index] ??= { current: initial }; return current[index]; },
    useState(initial) {
      const index = cursor++, slots = current;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial, set(next) { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; dirty = true; } };
      return [slots[index].value, slots[index].set];
    },
    useCallback(callback, dependencies) {
      const index = cursor++;
      if (!current[index] || !equal(current[index].dependencies, dependencies)) current[index] = { callback, dependencies };
      return current[index].callback;
    },
    useEffect(callback, dependencies) {
      const index = cursor++, slots = current, previous = slots[index];
      if (!previous || !equal(previous.dependencies, dependencies)) effects.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: callback() }; });
    },
  };
  hooks.useLayoutEffect = hooks.useEffect;
  const navigation = {
    isFocused: () => focused,
    addListener(name, callback) { listeners.set(name, callback); return () => listeners.delete(name); },
    setParams(params) { calls.push({ name: 'setParams', id: params.sessionId }); drawerProps.sessionId = params.sessionId; dirty = true; },
  };
  const theme = { colors: { muted: '#777', text: '#111', subtle: '#999', hover: '#eee' }, fonts: { regular: 'regular' }, dark: false };
  const modules = {};
  function load(file) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(output, {
      module, exports: module.exports, AbortController, Date, Intl, Error, Promise, Math, Map, Set,
      setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: (id) => timers.delete(id),
      requestAnimationFrame: (fn) => { const id = ++frameId; frames.set(id, fn); return id; }, cancelAnimationFrame: (id) => frames.delete(id),
      require(name) {
        if (name === 'react') return hooks;
        if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
        if (name === 'react-native') return {
          ...Object.fromEntries(['ActivityIndicator', 'FlatList', 'Modal', 'Pressable', 'TextInput', 'View'].map((name) => [name, name])),
          Alert: { alert() {} }, Platform: { OS: platform }, Keyboard: { dismiss() { keyboard.dismissals += 1; } }, StyleSheet: { create: (styles) => styles },
          useWindowDimensions: () => dimensions,
        };
        if (name === 'expo-router') return { useNavigation: () => navigation, useIsFocused: () => focused, router: { push: (path) => calls.push({ name: 'push', path }) } };
        if (name === 'react-native-reanimated') return { __esModule: true, default: { View: 'Animated.View' }, useReducedMotion: () => false, useSharedValue: (value) => hooks.useRef({ value }).current, useAnimatedStyle: (factory) => factory };
        if (name === 'react-native-keyboard-controller') return { useKeyboardContext: () => ({ reanimated: { height: { value: 0 }, progress: { value: 0 } } }), useGenericKeyboardHandler(handler) { keyboard.handler = handler; } };
        if (name === 'react-native-safe-area-context') return { useSafeAreaInsets: () => insets };
        if (name === 'lucide-react-native') return new Proxy({}, { get: (_target, key) => key });
        if (name === '../lib/api') return { api: { sessionsPage(options, signal) { const request = { options, signal, ...deferred() }; requests.push(request); return request.promise; } } };
        if (name === '../lib/sessionList') return modules.list;
        if (name === '../providers/AppProvider') return { useTheme: () => theme, useApp: () => ({ ...theme, user: {}, signOut: async () => {}, invalidateLists() {} }), useSessionList: () => ({ ...snapshot, cache }) };
        if (name === '../../brand.config') return { brand: { displayName: 'Ochi' } };
        if (name === './SessionSearch') return { SessionSearch: 'SessionSearch', sessionDate: (value) => value };
        if (name.startsWith('../ui/') || name === './ScreenChrome') return new Proxy({}, { get: (_target, key) => key });
        throw new Error(`Unexpected import ${name}`);
      },
    }, { filename: file });
    return module.exports;
  }
  modules.list = load('src/lib/sessionList.ts');
  const Search = load('src/components/SessionSearch.tsx').SessionSearch;
  const Drawer = load('src/components/SessionDrawer.tsx').SessionDrawer;
  const useNavigation = load('src/hooks/useDrawerNavigation.ts').useDrawerNavigation;
  function inScope(name, render) { if (!scopes.has(name)) scopes.set(name, []); current = scopes.get(name); cursor = 0; return render(); }
  function render(changes) {
    Object.assign(props, changes); dirty = false;
    let searchProps = props;
    if (drawer) {
      nav = inScope('navigation', () => useNavigation(drawerProps.open, drawerProps.sessionId));
      const current = nav;
      drawerTree = inScope('drawer', () => Drawer({
        open: drawerProps.open, activeId: drawerProps.sessionId, canAct: current.canAct, onNavigate: current.pushDestination,
        onSelectSession(id) { if (current.selectSession(id)) { drawerProps.open = false; dirty = true; } }, onNewChat() {}, onDeletedSession() {},
      }));
      searchProps = find(drawerTree, 'SessionSearch').props;
    }
    searchTree = inScope('search', () => Search(searchProps));
  }
  function commit() { effects.splice(0).forEach((effect) => effect()); }
  async function settle() { for (let index = 0; index < 16; index++) { await Promise.resolve(); if (dirty) render(); if (effects.length) commit(); } }
  function emit(name, data, nextFocus) { if (nextFocus !== undefined) focused = nextFocus; listeners.get(name)?.({ data }); }
  render(); commit();
  return {
    props, calls, requests, keyboard, drawerProps,
    get tree() { return searchTree; }, get modal() { return find(searchTree, 'Modal'); }, get nav() { return nav; },
    render, commit, settle, emit,
    resize(nextDimensions, nextInsets) { Object.assign(dimensions, nextDimensions); Object.assign(insets, nextInsets); render(); commit(); },
    open() { if (drawer) find(drawerTree, 'Pressable', (props) => props.accessibilityLabel === '搜索对话').props.onPress(); else { props.visible = true; dirty = true; } },
    row(id) { return find(searchTree, 'FlatList').props.renderItem({ item: fixture(id) }); },
    poll() { snapshot.page = { items: [fixture('updated'), ...snapshot.page.items] }; dirty = true; },
    // Model installed native-stack onWillDisappear/onDisappear for a UIKit fullScreen presentation.
    present() { if (drawer && platform === 'ios' && find(searchTree, 'Modal').props.presentationStyle === 'fullScreen') { emit('transitionStart', { closing: true }); emit('transitionEnd', { closing: true }); } find(searchTree, 'Modal').props.onShow(); },
    tick(ms) { for (const [id, timer] of [...timers]) if (ms === undefined || timer.ms === ms) { timers.delete(id); timer.fn(); } },
    frame() { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } },
    unmount() { for (const slots of scopes.values()) slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

test('opaque overFullScreen keeps the iOS drawer owner through three searches, polling and result selection', async () => {
  const h = harness('ios', true); await h.settle();
  const keys = [];
  for (let iteration = 0; iteration < 3; iteration++) {
    h.open(); await h.settle(); const modal = h.modal; keys.push(modal.key);
    assert.equal(modal.props.presentationStyle, 'overFullScreen'); assert.notEqual(modal.props.transparent, true);
    assert.equal(modal.props.backdropColor, '#fafafa'); assert.equal(style(find(h.tree, 'View').props.style).flex, 1);
    h.present(); await h.settle(); h.poll(); await h.settle();
    assert.equal(h.modal.props.visible, true); assert.equal(h.nav.canAct(), true);
    if (iteration < 2) {
      find(h.tree, 'IconButton').props.onPress(); await h.settle(); assert.equal(h.modal.props.visible, false);
      h.modal.props.onDismiss(); await h.settle(); assert.equal(h.drawerProps.open, true);
    } else {
      h.row('B').props.onPress(); await h.settle(); assert.equal(h.modal.props.visible, false);
      assert.deepEqual(h.calls, []); h.modal.props.onDismiss(); await h.settle();
      assert.deepEqual(h.calls, [{ name: 'setParams', id: 'B' }]); assert.equal(h.drawerProps.open, false);
    }
  }
  assert.equal(new Set(keys).size, 3); h.unmount();
});

test('real route departure and closing the drawer still clear the search instead of loosening admission', async () => {
  for (const reason of ['route', 'drawer']) {
    const h = harness('ios', true); await h.settle(); h.open(); await h.settle();
    if (reason === 'route') { h.emit('transitionStart', { closing: true }); h.emit('blur', undefined, false); }
    else { h.drawerProps.open = false; h.render(); h.commit(); }
    await h.settle(); assert.equal(h.modal.props.visible, false); assert.equal(h.nav.canAct(), false);
    h.modal.props.onDismiss(); assert.deepEqual(h.calls, []); h.unmount();
  }
});

test('old native show/dismiss/row callbacks cannot focus, cancel or select a later presentation', async () => {
  const h = harness(); await h.settle();
  const old = h.modal, oldRow = h.row('old');
  find(h.tree, 'IconButton').props.onPress(); await h.settle(); h.open(); await h.settle();
  const current = h.modal; let focused = 0;
  find(h.tree, 'TextInput').props.ref.current = { focus() { focused += 1; } };
  old.props.onShow(); old.props.onRequestClose(); oldRow.props.onPress(); await h.settle();
  assert.equal(focused, 0); assert.equal(h.modal.props.visible, true); assert.notEqual(old.key, current.key);
  current.props.onShow(); assert.equal(focused, 1);
  h.row('new').props.onPress(); h.row('new').props.onPress(); await h.settle();
  old.props.onDismiss(); assert.deepEqual(h.calls, []);
  h.modal.props.onDismiss(); h.modal.props.onDismiss(); assert.deepEqual(h.calls, [{ name: 'selected', id: 'new' }]);
  h.unmount(); current.props.onShow(); assert.equal(focused, 1);
});

test('Android delayed focus remains owned by the new presentation; selection waits for the hidden commit', async () => {
  const h = harness('android'); await h.settle(); const old = h.modal;
  find(h.tree, 'IconButton').props.onPress(); await h.settle(); h.open(); await h.settle();
  let focused = 0; find(h.tree, 'TextInput').props.ref.current = { focus() { focused += 1; } };
  h.modal.props.onShow(); old.props.onShow(); h.tick(150); assert.equal(focused, 1);
  h.row('B').props.onPress(); assert.deepEqual(h.calls, []); await h.settle(); h.frame();
  assert.deepEqual(h.calls, [{ name: 'selected', id: 'B' }]); h.unmount();
});

test('keyboard dismissal changes only input/results geometry and stale requests cannot close or replace reopened search', async () => {
  const h = harness(); await h.settle(); h.tick(); const first = h.requests[0];
  const body = find(h.tree, 'Animated.View');
  h.keyboard.handler.onMove({ height: 150, progress: 0.5 }); assert.equal(style(body.props.style).paddingBottom, 167);
  find(h.tree, 'TextInput').props.onSubmitEditing(); await h.settle(); assert.equal(h.modal.props.visible, true);
  find(h.tree, 'IconButton').props.onPress(); await h.settle(); assert.equal(first.signal.aborted, true);
  h.open(); await h.settle(); h.tick(); const next = h.requests[1];
  first.reject(new Error('late previous request')); next.resolve({ items: [fixture('new')] }); await h.settle();
  assert.equal(h.modal.props.visible, true); assert.deepEqual(Array.from(find(h.tree, 'FlatList').props.data, (item) => item.id), ['new']);
  h.unmount();
});

test('rotating a visible search preserves its presentation, query and native input while only safe chrome and keyboard geometry change', async () => {
  for (const platform of ['ios', 'android']) {
    const h = harness(platform); await h.settle(); h.tick(0);
    h.requests[0].resolve({ items: [fixture('initial')] }); await h.settle();
    const modalKey = h.modal.key;
    const inputRef = find(h.tree, 'TextInput').props.ref;
    let focuses = 0;
    const nativeInput = { focus() { focuses += 1; } };
    inputRef.current = nativeInput;
    h.present(); if (platform === 'android') h.tick(150);
    assert.equal(focuses, 1);
    const query = '  横屏 search  ';
    find(h.tree, 'TextInput').props.onChangeText(query); await h.settle(); h.tick(230);
    const request = h.requests[1];
    assert.equal(request.options.q, query.trim());
    h.keyboard.handler.onMove({ height: 216, progress: 1 });
    const landscapeInsets = platform === 'ios'
      ? { top: 0, left: 59, right: 59, bottom: 21 }
      : { top: 0, left: 44, right: 0, bottom: 24 };
    h.resize({ width: 852, height: 393 }, landscapeInsets); await h.settle();
    assert.ok(Array.from(h.modal.props.supportedOrientations).includes('landscape-left'));
    assert.ok(Array.from(h.modal.props.supportedOrientations).includes('landscape-right'));
    const canvas = find(h.tree, 'View');
    const header = find(canvas.props.children, 'View');
    assert.equal(style(canvas.props.style).flex, 1);
    assert.equal(style(canvas.props.style).paddingBottom, undefined);
    assert.equal(style(header.props.style).paddingTop, 3);
    assert.equal(style(header.props.style).paddingBottom, 4);
    assert.equal(style(header.props.style).paddingLeft, landscapeInsets.left + 16);
    assert.equal(style(header.props.style).paddingRight, landscapeInsets.right + 16);
    let body = find(h.tree, 'Animated.View');
    assert.equal(style(body.props.style).paddingLeft, landscapeInsets.left);
    assert.equal(style(body.props.style).paddingRight, landscapeInsets.right);
    assert.equal(style(body.props.style).paddingBottom, 216);
    assert.equal(style(find(h.tree, 'FlatList').props.style).maxWidth, 780);
    assert.equal(find(h.tree, 'TextInput').props.disableFullscreenUI, true);
    assert.equal(request.signal.aborted, false);
    find(h.tree, 'TextInput').props.onSubmitEditing();
    h.keyboard.handler.onEnd({ height: 0, progress: 0 }); await h.settle();
    body = find(h.tree, 'Animated.View');
    assert.equal(style(body.props.style).paddingBottom, landscapeInsets.bottom);
    h.resize({ width: 852, height: 393 }, { ...landscapeInsets, left: landscapeInsets.right, right: landscapeInsets.left }); await h.settle();
    body = find(h.tree, 'Animated.View');
    assert.equal(style(body.props.style).paddingLeft, landscapeInsets.right);
    assert.equal(style(body.props.style).paddingRight, landscapeInsets.left);
    h.resize({ width: 393, height: 852 }, { top: 59, left: 0, right: 0, bottom: 34 }); await h.settle(); h.tick(150);
    assert.equal(h.modal.key, modalKey);
    assert.equal(h.modal.props.visible, true);
    assert.equal(find(h.tree, 'TextInput').props.value, query);
    assert.equal(find(h.tree, 'TextInput').props.ref, inputRef);
    assert.equal(inputRef.current, nativeInput);
    assert.equal(focuses, 1);
    assert.equal(h.keyboard.dismissals, 1);
    assert.equal(h.requests.length, 2);
    assert.equal(request.signal.aborted, false);
    assert.deepEqual(h.calls, []);
    request.resolve({ items: [fixture('query-result')] }); await h.settle();
    assert.deepEqual(Array.from(find(h.tree, 'FlatList').props.data, (item) => item.id), ['query-result']);
    assert.equal(find(h.tree, 'TextInput').props.value, query);
    assert.equal(h.modal.key, modalKey);
    assert.equal(h.modal.props.visible, true);
    h.unmount();
  }
});
