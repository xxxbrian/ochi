import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { translateError } from "../../../shared/i18n/errors";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import type { SpeechCapabilities } from "../lib/types";

const formats = [
  { mime: "audio/webm;codecs=opus", extension: "webm" },
  { mime: "audio/mp4", extension: "m4a" },
  { mime: "audio/ogg;codecs=opus", extension: "ogg" },
  { mime: "audio/webm", extension: "webm" },
  { mime: "audio/ogg", extension: "ogg" },
];

const recordingFormat = () =>
  typeof MediaRecorder === "function" && typeof navigator.mediaDevices?.getUserMedia === "function"
    ? formats.find(({ mime }) => MediaRecorder.isTypeSupported(mime))
    : undefined;

type Capture = {
  controller: AbortController;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  timer?: ReturnType<typeof setTimeout>;
  file?: File;
};

type DictationState =
  | { phase: "permission" | "finishing" | "transcribing" }
  | { phase: "recording"; startedAt: number }
  | { phase: "retry" | "error"; error: string };

function releaseMicrophone(capture: Capture) {
  clearTimeout(capture.timer);
  const recorder = capture.recorder;
  if (recorder) {
    recorder.ondataavailable = recorder.onstop = recorder.onerror = null;
    if (recorder.state !== "inactive") recorder.stop();
    capture.recorder = undefined;
  }
  capture.stream?.getTracks().forEach((track) => track.stop());
  capture.stream = undefined;
}

export function useDictation({
  scope, capabilities, inputRef, onTranscript, onActiveChange,
}: {
  scope: string;
  capabilities?: SpeechCapabilities;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onTranscript: (text: string) => void;
  onActiveChange?: (active: boolean) => void;
}) {
  const available = Boolean(capabilities?.dictation && recordingFormat());
  const seconds = capabilities?.max_recording_seconds ?? 0;
  const maxBytes = capabilities?.max_upload_bytes ?? 0;
  const [state, setState] = useState<DictationState | null>(null);
  const active = useRef<Capture>(null);
  const selection = useRef<{ start: number; end: number; direction: "forward" | "backward" | "none" }>(null);
  const latest = useRef({ onTranscript, onActiveChange });
  useLayoutEffect(() => {
    latest.current = { onTranscript, onActiveChange };
  }, [onTranscript, onActiveChange]);

  const release = useCallback(() => {
    const capture = active.current;
    active.current = null;
    if (!capture) return;
    capture.controller.abort();
    releaseMicrophone(capture);
    latest.current.onActiveChange?.(false);
  }, []);
  const cancel = useCallback(() => {
    release();
    setState(null);
  }, [release]);

  useLayoutEffect(() => {
    setState(null);
    if (!available) return;
    window.addEventListener("pagehide", cancel);
    return () => {
      window.removeEventListener("pagehide", cancel);
      selection.current = null;
      release();
    };
  }, [scope, available, seconds, maxBytes, cancel, release]);

  useLayoutEffect(() => {
    const saved = selection.current;
    selection.current = null;
    const input = inputRef.current;
    if (saved && input && document.activeElement === input) {
      input.setSelectionRange(saved.start, saved.end, saved.direction);
    }
  });

  function fail(message: string) {
    release();
    setState({ phase: "error", error: message });
  }

  async function transcribe(capture: Capture, file: File) {
    setState({ phase: "transcribing" });
    capture.file = undefined;
    try {
      const { text } = await api.transcribe(file, capture.controller.signal);
      if (active.current !== capture) return;
      if (!text.trim()) {
        fail(t("composer.noSpeech"));
        return;
      }
      const input = inputRef.current;
      if (input && document.activeElement === input) {
        selection.current = { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
      }
      latest.current.onTranscript(text);
      cancel();
    } catch (reason) {
      if (active.current !== capture) return;
      capture.file = file;
      setState({ phase: "retry", error: reason instanceof Error ? reason.message : t("composer.transcriptionFailed") });
    }
  }

  function finish() {
    const capture = active.current;
    if (!capture || capture.recorder?.state !== "recording") return;
    clearTimeout(capture.timer);
    setState({ phase: "finishing" });
    capture.recorder.stop();
  }

  async function start() {
    const format = available ? recordingFormat() : undefined;
    if (active.current || !format) return;
    const capture: Capture = { controller: new AbortController() };
    active.current = capture;
    latest.current.onActiveChange?.(true);
    setState({ phase: "permission" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      capture.stream = stream;
      if (active.current !== capture) {
        releaseMicrophone(capture);
        return;
      }
      const recorder = new MediaRecorder(stream, { mimeType: format.mime });
      capture.recorder = recorder;
      const chunks: Blob[] = [];
      let bytes = 0;
      recorder.ondataavailable = ({ data }) => {
        if (active.current !== capture || data.size === 0) return;
        bytes += data.size;
        if (bytes > maxBytes) {
          fail(translateError("speech_recording_too_large", { max: maxBytes / (1024 * 1024) }) ?? t("error.fileSize"));
          return;
        }
        chunks.push(data);
      };
      recorder.onstop = () => {
        if (active.current !== capture) return;
        const type = chunks[0]?.type || recorder.mimeType || format.mime;
        const extension = formats.find(({ mime }) => mime.split(";")[0] === type.split(";")[0])?.extension ?? format.extension;
        releaseMicrophone(capture);
        if (!bytes) {
          fail(t("composer.noSpeech"));
          return;
        }
        void transcribe(capture, new File(chunks, `recording.${extension}`, { type }));
      };
      recorder.onerror = () => {
        if (active.current === capture) fail(t("error.microphone"));
      };
      recorder.start(500);
      setState({ phase: "recording", startedAt: Date.now() });
      capture.timer = setTimeout(finish, seconds * 1000);
    } catch {
      if (active.current === capture) fail(t("error.microphone"));
    }
  }

  function retry() {
    const capture = active.current;
    if (capture?.file) void transcribe(capture, capture.file);
    else void start();
  }

  const pending = state !== null && state.phase !== "error" && state.phase !== "retry";
  return { available, pending, state, start, finish, retry, cancel };
}
