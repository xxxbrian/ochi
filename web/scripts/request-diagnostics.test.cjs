const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const sourceFile = (file) => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const walk = (node) => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object' && 'type' in node ? [node, ...walk(node.props.children)] : [];
const text = (node) => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' && 'type' in node ? text(node.props.children) : node == null || typeof node === 'boolean' ? '' : String(node);

function evaluate(source, imports = {}, globals = {}, filename = 'fixture.tsx') {
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, AbortController, Date, Error, JSON, Map, Promise, Set, ...globals,
    require(name) { if (name in imports) return imports[name]; throw new Error(`Unexpected import: ${name}`); },
  }, { filename });
  return module.exports;
}

function hookHarness(file, name, imports, globals = {}, initialProps = {}, tail = '') {
  const slots = [], effects = [];
  let cursor = 0, dirty = false, tree, props = initialProps;
  const different = (left, right) => !left || !right || left.length !== right.length || left.some((value, index) => !Object.is(value, right[index]));
  const memo = (callback, dependencies) => {
    const index = cursor++;
    if (different(slots[index]?.dependencies, dependencies)) slots[index] = { dependencies, value: callback() };
    return slots[index].value;
  };
  const react = {
    lazy: () => 'LazyContent', Suspense: 'Suspense',
    useId() { const index = cursor++; slots[index] ??= { value: `test-${index}` }; return slots[index].value; },
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (next) => {
        const value = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(slots[index].value, value)) { slots[index].value = value; dirty = true; }
      }];
    },
    useEffect(effect, dependencies) {
      const index = cursor++, previous = slots[index];
      if (different(previous?.dependencies, dependencies)) effects.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: effect() }; });
    },
    useCallback: (callback, dependencies) => memo(() => callback, dependencies), useMemo: memo,
  };
  react.useLayoutEffect = react.useEffect;
  const module = evaluate(read(file) + tail, { react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'lucide-react': new Proxy({}, { get: (_target, key) => String(key) }), ...imports }, globals, file);
  const render = (next = {}) => {
    props = { ...props, ...next }; cursor = 0; dirty = false;
    tree = module[name](props);
    effects.splice(0).forEach((effect) => effect());
    return tree;
  };
  const settle = async () => { for (let index = 0; index < 32; index++) { await Promise.resolve(); if (dirty) render(); } };
  render();
  return { render, settle, get tree() { return tree; }, nodes: () => walk(tree), unmount: () => slots.forEach((slot) => slot?.cleanup?.()) };
}

test('admin diagnostics transport scopes list/detail/clear routes and forwards abort signals', async () => {
  const source = sourceFile('src/lib/api.ts');
  const declaration = source.statements.flatMap((node) => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []).find((node) => node.name.getText(source) === 'adminApi');
  assert.ok(declaration && ts.isObjectLiteralExpression(declaration.initializer));
  const names = ['providerRequests', 'providerRequest', 'clearProviderRequests'];
  const methods = declaration.initializer.properties.filter((node) => names.includes(node.name?.getText(source)));
  assert.equal(methods.length, names.length);
  const helper = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'providerRequestsPath');
  assert.ok(helper, 'diagnostic routes share one run/global path owner');
  const calls = [];
  const { api } = evaluate(`${helper.getText(source)}\nexports.api = {${methods.map((node) => node.getText(source)).join(',\n')}};`, {}, {
    request: async (url, init) => { const value = { url, init }; calls.push(value); return value; },
  });
  const signal = new AbortController().signal;
  await api.providerRequests(undefined, 0, signal);
  await api.providerRequests('run/a ?#', 60, signal);
  await api.providerRequest(undefined, 'trace/a ?#', signal);
  await api.providerRequest('run/a ?#', 'trace/a ?#', signal);
  await api.clearProviderRequests(undefined, signal);
  await api.clearProviderRequests('run/a ?#', signal);
  assert.deepEqual(calls.map((call) => call.url), [
    '/api/admin/requests?limit=30&offset=0',
    '/api/admin/runs/run%2Fa%20%3F%23/requests?limit=30&offset=60',
    '/api/admin/requests/trace%2Fa%20%3F%23',
    '/api/admin/runs/run%2Fa%20%3F%23/requests/trace%2Fa%20%3F%23',
    '/api/admin/requests',
    '/api/admin/runs/run%2Fa%20%3F%23/requests',
  ]);
  assert.ok(calls.every((call) => call.init.signal === signal));
  assert.deepEqual(calls.map((call) => call.init.method), [undefined, undefined, undefined, undefined, 'DELETE', 'DELETE']);
  assert.ok(calls.every((call) => call.init.body === undefined));
});

