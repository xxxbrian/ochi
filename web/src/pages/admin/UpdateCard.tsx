import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Download, LoaderCircle, RefreshCw, RotateCcw } from "lucide-react";
import { Modal } from "../../components/Modal";
import { adminApi } from "../../lib/api";
import type { ApiError, UpdateBuild, UpdateState } from "../../lib/types";

const RESTART_STORAGE_KEY = "ochi-admin-update-restart";
const RESTART_WAIT_MS = 15 * 60 * 1000;
type RestartIntent = { revision: string; startedAt: number };
type UpdateAction = "check" | "apply" | "rollback" | "restart";

function storedRestart(): RestartIntent | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(RESTART_STORAGE_KEY) ?? "null") as RestartIntent | null;
    if (value && typeof value.revision === "string" && value.revision.length > 0 &&
      value.revision.length <= 128 && Number.isFinite(value.startedAt) && value.startedAt > 0)
      return value;
  } catch { /* Storage can be unavailable in private browser sessions. */ }
  return null;
}

function isActive(phase?: UpdateState["phase"]) {
  return phase === "checking" || phase === "downloading" || phase === "restarting";
}

function useUpdateController() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [action, setAction] = useState<UpdateAction | null>(null);
  const [error, setError] = useState("");
  const [connectionLost, setConnectionLost] = useState(false);
  const [confirmedRevision, setConfirmedRevision] = useState("");
  const [restartIntent, setRestartIntent] = useState(storedRestart);
  const [restartExpired, setRestartExpired] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const mounted = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const operationTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const polling = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const intent = useRef(restartIntent);

  const rememberRestart = useCallback((value: RestartIntent | null) => {
    intent.current = value;
    setRestartIntent(value);
    try {
      if (value) sessionStorage.setItem(RESTART_STORAGE_KEY, JSON.stringify(value));
      else sessionStorage.removeItem(RESTART_STORAGE_KEY);
    } catch { /* Server state remains the source of truth when storage is unavailable. */ }
  }, []);

  const acceptState = useCallback((value: UpdateState) => {
    setState(value);
    setError("");
    setConnectionLost(false);
    if (intent.current && value.current.revision === intent.current.revision) {
      setConfirmedRevision(intent.current.revision);
      setRestartExpired(false);
      rememberRestart(null);
    } else if (intent.current && value.phase === "failed") {
      rememberRestart(null);
      setError(value.error || "重启未完成，请检查服务状态后重试。");
    } else if (!intent.current && value.phase === "restarting" && value.pending) {
      rememberRestart({ revision: value.pending.revision, startedAt: Date.now() });
    }
  }, [rememberRestart]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(operationTimeout.current);
      operation.current?.abort();
      polling.current?.abort();
    };
  }, []);

  const pollMode = restartIntent ? "restart" : !state ? "initial" : isActive(state.phase) ? state.phase : "idle";
  useEffect(() => {
    if (action || restartExpired || pollMode === "idle") return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const requestGeneration = generation.current;
    const stale = () => disposed || requestGeneration !== generation.current;
    async function read() {
      if (stale() || operation.current) return;
      if (intent.current && Date.now() - intent.current.startedAt >= RESTART_WAIT_MS) {
        setRestartExpired(true);
        setError("仍未确认目标构建已启动，请检查容器日志，或继续检查状态。不要重复重启服务。");
        return;
      }
      controller = new AbortController();
      polling.current = controller;
      timeout = setTimeout(() => controller?.abort(), 8000);
      let delay = 2500;
      let again = Boolean(intent.current);
      try {
        const next = await adminApi.updates(controller.signal);
        if (stale()) return;
        acceptState(next);
        again = Boolean(intent.current) || isActive(next.phase);
        delay = next.phase === "downloading" ? 1000 : 2500;
      } catch (reason) {
        if (stale()) return;
        const status = (reason as ApiError).status;
        if (status === 401 || status === 403) {
          setError(reason instanceof Error ? reason.message : "请重新登录管理员账号");
          again = false;
        } else if (pollMode === "initial" && !intent.current) {
          setError(controller.signal.aborted ? "获取更新状态超时，请重试。" : reason instanceof Error ? reason.message : "无法获取更新状态");
        } else {
          setConnectionLost(true);
          again = true;
          delay = 4000;
        }
      } finally {
        clearTimeout(timeout);
        if (polling.current === controller) polling.current = null;
      }
      if (!stale() && again) timer = setTimeout(() => void read(), delay);
    }
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(timeout);
      controller?.abort();
    };
  }, [action, pollMode, restartIntent?.revision, restartIntent?.startedAt, restartExpired, retryKey, acceptState]);

  async function perform(name: UpdateAction) {
    if (operation.current || !state || restartIntent || isActive(state.phase)) return;
    const pending = state.pending;
    if (name !== "check" && !state.supported) return;
    if (name === "check" && pending) return;
    if (name === "apply" && (!state.latest || !state.available || state.blocked_reason || pending)) return;
    if (name === "restart" && (state.phase !== "ready" || !pending)) return;
    if (name === "rollback" && (!state.backup || pending)) return;
    const controller = new AbortController();
    operation.current = controller;
    generation.current += 1;
    polling.current?.abort();
    setAction(name);
    setError("");
    setConfirmedRevision("");
    setConnectionLost(false);
    if (name === "restart") rememberRestart({ revision: pending!.revision, startedAt: Date.now() });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, name === "restart" ? 8000 : 45000);
    operationTimeout.current = timeout;
    try {
      const next = await (name === "check" ? adminApi.checkUpdate(controller.signal)
        : name === "apply" ? adminApi.applyUpdate(state.latest!.revision, controller.signal)
        : name === "rollback" ? adminApi.rollbackUpdate(controller.signal)
        : adminApi.restartUpdate(controller.signal));
      if (mounted.current && !controller.signal.aborted) acceptState(next);
    } catch (reason) {
      if (!mounted.current || (controller.signal.aborted && !timedOut)) return;
      if (name === "restart" && !(reason as ApiError).status) {
        // Losing this connection can mean the accepted restart already replaced the process.
        setConnectionLost(true);
      } else if ((name === "apply" || name === "rollback") && !(reason as ApiError).status) {
        // The command may have been accepted even if its response was interrupted.
        setState(null);
      } else {
        if (name === "restart") rememberRestart(null);
        setError(timedOut ? "操作超时，请重试。" : reason instanceof Error ? reason.message : "操作失败，请重试");
      }
    } finally {
      clearTimeout(timeout);
      if (operationTimeout.current === timeout) operationTimeout.current = undefined;
      if (operation.current === controller) operation.current = null;
      if (mounted.current) setAction(null);
    }
  }

  function retry() {
    setError("");
    setConnectionLost(false);
    setRestartExpired(false);
    if (intent.current) rememberRestart({ ...intent.current, startedAt: Date.now() });
    setRetryKey((key) => key + 1);
  }

  return { state, action, error, connectionLost, confirmedRevision, restartIntent, restartExpired, perform, retry };
}

