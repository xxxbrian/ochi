const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const jsx = (type, props, key) => ({ type, key, props: props ?? {} });
const walk = (node) => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object' && 'type' in node ? [node, ...walk(node.props.children)] : [];
const flatten = (style) => typeof style === 'function' ? flatten(style()) : Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style ?? {};

// Exercise the real geometry/effect closures; native layout and hit-testing remain device QA.
function harness(file, name, props, { width = 393, height = 852, insets = { top: 59, bottom: 34, left: 0, right: 0 }, platform = 'ios', keyboardHeight = 0 } = {}) {
  const slots = [], effects = [], frames = new Map(), timers = new Map(), shared = [], modules = new Map();
  const dimensions = { width, height, fontScale: 1 }, animations = [];
  let keyboardHandler;
  const keyboard = { height: { value: -keyboardHeight }, progress: { value: keyboardHeight > 0 ? 1 : 0 } };
  const keyboardCalls = [];
  const theme = { fonts: { medium: 'medium', regular: 'regular', semibold: 'semibold' }, colors: { surface: '#fff', text: '#111', muted: '#777' } };
  const navigation = { setParams() {}, isFocused: () => true };
  const chat = { messages: [], pending: [], session: { id: 'test', title: 'Test' }, refresh() {} };
  const instructions = { items: [] };
  const app = { ...theme, dark: false, models: [], preferences: {}, refreshPreferences() {}, invalidateLists() {} };
  const nativeAnimated = { Value: class { interpolate() { return {}; } }, View: 'Animated.View', timing: () => ({ start() {}, stop() {} }) };
  let cursor = 0, dirty = false, tree, id = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
  const hooks = {
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (next) => {
        const value = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; }
      }];
    },
    useCallback(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { callback, dependencies };
      return slots[index].callback;
    },
    useMemo(factory, dependencies) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { value: factory(), dependencies };
      return slots[index].value;
    },
    useEffect(callback, dependencies) {
      const index = cursor++, previous = slots[index];
      if (!previous || !same(previous.dependencies, dependencies)) effects.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: callback() }; });
    },
  };
  const motion = {
    __esModule: true, default: { View: 'Animated.View', Image: 'Animated.Image' },
    useAnimatedStyle: (callback) => callback, useReducedMotion: () => false, runOnJS: (callback) => callback,
    useSharedValue(initial) {
      const item = hooks.useRef();
      if (!item.current) {
        let value = initial;
        item.current = { get value() { return value; }, set value(next) { if (next?.animation) { value = next.target; animations.push(next); } else value = next; } };
        shared.push(item.current);
      }
      return item.current;
    },
    withTiming: (target, _options, callback) => ({ animation: true, target, callback }), withSpring: (target) => ({ animation: true, target }), cancelAnimation() {},
    Easing: { out: (value) => value, cubic: 'cubic' },
  };
  const chain = () => new Proxy({}, { get: (_target, method) => method === 'then' ? undefined : () => chain() });
  function load(relative) {
    if (modules.has(relative)) return modules.get(relative);
    const source = fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(output, {
      module, exports: module.exports,
      requestAnimationFrame(callback) { const key = ++id; frames.set(key, callback); return key; }, cancelAnimationFrame: (key) => frames.delete(key),
      setTimeout(callback) { const key = ++id; timers.set(key, callback); return key; }, clearTimeout: (key) => timers.delete(key),
      require(imported) {
        if (imported === 'react') return hooks;
        if (imported === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
        if (imported === 'react-native') return {
          ...Object.fromEntries(['View', 'Text', 'Image', 'Modal', 'ScrollView', 'Pressable', 'ActivityIndicator'].map((name) => [name, name])),
          Platform: { OS: platform }, Dimensions: { get: () => dimensions }, Keyboard: { dismiss() { keyboardCalls.push('dismiss'); } }, useWindowDimensions: () => dimensions,
          Animated: nativeAnimated, PanResponder: { create: () => ({ panHandlers: {} }) },
          StyleSheet: { create: (value) => value, absoluteFill: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }, hairlineWidth: 0.5 },
        };
        if (imported === 'react-native-reanimated') return motion;
        if (imported === 'react-native-gesture-handler') return { GestureDetector: 'GestureDetector', GestureHandlerRootView: 'GestureHandlerRootView', Gesture: new Proxy({}, { get: () => chain }) };
        if (imported === 'react-native-safe-area-context') return { SafeAreaListener: 'SafeAreaListener', useSafeAreaInsets: () => insets };
        if (imported === 'react-native-keyboard-controller') return { KeyboardAvoidingView: 'KeyboardAvoidingView', useKeyboardState: (select) => select({ isVisible: keyboard.height.value < 0 }), useGenericKeyboardHandler(handler) { keyboardHandler = handler; }, useKeyboardContext: () => ({ reanimated: keyboard }) };
        if (imported === '../providers/AppProvider') return { useTheme: () => theme, useApp: () => app };
        if (imported === 'expo-router') return { router: {}, useNavigation: () => navigation, useIsFocused: () => true };
        if (imported === '../hooks/useSessionChat') return { useSessionChat: () => chat };
        if (imported === '../hooks/useRunInstructions') return { useRunInstructions: () => instructions };
        if (imported === '../hooks/useDrawerNavigation') return { useDrawerNavigation: () => ({ canHandleInput: () => true }) };
        if (imported === '../lib/haptics') return { selectionHaptic() {} };
        if (imported === '../../brand.config') return { brand: { displayName: 'Ochi' } };
        if (imported === '../lib/api' && file.endsWith('ChatScreen.tsx')) return { isActiveStatus: () => false, api: {} };
        if (imported === '../lib/api') return { fileURL: () => '/image', resourceHeaders: () => ({}), imageSource: () => ({ uri: '/image' }) };
        if (imported === './artifactFiles') return { fileSize: () => '100KB', shareArtifact: async () => {} };
        if (imported === '../ui/overlayGeometry' || imported === './overlayGeometry') return load('src/ui/overlayGeometry.ts');
        if (imported === './useModalTransition') return { useModalTransition: () => ({ mounted: true, backdrop: {}, surface: {} }) };
        if (['expo-status-bar', 'lucide-react-native', '../ui/IconButton', './IconButton', './ZoomImage', './AnchoredMenu', '../ui/GlassSurface', '../ui/AnchoredMenu', '../ui/Sheet', '../ui/SessionTitleDialog'].includes(imported) || imported.startsWith('../components/')) return new Proxy({}, { get: (_target, key) => key });
        throw new Error(`Unexpected import ${imported}`);
      },
    });
    modules.set(relative, module.exports);
    return module.exports;
  }
  const Component = load(file)[name];
  function render() { cursor = 0; dirty = false; tree = Component(props); }
  function settle() {
    for (let count = 0; count < 20; count++) {
      if (dirty) render();
      if (!effects.length) return;
      effects.splice(0).forEach((effect) => effect());
    }
    throw new Error('Effects did not settle');
  }
  render(); settle();
  return {
    get tree() { return tree; }, shared, animations, keyboardCalls,
    keyboard(height, progress = height > 0 ? 1 : 0) { keyboard.height.value = -height; keyboard.progress.value = progress; keyboardHandler?.onMove({ height, progress }); render(); settle(); },
    resize(width, height, nextInsets) { Object.assign(dimensions, { width, height }); Object.assign(insets, nextInsets); render(); settle(); },
    settle,
    expireTimers() { for (const [key, callback] of [...timers]) { timers.delete(key); callback(); } settle(); },
  };
}

