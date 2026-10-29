import { t, useAdminI18n, getLocale } from "./i18n";
import { useEffect, useId, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Copy, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { adminApi } from "../../lib/api";
import type { ProviderRequestDetail, ProviderRequestPage, ProviderRequestSummary } from "../../lib/types";
import { Modal } from "../../components/Modal";
import { ErrorNotice } from "./Fields";

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
  return <dl className="request-facts">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function RequestPayload({ headers, body }: { headers?: Record<string, string[]>; body?: string }) {
  useAdminI18n();
  return <div className="request-payload">
    <h4>{t("httpHeaders")}</h4><pre>{headers && Object.keys(headers).length ? JSON.stringify(headers, null, 2) : t("none")}</pre>
    <h4>{t("httpBody")}</h4><pre>{body || t("noCapturedBody")}</pre>
  </div>;
}

function RequestDetail({ item }: { item: ProviderRequestDetail }) {
  useAdminI18n();
  const [tab, setTab] = useState("metadata");
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
    <div className="request-detail-toolbar">
      <div className="request-tabs" role="tablist" aria-label={t("requestDetails")}>
        {tabs.map(value => <button key={value.id} id={`${tabID}-${value.id}`} type="button" role="tab" aria-selected={tab === value.id} aria-controls={`${tabID}-content`} className={tab === value.id ? "selected" : ""} onClick={() => setTab(value.id)}>{value.title}</button>)}
      </div>
      <button type="button" className="secondary-button" onClick={() => void copy()}><Copy size={14} />{copied ? t("copied") : t("copyJSON")}</button>
    </div>
    <ErrorNotice error={copyError} />
    {item.truncated && <p className="request-capture-note" role="status">{t("captureTruncatedHint")}</p>}
    <div id={`${tabID}-content`} role="tabpanel" aria-labelledby={`${tabID}-${tab}`} className="request-detail-content">
      {tab === "metadata" ? <RequestFacts item={item} />
        : tab === "request" ? <RequestPayload headers={item.request_headers} body={item.request_body} />
        : tab === "response" ? <RequestPayload headers={item.response_headers} body={item.response_body} />
        : item.stream_chunks?.length ? <div className="request-stream" aria-label={t("rawSSEData")}>
          {item.stream_chunks.map(chunk => <div key={chunk.sequence}><span title={t("lineNumber", { number: chunk.sequence })}>#{chunk.sequence} · +{chunk.at_ms} ms</span><pre>{chunk.data}</pre></div>)}
        </div> : <div className="table-empty">{t("noCapturedStream")}</div>}
    </div>
  </>;
}

export function RequestDiagnostics({ runID }: { runID?: string }) {
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
  const listID = useId();

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
  return <div className="request-diagnostics">
    <div className="request-toolbar">
      <p>{t(runID ? "runRequestsRetention" : "requestsRetention", {
        days: page?.retention_days ?? 7, global: 2048, run: page?.max_requests_per_run ?? 256,
      })}</p>
      <div>
        <button type="button" className="icon-button" aria-label={t("refreshRequests")} disabled={loading || clearing} onClick={() => { setNotice(""); setRevision(value => value + 1); }}><RefreshCw size={16} className={loading ? "spin" : undefined} /></button>
        <button type="button" className="secondary-button" disabled={loading || clearing || !page?.total} onClick={() => setConfirmClear(true)}><Trash2 size={14} />{t("clearRecords")}</button>
      </div>
    </div>
    <ErrorNotice error={error} notice={notice} />
    <div className="request-list" aria-busy={loading}>
      {loading ? <div className="table-empty"><LoaderCircle className="spin" size={18} aria-label={t("loadingRequests")} /></div>
        : page?.items.length ? page.items.map(item => <article key={item.id}>
          <button type="button" className="request-summary" aria-expanded={selectedID === item.id} aria-controls={`${listID}-${item.id}`} onClick={() => setSelectedID(value => value === item.id ? null : item.id)}>
            <span className="request-summary-main"><strong>{item.model || item.model_id || "—"}</strong><small>{item.purpose} · {item.protocol} · {item.round ? `${t("roundNumber", { number: item.round })} · ` : ""}{t("requestAttempt", { number: item.attempt })}</small><small>{timestamp(item.started_at)}</small></span>
            <span className={`request-summary-status${item.error || (item.status_code ?? 0) >= 400 ? " danger" : ""}`}><span>{requestStatus(item)}</span><small>{item.finish_reason || item.response_status || item.error_class || (item.stream ? t("streaming") : t("nonStreaming"))}</small><span className="request-flags">{item.truncated && <small>{t("truncated")}</small>}{item.redacted && <small>{t("redacted")}</small>}</span></span>
            <span className="request-summary-timing"><span>{duration(item.duration_ms)}</span><small>TTFB {duration(item.ttfb_ms)}</small><small>TTFT {duration(item.ttft_ms)}</small></span>
            <ChevronDown size={16} className={selectedID === item.id ? "is-expanded" : undefined} />
          </button>
          {selectedID === item.id && <div id={`${listID}-${item.id}`} className="request-expanded">
            {detailLoading || (!detail && !detailError) ? <div className="table-empty"><LoaderCircle className="spin" size={18} aria-label={t("loadingRequestDetails")} /></div>
              : detailError ? <><ErrorNotice error={detailError} /><button type="button" className="secondary-button" onClick={() => setDetailRevision(value => value + 1)}>{t("retry")}</button></>
              : detail && detail.id === item.id ? <RequestDetail key={detail.id} item={detail} /> : null}
          </div>}
        </article>) : !error && <div className="request-empty"><strong>{t("noRequests")}</strong><span>{t("enableDebugHint")}</span></div>}
    </div>
    {page && <div className="table-pagination">
      <span>{t("recordsRange", { total: page.total, start: page.total ? offset + 1 : 0, end: Math.min(offset + limit, page.total) })}</span>
      <div><button type="button" className="icon-button" aria-label={t("previousRequestsPage")} disabled={loading || clearing || offset === 0} onClick={() => setOffset(value => Math.max(0, value - limit))}><ChevronLeft size={16} /></button><span>{Math.floor(offset / limit) + 1} / {Math.max(1, Math.ceil(page.total / limit))}</span><button type="button" className="icon-button" aria-label={t("nextRequestsPage")} disabled={loading || clearing || offset + limit >= page.total} onClick={() => setOffset(value => value + limit)}><ChevronRight size={16} /></button></div>
    </div>}
    {confirmClear && <Modal className="ochi-admin-modal" title={runID ? t("clearRunRequestsQuestion") : t("clearAllRequestsQuestion")} size="small" onClose={() => { if (!clearing) setConfirmClear(false); }} footer={<div className="modal-actions"><button type="button" className="secondary-button" disabled={clearing} onClick={() => setConfirmClear(false)}>{t("cancel")}</button><button type="button" className="danger-button" disabled={clearing} onClick={() => void clear()}>{clearing && <LoaderCircle className="spin" size={14} />}{t("clear")}</button></div>}>
      <p>{t("clearRequestsHint")}</p>
    </Modal>}
  </div>;
}

export function DebugPage() {
  useAdminI18n();
  return <><div className="admin-page-heading"><h2>{t("requestDiagnostics")}</h2></div><RequestDiagnostics /></>;
}
