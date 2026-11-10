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
    require(name) { if (/\/Loading$/.test(name)) return { LoadingDots: () => null, SkelRows: () => null }; if (sharedModule(name)) return sharedModule(name); if (name in imports) return imports[name]; const locale = i18n.resolve(name, file.startsWith("mobile/") ? "mobile" : "web"); if (locale) return locale; if (name.endsWith("/reasoningLabels")) return { effortLabel: (value) => value }; throw new Error(`Unexpected import ${name}`); },
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

const headerOf = (patch) => {
  const process = load("src/lib/processTimeline.ts");
  const { describeHeader } = load("src/lib/processHeader.ts", { "./processTiming": timing, "./processTimeline": process });
  return describeHeader({ active: false, entries: [], durationMs: 12_000, ...patch });
};
const toolEntry = (id, seq, status = "completed", name = "exec", args = { command: `echo ${id}` }) => ({ id, seq, kind: "tool", step: { id, name, status, arguments: args } });
const thinkingEntry = (id, seq, done) => ({ id, seq, kind: "reasoning", reasoning: { id, kind: "reasoning", text: "Plan", done } });

test("header model: running tool names its verb and keeps the subject in a separate mono field", () => {
  const header = headerOf({ status: "running", active: true, entries: [toolEntry("T1", 1, "running", "isolated_research", { task: "compare vendors" })] });
  assert.equal(header.state, "running");
  assert.equal(header.label, "正在独立调研");
  assert.equal(header.sub, "compare vendors");
  assert.equal(header.mono, true);
  assert.doesNotMatch(header.label, /isolated_research/, "a raw tool id never reaches a sentence");
  const unknown = headerOf({ status: "running", active: true, entries: [toolEntry("T2", 1, "running", "vendor_thing", {})] });
  assert.doesNotMatch(unknown.label, /vendor_thing/);
});

test("header model: thinking, writing, waiting, done, failed and stopped each own a state and label", () => {
  assert.equal(headerOf({ status: "running", active: true, entries: [thinkingEntry("R1", 1, false)] }).label, "思考中");
  assert.equal(headerOf({ status: "running", active: true, entries: [toolEntry("T1", 1), thinkingEntry("R1", 2, true)] }).label, "正在撰写回复");
  assert.equal(headerOf({ status: "running", active: true, entries: [] }).label, "正在处理");
  const waiting = headerOf({ status: "waiting_user", active: true, entries: [toolEntry("T1", 1)], waitingKind: "computer_permission" });
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.label, "等待授权");
  const done = headerOf({ status: "completed", entries: [toolEntry("T1", 1), toolEntry("T2", 2)] });
  assert.equal(done.state, "done");
  assert.equal(done.label, "已处理");
  assert.equal(done.duration, "12 秒", "the duration is its own field, shown at the far right");
  assert.equal(done.sub, "2 个工具调用");
  const thoughtOnly = headerOf({ status: "completed", entries: [thinkingEntry("R1", 1, true)] });
  assert.equal(thoughtOnly.label, "已思考");
  assert.equal(thoughtOnly.duration, "12 秒");
  assert.equal(headerOf({ status: "failed", entries: [toolEntry("T1", 1)] }).state, "failed");
  assert.equal(headerOf({ status: "cancelled", entries: [toolEntry("T1", 1)] }).label, "已停止 · 处理了 12 秒");
});

test("header label ids change per phase, not per token, so the rolling label animates once", () => {
  const first = headerOf({ status: "running", active: true, entries: [thinkingEntry("R1", 1, false)] });
  const grown = headerOf({ status: "running", active: true, entries: [{ ...thinkingEntry("R1", 1, false), reasoning: { id: "R1", kind: "reasoning", text: "A much longer thought", done: false } }] });
  assert.equal(first.id, grown.id);
  assert.notEqual(first.id, headerOf({ status: "running", active: true, entries: [toolEntry("T1", 2, "running")] }).id);
});

function reducedCss(css) { return css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)")); }

test("motion: the running indicator is the lab bars, nothing rotates, and reduced motion removes ambient loops", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../src/components/process.css"), "utf8");
  assert.match(css, /\.ind-bars i[^}]*animation: bars/);
  assert.doesNotMatch(css, /st-ring|ring-sweep|ind-pulse|sonar/, "no old ring, arc or sonar remains");
  assert.match(css, /@keyframes ring-turn \{ to \{ --ring-a: 360deg; \}/, "the running ring turns only a gradient angle, never the tile");
  assert.match(reducedCss(css), /st-dot::after \{ animation: none/, "the ring is static under reduced motion");
  assert.doesNotMatch(css.match(/@keyframes[^{]*\{(?:[^{}]|\{[^}]*\})*\}/g).join("\n"), /(?<![-\w])rotate\s*:/, "no process keyframe rotates a box");
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.ind-bars i[^}]*animation: none/);
  assert.doesNotMatch(fs.readFileSync(path.resolve(__dirname, "../src/components/ThinkingDetails.tsx"), "utf8"), /shimmer/);
});

test("finished header strip is flat: no overlap, fixed chip size, four families then +N, two then +N on narrow screens", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../src/components/process.css"), "utf8");
  const strip = css.match(/\.proc-icons i, \.st-strip i \{[^}]*\}/)[0];
  assert.match(strip, /width: 17px; height: 17px/);
  assert.doesNotMatch(css, /margin-left: -5px; box-shadow: 0 0 0 2px var\(--canvas\)/, "chips never overlap");
  assert.match(css, /@media \(max-width: 480px\) \{[^}]*\.proc-icons i:nth-of-type\(n \+ 3\) \{ display: none; \}/);
});

