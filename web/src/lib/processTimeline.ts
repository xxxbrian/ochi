import { orderedProcessEntries } from "../../../shared/conversation/projection";
export { orderedProcessEntries } from "../../../shared/conversation/projection";
import { t } from "./i18n";
import { computerQueueProgress, isExecutedStep } from "../../../shared/conversation/computerQueue";
import { isToolFailure, toolNeedsUser } from "../../../shared/conversation/projection";
import type { ProcessEntry, Step } from "./types";

export type ToolFamily = "terminal" | "files" | "browser" | "computer" | "search" | "image" | "tool" | "ask";

type ToolDef = { kind: ToolFamily; label: Parameters<typeof t>[0]; run: Parameters<typeof t>[0] };
const tool = (kind: ToolFamily, label: ToolDef["label"], run: ToolDef["run"]): ToolDef => ({ kind, label, run });

// Every server tool: its family (tile hue and icon), its finished label and its running verb.
const tools: Record<string, ToolDef> = {
  exec: tool("terminal", "tool.exec", "tool.verb.exec"),
  generate_image: tool("image", "tool.image", "tool.verb.generate_image"),
  files_list: tool("files", "tool.filesList", "tool.verb.files_list"),
  files_read: tool("files", "tool.filesRead", "tool.verb.files_read"),
  files_write: tool("files", "tool.filesWrite", "tool.verb.files_write"),
  files_copy: tool("files", "tool.filesCopy", "tool.verb.files_copy"),
  publish_file: tool("files", "tool.publishFile", "tool.verb.publish_file"),
  web_search: tool("search", "tool.search", "tool.verb.web_search"),
  web_fetch: tool("search", "tool.fetch", "tool.verb.web_fetch"),
  isolated_research: tool("search", "tool.isolatedResearch", "tool.verb.isolated_research"),
  browser_goto: tool("browser", "tool.browserGoto", "tool.verb.browser_goto"),
  browser_observe: tool("browser", "tool.browserObserve", "tool.verb.browser_observe"),
  browser_snapshot: tool("browser", "tool.browserSnapshot", "tool.verb.browser_snapshot"),
  browser_click: tool("browser", "tool.browserClick", "tool.verb.browser_click"),
  browser_type: tool("browser", "tool.browserType", "tool.verb.browser_type"),
  browser_scroll: tool("browser", "tool.browserScroll", "tool.verb.browser_scroll"),
  browser_screenshot: tool("browser", "tool.browserScreenshot", "tool.verb.browser_screenshot"),
  browser_tabs: tool("browser", "tool.browserTabs", "tool.verb.browser_tabs"),
  browser_select_tab: tool("browser", "tool.browserSelectTab", "tool.verb.browser_select_tab"),
  browser_upload: tool("browser", "tool.browserUpload", "tool.verb.browser_upload"),
  browser_download: tool("browser", "file.downloadFile", "tool.verb.browser_download"),
  browser_status: tool("browser", "tool.browserStatus", "tool.verb.browser_status"),
  browser_resume: tool("browser", "tool.browserResume", "tool.verb.browser_resume"),
  browser_action: tool("browser", "tool.browserAction", "tool.verb.browser_action"),
  computer_observe: tool("computer", "tool.computerObserve", "tool.verb.computer_observe"),
  computer_screenshot: tool("computer", "tool.computerScreenshot", "tool.verb.computer_screenshot"),
  computer_click: tool("computer", "tool.computerClick", "tool.verb.computer_click"),
  computer_type: tool("computer", "computer.typeText", "tool.verb.computer_type"),
  computer_key: tool("computer", "tool.computerKey", "tool.verb.computer_key"),
  computer_scroll: tool("computer", "tool.computerScroll", "tool.verb.computer_scroll"),
  computer_move: tool("computer", "tool.computerMove", "tool.verb.computer_move"),
  computer_drag: tool("computer", "tool.computerDrag", "tool.verb.computer_drag"),
  computer_windows: tool("computer", "tool.computerWindows", "tool.verb.computer_windows"),
  computer_apps: tool("computer", "tool.computerApps", "tool.verb.computer_apps"),
  computer_queue: tool("computer", "tool.computerQueue", "tool.verb.computer_queue"),
  computer_release: tool("computer", "tool.computerRelease", "tool.verb.computer_release"),
  request_computer_permission: tool("computer", "tool.computerPermission", "tool.verb.request_computer_permission"),
  request_user_input: tool("ask", "status.awaitingReply", "tool.verb.request_user_input"),
  memory_search: tool("tool", "tool.memorySearch", "tool.verb.memory_search"),
  memory_save: tool("tool", "tool.memorySave", "tool.verb.memory_save"),
  memory_delete: tool("tool", "memory.delete", "tool.verb.memory_delete"),
  schedule_list: tool("tool", "tool.scheduleList", "tool.verb.schedule_list"),
  schedule_create: tool("tool", "tool.scheduleCreate", "tool.verb.schedule_create"),
  schedule_update: tool("tool", "tool.scheduleUpdate", "tool.verb.schedule_update"),
  skills_list: tool("tool", "tool.skillsList", "tool.verb.skills_list"),
  skills_read: tool("tool", "tool.skillsRead", "tool.verb.skills_read"),
  skills_promote: tool("tool", "tool.skillsPromote", "tool.verb.skills_promote"),
};

const humanize = (name: string) => name.replace(/^mcp_/, "").replaceAll("_", " ");

/**
 * Localized label (finished), running verb and family of a tool. Unknown ids never reach a sentence:
 * MCP tools carry their humanized name as a parameter, anything else is a generic "tool call".
 */
