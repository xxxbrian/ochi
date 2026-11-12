import { t, useAdminI18n, getLocale } from "./i18n";
import { useEffect, useId, useState } from "react";
import { Activity, ChevronLeft, ChevronRight, Copy, Eraser, RefreshCw } from "lucide-react";
import { adminApi } from "../../lib/api";
import type { ProviderRequestDetail, ProviderRequestPage, ProviderRequestSummary } from "../../lib/types";
import { Modal } from "../../components/Modal";
import { ErrorNotice } from "./Fields";
import { AdminHeader, Card, Drawer, Empty, Meter, onActivate, Pill, Seg, SkeletonRows, Stat } from "./ui";
import { CopyButton } from "./CopyButton";

function duration(value?: number) {
  if (value == null) return "—";
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} s`;
}

function timestamp(value?: string) {
  return value ? new Date(value).toLocaleString(getLocale(), { hour12: false }) : "—";
}

function requestStatus(item: ProviderRequestSummary) {
  return item.status_code ? `HTTP ${item.status_code}` : item.error_class || t("noResponse");
}

function RequestFacts({ item }: { item: ProviderRequestDetail }) {
  useAdminI18n();
  const fields: [string, string][] = [
    [t("requestID"), item.id], [t("upstreamRequestID"), item.request_id || "—"],
    [t("purposeRoundAttempt"), `${item.purpose} / ${item.round || "—"} / ${item.attempt}`],
    [t("model"), item.model], [t("protocol"), item.protocol], [t("request"), `${item.method} ${item.url}`],
    [t("response"), requestStatus(item)], [t("streaming"), item.stream ? t("yes") : t("no")],
    [t("start"), timestamp(item.started_at)], [t("firstByte"), timestamp(item.first_byte_at)],
    [t("firstToken"), timestamp(item.first_token_at)], [t("lastData"), timestamp(item.last_data_at)],
    [t("end"), timestamp(item.finished_at)], [t("totalDuration"), duration(item.duration_ms)],
    ["TTFB", duration(item.ttfb_ms)], ["TTFT", duration(item.ttft_ms)],
    [t("finishReason"), item.finish_reason || "—"], [t("responseStatus"), item.response_status || "—"],
    [t("endMarker"), `DONE: ${item.saw_done ? t("yes") : t("no")} · Completed: ${item.saw_completed ? t("yes") : t("no")} · EOF: ${item.saw_eof ? t("yes") : t("no")}`],
    [t("requestResponseBytes"), `${item.request_bytes.toLocaleString(getLocale())} / ${item.response_bytes.toLocaleString(getLocale())}`],
    [t("capturedResponseBytes"), item.captured_bytes.toLocaleString(getLocale())],
    [t("truncation"), t("truncationSummary", { request: item.request_truncated ? t("yes") : t("no"), response: item.response_truncated ? t("yes") : t("no") })],
    [t("redaction"), item.redacted ? t("yes") : t("no")],
    [t("inputOutputTokens"), item.usage ? `${item.usage.prompt_tokens?.toLocaleString(getLocale()) ?? "—"} / ${item.usage.completion_tokens?.toLocaleString(getLocale()) ?? "—"}` : "—"],
    [t("totalTokens"), item.usage?.total_tokens?.toLocaleString(getLocale()) ?? "—"],
    [t("cachedTokens"), item.usage?.cached_tokens?.toLocaleString(getLocale()) ?? "—"],
    [t("reasoningTokens"), item.usage?.reasoning_tokens?.toLocaleString(getLocale()) ?? "—"],
    [t("runID"), item.run_id || "—"], [t("sessionID"), item.session_id || "—"],
    [t("providerID"), item.provider_id || "—"], [t("modelID"), item.model_id || "—"],
    [t("errorClass"), item.error_class || "—"], [t("error"), item.error || "—"],
    [t("readError"), item.read_error || "—"], [t("upstreamErrorCode"), item.upstream_error_code || "—"],
    [t("upstreamErrorType"), item.upstream_error_type || "—"], [t("upstreamError"), item.upstream_error || "—"],
  ];
  return <dl className="ochi-admin-facts">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function RequestPayload({ headers, body }: { headers?: Record<string, string[]>; body?: string }) {
  useAdminI18n();
  return <div className="ochi-admin-payload">
    <h4 className="ochi-admin-dh4">{t("httpHeaders")}</h4><pre className="ochi-admin-code">{headers && Object.keys(headers).length ? JSON.stringify(headers, null, 2) : t("none")}</pre>
    <h4 className="ochi-admin-dh4">{t("httpBody")}</h4><pre className="ochi-admin-code">{body || t("noCapturedBody")}</pre>
  </div>;
}

function RequestDetail({ item }: { item: ProviderRequestDetail }) {
  useAdminI18n();
  const [tab, setTab] = useState<string>("metadata");
  const [copyError, setCopyError] = useState("");
  const [copied, setCopied] = useState(false);
  const tabID = useId();
  const tabs = [
    { id: "metadata", title: t("metadata") }, { id: "request", title: t("request") },
    { id: "response", title: t("response") }, { id: "stream", title: t("rawSSECount", { count: item.stream_chunks?.length ?? 0 }) },
  ];
  async function copy() {
    setCopyError("");
    try {
      await navigator.clipboard.writeText(JSON.stringify(item, null, 2));
      setCopied(true);
    } catch {
      setCopyError(t("copyFailed"));
    }
  }
  return <>
    <Seg small label={t("requestDetails")} value={tab} onChange={setTab} options={tabs.map((value) => ({ v: value.id, l: value.title }))} />
    <ErrorNotice error={copyError} />
    {item.truncated && <div className="ochi-admin-alert" role="status"><div>{t("captureTruncatedHint")}</div></div>}
    <div id={`${tabID}-content`} role="tabpanel" className="ochi-admin-detail-content">
      {tab === "metadata" ? <RequestFacts item={item} />
        : tab === "request" ? <RequestPayload headers={item.request_headers} body={item.request_body} />
        : tab === "response" ? <RequestPayload headers={item.response_headers} body={item.response_body} />
        : item.stream_chunks?.length ? <div className="ochi-admin-stream" aria-label={t("rawSSEData")}>
          {item.stream_chunks.map(chunk => <div key={chunk.sequence}><span className="muted mono" title={t("lineNumber", { number: chunk.sequence })}>#{chunk.sequence} · +{chunk.at_ms} ms</span><pre className="ochi-admin-code">{chunk.data}</pre></div>)}
        </div> : <Empty icon={<Activity className="ic" />} title={t("noCapturedStream")} />}
    </div>
    <footer className="ochi-admin-df ochi-admin-df-inline"><span className="muted mono">{item.id}</span><span className="grow" />
      <button type="button" className="btn sm secondary" onClick={() => void copy()}><Copy className="ic" />{copied ? t("copied") : t("copyJSON")}</button></footer>
  </>;
}

export function RequestDiagnostics({ runID, embedded }: { runID?: string; embedded?: boolean }) {
  useAdminI18n();
  const [page, setPage] = useState<ProviderRequestPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProviderRequestDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailRevision, setDetailRevision] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setSelectedID(null); setPage(null);
    adminApi.providerRequests(runID, offset, controller.signal)
      .then(value => {
        if (controller.signal.aborted) return;
        if (offset > 0 && offset >= value.total) {
          setOffset(Math.max(0, Math.floor((value.total - 1) / value.limit) * value.limit));
          return;
        }
        setPage(value);
      })
      .catch((reason: Error) => { if (!controller.signal.aborted) setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [runID, offset, revision]);

  useEffect(() => {
    setDetail(null); setDetailError("");
    if (!selectedID) { setDetailLoading(false); return; }
    const controller = new AbortController();
    setDetailLoading(true);
    adminApi.providerRequest(runID, selectedID, controller.signal)
      .then(value => { if (!controller.signal.aborted) setDetail(value); })
      .catch((reason: Error) => { if (!controller.signal.aborted) setDetailError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [runID, selectedID, detailRevision]);

  async function clear() {
    setClearing(true); setError(""); setNotice("");
    try {
      await adminApi.clearProviderRequests(runID);
      setConfirmClear(false); setSelectedID(null); setOffset(0);
      setRevision(value => value + 1);
      setNotice(t("requestsCleared"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("clearFailed"));
      setConfirmClear(false);
    } finally {
      setClearing(false);
    }
  }
  const limit = page?.limit ?? 30;
  const rows = page?.items ?? [];
  const failures = rows.filter((item) => item.error || (item.status_code ?? 0) >= 400).length;
  const timed = rows.filter((item) => item.duration_ms != null);
  const average = timed.length ? Math.round(timed.reduce((sum, item) => sum + (item.duration_ms ?? 0), 0) / timed.length) : null;
  const slowest = Math.max(1000, ...timed.map((item) => item.duration_ms ?? 0));
  const selected = rows.find((item) => item.id === selectedID);
  const actions = <>
    <button type="button" className="btn secondary" aria-label={t("refreshRequests")} disabled={loading || clearing} onClick={() => { setNotice(""); setRevision(value => value + 1); }}><RefreshCw className={`ic${loading ? " ic-turn" : ""}`} />{t("refresh")}</button>
    <button type="button" className="btn secondary" disabled={loading || clearing || !page?.total} onClick={() => setConfirmClear(true)}><Eraser className="ic" />{t("clearRecords")}</button>
  </>;
  return <>
    {embedded ? <div className="ochi-admin-toolbar ochi-admin-embedded-actions"><p className="muted">{t("runRequestsRetention", { days: page?.retention_days ?? 7, global: 2048, run: page?.max_requests_per_run ?? 256 })}</p><span className="grow" />{actions}</div> : <AdminHeader actions={actions} />}
    <ErrorNotice error={error} notice={notice} />
    {!embedded && <div className="ochi-admin-stats">
      <Stat label={t("records")} value={(page?.total ?? 0).toLocaleString(getLocale())} sub={t(runID ? "runRequestsRetentionShort" : "requestsRetentionShort", { days: page?.retention_days ?? 7 })} />
      <Stat label={t("errorsOnPage")} value={failures} sub={t("onThisPage", { count: rows.length })} tone={failures ? "warn" : "success"} />
      <Stat label={t("averageDuration")} value={average == null ? "—" : duration(average)} sub={t("onThisPage", { count: timed.length })} />
    </div>}
    <Card flush aria-busy={loading}>
      {loading && !page ? <SkeletonRows rows={6} />
        : rows.length ? <>
          <div className="ochi-admin-tscroll ochi-admin-tall"><table className="ochi-admin-table ochi-admin-reqs">
            <thead><tr><th>{t("start")}</th><th>{t("model")}</th><th>{t("status")}</th><th>{t("duration")}</th><th className="ochi-admin-hide-s">{t("protocol")}</th></tr></thead>
            <tbody>{rows.map((item, index) => {
              const bad = Boolean(item.error) || (item.status_code ?? 0) >= 400;
              const ms = item.duration_ms ?? 0;
              return (
                <tr key={item.id} tabIndex={0} aria-label={`${item.model || item.model_id || item.id} ${requestStatus(item)}`} style={{ "--i": Math.min(index, 12) } as React.CSSProperties}
                  onClick={() => setSelectedID(item.id)} onKeyDown={onActivate(() => setSelectedID(item.id))}>
                  <td className="mono muted">{timestamp(item.started_at)}</td>
                  <td><b>{item.model || item.model_id || "—"}</b><br /><small>{item.purpose} · {item.round ? `${t("roundNumber", { number: item.round })} · ` : ""}{t("requestAttempt", { number: item.attempt })}</small></td>
                  <td><span className="ochi-admin-code-s" data-tone={bad ? "danger" : item.status_code ? "success" : "warn"}>{requestStatus(item)}</span>
                    {(item.truncated || item.redacted) && <span className="ochi-admin-flags">{item.truncated && <Pill tone="warn">{t("truncated")}</Pill>}{item.redacted && <Pill>{t("redacted")}</Pill>}</span>}</td>
                  <td className="ochi-admin-lat"><Meter pct={(ms / slowest) * 100} tone={ms > 2000 ? "danger" : ms > 1000 ? "warn" : ""} /><small className="tnum">{duration(item.duration_ms)}</small></td>
                  <td className="muted ochi-admin-hide-s">{item.protocol}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
          <footer className="ochi-admin-pager">
            <span className="muted tnum">{t("recordsRange", { total: page?.total ?? 0, start: page?.total ? offset + 1 : 0, end: Math.min(offset + limit, page?.total ?? 0) })}</span><span className="grow" />
            <button type="button" className="icon-btn sm" aria-label={t("previousRequestsPage")} disabled={loading || clearing || offset === 0} onClick={() => setOffset(value => Math.max(0, value - limit))}><ChevronLeft className="ic" /></button>
            <span className="tnum muted">{Math.floor(offset / limit) + 1} / {Math.max(1, Math.ceil((page?.total ?? 0) / limit))}</span>
            <button type="button" className="icon-btn sm" aria-label={t("nextRequestsPage")} disabled={loading || clearing || offset + limit >= (page?.total ?? 0)} onClick={() => setOffset(value => value + limit)}><ChevronRight className="ic" /></button>
          </footer>
        </>
        : !error && <Empty icon={<Activity className="ic" />} title={t("noRequests")} desc={t("enableDebugHint")} />}
    </Card>
    {selected && <Drawer wide title={selected.model || selected.model_id || selected.id} sub={`${timestamp(selected.started_at)} · ${requestStatus(selected)} · ${duration(selected.duration_ms)}`} onClose={() => setSelectedID(null)}>
      {detailLoading || (!detail && !detailError) ? <SkeletonRows rows={4} />
        : detailError ? <><ErrorNotice error={detailError} /><button type="button" className="btn secondary" onClick={() => setDetailRevision(value => value + 1)}>{t("retry")}</button></>
        : detail && detail.id === selected.id ? <RequestDetail key={detail.id} item={detail} /> : null}
    </Drawer>}
    {confirmClear && <Modal title={runID ? t("clearRunRequestsQuestion") : t("clearAllRequestsQuestion")} size="small" dismissible={!clearing} onClose={() => setConfirmClear(false)} footer={<div className="modal-actions"><button type="button" className="btn ghost" disabled={clearing} onClick={() => setConfirmClear(false)}>{t("cancel")}</button><button type="button" className={`btn danger${clearing ? " btn-progress" : ""}`} disabled={clearing} onClick={() => void clear()}>{clearing ? t("clearingEllipsis") : t("clear")}</button></div>}>
      <p>{t("clearRequestsHint")}</p>
    </Modal>}
  </>;
}

export function DebugPage() {
  useAdminI18n();
  return <RequestDiagnostics />;
}
