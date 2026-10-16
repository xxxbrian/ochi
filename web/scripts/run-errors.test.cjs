const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

for (const client of ['web', 'mobile']) {
  test(`${client}: output-limit failure is understandable without claiming a completed reply`, () => {
    const filename = path.resolve(__dirname, `../../${client}/src/lib/api.ts`);
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'userFacingRunError');
    assert.ok(declaration);
    const output = ts.transpileModule(declaration.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(output, { module, exports: module.exports });
    const format = module.exports.userFacingRunError;
    assert.equal(format('model response ended with an output limit'), '\u6a21\u578b\u5df2\u8fbe\u5230\u672c\u8f6e\u8f93\u51fa\u4e0a\u9650\uff0c\u56de\u590d\u5c1a\u672a\u5b8c\u6210\u3002');
    assert.equal(format('model response ended with an output limit', true), '\u4efb\u52a1\u672a\u80fd\u5b8c\u6210\uff0c\u5df2\u6709\u6587\u4ef6\u4ecd\u53ef\u4f7f\u7528\u3002');
    assert.equal(format('specific user-facing \u4e2d\u6587'), 'specific user-facing \u4e2d\u6587');
  });
}
