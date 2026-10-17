const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, imports, tail = '', globals = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output + tail, { module, exports: module.exports, URL, Set, Map, ...globals,
    require(name) { if (name in imports) return imports[name]; throw new Error(`Unexpected import: ${name}`); },
  }, { filename: file });
  return module.exports;
}

const process = load('src/lib/processTimeline.ts', {});
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const walk = (node) => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object' && 'type' in node ? [node, ...walk(node.props.children)] : [];
const matches = (node, type) => node.type === type || node.type?.name === type;
const snapshot = (patch = {}) => ({ run_id: 'A', session_id: 'S', seq: 1, status: 'running', output: '', steps: [], timeline: [], updated_at: '', ...patch });
const tool = (id, seq) => ({ id, seq, kind: 'tool', step: { id, name: 'exec', status: 'completed', arguments: { command: `echo ${id}` }, output: '{"stdout":"ok","exit_code":0}' } });
const message = (patch = {}) => ({ id: 'canonical-A', run_id: 'A', run_status: 'completed', role: 'assistant', content: 'Final answer', has_process: true, created_at: '2026-10-13T00:00:00Z', ...patch });
const scrollEvent = (offset, content = 700, viewport = 280) => ({ nativeEvent: { contentOffset: { y: offset }, contentSize: { height: content }, layoutMeasurement: { height: viewport } } });
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };

