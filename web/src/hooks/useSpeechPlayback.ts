import { Lexer } from "marked";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
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

export function useSpeechPlayback(scope: string, maxCharacters: number, onError: (message: string) => void) {
  const current = useRef<Playback>(null);
  const [status, setStatus] = useState<SpeechPlaybackStatus | null>(null);
  const available = maxCharacters > 0 && typeof AudioContext === "function";

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
  }, [scope, available, maxCharacters, release, stop]);

  const toggle = useCallback(async (id: string, markdown: string) => {
    if (!available) return;
    if (current.current?.id === id) {
      stop();
      return;
    }
    stop();
    let playing: Playback | undefined;
    try {
      const chunks = splitSpeechText(Lexer.lex(markdown), maxCharacters);
      if (chunks.length === 0) {
        onError(t("message.noSpeechText"));
        return;
      }
      const context = new AudioContext();
      playing = { id, context, controller: new AbortController() };
      current.current = playing;
      setStatus({ id, preparing: true });
      // Activate audio in the click gesture before waiting for any synthesis request.
      await context.resume();

      for (const chunk of chunks) {
        if (current.current !== playing) return;
        const signal = playing.controller.signal;
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
  }, [available, maxCharacters, onError, stop]);

  const stopMessage = useCallback((id: string) => {
    if (current.current?.id === id) stop();
  }, [stop]);

  return { available, status, toggle, stop, stopMessage };
}
