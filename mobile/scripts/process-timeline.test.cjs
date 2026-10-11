const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, imports = {}, tail = '', globals = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output + tail, {
    module, exports: module.exports, URL, ...globals,
    require(name) { if (name in imports) return imports[name]; throw new Error(`Unexpected import: ${name}`); },
  }, { filename: file });
  return module.exports;
}

const process = load('src/lib/processTimeline.ts');
const expoRequire = createRequire(fs.realpathSync(path.resolve(__dirname, '../node_modules/expo/package.json')));
const { URL: NativeURL } = expoRequire('whatwg-url-minimum');
const nativeProcess = load('src/lib/processTimeline.ts', {}, '', { URL: NativeURL });
const events = load('src/lib/runEvents.ts', { './processTimeline': process });
const snapshot = (patch = {}) => ({ run_id: 'A', session_id: 'S', seq: 0, status: 'running', output: '', steps: [], timeline: [], updated_at: '', ...patch });
const reasoning = (id, seq, text = 'Think') => ({ id, seq, kind: 'reasoning', reasoning: { id, kind: 'reasoning', text, done: false } });
const tool = (id, seq, name = 'exec', status = 'completed') => ({ id, seq, kind: 'tool', step: { id, name, status, arguments: { command: `echo ${id}` } } });
const progress = (id, seq, text = 'Checking sources') => ({ id, seq, kind: 'progress', text });
const plain = (value) => JSON.parse(JSON.stringify(value));

test('pending text and atomic commit retain the public entry identity without replay', () => {
  const pending = { ...progress('p1', 1, 'Checking'), pending: true };
  const frame = events.parseRunFrame(`event: text_delta\ndata: ${JSON.stringify({ type: 'text_delta', run_id: 'A', seq: 1, text: 'Checking', updated_at: '2026-10-16T10:00:01Z', timeline_entry: pending })}\n\n`);
  const working = events.applyRunEvent(snapshot(), frame);
  assert.equal(working.timeline[0].pending, true);
  assert.equal(working.updated_at, '2026-10-16T10:00:01Z');
  const commit = events.parseRunFrame(`event: output_commit\ndata: ${JSON.stringify({ type: 'output_commit', run_id: 'A', seq: 2, text: 'Checking', timeline: [{ ...pending, pending: false, final: true }], updated_at: '2026-10-16T10:00:02Z' })}\n\n`);
  const final = events.applyRunEvent(working, commit);
  assert.equal(final.output, 'Checking');
  assert.equal(final.timeline[0].id, pending.id);
  assert.equal(final.timeline[0].seq, pending.seq);
  assert.equal(final.timeline[0].final, true);
  assert.equal(final.updated_at, '2026-10-16T10:00:02Z');
});

test('interleaved commentary does not duplicate multiple final or provisional public blocks', () => {
  for (const status of ['running', 'completed', 'failed']) {
    for (const flag of ['pending', 'final']) {
      const first = { ...progress('a', 1, 'Part A. '), [flag]: true };
      const middle = progress('commentary', 2, 'Still checking.');
      const last = { ...progress('b', 3, 'Part B.'), [flag]: true };
      const state = snapshot({ status, output: 'Part A. Part B.', timeline: [first, middle, last] });
      assert.equal(process.unrepresentedOutput(state), '');
      const terminal = process.reconcileTerminalText(state, state.output);
      assert.deepEqual(Array.from(terminal.filter((entry) => entry.final), (entry) => entry.id), ['a', 'b']);
      assert.equal(terminal[1].final, false);
      assert.equal(terminal[1].text, middle.text);
    }
  }
});

test('late commentary changes only the matching pending entry and the answer buffer', () => {
  const pending = { ...progress('p1', 1, 'Sources'), pending: true }, after = reasoning('r1', 2);
  const frame = events.parseRunFrame(`event: progress\ndata: ${JSON.stringify({ type: 'progress', run_id: 'A', seq: 3, updated_at: '2026-10-16T10:00:03Z', text: 'Answer', timeline_entry: { ...pending, pending: false } })}\n\n`);
  const next = events.applyRunEvent(snapshot({ output: 'SourcesAnswer', timeline: [pending, after] }), frame);
  assert.equal(next.output, 'Answer');
  assert.equal(next.timeline[0].pending, false);
  assert.equal(next.timeline[0].seq, 1);
  assert.equal(next.timeline[1], after);
});