function harness(file, name, initialProps, overrides = {}) {
  const slots = [], frames = new Map(), timers = new Map(), calls = [], stateUpdates = [];
  let cursor = 0, frameID = 0, timerID = 0, time = 0, tree, props = initialProps, pendingEffects = [], mounted = true, lateWrites = 0, deferredState = false;
  const changed = (previous, deps) => !deps || !previous || deps.length !== previous.length || deps.some((dep, index) => dep !== previous[index]);
  const hooks = {
    memo: (value) => value,
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (next) => {
        const update = () => { if (!mounted) lateWrites++; slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; };
        if (deferredState) stateUpdates.push(update); else update();
      }];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (changed(previous?.deps, deps)) pendingEffects.push(() => {
        previous?.cleanup?.();
        slots[index] = { deps, cleanup: effect() };
      });
    },
    useMemo(fn, deps) { const index = cursor++; if (changed(slots[index]?.deps, deps)) slots[index] = { deps, value: fn() }; return slots[index].value; },
    useCallback(fn, deps) { return hooks.useMemo(() => fn, deps); },
  };
  const imports = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': {
      ...Object.fromEntries(['View', 'Pressable', 'ScrollView', 'ActivityIndicator', 'TextInput', 'Image'].map((name) => [name, name])),
      StyleSheet: { create: (styles) => styles, hairlineWidth: 0.5 },
      LayoutAnimation: { configureNext() {} },
      Share: { share: async () => undefined }, Linking: { openURL: async () => undefined },
      useWindowDimensions: () => ({ fontScale: 1 }),
    },
    '@shopify/flash-list': { FlashList: 'FlashList' },
    'expo-clipboard': { setStringAsync: async () => undefined },
    'lucide-react-native': new Proxy({}, { get: (_target, key) => String(key) }),
    '../lib/api': { isActiveStatus: (status) => ['running', 'queued', 'waiting_user', 'waiting_resource', 'cancelling'].includes(status), api: { run: async () => { throw new Error('Unexpected run fetch'); } } },
    '../lib/processTimeline': process,
    '../providers/AppProvider': { useTheme: () => ({ colors: { muted: '#777', border: '#ccc', text: '#111', raised: '#fff' }, fonts: { mono: 'monospace' } }) },
    '../ui/LongPressMenu': { LongPressMenu: 'LongPressMenu' },
    './ScreenChrome': { AppText: 'AppText', ActionIcon: 'ActionIcon', Button: 'Button', ErrorNotice: 'ErrorNotice' },
    './Markdown': { Markdown: 'Markdown' }, './ActivityStep': { StepRow: 'StepRow' },
    './Artifacts': { ArtifactCards: 'ArtifactCards' }, './Activity': { Activity: 'Activity' },
    './ArtifactMarkdown': { ArtifactMarkdown: 'ArtifactMarkdown' },
    './ProcessElapsed': { ProcessElapsed: 'ProcessElapsed' },
    './OchiActivityMark': { ActivityDisclosure: 'ActivityDisclosure', ActivityStatusText: 'ActivityStatusText', OchiActivityMark: 'OchiActivityMark', useReducedMotion: () => false },
    ...overrides,
  };
  const exports = { Activity: 'exports.ProcessViewport = ProcessViewport; exports.ToolGroup = ToolGroup; exports.DetailSection = DetailSection; exports.ProcessText = ProcessText; exports.PublicText = PublicText;', ChatMessages: 'exports.AssistantBubble = AssistantBubble; exports.projectRows = projectRows;' };
  const module = load(file, imports, `\n${exports[file.split('/').at(-1).split('.')[0]] ?? ''}`, {
    requestAnimationFrame(fn) { const id = ++frameID; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); }, AbortController,
    setTimeout(fn, delay) { const id = ++timerID; timers.set(id, { fn, due: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const render = (changes = {}) => {
    props = { ...props, ...changes }; cursor = 0; pendingEffects = [];
    tree = module[name](props);
    for (const commit of pendingEffects) commit();
  };
  render();
  return {
    get tree() { return tree; }, get lateWrites() { return lateWrites; }, module, render, calls,
    deferState() { deferredState = true; },
    flushState() { while (stateUpdates.length) stateUpdates.shift()(); deferredState = false; },
    find(type) { return walk(tree).find((node) => matches(node, type)); },
    all(type) { return walk(tree).filter((node) => matches(node, type)); },
    frame() { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } },
    time(milliseconds) { time += milliseconds; for (const [id, timer] of [...timers]) if (timer.due <= time) { timers.delete(id); timer.fn(); } },
    get timerCount() { return timers.size; },
    bind(type) { this.find(type).props.ref.current = { scrollToEnd: (options) => calls.push(options) }; },
    unmount() { mounted = false; for (const slot of slots) slot?.cleanup?.(); },
  };
}

const chatProps = (patch = {}) => ({ messages: [], run: snapshot(), hasOlder: false, loadingOlder: false, loadOlder: async () => {}, refreshing: false, onRefresh() {}, resume: async () => {}, onRetry: async () => {}, onEdit() {}, ...patch });

test('jump-to-latest stays out of the header when the landscape keyboard and editing composer consume the transcript', () => {
  const h = harness('src/components/ChatMessages.tsx', 'ChatMessages', chatProps({ bottomInset: 120 }));
  const jump = () => h.all('Pressable').find((node) => node.props.accessibilityLabel === '回到最新消息');
  h.find('View').props.onLayout({ nativeEvent: { layout: { height: 180 } } });
  h.find('FlashList').props.onScrollBeginDrag();
  h.find('FlashList').props.onScroll(scrollEvent(0));
  h.render();
  assert.ok(jump(), 'the button is available when a real transcript strip remains');
  h.find('View').props.onLayout({ nativeEvent: { layout: { height: 137 } } });
  h.render({ bottomInset: 158 });
  assert.equal(jump(), undefined, 'no negative top position over chat header or edit actions');
  h.find('View').props.onLayout({ nativeEvent: { layout: { height: 600 } } });
  h.render();
  assert.ok(jump(), 'portrait or keyboard dismissal restores the affordance');
  h.unmount();
});

test('artifact Markdown maps canonical same-origin links and removes only its authenticated image duplicates, never foreign paths or code examples', () => {
  const file = { id: 'image', name: 'image.png', mime_type: 'image/png', url: '/api/files/image/content' };
  const canonical = `https://ochi.example${file.url}`;
  const foreign = `https://other.example${file.url}`;
  const content = `![local](${canonical})\n![foreign](${foreign})\n\`![code](${canonical})\``;
  const h = harness('src/components/ArtifactMarkdown.tsx', 'ArtifactMarkdown', { content, files: [file] }, {
    '../lib/api': { fileURL: (url) => new URL(url, 'https://ochi.example/').href },
    './Artifacts': { ArtifactViewer: 'ArtifactViewer' },
  });
  const markdown = h.find('Markdown').props;
  assert.doesNotMatch(markdown.content, /!\[local\]/);
  assert.ok(markdown.content.includes(`![foreign](${foreign})`));
  assert.ok(markdown.content.includes(`\`![code](${canonical})\``));
  assert.equal(markdown.onLink(foreign), false);
  assert.equal(markdown.onLink('http://['), false);
  assert.equal(markdown.onLink(`${canonical}?download=1`), true);
  h.render();
  assert.equal(h.find('ArtifactViewer').props.file, file);
});

test('assistant occurrence key, renderer and supplied panel remain stable through live, canonical persistence and the next run', () => {
  const h = harness('src/components/ChatMessages.tsx', 'ChatMessages', chatProps());
  const live = h.find('FlashList').props;
  const initial = live.renderItem({ item: live.data[0] });
  assert.equal(initial.key, 'assistant-A');
  assert.equal(initial.type.name, 'AssistantBubble');
  const persisted = message();
  const final = snapshot({ status: 'completed', seq: 9, output: 'Final answer' });
  h.render({ messages: [persisted], run: final });
  let list = h.find('FlashList').props;
  assert.equal(list.data.length, 1);
  const committed = list.renderItem({ item: list.data[0] });
  assert.equal(committed.key, initial.key);
  assert.equal(committed.type, initial.type);
  assert.equal(committed.props.snapshot, final);
  h.render({ messages: [persisted, { id: 'next-user', role: 'user', content: 'Next', created_at: '' }], run: snapshot({ run_id: 'B' }) });
  list = h.find('FlashList').props;
  const previous = list.renderItem({ item: list.data[0] });
  assert.equal(previous.key, initial.key);
  assert.equal(previous.type, initial.type);
  assert.equal(previous.props.snapshot, undefined);
  assert.equal(previous.props.onRetry, undefined);
  assert.equal(list.getItemType(list.data[0]), 'assistant');
  assert.equal(persisted.content, 'Final answer');
});

test('native live rows and completed messages use attachments while snapshots retain artifacts', () => {
  const files = [{ id: 'image', url: '/api/files/image/content', mime_type: 'image/png' }];
  const h = harness('src/components/ChatMessages.tsx', 'ChatMessages', chatProps({ run: snapshot({ artifacts: files }) }));
  const [row] = h.find('FlashList').props.data;
  assert.equal(row.message.attachments, files);
  assert.equal(Object.hasOwn(row.message, 'artifacts'), false);
  assert.equal(row.snapshot.artifacts, files);
  h.unmount();
  const bubble = harness('src/components/ChatMessages.tsx', 'AssistantBubble', {
    message: message({ attachments: files, has_process: false }), onResume: async () => {}, onProcessReadingChange() {},
  });
  assert.equal(bubble.find('ArtifactCards').props.files, files);
  bubble.unmount();
});

test('cached terminal snapshot avoids a history loading remount and keeps current output, artifacts and Activity props after the next turn', () => {
  let fetches = 0;
  const final = snapshot({ status: 'completed', seq: 9, output: 'Final answer', steps: [tool('t', 2).step], timeline: [tool('t', 2)], artifacts: [{ id: 'file' }] });
  const h = harness('src/components/ChatMessages.tsx', 'AssistantBubble', { message: message({ id: 'run-A' }), snapshot: final, onResume: async () => {}, onProcessReadingChange() {} }, {
    '../lib/api': { isActiveStatus: (status) => status === 'running', api: { run: async () => { fetches++; return final; } } },
  });
  const initial = h.find('Activity');
  h.render({ message: message(), snapshot: undefined });
  const historical = h.find('Activity');
  assert.equal(historical.type, initial.type);
  assert.equal(historical.props.snapshot, final);
  assert.equal(historical.props.onReadingChange, initial.props.onReadingChange);
  assert.equal(h.find('ArtifactMarkdown').props.content, 'Final answer');
  assert.equal(h.find('ArtifactCards').props.files, final.artifacts);
  assert.equal(h.find('ActivityIndicator'), undefined);
  assert.equal(fetches, 0);
});

test('outer following cancels queued frames immediately and stays blocked until every process reader returns or closes', () => {
  const h = harness('src/components/ChatMessages.tsx', 'ChatMessages', chatProps({ messages: [message()], run: snapshot({ run_id: 'B' }) }));
  h.bind('FlashList');
  let list = h.find('FlashList').props;
  assert.equal(list.maintainVisibleContentPosition.autoscrollToBottomThreshold, undefined);
  const first = list.renderItem({ item: list.data[0] });
  const second = list.renderItem({ item: list.data[1] });
  list.onContentSizeChange(300, 1000);
  first.props.onProcessReadingChange('A', true);
  h.frame();
  assert.equal(h.calls.length, 0);
  second.props.onProcessReadingChange('B', true);
  first.props.onProcessReadingChange('A', false);
  list.onContentSizeChange(300, 1200); h.frame();
  assert.equal(h.calls.length, 0);
  second.props.onProcessReadingChange('B', false);
  list.onContentSizeChange(300, 1300); h.frame();
  assert.equal(h.calls.length, 1);
  list.onScrollBeginDrag();
  list.onScroll(scrollEvent(30, 1300, 600));
  list.onScrollEndDrag();
  list.onContentSizeChange(300, 1500); h.frame();
  assert.equal(h.calls.length, 1);
  list.onScroll(scrollEvent(900, 1500, 600));
  list.onContentSizeChange(300, 1600); h.frame();
  assert.equal(h.calls.length, 2);
});

test('nested process reading blocks outer final-output growth and unmount releases the outer gate without losing normal anchoring', () => {
  const outer = harness('src/components/ChatMessages.tsx', 'ChatMessages', chatProps());
  outer.bind('FlashList');
  const list = outer.find('FlashList').props;
  const bubble = list.renderItem({ item: list.data[0] });
  const inner = harness('src/components/Activity.tsx', 'ProcessViewport', { maxHeight: 280, children: null, onReadingChange: (reading) => bubble.props.onProcessReadingChange('A', reading) });
  inner.bind('ScrollView');
  const scroll = inner.find('ScrollView').props;
  scroll.onLayout({ nativeEvent: { layout: { height: 280 } } });
  scroll.onContentSizeChange(300, 700); inner.frame();
  scroll.onScroll(scrollEvent(420));
  outer.find('FlashList').props.onContentSizeChange(300, 1000); outer.frame();
  assert.equal(outer.calls.length, 1);
  scroll.onScrollBeginDrag();
  scroll.onScroll(scrollEvent(50)); scroll.onScrollEndDrag(scrollEvent(50));
  outer.find('FlashList').props.onContentSizeChange(300, 1600); outer.frame();
  assert.equal(outer.calls.length, 1);
  inner.render({ children: 'New thought while the reader stays above tail' });
  assert.equal(inner.calls.length, 1);
  inner.unmount();
  outer.find('FlashList').props.onContentSizeChange(300, 1700); outer.frame();
  assert.equal(outer.calls.length, 2);
  assert.deepEqual(plain(outer.find('FlashList').props.maintainVisibleContentPosition), { startRenderingFromBottom: false });
});

test('explicit latest resumes outer following for every paused panel and stale layout/settle callbacks cannot undo it; fresh manual reading rearms', () => {
  const h = harness('src/components/ChatMessages.tsx', 'ChatMessages', chatProps({ messages: [message()], run: snapshot({ run_id: 'B' }) }));
  h.bind('FlashList');
  let list = h.find('FlashList').props;
  const first = list.renderItem({ item: list.data[0] }), second = list.renderItem({ item: list.data[1] });
  first.props.onProcessReadingChange('A', true);
  second.props.onProcessReadingChange('B', true);
  h.render();
  h.all('Pressable').find((node) => node.props.accessibilityLabel === '回到最新消息').props.onPress();
  h.render();
  assert.equal(h.all('Pressable').find((node) => node.props.accessibilityLabel === '回到最新消息'), undefined);
  list = h.find('FlashList').props;
  list.onScroll(scrollEvent(10, 1000, 600));
  list.onContentSizeChange(300, 1100); h.frame();
  assert.equal(h.calls.length, 2);
  first.props.onProcessReadingChange('A', false);
  first.props.onProcessReadingChange('A', true);
  second.props.onProcessReadingChange('B', true);
  list.onContentSizeChange(300, 1200); h.frame();
  assert.equal(h.calls.length, 3);
  h.render();
  assert.equal(h.all('Pressable').find((node) => node.props.accessibilityLabel === '回到最新消息'), undefined);
  first.props.onProcessReadingChange('A', true, true);
  list.onContentSizeChange(300, 1300); h.frame();
  assert.equal(h.calls.length, 3);
  first.props.onProcessReadingChange('A', false);
  list.onContentSizeChange(300, 1400); h.frame();
  assert.equal(h.calls.length, 4);
});

test('fresh inner interaction reaches the outer reader even when the panel was already reading before an explicit latest override', () => {
  const outer = harness('src/components/ChatMessages.tsx', 'ChatMessages', chatProps());
  outer.bind('FlashList');
  const list = outer.find('FlashList').props;
  const row = list.renderItem({ item: list.data[0] });
  const bubble = harness('src/components/ChatMessages.tsx', 'AssistantBubble', row.props);
  const inner = harness('src/components/Activity.tsx', 'ProcessViewport', { maxHeight: 280, children: null, onReadingChange: bubble.find('Activity').props.onReadingChange });
  inner.bind('ScrollView');
  const scroll = inner.find('ScrollView').props;
  scroll.onLayout({ nativeEvent: { layout: { height: 280 } } });
  scroll.onContentSizeChange(300, 700); inner.frame();
  scroll.onScroll(scrollEvent(420));
  scroll.onTouchStart(); scroll.onScroll(scrollEvent(20)); scroll.onTouchEnd();
  outer.render(); outer.find('Pressable').props.onPress();
  inner.frame(); inner.frame();
  list.onContentSizeChange(300, 1000); outer.frame();
  assert.equal(outer.calls.length, 2);
  scroll.onTouchStart();
  list.onContentSizeChange(300, 1200); outer.frame();
  assert.equal(outer.calls.length, 2);
  inner.unmount(); bubble.unmount();
  list.onContentSizeChange(300, 1300); outer.frame();
  assert.equal(outer.calls.length, 3);
});

test('nested touch release settles after layout, tail action and cleanup all release reading; callbacks cannot become stuck', () => {
  const changes = [];
  const h = harness('src/components/Activity.tsx', 'ProcessViewport', { maxHeight: 280, children: null, onReadingChange: (value) => changes.push(value) });
  h.bind('ScrollView');
  const scroll = h.find('ScrollView').props;
  scroll.onLayout({ nativeEvent: { layout: { height: 280 } } });
  scroll.onContentSizeChange(300, 80); h.frame();
  assert.deepEqual(changes, [true, false]);
  scroll.onTouchStart(); scroll.onTouchEnd(); h.frame(); h.frame();
  assert.equal(changes.at(-1), false);
  scroll.onTouchStart(); scroll.onTouchEnd();
  scroll.onContentSizeChange(300, 700); h.frame(); h.frame();
  assert.equal(changes.at(-1), true);
  h.render(); h.find('Pressable').props.onPress();
  assert.equal(changes.at(-1), false);
  scroll.onScroll(scrollEvent(420));
  scroll.onScrollBeginDrag(); scroll.onScroll(scrollEvent(10)); scroll.onScrollEndDrag(scrollEvent(10));
  assert.equal(changes.at(-1), true);
  h.unmount(); h.frame(); h.frame();
  assert.equal(changes.at(-1), false);
  assert.equal(h.lateWrites, 0);
});

test('explicitly opened Activity and standalone tool technical detail survive adjacency promotion and terminal updates', () => {
  const first = tool('t1', 2), second = tool('t2', 3);
  const activity = harness('src/components/Activity.tsx', 'Activity', { snapshot: snapshot({ steps: [first.step], timeline: [first] }), defaultExpanded: true });
  let section = activity.find('DetailSection');
  section.props.onStepExpansionChange('t1', { open: true, technical: true }); activity.render();
  const panel = harness('src/components/Activity.tsx', 'DetailSection', activity.find('DetailSection').props);
  let row = panel.find('ProcessRowView');
  const group = harness('src/components/Activity.tsx', 'ToolGroup', row.props);
  const step = group.find('StepRow');
  assert.deepEqual(plain(step.props.expansion), { open: true, technical: true });
  const singleRoot = group.tree.type;
  activity.render({ snapshot: snapshot({ seq: 3, steps: [first.step, second.step], timeline: [first, second] }) });
  panel.render(activity.find('DetailSection').props);
  row = panel.find('ProcessRowView'); group.render(row.props);
  assert.equal(group.tree.type, singleRoot);
  assert.equal(group.find('Pressable').props.accessibilityState.expanded, true);
  assert.deepEqual(plain(group.all('StepRow')[0].props.expansion), { open: true, technical: true });
  const detail = harness('src/components/ActivityStep.tsx', 'StepRow', group.all('StepRow')[0].props);
  assert.equal(detail.find('Pressable').props.accessibilityState.expanded, true);
  assert.ok(walk(detail.tree).some((node) => node.type === 'AppText' && node.props.children === '收起技术详情'));
  group.find('Pressable').props.onPress(); group.render();
  assert.equal(group.find('Pressable').props.accessibilityState.expanded, false);
  group.find('Pressable').props.onPress(); group.render();
  assert.deepEqual(plain(group.all('StepRow')[0].props.expansion), { open: true, technical: true });
  activity.render({ snapshot: snapshot({ status: 'completed', seq: 4, output: 'Final', steps: [first.step, second.step], timeline: [first, second] }) });
  activity.render();
  assert.equal(activity.find('DetailSection').props.hidden, false);
  assert.equal(activity.find('DetailSection').props.open, true);
  assert.deepEqual(plain(activity.find('DetailSection').props.stepExpansion.t1), { open: true, technical: true });
});

test('untouched adjacent tools remain compact rather than expanding every new group', () => {
  const row = process.processRows([tool('t1', 1), tool('t2', 2)])[0];
  const h = harness('src/components/Activity.tsx', 'ToolGroup', { row, stepExpansion: {}, onStepExpansionChange() {} });
  assert.equal(h.find('Pressable').props.accessibilityState.expanded, false);
  assert.equal(h.find('StepRow'), undefined);
});

test('a missed terminal event hydrates the remembered panel in place without briefly restoring an active status or loading shell', async () => {
  let resolve;
  const waiting = snapshot({ status: 'waiting_user', seq: 4, output: 'Progress', waiting_input: { question: 'Choose' } });
  const changes = [];
  const h = harness('src/components/ChatMessages.tsx', 'AssistantBubble', { message: message({ run_status: 'waiting_user' }), snapshot: waiting, onResume: async () => {}, onProcessReadingChange: (...args) => changes.push(args) }, {
    '../lib/api': { isActiveStatus: (status) => ['running', 'waiting_user'].includes(status), api: { run: () => new Promise((done) => { resolve = done; }) } },
  });
  assert.ok(h.find('WaitingCard'));
  h.render({ message: message(), snapshot: undefined });
  assert.equal(h.find('Activity').props.snapshot.status, 'completed');
  assert.equal(h.find('ArtifactMarkdown').props.content, 'Final answer');
  assert.equal(h.find('WaitingCard'), undefined);
  assert.equal(h.find('ActivityIndicator'), undefined);
  const final = snapshot({ status: 'completed', seq: 9, output: 'Final answer', timeline: [tool('t', 2)] });
  resolve(final); await flush(); h.render();
  assert.equal(h.find('Activity').props.snapshot, final);
  assert.equal(h.find('ActivityIndicator'), undefined);
  h.find('Activity').props.onReadingChange(true);
  h.unmount();
  assert.deepEqual(changes.at(-1), ['A', false]);
});

test('missing-terminal hydration retries transient failures with bounded delays while retaining the same process view', async () => {
  const final = snapshot({ status: 'completed', seq: 8, output: 'Final answer', timeline: [tool('t', 2)] });
  let requests = 0;
  const h = harness('src/components/ChatMessages.tsx', 'AssistantBubble', { message: message(), snapshot: snapshot({ seq: 4 }), onResume: async () => {}, onProcessReadingChange() {} }, {
    '../lib/api': { isActiveStatus: (status) => status === 'running', api: { run: async (id, signal) => {
      assert.equal(id, 'A'); assert.equal(signal.aborted, false); requests++;
      if (requests < 3) throw new Error('Offline');
      return final;
    } } },
  });
  const initial = h.find('Activity');
  h.render({ snapshot: undefined }); await flush(); h.render();
  assert.equal(requests, 1);
  h.time(499); await flush(); assert.equal(requests, 1);
  h.time(1); await flush(); h.render(); assert.equal(requests, 2);
  h.time(1499); await flush(); assert.equal(requests, 2);
  h.time(1); await flush(); h.render(); assert.equal(requests, 3);
  assert.equal(h.find('Activity').type, initial.type);
  assert.equal(h.find('Activity').props.snapshot, final);
  assert.equal(h.find('ActivityIndicator'), undefined);
  assert.equal(h.timerCount, 0);
});

test('exhausted terminal recovery is visible and manually retryable without inventing a tool outcome or replacing the panel', async () => {
  const runningTool = { ...tool('t', 2), step: { ...tool('t', 2).step, status: 'running' } };
  const cached = snapshot({ seq: 4, steps: [runningTool.step], timeline: [runningTool] });
  const final = snapshot({ status: 'completed', seq: 8, output: 'Final answer', steps: [tool('t', 2).step], timeline: [tool('t', 2)] });
  let requests = 0;
  const h = harness('src/components/ChatMessages.tsx', 'AssistantBubble', { message: message(), snapshot: cached, onResume: async () => {}, onProcessReadingChange() {} }, {
    '../lib/api': { isActiveStatus: (status) => status === 'running', api: { run: async () => { if (++requests <= 3) throw new Error('Offline'); return final; } } },
  });
  const initial = h.find('Activity');
  h.render({ snapshot: undefined }); await flush();
  h.time(500); await flush(); h.time(1500); await flush(); h.render();
  assert.equal(requests, 3); assert.equal(h.timerCount, 0);
  assert.ok(h.all('AppText').some((node) => node.props.children === '处理记录暂时无法同步'));
  assert.equal(h.find('Activity').props.snapshot.timeline[0].step.status, 'running');
  assert.equal(cached.timeline[0].step.status, 'running');
  h.all('Pressable').find((node) => node.props.accessibilityLabel === '重试同步处理记录').props.onPress();
  h.render(); await flush(); h.render();
  assert.equal(requests, 4);
  assert.equal(h.find('Activity').type, initial.type);
  assert.equal(h.find('Activity').props.snapshot, final);
  assert.equal(h.all('Pressable').find((node) => node.props.accessibilityLabel === '重试同步处理记录'), undefined);
});

test('recovery requests time out, abort and stop after three attempts; unmount cancels a pending retry', async () => {
  const signals = [];
  const h = harness('src/components/ChatMessages.tsx', 'AssistantBubble', { message: message(), snapshot: snapshot(), onResume: async () => {}, onProcessReadingChange() {} }, {
    '../lib/api': { isActiveStatus: (status) => status === 'running', api: { run: (_id, signal) => { signals.push(signal); return new Promise(() => {}); } } },
  });
  h.render({ snapshot: undefined });
  for (const delay of [500, 1500, null]) {
    h.time(10000); await flush();
    assert.equal(signals.at(-1).aborted, true);
    if (delay !== null) { h.time(delay); await flush(); }
  }
  h.render(); assert.equal(signals.length, 3); assert.equal(h.timerCount, 0);
  assert.ok(h.all('Pressable').some((node) => node.props.accessibilityLabel === '重试同步处理记录'));
  h.all('Pressable').find((node) => node.props.accessibilityLabel === '重试同步处理记录').props.onPress();
  h.render(); h.time(10000); await flush();
  const attempts = signals.length;
  h.unmount(); h.time(20000); await flush();
  assert.equal(signals.length, attempts); assert.equal(h.timerCount, 0); assert.equal(h.lateWrites, 0);
});

test('foreign, stale and nonterminal recovery snapshots never overwrite current run; live replacement cancels recovery and ignores its late result', async () => {
  let resolve;
  const replies = [snapshot({ run_id: 'B', status: 'completed', seq: 8 }), snapshot({ status: 'completed', seq: 2 }), snapshot({ status: 'running', seq: 8 })];
  const signals = [];
  const h = harness('src/components/ChatMessages.tsx', 'AssistantBubble', { message: message(), snapshot: snapshot({ seq: 4 }), onResume: async () => {}, onProcessReadingChange() {} }, {
    '../lib/api': { isActiveStatus: (status) => status === 'running', api: { run: (_id, signal) => { signals.push(signal); return replies.length ? Promise.resolve(replies.shift()) : new Promise((done) => { resolve = done; }); } } },
  });
  h.render({ snapshot: undefined }); await flush(); h.time(500); await flush(); h.time(1500); await flush(); h.render();
  assert.equal(h.find('Activity').props.snapshot.run_id, 'A');
  assert.equal(h.find('Activity').props.snapshot.seq, 4);
  assert.ok(h.all('Pressable').some((node) => node.props.accessibilityLabel === '重试同步处理记录'));
  h.all('Pressable').find((node) => node.props.accessibilityLabel === '重试同步处理记录').props.onPress(); h.render();
  const current = snapshot({ seq: 9, output: 'New observed output' });
  h.render({ snapshot: current, message: message({ run_status: 'running' }) });
  assert.equal(signals.at(-1).aborted, true);
  resolve(snapshot({ status: 'completed', seq: 12, output: 'Stale recovery' })); await flush(); h.render();
  assert.equal(h.find('Activity').props.snapshot, current);
  assert.equal(h.find('ArtifactMarkdown').props.content, 'New observed output');
  assert.equal(h.timerCount, 0);
});

test('unopened measurement rows cannot clear another visible panel reading registration', () => {
  const changes = [];
  const onProcessReadingChange = (...args) => changes.push(args);
  const props = { message: message(), snapshot: snapshot({ status: 'completed' }), onResume: async () => {}, onProcessReadingChange };
  const visible = harness('src/components/ChatMessages.tsx', 'AssistantBubble', props);
  const measurement = harness('src/components/ChatMessages.tsx', 'AssistantBubble', props);
  visible.find('Activity').props.onReadingChange(true);
  visible.find('Activity').props.onReadingChange(true);
  measurement.unmount();
  assert.deepEqual(changes, [['A', true]]);
  visible.unmount();
  assert.deepEqual(changes, [['A', true], ['A', false]]);
});

test('historical process lazy-loading is still scoped: an unmounted row cannot commit late snapshot, error or loading state', async () => {
  let resolve;
  const h = harness('src/components/ChatMessages.tsx', 'AssistantBubble', { message: message(), onResume: async () => {}, onProcessReadingChange() {} }, {
    '../lib/api': { isActiveStatus: () => false, api: { run: () => new Promise((done) => { resolve = done; }) } },
  });
  h.find('Pressable').props.onPress(); h.render();
  assert.ok(h.find('ActivityIndicator'));
  h.unmount(); resolve(snapshot({ status: 'completed' }));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.lateWrites, 0);
});

test('tentative public output is delegated to the stable linear native text slot, never duplicated in the body', () => {
  const content = 'Checking the official sources';
  const pending = snapshot({ seq: 2, output: content, timeline: [{ id: 'p', seq: 1, kind: 'progress', text: content, pending: true }] });
  const h = harness('src/components/ChatMessages.tsx', 'AssistantBubble', {
    message: message({ run_status: 'running', content }), snapshot: pending, onResume: async () => {}, onProcessReadingChange() {},
  });
  assert.equal(h.find('ArtifactMarkdown'), undefined);
  assert.equal(h.find('Activity').props.snapshot, pending);
  h.render({ snapshot: { ...pending, seq: 3, timeline: [], output: 'Confirmed final answer' } });
  assert.equal(h.find('ArtifactMarkdown').props.content, 'Confirmed final answer');
});

test('persisted final answer survives a missed output commit and failed recovery without duplicating cached pending text', async () => {
  const confirmed = { id: 'earlier', seq: 1, kind: 'progress', text: 'Checking sources' };
  const pending = { id: 'pending', seq: 3, kind: 'progress', text: 'Final answer', pending: true };
  const cached = snapshot({ seq: 4, output: pending.text, timeline: [confirmed, tool('t', 2), pending], artifacts: [], created_at: '2026-10-16T00:00:00Z', updated_at: '2026-10-16T00:00:30Z' });
  const attachments = [{ id: 'final-file', name: 'report.pdf', mime_type: 'application/pdf', url: '/api/files/final-file/content' }];
  const h = harness('src/components/ChatMessages.tsx', 'AssistantBubble', {
    message: message({ run_status: 'running', content: '' }), snapshot: cached, onResume: async () => {}, onProcessReadingChange() {},
  });
  h.render({ snapshot: undefined, message: message({ attachments, run_created_at: cached.created_at, run_updated_at: '2026-10-16T00:01:07Z' }) });
  await flush(); h.time(500); await flush(); h.time(1500); await flush(); h.render();
  const recovered = h.find('Activity').props.snapshot;
  assert.equal(h.find('ArtifactMarkdown'), undefined);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.updated_at, '2026-10-16T00:01:07Z');
  assert.equal(h.find('ArtifactCards').props.files, attachments);
  assert.deepEqual(plain(recovered.timeline), plain([{ ...confirmed, pending: false, final: false }, tool('t', 2), { ...pending, pending: false, final: true }]));
  assert.equal(cached.timeline[2].pending, true, 'cached stream must stay immutable');
  assert.ok(h.all('AppText').some((node) => node.props.children === '处理记录暂时无法同步'));
});

