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
    [path.join(root, 'web/src/components/ThinkingDetails.tsx')]: { OchiActivityMark: () => null },
    [path.join(root, 'web/src/components/ProcessTimeline.tsx')]: { ProcessTimeline: ({ timeline }) => React.createElement('div', { 'data-process': true }, timeline.map((item) => item.reasoning?.text ?? item.step?.name).join(' ')) },
    [path.join(root, 'web/src/components/ProcessElapsed.tsx')]: { ProcessElapsed: () => null },
    [path.join(root, 'web/src/components/ProcessSteps.tsx')]: { StepList: () => null },
  });
  return { ...load(path.join(root, 'web/src/components/RunTranscript.tsx')), ...load(path.join(root, 'web/src/components/HistoryProcess.tsx')),
    ...load(path.join(root, 'shared/conversation/projection.ts')) };
}
const item = (id, text, phase = 'final') => ({ id, seq: 1, kind: 'text', source_id: id, round_id: 'round', phase, state: 'completed', text });
const thought = { id: 'thought', seq: 2, kind: 'reasoning', source_id: 'thought', round_id: 'round', text: 'Private reasoning', state: 'completed' };
const snapshot = (items, status = 'completed', seq = 10) => ({ run_id: 'R', session_id: 'S', status, seq, items: items.map((value, index) => ({ ...value, seq: index })), created_at: '', updated_at: '' });
test.afterEach(cleanup);

test('real portal slots keep Markdown host identity and focus while final entries move out of the folded process', async () => {
  const { RunTranscript, projectRun } = setup(); let mounts = 0;
  function Body({ value, id }) { React.useEffect(() => { mounts++; }, []); return React.createElement('button', { 'data-body': id }, value); }
  const renderBody = (value, id) => React.createElement(Body, { value, id });
  const live = snapshot([item('intro', 'Checking', 'commentary'), thought, item('a', 'First'), item('b', 'Second')], 'running');
  const props = { timeline: projectRun(live).entries, output: '', status: 'running', renderBody };
  let view; await act(async () => { view = render(React.createElement('div', { className: 'messages-scroll' }, React.createElement(RunTranscript, props))); });
  const first = view.getByText('First'); first.focus(); const count = mounts;
  await act(async () => { view.rerender(React.createElement('div', { className: 'messages-scroll' }, React.createElement(RunTranscript, { ...props, status: 'completed' }))); });
  assert.equal(view.getByText('First'), first); assert.equal(document.activeElement, first); assert.equal(mounts, count);
  assert.equal(view.container.querySelector('.run-work-surface').hidden, true);
  assert.deepEqual([...view.container.querySelector('.run-answer-surface').querySelectorAll('[data-body]')].map((node) => node.textContent), ['First', 'Second']);
  assert.equal(view.container.querySelectorAll('[data-body="a"]').length, 1);
  fireEvent.click(view.container.querySelector('.run-transcript-summary button'));
  assert.equal(view.container.querySelector('.run-work-surface').hidden, false); assert.equal(mounts, count);
});

test('manual process reading delays folding until explicit view answer and interrupted runs keep every public block visible', async () => {
  const { RunTranscript, projectRun } = setup();
  const state = snapshot([item('intro', 'Checking', 'commentary'), thought, item('answer', 'Answer')], 'running');
  const props = { timeline: projectRun(state).entries, output: '', status: 'running', expanded: true, renderBody: (value) => React.createElement('p', {}, value) };
  const view = render(React.createElement(RunTranscript, props));
  await act(async () => view.rerender(React.createElement(RunTranscript, { ...props, status: 'completed' })));
  assert.equal(view.container.querySelector('.run-work-surface').hidden, false);
  fireEvent.click(view.getByText('View response'));
  assert.equal(view.container.querySelector('.run-transcript').classList.contains('is-archived'), true);
  await act(async () => view.rerender(React.createElement(RunTranscript, { ...props, status: 'interrupted', expanded: false })));
  assert.equal(view.container.querySelector('.run-work-surface').hidden, false);
  assert.equal(view.getAllByText('Answer').length, 1); assert.equal(view.getAllByText('Checking').length, 1);
  assert.equal(view.getAllByRole('alert').length, 1);
});

test('cold completed history renders its public reply without loading heavy details; expansion loads once', async () => {
  const load = deferred(); let calls = 0;
  const { HistoryProcess } = setup(() => { calls++; return load.promise; });
  const props = { runId: 'R', stepCount: 1, hasProcess: true, status: 'completed', output: 'Persisted final', renderBody: (value) => React.createElement('p', {}, value) };
  const view = render(React.createElement(HistoryProcess, props));
  assert.equal(calls, 0); assert.ok(view.getByText('Persisted final'));
  fireEvent.click(view.container.querySelector('.history-process button')); assert.equal(calls, 1);
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