test('diagnostic summaries remain payload-free while detail preserves raw bodies, headers and ordered SSE timing', () => {
  const filename = path.join(root, 'src/lib/types.ts');
  const program = ts.createProgram([filename], { noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022 });
  const source = program.getSourceFile(filename), checker = program.getTypeChecker();
  const alias = (name) => {
    const node = source.statements.find((entry) => ts.isTypeAliasDeclaration(entry) && entry.name.text === name);
    assert.ok(node, `${name} exists`);
    return checker.getTypeAtLocation(node);
  };
  const summary = alias('ProviderRequestSummary'), detail = alias('ProviderRequestDetail'), page = alias('ProviderRequestPage');
  const keys = (type) => checker.getPropertiesOfType(type).map((property) => property.name);
  for (const name of ['id', 'run_id', 'session_id', 'round', 'attempt', 'purpose', 'provider_id', 'model_id', 'model', 'protocol', 'method', 'url', 'stream', 'status_code', 'request_id', 'started_at', 'finished_at', 'duration_ms', 'ttfb_ms', 'ttft_ms', 'finish_reason', 'response_status', 'saw_done', 'saw_completed', 'saw_eof', 'usage', 'error_class', 'error', 'read_error', 'upstream_error_code', 'upstream_error_type', 'upstream_error', 'request_bytes', 'response_bytes', 'captured_bytes', 'request_truncated', 'response_truncated', 'truncated', 'redacted']) {
    assert.ok(keys(summary).includes(name), `summary exposes ${name}`);
    assert.ok(keys(detail).includes(name), `detail retains ${name}`);
  }
  for (const name of ['request_headers', 'request_body', 'response_headers', 'response_body', 'stream_chunks']) {
    assert.ok(!keys(summary).includes(name), `${name} must not make list pages heavy`);
    assert.ok(keys(detail).includes(name), `detail exposes ${name}`);
  }
  const propertyType = (type, name) => checker.getTypeOfSymbolAtLocation(checker.getPropertyOfType(type, name), source);
  assert.equal(checker.getIndexTypeOfType(propertyType(page, 'items'), ts.IndexKind.Number), summary);
  for (const name of ['total', 'limit', 'offset', 'retention_days', 'max_requests_per_run']) assert.ok(keys(page).includes(name), `page exposes ${name}`);
  const chunk = checker.getIndexTypeOfType(propertyType(detail, 'stream_chunks'), ts.IndexKind.Number);
  assert.ok(chunk, 'stream_chunks is an array');
  assert.deepEqual(keys(chunk), ['sequence', 'at_ms', 'data']);
  assert.equal(checker.typeToString(propertyType(chunk, 'sequence')), 'number');
  assert.equal(checker.typeToString(propertyType(chunk, 'at_ms')), 'number');
  assert.equal(checker.typeToString(propertyType(chunk, 'data')), 'string');
});

const summary = (id = 'trace-A') => ({
  id, run_id: 'R', model: id, purpose: 'chat', protocol: 'responses', attempt: 1,
  method: 'POST', url: 'https://models.invalid/v1/responses', stream: true, status_code: 200,
  started_at: '2026-10-18T00:00:00Z', finished_at: '2026-10-18T00:00:01Z', duration_ms: 1000,
  request_bytes: 200, response_bytes: 400, captured_bytes: 400, saw_done: false, saw_completed: true, saw_eof: true,
  request_truncated: false, response_truncated: false, truncated: false, redacted: true,
});
const detail = (id = 'trace-A') => ({
  ...summary(id), request_headers: { Authorization: ['[REDACTED]'] }, request_body: '  {"input":"REQUEST_RAW_MARKER"}\n',
  response_headers: { 'Content-Type': ['text/event-stream'] }, response_body: 'data: {"output":"RESPONSE_RAW_MARKER"}\n\n',
  stream_chunks: [{ sequence: 1, at_ms: 24, data: ': keepalive' }, { sequence: 2, at_ms: 46, data: 'data: {"delta":"RAW_SSE_MARKER"}' }, { sequence: 3, at_ms: 46, data: '' }],
});
const requestPage = (offset = 0, total = 2) => ({ items: [summary(), summary('trace-B')], total, limit: 30, offset, retention_days: 7, max_requests_per_run: 256 });
const diagnosticImports = (adminApi = {}) => ({ '../../lib/api': { adminApi }, '../../components/Modal': { Modal: 'Modal' }, './Fields': { ErrorNotice: 'ErrorNotice' } });
const expanded = (h) => h.nodes().filter((node) => node.type === 'button' && Object.hasOwn(node.props, 'aria-expanded'));