test('failed run without a persisted final body preserves its genuine pending progress during terminal recovery', () => {
  const pending = { id: 'pending', seq: 1, kind: 'progress', text: 'Unfinished work', pending: true };
  const h = harness('src/components/ChatMessages.tsx', 'AssistantBubble', {
    message: message({ run_status: 'running', content: '' }), snapshot: snapshot({ timeline: [pending] }), onResume: async () => {}, onProcessReadingChange() {},
  });
  h.render({ snapshot: undefined, message: message({ run_status: 'failed', content: '' }) });
  assert.equal(h.find('ArtifactMarkdown'), undefined);
  assert.ok(h.all('ActionIcon').some((node) => node.props.label === '复制回复'), 'already public partial replies remain copyable');
  assert.equal(h.find('Activity').props.snapshot.status, 'failed');
  assert.deepEqual(plain(h.find('Activity').props.snapshot.timeline), plain([pending]));
  h.unmount();
});

test('cold terminal rows show persisted public replies and exact errors without opening the process inspector', async () => {
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    let fetches = 0;
    const copied = [];
    const intro = { id: 'intro', seq: 1, kind: 'progress', text: 'Checking the code' };
    const result = { id: 'result', seq: 4, kind: 'progress', text: 'The first task passed its tests.' };
    const error = status === 'cancelled' ? undefined : 'model returned an incomplete tool call';
    const terminal = snapshot({ status, output: '', timeline: [intro, tool('t', 2), { id: 'thought', seq: 3, kind: 'reasoning', reasoning: { id: 'thought', kind: 'reasoning', text: 'Not a public reply', done: true } }, result], error });
    const content = 'Checking the code\n\nThe first task passed its tests.';
    const h = harness('src/components/ChatMessages.tsx', 'AssistantBubble', {
      message: message({ run_status: status, content, run_error: error }), onResume: async () => {}, onProcessReadingChange() {},
    }, {
      '../lib/api': { isActiveStatus: () => false, api: { run: async () => { fetches++; return terminal; } } },
      'expo-clipboard': { setStringAsync: async (value) => { copied.push(value); } },
    });
    assert.equal(fetches, 0, 'opening history must not fetch every full run');
    assert.equal(h.find('ArtifactMarkdown').props.content, content);
    assert.ok(!error || h.all('ErrorNotice').some((node) => node.props.error === error));
    h.all('ActionIcon').find((node) => node.props.label === '复制回复').props.onPress();
    await flush(); h.render();
    h.find('Pressable').props.onPress();
    await flush(); h.render();
    assert.equal(fetches, 1);
    assert.equal(h.find('ArtifactMarkdown'), undefined, 'the snapshot owns the same public blocks after opening; the combined persisted body is not appended again');
    const activity = harness('src/components/Activity.tsx', 'Activity', { snapshot: h.find('Activity').props.snapshot });
    assert.deepEqual(activity.all('PublicText').map((node) => node.props.entry.text), [intro.text, result.text]);
    assert.ok(activity.all('PublicText').every((node) => !node.props.hidden));
    assert.ok(!error || activity.all('AppText').some((node) => node.props.children === error));
    h.all('ActionIcon').find((node) => node.props.label === '复制回复').props.onPress();
    await flush();
    assert.deepEqual(copied, [content, content], 'copy preserves every public reply before and after process expansion');
    activity.unmount(); h.unmount();
  }
});