export function toolInfo(name: string) {
  const known = tools[name];
  if (known) return { label: t(known.label), running: t(known.run), kind: known.kind, known: true };
  if (name.startsWith("mcp_")) return { label: t("tool.mcp", { name: humanize(name) }), running: t("tool.mcpRunning", { name: humanize(name) }), kind: "tool" as const, known: false };
  return { label: t("tool.generic"), running: t("tool.genericRunning"), kind: "tool" as const, known: false };
}

export function textArgument(args: Record<string, unknown> | null | undefined, keys: string[]) {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export function lastMatching<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) if (predicate(items[index])) return items[index];
  return undefined;
}

export function processHasContent(timeline: ProcessEntry[]) {
  return timeline.some((entry) => entry.kind === "tool" ? Boolean(entry.step) : Boolean((entry.reasoning?.text ?? entry.text)?.trim()));
}

export { isToolFailure, toolNeedsUser as browserNeedsUser } from "../../../shared/conversation/projection";
// A tool call joins a group when it is finished work. Calls that need the person or failed stay rows of their own.
function groupable(step: Step) {
  return isExecutedStep(step) && !isToolFailure(step) && !toolNeedsUser(step) && !/(?:^|_)(?:request|permission|queue|waiting)/.test(step.name);
}

export type ProcessRow =
  | { kind: "entry"; id: string; entry: ProcessEntry }
  | { kind: "tools"; id: string; entries: ProcessEntry[] };

// Consecutive finished or running tool calls collapse into one group (lab: "Used N tools"); a single call stays a plain row.
// Thinking, interim replies and calls that need attention break a group.
export function groupProcessEntries(entries: ProcessEntry[]): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const entry of orderedProcessEntries(entries)) {
    const joins = entry.kind === "tool" && entry.step && groupable(entry.step);
    const previous = rows[rows.length - 1];
    if (joins && previous?.kind === "tools") {
      previous.entries.push(entry);
    } else if (joins && previous?.kind === "entry" && previous.entry.kind === "tool" && previous.entry.step && groupable(previous.entry.step)) {
      rows[rows.length - 1] = { kind: "tools", id: previous.id, entries: [previous.entry, entry] };
    } else {
      rows.push({ kind: "entry", id: entry.id, entry });
    }
  }
  return rows;
}

export type SearchResult = { title: string; url: string; description?: string; published_at?: string };
export type SearchOutput = { query: string; results: SearchResult[] };

export function publicWebUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // Never turn credentials or a local/private result into an external image request.
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (url.username || url.password || !host.includes(".") || host.length > 253 ||
      host.split(".").some((label) => label.length > 63 || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label)) ||
      /(?:^|\.)(?:localhost|local|internal|test)$/.test(host) ||
      /^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\.|^::|^f[cd][\da-f]:|^fe[89ab][\da-f]:/i.test(host) ||
      (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535))) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function parseSearchOutput(step: Step): SearchOutput | null {
  if (step.name !== "web_search") return null;
  try {
    const output = JSON.parse(step.output ?? "");
    if (!output || !Array.isArray(output.results)) return null;
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    for (const item of output.results.slice(0, 60)) {
      if (!item || typeof item !== "object") continue;
      const url = publicWebUrl(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      results.push({
        title: textArgument(item, ["title"]) || new URL(url).hostname,
        url,
        description: typeof item.description === "string" ? item.description : undefined,
        published_at: typeof item.published_at === "string" ? item.published_at : undefined,
      });
    }
    return { query: textArgument(output, ["query"]) || textArgument(step.arguments, ["query"]), results };
  } catch {
    return null;
  }
}

// Hue (degrees) of each tool family. Tile tint strength is the `tile-tint` token, so a look can mute it.
export const familyHue: Record<ToolFamily, number> = { terminal: 155, files: 75, search: 245, browser: 215, computer: 300, image: 345, tool: 262, ask: 62 };

export type StepState = "running" | "done" | "error" | "waiting";

export function stepState(step: Step): StepState {
  if (isToolFailure(step)) return "error";
  if (toolNeedsUser(step)) return "waiting";
  if (step.status === "running") {
    const queue = computerQueueProgress(step);
    return queue && queue.status !== "acquired" ? "waiting" : "running";
  }
  return "done";
}

const subjectKeys = ["command", "cmd", "path", "url", "query", "target", "text", "keys", "key", "title", "question", "summary", "task", "prompt", "id", "name", "ref", "selector", "reason"];

// The one-line subject of a tool call: the command, path, query or URL it acts on.
export function toolSubject(step: Step): string {
  const args = step.arguments;
  return textArgument(args, subjectKeys) ||
    (typeof args?.x === "number" && typeof args?.y === "number" ? `(${args.x}, ${args.y})`
      : Array.isArray(args?.paths) ? args.paths.join(", ") : "") ||
    (tools[step.name] ? "" : humanize(step.name));
}

export function toolFamily(name: string): ToolFamily { return toolInfo(name).kind; }

// Tool calls that count toward "N tool calls": executed work, not permission or user-input prompts.
export function countedSteps(entries: ProcessEntry[]): Step[] {
  return entries.flatMap((entry) => entry.step && isExecutedStep(entry.step) && !/^(?:request_|computer_queue$)/.test(entry.step.name) ? [entry.step] : []);
}

export function stepFamilies(steps: Step[], limit = 6): ToolFamily[] {
  return [...new Set(steps.map((step) => toolFamily(step.name)))].slice(0, limit);
}

export function formatStepDuration(milliseconds: number): string {
  return milliseconds < 1000 ? `${Math.round(milliseconds)}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
}
