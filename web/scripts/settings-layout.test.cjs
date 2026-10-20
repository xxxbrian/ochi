const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const css = read('src/components/settings.css').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = (selector) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((match) => match[1].trim() === selector)
  .map((match) => Object.fromEntries(match[2].split(';').map((declaration) => declaration.trim().split(/:\s*/)).filter(([key, value]) => key && value)));

test('settings popup has one stable height capped to desktop and mobile viewports', () => {
  const popup = rules('.modal.ochi-settings-modal');
  assert.equal(popup.length, 2);
  assert.equal(popup[0].height, 'min(680px, calc(100dvh - 32px))');
  assert.equal(popup[1].height, 'min(680px, calc(100dvh - 24px))');
  assert.ok(!rules('.ochi-settings').some((rule) => rule['max-height']), 'the inner grid must not compete with the popup height');
});

test('settings content scrolls inside a shrinkable shell rather than growing the popup', () => {
  assert.equal(rules('.modal-body.ochi-settings-body')[0].overflow, 'hidden');
  assert.equal(rules('.ochi-settings')[0]['min-height'], '0');
  const content = rules('.ochi-settings__content')[0];
  assert.equal(content['min-height'], '0');
  assert.equal(content['overflow-y'], 'auto');
  assert.equal(content['overscroll-behavior'], 'contain');
  assert.equal(content['scrollbar-gutter'], 'stable');
});

test('settings categories remain accessible in short and narrow viewports', () => {
  const rail = rules('.ochi-settings__rail');
  assert.equal(rail[0]['min-height'], '0');
  assert.equal(rail[0]['overflow-y'], 'auto');
  assert.equal(rail[1]['overflow-x'], 'auto');
  assert.equal(rail[1]['flex-shrink'], '0');
});

test('switching sections resets the content scroller without changing the dialog shell', () => {
  const source = ts.createSourceFile('UserSettings.tsx', read('src/components/UserSettings.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let content;
  function visit(node) {
    if (ts.isJsxOpeningElement(node) && node.attributes.properties.some((attribute) =>
      ts.isJsxAttribute(attribute) && attribute.name.text === 'className' && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === 'ochi-settings__content')) content = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(content, 'settings has one shared scroll container');
  const key = content.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.text === 'key');
  assert.equal(key?.initializer?.expression?.getText(source), 'section');
});
