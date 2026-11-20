const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { createLoader } = require("../../shared/conversation/test-loader.cjs");
const { createI18nHarness } = require("./i18n-harness.cjs");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://client.example.invalid/" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
  sessionStorage: dom.window.sessionStorage, getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  ResizeObserver: class { observe() {} disconnect() {} },
});
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const React = require("react");
const { act, cleanup, fireEvent, render, within } = require("@testing-library/react");
const file = (name) => path.resolve(__dirname, "..", "src", name);
const t = createI18nHarness("en");
const capabilities = {
  dictation: true, read_aloud: true, max_recording_seconds: 90, max_upload_bytes: 10 * 1024 * 1024, max_text_characters: 2_000,
};
const idle = () => {};
const unavailable = new Set(["queued", "running", "waiting_user", "waiting_resource", "cancelling"]);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function loader(api, adminApi) {
  const Paragraph = ({ message }) => React.createElement("p", {}, message.content);
  return createLoader(require("typescript"), require, {
    [file("lib/i18n.ts")]: t.web,
    [file("pages/admin/i18n.ts")]: t.admin,
    [file("lib/api.ts")]: { api, adminApi, isActiveStatus: (status) => unavailable.has(status) },
    [file("components/FileCards.tsx")]: { FileCards: () => null, sizeText: String },
    [file("components/MarkdownMessage.tsx")]: { MarkdownMessage: Paragraph },
    [file("components/UserMessage.tsx")]: { UserMessage: Paragraph },
    [file("components/HistoryProcess.tsx")]: { HistoryProcess: () => null },
    [file("components/WaitingInputCard.tsx")]: { WaitingInputCard: () => null },
  });
}

function microphone(getUserMedia) {
  let stops = 0;
  const stream = { getTracks: () => [{ stop: () => { stops++; } }] };
  const recorders = [];
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: getUserMedia ?? (async () => stream) },
    configurable: true,
  });
  globalThis.MediaRecorder = class {
    static isTypeSupported(mime) { return mime === "audio/mp4"; }
    state = "inactive";
    constructor(device, options) {
      assert.equal(device, stream);
      this.mimeType = options.mimeType;
      recorders.push(this);
    }
    start() { this.state = "recording"; }
    emit(body) { this.ondataavailable?.({ data: new Blob([body], { type: this.mimeType }) }); }
    stop() {
      assert.equal(this.state, "recording");
      this.state = "inactive";
      queueMicrotask(() => this.onstop?.());
    }
  };
  return { stream, recorders, stops: () => stops };
}

function mountComposer(api, overrides = {}) {
  const { Composer } = loader(api)(file("components/Composer.tsx"));
  const submissions = [];
  let props = {
    onSubmit: async (content) => { submissions.push(content); return true; },
    onStop: idle, onError: idle, onComputer: idle, onModel: idle, onEffort: idle,
    computerEnabled: false, memoryEnabled: true, globalMemoryEnabled: true,
    unavailable: false, busy: false, stopping: false, models: [], modelId: "", effort: "",
    draftKey: "speech-draft", initialDraft: "First draft", speech: capabilities, ...overrides,
  };
  const element = () => React.createElement(React.StrictMode, {}, React.createElement(Composer, props));
  const view = render(element());
  return {
    view, submissions,
    input: () => view.getByRole("textbox", { name: t.web.t("composer.messageLabel") }),
    button: (key) => view.getByRole("button", { name: t.web.t(key), exact: true }),
    async update(patch) {
      props = { ...props, ...patch };
      await act(async () => view.rerender(element()));
    },
  };
}

async function click(button) {
  await act(async () => {
    fireEvent.mouseDown(button);
    fireEvent.click(button);
  });
}

test.afterEach(() => {
  cleanup();
  sessionStorage.clear();
  delete navigator.mediaDevices;
  delete globalThis.MediaRecorder;
  delete globalThis.AudioContext;
});

