import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import type { File } from "expo-file-system";
import { Lexer } from "marked";
import { chatMessageKey, messagePresentation, projectChatMessages } from "../../../shared/conversation/projection";
import { splitSpeechText } from "../../../shared/speech";
import { api, isActiveStatus } from "../lib/api";
import { errorForDisplay, localizedError, type DisplayError } from "../lib/errors";
import { playSpeech, recordSpeech, removeSpeechFile, requestMicrophonePermission } from "../lib/speechAudio";
import type { Message, Snapshot, SpeechCapabilities } from "../lib/types";

type DictationStatus =
  | { phase: "starting" | "finishing" | "transcribing" }
  | { phase: "recording"; startedAt: number; maxSeconds: number }
  | { phase: "failed"; retry?: boolean; error: DisplayError };
type PlaybackStatus = { id: string; phase: "loading" | "playing" | "failed"; error?: DisplayError };
type Operation = { owner: string; controller: AbortController };
type Reply = { id: string; text: string };
type DictationOperation = Operation & {
  file?: File;
  finish?: () => void;
  permissionPending: boolean;
  transcribing?: boolean;
  receive: (text: string) => void;
};
const noMessages: Message[] = [];

export type DictationActions = {
  enabled: boolean;
  status: DictationStatus | null;
  start: (receive: (text: string) => void) => void;
  finish: () => void;
  cancel: () => void;
  retry: () => void;
};

export type ReadAloudActions = {
  enabled: boolean;
  blocked: boolean;
  status: PlaybackStatus | null;
  toggle: (id: string, text: string) => void;
};

function useSpeechCapabilities(owner: string, focused: boolean) {
  const scope = useMemo(() => ({ owner, focused }), [owner, focused]);
  const [state, setState] = useState<{ scope: typeof scope; value: SpeechCapabilities }>();
  useEffect(() => {
    if (!scope.owner || !scope.focused) return;
    let pending: AbortController | undefined;
    const load = () => {
      pending?.abort();
      const request = new AbortController();
      pending = request;
      void api.speechCapabilities(request.signal).then((value) => {
        if (!request.signal.aborted) setState({ scope, value });
      }).catch(() => undefined);
    };
    if (AppState.currentState === "active") load();
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") load();
    });
    return () => { pending?.abort(); listener.remove(); };
  }, [scope]);
  return state?.scope === scope ? state.value : undefined;
}