test('reasoning and tool upserts keep original chronology and untouched entry identities', () => {
  const first = reasoning('r1', 1), second = tool('t1', 2), third = reasoning('r2', 3);
  let state = snapshot({ timeline: [first, second, third], reasoning: [first.reasoning, third.reasoning] });
  state = events.applyRunEvent(state, { kind: 'reasoning_delta', value: { run_id: 'A', seq: 4, reasoning: { ...first.reasoning, text: ' more' }, timeline_entry: { ...first, reasoning: { ...first.reasoning, text: 'Think more' } } } });
  assert.deepEqual(Array.from(state.timeline, (entry) => entry.id), ['r1', 't1', 'r2']);
  assert.equal(state.timeline[0].reasoning.text, 'Think more');
  assert.equal(state.timeline[1], second);
  assert.equal(state.timeline[2], third);
  assert.equal(state.reasoning[0].text, 'Think more');
});

test('step completion updates its established slot rather than moving it below subsequent thought', () => {
  const first = tool('t1', 2, 'exec', 'running'), after = reasoning('r1', 3);
  const next = events.applyRunEvent(snapshot({ seq: 3, steps: [first.step], timeline: [first, after] }), {
    kind: 'step', value: { run_id: 'A', seq: 4, step: { ...first.step, status: 'completed', output: 'ok' }, timeline_entry: { ...first, seq: 4, step: { ...first.step, status: 'completed', output: 'ok' } } },
  });
  assert.equal(next.timeline[0].seq, 2);
  assert.equal(next.timeline[0].step.output, 'ok');
  assert.equal(next.timeline[1], after);
});

test('output reset promotes public progress at its first-output sequence, not at reset time', () => {
  const thought = reasoning('r1', 3), step = tool('t1', 5);
  const next = events.applyRunEvent(snapshot({ seq: 5, output: 'Checking sources', timeline: [thought, step] }), {
    kind: 'output_reset', value: { run_id: 'A', seq: 6, timeline: [progress('p1', 2), thought, step] },
  });
  assert.equal(next.output, '');
  assert.deepEqual(Array.from(next.timeline, (entry) => entry.kind), ['progress', 'reasoning', 'tool']);
  assert.equal(process.latestProgress(next), 'Checking sources');
  assert.equal(next.timeline[1], thought);
});

test('final output stays separate and terminal authoritative timeline repairs states without duplication', () => {
  const pending = tool('t1', 2, 'exec', 'running');
  const archived = progress('p1', 1, 'Searching');
  const next = events.applyRunEvent(snapshot({ seq: 3, output: 'Final answer', timeline: [archived, pending] }), {
    kind: 'status', value: { run_id: 'A', seq: 4, status: 'completed', timeline: [archived, { ...pending, step: { ...pending.step, status: 'completed' } }] },
  });
  assert.equal(next.output, 'Final answer');
  assert.equal(next.timeline.filter((entry) => entry.text === 'Final answer').length, 0);
  assert.equal(next.timeline[1].step.status, 'completed');
  assert.equal(next.timeline[0], archived);
});

test('text deltas retain the empty timeline and an authoritative reset clears process without reconstructing it', () => {
  const timeline = [];
  const next = events.applyRunEvent(snapshot({ timeline }), { kind: 'text_delta', value: { run_id: 'A', seq: 1, text: 'Hello' } });
  assert.equal(next.timeline, timeline);
  assert.equal(process.applyProcessEvent(timeline, { timeline: [] }), timeline);
  const thought = reasoning('r', 1), command = tool('t', 2);
  const reset = events.applyRunEvent(snapshot({ timeline: [thought, command], reasoning: [thought.reasoning], steps: [command.step] }), {
    kind: 'output_reset', value: { run_id: 'A', seq: 3, timeline: [] },
  });
  assert.equal(reset.reasoning.length, 1);
  assert.equal(reset.steps.length, 1);
  assert.deepEqual(plain(process.processRows(reset.timeline)), []);
});

