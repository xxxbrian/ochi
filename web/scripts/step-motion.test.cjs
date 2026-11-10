const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync(path.resolve(__dirname, "../src/lib/stepMotion.ts"), "utf8");
const module_ = { exports: {} };
new Function("module", "exports", ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(module_, module_.exports);
const { stepMotion } = module_.exports;

test("each tool family has its own running motion, never a generic spinner", () => {
  assert.equal(stepMotion("exec", "terminal"), "caret");
  assert.equal(stepMotion("web_search", "search"), "sweep");
  assert.equal(stepMotion("web_fetch", "search"), "ripple");
  assert.equal(stepMotion("files_read", "files"), "lines");
  assert.equal(stepMotion("browser_goto", "browser"), "ripple");
  assert.equal(stepMotion("generate_image", "image"), "twinkle");
  assert.equal(stepMotion("computer_click", "computer"), "nudge");
  assert.equal(stepMotion("memory_save", "tool"), "pulse");
  assert.equal(stepMotion("mcp_x", "tool"), "pulse");
  assert.equal(stepMotion("", "reasoning"), "glow");
  assert.equal(stepMotion("", "group"), "stack");
});

test("process sheets keep no rotation and no look-name branching", () => {
  for (const file of ["process.css", "sidebar.css", "computer.css"]) {
    const css = fs.readFileSync(path.resolve(__dirname, "../src/components", file), "utf8");
    assert.doesNotMatch(css, /rotate\(|data-look/, file);
  }
});
