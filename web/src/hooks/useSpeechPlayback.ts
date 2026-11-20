import { Lexer } from "marked";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { translateError } from "../../../shared/i18n/errors";
import { splitSpeechText } from "../../../shared/speech";
import { api } from "../lib/api";
import { t } from "../lib/i18n";

type Playback = {
  id: string;
  controller: AbortController;
  context: AudioContext;
  source?: AudioBufferSourceNode;
};

export type SpeechPlaybackStatus = { id: string; preparing: boolean };

export function useSpeechPlayback(scope: string, enabled: boolean, onError: (message: string) => void) {
  const current = useRef<Playback>(null);
  const [status, setStatus] = useState<SpeechPlaybackStatus | null>(null);
  const available = enabled && typeof AudioContext === "function";

  const release = useCallback(() => {
    const playing = current.current;
    current.current = null;
    if (!playing) return;
    playing.controller.abort();
    if (playing.source) {
      playing.source.onended = null;
      playing.source.stop();
      playing.source.disconnect();
    }
    void playing.context.close().catch(() => undefined);
  }, []);

  const stop = useCallback(() => {
    release();
    setStatus(null);
  }, [release]);

  useLayoutEffect(() => {
    setStatus(null);
    if (!available) return;
    window.addEventListener("pagehide", stop);
    return () => {
      window.removeEventListener("pagehide", stop);
      release();
    };
  }, [scope, available, release, stop]);

  const toggle = useCallback(async (id: string, markdown: string) => {
    if (!available) return;
    if (current.current?.id === id) {
      stop();
      return;
    }
    stop();
    let playing: Playback | undefined;
    try {
      const context = new AudioContext();
      playing = { id, context, controller: new AbortController() };
      current.current = playing;
      setStatus({ id, preparing: true });
      // Activate audio in the click gesture before waiting for any synthesis request.
      await context.resume();
      if (current.current !== playing) return;

      const signal = playing.controller.signal;
      const capability = await api.speechCapabilities(signal);
      if (current.current !== playing) return;
      if (!capability.read_aloud) {
        stop();
        onError(translateError("speech_unavailable") ?? t("message.speechPlaybackFailed"));
        return;
      }
      const chunks = splitSpeechText(Lexer.lex(markdown), capability.max_text_characters);
      if (chunks.length === 0) {
        stop();
        onError(t("message.noSpeechText"));
        return;
      }

      for (const chunk of chunks) {
        if (current.current !== playing) return;
        const blob = await api.synthesizeSpeech(chunk, signal);
        if (current.current !== playing) return;
        const data = await blob.arrayBuffer();
        if (current.current !== playing) return;
        const buffer = await context.decodeAudioData(data);
        if (current.current !== playing) return;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.start();
        playing.source = source;
        setStatus({ id, preparing: false });
        await new Promise<void>((resolve) => {
          function done() {
            signal.removeEventListener("abort", done);
            resolve();
          }
          source.onended = done;
          signal.addEventListener("abort", done, { once: true });
        });
        if (current.current !== playing) return;
        source.onended = null;
        source.disconnect();
        playing.source = undefined;
        setStatus({ id, preparing: true });
      }
      stop();
    } catch (reason) {
      if (playing && current.current !== playing) return;
      stop();
      onError(reason instanceof Error && "status" in reason ? reason.message : t("message.speechPlaybackFailed"));
    }
  }, [available, onError, stop]);

  const stopMessage = useCallback((id: string) => {
    if (current.current?.id === id) stop();
  }, [stop]);

  return { available, status, toggle, stop, stopMessage };
}
