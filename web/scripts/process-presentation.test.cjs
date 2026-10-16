const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function load(file, imports = {}, globals = {}, tail = "") {
  const source = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output + tail, {
    module, exports: module.exports, ...globals,
    require(name) { if (name in imports) return imports[name]; throw new Error(`Unexpected import ${name}`); },
  });
  return module.exports;
}

const timing = load("src/lib/processTiming.ts");
const start = "2026-10-16T00:00:00Z";
const end = "2026-10-16T00:01:07Z";

test("live elapsed starts from the persisted run, including reconnects and waits", () => {
  assert.equal(timing.processElapsedMilliseconds(start, end, true, Date.parse(end) + 3000), 70_000);
  assert.equal(timing.processElapsedMilliseconds(start, end, true, Date.parse(end) - 3000), 67_000);
});

test("terminal elapsed is frozen by the server timestamp, never by page mount time", () => {
  assert.equal(timing.processElapsedMilliseconds(start, end, false, Date.now()), 67_000);
  assert.equal(timing.processElapsedMilliseconds(start, end, false, Date.now() + 600_000), 67_000);
  assert.equal(timing.processElapsedMilliseconds(start, undefined, false, Date.now()), null);
  assert.equal(timing.processElapsedMilliseconds(undefined, end, true, Date.now()), null);
  assert.equal(timing.processElapsedMilliseconds(end, start, false, Date.now()), 0);
});

test("compact elapsed formatting has stable second/minute/hour boundaries", () => {
  for (const [milliseconds, label] of [[0, "0 秒"], [59_999, "59 秒"], [60_000, "1 分 00 秒"], [67_999, "1 分 07 秒"], [3_600_000, "1 小时 00 分"], [7_380_000, "2 小时 03 分"]]) {
    assert.equal(timing.formatProcessElapsed(milliseconds), label);
  }
});

test("the header clock keeps one interval across token updates and clears it on terminal/unmount", () => {
  let now = Date.parse(end), state, previousDependencies, cleanup, interval, started = 0, cleared = 0;
  class Clock extends Date { static now() { return now; } }
  const react = {
    useState(initial) { state ??= initial(); return [state, (next) => { state = next; }]; },
    useEffect(effect, dependencies) {
      if (previousDependencies?.every((value, index) => value === dependencies[index])) return;
      cleanup?.();
      cleanup = effect();
      previousDependencies = dependencies;
    },
  };
  const { useProcessElapsed } = load("src/hooks/useProcessElapsed.ts", { react, "../lib/processTiming": timing }, {
    Date: Clock,
    setInterval(callback, delay) { assert.equal(delay, 1000); interval = callback; started++; return started; },
    clearInterval() { cleared++; interval = undefined; },
  });
  assert.equal(useProcessElapsed(start, end, true), "1 分 07 秒");
  now += 2000;
  interval();
  assert.equal(useProcessElapsed(start, "2026-10-16T00:01:09Z", true), "1 分 09 秒");
  assert.equal(started, 1, "tokens must not restart the local timer");
  assert.equal(useProcessElapsed(start, end, false), "1 分 07 秒");
  assert.equal(cleared, 1);
  assert.equal(interval, undefined);
  useProcessElapsed(start, end, true);
  cleanup();
  assert.equal(cleared, 2);
});

test("public paragraphs never shimmer; the short working status owns slow reduced-motion-safe animation", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { PublicProgress } = load("src/components/ProcessTimeline.tsx", {
    react: React, "react/jsx-runtime": require("react/jsx-runtime"), "lucide-react": require("lucide-react"),
    "../lib/processTimeline": {}, "./ProcessSteps": {}, "./ThinkingDetails": {}, "./process-timeline.css": {},
  });
  const active = renderToStaticMarkup(React.createElement(PublicProgress, { text: "正在核对来源", active: true, preview: true }));
  const complete = renderToStaticMarkup(React.createElement(PublicProgress, { text: "正在核对来源" }));
  assert.match(active, /process-progress-preview/);
  assert.doesNotMatch(active, /is-working/);
  assert.doesNotMatch(complete, /is-working/);
  const css = fs.readFileSync(path.resolve(__dirname, "../src/components/thinking.css"), "utf8");
  assert.match(css, /\.ochi-status-label\.is-working[^}]*animation: ochi-status-shimmer 8s linear infinite/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none;[\s\S]*color: var\(--muted\);/);
  assert.doesNotMatch(fs.readFileSync(path.resolve(__dirname, "../src/components/process-timeline.css"), "utf8"), /shimmer/);
});

