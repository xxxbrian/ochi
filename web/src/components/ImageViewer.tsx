import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Popover } from "@base-ui/react/popover";
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Info,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { formatNumber, t, useI18n } from "../lib/i18n";
import { downloadUrl, fetchPrivate, sizeText } from "../lib/files";
import type { Artifact } from "../lib/types";

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const ms = (value: number) => (reducedMotion() ? 0 : value);
/** Motion durations come from the design tokens so every look and speed setting applies. */
const token = (n: 1 | 2 | 3 | 4) => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--dur-${n}`).trim();
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? (raw.endsWith("ms") ? value : value * 1000) : 300;
};

type Origin = { left: number; top: number; width: number; height: number };
type Engine = {
  go: (index: number, direction?: number, swipe?: boolean) => void;
  close: () => void;
  zoomBy: (factor: number) => void;
  reset: () => void;
};

export async function copyImageToClipboard(url: string) {
  const response = await fetchPrivate(url);
  let blob = await response.blob();
  if (blob.type !== "image/png") {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("encode"))), "image/png"),
    );
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

function ImageInfo({ image, dimensions }: { image: Artifact; dimensions: string }) {
  const generation = image.generation;
  const facts: [string, string][] = [
    [t("viewer.dimensions"), dimensions],
    [t("viewer.fileSize"), sizeText(image.size)],
  ];
  if (generation?.model_name) facts.push([t("viewer.model"), generation.model_name]);
  if (generation?.quality) facts.push([t("viewer.quality"), generation.quality]);
  if (generation?.output_format) facts.push([t("viewer.format"), generation.output_format.toUpperCase()]);
  return (
    <div className="pv-info">
      <Popover.Title render={<b />}>{image.name}</Popover.Title>
      {generation?.prompt && <p>{generation.prompt}</p>}
      {generation?.revised_prompt && generation.revised_prompt !== generation.prompt && <p>{generation.revised_prompt}</p>}
      <dl>
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="tnum">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Full-screen viewer for one or more images. Opens from (and returns to) the thumbnail with a
 * FLIP transition; wheel, pinch and double-click zoom, drag pans, dragging down at fit scale
 * dismisses, and horizontal swipes or arrow keys change image.
 */
export function ImageViewer({
  images,
  index,
  getOrigin,
  onClose,
}: {
  images: Artifact[];
  index: number;
  getOrigin: (index: number) => HTMLElement | null;
  onClose: () => void;
}) {
  useI18n();
  const count = images.length;
  const rootRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const latest = useRef({ images, getOrigin, onClose });
  latest.current = { images, getOrigin, onClose };
  const [current, setCurrent] = useState(clamp(index, 0, count - 1));
  const [phase, setPhase] = useState<"opening" | "open" | "closing">("opening");
  const [chrome, setChrome] = useState(true);
  const [percent, setPercent] = useState(100);
  const [zoomed, setZoomed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dimensions, setDimensions] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
  const infoOpenRef = useRef(false);
  infoOpenRef.current = infoOpen;
  const image = images[Math.min(current, count - 1)];

  useLayoutEffect(() => {
    const root = rootRef.current!;
    const backdrop = backdropRef.current!;
    const stage = stageRef.current!;
    const img = imageRef.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const st = {
      i: clamp(index, 0, count - 1),
      s: 1,
      tx: 0,
      ty: 0,
      closing: false,
      busy: false,
      ptrs: new Map<number, { x: number; y: number }>(),
    };
    let hidden: HTMLElement | null = null;
    let idle = 0;
    let lastTap = 0;
    let lastTouch = 0;
    let gesture: {
      mode: "pan" | "dismiss" | "swipe" | "pinch" | "done" | null;
      x0?: number;
      y0?: number;
      tx0: number;
      ty0: number;
      d0?: number;
      s0?: number;
      m0?: { x: number; y: number };
      hist?: [number, number, number][];
    } = { mode: null, tx0: 0, ty0: 0 };
    let alive = true;

    const natural = () => {
      const generation = latest.current.images[st.i].generation;
      return {
        w: img.naturalWidth || generation?.width || 4,
        h: img.naturalHeight || generation?.height || 3,
      };
    };
    const box = () => {
      const W = root.clientWidth;
      const H = root.clientHeight;
      const compact = W < 720;
      const top = 60;
      const bottom = compact ? 92 : 112;
      const side = compact ? 6 : 76;
      const nat = natural();
      const ratio = nat.w / nat.h;
      const availableW = W - side * 2;
      const availableH = H - top - bottom;
      let w = availableW;
      let h = w / ratio;
      if (h > availableH) {
        h = availableH;
        w = h * ratio;
      }
      return { W, H, w, h, cx: W / 2, cy: top + availableH / 2 };
    };
    const layout = () => {
      const f = box();
      Object.assign(img.style, {
        width: `${f.w}px`,
        height: `${f.h}px`,
        left: `${f.cx - f.w / 2}px`,
        top: `${f.cy - f.h / 2}px`,
      });
    };
    const bounds = () => {
      const f = box();
      const s = st.s;
      return {
        bx: f.w * s > f.W ? [f.W - f.cx - (f.w * s) / 2, (f.w * s) / 2 - f.cx] : [0, 0],
        by: f.h * s > f.H ? [f.H - f.cy - (f.h * s) / 2, (f.h * s) / 2 - f.cy] : [0, 0],
      };
    };
    const apply = (mode = "") => {
      img.dataset.t = reducedMotion() ? "" : mode;
      img.style.transform = `translate(${st.tx}px, ${st.ty}px) scale(${st.s})`;
      setPercent(Math.round(st.s * 100));
      setZoomed(st.s > 1.01);
    };
    const settle = (mode = "smooth") => {
      const { bx, by } = bounds();
      st.tx = clamp(st.tx, bx[0], bx[1]);
      st.ty = clamp(st.ty, by[0], by[1]);
      apply(mode);
    };
    const zoomAt = (px: number, py: number, next: number, mode = "smooth") => {
      next = clamp(next, 1, 8);
      const f = box();
      const k = next / st.s;
      st.tx = px - f.cx - (px - f.cx - st.tx) * k;
      st.ty = py - f.cy - (py - f.cy - st.ty) * k;
      st.s = next;
      settle(mode);
    };
    const zoomMid = (next: number) => {
      const f = box();
      zoomAt(f.cx, f.cy, next);
    };
    const rubber = (value: number, [low, high]: number[]) =>
      value < low ? low + (value - low) * 0.35 : value > high ? high + (value - high) * 0.35 : value;
    const reset = (mode = "smooth") => {
      st.s = 1;
      st.tx = st.ty = 0;
      apply(mode);
    };

    const originElement = (i: number) => {
      const el = latest.current.getOrigin(i);
      return el?.isConnected ? el : null;
    };
    const originRect = (): Origin | null => {
      const el = originElement(st.i);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
        ? { left: r.left, top: r.top, width: r.width, height: r.height }
        : null;
    };
    const hideOrigin = () => {
      if (hidden) hidden.style.opacity = "";
      hidden = originElement(st.i);
      if (hidden) hidden.style.opacity = "0";
    };
    const flip = (r: Origin, radius: number) => {
      const f = box();
      const sc = Math.max(r.width / f.w, r.height / f.h);
      const ix = Math.max(0, (f.w - r.width / sc) / 2);
      const iy = Math.max(0, (f.h - r.height / sc) / 2);
      return {
        transform: `translate(${r.left + r.width / 2 - f.cx}px, ${r.top + r.height / 2 - f.cy}px) scale(${sc})`,
        clipPath: `inset(${iy}px ${ix}px round ${radius / sc}px)`,
      };
    };
    const poke = () => {
      setChrome(true);
      clearTimeout(idle);
      idle = window.setTimeout(() => {
        if (st.closing || !alive) return;
        if (infoOpenRef.current || root.querySelector(".pv-chrome :is(button, a):hover, .pv-chrome :focus-visible")) poke();
        else setChrome(false);
      }, 2600);
    };
    const show = (next: number) => {
      st.i = next;
      setCurrent(next);
      img.src = latest.current.images[next].url;
      img.alt = latest.current.images[next].generation?.prompt || latest.current.images[next].name;
    };

    const go = async (next: number, direction = next > st.i ? 1 : -1, swipe = false) => {
      if (next < 0 || next >= count || st.busy || st.closing) {
        if (swipe) {
          st.tx = 0;
          apply("smooth");
        }
        return;
      }
      st.busy = true;
      const from = swipe ? st.tx : 0;
      st.tx = st.ty = 0;
      st.s = 1;
      apply("");
      const out = img.animate(
        [{ translate: `${from}px 0`, opacity: 1 }, { translate: `${-direction * 56}px 0`, opacity: 0 }],
        { duration: ms(token(2) * 0.7), easing: "ease-in", fill: "forwards" },
      );
      await out.finished.catch(() => undefined);
      if (!alive) return;
      show(next);
      layout();
      apply("");
      hideOrigin();
      await img.decode().catch(() => undefined);
      if (!alive) return;
      layout();
      const enter = img.animate(
        [{ translate: `${direction * 56}px 0`, opacity: 0 }, { translate: "0 0", opacity: 1 }],
        { duration: ms(token(3)), easing: EASE },
      );
      out.cancel();
      await enter.finished.catch(() => undefined);
      st.busy = false;
    };

    const close = async () => {
      if (st.closing) return;
      st.closing = true;
      clearTimeout(idle);
      setPhase("closing");
      setInfoOpen(false);
      document.removeEventListener("keydown", onKey, true);
      removeEventListener("resize", onResize);
      const origin = originRect();
      const now = `translate(${st.tx}px, ${st.ty}px) scale(${st.s})`;
      backdrop.animate(
        [{ opacity: Number.parseFloat(backdrop.style.opacity || "1") }, { opacity: 0 }],
        { duration: ms(token(3)), easing: "ease-out", fill: "forwards" },
      );
      const animation = origin
        ? img.animate([{ transform: now, clipPath: "inset(0px round 0px)" }, flip(origin, 10)], {
            duration: ms(token(4)),
            easing: EASE,
            fill: "forwards",
          })
        : img.animate(
            [{ transform: now, opacity: 1 }, { transform: `${now} scale(0.94)`, opacity: 0 }],
            { duration: ms(token(2)), easing: "ease-in", fill: "forwards" },
          );
      await animation.finished.catch(() => undefined);
      if (hidden) hidden.style.opacity = "";
      hidden = null;
      alive = false;
      latest.current.onClose();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };

    const focusables = () =>
      [...root.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]")].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented && event.key !== "Escape") return;
      if (event.key === "Escape") {
        if (infoOpenRef.current) return;
        void close();
      } else if (event.key === "Tab") {
        const list = focusables();
        if (!list.length) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (!root.contains(document.activeElement)) first.focus();
        else if (event.shiftKey && document.activeElement === first) last.focus();
        else if (!event.shiftKey && document.activeElement === last) first.focus();
        else {
          poke();
          return;
        }
      } else if (infoOpenRef.current) return;
      else if (event.key === "ArrowRight") void go(st.i + 1, 1);
      else if (event.key === "ArrowLeft") void go(st.i - 1, -1);
      else if (event.key === "+" || event.key === "=") zoomMid(st.s * 1.5);
      else if (event.key === "-") zoomMid(st.s / 1.5);
      else if (event.key === "0") reset();
      else return;
      event.preventDefault();
      poke();
    }
    function onResize() {
      layout();
      settle("");
    }
    document.addEventListener("keydown", onKey, true);
    addEventListener("resize", onResize);
    root.addEventListener("pointermove", poke);

    const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    const middle = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const down = (event: PointerEvent) => {
      if (event.button > 0 || st.busy || st.closing) return;
      stage.setPointerCapture(event.pointerId);
      st.ptrs.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (st.ptrs.size === 2) {
        const [a, b] = [...st.ptrs.values()];
        gesture = { mode: "pinch", d0: distance(a, b), s0: st.s, m0: middle(a, b), tx0: st.tx, ty0: st.ty };
      } else {
        gesture = {
          mode: null,
          x0: event.clientX,
          y0: event.clientY,
          tx0: st.tx,
          ty0: st.ty,
          hist: [[performance.now(), event.clientX, event.clientY]],
        };
      }
    };
    const move = (event: PointerEvent) => {
      const pointer = st.ptrs.get(event.pointerId);
      if (!pointer) return;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      if (gesture.mode === "pinch") {
        if (st.ptrs.size < 2) return;
        const [a, b] = [...st.ptrs.values()];
        const next = clamp((gesture.s0! * distance(a, b)) / gesture.d0!, 0.8, 8);
        const m = middle(a, b);
        const f = box();
        const k = next / gesture.s0!;
        st.tx = m.x - f.cx - (gesture.m0!.x - f.cx - gesture.tx0) * k;
        st.ty = m.y - f.cy - (gesture.m0!.y - f.cy - gesture.ty0) * k;
        st.s = next;
        apply();
        return;
      }
      if (gesture.mode === "done") return;
      const dx = event.clientX - gesture.x0!;
      const dy = event.clientY - gesture.y0!;
      gesture.hist!.push([performance.now(), event.clientX, event.clientY]);
      if (gesture.hist!.length > 5) gesture.hist!.shift();
      if (!gesture.mode) {
        if (Math.hypot(dx, dy) < 6) return;
        gesture.mode = st.s > 1.01 ? "pan" : Math.abs(dy) > Math.abs(dx) ? "dismiss" : "swipe";
        setDragging(true);
      }
      if (gesture.mode === "pan") {
        const { bx, by } = bounds();
        st.tx = rubber(gesture.tx0 + dx, bx);
        st.ty = rubber(gesture.ty0 + dy, by);
      } else if (gesture.mode === "dismiss") {
        st.ty = dy;
        st.tx = dx * 0.4;
        st.s = 1 - Math.min(Math.abs(dy) / 1200, 0.22);
        backdrop.style.opacity = String(1 - Math.min(Math.abs(dy) / (innerHeight * 0.5), 0.85));
        setChrome(false);
      } else if (gesture.mode === "swipe") {
        st.tx = dx * ((dx < 0 && st.i < count - 1) || (dx > 0 && st.i > 0) ? 1 : 0.25);
      }
      apply();
    };
    const end = (event: PointerEvent) => {
      if (!st.ptrs.delete(event.pointerId)) return;
      setDragging(false);
      if (event.pointerType === "touch") lastTouch = performance.now();
      if (gesture.mode === "pinch") {
        if (st.ptrs.size < 2) {
          gesture = { mode: "done", tx0: 0, ty0: 0 };
          if (st.s < 1) reset();
          else settle();
        }
        return;
      }
      const hist = gesture.hist ?? [];
      const a = hist[0];
      const b = hist[hist.length - 1];
      const vx = a && b && b[0] > a[0] ? (b[1] - a[1]) / (b[0] - a[0]) : 0;
      const vy = a && b && b[0] > a[0] ? (b[2] - a[2]) / (b[0] - a[0]) : 0;
      if (gesture.mode === "pan") settle();
      else if (gesture.mode === "dismiss") {
        if (Math.abs(st.ty) > 120 || Math.abs(vy) > 0.7) void close();
        else {
          backdrop.style.opacity = "";
          reset();
          poke();
        }
      } else if (gesture.mode === "swipe") {
        if (Math.abs(st.tx) > 80 || Math.abs(vx) > 0.6) void go(st.i + (st.tx < 0 ? 1 : -1), st.tx < 0 ? 1 : -1, true);
        else {
          st.tx = 0;
          apply("smooth");
        }
      } else if (!gesture.mode && event.pointerType === "touch") {
        const now = performance.now();
        if (now - lastTap < 300) {
          if (st.s > 1.05) reset();
          else zoomAt(event.clientX, event.clientY, 2.6);
          lastTap = 0;
        } else {
          lastTap = now;
          setChrome((value) => !value);
        }
      }
    };
    const doubleClick = (event: MouseEvent) => {
      if (performance.now() - lastTouch < 600) return;
      if (st.s > 1.05) reset();
      else zoomAt(event.clientX, event.clientY, 2.6);
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAt(event.clientX, event.clientY, st.s * Math.exp(-event.deltaY * (event.ctrlKey ? 0.012 : 0.0018)), "fast");
    };
    stage.addEventListener("pointerdown", down);
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    stage.addEventListener("dblclick", doubleClick);
    stage.addEventListener("wheel", wheel, { passive: false });
    engine.current = {
      go: (next, direction, swipe) => void go(next, direction, swipe),
      close: () => void close(),
      zoomBy: (factor) => zoomMid(st.s * factor),
      reset: () => reset(),
    };

    // Open: decode first so the FLIP starts from a fully painted frame.
    show(st.i);
    layout();
    apply("");
    void (async () => {
      await img.decode().catch(() => undefined);
      if (!alive || st.closing) return;
      layout();
      setDimensions(`${img.naturalWidth || natural().w} × ${img.naturalHeight || natural().h}`);
      const origin = originRect();
      hideOrigin();
      setPhase("open");
      poke();
      backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms(token(3)), easing: "ease-out" });
      if (origin)
        img.animate([flip(origin, 10), { transform: "translate(0, 0) scale(1)", clipPath: "inset(0px round 0px)" }], {
          duration: ms(token(4)),
          easing: EASE,
        });
      else
        img.animate([{ opacity: 0, transform: "scale(0.92)" }, { opacity: 1, transform: "scale(1)" }], {
          duration: ms(token(3)),
          easing: EASE,
        });
      root.focus({ preventScroll: true });
    })();
    const loaded = () => {
      layout();
      setDimensions(`${img.naturalWidth} × ${img.naturalHeight}`);
    };
    img.addEventListener("load", loaded);
    return () => {
      alive = false;
      clearTimeout(idle);
      document.removeEventListener("keydown", onKey, true);
      removeEventListener("resize", onResize);
      root.removeEventListener("pointermove", poke);
      stage.removeEventListener("pointerdown", down);
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerup", end);
      stage.removeEventListener("pointercancel", end);
      stage.removeEventListener("dblclick", doubleClick);
      stage.removeEventListener("wheel", wheel);
      img.removeEventListener("load", loaded);
      if (hidden) hidden.style.opacity = "";
      engine.current = null;
    };
    // The engine owns a stable image set for the lifetime of one open viewer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const strip = stripRef.current;
    const active = strip?.querySelector<HTMLElement>('[aria-current="true"]');
    if (strip && active)
      strip.scrollTo({
        left: active.offsetLeft - strip.clientWidth / 2 + active.offsetWidth / 2,
        behavior: reducedMotion() ? "auto" : "smooth",
      });
  }, [current]);
  useEffect(() => {
    if (copy === "idle") return;
    const timer = setTimeout(() => setCopy("idle"), 1400);
    return () => clearTimeout(timer);
  }, [copy]);

  const copyImage = useCallback(async () => {
    try {
      await copyImageToClipboard(image.url);
      setCopy("done");
    } catch {
      setCopy("failed");
    }
  }, [image.url]);

  const counter = t("viewer.counter", { current: formatNumber(current + 1), total: formatNumber(count) });
  const subtitle = [dimensions, sizeText(image.size)].filter(Boolean).join(" · ");
  const canCopy = typeof ClipboardItem !== "undefined" && Boolean(navigator.clipboard?.write);
  return createPortal(
    <div
      ref={rootRef}
      className="pv-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={t("viewer.label", { name: image.name })}
      tabIndex={-1}
      data-open={phase === "open" ? "true" : phase === "closing" ? "closing" : "false"}
      data-chrome={chrome}
      data-zoomed={zoomed}
      data-drag={dragging}
      data-n={count}
    >
      <div ref={backdropRef} className="pv-vbg" />
      <div ref={stageRef} className="pv-vstage">
        <img ref={imageRef} className="pv-vimg" alt="" draggable={false} />
      </div>
      <div className="pv-vtop pv-chrome">
        <div className="pv-vtitle">
          <b>{image.name}</b>
          <small>{subtitle}</small>
        </div>
        <span className="pv-count tnum" aria-live="polite">{counter}</span>
        <div className="pv-vacts">
          <Popover.Root open={infoOpen} onOpenChange={setInfoOpen}>
            <Popover.Trigger className="icon-btn" aria-label={t("viewer.info")}>
              <Info className="ic" />
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner className="pop-positioner" side="bottom" align="end" sideOffset={8} collisionPadding={8}>
                <Popover.Popup className="pop pv-infopop">
                  <ImageInfo image={image} dimensions={dimensions || "—"} />
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
          {canCopy && (
            <button
              type="button"
              className={`icon-btn${copy === "done" ? " flash" : ""}`}
              onClick={() => void copyImage()}
              aria-label={copy === "done" ? t("viewer.copied") : copy === "failed" ? t("viewer.copyFailed") : t("viewer.copyImage")}
            >
              {copy === "done" ? <Check className="ic" /> : copy === "failed" ? <AlertCircle className="ic" /> : <Copy className="ic" />}
            </button>
          )}
          <a className="icon-btn" href={downloadUrl(image)} download={image.name} aria-label={t("file.downloadName", { name: image.name })}>
            <Download className="ic" />
          </a>
          <button type="button" className="icon-btn" onClick={() => engine.current?.close()} aria-label={t("common.close")}>
            <X className="ic" />
          </button>
        </div>
      </div>
      <button type="button" className="pv-nav prev pv-chrome" onClick={() => engine.current?.go(current - 1, -1)} disabled={current === 0} aria-label={t("viewer.previous")}>
        <ChevronLeft className="ic" />
      </button>
      <button type="button" className="pv-nav next pv-chrome" onClick={() => engine.current?.go(current + 1, 1)} disabled={current === count - 1} aria-label={t("viewer.next")}>
        <ChevronRight className="ic" />
      </button>
      <div className="pv-vbot pv-chrome">
        <span className="pv-count mini tnum">{counter}</span>
        <div className="pv-strip" ref={stripRef}>
          {images.map((item, position) => (
            <button
              key={item.id}
              type="button"
              className="pv-sth"
              aria-current={position === current}
              aria-label={t("viewer.goTo", { n: formatNumber(position + 1) })}
              onClick={() => engine.current?.go(position)}
            >
              <img src={item.url} alt="" loading="lazy" draggable={false} />
            </button>
          ))}
        </div>
        <div className="pv-zoom">
          <button type="button" className="icon-btn sm" onClick={() => engine.current?.zoomBy(1 / 1.5)} aria-label={t("viewer.zoomOut")} disabled={percent <= 100}>
            <ZoomOut className="ic" />
          </button>
          <button type="button" className="pv-zl tnum" onClick={() => engine.current?.reset()} aria-label={t("viewer.resetZoom")}>
            {percent}%
          </button>
          <button type="button" className="icon-btn sm" onClick={() => engine.current?.zoomBy(1.5)} aria-label={t("viewer.zoomIn")} disabled={percent >= 800}>
            <ZoomIn className="ic" />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
