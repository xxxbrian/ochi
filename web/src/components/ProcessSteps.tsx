import { t, useI18n } from "../lib/i18n";
import {
  ChevronRight,
  CircleAlert,
  Download,
  ExternalLink,
  FileText,
  Globe2,
  ImagePlus,
  LoaderCircle,
  Monitor,
  Terminal,
  Wrench,
} from "lucide-react";
import { lazy, memo, Suspense, useMemo, useState } from "react";
import type { Artifact, Step } from "../lib/types";
import { browserNeedsUser, isToolFailure, parseSearchOutput, textArgument as textArg, toolInfo } from "../lib/processTimeline";
import { FileCards } from "./FileCards";
import { Modal } from "./Modal";
import { SearchResults, SearchSiteIcons } from "./SearchSources";
import "./execution.css";

const MarkdownContent = lazy(() => import("./MarkdownContent"));
function FileOutput({ content, path }: { content: string; path: string }) {
  useI18n();
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const language =
    (
      {
        py: "python",
        js: "javascript",
        ts: "typescript",
        sh: "bash",
        yml: "yaml",
        svg: "xml",
      } as Record<string, string>
    )[extension] ?? extension;
  const excerpt = content.slice(0, 18000);
  const fence = "`".repeat(
    (excerpt.match(/`+/g) ?? []).reduce(
      (length, value) => Math.max(length, value.length + 1),
      3,
    ),
  );
  return (
    <div className="step-file-content">
      <Suspense fallback={<pre>{excerpt}</pre>}>
        <MarkdownContent
          content={
            extension === "md" || extension === "markdown"
              ? excerpt
              : `${fence}${language}\n${excerpt}\n${fence}`
          }
          isStreaming={false}
        />
      </Suspense>
    </div>
  );
}

export function toolIcon(kind: string) {
  if (kind === "terminal") return <Terminal size={15} />;
  if (kind === "files") return <FileText size={15} />;
  if (kind === "browser") return <Globe2 size={15} />;
  if (kind === "computer") return <Monitor size={15} />;
  if (kind === "search") return <ExternalLink size={15} />;
  if (kind === "image") return <ImagePlus size={15} />;
  return <Wrench size={15} />;
}

function parseOutput(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed)
      ? { results: parsed }
      : parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
  } catch {
    return null;
  }
}

function StructuredOutput({
  result,
  filePath,
  needsUser,
}: {
  result: Record<string, unknown>;
  filePath?: string;
  needsUser: boolean;
}) {
  useI18n();
  const items =
    result.files ??
    result.entries ??
    result.tabs ??
    result.results ??
    result.sources ??
    result.links ??
    result.skills ??
    result.memories ??
    result.tools ??
    result.apps;
  const lists = items !== undefined
    ? [{ label: "", items }]
    : [
        { label: t("process.window"), items: result.windows },
        { label: t("process.element"), items: result.elements },
      ];
  const body =
    textArg(result, [
      "content",
      "text",
      "message",
      "error",
      "description",
      "instructions",
    ]) ||
    (Array.isArray(result.content)
      ? result.content
          .filter(
            (item) => item && typeof item === "object" && item.type === "text",
          )
          .map((item) => item.text)
          .join("\n")
      : "");
  const tab =
    result.tab && typeof result.tab === "object"
      ? (result.tab as Record<string, unknown>)
      : result;
  const url = textArg(tab, ["url"]);
  const title = textArg(tab, ["title", "name"]);
  const file =
    result.file && typeof result.file === "object"
      ? (result.file as Record<string, unknown>)
      : null;
  const hidden = new Set([
    "file",
    "tab",
    "files",
    "entries",
    "tabs",
    "results",
    "sources",
    "links",
    "skills",
    "memories",
    "tools",
    "apps",
    "windows",
    "elements",
    "automation",
    "needs_user",
    "blocked",
    "content",
    "text",
    "message",
    "error",
    "description",
    "instructions",
    "url",
    "title",
    "name",
    "image",
    "interactive",
  ]);
  const facts = Object.entries(result).filter(
    ([key, value]) =>
      !hidden.has(key) &&
      ["string", "number", "boolean"].includes(typeof value),
  );
  return (
    <div className="structured-output">
      {needsUser && <div className="browser-handoff">{t("process.verification")}</div>}
      {(url || title) && (
        <div className="browser-result">
          <Globe2 size={16} />
          <span>
            <strong>{title || url}</strong>
            {url && (
              <a href={url} target="_blank" rel="noreferrer">
                {url}
              </a>
            )}
          </span>
        </div>
      )}
      {file && (
        <div className="result-row result-file">
          <FileText size={16} />
          <span>{textArg(file, ["name", "path"])}</span>
          <Download size={14} />
        </div>
      )}
      {lists.map(({ label, items }, listIndex) => Array.isArray(items) && items.length > 0 && (
        <div className="result-list" key={listIndex}>
          {label && <div className="output-label">{label}</div>}
          {items.slice(0, 60).map((item, index) => {
            const row =
              item && typeof item === "object"
                ? (item as Record<string, unknown>)
                : { name: String(item) };
            const name =
              textArg(row, [
                "title",
                "name",
                "content",
                "path",
                "url",
                "text",
              ]) || `#${index + 1}`;
            const href = textArg(row, ["url"]);
            return (
              <div className="result-row" key={index}>
                {row.type === "directory" ? (
                  <FileText size={15} />
                ) : href ? (
                  <Globe2 size={15} />
                ) : (
                  <FileText size={15} />
                )}
                <span>
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer">
                      {name}
                    </a>
                  ) : (
                    name
                  )}
                  {typeof row.size === "number" && (
                    <small>{Math.round(row.size / 1024)} KB</small>
                  )}
                  {typeof row.prompt === "string" && (
                    <small className="result-prompt">{row.prompt}</small>
                  )}
                  {typeof row.description === "string" && (
                    <small className="result-prompt">{row.description}</small>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      ))}
      {body &&
        (filePath ? (
          <FileOutput content={body} path={filePath} />
        ) : (
          <pre>{body.slice(0, 18000)}</pre>
        ))}
      {facts.length > 0 && (
        <dl className="result-facts">
          {facts.map(([key, value]) => (
            <div key={key}>
              <dt>
                {(
                  {
                    path: t("file.title"),
                    bytes_written: t("file.writeSize"),
                    type: t("common.type"),
                    tab_id: t("browser.tabs"),
                    active: t("browser.currentPage"),
                    exit_code: t("process.exitStatus"),
                    truncated: t("process.partialOutput"),
                    cwd: t("file.directory"),
                    duration_ms: t("process.duration"),
                    stdout_path: t("process.fullOutput"),
                    stderr_path: t("process.stderr"),
                    mime_type: t("file.format"),
                    size: t("file.size"),
                    pages: t("file.pages"),
                    selected: t("browser.currentPage"),
                    bytes: t("file.size"),
                  } as Record<string, string>
                )[key] ?? key}
              </dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export const StepCard = memo(function StepCard({ step, expanded, onExpandedChange }: { step: Step; expanded?: boolean; onExpandedChange?: (id: string, expanded: boolean) => void }) {
  useI18n();
  const [localOpen, setOpen] = useState(false);
  const open = expanded ?? localOpen;
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const info = toolInfo(step.name);
  const needsUser = browserNeedsUser(step);
  const search = useMemo(() => parseSearchOutput(step), [step.name, step.arguments, step.output]);
  const args = step.arguments;
  const target =
    textArg(args, [
      "command",
      "cmd",
      "path",
      "url",
      "query",
      "text",
      "key",
      "id",
      "name",
      "ref",
      "selector",
      "reason",
      "prompt",
    ]) ||
    (typeof args?.x === "number" && typeof args?.y === "number"
      ? `${args.x}, ${args.y}`
      : Array.isArray(args?.paths)
        ? args.paths.join(", ")
        : "");
  const output = step.output?.trim() ?? "";
  const result = open ? parseOutput(output) : null;
  const command =
    info.kind === "terminal" ? textArg(args, ["command", "cmd"]) : "";
  const stdout = result
    ? textArg(result, ["stdout", "output", "content"])
    : output;
  const stderr = result ? textArg(result, ["stderr", "error"]) : "";
  const exitCode = result?.exit_code ?? args?.exit_code;
  const failed =
    isToolFailure(step) ||
    (typeof exitCode === "number" && exitCode !== 0);
  const published =
    step.name === "publish_file" && result && typeof result.url === "string"
      ? (result as unknown as Artifact)
      : null;
  const generated = step.name === "generate_image" && result?.artifact
    ? result.artifact as Artifact
    : null;
  return (
    <article className={`process-step process-step-${info.kind}`}>
      <span
        className={`step-indicator ${failed ? "failed" : step.status}`}
        aria-label={needsUser ? t("process.awaitingVerification") : step.status === "running" ? t("status.inProgress") : failed ? t("status.failed") : t("status.completed")}
      >
        {step.status === "running" ? (
          <LoaderCircle size={14} className="spin" />
        ) : failed ? (
          <CircleAlert size={14} />
        ) : (
          toolIcon(info.kind)
        )}
      </span>
      <div className={`step-content ${open ? "is-expanded" : ""}`}>
        <button
          className="step-summary"
          aria-expanded={open}
          onClick={() => { setOpen(!open); onExpandedChange?.(step.id, !open); }}
        >
          <span className="step-summary-text">
            <span className="step-name" title={info.label}>{info.label}</span>
            {target && (
              <span className="step-target" title={target}>
                {target}
              </span>
            )}
            {typeof exitCode === "number" && exitCode !== 0 && (
              <span className="step-exit bad">{t("process.exit")} {exitCode}</span>
            )}
            {search && <span className="search-summary-sites"><SearchSiteIcons results={search.results} /><span>{t("process.results", { count: search.results.length })}</span></span>}
            {needsUser && <span className="step-exit">{t("process.awaitingVerification")}</span>}
          </span>
          <ChevronRight size={14} className="step-chevron" />
        </button>
        {open && (
          <div className="step-details">
            {step.screenshot && (
              <button
                className="step-image-button"
                aria-label={t("process.viewScreenshot")}
                onClick={() => setImageOpen(true)}
              >
                <img
                  className="step-screenshot"
                  src={step.screenshot}
                  alt={t("process.result")}
                  loading="lazy"
                />
              </button>
            )}
            {step.name === "files_write" &&
              typeof args?.content === "string" && (
                <div className="step-output file-write-preview">
                  <div className="output-label">
                    {args.append ? t("process.addedContent") : t("file.content")}
                  </div>
                  <FileOutput
                    content={args.content}
                    path={textArg(args, ["path"])}
                  />
                </div>
              )}
            {info.kind === "terminal" && (command || stdout || stderr) && (
              <div className="step-output">
                <div className="output-label">
                  {command ? "$ " + command : t("process.output")}
                </div>
                {stdout && <pre>{stdout.slice(0, 32000)}</pre>}
                {stderr && (
                  <pre className="stderr">{stderr.slice(0, 16000)}</pre>
                )}
              </div>
            )}
            {published && <FileCards files={[published]} />}
            {generated && <FileCards files={[generated]} />}
            {search && <SearchResults results={search.results} />}
            {info.kind !== "terminal" && output && !published && !generated && !search && (
              <div className="step-output">
                {result ? (
                  <StructuredOutput
                    result={result}
                    needsUser={needsUser}
                    filePath={
                      step.name === "files_read"
                        ? textArg(args, ["path"])
                        : undefined
                    }
                  />
                ) : (
                  <pre>{output.slice(0, 32000)}</pre>
                )}
              </div>
            )}
            {(args || result) && (
              <details
                className="technical-details"
                onToggle={(event) => setTechnicalOpen(event.currentTarget.open)}
              >
                <summary>{t("process.technicalDetails")}</summary>
                {technicalOpen && (
                  <pre>
                    {JSON.stringify(
                      { arguments: args, result: result ?? output },
                      null,
                      2,
                    ).slice(0, 64000)}
                  </pre>
                )}
              </details>
            )}
          </div>
        )}
      </div>
      {imageOpen && step.screenshot && (
        <Modal
          title={t("process.screenshot")}
          onClose={() => setImageOpen(false)}
          wide
          fullscreen
        >
          <img
            className="process-image-full"
            src={step.screenshot}
            alt={t("process.result")}
          />
        </Modal>
      )}
    </article>
  );
});

export const StepList = memo(function StepList({ steps, expansion, onExpandedChange }: { steps: Step[]; expansion?: Record<string, boolean>; onExpandedChange?: (id: string, expanded: boolean) => void }) {
  useI18n();
  return (
    <div className="process-list">
      {steps.map((step) => (
        <StepCard step={step} key={step.id} expanded={expansion ? Boolean(expansion[step.id]) : undefined} onExpandedChange={onExpandedChange} />
      ))}
    </div>
  );
});

