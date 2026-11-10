const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { JSDOM } = require("jsdom");
const root = path.resolve(__dirname, "../..");
const locale = require("./i18n-harness.cjs").createI18nHarness("en");
const load = require("../../shared/conversation/test-loader.cjs").createLoader(require("typescript"), require, {
  [path.join(root, "web/src/lib/i18n.ts")]: locale.web,
  [path.join(root, "web/src/components/FileCards.tsx")]: { FileCards: () => null, ArtifactPlaceholder: () => null },
  [path.join(root, "web/src/components/Modal.tsx")]: { Modal: () => null },
  [path.join(root, "web/src/components/ComputerSteps.tsx")]: { computerStepPart: () => null },
});
const { ToolBody } = load(path.join(root, "web/src/components/ToolBodies.tsx"));

function body(name, result, extra = {}) {
  const step = { id: "fixture-step", name, status: "completed", arguments: { path: "/data/example.txt" }, output: typeof result === "string" ? result : JSON.stringify(result), ...extra };
  const html = renderToStaticMarkup(React.createElement(ToolBody, { step, kind: "files", queue: null, needsUser: false, failed: step.status === "failed" }));
  return JSDOM.fragment(html);
}

test("successful file reads render one specialized code body for either content or text", () => {
  for (const key of ["content", "text"]) {
    const result = body("files_read", { [key]: "SYNTHETIC_READ_BODY", size: 19 });
    assert.equal(result.querySelectorAll(".tb-file .tb-code").length, 1);
    assert.equal(result.querySelectorAll(".tb-code").length, 1);
    assert.equal(result.textContent.split("SYNTHETIC_READ_BODY").length - 1, 1);
    assert.equal(result.querySelector(".tb-tech pre"), null, "raw details stay lazy");
  }
});

test("empty file reads keep useful result metadata", () => {
  const result = body("files_read", { content: "", size: 0 });
  assert.equal(result.querySelectorAll(".tb-code").length, 0);
  assert.equal(result.querySelector(".tb-kv b").textContent, "0");
});

test("nonstandard and plain file results retain their generic fallback exactly once", () => {
  for (const output of [{ message: "SYNTHETIC_FALLBACK" }, "SYNTHETIC_FALLBACK"]) {
    const result = body("files_read", output);
    assert.equal(result.textContent.split("SYNTHETIC_FALLBACK").length - 1, 1);
  }
  const result = body("custom_file_tool", { content: "SYNTHETIC_GENERIC" });
  assert.equal(result.querySelector(".tb-plain").textContent, "SYNTHETIC_GENERIC");
});

test("failed reads keep the error instead of rendering a successful result", () => {
  const result = body("files_read", { error: "SYNTHETIC_READ_FAILURE" }, { status: "failed" });
  assert.equal(result.querySelectorAll('[role="alert"]').length, 1);
  assert.equal(result.textContent.split("SYNTHETIC_READ_FAILURE").length - 1, 1);
});
