import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronDown, CircleAlert, Copy, Download, Image as ImageIcon, LayoutDashboard, Maximize2, Minimize2, Monitor, RotateCw, ShieldCheck, Smartphone, Tablet, X, ZoomIn, ZoomOut } from "lucide-react";
import { getLocale, t, useI18n } from "../lib/i18n";
import { artifactVersions, closeArtifact, registerDockHost, themedDocument, useArtifactDock, useResolvedTheme, useSvgUrl } from "../lib/artifactDock";
import { downloadUrl, fileKind } from "../lib/files";
import { useFileContent } from "../hooks/useFileContent";
import type { Artifact } from "../lib/types";
import { CodeView } from "./CodeView";
import { Segmented } from "./ui/Segmented";
import { toast } from "./ui/Toast";
import "./preview.css";

type Device = "desktop" | "tablet" | "phone";
const devices: { value: Device; icon: typeof Monitor; label: "artifact.desktop" | "artifact.tablet" | "artifact.phone" }[] = [
  { value: "desktop", icon: Monitor, label: "artifact.desktop" },
  { value: "tablet", icon: Tablet, label: "artifact.tablet" },
  { value: "phone", icon: Smartphone, label: "artifact.phone" },
];
const MIN_WIDTH = 340;
const MAX_ZOOM = 6;
const CLOSE_MS = 600;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const formatDate = (value: string, options: Intl.DateTimeFormatOptions) => new Date(value).toLocaleString(getLocale(), options);

/** Skeleton shown over the frame until the document has painted. */
function Loading() {
  return (
    <div className="pv-load" aria-hidden="true">
      {[40, 90, 70, 55].map((width, index) => (
        <i key={index} className="skeleton" style={{ width: `${width}%`, "--i": index } as CSSProperties} />
      ))}
      <div className="pv-load-b">
        <i className="skeleton" />
        <i className="skeleton" />
        <i className="skeleton" />
      </div>
    </div>
  );
}

type DocumentRequest = { text: string };
type Layer = { key: number; request: DocumentRequest; on: boolean };

const transitionTime = (node: HTMLElement) => {
  const style = getComputedStyle(node);
  const ms = (value: string) => Number.parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000) || 0;
  const delays = style.transitionDelay.split(",").map(ms);
  return Math.max(0, ...style.transitionDuration.split(",").map((value, index) => ms(value) + delays[index % delays.length]));
};

/**
 * Sandboxed document layers. A new version or reload mounts a fresh iframe beside the old one and
 * cross-fades once it has loaded, so the preview never flashes empty. No same-origin privilege:
 * scripts run, but with an opaque origin and no access to the app, cookies or storage.
 */
export function HtmlFrames({ id, text, reload, title, onLoaded }: { id: string; text: string; reload: number; title: string; onLoaded: () => void }) {
  const theme = useResolvedTheme();
  const [layers, setLayers] = useState<Layer[]>([]);
  const request = useMemo(() => ({ text: themedDocument(text, theme) }), [id, text, reload, theme]);
  const latest = useRef(request);
  latest.current = request;
  const nextKey = useRef(0);
  const retireTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const key = ++nextKey.current;
    // Only the visible document survives while its newest replacement loads.
    setLayers((current) => [...current.filter((layer) => layer.on).slice(-1), { key, request, on: false }]);
    return () => window.clearTimeout(retireTimer.current);
  }, [request]);
  const settle = (layer: Layer, node: HTMLIFrameElement) => {
    if (latest.current !== layer.request) return;
    window.clearTimeout(retireTimer.current);
    setLayers((current) => current.map((item) => ({ ...item, on: item.request === layer.request })));
    onLoaded();
    retireTimer.current = window.setTimeout(() => {
      if (latest.current === layer.request) setLayers((current) => current.filter((item) => item.request === layer.request));
    }, transitionTime(node));
  };
  return (
    <>
      {layers.map((layer) => (
        <iframe
          key={layer.key}
          sandbox="allow-scripts"
          srcDoc={layer.request.text}
          title={title}
          data-on={layer.on || undefined}
          onLoad={(event) => settle(layer, event.currentTarget)}
        />
      ))}
    </>
  );
}