test('terminal recovery shows every persisted partial reply during delayed and failed sync without replacing the candidate buffer', async () => {
  const first = { id: 'intro', seq: 1, kind: 'progress', text: 'Checking sources' };
  const candidate = { id: 'pending', seq: 3, kind: 'progress', text: 'Partial result', pending: true };
  const thought = { id: 'thought', seq: 4, kind: 'reasoning', reasoning: { id: 'thought', kind: 'reasoning', text: 'Private analysis', done: true } };
  const missed = { id: 'missed', seq: 5, kind: 'progress', text: 'Another result was saved.', pending: true };
  const content = `${first.text}\n\n${candidate.text}\n\n${missed.text}`;
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    let requests = 0, rejectFirst;
    const copied = [];
    const live = snapshot({ seq: 4, output: candidate.text, timeline: [first, tool('t', 2), candidate, thought] });
    const final = snapshot({ status, seq: 8, output: missed.text, timeline: [...live.timeline, missed], error: 'The run stopped' });
    const h = harness('src/components/ChatMessages.tsx', 'AssistantBubble', {
      message: message({ run_status: 'running', content: '' }), snapshot: live, onResume: async () => {}, onProcessReadingChange() {},
    }, {
      '../lib/api': { isActiveStatus: (status) => status === 'running', api: { run: () => {
        requests++;
        if (requests === 1) return new Promise((_resolve, reject) => { rejectFirst = reject; });
        return requests <= 3 ? Promise.reject(new Error('Offline')) : Promise.resolve(final);
      } } },
      'expo-clipboard': { setStringAsync: async (value) => { copied.push(value); } },
    });
    const initial = h.find('Activity');
    h.render({ snapshot: undefined, message: message({ run_status: status, content, run_error: 'The run stopped' }) });
    const checkPartial = () => {
      const display = h.find('Activity').props.snapshot;
      assert.equal(h.find('Activity').type, initial.type, 'the process panel remains mounted');
      assert.equal(display.status, status);
      assert.equal(display.output, candidate.text, 'the authoritative public body is never written into the candidate buffer');
      assert.equal(display.error, 'The run stopped');
      assert.deepEqual(plain(display.timeline), plain([tool('t', 2), thought]), 'only public display slots defer to the persisted projection');
      assert.deepEqual(h.all('ArtifactMarkdown').map((node) => node.props.content), [content], 'missed public replies are immediately visible exactly once');
      assert.deepEqual(plain(live.timeline), plain([first, tool('t', 2), candidate, thought]), 'cached stream history remains immutable');
      assert.equal(live.output, candidate.text);
    };
    checkPartial();
    h.time(50); await flush(); h.render(); checkPartial();
    assert.equal(requests, 1, 'the first recovery request is still pending');
    rejectFirst(new Error('Offline')); await flush(); h.render(); checkPartial();
    h.time(500); await flush(); h.render(); checkPartial();
    h.time(1500); await flush(); h.render(); checkPartial();
    assert.equal(requests, 3);
    assert.ok(h.all('AppText').some((node) => node.props.children === '处理记录暂时无法同步'));
    h.all('ActionIcon').find((node) => node.props.label === '复制回复').props.onPress();
    await flush();
    assert.deepEqual(copied, [content], 'copy includes the reply missed by the cached timeline');
    h.all('Pressable').find((node) => node.props.accessibilityLabel === '重试同步处理记录').props.onPress();
    h.render(); await flush(); h.render();
    assert.equal(requests, 4);
    assert.equal(h.find('Activity').props.snapshot, final);
    assert.equal(h.find('ArtifactMarkdown'), undefined, 'canonical timeline takes over without appending the combined body');
    const activity = harness('src/components/Activity.tsx', 'Activity', { snapshot: h.find('Activity').props.snapshot });
    assert.deepEqual(activity.all('PublicText').map((node) => node.props.entry.text), [first.text, candidate.text, missed.text]);
    assert.ok(activity.all('PublicText').every((node) => !node.props.hidden));
    assert.ok(activity.all('AppText').some((node) => node.props.children === 'The run stopped'));
    activity.unmount();
    h.unmount();
  }
});

