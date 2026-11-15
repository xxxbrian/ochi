const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

test("session creation preserves an explicit memory choice and omission leaves the server default intact", async () => {
  const filename = path.resolve(__dirname, "../src/lib/api.ts");
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
  const api = source.statements.flatMap((node) => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .find((node) => node.name.getText(source) === "api");
  const method = api.initializer.properties.find((node) => node.name.getText(source) === "createSession");
  const output = ts.transpileModule(`exports.createSession = ${method.initializer.getText(source)};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const calls = [], module = { exports: {} };
  vm.runInNewContext(output, {
    exports: module.exports, JSON,
    request: async (url, init) => { calls.push({ url, method: init.method, body: JSON.parse(init.body) }); },
  }, { filename });
  await module.exports.createSession("model", "high", "project", true, false);
  await module.exports.createSession("model", "", undefined, false, true);
  await module.exports.createSession();
  assert.deepEqual(calls, [
    { url: "/api/sessions", method: "POST",
      body: { model_id: "model", effort: "high", project_id: "project", computer_enabled: true, memory_enabled: false } },
    { url: "/api/sessions", method: "POST",
      body: { model_id: "model", effort: "", computer_enabled: false, memory_enabled: true } },
    { url: "/api/sessions", method: "POST", body: {} },
  ]);
});
