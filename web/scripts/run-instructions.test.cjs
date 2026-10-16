const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const item = (patch = {}) => ({ id: 'receipt-1', content: 'Preserve CSV', client_key: 'client-key-1', status: 'pending', run_status: 'running', created_at: '2026-10-14T00:00:00Z', ...patch });
const snapshot = (seq = 1) => ({ run_id: 'A', session_id: 'S', status: 'running', seq, output: '', steps: [], timeline: [], updated_at: '' });
function load(file, imports = {}, globals = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, AbortController, TextEncoder, Date, Math, Map, Set, Promise, JSON, Error, ...globals,
    require(name) { if (name in imports) return imports[name]; throw new Error(`Unexpected import: ${name}`); },
  }, { filename: file });
  return module.exports;
}
function clock() {
  let now = 0, id = 0;
  const timers = new Map();
  return {
    setTimeout(fn, delay) { const key = ++id; timers.set(key, { fn, due: now + delay }); return key; },
    clearTimeout(key) { timers.delete(key); },
    tick(delay) { now += delay; for (const [key, timer] of [...timers]) if (timer.due <= now) { timers.delete(key); timer.fn(); } },
    get size() { return timers.size; },
  };
}
function storeHarness(overrides = {}) {
  const time = clock(), reads = [], posts = [];
  const transport = {
    runInstructions: async (runId, signal) => { reads.push({ runId, signal }); return []; },
    supplementRun: async (runId, content, clientKey, signal) => { posts.push({ runId, content, clientKey, signal }); return item({ content, client_key: clientKey }); },
    ...overrides,
  };
  const domain = load('web/src/lib/runInstructions.ts', {}, { setTimeout: time.setTimeout, clearTimeout: time.clearTimeout });
  const store = domain.createRunInstructionsStore(transport);
  store.select('S:1', 'S', 'A', 'running'); store.setEnabled(true);
  return { domain, store, reads, posts, time };
}

