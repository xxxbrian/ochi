const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const React = require("react");
const { render, act, cleanup } = require("@testing-library/react");
const load = require("../../shared/conversation/test-loader.cjs").createLoader(require("typescript"), require);
const { useStickToEnd } = load(path.resolve(__dirname, "../src/hooks/useStickToEnd.ts"));

function box() {
  let height = 1000;
  let top = 0;
  let node;
  let tick = 0;
  let enabled = true;
  function Probe({ tick, enabled }) {
    const ref = React.useRef(null);
    const attach = React.useCallback((element) => {
      ref.current = element;
      if (!element) return;
      node = element;
      Object.defineProperties(element, {
        clientHeight: { get: () => 200 },
        scrollHeight: { get: () => height },
        scrollTop: {
          get: () => top,
          set(value) {
            const next = Math.max(0, Math.min(value, height - 200));
            // Browsers emit no scroll event when an assignment leaves the position unchanged.
            if (next === top) return;
            top = next;
            queueMicrotask(() => element.dispatchEvent(new dom.window.Event("scroll")));
          },
        },
      });
    }, []);
    useStickToEnd(ref, tick, enabled);
    return React.createElement("pre", { ref: attach });
  }
  let view;
  return {
    get top() { return top; },
    async mount() {
      await act(async () => { view = render(React.createElement(Probe, { tick, enabled })); });
    },
    async update(nextHeight = height, nextEnabled = enabled) {
      height = nextHeight;
      enabled = nextEnabled;
      await act(async () => { view.rerender(React.createElement(Probe, { tick: ++tick, enabled })); });
    },
    async scroll(value) {
      await act(async () => {
        top = value;
        node.dispatchEvent(new dom.window.Event("scroll"));
      });
    },
  };
}
test.afterEach(cleanup);

test("a live bounded box follows new text while the reader stays at its end", async () => {
  const value = box();
  await value.mount();
  assert.equal(value.top, 800);
  await value.update(1100);
  assert.equal(value.top, 900);
  await value.update(1300);
  assert.equal(value.top, 1100);
});

test("tokens that do not add a line never consume the reader's first upward scroll", async () => {
  const value = box();
  await value.mount();
  await value.update();
  await value.update();
  await value.scroll(400);
  await value.update(1020);
  assert.equal(value.top, 400);
  await value.update(1040);
  assert.equal(value.top, 400);
});

test("returning to the bottom resumes following without remounting the box", async () => {
  const value = box();
  await value.mount();
  await value.scroll(400);
  await value.update(1100);
  assert.equal(value.top, 400);
  await value.scroll(900);
  await value.update(1200);
  assert.equal(value.top, 1000);
});

test("settled content does not follow; starting another live segment attaches immediately", async () => {
  const value = box();
  await value.mount();
  await value.scroll(400);
  await value.update(1100, false);
  await value.scroll(300);
  await value.update(1200, false);
  assert.equal(value.top, 300);
  await value.update(1200, true);
  assert.equal(value.top, 1000);
});
