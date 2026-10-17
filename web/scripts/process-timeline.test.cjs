const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function load(file, imports = {}, tail = "", globals = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output + tail, {
    module, exports: module.exports, URL, ...globals,
    require(name) { if (name in imports) return imports[name]; throw new Error(`Unexpected import ${name}`); },
  }, { filename: file });
  return module.exports;
}

const process = load("src/lib/processTimeline.ts");
const { reduceRunDelta } = load("src/lib/runReducer.ts", { "./processTimeline": process });
const { projectChatMessages, chatMessageKey } = load("src/lib/chatProjection.ts");
const { parseRunEvent } = load("src/lib/sse.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));
const snapshot = (patch = {}) => ({ run_id: "A", session_id: "S", seq: 0, status: "running", output: "", steps: [], timeline: [], updated_at: "", ...patch });
const reasoning = (id, seq, text = "Thinking") => ({ id, seq, kind: "reasoning", reasoning: { id, kind: "reasoning", text, done: false } });
const progress = (id, seq, text = "Checking sources") => ({ id, seq, kind: "progress", text });
const tool = (id, seq, name = "exec", status = "completed", output) => ({ id, seq, kind: "tool", step: { id, name, status, output, arguments: { command: `echo ${id}` } } });

test("public text keeps the same timeline occurrence across commit and combined timeline updates", () => {
  const pending = { ...progress("P1", 1, "Checking"), pending: true };
  const updatedAt = "2026-10-16T10:00:01Z";
  const delta = parseRunEvent({ type: "text_delta", data: JSON.stringify({ type: "text_delta", run_id: "A", seq: 1, text: "Checking", updated_at: updatedAt, timeline_entry: pending }) });
  const working = reduceRunDelta(snapshot(), delta);
  assert.equal(working.output, "Checking");
  assert.equal(working.timeline[0].pending, true);
  assert.equal(working.updated_at, updatedAt);
  const committed = { ...pending, pending: false, final: true };
  const commit = parseRunEvent({ type: "output_commit", data: JSON.stringify({ type: "output_commit", run_id: "A", seq: 2, text: "Checking", updated_at: "2026-10-16T10:00:02Z", timeline: [pending], timeline_entry: committed }) });
  const final = reduceRunDelta(working, commit);
  assert.equal(final.output, "Checking");
  assert.deepEqual(plain(final.timeline), [committed]);
  assert.equal(final.updated_at, "2026-10-16T10:00:02Z");
  const textOnly = reduceRunDelta(working, { kind: "output_commit", value: { seq: 2, text: "Checking" } });
  assert.equal(textOnly.timeline, working.timeline, "a missing timeline is not an instruction to discard public blocks");
});

test("late commentary classification preserves chronology and replaces the answer buffer", () => {
  const pending = { ...progress("P1", 1, "Sources"), pending: true };
  const after = reasoning("R1", 2);
  const event = parseRunEvent({ type: "progress", data: JSON.stringify({ type: "progress", run_id: "A", seq: 3, text: "Real answer", updated_at: "2026-10-16T10:00:03Z", timeline_entry: { ...pending, pending: false } }) });
  const next = reduceRunDelta(snapshot({ output: "SourcesReal answer", timeline: [pending, after] }), event);
  assert.equal(next.output, "Real answer");
  assert.equal(next.timeline[0].seq, 1);
  assert.equal(next.timeline[0].pending, false);
  assert.equal(next.timeline[1], after);
});

test("reasoning full upsert does not append twice or move its original slot", () => {
  const first = reasoning("R1", 1), command = tool("T1", 2), nextThought = reasoning("R2", 3);
  const next = reduceRunDelta(snapshot({ reasoning: [first.reasoning, nextThought.reasoning], timeline: [first, command, nextThought] }), {
    kind: "reasoning_delta", value: { seq: 4, reasoning: { ...first.reasoning, text: " more" }, timeline_entry: { ...first, seq: 4, reasoning: { ...first.reasoning, text: "Thinking more" } } },
  });
  assert.deepEqual(Array.from(next.timeline, (entry) => entry.id), ["R1", "T1", "R2"]);
  assert.equal(next.timeline[0].seq, 1);
  assert.equal(next.timeline[0].reasoning.text, "Thinking more");
  assert.equal(next.reasoning[0].text, "Thinking more");
  assert.equal(next.timeline[1], command);
});

test("step completion updates in place before later reasoning", () => {
  const command = tool("T1", 2, "exec", "running"), thought = reasoning("R1", 3);
  const next = reduceRunDelta(snapshot({ timeline: [command, thought], steps: [command.step] }), {
    kind: "step", value: { seq: 4, step: { ...command.step, status: "completed" }, timeline_entry: { ...command, seq: 4, step: { ...command.step, status: "completed" } } },
  });
  assert.equal(next.timeline[0].seq, 2);
  assert.equal(next.timeline[0].step.status, "completed");
  assert.equal(next.timeline[1], thought);
});

test("promoted public reply keeps the first-text position despite later output_reset", () => {
  const thought = reasoning("R1", 3), command = tool("T1", 5);
  const next = reduceRunDelta(snapshot({ output: "Checking sources", timeline: [thought, command] }), {
    kind: "output_reset", value: { seq: 6, timeline: [command, progress("P1", 2), thought] },
  });
  assert.equal(next.output, "");
  assert.deepEqual(Array.from(next.timeline, (entry) => entry.kind), ["progress", "reasoning", "tool"]);
  assert.equal(next.timeline[0].text, "Checking sources");
});

test("final output is separate from progress and terminal timeline repairs states", () => {
  const command = tool("T1", 2, "exec", "running"), note = progress("P1", 1, "Searching");
  const next = reduceRunDelta(snapshot({ output: "Final answer", timeline: [note, command] }), {
    kind: "status", value: { seq: 7, status: "completed", timeline: [note, { ...command, step: { ...command.step, status: "completed" } }] },
  });
  assert.equal(next.output, "Final answer");
  assert.equal(next.timeline.some((entry) => entry.text === next.output), false);
  assert.equal(next.timeline[1].step.status, "completed");
});

test("text deltas retain the empty timeline and an authoritative reset clears process without reconstructing it", () => {
  const timeline = [];
  const next = reduceRunDelta(snapshot({ timeline }), { kind: "text_delta", value: { seq: 1, text: "Hello" } });
  assert.equal(next.timeline, timeline);
  assert.equal(process.processHasContent(next.timeline), false);
  const thought = reasoning("R1", 1), command = tool("T1", 2);
  const reset = reduceRunDelta(snapshot({ timeline: [thought, command], reasoning: [thought.reasoning], steps: [command.step] }), {
    kind: "output_reset", value: { seq: 3, timeline: [] },
  });
  assert.equal(reset.reasoning.length, 1);
  assert.equal(reset.steps.length, 1);
  assert.equal(process.processHasContent(reset.timeline), false);
});

test("current waiting payload pauses for input and running status clears it without losing Computer permission", () => {
  const input = { kind: "question", question: "Which file?", options: ["Report", "Notes"] };
  const waiting = parseRunEvent({ type: "waiting", data: JSON.stringify({ type: "waiting", run_id: "A", seq: 1, status: "waiting_user", waiting_input: input }) });
  const paused = reduceRunDelta(snapshot({ computer_granted: true }), waiting);
  assert.equal(paused.status, "waiting_user");
  assert.deepEqual(plain(paused.waiting_input), input);
  assert.equal(paused.computer_granted, true);
  const resumed = reduceRunDelta(paused, { kind: "status", value: { run_id: "A", seq: 2, status: "running", computer_granted: false } });
  assert.equal(resumed.waiting_input, undefined);
  assert.equal(resumed.computer_granted, false);
  assert.equal(reduceRunDelta(resumed, { kind: "status", value: { run_id: "A", seq: 3, status: "waiting_resource" } }).status, "waiting_resource");
});

test("public progress alone counts as process; final answer alone does not", () => {
  assert.equal(process.processHasContent([progress("P1", 1)]), true);
  assert.equal(process.processHasContent([]), false);
});

test("only consecutive same-family tools are grouped with a stable first id", () => {
  const entries = [tool("T1", 1), tool("T2", 2), reasoning("R1", 3), tool("T3", 4), tool("T4", 5, "files_read"), tool("T5", 6, "files_write")];
  const rows = process.groupProcessEntries(entries);
  assert.deepEqual(Array.from(rows, (row) => row.kind), ["tools", "entry", "entry", "tools"]);
  assert.equal(rows[0].id, "T1");
  assert.deepEqual(Array.from(rows[0].entries, (entry) => entry.id), ["T1", "T2"]);
  assert.equal(rows[3].family, "files");
});

test("thinking and public progress each break adjacent-tool aggregation", () => {
  for (const boundary of [reasoning("R1", 2), progress("P1", 2)]) {
    const rows = process.groupProcessEntries([tool("T1", 1), boundary, tool("T2", 3)]);
    assert.equal(rows.length, 3);
    assert.equal(rows.every((row) => row.kind === "entry"), true);
  }
});

test("failed and nonzero-exit tools remain individually visible boundaries", () => {
  for (const bad of [tool("bad", 2, "exec", "failed"), tool("bad", 2, "exec", "completed", '{"exit_code":1}')]) {
    const rows = process.groupProcessEntries([tool("T1", 1), bad, tool("T2", 3)]);
    assert.equal(rows.length, 3);
    assert.equal(rows[1].kind, "entry");
  }
});

test("permission and user-input requests do not disappear inside a generic group", () => {
  for (const name of ["request_computer_permission", "request_user_input"]) {
    const rows = process.groupProcessEntries([tool("T1", 1, "computer_click"), tool("P1", 2, name, "running"), tool("T2", 3, "computer_scroll")]);
    assert.equal(rows.length, 3);
    assert.equal(rows[1].kind, "entry");
  }
});

test("each search query and subsequent page read stay separate", () => {
  const rows = process.groupProcessEntries([tool("S1", 1, "web_search"), tool("S2", 2, "web_search"), tool("F1", 3, "web_fetch"), tool("F2", 4, "web_fetch")]);
  assert.equal(rows.length, 4);
});

test("normal search output has one query and compact safe results, no secret-bearing endpoint fields", () => {
  const output = { query: "test", provider: "exa", count: 2, endpoint: "private-config", results: [{ title: "Docs", url: "https://example.com/docs", description: "Read docs", published_at: "2026-10-13" }, { title: "Again", url: "https://example.com/docs" }] };
  const parsed = process.parseSearchOutput({ name: "web_search", status: "completed", output: JSON.stringify(output) });
  assert.deepEqual(plain(parsed), { query: "test", results: [output.results[0]] });
});

test("search rejects unsafe protocols, URL credentials and local/private icon targets", () => {
  const unsafe = ["javascript:alert(1)", "data:image/svg+xml,x", "file:///etc/passwd", "https://user:secret@example.com/x", "http://localhost/x", "http://127.0.0.1/x", "http://10.1.2.3/x", "http://192.168.1.1/x", "http://172.16.0.1/x", "http://169.254.1.1/x", "http://[::1]/x", "https://host.internal/x"];
  for (const url of unsafe) assert.equal(process.publicWebUrl(url), null, url);
  assert.equal(process.publicWebUrl("https://example.com/path?q=hello"), "https://example.com/path?q=hello");
});

test("search parser ignores malformed output and non-search steps", () => {
  assert.equal(process.parseSearchOutput({ name: "web_search", output: "bad" }), null);
  assert.equal(process.parseSearchOutput({ name: "exec", output: '{"results":[]}' }), null);
});

test("search URL safety normalizes terminal dots and validates DNS labels/ports before requesting icons", () => {
  for (const url of ["http://localhost./x", "https://printer.local./x", "https://host.internal./x", "http://127.1/x", "http://2130706433/x", "https://example..com/x", "https://-bad.example/x", "https://bad-.example/x", "https://bad_host.example/x", `https://${"a".repeat(64)}.example/x`, "https://example.com:0/x", "https://example.com:65536/x", "https://example.com:invalid/x"]) {
    assert.equal(process.publicWebUrl(url), null, url);
  }
  assert.equal(process.publicWebUrl("https://example.com./path"), "https://example.com./path");
  assert.equal(process.publicWebUrl("https://example.com:65535/path"), "https://example.com:65535/path");
});

test("wire parser preserves additive timeline_entry and authoritative timeline on existing event kinds", () => {
  const value = { seq: 4, run_id: "A", timeline: [progress("P1", 1)] };
  const parsed = parseRunEvent({ type: "output_reset", data: JSON.stringify(value) });
  assert.equal(parsed.kind, "output_reset");
  assert.deepEqual(plain(parsed.value), value);
});

test("live process and persisted assistant use one stable host key without a duplicate final row", () => {
  const user = { id: "U1", role: "user", content: "Hello", created_at: "2026-10-13" };
  const state = snapshot({ output: "Final answer" });
  const live = projectChatMessages([user], state);
  const saved = { ...live[1], id: "database-message", created_at: "2026-10-13" };
  const persisted = projectChatMessages([user, saved], state);
  assert.equal(chatMessageKey(live[1]), chatMessageKey(saved));
  assert.equal(persisted.length, 2);
  assert.equal(persisted[1], saved);
});

test("new session projection has no inherited run and an empty live answer still owns the process host", () => {
  assert.deepEqual(plain(projectChatMessages([], null)), []);
  const live = projectChatMessages([], snapshot());
  assert.equal(live.length, 1);
  assert.equal(live[0].content, "");
  assert.equal(live[0].run_id, "A");
});

test("run artifacts project into the canonical message attachment field", () => {
  const files = [{ id: "image", url: "/api/files/image/content", mime_type: "image/png" }];
  const [message] = projectChatMessages([], snapshot({ artifacts: files }));
  assert.equal(message.attachments, files);
  assert.equal(Object.hasOwn(message, "artifacts"), false);
});

test("actual tool-group rendering inherits an expanded first detail on single-to-group growth", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { TestToolGroup } = load("src/components/ProcessTimeline.tsx", {
    react: React,
    "react/jsx-runtime": require("react/jsx-runtime"),
    "lucide-react": require("lucide-react"),
    "../lib/processTimeline": process,
    "./ProcessSteps": {
      toolIcon: () => null,
      StepCard: () => null,
      StepList: ({ expansion }) => React.createElement("span", null, expansion.T1 ? "first-detail-stays-open" : "closed"),
    },
    "./ThinkingDetails": { ThinkingContent: () => null },
    "./process-timeline.css": {},
  }, "\nexports.TestToolGroup = ToolGroup;");
  const row = process.groupProcessEntries([tool("T1", 1), tool("T2", 2)])[0];
  const props = { row, expansion: { T1: true }, onExpandedChange() {}, onStepExpandedChange() {} };
  const markup = renderToStaticMarkup(React.createElement(TestToolGroup, props));
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, /first-detail-stays-open/);
  const explicitlyClosed = renderToStaticMarkup(React.createElement(TestToolGroup, { ...props, expanded: false }));
  assert.match(explicitlyClosed, /aria-expanded="false"/);
  assert.doesNotMatch(explicitlyClosed, /first-detail-stays-open/);
});