function diagnosticsHarness(transport = {}, props = { runID: 'R' }) {
  const lists = [], details = [], clears = [];
  const api = {
    providerRequests: (runID, offset, signal) => { lists.push({ runID, offset, signal }); return transport.list ? transport.list(runID, offset, signal) : Promise.resolve(requestPage(offset)); },
    providerRequest: (runID, id, signal) => { details.push({ runID, id, signal }); return transport.detail ? transport.detail(runID, id, signal) : Promise.resolve(detail(id)); },
    clearProviderRequests: async (runID) => { clears.push(runID); return transport.clear?.(runID); },
  };
  return Object.assign(hookHarness('src/pages/admin/RequestDiagnostics.tsx', 'RequestDiagnostics', diagnosticImports(api), {}, props), { lists, details, clears });
}

test('request lists fetch summaries only and expansion loads one detail with stale requests aborted', async () => {
  const first = deferred(), second = deferred();
  const h = diagnosticsHarness({ detail: (_run, id) => id === 'trace-A' ? first.promise : second.promise });
  await h.settle();
  for (let index = 0; index < 25; index++) h.render();
  assert.equal(h.lists.length, 1);
  assert.equal(h.details.length, 0, 'closed rows must not fetch raw bodies or SSE');
  assert.equal(expanded(h).length, 2);
  expanded(h)[0].props.onClick(); h.render(); await h.settle();
  assert.equal(h.details.length, 1);
  assert.equal(h.details[0].runID, 'R');
  assert.equal(h.details[0].id, 'trace-A');
  expanded(h)[1].props.onClick(); h.render(); await h.settle();
  assert.equal(h.details[0].signal.aborted, true);
  assert.equal(h.details.length, 2);
  assert.equal(expanded(h).filter((node) => node.props['aria-expanded']).length, 1);
  first.resolve(detail()); await h.settle();
  assert.equal(h.nodes().filter((node) => node.type?.name === 'RequestDetail').length, 0, 'a late first-row response cannot populate the newly selected row');
  second.resolve(detail('trace-B')); await h.settle();
  assert.equal(h.nodes().find((node) => node.type?.name === 'RequestDetail').props.item.id, 'trace-B');
  expanded(h)[1].props.onClick(); h.render(); await h.settle();
  assert.equal(h.details[1].signal.aborted, true);
  assert.equal(h.nodes().filter((node) => node.type?.name === 'RequestDetail').length, 0);
  h.unmount();
});

test('detail tabs mount only the selected payload and JSON copy preserves original body and SSE bytes', async () => {
  const item = detail(), copied = [];
  const h = hookHarness('src/pages/admin/RequestDiagnostics.tsx', 'TestRequestDetail', diagnosticImports(), { navigator: { clipboard: { writeText: async (value) => copied.push(value) } } }, { item }, '\nexports.TestRequestDetail = RequestDetail;');
  const tabs = () => h.nodes().filter((node) => node.props.role === 'tab');
  assert.equal(tabs().length, 4);
  assert.equal(tabs()[0].props['aria-selected'], true);
  assert.ok(h.nodes().some((node) => node.type?.name === 'RequestFacts'));
  assert.ok(!h.nodes().some((node) => node.type?.name === 'RequestPayload'));
  assert.doesNotMatch(text(h.tree), /REQUEST_RAW_MARKER|RESPONSE_RAW_MARKER|RAW_SSE_MARKER/);
  tabs()[1].props.onClick(); h.render();
  assert.equal(h.nodes().find((node) => node.type?.name === 'RequestPayload').props.body, item.request_body);
  tabs()[2].props.onClick(); h.render();
  assert.equal(h.nodes().find((node) => node.type?.name === 'RequestPayload').props.body, item.response_body);
  tabs()[3].props.onClick(); h.render();
  assert.deepEqual(h.nodes().filter((node) => node.type === 'pre').map((node) => node.props.children), item.stream_chunks.map((chunk) => chunk.data));
  assert.match(text(h.tree), /#1.*24 ms.*#2.*46 ms.*#3.*46 ms/);
  h.nodes().find((node) => node.type === 'button' && text(node).includes('JSON')).props.onClick();
  await h.settle();
  assert.equal(copied.length, 1);
  assert.deepEqual(JSON.parse(copied[0]), item);
  h.unmount();
});

test('global request pagination stays scoped and clear waits for explicit confirmation before reloading page one', async () => {
  let cleared = false;
  const h = diagnosticsHarness({ list: (_run, offset) => Promise.resolve(cleared ? { ...requestPage(0, 0), items: [] } : requestPage(offset, 61)), clear: () => { cleared = true; } }, {});
  await h.settle();
  const pageButtons = () => h.nodes().filter((node) => node.type === 'button' && node.props['aria-label']?.includes('\u9875\u8bf7\u6c42'));
  assert.equal(pageButtons()[0].props.disabled, true);
  pageButtons()[1].props.onClick(); h.render(); await h.settle();
  assert.deepEqual(h.lists.map(({ runID, offset }) => [runID, offset]), [[undefined, 0], [undefined, 30]]);
  const clearButton = h.nodes().find((node) => node.type === 'button' && node.props.children?.[0]?.type === 'Trash2');
  clearButton.props.onClick(); h.render();
  assert.deepEqual(h.clears, []);
  let modal = h.nodes().find((node) => node.type === 'Modal');
  assert.ok(modal);
  modal.props.onClose(); h.render();
  assert.deepEqual(h.clears, [], 'dismissing confirmation does not delete logs');
  clearButton.props.onClick(); h.render();
  modal = h.nodes().find((node) => node.type === 'Modal');
  walk(modal.props.footer).find((node) => node.props.className === 'danger-button').props.onClick();
  await h.settle();
  assert.deepEqual(h.clears, [undefined]);
  assert.deepEqual(h.lists.map(({ runID, offset }) => [runID, offset]), [[undefined, 0], [undefined, 30], [undefined, 0]]);
  assert.ok(!h.nodes().some((node) => node.type === 'Modal'));
  assert.equal(expanded(h).length, 0);
  h.unmount();
});

function settingsHarness(saveSettings, settings = { debug_mode: false, system_prompt: 'Saved prompt', max_tool_rounds: 40 }) {
  return hookHarness('src/pages/admin/SystemPages.tsx', 'SystemPage', {
    '../../lib/api': { adminApi: { settings: async () => settings, models: async () => [], saveSettings } },
    '../../components/Modal': { Modal: 'Modal' }, '../../components/ui/Select': { SelectField: 'SelectField' },
    '../../lib/router': { statusLabel: (status) => status },
    './Fields': { ErrorNotice: 'ErrorNotice', Field: 'Field', Toggle: 'Toggle' },
    '../../components/ProcessDetails': { StepList: 'StepList' }, '../../components/FileCards': { FileCards: 'FileCards' },
    './RequestDiagnostics': { RequestDiagnostics: 'RequestDiagnostics' },
    './UpdateCard': { UpdateCard: 'UpdateCard' },
  });
}
const debugToggle = (harness) => harness.nodes().find((node) => node.type === 'Toggle' && node.props.title.includes('Debug'));
const settingsSubmit = (harness) => harness.nodes().find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });

