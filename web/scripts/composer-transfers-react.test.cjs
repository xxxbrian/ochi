const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://client.example.invalid/" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
  sessionStorage: dom.window.sessionStorage, localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
});
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const React = require("react");
const { render, act, cleanup, fireEvent, createEvent } = require("@testing-library/react");
const { createLoader } = require("../../shared/conversation/test-loader.cjs");
const { createI18nHarness } = require("./i18n-harness.cjs");
const root = path.resolve(__dirname, "../..");
const filename = (file) => path.join(root, "web", file);
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function file(name, type = "text/plain") {
  return new dom.window.File(["synthetic attachment"], name, { type });
}
function artifact(value) {
  return { id: value.name, name: value.name, mime_type: value.type, size: value.size, url: `/files/${value.name}` };
}
function transfer(files, text = "", html = "") {
  return {
    files,
    items: files.map((value) => ({ kind: "file", type: value.type, getAsFile: () => value })),
    types: [...(files.length ? ["Files"] : []), ...(text ? ["text/plain"] : []), ...(html ? ["text/html"] : [])],
    getData: (type) => type === "text/plain" ? text : type === "text/html" ? html : "",
    dropEffect: "none",
  };
}
async function event(target, name, data) {
  const value = createEvent[name](target, data);
  await act(async () => { fireEvent(target, value); await flush(); });
  return value;
}
async function fixture({ upload = async (value) => artifact(value), locale = "en", strict = false, ...patch } = {}) {
  const language = createI18nHarness(locale);
  const sent = [], errors = [];
  const load = createLoader(require("typescript"), require, {
    [filename("src/lib/i18n.ts")]: language.web,
    [filename("src/lib/api.ts")]: { api: { upload } },
    [filename("src/components/FileCards.tsx")]: { sizeText: String },
  });
  const { Composer } = load(filename("src/components/Composer.tsx"));
  let props = {
    onSubmit: async (content, files) => { sent.push({ content, files }); return true; },
    onStop() {}, onError: (error) => errors.push(error),
    computerEnabled: false, onComputer() {}, busy: false, unavailable: false, stopping: false,
    draftKey: "transfer-fixture", models: [], modelId: "", effort: "", onModel() {}, onEffort() {},
    initialDraft: "Keep this draft", ...patch,
  };
  const element = (key = "current") => {
    const child = React.createElement(Composer, { ...props, key });
    return strict ? React.createElement(React.StrictMode, {}, child) : child;
  };
  let view;
  await act(async () => { view = render(element()); await flush(); });
  return {
    view, sent, errors, t: language.web.t,
    input: () => view.getByRole("textbox", { name: language.web.t("composer.messageLabel") }),
    form: () => view.container.querySelector("form"),
    async rerender(patch, key) {
      props = { ...props, ...patch };
      await act(async () => { view.rerender(element(key)); await flush(); });
    },
  };
}
test.afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); });

test("dropped files use the attachment pipeline once, retain the draft and submit as ordinary attachments", async () => {
  const uploads = [];
  const h = await fixture({ upload: async (value) => { uploads.push(value); return artifact(value); } });
  h.input().focus();
  h.input().setSelectionRange(4, 4);
  const files = [file("notes.txt"), file("diagram.png", "image/png")];
  const dropped = await event(h.input(), "drop", { dataTransfer: transfer(files) });
  assert.equal(dropped.defaultPrevented, true);
  assert.deepEqual(uploads, files, "files and items describing the same transfer are not both uploaded");
  assert.equal(h.input().value, "Keep this draft");
  assert.equal(document.activeElement, h.input());
  assert.equal(h.input().selectionStart, 4);
  assert.equal(h.sent.length, 0, "adding files does not send the message");
  assert.ok(h.view.getByRole("img", { name: "diagram.png" }));
  await act(async () => { fireEvent.submit(h.form()); await flush(); });
  assert.equal(h.sent[0].content, "Keep this draft");
  assert.deepEqual(h.sent[0].files.map((value) => value.id), files.map((value) => value.name));
});