test("live process step counts exclude running and failed calls and preserve terminal labels", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const process = load("src/lib/processTimeline.ts");
  const { ProcessDetails } = load("src/components/ProcessDetails.tsx", {
    react: React, "react/jsx-runtime": require("react/jsx-runtime"), "lucide-react": require("lucide-react"),
    "../lib/processTimeline": process,
    "./ThinkingDetails": { OchiActivityMark: ({ working }) => React.createElement("span", { "data-face-working": Boolean(working) }) },
    "./ProcessTimeline": {
      ProcessTimeline: ({ active, bounded }) => React.createElement("span", { "data-working": Boolean(active), "data-bounded": bounded }),
    },
    "./ProcessElapsed": { ProcessElapsed: () => React.createElement("span", null, "· 12 秒") },
    "./ProcessSteps": {}, "./execution.css": {},
  });
  const timeline = ["completed", "running", "failed"].map((status, seq) => ({ id: String(seq), seq, kind: "tool", step: { id: String(seq), name: "exec", status } }));
  const props = { active: true, status: "running", timeline };
  const live = renderToStaticMarkup(React.createElement(ProcessDetails, props));
  assert.match(live, /已完成 1 步/);
  assert.match(live, /12 秒/);
  assert.match(live, /ochi-status-label is-working/);
  assert.match(live, /data-face-working="true"/);
  const failed = renderToStaticMarkup(React.createElement(ProcessDetails, { ...props, status: "failed", active: false }));
  assert.match(failed, /未完成/);
  const stopped = renderToStaticMarkup(React.createElement(ProcessDetails, { ...props, status: "cancelled", active: false }));
  assert.match(stopped, /已停止/);
  const expanded = renderToStaticMarkup(React.createElement(ProcessDetails, { ...props, expanded: true }));
  assert.match(expanded, /data-working="true"/);
  const waiting = renderToStaticMarkup(React.createElement(ProcessDetails, { ...props, status: "waiting_user", expanded: true }));
  assert.doesNotMatch(waiting, /ochi-status-label is-working/);
  assert.match(waiting, /data-face-working="false"/);
  const compact = renderToStaticMarkup(React.createElement(ProcessDetails, { ...props, compact: true, bounded: false, expanded: true }));
  assert.doesNotMatch(compact, /data-face-working|12 秒|ochi-status-label is-working/);
  assert.match(compact, /data-bounded="false"/);
});

test("every process disclosure uses a horizontal closed chevron and a downward open rotation", () => {
  for (const file of ["ProcessDetails.tsx", "HistoryProcess.tsx", "ProcessTimeline.tsx", "ProcessSteps.tsx"]) {
    const source = fs.readFileSync(path.resolve(__dirname, "../src/components", file), "utf8");
    assert.match(source, /ChevronRight/);
    assert.doesNotMatch(source, /ChevronDown/);
  }
  for (const file of ["execution.css", "process-timeline.css", "run-transcript.css"]) {
    const css = fs.readFileSync(path.resolve(__dirname, "../src/components", file), "utf8");
    assert.match(css, /rotate\(90deg\)/);
    assert.doesNotMatch(css, /rotate\(180deg\)/);
  }
});

test("Markdown keeps its block renderer when streaming ends without incomplete parsing or terminal animation", () => {
  const jsx = (type, props) => ({ type, props });
  const { default: MarkdownContent } = load("src/components/MarkdownContent.tsx", {
    react: { useEffect() {}, useMemo: (callback) => callback(), useState: (value) => [value, () => {}] },
    "react/jsx-runtime": { jsx, jsxs: jsx }, streamdown: { Streamdown: "Streamdown" },
    "@streamdown/cjk": { cjk: {} }, "../lib/markdown": { normalizeMath: (text) => text }, "./markdown.css": {},
  });
  const live = MarkdownContent({ content: "An answer", isStreaming: true });
  const final = MarkdownContent({ content: "An answer", isStreaming: false });
  assert.equal(live.props.mode, "streaming");
  assert.equal(final.props.mode, live.props.mode);
  assert.equal(final.props.parseIncompleteMarkdown, false);
  assert.equal(final.props.isAnimating, false);
});

