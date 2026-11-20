const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
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

function sampleWav() {
  const bytes = Buffer.alloc(46);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(2, 40);
  return new Blob([bytes], { type: "audio/wav" });
}

function loader(api, adminApi) {
  const Paragraph = ({ message }) => React.createElement("p", {}, message.content);
  return createLoader(require("typescript"), require, {
    [path.resolve(__dirname, "../../shared/i18n/errors.ts")]: t.errors,
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
    decodeAudioData(data) { calls.push(["decode", Buffer.from(data)]); return Promise.resolve({}); }
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
    speechCapabilities(signal) {
      calls.push(["capabilities", signal]);
      return Promise.resolve(capabilities);
    },
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
    const audio = useSpeechPlayback(scope, true, (message) => errors.push(message));
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
  assert.deepEqual(calls.map(([event]) => event), ["resume", "capabilities", "synthesize"]);
  const firstRequest = calls[2][1];
  assert.equal(firstRequest.signal, calls[1][1]);
  assert.equal(firstRequest.text, "First reply\n\nContinue");

  await click(second);
  assert.equal(firstRequest.signal.aborted, true);
  const secondRequest = calls.findLast(([event]) => event === "synthesize")[1];
  await act(async () => firstRequest.result.resolve(new Blob(["late MP3"], { type: "audio/mpeg" })));
  assert.equal(calls.filter(([event]) => event === "decode").length, 0);
  const wav = sampleWav();
  await act(async () => secondRequest.result.resolve(wav));
  assert.deepEqual(calls.find(([event]) => event === "decode")[1], Buffer.from(await wav.arrayBuffer()));
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

test("read-aloud refreshes the request limit and drops results from a cancelled capability probe", async () => {
  const probes = [];
  const segments = [];
  const sources = [];
  const errors = [];
  const wav = sampleWav();
  globalThis.AudioContext = class {
    destination = {};
    async resume() {}
    async close() {}
    async decodeAudioData() { return {}; }
    createBufferSource() {
      const source = { start: () => sources.push(source), stop() {}, connect() {}, disconnect() {} };
      return source;
    }
  };
  const { useSpeechPlayback } = loader({
    speechCapabilities(signal) {
      const result = deferred();
      probes.push({ signal, result });
      return result.promise;
    },
    async synthesizeSpeech(text, signal) {
      segments.push({ text, signal });
      return wav;
    },
  })(file("hooks/useSpeechPlayback.ts"));
  function Chat() {
    const audio = useSpeechPlayback("chat", true, (message) => errors.push(message));
    return React.createElement("button", { onClick: () => audio.toggle("reply", "ABCDEFGHI") },
      t.web.t(audio.status ? "message.stopSpeech" : "message.readAloud"));
  }
  const view = render(React.createElement(Chat));
  const action = () => view.getByRole("button");
  await click(action());
  assert.equal(action().textContent, t.web.t("message.stopSpeech"));
  await click(action());
  assert.equal(probes[0].signal.aborted, true);
  await act(async () => probes[0].result.resolve(capabilities));
  assert.equal(segments.length, 0);
  assert.deepEqual(errors, []);

  await click(action());
  await act(async () => probes[1].result.resolve({ ...capabilities, max_text_characters: 4 }));
  assert.deepEqual(segments.map(({ text }) => text), ["ABCD"]);
  await act(async () => sources[0].onended());
  await act(async () => sources[1].onended());
  await act(async () => sources[2].onended());
  assert.deepEqual(segments.map(({ text }) => text), ["ABCD", "EFGH", "I"]);
  assert.ok(segments.every(({ signal }) => signal === probes[1].signal));
  assert.equal(action().textContent, t.web.t("message.readAloud"));

  await click(action());
  await act(async () => probes[2].result.resolve({ ...capabilities, read_aloud: false }));
  assert.equal(segments.length, 3);
  assert.equal(action().textContent, t.web.t("message.readAloud"));
  assert.deepEqual(errors, [t.errors.translateError("speech_unavailable")]);
});

test("the admin can preview WAV and save the selected format and request limit", async () => {
  const config = {
    dictation: { enabled: false, provider_id: "synthetic", model: "voice/transcription" },
    read_aloud: { enabled: false, provider_id: "synthetic", model: "voice/synthesis", voice: "fixture", output_format: "mp3", max_text_characters: 2000 },
  };
  const calls = [];
  const wav = sampleWav();
  const load = loader(undefined, {
    speechSettings: async () => config,
    providers: async () => [{ id: "synthetic", name: "Synthetic Provider", enabled: true }],
    testTranscription: async (target, file) => {
      calls.push(["transcription", target, file]);
      return { text: "Hello from the recording" };
    },
    testSynthesis: async (target, text) => {
      calls.push(["synthesis", target, text]);
      return target.output_format === "wav" ? wav : new Blob(["test MP3"], { type: "audio/mpeg" });
    },
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
    const generate = playback.getByRole("button", { name: t.admin.t("speech.testReadAloud") });
    const format = playback.getByRole("combobox", { name: t.admin.t("speech.outputFormat") });
    const limit = playback.getByRole("spinbutton", { name: /Characters per request/ });
    const sampleText = playback.getByRole("textbox", { name: /Sample text/ });
    const save = within(actions).getByRole("button", { name: t.admin.t("save") });
    const form = view.container.querySelector("form");
    const spokenText = "\u4f60\u597d\u{1f30a}".repeat(66) + "\u4f60\u{1f680}";
    assert.equal(Array.from(spokenText).length, 200);
    assert.ok(spokenText.length > 200);
    assert.equal(format.textContent.trim(), "MP3");
    assert.equal(limit.value, "2000");
    await click(generate);
    const mp3URL = playback.getByLabelText(t.admin.t("speech.preview")).src;
    const mp3 = await fetch(mp3URL);
    assert.equal(mp3.headers.get("content-type"), "audio/mpeg");
    assert.equal(await mp3.text(), "test MP3");
    assert.deepEqual(calls[1], ["synthesis", config.read_aloud, t.admin.t("speech.sampleText")]);

    await click(format);
    const wavOption = view.getByRole("option", { name: "WAV" });
    await act(async () => {
      fireEvent.pointerDown(wavOption);
      fireEvent.click(wavOption);
    });
    assert.equal(format.textContent.trim(), "WAV");
    assert.equal(playback.queryByLabelText(t.admin.t("speech.preview")), null);
    await assert.rejects(fetch(mp3URL), TypeError);
    await act(async () => fireEvent.change(limit, { target: { value: "200.1" } }));
    assert.equal(save.disabled, true);
    assert.equal(generate.disabled, true);
    await act(async () => fireEvent.submit(form));
    assert.equal(calls.length, 2);
    await act(async () => fireEvent.change(limit, { target: { value: "200" } }));
    await act(async () => fireEvent.change(sampleText, { target: { value: spokenText + "!" } }));
    assert.equal(generate.disabled, true);
    assert.ok(playback.getByText(t.admin.t("speech.sampleTooLong", { max: 200 })));
    assert.equal(sampleText.value, spokenText + "!");
    await act(async () => fireEvent.change(sampleText, { target: { value: spokenText } }));
    assert.equal(generate.disabled, false);
    const unsavedReadAloud = { ...config.read_aloud, output_format: "wav", max_text_characters: 200 };
    await click(generate);
    assert.deepEqual(calls[2], ["synthesis", unsavedReadAloud, spokenText]);
    const initialWavURL = playback.getByLabelText(t.admin.t("speech.preview")).src;
    const wavResponse = await fetch(initialWavURL);
    assert.equal(wavResponse.headers.get("content-type"), "audio/wav");
    assert.deepEqual(await wavResponse.arrayBuffer(), await wav.arrayBuffer());
    await act(async () => fireEvent.change(limit, { target: { value: "199" } }));
    assert.equal(sampleText.value, spokenText);
    assert.equal(generate.disabled, true);
    assert.equal(playback.queryByLabelText(t.admin.t("speech.preview")), null);
    await assert.rejects(fetch(initialWavURL), TypeError);
    await act(async () => fireEvent.change(limit, { target: { value: "200" } }));
    await click(generate);
    const failedAudio = playback.getByLabelText(t.admin.t("speech.preview"));
    const failedAudioURL = failedAudio.src;
    await act(async () => fireEvent.error(failedAudio));
    assert.equal(playback.queryByLabelText(t.admin.t("speech.preview")), null);
    assert.equal(playback.getByRole("alert").textContent, t.admin.t("speech.previewFailed"));
    await assert.rejects(fetch(failedAudioURL), TypeError);
    await click(generate);
    audioURL = playback.getByLabelText(t.admin.t("speech.preview")).src;
    assert.equal(playback.queryByRole("alert"), null);
    await click(dictation.getByRole("switch", { name: t.admin.t("speech.enableDictation") }));
    await act(async () => fireEvent.submit(form));
    assert.deepEqual(calls[5], ["save", {
      dictation: { ...config.dictation, enabled: true, model: "voice/unsaved-transcription" },
      read_aloud: unsavedReadAloud,
    }]);
    assert.equal(save.disabled, true);
  } finally {
    cleanup();
    actions.remove();
  }
  await assert.rejects(fetch(audioURL), TypeError);
});

test("speech transport accepts both response formats and sends preview settings only through the admin route", async () => {
  const ts = require("typescript");
  const filename = file("lib/api.ts");
  const source = fs.readFileSync(filename, "utf8").replace("import.meta.env.VITE_API_BASE", "undefined");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const wav = sampleWav();
  const calls = [];
  const exports = {};
  vm.runInNewContext(outputText, {
    exports, FormData, Intl,
    require(name) {
      if (name === "./i18n") return t.web;
      if (name.endsWith("/i18n/errors")) return t.errors;
      if (name.endsWith("/shared/speech")) {
        return createLoader(ts, require)(path.resolve(path.dirname(filename), name + ".ts"));
      }
      throw new Error(`Unexpected API dependency: ${name}`);
    },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(wav);
    },
  }, { filename });
  const target = { enabled: true, provider_id: "synthetic", model: "fixture/voice", voice: "fixture", output_format: "wav", max_text_characters: 200 };
  const signal = new AbortController().signal;
  const preview = await exports.adminApi.testSynthesis(target, "Preview this", signal);
  const reply = await exports.api.synthesizeSpeech("Read this", signal);
  assert.equal(preview.type, "audio/wav");
  assert.deepEqual(await reply.arrayBuffer(), await wav.arrayBuffer());
  assert.deepEqual(calls.map(({ url }) => url), ["/api/admin/speech/test-synthesis", "/api/speech/synthesis"]);
  for (const { init } of calls) {
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Accept, "audio/mpeg, audio/wav");
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.equal(init.signal, signal);
  }
  assert.deepEqual(JSON.parse(calls[0].init.body),
    { provider_id: "synthetic", model: "fixture/voice", voice: "fixture", output_format: "wav", max_text_characters: 200, text: "Preview this" });
  assert.deepEqual(JSON.parse(calls[1].init.body), { text: "Read this" });
});
