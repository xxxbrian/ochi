const { testI18n } = require('./helpers/i18n.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const sharedLoad = require("../../shared/conversation/test-loader.cjs").createLoader(ts, require);
const sharedModule = (name) => name.includes("shared/conversation/") ? sharedLoad(path.resolve(__dirname, "../..", "shared/conversation", name.split("shared/conversation/")[1] + ".ts")) : undefined;

function load(file, imports = {}, tail = '', globals = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output + tail, {
    module, exports: module.exports, URL, ...globals,
    require(name) {
      if (sharedModule(name)) return sharedModule(name);
        const translated = testI18n.importFor(name); if (translated) return translated;
 if (name in imports) return imports[name]; throw new Error(`Unexpected import: ${name}`); },
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