test("actual image tool detail renders its delivered artifact and keeps failed generation output visible", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { StepCard } = load("src/components/ProcessSteps.tsx", {
    react: React,
    "react/jsx-runtime": require("react/jsx-runtime"),
    "lucide-react": require("lucide-react"),
    "../lib/processTimeline": process,
    "./FileCards": { FileCards: ({ files }) => React.createElement("span", { "data-files": files.map((file) => file.id).join(",") }, files.map((file) => file.name).join(",")) },
    "./Modal": { Modal: () => null },
    "./SearchSources": { SearchResults: () => null, SearchSiteIcons: () => null },
    "./execution.css": {},
  });
  const artifact = { id: "image-current", name: "generated.png", url: "/api/files/image-current/content", mime_type: "image/png", size: 1024 };
  const step = tool("I1", 1, "generate_image", "completed", JSON.stringify({ delivered: true, artifact, url: artifact.url })).step;
  const markup = renderToStaticMarkup(React.createElement(StepCard, { step, expanded: true }));
  assert.match(markup, /data-files="image-current"/);
  assert.match(markup, /generated\.png/);
  const failed = renderToStaticMarkup(React.createElement(StepCard, { step: { ...step, status: "failed", output: JSON.stringify({ error: "Generation failed" }) }, expanded: true }));
  assert.match(failed, /Generation failed/);
  assert.doesNotMatch(failed, /data-files=/);
});

