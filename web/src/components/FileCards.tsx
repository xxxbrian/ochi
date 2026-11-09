import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ArrowUpRight, Download, Eye, Image as ImageIcon, LayoutDashboard, Maximize2 } from "lucide-react";
import { formatNumber, t, useI18n } from "../lib/i18n";
import { downloadUrl, fileKind, fileTypeLabel, isRasterImage, opensInDock, sizeText } from "../lib/files";
import { hasDockHost, openArtifact, rememberArtifacts, themedDocument, useArtifactOwner, useResolvedTheme, useSvgUrl } from "../lib/artifactDock";
import { useFileContent } from "../hooks/useFileContent";
import type { Artifact } from "../lib/types";
import { FileTile } from "./FileTile";
import { FilePreview } from "./FilePreview";
import "./preview.css";

const ImageViewer = lazy(() => import("./ImageViewer").then((module) => ({ default: module.ImageViewer })));

export { downloadUrl, sizeText };

const MAX_TILES = 4;
const FRESH_MS = 8000;
const clampRatio = (value: number) => Math.min(1.6, Math.max(0.75, value));
const imageAlt = (file: Artifact) => file.generation?.prompt || file.name;

/** A tile still being generated: progress ring, shimmer label. The viewer skips these. */
export type PendingImage = { progress?: number };

function Ring({ progress }: { progress: number }) {
  return (
    <span className="pv-ring">
      <svg viewBox="0 0 44 44" aria-hidden="true">
        <circle cx="22" cy="22" r="18" className="bg" />
        <circle cx="22" cy="22" r="18" className="fg" pathLength="100" style={{ strokeDasharray: `${Math.round(progress * 100)} 100` }} />
      </svg>
      <b className="tnum">{Math.round(progress * 100)}</b>
    </span>
  );
}

