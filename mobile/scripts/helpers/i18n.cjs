const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');

// Existing interaction tests keep their Chinese assertions while exercising the
// real catalogs. Locale tests create isolated runtimes with explicit preferences.
function createI18n({ locale = 'zh-CN', react = {}, secureStore, imports = {} } = {}) {
  const modules = new Map();
  const storage = new Map();
  const store = secureStore ?? {
    async getItemAsync(key) { return storage.get(key) ?? null; },
    async setItemAsync(key, value) { storage.set(key, value); },
  };
  function load(file) {
    const absolute = path.resolve(root, file);
    if (modules.has(absolute)) return modules.get(absolute);
    if (absolute.endsWith('.json')) {
      const value = JSON.parse(fs.readFileSync(absolute, 'utf8'));
      modules.set(absolute, value);
      return value;
    }
    const module = { exports: {} };
    modules.set(absolute, module.exports);
    const output = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const execute = vm.compileFunction(output, ['module', 'exports', 'require'], { filename: absolute });
    execute(module, module.exports, (name) => {
        if (name in imports) return imports[name];
        if (name === 'react') return { useSyncExternalStore() {}, ...react };
        if (name === 'expo-secure-store') return store;
        if (!name.startsWith('.')) throw new Error(`Unexpected locale import ${name}`);
        const base = path.resolve(path.dirname(absolute), name);
        const resolved = ['.ts', '/index.ts', ''].map((suffix) => `${base}${suffix}`).find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (!resolved) throw new Error(`Cannot resolve locale import ${name}`);
        return load(resolved);
      });
    return module.exports;
  }
  const core = load('../shared/i18n/index.ts');
  core.setLanguage(locale);
  const native = load('src/lib/i18n.ts');
  return {
    core, native, storage, load,
    importFor(name) {
      if (/(?:^|\/)shared\/i18n$/.test(name)) return core;
      if (/(?:^|\/)i18n\/(?:errors|process)$/.test(name)) return load(`../shared/i18n/${name.split('/').at(-1)}.ts`);
      if (/(?:^|\/)i18n$/.test(name)) return native;
      if (/(?:^|\/)lib\/errors$/.test(name) || name === './errors') return load('src/lib/errors.ts');
      return undefined;
    },
  };
}

const testI18n = createI18n();
module.exports = { createI18n, testI18n };
