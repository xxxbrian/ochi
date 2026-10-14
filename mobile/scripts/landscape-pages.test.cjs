const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const walk = (node) => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object' && 'type' in node ? [node, ...walk(node.props.children)] : [];
const matches = (node, type) => node.type === type || node.type?.name === type;
const find = (tree, type) => walk(tree).find((node) => matches(node, type));
const style = (value) => Array.isArray(value) ? Object.assign({}, ...value.map(style)) : value ?? {};

function harness(width = 852, height = 393, insets = { top: 0, left: 59, right: 59, bottom: 21 }) {
  const state = { viewport: { width, height, fontScale: 1 }, insets, values: {}, cursor: 0 };
  const loaded = new Map();
  const theme = { colors: { canvas: '#fff', surface: '#fafafa', text: '#111', muted: '#777', border: '#ddd' }, fonts: { regular: 'regular', medium: 'medium', semibold: 'semibold' } };
  const hooks = {
    memo: (fn) => fn,
    useState(initial) { const index = state.cursor++; return [index in state.values ? state.values[index] : typeof initial === 'function' ? initial() : initial, () => {}]; },
    useEffect() {}, useCallback: (fn) => fn, useMemo: (fn) => fn(), useRef: (current) => ({ current }),
  };
  const primitives = new Proxy({}, { get: (_target, key) => key });
  const native = {
    ...Object.fromEntries(['View', 'Text', 'TextInput', 'ScrollView', 'FlatList', 'Pressable', 'Switch', 'ActivityIndicator', 'Image'].map((name) => [name, name])),
    Platform: { OS: 'android' }, Alert: { alert() {} }, Linking: { openURL() {} },
    StyleSheet: { create: (value) => value, hairlineWidth: 0.5 },
    useWindowDimensions: () => state.viewport,
  };
  const imports = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'react-native': native,
    'lucide-react-native': primitives,
    'expo-router': { router: { push() {}, replace() {}, back() {}, canGoBack: () => true }, useFocusEffect() {}, useLocalSearchParams: () => ({ memoryId: 'new' }) },
    'react-native-safe-area-context': { useSafeAreaInsets: () => state.insets },
    'react-native-keyboard-controller': { KeyboardAvoidingView: 'KeyboardAvoidingView', KeyboardAwareScrollView: 'KeyboardAwareScrollView' },
    'react-native-webview': { WebView: 'WebView' },
    '../providers/AppProvider': { useTheme: () => theme, useApp: () => ({ ...theme, models: [], preferences: {} }) },
    '../lib/api': { getAPIBaseURL: () => 'https://ochi.example', isConfiguredAPIBaseURL: () => true, resourceHeaders: () => ({}), api: {} },
    '../lib/processTimeline': { unrepresentedOutput: () => '' },
    '../../../web/src/lib/scheduling': { scheduleWallTime: () => '', scheduleInstant: () => '' },
    '../../brand.config': { brand: { displayName: 'Ochi' } },
    '../hooks/useRunStream': { useRunStream: () => ({}) },
    './artifactFiles': { fileType: (file) => file.type ?? 'binary', fileSize: () => '1 KB' },
  };
  function load(file, tail = '') {
    if (loaded.has(file)) return loaded.get(file);
    const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(output + tail, {
      module, exports: module.exports, URL, Date, Intl, Math, Map, Set,
      require(name) {
        if (name in imports) return imports[name];
        if (['./ScreenChrome', '../components/ScreenChrome'].includes(name)) return load('src/components/ScreenChrome.tsx');
        if (['./SettingsChrome', '../components/SettingsChrome'].includes(name)) return load('src/components/SettingsChrome.tsx');
        if (name.startsWith('../ui/') || name.startsWith('../components/') || name.startsWith('./')) return primitives;
        throw new Error(`Unexpected import ${name}`);
      },
    }, { filename: file });
    loaded.set(file, module.exports);
    return module.exports;
  }
  return { state, load, render(file, name, props = {}, values = {}) { state.cursor = 0; state.values = values; return load(file)[name](props); } };
}

test('page columns rotate within either notch edge, retain a readable maximum width and include the home-indicator inset', () => {
  const h = harness();
  const { usePageContentStyle } = h.load('src/components/ScreenChrome.tsx');
  for (const [width, height, left, right, bottom] of [[393, 852, 0, 0, 34], [852, 393, 59, 59, 21], [740, 360, 59, 0, 21], [740, 360, 0, 59, 21], [667, 375, 0, 0, 0]]) {
    h.state.viewport = { width, height, fontScale: 1 };
    h.state.insets = { top: 0, left, right, bottom };
    const body = usePageContentStyle();
    const gutter = Math.max(0, (width - body.maxWidth) / 2);
    assert.ok(gutter + body.paddingLeft >= left + 20);
    assert.ok(gutter + body.paddingRight >= right + 20);
    assert.equal(body.maxWidth, 720);
    assert.equal(body.paddingBottom, bottom + 32);
    assert.equal(body.alignSelf, 'center');
  }
});

