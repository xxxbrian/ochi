const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, imports, tail = '') {
  const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output + tail, { module, exports: module.exports, URL, Date, JSON, Error, AbortController, require(name) {
    if (!(name in imports)) throw new Error(`Unexpected import ${name}`);
    return imports[name];
  } }, { filename: file });
  return module.exports;
}

const file = { id: 'synthetic-file', name: 'Report.pdf', mime_type: 'application/pdf', size: 1000, url: '/api/artifacts/file' };
const response = (status = 200, headers = {}) => ({ info: () => ({ status, headers }) });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function filesHarness() {
  const state = { server: 'https://api.example', token: 'Bearer synthetic-token', calls: [], removed: [], directories: [], copies: [], shared: [], replies: [], cancelCount: 0, available: true };
  const api = {
    getAPIBaseURL: () => state.server,
    fileURL: (value) => new URL(typeof value === 'string' ? value : value.url, state.server).href,
    resourceHeaders: (value) => new URL(typeof value === 'string' ? value : value.url, state.server).origin === new URL(state.server).origin ? { Authorization: state.token } : {},
  };
  const FileSystem = {
    cacheDirectory: 'file:///private/cache/',
    makeDirectoryAsync: async (directory) => { state.directories.push(directory); },
    deleteAsync: async (directory) => { state.removed.push(directory); },
    copyAsync: async (copy) => { state.copies.push(copy); },
  };
  const Sharing = { isAvailableAsync: async () => state.available, shareAsync: async (uri, options) => { state.shared.push({ uri, options }); if (state.shareError) throw new Error(state.shareError); } };
  const BlobUtil = { config: (options) => ({ fetch(method, url, headers) {
    state.calls.push({ options, method, url, headers });
    const reply = state.replies.shift() ?? response();
    const promise = reply instanceof Error ? Promise.reject(reply) : reply.promise ?? Promise.resolve(reply);
    promise.cancel = () => { state.cancelCount++; reply.reject?.(new Error('cancelled')); return Promise.resolve(); };
    return promise;
  } }) };
  const module = load('src/components/artifactFiles.ts', { 'expo-file-system/legacy': FileSystem, 'expo-sharing': Sharing, 'react-native-blob-util': { default: BlobUtil, __esModule: true }, '../lib/api': api });
  return { ...module, state };
}