test('current waiting payload pauses for input and running status clears it without losing Computer permission', () => {
  const input = { kind: 'question', question: 'Which file?', options: ['Report', 'Notes'] };
  const waiting = events.parseRunFrame(`event: waiting\ndata: ${JSON.stringify({ type: 'waiting', run_id: 'A', seq: 1, status: 'waiting_user', waiting_input: input })}`);
  const paused = events.applyRunEvent(snapshot({ computer_granted: true }), waiting);
  assert.equal(paused.status, 'waiting_user');
  assert.deepEqual(plain(paused.waiting_input), input);
  assert.equal(paused.computer_granted, true);
  const resumed = events.applyRunEvent(paused, { kind: 'status', value: { run_id: 'A', seq: 2, status: 'running', computer_granted: false } });
  assert.equal(resumed.waiting_input, undefined);
  assert.equal(resumed.computer_granted, false);
  assert.equal(events.applyRunEvent(resumed, { kind: 'status', value: { run_id: 'A', seq: 3, status: 'waiting_resource' } }).status, 'waiting_resource');
});

test('same repeated authoritative timeline preserves references, stale and foreign stream events are rejected', () => {
  const timeline = [reasoning('r', 1), tool('t', 2)];
  assert.equal(process.applyProcessEvent(timeline, { timeline: structuredClone(timeline) }), timeline);
  const state = snapshot({ seq: 3, timeline });
  assert.equal(events.applyRunEvent(state, { kind: 'text_delta', value: { run_id: 'A', seq: 3, text: 'duplicate' } }), state);
  assert.equal(events.applyRunEvent(state, { kind: 'output_reset', value: { run_id: 'B', seq: 4, timeline: [] } }), state);
});

test('a full timeline and its accompanying entry both apply, retaining stable chronology and final classification', () => {
  const first = progress('round-1:text', 1, 'Searching');
  const second = { ...progress('round-2:text', 4, 'Answer'), pending: true };
  const next = process.applyProcessEvent([first], { timeline: [first, tool('t', 2), second], timeline_entry: { ...second, seq: 10, pending: false, final: true } });
  assert.equal(next[0], first);
  assert.equal(next[2].seq, 4);
  assert.equal(next[2].final, true);
  assert.equal(next[2].pending, false);
  assert.equal(process.applyProcessEvent(next, { timeline: structuredClone(next) }), next);
});

test('linear segments retain public text between technical sequences and multiple final output items', () => {
  const entries = [progress('p1', 1), tool('s', 2, 'web_search'), reasoning('r', 3), progress('p2', 4), tool('c', 5),
    { ...progress('final-a', 6, 'First'), final: true }, { ...progress('final-b', 7, 'Second'), final: true }];
  const segments = process.timelineSegments(entries);
  assert.deepEqual(Array.from(segments, (segment) => [segment.kind, segment.id]), [
    ['text', 'p1'], ['details', 's'], ['text', 'p2'], ['details', 'c'], ['text', 'final-a'], ['text', 'final-b'],
  ]);
  const completed = snapshot({ status: 'completed', timeline: entries, output: 'FirstSecond' });
  assert.equal(process.unrepresentedOutput(completed), '');
  assert.equal(process.finalPublicEntries(completed).length, 2);
  assert.equal(process.hasProcessHistory(completed), true);
});

test('a distinct output remains visible even with older progress, and only complete public entries can represent it', () => {
  const earlier = progress('old', 1, 'Answer');
  const later = progress('later', 2, 'Different public text');
  assert.equal(process.unrepresentedOutput(snapshot({ output: 'Answer', timeline: [earlier, later] })), 'Answer');
  assert.equal(process.unrepresentedOutput(snapshot({ output: 'text', timeline: [later] })), 'text');
  assert.equal(process.unrepresentedOutput(snapshot({ output: 'Final', timeline: [earlier] })), 'Final');
  const pure = snapshot({ status: 'completed', output: 'Answer', timeline: [{ ...earlier, final: true }] });
  assert.equal(process.hasProcessHistory(pure), false);
});

