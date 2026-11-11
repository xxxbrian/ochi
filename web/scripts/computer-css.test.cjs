const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const css = fs.readFileSync(path.join(__dirname, "../src/components/computer.css"), "utf8");
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));

test("computer UI reads radii and colours from tokens and never branches on the look", () => {
  assert.doesNotMatch(css, /data-look/);
  assert.doesNotMatch(css, /border-radius:\s*\d+px/);
  assert.doesNotMatch(css, /\b(?:colorful|purple)\b/i);
});

test("only icon glyphs rotate; no tile, ring or card box spins around its content", () => {
  const animated = rules.filter((rule) => /animation:[^;]*\bcu-flip\b/.test(rule.body));
  assert.ok(animated.length > 0, "the hourglass flip is part of the queue design");
  for (const rule of animated) assert.match(rule.selector, /\bsvg\b/, `${rule.selector} must rotate only its icon`);
  const spinning = rules.filter((rule) => /(?:^|;)\s*(?:rotate|transform)\s*:[^;]*rotate/.test(rule.body) && /animation/.test(rule.body));
  assert.deepEqual(spinning.map((rule) => rule.selector), []);
});

test("the live-desktop ring animates a registered angle, not the element", () => {
  assert.match(css, /@property --cu-angle\s*\{\s*syntax:\s*"<angle>"/);
  assert.match(css, /@keyframes cu-orbit\s*\{\s*to\s*\{\s*--cu-angle:\s*360deg/);
  const ring = rules.find((rule) => rule.selector === ".cu-viewport::after");
  assert.ok(ring && !/rotate|transform|animation/.test(ring.body), "the ring is a static masked gradient");
  const live = rules.find((rule) => rule.selector === '.cu-stage[data-view="ai"] .cu-viewport::after');
  assert.ok(live && /animation:\s*cu-orbit/.test(live.body) && !/rotate|transform/.test(live.body), "only the driving state animates the angle");
});

test("reduced motion collapses every computer animation", () => {
  const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  for (const target of [".cu-body *", ".cu-perm *", ".cu-queue *", ".cu-live *"]) assert.ok(block.includes(target), target);
  assert.match(block, /animation-duration:\s*0\.01ms !important/);
});

test("the dock must not hold an animation or transform, which would trap the fixed full-screen stage inside it", () => {
  const dock = rules.find((rule) => rule.selector === ".computer-dock");
  assert.ok(dock, "the right-hand dock exists");
  assert.doesNotMatch(dock.body, /animation:[^;]*\b(?:both|forwards)\b/);
  assert.doesNotMatch(dock.body, /\b(?:transform|filter|backdrop-filter|will-change|contain)\s*:/);
  const stage = rules.find((rule) => rule.selector === ".cu-stage[data-fs]");
  assert.ok(stage && /position:\s*fixed/.test(stage.body), "full screen lifts the stage in place so the canvas never remounts");
});

test("the dock reads its default width from the shared token and the desktop viewport keeps the 16:10 workspace shape", () => {
  const dock = rules.find((rule) => rule.selector === ".computer-dock");
  assert.match(dock.body, /width:\s*var\(--dock-w\)/);
  const viewport = rules.find((rule) => rule.selector === ".cu-viewport");
  assert.match(viewport.body, /aspect-ratio:\s*16\s*\/\s*10/);
});
