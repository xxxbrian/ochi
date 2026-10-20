const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const walk = (node) => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object' && 'type' in node ? [node, ...walk(node.props.children)] : [];
const text = (node) => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' && 'type' in node ? text(node.props.children) : node == null || typeof node === 'boolean' ? '' : String(node);
const build = (revision = '11111111aaaa') => ({ version: '0.1.0', revision, built_at: '2026-01-01T00:00:00Z', schema_sha256: 'schema' });
const initial = (patch = {}) => ({ current: build(), supported: true, available: false, phase: 'idle', downloaded_bytes: 0, total_bytes: 0, ...patch });

function evaluate(source, imports = {}, globals = {}) {
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, AbortController, Date, Error, JSON, Promise, Intl, ...globals,
    require(name) { if (name in imports) return imports[name]; throw new Error(`Unexpected import: ${name}`); },
  });
  return module.exports;
}

function clock() {
  let now = 1000000, id = 0;
  const tasks = new Map();
  return {
    get now() { return now; }, get size() { return tasks.size; },
    setTimeout(callback, delay) { const key = ++id; tasks.set(key, { callback, at: now + delay }); return key; },
    clearTimeout(key) { tasks.delete(key); },
    tick(milliseconds) {
      now += milliseconds;
      for (const [key, task] of [...tasks]) if (task.at <= now) { tasks.delete(key); task.callback(); }
    },
  };
}