test('already-terminal cached snapshots fill a missing display error from the message without fetching or changing public text', () => {
  const publicEntry = { id: 'public', seq: 1, kind: 'progress', text: 'The first task passed.', pending: true };
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    let requests = 0;
    const cached = snapshot({ status, seq: 8, error: '', output: publicEntry.text, timeline: [publicEntry, tool('t', 2)] });
    const h = harness('src/components/ChatMessages.tsx', 'AssistantBubble', {
      message: message({ run_status: status, content: publicEntry.text }), snapshot: cached, onResume: async () => {}, onProcessReadingChange() {},
    }, {
      '../lib/api': { isActiveStatus: (status) => status === 'running', api: { run: async () => { requests++; throw new Error('Unexpected run fetch'); } } },
    });
    assert.equal(h.find('Activity').props.snapshot, cached);
    h.render({ message: message({ run_status: status, content: publicEntry.text, run_error: 'Provider closed the response early' }) });
    const display = h.find('Activity').props.snapshot;
    assert.equal(display.error, 'Provider closed the response early');
    assert.equal(display.output, cached.output);
    assert.equal(display.timeline, cached.timeline);
    assert.equal(h.find('ArtifactMarkdown'), undefined, 'the public timeline still owns the body');
    assert.equal(cached.error, '', 'the cached snapshot is not mutated');
    assert.equal(requests, 0, 'an error does not trigger an unnecessary full history fetch');
    const activity = harness('src/components/Activity.tsx', 'Activity', { snapshot: display });
    assert.ok(activity.all('AppText').some((node) => node.props.children === 'Provider closed the response early'));
    assert.equal(activity.find('PublicText').props.entry.text, publicEntry.text);
    assert.equal(activity.find('PublicText').props.hidden, false);
    activity.unmount(); h.unmount();
  }
});

