import { lazy, memo, Suspense, useEffect, useState } from "react";
import {
  Code2,
  Download,
  FileText,
  Image,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Play,
} from "lucide-react";
import type { Artifact } from "../lib/types";
import { Modal } from "./Modal";
import "./message-files.css";
const MarkdownContent = lazy(() => import("./MarkdownContent"));

export function sizeText(size: number) {
  return size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;
}
export function downloadUrl(file: Artifact) {
  return `${file.url}${file.url.includes("?") ? "&" : "?"}download=1`;
}
const extensions: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  py: "python",
  go: "go",
  rs: "rust",
  sh: "bash",
  css: "css",
  json: "json",
  html: "html",
  svg: "xml",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
};
function previewType(file: Artifact) {
  if (/\.svg$/i.test(file.name) || /image\/svg/.test(file.mime_type))
    return "svg";
  if (
    /\.html?$/i.test(file.name) ||
    /text\/html/.test(file.mime_type)
  )
    return "html";
  if (/\.(md|markdown)$/i.test(file.name) || /markdown/.test(file.mime_type))
    return "markdown";
  if (/^image\//.test(file.mime_type)) return "image";
  if (/pdf/.test(file.mime_type)) return "pdf";
  if (
    /^text\/|json|javascript|xml/.test(file.mime_type) ||
    file.name.split(".").pop()! in extensions
  )
    return "code";
  return "binary";
}

export function ArtifactPreview({
  file,
  onClose,
}: {
  file: Artifact;
  onClose: () => void;
}) {
  const type = previewType(file);
  const [source, setSource] = useState("");
  const [loading, setLoading] = useState(
    ["html", "svg", "markdown", "code"].includes(type),
  );
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [fullscreen, setFullscreen] = useState(false);
  const [imageRatio, setImageRatio] = useState(
    file.generation?.width && file.generation.height
      ? file.generation.width / file.generation.height
      : 1,
  );
  const imagePreview = (type === "image" || type === "svg") && mode === "preview";
  useEffect(() => {
    if (!["html", "svg", "markdown", "code"].includes(type)) return;
    const controller = new AbortController();
    setLoading(true);
    void fetch(file.url, { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("无法加载文件");
        const bytes = await response.arrayBuffer();
        return new TextDecoder("utf-8").decode(bytes);
      })
      .then(setSource)
      .catch((reason: Error) => {
        if (reason.name !== "AbortError") setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [file.url, type]);
  const language =
    extensions[file.name.split(".").pop()?.toLowerCase() ?? ""] ?? "text";
  const fence = "`".repeat(
    (source.match(/`+/g) ?? []).reduce(
      (length, match) => Math.max(length, match.length + 1),
      3,
    ),
  );
  return (
    <Modal title={file.name} onClose={onClose} size="preview" fullscreen={fullscreen} bodyClassName={`preview-body ${imagePreview ? "image-preview-body" : ""}`}>
      <div className="preview-toolbar">
        {["html", "svg", "markdown", "code"].includes(type) && <div className="segmented-control">
          {["html", "svg", "markdown"].includes(type) && (
            <button
              className={mode === "preview" ? "selected" : ""}
              onClick={() => setMode("preview")}
            >
              {type === "html" || type === "svg" ? <Play size={15} /> : <FileText size={15} />}
              预览
            </button>
          )}
          {["html", "svg", "markdown", "code"].includes(type) && (
            <button
              className={mode === "source" || type === "code" ? "selected" : ""}
              onClick={() => setMode("source")}
            >
              <Code2 size={15} />
              源码
            </button>
          )}
        </div>}
        <div className="toolbar-actions">
          {file.version && <span className="date-meta">v{file.version}</span>}
          <button
            className="icon-button"
            onClick={() => setFullscreen((value) => !value)}
            aria-label={fullscreen ? "退出全屏" : "全屏"}
          >
            {fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
          <a
            className="icon-button"
            href={downloadUrl(file)}
            download={file.name}
            aria-label="下载"
          >
            <Download size={17} />
          </a>
        </div>
      </div>
      <div className={`artifact-preview artifact-${type}`} style={imagePreview && !fullscreen ? { aspectRatio: imageRatio } : undefined}>
        {loading ? (
          <div className="panel-loading">
            <LoaderCircle className="spin" size={22} />
          </div>
        ) : error ? (
          <div className="form-error">{error}</div>
        ) : type === "html" && mode === "preview" ? (
          <iframe
            srcDoc={source}
            title={file.name}
            sandbox="allow-scripts allow-downloads"
          />
        ) : mode === "source" || type === "code" ? (
          <Suspense fallback={<pre>{source}</pre>}>
            <MarkdownContent
              content={`${fence}${language}\n${source}\n${fence}`}
              isStreaming={false}
            />
          </Suspense>
        ) : type === "markdown" ? (
          <Suspense fallback={<pre>{source}</pre>}>
            <MarkdownContent content={source} isStreaming={false} />
          </Suspense>
        ) : type === "image" || type === "svg" ? (
          <img
            src={file.url}
            alt={file.generation?.prompt || file.name}
            onLoad={({ currentTarget }) => {
              if (currentTarget.naturalWidth && currentTarget.naturalHeight)
                setImageRatio(currentTarget.naturalWidth / currentTarget.naturalHeight);
            }}
          />
        ) : type === "pdf" ? (
          <iframe src={file.url} title={file.name} />
        ) : (
          <div className="file-preview-fallback">
            <FileText size={38} />
            <a
              className="primary-button"
              href={downloadUrl(file)}
              download={file.name}
            >
              <Download size={16} />
              下载文件
            </a>
          </div>
        )}
      </div>
      {file.generation && (
        <details className="generation-details">
          <summary>{file.generation.model_name || "图片详情"}</summary>
          <p>{file.generation.prompt}</p>
          {file.generation.revised_prompt && file.generation.revised_prompt !== file.generation.prompt && <p>{file.generation.revised_prompt}</p>}
          <span>{[file.generation.size, file.generation.quality, file.generation.output_format?.toUpperCase()].filter(Boolean).join(" · ")}</span>
        </details>
      )}
    </Modal>
  );
}
export const FileCards = memo(function FileCards({
  files,
  variant = "artifact",
  compactImages = false,
}: {
  files?: Artifact[];
  variant?: "artifact" | "attachment";
  compactImages?: boolean;
}) {
  const [preview, setPreview] = useState<Artifact | null>(null);
  if (!files?.length) return null;
  return (
    <>
      <div className={`file-cards ${variant === "attachment" ? "attachment-cards" : "artifact-cards"}`}>
        {files.map((file) => file.mime_type.startsWith("image/") && !compactImages ? (
          <div className={`message-image${file.generation ? " generated-image" : ""}`} key={file.id}>
            <button className="message-image-open" onClick={() => setPreview(file)} aria-label={`查看图片 ${file.name}`}>
              <img src={file.url} alt={file.generation?.prompt || file.name} loading="lazy" decoding="async" width={file.generation?.width} height={file.generation?.height} />
            </button>
            <a className="icon-button image-download" href={downloadUrl(file)} download={file.name} aria-label={`下载 ${file.name}`}>
              <Download size={16} />
            </a>
          </div>
        ) : (
          <div className={`file-card file-card-${previewType(file)} ${["html", "svg"].includes(previewType(file)) ? "interactive-file-card" : ""}`} key={file.id}>
            <button className="file-open" onClick={() => setPreview(file)}>
              {["html", "svg"].includes(previewType(file)) ? (
                <Code2 size={21} />
              ) : file.mime_type.startsWith("image/") ? (
                <Image size={21} />
              ) : (
                <FileText size={21} />
              )}
              <span>
                <strong>{file.name}</strong>
                <small>
                  {["html", "svg"].includes(previewType(file)) ? `${previewType(file).toUpperCase()} · ${sizeText(file.size)}` : sizeText(file.size)}
                  {variant === "artifact" && file.version && file.version > 1 ? ` · v${file.version}` : ""}
                </small>
              </span>
            </button>
            <a
              className="icon-button"
              href={downloadUrl(file)}
              download={file.name}
              aria-label={`下载 ${file.name}`}
            >
              <Download size={17} />
            </a>
          </div>
        ))}
      </div>
      {preview && (
        <ArtifactPreview file={preview} onClose={() => setPreview(null)} />
      )}
    </>
  );
});
