const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const sharedLoad = require("../../shared/conversation/test-loader.cjs").createLoader(ts, require);
const sharedModule = (name) => name.includes("shared/conversation/") ? sharedLoad(path.resolve(__dirname, "../..", "shared/conversation", name.split("shared/conversation/")[1] + ".ts")) : undefined;
const { createI18nHarness } = require("./i18n-harness.cjs");
const i18n = createI18nHarness();

function load(file, imports = {}, globals = {}, tail = "") {
  const source = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output + tail, {
    module, exports: module.exports, ...globals,
    require(name) { if (sharedModule(name)) return sharedModule(name); if (name in imports) return imports[name]; const locale = i18n.resolve(name, file.startsWith("mobile/") ? "mobile" : "web"); if (locale) return locale; if (name.endsWith("/reasoningLabels")) return { effortLabel: (value) => value }; throw new Error(`Unexpected import ${name}`); },
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
  for (const [milliseconds, label] of [[0, "0 秒"], [59_999, "59 秒"], [60_000, "1 分 0 秒"], [67_999, "1 分 7 秒"], [3_600_000, "1 小时 0 分"], [7_380_000, "2 小时 3 分"]]) {
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
  assert.equal(useProcessElapsed(start, end, true), "1 分 7 秒");
  now += 2000;
  interval();
  assert.equal(useProcessElapsed(start, "2026-10-16T00:01:09Z", true), "1 分 9 秒");
  assert.equal(started, 1, "tokens must not restart the local timer");
  assert.equal(useProcessElapsed(start, end, false), "1 分 7 秒");
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
    "./ComputerQueueDetails": { ComputerQueueDetails: () => null },
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
