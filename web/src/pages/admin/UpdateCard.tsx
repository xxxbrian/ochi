import { t, useAdminI18n, getLocale, formatNumber, translateError, type AdminMessageKey } from "./i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Download, Power, RefreshCw, RotateCcw } from "lucide-react";
import { Modal } from "../../components/Modal";
import { adminApi } from "../../lib/api";
import type { ApiError, UpdateBuild, UpdateState } from "../../lib/types";

const RESTART_STORAGE_KEY = "ochi-admin-update-restart";
const RESTART_WAIT_MS = 15 * 60 * 1000;
type RestartIntent = { revision: string; startedAt: number };
type UpdateAction = "check" | "apply" | "rollback" | "restart";
type UpdateIssue = AdminMessageKey | Pick<ApiError, "message" | "code" | "params">;

function issueText(issue: UpdateIssue | null) {
  if (!issue) return "";
  return typeof issue === "string" ? t(issue) : translateError(issue.code, issue.params) ?? issue.message;
}

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
  const [issue, setIssue] = useState<UpdateIssue | null>(null);
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
    setIssue(null);
    setConnectionLost(false);
    if (intent.current && value.current.revision === intent.current.revision) {
      setConfirmedRevision(intent.current.revision);
      setRestartExpired(false);
      rememberRestart(null);
    } else if (intent.current && value.phase === "failed") {
      rememberRestart(null);
      setIssue(value.error_code ? { code: value.error_code, params: value.error_params, message: value.error ?? "" } : "restartIncomplete");
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
        setIssue("restartUnconfirmedHint");
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
          setIssue(reason instanceof Error ? reason : "adminLoginRequired");
          again = false;
        } else if (pollMode === "initial" && !intent.current) {
          setIssue(controller.signal.aborted ? "updateStatusTimeout" : reason instanceof Error ? reason : "updateStatusFailed");
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
    setIssue(null);
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
        setIssue(timedOut ? "operationTimeout" : reason instanceof Error ? reason : "operationFailedRetry");
      }
    } finally {
      clearTimeout(timeout);
      if (operationTimeout.current === timeout) operationTimeout.current = undefined;
      if (operation.current === controller) operation.current = null;
      if (mounted.current) setAction(null);
    }
  }

  function retry() {
    setIssue(null);
    setConnectionLost(false);
    setRestartExpired(false);
    if (intent.current) rememberRestart({ ...intent.current, startedAt: Date.now() });
    setRetryKey((key) => key + 1);
  }

  return { state, action, error: issueText(issue), connectionLost, confirmedRevision, restartIntent, restartExpired, perform, retry };
}

function shortRevision(revision: string) {
  return !revision || revision === "unknown" ? t("localBuild") : revision.slice(0, 8);
}

/** The active phase shows the icon of what is happening: refresh turns itself, the rest pulse. */
export function updatePhaseIcon(action: UpdateAction | null | undefined, phase: UpdateState["phase"] | undefined, restarting: boolean) {
  if (restarting) return { Icon: Power, turn: false };
  if (action === "rollback") return { Icon: RotateCcw, turn: false };
  if (phase === "downloading" || action === "apply") return { Icon: Download, turn: false };
  return { Icon: RefreshCw, turn: true };
}

function UpdatePhaseIcon({ action, phase, restarting }: { action: UpdateAction | null | undefined; phase: UpdateState["phase"] | undefined; restarting: boolean }) {
  const { Icon, turn } = updatePhaseIcon(action, phase, restarting);
  return <Icon size={15} className={turn ? "ic-turn" : "ic-pulse"} aria-hidden="true" />;
}

function buildLabel(build: UpdateBuild) {
  return `${build.version || t("developmentBuild")} · ${shortRevision(build.revision)}`;
}

function dateLabel(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(getLocale(), {
    dateStyle: "medium", timeStyle: "short",
  }).format(date);
}

function byteLabel(value: number) {
  if (value < 1024) return `${formatNumber(Math.max(0, value))} B`;
  if (value < 1024 * 1024) return `${formatNumber(value / 1024, { maximumFractionDigits: 1 })} KB`;
  return `${formatNumber(value / (1024 * 1024), { maximumFractionDigits: 1 })} MB`;
}

