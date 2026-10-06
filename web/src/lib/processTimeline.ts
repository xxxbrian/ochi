import type { ProcessEntry, Step } from "./types";

export type ToolFamily = "terminal" | "files" | "browser" | "computer" | "search" | "image" | "tool";

const tools: Record<string, { label: string; kind: ToolFamily }> = {
  exec: { label: "运行代码", kind: "terminal" },
  generate_image: { label: "生成图片", kind: "image" },
  files_list: { label: "浏览文件", kind: "files" },
  files_read: { label: "读取文件", kind: "files" },
  files_write: { label: "写入文件", kind: "files" },
  publish_file: { label: "交付文件", kind: "files" },
  browser_goto: { label: "打开网页", kind: "browser" },
  browser_observe: { label: "查看网页", kind: "browser" },
  browser_click: { label: "点击网页", kind: "browser" },
  browser_type: { label: "填写网页", kind: "browser" },
  browser_scroll: { label: "浏览网页", kind: "browser" },
  browser_screenshot: { label: "截取网页", kind: "browser" },
  browser_tabs: { label: "查看标签页", kind: "browser" },
  browser_select_tab: { label: "切换标签页", kind: "browser" },
  browser_upload: { label: "上传文件", kind: "browser" },
  browser_download: { label: "下载文件", kind: "browser" },
  browser_status: { label: "查看浏览器状态", kind: "browser" },
  browser_resume: { label: "继续浏览", kind: "browser" },
  browser_action: { label: "操作网页", kind: "browser" },
  computer_observe: { label: "查看桌面内容", kind: "computer" },
  computer_screenshot: { label: "查看电脑", kind: "computer" },
  computer_click: { label: "点击电脑", kind: "computer" },
  computer_type: { label: "输入文字", kind: "computer" },
  computer_key: { label: "操作键盘", kind: "computer" },
  computer_scroll: { label: "滚动电脑", kind: "computer" },
  computer_move: { label: "移动指针", kind: "computer" },
  computer_drag: { label: "拖动电脑", kind: "computer" },
  computer_windows: { label: "切换窗口", kind: "computer" },
  computer_apps: { label: "使用应用", kind: "computer" },
  web_search: { label: "搜索资料", kind: "search" },
  web_fetch: { label: "读取网页", kind: "search" },
  skills_list: { label: "查找 Skills", kind: "tool" },
  skills_read: { label: "读取 Skill", kind: "tool" },
  memory_search: { label: "查找记忆", kind: "tool" },
  memory_save: { label: "保存记忆", kind: "tool" },
  memory_delete: { label: "删除记忆", kind: "tool" },
  schedule_list: { label: "查看定时任务", kind: "tool" },
  schedule_create: { label: "创建定时任务", kind: "tool" },
  schedule_update: { label: "更新定时任务", kind: "tool" },
  request_user_input: { label: "等待回复", kind: "tool" },
  request_computer_permission: { label: "请求使用电脑", kind: "computer" },
};

export function toolInfo(name: string) {
  return tools[name] ?? {
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

export function orderedProcessEntries(entries: ProcessEntry[]) {
  return entries.slice().sort((left, right) => left.seq - right.seq);
}

export function lastMatching<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) if (predicate(items[index])) return items[index];
  return undefined;
}

export function upsertProcessEntry(entries: ProcessEntry[], entry: ProcessEntry) {
  const next = entries.slice();
  const index = next.findIndex((current) => current.id === entry.id);
  if (index >= 0) next[index] = { ...entry, seq: next[index].seq };
  else next.push(entry);
  // A public reply is promoted after its tool round, but retains its original position.
  return orderedProcessEntries(next);
}

export function processHasContent(timeline: ProcessEntry[]) {
  return timeline.some((entry) => entry.kind === "tool" ? Boolean(entry.step) : Boolean((entry.reasoning?.text ?? entry.text)?.trim()));
}

export function isToolFailure(step: Step) {
  if (step.status === "failed") return true;
  if (step.name !== "exec" || !step.output) return false;
  try {
    const result = JSON.parse(step.output);
    return typeof result?.exit_code === "number" && result.exit_code !== 0;
  } catch {
    return false;
  }
}

function groupFamily(step: Step): ToolFamily | null {
  const family = toolInfo(step.name).kind;
  if (isToolFailure(step) || browserNeedsUser(step) || step.name.startsWith("request_") || /(?:permission|waiting|user_input)/.test(step.name)) return null;
  // Each query and subsequent page read remain distinct, even when adjacent.
  if (family === "search" || family === "image") return null;
  return family;
}

export function browserNeedsUser(step: Step): boolean {
  if ((!step.name.startsWith("browser_") && step.name !== "computer_apps") || !step.output) return false;
  try {
    const result = JSON.parse(step.output);
    return result?.needs_user === true || result?.automation?.needs_user === true;
  } catch {
    return false;
  }
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
