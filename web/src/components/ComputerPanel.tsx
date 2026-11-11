import { t, useI18n } from "../lib/i18n";
import { flushSync } from "react-dom";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  Bot,
  ChevronDown,
  CircleX,
  Expand,
  Eye,
  Hand,
  History,
  Keyboard,
  Maximize2,
  Minimize2,
  Monitor,
  Plug,
  RefreshCw,
  Send,
  Shrink,
  Unplug,
  X,
  type LucideIcon,
} from "lucide-react";
import { api } from "../lib/api";
import { formatProcessElapsed } from "../../../shared/i18n/process";
import type { ApiError, ComputerState } from "../lib/types";
import type RFB from "@novnc/novnc";
import { QueueCard } from "./ComputerSteps";
import "./computer.css";

type View = "connecting" | "queued" | "user" | "ai" | "watching" | "off";
type LogKind = "connected" | "disconnected" | "tookOver" | "released" | "ochiStarted" | "ochiStopped" | "sent" | "key";
type LogEntry = { id: number; at: number; kind: LogKind; value?: string | number };

const MIN_WIDTH = 340;
const FLIP_MS = 400;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Log rows read as who did what: Ochi, the user, or the connection itself. */
const logMeta: Record<LogKind, { icon: LucideIcon; who: "ai" | "user" | "system" }> = {
  connected: { icon: Plug, who: "system" },
  disconnected: { icon: Unplug, who: "system" },
  tookOver: { icon: Hand, who: "user" },
  released: { icon: Bot, who: "user" },
  ochiStarted: { icon: Bot, who: "ai" },
  ochiStopped: { icon: Bot, who: "ai" },
  sent: { icon: Send, who: "user" },
  key: { icon: Keyboard, who: "user" },
};

const logText = (entry: LogEntry) => {
  switch (entry.kind) {
    case "connected": return t("computer.logConnected");
    case "disconnected": return t("computer.logDisconnected");
    case "tookOver": return t("computer.logTookOver");
    case "released": return t("computer.logReleased");
    case "ochiStarted": return t("computer.logOchiStarted");
    case "ochiStopped": return t("computer.logOchiStopped");
    case "sent": return t("computer.logSent", { count: Number(entry.value) });
    default: return t("computer.logKey", { key: String(entry.value) });
  }
};

function useElapsed(since: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since ? formatProcessElapsed(Math.max(0, now - since)) : undefined;
}

function Ago({ at }: { at: number }) {
  const { locale } = useI18n();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  return <>{seconds < 5 ? format.format(0, "second") : seconds < 60 ? format.format(-seconds, "second") : format.format(-Math.round(seconds / 60), "minute")}</>;
}

const SPECIAL_KEYS: [string, number][] = [["Esc", 0xff1b], ["Tab", 0xff09], ["Enter", 0xff0d]];

// Connecting: the monitor keeps its own icon while a scan line sweeps down the screen.
function ScanMonitor({ size }: { size: number }) {
  return <span className="cu-link" style={{ width: size, height: size }} aria-hidden><Monitor size={size} strokeWidth={1.8} /><i /></span>;
}

