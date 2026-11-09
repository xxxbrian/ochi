import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { ArrowUp, Check, CircleAlert, CornerDownLeft, Copy, Download, FileArchive, Maximize2, Minimize2, RotateCw, X } from "lucide-react";
import { formatNumber, t, useI18n } from "../lib/i18n";
import {
  downloadUrl,
  fileKind,
  fileTypeLabel,
  nextSort,
  numericColumns,
  parseDelimited,
  sizeText,
  sortRows,
  splitLines,
  type SortState,
} from "../lib/files";
import { flavorOf, type Flavor } from "../lib/highlight";
import { toast } from "./ui/Toast";
import { useFileContent } from "../hooks/useFileContent";
import type { Artifact } from "../lib/types";
import { CodeView } from "./CodeView";
import { FileTile } from "./FileTile";
import { Segmented } from "./ui/Segmented";
import "./preview.css";

const MarkdownContent = lazy(() => import("./MarkdownContent"));
const PdfViewer = lazy(() => import("./PdfViewer").then((module) => ({ default: module.PdfViewer })));
const MAX_ROWS = 2000;
const LINE_WIDTHS = [62, 88, 74, 40, 92, 55, 80, 68, 30, 85, 72, 48];

type SkeletonKind = "pdf" | "markdown" | "text";