test('a terminal message overrides a stale supplied active stream and recovers without retaining waiting controls', async () => {
  for (const activeStatus of ['running', 'waiting_user']) for (const status of ['completed', 'failed', 'cancelled', 'interrupted']) {
    let requests = 0, resolve;
    const cached = snapshot({ status: activeStatus, seq: 4, output: 'Earlier draft', timeline: [tool('t', 2)],
      waiting_input: activeStatus === 'waiting_user' ? { question: 'Choose' } : undefined });
    const finalText = { id: 'reply', seq: 5, kind: 'progress', text: 'The authoritative reply', pending: status !== 'completed', final: status === 'completed' };
    const final = snapshot({ status, seq: 8, output: finalText.text, timeline: [...cached.timeline, finalText] });
    const h = harness('src/components/ChatMessages.tsx', 'AssistantBubble', {
      message: message({ run_status: activeStatus, content: '' }), snapshot: cached, onResume: async () => {}, onProcessReadingChange() {},
    }, {
      '../lib/api': { isActiveStatus: (status) => ['running', 'waiting_user'].includes(status), api: { run: () => { requests++; return new Promise((done) => { resolve = done; }); } } },
    });
    assert.equal(Boolean(h.find('WaitingCard')), activeStatus === 'waiting_user');
    h.render({ message: message({ run_status: status, content: finalText.text }) });
    assert.equal(requests, 1, 'an attached but stale SSE snapshot cannot suppress terminal recovery');
    const display = h.find('Activity').props.snapshot;
    assert.equal(display.status, status);
    assert.equal(display.output, status === 'completed' ? finalText.text : cached.output);
    assert.equal(h.find('ArtifactMarkdown').props.content, finalText.text);
    assert.equal(h.find('WaitingCard'), undefined, 'terminal status removes stale user-input controls immediately');
    assert.equal(cached.status, activeStatus);
    resolve(final); await flush(); h.render();
    assert.equal(h.find('Activity').props.snapshot, final, 'a newer recovered snapshot wins over the stale supplied stream');
    assert.equal(h.find('ArtifactMarkdown'), undefined);
    assert.equal(h.timerCount, 0);
    h.unmount();
  }
});

test('terminal states remain visible without process history or text and cold failures offer retry', () => {
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    const h = harness('src/components/ChatMessages.tsx', 'AssistantBubble', {
      message: message({ run_status: status, content: '', has_process: false, run_error: status === 'cancelled' ? undefined : 'Request failed' }),
      onResume: async () => {}, onRetry: async () => {}, onProcessReadingChange() {},
    });
    assert.ok(h.find('ProcessElapsed'), 'cold stopped rows retain a status header even without process entries');
    assert.equal(h.find('ArtifactMarkdown'), undefined);
    if (status !== 'cancelled') {
      assert.ok(h.all('ErrorNotice').some((node) => node.props.error === 'Request failed'));
      assert.ok(h.all('Pressable').some((node) => node.props.children?.props?.children === '重试'));
    }
    const activity = harness('src/components/Activity.tsx', 'Activity', { snapshot: snapshot({ status }) });
    assert.ok(activity.find('ActivityStatusText'), 'a loaded stopped run cannot appear blank');
    activity.unmount(); h.unmount();
  }
});

