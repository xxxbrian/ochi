const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createLoader } = require("../../shared/conversation/test-loader.cjs");
const { createI18nHarness } = require("./i18n-harness.cjs");
const root = path.resolve(__dirname, "../..");
const domainLoad = createLoader(require("typescript"), require);
const queue = domainLoad(path.join(root, "shared/conversation/computerQueue.ts"));
const { toolGroupFamily } = domainLoad(path.join(root, "shared/conversation/projection.ts"));
const sampleAt = "2026-11-01T00:00:00Z";
const output = (patch = {}) => ({
  status: "waiting", resource: "desktop", executed: false, request_id: "queue-fixture", sequence: 3,
  active_wait_ms: 61_000, elapsed_ms: 241_000, waiting_ahead: 2, ready_count: 3,
  checkpoint_count: 1, observed_at: sampleAt, ...patch,
});
const step = (value = output(), patch = {}) => ({
  id: "tool", name: "computer_queue", status: "running", output: JSON.stringify(value), ...patch,
});
const entry = (seq, value = step()) => ({ id: String(seq), seq, kind: "tool", step: value });

test("queue metadata uses explicit non-execution and validates finite actual counts", () => {
  const value = queue.computerQueueProgress(step());
  assert.deepEqual(value, {
    status: "waiting", resource: "desktop", requestId: "queue-fixture", activeWaitMs: 61_000,
    waitingAhead: 2, observedAt: sampleAt,
  });
  for (const patch of [
    { executed: true }, { executed: undefined }, { status: "running" }, { request_id: "" },
    { resource: undefined }, { resource: "unknown" },
    { active_wait_ms: -1 }, { active_wait_ms: "61000" }, { waiting_ahead: 1.5 },
    { waiting_ahead: null }, { waiting_ahead: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.equal(queue.computerQueueProgress(step(output(patch))), null);
  assert.equal(queue.computerQueueProgress(step(null)), null);
  assert.equal(queue.computerQueueProgress(step([], { output: "plain output" })), null);
  assert.equal(queue.computerQueueProgress(step(output({ observed_at: "invalid" }))).observedAt, undefined);
});

test("real execution counts and aggregation exclude parked waits, admission and skipped batched calls", () => {
  for (const value of [
    step(output({ status: "paused" }), { status: "completed" }),
    step({ status: "acquired", executed: false }, { name: "computer_click", status: "completed" }),
    step({ status: "released", executed: false }, { name: "computer_release", status: "completed" }),
    step(undefined, { output: "not dispatched", outcome: "not_executed", status: "completed" }),
  ]) {
    assert.equal(queue.isExecutedStep(value), false);
    assert.equal(queue.isCompletedStep(value), false);
    assert.equal(toolGroupFamily(value), null);
  }
  assert.equal(queue.isCompletedStep(step({}, { status: "completed", outcome: "success" })), true);
  assert.equal(queue.isCompletedStep(step(output(), { status: "completed", outcome: "success" })), true);
  assert.equal(queue.isCompletedStep(step({}, { status: "completed", outcome: "needs_user" })), false);
  assert.equal(queue.isCompletedStep(step({}, { status: "failed", outcome: "failure" })), false);
});

test("queue parsing follows source updates without stale cached output and chooses the latest running occurrence", () => {
  const value = step();
  assert.equal(queue.computerQueueProgress(value).status, "waiting");
  value.output = JSON.stringify(output({ status: "paused" }));
  assert.equal(queue.computerQueueProgress(value).status, "paused");
  const oldest = step(output({ request_id: "old" }));
  const newest = step(output({ request_id: "new" }));
  const paused = step(output({ request_id: "paused", status: "paused" }), { status: "completed" });
  assert.equal(queue.latestComputerQueue([entry(9, paused), entry(3, newest), entry(1, oldest)]).requestId, "new");
  assert.equal(queue.latestComputerQueue([entry(9, paused)]), null);
});

test("active waiting advances from its server sample and parked thinking time never becomes waiting time", () => {
  const waiting = queue.computerQueueProgress(step());
  assert.equal(queue.computerQueueWaitMilliseconds(waiting, Date.parse(sampleAt) + 10_000), 71_000);
  assert.equal(queue.computerQueueWaitMilliseconds(waiting, Date.parse(sampleAt) - 10_000), 61_000);
  assert.equal(queue.computerQueueWaitMilliseconds(waiting), 61_000);
  const paused = queue.computerQueueProgress(step(output({ status: "paused" })));
  assert.equal(queue.computerQueueWaitMilliseconds(paused, Date.parse(sampleAt) + 3600_000), 61_000);
  assert.equal(queue.computerQueueWaitMilliseconds({ ...waiting, observedAt: undefined }, Date.now()), 61_000);
  assert.equal(queue.computerQueueWaitMilliseconds({ status: "acquired", resource: "desktop" }, Date.now()), 0);
});

test("queue descriptions have three live locales, preserve zero ahead and never claim an estimated wait", () => {
  const i18n = createI18nHarness("en");
  const waiting = queue.computerQueueProgress(step(output({ waiting_ahead: 0 })));
  const expected = {
    en: ["Waiting for computer", "0 requests ahead · Waited 1m 1s", "Computer wait paused", "Computer ready"],
    "zh-CN": ["等待电脑", "前方 0 项 · 已等待 1 分 1 秒", "已暂停等待电脑", "电脑已就绪"],
    "zh-TW": ["等待電腦", "前方 0 項 · 已等待 1 分 1 秒", "已暫停等待電腦", "電腦已就緒"],
  };
  for (const [locale, labels] of Object.entries(expected)) {
    i18n.runtime.setLanguage(locale);
    assert.equal(i18n.process.computerQueueLabel(waiting), labels[0]);
    assert.equal(i18n.process.computerQueueDetail(waiting), labels[1]);
    assert.equal(i18n.process.computerQueueLabel({ ...waiting, status: "paused" }), labels[2]);
    assert.equal(i18n.process.computerQueueLabel({ status: "acquired", resource: "desktop" }), labels[3]);
    assert.equal(i18n.process.computerQueueDetail({ status: "acquired", resource: "desktop" }), "");
  }
  i18n.runtime.setLanguage("en");
  assert.match(i18n.process.computerQueueDetail({ ...waiting, waitingAhead: 1 }), /^1 request ahead/);
});

test("project admission uses workspace labels for waiting, paused and acquired in every language", () => {
  const i18n = createI18nHarness("en");
  const expected = {
    en: ["Waiting for workspace", "Workspace wait paused", "Workspace ready"],
    "zh-CN": ["等待工作空间", "已暂停等待工作空间", "工作空间已就绪"],
    "zh-TW": ["等待工作空間", "已暫停等待工作空間", "工作空間已就緒"],
  };
  for (const [locale, labels] of Object.entries(expected)) {
    i18n.runtime.setLanguage(locale);
    for (const [index, status] of ["waiting", "paused", "acquired"].entries()) {
      const progress = queue.computerQueueProgress(step(output({ resource: "project", status })));
      assert.equal(progress.resource, "project");
      assert.equal(i18n.process.computerQueueLabel(progress), labels[index]);
      assert.doesNotMatch(i18n.process.computerQueueLabel(progress), /computer|电脑|電腦/i);
    }
  }
});

test("actual Web summaries show queue progress, count only executed work and do not keep paused waiting as the run status", () => {
  const i18n = createI18nHarness("en");
  const load = createLoader(require("typescript"), require, {
    [path.join(root, "web/src/lib/i18n.ts")]: i18n.web,
    [path.join(root, "shared/i18n/process.ts")]: i18n.process,
    [path.join(root, "web/src/components/process.css")]: {},
    [path.join(root, "web/src/components/ProcessSteps.tsx")]: {
      Collapse: () => null, hueStyle: () => ({}), toolIcon: () => null, ThinkingRow: () => null, ToolRow: () => null, ToolGroup: () => null, ProgressRow: () => null, RunningBars: () => null,
    },
  });
  const { ProcessTimeline: ProcessSummary } = load(path.join(root, "web/src/components/ProcessTimeline.tsx"));
  const executed = entry(1, step({}, { name: "exec", status: "completed" }));
  const props = { renderBody: () => null, timeline: [executed, entry(2)], active: true, status: "waiting_resource", resource: "desktop:fixture" };
  const render = (patch = {}) => renderToStaticMarkup(React.createElement(ProcessSummary, { ...props, ...patch }));
  const waiting = render();
  assert.match(waiting, /Waiting for computer/);
  assert.match(waiting, /2 requests ahead/);
  assert.match(waiting, /Waited/);
  assert.doesNotMatch(waiting, /Run elapsed|step completed/);
  const projectWaiting = render({ timeline: [executed, entry(2, step(output({ resource: "project" })))], resource: "project:fixture" });
  assert.match(projectWaiting, /Waiting for workspace/);
  assert.match(projectWaiting, /2 requests ahead/);
  assert.doesNotMatch(projectWaiting, /computer/i);
  const paused = entry(2, step(output({ status: "paused" }), { status: "completed", outcome: "not_executed" }));
  const resumedModel = render({ timeline: [executed, paused], status: "running" });
  assert.doesNotMatch(resumedModel, /Waiting for computer|requests ahead/);
  assert.doesNotMatch(resumedModel, /Waited/);
  const complete = render({ timeline: [executed, paused, entry(3, step({ status: "acquired", resource: "desktop", executed: false }, { status: "completed", outcome: "not_executed" }))], status: "completed", active: false });
  assert.match(complete, /1 tool call\b/);
  assert.doesNotMatch(complete, /[23] tool calls/);
});