test('terminal reconciliation preserves public IDs and never removes partial text or guesses by answer wording', () => {
  const entries = [progress('first', 1, 'Conclusion'), tool('t', 2), progress('last-a', 3, 'Actual '), progress('last-b', 4, 'answer')];
  const original = snapshot({ timeline: entries });
  const result = process.reconcileTerminalText(original, 'Actual answer');
  assert.deepEqual(Array.from(result, (entry) => entry.id), entries.map((entry) => entry.id));
  assert.deepEqual(Array.from(result.filter((entry) => entry.final), (entry) => entry.id), ['last-a', 'last-b']);
  assert.equal(original.timeline[0].final, undefined);
  assert.equal(process.reconcileTerminalText(original, 'Unknown answer'), entries);
});

test('reasoning structure stays model-neutral; only a fully title-only flattened summary gets presentation line breaks', () => {
  const fixtures = [
    ['GPT', '**准备说明 Rust 不能直接编译为 Go****我正准备 Rust 与 Go 的 FFI 示例****Checking cgo prerequisites**', '**准备说明 Rust 不能直接编译为 Go**\n\n**我正准备 Rust 与 Go 的 FFI 示例**\n\n**Checking cgo prerequisites**'],
    ['GPT whitespace', '**Checking sources** \r\n **Verifying code**', '**Checking sources**\n\n**Verifying code**'],
    ['Grok', '**Checking sources**\n\nThe result needs verification.', '**Checking sources**\n\nThe result needs verification.'],
    ['GLM', '先核对定义。\n\n再检查边界条件。', '先核对定义。\n\n再检查边界条件。'],
    ['Gemini', '**Plan**\n\n**Verify**', '**Plan**\n\n**Verify**'],
    ['DeepSeek', '推导 $x^2$，保留 `a****b` 代码与完整段落。', '推导 $x^2$，保留 `a****b` 代码与完整段落。'],
  ];
  for (const [vendor, input, expected] of fixtures) {
    assert.equal(process.formatReasoningText(input), expected, vendor);
    const rows = process.processRows([reasoning(`${vendor}-a`, 1, input), reasoning(`${vendor}-b`, 2, 'Next item')]);
    assert.equal(rows.length, 2, vendor);
    assert.equal(rows[0].entry.reasoning.text, input, 'presentation never changes stored reasoning');
    assert.equal(rows[1].entry.id, `${vendor}-b`);
  }
});

test('only adjacent matching tool families aggregate; reasoning/progress/failure/permission form hard boundaries', () => {
  const rows = process.processRows([
    tool('c1', 1), tool('c2', 2, 'exec', 'running'), reasoning('r', 3), tool('c3', 4),
    progress('p', 5), tool('c4', 6), tool('failed', 7, 'exec', 'failed'), tool('c5', 8),
    tool('permission', 9, 'request_computer_permission', 'running'), tool('c6', 10), tool('c7', 11),
  ]);
  assert.deepEqual(Array.from(rows, (row) => row.kind === 'tools' ? row.steps.map((step) => step.id).join(',') : row.entry.kind),
    ['c1,c2', 'reasoning', 'c3', 'progress', 'c4', 'failed', 'c5', 'permission', 'c6,c7']);
  assert.equal(rows[0].id, 'c1');
  assert.equal(rows[5].family, null);
  assert.equal(rows[7].family, null);
});

test('search queries and page reads stay distinct even when consecutive; no aggregation crosses tool family', () => {
  const rows = process.processRows([
    tool('s1', 1, 'web_search'), tool('s2', 2, 'web_search'), tool('f1', 3, 'web_fetch'), tool('f2', 4, 'web_fetch'),
    tool('b1', 5, 'browser_observe'), tool('b2', 6, 'browser_click'), tool('c1', 7, 'computer_click'),
  ]);
  assert.deepEqual(Array.from(rows, (row) => row.steps?.length), [1, 1, 1, 1, 2, 1]);
});

