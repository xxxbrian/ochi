import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Mic, Volume2 } from "lucide-react";
import { adminApi } from "../../lib/api";
import type { Provider, SpeechSettings } from "../../lib/types";
import { SelectField } from "../../components/ui/Select";
import { AdminSkeleton, ErrorNotice, Field } from "./Fields";
import { AdminHeader, Card, CardHead, Switch } from "./ui";
import { t, useAdminI18n } from "./i18n";

type Operation = "save" | "dictation" | "read_aloud";
type ReportedError = { operation: Operation | "load"; message: string };
type DictationSettings = SpeechSettings["dictation"];
type ReadAloudSettings = SpeechSettings["read_aloud"];

function usable(settings: DictationSettings, providers: Provider[]) {
  return Boolean(settings.model.trim() && providers.some(({ id, enabled }) => id === settings.provider_id && enabled));
}

function errorText(reason: unknown, fallback: string, diagnostic: boolean) {
  if (!(reason instanceof Error)) return fallback;
  const detail = diagnostic && "detail" in reason && typeof reason.detail === "string" ? reason.detail : "";
  return detail && detail !== reason.message ? `${reason.message}\n${detail}` : reason.message;
}

function SpeechFields({ value, providers, onChange, busy }: {
  value: DictationSettings;
  providers: Provider[];
  onChange: (value: Partial<DictationSettings>) => void;
  busy: boolean;
}) {
  const options = [
    { value: "", label: t("chooseProvider") },
    ...providers.map(({ id, name, enabled }) => ({ value: id, label: enabled ? name : `${name} (${t("disabled")})`, disabled: !enabled })),
  ];
  if (value.provider_id && !providers.some(({ id }) => id === value.provider_id)) {
    options.push({ value: value.provider_id, label: t("speech.missingProvider"), disabled: true });
  }
  return (
    <div className="ochi-admin-grid2">
      <Field title={t("provider")}>
        <SelectField value={value.provider_id} options={options} label={t("provider")} disabled={busy}
          triggerClassName="ochi-admin-speech-select" onChange={(provider_id) => onChange({ provider_id })} />
      </Field>
      <Field title={t("modelID")} hint={t("speech.modelHint")}>
        <input className="input mono" value={value.model} disabled={busy}
          onChange={(event) => onChange({ model: event.target.value })} />
      </Field>
    </div>
  );
}

