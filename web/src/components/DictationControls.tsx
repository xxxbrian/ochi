import { Check, Mic, RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { useDictation } from "../hooks/useDictation";
import { t, useI18n } from "../lib/i18n";
import "./composer.css";

function RecordingTime({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))), 250);
    return () => clearInterval(timer);
  }, [startedAt]);
  return <span className="tnum" aria-hidden="true">
    {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
  </span>;
}

export function DictationControls({ voice, disabled }: {
  voice: ReturnType<typeof useDictation>;
  disabled?: boolean;
}) {
  useI18n();
  const microphoneButton = useRef<HTMLButtonElement>(null);
  if (!voice.available) return null;
  const state = voice.state;
  const retainInput = (event: MouseEvent) => event.preventDefault();
  const restoreVoiceFocus = (event: MouseEvent<HTMLButtonElement>) => {
    if (document.activeElement === event.currentTarget) microphoneButton.current?.focus();
  };
  const recording = state?.phase === "recording";
  const failure = state?.phase === "retry" || state?.phase === "error";
  const action = t(state ? "composer.cancelRecording" : "composer.voiceInput");
  const status = recording
    ? t("composer.recording")
    : state?.phase === "permission" ? t("composer.requestingMicrophone") : t("composer.transcribing");
  return (
    <div className="dictation-controls" data-active={Boolean(state) || undefined}>
      {failure
        ? <span className="dictation-status" role="alert">{state.error}</span>
        : state && <span className="dictation-status" role="status">
            {recording && <span className="dictation-dot" aria-hidden="true" />}
            <span>{status}</span>
            {recording && <RecordingTime startedAt={state.startedAt} />}
          </span>}
      <button ref={microphoneButton} type="button" className="icon-btn sm" aria-label={action} title={action}
        disabled={!state && disabled} onMouseDown={retainInput} onClick={state ? voice.cancel : () => void voice.start()}>
        {state ? <X className="ic" /> : <Mic className="ic" />}
      </button>
      {recording && (
        <button type="button" className="icon-btn sm dictation-finish" aria-label={t("composer.finishRecording")} title={t("composer.finishRecording")}
          onMouseDown={retainInput} onClick={(event) => { restoreVoiceFocus(event); voice.finish(); }}>
          <Check className="ic" />
        </button>
      )}
      {failure && (
        <button type="button" className="icon-btn sm" aria-label={t("common.retry")} title={t("common.retry")}
          disabled={disabled} onMouseDown={retainInput} onClick={(event) => { restoreVoiceFocus(event); voice.retry(); }}>
          <RotateCw className="ic" />
        </button>
      )}
    </div>
  );
}
