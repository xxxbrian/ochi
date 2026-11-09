import { formatNumber, getLocale, t } from "./i18n";
import type { Artifact } from "./types";

export type FileKind =
  | "image"
  | "svg"
  | "html"
  | "markdown"
  | "csv"
  | "pdf"
  | "code"
  | "binary";

const languages: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  css: "css",
  scss: "scss",
  json: "json",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  html: "html",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  txt: "text",
  log: "text",
};

export function fileExtension(name: string) {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toLowerCase() : "";
}

export function fileKind(file: Pick<Artifact, "name" | "mime_type">): FileKind {
  const mime = file.mime_type.split(";")[0].trim().toLowerCase();
  const ext = fileExtension(file.name);
  if (ext === "svg" || mime === "image/svg+xml") return "svg";
  if (ext === "html" || ext === "htm" || mime === "text/html") return "html";
  if (ext === "md" || ext === "markdown" || /markdown/.test(mime)) return "markdown";
  if (ext === "csv" || ext === "tsv" || mime === "text/csv" || mime === "text/tab-separated-values") return "csv";
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (
    mime.startsWith("text/") ||
    /json|javascript|xml|yaml|toml|x-sh/.test(mime) ||
    ext in languages
  )
    return "code";
  return "binary";
}

export const isRasterImage = (file: Pick<Artifact, "name" | "mime_type">) => fileKind(file) === "image";
/** HTML and SVG artifacts open in the right-hand dock; everything else in a viewer or modal. */
export const opensInDock = (file: Pick<Artifact, "name" | "mime_type">) => {
  const kind = fileKind(file);
  return kind === "html" || kind === "svg";
};
export const fileLanguage = (name: string) => languages[fileExtension(name)] ?? "text";
export const fileTypeLabel = (file: Pick<Artifact, "name" | "mime_type">) => {
  const kind = fileKind(file);
  if (kind === "markdown") return "Markdown";
  if (kind === "csv") return fileExtension(file.name) === "tsv" ? "TSV" : "CSV";
  if (kind === "pdf") return "PDF";
  if (kind === "html") return "HTML";
  if (kind === "svg") return "SVG";
  const ext = fileExtension(file.name);
  if (kind === "code") return (ext || "text").toUpperCase();
  if (kind === "image") return (ext || file.mime_type.split("/")[1] || "image").toUpperCase();
  return (ext || file.mime_type.split("/").pop() || "file").toUpperCase();
};

export function sizeText(size: number) {
  const one = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  return size < 1024
    ? `${formatNumber(size)} B`
    : size < 1024 * 1024
      ? `${formatNumber(size / 1024, one)} KB`
      : `${formatNumber(size / 1024 / 1024, one)} MB`;
}

export function downloadUrl(file: Pick<Artifact, "url">) {
  return `${file.url}${file.url.includes("?") ? "&" : "?"}download=1`;
}

/** Bytes are private: only same-origin URLs are fetched, always with the session cookie and never a bearer header. */
export function isSameOrigin(url: string, base = typeof window === "undefined" ? "http://localhost/" : window.location.href) {
  try {
    return new URL(url, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}
export async function fetchPrivate(url: string, signal?: AbortSignal) {
  if (!isSameOrigin(url)) throw new Error(t("file.loadError"));
  const response = await fetch(url, {
    credentials: "include",
    headers: { "Accept-Language": getLocale() },
    signal,
  });
  if (!response.ok) throw new Error(t("file.loadError"));
  return response;
}

export const MAX_TEXT_CHARS = 1_000_000;
export const MAX_LINES = 5000;
export const MAX_HIGHLIGHT_CHARS = 150_000;

export function clipText(text: string) {
  return text.length > MAX_TEXT_CHARS
    ? { text: text.slice(0, MAX_TEXT_CHARS), truncated: true }
    : { text, truncated: false };
}
export function splitLines(text: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** RFC 4180 style parser with quoted fields, doubled quotes and embedded newlines. */
export function parseDelimited(text: string, delimiter = ",") {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += char;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

export type SortState = { column: number; direction: 1 | -1 } | null;
const numeric = /^-?\d+(?:\.\d+)?$/;
export function numericColumns(rows: string[][], width: number) {
  return Array.from({ length: width }, (_, column) => {
    let seen = false;
    for (const row of rows) {
      const value = row[column]?.trim() ?? "";
      if (value === "") continue;
      if (!numeric.test(value)) return false;
      seen = true;
    }
    return seen;
  });
}
export function sortRows(rows: string[][], sort: SortState, numbers: boolean[]) {
  if (!sort) return rows;
  const { column, direction } = sort;
  const collator = new Intl.Collator(getLocale(), { numeric: true });
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const left = a.row[column] ?? "";
      const right = b.row[column] ?? "";
      const result = numbers[column]
        ? (left.trim() === "" ? Number.NEGATIVE_INFINITY : Number(left)) -
            (right.trim() === "" ? Number.NEGATIVE_INFINITY : Number(right)) || 0
        : collator.compare(left, right);
      return result * direction || a.index - b.index;
    })
    .map((item) => item.row);
}
export function nextSort(current: SortState, column: number): SortState {
  if (!current || current.column !== column) return { column, direction: 1 };
  return current.direction === 1 ? { column, direction: -1 } : null;
}

/** Same logical file saved again gets a higher version; match them by their workspace source path. */
export function versionsOf(file: Artifact, all: Artifact[]) {
  const source = file.source_path;
  const items = source ? all.filter((item) => item.source_path === source) : [];
  if (!items.some((item) => item.id === file.id)) items.push(file);
  return items.sort((a, b) => (b.version ?? 0) - (a.version ?? 0) || b.created_at.localeCompare(a.created_at));
}

export function imageRatio(file: Artifact) {
  const width = file.generation?.width;
  const height = file.generation?.height;
  return width && height ? width / height : 0;
}