/** SVG renders as an image (scripts never run) with wheel/double-click zoom and drag pan. */
function SvgStage({ url, alt, reset, onLoaded, children }: { url: string; alt: string; reset: number; onLoaded: () => void; children?: React.ReactNode }) {
  const stage = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState({ s: 1, x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const [smooth, setSmooth] = useState(false);
  const [on, setOn] = useState(false);
  const live = useRef(zoom);
  live.current = zoom;
  useEffect(() => setZoom({ s: 1, x: 0, y: 0 }), [url, reset]);
  useEffect(() => setOn(false), [url, reset]);
  const zoomTo = useCallback((next: number, px = 0, py = 0, animate = true) => {
    const current = live.current;
    const s = clamp(next, 1, MAX_ZOOM);
    const k = s / current.s;
    setSmooth(animate);
    setZoom(s === 1 ? { s, x: 0, y: 0 } : { s, x: px - (px - current.x) * k, y: py - (py - current.y) * k });
  }, []);
  const offset = useCallback((event: { clientX: number; clientY: number }) => {
    const box = stage.current!.getBoundingClientRect();
    return [event.clientX - box.left - box.width / 2, event.clientY - box.top - box.height / 2] as const;
  }, []);
  useEffect(() => {
    const node = stage.current!;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomTo(live.current.s * Math.exp(-event.deltaY * 0.002), ...offset(event), false);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [zoomTo, offset]);
  const onPointerDown = (event: ReactPointerEvent) => {
    if (live.current.s === 1 || (event.target as HTMLElement).closest(".pv-zoombar")) return;
    const startX = event.clientX - live.current.x;
    const startY = event.clientY - live.current.y;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    setPanning(true);
    setSmooth(false);
    const move = (move: PointerEvent) => setZoom((value) => ({ ...value, x: move.clientX - startX, y: move.clientY - startY }));
    const up = () => {
      setPanning(false);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
  return (
    <>
      <div
        ref={stage}
        className="pv-svgstage"
        data-pan={panning}
        onPointerDown={onPointerDown}
        onDoubleClick={(event) => (zoom.s > 1 ? zoomTo(1) : zoomTo(2.4, ...offset(event)))}
      >
        <div className="pv-svgin" data-sm={smooth ? 1 : 0} style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})` }}>
          <img
            src={url}
            alt={alt}
            draggable={false}
            data-on={on || undefined}
            onLoad={() => {
              setOn(true);
              onLoaded();
            }}
          />
        </div>
      </div>
      <div className="pv-zoombar">
        <button type="button" className="icon-btn sm" onClick={() => zoomTo(zoom.s / 1.4)} aria-label={t("viewer.zoomOut")}><ZoomOut className="ic" /></button>
        <button type="button" className="pv-zl tnum" onClick={() => zoomTo(1)} aria-label={t("viewer.resetZoom")}>{Math.round(zoom.s * 100)}%</button>
        <button type="button" className="icon-btn sm" onClick={() => zoomTo(zoom.s * 1.4)} aria-label={t("viewer.zoomIn")}><ZoomIn className="ic" /></button>
      </div>
      {children}
    </>
  );
}

function DockContent({ file, versions, open, onClose }: { file: Artifact; versions: Artifact[]; open: boolean; onClose: () => void }) {
  useI18n();
  const [selected, setSelected] = useState(file.id);
  const [mode, setMode] = useState<"preview" | "code">("preview");
  const [device, setDevice] = useState<Device>("desktop");
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reload, setReload] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const [fullWidth, setFullWidth] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => setSelected(file.id), [file.id]);
  const current = versions.find((item) => item.id === selected) ?? file;
  useEffect(() => setLoaded(false), [selected, reload]);
  useEffect(() => {
    if (!spinning) return;
    const timer = setTimeout(() => setSpinning(false), 700);
    return () => clearTimeout(timer);
  }, [spinning]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  const svg = fileKind(current) === "svg";
  const { content, retry } = useFileContent(current, "text");
  const ready = content.status === "ready" ? content : null;
  const svgUrl = useSvgUrl(svg && ready ? ready.text : null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector("[role=dialog], [role=menu]")) return;
      event.preventDefault();
      if (full) setFull(false);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [full, onClose]);

  // Full screen widens the dock over the conversation, keeping the sidebar (lab behavior).
  useEffect(() => {
    if (!full) return setFullWidth(null);
    const dock = root.current;
    const shell = dock?.closest<HTMLElement>(".app-shell");
    const main = shell?.querySelector<HTMLElement>(".app-main");
    if (!dock || !main || !shell) return;
    const gap = Number.parseFloat(getComputedStyle(shell).columnGap) || 0;
    setFullWidth(dock.getBoundingClientRect().width + main.getBoundingClientRect().width + gap);
  }, [full]);

  const latest = versions[0]?.id;
  const label = current.version ? `v${current.version}` : "";
  const when = formatDate(current.created_at, { dateStyle: "medium", timeStyle: "short" });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ready?.text ?? "");
      setCopied(true);
      toast(t("file.copied"));
    } catch {
      setCopied(false);
    }
  };
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const host = root.current;
    if (!host) return;
    const right = host.getBoundingClientRect().right;
    const maxWidth = window.innerWidth * 0.7;
    event.preventDefault();
    setDragging(true);
    const move = (move: PointerEvent) => setWidth(clamp(right - move.clientX, MIN_WIDTH, maxWidth));
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const resizeByKey = (event: ReactKeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const base = root.current?.getBoundingClientRect().width ?? MIN_WIDTH;
    setWidth(clamp(base + (event.key === "ArrowLeft" ? 32 : -32), MIN_WIDTH, window.innerWidth * 0.7));
  };
  const Icon = svg ? ImageIcon : LayoutDashboard;
  const dockWidth = fullWidth ?? width;
  return (
    <div
      ref={root}
      className="artifact-dock"
      data-open={open}
      data-full={full}
      data-drag={dragging}
      style={dockWidth ? ({ "--dock-w": `${dockWidth}px` } as CSSProperties) : undefined}
    >
    <aside
      className="dock-in pv-art-dock"
      data-kind="artifact"
      data-mode={mode}
      data-dev={device}
      data-svg={svg}
      aria-label={t("artifact.label", { name: current.name })}
      aria-hidden={!open || undefined}
    >
      <div className="dock-grip" role="separator" aria-orientation="vertical" aria-label={t("artifact.resize")} tabIndex={0} onPointerDown={startResize} onKeyDown={resizeByKey} />
      <div className="dock-head">
        <div className="dock-title" title={current.name}>
          <Icon className="ic" aria-hidden="true" />
          <span>{current.name}</span>
        </div>
        <span className="grow" />
        {versions.length > 1 ? (
          <Menu.Root>
            <Menu.Trigger className="select-btn pv-ver" aria-label={t("artifact.versions")}>
              <span>{label || t("artifact.versions")}</span>
              <ChevronDown className="ic" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner className="pop-positioner" sideOffset={6} collisionPadding={8} align="end" side="bottom">
                <Menu.Popup className="pop">
                  <div className="menu" style={{ minWidth: 240 }}>
                    <div className="menu-label">{t("artifact.history")}</div>
                    <Menu.RadioGroup value={current.id} onValueChange={(value) => setSelected(String(value))}>
                    {versions.map((item) => (
                      <Menu.RadioItem key={item.id} value={item.id} className="menu-item rich">
                        <span className="mi-text">
                          <b style={{ fontWeight: 500 }}>
                            {item.version ? `v${item.version}` : formatDate(item.created_at, { dateStyle: "medium" })}
                            {item.id === latest && <em className="pv-latest">{t("artifact.latest")}</em>}
                          </b>
                          <small>{formatDate(item.created_at, { dateStyle: "medium", timeStyle: "short" })}</small>
                        </span>
                        <Check className="ic tick" aria-hidden="true" />
                      </Menu.RadioItem>
                    ))}
                    </Menu.RadioGroup>
                  </div>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        ) : label ? (
          <span className="select-btn pv-ver" data-static>{label}</span>
        ) : null}
        <Segmented
          className="pv-aseg"
          label={t("file.viewMode")}
          value={mode}
          onChange={setMode}
          options={[
            { value: "preview", label: t("file.preview") },
            { value: "code", label: t("artifact.code") },
          ]}
        />
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
          <X className="ic" />
        </button>
      </div>
      <div className="dock-body">
        <div className="pv-art">
          <div className="pv-abar">
            {!svg && (
              <Segmented
                className="pv-dseg"
                label={t("artifact.device")}
                value={device}
                onChange={setDevice}
                options={devices.map(({ value, icon: DeviceIcon, label: name }) => ({ value, title: t(name), label: <><DeviceIcon className="ic" /><span>{t(name)}</span></> }))}
              />
            )}
            <span className="grow" />
            <button
              type="button"
              className={`icon-btn pv-reload${spinning ? " is-spinning" : ""}`}
              onClick={() => {
                setReload((value) => value + 1);
                setSpinning(true);
                if (content.status === "error") retry();
              }}
              aria-label={t("artifact.reload")}
              title={t("artifact.reload")}
            >
              <RotateCw className="ic" />
            </button>
            <button type="button" className={`icon-btn${copied ? " flash" : ""}`} onClick={() => void copy()} disabled={!ready} aria-label={t("file.copy")} title={t("file.copy")}>
              {copied ? <Check className="ic" /> : <Copy className="ic" />}
            </button>
            <a className="icon-btn" href={downloadUrl(current)} download={current.name} aria-label={t("file.downloadName", { name: current.name })} title={t("artifact.download")}>
              <Download className="ic" />
            </a>
            <button type="button" className="icon-btn pv-fullbtn" onClick={() => setFull((value) => !value)} aria-pressed={full} aria-label={full ? t("common.exitFullscreen") : t("common.fullscreen")} title={full ? t("common.exitFullscreen") : t("common.fullscreen")}>
              {full ? <Minimize2 className="ic" /> : <Maximize2 className="ic" />}
            </button>
          </div>
          <div className="pv-stage">
            <div className="pv-view pv-pane2">
              <div className="pv-dev">
                <div className="pv-frame" data-loading={!loaded && content.status !== "error"}>
                  {content.status === "error" ? (
                    <div className="pv-center" role="alert">
                      <div className="pv-un-ic" data-tone="danger"><CircleAlert className="ic" /></div>
                      <p>{content.error}</p>
                      <button type="button" className="btn secondary" onClick={retry}><RotateCw className="ic" />{t("common.retry")}</button>
                    </div>
                  ) : (
                    <>
                      {ready && svg ? (
                        <SvgStage url={svgUrl} alt={current.name} reset={reload} onLoaded={() => setLoaded(true)} />
                      ) : ready ? (
                        <HtmlFrames id={current.id} text={ready.text} reload={reload} title={current.name} onLoaded={() => setLoaded(true)} />
                      ) : null}
                      <Loading />
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="pv-codepane pv-pane2">
              {ready ? <CodeView text={ready.text} flavor="markup" label={t("file.sourceOf", { name: current.name })} /> : null}
            </div>
          </div>
          <div className="pv-afoot">
            {svg ? <ImageIcon className="ic" aria-hidden="true" /> : <ShieldCheck className="ic" aria-hidden="true" />}
            <span>{svg ? t("artifact.svgNote") : t("artifact.sandboxNote")}</span>
            <span className="grow" />
            <span className="tnum pv-vlabel">{[label, when].filter(Boolean).join(" · ")}</span>
          </div>
        </div>
      </div>
    </aside>
    </div>
  );
}

/** Right-hand artifact panel. Mount once beside the chat; cards open files into it. */
export function ArtifactDock() {
  const { owner, file } = useArtifactDock();
  useEffect(() => registerDockHost(), []);
  // `shown` outlives the store value so the panel can slide shut before it unmounts.
  const [shown, setShown] = useState<{ owner: string; file: Artifact } | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (file && owner) {
      setShown({ owner, file });
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)));
      return () => cancelAnimationFrame(id);
    }
    setOpen(false);
    const timer = setTimeout(() => setShown(null), CLOSE_MS);
    return () => clearTimeout(timer);
  }, [owner, file]);
  if (!shown || shown.owner !== owner) return null;
  return <DockContent key={`${owner}:${shown.file.source_path || shown.file.id}`} file={shown.file} versions={artifactVersions(shown.file, owner)} open={open} onClose={closeArtifact} />;
}