test('empty thinking entries still prevent unrelated tools from being joined across a semantic boundary', () => {
  assert.equal(process.processRows([tool('a', 1), reasoning('r', 2, ''), tool('b', 3)]).length, 3);
});

test('one search response yields validated deduplicated results and safe site icon URLs without API credentials', () => {
  const data = process.searchResults({ ...tool('s', 1, 'web_search').step, arguments: { query: 'Native glass' }, output: JSON.stringify({ results: [
    { title: 'Apple', url: 'https://developer.apple.com/a', description: 'Glass', published_at: '2026-10-01' },
    { title: 'Duplicate', url: 'https://developer.apple.com/a' },
    { title: 'Expo', url: 'https://docs.expo.dev/ui/' },
    { title: 'Invalid', url: 'javascript:alert(1)' },
    { title: 'Credentials', url: 'https://secret:password@example.com/' },
  ] }) });
  assert.equal(data.query, 'Native glass');
  assert.equal(data.results.length, 2);
  assert.equal(data.results[0].publishedAt, '2026-10-01');
  assert.equal(process.website(data.results[0].url).favicon, 'https://developer.apple.com/favicon.ico');
  assert.equal(process.searchResults(tool('s', 1, 'exec').step), null);
});

test('empty actual search is represented as empty; errors and arbitrary output are not fabricated as results', () => {
  const step = tool('s', 1, 'web_search').step;
  assert.equal(process.searchResults({ ...step, output: '{"error":"Not configured"}' }), null);
  assert.equal(process.searchResults({ ...step, output: 'Unexpected response' }), null);
  assert.equal(process.searchResults({ ...step, output: '{"query":"No match","results":[]}' }).results.length, 0);
});

test('search icons reject local/private literals, reserved hosts, browser-abbreviated IPs and credential URLs', () => {
  const blocked = [
    'https://localhost/', 'https://localhost./', 'https://a.localhost/',
    'https://printer.local/', 'https://printer.local./', 'https://service.internal/', 'https://example.test/',
    'https://127.0.0.1/', 'https://10.2.3.4/', 'https://172.16.0.1/', 'https://172.31.255.255/',
    'https://192.168.0.1/', 'https://169.254.1.1/', 'https://0.0.0.0/',
    'https://127.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://0177.0.0.1/',
    'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[fc00::1]/', 'https://[fe80::1]/',
    'https://secret:password@example.com/',
  ];
  for (const parser of [process, nativeProcess]) {
    for (const url of blocked) assert.equal(parser.website(url), null, url);
    const data = parser.searchResults({ ...tool('s', 1, 'web_search').step, output: JSON.stringify({ results: blocked.map((url) => ({ title: 'Blocked', url })) }) });
    assert.equal(data.results.length, 0);
  }
});

test('malformed hosts/ports and unsafe protocols cannot become native search links or favicon requests', () => {
  const blocked = [
    'https:///', 'https://single-label/', 'https://example..com/', 'https://-example.com/',
    'https://example-.com/', 'https://exa_mple.com/', 'https://.example.com/',
    `https://${'a'.repeat(64)}.example.com/`, 'https://exa mple.com/',
    'https://example.com:65536/', 'https://example.com:0/', 'https://example.com:bad/',
    'javascript:alert(1)', 'file:///private/a.png', 'data:image/png;base64,test',
  ];
  for (const parser of [process, nativeProcess]) {
    for (const url of blocked) assert.equal(parser.website(url), null, url);
    const step = tool('s', 1, 'web_search').step;
    const data = parser.searchResults({ ...step, output: JSON.stringify({ results: [...blocked.map((url) => ({ url })), { url: null }, { url: 12 }, {}] }) });
    assert.equal(data.results.length, 0);
  }
});

