const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/lib/modelSelection.ts"), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleValue = { exports: {} };
vm.runInNewContext(output, { module: moduleValue, exports: moduleValue.exports });
const { preferredChatModel, moveModel } = moduleValue.exports;
const models = [{ id: "first", is_default: false }, { id: "default", is_default: true }, { id: "chosen", is_default: false }];

test("explicit user choice wins over default and published order", () => {
  assert.equal(preferredChatModel(models, "chosen"), models[2]);
  assert.equal(preferredChatModel([...models].reverse(), "chosen"), models[2]);
});
test("new account, missing or unpublished preference uses administrator default", () => {
  for (const preference of [undefined, "", "removed"]) assert.equal(preferredChatModel(models, preference), models[1]);
  assert.equal(preferredChatModel(models.filter((model) => !model.is_default), "removed"), models[0]);
  assert.equal(preferredChatModel([], "chosen"), undefined);
});
test("order changes preserve input and cannot duplicate or discard models", () => {
  const ids = ["a", "b", "c"];
  assert.deepEqual(Array.from(moveModel(ids, "b", -1)), ["b", "a", "c"]);
  assert.deepEqual(Array.from(moveModel(ids, "b", 1)), ["a", "c", "b"]);
  for (const [id, offset] of [["a", -1], ["c", 1], ["missing", -1]]) assert.deepEqual(Array.from(moveModel(ids, id, offset)), ids);
  assert.deepEqual(ids, ["a", "b", "c"]);
});
