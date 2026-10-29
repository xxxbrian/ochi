const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { createI18nHarness } = require("./i18n-harness.cjs");

for (const client of ["web", "mobile"]) {
  test(`${client}: stable run codes use the viewer language and keep private diagnostics hidden`, () => {
    const i18n = createI18nHarness();
    const filename = path.resolve(__dirname, `../../${client}/src/lib/api.ts`);
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "userFacingRunError");
    assert.ok(declaration);
    const output = ts.transpileModule(declaration.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(output, {
      module, exports: module.exports,
      t: i18n[client].t,
      translateError: i18n.errors.translateError,
    });
    const format = module.exports.userFacingRunError;
    for (const locale of ["en", "zh-CN", "zh-TW"]) {
      i18n.runtime.setLanguage(locale);
      assert.equal(format("private provider trace", false, "model_output_limit"), i18n.errors.translateError("model_output_limit"));
      assert.equal(format("other raw diagnostic", false, "run_timeout"), i18n.errors.translateError("run_timeout"));
      const safeFallback = i18n[client].t(client === "web" ? "runError.failed" : "error.run");
      assert.equal(format("provider said 中文 private diagnostics"), safeFallback);
      assert.equal(format("unknown technical text", false, "unrecognized_upstream_code"), safeFallback);
      assert.equal(format("private provider trace", true, "model_output_limit"),
        i18n[client].t(client === "web" ? "runError.artifacts" : "error.runWithFiles"));
    }
  });
}
