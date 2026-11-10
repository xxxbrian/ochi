import { t, useI18n } from "../lib/i18n";
import { Check, CircleAlert, Copy, FileText, Folder, Globe2, Lock, LockKeyhole, Sparkles, CornerDownRight } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Artifact, Step } from "../lib/types";
import { formatStepDuration, parseSearchOutput, textArgument as textArg, toolSubject, type ToolFamily } from "../lib/processTimeline";
import { flavorOf, highlightLines } from "../lib/highlight";
import { useStickToEnd } from "../hooks/useStickToEnd";
import { ArtifactPlaceholder, FileCards } from "./FileCards";
import { Favicon, SearchResults } from "./SearchSources";
import { Modal } from "./Modal";
import { computerStepPart } from "./ComputerSteps";
import type { ComputerQueueProgress } from "../../../shared/conversation/computerQueue";

/* Tool bodies: the expanded content of one tool step (Design Lab process.js bodyFor). One body per tool shape. */

function parseOutput(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? { results: parsed } : parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const lineTone = (line: string) => /^\s*✓/.test(line) ? "ok" : /FAILED|Error|error:|✗/.test(line) ? "bad" : /^\s*[#$]/.test(line) ? "dim" : undefined;

function CopyButton({ text }: { text: string }) {
  useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button className={`icon-btn sm${copied ? " flash" : ""}`} aria-label={t("process.copyCommand")} title={t("process.copyCommand")}
      onClick={() => { navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {}); }}>
      {copied ? <Check className="ic" /> : <Copy className="ic" />}
    </button>
  );
}

function OutputLines({ text, stderr = false }: { text: string; stderr?: boolean }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  if (lines.length > 1500) return <>{text}</>;
  return <>{lines.map((line, index) => (
    <span key={index} className={(stderr ? "bad" : lineTone(line)) || undefined}>{line}{index < lines.length - 1 ? "\n" : ""}</span>
  ))}</>;
}