test('Debug saves immediately as an isolated patch and general settings never resubmit a stale debug_mode', async () => {
  const debug = deferred(), general = deferred(), patches = [];
  const h = settingsHarness((value) => { patches.push(plain(value)); return patches.length === 1 ? debug.promise : general.promise; });
  await h.settle();
  h.nodes().find((node) => node.type === 'textarea').props.onChange({ target: { value: 'Unsaved prompt' } });
  h.render();
  debugToggle(h).props.onChange(true);
  h.render();
  assert.deepEqual(patches, [{ debug_mode: true }], 'toggling must not wait for the form save or include unrelated edits');
  assert.equal(debugToggle(h).props.value, false, 'the switch represents the last server-confirmed state while saving');
  assert.equal(debugToggle(h).props.disabled, true);
  assert.ok(h.nodes().find((node) => node.type === 'button' && node.props.className === 'primary-button').props.disabled, 'general saves cannot race a pending debug patch');
  debug.resolve({ debug_mode: true, system_prompt: 'Saved prompt', max_tool_rounds: 40 });
  await h.settle();
  assert.equal(debugToggle(h).props.value, true);
  assert.equal(h.nodes().find((node) => node.type === 'textarea').props.value, 'Unsaved prompt', 'a debug acknowledgement must not overwrite local form edits');
  settingsSubmit(h);
  h.render();
  assert.equal(patches.length, 2);
  assert.equal(Object.hasOwn(patches[1], 'debug_mode'), false);
  assert.equal(patches[1].system_prompt, 'Unsaved prompt');
  assert.equal(debugToggle(h).props.disabled, true, 'debug changes cannot race a pending general save');
  general.resolve({ ...patches[1], debug_mode: true });
  await h.settle();
  assert.equal(debugToggle(h).props.value, true);
  assert.equal(patches.length, 2);
  h.unmount();
});

test('a failed immediate Debug patch keeps the confirmed value and exposes a retryable error', async () => {
  const pending = deferred(), patches = [];
  const h = settingsHarness((value) => { patches.push(plain(value)); return pending.promise; });
  await h.settle();
  debugToggle(h).props.onChange(true);
  h.render();
  pending.reject(new Error('Debug save failed'));
  await h.settle();
  assert.deepEqual(patches, [{ debug_mode: true }]);
  assert.equal(debugToggle(h).props.value, false);
  assert.equal(debugToggle(h).props.disabled, false);
  assert.equal(h.nodes().find((node) => node.type === 'ErrorNotice').props.error, 'Debug save failed');
  h.unmount();
});
