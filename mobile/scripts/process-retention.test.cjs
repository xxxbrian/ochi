const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const React = require('react');
const { create, act } = require('react-test-renderer');
const { createLoader } = require('../../shared/conversation/test-loader.cjs');
const { testI18n } = require('./helpers/i18n.cjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = clearTimeout;
const root = path.resolve(__dirname, '../..');
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
const text = (id, value, phase = 'final') => ({ id, seq: 1, kind: 'text', source_id: id, round_id: 'round', state: 'completed', text: value, phase });
const reason = { id: 'reason', seq: 2, kind: 'reasoning', source_id: 'reason', round_id: 'round', state: 'completed', text: 'Private reasoning' };
const tool = (id, outcome = 'success') => ({ id, seq: 3, kind: 'tool', source_id: id, round_id: 'round', state: 'completed', step: { id, name: 'browser_goto', status: 'completed', outcome, arguments: { url: 'https://example.invalid' }, output: 'Tool output' } });
const snapshot = (items = [], status = 'running', seq = 1) => ({ run_id: 'R', session_id: 'S', seq, items: items.map((value, index) => ({ ...value, seq: index })), status, created_at: '', updated_at: '' });
const message = (content, status = 'completed') => ({ id: 'canonical', run_id: 'R', role: 'assistant', content, run_status: status, has_process: true, created_at: '' });
const flatten = (style) => Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style || {};
const visible = (node) => { for (let n = node; n; n = n.parent) if (flatten(n.props.style).display === 'none') return false; return true; };
function setup(run = async () => { throw new Error('unexpected run load'); }) {
  const calls = { copy: [], end: 0, scroll: [], mounts: [] };
  const api = { api: { run }, isActiveStatus: (value) => ['running', 'waiting_user', 'waiting_resource', 'cancelling'].includes(value), userFacingRunError: () => 'Localized incomplete', imageSource: () => ({ uri: 'fixture' }) };
  const FlashList = React.forwardRef(function List(props, ref) {
    React.useImperativeHandle(ref, () => ({ scrollToEnd() { calls.end++; }, scrollToOffset(value) { calls.scroll.push(value); } }), []);
    return React.createElement('FlashList', props, props.data.map((item, index) => React.createElement(React.Fragment, { key: props.keyExtractor(item) }, props.renderItem({ item, index, target: 'Cell' }))));
  });
  const host = (type) => (props) => { React.useEffect(() => { if (type === 'MarkdownBlock') calls.mounts.push(props.content); }, []); return React.createElement(type, props, props.children); };
  const colors = new Proxy({}, { get: () => '#777' });
  const load = createLoader(require('typescript'), require, {
    'react-native': { ...Object.fromEntries(['View', 'Pressable', 'ScrollView', 'ActivityIndicator', 'TextInput', 'Image'].map((name) => [name, name])),
      StyleSheet: { create: (value) => value, hairlineWidth: 0.5 }, LayoutAnimation: { configureNext() {} },
      useWindowDimensions: () => ({ width: 402, height: 874, fontScale: 1 }), Share: { share: async () => {} }, Linking: { openURL: async () => {} } },
    'lucide-react-native': new Proxy({}, { get: (_, name) => host(String(name)) }),
    '@shopify/flash-list': { FlashList }, 'expo-clipboard': { setStringAsync: async (value) => calls.copy.push(value) },
    [path.join(root, 'mobile/src/lib/api.ts')]: api,
    [path.join(root, 'mobile/src/lib/i18n.ts')]: testI18n.native,
    [path.join(root, 'mobile/src/lib/errors.ts')]: testI18n.load('src/lib/errors.ts'),
    [path.join(root, 'mobile/src/providers/AppProvider.tsx')]: { useTheme: () => ({ colors, fonts: { mono: 'monospace' } }) },
    [path.join(root, 'mobile/src/components/ScreenChrome.tsx')]: { AppText: host('AppText'), ActionIcon: host('ActionIcon'), Button: host('Button'), ErrorNotice: host('ErrorNotice') },
    [path.join(root, 'mobile/src/components/Markdown.tsx')]: { Markdown: host('Markdown') },
    [path.join(root, 'mobile/src/components/ArtifactMarkdown.tsx')]: { ArtifactMarkdown: host('MarkdownBlock') },
    [path.join(root, 'mobile/src/components/Artifacts.tsx')]: { ArtifactCards: host('ArtifactCards') },
    [path.join(root, 'mobile/src/components/ProcessElapsed.tsx')]: { ProcessElapsed: () => null },
    [path.join(root, 'mobile/src/ui/LongPressMenu.tsx')]: { LongPressMenu: host('LongPressMenu') },
    [path.join(root, 'mobile/src/components/OchiActivityMark.tsx')]: { ActivityDisclosure: host('Disclosure'), ActivityStatusText: host('StatusText'), OchiActivityMark: () => null, useReducedMotion: () => true },
  });
  return { ...load(path.join(root, 'mobile/src/components/Activity.tsx')), ...load(path.join(root, 'mobile/src/components/ChatMessages.tsx')), calls };
}
async function mount(type, props) {
  let tree; await act(async () => { tree = create(React.createElement(type, props), { createNodeMock: () => ({ scrollToEnd() {}, scrollTo() {} }) }); await flush(); });
  return tree;
}
const chatProps = (patch = {}) => ({ messages: [], run: null, hasOlder: false, loadingOlder: false, loadOlder: async () => {}, refreshing: false, onRefresh() {}, resume: async () => {}, onRetry: async () => {}, onEdit() {}, ...patch });
const bodies = (tree) => tree.root.findAllByType('MarkdownBlock').filter(visible);

test('native real React keeps both final slots once through completion, persistence and the next turn', async () => {
  const { ChatMessages, calls } = setup();
  const live = snapshot([text('intro', 'Checking', 'commentary'), reason, text('a', 'Part A'), text('b', 'Part B')]);
  const tree = await mount(ChatMessages, chatProps({ run: live }));
  try {
    const first = bodies(tree).find((node) => node.props.content === 'Part A');
    const completed = { ...live, status: 'completed', seq: 2 };
    await act(async () => tree.update(React.createElement(ChatMessages, chatProps({ run: completed }))));
    assert.deepEqual(bodies(tree).map((node) => node.props.content), ['Part A', 'Part B']);
    assert.equal(calls.mounts.filter((value) => value === 'Part A').length, 1);
    await act(async () => tree.update(React.createElement(ChatMessages, chatProps({ messages: [message('Part A\n\nPart B')], run: { ...snapshot(), run_id: 'NEXT' } }))));
    assert.deepEqual(bodies(tree).map((node) => node.props.content), ['Part A', 'Part B']);
    assert.equal(calls.mounts.filter((value) => value === 'Part A').length, 1);
  } finally { await act(async () => tree.unmount()); }
});

test('native persisted terminal text stays readable while shared resource recovers a missed terminal event', async () => {
  const response = deferred(); let reads = 0;
  const { ChatMessages } = setup(() => { reads++; return response.promise; });
  const live = snapshot([text('partial', 'Partial candidate', 'pending'), reason], 'waiting_user');
  live.waiting_input = { question: 'Continue?' };
  const tree = await mount(ChatMessages, chatProps({ run: live }));
  try {
    await act(async () => tree.update(React.createElement(ChatMessages, chatProps({ messages: [message('Complete public history', 'interrupted')], run: live }))));
    assert.equal(reads, 1); assert.deepEqual(bodies(tree).map((node) => node.props.content), ['Complete public history']);
    assert.equal(tree.root.findAllByType('TextInput').length, 0);
    await act(async () => { response.resolve(snapshot([text('finished', 'Complete public history', 'commentary'), reason], 'interrupted', 3)); await flush(); });
    assert.deepEqual(bodies(tree).map((node) => node.props.content), ['Complete public history']);
  } finally { await act(async () => tree.unmount()); }
});

test('native cold history fetches process only on disclosure and preserves all public output during loading', async () => {
  const response = deferred(); let reads = 0;
  const { ChatMessages } = setup(() => { reads++; return response.promise; });
  const tree = await mount(ChatMessages, chatProps({ messages: [message('Saved answer')] }));
  try {
    assert.equal(reads, 0); assert.equal(bodies(tree)[0].props.content, 'Saved answer');
    const disclosure = tree.root.findAllByType('Pressable').find((node) => node.props.onPress && !node.props.accessibilityLabel);
    await act(async () => disclosure.props.onPress()); assert.equal(reads, 1);
    assert.equal(bodies(tree)[0].props.content, 'Saved answer');
    await act(async () => { response.resolve(snapshot([reason, text('final', 'Saved answer')], 'completed')); await flush(); });
    assert.deepEqual(bodies(tree).map((node) => node.props.content), ['Saved answer']);
  } finally { await act(async () => tree.unmount()); }
});

test('native needs-user tool remains a separate labelled row and is not counted as successful work', async () => {
  const { Activity } = setup();
  const tree = await mount(Activity, { snapshot: snapshot([tool('one'), tool('permission', 'needs_user'), tool('two')], 'waiting_user'), defaultExpanded: true, availableHeight: 200 });
  try {
    assert.ok(tree.root.findAllByType('AppText').some((node) => node.props.children === testI18n.native.t('process.needsUser')));
    const scrolls = tree.root.findAllByType('ScrollView'); assert.ok(scrolls.length > 0);
    assert.ok(scrolls.every((node) => flatten(node.props.style).maxHeight <= 200));
    assert.ok(scrolls.every((node) => node.props.keyboardShouldPersistTaps === 'always' && node.props.keyboardDismissMode === 'none'));
  } finally { await act(async () => tree.unmount()); }
});

test('native explicit process reading delays completion fold, and view-answer releases the outer reading owner', async () => {
  const { Activity } = setup(); const reading = [];
  const live = snapshot([text('intro', 'Checking', 'commentary'), reason, text('final', 'Answer')]);
  const props = { snapshot: live, onReadingChange: (...value) => reading.push(value) };
  const tree = await mount(Activity, props);
  try {
    const disclosure = tree.root.findAllByType('Pressable').find((node) => node.props.accessibilityState?.expanded === false);
    await act(async () => disclosure.props.onPress());
    await act(async () => tree.update(React.createElement(Activity, { ...props, snapshot: { ...live, status: 'completed', seq: 2 } })));
    assert.deepEqual(bodies(tree).map((node) => node.props.content), ['Checking', 'Answer']);
    const viewAnswer = tree.root.findAllByType('Pressable').find((node) => node.props.accessibilityLabel === testI18n.native.t('process.viewAnswer'));
    assert.ok(viewAnswer); await act(async () => viewAnswer.props.onPress());
    assert.deepEqual(bodies(tree).map((node) => node.props.content), ['Answer']);
    assert.equal(reading.at(-1)[0], false);
  } finally { await act(async () => tree.unmount()); }
});

test('native interrupted copy uses all public source bytes and never reasoning or tool results', async () => {
  const { ChatMessages, calls } = setup();
  const run = snapshot([text('a', 'First', 'commentary'), reason, tool('t'), text('b', 'Second', 'pending')], 'interrupted');
  const tree = await mount(ChatMessages, chatProps({ run }));
  try {
    const copy = tree.root.findAllByType('ActionIcon').find((node) => node.props.label === '复制回复');
    await act(async () => copy.props.onPress()); assert.deepEqual(calls.copy, ['First\n\nSecond']);
    assert.deepEqual(bodies(tree).map((node) => node.props.content), ['First', 'Second']);
  } finally { await act(async () => tree.unmount()); }
});