function messageScrollHarness() {
  const frames = new Map();
  const listeners = new Map();
  const refs = [];
  let nextFrame = 0, resize;
  const scroll = {
    scrollTop: 440, scrollHeight: 1000, clientHeight: 500,
    dataset: {}, contains: () => false,
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); },
    scrollTo({ top }) { this.scrollTop = top; },
  };
  const jsx = (type, props) => ({ type, props });
  class Element {
    constructor(inner = false) { this.inner = inner; }
    closest(selector) { return this.inner && selector.includes(".process-viewport") ? this : null; }
  }
  let stateIndex = 0;
  const React = {
    memo: (component) => component,
    useCallback: (callback) => callback,
    useMemo: (callback) => callback(),
    useRef(value) {
      const index = refs.length;
      const ref = { current: index === 0 ? scroll : index === 1 ? {} : value };
      refs.push(ref);
      return ref;
    },
    useState(value) { return [stateIndex++ === 0 ? true : value, () => {}]; },
    useLayoutEffect: (callback) => callback(),
    useEffect: (callback) => callback(),
  };
  const { MessageList } = load("src/components/MessageList.tsx", {
    react: React,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "lucide-react": {},
    "../lib/api": { isActiveStatus: (status) => status === "running", userFacingRunError: () => "error" },
    "../lib/chatProjection": { chatMessageKey, projectChatMessages },
    "../lib/markdown": {},
    "../lib/runPresentation": {},
    "./MarkdownMessage": {}, "./UserMessage": {}, "./HistoryProcess": {},
    "./FileCards": {}, "./Composer": {}, "./WaitingInputCard": {}, "./chat.css": {},
  }, "", {
    Element, performance: { now: () => 0 },
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
    ResizeObserver: class { constructor(callback) { resize = callback; } observe() {} disconnect() {} },
    window: { matchMedia: () => ({ matches: false }), getSelection: () => null },
    document: { addEventListener() {}, removeEventListener() {} },
  });
  const tree = MessageList({ messages: [], snapshot: snapshot({ output: "Live" }), sessionId: "S", onResume() {} });
  const outer = tree.props.children[0].props;
  const jump = tree.props.children[1].props.onClick;
  return {
    outer, jump, frames, scroll, resize: () => resize(), layout: (detail) => listeners.get("ochi:transcript-layout")({ detail }),
    inner: new Element(true), outside: new Element(false),
    sticks: () => refs[2].current,
    inspecting: () => refs[3].current,
  };
}