test("thinking observes natural content across the four-line streaming threshold and layout changes", () => {
  const slots = [];
  const effects = [];
  const natural = { scrollHeight: 24 };
  let cursor = 0, observed, resize, disconnected = false, observerCount = 0;
  const jsx = (type, props) => ({ type, props });
  const { TestThinkingPart } = load("src/components/ThinkingDetails.tsx", {
    react: {
      memo: (component) => component, lazy: () => "Markdown", Suspense: "Suspense",
      useMemo: (callback) => callback(),
      useState(initial) { const index = cursor++; slots[index] ??= { value: initial }; return [slots[index].value, (next) => { slots[index].value = next; }]; },
      useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
      useLayoutEffect(effect) { const index = cursor++; if (!slots[index]) { slots[index] = true; effects.push(effect); } },
    },
    "react/jsx-runtime": { jsx, jsxs: jsx }, "lucide-react": {},
    "../lib/runPresentation": { formatReasoningDisplay: (text) => text }, "./thinking.css": {},
  }, {
    getComputedStyle: () => ({ lineHeight: "24px" }),
    ResizeObserver: class {
      constructor(callback) { resize = callback; observerCount++; }
      observe(node) { observed = node; }
      disconnect() { disconnected = true; }
    },
  }, "\nexports.TestThinkingPart = ThinkingPart;");
  function render() {
    cursor = 0;
    const tree = TestThinkingPart({ part: { id: "R", kind: "reasoning", text: "Streaming thought" }, active: true });
    const body = tree.props.children[0];
    assert.equal(body.props.className, "thinking-part-body");
    const contents = body.props.children;
    assert.equal(contents.props.className, "thinking-part-content");
    contents.props.ref.current = natural;
    return tree;
  }
  let view = render();
  const cleanup = effects[0]();
  assert.equal(observed, natural, "the unclipped wrapper owns the observation");
  assert.equal(view.props.children[1], null);
  natural.scrollHeight = 96; resize(); view = render();
  assert.equal(view.props.children[1], null, "exactly four lines need no disclosure");
  natural.scrollHeight = 120; resize(); view = render();
  assert.equal(view.props.children[1].props.children, "展开思考");
  natural.scrollHeight = 72; resize(); view = render();
  assert.equal(view.props.children[1], null, "wider layout or smaller type remeasures");
  natural.scrollHeight = 144; resize(); view = render();
  assert.equal(view.props.children[1].props.children, "展开思考", "narrower layout or larger type remeasures");
  assert.equal(observerCount, 1, "stream deltas do not recreate the observer");
  cleanup();
  assert.equal(disconnected, true);
});

function historyProcessHarness(run = async () => { throw new Error("Unexpected process fetch"); }) {
  const slots = [];
  let cursor = 0, commits = [];
  const changed = (previous, next) => !previous || previous.length !== next.length || next.some((value, index) => value !== previous[index]);
  const react = {
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useState(initial) { const index = cursor++; slots[index] ??= { value: initial }; return [slots[index].value, (next) => { slots[index].value = next; }]; },
    useEffect(effect, dependencies) {
      const index = cursor++, previous = slots[index];
      if (changed(previous?.dependencies, dependencies)) commits.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: effect() }; });
    },
  };
  const { HistoryProcess } = load("src/components/HistoryProcess.tsx", {
    react, "react/jsx-runtime": require("react/jsx-runtime"), "lucide-react": require("lucide-react"),
    "../lib/api": { api: { run }, isActiveStatus: (status) => status === "running" },
    "./RunTranscript": { RunTranscript: () => null }, "./execution.css": {},
  });
  return (props) => { cursor = 0; commits = []; const result = HistoryProcess(props); for (const commit of commits) commit(); return result.props.children[0]; };
}

