const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const walk = (node) => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object' && 'type' in node ? [node, ...walk(node.props.children)] : [];
const find = (tree, type, predicate = () => true) => walk(tree).find((node) => node.type === type && predicate(node.props));
const isPressable = (node) => ['Pressable', 'GesturePressable'].includes(node.type);
const scrollView = (tree) => walk(tree).find((node) => ['ScrollView', 'GestureScrollView'].includes(node.type));
const flattenStyle = (value) => typeof value === 'function' ? flattenStyle(value({ pressed: false })) : Array.isArray(value) ? Object.assign({}, ...value.map(flattenStyle)) : value ?? {};
const models = (count = 3) => Array.from({ length: count }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}`, provider_name: 'Provider', reasoning_kind: 'effort', effort_parameter: 'reasoning_effort', efforts: ['low', 'high'] }));

// Execute the production hooks and action closures, controlling only native events
// and Reanimated completion delivery. This does not emulate native hit-testing.
function harness({ platform = 'android', composer = false, preserveKeyboard = true, keyboardHeight = 320, reducedMotion = false, modelCount = 3, width = 393, height = 852, insets = { top: 59, bottom: 34, left: 0, right: 0 } } = {}) {
  const scopes = new Map(), effects = [], frames = new Map(), timers = new Map(), listeners = new Map(), animations = [];
  const modules = new Map(), calls = [], keyboardCalls = [], measurements = [];
  let slots, cursor, dirty = false, frameId = 0, timerId = 0, live = true, lateWrites = 0, menuTree, composerTree, menuProps, closeCount = 0, deferMeasurements = false;
  const dimensions = { width, height, fontScale: 1 };
  const input = {
    focused: keyboardHeight > 0,
    isFocused() { return this.focused; },
    focus() { keyboardCalls.push('focus'); this.focused = true; },
    blur() { keyboardCalls.push('blur'); this.focused = false; },
    setNativeProps() {},
  };
  const props = composer ? {
    draftKey: 'session-A', models: models(modelCount), modelId: 'model-0', effort: '', initialDraft: 'Keep this draft', computerEnabled: false,
    onModel(id) { calls.push({ kind: 'model', value: id }); props.modelId = id; dirty = true; },
    onEffort(value) { calls.push({ kind: 'effort', value }); props.effort = value; dirty = true; },
    onComputer() {}, onStop() {}, onSubmit: async () => {},
  } : {
    visible: true, anchor: { x: 70, y: 450, width: 44, height: 40 }, preserveKeyboard,
    onClose() { closeCount += 1; props.visible = false; dirty = true; },
    items: [
      { key: 'first', title: 'First', onPress() { calls.push({ kind: 'action', value: 'first' }); } },
      { key: 'second', title: 'Second', onPress() { calls.push({ kind: 'action', value: 'second' }); } },
    ],
  };
  const same = (a, b) => a && b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
  const hooks = {
    memo: (component) => component,
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useState(initial) {
      const index = cursor++, owner = slots;
      owner[index] ??= { value: typeof initial === 'function' ? initial() : initial, set(next) {
        if (!live) { lateWrites += 1; return; }
        const value = typeof next === 'function' ? next(owner[index].value) : next;
        if (!Object.is(value, owner[index].value)) { owner[index].value = value; dirty = true; }
      } };
      return [owner[index].value, owner[index].set];
    },
    useCallback(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { callback, dependencies };
      return slots[index].callback;
    },
    useEffect(callback, dependencies) {
      const index = cursor++, owner = slots, previous = owner[index];
      if (!previous || !same(previous.dependencies, dependencies)) effects.push(() => { previous?.cleanup?.(); owner[index] = { dependencies, cleanup: callback() }; });
    },
  };
  const keyboard = {
    isVisible: () => input.focused,
    metrics: () => ({ screenY: dimensions.height - keyboardHeight }),
    dismiss() { keyboardCalls.push('dismiss'); input.focused = false; },
    addListener(name, callback) { const callbacks = listeners.get(name) ?? new Set(); callbacks.add(callback); listeners.set(name, callbacks); return { remove: () => callbacks.delete(callback) }; },
  };
  const reanimated = {
    __esModule: true, default: { View: 'Animated.View' },
    useReducedMotion: () => reducedMotion,
    useAnimatedStyle: (factory) => factory,
    useSharedValue(initial) {
      const ref = hooks.useRef(null);
      if (!ref.current) {
        let value = initial, active;
        ref.current = {
          get value() { return value; },
          set value(next) {
            if (active) active.cancelled = true;
            active = null;
            if (next?.animation) {
              active = { ...next, cancelled: false, finish(finished = true) { if (finished && !this.cancelled) value = this.target; this.callback?.(finished); } };
              animations.push(active);
            } else value = next;
          },
          cancel() { if (active) active.cancelled = true; active = null; },
        };
      }
      return ref.current;
    },
    withSpring: (target, options, callback) => ({ animation: 'spring', target, options, callback }),
    withTiming: (target, options, callback) => ({ animation: 'timing', target, options, callback }),
    cancelAnimation: (shared) => shared.cancel(), runOnJS: (callback) => callback,
  };
  const theme = { dark: platform === 'android', colors: { text: '#111', canvas: '#fff', border: '#ddd', muted: '#777', subtle: '#999', hover: '#eee', error: '#c00' }, fonts: { regular: 'regular', medium: 'medium' } };
  const ui = new Set(['../ui/GlassSurface', './GlassSurface', '../ui/Sheet', '../ui/MenuTrigger', '../ui/IconButton', './Icon', './ScreenChrome', './Artifacts', './ModelIcon']);
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const filename = path.resolve(__dirname, '..', file), source = fs.readFileSync(filename, 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(output, {
      module, exports: module.exports, Promise, Math, Set, Map,
      requestAnimationFrame: (callback) => { const id = ++frameId; frames.set(id, callback); return id; }, cancelAnimationFrame: (id) => frames.delete(id),
      setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; }, clearTimeout: (id) => timers.delete(id),
      require(name) {
        if (name === 'react') return hooks;
        if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
        if (name === 'react-native') return {
          ...Object.fromEntries(['ActivityIndicator', 'Image', 'Modal', 'Pressable', 'ScrollView', 'Switch', 'Text', 'TextInput', 'View'].map((name) => [name, name])),
          Platform: { OS: platform }, Keyboard: keyboard, useWindowDimensions: () => dimensions,
          BackHandler: { addEventListener: (_name, callback) => { listeners.set('back', new Set([callback])); return { remove: () => listeners.delete('back') }; } },
          StyleSheet: { create: (styles) => styles, hairlineWidth: 0.5, absoluteFill: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 } },
        };
        if (name === 'react-native-reanimated') return reanimated;
        if (name === 'react-native-keyboard-controller') return { OverKeyboardView: 'OverKeyboardView', useWindowDimensions: () => dimensions };
        if (name === 'react-native-gesture-handler') return { GestureHandlerRootView: 'GestureHandlerRootView', Pressable: 'GesturePressable', ScrollView: 'GestureScrollView' };
        if (name === 'react-native-safe-area-context') return { useSafeAreaInsets: () => insets };
        if (name === 'lucide-react-native' || ui.has(name)) return new Proxy({}, { get: (_target, key) => key });
        if (name === '../providers/AppProvider') return { useTheme: () => theme };
        if (name === 'expo-secure-store') return { getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} };
        if (name === 'expo-document-picker' || name === 'expo-image-picker' || name === '../lib/api') return {};
        if (name === '../ui/AnchoredMenu') return load('src/ui/AnchoredMenu.tsx');
        if (name === './useModalTransition') return load('src/ui/useModalTransition.ts');
        if (name === './overlayGeometry' || name === '../ui/overlayGeometry') return load('src/ui/overlayGeometry.ts');
        if (name === '../hooks/useKeyboardTop') return load('src/hooks/useKeyboardTop.ts');
        throw new Error(`Unexpected import ${name} in ${file}`);
      },
    }, { filename });
    modules.set(file, module.exports);
    return module.exports;
  }
  const Menu = load('src/ui/AnchoredMenu.tsx').AnchoredMenu;
  const Composer = composer && load('src/components/Composer.tsx').Composer;
  function inScope(name, callback) { if (!scopes.has(name)) scopes.set(name, []); slots = scopes.get(name); cursor = 0; return callback(); }
  function render(changes) {
    Object.assign(props, changes); dirty = false;
    if (composer) {
      composerTree = inScope('composer', () => Composer(props));
      for (const node of walk(composerTree)) {
        if (!node.props.ref || typeof node.props.ref !== 'object') continue;
        node.props.ref.current ??= node.type === 'TextInput' ? input : { measureInWindow: (callback) => {
          if (deferMeasurements) measurements.push(callback); else callback(70, 450, 44, 40);
        } };
      }
      menuProps = find(composerTree, Menu).props;
    } else menuProps = props;
    menuTree = inScope('menu', () => Menu(menuProps));
  }
  function settle() {
    for (let index = 0; index < 30; index++) {
      if (dirty) render();
      if (!effects.length) return;
      effects.splice(0).forEach((effect) => effect());
    }
    throw new Error('Hook effects did not settle');
  }
  function row(title) {
    const result = walk(menuTree).find((node) => isPressable(node) && walk(node.props.children).some((node) => node.type === 'Text' && node.props.children === title));
    assert.ok(result, `Missing menu row ${title}`);
    return result;
  }
  render(); settle();
  return {
    props, calls, keyboardCalls, input, animations,
    get tree() { return menuTree; }, get menuProps() { return menuProps; }, get composerTree() { return composerTree; },
    get closeCount() { return closeCount; }, get lateWrites() { return lateWrites; },
    render, settle, row,
    deferMeasurements() { deferMeasurements = true; },
    flushMeasurements() { deferMeasurements = false; measurements.splice(0).forEach((callback) => callback(70, 450, 44, 40)); settle(); },
    resize(width, height, nextInsets) { Object.assign(dimensions, { width, height }); Object.assign(insets, nextInsets); render(); settle(); },
    tap(title) { const node = row(title); if (!node.props.disabled) node.props.onPress(); },
    open(kind) { assert.ok(composer); find(composerTree, 'Pressable', (props) => props.accessibilityLabel?.startsWith(kind === 'model' ? '\u6a21\u578b ' : '\u601d\u8003\u7a0b\u5ea6 ')).props.onPress(); settle(); },
    exit() { const animation = animations.findLast((item) => item.callback && !item.cancelled); assert.ok(animation, 'No pending exit animation'); return animation; },
    frame() { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } settle(); },
    unmount() { for (const owner of scopes.values()) owner.forEach((slot) => slot?.cleanup?.()); live = false; },
  };
}

for (const platform of ['android', 'ios']) {
  test(`${platform}: actual Composer model and effort selections finish their exit before applying once without changing input focus`, () => {
    const h = harness({ platform, composer: true });
    const originalInput = find(h.composerTree, 'TextInput').props.ref;
    for (const [kind, title, expected] of [['model', 'Model 2', { kind: 'model', value: 'model-2' }], ['effort', 'high', { kind: 'effort', value: 'high' }]]) {
      const before = h.calls.length;
      h.open(kind); assert.equal(h.menuProps.preserveKeyboard, true);
      h.tap(title); h.settle();
      assert.equal(h.calls.length, before);
      assert.equal(h.menuProps.visible, false);
      assert.ok(h.row(title));
      const exit = h.exit(); exit.finish(false); h.settle(); h.frame();
      assert.equal(h.calls.length, before);
      exit.finish(); h.settle();
      assert.equal(h.calls.length, before);
      h.frame(); h.frame();
      assert.deepEqual(h.calls.slice(before), [expected]);
      assert.equal(find(h.composerTree, 'TextInput').props.ref, originalInput);
      assert.equal(find(h.composerTree, 'TextInput').props.value, 'Keep this draft');
      assert.equal(h.input.focused, true);
      assert.deepEqual(h.keyboardCalls, []);
    }
    h.unmount();
  });

  test(`${platform}: a long model list has a finite keyboard-aware scroll viewport and its tail selection remains actionable`, () => {
    const h = harness({ platform, composer: true, modelCount: 70 }); h.open('model');
    const scroll = scrollView(h.tree);
    assert.equal(scroll.props.keyboardShouldPersistTaps, 'always');
    assert.equal(scroll.props.keyboardDismissMode, 'none');
    assert.equal(walk(scroll).filter(isPressable).length, 70);
    const bounded = walk(h.tree).map((node) => flattenStyle(node.props.style)).find((style) => Number.isFinite(style.maxHeight));
    assert.ok(bounded && bounded.maxHeight > 0 && bounded.maxHeight < 852 - 320);
    h.render({ effort: 'low' }); h.settle(); h.tap('Model 69'); h.settle();
    h.exit().finish(); h.settle(); h.frame();
    assert.deepEqual(h.calls, [{ kind: 'model', value: 'model-69' }]);
    assert.deepEqual(h.keyboardCalls, []); h.unmount();
  });

  test(`${platform}: non-keyboard presentations reject early dismissals and drain the selected action only once`, () => {
    const h = harness({ platform, preserveKeyboard: false });
    const modal = find(h.tree, 'Modal');
    h.tap('Second'); h.settle(); modal.props.onDismiss();
    assert.deepEqual(h.calls, []);
    h.exit().finish(); h.settle();
    assert.deepEqual(h.calls, []);
    if (platform === 'ios') { h.frame(); assert.deepEqual(h.calls, []); find(h.tree, 'Modal').props.onDismiss(); }
    else h.frame();
    find(h.tree, 'Modal').props.onDismiss(); find(h.tree, 'Modal').props.onDismiss(); h.frame();
    assert.deepEqual(h.calls, [{ kind: 'action', value: 'second' }]); h.unmount();
  });

  test(`${platform}: stale rows, native dismissals and completed exit work cannot act on a reopened menu`, () => {
    const h = harness({ platform, preserveKeyboard: false });
    const oldModal = find(h.tree, 'Modal'), oldRow = h.row('First');
    h.tap('First'); h.settle(); const oldExit = h.exit();
    h.render({ visible: true }); h.settle();
    const currentModal = find(h.tree, 'Modal'); assert.notEqual(currentModal.key, oldModal.key);
    oldRow.props.onPress(); oldModal.props.onRequestClose(); oldModal.props.onDismiss(); oldExit.finish(); h.settle(); h.frame();
    assert.equal(h.props.visible, true); assert.deepEqual(h.calls, []);
    h.tap('Second'); h.settle(); h.exit().finish(); h.settle();
    oldModal.props.onDismiss(); assert.deepEqual(h.calls, []);
    if (platform === 'ios') find(h.tree, 'Modal').props.onDismiss(); else h.frame();
    assert.deepEqual(h.calls, [{ kind: 'action', value: 'second' }]); h.unmount();
  });
}

test('only the Android keyboard overlay owns a separate gesture root and gesture-native rows, backdrop and scrolling', () => {
  for (const [platform, preserveKeyboard, keyboardHeight] of [['android', true, 320], ['android', true, 0], ['android', false, 320], ['ios', true, 320], ['ios', false, 320], ['web', true, 0]]) {
    const h = harness({ platform, preserveKeyboard, keyboardHeight });
    const gestureRoot = find(h.tree, 'GestureHandlerRootView');
    const gestureOverlay = platform === 'android' && preserveKeyboard;
    assert.equal(Boolean(gestureRoot), gestureOverlay);
    assert.equal(scrollView(h.tree).type, gestureOverlay ? 'GestureScrollView' : 'ScrollView');
    for (const pressable of walk(h.tree).filter(isPressable)) assert.equal(pressable.type, gestureOverlay ? 'GesturePressable' : 'Pressable');
    if (gestureOverlay) {
      assert.equal(h.tree.type, 'OverKeyboardView');
      assert.equal(h.tree.props.children, gestureRoot);
      assert.equal(flattenStyle(gestureRoot.props.style).flex, 1);
      assert.equal(gestureRoot.props.pointerEvents, 'auto');
      h.tap('First'); h.settle();
      assert.equal(find(h.tree, 'GestureHandlerRootView').props.pointerEvents, 'none');
      assert.deepEqual(h.calls, []);
      h.exit().finish(); h.settle(); h.frame();
      assert.deepEqual(h.calls, [{ kind: 'action', value: 'first' }]);
    }
    h.unmount();
  }
});

test('duplicate taps claim one action while backdrop cancellation and unmount never manufacture a selection', () => {
  const h = harness();
  const first = h.row('First'), second = h.row('Second');
  first.props.onPress(); first.props.onPress(); second.props.onPress(); h.settle();
  assert.equal(h.closeCount, 1);
  h.exit().finish(); h.settle(); h.frame(); h.frame();
  assert.deepEqual(h.calls, [{ kind: 'action', value: 'first' }]); h.unmount();

  const cancelled = harness();
  const staleRow = cancelled.row('First');
  walk(cancelled.tree).find((node) => isPressable(node) && node.props.accessibilityLabel === '\u5173\u95ed\u83dc\u5355').props.onPress(); cancelled.settle();
  staleRow.props.onPress(); cancelled.exit().finish(); cancelled.settle(); cancelled.frame();
  assert.deepEqual(cancelled.calls, []); cancelled.unmount();

  const removed = harness(); removed.tap('First'); removed.settle(); const exit = removed.exit();
  removed.unmount(); exit.finish(); removed.frame();
  assert.deepEqual(removed.calls, []); assert.equal(removed.lateWrites, 0);
});

test('reopening before the deferred action frame cancels the previous opening rather than leaking its selection', () => {
  for (const platform of ['android', 'ios']) {
    const h = harness({ platform }); h.tap('First'); h.settle(); h.exit().finish(); h.settle();
    h.render({ visible: true }); h.settle(); h.frame();
    assert.deepEqual(h.calls, []);
    h.tap('Second'); h.settle(); h.exit().finish(); h.settle(); h.frame();
    assert.deepEqual(h.calls, [{ kind: 'action', value: 'second' }]); h.unmount();
  }
});

test('a closing Composer retains the exact selected model closure even if the published model list changes during its exit', () => {
  const h = harness({ composer: true }); h.open('model'); h.tap('Model 2'); h.settle();
  const replacementCalls = [];
  h.render({ models: models(1), onModel: (id) => replacementCalls.push(id) }); h.settle();
  h.exit().finish(); h.settle(); h.frame();
  assert.deepEqual(h.calls, [{ kind: 'model', value: 'model-2' }]); assert.deepEqual(replacementCalls, []); h.unmount();
});

test('reduced-motion iOS exits still wait for completed removal and native dismissal before applying an action', () => {
  const h = harness({ platform: 'ios', preserveKeyboard: false, reducedMotion: true }); h.tap('First'); h.settle();
  h.exit().finish(false); h.settle(); find(h.tree, 'Modal').props.onDismiss(); h.frame();
  assert.deepEqual(h.calls, []);
  h.exit().finish(); h.settle(); h.frame(); assert.deepEqual(h.calls, []);
  find(h.tree, 'Modal').props.onDismiss();
  assert.deepEqual(h.calls, [{ kind: 'action', value: 'first' }]); h.unmount();
});

test('landscape model menus stay inside notch-safe sides and the keyboard, including measured large-font content', () => {
  for (const platform of ['android', 'ios']) {
    const h = harness({ platform, width: 852, height: 393, keyboardHeight: 178, insets: { top: 0, bottom: 21, left: 59, right: 59 } });
    h.render({ width: 1000, anchor: { x: 6, y: 210, width: 44, height: 40 } }); h.settle();
    scrollView(h.tree).props.onContentSizeChange(700, 600); h.settle();
    const positioned = walk(h.tree).map((node) => flattenStyle(node.props.style)).find((style) => style.position === 'absolute' && Number.isFinite(style.width));
    const panel = walk(h.tree).map((node) => flattenStyle(node.props.style)).find((style) => Number.isFinite(style.maxHeight));
    assert.equal(positioned.left, 71);
    assert.equal(positioned.width, 710);
    assert.ok(positioned.top >= 8);
    assert.ok(positioned.top + panel.maxHeight <= 393 - 178 - 8);
    assert.deepEqual(h.keyboardCalls, []); h.unmount();
  }
});

test('rotating an open anchored menu cancels stale geometry without changing keyboard focus or selecting an item', () => {
  for (const platform of ['android', 'ios']) {
    const h = harness({ platform });
    const oldRow = h.row('First');
    h.resize(852, 393, { top: 0, bottom: 21, left: 59, right: 59 });
    assert.equal(h.props.visible, false);
    assert.equal(h.closeCount, 1);
    oldRow.props.onPress(); h.exit().finish(); h.settle(); h.frame();
    assert.deepEqual(h.calls, []);
    assert.equal(h.input.focused, true);
    assert.deepEqual(h.keyboardCalls, []); h.unmount();
  }
});

test('native modal menus explicitly support both landscape orientations instead of falling back to portrait', () => {
  const h = harness({ platform: 'ios', preserveKeyboard: false });
  assert.deepEqual(Array.from(find(h.tree, 'Modal').props.supportedOrientations), ['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']);
  h.unmount();
});

test('a long iOS menu collapses from the capped panel center, not the offscreen natural content center', () => {
  const h = harness({ platform: 'ios', width: 852, height: 393, keyboardHeight: 178, insets: { top: 0, bottom: 21, left: 59, right: 59 } });
  h.render({ anchor: { x: 70, y: 210, width: 44, height: 40 } }); h.settle();
  scrollView(h.tree).props.onContentSizeChange(260, 1200); h.settle();
  const positioned = walk(h.tree).find((node) => {
    const style = flattenStyle(node.props.style);
    return style.position === 'absolute' && style.width === 260;
  });
  const position = flattenStyle(positioned.props.style);
  const animate = positioned.props.style.find((style) => typeof style === 'function');
  const panel = walk(h.tree).map((node) => flattenStyle(node.props.style)).find((style) => Number.isFinite(style.maxHeight));
  h.tap('First'); h.settle(); h.exit().finish();
  assert.equal(animate().transform[1].translateY, 210 + 20 - position.top - panel.maxHeight / 2);
  h.unmount();
});

test('Composer rotation retains one TextInput and draft/edit ownership while bounding input height to the real keyboard remainder', () => {
  for (const platform of ['android', 'ios']) {
    const h = harness({ platform, composer: true });
    const original = find(h.composerTree, 'TextInput').props.ref;
    find(h.composerTree, 'TextInput').props.onLayout({ nativeEvent: { layout: { width: 350 } } }); h.settle();
    find(h.composerTree, 'Text', (props) => props.testID === 'chat-input-measure').props.onLayout({ nativeEvent: { layout: { height: 220 } } }); h.settle();
    h.resize(852, 393, { top: 0, bottom: 21, left: 59, right: 59 });
    let input = find(h.composerTree, 'TextInput');
    assert.equal(input.props.ref, original);
    assert.equal(input.props.value, 'Keep this draft');
    assert.equal(input.props.disableFullscreenUI, true);
    assert.equal(flattenStyle(input.props.style).maxHeight, 72);
    assert.equal(flattenStyle(input.props.style).height, 72);
    h.render({ availableHeight: 70 }); h.settle();
    input = find(h.composerTree, 'TextInput');
    assert.equal(flattenStyle(input.props.style).maxHeight, 40);
    assert.equal(flattenStyle(input.props.style).height, 40);
    h.render({ editingMessage: { id: 'edit-1', content: 'Edit separately', attachments: [] }, availableHeight: 100 }); h.settle();
    input = find(h.composerTree, 'TextInput');
    assert.equal(input.props.ref, original);
    assert.equal(input.props.value, 'Edit separately');
    assert.equal(flattenStyle(input.props.style).maxHeight, 32);
    h.render({ editingMessage: undefined }); h.settle();
    input = find(h.composerTree, 'TextInput');
    assert.equal(input.props.ref, original);
    assert.equal(input.props.value, 'Keep this draft');
    assert.equal(flattenStyle(input.props.style).height, 70);
    assert.deepEqual(h.keyboardCalls, []); h.unmount();
  }
});

test('Composer ignores a delayed portrait trigger measurement after rotation but accepts the fresh landscape selection', () => {
  for (const platform of ['android', 'ios']) {
    const h = harness({ platform, composer: true });
    const original = find(h.composerTree, 'TextInput').props.ref;
    h.deferMeasurements(); h.open('model');
    assert.equal(h.menuProps.visible, false);
    h.resize(852, 393, { top: 0, bottom: 21, left: 59, right: 59 });
    h.flushMeasurements();
    assert.equal(h.menuProps.visible, false);
    assert.equal(find(h.composerTree, 'TextInput').props.ref, original);
    h.open('model'); assert.equal(h.menuProps.visible, true);
    h.tap('Model 2'); h.settle(); h.exit().finish(); h.settle(); h.frame();
    assert.deepEqual(h.calls, [{ kind: 'model', value: 'model-2' }]);
    assert.equal(h.input.focused, true);
    assert.deepEqual(h.keyboardCalls, []); h.unmount();
  }
});

test('a same-width IME window-height update does not dismiss the open Composer menu', () => {
  const h = harness({ platform: 'android', composer: true });
  h.open('model'); assert.equal(h.menuProps.visible, true);
  h.resize(393, 532);
  assert.equal(h.menuProps.visible, true);
  h.tap('Model 1'); h.settle(); h.exit().finish(); h.settle(); h.frame();
  assert.deepEqual(h.calls, [{ kind: 'model', value: 'model-1' }]);
  assert.equal(h.input.focused, true);
  assert.deepEqual(h.keyboardCalls, []); h.unmount();
});

test('same-width cutout-side changes dismiss open menus and reject pending Composer anchors without blurring', () => {
  for (const composer of [false, true]) {
    const h = harness({ composer, width: 852, height: 393, keyboardHeight: 178, insets: { top: 0, bottom: 21, left: 32, right: 0 } });
    if (composer) h.open('model');
    h.resize(852, 393, { left: 0, right: 32 });
    assert.equal(composer ? h.menuProps.visible : h.props.visible, false);
    if (composer) {
      h.deferMeasurements(); h.open('model');
      h.resize(852, 393, { left: 32, right: 0 }); h.flushMeasurements();
      assert.equal(h.menuProps.visible, false);
      h.open('model'); assert.equal(h.menuProps.visible, true);
    }
    assert.equal(h.input.focused, true);
    assert.deepEqual(h.keyboardCalls, []); h.unmount();
  }
});

test('landscape editing budgets the full attachment row before growing the input', () => {
  const h = harness({ composer: true, width: 852, height: 393, keyboardHeight: 178 });
  h.render({ availableHeight: 205, editingMessage: { id: 'edit-image', content: 'Caption', attachments: [{ id: 'image', name: 'image.png', mime_type: 'image/png' }] } }); h.settle();
  const input = find(h.composerTree, 'TextInput');
  assert.equal(flattenStyle(input.props.style).maxHeight, 47);
  assert.equal(input.props.value, 'Caption');
  assert.equal(h.input.focused, true);
  assert.deepEqual(h.keyboardCalls, []); h.unmount();
});