test("actual parent callbacks keep inner wheel/touch reading paused after near-bottom clamps and growth", () => {
  for (const handler of ["onWheel", "onTouchMove"]) {
    const harness = messageScrollHarness();
    assert.equal(harness.frames.size, 1, "outer follow was queued before the gesture");
    harness.outer[handler]({ target: harness.inner });
    assert.equal(harness.frames.size, 0, "inner gesture cancels queued outer follow");
    assert.equal(harness.inspecting(), true);
    assert.equal(harness.sticks(), false);
    harness.outer.onScroll();
    assert.equal(harness.sticks(), false, "near-bottom clamp must not override detail reading");
    harness.scroll.scrollHeight = 1400;
    harness.resize();
    assert.equal(harness.frames.size, 0);
    assert.equal(harness.scroll.scrollTop, 440, "new answer height does not grab the outer tail");
  }
});

test("a transcript layout transaction cancels tail following until final-block anchor restoration finishes", () => {
  const harness = messageScrollHarness();
  assert.equal(harness.frames.size, 1);
  harness.layout("begin");
  assert.equal(harness.frames.size, 0);
  harness.scroll.scrollHeight = 1300;
  harness.resize();
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.scroll.scrollTop, 440);
  harness.layout("end");
  harness.resize();
  assert.equal(harness.frames.size, 1);
});