test("voice input preserves the editable draft and retry sends the same recording", async () => {
  const device = microphone();
  const uploads = [];
  const composer = mountComposer({
    transcribe(file, signal) {
      const result = deferred();
      uploads.push({ file, signal, result });
      return result.promise;
    },
  });
  const input = composer.input();
  input.focus();
  input.setSelectionRange(2, 5, "backward");

  await click(composer.button("composer.voiceInput"));
  assert.ok(composer.view.getByRole("status"));
  assert.equal(composer.button("common.send").disabled, true);
  assert.equal(document.activeElement, input);
  assert.equal(device.recorders.length, 1);
  device.recorders[0].emit("recorded AAC fixture");
  await click(composer.button("composer.finishRecording"));
  assert.equal(device.stops(), 1);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].file.name, "recording.m4a");
  assert.equal(uploads[0].file.type, "audio/mp4");

  await act(async () => uploads[0].result.reject(new Error("Synthetic transcription failure")));
  assert.equal(composer.view.getByRole("alert").textContent, "Synthetic transcription failure");
  await act(async () => fireEvent.change(input, { target: { value: "Edited while waiting" } }));
  input.setSelectionRange(2, 6, "backward");
  await click(composer.button("common.retry"));
  assert.equal(uploads[1].file, uploads[0].file);
  assert.equal(device.recorders.length, 1);
  await act(async () => uploads[1].result.resolve({ text: "Some dictated words" }));
  assert.equal(composer.input(), input);
  assert.equal(input.value, "Edited while waiting\nSome dictated words");
  assert.equal(document.activeElement, input);
  assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [2, 6, "backward"]);
  assert.equal(sessionStorage.getItem("speech-draft"), input.value);
  assert.deepEqual(composer.submissions, []);
});

test("changing the draft aborts transcription and discards results from the original draft", async () => {
  const device = microphone();
  const result = deferred();
  let signal;
  const composer = mountComposer({ transcribe: (_file, requestSignal) => { signal = requestSignal; return result.promise; } });
  await click(composer.button("composer.voiceInput"));
  device.recorders[0].emit("recorded AAC fixture");
  await click(composer.button("composer.finishRecording"));
  await composer.update({ draftKey: "new-owner" });
  assert.equal(signal.aborted, true);
  await act(async () => result.resolve({ text: "Old owner's words" }));
  assert.equal(composer.input().value, "First draft");
  assert.ok(composer.button("composer.voiceInput"));
  assert.equal(composer.view.queryByRole("alert"), null);
});

test("cancelling pending permission releases a late microphone stream and keeps keyboard controls focused", async () => {
  const permission = deferred();
  const device = microphone(() => permission.promise);
  const composer = mountComposer({});
  const voice = composer.button("composer.voiceInput");
  voice.focus();
  await click(voice);
  assert.equal(composer.button("composer.cancelRecording"), voice);
  assert.equal(document.activeElement, voice);
  await click(voice);
  await act(async () => permission.resolve(device.stream));
  assert.equal(device.stops(), 1);
  assert.equal(device.recorders.length, 0);
  assert.equal(composer.button("composer.voiceInput"), voice);
  assert.equal(document.activeElement, voice);
  assert.equal(composer.view.queryByRole("status"), null);
});

test("speech availability refreshes after administration and ignores the previous account's response", async () => {
  const reads = [];
  const { useSpeechCapabilities } = loader({
    speechCapabilities(signal) {
      const result = deferred();
      reads.push({ signal, result });
      return result.promise;
    },
  })(file("hooks/useSpeechCapabilities.ts"));
  function Account({ id, admin }) {
    const speech = useSpeechCapabilities(id, admin);
    return React.createElement("output", {}, speech?.dictation ? "Voice input enabled" : "Voice input unavailable");
  }
  const element = (id, admin = false) => React.createElement(Account, { id, admin });
  const view = render(element("first"));
  await act(async () => view.rerender(element("second")));
  assert.equal(reads[0].signal.aborted, true);
  await act(async () => reads[0].result.resolve(capabilities));
  assert.equal(view.getByRole("status").textContent, "Voice input unavailable");
  await act(async () => reads[1].result.resolve(capabilities));
  assert.equal(view.getByRole("status").textContent, "Voice input enabled");
  await act(async () => view.rerender(element("second", true)));
  assert.equal(view.getByRole("status").textContent, "Voice input unavailable");
  assert.equal(reads.length, 2);
  await act(async () => view.rerender(element("second")));
  await act(async () => reads[2].result.resolve({ ...capabilities, dictation: false }));
  assert.equal(view.getByRole("status").textContent, "Voice input unavailable");
});