test("clipboard images upload while plain text, HTML and remote image URLs retain native paste behavior", async () => {
  const uploads = [];
  const h = await fixture({ upload: async (value) => { uploads.push(value); return artifact(value); } });
  const image = file("clipboard.png", "image/png");
  const pasted = await event(h.input(), "paste", { clipboardData: transfer([image]) });
  assert.equal(pasted.defaultPrevented, true);
  assert.deepEqual(uploads, [image]);
  assert.equal(h.input().value, "Keep this draft");
  const text = await event(h.input(), "paste", { clipboardData: transfer([], "Plain text") });
  assert.equal(text.defaultPrevented, false);
  const html = await event(h.input(), "paste", { clipboardData: transfer([], "", '<img src="https://example.invalid/image.png">') });
  assert.equal(html.defaultPrevented, false);
  assert.equal(uploads.length, 1, "HTML or a URL never triggers an unsolicited remote fetch");
  const mixed = await event(h.input(), "paste", { clipboardData: transfer([file("mixed.png", "image/png")], "Caption") });
  assert.equal(mixed.defaultPrevented, false, "mixed clipboard text is inserted by the browser at the original selection");
  assert.equal(uploads.length, 2);
});

test("overlapping drop, paste and picker batches queue in order and continue after an individual upload fails", async () => {
  const calls = [];
  const h = await fixture({ upload: (value, signal) => { const gate = deferred(); calls.push({ file: value, signal, ...gate }); return gate.promise; } });
  const first = file("first.txt"), failed = file("failed.pdf", "application/pdf"), last = file("last.png", "image/png"), picked = file("picked.txt");
  await event(h.form(), "drop", { dataTransfer: transfer([first, failed]) });
  await event(h.input(), "paste", { clipboardData: transfer([last]) });
  await event(h.form().querySelector('input[type="file"]:not([accept])'), "change", { target: { files: [picked] } });
  assert.equal(calls.length, 1);
  assert.equal(h.view.getByRole("button", { name: h.t("common.send"), exact: true }).disabled, true);
  await act(async () => { calls[0].resolve(artifact(first)); await flush(); });
  assert.equal(calls[1].file, failed);
  await act(async () => { calls[1].reject(new Error("Synthetic upload failure")); await flush(); });
  assert.equal(calls[2].file, last);
  await act(async () => { calls[2].resolve(artifact(last)); await flush(); });
  assert.equal(calls[3].file, picked);
  await act(async () => { calls[3].resolve(artifact(picked)); await flush(); });
  assert.deepEqual(h.errors, ["Synthetic upload failure"]);
  assert.ok(h.view.getByText("first.txt"));
  assert.ok(h.view.getByText("last.png"));
  assert.equal(h.view.queryByText("failed.pdf"), null);
  await act(async () => { fireEvent.submit(h.form()); await flush(); });
  assert.deepEqual(h.sent[0].files.map((value) => value.name), ["first.txt", "last.png", "picked.txt"]);
});

test("file-only paste can use transfer items without a FileList and creates a sendable image-only message", async () => {
  const uploads = [], h = await fixture({
    initialDraft: "",
    upload: async (value) => { uploads.push(value); return artifact(value); },
  });
  const image = file("items-only.png", "image/png"), data = transfer([image]);
  data.files = [];
  const pasted = await event(h.input(), "paste", { clipboardData: data });
  assert.equal(pasted.defaultPrevented, true);
  assert.deepEqual(uploads, [image]);
  assert.equal(h.input().value, "");
  assert.equal(h.view.getByRole("button", { name: h.t("common.send"), exact: true }).disabled, false);
  await act(async () => { fireEvent.submit(h.form()); await flush(); });
  assert.equal(h.sent[0].content, "");
  assert.deepEqual(h.sent[0].files.map((value) => value.name), ["items-only.png"]);
});

test("unavailable and submitting composers consume file drops without uploading or affecting normal text drags", async () => {
  const uploads = [];
  const pending = deferred();
  const h = await fixture({
    unavailable: true,
    upload: async (value) => { uploads.push(value); return artifact(value); },
    onSubmit: () => pending.promise,
  });
  const data = transfer([file("blocked.txt")]);
  const drop = await event(h.form(), "drop", { dataTransfer: data });
  assert.equal(drop.defaultPrevented, true);
  assert.equal(uploads.length, 0);
  const textDrag = await event(h.form(), "dragOver", { dataTransfer: transfer([], "Move text") });
  assert.equal(textDrag.defaultPrevented, false);
  await h.rerender({ unavailable: false });
  await act(async () => { fireEvent.submit(h.form()); await flush(); });
  await event(h.form(), "drop", { dataTransfer: data });
  assert.equal(uploads.length, 0, "a file added during submission must not be lost when submission clears attachments");
  await act(async () => { pending.resolve(true); await flush(); });
});

