const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createLoader } = require("../../shared/conversation/test-loader.cjs");
const load = createLoader(require("typescript"), require);
const root = path.resolve(__dirname, "../..");
const { createConversationController } = load(path.join(root, "shared/conversation/controller.ts"));
const { reduceRunDelta } = load(path.join(root, "shared/conversation/events.ts"));
const { projectRun, publicReply, toolGroupFamily } = load(path.join(root, "shared/conversation/projection.ts"));
const { createRunStream } = load(path.join(root, "shared/conversation/runStream.ts"));
const { createRunDetail } = load(path.join(root, "shared/conversation/runDetail.ts"));
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const owner = (sessionId = "S", account = "account", origin = "https://example.invalid") => ({ origin, account, sessionId });
const run = (id = "R", status = "completed", seq = 10) => ({
  run_id: id, session_id: "S", status, seq, items: [], created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:01Z",
});
const text = (id, value, phase = "final", source = id) => ({ id, seq: 1, kind: "text", source_id: source, round_id: "round", state: "completed", phase, text: value });
function fixture(overrides = {}) {
  let head = { session: { id: "S", title: "First", updated_at: "1", computer_enabled: false },
    latest_run: { run_id: "R", status: "completed", seq: 10 }, history_revision: "1", queue_revision: "0" };
  let history = [{ id: "M", run_id: "R", role: "assistant", content: "First", created_at: "" }];
  const calls = { head: 0, messages: 0, queue: 0, run: 0, connected: 0, closed: 0 };
  const handlers = [];
  const transport = {
    sessionHead: async () => { calls.head++; return head; },
    messages: async () => { calls.messages++; return history; },
    queue: async () => { calls.queue++; return []; },
    run: async (id) => { calls.run++; return run(id, head.latest_run.status, head.latest_run.seq); },
    connect: (_id, handler) => { calls.connected++; handlers.push(handler); return () => calls.closed++; },
    createSession: async () => head.session,
    startRun: async () => run("R2", "running", 1),
    updateSession: async (_id, patch) => ({ ...head.session, ...patch }),
    cancelRun: async () => run("R", "cancelled", 11),
    resumeRun: async () => run("R", "running", 11),
    cancelQueuedRun: async () => {},
    updateQueuedRun: async () => {},
    runInstructions: async () => [],
    supplementRun: async () => { throw new Error("No fixture receipt"); },
    ...overrides,
  };
  const controller = createConversationController(transport);
  return { controller, transport, calls, handlers, setHead(next) { head = next; }, get head() { return head; }, setHistory(next) { history = next; } };
}

test("idle remote turn updates selected history and run without rail ownership", async () => {
  const f = fixture();
  try {
    f.controller.select(owner()); f.controller.setEnabled(true); await flush();
    assert.equal(f.controller.getSnapshot().messages[0].content, "First");
    f.setHead({ ...f.head, session: { ...f.head.session, title: "Remote", updated_at: "2" },
      latest_run: { run_id: "R2", status: "completed", seq: 8 }, history_revision: "2" });
    f.setHistory([{ id: "M2", run_id: "R2", role: "assistant", content: "Remote reply", created_at: "" }]);
    await f.controller.refresh();
    assert.equal(f.controller.getSnapshot().session.title, "Remote");
    assert.equal(f.controller.getSnapshot().messages[0].content, "Remote reply");
    assert.equal(f.controller.getSnapshot().run.run_id, "R2");
  } finally { f.controller.dispose(); }
});

test("unchanged head polling never fetches history, queue or complete process bodies", async () => {
  const f = fixture();
  try {
    f.controller.select(owner()); f.controller.setEnabled(true); await flush();
    for (let i = 0; i < 15; i++) await f.controller.refresh();
    assert.deepEqual(f.calls, { head: 16, messages: 1, queue: 1, run: 1, connected: 0, closed: 0 });
  } finally { f.controller.dispose(); }
});

