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
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
}

function requestStatus(item: ProviderRequestSummary) {
  return item.status_code ? `HTTP ${item.status_code}` : item.error_class || "未收到响应";
}

function RequestFacts({ item }: { item: ProviderRequestDetail }) {
  const fields: [string, string][] = [
    ["请求 ID", item.id], ["上游请求 ID", item.request_id || "—"],
    ["用途 / 轮次 / 尝试", `${item.purpose} / ${item.round || "—"} / ${item.attempt}`],
    ["模型", item.model], ["协议", item.protocol], ["请求", `${item.method} ${item.url}`],
    ["响应", requestStatus(item)], ["流式", item.stream ? "是" : "否"],
    ["开始", timestamp(item.started_at)], ["首字节", timestamp(item.first_byte_at)],
    ["首 Token", timestamp(item.first_token_at)], ["最后数据", timestamp(item.last_data_at)],
    ["结束", timestamp(item.finished_at)], ["总耗时", duration(item.duration_ms)],
    ["TTFB", duration(item.ttfb_ms)], ["TTFT", duration(item.ttft_ms)],
    ["Finish reason", item.finish_reason || "—"], ["响应状态", item.response_status || "—"],
    ["结束标记", `DONE: ${item.saw_done ? "是" : "否"} · Completed: ${item.saw_completed ? "是" : "否"} · EOF: ${item.saw_eof ? "是" : "否"}`],
    ["请求 / 响应字节", `${item.request_bytes.toLocaleString()} / ${item.response_bytes.toLocaleString()}`],
    ["捕获响应字节", item.captured_bytes.toLocaleString()],
    ["截断", `请求: ${item.request_truncated ? "是" : "否"} · 响应: ${item.response_truncated ? "是" : "否"}`],
    ["脱敏", item.redacted ? "是" : "否"],
    ["输入 / 输出 Tokens", item.usage ? `${item.usage.prompt_tokens?.toLocaleString() ?? "—"} / ${item.usage.completion_tokens?.toLocaleString() ?? "—"}` : "—"],
    ["总 Tokens", item.usage?.total_tokens?.toLocaleString() ?? "—"],
    ["缓存 Tokens", item.usage?.cached_tokens?.toLocaleString() ?? "—"],
    ["推理 Tokens", item.usage?.reasoning_tokens?.toLocaleString() ?? "—"],
    ["运行 ID", item.run_id || "—"], ["对话 ID", item.session_id || "—"],
    ["服务 ID", item.provider_id || "—"], ["模型 ID", item.model_id || "—"],
    ["错误分类", item.error_class || "—"], ["错误", item.error || "—"],
    ["读取错误", item.read_error || "—"], ["上游错误码", item.upstream_error_code || "—"],
    ["上游错误类型", item.upstream_error_type || "—"], ["上游错误", item.upstream_error || "—"],
  ];
  return <dl className="request-facts">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function RequestPayload({ headers, body }: { headers?: Record<string, string[]>; body?: string }) {
  return <div className="request-payload">
    <h4>Headers</h4><pre>{headers && Object.keys(headers).length ? JSON.stringify(headers, null, 2) : "无"}</pre>
    <h4>Body</h4><pre>{body || "无捕获正文"}</pre>
  </div>;
}

function RequestDetail({ item }: { item: ProviderRequestDetail }) {
  const [tab, setTab] = useState("metadata");
  const [copyError, setCopyError] = useState("");
  const [copied, setCopied] = useState(false);
  const tabID = useId();
  const tabs = [
    { id: "metadata", title: "元数据" }, { id: "request", title: "请求" },
    { id: "response", title: "响应" }, { id: "stream", title: `原始 SSE (${item.stream_chunks?.length ?? 0})` },
  ];
  async function copy() {
    setCopyError("");
    try {
      await navigator.clipboard.writeText(JSON.stringify(item, null, 2));
      setCopied(true);
    } catch {
      setCopyError("复制失败，请检查浏览器剪贴板权限");
    }
  }
  return <>
    <div className="request-detail-toolbar">
      <div className="request-tabs" role="tablist" aria-label="请求详情">
        {tabs.map(value => <button key={value.id} id={`${tabID}-${value.id}`} type="button" role="tab" aria-selected={tab === value.id} aria-controls={`${tabID}-content`} className={tab === value.id ? "selected" : ""} onClick={() => setTab(value.id)}>{value.title}</button>)}
      </div>
      <button type="button" className="secondary-button" onClick={() => void copy()}><Copy size={14} />{copied ? "已复制" : "复制 JSON"}</button>
    </div>
    <ErrorNotice error={copyError} />
    {item.truncated && <p className="request-capture-note" role="status">此记录已达到捕获上限，原文可能不完整。</p>}
    <div id={`${tabID}-content`} role="tabpanel" aria-labelledby={`${tabID}-${tab}`} className="request-detail-content">
      {tab === "metadata" ? <RequestFacts item={item} />
        : tab === "request" ? <RequestPayload headers={item.request_headers} body={item.request_body} />
        : tab === "response" ? <RequestPayload headers={item.response_headers} body={item.response_body} />
        : item.stream_chunks?.length ? <div className="request-stream" aria-label="原始 SSE 数据">
          {item.stream_chunks.map(chunk => <div key={chunk.sequence}><span title={`第 ${chunk.sequence} 行`}>#{chunk.sequence} · +{chunk.at_ms} ms</span><pre>{chunk.data}</pre></div>)}
        </div> : <div className="table-empty">无捕获流数据</div>}
    </div>
  </>;
}

export function RequestDiagnostics({ runID }: { runID?: string }) {
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
      setNotice("请求记录已清除");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "清除失败");
      setConfirmClear(false);
    } finally {
      setClearing(false);
    }
  }
  const limit = page?.limit ?? 30;
  return <div className="request-diagnostics">
    <div className="request-toolbar">
      <p>保留 {page?.retention_days ?? 7} 天 · {runID ? "本次运行" : "全局最多 2,048 条"} · 每次运行最多 {page?.max_requests_per_run ?? 256} 条</p>
      <div>
        <button type="button" className="icon-button" aria-label="刷新请求记录" disabled={loading || clearing} onClick={() => { setNotice(""); setRevision(value => value + 1); }}><RefreshCw size={16} className={loading ? "spin" : undefined} /></button>
        <button type="button" className="secondary-button" disabled={loading || clearing || !page?.total} onClick={() => setConfirmClear(true)}><Trash2 size={14} />清除记录</button>
      </div>
    </div>
    <ErrorNotice error={error} notice={notice} />
    <div className="request-list" aria-busy={loading}>
      {loading ? <div className="table-empty"><LoaderCircle className="spin" size={18} aria-label="加载请求记录" /></div>
        : page?.items.length ? page.items.map(item => <article key={item.id}>
          <button type="button" className="request-summary" aria-expanded={selectedID === item.id} aria-controls={`${listID}-${item.id}`} onClick={() => setSelectedID(value => value === item.id ? null : item.id)}>
            <span className="request-summary-main"><strong>{item.model || item.model_id || "—"}</strong><small>{item.purpose} · {item.protocol} · {item.round ? `轮次 ${item.round} · ` : ""}第 {item.attempt} 次</small><small>{timestamp(item.started_at)}</small></span>
            <span className={`request-summary-status${item.error || (item.status_code ?? 0) >= 400 ? " danger" : ""}`}><span>{requestStatus(item)}</span><small>{item.finish_reason || item.response_status || item.error_class || (item.stream ? "流式" : "非流式")}</small><span className="request-flags">{item.truncated && <small>已截断</small>}{item.redacted && <small>已脱敏</small>}</span></span>
            <span className="request-summary-timing"><span>{duration(item.duration_ms)}</span><small>TTFB {duration(item.ttfb_ms)}</small><small>TTFT {duration(item.ttft_ms)}</small></span>
            <ChevronDown size={16} className={selectedID === item.id ? "is-expanded" : undefined} />
          </button>
          {selectedID === item.id && <div id={`${listID}-${item.id}`} className="request-expanded">
            {detailLoading || (!detail && !detailError) ? <div className="table-empty"><LoaderCircle className="spin" size={18} aria-label="加载请求详情" /></div>
              : detailError ? <><ErrorNotice error={detailError} /><button type="button" className="secondary-button" onClick={() => setDetailRevision(value => value + 1)}>重试</button></>
              : detail && detail.id === item.id ? <RequestDetail key={detail.id} item={detail} /> : null}
          </div>}
        </article>) : !error && <div className="request-empty"><strong>暂无请求记录</strong><span>在系统设置中开启 Debug 模式后，新的模型请求会记录在这里。</span></div>}
    </div>
    {page && <div className="table-pagination">
      <span>{page.total.toLocaleString()} 条 · {page.total ? offset + 1 : 0}–{Math.min(offset + limit, page.total)}</span>
      <div><button type="button" className="icon-button" aria-label="上一页请求记录" disabled={loading || clearing || offset === 0} onClick={() => setOffset(value => Math.max(0, value - limit))}><ChevronLeft size={16} /></button><span>{Math.floor(offset / limit) + 1} / {Math.max(1, Math.ceil(page.total / limit))}</span><button type="button" className="icon-button" aria-label="下一页请求记录" disabled={loading || clearing || offset + limit >= page.total} onClick={() => setOffset(value => value + limit)}><ChevronRight size={16} /></button></div>
    </div>}
    {confirmClear && <Modal className="ochi-admin-modal" title={runID ? "清除本次运行的请求记录？" : "清除所有请求记录？"} size="small" onClose={() => { if (!clearing) setConfirmClear(false); }} footer={<div className="modal-actions"><button type="button" className="secondary-button" disabled={clearing} onClick={() => setConfirmClear(false)}>取消</button><button type="button" className="danger-button" disabled={clearing} onClick={() => void clear()}>{clearing && <LoaderCircle className="spin" size={14} />}清除</button></div>}>
      <p>只删除诊断日志，不影响对话、运行记录或 Debug 模式。此操作无法撤销。</p>
    </Modal>}
  </div>;
}

export function DebugPage() {
  return <><div className="admin-page-heading"><h2>请求诊断</h2></div><RequestDiagnostics /></>;
}