test("persisted terminal status preserves every public block in a remembered Web process panel", () => {
  const render = historyProcessHarness();
  const confirmed = { id: "P1", seq: 1, kind: "progress", text: "Checking sources" };
  const pending = { id: "P2", seq: 2, kind: "progress", text: "Final answer", pending: true };
  const snapshot = { run_id: "R", status: "running", output: pending.text, timeline: [confirmed, pending], created_at: start, updated_at: start };
  render({ runId: "R", status: "running", snapshot, stepCount: 0 });
  const terminal = render({ runId: "R", status: "completed", output: "Final answer", stepCount: 0, updatedAt: end });
  assert.equal(terminal.props.status, "completed");
  assert.equal(terminal.props.output, "Final answer");
  assert.equal(terminal.props.updatedAt, end);
  assert.deepEqual(JSON.parse(JSON.stringify(terminal.props.timeline)), [confirmed, pending]);
  assert.equal(snapshot.timeline[1].pending, true);
  const failed = render({ runId: "R", status: "failed", output: "", stepCount: 0, updatedAt: end });
  assert.equal(failed.props.output, "");
  assert.deepEqual(JSON.parse(JSON.stringify(failed.props.timeline)), [confirmed, pending]);
});

test("opening a remembered Web panel refreshes missed terminal tools in place without retry loops or accepting stale snapshots", async () => {
  const tool = { id: "T", seq: 1, kind: "tool", step: { id: "T", name: "exec", status: "running" } };
  const cached = { run_id: "R", status: "running", seq: 4, output: "", timeline: [tool], created_at: start, updated_at: start };
  const final = { ...cached, status: "completed", seq: 9, output: "Final answer", updated_at: end, timeline: [{ ...tool, step: { ...tool.step, status: "completed" } }] };
  const responses = [new Error("Offline"), { ...final, run_id: "other" }, { ...final, seq: 2 }, { ...final, status: "running" }, final];
  let requests = 0;
  const render = historyProcessHarness(async (runId) => {
    assert.equal(runId, "R");
    requests++;
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const terminalProps = { runId: "R", status: "completed", output: "Final answer", stepCount: 1, updatedAt: end };
  render({ ...terminalProps, status: "running", snapshot: cached });
  let view = render(terminalProps);
  assert.equal(requests, 0, "closed process stays lazy");
  const initialType = view.type;
  for (let attempt = 1; attempt <= 5; attempt++) {
    view.props.onExpandedChange(true);
    view = render(terminalProps);
    assert.equal(view.type, initialType, "recovery keeps the panel mounted");
    assert.equal(view.props.status, "completed");
    assert.equal(requests, attempt);
    for (let tick = 0; tick < 5; tick++) await Promise.resolve();
    view = render(terminalProps);
    view = render(terminalProps);
    assert.equal(requests, attempt, "failed recovery must not loop automatically");
    if (attempt < 5) {
      assert.equal(view.props.timeline[0].step.status, "running", "unobserved tool results are never invented");
      view.props.onExpandedChange(false);
      view = render(terminalProps);
    }
  }
  assert.equal(view.props.timeline[0].step.status, "completed");
  assert.equal(view.props.updatedAt, end);
  assert.equal(view.props.output, "Final answer");
  assert.equal(cached.timeline[0].step.status, "running");
});

test("pending public text streams once and stays visible on cancellation or failure", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const timeline = load("src/lib/processTimeline.ts");
  const presentation = load("src/lib/runPresentation.ts", { "./processTimeline": timeline });
  const { RunTranscript } = load("src/components/RunTranscript.tsx", {
    react: React, "react/jsx-runtime": require("react/jsx-runtime"), "react-dom": require("react-dom"),
    "../lib/api": { isActiveStatus: (status) => status === "running" },
    "../lib/runPresentation": presentation,
    "./ProcessDetails": { ProcessDetails: () => null, ProcessSummary: () => null }, "./run-transcript.css": {},
  });
  const text = "让我核对来源";
  const props = { timeline: [{ id: "P", seq: 1, kind: "progress", pending: true, text }], output: text,
    renderBody: (content, id, streaming) => React.createElement("p", { "data-answer": id, "data-streaming": streaming }, content) };
  for (const status of ["running", "cancelled", "failed"]) {
    const markup = renderToStaticMarkup(React.createElement(RunTranscript, { ...props, status }));
    assert.match(markup, /data-answer="P"/);
    assert.equal(markup.split(text).length - 1, 1, `${status} must not hide or duplicate public text`);
    assert.doesNotMatch(markup, /is-archived/);
  }
});

test("a lazily loaded completed history groups its process and still honors the explicitly open panel", () => {
  const slots = [];
  let cursor = 0, commits = [];
  const react = {
    memo: (component) => component, useMemo: (callback) => callback(),
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useState(initial) { const index = cursor++; slots[index] ??= { value: typeof initial === "function" ? initial() : initial }; return [slots[index].value, (next) => { slots[index].value = typeof next === "function" ? next(slots[index].value) : next; }]; },
    useLayoutEffect(effect, dependencies) {
      const index = cursor++, previous = slots[index];
      if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) {
        commits.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: effect() }; });
      }
    },
  };
  const timeline = load("src/lib/processTimeline.ts");
  const presentation = load("src/lib/runPresentation.ts", { "./processTimeline": timeline });
  const { RunTranscript, testReaderPaused } = load("src/components/RunTranscript.tsx", {
    react, "react/jsx-runtime": require("react/jsx-runtime"), "react-dom": {},
    "../lib/api": { isActiveStatus: (status) => status === "running" }, "../lib/runPresentation": presentation,
    "./ProcessDetails": {}, "./run-transcript.css": {},
  }, {}, "\nexports.testReaderPaused = readerPaused;");
  const render = (props) => { cursor = 0; commits = []; const node = RunTranscript(props); for (const commit of commits) commit(); return node; };
  const props = { status: "completed", output: "Answer", expanded: false, timeline: [], renderBody: () => null };
  assert.doesNotMatch(render(props).props.className, /is-archived/);
  const loaded = { ...props, expanded: true, timeline: [
    { id: "P", seq: 1, kind: "progress", text: "Checking" },
    { id: "F", seq: 2, kind: "progress", text: "Answer", final: true },
  ] };
  render(loaded);
  assert.match(render(loaded).props.className, /is-archived is-open/);
  const closed = render({ ...loaded, expanded: false });
  assert.match(closed.props.className, /is-archived/);
  assert.equal(closed.props.children[1].props.hidden, true);
  assert.equal(testReaderPaused({ dataset: {}, matches: () => true, scrollHeight: 1600, scrollTop: 80, clientHeight: 700 }), true, "a task-page outer reader must not be collapsed away");
  assert.equal(testReaderPaused({ dataset: {}, matches: () => true, scrollHeight: 1600, scrollTop: 900, clientHeight: 700 }), false);
});