test("an active head does not replace a healthy stream or fetch accumulated process text", async () => {
  const f = fixture();
  f.setHead({ ...f.head, latest_run: { run_id: "R", status: "running", seq: 1 } });
  try {
    f.controller.select(owner()); f.controller.setEnabled(true); await flush();
    f.setHead({ ...f.head, latest_run: { run_id: "R", status: "running", seq: 100 } });
    await f.controller.refresh();
    assert.equal(f.calls.run, 1); assert.equal(f.calls.connected, 1); assert.equal(f.calls.closed, 0);
  } finally { f.controller.dispose(); }
});

test("queue revision refreshes edits even when the queue length is unchanged", async () => {
  const f = fixture();
  try {
    f.controller.select(owner()); f.controller.setEnabled(true); await flush();
    f.setHead({ ...f.head, queue_revision: "edited" }); await f.controller.refresh();
    assert.equal(f.calls.queue, 2); assert.equal(f.calls.messages, 1); assert.equal(f.calls.run, 1);
  } finally { f.controller.dispose(); }
});

test("account/origin/session ownership rejects late history and command results", async () => {
  for (const next of [{ ...owner(), sessionId: undefined, account: "other" }, owner("S", "other"), owner("S", "account", "https://other.invalid")]) {
    const read = deferred(), post = deferred();
    const f = fixture({ messages: () => read.promise, startRun: () => post.promise });
    try {
      f.controller.select(owner()); f.controller.setEnabled(true); await flush();
      const sending = f.controller.send("hello");
      f.controller.setEnabled(false); f.controller.select(next);
      read.resolve([{ id: "private", content: "old-account" }]);
      post.resolve(run("old", "running")); await sending; await flush();
      assert.equal(f.controller.getSnapshot().owner.account, next.account);
      assert.equal(f.controller.getSnapshot().run, null);
      assert.ok(!f.controller.getSnapshot().messages.some((message) => message.content === "hello"));
    } finally { f.controller.dispose(); }
  }
});

test("first turn adoption and route acknowledgement retain live state and message identity", async () => {
  const f = fixture();
  f.setHead({ ...f.head, latest_run: { run_id: "R2", status: "running", seq: 1 } });
  try {
    f.controller.select({ ...owner(), sessionId: undefined }); f.controller.setEnabled(true);
    const created = await f.controller.createAndSend("hello");
    assert.equal(created.session.id, "S");
    const accepted = f.controller.getSnapshot();
    f.controller.select(owner());
    assert.equal(f.controller.getSnapshot().run, accepted.run);
    assert.equal(f.controller.getSnapshot().messages, accepted.messages);
    assert.equal(f.controller.getSnapshot().adoptedFrom, undefined);
  } finally { f.controller.dispose(); }
});

test("session writes serialize independent patches and cannot resolve in reverse order", async () => {
  const first = deferred(), calls = [];
  const f = fixture({ updateSession: async (_id, patch) => {
    calls.push(patch);
    if (calls.length === 1) await first.promise;
    f.setHead({ ...f.head, session: { ...f.head.session, ...patch } });
    return f.head.session;
  } });
  try {
    f.controller.select(owner()); f.controller.setEnabled(true); await flush();
    const a = f.controller.updateSession({ model_id: "chosen" });
    const b = f.controller.updateSession({ effort: "high" });
    await flush();
    assert.deepEqual(calls, [{ model_id: "chosen" }]);
    first.resolve(); await Promise.all([a, b]);
    assert.deepEqual(calls, [{ model_id: "chosen" }, { effort: "high" }]);
    assert.equal(f.controller.getSnapshot().session.model_id, "chosen");
    assert.equal(f.controller.getSnapshot().session.effort, "high");
  } finally { f.controller.dispose(); }
});

test("switching owner drops queued writes before dispatch and ignores the old in-flight result", async () => {
  const first = deferred(), calls = [];
  const f = fixture({ updateSession: async (id, patch) => { calls.push([id, patch]); await first.promise; return { ...f.head.session, ...patch }; } });
  try {
    f.controller.select(owner());
    const a = f.controller.updateSession({ model_id: "old" });
    const b = f.controller.updateSession({ effort: "high" });
    await flush(); f.controller.select({ ...owner(), sessionId: undefined, draftId: "another" });
    first.resolve(); await Promise.all([a, b]);
    assert.equal(calls.length, 1); assert.equal(f.controller.getSnapshot().session, null);
  } finally { f.controller.dispose(); }
});

