import { useEffect, useRef, useState } from "react";
import { Check, Download, Trash2, Upload, X } from "lucide-react";
import { adminApi } from "../../lib/api";
import { androidReleaseURL, releaseSize } from "../../lib/clientReleases";
import type { ClientReleases } from "../../lib/types";
import { Modal } from "../../components/Modal";
import { PlatformLogo } from "../../components/PlatformLogo";
import { ErrorNotice, Field } from "./Fields";
import { Card, CardHead } from "./ui";
import { formatDate, formatNumber, t, useAdminI18n } from "./i18n";
import "./client-releases.css";

type Action = "upload" | "remove" | "ios";

export function ClientReleasesCard() {
  useAdminI18n();
  const [releases, setReleases] = useState<ClientReleases | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<"saved" | "cancelled" | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [iosURL, setIOSURL] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [progress, setProgress] = useState(0);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [retry, setRetry] = useState(0);
  const mounted = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    setLoadError(null);
    adminApi.clientReleases(controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setReleases(value);
      setIOSURL(value.ios?.url ?? "");
      setNotes(value.android?.release_notes ?? "");
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setLoadError(reason instanceof Error ? reason : new Error(t("loadFailed")));
    });
    return () => { mounted.current = false; controller.abort(); operation.current?.abort(); };
  }, [retry]);

  async function perform(next: Action) {
    if (operation.current || !releases || (next === "upload" && !file)) return;
    const controller = new AbortController();
    operation.current = controller;
    setAction(next);
    setError(null);
    setNotice(null);
    setProgress(0);
    try {
      const value = next === "upload"
        ? await adminApi.uploadAndroidRelease(file!, notes, (value) => { if (!controller.signal.aborted) setProgress(value); }, controller.signal)
        : next === "remove" ? await adminApi.removeAndroidRelease(controller.signal)
        : await adminApi.saveIOSRelease(iosURL.trim(), controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setReleases(value);
      setNotice("saved");
      if (next === "ios") setIOSURL(value.ios?.url ?? "");
      else {
        setFile(null);
        setNotes(value.android?.release_notes ?? "");
        if (input.current) input.current.value = "";
      }
      if (next === "remove") setConfirmRemove(false);
    } catch (reason) {
      if (!mounted.current) return;
      if (controller.signal.aborted) {
        // Cancellation can race the server's atomic publication; read back the authoritative current release.
        try {
          const value = await adminApi.clientReleases();
          if (mounted.current) { setReleases(value); setNotice("cancelled"); }
        } catch (refreshReason) {
          if (mounted.current) setError(refreshReason instanceof Error ? refreshReason : new Error(t("loadFailed")));
        }
      } else setError(reason instanceof Error ? reason : new Error(t("operationFailed")));
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        if (mounted.current) setAction(null);
      }
    }
  }

  const busy = action !== null;
  const android = releases?.android;
  const downloadURL = android ? androidReleaseURL(android) : undefined;
  const uploadLabel = action === "upload"
    ? progress >= 100 ? t("clientReleases.processing") : t("clientReleases.uploading", { percent: formatNumber(Math.floor(progress)) })
    : t(android ? "clientReleases.replace" : "clientReleases.publish");
  return (
    <Card className="client-releases-card">
      <CardHead title={t("clientReleases.title")} desc={t("clientReleases.description")} />
      {loadError ? <div className="client-releases-feedback">
        <ErrorNotice error={loadError.message} />
        <button type="button" className="btn secondary" onClick={() => setRetry((value) => value + 1)}>{t("retry")}</button>
      </div> : !releases ? <div className="client-releases-loading" role="status"><span>{t("loading")}</span><i className="skel" /></div> : <>
        {!confirmRemove ? <ErrorNotice error={error?.message ?? ""} notice={notice === "saved" ? t("clientReleases.saved") : notice === "cancelled" ? t("clientReleases.cancelled") : ""} /> : null}
        <section className="client-release-platform">
          <h4><PlatformLogo platform="android" className="ic" />Android</h4>
          {android ? <div className="client-release-current">
            <b>{android.version_name} <span className="muted">({android.version_code})</span></b>
            <span>{releaseSize(android.size_bytes)} · {formatDate(android.published_at, { dateStyle: "medium", timeStyle: "short" })}</span>
            <code title="SHA-256">SHA-256 {android.sha256}</code>
            <div className="client-release-actions">
              {downloadURL ? <a href={downloadURL} download={`Ochi-${android.version_name}.apk`} className="btn secondary sm"><Download className="ic" />{t("clientReleases.downloadCurrent")}</a> : null}
              <button type="button" className="btn danger-ghost sm" disabled={busy} onClick={() => { setError(null); setConfirmRemove(true); }}><Trash2 className="ic" />{t("clientReleases.remove")}</button>
            </div>
          </div> : <p className="field-help">{t("clientReleases.noAndroid")}</p>}
          <form className="client-release-form" onSubmit={(event) => { event.preventDefault(); void perform("upload"); }}>
            <Field title={t("clientReleases.apk")} hint={t("clientReleases.apkHint")}>
              <input ref={input} className="input client-release-file" type="file" aria-label={t("clientReleases.apk")} accept=".apk,application/vnd.android.package-archive" disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(null); setNotice(null); }} />
            </Field>
            <Field title={t("clientReleases.notes")} hint={t("clientReleases.notesHint")}>
              <textarea className="input" aria-label={t("clientReleases.notes")} rows={3} maxLength={10000} value={notes} disabled={busy} onChange={(event) => { setNotes(event.target.value); setError(null); setNotice(null); }} />
            </Field>
            {action === "upload" ? <div className="client-release-progress" role="progressbar" aria-label={t("clientReleases.uploadProgress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(progress)}>
              <div><i style={{ width: `${progress}%` }} /></div><span>{uploadLabel}</span>
            </div> : null}
            <div className="client-release-actions">
              <button type="submit" className={`btn primary${action === "upload" ? " btn-progress" : ""}`} disabled={busy || !file}><Upload className="ic" />{uploadLabel}</button>
              {action === "upload" ? <button type="button" className="btn secondary" onClick={() => operation.current?.abort()}><X className="ic" />{t("cancel")}</button> : null}
            </div>
          </form>
        </section>
        <section className="client-release-platform">
          <h4><PlatformLogo platform="ios" className="ic" />iOS</h4>
          <form className="client-release-form" onSubmit={(event) => { event.preventDefault(); void perform("ios"); }}>
            <Field title={t("clientReleases.iosURL")} hint={t("clientReleases.iosHint")}>
              <input className="input" type="url" aria-label={t("clientReleases.iosURL")} value={iosURL} placeholder="https://testflight.apple.com/join/…" disabled={busy} onChange={(event) => { setIOSURL(event.target.value); setError(null); setNotice(null); }} />
            </Field>
            <div className="client-release-actions"><button type="submit" className={`btn secondary${action === "ios" ? " btn-progress" : ""}`} disabled={busy || iosURL.trim() === (releases.ios?.url ?? "")}><Check className="ic" />{action === "ios" ? t("savingEllipsis") : t("save")}</button></div>
          </form>
        </section>
      </>}
      {confirmRemove ? <Modal title={t("clientReleases.removeQuestion")} size="small" dismissible={!busy} onClose={() => setConfirmRemove(false)} footer={<>
        <button type="button" className="btn secondary" disabled={busy} onClick={() => setConfirmRemove(false)}>{t("cancel")}</button>
        <button type="button" className={`btn danger${action === "remove" ? " btn-progress" : ""}`} disabled={busy} onClick={() => void perform("remove")}>{action === "remove" ? t("deletingEllipsis") : t("clientReleases.remove")}</button>
      </>}><p>{t("clientReleases.removeDescription")}</p><ErrorNotice error={error?.message ?? ""} /></Modal> : null}
    </Card>
  );
}