export function ComputerPanel({
  onClose,
  standalone = false,
}: {
  onClose: () => void;
  standalone?: boolean;
}) {
  useI18n();
  const [state, setState] = useState<ComputerState | null>(null);
  const [connection, setConnection] = useState<
    "connecting" | "connected" | "disconnected"
  >("connecting");
  const [error, setError] = useState("");
  const [fit, setFit] = useState(true);
  const [pan, setPan] = useState(false);
  const [kbd, setKbd] = useState(false);
  const [retry, setRetry] = useState(0);
  const [lostLink, setLostLink] = useState(false);
  const desktopUrl = useRef("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [queuedSince, setQueuedSince] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const logId = useRef(0);
  const aiActive = useRef<boolean | null>(null);
  const record = useCallback((kind: LogKind, value?: string | number) => {
    setLog((current) => [{ id: ++logId.current, at: Date.now(), kind, value }, ...current].slice(0, 40));
  }, []);
  const waited = useElapsed(queuedSince);
  const dock = useRef<HTMLElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const client = useRef<RFB | null>(null);
  const closedClients = useRef(new WeakSet<RFB>());
  const disconnectClient = useCallback((value: RFB | null) => {
    if (!value || closedClients.current.has(value)) return;
    closedClients.current.add(value);
    value.disconnect();
  }, []);
  const controlRequest = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;
  const accessRevoked = useRef(false);

  /* Full screen is a FLIP between the dock and the whole window. The stage never remounts, so the VNC canvas survives. */
  const stage = useRef<HTMLDivElement>(null);
  const placeholder = useRef<HTMLDivElement>(null);
  const [fs, setFs] = useState<"off" | "pre" | "on">("off");
  const [phHeight, setPhHeight] = useState(0);
  const fsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settle = useCallback(() => {
    // noVNC rescales on container resize; make sure it has the final size once the box stops moving.
    window.dispatchEvent(new Event("resize"));
  }, []);
  const enterFs = useCallback(() => {
    const node = stage.current;
    if (!node) return;
    clearTimeout(fsTimer.current);
    const box = node.getBoundingClientRect();
    flushSync(() => {
      setPhHeight(box.height);
      setFs("pre");
    });
    node.style.cssText = `top:${box.top}px;left:${box.left}px;width:${box.width}px;height:${box.height}px`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      // Apply the target rules and drop the inline start box in the same frame so the transition runs.
      flushSync(() => setFs("on"));
      node.style.cssText = "";
      fsTimer.current = setTimeout(settle, reducedMotion() ? 0 : FLIP_MS);
    }));
  }, [settle]);
  const exitFs = useCallback((instant = false) => {
    const node = stage.current;
    const ph = placeholder.current;
    if (!node) return;
    clearTimeout(fsTimer.current);
    const done = () => {
      node.style.cssText = "";
      setFs("off");
      requestAnimationFrame(settle);
    };
    if (instant || !ph || reducedMotion()) return done();
    const box = ph.getBoundingClientRect();
    node.style.cssText = `top:${box.top}px;left:${box.left}px;width:${box.width}px;height:${box.height}px`;
    flushSync(() => setFs("pre"));
    fsTimer.current = setTimeout(done, FLIP_MS);
    const poll = setInterval(settle, 60);
    setTimeout(() => clearInterval(poll), FLIP_MS + 40);
  }, [settle]);
  useEffect(() => () => clearTimeout(fsTimer.current), []);
  useEffect(() => {
    if (fs === "off") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      exitFs();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [fs, exitFs]);

  /* Escape closes the dock when nothing else (menu, dialog, full screen) is taking it. */
  useEffect(() => {
    if (standalone) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || fs !== "off") return;
      if (document.querySelector("[role=dialog], [role=menu]")) return;
      if (dock.current && !dock.current.contains(document.activeElement)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [standalone, fs, onClose]);

  const refreshState = useCallback(async () => {
    let value: ComputerState;
    try {
      value = await api.computerState();
    } catch (reason) {
      if (
        mounted.current &&
        [401, 403, 404].includes((reason as ApiError).status ?? 0)
      ) {
        accessRevoked.current = true;
        disconnectClient(client.current);
        client.current = null;
        setState(null);
        setConnection("disconnected");
        setError(reason instanceof Error ? reason.message : t("computer.accessError"));
      }
      throw reason;
    }
    if (!mounted.current) return value;
    setState(value);
    if (client.current) client.current.viewOnly = value.view_only;
    if (
      desktopUrl.current &&
      value.desktop_url &&
      desktopUrl.current !== value.desktop_url
    ) {
      desktopUrl.current = value.desktop_url;
      setRetry((current) => current + 1);
    }
    return value;
  }, [disconnectClient]);
  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let rfb: RFB | null = null;
    accessRevoked.current = false;
    async function connect() {
      setConnection("connecting");
      try {
        const current = await refreshState();
        if (disposed) return;
        if (!current.available || !current.desktop_url) {
          setError(t("computer.unavailable"));
          setConnection("disconnected");
          return;
        }
        desktopUrl.current = current.desktop_url;
        const { default: Client } = await import("@novnc/novnc");
        if (disposed || !host.current) return;
        host.current.replaceChildren();
        rfb = new Client(host.current, api.desktopUrl(current.desktop_url));
        client.current = rfb;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.clipViewport = true;
        rfb.viewOnly = current.view_only;
        rfb.background = "#121214";
        rfb.showDotCursor = true;
        rfb.addEventListener("connect", () => {
          if (!disposed) {
            setConnection("connected");
            setLostLink(false);
            setError("");
            failures = 0;
            record("connected");
          }
        });
        rfb.addEventListener("disconnect", () => {
          if (rfb) closedClients.current.add(rfb);
          if (disposed) return;
          setConnection("disconnected");
          setLostLink(true);
          record("disconnected");
          client.current = null;
          if (accessRevoked.current) return;
          failures += 1;
          reconnectTimer = setTimeout(
            () => {
              if (!disposed && !accessRevoked.current) void connect();
            },
            Math.min(1000 * 2 ** failures, 15000),
          );
        });
        rfb.addEventListener("securityfailure", () => {
          if (!disposed) setError(t("computer.connectError"));
        });
      } catch (reason) {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : t("error.connection"));
          setConnection("disconnected");
        }
      }
    }
    void connect();
    const interval = setInterval(() => {
      if (!disposed && !accessRevoked.current)
        void refreshState().catch(() => undefined);
    }, 5000);
    return () => {
      disposed = true;
      clearInterval(interval);
      clearTimeout(reconnectTimer);
      disconnectClient(rfb);
      client.current = null;
    };
  }, [retry, refreshState, disconnectClient, record]);
  const ochiBusy = Boolean(state?.view_only && state.busy);
  useEffect(() => {
    if (!state) return;
    if (aiActive.current !== null && aiActive.current !== ochiBusy) record(ochiBusy ? "ochiStarted" : "ochiStopped");
    aiActive.current = ochiBusy;
  }, [state, ochiBusy, record]);
  useEffect(() => {
    setQueuedSince(busy ? Date.now() : 0);
  }, [busy]);
  useEffect(() => {
    if (client.current) {
      client.current.scaleViewport = fit;
      client.current.dragViewport = pan;
    }
  }, [fit, pan, connection]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controlRequest.current?.abort();
      if (stateRef.current?.control_enabled)
        void api.computerControl(false).catch(() => undefined);
    };
  }, []);
  async function control() {
    if (busy) {
      controlRequest.current?.abort();
      controlRequest.current = null;
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    controlRequest.current = controller;
    setBusy(true);
    try {
      const value = await api.computerControl(
        !state?.control_enabled,
        controller.signal,
      );
      if (
        !mounted.current ||
        controller.signal.aborted
      )
        return;
      setState(value);
      record(value.control_enabled ? "tookOver" : "released");
      desktopUrl.current = value.desktop_url ?? "";
      setRetry((current) => current + 1);
      setError("");
    } catch (reason) {
      if (
        !controller.signal.aborted &&
        mounted.current
      )
        setError(reason instanceof Error ? reason.message : t("computer.takeoverError"));
    } finally {
      if (controlRequest.current === controller) {
        if (mounted.current) setBusy(false);
        controlRequest.current = null;
      }
    }
  }
  function sendKey(keysym: number, name: string) {
    if (!client.current) return;
    client.current.sendKey(keysym);
    record("key", name);
  }
  function sendText(value: string) {
    if (!client.current || state?.view_only) return;
    record("sent", [...value].length);
    for (const char of value) {
      const code = char.codePointAt(0)!;
      client.current.sendKey(
        code === 10 ? 0xff0d : code <= 255 ? code : 0x01000000 | code,
      );
    }
  }
  const view: View =
    connection === "disconnected"
      ? "off"
      : busy
        ? "queued"
        : connection === "connecting"
          ? "connecting"
          : !state?.view_only
            ? "user"
            : state.busy
              ? "ai"
              : "watching";
  const canInput = !state?.view_only && connection === "connected";
  // The keyboard toggle hands focus to the remote desktop; it releases when control or the link goes away.
  useEffect(() => {
    if (!client.current) return;
    if (kbd && canInput) client.current.focus();
    else (client.current as typeof client.current & { blur(): void }).blur();
  }, [kbd, canInput, retry]);
  const pill = {
    off: ["danger", t("status.disconnected")],
    connecting: ["neutral", t("status.connecting")],
    queued: ["warn", t("computer.queuedPill")],
    user: ["success", t("computer.youControlling")],
    ai: ["accent", t("computer.aiControlling")],
    watching: ["neutral", t("computer.watching")],
  }[view];
  const badge = {
    ai: [<Bot key="i" size={14} />, t("computer.badgeAi")],
    user: [<Hand key="i" size={14} />, t("computer.badgeUser")],
    watching: [<Eye key="i" size={14} />, t("computer.badgeWatching")],
  }[view as "ai" | "user" | "watching"];

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const node = dock.current;
    if (!node) return;
    const right = node.getBoundingClientRect().right;
    const maxWidth = window.innerWidth * 0.7;
    event.preventDefault();
    setDragging(true);
    const move = (next: PointerEvent) => setWidth(clamp(right - next.clientX, MIN_WIDTH, maxWidth));
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const resizeByKey = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const base = dock.current?.getBoundingClientRect().width ?? MIN_WIDTH;
    setWidth(clamp(base + (event.key === "ArrowLeft" ? 32 : -32), MIN_WIDTH, window.innerWidth * 0.7));
  };

  const toolbar = (
    <span className="cu-tools">
      <button
        className="icon-btn sm cu-hc"
        aria-label={fit ? t("computer.actualSize") : t("computer.fit")}
        title={fit ? t("computer.actualSize") : t("computer.fit")}
        aria-pressed={!fit}
        onClick={() => setFit((value) => !value)}
      >
        {fit ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
      </button>
      <button
        className="icon-btn sm cu-hc"
        aria-label={t("computer.dragView")}
        title={t("computer.dragView")}
        aria-pressed={pan}
        onClick={() => setPan((value) => !value)}
      >
        <Hand size={14} />
      </button>
      {!standalone && (
        <button
          className="icon-btn sm"
          aria-label={fs === "on" ? t("common.exitFullscreen") : t("common.fullscreen")}
          title={fs === "on" ? t("common.exitFullscreen") : t("common.fullscreen")}
          onClick={() => (fs === "off" ? enterFs() : exitFs())}
        >
          {fs === "on" ? <Shrink size={14} /> : <Expand size={14} />}
        </button>
      )}
      <button
        className="icon-btn sm"
        aria-label={t("common.reconnect")}
        title={t("common.reconnect")}
        onClick={() => setRetry((value) => value + 1)}
      >
        <RefreshCw size={14} />
      </button>
    </span>
  );

  const content = (
    <div className="cu-live" data-view={view}>
      {fs !== "off" && <div ref={placeholder} className="cu-ph" style={{ height: phHeight }} />}
      <div ref={stage} className="cu-stage" data-view={view} data-fs={fs === "off" ? undefined : fs}>
        <div className="cu-viewport" data-fit={fit} data-pan={pan}>
          <div className={`desktop-screen ${fit ? "is-fitted" : ""}`}>
            <div ref={host} className="desktop-host" />
          </div>
          {connection === "connecting" && !busy && !lostLink && (
            <span className="cu-loader" role="status"><ScanMonitor size={22} /><span>{t("computer.connecting")}</span></span>
          )}
          {badge && connection === "connected" && (
            <span className="cu-badge" data-on aria-hidden>{badge[0]}<span>{badge[1]}</span></span>
          )}
          {view === "queued" && (
            <div className="cu-overlay" data-kind="queue">
              <QueueCard
                resource="desktop"
                status="waiting"
                title={t("computer.queuedTitle")}
                subtitle={t("computer.queuedHint")}
                elapsed={waited}
                footer={t("computer.queueFooter")}
                onCancel={() => void control()}
                cancelLabel={t("computer.cancelWait")}
                overlay
              />
            </div>
          )}
          {view === "connecting" && lostLink && (
            <div className="cu-overlay" data-kind="off">
              <div className="cu-offcard" role="status">
                <span className="cu-spin"><ScanMonitor size={20} /></span>
                <b>{t("computer.reconnecting")}</b>
                <small>{t("computer.reconnectingHint")}</small>
              </div>
            </div>
          )}
          {view === "off" && (
            <div className="cu-overlay" data-kind="off">
              <div className="cu-offcard">
                <span><CircleX size={20} aria-hidden /></span>
                <b>{t("computer.disconnectedTitle")}</b>
                <small>{error || t("computer.disconnectedHint")}</small>
                <button className="btn primary" onClick={() => setRetry((value) => value + 1)}>
                  <RefreshCw size={14} />
                  {t("common.reconnect")}
                </button>
              </div>
            </div>
          )}
          <span className="cu-hint" aria-hidden>{t("computer.exitFullscreenHint")}</span>
        </div>
        {error && view !== "off" && (
          <p className="form-error cu-error" role="alert">
            {error}
          </p>
        )}
        <div className="cu-ctl">
          <div className="cu-ctl-row">
            <button
              className={`btn cu-take ${state?.view_only ? "primary" : "secondary"}${busy ? " btn-progress" : ""}`}
              disabled={!busy && connection !== "connected"}
              onClick={() => void control()}
            >
              {busy ? <X size={14} /> : state?.view_only ? <Hand size={14} /> : <Bot size={14} />}
              {busy ? t("computer.cancelWait") : state?.view_only ? t("computer.takeover") : t("computer.returnToOchi")}
            </button>
            <form
              className="cu-send"
              onSubmit={(event) => {
                event.preventDefault();
                if (!text) return;
                sendText(text);
                setText("");
              }}
            >
              <input
                className="input"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={state?.view_only ? t("computer.takeoverToType") : t("computer.typeText")}
                disabled={!canInput}
                aria-label={t("computer.sendText")}
              />
              <button className="icon-btn sm" disabled={!canInput || !text} aria-label={t("computer.sendText")}>
                <Send size={14} />
              </button>
            </form>
            <button
              className="icon-btn"
              type="button"
              disabled={!canInput}
              aria-pressed={kbd}
              aria-label={t("computer.keyboard")}
              title={t("computer.keyboard")}
              onClick={() => setKbd((value) => !value)}
            >
              <Keyboard size={16} />
            </button>
          </div>
          {kbd && canInput && (
            <div className="cu-keys" role="group" aria-label={t("computer.specialKeys")}>
              {SPECIAL_KEYS.map(([name, keysym]) => (
                <button key={name} type="button" className="cu-keycap" onClick={() => sendKey(keysym, name)}>{name}</button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="cu-log">
        <button className="cu-logh" aria-expanded={logOpen} onClick={() => setLogOpen((value) => !value)}>
          <History size={15} aria-hidden />
          <b>{t("computer.log")}</b>
          <span className="cu-logn">{log.length}</span>
          <span className="grow" />
          <ChevronDown size={14} className="cu-chev" aria-hidden />
        </button>
        <div className="cu-fold" data-open={logOpen} inert={!logOpen}>
          <div>
            {log.length ? (
              <ul className="cu-logl">
                {log.map((entry) => {
                  const { icon: Icon, who } = logMeta[entry.kind];
                  return (
                    <li key={entry.id} data-who={who} data-fresh={Date.now() - entry.at < 1500 || undefined}>
                      <i aria-hidden><Icon size={12} /></i>
                      <span>{logText(entry)}</span>
                      <small><Ago at={entry.at} /></small>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="cu-log-empty">{t("computer.logEmpty")}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  if (standalone) {
    return (
      <main className="native-computer-page" data-view={view}>
        <header className="cd-head">
          <span className="pill cu-pill" data-tone={pill[0]} role="status">
            {view === "ai" && <i className="dot-live" aria-hidden />}
            {pill[1]}
          </span>
          <span className="grow" />
          {toolbar}
        </header>
        {content}
      </main>
    );
  }
  return (
    <aside
      ref={dock}
      className="computer-dock"
      data-view={view}
      data-full={fs !== "off"}
      data-drag={dragging}
      style={width ? ({ "--dock-w": `${width}px` } as CSSProperties) : undefined}
      aria-label={t("computer.title")}
    >
      <div
        className="cd-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("artifact.resize")}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={resizeByKey}
      />
      <header className="cd-head">
        <Monitor size={16} aria-hidden />
        <h2>{t("computer.title")}</h2>
        <span className="grow" />
        <span className="pill cu-pill" data-tone={pill[0]} role="status" title={state?.busy ? state.owner_title : undefined}>
          {view === "ai" && <i className="dot-live" aria-hidden />}
          {pill[1]}
        </span>
        {toolbar}
        <button className="icon-btn" onClick={onClose} aria-label={t("common.close")} title={t("common.close")}>
          <X size={16} />
        </button>
      </header>
      <div className="cd-body">{content}</div>
    </aside>
  );
}