function shortRevision(revision: string) {
  return !revision || revision === "unknown" ? "本地构建" : revision.slice(0, 8);
}

function buildLabel(build: UpdateBuild) {
  return `${build.version || "开发构建"} · ${shortRevision(build.revision)}`;
}

function dateLabel(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium", timeStyle: "short",
  }).format(date);
}

function byteLabel(value: number) {
  if (value < 1024) return `${Math.max(0, value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdateCard() {
  const control = useUpdateController();
  const { state, action, error, connectionLost, confirmedRevision, restartIntent, restartExpired } = control;
  const [confirm, setConfirm] = useState<"restart" | "rollback" | null>(null);
  const restarting = Boolean(restartIntent) || state?.phase === "restarting";
  const active = Boolean(action) || restarting || isActive(state?.phase);
  const ready = state?.phase === "ready" && state.pending;
  const downloading = state?.phase === "downloading";
  const checking = action === "check" || state?.phase === "checking";
  const canApply = state?.supported && state.available && state.latest && !state.blocked_reason && !state.pending && !active;
  const status = restarting ? "正在等待任务完成并重启"
    : downloading ? "正在下载更新"
    : action === "apply" ? "正在准备下载"
    : action === "rollback" ? "正在恢复备份"
    : ready ? "已准备就绪，等待重启"
    : checking ? "正在检查更新"
    : confirmedRevision ? "更新成功，已运行目标构建"
    : state?.phase === "failed" ? "更新未完成"
    : state?.blocked_reason ? "此构建需要手动升级"
    : state?.latest ? state.available ? "发现可用更新" : "已是最新构建"
    : "尚未检查更新";

  return (
    <section className="settings-card update-card" aria-labelledby="update-card-heading">
      <div className="update-card-heading">
        <h3 id="update-card-heading">软件更新</h3>
        {state && <button type="button" className="secondary-button" disabled={active || Boolean(state.pending)}
          onClick={() => void control.perform("check")}>
          {checking ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
          检查更新
        </button>}
      </div>
      {!state ? (
        error ? <div className="update-card-error" role="alert"><span>{error}</span>
          <button type="button" className="text-button" onClick={control.retry}>重试</button></div>
          : <div className="update-card-loading" role="status"><LoaderCircle size={17} className="spin" />正在获取构建信息</div>
      ) : (
        <>
          <div className="update-build-current">
            <strong>Ochi {state.current.version || "开发构建"}</strong>
            <code title={state.current.revision}>{shortRevision(state.current.revision)}</code>
            {dateLabel(state.current.built_at) && <span>构建于 {dateLabel(state.current.built_at)}</span>}
          </div>
          {(state.pending || state.latest) && <div className="update-build-target">
            <span>{state.pending ? "重启后运行" : "最新构建"}</span>
            <strong>{buildLabel((state.pending ?? state.latest)!)}</strong>
          </div>}
          <div className={`update-card-status${confirmedRevision ? " is-complete" : ""}`} role="status" aria-live="polite">
            {active ? <LoaderCircle className="spin" size={16} /> : confirmedRevision ? <Check size={16} /> : state.phase === "failed" || state.blocked_reason ? <CircleAlert size={16} /> : null}
            <span>{restartExpired ? "尚未确认重启完成" : status}</span>
          </div>
          {downloading && <div className="update-download">
            <progress aria-label="更新下载进度" value={state.total_bytes > 0 ? state.downloaded_bytes : undefined}
              max={state.total_bytes > 0 ? state.total_bytes : undefined} />
            <span>{byteLabel(state.downloaded_bytes)}{state.total_bytes > 0 ? ` / ${byteLabel(state.total_bytes)}` : " 已下载"}</span>
          </div>}
          {restarting && <p className="settings-note">先等待进行中的任务完成，最多等待 10 分钟，再重启服务。短暂断开连接是正常现象；正在核对目标构建，可离开此页。</p>}
          {connectionLost && !restartExpired && <p className="settings-note">{restarting ? "服务连接已断开，正在等待目标构建启动…" : "暂时无法获取进度，正在重新连接…"}</p>}
          {!state.supported && <p className="settings-note">{state.unsupported_reason || "此环境不支持在线更新，请使用发布构建。"}</p>}
          {state.blocked_reason && <p className="update-card-warning">{state.blocked_reason}</p>}
          {(error || state.error) && <div className="update-card-error" role="alert"><span>{error || state.error}</span>
            {restartExpired && <button type="button" className="text-button" onClick={control.retry}>继续检查</button>}
            {!restartExpired && error && (isActive(state.phase) || restartIntent) && <button type="button" className="text-button" onClick={control.retry}>重新检查</button>}
          </div>}
          <div className="update-card-actions">
            {canApply && <button type="button" className="primary-button" onClick={() => void control.perform("apply")}><Download size={15} />下载更新</button>}
            {ready && !restarting && <button type="button" className="primary-button" disabled={active || !state.supported} onClick={() => setConfirm("restart")}><RefreshCw size={15} />重启并应用</button>}
            {confirmedRevision && <button type="button" className="secondary-button" onClick={() => window.location.reload()}>刷新页面</button>}
            {state.backup && !state.pending && <button type="button" className="text-button" disabled={active || !state.supported}
              onClick={() => setConfirm("rollback")}><RotateCcw size={14} />恢复备份 <code>{shortRevision(state.backup.revision)}</code></button>}
            {state.checked_at && !active && <span className="update-checked">上次检查 {dateLabel(state.checked_at)}</span>}
          </div>
          <p className="settings-note update-card-footnote">仅更新 Ochi 前后端，不更新数据库或 Computer 工作区。重建容器会恢复镜像自带的程序版本。</p>
        </>
      )}
      {confirm && <Modal className="ochi-admin-modal" size="small" title={confirm === "restart" ? "重启并应用更新？" : "恢复备份程序？"}
        onClose={() => setConfirm(null)} footer={<div className="modal-actions">
          <button type="button" className="secondary-button" onClick={() => setConfirm(null)}>取消</button>
          <button type="button" className="primary-button" disabled={active} onClick={() => {
            const command = confirm;
            setConfirm(null);
            void control.perform(command);
          }}>{confirm === "restart" ? "确认重启" : "恢复备份"}</button>
        </div>}>
        {confirm === "restart" ? <p>将运行 {state?.pending ? buildLabel(state.pending) : "目标构建"}。服务会先等待进行中的任务完成，最多等待 10 分钟；超时仍未完成的任务会中断。重启时会短暂断开连接。</p>
          : <p>将恢复 {state?.backup ? buildLabel(state.backup) : "备份构建"}，之后仍需确认重启才会生效。此操作不恢复数据库或用户文件。</p>}
      </Modal>}
    </section>
  );
}
