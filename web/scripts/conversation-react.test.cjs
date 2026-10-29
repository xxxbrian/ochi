const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://client.example.invalid/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const React = require("react");
const { render, act, cleanup, fireEvent } = require("@testing-library/react");
const { createLoader } = require("../../shared/conversation/test-loader.cjs");
const root = path.resolve(__dirname, "../..");
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
function fixture() {
  const session = { id: "S", title: "Session", updated_at: "1", computer_enabled: false };
  const snapshot = { run_id: "R", session_id: "S", status: "running", seq: 1, items: [], created_at: "", updated_at: "" };
  const handlers = [], calls = { open: 0, close: 0 };
  let response = snapshot, history = [];
  const transport = {
    sessionHead: async () => ({ session, latest_run: { run_id: "R", seq: response.seq, status: response.status },
      history_revision: "1", queue_revision: "1" }),
    messages: async () => history, queue: async () => [], run: async () => response,
    createSession: async () => session, startRun: async () => response,
    connect(_id, h) { handlers.push(h); calls.open++; return () => calls.close++; },
    runInstructions: async () => [], supplementRun: async () => {},
  };
  const load = createLoader(require("typescript"), require, {
    [path.join(root, "web/src/lib/api.ts")]: { API_BASE: "" },
    [path.join(root, "web/src/lib/runTransport.ts")]: { conversationTransport: transport },
  });
  const { useConversation } = load(path.join(root, "web/src/hooks/useConversation.ts"));
  let current;
  const callbacks = { onSessionChanged() {}, onExpired() {} };
  function Screen({ account = "A", sessionId, draftId = "draft" }) {
    current = useConversation(account, sessionId, draftId, callbacks);
    return React.createElement("main", {}, React.createElement("input", { "aria-label": "Composer", defaultValue: "" }),
      React.createElement("output", {}, `${current.owner.account}:${current.run?.run_id ?? ""}:${current.run?.seq ?? ""}`));
  }
  return { Screen, handlers, calls, get current() { return current; }, setResponse(value) { response = value; },
    setHistory(value) { history = value; } };
}
test.afterEach(() => cleanup());

test("real React StrictMode restarts ownership and stream lifecycle without disposing the shared store", async () => {
  const f = fixture(); let view;
  await act(async () => { view = render(React.createElement(React.StrictMode, {}, React.createElement(f.Screen, { sessionId: "S" }))); await flush(); });
  assert.equal(f.current.run.run_id, "R"); assert.equal(f.calls.open - f.calls.close, 1);
  const input = view.getByRole("textbox");
  input.focus(); fireEvent.change(input, { target: { value: "keep draft" } });
  await act(async () => {
    const h = f.handlers.at(-1);
    h.onEvent({ kind: "item_started", value: { run_id: "R", seq: 2, item: { id: "text", seq: 1, kind: "text",
      text: "", source_id: "provider", round_id: "round", phase: "pending", state: "streaming" } } });
    for (let seq = 3; seq < 103; seq++) h.onEvent({ kind: "item_delta", value: { run_id: "R", seq, item_id: "text", delta: "x" } });
    await new Promise((resolve) => setTimeout(resolve, 65));
  });
  assert.equal(f.current.run.items[0].text.length, 100);
  assert.equal(view.getByRole("textbox"), input); assert.equal(input.value, "keep draft"); assert.equal(document.activeElement, input);
  assert.equal(f.calls.open - f.calls.close, 1);
  await act(async () => view.unmount());
  assert.equal(f.calls.open, f.calls.close);
});

test("owner switching never renders another account's old process and closes its stream", async () => {
  const f = fixture(); let view;
  await act(async () => { view = render(React.createElement(f.Screen, { sessionId: "S" })); await flush(); });
  const stale = f.handlers.at(-1);
  await act(async () => { view.rerender(React.createElement(f.Screen, { account: "B", draftId: "empty" })); await flush(); });
  assert.equal(f.current.owner.account, "B"); assert.equal(f.current.run, null); assert.deepEqual(f.current.messages, []);
  await act(async () => stale.onEvent({ kind: "status", value: { run_id: "R", seq: 2, status: "completed" } }));
  assert.equal(f.current.run, null); assert.equal(view.container.querySelector("output").textContent, "B::");
  assert.equal(f.calls.open, f.calls.close);
});

test("first-turn route acknowledgement keeps the React composer host and live stream", async () => {
  const f = fixture(); let view;
  await act(async () => { view = render(React.createElement(f.Screen, {})); await flush(); });
  const input = view.getByRole("textbox"); input.focus(); fireEvent.change(input, { target: { value: "draft" } });
  let result;
  await act(async () => { result = await f.current.controller.createAndSend("first"); await flush(); });
  assert.equal(result.session.id, "S");
  const run = f.current.run; const opens = f.calls.open;
  await act(async () => { view.rerender(React.createElement(f.Screen, { sessionId: "S" })); await flush(); });
  assert.equal(f.current.run, run); assert.equal(f.calls.open, opens);
  assert.equal(view.getByRole("textbox"), input); assert.equal(document.activeElement, input); assert.equal(input.value, "draft");
});
