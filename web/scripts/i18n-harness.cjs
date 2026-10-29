const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");

// VM component tests use the real catalogs and formatter without browser storage.
function createI18nHarness(language = "zh-CN") {
  const cache = new Map();
  function load(relative) {
    const base = path.resolve(root, relative);
    const filename = [base, `${base}.ts`, path.join(base, "index.ts")]
      .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!filename) throw new Error(`Missing locale fixture: ${relative}`);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    if (filename.endsWith(".json")) {
      module.exports = JSON.parse(fs.readFileSync(filename, "utf8"));
      return module.exports;
    }
    const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    vm.runInNewContext(output, {
      module, exports: module.exports, Intl,
      require(name) {
        if (filename === path.resolve(root, "mobile/src/lib/errors.ts") && name === "./i18n") return mobile;
        if (!name.startsWith(".")) throw new Error(`Unexpected locale dependency: ${name}`);
        return load(path.relative(root, path.resolve(path.dirname(filename), name)));
      },
    }, { filename });
    return module.exports;
  }
  const runtime = load("shared/i18n/index.ts");
  runtime.setLanguage(language);
  function client(relative) {
    const catalog = load(relative);
    const t = runtime.createTranslator(relative.endsWith(".json") ? catalog : catalog.messages ?? catalog.default ?? catalog);
    return {
      ...runtime, t,
      useI18n: () => ({ t, locale: runtime.getLocale(), language: runtime.getLanguage(), setLanguage: runtime.setLanguage }),
    };
  }
  const web = client("web/src/lib/messages.ts");
  const mobile = client("mobile/src/lib/messages.ts");
  const mobileErrors = load("mobile/src/lib/errors.ts");
  const admin = client("web/src/pages/admin/messages.json");
  const process = load("shared/i18n/process.ts");
  const errors = load("shared/i18n/errors.ts");
  admin.useAdminI18n = admin.useI18n;
  admin.translateError = errors.translateError;
  return {
    runtime, web, mobile, admin, process, errors,
    resolve(name, target = "web") {
      if (name.endsWith("/shared/i18n/process")) return process;
      if (name.endsWith("/shared/i18n/errors")) return errors;
      if (name.endsWith("/shared/i18n")) return runtime;
      if (name === "./i18n" || name === "../lib/i18n") return { web, mobile, admin }[target];
      if (name === "../lib/errors" && target === "mobile") return mobileErrors;
      return undefined;
    },
  };
}

module.exports = { createI18nHarness };