test("Web tasks delegate current public output without stale execution fallbacks", () => {
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const walk = (node) => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" && "type" in node ? [node, ...walk(node.props.children)] : [];
  let state = 0, current;
  const execution = { id: "E", status: "completed", output: "Earlier stored output", started_at: "" };
  const seeds = [[], { id: "T", name: "Task", timezone: "UTC" }, [execution], execution, null, null, false];
  const { default: TasksPage } = load("src/pages/TasksPage.tsx", {
    react: { lazy: () => "MarkdownContent", Suspense: "Suspense", useEffect() {}, useCallback: (fn) => fn, useRef: (value) => ({ current: value }), useState(initial) { const index = state++; return [index < seeds.length ? seeds[index] : initial, () => {}]; } },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" }, "lucide-react": new Proxy({}, { get: (_target, key) => String(key) }),
    "../lib/api": { api: {}, isActiveStatus: (status) => status === "running" }, "../lib/router": { statusLabel: () => "" },
    "../components/Modal": {}, "../components/Sidebar": {}, "../components/ui/Select": {}, "../components/FileCards": {}, "../components/RunTranscript": { RunTranscript: "RunTranscript" },
    "../hooks/useRunStream": { useRunStream: () => ({ snapshot: current }) },
    "../components/ReasoningField": {}, "../components/WaitingInputCard": {}, "../components/SessionSearch": {}, "../lib/scheduling": {}, "./tasks.css": {},
  });
  const props = { taskId: "T", executionId: "E", sessions: [], models: [], projects: [], onNavigate() {}, onMenu() {} };
  const render = (snapshot) => { state = 0; current = snapshot; return walk(TasksPage(props)).find((node) => node.type === "RunTranscript"); };
  const pending = { run_id: "R", status: "running", output: "Unconfirmed", timeline: [{ id: "P", seq: 1, kind: "progress", text: "Unconfirmed", pending: true }] };
  assert.equal(render(pending).props.output, "Unconfirmed");
  assert.equal(render(pending).props.timeline, pending.timeline);
  assert.equal(render({ ...pending, output: "", timeline: [] }).props.output, "");
  assert.equal(render({ ...pending, output: "Confirmed", timeline: [] }).props.output, "Confirmed");
  assert.equal(render(null).props.output, execution.output);
});
