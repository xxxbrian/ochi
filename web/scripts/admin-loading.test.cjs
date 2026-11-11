const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const vm = require("node:vm");
const src = (p) => fs.readFileSync(path.join(__dirname, "..", "src", p), "utf8");

const adminFiles = ["PluginsPage", "ProvidersPage", "IntegrationsPage", "SearchPage", "SystemPages", "RequestDiagnostics", "UpdateCard"].map((n) => `pages/admin/${n}.tsx`);

test("admin and settings no longer use the generic spinner", () => {
  for (const f of [...adminFiles, "components/settings/MemoryTab.tsx", "components/settings/DataTab.tsx"])
    assert.doesNotMatch(src(f), /ui\/Busy|<Busy/, f);
});

test("busy buttons keep their own icon and switch to the progressive label with the progress line", () => {
  const providers = src("pages/admin/ProvidersPage.tsx");
  assert.match(providers, /<Database className="ic" \/>/);
  assert.doesNotMatch(providers, /Database className="[^"]*ic-turn/);
  assert.match(providers, /t\("updatingMetadata"\)/);
  assert.match(providers, /btn secondary sm\$\{busy === `metadata:\$\{item\.id\}` \? " btn-progress"/);
  assert.match(providers, /<Zap className="ic" \/>/);
  assert.match(src("components/settings/DataTab.tsx"), /<Download size=\{14\} \/>\{exporting \? t\("settings\.exporting"\)/);
  assert.match(src("components/settings/DataTab.tsx"), /btn-progress/);
  assert.match(src("components/settings/MemoryTab.tsx"), /t\("common\.saving"\)/);
});

test("only refresh icons turn themselves", () => {
  for (const f of [...adminFiles, "components/settings/PluginsTab.tsx"]) {
    for (const m of src(f).matchAll(/<(\w+)[^<>]*ic-turn/g)) assert.ok(m[1] === "RefreshCw" || (m[1] === "Icon" && f.endsWith("UpdateCard.tsx")), `${f}: ${m[0]}`);
  }
});

test("update phase icon matches what is happening", () => {
  const source = src("pages/admin/UpdateCard.tsx");
  const start = source.indexOf("export function updatePhaseIcon");
  const body = source.slice(start, source.indexOf("function UpdatePhaseIcon"));
  const js = ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, Power: "Power", RotateCcw: "RotateCcw", Download: "Download", RefreshCw: "RefreshCw" });
  const f = module.exports.updatePhaseIcon;
  assert.deepEqual({ ...f(null, "restarting", true) }, { Icon: "Power", turn: false });
  assert.deepEqual({ ...f("rollback", "idle", false) }, { Icon: "RotateCcw", turn: false });
  assert.deepEqual({ ...f(null, "downloading", false) }, { Icon: "Download", turn: false });
  assert.deepEqual({ ...f("apply", "idle", false) }, { Icon: "Download", turn: false });
  assert.deepEqual({ ...f("check", "checking", false) }, { Icon: "RefreshCw", turn: true });
});

test("new progressive strings exist in en, zh-CN and zh-TW", () => {
  const admin = JSON.parse(src("pages/admin/messages.json"));
  for (const key of ["testingEllipsis", "syncingEllipsis", "uploadingEllipsis", "installingEllipsis", "clearingEllipsis", "matchingEllipsis", "rebuildingEllipsis"])
    for (const l of ["en", "zh-CN", "zh-TW"]) assert.ok(admin[key]?.[l], `${key} ${l}`);
  const m = src("lib/messages.ts");
  for (const key of ["settings.exporting", "common.saving"]) {
    const block = m.slice(m.indexOf(`"${key}"`), m.indexOf("},", m.indexOf(`"${key}"`)));
    for (const l of ["en", "zh-CN", "zh-TW"]) assert.match(block, new RegExp(`"${l}": "[^"]+"`), `${key} ${l}`);
  }
});

test("icon motion classes exist once and honor reduced motion", () => {
  const css = src("components/ui/primitives.css");
  assert.equal(css.split(".ic-turn {").length, 2);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.ic-turn, \.ic-pulse \{ animation: none/);
  assert.doesNotMatch(src("pages/admin/admin.css"), /\.busy\b/);
});
