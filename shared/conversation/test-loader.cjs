const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

// Compile the real domain/hook modules for Node's test runner. React itself is
// resolved from the tested client; no hooks or scheduler are simulated here.
function createLoader(ts, clientRequire, overrides = {}) {
  const cache = new Map();
  function load(filename) {
    filename = path.resolve(filename);
    if (Object.hasOwn(overrides, filename)) return overrides[filename];
    if (cache.has(filename)) return cache.get(filename).exports;
    const loaded = new Module(filename);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    cache.set(filename, loaded);
    loaded.require = (name) => {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (name.startsWith(".")) {
        const target = path.resolve(path.dirname(filename), name);
        for (const candidate of [target, `${target}.ts`, `${target}.tsx`, `${target}.cjs`, path.join(target, "index.ts")]) {
          if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
          if (Object.hasOwn(overrides, candidate)) return overrides[candidate];
          if (/\.css$/.test(candidate)) return {};
          if (/\.[cm]?js$/.test(candidate) || /\.json$/.test(candidate)) return require(candidate);
          return load(candidate);
        }
      }
      return clientRequire(name);
    };
    const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      fileName: filename,
    }).outputText;
    loaded._compile(source, filename);
    return loaded.exports;
  }
  return load;
}
module.exports = { createLoader };