test('completed public progress is not folded away when no nonempty final answer exists', () => {
  const first = { id: 'intro', seq: 1, kind: 'progress', text: 'Checking sources' };
  const result = { id: 'result', seq: 3, kind: 'progress', text: 'The result is available.' };
  const whitespace = { id: 'empty', seq: 4, kind: 'progress', text: '\n ', pending: true, final: true };
  for (const output of ['', '\n ']) {
    const terminal = snapshot({ status: 'completed', output, timeline: [first, tool('t', 2), result, whitespace] });
    const activity = harness('src/components/Activity.tsx', 'Activity', { snapshot: terminal });
    assert.deepEqual(activity.all('PublicText').map((node) => node.props.entry.text), [first.text, result.text]);
    assert.ok(activity.all('PublicText').every((node) => !node.props.hidden));
    assert.equal(activity.find('Pressable').props.accessibilityRole, undefined, 'a fold with no final answer has no meaningful action');
    assert.equal(activity.all('Pressable').some((node) => node.props.accessibilityLabel === '查看答复'), false);
    const bubble = harness('src/components/ChatMessages.tsx', 'AssistantBubble', {
      message: message({ content: `${first.text}\n\n${result.text}` }), snapshot: terminal, onResume: async () => {}, onProcessReadingChange() {},
    });
    assert.equal(bubble.find('ArtifactMarkdown'), undefined, 'public timeline owns the fallback, not another combined body');
    assert.ok(bubble.all('ActionIcon').some((node) => node.props.label === '复制回复'));
    activity.unmount(); bubble.unmount();
  }
});

test('native task output uses the current confirmed body without pending duplicates or stale execution fallbacks', () => {
  let state = 0, current;
  const execution = { id: 'E', status: 'completed', output: 'Earlier stored output', started_at: '' };
  const module = load('src/screens/TasksScreen.tsx', {
    react: { useCallback: (fn) => fn, useEffect() {}, useRef: (value) => ({ current: value }), useState(initial) { const index = state++; return [index === 0 ? execution : index === 1 ? false : initial, () => {}]; } },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { View: 'View', ScrollView: 'ScrollView', StyleSheet: { create: (styles) => styles, hairlineWidth: 0.5 } },
    'lucide-react-native': new Proxy({}, { get: (_target, key) => String(key) }),
    'expo-router': { router: {} }, '../lib/api': { api: {}, isActiveStatus: (status) => status === 'running' },
    '../providers/AppProvider': { useApp: () => ({ colors: {} }) },
    '../hooks/useRunStream': { useRunStream: () => ({ snapshot: current }) },
    '../components/ScreenChrome': { screenStyles: {}, usePageContentStyle: () => ({}), AppText: 'AppText' },
    '../components/TaskEditor': {}, '../components/Activity': {}, '../components/ChatMessages': {},
    '../lib/processTimeline': process,
    '../components/Artifacts': { ArtifactCards: 'ArtifactCards' }, '../components/ArtifactMarkdown': { ArtifactMarkdown: 'ArtifactMarkdown' },
  });
  const render = (snapshot) => { state = 0; current = snapshot; return walk(module.TaskExecutionScreen({ taskId: 'T', executionId: 'E' })).find((node) => node.type === 'ArtifactMarkdown'); };
  const pending = snapshot({ output: 'Unconfirmed', timeline: [{ id: 'p', seq: 1, kind: 'progress', text: 'Unconfirmed', pending: true }] });
  assert.equal(render(pending), undefined);
  assert.equal(render({ ...pending, output: '', timeline: [] }), undefined);
  assert.equal(render({ ...pending, output: 'Confirmed', timeline: [] }).props.content, 'Confirmed');
  assert.equal(render(null).props.content, execution.output);
});

test('task transcript reading protects intermediate text and view-answer anchors the first final block rather than a long answer tail', async () => {
  let current = snapshot({ output: 'Final answer' });
  const execution = { id: 'E', status: 'running', output: '', started_at: '', snapshot: current };
  const h = harness('src/screens/TasksScreen.tsx', 'TaskExecutionScreen', { taskId: 'T', executionId: 'E' }, {
    'expo-router': { router: {} },
    '../lib/api': { api: { scheduleExecution: async () => execution }, isActiveStatus: (status) => status === 'running' },
    '../providers/AppProvider': { useApp: () => ({ colors: {} }) },
    '../hooks/useRunStream': { useRunStream: () => ({ snapshot: current, follow() {}, clear() {} }) },
    '../components/ScreenChrome': { screenStyles: {}, usePageContentStyle: () => ({}), AppText: 'AppText', ErrorNotice: 'ErrorNotice' },
    '../components/TaskEditor': {}, '../components/Activity': { Activity: 'Activity' }, '../components/ChatMessages': {},
    '../components/Artifacts': { ArtifactCards: 'ArtifactCards' }, '../components/ArtifactMarkdown': { ArtifactMarkdown: 'ArtifactMarkdown' },
  });
  await flush(); h.render();
  const scroll = h.find('ScrollView');
  const calls = [];
  scroll.props.ref.current = { scrollTo: (options) => calls.push(options) };
  h.deferState();
  const event = { nativeEvent: { layout: { height: 600 } } };
  scroll.props.onLayout(event);
  event.nativeEvent = null;
  h.flushState();
  scroll.props.onScrollBeginDrag(); h.render();
  h.flushState(); h.render();
  assert.equal(h.find('Activity').props.readingTranscript, true);
  assert.equal(h.find('Activity').props.availableHeight, 600);
  current = { ...current, status: 'completed' }; h.render();
  assert.equal(h.find('Activity').props.readingTranscript, true, 'completion does not clear the outer reading choice');
  const origin = h.all('View').find((node) => node.props.onLayout);
  origin.props.onLayout({ nativeEvent: { layout: { y: 42 } } });
  h.find('Activity').props.onViewAnswer(380);
  h.find('Activity').props.onViewAnswer(34);
  h.frame(); h.flushState(); h.render();
  assert.deepEqual(plain(calls), [{ y: 68, animated: true }], 'latest post-collapse answer layout wins within the frame');
  assert.equal(h.find('Activity').props.readingTranscript, false);
  h.find('ScrollView').props.onScroll(scrollEvent(0)); h.flushState(); h.render();
  assert.equal(h.find('Activity').props.readingTranscript, true);
  h.find('ScrollView').props.onScroll(scrollEvent(420)); h.flushState(); h.render();
  assert.equal(h.find('Activity').props.readingTranscript, false);
  h.unmount();
});

test('chat view-answer targets the final start inside the stable assistant row and blocks tail-follow for long final replies', () => {
  const h = harness('src/components/ChatMessages.tsx', 'ChatMessages', chatProps({ messages: [message()] }));
  const calls = [];
  h.find('FlashList').props.ref.current = { scrollToIndex: (options) => calls.push(options), scrollToEnd: () => calls.push('tail') };
  const list = h.find('FlashList').props;
  list.renderItem({ item: list.data[0] }).props.onViewAnswer(430);
  list.renderItem({ item: list.data[0] }).props.onViewAnswer(38);
  list.onContentSizeChange();
  h.frame();
  assert.deepEqual(plain(calls), [{ index: 0, viewPosition: 0, viewOffset: 34, animated: true }]);
  h.unmount();
});

