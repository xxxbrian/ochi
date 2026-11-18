const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.invalid/" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
});
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const React = require("react");
const { render, act, cleanup, fireEvent } = require("@testing-library/react");
const { createLoader } = require("../../shared/conversation/test-loader.cjs");
const i18n = require("./i18n-harness.cjs").createI18nHarness("en");
const root = path.resolve(__dirname, "../..");
const load = createLoader(require("typescript"), require, {
  [path.join(root, "web/src/lib/i18n.ts")]: i18n.web,
  [path.join(root, "web/src/components/ComputerQueueDetails.tsx")]: { ComputerQueueDetails: () => null },
  [path.join(root, "web/src/components/SearchSources.tsx")]: { Favicon: () => null },
  [path.join(root, "web/src/components/ThinkingDetails.tsx")]: {
    ThinkingContent: ({ part }) => React.createElement("p", {}, part.text),
  },
  [path.join(root, "web/src/components/ToolBodies.tsx")]: {
    ToolBody: ({ step }) => React.createElement("pre", {}, step.output),
  },
});
const { ProcessTimeline } = load(path.join(root, "web/src/components/ProcessTimeline.tsx"));
const thought = (id, seq) => ({
  id, seq, kind: "reasoning", reasoning: { id, kind: "reasoning", text: `Plan ${id}`, done: true },
});
const tool = (id, seq, status = "completed") => ({
  id, seq, kind: "tool", step: {
    id, name: "exec", status, arguments: { command: `echo ${id}` }, output: `Result ${id}`,
  },
});
const row = (view, id) => view.container.querySelector(`[data-process-id="${id}"]`);
const head = (node) => node.querySelector(":scope > .step-row > .st-main > .st-head");
const folded = (view, id) => row(view, id).dataset.fold;
const props = (timeline, patch = {}) => ({
  timeline, active: true, status: "running", renderBody: (text) => text, ...patch,
});
async function click(button) {
  await act(async () => { fireEvent.click(button); });
}
test.afterEach(cleanup);

test("automatic live disclosure remains compact at both timeline and tool-group levels", () => {
  const view = render(React.createElement(ProcessTimeline, props([
    thought("R1", 1), tool("T1", 2), tool("T2", 3, "running"),
  ])));
  assert.equal(view.container.querySelector(".proc-head").getAttribute("aria-expanded"), "true");
  assert.equal(folded(view, "R1"), "true");
  assert.equal(head(row(view, "T1")).getAttribute("aria-expanded"), "true");
  const nested = row(view, "T1").querySelector(".steps.nested");
  assert.equal(nested.children[0].dataset.fold, "true");
  assert.equal(nested.children[1].dataset.fold, "false");
});

test("manual process expansion keeps earlier reasoning and tool rows as streamed work grows", async () => {
  const first = [thought("R1", 1), tool("T1", 2), tool("T2", 3, "running")];
  const view = render(React.createElement(ProcessTimeline, props(first)));
  const header = view.container.querySelector(".proc-head");
  await click(header);
  await click(header);
  assert.equal(folded(view, "R1"), "false");
  assert.deepEqual([...row(view, "T1").querySelector(".steps.nested").children].map((node) => node.dataset.fold), ["false", "false"]);

  const growing = [...first.slice(0, 2), tool("T2", 3), thought("R2", 4), tool("T3", 5), tool("T4", 6, "running")];
  await act(async () => { view.rerender(React.createElement(ProcessTimeline, props(growing))); });
  assert.deepEqual([...view.container.querySelectorAll("[data-process-id]")].map((node) => node.dataset.fold), Array(8).fill("false"));
  assert.equal(view.container.querySelector(".proc-head"), header, "streaming preserves the reader's control and choice");
  await act(async () => { view.rerender(React.createElement(ProcessTimeline, props(growing, { active: false, status: "completed" }))); });
  assert.equal(header.getAttribute("aria-expanded"), "true", "completion preserves explicit reader expansion");
  assert.equal(folded(view, "R1"), "false");
});

test("an explicitly opened tool group retains all children through growth, idle gaps and resumed tools", async () => {
  const entries = [thought("R1", 1), tool("T1", 2), tool("T2", 3, "running")];
  const view = render(React.createElement(ProcessTimeline, props(entries)));
  const groupHeader = head(row(view, "T1"));
  await click(groupHeader);
  await click(groupHeader);
  const children = () => [...row(view, "T1").querySelector(".steps.nested").children];
  assert.deepEqual(children().map((node) => node.dataset.fold), ["false", "false"]);
  assert.equal(folded(view, "R1"), "true", "a nested choice does not expand the entire timeline");

  const paused = [entries[0], entries[1], tool("T2", 3), tool("T3", 4)];
  await act(async () => { view.rerender(React.createElement(ProcessTimeline, props(paused))); });
  assert.equal(head(row(view, "T1")), groupHeader);
  assert.equal(groupHeader.getAttribute("aria-expanded"), "true");
  assert.deepEqual(children().map((node) => node.dataset.fold), ["false", "false", "false"]);
  await act(async () => { view.rerender(React.createElement(ProcessTimeline, props([...paused, tool("T4", 5, "running")]))); });
  assert.deepEqual(children().map((node) => node.dataset.fold), ["false", "false", "false", "false"]);
  assert.equal(groupHeader.getAttribute("aria-expanded"), "true");

  await click(groupHeader);
  await act(async () => { view.rerender(React.createElement(ProcessTimeline, props([...paused, tool("T4", 5), tool("T5", 6, "running")]))); });
  assert.equal(groupHeader.getAttribute("aria-expanded"), "false", "later work cannot override an explicit collapse");
});

test("controlled reader expansion disables peek, while untouched completed history stays collapsed", () => {
  const entries = [thought("R1", 1), tool("T1", 2), tool("T2", 3, "running")];
  const view = render(React.createElement(ProcessTimeline, props(entries, { expanded: true })));
  assert.equal(folded(view, "R1"), "false");
  assert.deepEqual([...row(view, "T1").querySelector(".steps.nested").children].map((node) => node.dataset.fold), ["false", "false"]);
  view.unmount();
  const history = render(React.createElement(ProcessTimeline, props(entries, { active: false, status: "completed" })));
  assert.equal(history.container.querySelector(".proc-head").getAttribute("aria-expanded"), "false");
  assert.equal(history.container.querySelector(".proc-body"), null);
});
