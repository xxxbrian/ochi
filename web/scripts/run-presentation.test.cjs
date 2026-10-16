const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function load(file, imports = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, require(name) { if (name in imports) return imports[name]; throw new Error(`Unexpected import ${name}`); } });
  return module.exports;
}
const process = load("src/lib/processTimeline.ts");
const { transcriptPlan, transcriptRows, formatReasoningDisplay } = load("src/lib/runPresentation.ts", { "./processTimeline": process });
const plain = (value) => JSON.parse(JSON.stringify(value));
const publicText = (id, seq, text, extra = {}) => ({ id, seq, kind: "progress", text, ...extra });
const thinking = (id, seq) => ({ id, seq, kind: "reasoning", reasoning: { id, kind: "reasoning", text: "Thinking" } });
const tool = (id, seq) => ({ id, seq, kind: "tool", step: { id, name: "exec", status: "completed" } });

test("public blocks keep their original slots while only adjacent technical entries group", () => {
  const entries = [publicText("P1", 1, "Checking", { pending: true }), thinking("R1", 2), tool("T1", 3), publicText("P2", 4, "Found sources"), thinking("R2", 5), publicText("P3", 6, "Answer", { final: true })];
  const rows = transcriptRows(entries);
  assert.deepEqual(Array.from(rows, (row) => row.id), ["P1", "process:R1", "P2", "process:R2", "P3"]);
  assert.deepEqual(Array.from(rows[1].entries, (entry) => entry.id), ["R1", "T1"]);
  assert.equal(rows[0].entry, entries[0]);
  assert.equal(transcriptPlan(entries, "Answer", "running").fallback, "");
});

test("only completion rolls up exploration; final public IDs and multiple final items stay distinct", () => {
  const entries = [publicText("P1", 1, "Checking"), thinking("R1", 2), publicText("P2", 3, "First ", { final: true }), publicText("P3", 4, "second", { final: true })];
  for (const status of ["running", "waiting_user", "waiting_resource", "failed", "cancelled"]) {
    assert.equal(transcriptPlan(entries, "First second", status).canRollUp, false, status);
  }
  const plan = transcriptPlan(entries, "First second", "completed");
  assert.equal(plan.canRollUp, true);
  assert.equal(plan.fallback, "");
  assert.deepEqual(Array.from(plan.finalIds), ["P2", "P3"]);
  assert.equal(plan.rows.at(-1).entry, entries.at(-1));
});

test("output remains authoritative when a saved timeline contains only earlier public progress", () => {
  const entries = [publicText("P1", 1, "I will check"), tool("T1", 2)];
  const plan = transcriptPlan(entries, "The final answer", "completed");
  assert.equal(plan.fallback, "The final answer");
  assert.equal(plan.canRollUp, true);
  for (const status of ["running", "failed", "cancelled"]) {
    assert.equal(transcriptPlan(entries, "Partial answer", status).fallback, "Partial answer");
  }
});

test("commentary between final items does not manufacture a duplicate output block", () => {
  const entries = [publicText("F1", 1, "First ", { final: true }), publicText("C", 2, "Checking the source"), publicText("F2", 3, "second", { final: true })];
  const plan = transcriptPlan(entries, "First second", "completed");
  assert.equal(plan.fallback, "");
  assert.deepEqual(Array.from(plan.finalIds), ["F1", "F2"]);
  assert.equal(plan.canRollUp, true);
  assert.deepEqual(Array.from(plan.rows, (row) => row.id), ["F1", "C", "F2"]);
});

test("uncommitted candidate blocks separated by explicit commentary also render only once", () => {
  const entries = [publicText("P1", 1, "First ", { pending: true }), publicText("C", 2, "Checking the source"), publicText("P2", 3, "second", { pending: true })];
  assert.equal(transcriptPlan(entries, "First second", "running").fallback, "");
  const terminal = transcriptPlan(entries, "First second", "completed");
  assert.equal(terminal.fallback, "");
  assert.deepEqual(Array.from(terminal.finalIds), ["P1", "P2"]);
});

test("an unflagged output suffix is represented without duplication and pure answers have no empty process", () => {
  const entries = [publicText("P1", 1, "Checking"), publicText("P2", 2, "The answer")];
  const plan = transcriptPlan(entries, "The answer", "completed");
  assert.equal(plan.fallback, "");
  assert.deepEqual(Array.from(plan.finalIds), ["P2"]);
  assert.equal(plan.canRollUp, true);
  const pure = transcriptPlan([publicText("F", 1, "Answer", { final: true })], "Answer", "completed");
  assert.equal(pure.hasWork, false);
  assert.equal(pure.canRollUp, false);
  const pureUnflagged = transcriptPlan([publicText("F", 1, "Answer", { pending: true })], "Answer", "completed");
  assert.equal(pureUnflagged.hasWork, false);
  assert.deepEqual(plain(pureUnflagged.rows).map((row) => row.id), ["F"]);
});

test("only an entire repeated bold-title string gets visual paragraph boundaries", () => {
  assert.equal(formatReasoningDisplay("**First****Second****Third**"), "**First**\n\n**Second**\n\n**Third**");
  assert.equal(formatReasoningDisplay("**First** **Second**"), "**First**\n\n**Second**");
  for (const text of ["**One**", "Text **First****Second**", "**First**\nordinary explanation", "**First****Unfinished", "**First**\n\nA paragraph", "# A title\nNext"]) {
    assert.equal(formatReasoningDisplay(text), text);
  }
});