test('native search normalizes and deduplicates public URLs while preserving anonymous HTTPS-only site icons', () => {
  const step = { ...tool('s', 1, 'web_search').step, output: JSON.stringify({ query: 'Sources', results: [
    { url: ' HTTPS://WWW.EXAMPLE.COM:443/a ' }, { url: 'https://www.example.com/a' },
    { url: 'http://public.example.com:8080/b' }, { url: 'https://docs.expo.dev./ui/' },
    { url: 'https://8.8.8.8/' }, { url: 'https://172.32.0.1/' }, { url: 'https://xn--bcher-kva.de/' },
  ] }) };
  for (const parser of [process, nativeProcess]) {
    const data = parser.searchResults(step);
    assert.equal(data.results.length, 6);
    assert.equal(data.results[0].url, 'https://www.example.com/a');
    assert.equal(data.results[0].title, 'example.com');
    assert.deepEqual(plain(parser.website(data.results[0].url)), { host: 'example.com', favicon: 'https://www.example.com/favicon.ico' });
    assert.deepEqual(plain(parser.website(data.results[1].url)), { host: 'public.example.com' });
    assert.equal(parser.website(data.results[2].url).host, 'docs.expo.dev');
    assert.equal(data.results[5].url, 'https://xn--bcher-kva.de/');
  }
  // Expo's existing minimum URL parser omits IDNA conversion; unnormalized Unicode fails closed.
  assert.equal(nativeProcess.website('https://b\u00fccher.de/'), null);
  assert.equal(process.website('https://b\u00fccher.de/').host, 'xn--bcher-kva.de');
});

test('process viewport cap adapts to the real available transcript after composer/keyboard and near-bottom tolerance is bounded', () => {
  assert.equal(process.processPanelLimit(900), 280);
  assert.equal(process.processPanelLimit(240), 153);
  assert.equal(process.processPanelLimit(100), 64);
  assert.equal(process.processPanelLimit(50), 48);
  assert.equal(process.processNearBottom(300, 700, 280), false);
  assert.equal(process.processNearBottom(401, 700, 280), true);
});

test('native elapsed is an isolated clock that survives token updates and freezes at the server terminal time', () => {
  let now = Date.parse('2026-10-16T00:01:07Z'), state, dependencies, cleanup, tick, starts = 0, stops = 0;
  class Clock extends Date { static now() { return now; } }
  const hooks = {
    memo: (value) => value,
    useState(initial) { state ??= initial(); return [state, (next) => { state = next; }]; },
    useEffect(effect, next) {
      if (dependencies?.every((value, index) => value === next[index])) return;
      cleanup?.(); cleanup = effect(); dependencies = next;
    },
  };
  const { ProcessElapsed } = load('src/components/ProcessElapsed.tsx', {
    react: hooks,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '../../../web/src/lib/processTiming': load('../web/src/lib/processTiming.ts'),
    './ScreenChrome': { AppText: 'AppText' },
  }, '', {
    Date: Clock,
    setInterval(callback, delay) { assert.equal(delay, 1000); tick = callback; return ++starts; },
    clearInterval() { tick = undefined; stops++; },
  });
  const props = { createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:01:07Z', active: true };
  assert.equal(ProcessElapsed(props).props.accessibilityLabel, '用时 1 分 07 秒');
  now += 2000; tick();
  assert.equal(ProcessElapsed({ ...props, updatedAt: '2026-10-16T00:01:09Z' }).props.accessibilityLabel, '用时 1 分 09 秒');
  assert.equal(starts, 1);
  assert.equal(ProcessElapsed({ ...props, active: false }).props.accessibilityLabel, '用时 1 分 07 秒');
  assert.equal(stops, 1);
  assert.equal(tick, undefined);
});

const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const walk = (node) => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object' && 'type' in node ? [node, ...walk(node.props.children)] : [];
function harness(name, initialProps) {
  const slots = [], frames = new Map(), calls = [];
  let cursor = 0, frameID = 0, tree, props = initialProps;
  const hooks = {
    memo: (value) => value,
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useState(initial) { const index = cursor++; slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, (next) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }]; },
    useEffect() { cursor++; },
    useMemo(fn) { cursor++; return fn(); },
    useCallback(fn) { cursor++; return fn; },
  };
  const imports = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { ...Object.fromEntries(['View', 'Pressable', 'ScrollView', 'ActivityIndicator'].map((name) => [name, name])), StyleSheet: { create: (styles) => styles, hairlineWidth: 0.5 }, useWindowDimensions: () => ({ fontScale: 1 }), LayoutAnimation: { configureNext() {} } },
    'lucide-react-native': new Proxy({}, { get: (_target, name) => name }),
    '../lib/api': { isActiveStatus: (status) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(status) },
    '../lib/processTimeline': process,
    '../providers/AppProvider': { useTheme: () => ({ colors: { muted: '#777', border: '#ccc', text: '#111', raised: '#fff' } }) },
    './ScreenChrome': { AppText: 'AppText' }, './Markdown': { Markdown: 'Markdown' }, './ActivityStep': { StepRow: 'StepRow' },
    './ProcessElapsed': { ProcessElapsed: 'ProcessElapsed' },
    './ArtifactMarkdown': { ArtifactMarkdown: 'ArtifactMarkdown' },
    './OchiActivityMark': { ActivityStatusText: 'ActivityStatusText', OchiActivityMark: 'OchiActivityMark', useReducedMotion: () => false },
  };
  const module = load('src/components/Activity.tsx', imports, '\nexports.ProcessViewport = ProcessViewport;', {
    requestAnimationFrame(fn) { const id = ++frameID; frames.set(id, fn); return id; }, cancelAnimationFrame(id) { frames.delete(id); },
  });
  const component = module[name];
  const render = (changes = {}) => { props = { ...props, ...changes }; cursor = 0; tree = component(props); };
  render();
  return {
    get tree() { return tree; }, render,
    find(type) { return walk(tree).find((node) => node.type === type || node.type?.name === type); },
    frame() { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } },
    bindScroll() { this.find('ScrollView').props.ref.current = { scrollToEnd: (options) => calls.push(options) }; }, calls,
  };
}

