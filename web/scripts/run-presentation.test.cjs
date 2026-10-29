const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const load = require('../../shared/conversation/test-loader.cjs').createLoader(require('typescript'), require);
const { publicReply, projectRun, messagePresentation, formatReasoningText } = load(path.resolve(__dirname, '../../shared/conversation/projection.ts'));
const text = (id, value, phase = 'final', source = id) => ({ id, seq: 1, kind: 'text', source_id: source, round_id: 'round', state: 'completed', phase, text: value });
const reason = (id, value) => ({ id, seq: 2, kind: 'reasoning', source_id: id, round_id: 'round', state: 'completed', text: value });
const tool = (id) => ({ id, seq: 3, kind: 'tool', source_id: id, round_id: 'round', state: 'completed', step: { id, name: 'exec', status: 'completed', outcome: 'success' } });
const snapshot = (items, status = 'completed') => ({ run_id: 'R', session_id: 'S', seq: 10, items, status, created_at: '', updated_at: '' });

test('explicit phases preserve every occurrence, roll up commentary only after completion and never synthesize body slots', () => {
  const items = [text('intro', 'Checking', 'commentary'), reason('thought', 'Think'), tool('command'), text('a', 'A'), text('b', 'B')].map((item, seq) => ({ ...item, seq }));
  for (const status of ['running', 'failed', 'cancelled', 'interrupted', 'completed']) {
    const view = projectRun(snapshot(items, status));
    assert.deepEqual(view.entries.map((item) => item.id), items.map((item) => item.id));
    assert.equal(view.plan.canRollUp, status === 'completed');
    assert.equal(view.text, status === 'completed' ? 'A\n\nB' : 'Checking\n\nA\n\nB');
  }
});

test('source IDs join exact markdown bytes across reasoning/tool occurrences without matching content', () => {
  const parts = ['  $$', '\nx^2 + y^2', '\n$$\n\n```go\n', '  return x\n', '```  '];
  const items = parts.flatMap((value, i) => [text(`p${i}`, value, 'final', 'one-source'), i % 2 ? reason(`r${i}`, 'Private') : tool(`t${i}`)]);
  assert.equal(publicReply(snapshot(items)), parts.join(''));
  assert.equal(projectRun(snapshot(items)).finalEntries.length, parts.length);
  assert.equal(publicReply(snapshot([...items, text('other', 'A separate source')])), parts.join('') + '\n\nA separate source');
});

test('identical public text from different occurrences is never deduplicated by words', () => {
  const view = projectRun(snapshot([text('a', 'Same'), tool('t'), text('b', 'Same')]));
  assert.equal(view.text, 'Same\n\nSame'); assert.deepEqual(view.finalEntries.map((item) => item.id), ['a', 'b']);
});

test('completed work without a final answer retains every public finding without an empty folded answer', () => {
  const state = snapshot([text('a', 'Finding', 'commentary'), tool('t')]);
  assert.equal(publicReply(state), 'Finding'); assert.equal(projectRun(state).plan.canRollUp, false);
  const pure = projectRun(snapshot([text('final', 'Answer')])); assert.equal(pure.plan.hasWork, false);
});

test('persisted terminal message is readable before its stale live process has recovered and removes waiting controls', () => {
  const active = { ...snapshot([text('p', 'Partial', 'pending'), reason('r', 'private')], 'waiting_user'), waiting_input: { question: 'Continue?' } };
  const message = { id: 'M', role: 'assistant', content: 'Part one\n\nPart two', run_status: 'interrupted', run_error_code: 'run_timeout', created_at: '' };
  const view = messagePresentation(message, active);
  assert.equal(view.needsTerminal, true); assert.equal(view.fallback, message.content); assert.equal(view.copyText, message.content);
  assert.equal(view.snapshot.status, 'interrupted'); assert.equal(view.snapshot.waiting_input, undefined);
  assert.deepEqual(view.snapshot.items.map((item) => item.id), ['r']);
  assert.equal(active.items.length, 2);
});

test('only fully bold-title summaries receive visual paragraph boundaries; model prose and code remain unchanged', () => {
  assert.equal(formatReasoningText('**Plan****Verify**'), '**Plan**\n\n**Verify**');
  for (const input of ['**Plan**\n\nSome prose.', '推导 $x^2$，保留 `a****b`', '**Plan** and **Verify**']) assert.equal(formatReasoningText(input), input);
});