test('page chrome uses short-height metrics and horizontal safe area without applying the inset twice to settings content', () => {
  const h = harness(740, 360, { top: 0, left: 59, right: 0, bottom: 21 });
  const header = h.render('src/components/ScreenChrome.tsx', 'PageHeader', { title: '任务' });
  assert.equal(style(header.props.style).paddingLeft, 71);
  assert.equal(style(header.props.style).paddingRight, 12);
  assert.equal(style(header.props.style).minHeight, 52);
  const page = h.render('src/components/SettingsChrome.tsx', 'SettingsPage', { children: 'body' });
  assert.equal(style(page.props.style).paddingLeft, 59);
  assert.equal(style(page.props.style).paddingBottom, 21);
  const settings = h.load('src/components/SettingsChrome.tsx');
  assert.equal(settings.settingsStyles.content.maxWidth, 720);
  assert.equal(settings.settingsStyles.content.paddingHorizontal, 18);
  assert.equal(style(settings.SettingsHeader({ title: '设置' }).props.style).paddingBottom, 6);
});

test('Android fields disable the landscape extract editor by default; login and memory editing can scroll their save controls above the keyboard', () => {
  const h = harness();
  const { Field } = h.load('src/components/ScreenChrome.tsx');
  assert.equal(find(Field({ label: '内容' }), 'TextInput').props.disableFullscreenUI, true);
  assert.equal(find(Field({ label: '内容', disableFullscreenUI: false }), 'TextInput').props.disableFullscreenUI, false);
  const login = h.render('src/screens/LoginScreen.tsx', 'LoginScreen');
  const loginScroll = find(login, 'KeyboardAwareScrollView');
  assert.equal(loginScroll.props.keyboardShouldPersistTaps, 'handled');
  assert.equal(style(loginScroll.props.contentContainerStyle).paddingTop, 20);
  assert.ok(find(loginScroll, 'Button'));
  const memory = h.render('src/screens/MemoryScreens.tsx', 'MemoryEditorScreen');
  const memoryScroll = find(memory, 'KeyboardAwareScrollView');
  assert.ok(memoryScroll);
  assert.ok(find(memoryScroll, 'Button'));
});

test('short task editors keep Save inside the scroll range instead of reserving a footer that can consume the remaining keyboard viewport', () => {
  const h = harness();
  let tree = h.render('src/components/TaskEditor.tsx', 'TaskEditor', { visible: true });
  assert.ok(find(find(tree, 'ScrollView'), 'Button'));
  h.state.viewport = { width: 393, height: 852, fontScale: 1 };
  tree = h.render('src/components/TaskEditor.tsx', 'TaskEditor', { visible: true });
  assert.equal(find(find(tree, 'ScrollView'), 'Button'), undefined);
  assert.ok(find(tree, 'Button'));
});

test('project entry retains its virtualized list with a keyboard-aware scroller and never clips the composer header', () => {
  const h = harness();
  const tree = h.render('src/screens/ProjectsScreen.tsx', 'ProjectScreen', { projectId: 'project' }, { 0: { id: 'project', name: 'Project' }, 3: false });
  const list = find(tree, 'FlatList');
  assert.equal(list.props.removeClippedSubviews, false);
  assert.equal(list.props.contentContainerStyle.maxWidth, 720);
  const scroller = list.props.renderScrollComponent({ keyboardShouldPersistTaps: 'handled' });
  assert.equal(scroller.type, 'KeyboardAwareScrollView');
  assert.equal(scroller.props.keyboardShouldPersistTaps, 'handled');
  assert.equal(scroller.props.bottomOffset, 16);
});

test('document preview uses its actual short viewport and unsupported files can scroll rather than overflowing the toolbar', () => {
  const h = harness();
  const module = h.load('src/components/Artifacts.tsx', '\nexports.DocumentViewer = DocumentViewer;');
  const tree = module.DocumentViewer({ file: { id: 'file', name: 'File.bin', size: 1, url: '/file' } });
  const preview = walk(tree).find((node) => style(node.props.style).minHeight === 0 && style(node.props.style).flex === 1);
  assert.ok(preview);
  assert.ok(find(preview, 'ScrollView'));
  assert.ok(find(preview, 'Button'));
});
