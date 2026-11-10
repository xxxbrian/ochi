const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync(path.resolve(__dirname, "../src/lib/sessionGroups.ts"), "utf8");
const module_ = { exports: {} };
new Function("module", "exports", ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(module_, module_.exports);
const { groupSessions } = module_.exports;

const now = new Date(2026, 10, 10, 15, 0, 0);
const at = (days, hour = 12) => new Date(2026, 10, 10 - days, hour).toISOString();
const session = (id, updated_at) => ({ id, title: id, updated_at });

test("sessions group by local calendar day and keep order", () => {
  const groups = groupSessions([session("a", at(0, 9)), session("b", at(0, 1)), session("c", at(1, 23)), session("d", at(4)), session("e", at(6)), session("f", at(7)), session("bad", "nope")], now);
  assert.deepEqual(groups.map((group) => [group.key, group.items.map((item) => item.id)]), [
    ["today", ["a", "b"]], ["yesterday", ["c"]], ["week", ["d", "e"]], ["older", ["f", "bad"]],
  ]);
});

test("empty buckets are omitted", () => {
  assert.deepEqual(groupSessions([session("x", at(30))], now).map((group) => group.key), ["older"]);
  assert.deepEqual(groupSessions([], now), []);
});