/** One tile: blurs in once decoded, grows slightly on hover and is the FLIP origin of the viewer. */
function Thumb({ file, index, extra, onOpen, register, onNatural }: {
  file: Artifact;
  index: number;
  extra: number;
  onOpen: (index: number) => void;
  register: (index: number, element: HTMLElement | null) => void;
  onNatural?: (ratio: number) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const settle = useCallback((element: HTMLImageElement | null) => {
    if (element?.complete && element.naturalWidth) {
      setLoaded(true);
      onNatural?.(element.naturalWidth / element.naturalHeight);
    }
  }, [onNatural]);
  return (
    <button
      type="button"
      className="pv-th"
      style={{ "--i": index } as CSSProperties}
      ref={(element) => register(index, element)}
      onClick={() => onOpen(index)}
      aria-label={t("file.viewImage", { name: file.name })}
    >
      <img
        ref={settle}
        src={file.url}
        alt={imageAlt(file)}
        data-l={loaded || undefined}
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={(event) => {
          setLoaded(true);
          onNatural?.(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight);
        }}
      />
      {extra > 0 ? (
        <span className="pv-more" aria-hidden="true">+{formatNumber(extra)}</span>
      ) : (
        <span className="pv-th-ex" aria-hidden="true"><Maximize2 className="ic" /></span>
      )}
    </button>
  );
}

/** 1 / 2 / 3 / 4 tiles, then the fourth tile carries a "+N" count. Every finished tile opens the viewer. */
export function ImageGrid({ images, pending = [], onOpen, register }: {
  images: Artifact[];
  pending?: PendingImage[];
  onOpen: (index: number) => void;
  register: (index: number, element: HTMLElement | null) => void;
}) {
  useI18n();
  const total = images.length + pending.length;
  const shown = images.slice(0, MAX_TILES);
  const room = Math.max(0, MAX_TILES - shown.length);
  const placeholders = pending.slice(0, room);
  const extra = total - shown.length - placeholders.length;
  const [natural, setNatural] = useState<number>();
  const generation = images[0]?.generation;
  const single = total === 1;
  const ratio = single ? clampRatio(generation?.width && generation.height ? generation.width / generation.height : natural ?? 4 / 3) : undefined;
  return (
    <div className="pv-grid" data-n={Math.min(total, MAX_TILES)} style={ratio ? ({ "--ar": ratio } as CSSProperties) : undefined}>
      {shown.map((file, index) => (
        <Thumb
          key={file.id}
          file={file}
          index={index}
          extra={index === shown.length - 1 && !placeholders.length ? extra : 0}
          onOpen={onOpen}
          register={register}
          onNatural={single ? setNatural : undefined}
        />
      ))}
      {placeholders.map((item, offset) => (
        <div className="pv-th gen" key={`gen-${offset}`} style={{ "--i": shown.length + offset } as CSSProperties} role="status">
          <Ring progress={item.progress ?? 0.42} />
          <span className="pv-gen-l shimmer">{t("file.generating")}</span>
        </div>
      ))}
    </div>
  );
}

/** Lazily loaded live thumbnail: SVG as an image, HTML in the same opaque-origin sandbox as the dock. */
function Preview({ file }: { file: Artifact }) {
  const svg = fileKind(file) === "svg";
  const theme = useResolvedTheme();
  const { content } = useFileContent(file, "text");
  const text = content.status === "ready" ? content.text : null;
  const url = useSvgUrl(svg ? text : null);
  if (text === null) return <span className="pv-ac-load skeleton" aria-hidden="true" />;
  return svg ? (
    <img src={url} alt="" draggable={false} />
  ) : (
    <iframe sandbox="allow-scripts" tabIndex={-1} title="" srcDoc={themedDocument(text, theme)} />
  );
}

const keyActivate = (action: () => void) => (event: KeyboardEvent) => {
  if (event.target !== event.currentTarget) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
};

function ArtifactCard({ file, onOpen }: { file: Artifact; onOpen: () => void }) {
  const svg = fileKind(file) === "svg";
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = host.current;
    if (!node || visible) return;
    if (typeof IntersectionObserver === "undefined") return setVisible(true);
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "200px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);
  const Icon = svg ? ImageIcon : LayoutDashboard;
  // A card that appears right after the file was produced eases in with a glow; history stays still.
  const [fresh] = useState(() => Date.now() - Date.parse(file.created_at) < FRESH_MS);
  const meta = [t("artifact.kind", { type: fileTypeLabel(file) }), file.version ? `v${file.version}` : ""].filter(Boolean).join(" · ");
  return (
    <div
      className={`pv-ac${fresh ? " pv-ac-done" : ""}`}
      data-state="ready"
      role="button"
      tabIndex={0}
      aria-label={t("artifact.openName", { name: file.name })}
      onClick={onOpen}
      onKeyDown={keyActivate(onOpen)}
    >
      <div className="pv-ac-thumb" ref={host} data-kind={svg ? "svg" : "html"}>
        {visible ? <Preview file={file} /> : <span className="pv-ac-load skeleton" aria-hidden="true" />}
        <span className="pv-ac-hint"><ArrowUpRight className="ic" />{t("artifact.openSide")}</span>
      </div>
      <div className="pv-ac-body">
        <span className="pv-ac-ic"><Icon className="ic" /></span>
        <div className="pv-ac-t">
          <b>{file.name}</b>
          <small>{meta}</small>
        </div>
        <span className="btn sm secondary" aria-hidden="true">{t("artifact.open")}</span>
      </div>
    </div>
  );
}

/** Card shown while a file is being produced, or after the run was cancelled before it was saved. */
export function ArtifactPlaceholder({ name, state, onCancel }: {
  name?: string;
  state: "building" | "cancelled";
  onCancel?: () => void;
}) {
  useI18n();
  const building = state === "building";
  return (
    <div className="pv-ac" data-state={state} role={building ? "status" : undefined}>
      <div className="pv-ac-thumb">
        <div className="pv-bl" aria-hidden="true">
          {[46, 82, 64, 90, 38, 70, 54].map((width, index) => (
            <i key={index} className="skeleton" style={{ width: `${width}%`, "--i": index } as CSSProperties} />
          ))}
        </div>
      </div>
      <div className="pv-ac-body">
        <span className="pv-ac-ic"><LayoutDashboard className="ic" /></span>
        <div className="pv-ac-t">
          <b>{name || t("artifact.untitled")}</b>
          <small className={building ? "shimmer" : ""}>{building ? t("artifact.building") : t("artifact.cancelled")}</small>
        </div>
        {building && onCancel && <button type="button" className="btn sm ghost" onClick={onCancel}>{t("common.cancel")}</button>}
      </div>
      {building && <i className="pv-prog" aria-hidden="true" />}
    </div>
  );
}

function FileCard({ file, index, onOpen }: { file: Artifact; index: number; onOpen: () => void }) {
  const meta = [fileTypeLabel(file), sizeText(file.size)].join(" · ");
  return (
    <div
      className="pv-fc"
      style={{ "--i": index } as CSSProperties}
      role="button"
      tabIndex={0}
      aria-label={t("file.preview") + " " + file.name}
      onClick={onOpen}
      onKeyDown={keyActivate(onOpen)}
    >
      <FileTile file={file} />
      <span className="pv-fi">
        <b>{file.name}</b>
        <small>{meta}</small>
      </span>
      <span className="pv-fa">
        <button type="button" className="icon-btn sm" onClick={(event) => { event.stopPropagation(); onOpen(); }} aria-label={t("file.preview")} title={t("file.preview")}>
          <Eye className="ic" />
        </button>
        <a className="icon-btn sm" href={downloadUrl(file)} download={file.name} onClick={(event) => event.stopPropagation()} aria-label={t("file.downloadName", { name: file.name })} title={t("file.download")}>
          <Download className="ic" />
        </a>
      </span>
    </div>
  );
}

function FileChip({ file, index, onOpen }: { file: Artifact; index: number; onOpen: () => void }) {
  return (
    <button type="button" className="pv-chip" style={{ "--i": index } as CSSProperties} onClick={onOpen} aria-label={t("file.preview") + " " + file.name}>
      <FileTile file={file} small />
      <span className="pv-fn">{file.name}</span>
      <small>{sizeText(file.size)}</small>
    </button>
  );
}

type Row = { kind: "files"; files: Artifact[] } | { kind: "artifact"; file: Artifact };

/** Ordered rows: consecutive plain files share one wrapping row, artifacts are standalone cards. */
function rowsOf(files: Artifact[], artifactCards: boolean): Row[] {
  const rows: Row[] = [];
  for (const file of files) {
    if (artifactCards && opensInDock(file)) rows.push({ kind: "artifact", file });
    else {
      const last = rows[rows.length - 1];
      if (last?.kind === "files") last.files.push(file);
      else rows.push({ kind: "files", files: [file] });
    }
  }
  return rows;
}

export const FileCards = memo(function FileCards({
  files,
  variant = "artifact",
  compactImages = false,
  pendingImages,
}: {
  files?: Artifact[];
  variant?: "artifact" | "attachment";
  /** Embedded files render as inline chips and images stay chips instead of a gallery. */
  compactImages?: boolean;
  pendingImages?: PendingImage[];
}) {
  useI18n();
  const owner = useArtifactOwner();
  const [preview, setPreview] = useState<Artifact | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const origins = useRef(new Map<number, HTMLElement>());
  const { gallery, rows } = useMemo(() => {
    const list = files ?? [];
    return {
      gallery: list.filter(isRasterImage),
      rows: rowsOf(compactImages ? list : list.filter((file) => !isRasterImage(file)), variant === "artifact" && !compactImages),
    };
  }, [files, compactImages, variant]);
  useEffect(() => rememberArtifacts((files ?? []).filter(opensInDock), owner), [files, owner]);
  const register = useCallback((index: number, element: HTMLElement | null) => {
    if (element) origins.current.set(index, element);
    else origins.current.delete(index);
  }, []);
  if (!files?.length && !pendingImages?.length) return null;
  const openFile = (file: Artifact) => {
    if (isRasterImage(file)) setViewer(Math.max(0, gallery.findIndex((item) => item.id === file.id)));
    else if (opensInDock(file) && hasDockHost()) openArtifact(file, owner);
    else setPreview(file);
  };
  let chipIndex = 0;
  return (
    <>
      {!compactImages && (gallery.length > 0 || (pendingImages?.length ?? 0) > 0) && (
        <ImageGrid images={gallery} pending={pendingImages} onOpen={setViewer} register={register} />
      )}
      {rows.map((row, position) =>
        row.kind === "artifact" ? (
          <ArtifactCard key={row.file.id} file={row.file} onOpen={() => openFile(row.file)} />
        ) : (
          <div className="pv-files" data-v={compactImages ? "chip" : "card"} key={`files-${position}`}>
            {row.files.map((file) => {
              const index = chipIndex++;
              return compactImages ? (
                <FileChip key={file.id} file={file} index={index} onOpen={() => openFile(file)} />
              ) : (
                <FileCard key={file.id} file={file} index={index} onOpen={() => openFile(file)} />
              );
            })}
          </div>
        ),
      )}
      {viewer !== null && (
        <Suspense fallback={null}>
          <ImageViewer
            images={gallery}
            index={viewer}
            getOrigin={(index) => origins.current.get(Math.min(index, MAX_TILES - 1)) ?? null}
            onClose={() => setViewer(null)}
          />
        </Suspense>
      )}
      {preview && <FilePreview file={preview} onClose={() => setPreview(null)} />}
    </>
  );
});