const imageFile = { id: 'image', name: 'Landscape', generation: { width: 2000, height: 1000, prompt: 'Test' } };
const imageStyle = (tree) => flatten(walk(tree).find((node) => node.type === 'Animated.View' && flatten(node.props.style).overflow === 'hidden').props.style);
const modal = (tree) => walk(tree).find((node) => node.type === 'Modal');

test('image viewer rotates into a notch-safe image area below reachable toolbar controls and only uses a fresh return rectangle', () => {
  let measure;
  const h = harness('src/components/ImageViewer.tsx', 'ImageViewer', { file: imageFile, onClose() {}, origin: { rect: { x: 20, y: 300, width: 300, height: 200, radius: 20 }, measure(done) { measure = done; } } });
  modal(h.tree).props.onShow();
  h.resize(852, 393, { top: 0, bottom: 21, left: 59, right: 59 });
  assert.ok(modal(h.tree).props.supportedOrientations.includes('landscape-right'));
  const toolbar = walk(h.tree).find((node) => node.type === 'Animated.View' && flatten(node.props.style).flexDirection === 'row');
  assert.equal(flatten(toolbar.props.style).left, 73);
  assert.equal(flatten(toolbar.props.style).right, 73);
  assert.equal(imageStyle(h.tree).top, 64);
  assert.equal(imageStyle(h.tree).height, 300);
  modal(h.tree).props.onRequestClose();
  measure({ x: 130, y: 70, width: 240, height: 100, radius: 18 });
  const closing = imageStyle(h.tree);
  assert.equal(closing.left, 130);
  assert.equal(closing.top, 70);
  assert.equal(closing.width, 240);
});