test('PDF and common text names are recognized even with generic MIME; unsupported Office files stay downloads', () => {
  const h = filesHarness();
  for (const name of ['REPORT.PDF', 'report.pdf']) assert.equal(h.fileType({ ...file, name, mime_type: 'application/octet-stream' }), 'pdf');
  assert.equal(h.fileType({ ...file, name: 'attachment', mime_type: 'APPLICATION/PDF; charset=binary' }), 'pdf');
  for (const name of ['notes.TXT', 'data.CSV', 'trace.LOG', 'config.JSON', 'settings.YAML']) assert.equal(h.fileType({ ...file, name, mime_type: 'application/octet-stream' }), 'code');
  assert.equal(h.fileType({ ...file, name: 'sheet.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'binary');
  assert.equal(h.fileType({ ...file, name: 'note.md', mime_type: 'text/plain' }), 'markdown');
});

test('private artifact bytes download natively into distinct per-open files and dispose without stale-version cache reuse', async () => {
  const h = filesHarness();
  const [first, second] = await Promise.all([h.downloadArtifact(file), h.downloadArtifact({ ...file, version: 2 })]);
  assert.match(first.uri, /^file:\/\/\/private\/cache\/ochi-artifact-/);
  assert.notEqual(first.uri, second.uri);
  for (const call of h.state.calls) {
    assert.equal(call.method, 'GET');
    assert.equal(call.headers.Authorization, 'Bearer synthetic-token');
    assert.equal(call.options.followRedirect, false);
    assert.equal(call.options.trusty, false);
    assert.equal(call.options.fileCache, undefined);
    assert.equal(call.options.path.includes('://'), false);
  }
  await first.dispose();
  assert.equal(h.state.removed.length, 1);
  assert.equal(second.uri.startsWith(`${h.state.removed[0]}/`), false);
});

test('Unicode PDF filenames remain intact through the encoded URI and native path, and long names keep their extension within filesystem limits', async () => {
  const h = filesHarness();
  const name = '季度研究报告 🦉 100%.pdf';
  const local = await h.downloadArtifact({ ...file, name });
  assert.equal(decodeURIComponent(new URL(local.uri).pathname).split('/').at(-1), name);
  assert.equal(h.state.calls[0].options.path.split('/').at(-1), name);
  const long = await h.downloadArtifact({ ...file, name: '🦉'.repeat(200) + '.pdf' });
  const leaf = decodeURIComponent(new URL(long.uri).pathname).split('/').at(-1);
  assert.ok(Buffer.byteLength(leaf, 'utf8') < 255);
  assert.match(leaf, /\.pdf$/);
});

test('redirects preserve auth only for the initial trusted origin and never grant auth to an external artifact redirecting home', async () => {
  const h = filesHarness();
  h.state.replies.push(response(302, { Location: '/download' }), response(307, { location: 'https://cdn.example/report.pdf' }), response());
  await h.downloadArtifact(file);
  assert.equal(h.state.calls[0].headers.Authorization, 'Bearer synthetic-token');
  assert.equal(h.state.calls[1].headers.Authorization, 'Bearer synthetic-token');
  assert.equal(Object.keys(h.state.calls[2].headers).length, 0);

  const external = filesHarness();
  external.state.replies.push(response(302, { Location: 'https://api.example/download' }), response());
  await external.downloadArtifact({ ...file, url: 'https://cdn.example/report.pdf' });
  assert.ok(external.state.calls.every((call) => !('Authorization' in call.headers)));
});

test('downloads reject unsafe URLs, downgrade redirects and loops, then remove partial bytes', async () => {
  for (const url of ['file:///secret.pdf', 'javascript:alert(1)', 'data:application/pdf;base64,AA==', 'https://user:pass@api.example/file']) {
    const h = filesHarness();
    await assert.rejects(h.downloadArtifact({ ...file, url }));
    assert.equal(h.state.calls.length, 0);
  }
  const downgrade = filesHarness();
  downgrade.state.replies.push(response(302, { Location: 'http://api.example/file' }));
  await assert.rejects(downgrade.downloadArtifact(file), /安全连接/);
  assert.equal(downgrade.state.calls.length, 1);
  assert.equal(downgrade.state.removed.length, 1);
  const loop = filesHarness();
  loop.state.replies.push(...Array.from({ length: 6 }, () => response(302, { Location: '/loop' })));
  await assert.rejects(loop.downloadArtifact(file), /文件地址/);
  assert.equal(loop.state.calls.length, 6);
  assert.equal(loop.state.removed.length, 1);
});

test('HTTP failures and transport errors clear partial files without exposing private request URLs', async () => {
  for (const reply of [response(401), response(500), new Error('GET https://private.example?token=secret failed')]) {
    const h = filesHarness();
    h.state.replies.push(reply);
    await assert.rejects(h.downloadArtifact(file), (error) => error.message === '无法下载文件，请重试');
    assert.equal(h.state.removed.length, 1);
    assert.equal(h.state.shared.length, 0);
  }
});

test('abort cancels the native in-flight task and clears its partial file; already-aborted loads never start', async () => {
  const h = filesHarness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.downloadArtifact(file, controller.signal), /取消/);
  assert.equal(h.state.calls.length, 0);
  const next = new AbortController();
  const pending = deferred();
  h.state.replies.push(pending);
  const result = h.downloadArtifact(file, next.signal);
  await new Promise(setImmediate);
  assert.equal(h.state.calls.length, 1);
  next.abort();
  await assert.rejects(result, /取消/);
  assert.equal(h.state.cancelCount, 1);
  assert.equal(h.state.removed.length, 1);
});

test('a backend or credential switch while downloading discards the old response rather than returning private bytes', async () => {
  for (const switchOwner of [(state) => { state.server = 'https://other.example'; }, (state) => { state.token = 'Bearer other-account'; }]) {
    const h = filesHarness();
    const pending = deferred();
    h.state.replies.push(pending);
    const result = h.downloadArtifact(file);
    await new Promise(setImmediate);
    assert.equal(h.state.calls.length, 1);
    switchOwner(h.state);
    pending.resolve(response());
    await assert.rejects(result, /取消/);
    assert.equal(h.state.removed.length, 1);
  }
});

test('sharing copies local preview bytes to an independent safe filename and keeps the receiver file alive after chooser dismissal', async () => {
  const h = filesHarness();
  await h.shareArtifact({ ...file, name: '../../unsafe/Report.pdf' }, 'file:///private/preview.pdf');
  assert.equal(h.state.calls.length, 0);
  assert.equal(h.state.copies.length, 1);
  assert.equal(h.state.copies[0].from, 'file:///private/preview.pdf');
  assert.equal(new URL(h.state.shared[0].uri).pathname.split('/').length, 5);
  assert.equal(h.state.removed.length, 0);
  h.state.shareError = 'private filesystem path';
  await assert.rejects(h.shareArtifact(file), /无法分享文件/);
  assert.equal(h.state.removed.length, 1);
});

const jsx = (type, props) => ({ type, props: props ?? {} });
const walk = (node) => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object' && 'type' in node ? [node, ...walk(node.props.children)] : [];
function viewerHarness() {
  const state = { slots: [], cursor: 0, refs: [], refCursor: 0, opened: [] };
  const hooks = { useState(initial) { const i = state.cursor++; if (!(i in state.slots)) state.slots[i] = initial; return [state.slots[i], (value) => { state.slots[i] = typeof value === 'function' ? value(state.slots[i]) : value; }]; }, useRef(initial) { const i = state.refCursor++; return state.refs[i] ??= { current: initial }; }, useEffect() {} };
  const primitives = Object.fromEntries(['Modal', 'Pressable', 'ScrollView', 'View', 'ActivityIndicator'].map((name) => [name, name]));
  const module = load('src/components/DocumentViewer.tsx', {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { ...primitives, Linking: { openURL: async (url) => { state.opened.push(url); } }, StyleSheet: { create: (x) => x, hairlineWidth: 0.5 } },
    'expo-file-system/legacy': {}, 'expo-status-bar': { StatusBar: 'StatusBar' },
    'lucide-react-native': { FileText: 'FileText', Share2: 'Share2', X: 'X' },
    'react-native-pdf': { default: 'Pdf', __esModule: true },
    'react-native-safe-area-context': { SafeAreaProvider: 'SafeAreaProvider', SafeAreaView: 'SafeAreaView' },
    'react-native-webview': { WebView: 'WebView' },
    '../lib/api': { getAPIBaseURL: () => 'https://api.example', fileURL: () => 'https://api.example/private.pdf' },
    '../providers/AppProvider': { useApp: () => ({ user: { id: 'synthetic-user' } }), useTheme: () => ({ dark: false, colors: { canvas: '#fff', surface: '#fafafa', muted: '#777', border: '#ddd' } }) },
    '../ui/IconButton': { IconButton: 'IconButton' },
    '../ui/overlayGeometry': { modalOrientations: ['portrait', 'landscape-left', 'landscape-right'] },
    './ScreenChrome': { AppText: 'AppText', Button: 'Button', ErrorNotice: 'ErrorNotice' },
    './Markdown': { Markdown: 'Markdown' },
    './artifactFiles': { fileType: () => 'pdf', fileSize: () => '1 KB' },
  }, '\nexports.DocumentPreview = DocumentPreview;');
  return { ...module, state, render() { state.cursor = 0; state.refCursor = 0; return module.DocumentPreview({ file, onClose() {} }); } };
}

test('PDF preview is full-screen and landscape-safe, native zoom/scroll uses only a local URI without network credentials', () => {
  const h = viewerHarness();
  h.state.slots = ['', 'file:///private/cache/report.pdf', true, '', '', 0, 'preview', false, { page: 1, total: 0 }];
  let tree = h.render();
  assert.equal(tree.type, 'Modal');
  assert.equal(tree.props.presentationStyle, 'fullScreen');
  assert.ok(tree.props.supportedOrientations.includes('landscape-left'));
  assert.ok(tree.props.supportedOrientations.includes('landscape-right'));
  assert.ok(walk(tree).some((node) => node.type === 'SafeAreaProvider'));
  const pdf = walk(tree).find((node) => node.type === 'Pdf');
  assert.equal(pdf.props.source.uri, 'file:///private/cache/report.pdf');
  assert.equal(pdf.props.source.headers, undefined);
  assert.equal(pdf.props.source.cache, false);
  assert.equal(pdf.props.trustAllCerts, false);
  assert.equal(pdf.props.enableDoubleTapZoom, true);
  assert.ok(pdf.props.maxScale > 1);
  pdf.props.onLoadComplete(8);
  pdf.props.onPageChanged(3, 8);
  tree = h.render();
  assert.match(JSON.stringify(tree), /3 \/ 8 页/);
  assert.equal(h.state.slots[2], false);
  assert.equal(walk(tree).some((node) => node.type === 'WebView'), false);
});

test('late native callbacks from a previous PDF cannot overwrite a retried preview', () => {
  const h = viewerHarness();
  h.state.slots = ['', 'file:///private/cache/first.pdf', false, '', '', 0, 'preview', false, { page: 1, total: 2 }];
  const previous = walk(h.render()).find((node) => node.type === 'Pdf');
  h.state.slots[1] = 'file:///private/cache/retry.pdf';
  h.state.slots[5] = 1;
  h.render();
  previous.props.onError(); previous.props.onPageChanged(99, 100);
  assert.equal(h.state.slots[3], '');
  assert.equal(h.state.slots[8].page, 1);
});

test('document links only open ordinary HTTP(S) URLs, never local files, JS, custom schemes or embedded credentials', () => {
  const h = viewerHarness();
  for (const url of ['file:///private/file', 'javascript:alert(1)', 'intent://something', 'https://user:pass@example.com/', '#page=2']) h.openDocumentLink(url);
  h.openDocumentLink('https://example.com/page');
  h.openDocumentLink('http://example.com/page');
  assert.deepEqual(h.state.opened, ['https://example.com/page', 'http://example.com/page']);
});
