const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { create, act } = require("react-test-renderer");
const { createLoader } = require("../../shared/conversation/test-loader.cjs");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const root = path.resolve(__dirname, "../..");
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
function fixture(overrides = {}) {
  let user = { id: "A" }, origin = "https://example.invalid";
  const appListeners = new Set(), handlers = [];
  const calls = { opened: 0, closed: 0 };
  const AppState = { currentState: "active", addEventListener(_event, listener) {
    appListeners.add(listener); return { remove: () => appListeners.delete(listener) };
  } };
  const session = { id: "S", title: "Session", updated_at: "1", computer_enabled: false };
  const snapshot = { run_id: "R", session_id: "S", seq: 1, status: "running", items: [], created_at: "", updated_at: "" };
  const transport = {
    sessionHead: async () => ({ session, latest_run: { run_id: "R", seq: 1, status: "running" }, history_revision: "1", queue_revision: "1" }),
    messages: async () => [], queue: async () => [], run: async () => snapshot,
    createSession: async () => session, startRun: async () => snapshot,
    connect(_id, h) { calls.opened++; handlers.push(h); return () => calls.closed++; },
    runInstructions: async () => [], supplementRun: async () => {},
    ...overrides,
  };
  const load = createLoader(require("typescript"), require, {
    "react-native": { AppState },
    [path.join(root, "mobile/src/providers/AppProvider.tsx")]: { useApp: () => ({ user, invalidateLists() {} }) },
    [path.join(root, "mobile/src/lib/errors.ts")]: { errorForDisplay: (error) => error.message },
    [path.join(root, "mobile/src/lib/api.ts")]: { api: { me: async () => user }, getAPIBaseURL: () => origin },
    [path.join(root, "mobile/src/lib/runTransport.ts")]: { conversationTransport: transport },
  });
  const { useSessionChat } = load(path.join(root, "mobile/src/hooks/useSessionChat.ts"));
  let current, mounts = 0;
  function ComposerHost() { React.useEffect(() => { mounts++; }, []); return React.createElement("TextInput", { value: "retained draft" }); }
  function Screen({ sessionId, focused = true, draftId }) {
    current = useSessionChat(sessionId, focused, draftId);
    return React.createElement(React.Fragment, {}, React.createElement(ComposerHost), React.createElement("Status", { run: current.run }));
  }
  return { Screen, calls, handlers, appListeners, get current() { return current; }, get mounts() { return mounts; },
    setUser(value) { user = value; }, setOrigin(value) { origin = value; },
    foreground(value) { AppState.currentState = value; for (const listener of appListeners) listener(value); } };
}

test("native hook uses real React StrictMode and reconnects after AppState resume", async () => {
  const f = fixture(); let tree;
  await act(async () => { tree = create(React.createElement(React.StrictMode, {}, React.createElement(f.Screen, { sessionId: "S" }))); await flush(); });
  try {
    assert.equal(f.current.run.run_id, "R"); assert.equal(f.calls.opened - f.calls.closed, 1);
    const mounts = f.mounts;
    await act(async () => f.foreground("background"));
    assert.equal(f.calls.opened, f.calls.closed);
    await act(async () => { f.foreground("active"); await flush(); });
    assert.equal(f.calls.opened - f.calls.closed, 1); assert.equal(f.mounts, mounts);
    await act(async () => {
      f.handlers.at(-1).onEvent({ kind: "status", value: { run_id: "R", seq: 2, status: "waiting_resource", resource: "computer" } });
      await new Promise((resolve) => setTimeout(resolve, 65));
    });
    assert.equal(f.current.run.resource, "computer");
  } finally { await act(async () => tree.unmount()); }
  assert.equal(f.calls.opened, f.calls.closed); assert.equal(f.appListeners.size, 0);
});

test("native first turn adoption retains composer lifecycle; account/origin changes clear old state", async () => {
  const f = fixture(); let tree;
  await act(async () => { tree = create(React.createElement(f.Screen, {})); await flush(); });
  try {
    const mounts = f.mounts;
    await act(async () => { await f.current.createAndSend("hello"); await flush(); });
    const run = f.current.run;
    await act(async () => { tree.update(React.createElement(f.Screen, { sessionId: "S" })); await flush(); });
    assert.equal(f.current.run, run); assert.equal(f.mounts, mounts);
    f.setUser({ id: "B" }); f.setOrigin("https://other.invalid");
    await act(async () => { tree.update(React.createElement(f.Screen, {})); await flush(); });
    assert.equal(f.current.owner.account, "B"); assert.equal(f.current.run, null); assert.deepEqual(f.current.messages, []);
  } finally { await act(async () => tree.unmount()); }
});

test("native new draft owns delayed session creation without replacing the composer", async () => {
  let resolveCreate, starts = 0;
  const f = fixture({
    createSession: () => new Promise((resolve) => { resolveCreate = resolve; }),
    startRun: async () => { starts++; throw new Error("stale draft must not send"); },
  });
  let tree, creating;
  await act(async () => { tree = create(React.createElement(f.Screen, { draftId: "project-a:0" })); await flush(); });
  try {
    const mounts = f.mounts;
    await act(async () => { creating = f.current.createAndSend("old draft"); await flush(); });
    assert.equal(f.current.posting, true);
    await act(async () => { tree.update(React.createElement(f.Screen, { draftId: "project-a:1" })); await flush(); });
    await act(async () => {
      resolveCreate({ id: "S", title: "Old draft", updated_at: "1", computer_enabled: false });
      await creating; await flush();
    });
    assert.equal(await creating, undefined);
    assert.equal(starts, 0); assert.equal(f.current.run, null); assert.equal(f.current.session, null);
    assert.equal(f.current.posting, false); assert.equal(f.mounts, mounts);
    assert.equal(f.current.owner.draftId, "project-a:1");
  } finally { await act(async () => tree.unmount()); }
});