export default function SpeechPage() {
  useAdminI18n();
  const [settings, setSettings] = useState<SpeechSettings | null>(null);
  const [saved, setSaved] = useState<SpeechSettings | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [busy, setBusy] = useState<Operation | null>(null);
  const [error, setError] = useState<ReportedError | null>(null);
  const [notice, setNotice] = useState("");
  const [sample, setSample] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [transcript, setTranscript] = useState<string | null>(null);
  const [audio, setAudio] = useState<Blob | null>(null);
  const [audioURL, setAudioURL] = useState("");
  const request = useRef<AbortController>(null);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([adminApi.speechSettings(controller.signal), adminApi.providers(controller.signal)])
      .then(([config, connections]) => {
        if (controller.signal.aborted) return;
        setSettings(config);
        setSaved(config);
        setProviders(connections);
        setText(t("speech.sampleText"));
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError({ operation: "load", message: errorText(reason, t("speech.loadFailed"), false) });
      });
    return () => controller.abort();
  }, []);

  useLayoutEffect(() => () => { request.current?.abort(); }, []);
  useLayoutEffect(() => {
    const url = audio ? URL.createObjectURL(audio) : "";
    setAudioURL(url);
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [audio]);

  function update<K extends "dictation" | "read_aloud">(section: K, patch: Partial<SpeechSettings[K]>) {
    setSettings((current) => current ? { ...current, [section]: { ...current[section], ...patch } } : current);
    setNotice("");
    setError((current) => current?.operation === section || current?.operation === "save" ? null : current);
    if ("enabled" in patch) return;
    if (section === "dictation") setTranscript(null);
    else setAudio(null);
  }

  async function run(operation: Operation, action: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(operation);
    setError(null);
    setNotice("");
    try {
      await action(controller.signal);
    } catch (reason) {
      if (!controller.signal.aborted) {
        const fallback = operation === "save" ? t("saveFailed") : t("testFailed");
        setError({ operation, message: errorText(reason, fallback, operation !== "save") });
      }
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  const dictationReady = Boolean(settings && usable(settings.dictation, providers));
  const readAloudReady = Boolean(settings && usable(settings.read_aloud, providers) && settings.read_aloud.voice.trim());
  const valid = settings && (!settings.dictation.enabled || dictationReady) && (!settings.read_aloud.enabled || readAloudReady);
  const dirty = JSON.stringify(settings) !== JSON.stringify(saved);
  function save() {
    if (!settings || !valid || !dirty) return;
    void run("save", async (signal) => {
      const config = await adminApi.saveSpeechSettings(settings, signal);
      if (signal.aborted) return;
      setSettings(config);
      setSaved(config);
      setNotice(t("saved"));
    });
  }
  function testDictation() {
    if (!settings || !dictationReady || !sample) return;
    void run("dictation", async (signal) => {
      setTranscript(null);
      const result = await adminApi.testTranscription(settings.dictation, sample, signal);
      if (!signal.aborted) setTranscript(result.text);
    });
  }
  function testReadAloud() {
    if (!settings || !readAloudReady || !text.trim()) return;
    void run("read_aloud", async (signal) => {
      setAudio(null);
      const result = await adminApi.testSynthesis(settings.read_aloud, text.trim(), signal);
      if (!signal.aborted) setAudio(result);
    });
  }

  return (
    <>
      <AdminHeader actions={
        <button type="submit" form="speech-settings" className={`btn primary${busy === "save" ? " btn-progress" : ""}`}
          disabled={!valid || !dirty || busy !== null}>{busy === "save" ? t("savingEllipsis") : t("save")}</button>
      } />
      <ErrorNotice error={error?.operation === "load" || error?.operation === "save" ? error.message : ""} notice={notice} />
      {!settings ? (error ? null : <AdminSkeleton rows={4} />) : (
        <form id="speech-settings" className="ochi-admin-stack-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
          <Card className="ochi-admin-speech-card">
            <CardHead title={t("speech.dictation")} desc={t("speech.dictationHint")}
              right={<Switch label={t("speech.enableDictation")} on={settings.dictation.enabled}
                onChange={(enabled) => update("dictation", { enabled })} disabled={busy !== null} />} />
            <fieldset className="ochi-admin-fieldset" disabled={busy !== null}>
              <SpeechFields value={settings.dictation} providers={providers} onChange={(patch) => update("dictation", patch)} busy={busy !== null} />
              <div className="ochi-admin-speech-test">
                <Field title={t("speech.audioSample")}>
                  <input type="file" accept="audio/*,.mp4,.m4a,.webm,.ogg,.wav,.mp3" className="input"
                    onChange={(event) => {
                      setSample(event.target.files?.[0] ?? null);
                      setTranscript(null);
                      setError((current) => current?.operation === "dictation" ? null : current);
                    }} />
                </Field>
                <div>
                  <button type="button" className={`btn secondary${busy === "dictation" ? " btn-progress" : ""}`}
                    disabled={!dictationReady || !sample || busy !== null} onClick={testDictation}>
                    <Mic className="ic" />{busy === "dictation" ? t("testingEllipsis") : t("speech.testDictation")}
                  </button>
                </div>
                {transcript !== null && <div className="ochi-admin-speech-transcript" role="status"><Check className="ic" /><span>{transcript || t("noResponse")}</span></div>}
                <ErrorNotice error={error?.operation === "dictation" ? error.message : ""} />
              </div>
            </fieldset>
          </Card>
          <Card className="ochi-admin-speech-card">
            <CardHead title={t("speech.readAloud")} desc={t("speech.readAloudHint")}
              right={<Switch label={t("speech.enableReadAloud")} on={settings.read_aloud.enabled}
                onChange={(enabled) => update("read_aloud", { enabled })} disabled={busy !== null} />} />
            <fieldset className="ochi-admin-fieldset" disabled={busy !== null}>
              <SpeechFields value={settings.read_aloud} providers={providers} onChange={(patch) => update("read_aloud", patch)} busy={busy !== null} />
              <Field title={t("speech.voice")} hint={t("speech.voiceHint")}>
                <input className="input mono" value={settings.read_aloud.voice}
                  onChange={(event) => update("read_aloud", { voice: event.target.value })} />
              </Field>
              <div className="ochi-admin-speech-test">
                <Field title={t("speech.testText")}>
                  <textarea className="textarea" rows={2} maxLength={500} value={text} onChange={(event) => {
                    setText(event.target.value); setAudio(null);
                    setError((current) => current?.operation === "read_aloud" ? null : current);
                  }} />
                </Field>
                <div>
                  <button type="button" className={`btn secondary${busy === "read_aloud" ? " btn-progress" : ""}`}
                    disabled={!readAloudReady || !text.trim() || busy !== null} onClick={testReadAloud}>
                    <Volume2 className="ic" />{busy === "read_aloud" ? t("testingEllipsis") : t("speech.testReadAloud")}
                  </button>
                </div>
                {audioURL && <audio controls src={audioURL} aria-label={t("speech.preview")} />}
                <ErrorNotice error={error?.operation === "read_aloud" ? error.message : ""} />
              </div>
            </fieldset>
          </Card>
        </form>
      )}
    </>
  );
}