test('only owned active running/waiting turns accept supplements, never queued/cancelling/terminal/New', async () => {
  for (const status of ['running', 'waiting_user', 'waiting_resource', 'queued', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted']) {
    const h = storeHarness(); await flush(); h.store.select('S:1', 'S', 'A', status); await flush();
    assert.equal(await h.store.send('S:1', 'Keep CSV'), ['running', 'waiting_user', 'waiting_resource'].includes(status));
    assert.equal(await h.store.send('foreign', 'Keep CSV'), false);
    h.store.select('New:2'); assert.equal(await h.store.send('New:2', 'Keep CSV'), false); h.store.dispose();
  }
});

test('actual POST receipt, not an optimistic ordinary bubble, establishes acceptance; concurrent sends coalesce safely', async () => {
  const post = deferred(); let calls = 0;
  const h = storeHarness({ supplementRun: (_run, content, key) => { calls++; post.content = content; post.key = key; return post.promise; } });
  await flush(); const sending = h.store.send('S:1', 'Preserve CSV');
  assert.equal(h.store.getSnapshot().items.length, 0);
  assert.equal(h.store.getSnapshot().submitting, true);
  assert.equal(await h.store.send('S:1', 'Another'), false); assert.equal(calls, 1);
  post.resolve(item({ client_key: post.key })); assert.equal(await sending, true);
  assert.equal(h.store.getSnapshot().accepted.content, 'Preserve CSV');
  assert.equal(h.store.getSnapshot().items[0].run_id, 'A'); h.store.dispose();
});

test('a lost response automatically retries with the identical client_key and exact content, not a queue request', async () => {
  const attempts = [];
  const h = storeHarness({ supplementRun: async (runId, content, key) => {
    attempts.push({ runId, content, key }); if (attempts.length === 1) throw new Error('Disconnected');
    return item({ content, client_key: key });
  } });
  assert.equal(await h.store.send('S:1', '  exact bytes  '), true);
  assert.deepEqual(attempts[0], attempts[1]); assert.equal(attempts[0].content, '  exact bytes  '); h.store.dispose();
});

test('two uncertain failures retain a manual retry under the old run/key even after cancellation or the next run', async () => {
  const attempts = []; let succeeding = false;
  const h = storeHarness({ supplementRun: async (runId, content, key) => {
    attempts.push({ runId, content, key }); if (!succeeding) throw new Error('Offline');
    return item({ content, client_key: key, status: 'not_applied', run_status: 'cancelled' });
  } });
  assert.equal(await h.store.send('S:1', 'Keep CSV'), false); assert.equal(attempts.length, 2);
  assert.equal(h.store.getSnapshot().retry, true);
  assert.equal(await h.store.send('S:1', 'Different'), false);
  h.store.select('S:1', 'S', 'B', 'running'); await flush(); succeeding = true;
  assert.equal(await h.store.retry(), true); assert.deepEqual(attempts[0], attempts[2]);
  assert.equal(h.store.getSnapshot().items[0].status, 'not_applied');
  assert.equal(h.store.getSnapshot().retry, false); h.store.dispose();
});

test('definitive terminal rejection does not retry or invent a queued message, and leaves draft acknowledgement absent', async () => {
  let requests = 0;
  const h = storeHarness({ supplementRun: async () => { requests++; throw Object.assign(new Error('Conflict'), { status: 409 }); } });
  assert.equal(await h.store.send('S:1', 'Keep CSV'), false); assert.equal(requests, 1);
  assert.equal(h.store.getSnapshot().items.length, 0); assert.equal(h.store.getSnapshot().accepted, undefined);
  assert.equal(h.store.getSnapshot().retry, false); h.store.dispose();
});

test('New and session changes discard late successful and failed POSTs without changing controls or errors', async () => {
  for (const failed of [false, true]) {
    const post = deferred();
    const h = storeHarness({ supplementRun: () => post.promise });
    const pending = h.store.send('S:1', 'Keep CSV'); await flush();
    h.store.select('New:2');
    if (failed) post.reject(new Error('Old failed')); else post.resolve(item());
    assert.equal(await pending, false); await flush();
    assert.deepEqual(plain(h.store.getSnapshot()), { owner: 'New:2', items: [], submitting: false, error: '', syncError: '', retry: false });
    h.store.dispose(); assert.equal(h.time.size, 0);
  }
});

test('a pre-POST GET cannot erase a newer accepted receipt, and a preterminal GET cannot revive a cancelled run', async () => {
  const read = deferred(); let requests = 0;
  const h = storeHarness({ runInstructions: () => { requests++; return requests === 1 ? read.promise : Promise.resolve([item({ status: 'not_applied', run_status: 'cancelled' })]); } });
  assert.equal(await h.store.send('S:1', 'Preserve CSV'), true);
  h.store.select('S:1', 'S', 'A', 'cancelled'); read.resolve([]); await flush();
  assert.equal(h.store.getSnapshot().items[0].status, 'not_applied');
  assert.equal(await h.store.send('S:1', 'Late'), false); h.store.dispose();
});

test('a stale GET containing the same pending ID cannot regress a newer POST acknowledgement from applied', async () => {
  const read = deferred(), statuses = []; let key, reads = 0;
  const h = storeHarness({
    runInstructions: () => { reads++; return reads === 1 ? read.promise : Promise.resolve([item({ client_key: key, status: 'applied' })]); },
    supplementRun: async (_run, content, clientKey) => { key = clientKey; return item({ content, client_key: key, status: 'applied', canonical_seq: 12 }); },
  });
  h.store.subscribe(() => { statuses.push(h.store.getSnapshot().items[0]?.status); });
  assert.equal(await h.store.send('S:1', 'Preserve CSV'), true);
  assert.equal(h.store.getSnapshot().items[0].status, 'applied');
  read.resolve([item({ client_key: key, status: 'pending' })]); await flush();
  assert.equal(h.store.getSnapshot().items[0].status, 'applied');
  assert.ok(!statuses.includes('pending')); h.store.dispose();
});

test('GET results and errors are scoped; foreign selection never hydrates previous receipts', async () => {
  for (const failed of [false, true]) {
    const read = deferred(); const h = storeHarness({ runInstructions: () => read.promise });
    h.store.select('B:2', 'B');
    if (failed) read.reject(new Error('Stale')); else read.resolve([item()]); await flush();
    assert.equal(h.store.getSnapshot().items.length, 0); assert.equal(h.store.getSnapshot().syncError, ''); h.store.dispose();
  }
});

test('statuses come from the server, retain cancelled unconsumed input as not_applied, and terminal polling stops', async () => {
  let values = [item()], reads = 0;
  const h = storeHarness({ runInstructions: async () => { reads++; return values; } }); await flush();
  assert.equal(h.store.getSnapshot().items[0].status, 'pending');
  values = [item({ status: 'applied', canonical_seq: 8 })]; h.time.tick(2000); await flush();
  assert.equal(h.store.getSnapshot().items[0].status, 'applied');
  values = [item({ status: 'not_applied', run_status: 'cancelled' })]; h.store.select('S:1', 'S', 'A', 'cancelled'); await flush();
  const finalReads = reads; h.time.tick(120000); await flush(); assert.equal(reads, finalReads);
  assert.deepEqual(['pending', 'applied', 'queued', 'not_applied'].map(h.domain.instructionStatusLabel), ['已接收', '已应用', '已排队', '未应用']); h.store.dispose();
});

test('refresh cadence is at most one flight, pauses in background, and invisible store disposes timers/requests', async () => {
  const h = storeHarness(); await flush(); const initial = h.reads.length;
  h.time.tick(1999); await flush(); assert.equal(h.reads.length, initial);
  h.time.tick(1); await flush(); assert.equal(h.reads.length, initial + 1);
  h.store.setEnabled(false); h.time.tick(120000); await flush(); assert.equal(h.reads.length, initial + 1);
  h.store.setEnabled(true); await flush(); assert.equal(h.reads.length, initial + 2);
  h.store.dispose(); assert.equal(h.time.size, 0);
});

test('POST deadlines abort two bounded attempts and retain an idempotent retry rather than hanging controls', async () => {
  const signals = [];
  const h = storeHarness({ supplementRun: (_run, _content, _key, signal) => { signals.push(signal); return new Promise(() => {}); } });
  const pending = h.store.send('S:1', 'Preserve CSV'); await flush();
  h.time.tick(8000); await flush(); assert.equal(signals[0].aborted, true);
  h.time.tick(8000); await flush(); assert.equal(await pending, false); assert.equal(signals.length, 2);
  assert.equal(h.store.getSnapshot().submitting, false); assert.equal(h.store.getSnapshot().retry, true); h.store.dispose();
});

test('server byte bounds are enforced without dropping a long draft or issuing a POST', async () => {
  const h = storeHarness(); assert.equal(await h.store.send('S:1', '字'.repeat(10667)), false);
  assert.equal(h.posts.length, 0); assert.equal(h.store.getSnapshot().error, '补充要求太长'); h.store.dispose();
});

test('a next-turn transition retains an in-flight old receipt until its actual terminal disposition is loaded', async () => {
  const post = deferred(); let accepted = false; const reads = [];
  const h = storeHarness({
    supplementRun: (_run, _content, key) => { post.key = key; return post.promise; },
    runInstructions: async (run) => { reads.push(run); return run === 'A' && accepted ? [item({ client_key: post.key, status: 'queued', run_status: 'completed' })] : []; },
  });
  await flush(); const pending = h.store.send('S:1', 'Preserve CSV'); await flush();
  h.store.select('S:1', 'S', 'B', 'running'); await flush();
  accepted = true; post.resolve(item({ client_key: post.key })); assert.equal(await pending, true); await flush();
  assert.equal(h.store.getSnapshot().items[0].run_id, 'A'); assert.equal(h.store.getSnapshot().items[0].status, 'queued');
  assert.ok(reads.includes('A') && reads.includes('B')); h.store.dispose();
});

test('an archived previous run cannot prevent the current run receipts from refreshing', async () => {
  let stage = 0;
  const h = storeHarness({ runInstructions: async (run) => {
    if (run === 'A' && stage > 0) throw Object.assign(new Error('Archived'), { status: 404 });
    return [item({ id: run, client_key: `${run}-key`, status: run === 'B' ? 'applied' : 'pending' })];
  } });
  await flush(); stage = 1; h.store.select('S:1', 'S', 'B', 'running'); await flush();
  assert.equal(h.store.getSnapshot().items.find((value) => value.id === 'B').status, 'applied');
  assert.equal(h.store.getSnapshot().syncError, '补充状态暂时无法同步'); h.store.dispose();
});

const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const walk = (node) => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object' && 'type' in node ? [node, ...walk(node.props.children)] : [];
function composerHarness(native, patch = {}) {
  const slots = [], effects = [], time = clock(), storage = new Map();
  let cursor = 0, dirty = false, tree, mounted = true, lateWrites = 0;
  const changes = (a, b) => !a || !b || a.length !== b.length || a.some((value, index) => value !== b[index]);
  const react = {
    memo: (component) => component,
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useState(initial) { const index = cursor++; slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, (next) => { if (!mounted) lateWrites++; slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; dirty = true; }]; },
    useEffect(effect, dependencies) { const index = cursor++, previous = slots[index]; if (changes(previous?.dependencies, dependencies)) effects.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: effect() }; }); },
  };
  react.useLayoutEffect = react.useEffect;
  const icons = new Proxy({}, { get: (_target, key) => key });
  const chrome = new Proxy({}, { get: (_target, key) => key });
  const imports = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': icons, 'lucide-react-native': icons,
    '../lib/api': { api: { upload: async () => ({ id: 'file', name: 'file', mime_type: 'text/plain', url: '/file', size: 1 }) } },
    './ui/Select': { SelectField: 'SelectField' }, './FileCards': { sizeText: String }, './BrandIcon': { BrandIcon: 'BrandIcon' }, './composer.css': {},
    '@base-ui/react/popover': { Popover: chrome },
    'react-native': { ...chrome, ...Object.fromEntries(['ActivityIndicator', 'Image', 'Pressable', 'ScrollView', 'Switch', 'Text', 'TextInput', 'View'].map((name) => [name, name])), Platform: { OS: 'ios' }, StyleSheet: { create: (value) => value, hairlineWidth: 0.5 }, useWindowDimensions: () => ({ width: 393, fontScale: 1 }) },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) },
    '../ui/overlayGeometry': load('mobile/src/ui/overlayGeometry.ts'),
    'expo-document-picker': { getDocumentAsync: async () => ({ canceled: false, assets: [{ uri: 'file:///qa.txt', name: 'qa.txt', mimeType: 'text/plain' }] }) }, 'expo-image-picker': {},
    'expo-secure-store': { getItemAsync: async (key) => storage.get(key), setItemAsync: async (key, value) => storage.set(key, value), deleteItemAsync: async (key) => storage.delete(key) },
    '../providers/AppProvider': { useTheme: () => ({ colors: { text: '#111', muted: '#777', border: '#ddd', canvas: '#fff', hover: '#eee' }, fonts: { regular: 'Geist' }, dark: false }) },
    '../ui/GlassSurface': { GlassSurface: 'GlassSurface' }, '../ui/AnchoredMenu': { AnchoredMenu: 'AnchoredMenu' }, '../ui/Sheet': { Sheet: 'Sheet' }, '../ui/MenuTrigger': { MenuTrigger: 'MenuTrigger' }, '../ui/IconButton': { IconButton: 'IconButton' },
    './ScreenChrome': chrome, './Artifacts': { ArtifactCards: 'ArtifactCards' }, './ModelIcon': { ModelIcon: 'ModelIcon' },
  };
  const module = load(`${native ? 'mobile' : 'web'}/src/components/Composer.tsx`, imports, {
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    window: { matchMedia: () => ({ matches: false }) }, sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
  });
  let props = { draftKey: 'S', models: [], modelId: '', effort: '', onModel() {}, onEffort() {}, computerEnabled: false, onComputer() {}, onError() {}, onStop() {}, onSubmit: async () => true, onSupplement: async () => true, busy: true, running: true, initialDraft: 'Preserve CSV', ...patch };
  function render(next = {}) { props = { ...props, ...next }; cursor = 0; dirty = false; tree = module.Composer(props); effects.splice(0).forEach((effect) => effect()); }
  function find(label) { return walk(tree).find((node) => (node.props.accessibilityLabel ?? node.props['aria-label'] ?? node.props.label) === label); }
  function input() { return walk(tree).find((node) => node.type === (native ? 'TextInput' : 'textarea')); }
  const settle = async () => { for (let index = 0; index < 24; index++) { await Promise.resolve(); if (dirty) render(); } };
  render();
  return { render, settle, find, input, get tree() { return tree; }, get lateWrites() { return lateWrites; },
    change(value) { if (native) input().props.onChangeText(value); else input().props.onChange({ target: { value } }); render(); },
    async press() { const button = find('补充当前任务要求'); (native ? button.props.onPress : button.props.onClick)(); await settle(); },
    async attach() {
      if (native) walk(tree).find((node) => node.type === 'MenuTrigger').props.items.find((entry) => entry.key === 'files').onPress();
      else walk(tree).find((node) => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files: [{ name: 'qa.txt' }] } });
      await settle();
    },
    async submit() {
      if (native) find('加入队列').props.onPress();
      else walk(tree).find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
      await settle();
    },
    unmount() { mounted = false; slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

for (const native of [false, true]) {
  const platform = native ? 'native' : 'web';
  test(`${platform} actual composer supplements the draft without ordinary send, remount or an input-focus cycle`, async () => {
    let calls = 0, ordinary = 0;
    const h = composerHarness(native, { onSupplement: async (content) => { calls++; assert.equal(content, 'Preserve CSV'); return true; }, onSubmit: async () => { ordinary++; return true; } });
    await h.settle(); const type = h.input().type; await h.press();
    assert.equal(calls, 1); assert.equal(ordinary, 0); assert.equal(h.input().type, type); assert.equal(h.input().props.value, '');
    h.unmount(); assert.equal(h.lateWrites, 0);
  });
  test(`${platform} late supplement success cannot clear a changed draft, and uncertain failure preserves it`, async () => {
    const post = deferred(); const h = composerHarness(native, { onSupplement: () => post.promise }); await h.settle();
    await h.press(); h.change('New draft'); post.resolve(true); await h.settle(); assert.equal(h.input().props.value, 'New draft');
    h.render({ onSupplement: async () => false }); await h.press(); assert.equal(h.input().props.value, 'New draft'); h.unmount();
  });
  test(`${platform} late callbacks after unmount do not mutate New or emit errors`, async () => {
    const post = deferred(); const h = composerHarness(native, { onSupplement: () => post.promise }); await h.settle(); await h.press();
    h.unmount(); post.resolve(true); await h.settle(); assert.equal(h.lateWrites, 0);
  });
  test(`${platform} receipt recovered by idempotent retry clears only its exact current draft; empty/busy states disable the action`, async () => {
    const h = composerHarness(native); await h.settle(); h.change(''); assert.equal(h.find('补充当前任务要求').props.disabled, true);
    h.change('Preserve CSV'); h.render({ supplementBusy: true }); assert.equal(h.find('补充当前任务要求').props.disabled, true);
    h.render({ supplementBusy: false, supplementAccepted: { id: 'real-receipt', content: 'Preserve CSV' } }); await h.settle(); assert.equal(h.input().props.value, '');
    h.unmount();
  });
  test(`${platform} attachments disable supplementary send without being dropped, while ordinary queue send retains them`, async () => {
    let supplements = 0, sent;
    const h = composerHarness(native, { onSupplement: async () => { supplements++; return true; }, onSubmit: async (...args) => { sent = args; return true; } });
    await h.settle(); await h.attach(); assert.equal(h.find('补充当前任务要求').props.disabled, true);
    await h.press(); assert.equal(supplements, 0); assert.equal(h.input().props.value, 'Preserve CSV');
    await h.submit(); assert.equal(native ? sent[0].files[0].id : sent[1][0].id, 'file'); h.unmount();
  });
}

test('native edit mode never exposes a supplement action and preserves the existing mounted TextInput', async () => {
  const h = composerHarness(true); await h.settle(); const type = h.input().type;
  h.render({ editingMessage: { id: 'message', content: 'Edit original', role: 'user' } }); await h.settle();
  assert.equal(h.find('补充当前任务要求'), undefined); assert.equal(h.input().type, type); assert.equal(h.input().props.value, 'Edit original'); h.unmount();
});

function hookHarness(native, transport = {}) {
  const slots = [], effects = [], time = clock(), listeners = new Map();
  let cursor = 0, value, dirty = false, reads = 0;
  const different = (left, right) => !left || !right || left.length !== right.length || left.some((dep, index) => dep !== right[index]);
  const react = {
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useEffect(effect, dependencies) { const index = cursor++, previous = slots[index]; if (different(previous?.dependencies, dependencies)) effects.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: effect() }; }); },
    useCallback(callback, dependencies) { const index = cursor++; if (different(slots[index]?.dependencies, dependencies)) slots[index] = { dependencies, callback }; return slots[index].callback; },
    useSyncExternalStore(subscribe, snapshot) { const index = cursor++; slots[index] ??= { cleanup: subscribe(() => { dirty = true; }) }; return snapshot(); },
  };
  react.useLayoutEffect = react.useEffect;
  const domain = load('web/src/lib/runInstructions.ts', {}, { setTimeout: time.setTimeout, clearTimeout: time.clearTimeout });
  const appState = { currentState: 'active', addEventListener(name, callback) { listeners.set(name, callback); return { remove() { listeners.delete(name); } }; } };
  const document = { visibilityState: 'visible', addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); } };
  const api = { runInstructions: async () => { reads++; return []; }, supplementRun: async (_run, content, key) => item({ content, client_key: key }), ...transport };
  const module = load(`${native ? 'mobile' : 'web'}/src/hooks/useRunInstructions.ts`, { react, '../lib/api': { api }, 'react-native': { AppState: appState }, '../lib/runInstructions': domain, '../../../web/src/lib/runInstructions': domain }, { document });
  let props = { owner: 'S:1', sessionId: 'S', snapshot: snapshot(), focused: true };
  const render = (changes = {}) => { props = { ...props, ...changes }; cursor = 0; dirty = false; value = module.useRunInstructions(props.owner, props.sessionId, props.snapshot, props.focused); effects.splice(0).forEach((effect) => effect()); };
  const settle = async () => { for (let index = 0; index < 24; index++) { await Promise.resolve(); if (dirty) render(); } };
  render();
  return { render, settle, time, get value() { return value; }, get reads() { return reads; },
    background() { if (native) { appState.currentState = 'background'; listeners.get('change')?.('background'); } else { document.visibilityState = 'hidden'; listeners.get('visibilitychange')?.(); } },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}
