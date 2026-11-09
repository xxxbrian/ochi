const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const src = (p) => fs.readFileSync(path.join(__dirname, "..", "src", p), "utf8");

test("shell, composer and pages no longer use the generic spinner", () => {
  for (const f of ["App.tsx", "components/Composer.tsx", "components/MessageList.tsx", "components/SessionSearch.tsx", "components/LoginScreen.tsx", "pages/ProjectsPage.tsx", "pages/TasksPage.tsx"])
    assert.doesNotMatch(src(f), /ui\/Busy|<Busy/, f);
});

test("busy buttons keep their icon, switch label and use the shared progress line", () => {
  const login = src("components/LoginScreen.tsx");
  assert.match(login, /btn-progress/);
  assert.match(login, /login\.signingIn/);
  assert.match(login, /<ArrowRight/);
  assert.match(src("pages/TasksPage.tsx"), /tasks\.starting/);
  assert.match(src("components/Composer.tsx"), /composer\.uploading/);
});

test("shared loading primitives live in ui/primitives.css and honor reduced motion", () => {
  const css = src("components/ui/primitives.css");
  for (const cls of [".btn-progress", ".skel", ".loading-dots"]) assert.ok(css.includes(cls), cls);
  const reduce = css.slice(css.lastIndexOf("prefers-reduced-motion: reduce) {\n    .btn-progress"));
  assert.match(reduce, /\.btn-progress::after \{ animation: none/);
  assert.match(reduce, /\.skel \{ animation: none/);
});

test("new loading strings exist in en, zh-CN and zh-TW", () => {
  const m = src("lib/messages.ts");
  for (const key of ["login.signingIn", "composer.uploading", "tasks.starting"]) {
    const block = m.slice(m.indexOf(`"${key}"`), m.indexOf("},", m.indexOf(`"${key}"`)));
    for (const l of ["en", "zh-CN", "zh-TW"]) assert.match(block, new RegExp(`"${l}": "[^"]+"`), `${key} ${l}`);
  }
});
