import { orderedProcessEntries, toolGroupFamily } from "../../../shared/conversation/projection";
export { orderedProcessEntries } from "../../../shared/conversation/projection";
import { t } from "./i18n";
import type { ProcessEntry, Step } from "./types";

export type ToolFamily = "terminal" | "files" | "browser" | "computer" | "search" | "image" | "tool";

const tools: Record<string, { label: Parameters<typeof t>[0]; kind: ToolFamily }> = {
  exec: { label: "tool.exec", kind: "terminal" },
  generate_image: { label: "tool.image", kind: "image" },
  files_list: { label: "tool.filesList", kind: "files" },
  files_read: { label: "tool.filesRead", kind: "files" },
  files_write: { label: "tool.filesWrite", kind: "files" },
  publish_file: { label: "tool.publishFile", kind: "files" },
  browser_goto: { label: "tool.browserGoto", kind: "browser" },
  browser_observe: { label: "tool.browserObserve", kind: "browser" },
  browser_click: { label: "tool.browserClick", kind: "browser" },
  browser_type: { label: "tool.browserType", kind: "browser" },
  browser_scroll: { label: "tool.browserScroll", kind: "browser" },
  browser_screenshot: { label: "tool.browserScreenshot", kind: "browser" },
  browser_tabs: { label: "tool.browserTabs", kind: "browser" },
  browser_select_tab: { label: "tool.browserSelectTab", kind: "browser" },
  browser_upload: { label: "tool.browserUpload", kind: "browser" },
  browser_download: { label: "file.downloadFile", kind: "browser" },
  browser_status: { label: "tool.browserStatus", kind: "browser" },
  browser_resume: { label: "tool.browserResume", kind: "browser" },
  browser_action: { label: "tool.browserAction", kind: "browser" },
  computer_observe: { label: "tool.computerObserve", kind: "computer" },
  computer_screenshot: { label: "tool.computerScreenshot", kind: "computer" },
  computer_click: { label: "tool.computerClick", kind: "computer" },
  computer_type: { label: "computer.typeText", kind: "computer" },
  computer_key: { label: "tool.computerKey", kind: "computer" },
  computer_scroll: { label: "tool.computerScroll", kind: "computer" },
  computer_move: { label: "tool.computerMove", kind: "computer" },
  computer_drag: { label: "tool.computerDrag", kind: "computer" },
  computer_windows: { label: "tool.computerWindows", kind: "computer" },
  computer_apps: { label: "tool.computerApps", kind: "computer" },
  web_search: { label: "tool.search", kind: "search" },
  web_fetch: { label: "tool.fetch", kind: "search" },
  skills_list: { label: "tool.skillsList", kind: "tool" },
  skills_read: { label: "tool.skillsRead", kind: "tool" },
  memory_search: { label: "tool.memorySearch", kind: "tool" },
  memory_save: { label: "tool.memorySave", kind: "tool" },
  memory_delete: { label: "memory.delete", kind: "tool" },
  schedule_list: { label: "tool.scheduleList", kind: "tool" },
  schedule_create: { label: "tool.scheduleCreate", kind: "tool" },
  schedule_update: { label: "tool.scheduleUpdate", kind: "tool" },
  request_user_input: { label: "status.awaitingReply", kind: "tool" },
  request_computer_permission: { label: "tool.computerPermission", kind: "computer" },
};

export function toolInfo(name: string) {
  const tool = tools[name];
  if (tool) return { label: t(tool.label), kind: tool.kind };
  return {
    label: name.startsWith("mcp_")
      ? `MCP · ${name.replace(/^mcp_/, "").replaceAll("_", " ")}`
      : name.replaceAll("_", " "),
    kind: "tool" as const,
  };
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
function groupFamily(step: Step): ToolFamily | null {
  const family = toolGroupFamily(step);
  return family === "commands" ? "terminal" : family === "integration" ? "tool" : family;
}

export type ProcessRow =
  | { kind: "entry"; id: string; entry: ProcessEntry }
  | { kind: "tools"; id: string; family: ToolFamily; entries: ProcessEntry[] };

export function groupProcessEntries(entries: ProcessEntry[]): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const entry of orderedProcessEntries(entries)) {
    const family = entry.kind === "tool" && entry.step ? groupFamily(entry.step) : null;
    const previous = rows[rows.length - 1];
    if (family && previous?.kind === "tools" && previous.family === family) {
      previous.entries.push(entry);
    } else if (family && previous?.kind === "entry" && previous.entry.kind === "tool" && previous.entry.step && groupFamily(previous.entry.step) === family) {
      rows[rows.length - 1] = { kind: "tools", id: previous.id, family, entries: [previous.entry, entry] };
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
