const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.invalid/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const React = require('react');
const { render, act, cleanup, fireEvent } = require('@testing-library/react');
const { createLoader } = require('../../shared/conversation/test-loader.cjs');
const i18n = require('./i18n-harness.cjs').createI18nHarness('en');
const root = path.resolve(__dirname, '../..');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { resolve, promise }; }
function setup(run = async () => { throw new Error('unexpected load'); }) {
  const load = createLoader(require('typescript'), require, {
    [path.join(root, 'web/src/lib/i18n.ts')]: i18n.web,
    [path.join(root, 'web/src/lib/api.ts')]: { api: { run }, isActiveStatus: (status) => ['running', 'waiting_user', 'waiting_resource', 'cancelling'].includes(status), userFacingRunError: () => 'Localized incomplete response' },
    [path.join(root, 'web/src/components/ProcessTimeline.tsx')]: { ProcessTimeline: ({ timeline, active, status, blockId, headerEntries, expanded, onExpandedChange }) => React.createElement('div', { className: 'proc', 'data-active': Boolean(active), 'data-status': status, 'data-block': blockId, 'data-header': headerEntries ? headerEntries.length : undefined, 'data-rail': timeline.map((item) => item.kind === 'progress' ? `progress:${item.text}` : item.id).join('|') },
      React.createElement('button', { className: 'proc-head', 'aria-expanded': Boolean(expanded), onClick: () => onExpandedChange?.(!expanded) }, 'header')) },
    [path.join(root, 'web/src/components/process.css')]: {},
  });
  return { ...load(path.join(root, 'web/src/components/RunTranscript.tsx')), ...load(path.join(root, 'web/src/components/HistoryProcess.tsx')),
    ...load(path.join(root, 'shared/conversation/projection.ts')) };
}
const item = (id, text, phase = 'final') => ({ id, seq: 1, kind: 'text', source_id: id, round_id: 'round', phase, state: 'completed', text });
const thought = { id: 'thought', seq: 2, kind: 'reasoning', source_id: 'thought', round_id: 'round', text: 'Private reasoning', state: 'completed' };
const snapshot = (items, status = 'completed', seq = 10) => ({ run_id: 'R', session_id: 'S', status, seq, items: items.map((value, index) => ({ ...value, seq: index })), created_at: '', updated_at: '' });
test.afterEach(cleanup);

const texts = (container, selector) => [...container.querySelectorAll(selector)].map((node) => node.textContent);

test('interim replies are prose, tool work after them opens a new block, and the final answer folds every block into the first', async () => {
  const { RunTranscript, projectRun } = setup(); let mounts = 0;
  function Body({ value, id }) { React.useEffect(() => { mounts++; }, []); return React.createElement('button', { 'data-body': id }, value); }
  const renderBody = (value, id) => React.createElement(Body, { value, id });
  const wrap = (props) => React.createElement('div', { className: 'scroller' }, React.createElement(RunTranscript, props));
  const tool = (id) => ({ id, seq: 0, kind: 'tool', source_id: id, round_id: 'round', step: { id, name: 'exec', status: 'completed', arguments: {} } });
  const items = [thought, item('mid', 'Found it, now checking more', 'commentary'), tool('tool2'), item('a', 'First'), item('b', 'Second')];
  const props = (status, list) => ({ timeline: projectRun(snapshot(list, status)).entries, output: '', status, renderBody });

  let view; await act(async () => { view = render(wrap(props('running', [item('intro', 'Checking', 'commentary')]))); });
  assert.deepEqual(texts(view.container, '[data-body]'), ['Checking']);
  assert.equal(view.container.querySelector('.proc').dataset.block, 'process:tail', 'a run with only an interim reply keeps a live status below it');
  assert.equal(view.container.querySelector('.proc').dataset.active, 'true');

  await act(async () => { view.rerender(wrap(props('running', [item('intro', 'Checking', 'commentary'), ...items.slice(0, 3)]))); });
  const blocks = [...view.container.querySelectorAll('.proc')];
  assert.deepEqual(blocks.map((node) => node.dataset.rail), ['thought', 'tool2']);
  assert.deepEqual(blocks.map((node) => `${node.dataset.status}:${node.dataset.active}`), ['completed:false', 'running:true'], 'a block an interim reply closed reads as finished; only the newest works');
  assert.deepEqual(texts(view.container, '[data-body]'), ['Checking', 'Found it, now checking more']);
  assert.deepEqual([...view.container.querySelectorAll('.run-item-in > *')].map((node) => node.dataset.publicEntry ?? node.dataset.block), ['intro', 'process:thought', 'mid', 'process:tool2'], 'prose and blocks interleave in run order');

  await act(async () => { view.rerender(wrap(props('running', [item('intro', 'Checking', 'commentary'), ...items]))); });
  const first = view.getByText('First'); first.focus(); const count = mounts;
  await act(async () => { view.rerender(wrap(props('completed', [item('intro', 'Checking', 'commentary'), ...items]))); });
  assert.equal(view.getByText('First'), first); assert.equal(document.activeElement, first); assert.equal(mounts, count, 'answer Markdown keeps its identity and focus through the fold');
  const procs = [...view.container.querySelectorAll('.proc:not([data-leaving])')].filter((node) => !node.closest('[data-leaving="true"]'));
  assert.equal(procs.length, 1, 'exactly one progress block remains');
  assert.equal(procs[0].dataset.rail, 'progress:Checking|thought|progress:Found it, now checking more|tool2');
  assert.equal(procs[0].dataset.active, 'false');
  assert.equal(procs[0].dataset.block, 'process:thought', 'the folded block is the first live block, so it is not remounted');
  const visible = [...view.container.querySelectorAll('.run-item:not([data-leaving="true"]) [data-body]')].map((node) => node.textContent);
  assert.deepEqual(visible, ['First', 'Second'], 'interim replies leave the transcript; only the answer stays');
});