test('image close cannot morph toward a stale portrait callback or timeout fallback after rotation', () => {
  for (const timeout of [false, true]) {
    let measure;
    const h = harness('src/components/ImageViewer.tsx', 'ImageViewer', { file: imageFile, onClose() {}, origin: { rect: { x: 20, y: 300, width: 300, height: 200, radius: 20 }, measure(done) { measure = done; } } });
    modal(h.tree).props.onShow(); modal(h.tree).props.onRequestClose();
    h.resize(852, 393, { top: 0, bottom: 21, left: 59, right: 59 });
    if (timeout) h.expireTimers(); else measure({ x: 20, y: 300, width: 300, height: 200, radius: 20 });
    assert.equal(imageStyle(h.tree).opacity, 0);
    assert.equal(imageStyle(h.tree).left, 59);
  }
});

test('image viewer measures its own Modal safe area and canvas instead of inheriting a narrower Activity window', () => {
  const h = harness('src/components/ImageViewer.tsx', 'ImageViewer', { file: imageFile, onClose() {} }, { width: 775.2727, height: 392.7273, insets: { top: 27, bottom: 0, left: 49, right: 0 } });
  modal(h.tree).props.onShow();
  const listener = () => walk(h.tree).find((node) => node.type === 'SafeAreaListener');
  const toolbar = () => flatten(walk(h.tree).find((node) => node.type === 'Animated.View' && flatten(node.props.style).flexDirection === 'row').props.style);
  const frame = { x: 0, y: 0, width: 872.7273, height: 392.7273 };
  listener().props.onChange({ frame, insets: { top: 27, bottom: 0, left: 49, right: 48 } }); h.settle();
  assert.equal(toolbar().right, 62);
  assert.equal(toolbar().left, 63);
  assert.ok(Math.abs(imageStyle(h.tree).width - (frame.width - 49 - 48)) < 0.001);
  assert.ok(frame.width - toolbar().right <= frame.width - 48);
  // A 180-degree rotation swaps the system navigation side without changing window dimensions.
  listener().props.onChange({ frame, insets: { top: 27, bottom: 0, left: 48, right: 49 } }); h.settle();
  assert.equal(toolbar().left, 62);
  assert.equal(toolbar().right, 63);
  assert.equal(imageStyle(h.tree).left, 48);
  const oldListener = listener().props.onChange;
  h.resize(393, 852, { top: 59, bottom: 34, left: 0, right: 0 });
  listener().props.onChange({ frame: { x: 0, y: 0, width: 393, height: 852 }, insets: { top: 59, bottom: 34, left: 0, right: 0 } }); h.settle();
  oldListener({ frame, insets: { top: 27, bottom: 0, left: 48, right: 49 } }); h.settle();
  assert.equal(imageStyle(h.tree).width, 393);
  assert.equal(toolbar().left, 14);
});

test('zoomed-image pan and scale reset together on rotation, not just the displayed image transform', () => {
  const dragX = { value: 0 }, dragY = { value: 0 };
  const h = harness('src/components/ZoomImage.tsx', 'ZoomImage', { file: imageFile, imageRatio: 2, dragX, dragY });
  h.shared[0].value = 3; h.shared[1].value = 3;
  for (const index of [2, 3, 4, 5]) h.shared[index].value = 600;
  h.shared[7].value = true; dragX.value = 80; dragY.value = 120;
  h.resize(852, 393);
  assert.equal(h.shared[0].value, 1);
  assert.equal(h.shared[1].value, 1);
  for (const index of [2, 3, 4, 5]) assert.equal(h.shared[index].value, 0);
  assert.equal(h.shared[7].value, false);
  assert.equal(dragX.value, 0); assert.equal(dragY.value, 0);
});

