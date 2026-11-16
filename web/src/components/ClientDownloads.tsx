import { useEffect, useState } from "react";
import { Download, ExternalLink } from "lucide-react";
import { api } from "../lib/api";
import { androidReleaseURL, iosReleaseURL, releaseSize } from "../lib/clientReleases";
import { t, useI18n } from "../lib/i18n";
import type { ClientReleases } from "../lib/types";
import { Modal } from "./Modal";
import { PlatformLogo } from "./PlatformLogo";
import "./client-downloads.css";

export function ClientDownloads({ onClose }: { onClose: () => void }) {
  useI18n();
  const [releases, setReleases] = useState<ClientReleases | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setReleases(null);
    api.clientReleases(controller.signal).then((value) => {
      if (!controller.signal.aborted) setReleases(value);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason : new Error(t("error.load")));
    });
    return () => controller.abort();
  }, [retry]);
  const android = releases?.android;
  const androidURL = android ? androidReleaseURL(android) : undefined;
  const iosURL = releases?.ios ? iosReleaseURL(releases.ios.url) : undefined;
  return (
    <Modal title={t("clientDownloads.title")} onClose={onClose} className="client-downloads-modal">
      <p className="client-downloads-intro">{t("clientDownloads.description")}</p>
      {error ? <div className="client-downloads-error" role="alert">
        <p>{error.message}</p>
        <button type="button" className="btn secondary" onClick={() => setRetry((value) => value + 1)}>{t("common.retry")}</button>
      </div> : !releases ? <div className="client-downloads-loading" role="status">
        <span>{t("status.loading")}</span><i className="skel" /><i className="skel" />
      </div> : <div className="client-downloads-grid">
        <section className="client-download-platform">
          <PlatformLogo platform="android" className="client-download-icon" />
          <h3>Android</h3>
          {android && androidURL ? <>
            <p className="client-download-version">{android.version_name} <span>({android.version_code}) · {releaseSize(android.size_bytes)}</span></p>
            <a className="btn primary" href={androidURL} download={`Ochi-${android.version_name}.apk`}><Download className="ic" />{t("clientDownloads.android")}</a>
            {android.release_notes ? <p className="client-download-notes">{android.release_notes}</p> : null}
          </> : <p className="client-download-unavailable">{t("clientDownloads.androidUnavailable")}</p>}
        </section>
        <section className="client-download-platform">
          <PlatformLogo platform="ios" className="client-download-icon" />
          <h3>iOS</h3>
          {iosURL ? <>
            <p className="client-download-version">{t("clientDownloads.iosDescription")}</p>
            <a className="btn primary" href={iosURL} target="_blank" rel="noopener noreferrer"><ExternalLink className="ic" />{t("clientDownloads.ios")}</a>
          </> : <p className="client-download-unavailable">{t("clientDownloads.iosUnavailable")}</p>}
        </section>
      </div>}
    </Modal>
  );
}