test("a different draft aborts the old upload and cannot inherit its files, pending queue or errors", async () => {
  const calls = [];
  const h = await fixture({ strict: true, upload: (value, signal) => { const gate = deferred(); calls.push({ value, signal, ...gate }); return gate.promise; } });
  await event(h.form(), "drop", { dataTransfer: transfer([file("old.txt"), file("never-start.txt")]) });
  assert.equal(calls.length, 1);
  await h.rerender({ draftKey: "new-account-draft", initialDraft: "New account draft" }, "new-account");
  assert.equal(calls[0].signal.aborted, true);
  await act(async () => { calls[0].resolve(artifact(calls[0].value)); await flush(); });
  assert.equal(calls.length, 1, "old queued files never upload with a later account's credentials");
  assert.equal(h.view.queryByText("old.txt"), null);
  assert.equal(h.input().value, "New account draft");
  assert.deepEqual(h.errors, []);
  await event(h.input(), "paste", { clipboardData: transfer([file("current.png", "image/png")]) });
  assert.equal(calls.length, 2);
  await act(async () => { calls[1].resolve(artifact(calls[1].value)); await flush(); });
  assert.ok(h.view.getByText("current.png"));
});

test("a late rejection after unmount is silent and repeated picker selections still work", async () => {
  const gate = deferred();
  const h = await fixture({ upload: () => gate.promise });
  await event(h.form(), "drop", { dataTransfer: transfer([file("old.txt")]) });
  h.view.unmount();
  await act(async () => { gate.reject(new Error("Old account failure")); await flush(); });
  assert.deepEqual(h.errors, []);
  const files = [];
  const next = await fixture({ upload: async (value) => { files.push(value); return { ...artifact(value), id: `id-${files.length}` }; } });
  const picker = next.form().querySelector('input[type="file"]:not([accept])');
  const selected = file("repeat.txt");
  await event(picker, "change", { target: { files: [selected] } });
  await event(picker, "change", { target: { files: [selected] } });
  assert.deepEqual(files, [selected, selected]);
  assert.equal(picker.value, "");
});

test("nested file drags keep one highlight until leaving and clear on cancellation", async () => {
  const h = await fixture();
  const data = transfer([file("dragged.txt")]);
  await event(h.form(), "dragEnter", { dataTransfer: data });
  await event(h.input(), "dragEnter", { dataTransfer: data });
  await event(h.form(), "dragLeave", { dataTransfer: data });
  assert.equal(h.form().dataset.dragging, "true", "crossing a child does not hide the drop target");
  assert.ok(h.view.getByRole("status"));
  await event(h.input(), "dragLeave", { dataTransfer: data });
  assert.equal(h.form().dataset.dragging, undefined);
  await event(h.form(), "dragEnter", { dataTransfer: data });
  await act(async () => { fireEvent.keyDown(window, { key: "Escape" }); });
  assert.equal(h.form().dataset.dragging, undefined);
  await event(h.form(), "dragEnter", { dataTransfer: data });
  await event(window, "drop", { dataTransfer: data });
  assert.equal(h.form().dataset.dragging, undefined, "a drop outside the composer clears feedback");
});

test("folder drops report a localized error while ordinary files in the same transfer still upload", async () => {
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const uploaded = [];
    const h = await fixture({ locale, upload: async (value) => { uploaded.push(value); return artifact(value); } });
    const kept = file("kept.txt"), directory = file("folder");
    const data = transfer([directory, kept]);
    data.items[0].webkitGetAsEntry = () => ({ isDirectory: true });
    data.items[0].getAsFile = () => { throw new Error("A directory must not be uploaded as a file"); };
    await event(h.form(), "drop", { dataTransfer: data });
    assert.deepEqual(uploaded, [kept]);
    assert.deepEqual(h.errors, [h.t("composer.foldersUnsupported")]);
    assert.equal(h.input().value, "Keep this draft");
    h.view.unmount();
  }
});