test("actual parent keyboard callback never resumes outer follow for inner navigation keys", () => {
  for (const key of ["Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", " ", "Enter"]) {
    const harness = messageScrollHarness();
    harness.outer.onKeyDownCapture({ target: harness.inner, key });
    assert.equal(harness.frames.size, 0, key);
    assert.equal(harness.inspecting(), true, key);
    harness.outer.onScroll();
    assert.equal(harness.sticks(), false, key);
    harness.scroll.scrollHeight = 1400;
    harness.resize();
    assert.equal(harness.frames.size, 0, key);
    assert.equal(harness.scroll.scrollTop, 440, key);
  }
});

test("outer gestures or explicit latest action can deliberately resume follow after inner reading", () => {
  const harness = messageScrollHarness();
  harness.outer.onWheel({ target: harness.inner });
  harness.outer.onWheel({ target: harness.outside });
  assert.equal(harness.inspecting(), false);
  harness.outer.onScroll();
  assert.equal(harness.sticks(), true);
  harness.resize();
  assert.equal(harness.frames.size, 1);
  harness.outer.onTouchMove({ target: harness.inner });
  assert.equal(harness.frames.size, 0);
  harness.jump();
  assert.equal(harness.inspecting(), false);
  assert.equal(harness.sticks(), true);
  assert.equal(harness.scroll.scrollTop, harness.scroll.scrollHeight);
});