function harness(transport = {}, { storage = new Map(), component = false } = {}) {
  const slots = [], effects = [], time = clock(), calls = [];
  let cursor = 0, dirty = false, value, mounted = true, lateWrites = 0;
  const different = (a, b) => !a || !b || a.length !== b.length || a.some((item, index) => !Object.is(item, b[index]));
  const react = {
    useRef(value) { const index = cursor++; slots[index] ??= { current: value }; return slots[index]; },
    useState(value) {
      const index = cursor++; slots[index] ??= { value: typeof value === 'function' ? value() : value };
      return [slots[index].value, (next) => {
        if (!mounted) lateWrites++;
        const result = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(result, slots[index].value)) { slots[index].value = result; dirty = true; }
      }];
    },
    useCallback(callback, dependencies) {
      const index = cursor++;
      if (different(slots[index]?.dependencies, dependencies)) slots[index] = { dependencies, value: callback };
      return slots[index].value;
    },
    useEffect(effect, dependencies) {
      const index = cursor++, previous = slots[index];
      if (different(previous?.dependencies, dependencies)) effects.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: effect() }; });
    },
  };
  const api = {};
  for (const name of ['updates', 'checkUpdate', 'applyUpdate', 'restartUpdate', 'rollbackUpdate']) api[name] = (...args) => {
    calls.push({ name, args });
    return transport[name] ? transport[name](...args) : Promise.resolve(initial());
  };
  const FakeDate = class extends Date { static now() { return time.now; } };
  const module = evaluate(read('src/pages/admin/UpdateCard.tsx') + '\nexports.controller = useUpdateController;', {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'lucide-react': new Proxy({}, { get: (_target, key) => String(key) }),
    '../../components/Modal': { Modal: 'Modal' }, '../../lib/api': { adminApi: api },
  }, { Date: FakeDate, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    window: { location: { reload() { calls.push({ name: 'reload' }); } } },
  });
  const render = () => { cursor = 0; dirty = false; value = component ? module.UpdateCard() : module.controller(); effects.splice(0).forEach((effect) => effect()); };
  const settle = async () => { for (let index = 0; index < 40; index++) { await Promise.resolve(); if (dirty && mounted) render(); } };
  render();
  return { time, storage, calls, render, settle, get value() { return value; }, get lateWrites() { return lateWrites; },
    nodes: () => walk(value), find: (label) => walk(value).find((node) => node.type === 'button' && text(node) === label),
    unmount() { mounted = false; slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

test('update transport uses explicit admin actions, exact revisions, cancellation and quiet restart-aware requests', async () => {
  const source = ts.createSourceFile('api.ts', read('src/lib/api.ts'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.flatMap((node) => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []).find((node) => node.name.getText(source) === 'adminApi');
  const names = ['updates', 'checkUpdate', 'applyUpdate', 'restartUpdate', 'rollbackUpdate'];
  const methods = declaration.initializer.properties.filter((node) => names.includes(node.name?.getText(source)));
  assert.equal(methods.length, names.length);
  const calls = [];
  const { api } = evaluate(`exports.api = {${methods.map((node) => node.getText(source)).join(',\n')}}`, {}, {
    request: async (...args) => calls.push(args),
  });
  const signal = new AbortController().signal;
  await api.updates(signal); await api.checkUpdate(signal); await api.applyUpdate('exact-revision', signal);
  await api.restartUpdate(signal); await api.rollbackUpdate(signal);
  assert.deepEqual(calls.map(([url]) => url), ['/api/admin/updates', '/api/admin/updates/check', '/api/admin/updates/apply', '/api/admin/updates/restart', '/api/admin/updates/rollback']);
  assert.ok(calls.every(([, init, options]) => init.signal === signal && options.quiet === true));
  assert.deepEqual(calls.map(([, init]) => init.method), [undefined, 'POST', 'POST', 'POST', 'POST']);
  assert.deepEqual(JSON.parse(calls[2][1].body), { revision: 'exact-revision' });
});

test('expected update disconnects do not spam console errors; ordinary requests keep diagnostic logging', async () => {
  const source = ts.createSourceFile('api.ts', read('src/lib/api.ts'), ts.ScriptTarget.Latest, true);
  const functions = source.statements.filter((node) => ts.isFunctionDeclaration(node) && ['request', 'userFacingError'].includes(node.name?.text));
  let failFetch = true, logs = 0;
  const { request } = evaluate(functions.map((node) => node.getText(source)).join('\n'), {}, {
    API_BASE: '', FormData, console: { error() { logs++; } },
    fetch: async () => { if (failFetch) throw new Error('offline'); return { ok: false, status: 503, json: async () => ({}) }; },
  });
  await assert.rejects(request('/api/admin/updates', {}, { quiet: true }));
  failFetch = false; await assert.rejects(request('/api/admin/updates', {}, { quiet: true }));
  assert.equal(logs, 0);
  await assert.rejects(request('/api/admin/settings')); assert.equal(logs, 1);
});

test('opening updates never checks, applies or restarts automatically; duplicate checks are guarded', async () => {
  const checked = deferred();
  const h = harness({ checkUpdate: () => checked.promise }); await h.settle();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, 'updates'); assert.equal(h.time.size, 0);
  const first = h.value.perform('check'); await h.value.perform('check'); await h.settle();
  assert.equal(h.calls.filter((call) => call.name === 'checkUpdate').length, 1);
  checked.resolve(initial({ latest: build('22222222bbbb'), available: true })); await first; await h.settle();
  assert.equal(h.value.state.latest.revision, '22222222bbbb'); assert.equal(h.time.size, 0); h.unmount();
});

test('download progress follows server bytes and stops at ready without an implicit restart', async () => {
  const target = build('22222222bbbb'); let status = initial({ latest: target, available: true });
  const h = harness({ updates: async () => status, applyUpdate: async () => {
    status = initial({ latest: target, available: true, phase: 'downloading', downloaded_bytes: 2048, total_bytes: 8192 });
    return status;
  } }); await h.settle();
  await h.value.perform('apply'); await h.settle(); assert.equal(h.value.state.downloaded_bytes, 2048);
  status = { ...status, phase: 'ready', pending: target, downloaded_bytes: 8192 };
  h.time.tick(1000); await h.settle();
  assert.equal(h.value.state.phase, 'ready'); assert.equal(h.time.size, 0);
  assert.equal(h.calls.filter((call) => call.name === 'restartUpdate').length, 0); h.unmount();
});

test('unsupported builds can be checked but cannot change binaries; schema-blocked targets cannot be applied', async () => {
  for (const patch of [{ supported: false, unsupported_reason: '开发构建' }, { blocked_reason: '数据库结构不同' }]) {
    const status = initial({ latest: build('22222222bbbb'), backup: build('00000000aaaa'), available: true, ...patch });
    const h = harness({ updates: async () => status, checkUpdate: async () => status }); await h.settle();
    await h.value.perform('apply'); await h.value.perform('restart');
    if (!status.supported) await h.value.perform('rollback');
    await h.value.perform('check'); await h.settle();
    assert.equal(h.calls.filter((call) => ['applyUpdate', 'restartUpdate', 'rollbackUpdate'].includes(call.name)).length, 0);
    assert.equal(h.calls.filter((call) => call.name === 'checkUpdate').length, 1); h.unmount();
  }
});

test('restart waits beyond the ten-minute drain, survives disconnects, and confirms only the exact target revision', async () => {
  const target = build('22222222bbbb'); let status = initial({ phase: 'ready', pending: target }), offline = false;
  const h = harness({ updates: async () => { if (offline) throw new Error('offline'); return status; }, restartUpdate: async () => { throw new Error('connection reset'); } });
  await h.settle(); await h.value.perform('restart'); await h.settle();
  assert.equal(h.value.restartIntent.revision, target.revision); assert.equal(h.storage.size, 1);
  status = initial();
  for (let step = 0; step < 66; step++) { offline = step % 2 === 0; h.time.tick(10000); await h.settle(); }
  assert.equal(h.value.confirmedRevision, ''); assert.equal(h.value.restartExpired, false);
  offline = false; status = initial({ current: target }); h.time.tick(5000); await h.settle();
  assert.equal(h.value.confirmedRevision, target.revision); assert.equal(h.value.restartIntent, null);
  assert.equal(h.storage.size, 0); assert.equal(h.time.size, 0);
  assert.equal(h.calls.filter((call) => call.name === 'restartUpdate').length, 1); h.unmount();
});

test('leaving and returning restores restart verification from storage without another restart command', async () => {
  const storage = new Map(), target = build('22222222bbbb');
  const first = harness({ updates: async () => initial({ phase: 'ready', pending: target }), restartUpdate: async () => initial({ phase: 'restarting', pending: target }) }, { storage });
  await first.settle(); await first.value.perform('restart'); await first.settle(); first.unmount();
  const second = harness({ updates: async () => initial({ current: target }) }, { storage }); await second.settle();
  assert.equal(second.value.confirmedRevision, target.revision); assert.equal(storage.size, 0);
  assert.ok(second.calls.every((call) => call.name === 'updates')); second.unmount();
});

test('a hanging restart acknowledgement times out into target verification rather than freezing the controls', async () => {
  const target = build('22222222bbbb');
  const h = harness({ updates: async () => initial({ phase: 'ready', pending: target }),
    restartUpdate: (signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  }); await h.settle();
  const pending = h.value.perform('restart'); await h.settle(); assert.equal(h.value.action, 'restart');
  h.time.tick(8000); await h.settle(); await pending;
  assert.equal(h.value.action, null); assert.equal(h.value.restartIntent.revision, target.revision);
  assert.ok(h.calls.filter((call) => call.name === 'updates').length >= 2); h.unmount();
});

test('permission errors pause polling and can be retried without losing the target or issuing another restart', async () => {
  const target = build('22222222bbbb'); let status = initial({ phase: 'restarting', pending: target }), denied = false;
  const h = harness({ updates: async () => { if (denied) throw Object.assign(new Error('请重新登录'), { status: 401 }); return status; } });
  await h.settle(); denied = true; h.time.tick(2500); await h.settle();
  assert.match(h.value.error, /重新登录/); assert.equal(h.time.size, 0); assert.equal(h.value.restartIntent.revision, target.revision);
  denied = false; status = initial({ current: target }); h.value.retry(); await h.settle();
  assert.equal(h.value.confirmedRevision, target.revision); assert.ok(h.calls.every((call) => call.name === 'updates')); h.unmount();
});

test('initial state request timeouts show a localized retry instead of an endless loader', async () => {
  const h = harness({ updates: (signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  h.time.tick(8000); await h.settle(); assert.match(h.value.error, /获取更新状态超时/); assert.equal(h.time.size, 0); h.unmount();
});

test('a restart issued elsewhere is recovered; prolonged startup gets a retryable verification timeout, never another restart', async () => {
  const target = build('22222222bbbb'), status = initial({ phase: 'restarting', pending: target });
  const h = harness({ updates: async () => status }); await h.settle();
  assert.equal(h.value.restartIntent.revision, target.revision);
  h.time.tick(16 * 60 * 1000); await h.settle();
  assert.equal(h.value.restartExpired, true); assert.match(h.value.error, /不要重复重启/); assert.equal(h.time.size, 0);
  h.value.retry(); await h.settle(); assert.equal(h.value.restartExpired, false);
  assert.ok(h.calls.every((call) => call.name === 'updates')); h.unmount();
});

test('lost apply acknowledgements are reconciled by reading state, not blindly downloading again', async () => {
  const target = build('22222222bbbb'); let status = initial({ latest: target, available: true });
  const h = harness({ updates: async () => status, applyUpdate: async () => {
    status = initial({ phase: 'ready', pending: target }); throw new Error('connection reset');
  } }); await h.settle(); await h.value.perform('apply'); await h.settle();
  assert.equal(h.value.state.phase, 'ready'); assert.equal(h.calls.filter((call) => call.name === 'applyUpdate').length, 1); h.unmount();
});

test('unmount aborts action/read requests, drops late responses and cancels every timer', async () => {
  const response = deferred(); let signal;
  const h = harness({ checkUpdate: (value) => { signal = value; return response.promise; } }); await h.settle();
  const pending = h.value.perform('check'); await h.settle(); h.unmount(); assert.equal(signal.aborted, true);
  assert.equal(h.time.size, 0);
  response.resolve(initial({ latest: build('22222222bbbb') })); await pending; await h.settle();
  assert.equal(h.lateWrites, 0); assert.equal(h.time.size, 0);
  const readResponse = deferred(); const second = harness({ updates: (value) => { signal = value; return readResponse.promise; } });
  second.unmount(); assert.equal(signal.aborted, true); readResponse.resolve(initial()); await second.settle();
  assert.equal(second.lateWrites, 0); assert.equal(second.time.size, 0);
});

test('update UI uses real progress, explicit restart confirmation and independent type=button controls', async () => {
  const target = build('22222222bbbb'); let status = initial({ phase: 'downloading', downloaded_bytes: 1024, total_bytes: 4096 });
  const h = harness({ updates: async () => status, restartUpdate: async () => initial({ phase: 'restarting', pending: target }) }, { component: true });
  await h.settle(); const progress = h.nodes().find((node) => node.type === 'progress');
  assert.equal(progress.props.value, 1024); assert.equal(progress.props.max, 4096);
  status = initial({ phase: 'ready', pending: target }); h.time.tick(1000); await h.settle();
  h.find('重启并应用').props.onClick(); await h.settle();
  const modal = h.nodes().find((node) => node.type === 'Modal'); assert.ok(modal);
  assert.match(text(modal), /10 分钟/); assert.match(text(modal), /会中断/);
  assert.equal(h.calls.filter((call) => call.name === 'restartUpdate').length, 0);
  const confirm = walk(modal.props.footer).find((node) => node.type === 'button' && text(node) === '确认重启');
  confirm.props.onClick(); await h.settle(); assert.equal(h.calls.filter((call) => call.name === 'restartUpdate').length, 1);
  assert.ok(h.nodes().filter((node) => node.type === 'button').every((node) => node.props.type === 'button')); h.unmount();
});

test('backup restoration prepares another explicit restart, while incompatible builds show no download action', async () => {
  const backup = build('00000000aaaa');
  const h = harness({ updates: async () => initial({ backup }), rollbackUpdate: async () => initial({ backup, phase: 'ready', pending: backup }) }, { component: true });
  await h.settle(); h.nodes().find((node) => node.type === 'button' && text(node).startsWith('恢复备份')).props.onClick(); await h.settle();
  const modal = h.nodes().find((node) => node.type === 'Modal'); assert.match(text(modal), /不恢复数据库/);
  walk(modal.props.footer).find((node) => node.type === 'button' && text(node) === '恢复备份').props.onClick(); await h.settle();
  assert.ok(h.find('重启并应用')); assert.equal(h.calls.filter((call) => call.name === 'restartUpdate').length, 0); h.unmount();
  const blocked = harness({ updates: async () => initial({ latest: build('22222222bbbb'), available: true, blocked_reason: '数据库结构不同' }) }, { component: true });
  await blocked.settle(); assert.equal(blocked.find('下载更新'), undefined); assert.match(text(blocked.value), /数据库结构不同/); blocked.unmount();
});

test('the update section sits outside the system settings form', () => {
  const source = ts.createSourceFile('SystemPages.tsx', read('src/pages/admin/SystemPages.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = 0;
  function visit(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'UpdateCard') {
      found++;
      for (let parent = node.parent; parent; parent = parent.parent)
        assert.ok(!ts.isJsxElement(parent) || parent.openingElement.tagName.getText(source) !== 'form');
    }
    ts.forEachChild(node, visit);
  }
  visit(source); assert.equal(found, 1);
});
