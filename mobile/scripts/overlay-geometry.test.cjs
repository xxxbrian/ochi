const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const moduleSource = fs.readFileSync(path.resolve(__dirname, '../src/ui/overlayGeometry.ts'), 'utf8');
const output = ts.transpileModule(moduleSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = { exports: {} };
vm.runInNewContext(output, { module: loaded, exports: loaded.exports });
const { anchorGeometryKey, anchoredMenuLayout, overlayBounds, sheetKeyboardLayout } = loaded.exports;

test('anchor geometry tracks same-width safe-area flips but ignores IME height and bottom-inset changes', () => {
  const initial = anchorGeometryKey(852, { left: 32, right: 0, top: 0, bottom: 24 });
  assert.equal(anchorGeometryKey(852, { left: 32, right: 0, top: 0, bottom: 0 }), initial);
  assert.notEqual(anchorGeometryKey(852, { left: 0, right: 32, top: 0, bottom: 24 }), initial);
  assert.notEqual(anchorGeometryKey(852, { left: 32, right: 0, top: 16, bottom: 24 }), initial);
});

test('sheet keyboard geometry subtracts only real Dialog overlap, never a second keyboard height from a resized root', () => {
  const fullscreen = sheetKeyboardLayout(393, 393, 214, 8, 385);
  assert.equal(fullscreen.bottom, 214);
  assert.equal(fullscreen.height, 171);
  const resized = sheetKeyboardLayout(179, 393, 214, 8, 171);
  assert.equal(resized.bottom, 0);
  assert.equal(resized.height, 171);
  const partial = sheetKeyboardLayout(300, 393, 214, 8, 292);
  assert.equal(partial.bottom, 121);
  assert.equal(partial.height, 171);
  assert.equal(sheetKeyboardLayout(393, 393, 0, 8, 280).height, 280);
});

test('menu placement respects either landscape notch, screen edges and a docked keyboard', () => {
  for (const insets of [{ top: 0, bottom: 21, left: 59, right: 59 }, { top: 0, bottom: 24, left: 0, right: 32 }]) {
    for (const align of ['start', 'end']) {
      for (const anchor of [{ x: 0, y: 6, width: 44, height: 44 }, { x: 830, y: 270, width: 44, height: 44 }]) {
        const layout = anchoredMenuLayout({ width: 852, height: 393 }, insets, anchor, 300, 1200, align, 215);
        assert.ok(layout.left >= insets.left + 12);
        assert.ok(layout.left + layout.width <= 852 - insets.right - 12);
        assert.ok(layout.top >= insets.top + 8);
        assert.ok(layout.top + layout.height <= 215 - 8);
      }
    }
  }
});

test('short available height does not manufacture a 46-point menu that extends into the keyboard', () => {
  const layout = anchoredMenuLayout({ width: 393, height: 280 }, { top: 59, bottom: 21, left: 0, right: 0 }, { x: 20, y: 75, width: 44, height: 40 }, 260, 400, 'start', 100);
  assert.equal(layout.maxHeight, 25);
  assert.equal(layout.top + layout.height, 92);
});

test('a keyboard frame outside the new orientation is clamped to the physical safe area', () => {
  const safe = overlayBounds({ width: 852, height: 393 }, { top: 0, bottom: 21, left: 59, right: 59 }, 600);
  assert.equal(safe.bottom, 364);
  assert.equal(safe.width, 710);
});
