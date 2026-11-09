import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ZoomIn, ZoomOut } from "lucide-react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { formatNumber, t, useI18n } from "../lib/i18n";

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const THUMB_W = 92;
const MIN_Z = 0.35;
const MAX_Z = 2.5;

/** Draws one page into a canvas whenever it is near the viewport; superseded renders are cancelled. */
const PageCanvas = memo(function PageCanvas({ page, scale, root }: { page: PDFPageProxy; scale: number; root: React.RefObject<HTMLElement | null> }) {
  const host = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") return setNear(true);
    const observer = new IntersectionObserver((entries) => setNear(entries.some((entry) => entry.isIntersecting)), { root: root.current, rootMargin: "600px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [root]);
  useEffect(() => {
    const canvas = host.current;
    if (!near || !canvas) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: scale * ratio });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) return;
    let task: RenderTask | undefined;
    task = page.render({ canvas, canvasContext: context, viewport });
    task.promise.catch(() => undefined);
    return () => task?.cancel();
  }, [near, page, scale]);
  return <canvas ref={host} aria-hidden="true" />;
});

type Dimensions = { w: number; h: number };

/** Lab PDF viewer: page rail, continuous pages, zoom bar and page counter, drawn with pdf.js onto canvas (never an iframe). */
export function PdfViewer({ bytes, name, onReady, onError }: { bytes: ArrayBuffer; name: string; onReady: () => void; onError: () => void }) {
  useI18n();
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<PDFPageProxy[]>([]);
  const [sizes, setSizes] = useState<Dimensions[]>([]);
  const [zoom, setZoom] = useState(1);
  const [renderZoom, setRenderZoom] = useState(1);
  const [fit, setFit] = useState(true);
  const [current, setCurrent] = useState(0);
  const [init, setInit] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLElement>(null);
  const latest = useRef({ onReady, onError });
  latest.current = { onReady, onError };

  useEffect(() => {
    let alive = true;
    let opened: PDFDocumentProxy | undefined;
    let task: ReturnType<typeof import("pdfjs-dist").getDocument> | undefined;
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        // pdf.js transfers the buffer to its worker; hand it a copy so a retry can reuse the bytes.
        task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), enableXfa: false });
        opened = await task.promise;
        const loaded = await Promise.all(Array.from({ length: opened.numPages }, (_, index) => opened!.getPage(index + 1)));
        if (!alive) return;
        setDoc(opened);
        setPages(loaded);
        setSizes(loaded.map((page) => ({ w: page.getViewport({ scale: 1 }).width, h: page.getViewport({ scale: 1 }).height })));
        latest.current.onReady();
      } catch {
        if (alive) latest.current.onError();
      }
    })();
    return () => {
      alive = false;
      void task?.destroy();
    };
  }, [bytes]);

  const fitZoom = useCallback(() => {
    const node = scroller.current;
    const first = sizes[0];
    return node && first ? clamp((node.clientWidth - 56) / first.w, MIN_Z, 1.5) : 1;
  }, [sizes]);
  const hold = useRef(0);
  // Keep the reading position while the page boxes resize under the scroll offset.
  const setZ = useCallback((next: number, fitting = false) => {
    const node = scroller.current;
    const ratio = node ? node.scrollTop / Math.max(1, node.scrollHeight) : 0;
    setFit(fitting);
    setZoom(clamp(next, MIN_Z, MAX_Z));
    if (!node) return;
    cancelAnimationFrame(hold.current);
    const started = performance.now();
    const keep = () => {
      node.scrollTop = ratio * node.scrollHeight;
      if (performance.now() - started < 340) hold.current = requestAnimationFrame(keep);
    };
    keep();
  }, []);
  useLayoutEffect(() => {
    if (!doc) return;
    setZoom(fitZoom());
    setRenderZoom(fitZoom());
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setInit(false)));
    return () => cancelAnimationFrame(id);
  }, [doc, fitZoom]);
  useEffect(() => {
    const timer = setTimeout(() => setRenderZoom(zoom), 140);
    return () => clearTimeout(timer);
  }, [zoom]);
  useEffect(() => {
    const node = scroller.current;
    if (!node || !doc) return;
    const observer = new ResizeObserver(() => {
      if (fit) setZoom(fitZoom());
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [doc, fit, fitZoom]);

  const onScroll = () => {
    const node = scroller.current;
    if (!node) return;
    const mark = node.scrollTop + node.clientHeight * 0.4;
    let index = 0;
    node.querySelectorAll<HTMLElement>(".pv-pgw").forEach((page, position) => {
      if (page.offsetTop <= mark) index = position;
    });
    setCurrent(index);
  };
  useEffect(() => {
    const active = rail.current?.querySelector<HTMLElement>('[aria-current="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [current]);
  const go = (index: number) => {
    const target = scroller.current?.querySelectorAll<HTMLElement>(".pv-pgw")[index];
    if (target && scroller.current) scroller.current.scrollTo({ top: target.offsetTop - 16, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  if (!doc) return null;
  return (
    <div className="pv-pdf" data-init={init || undefined} style={{ "--z": zoom } as CSSProperties}>
      <nav className="pv-rail" ref={rail} aria-label={name}>
        {pages.map((page, index) => (
          <button key={index} type="button" className="pv-rt" aria-current={index === current} aria-label={t("file.pageThumb", { n: formatNumber(index + 1) })} onClick={() => go(index)}>
            <span className="pv-rt-pg" style={{ height: `${Math.round((THUMB_W * sizes[index].h) / sizes[index].w)}px` }}>
              <PageCanvas page={page} scale={THUMB_W / sizes[index].w} root={rail} />
            </span>
            <small>{formatNumber(index + 1)}</small>
          </button>
        ))}
      </nav>
      <div className="pv-pdf-sc" ref={scroller} onScroll={onScroll} tabIndex={0} role="region" aria-label={name}>
        {pages.map((page, index) => (
          <div className="pv-pgw" key={index} style={{ "--pw": sizes[index].w, "--ph": sizes[index].h } as CSSProperties}>
            <PageCanvas page={page} scale={renderZoom} root={scroller} />
          </div>
        ))}
      </div>
      <div className="pv-pdf-bar">
        <button type="button" className="icon-btn sm" onClick={() => setZ(zoom / 1.2)} aria-label={t("viewer.zoomOut")}><ZoomOut className="ic" /></button>
        <span className="pv-pz tnum">{Math.round(zoom * 100)}%</span>
        <button type="button" className="icon-btn sm" onClick={() => setZ(zoom * 1.2)} aria-label={t("viewer.zoomIn")}><ZoomIn className="ic" /></button>
        <button type="button" className="pv-pfit" onClick={() => setZ(fitZoom(), true)}>{t("file.pdfFit")}</button>
        <i />
        <span className="pv-pi tnum" aria-live="polite">{t("file.pdfPosition", { current: formatNumber(current + 1), total: formatNumber(pages.length) })}</span>
      </div>
    </div>
  );
}