test('landscape sheets support rotation, use the short viewport and preserve a nonshrinking reachable header', () => {
  const h = harness('src/ui/Sheet.tsx', 'Sheet', { visible: true, onClose() {}, title: 'Test', children: jsx('Body') }, { width: 852, height: 393, insets: { top: 0, bottom: 21, left: 59, right: 59 } });
  assert.ok(modal(h.tree).props.supportedOrientations.includes('landscape-left'));
  const styles = walk(h.tree).map((node) => flatten(node.props.style));
  const panel = styles.find((style) => style.maxWidth === 680);
  assert.equal(panel.height, 385);
  const avoiding = styles.find((style) => style.justifyContent === 'flex-end');
  assert.equal(avoiding.paddingLeft, 59); assert.equal(avoiding.paddingRight, 59);
  assert.ok(styles.some((style) => style.minHeight === 44 && style.flexShrink === 0));
  assert.ok(styles.some((style) => style.flex === 1 && style.minHeight === 0));
});

test('sheet IME layout preserves the header and scrollable body for full, partial and resized Dialog roots even when widths differ', () => {
  const h = harness('src/ui/Sheet.tsx', 'Sheet', { visible: true, onClose() {}, title: 'Task', children: jsx('ScrollView') }, { width: 872.7272727, height: 392.7272727, insets: { top: 27, bottom: 0, left: 49, right: 48 } });
  const root = () => modal(h.tree).props.children;
  const panel = () => walk(h.tree).map((node) => flatten(node.props.style)).find((style) => style.maxWidth === 680);
  const avoiding = () => walk(h.tree).map((node) => flatten(node.props.style)).find((style) => style.justifyContent === 'flex-end');
  const layout = (height) => { root().props.onLayout({ nativeEvent: { layout: { width: 824.7272949, height } } }); h.settle(); };
  const available = 392.7272727 - 214 - 35;
  h.keyboard(214);
  assert.equal(avoiding().bottom, 214);
  assert.ok(Math.abs(panel().height - available) < 0.001);
  assert.equal(avoiding().paddingBottom, undefined);
  layout(300);
  assert.ok(Math.abs(avoiding().bottom - (300 - (392.7272727 - 214))) < 0.001);
  assert.ok(Math.abs(panel().height - available) < 0.001);
  layout(392.7272727 - 214);
  assert.equal(avoiding().bottom, 0);
  assert.ok(Math.abs(panel().height - available) < 0.001);
  assert.ok(panel().height > 56 + 48);
  assert.equal(panel().maxHeight, undefined);
  assert.ok(walk(h.tree).some((node) => flatten(node.props.style).minHeight === 44 && flatten(node.props.style).flexShrink === 0));
  h.keyboard(0); layout(392.7272727);
  assert.equal(avoiding().bottom, 0);
  assert.equal(panel().height, 392.7272727 - 35);
  assert.deepEqual(h.keyboardCalls, []);
});

test('short-height chat composer scrolls to keep its input/send tail visible only when its overflow budget changes', () => {
  for (const [width, height] of [[852, 393], [393, 852]]) {
    const h = harness('src/screens/ChatScreen.tsx', 'ChatScreen', { sessionId: 'test' }, { width, height });
    const composerScroll = () => walk(walk(h.tree).find((node) => node.type === 'BlurScene').props.overlay).find((node) => node.type === 'ScrollView');
    const ref = composerScroll().props.ref, calls = [];
    assert.ok(ref);
    ref.current = { scrollToEnd: (options) => calls.push(options.animated) };
    const layout = (value) => composerScroll().props.onLayout({ nativeEvent: { layout: { height: value } } });
    const content = (value) => composerScroll().props.onContentSizeChange(700, value);
    layout(200); content(140); assert.equal(calls.length, 0);
    content(280); assert.equal(calls.length, width > height ? 1 : 0);
    content(280); assert.equal(calls.length, width > height ? 1 : 0);
    layout(120); content(320); assert.equal(calls.length, width > height ? 3 : 0);
    // Identical native size events must not steal the scroll position from a reader.
    layout(120); content(320); assert.equal(calls.length, width > height ? 3 : 0);
    h.resize(width, height, { left: 32, right: 0 });
    assert.equal(composerScroll().props.ref, ref);
    assert.equal(calls.every((animated) => animated === false), true);
    assert.deepEqual(h.keyboardCalls, []);
  }
});

