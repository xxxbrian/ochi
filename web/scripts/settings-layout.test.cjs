const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const css = strip(read('src/components/settings/settings.css'));
const tsx = read('src/components/UserSettings.tsx');
const appearance = read('src/lib/appearance.ts');
const settingsFiles = fs.readdirSync(path.join(__dirname, '..', 'src/components/settings')).filter((file) => file.endsWith('.tsx'));
const rules = (selector) => [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)]
  .filter((match) => match[1].trim() === selector)
  .map((match) => Object.fromEntries(match[2].split(';').map((declaration) => declaration.trim().split(/:\s*/)).filter(([key, value]) => key && value)));

test('settings dialog has one stable height capped to the viewport', () => {
  const popup = rules('.modal.st-modal');
  assert.equal(popup.length, 1);
  assert.equal(popup[0].height, 'min(620px, calc(100dvh - 32px))');
  assert.ok(!rules('.st-shell').some((rule) => rule['max-height']), 'the shell must not compete with the popup height');
});

test('settings content scrolls inside a shrinkable shell rather than growing the dialog', () => {
  assert.equal(rules('.modal-body.st-modal-body')[0].overflow, 'hidden');
  assert.equal(rules('.st-shell')[0]['min-height'], '0');
  const scroll = rules('.st-scroll')[0];
  assert.equal(scroll['min-height'], '0');
  assert.equal(scroll['overflow-y'], 'auto');
  assert.equal(scroll['overscroll-behavior'], 'contain');
  assert.equal(scroll['scrollbar-gutter'], 'stable');
});

test('narrow containers turn the rail into a list that drills into a page', () => {
  assert.match(css, /container:\s*st \/ inline-size/);
  assert.match(css, /@container st \(max-width: 640px\)/);
  assert.match(css, /\.st-shell\[data-view="content"\] \.st-nav/);
  assert.match(css, /\.st-shell\[data-view="nav"\] \.st-mn/);
  assert.match(tsx, /data-view=\{view\}/);
  assert.match(tsx, /setView\("nav"\)/);
});

test('switching categories fades the pane, then swaps and resets one shared scroller', () => {
  assert.match(tsx, /TAB_SWAP_MS/);
  assert.match(tsx, /setShown\(next\)/);
  assert.match(tsx, /scroller\.current\?\.scrollTo\(\{ top: 0 \}\)/);
  assert.equal((tsx.match(/className="st-scroll"/g) ?? []).length, 1, 'one scroll container serves every category');
});

test('settings radii and motion come from tokens', () => {
  assert.ok(!/border-radius:\s*\d+px/.test(css.replace(/border-radius:\s*(3px|50%)/g, '')), 'raw radii bypass the look tokens');
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('every category the shell lists has a tab component and no tab invents controls without a backend', () => {
  for (const tab of ['General', 'Appearance', 'Models', 'Memory', 'Plugins', 'Data', 'Account']) {
    assert.ok(settingsFiles.includes(`${tab}Tab.tsx`), `${tab}Tab.tsx`);
    assert.match(tsx, new RegExp(`<${tab}Tab`));
  }
  const all = settingsFiles.map((file) => read(`src/components/settings/${file}`)).join('\n');
  assert.ok(!/password|api[_ ]?token|deleteAccount/i.test(all), 'password, token and account deletion have no endpoint');
});

test('appearance rows are backed by real tokens and attributes', () => {
  assert.match(appearance, /--font-scale/);
  assert.match(appearance, /--density/);
  assert.match(appearance, /dataset\.reduce/);
  assert.match(read('src/design/tokens.css'), /:root\[data-reduce="true"\]\s*\{\s*--speed:\s*100/);
});
