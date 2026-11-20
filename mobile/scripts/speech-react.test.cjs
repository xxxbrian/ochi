const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const React = require("react");
const { create, act } = require("react-test-renderer");
const { createLoader } = require("../../shared/conversation/test-loader.cjs");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const root = path.resolve(__dirname, "../..");
const deferred = () => Promise.withResolvers();
const h = React.createElement;
const reply = (id, content) => ({ id, content, role: "assistant", run_status: "completed" });
const oldReply = reply("old", "Old reply.");
const newReply = reply("new", "A new response.\n\n```js\nprivate();\n```\nAnother readable paragraph.");
const chat = { account: "server/account", conversation: "session", input: "draft", focused: true, messages: [oldReply, newReply] };
const capabilities = { dictation: true, read_aloud: true, max_recording_seconds: 90, max_upload_bytes: 1024, max_text_characters: 30 };

function harness(overrides = {}) {
  const listeners = new Set();
  const recordings = [];
  const player = [];
  const transcriptions = [];
  const synthesis = [];
  const files = [];
  const AppState = {
    currentState: "active",
    addEventListener(_event, listener) {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  };
  const load = createLoader(require("typescript"), require, {
    "react-native": { AppState },
    [path.join(root, "mobile/src/lib/errors.ts")]: {
      localizedError: (key) => new Error(key),
      errorForDisplay: (error) => error,
    },
    [path.join(root, "mobile/src/lib/api.ts")]: {
      isActiveStatus: (value) => ["queued", "running", "waiting_user", "waiting_resource", "cancelling"].includes(value),
      api: {
        speechCapabilities: async () => capabilities,
        transcribeSpeech(file, signal) {
          const request = { file, signal, ...deferred() };
          transcriptions.push(request);
          return request.promise;
        },
        synthesizeSpeech(text, signal) {
          const request = { text, signal, ...deferred() };
          synthesis.push(request);
          return request.promise;
        },
        ...overrides.api,
      },
    },
    [path.join(root, "mobile/src/lib/speechAudio.ts")]: {
      requestMicrophonePermission: overrides.permission ?? (async () => ({ granted: true })),
      recordSpeech(signal, seconds, onRecording) {
        const recording = deferred();
        const file = { size: 12, exists: true };
        files.push(file);
        recordings.push({ signal, seconds, file });
        signal.addEventListener("abort", () => recording.reject(signal.reason), { once: true });
        onRecording(() => recording.resolve(file));
        return recording.promise;
      },
      playSpeech(bytes, signal, onPlaying) {
        const playback = { bytes, signal, ...deferred() };
        player.push(playback);
        signal.addEventListener("abort", () => playback.reject(signal.reason), { once: true });
        onPlaying();
        return playback.promise;
      },
      removeSpeechFile(file) { if (file) file.exists = false; },
    },
  });
  const { useChatSpeech } = load(path.join(root, "mobile/src/hooks/useChatSpeech.ts"));
  const { appendDictation } = load(path.join(root, "shared/speech.ts"));
  let current;
  function Screen({ account, conversation, input, focused, messages, run = null }) {
    current = useChatSpeech(account, conversation, input, focused, messages, run);
    const [draft, setDraft] = React.useState("Before");
    return h("TextInput", {
      value: draft, onChangeText: setDraft,
      start: () => current.dictation.start((text) => setDraft((value) => appendDictation(value, text))),
    });
  }
  return {
    Screen, recordings, player, transcriptions, synthesis, files, listeners,
    get current() { return current; },
    foreground(value) {
      AppState.currentState = value;
      for (const listener of listeners) listener(value);
    },
  };
}

async function mount(fixture, props = chat) {
  let tree;
  await act(async () => { tree = create(h(fixture.Screen, props)); });
  return tree;
}

test("dictation waits for the microphone prompt and retries the same recording into the latest draft", async () => {
  const permission = deferred();
  const f = harness({ permission: () => permission.promise });
  const tree = await mount(f);
  try {
    const input = tree.root.findByType("TextInput");
    assert.equal(f.current.dictation.enabled, true);
    await act(async () => {
      input.props.start();
      f.foreground("inactive");
      permission.resolve({ granted: true });
    });
    assert.equal(f.current.dictation.status.phase, "starting");
    assert.equal(f.recordings.length, 0);
    await act(async () => { f.foreground("active"); });
    assert.equal(f.current.dictation.status.phase, "recording");
    assert.equal(f.recordings[0].seconds, 90);
    await act(async () => { f.current.dictation.finish(); });
    assert.equal(f.current.dictation.status.phase, "transcribing");
    await act(async () => { f.transcriptions[0].reject(new Error("unavailable")); });
    assert.equal(f.current.dictation.status.retry, true);
    await act(async () => {
      input.props.onChangeText("A more recent draft");
      f.current.dictation.retry();
      f.current.dictation.retry();
    });
    assert.equal(f.transcriptions.length, 2);
    assert.equal(f.transcriptions[0].file, f.transcriptions[1].file);
    await act(async () => { f.transcriptions[1].resolve({ text: "测试简体和繁體" }); });
    assert.equal(tree.root.findByType("TextInput"), input);
    assert.equal(input.props.value, "A more recent draft\n测试简体和繁體");
    assert.equal(f.current.dictation.status, null);
    assert.equal(f.files[0].exists, false);
  } finally {
    await act(async () => tree.unmount());
  }
  assert.equal(f.listeners.size, 0);
});

test("a stale permission or transcription cannot affect a different draft, account, or origin", async () => {
  const prompt = deferred();
  let answer = prompt.promise;
  const f = harness({ permission: () => answer });
  const tree = await mount(f);
  try {
    const input = tree.root.findByType("TextInput");
    await act(async () => input.props.start());
    const edit = { ...chat, input: "edit" };
    await act(async () => tree.update(h(f.Screen, edit)));
    await act(async () => prompt.resolve({ granted: true }));
    assert.equal(f.recordings.length, 0);
    answer = Promise.resolve({ granted: true });
    await act(async () => input.props.start());
    await act(async () => f.current.dictation.finish());
    const request = f.transcriptions[0];
    await act(async () => tree.update(h(f.Screen, { ...chat, account: "other/other", conversation: "new" })));
    assert.equal(request.signal.aborted, true);
    await act(async () => request.resolve({ text: "stale" }));
    assert.equal(input.props.value, "Before");
    assert.equal(f.current.dictation.status, null);
    assert.equal(f.files[0].exists, false);
  } finally {
    await act(async () => tree.unmount());
  }
});

test("read-aloud queues only prose, stops a stale reply and relinquishes playback before recording", async () => {
  const f = harness();
  const tree = await mount(f);
  try {
    await act(async () => f.current.readAloud.toggle(oldReply.id, oldReply.content));
    await act(async () => f.current.readAloud.toggle(newReply.id, newReply.content));
    assert.equal(f.synthesis[0].signal.aborted, true);
    await act(async () => {
      f.synthesis[0].resolve(new Uint8Array([1]));
      f.synthesis[1].resolve(new Uint8Array([2]));
    });
    assert.equal(f.player.length, 1);
    assert.equal(f.current.readAloud.status.phase, "playing");
    assert.equal(f.synthesis[1].text, "A new response.");
    await act(async () => f.player[0].resolve());
    assert.equal(f.synthesis[2].text, "Another readable paragraph.");
    await act(async () => f.synthesis[2].resolve(new Uint8Array([3])));
    assert.equal(f.player.length, 2);
    await act(async () => tree.root.findByType("TextInput").props.start());
    assert.equal(f.player[1].signal.aborted, true);
    assert.equal(f.current.readAloud.status, null);
    assert.equal(f.current.dictation.status.phase, "recording");
    await act(async () => f.foreground("background"));
    assert.equal(f.recordings[0].signal.aborted, true);
    assert.equal(f.current.dictation.status, null);
  } finally {
    await act(async () => tree.unmount());
  }
});

test("read-aloud follows the current reply through persistence but stops after revision or removal", async () => {
  const pending = {
    run_id: "run", status: "completed", items: [{ kind: "text", text: "Initial answer.", phase: "final" }],
  };
  const f = harness();
  const tree = await mount(f, { ...chat, messages: [], run: pending });
  try {
    await act(async () => f.current.readAloud.toggle("assistant-run", "Initial answer."));
    await act(async () => f.synthesis[0].resolve(new Uint8Array([1])));
    const persisted = { ...reply("saved-answer", "Initial answer."), run_id: "run" };
    await act(async () => tree.update(h(f.Screen, { ...chat, messages: [persisted] })));
    assert.equal(f.player[0].signal.aborted, false);
    const revised = { ...persisted, content: "Revised answer." };
    await act(async () => tree.update(h(f.Screen, { ...chat, messages: [revised] })));
    assert.equal(f.player[0].signal.aborted, true);
    assert.equal(f.current.readAloud.status, null);
    await act(async () => f.current.readAloud.toggle("assistant-run", "Initial answer."));
    assert.equal(f.synthesis.length, 1);
    await act(async () => f.current.readAloud.toggle("assistant-run", "Revised answer."));
    assert.equal(f.synthesis.length, 2);
    await act(async () => tree.update(h(f.Screen, { ...chat, messages: [] })));
    assert.equal(f.synthesis[1].signal.aborted, true);
    await act(async () => f.synthesis[1].resolve(new Uint8Array([2])));
    assert.equal(f.player.length, 1);
  } finally {
    await act(async () => tree.unmount());
  }
});