test("reply playback activates before fetching, excludes code and aborts on replacement or navigation", async () => {
  const calls = [];
  globalThis.AudioContext = class {
    destination = {};
    resume() { calls.push(["resume", this]); return Promise.resolve(); }
    close() { calls.push(["close", this]); return Promise.resolve(); }
    decodeAudioData() { calls.push(["decode", this]); return Promise.resolve({}); }
    createBufferSource() {
      const source = {
        start: () => { calls.push(["play", this]); },
        stop: () => { calls.push(["stop", this]); },
        connect() {}, disconnect() {},
      };
      return source;
    }
  };
  const load = loader({
    synthesizeSpeech(text, signal) {
      const result = deferred();
      calls.push(["synthesize", { text, signal, result }]);
      return result.promise;
    },
  });
  const { MessageList } = load(file("components/MessageList.tsx"));
  const { useSpeechPlayback } = load(file("hooks/useSpeechPlayback.ts"));
  const assistant = (id, content, run_status = "completed") => ({ id, content, run_status, role: "assistant", created_at: "" });
  let messages = [
    assistant("first", "**First** reply\n\n```sh\nfixture-tool\n```\n\n[Continue](https://example.invalid/)"),
    assistant("second", "Second reply"),
    assistant("unfinished", "Working text", "running"),
  ];
  const errors = [];
  const sent = [];
  const device = microphone();
  const { Composer } = load(file("components/Composer.tsx"));
  function Chat({ scope }) {
    const audio = useSpeechPlayback(scope, capabilities.max_text_characters, (message) => errors.push(message));
    const [dictating, setDictating] = React.useState(false);
    return React.createElement(React.Fragment, {},
      React.createElement(MessageList, {
        messages, snapshot: null, sessionId: scope, onResume: idle,
        speechStatus: audio.status, readAloudDisabled: dictating,
        onReadAloud: audio.toggle, onStopSpeech: audio.stopMessage,
      }),
      React.createElement(Composer, {
        draftKey: scope, initialDraft: "", speech: capabilities,
        onDictationActiveChange(active) { setDictating(active); if (active) audio.stop(); },
        onSubmit: async (...args) => { sent.push(args); return true; },
        onError: idle, onStop: idle, onModel: idle, onEffort: idle, onComputer: idle,
        models: [], modelId: "", effort: "", memoryEnabled: true, globalMemoryEnabled: true, computerEnabled: false,
      }),
    );
  }
  const element = (scope) => React.createElement(Chat, { scope });
  const view = render(element("chat-1"));
  const read = () => view.getAllByRole("button", { name: t.web.t("message.readAloud") });
  assert.equal(read().length, 2);
  const second = read()[1];
  await click(read()[0]);
  const stop = view.getByRole("button", { name: t.web.t("message.stopSpeech") });
  assert.equal(stop.getAttribute("aria-busy"), "true");
  assert.deepEqual(calls.map(([event]) => event), ["resume", "synthesize"]);
  const firstRequest = calls[1][1];
  assert.equal(firstRequest.text, "First reply\n\nContinue");

  await click(second);
  assert.equal(firstRequest.signal.aborted, true);
  const secondRequest = calls.findLast(([event]) => event === "synthesize")[1];
  await act(async () => firstRequest.result.resolve(new Blob(["late MP3"], { type: "audio/mpeg" })));
  assert.equal(calls.filter(([event]) => event === "decode").length, 0);
  await act(async () => secondRequest.result.resolve(new Blob(["second MP3"], { type: "audio/mpeg" })));
  assert.equal(calls.filter(([event]) => event === "play").length, 1);
  assert.equal(view.getByRole("button", { name: t.web.t("message.stopSpeech") }).getAttribute("aria-busy"), null);
  await click(view.getByRole("button", { name: t.web.t("composer.voiceInput") }));
  assert.equal(secondRequest.signal.aborted, true);
  assert.equal(calls.filter(([event]) => event === "stop").length, 1);
  assert.ok(read().every((button) => button.disabled));
  assert.equal(calls.filter(([event]) => event === "close").length, 2);
  await act(async () => view.rerender(element("chat-2")));
  assert.equal(device.stops(), 1);
  assert.ok(read().every((button) => !button.disabled));
  await click(read()[0]);
  const thirdRequest = calls.findLast(([event]) => event === "synthesize")[1];
  await act(async () => view.rerender(element("chat-3")));
  assert.equal(thirdRequest.signal.aborted, true);
  assert.equal(read().length, 2);
  assert.deepEqual(sent, []);
  assert.deepEqual(errors, []);
});

