import { useCallback, useEffect, useRef, useState } from "react";
import {
  Eye,
  Hand,
  Keyboard,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Move,
  RefreshCw,
  Send,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { api } from "../lib/api";
import type { ApiError, ComputerState } from "../lib/types";
import type RFB from "@novnc/novnc";
import { Modal } from "./Modal";
import "./computer.css";

export function ComputerPanel({
  onClose,
  standalone = false,
}: {
  onClose: () => void;
  standalone?: boolean;
}) {
  const [state, setState] = useState<ComputerState | null>(null);
  const [connection, setConnection] = useState<
    "connecting" | "connected" | "disconnected"
  >("connecting");
  const [error, setError] = useState("");
  const [fit, setFit] = useState(true);
  const [pan, setPan] = useState(false);
  const [full, setFull] = useState(false);
  const [retry, setRetry] = useState(0);
  const desktopUrl = useRef("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const keyboard = useRef<HTMLInputElement>(null);
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
        setError(reason instanceof Error ? reason.message : "无法访问电脑");
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
          setError("电脑暂时不可用");
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
            setError("");
            failures = 0;
          }
        });
        rfb.addEventListener("disconnect", () => {
          if (rfb) closedClients.current.add(rfb);
          if (disposed) return;
          setConnection("disconnected");
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
          if (!disposed) setError("无法连接电脑");
        });
      } catch (reason) {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : "连接失败");
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
  }, [retry, refreshState, disconnectClient]);
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
      desktopUrl.current = value.desktop_url ?? "";
      setRetry((current) => current + 1);
      setError("");
    } catch (reason) {
      if (
        !controller.signal.aborted &&
        mounted.current
      )
        setError(reason instanceof Error ? reason.message : "接管失败");
    } finally {
      if (controlRequest.current === controller) {
        if (mounted.current) setBusy(false);
        controlRequest.current = null;
      }
    }
  }
  function sendText(value: string) {
    if (!client.current || state?.view_only) return;
    for (const char of value) {
      const code = char.codePointAt(0)!;
      client.current.sendKey(
        code === 10 ? 0xff0d : code <= 255 ? code : 0x01000000 | code,
      );
    }
  }
  const content = (
    <>
      <div className="desktop-toolbar">
        <span className={`connection-dot ${connection}`} />
        <span>
          {connection === "connected"
            ? state?.view_only
              ? "观看中"
              : "控制中"
            : connection === "connecting"
              ? "正在连接"
              : "连接断开"}
        </span>
        {state?.busy && (
          <span className="desktop-owner" title={state.owner_title}>
            {state.owner_title || "正在使用"}
          </span>
        )}
        <div className="toolbar-actions">
          <button
            className="icon-button"
            aria-label="重新连接"
            onClick={() => setRetry((value) => value + 1)}
          >
            <RefreshCw size={16} />
          </button>
          <button
            className="icon-button"
            aria-label={fit ? "原始大小" : "适应屏幕"}
            onClick={() => setFit((value) => !value)}
          >
            {fit ? <ZoomIn size={17} /> : <ZoomOut size={17} />}
          </button>
          {!fit && (
            <button
              className={`icon-button ${pan ? "is-active" : ""}`}
              aria-label="拖动视图"
              onClick={() => setPan((value) => !value)}
            >
              <Move size={17} />
            </button>
          )}
          {!standalone && <button
            className="icon-button"
            aria-label={full ? "退出全屏" : "全屏"}
            onClick={() => setFull((value) => !value)}
          >
            {full ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>}
        </div>
      </div>
      <div
        className={`desktop-screen ${fit ? "is-fitted" : ""} ${connection !== "connected" ? "is-connecting" : ""}`}
      >
        <div ref={host} className="desktop-host" />
        {connection === "connecting" && (
          <LoaderCircle className="desktop-loader spin" size={24} />
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="desktop-controls">
        <button
          className={state?.view_only ? "secondary-button" : "primary-button"}
          disabled={!busy && connection !== "connected"}
          onClick={() => void control()}
        >
          {state?.view_only ? <Hand size={16} /> : <Eye size={16} />}
          {busy ? <LoaderCircle size={15} className="spin" /> : null}
          {busy ? "取消等待" : state?.view_only ? "接管" : "停止接管"}
        </button>
        <div className="toolbar-actions">
          <button
            className="secondary-button"
            disabled={state?.view_only}
            onClick={() => keyboard.current?.focus()}
          >
            <Keyboard size={17} />
            键盘
          </button>
          <button
            className="secondary-button"
            disabled={state?.view_only}
            onClick={() => client.current?.sendKey(0xff1b)}
          >
            Esc
          </button>
          <button
            className="secondary-button"
            disabled={state?.view_only}
            onClick={() => client.current?.sendKey(0xff09)}
          >
            Tab
          </button>
          <button
            className="secondary-button"
            disabled={state?.view_only}
            onClick={() => client.current?.sendKey(0xff0d)}
          >
            Enter
          </button>
        </div>
      </div>
      <form
        className="desktop-input"
        onSubmit={(event) => {
          event.preventDefault();
          sendText(text);
          setText("");
        }}
      >
        <input
          ref={keyboard}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="输入文字"
          disabled={state?.view_only}
          aria-label="输入到电脑"
        />
        <button
          className="icon-button"
          disabled={state?.view_only || !text}
          aria-label="输入到电脑"
        >
          <Send size={17} />
        </button>
      </form>
    </>
  );
  return standalone ? (
    <main className="native-computer-page">{content}</main>
  ) : (
    <Modal title="电脑" onClose={onClose} size="preview" fullscreen={full} bodyClassName="computer-body">
      {content}
    </Modal>
  );
}