test('Android chat uses the live IME inset on every frame, independent of previous layouts and open heights', () => {
  const h = harness('src/screens/ChatScreen.tsx', 'ChatScreen', {}, { platform: 'android', keyboardHeight: 312 });
  const area = () => walk(h.tree).find((node) => node.type === 'Animated.View' && typeof flatten(node.props.style).paddingBottom === 'number');
  const composer = () => walk(walk(h.tree).find((node) => node.type === 'BlurScene').props.overlay).find((node) => node.type === 'Composer');
  const originalKey = composer().key;
  const originalScroll = () => walk(walk(h.tree).find((node) => node.type === 'BlurScene').props.overlay).find((node) => node.type === 'ScrollView').props.ref;
  const scrollRef = originalScroll();
  assert.equal(originalKey, 0);
  assert.equal(walk(h.tree).some((node) => node.type === 'KeyboardAvoidingView'), false);
  assert.equal(flatten(area().props.style).paddingBottom, 312, 'mounting over an already-open keyboard needs no new start event');
  for (const [height, progress] of [[0, 0], [110, 0.4], [340, 1], [240, 1], [0, 0], [96, 0.3], [288, 1], [0, 0], [340, 1]]) {
    h.keyboard(height, progress);
    const current = area();
    assert.equal(flatten(current.props.style).paddingBottom, height);
    // A changed or late body-layout event must not become the next IME baseline.
    current.props.children.props.onLayout({ nativeEvent: { layout: { height: 852 - 105 - height } } });
    h.settle();
    assert.equal(flatten(area().props.style).paddingBottom, height);
    assert.equal(composer().key, originalKey);
    assert.equal(originalScroll(), scrollRef);
  }
  h.resize(852, 393, { top: 0, bottom: 0, left: 24, right: 0 });
  h.keyboard(178);
  assert.equal(flatten(area().props.style).paddingBottom, 178);
  h.resize(852, 393, { left: 0, right: 24 });
  assert.equal(flatten(area().props.style).paddingBottom, 178);
  assert.equal(originalScroll(), scrollRef);
  assert.deepEqual(h.keyboardCalls, []);
});

test('iOS chat retains native frame-aware keyboard avoidance without applying Android IME padding', () => {
  const h = harness('src/screens/ChatScreen.tsx', 'ChatScreen', {}, { platform: 'ios', keyboardHeight: 320 });
  const area = walk(h.tree).find((node) => node.type === 'KeyboardAvoidingView');
  assert.equal(area.props.behavior, 'padding');
  assert.equal(area.props.automaticOffset, true);
  assert.equal(flatten(area.props.style).paddingBottom, undefined);
  assert.deepEqual(h.keyboardCalls, []);
});

test('shared menu triggers reject late measurements after a same-width safe-area flip and accept a fresh press', () => {
  for (const name of ['MenuTrigger', 'LongPressMenu']) {
    const h = harness(`src/ui/${name}.tsx`, name, { items: [], children: 'Trigger' }, { width: 852, height: 393, insets: { top: 0, bottom: 24, left: 32, right: 0 } });
    const trigger = () => walk(h.tree).find((node) => node.type === 'Pressable');
    let measurement;
    trigger().props.ref.current = { measureInWindow: (done) => { measurement = done; } };
    const press = () => {
      if (name === 'LongPressMenu') { trigger().props.onPressIn(); trigger().props.onLongPress(); }
      else trigger().props.onPress();
    };
    press(); h.resize(852, 393, { left: 0, right: 32 });
    measurement(20, 40, 44, 44); h.settle();
    assert.equal(walk(h.tree).find((node) => node.type === 'AnchoredMenu').props.visible, false);
    press(); measurement(20, 40, 44, 44); h.settle();
    assert.equal(walk(h.tree).find((node) => node.type === 'AnchoredMenu').props.visible, true);
  }
});