test('native process uses a natural capped nested scroll with stable anchors and only follows the bottom, never a reader above it', () => {
  const h = harness('ProcessViewport', { maxHeight: 280, children: null });
  h.bindScroll();
  const scroll = h.find('ScrollView').props;
  assert.equal(scroll.style.maxHeight, 280);
  assert.equal(scroll.style.height, undefined);
  assert.equal(scroll.nestedScrollEnabled, true);
  assert.equal(scroll.keyboardDismissMode, 'none');
  assert.equal(scroll.keyboardShouldPersistTaps, 'always');
  assert.deepEqual(plain(scroll.maintainVisibleContentPosition), { minIndexForVisible: 0 });
  scroll.onLayout({ nativeEvent: { layout: { height: 280 } } });
  scroll.onContentSizeChange(300, 600); h.frame();
  assert.equal(h.calls.length, 1);
  scroll.onScrollBeginDrag();
  const position = { nativeEvent: { contentOffset: { y: 100 }, contentSize: { height: 600 }, layoutMeasurement: { height: 280 } } };
  scroll.onScroll(position); scroll.onScrollEndDrag(position);
  scroll.onContentSizeChange(300, 750); h.frame();
  assert.equal(h.calls.length, 1);
  h.render();
  assert.equal(h.find('Pressable').props.accessibilityLabel, '最新进展');
  h.find('Pressable').props.onPress();
  scroll.onContentSizeChange(300, 800); h.frame();
  assert.equal(h.calls.length, 3);
});

test('public text stays at its stable linear slot and explicit opened details remain open on completion', () => {
  const initial = snapshot({ timeline: [progress('p', 1, 'Checking'), reasoning('r', 2)], reasoning: [reasoning('r', 2).reasoning] });
  const h = harness('Activity', { snapshot: initial });
  const initialText = h.find('PublicText');
  assert.equal(initialText.props.entry.text, 'Checking');
  assert.equal(initialText.props.hidden, false);
  h.find('DetailSection').props.onToggle(); h.render();
  assert.equal(h.find('DetailSection').props.open, true);
  h.render({ snapshot: { ...initial, status: 'completed', output: 'Final' } });
  assert.equal(h.find('PublicText').key, initialText.key);
  assert.equal(h.find('PublicText').props.hidden, false);
  assert.equal(h.find('DetailSection').props.open, true);
});