test("outer chat scroll ownership opts out of competing browser scroll anchoring", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../src/components/chat.css"), "utf8");
  const outer = css.match(/\.messages-scroll\s*\{([^}]*)\}/)?.[1];
  assert.match(outer ?? "", /overflow-anchor\s*:\s*none\s*;/);
});

test("waiting actions and a removal clamp preserve outer reading while final text and footer grow", () => {
  const harness = messageScrollHarness();
  harness.scroll.scrollHeight = 1888;
  harness.scroll.clientHeight = 729;
  harness.scroll.scrollTop = 1142.5;
  harness.outer.onWheel({ target: harness.inner });
  // Choosing and submitting a waiting answer is not an outer scroll gesture.
  for (let action = 0; action < 2; action += 1) {
    harness.outer.onPointerDownCapture({ target: harness.outside, currentTarget: harness.scroll });
  }
  harness.scroll.scrollHeight = 1695;
  harness.scroll.scrollTop = 966; // Removing the waiting card clamps to the new scroll maximum.
  harness.outer.onScroll();
  harness.resize();
  assert.equal(harness.inspecting(), true);
  for (const height of [1741, 1953]) {
    harness.scroll.scrollHeight = height;
    harness.outer.onScroll();
    harness.resize();
    assert.equal(harness.inspecting(), true);
    assert.equal(harness.sticks(), false);
    assert.equal(harness.frames.size, 0);
    assert.equal(harness.scroll.scrollTop, 966, "final reply growth cannot move an outer reader after the clamp");
  }
});