/** Placeholder that mirrors the loaded layout: text lines, or a page rail beside a page for PDFs. */
function Skeleton({ kind, leaving = false }: { kind: SkeletonKind; leaving?: boolean }) {
  return (
    <div className="pv-skel" data-gone={leaving || undefined} aria-hidden="true">
      {kind === "pdf" ? (
        <div className="pv-sk-pdf">
          <div className="pv-sk-rail">{[0, 1, 2].map((index) => <i key={index} className="skeleton" />)}</div>
          <div className="pv-sk-page skeleton" />
        </div>
      ) : (
        <div className="pv-sk-lines">
          {Array.from({ length: kind === "markdown" ? 12 : 16 }, (_, index) => (
            <i
              key={index}
              className="skeleton"
              style={{ width: `${LINE_WIDTHS[(index * 5) % 12]}%`, ...(kind === "markdown" && index % 5 === 0 ? { height: 20, marginTop: 10 } : null) }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Keeps a fading element mounted for `ms` after it stops being wanted. */
function useLinger(wanted: boolean, ms: number) {
  const [mounted, setMounted] = useState(wanted);
  useEffect(() => {
    if (wanted) return setMounted(true);
    const timer = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(timer);
  }, [wanted, ms]);
  return wanted || mounted;
}

/** Fades the pane in on the frame after it mounts, like the lab's pane[data-on]. */
function Pane({ children }: { children: React.ReactNode }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setOn(true)));
    return () => cancelAnimationFrame(id);
  }, []);
  return <div className="pv-pane" data-on={on || undefined}>{children}</div>;
}

const decimals = (value: string) => {
  const dot = value.indexOf(".");
  return dot < 0 ? 0 : Math.min(6, value.length - dot - 1);
};

function CsvTable({ text, delimiter, label }: { text: string; delimiter: string; label: string }) {
  const rows = useMemo(() => parseDelimited(text, delimiter), [text, delimiter]);
  const [sort, setSort] = useState<SortState>(null);
  const head = rows[0] ?? [];
  const body = useMemo(() => rows.slice(1), [rows]);
  const width = useMemo(() => body.reduce((max, row) => Math.max(max, row.length), head.length), [body, head]);
  const numbers = useMemo(() => numericColumns(body, width), [body, width]);
  const sorted = useMemo(() => sortRows(body, sort, numbers), [body, sort, numbers]);
  const shown = sorted.length > MAX_ROWS ? sorted.slice(0, MAX_ROWS) : sorted;
  const cell = (value: string | undefined, column: number) => {
    if (!numbers[column] || !value?.trim()) return value ?? "";
    const places = decimals(value.trim());
    return formatNumber(Number(value), { minimumFractionDigits: places, maximumFractionDigits: places });
  };
  return (
    <div className="pv-csv">
      <div className="pv-tw" tabIndex={0} role="region" aria-label={label}>
        <table className="pv-tbl">
          <thead>
            <tr>
              <th className="rn" scope="col"><span className="sr-only">#</span><span aria-hidden="true">#</span></th>
              {Array.from({ length: width }, (_, column) => (
                <th
                  key={column}
                  scope="col"
                  className={numbers[column] ? "num" : ""}
                  aria-sort={sort?.column === column ? (sort.direction === 1 ? "ascending" : "descending") : "none"}
                >
                  <button type="button" onClick={() => setSort((current) => nextSort(current, column))}>
                    {head[column] || `${column + 1}`}
                    <ArrowUp className="ic pv-arrow" aria-hidden="true" />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <tr key={index}>
                <td className="rn tnum">{index + 1}</td>
                {Array.from({ length: width }, (_, column) => (
                  <td key={column} className={numbers[column] ? "num tnum" : ""}>{cell(row[column], column)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pv-tfoot tnum">
        <span>{t("file.rowsColumns", { rows: formatNumber(sorted.length), columns: formatNumber(width) })}</span>
        {sorted.length > shown.length && <span>{t("file.rowsClipped", { count: formatNumber(shown.length) })}</span>}
        {sort && <span>{t(sort.direction === 1 ? "file.sortedAscending" : "file.sortedDescending", { column: head[sort.column] || `${sort.column + 1}` })}</span>}
      </div>
    </div>
  );
}

function Unsupported({ file }: { file: Artifact }) {
  const location = file.source_path || file.path;
  return (
    <div className="pv-center">
      <div className="pv-un-ic" data-tone="warn"><FileArchive className="ic" /></div>
      <h3>{file.name}</h3>
      <p>{t("file.unsupported")}</p>
      <dl className="pv-facts">
        <div><dt>{t("file.type")}</dt><dd>{fileTypeLabel(file)}</dd></div>
        <div><dt>{t("file.fileSize")}</dt><dd className="tnum">{sizeText(file.size)}</dd></div>
        {location && <div><dt>{t("file.location")}</dt><dd className="mono">{location}</dd></div>}
      </dl>
      <a className="btn primary" href={downloadUrl(file)} download={file.name}><Download className="ic" />{t("file.downloadFile")}</a>
      <small className="muted">{t("file.unsupportedNote")}</small>
    </div>
  );
}

function Failure({ file, message, onRetry }: { file: Artifact; message: string; onRetry: () => void }) {
  return (
    <div className="pv-center" role="alert">
      <div className="pv-un-ic" data-tone="danger"><CircleAlert className="ic" /></div>
      <h3>{t("file.previewError")}</h3>
      <p>{message}</p>
      <div className="pv-row">
        <button type="button" className="btn primary" onClick={onRetry}><RotateCw className="ic" />{t("common.retry")}</button>
        <a className="btn secondary" href={downloadUrl(file)} download={file.name}><Download className="ic" />{t("file.download")}</a>
      </div>
    </div>
  );
}

/** Modal (bottom sheet on phones) preview for code, Markdown, CSV, PDF and images; unsupported types offer a download. */
export function FilePreview({ file, onClose }: { file: Artifact; onClose: () => void }) {
  useI18n();
  const kind = fileKind(file);
  const textual = kind === "code" || kind === "markdown" || kind === "csv" || kind === "html" || kind === "svg";
  const needsBytes = textual || kind === "pdf";
  const { content, retry } = useFileContent(needsBytes ? file : null, kind === "pdf" ? "bytes" : "text");
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [wrap, setWrap] = useState(false);
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pdf, setPdf] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => setPdf("loading"), [content]);
  const ready = content.status === "ready" ? content : null;
  const loading = needsBytes && (content.status === "loading" || (kind === "pdf" && ready !== null && pdf === "loading"));
  const failed = needsBytes && (content.status === "error" || (kind === "pdf" && pdf === "error"));
  const skeleton = useLinger(loading, 320);
  const hasMode = kind === "markdown" || kind === "csv";
  const showSource = kind === "code" || kind === "html" || kind === "svg" || (hasMode && mode === "source");
  const text = ready?.text ?? "";
  const lines = useMemo(() => (textual && ready ? splitLines(ready.text).length : 0), [textual, ready]);
  const meta = [fileTypeLabel(file), sizeText(file.size), lines ? t("file.lineCount", { count: lines }) : ""].filter(Boolean).join(" · ");
  const flavor: Flavor = kind === "markdown" ? "markdown" : kind === "csv" ? "delimited" : kind === "html" || kind === "svg" ? "markup" : flavorOf(file.name);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast(t("file.copied"));
    } catch {
      setCopied(false);
    }
  };
  const pdfBytes = kind === "pdf" && ready ? ready.bytes : null;
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="scrim" />
        <Dialog.Popup className="modal pv-fm" data-full={full} aria-describedby={undefined}>
          <header className="pv-fh">
            <FileTile file={file} />
            <div className="pv-fh-t">
              <Dialog.Title render={<b />}>{file.name}</Dialog.Title>
              <small>{meta}</small>
            </div>
            <span className="grow" />
            {hasMode && (
              <Segmented
                className="pv-fseg"
                label={t("file.viewMode")}
                value={mode}
                onChange={setMode}
                options={[
                  { value: "preview", label: kind === "csv" ? t("file.table") : t("file.preview") },
                  { value: "source", label: t("file.source") },
                ]}
              />
            )}
            <button type="button" className="icon-btn pv-wrap" onClick={() => setWrap((value) => !value)} aria-pressed={wrap} aria-label={t("file.wrap")} title={t("file.wrap")} hidden={!(ready && showSource)}>
              <CornerDownLeft className="ic" />
            </button>
            <button type="button" className={`icon-btn pv-cp${copied ? " flash" : ""}`} onClick={() => void copy()} aria-label={t("file.copy")} title={t("file.copy")} hidden={!(ready && textual)}>
              {copied ? <Check className="ic" /> : <Copy className="ic" />}
            </button>
            <a className="icon-btn" href={downloadUrl(file)} download={file.name} aria-label={t("file.downloadName", { name: file.name })} title={t("file.download")}>
              <Download className="ic" />
            </a>
            <button type="button" className="icon-btn pv-full" onClick={() => setFull((value) => !value)} aria-pressed={full} aria-label={full ? t("common.exitFullscreen") : t("common.fullscreen")} title={full ? t("common.exitFullscreen") : t("common.fullscreen")}>
              {full ? <Minimize2 className="ic" /> : <Maximize2 className="ic" />}
            </button>
            <Dialog.Close className="icon-btn" aria-label={t("common.close")}>
              <X className="ic" />
            </Dialog.Close>
          </header>
          <div className="pv-fb">
            {(failed || !needsBytes || ready) && (
              <Pane key={`${kind}:${failed}`}>
                {failed ? (
                  <Failure file={file} message={content.status === "error" ? content.error : t("file.pdfError")} onRetry={() => { setPdf("loading"); retry(); }} />
                ) : kind === "pdf" && pdfBytes ? (
                  <Suspense fallback={null}>
                    <PdfViewer bytes={pdfBytes} name={file.name} onReady={() => setPdf("ready")} onError={() => setPdf("error")} />
                  </Suspense>
                ) : kind === "image" ? (
                  <div className="pv-imgv"><img src={file.url} alt={file.generation?.prompt || file.name} /></div>
                ) : kind === "binary" ? (
                  <Unsupported file={file} />
                ) : ready && showSource ? (
                  <>
                    <CodeView text={text} flavor={flavor} wrap={wrap} label={t("file.sourceOf", { name: file.name })} />
                    {ready.truncated && <p className="pv-note">{t("file.truncated")}</p>}
                  </>
                ) : ready && kind === "csv" ? (
                  <CsvTable text={text} delimiter={file.name.toLowerCase().endsWith(".tsv") ? "\t" : ","} label={t("file.tableOf", { name: file.name })} />
                ) : ready && kind === "markdown" ? (
                  <div className="pv-scroll" tabIndex={0}>
                    <div className="pv-md">
                      <Suspense fallback={<Skeleton kind="markdown" />}>
                        <MarkdownContent content={text} isStreaming={false} />
                      </Suspense>
                      {ready.truncated && <p className="pv-note">{t("file.truncated")}</p>}
                    </div>
                  </div>
                ) : null}
              </Pane>
            )}
            {skeleton && <Skeleton kind={kind === "pdf" ? "pdf" : kind === "markdown" ? "markdown" : "text"} leaving={!loading} />}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