for (const native of [false, true]) {
  test(`${native ? 'native' : 'web'} actual hook does not restart instruction requests on hundreds of token renders; focus/background pauses polling`, async () => {
    const h = hookHarness(native); await h.settle(); const initial = h.reads, items = h.value.items;
    for (let seq = 2; seq < 302; seq++) h.render({ snapshot: snapshot(seq) });
    await h.settle(); assert.equal(h.reads, initial); assert.equal(h.value.items, items);
    h.background(); h.time.tick(120000); await h.settle(); assert.equal(h.reads, initial);
    h.render({ focused: false }); assert.equal(h.value.canSend, false); h.unmount(); assert.equal(h.time.size, 0);
  });
  test(`${native ? 'native' : 'web'} actual hook masks a foreign snapshot and invalidates a captured old send on New`, async () => {
    const post = deferred(); const h = hookHarness(native, { supplementRun: () => post.promise }); await h.settle();
    const oldSend = h.value.send; const pending = oldSend('Keep CSV'); await h.settle();
    h.render({ owner: 'New:2', sessionId: undefined, snapshot: snapshot(9) });
    assert.equal(h.value.canSend, false); assert.equal(h.value.submitting, false); assert.equal(h.value.items.length, 0);
    post.resolve(item()); assert.equal(await pending, false); await h.settle();
    assert.equal(await oldSend('Old callback'), false); assert.equal(h.value.accepted, undefined); h.unmount();
  });
}