test('final public native slots keep component type and key while completed history folds and opens separately', () => {
  const intro = { id: 'intro', seq: 1, kind: 'progress', text: 'Checking first', pending: true };
  const finalA = { id: 'answer-a', seq: 3, kind: 'progress', text: 'Actual ', pending: true };
  const finalB = { id: 'answer-b', seq: 4, kind: 'progress', text: 'answer', pending: true };
  const start = snapshot({ output: 'Actual answer', timeline: [intro, tool('t', 2), finalA, finalB] });
  const h = harness('src/components/Activity.tsx', 'Activity', { snapshot: start });
  const previous = h.all('PublicText');
  assert.equal(previous.length, 3);
  assert.ok(previous.every((node) => !node.props.hidden));
  h.render({ snapshot: { ...start, status: 'completed' } }); h.render();
  const after = h.all('PublicText');
  assert.equal(after[0].props.hidden, true);
  for (let index = 1; index < after.length; index++) {
    assert.equal(after[index].key, previous[index].key);
    assert.equal(after[index].type, previous[index].type);
    assert.equal(after[index].props.hidden, false);
    assert.equal(after[index].props.entry.final, true);
  }
  assert.equal(h.find('ProcessViewport'), undefined);
  h.find('Pressable').props.onPress(); h.render();
  const history = h.find('ProcessViewport');
  assert.ok(history);
  assert.equal(walk(history.props.children).filter((node) => node.props.row?.entry?.final).length, 0);
  assert.equal(h.all('PublicText')[2].key, previous[2].key);
});

test('manual process reading or outer transcript reading delays automatic folding until view-answer, and failed/cancelled keep all public text', () => {
  const timeline = [{ id: 'intro', seq: 1, kind: 'progress', text: 'Research' }, tool('t', 2), { id: 'answer', seq: 3, kind: 'progress', text: 'Answer' }];
  const initial = snapshot({ timeline, output: 'Answer' });
  for (const readingTranscript of [true, false]) {
    let views = 0;
    const h = harness('src/components/Activity.tsx', 'Activity', { snapshot: initial, readingTranscript, onViewAnswer() { views++; } });
    if (!readingTranscript) { h.find('DetailSection').props.onToggle(); h.render(); }
    h.render({ snapshot: { ...initial, status: 'completed' } }); h.render();
    assert.ok(h.all('PublicText').every((node) => !node.props.hidden));
    const view = h.all('Pressable').find((node) => node.props.accessibilityLabel === '查看答复');
    assert.ok(view);
    view.props.onPress(); h.render();
    assert.equal(h.all('PublicText')[0].props.hidden, true);
    assert.equal(h.all('PublicText')[1].props.hidden, false);
    assert.equal(views, 1);
  }
  for (const status of ['failed', 'cancelled', 'interrupted', 'waiting_user', 'waiting_resource']) {
    const h = harness('src/components/Activity.tsx', 'Activity', { snapshot: { ...initial, status } });
    assert.ok(h.all('PublicText').every((node) => !node.props.hidden), status);
    assert.ok(!h.all('OchiActivityMark').some((node) => node.props.working), status);
    assert.ok(!h.all('ActivityStatusText').some((node) => node.props.working), status);
  }
});

test('long reasoning uses measured native four-line clipping, retains full Markdown, and stays expanded as new tokens arrive', () => {
  const content = '**Plan**\n\n' + 'Full uncropped reasoning and $x^2$ math.\n\n'.repeat(30);
  const entry = { id: 'thought', seq: 1, kind: 'reasoning', reasoning: { id: 'thought', kind: 'reasoning', text: content, done: false } };
  const h = harness('src/components/Activity.tsx', 'ProcessText', { entry, active: true });
  const measure = h.all('View').find((node) => node.props.onLayout);
  h.deferState();
  const event = { nativeEvent: { layout: { height: 600 } } };
  measure.props.onLayout(event);
  event.nativeEvent = null;
  h.flushState(); h.render();
  assert.equal(h.find('Markdown').props.content, content);
  assert.ok(h.all('View').some((node) => node.props.style?.height === 88));
  assert.equal(measure.props.style.position, 'absolute', 'native intrinsic measurement must not inherit the preview cap');
  assert.equal(h.find('ActivityDisclosure').props.open, false);
  assert.equal(h.find('ScrollView'), undefined);
  h.find('Pressable').props.onPress(); h.render();
  assert.ok(h.all('View').some((node) => node.props.style?.height === 600));
  assert.equal(h.find('ActivityDisclosure').props.open, true);
  h.render({ entry: { ...entry, reasoning: { ...entry.reasoning, text: content + 'More text' } } });
  assert.equal(h.find('Pressable').props.accessibilityState.expanded, true);
  assert.equal(h.find('Markdown').props.content, content + 'More text');
});

test('a final-only reply has no empty process header or inspector, and older progress cannot swallow a different output', () => {
  const entry = { id: 'answer', seq: 1, kind: 'progress', text: 'Answer', final: true };
  const h = harness('src/components/Activity.tsx', 'Activity', { snapshot: snapshot({ status: 'completed', output: 'Answer', timeline: [entry] }) });
  assert.equal(h.find('Pressable'), undefined);
  assert.equal(h.find('ProcessViewport'), undefined);
  assert.equal(h.find('PublicText').props.hidden, false);
  const bubble = harness('src/components/ChatMessages.tsx', 'AssistantBubble', {
    message: message(), snapshot: snapshot({ status: 'completed', output: 'Final answer', timeline: [{ ...entry, text: 'Older progress', final: false }] }),
    onResume: async () => {}, onProcessReadingChange() {},
  });
  assert.equal(bubble.find('ArtifactMarkdown').props.content, 'Final answer');
});

test('Ochi face uses visible whole-surface movement and blinking, stops while waiting, and respects reduced motion; only the system label sweeps every eight seconds', async () => {
  const loops = [], interpolations = [];
  let reduceListener;
  class Value {
    constructor(value) { this.value = value; }
    setValue(value) { this.value = value; }
    interpolate(value) { interpolations.push(value); return value; }
  }
  const native = {
    View: 'View', StyleSheet: { create: (styles) => styles },
    AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener(_name, fn) { reduceListener = fn; return { remove() {} }; } },
    Easing: { inOut: (value) => value, cubic: 'cubic', quad: 'quad' },
    Animated: {
      Value, View: 'AnimatedView', Text: 'AnimatedText',
      timing: (value, config) => ({ value, ...config }), delay: (duration) => ({ duration }), sequence: (items) => items,
      multiply: (value, amount) => ({ value, amount }),
      loop(items) { const loop = { items, starts: 0, stops: 0, start() { this.starts++; }, stop() { this.stops++; } }; loops.push(loop); return loop; },
    },
  };
  const h = harness('src/components/OchiActivityMark.tsx', 'OchiActivityMark', { working: false }, { 'react-native': native });
  await flush(); h.render();
  assert.equal(loops.length, 0);
  h.render({ working: true });
  assert.equal(loops.length, 2);
  assert.ok(interpolations.some((value) => JSON.stringify(value.outputRange) === '["-12deg","0deg","12deg"]'));
  assert.ok(interpolations.some((value) => JSON.stringify(value.outputRange) === '[-2.5,0,2.5]'));
  assert.ok(loops[1].items.some((item) => item.toValue === 0.16));
  h.render({ working: false });
  assert.equal(loops[0].stops, 1);
  assert.equal(loops[1].stops, 1);
  reduceListener(true); h.render({ working: true });
  assert.equal(loops.length, 2);
  h.unmount();

  const label = harness('src/components/OchiActivityMark.tsx', 'ActivityStatusText', { working: true, children: '正在搜索' }, { 'react-native': native });
  await flush(); label.render();
  label.deferState();
  const event = { nativeEvent: { layout: { width: 64 } } };
  label.find('View').props.onLayout(event);
  event.nativeEvent = null;
  label.flushState(); label.render();
  assert.equal(loops.length, 3);
  assert.deepEqual(plain(loops[2].items.map((item) => item.duration)), [5800, 2200, 0]);
  label.render({ working: false });
  assert.equal(loops[2].stops, 1);
  assert.equal(label.find('AnimatedView'), undefined);
  label.unmount();
});