function waitForMicrophoneForeground(signal: AbortSignal) {
  if (signal.aborted || AppState.currentState !== "inactive") return Promise.resolve(AppState.currentState === "active");
  // iOS can resolve the permission prompt just before delivering active.
  return new Promise<boolean>((resolve) => {
    const finish = (allowed: boolean) => {
      subscription.remove();
      signal.removeEventListener("abort", abort);
      resolve(allowed);
    };
    const abort = () => finish(false);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "inactive") finish(state === "active");
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}

function replyIsCurrent(reply: Reply, messages: Message[], run: Snapshot | null) {
  const message = projectChatMessages(messages, run).find((value) => value.role === "assistant" && chatMessageKey(value) === reply.id);
  if (!message) return false;
  const presentation = messagePresentation(message, run?.run_id === message.run_id ? run : null);
  return !isActiveStatus(presentation.snapshot?.status ?? message.run_status) && presentation.copyText === reply.text;
}

export function useChatSpeech(
  account: string,
  conversation: string,
  input: string,
  focused: boolean,
  messages: Message[] = noMessages,
  run: Snapshot | null = null,
) {
  const caps = useSpeechCapabilities(account, focused);
  const recordOwner = caps?.dictation ? input : "";
  const playOwner = caps?.read_aloud ? conversation : "";
  const latest = useRef({ recordOwner, playOwner, caps, messages, run });
  latest.current = { recordOwner, playOwner, caps, messages, run };
  const capture = useRef<DictationOperation | null>(null);
  const reader = useRef<(Operation & Reply) | null>(null);
  const [recordState, setRecordState] = useState<{ operation: DictationOperation; value: DictationStatus } | null>(null);
  const [playState, setPlayState] = useState<{ owner: string; value: PlaybackStatus } | null>(null);

  const cancelDictation = useCallback(() => {
    const operation = capture.current;
    capture.current = null;
    operation?.controller.abort();
    removeSpeechFile(operation?.file);
    setRecordState(null);
  }, []);
  const stopReading = useCallback(() => {
    reader.current?.controller.abort();
    reader.current = null;
    setPlayState(null);
  }, []);
  useLayoutEffect(() => cancelDictation, [recordOwner, cancelDictation]);
  useLayoutEffect(() => stopReading, [playOwner, stopReading]);
  useLayoutEffect(() => {
    const operation = reader.current;
    if (operation && !replyIsCurrent(operation, messages, run)) stopReading();
  }, [messages, run, stopReading]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") return;
      stopReading();
      if (!capture.current?.permissionPending) cancelDictation();
    });
    return () => listener.remove();
  }, [cancelDictation, stopReading]);

  const ownsCapture = useCallback((operation: DictationOperation) =>
    capture.current === operation && latest.current.recordOwner === operation.owner && !operation.controller.signal.aborted, []);

  const transcribe = useCallback(async (operation: DictationOperation) => {
    const file = operation.file;
    if (!file || operation.transcribing || !ownsCapture(operation)) return;
    operation.transcribing = true;
    setRecordState({ operation, value: { phase: "transcribing" } });
    try {
      const { text } = await api.transcribeSpeech(file, operation.controller.signal);
      if (!ownsCapture(operation)) return;
      if (typeof text !== "string" || !text.trim()) {
        removeSpeechFile(file);
        operation.file = undefined;
        throw localizedError("speech.noSpeech");
      }
      operation.receive(text);
      cancelDictation();
    } catch (reason) {
      if (!ownsCapture(operation)) return;
      const retry = file.exists;
      setRecordState({ operation, value: {
        phase: "failed", retry, error: errorForDisplay(reason, "speech.transcriptionFailed"),
      } });
    } finally {
      operation.transcribing = false;
    }
  }, [cancelDictation, ownsCapture]);

  const startDictation = useCallback((receive: (text: string) => void) => {
    const { recordOwner, caps } = latest.current;
    if (!recordOwner || !caps || AppState.currentState !== "active" || capture.current) return;
    stopReading();
    cancelDictation();
    const operation: DictationOperation = { owner: recordOwner, controller: new AbortController(), permissionPending: true, receive };
    capture.current = operation;
    setRecordState({ operation, value: { phase: "starting" } });
    void (async () => {
      const signal = operation.controller.signal;
      try {
        const permission = await requestMicrophonePermission();
        if (!ownsCapture(operation)) return;
        if (!permission.granted) throw localizedError("speech.microphoneDenied");
        if (!await waitForMicrophoneForeground(signal)) {
          if (ownsCapture(operation)) cancelDictation();
          return;
        }
        if (!ownsCapture(operation)) return;
        operation.permissionPending = false;
        const file = await recordSpeech(signal, caps.max_recording_seconds, (finish) => {
          operation.finish = finish;
          if (ownsCapture(operation)) {
            setRecordState({ operation, value: { phase: "recording", startedAt: Date.now(), maxSeconds: caps.max_recording_seconds } });
          }
        });
        if (!ownsCapture(operation)) { removeSpeechFile(file); return; }
        operation.finish = undefined;
        operation.file = file;
        if (!file.size || file.size > caps.max_upload_bytes) {
          throw localizedError(file.size ? "speech.recordingTooLarge" : "speech.noSpeech");
        }
        await transcribe(operation);
      } catch (reason) {
        if (!ownsCapture(operation)) return;
        operation.permissionPending = false;
        operation.finish = undefined;
        removeSpeechFile(operation.file);
        operation.file = undefined;
        setRecordState({ operation, value: { phase: "failed", error: errorForDisplay(reason, "speech.recordingFailed") } });
      }
    })();
  }, [cancelDictation, ownsCapture, stopReading, transcribe]);

  const finishDictation = useCallback(() => {
    const operation = capture.current;
    if (!operation?.finish || !ownsCapture(operation)) return;
    const finish = operation.finish;
    operation.finish = undefined;
    setRecordState({ operation, value: { phase: "finishing" } });
    finish();
  }, [ownsCapture]);

  const status = recordState?.operation.owner === recordOwner ? recordState.value : null;
  const blocked = Boolean(status);
  const retryDictation = useCallback(() => {
    if (status?.phase === "failed" && capture.current) void transcribe(capture.current);
  }, [status?.phase, transcribe]);

  const toggleReadAloud = useCallback((id: string, text: string) => {
    const { playOwner, messages, run } = latest.current;
    if (!playOwner || capture.current || AppState.currentState !== "active") return;
    const wasReading = reader.current?.id === id && reader.current.owner === playOwner;
    if (!wasReading && !replyIsCurrent({ id, text }, messages, run)) return;
    stopReading();
    if (wasReading) return;
    const operation = { owner: playOwner, id, text, controller: new AbortController() };
    reader.current = operation;
    const signal = operation.controller.signal;
    const ownsPlayback = () => reader.current === operation && latest.current.playOwner === playOwner && !signal.aborted;
    const loading = { owner: playOwner, value: { id, phase: "loading" as const } };
    setPlayState(loading);
    void (async () => {
      try {
        const caps = await api.speechCapabilities(signal);
        if (!ownsPlayback()) return;
        if (!caps.read_aloud) throw localizedError("speech.playbackFailed");
        const chunks = splitSpeechText(Lexer.lex(text), caps.max_text_characters);
        if (!chunks.length) {
          reader.current = null;
          setPlayState({ owner: playOwner, value: { id, phase: "failed", error: localizedError("speech.noReadableText") } });
          return;
        }
        for (const part of chunks) {
          if (!ownsPlayback()) return;
          setPlayState(loading);
          const audio = await api.synthesizeSpeech(part, signal);
          if (!ownsPlayback()) return;
          await playSpeech(audio, signal, () => {
            if (ownsPlayback()) setPlayState({ owner: playOwner, value: { id, phase: "playing" } });
          });
        }
        if (ownsPlayback()) stopReading();
      } catch (reason) {
        if (!ownsPlayback()) return;
        reader.current = null;
        setPlayState({ owner: playOwner, value: { id, phase: "failed", error: errorForDisplay(reason, "speech.playbackFailed") } });
      }
    })();
  }, [stopReading]);

  const dictation = useMemo<DictationActions>(() => ({
    enabled: Boolean(recordOwner), status, start: startDictation, cancel: cancelDictation, finish: finishDictation, retry: retryDictation,
  }), [recordOwner, status, startDictation, cancelDictation, finishDictation, retryDictation]);
  const playback = playState?.owner === playOwner ? playState.value : null;
  const readAloud = useMemo<ReadAloudActions>(() => ({
    enabled: Boolean(playOwner), blocked, status: playback, toggle: toggleReadAloud,
  }), [playOwner, blocked, playback, toggleReadAloud]);
  return { dictation, readAloud };
}