function Terminal({ command, stdout, stderr, exitCode, running, duration }: {
  command: string; stdout: string; stderr: string; exitCode?: number; running: boolean; duration?: number;
}) {
  useI18n();
  const out = useRef<HTMLPreElement>(null);
  const body = stdout.slice(0, 32000);
  useStickToEnd(out, body + stderr.length, running);
  return (
    <div className="tb-term">
      {command ? <div className="tb-cmd"><span className="prompt" aria-hidden="true">$</span><code title={command}>{command}</code><CopyButton text={command} /></div> : null}
      {body || stderr || running ? (
        <pre className="tb-out mono" ref={out} tabIndex={0}>
          <OutputLines text={body} />
          {stderr ? <OutputLines text={stderr.slice(0, 16000)} stderr /> : null}
          {running ? <span className="caret sm" aria-hidden="true" /> : null}
        </pre>
      ) : null}
      {!running && (typeof exitCode === "number" || duration !== undefined) ? (
        <div className="tb-foot">
          {typeof exitCode === "number"
            ? <span className="pill" data-tone={exitCode ? "danger" : "success"}>{exitCode ? <CircleAlert className="ic" /> : <Check className="ic" />}{t("process.exit")} {exitCode}</span>
            : <span />}
          {duration !== undefined ? <span className="muted tnum">{formatStepDuration(duration)}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function PathChip({ path }: { path: string }) {
  return path ? <span className="tb-path"><FileText className="ic" aria-hidden="true" /><span className="mono">{path}</span></span> : null;
}

function Code({ text, path }: { text: string; path: string }) {
  const lines = useMemo(() => highlightLines(text.slice(0, 18000), flavorOf(path)), [text, path]);
  return (
    <pre className="tb-code mono" tabIndex={0}>
      {lines.map((tokens, index) => (
        <span key={index}>
          {tokens.map((token, position) => (token.cls ? <span key={position} className={token.cls}>{token.text}</span> : token.text))}
          {index < lines.length - 1 ? "\n" : ""}
        </span>
      ))}
    </pre>
  );
}

function ToolError({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="tb-error" role="alert">
      <CircleAlert className="ic" aria-hidden="true" />
      <div><b>{message}</b>{detail ? <pre className="mono">{detail.slice(0, 4000)}</pre> : null}</div>
    </div>
  );
}

function NeedsUser() {
  useI18n();
  return <div className="tb-needs"><LockKeyhole className="ic" aria-hidden="true" /><div><b>{t("process.verification")}</b></div></div>;
}

const skeletonLines = <><span className="skeleton skel-line wide" /><span className="skeleton skel-line mid" /></>;

function Fetched({ url, result, running }: { url: string; result: Record<string, unknown> | null; running: boolean }) {
  useI18n();
  const target = (() => { try { return new URL(url); } catch { return null; } })();
  const title = result ? textArg(result, ["title", "name"]) : "";
  const content = result ? textArg(result, ["content", "text", "summary", "description"]) : "";
  const words = content ? content.split(/\s+/).filter(Boolean).length : 0;
  return (
    <div className="tb-fetch">
      {target ? <Favicon url={target.href} /> : <Globe2 className="ic" aria-hidden="true" />}
      <div>
        <b>{title || (running ? "" : target?.hostname || url)}</b>
        <small>{url}</small>
        {content ? <p>{content.slice(0, 280)}{content.length > 280 ? "…" : ""}</p> : running ? skeletonLines : null}
      </div>
      {words > 1 ? <span className="pill">{t("process.fetchedWords", { count: words })}</span> : null}
    </div>
  );
}

function Tree({ items }: { items: unknown[] }) {
  return (
    <div className="tb-tree">
      {items.slice(0, 60).map((item, index) => {
        const row = item && typeof item === "object" ? (item as Record<string, unknown>) : { name: String(item) };
        const name = textArg(row, ["title", "name", "path", "url", "text", "content"]) || `#${index + 1}`;
        const folder = row.type === "directory" || row.dir === true;
        return (
          <div className="tr" key={index}>
            {folder ? <Folder className="ic" /> : <FileText className="ic" />}
            <span className="mono">{name}</span>
            {typeof row.size === "number" ? <small>{Math.round(row.size / 1024)} KB</small> : null}
          </div>
        );
      })}
    </div>
  );
}

const factLabels: Record<string, Parameters<typeof t>[0]> = {
  path: "file.title", bytes_written: "file.writeSize", type: "common.type", tab_id: "browser.tabs", active: "browser.currentPage",
  exit_code: "process.exitStatus", truncated: "process.partialOutput", cwd: "file.directory", duration_ms: "process.duration",
  stdout_path: "process.fullOutput", stderr_path: "process.stderr", mime_type: "file.format", size: "file.size", pages: "file.pages",
  selected: "browser.currentPage", bytes: "file.size",
};
const listKeys = ["files", "entries", "tabs", "results", "sources", "links", "skills", "memories", "tools", "apps", "windows", "elements"];
const textKeys = ["content", "text", "message", "error", "description", "instructions"];
const hidden = new Set([...listKeys, ...textKeys, "file", "tab", "automation", "needs_user", "blocked", "url", "title", "name", "image", "interactive"]);

// Any other structured tool result: a list when it has one, key/value facts and the main text.
function Structured({ result, filePath }: { result: Record<string, unknown>; filePath?: string }) {
  useI18n();
  const list = listKeys.map((key) => result[key]).find((value) => Array.isArray(value) && value.length > 0) as unknown[] | undefined;
  const body = textArg(result, textKeys) || (Array.isArray(result.content)
    ? result.content.filter((item) => item && typeof item === "object" && item.type === "text").map((item) => item.text).join("\n") : "");
  const facts = Object.entries(result).filter(([key, value]) => !hidden.has(key) && ["string", "number", "boolean"].includes(typeof value));
  const tab = result.tab && typeof result.tab === "object" ? (result.tab as Record<string, unknown>) : result;
  const url = textArg(tab, ["url"]);
  const title = textArg(tab, ["title", "name"]);
  return (
    <>
      {url || title ? <div className="tb-fetch"><Globe2 className="ic" /><div><b>{title || url}</b>{url ? <small>{url}</small> : null}</div></div> : null}
      {list ? <Tree items={list} /> : null}
      {facts.length ? (
        <div className="tb-kv">
          {facts.map(([key, value]) => <div key={key}><span>{factLabels[key] ? t(factLabels[key]) : key}</span><b>{String(value)}</b></div>)}
        </div>
      ) : null}
      {body ? (filePath ? <Code text={body} path={filePath} /> : <pre className="tb-plain mono">{body.slice(0, 18000)}</pre>) : null}
    </>
  );
}

export type ToolBodyProps = {
  step: Step;
  kind: ToolFamily;
  queue: ComputerQueueProgress | null;
  needsUser: boolean;
  failed: boolean;
};

export const ToolBody = memo(function ToolBody({ step, kind, queue, needsUser, failed }: ToolBodyProps) {
  useI18n();
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const args = step.arguments;
  const output = step.output?.trim() ?? "";
  const result = useMemo(() => parseOutput(output), [output]);
  const search = useMemo(() => parseSearchOutput(step), [step.name, step.arguments, step.output]);
  const running = step.status === "running";
  const target = toolSubject(step);
  const command = kind === "terminal" ? textArg(args, ["command", "cmd"]) : "";
  const stdout = result ? textArg(result, ["stdout", "output", "content"]) : output;
  const stderr = result ? textArg(result, ["stderr", "error"]) : "";
  const exitCode = typeof (result?.exit_code ?? args?.exit_code) === "number" ? (result?.exit_code ?? args?.exit_code) as number : undefined;
  const published = step.name === "publish_file" && result && typeof result.url === "string" ? (result as unknown as Artifact) : null;
  const generated = step.name === "generate_image" && result?.artifact ? result.artifact as Artifact : null;
  const errorText = failed && kind !== "terminal" ? (result ? textArg(result, ["error", "message"]) : output) : "";
  const computer = kind === "computer" ? computerStepPart(step, queue) : null;
  const path = textArg(args, ["path"]);
  const content = typeof args?.content === "string" ? args.content : "";
  const readContent = step.name === "files_read" && result ? textArg(result, ["content", "text"]) : "";
  const showResult = kind !== "terminal" && output && !published && !generated && !search && !failed && !readContent && !computer?.hidesOutput
    && step.name !== "web_fetch" && step.name !== "request_user_input" && (!queue || queue.status === "acquired");
  const answer = step.name === "request_user_input" && !running && !needsUser ? (result ? textArg(result, ["answer", "response", "text"]) : output) : "";
  const asked = step.name === "request_user_input" ? textArg(args, ["question"]) : "";

  return (
    <div className="st-body">
      {computer?.node}
      {step.screenshot && !computer ? (
        <div className="tb-browser">
          {kind === "browser" && /^https?:\/\//.test(target) ? <div className="tb-url"><Lock className="ic" aria-hidden="true" /><span className="mono">{target}</span></div> : null}
          <button className="tb-shot-open" aria-label={t("process.viewScreenshot")} onClick={() => setImageOpen(true)}>
            <img className="tb-shot" src={step.screenshot} alt={t("process.result")} loading="lazy" />
          </button>
        </div>
      ) : null}
      {kind === "terminal" && (command || stdout || stderr || running)
        ? <Terminal command={command} stdout={stdout} stderr={stderr} exitCode={exitCode} running={running} duration={step.duration_ms} /> : null}
      {step.name === "files_write" && content ? (
        <div className="tb-file">
          <PathChip path={path} />
          <span className="pill" data-tone="success">+{content.split("\n").length}</span>
          <span className="tb-note">{args?.append ? t("process.addedContent") : t("file.content")}</span>
          <Code text={content} path={path} />
        </div>
      ) : null}
      {readContent ? (
        <div className="tb-file"><PathChip path={path} /><Code text={readContent} path={path} /></div>
      ) : null}
      {published ? <FileCards files={[published]} /> : null}
      {step.name === "publish_file" && !published && (running || step.outcome === "not_executed")
        ? <ArtifactPlaceholder name={textArg(args, ["name", "path"]).split("/").pop()} state={running ? "building" : "cancelled"} /> : null}
      {generated ? <FileCards files={[generated]} /> : null}
      {step.name === "generate_image" && running && !generated
        ? <div className="tb-image"><div className="gen-tile"><div className="skeleton" /><span><Sparkles className="ic" />{t("process.generating")}</span></div><div className="gen-bar"><i /></div></div> : null}
      {search ? <SearchResults query={search.query} results={search.results} running={false} /> : step.name === "web_search" && running
        ? <SearchResults query={textArg(args, ["query"])} results={[]} running /> : null}
      {step.name === "web_fetch" ? <Fetched url={textArg(args, ["url"]) || target} result={result} running={running} /> : null}
      {asked ? (
        <div className={`tb-ask${answer ? " done" : ""}`}>
          <p className="q">{asked}</p>
          {answer ? <div className="ans"><CornerDownRight className="ic" /><span>{answer}</span></div> : null}
        </div>
      ) : null}
      {errorText ? <ToolError message={errorText.slice(0, 600)} /> : failed && kind !== "terminal" ? <ToolError message={t("status.failed")} /> : null}
      {showResult ? (result ? <Structured result={result} filePath={step.name === "files_read" ? path : undefined} /> : <pre className="tb-plain mono">{output.slice(0, 32000)}</pre>) : null}
      {needsUser ? <NeedsUser /> : null}
      {args || result ? (
        <details className="tb-tech" onToggle={(event) => setTechnicalOpen(event.currentTarget.open)}>
          <summary>{t("process.technicalDetails")}</summary>
          {technicalOpen ? <pre className="mono">{JSON.stringify({ arguments: args, result: result ?? output }, null, 2).slice(0, 64000)}</pre> : null}
        </details>
      ) : null}
      {imageOpen && step.screenshot ? (
        <Modal title={t("process.screenshot")} onClose={() => setImageOpen(false)} wide fullscreen>
          <img className="tb-shot-full" src={step.screenshot} alt={t("process.result")} />
        </Modal>
      ) : null}
    </div>
  );
});