test('the reader\'s header choice goes to the newest block, and a run without marks answers with the text after its last work', async () => {
  const { RunTranscript, projectRun } = setup();
  const state = snapshot([item('intro', 'Checking', 'commentary'), thought, item('tail', 'Plain ending', 'commentary')], 'completed');
  const changes = [];
  const props = { timeline: projectRun(state).entries, output: '', status: 'completed', expanded: true, onExpandedChange: (value) => changes.push(value), renderBody: (value) => React.createElement('p', {}, value) };
  const view = render(React.createElement(RunTranscript, props));
  assert.equal(view.container.querySelector('.proc-head').getAttribute('aria-expanded'), 'true');
  assert.equal(view.container.querySelector('.proc').dataset.rail, 'progress:Checking|thought');
  assert.equal(view.getAllByText('Plain ending').length, 1);
  fireEvent.click(view.container.querySelector('.proc-head'));
  assert.deepEqual(changes, [false]);
});

test('interim-only and answer-less runs never fold their prose into a header', async () => {
  const { RunTranscript, projectRun } = setup();
  const props = (list, status = 'completed') => ({ timeline: projectRun(snapshot(list, status)).entries, output: '', status, renderBody: (value) => React.createElement('p', {}, value) });
  const view = render(React.createElement(RunTranscript, props([item('intro', 'Checking', 'commentary'), item('answer', 'Answer')])));
  assert.equal(view.container.querySelectorAll('.proc').length, 0);
  assert.equal(view.getAllByText('Checking').length, 1); assert.equal(view.getAllByText('Answer').length, 1);
});

test('interrupted and stopped runs keep every public reply as prose between their blocks', async () => {
  const { RunTranscript, projectRun } = setup();
  const state = snapshot([item('intro', 'Checking', 'commentary'), thought, item('answer', 'Answer')], 'running');
  const props = { timeline: projectRun(state).entries, output: '', status: 'running', renderBody: (value) => React.createElement('p', {}, value) };
  for (const status of ['interrupted', 'failed', 'cancelled']) {
    const view = render(React.createElement(RunTranscript, { ...props, status }));
    assert.deepEqual([...view.container.querySelectorAll('.proc')].map((node) => node.dataset.rail), ['thought'], status);
    assert.equal(view.getAllByText('Answer').length, 1); assert.equal(view.getAllByText('Checking').length, 1);
    assert.equal(view.queryAllByRole('alert').length, status === 'cancelled' ? 0 : 1, status);
    view.unmount();
  }
});

test('cold completed history renders its public reply without loading heavy details; expansion loads once', async () => {
  const load = deferred(); let calls = 0;
  const { HistoryProcess } = setup(() => { calls++; return load.promise; });
  const props = { runId: 'R', stepCount: 1, hasProcess: true, status: 'completed', output: 'Persisted final', renderBody: (value) => React.createElement('p', {}, value) };
  const view = render(React.createElement(HistoryProcess, props));
  assert.equal(calls, 0); assert.ok(view.getByText('Persisted final'));
  fireEvent.click(view.container.querySelector('.proc .proc-head')); assert.equal(calls, 1);
  await act(async () => { load.resolve(snapshot([thought, item('answer', 'Persisted final')])); await flush(); });
  assert.equal(view.getAllByText('Persisted final').length, 1); assert.equal(calls, 1);
});

test('terminal history is immediately visible while the shared detail resource recovers a stale active snapshot', async () => {
  const load = deferred(); let signal;
  const { HistoryProcess } = setup((_id, value) => { signal = value; return load.promise; });
  const active = snapshot([item('partial', 'Partial candidate', 'pending'), thought], 'waiting_user', 1);
  const props = { runId: 'R', stepCount: 1, snapshot: active, hasProcess: true, status: 'interrupted', output: 'Every persisted public paragraph', renderBody: (value) => React.createElement('p', {}, value) };
  const view = render(React.createElement(HistoryProcess, props));
  assert.ok(view.getByText('Every persisted public paragraph')); assert.equal(view.queryByText('Partial candidate'), null);
  await act(async () => { load.resolve(snapshot([item('intro', 'Every persisted public paragraph', 'commentary'), thought], 'interrupted', 2)); await flush(); });
  assert.equal(view.getAllByText('Every persisted public paragraph').length, 1); assert.equal(signal.aborted, false);
});
