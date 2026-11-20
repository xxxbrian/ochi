import { AudioModule, createAudioPlayer, RecordingPresets, setAudioModeAsync, setIsAudioActiveAsync } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import { localizedError } from "./errors";

const preset = RecordingPresets.HIGH_QUALITY;
const recordingOptions = {
  extension: preset.extension,
  sampleRate: preset.sampleRate,
  numberOfChannels: 1,
  bitRate: 64_000,
  ...(Platform.OS === "ios" ? preset.ios : preset.android),
};
const nativeEventTimeout = 10_000;
let audioTail = Promise.resolve();
let fileSequence = 0;

function checkSignal(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
}

function withAudioSession<T>(signal: AbortSignal, recording: boolean, work: () => Promise<T>) {
  const task = audioTail.then(async () => {
    checkSignal(signal);
    try {
      await setAudioModeAsync({
        allowsRecording: recording,
        allowsBackgroundRecording: false,
        shouldPlayInBackground: false,
        playsInSilentMode: true,
        interruptionMode: "duckOthers",
      });
      checkSignal(signal);
      if (!recording) await setIsAudioActiveAsync(true);
      checkSignal(signal);
      return await work();
    } finally {
      await setIsAudioActiveAsync(false).catch(() => undefined);
    }
  });
  // Expo owns an app-wide audio session. Finish a cancelled operation's native
  // teardown before switching its mode for another screen or source.
  audioTail = task.then(() => undefined, () => undefined);
  return task;
}

export function removeSpeechFile(file?: File) {
  try { if (file?.exists) file.delete(); } catch { /* The OS may have cleared this cache. */ }
}

export function recordSpeech(
  signal: AbortSignal,
  seconds: number,
  onRecording: (finish: () => void) => void,
) {
  return withAudioSession(signal, true, async () => {
    const recorder = new AudioModule.AudioRecorder(recordingOptions);
    let completed: File | undefined;
    let finished = false;
    let recording = false;
    let stopTask: Promise<void> | undefined;
    let stopWatching: (() => void) | undefined;
    try {
      await recorder.prepareToRecordAsync();
      checkSignal(signal);
      completed = await new Promise<File>((resolve, reject) => {
        const failed = () => reject(localizedError("speech.recordingFailed"));
        const abort = () => reject(signal.reason);
        const subscription = recorder.addListener("recordingStatusUpdate", (status) => {
          if (status.isFinished) finished = true;
          if (status.hasError || status.mediaServicesDidReset) failed();
          else if (status.isFinished && status.url) {
            try { resolve(new File(status.url)); } catch { failed(); }
          } else if (status.isFinished) failed();
        });
        let timeout = setTimeout(failed, seconds * 1_000 + nativeEventTimeout);
        signal.addEventListener("abort", abort, { once: true });
        stopWatching = () => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", abort);
          subscription.remove();
        };
        const finish = () => {
          if (finished || stopTask || signal.aborted) return;
          clearTimeout(timeout);
          timeout = setTimeout(failed, nativeEventTimeout);
          stopTask = recorder.stop().catch(failed);
        };
        recorder.record({ forDuration: seconds });
        recording = true;
        onRecording(finish);
      });
      return completed;
    } finally {
      stopWatching?.();
      const uri = recorder.uri;
      try {
        if (stopTask) await stopTask;
        else if (recording && !finished) await recorder.stop().catch(() => undefined);
      } finally {
        recorder.release();
        if (!completed && uri) removeSpeechFile(new File(uri));
      }
    }
  });
}

export function requestMicrophonePermission() {
  return AudioModule.requestRecordingPermissionsAsync();
}

export async function playSpeech(bytes: Uint8Array, signal: AbortSignal, onPlaying: () => void) {
  checkSignal(signal);
  if (!bytes.byteLength) throw localizedError("speech.playbackFailed");
  const file = new File(Paths.cache, `ochi-speech-${Date.now()}-${++fileSequence}.mp3`);
  try {
    file.create();
    file.write(bytes);
    await withAudioSession(signal, false, async () => {
      // The managed session is deactivated after release, since Expo's default
      // delayed deactivation can otherwise cut off a newly started recording.
      const player = createAudioPlayer(file.uri, { keepAudioSessionActive: true, updateInterval: 250 });
      let stopWatching: (() => void) | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          const failed = () => reject(localizedError("speech.playbackFailed"));
          let timeout = setTimeout(failed, nativeEventTimeout);
          let started = false;
          let position = -1;
          const subscription = player.addListener("playbackStatusUpdate", (status) => {
            if (status.error || status.mediaServicesDidReset) failed();
            else if (status.didJustFinish) resolve();
            else if (status.playing && status.currentTime > position) {
              position = status.currentTime;
              if (!started) {
                started = true;
                onPlaying();
              }
              clearTimeout(timeout);
              timeout = setTimeout(failed, nativeEventTimeout);
            }
          });
          signal.addEventListener("abort", abort, { once: true });
          stopWatching = () => {
            clearTimeout(timeout);
            signal.removeEventListener("abort", abort);
            subscription.remove();
          };
          player.play();
        });
      } finally {
        stopWatching?.();
        try { player.pause(); } finally { player.release(); }
      }
    });
  } finally {
    removeSpeechFile(file);
  }
}