export function UpdateCard() {
  useAdminI18n();
  const control = useUpdateController();
  const { state, action, error, connectionLost, confirmedRevision, restartIntent, restartExpired } = control;
  const [confirm, setConfirm] = useState<"restart" | "rollback" | null>(null);
  const restarting = Boolean(restartIntent) || state?.phase === "restarting";
  const active = Boolean(action) || restarting || isActive(state?.phase);
  const ready = state?.phase === "ready" && state.pending;
  const downloading = state?.phase === "downloading";
  const checking = action === "check" || state?.phase === "checking";
  const stateError = translateError(state?.error_code, state?.error_params) ?? state?.error;
  const canApply = state?.supported && state.available && state.latest && !state.blocked_reason && !state.pending && !active;
  const status = restarting ? t("waitingForRestart")
    : downloading ? t("downloadingUpdate")
    : action === "apply" ? t("preparingDownload")
    : action === "rollback" ? t("restoringBackup")
    : ready ? t("readyToRestart")
    : checking ? t("checkingUpdates")
    : confirmedRevision ? t("updateConfirmed")
    : state?.phase === "failed" ? t("updateIncomplete")
    : state?.blocked_reason ? t("manualUpgradeRequired")
    : state?.latest ? state.available ? t("updateAvailable") : t("upToDate")
    : t("notChecked");

  return (
    <section className="settings-card update-card" aria-labelledby="update-card-heading">
      <div className="update-card-heading">
        <h3 id="update-card-heading">{t("softwareUpdate")}</h3>
        {state && <button type="button" className={`btn secondary${checking ? " btn-progress" : ""}`} disabled={active || Boolean(state.pending)}
          onClick={() => void control.perform("check")}>
          <RefreshCw size={15} className={checking ? "ic-turn" : undefined} />
          {t("checkUpdates")}</button>}
      </div>
      {!state ? (
        error ? <div className="update-card-error" role="alert"><span>{error}</span>
          <button type="button" className="btn ghost sm" onClick={control.retry}>{t("retry")}</button></div>
          : <div className="update-card-loading" role="status" aria-busy="true"><span className="sr-only">{t("loadingBuild")}</span><span className="skel update-skel" aria-hidden="true" /></div>
      ) : (
        <>
          <div className="update-build-current">
            <strong>Ochi {state.current.version || t("developmentBuild")}</strong>
            <code title={state.current.revision}>{shortRevision(state.current.revision)}</code>
            {dateLabel(state.current.built_at) && <span>{t("builtAt", { date: dateLabel(state.current.built_at) })}</span>}
          </div>
          {(state.pending || state.latest) && <div className="update-build-target">
            <span>{state.pending ? t("runAfterRestart") : t("latestBuild")}</span>
            <strong>{buildLabel((state.pending ?? state.latest)!)}</strong>
          </div>}
          <div className={`update-card-status${confirmedRevision ? " is-complete" : ""}`} role="status" aria-live="polite">
            {active ? <UpdatePhaseIcon action={action} phase={state.phase} restarting={restarting} /> : confirmedRevision ? <Check size={16} /> : state.phase === "failed" || state.blocked_reason ? <CircleAlert size={16} /> : null}
            <span>{restartExpired ? t("restartNotConfirmed") : status}</span>
          </div>
          {downloading && <div className="update-download">
            <progress aria-label={t("downloadProgress")} value={state.total_bytes > 0 ? state.downloaded_bytes : undefined}
              max={state.total_bytes > 0 ? state.total_bytes : undefined} />
            <span>{byteLabel(state.downloaded_bytes)}{state.total_bytes > 0 ? ` / ${byteLabel(state.total_bytes)}` : t("downloadedSuffix")}</span>
          </div>}
          {restarting && <p className="settings-note">{t("restartProgressHint")}</p>}
          {connectionLost && !restartExpired && <p className="settings-note">{restarting ? t("waitingForConnection") : t("reconnectingProgress")}</p>}
          {!state.supported && <p className="settings-note">{translateError(state.unsupported_reason_code) ?? state.unsupported_reason ?? t("onlineUpdateUnsupported")}</p>}
          {state.blocked_reason && <p className="update-card-warning">{translateError(state.blocked_reason_code) ?? state.blocked_reason}</p>}
          {(error || stateError) && <div className="update-card-error" role="alert"><span>{error || stateError}</span>
            {restartExpired && <button type="button" className="btn ghost sm" onClick={control.retry}>{t("keepChecking")}</button>}
            {!restartExpired && error && (isActive(state.phase) || restartIntent) && <button type="button" className="btn ghost sm" onClick={control.retry}>{t("checkAgain")}</button>}
          </div>}
          <div className="update-card-actions">
            {canApply && <button type="button" className="btn primary" onClick={() => void control.perform("apply")}><Download size={15} />{t("downloadUpdate")}</button>}
            {ready && !restarting && <button type="button" className="btn primary" disabled={active || !state.supported} onClick={() => setConfirm("restart")}><RefreshCw size={15} />{t("restartAndApply")}</button>}
            {confirmedRevision && <button type="button" className="btn secondary" onClick={() => window.location.reload()}>{t("refreshPage")}</button>}
            {state.backup && !state.pending && <button type="button" className="btn ghost sm" disabled={active || !state.supported}
              onClick={() => setConfirm("rollback")}><RotateCcw size={14} />{t("restoreBackup")}<code>{shortRevision(state.backup.revision)}</code></button>}
            {state.checked_at && !active && <span className="update-checked">{t("lastChecked", { date: dateLabel(state.checked_at) })}</span>}
          </div>
          <p className="settings-note update-card-footnote">{t("updateScopeHint")}</p>
        </>
      )}
      {confirm && <Modal className="ochi-admin-modal" size="small" title={confirm === "restart" ? t("applyUpdateQuestion") : t("restoreBackupQuestion")}
        onClose={() => setConfirm(null)} footer={<div className="modal-actions">
          <button type="button" className="btn secondary" onClick={() => setConfirm(null)}>{t("cancel")}</button>
          <button type="button" className="btn primary" disabled={active} onClick={() => {
            const command = confirm;
            setConfirm(null);
            void control.perform(command);
          }}>{confirm === "restart" ? t("confirmRestart") : t("restoreBackup")}</button>
        </div>}>
        <p>{confirm === "restart"
          ? t("restartWarning", { build: state?.pending ? buildLabel(state.pending) : t("targetBuild") })
          : t("restoreWarning", { build: state?.backup ? buildLabel(state.backup) : t("backupBuild") })}</p>
      </Modal>}
    </section>
  );
}