test("terminal arriving during a head request immediately repeats the invalidated read", async () => {
  const pending = deferred(); let count = 0;
  const f = fixture({ sessionHead: async () => ++count === 2 ? pending.promise : f.head });
  f.setHead({ ...f.head, latest_run: { run_id: "R", status: "running", seq: 1 } });
  try {
    f.controller.select(owner()); f.controller.setEnabled(true); await flush();
    const polling = f.controller.refresh(); await flush();
    f.setHead({ ...f.head, latest_run: { run_id: "R", status: "completed", seq: 2 }, history_revision: "done" });
    f.setHistory([{ id: "new", role: "assistant", content: "Terminal persisted" }]);
    f.handlers[0].onEvent({ kind: "status", value: { run_id: "R", seq: 2, status: "completed" } });
    pending.resolve({ ...f.head, history_revision: "stale" }); await polling; await flush();
    assert.equal(count, 3);
    assert.equal(f.controller.getSnapshot().messages[0].content, "Terminal persisted");
  } finally { f.controller.dispose(); }
});

test("create completion cannot start a run or change a newly selected owner", async () => {
  const request = deferred(); let started = 0;
  const f = fixture({ createSession: () => request.promise, startRun: async () => { started++; return run(); } });
  try {
    f.controller.select({ ...owner(), sessionId: undefined });
    const created = f.controller.createAndSend("private draft");
    f.controller.select({ ...owner(), sessionId: undefined, draftId: "another" });
    request.resolve(f.head.session);
    assert.equal(await created, undefined); assert.equal(started, 0);
    assert.equal(f.controller.getSnapshot().session, null);
  } finally { f.controller.dispose(); }
});

test("a failed first turn retains the created session for retry without creating another", async () => {
  let created = 0;
  const f = fixture({ createSession: async () => { created++; return f.head.session; },
    startRun: async () => { throw new Error("fixture failure"); } });
  try {
    f.controller.select({ ...owner(), sessionId: undefined });
    const result = await f.controller.createAndSend("draft");
    assert.equal(result.session.id, "S"); assert.equal(result.error.message, "fixture failure");
    assert.equal(f.controller.getSnapshot().session.id, "S");
    assert.equal(f.controller.getSnapshot().posting, false);
    assert.equal(await f.controller.createAndSend("retry"), undefined); assert.equal(created, 1);
  } finally { f.controller.dispose(); }
});

test("explicit final phases give exactly one answer, preserve sources and interrupted public text", () => {
  const snapshot = { ...run(), items: [text("a", "Checking", "commentary"), text("b", "First paragraph"), text("c", "Second paragraph")] };
  assert.equal(publicReply(snapshot), "First paragraph\n\nSecond paragraph");
  assert.deepEqual(projectRun(snapshot).finalEntries.map((item) => item.id), ["b", "c"]);
  assert.equal(projectRun(snapshot).plan.canRollUp, true);
  assert.equal(publicReply({ ...snapshot, status: "interrupted" }), "Checking\n\nFirst paragraph\n\nSecond paragraph");
  assert.equal(publicReply({ ...run(), items: [text("a", "Hello ", "final", "provider-1"), text("b", "world", "final", "provider-1")] }), "Hello world");
});

test("metadata patches retain occurrence sequence and unaffected reading identities", () => {
  const first = text("a", "Checking", "pending"), other = text("b", "Other");
  const initial = { ...run("R", "running", 1), items: [first, other] };
  const priorView = projectRun(initial);
  const next = reduceRunDelta(initial, { kind: "item_updated", value: { run_id: "R", seq: 2, updated_at: "",
    patches: [{ item_id: "a", phase: "commentary", state: "completed" }] } });
  assert.equal(next.items[0].seq, 1); assert.equal(next.items[1], other);
  assert.equal(projectRun(next).entries[1], priorView.entries[1]);
  assert.equal(reduceRunDelta(next, { kind: "item_delta", value: { run_id: "R", seq: 2, item_id: "a", delta: "duplicate" } }), next);
});