test("live process rendering: rolling header, shimmer while running, groups for finished work, ring only on running rows", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const process = load("src/lib/processTimeline.ts");
  const stubs = {
    RunningBars: () => React.createElement("span", { className: "ind-bars" }),
    Collapse: ({ open, className, children }) => open ? React.createElement("div", { className }, children) : null,
    hueStyle: () => ({}), toolIcon: () => null,
    ThinkingRow: ({ entry, fold }) => React.createElement("li", { "data-row": "thinking", "data-fold": fold }, entry.id),
    ToolRow: ({ entry, fold }) => React.createElement("li", { "data-row": "tool", "data-fold": fold }, entry.id),
    ToolGroup: ({ row, fold }) => React.createElement("li", { "data-row": "group", "data-fold": fold }, row.entries.length),
    ProgressRow: ({ entry, fold }) => React.createElement("li", { "data-row": "progress", "data-fold": fold }, entry.id),
  };
  const { ProcessTimeline } = load("src/components/ProcessTimeline.tsx", {
    react: React, "react/jsx-runtime": require("react/jsx-runtime"), "lucide-react": require("lucide-react"),
    "../lib/processTimeline": process, "../lib/processHeader": load("src/lib/processHeader.ts", { "./processTiming": timing, "./processTimeline": process }),
    "../lib/processTiming": timing, "../lib/entryClock": load("src/lib/entryClock.ts", { react: React }),
    "./ComputerQueueDetails": { ComputerQueueDetails: () => null }, "./ProcessSteps": stubs, "./process.css": {},
  });
  const timeline = [toolEntry("T1", 1), toolEntry("T2", 2), thinkingEntry("R1", 3, false)];
  const props = { timeline, active: true, status: "running", createdAt: start, updatedAt: end, renderBody: (text) => text };
  const live = renderToStaticMarkup(React.createElement(ProcessTimeline, props));
  assert.match(live, /roll shimmer/);
  assert.match(live, /ind-bars/);
  assert.doesNotMatch(live, /ind-pulse|st-ring/);
  assert.match(live, /aria-expanded="true"/, "a working run opens its rail");
  assert.match(live, /data-row="group"[^>]*data-fold="true"/, "peek folds everything but the newest row");
  assert.match(live, /data-row="thinking"[^>]*data-fold="false"/);
  const finished = renderToStaticMarkup(React.createElement(ProcessTimeline, { ...props, active: false, status: "completed" }));
  assert.match(finished, /aria-expanded="false"/, "history opens collapsed");
  assert.match(finished, /ind-done/);
  assert.match(finished, /已处理.*个工具调用.*proc-meta[^>]*>1 分 7 秒/s, "label, tool count, strip, then the duration at the far right");
  assert.doesNotMatch(finished, /shimmer/);
  const waiting = renderToStaticMarkup(React.createElement(ProcessTimeline, { ...props, status: "waiting_user" }));
  assert.match(waiting, /ind-wait/);
  assert.doesNotMatch(waiting, /shimmer/);
  const failed = renderToStaticMarkup(React.createElement(ProcessTimeline, { ...props, active: false, status: "failed" }));
  assert.match(failed, /ind-bad/);
  const stopped = renderToStaticMarkup(React.createElement(ProcessTimeline, { ...props, active: false, status: "cancelled" }));
  assert.match(stopped, /已停止/);
  const empty = renderToStaticMarkup(React.createElement(ProcessTimeline, { ...props, timeline: [], active: false, status: "completed" }));
  assert.match(empty, /data-empty="true"/);
});

test("every process disclosure uses a horizontal closed chevron and a downward open rotation", () => {
  for (const file of ["ProcessTimeline.tsx", "HistoryProcess.tsx", "ProcessSteps.tsx"]) {
    const source = fs.readFileSync(path.resolve(__dirname, "../src/components", file), "utf8");
    assert.match(source, /ChevronRight/);
    assert.doesNotMatch(source, /ChevronDown/);
  }
  assert.match(fs.readFileSync(path.resolve(__dirname, "../src/styles.css"), "utf8"), /aria-expanded="true"\] > \.chev[^}]*rotate: 90deg/);
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

test("thinking streams in a short box that follows new text, then settles into a taller scrollable block", () => {
  const stick = [];
  const jsx = (type, props) => ({ type, props });
  const { ThinkingContent } = load("src/components/ThinkingDetails.tsx", {
    react: { memo: (component) => component, lazy: () => "Markdown", Suspense: "Suspense", useMemo: (callback) => callback(), useRef: (initial) => ({ current: initial }) },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "../lib/i18n": { useI18n() {} },
    "../lib/runPresentation": { formatReasoningDisplay: (text) => text },
    "../hooks/useStickToEnd": { useStickToEnd: (_ref, dependency, enabled) => stick.push({ dependency, enabled }) },
    "./process.css": {},
  });
  const live = ThinkingContent({ part: { id: "R", kind: "reasoning", text: "Streaming thought" }, active: true });
  assert.match(live.props.className, /\blive\b/);
  assert.deepEqual(stick.at(-1), { dependency: "Streaming thought", enabled: true });
  const done = ThinkingContent({ part: { id: "R", kind: "reasoning", text: "Streaming thought", done: true }, active: true });
  assert.doesNotMatch(done.props.className, /\blive\b/);
  assert.equal(stick.at(-1).enabled, false, "a finished block is never force-scrolled");
  const idle = ThinkingContent({ part: { id: "R", kind: "reasoning", text: "History" } });
  assert.doesNotMatch(idle.props.className, /\blive\b/);
});
