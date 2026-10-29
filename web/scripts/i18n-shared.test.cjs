const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createI18nHarness } = require("./i18n-harness.cjs");

const root = path.resolve(__dirname, "../..");
const locales = ["en", "zh-CN", "zh-TW"];
const variants = (value) => typeof value === "string" ? [value] : Object.values(value);
const parameters = (value) => [...new Set(variants(value).flatMap((text) =>
  [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((match) => match[1])))].sort();

test("system locale resolution handles scripts, regions and fallback without changing the saved preference", () => {
  const { runtime: i18n } = createI18nHarness("system");
  for (const [input, expected] of [
    ["en-GB", "en"], ["EN_us", "en"], ["zh", "zh-CN"], ["zh-SG", "zh-CN"],
    ["zh-HK", "zh-TW"], ["zh-MO", "zh-TW"], ["zh-Hant", "zh-TW"],
    ["zh-Hans-TW", "zh-CN"], ["zh-Hant-CN", "zh-TW"], ["fr-FR", undefined],
  ]) assert.equal(i18n.normalizeLocale(input), expected, input);
  assert.equal(i18n.resolveLocale(["fr-FR", "zh-HK", "en-US"]), "zh-TW");
  assert.equal(i18n.resolveLocale(["fr-FR", "ja-JP"]), "en");
  i18n.setSystemLanguages(["zh-HK"]);
  assert.equal(i18n.getLocale(), "zh-TW");
  assert.equal(i18n.getLanguage(), "system");
  i18n.setLanguage("en");
  i18n.setSystemLanguages(["zh-CN"]);
  assert.equal(i18n.getLocale(), "en");
  assert.equal(i18n.getLanguage(), "en");
  assert.throws(() => i18n.setLanguage("fr-FR"), /Unsupported language/);
});

test("locale subscriptions update mounted consumers once and observe system/explicit choices with the same resolved locale", () => {
  const { runtime: i18n } = createI18nHarness("system");
  i18n.setSystemLanguages(["en"]);
  const changes = [];
  const unsubscribe = i18n.subscribeLocale(() => changes.push([i18n.getLanguage(), i18n.getLocale()]));
  const initialRevision = i18n.getLocaleRevision();
  i18n.setLanguage("en");
  i18n.setLanguage("en");
  i18n.setSystemLanguages(["zh-TW"]);
  i18n.setLanguage("system");
  assert.deepEqual(changes, [["en", "en"], ["system", "zh-TW"]]);
  assert.equal(i18n.getLocaleRevision(), initialRevision + 2);
  unsubscribe();
  i18n.setLanguage("zh-CN");
  assert.equal(changes.length, 2);
});

test("message formatting uses named values, locale numbers and English plural rules", () => {
  const { runtime: i18n } = createI18nHarness("en");
  const message = {
    en: { one: "{name} ran {count} command", other: "{name} ran {count} commands" },
    "zh-CN": "{name} 已执行 {count} 条命令",
    "zh-TW": "{name} 已執行 {count} 條命令",
  };
  assert.equal(i18n.formatMessage(message, { name: "Ochi", count: 1 }), "Ochi ran 1 command");
  assert.equal(i18n.formatMessage(message, { name: "Ochi", count: 2000 }), "Ochi ran 2,000 commands");
  i18n.setLanguage("zh-TW");
  assert.equal(i18n.formatMessage(message, { name: "Ochi", count: 2 }), "Ochi 已執行 2 條命令");
  const t = i18n.createTranslator({ count: message });
  assert.throws(() => t("missing"), /Unknown translation key/);
  assert.equal(i18n.formatDate("invalid"), "\u2014");
  const date = "2026-10-29T04:05:00Z", options = { dateStyle: "medium", timeZone: "UTC" };
  assert.equal(i18n.formatDate(date, options), new Intl.DateTimeFormat("zh-TW", options).format(new Date(date)));
});

test("all maintained UI/process/public-error catalogs have three complete locales and identical named parameters", () => {
  const i18n = createI18nHarness();
  const catalogs = {
    admin: JSON.parse(fs.readFileSync(path.join(root, "web/src/pages/admin/messages.json"), "utf8")),
    errors: JSON.parse(fs.readFileSync(path.join(root, "server/internal/i18n/messages.json"), "utf8")),
  };
  for (const [name, filename] of [
    ["web", "web/src/lib/messages.ts"], ["mobile", "mobile/src/lib/messages.ts"],
    ["process", "shared/i18n/process.ts"],
  ]) {
    const source = fs.readFileSync(path.join(root, filename), "utf8") + "\nexports.catalog = messages;";
    const ts = require("typescript"), vm = require("node:vm"), module = { exports: {} };
    vm.runInNewContext(ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { module, exports: module.exports, require() { return i18n.runtime; } });
    catalogs[name] = module.exports.catalog;
  }
  for (const [name, catalog] of Object.entries(catalogs)) {
    assert.ok(catalog && Object.keys(catalog).length > 0, `${name} has messages`);
    for (const [key, message] of Object.entries(catalog)) {
      assert.deepEqual(Object.keys(message).sort(), [...locales].sort(), `${name}.${key}: locale coverage`);
      for (const locale of locales) {
        const value = message[locale];
        assert.ok(typeof value === "string" || (value && Object.keys(value).sort().join() === "one,other"),
          `${name}.${key}.${locale}: valid plural shape`);
        assert.ok(variants(value).every((text) => typeof text === "string" && text.trim()), `${name}.${key}.${locale}: nonempty`);
        assert.deepEqual(parameters(value), parameters(message.en), `${name}.${key}.${locale}: named parameters`);
      }
    }
  }
});

test("persisted errors render in the viewer language and unknown codes never turn into translation keys", () => {
  const { runtime, errors } = createI18nHarness("en");
  const english = errors.translateError("model_rate_limit");
  assert.ok(english && !/[\u3400-\u9fff]/u.test(english));
  runtime.setLanguage("zh-CN");
  const simplified = errors.translateError("model_rate_limit");
  runtime.setLanguage("zh-TW");
  const traditional = errors.translateError("model_rate_limit");
  assert.ok(simplified && traditional);
  assert.notEqual(english, simplified);
  assert.notEqual(simplified, traditional);
  assert.equal(errors.translateError(undefined), undefined);
  assert.equal(errors.translateError("User wrote arbitrary prose"), undefined);
});