test("needs_user is completed execution but never grouped with successful tools", () => {
  assert.equal(toolGroupFamily({ id: "a", name: "browser_goto", status: "completed", outcome: "needs_user" }), null);
  assert.equal(toolGroupFamily({ id: "b", name: "browser_goto", status: "completed", outcome: "success" }), "browser");
});

test("sequence gap recovers once; old/foreign events cannot overwrite recovered state", async () => {
  const handlers = [], request = deferred();
  const stream = createRunStream({ run: () => request.promise, connect: (_id, h) => { handlers.push(h); return () => {}; } });
  try {
    stream.follow(run("R", "running", 1)); stream.setEnabled(true);
    handlers[0].onEvent({ kind: "item_delta", value: { run_id: "R", seq: 3, item_id: "a", delta: "gap" } });
    request.resolve({ ...run("R", "running", 4), items: [text("a", "Canonical")] }); await flush();
    handlers[0].onEvent({ kind: "item_delta", value: { run_id: "R", seq: 5, item_id: "a", delta: "stale" } });
    assert.equal(stream.getCurrent().items[0].text, "Canonical"); assert.equal(handlers.length, 2);
    handlers[1].onEvent({ kind: "status", value: { run_id: "foreign", seq: 5, status: "completed" } });
    assert.equal(stream.getCurrent().status, "running");
  } finally { stream.dispose(); }
});

test("shared run detail is lazy, retains a live panel and replaces it only with authoritative terminal items", async () => {
  let reads = 0; const request = deferred();
  const resource = createRunDetail({ run: () => { reads++; return request.promise; } });
  resource.select("R", null, "completed", false); resource.setEnabled(true);
  assert.equal(reads, 0);
  const active = { ...run("R", "running", 2), items: [text("a", "Partial", "pending")] };
  resource.select("R", active, "running", false); assert.equal(reads, 0);
  resource.select("R", null, "completed", false);
  assert.equal(reads, 1); assert.equal(resource.getSnapshot().snapshot, active);
  const terminal = { ...run("R", "completed", 3), items: [text("a", "Final")] };
  request.resolve(terminal); await flush();
  assert.equal(resource.getSnapshot().snapshot, terminal); assert.equal(resource.getSnapshot().loading, false);
  resource.select("R", active, "completed", true);
  assert.equal(resource.getSnapshot().snapshot, terminal); assert.equal(reads, 1);
  resource.setEnabled(false);
});

test("shared detail retries transient failures three times and exposes an explicit retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const resource = createRunDetail({ run: async () => { reads++; throw new Error("offline"); } });
  resource.select("R", run("R", "running", 1), "completed", false); resource.setEnabled(true); await flush();
  t.mock.timers.tick(500); await flush(); t.mock.timers.tick(1500); await flush();
  assert.equal(reads, 3); assert.equal(resource.getSnapshot().failed, true); assert.equal(resource.getSnapshot().loading, false);
  resource.retry(); await flush(); assert.equal(reads, 4);
  resource.setEnabled(false); t.mock.timers.tick(30_000); await flush(); assert.equal(reads, 4);
});

test("run detail invalidates requests on ownership change, stop and superseding supplied snapshot", async () => {
  const old = deferred(); let signal;
  const resource = createRunDetail({ run: (_id, value) => { signal = value; return old.promise; } });
  resource.select("R", null, "completed", true); resource.setEnabled(true);
  resource.select("R2", null, "completed", false);
  assert.equal(signal.aborted, true); old.resolve(run("R")); await flush();
  assert.equal(resource.getSnapshot().snapshot, null);
  const fresh = run("R2", "completed", 10);
  resource.select("R2", fresh, "completed", false);
  assert.equal(resource.getSnapshot().snapshot, fresh);
  resource.setEnabled(false);
});
