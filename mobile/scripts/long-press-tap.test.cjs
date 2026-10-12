const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const jsx = (type, props) => ({ type, props: props ?? {} });
const walk = (node) => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object' && 'type' in node ? [node, ...walk(node.props.children)] : [];
const modifier = (name) => (...args) => ({ name, args });
const compile = (filename, requireMock) => {
  const module = { exports: {} };
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(output, { require: requireMock, module, exports: module.exports });
  return module.exports;
};

function harness(props) {
  let size;
  const menu = Object.assign(function ContextMenu() {}, { Trigger: 'Trigger', Preview: 'Preview', Items: 'Items' });
  const ui = { Host: 'Host', RNHostView: 'RNHostView', Button: 'Button', Divider: 'Divider', ContextMenu: menu };
  const source = path.resolve(__dirname, '../src/ui/LongPressMenu.ios.tsx');
  const component = compile(source, (name) => {
    if (name === 'react') return { Fragment: 'Fragment', useState: () => [size, (next) => { size = next; }] };
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react-native') return { View: 'View', StyleSheet: { create: (value) => value, absoluteFill: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 } } };
    if (name === '@expo/ui/swift-ui') return ui;
    if (name === '@expo/ui/swift-ui/modifiers') return { ...Object.fromEntries(['accessibilityAddTraits', 'accessibilityElement', 'accessibilityLabel', 'buttonStyle', 'contentShape', 'disabled', 'frame'].map((name) => [name, modifier(name)])), shapes: { roundedRectangle: modifier('roundedRectangle') } };
    if (name === '../providers/AppProvider') return { useTheme: () => ({ dark: false, colors: { text: '#111111' } }) };
    throw new Error(`Unexpected import ${name}`);
  });
  let tree = component.LongPressMenu(props);
  const render = () => { tree = component.LongPressMenu(props); return tree; };
  const measure = (width, height) => { tree.props.onLayout({ nativeEvent: { layout: { width, height } } }); return render(); };
  return { get tree() { return tree; }, measure, menu };
}

test('history tap uses the native Button action channel, not an unforwarded ContextMenu modifier callback', () => {
  let taps = 0;
  const h = harness({ label: 'History', selected: true, children: jsx('Row'), onPress: () => { taps += 1; }, items: [] });
  h.measure(292, 60);
  const trigger = walk(h.tree).find((node) => node.type === 'Trigger');
  const button = trigger.props.children;
  assert.equal(button.type, 'Button');
  assert.equal(button.props.modifiers.some((item) => item.name === 'onTapGesture'), false);
  assert.equal(walk(h.tree).find((node) => node.type === h.menu).props.modifiers.some((item) => item.name === 'onTapGesture'), false);

  // Execute the installed Expo Button wrapper to verify the actual JS-to-native event prop.
  const expo = path.resolve(path.dirname(require.resolve('@expo/ui/package.json')), 'src/swift-ui');
  const wrapper = compile(path.join(expo, 'Button/index.tsx'), (name) => {
    if (name === 'expo') return { requireNativeView: (_module, name) => `Native${name}` };
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === '../modifiers/utils') return { createViewModifierEventListener: () => ({ onGlobalEvent() {} }) };
    throw new Error(`Unexpected Button import ${name}`);
  });
  const native = wrapper.Button(button.props);
  assert.equal(native.type, 'NativeButton');
  assert.equal(typeof native.props.onButtonPress, 'function');
  native.props.onButtonPress();
  assert.equal(taps, 1);
});

test('native trigger owns finite bounds, a noninteractive RN label, selected semantics and the explicit preview', () => {
  const preview = jsx('SelectedRow');
  const h = harness({ label: 'History', selected: true, children: jsx('Row'), preview, onPress() {}, items: [] });
  assert.equal(walk(h.tree).some((node) => node.type === 'Host'), false);
  h.measure(292, 60);
  const button = walk(h.tree).find((node) => node.type === 'Trigger').props.children;
  assert.equal(button.props.children.props.children.props.pointerEvents, 'none');
  assert.equal(button.props.children.props.children.props.style.width, 292);
  const bounds = button.props.modifiers.find((item) => item.name === 'frame').args[0];
  assert.equal(bounds.width, 292);
  assert.equal(bounds.height, 60);
  assert.deepEqual(Array.from(button.props.modifiers.find((item) => item.name === 'accessibilityAddTraits').args[0]), ['isButton', 'isSelected']);
  assert.equal(button.props.modifiers.find((item) => item.name === 'accessibilityLabel').args[0], 'History');
  assert.equal(walk(h.tree).find((node) => node.type === 'Preview').props.children.props.children.props.children, preview);
});

test('responsive Yoga relayout updates both native label and explicit preview without making the measurement probe interactive', () => {
  const h = harness({ label: 'History', children: jsx('Row'), onPress() {}, items: [] });
  h.measure(292, 60);
  h.measure(310, 76);
  for (const host of walk(h.tree).filter((node) => node.type === 'RNHostView')) assert.equal(host.props.children.props.style.width, 310);
  const probe = h.tree.props.children[0];
  assert.equal(probe.props.pointerEvents, 'none');
  assert.equal(probe.props.accessibilityElementsHidden, true);
  assert.equal(probe.props.importantForAccessibility, 'no-hide-descendants');
  assert.equal(probe.props.style.opacity, 0);
});

test('message bubbles remain native long-press-only and menu actions use their own Button action channels', () => {
  let copied = 0;
  const h = harness({ label: 'Message', children: jsx('Bubble'), items: [{ key: 'copy', title: 'Copy', onPress: () => { copied += 1; } }] });
  h.measure(344, 240);
  assert.equal(walk(h.tree).find((node) => node.type === 'Trigger').props.children.type, 'RNHostView');
  const menuItems = walk(h.tree).find((node) => node.type === 'Items');
  const action = walk(menuItems).find((node) => node.type === 'Button');
  action.props.onPress();
  assert.equal(copied, 1);
});