test("the admin can test unsaved audio models independently and save their enablement", async () => {
  const config = {
    dictation: { enabled: false, provider_id: "synthetic", model: "voice/transcription" },
    read_aloud: { enabled: false, provider_id: "synthetic", model: "voice/synthesis", voice: "fixture" },
  };
  const calls = [];
  const preview = new Blob(["test MP3"], { type: "audio/mpeg" });
  const load = loader(undefined, {
    speechSettings: async () => config,
    providers: async () => [{ id: "synthetic", name: "Synthetic Provider", enabled: true }],
    testTranscription: async (target, file) => {
      calls.push(["transcription", target, file]);
      return { text: "Hello from the recording" };
    },
    testSynthesis: async (target, text) => { calls.push(["synthesis", target, text]); return preview; },
    saveSpeechSettings: async (settings) => { calls.push(["save", settings]); return settings; },
  });
  const { default: SpeechPage } = load(file("pages/admin/SpeechPage.tsx"));
  const { AdminSlotContext } = load(file("pages/admin/ui.tsx"));
  const actions = document.body.appendChild(document.createElement("div"));
  let audioURL;
  try {
    let view;
    await act(async () => {
      view = render(React.createElement(AdminSlotContext.Provider, { value: { actions } }, React.createElement(SpeechPage)));
    });
    const dictation = within(view.getByRole("heading", { name: t.admin.t("speech.dictation") }).closest("section"));
    const playback = within(view.getByRole("heading", { name: t.admin.t("speech.readAloud") }).closest("section"));
    const model = dictation.getByRole("textbox", { name: /Model ID/ });
    await act(async () => fireEvent.change(model, { target: { value: "voice/unsaved-transcription" } }));
    const sample = new File(["test WAV"], "sample.wav", { type: "audio/wav" });
    await act(async () => fireEvent.change(view.container.querySelector('input[type="file"]'), { target: { files: [sample] } }));
    await click(dictation.getByRole("button", { name: t.admin.t("speech.testDictation") }));
    assert.equal(dictation.getByRole("status").textContent, "Hello from the recording");
    assert.equal(calls[0][1].model, "voice/unsaved-transcription");
    assert.equal(calls[0][2], sample);
    assert.equal(config.dictation.model, "voice/transcription");
    await click(playback.getByRole("button", { name: t.admin.t("speech.testReadAloud") }));
    audioURL = playback.getByLabelText(t.admin.t("speech.preview")).src;
    assert.equal(await (await fetch(audioURL)).text(), "test MP3");
    assert.deepEqual(calls[1], ["synthesis", config.read_aloud, t.admin.t("speech.sampleText")]);

    await click(dictation.getByRole("switch", { name: t.admin.t("speech.enableDictation") }));
    await act(async () => fireEvent.submit(view.container.querySelector("form")));
    assert.equal(calls[2][0], "save");
    assert.equal(calls[2][1].dictation.enabled, true);
    assert.equal(calls[2][1].read_aloud.enabled, false);
    assert.equal(within(actions).getByRole("button", { name: t.admin.t("save") }).disabled, true);
  } finally {
    cleanup();
    actions.remove();
  }
  await assert.rejects(fetch(audioURL), TypeError);
});
