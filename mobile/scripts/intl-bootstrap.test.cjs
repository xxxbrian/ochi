const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

test('native entry installs the real Hermes Intl prerequisites before routing and formats every catalog message', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const ts = require('typescript');
    const dateTime = Intl.DateTimeFormat;
    const number = Intl.NumberFormat;
    const canonical = Intl.getCanonicalLocales;
    delete Intl.Locale;
    delete Intl.PluralRules;
    delete Intl.RelativeTimeFormat;
    let routed = false;
    const entry = require('./package.json').main;
    vm.compileFunction(fs.readFileSync(entry, 'utf8'), ['require'])((name) => {
      if (name !== 'expo-router/entry') return require(name);
      routed = true;
      assert.equal(typeof Intl.Locale, 'function');
      assert.equal(typeof Intl.PluralRules, 'function');
      assert.deepEqual(Intl.PluralRules.supportedLocalesOf(['en', 'zh-CN', 'zh-TW']), ['en', 'zh-CN', 'zh-TW']);
    });
    assert.ok(routed);
    assert.equal(Intl.DateTimeFormat, dateTime);
    assert.equal(Intl.NumberFormat, number);
    assert.equal(Intl.getCanonicalLocales, canonical);
    assert.equal(Intl.RelativeTimeFormat, undefined);
    function load(file) {
      const module = { exports: {} };
      const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText;
      vm.compileFunction(source, ['module', 'exports', 'require'])(module, module.exports, require);
      return module.exports;
    }
    const core = load('../shared/i18n/index.ts');
    const { messages } = load('src/lib/messages.ts');
    const expected = { en: ['other', 'one', 'other'], 'zh-CN': ['other', 'other', 'other'], 'zh-TW': ['other', 'other', 'other'] };
    for (const locale of core.locales) {
      assert.deepEqual([0, 1, 2].map(count => new Intl.PluralRules(locale).select(count)), expected[locale]);
      for (const count of [0, 1, 2, 1000]) {
        for (const [key, message] of Object.entries(messages)) {
          assert.doesNotThrow(() => core.formatMessage(message, { count, name: 'fixture' }, locale), key + ':' + locale);
        }
      }
      assert.ok(core.formatMessage(messages['process.completedSteps'], { count: 2 }, locale));
      assert.ok(core.formatDate('2026-01-01T00:00:00Z', { timeZone: 'UTC', year: 'numeric' }, locale).includes('2026'));
      assert.ok(core.formatNumber(1000, undefined, locale).length);
    }
    process.stdout.write('Hermes capability profile: catalog passed in en, zh-CN, zh-TW');
  `], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /catalog passed in en, zh-CN, zh-TW/);
});
