import { orderedProcessEntries, projectRun, transcriptRows, toolGroupFamily as toolFamily } from "../../../shared/conversation/projection";
import { computerQueueProgress, isExecutedStep } from "../../../shared/conversation/computerQueue";
import { computerQueueLabel } from "../../../shared/i18n/process";
export { toolGroupFamily as toolFamily } from "../../../shared/conversation/projection";
import { t } from "./i18n";
import type { ProcessEntry, Snapshot, Step } from './types';

export type ToolFamily = 'commands' | 'files' | 'browser' | 'computer' | 'integration';
export type ProcessRow =
  | { kind: 'entry'; id: string; entry: ProcessEntry }
  | { kind: 'tools'; id: string; family: ToolFamily | null; steps: Step[] };

function appendTool(rows: ProcessRow[], step: Step, id: string) {
  const family = toolFamily(step);
  const previous = rows.at(-1);
  if (family && previous?.kind === 'tools' && previous.family === family) previous.steps.push(step);
  else rows.push({ kind: 'tools', id, family, steps: [step] });
}

export function processRows(entries: ProcessEntry[]): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const entry of orderedProcessEntries(entries)) {
    if (entry.kind === 'tool' && entry.step) appendTool(rows, entry.step, entry.id);
    else rows.push({ kind: 'entry', id: entry.id, entry });
  }
  return rows;
}

export type TimelineSegment =
  | { kind: 'text'; id: string; entry: ProcessEntry }
  | { kind: 'details'; id: string; entries: ProcessEntry[] };

export function hasPublicText(snapshot: Snapshot) { return projectRun(snapshot).hasPublicText; }
export function finalPublicEntries(snapshot: Snapshot) { return projectRun(snapshot).finalEntries; }
export function hasProcessHistory(snapshot: Snapshot) { return projectRun(snapshot).plan.hasWork; }
export function timelineSegments(entries: ProcessEntry[]): TimelineSegment[] {
  return transcriptRows(entries).map((row) => row.kind === 'public'
    ? { kind: 'text', id: row.id, entry: row.entry }
    : { kind: 'details', id: row.id, entries: row.entries });
}
export { publicReply, formatReasoningText } from '../../../shared/conversation/projection';

export function detailLabel(entries: ProcessEntry[]): string {
  let searches = 0, pages = 0, tools = 0;
  for (const entry of entries) {
    if (!entry.step || !isExecutedStep(entry.step)) continue;
    if (entry.step.name === 'web_search') searches++;
    else if (entry.step.name === 'web_fetch') pages++;
    else tools++;
  }
  const parts: string[] = [];
  if (searches) parts.push(t("process.searchCount", { count: searches }));
  if (pages) parts.push(t("process.pageCount", { count: pages }));
  if (tools) parts.push(t("process.toolCount", { count: tools }));
  if (parts.length) return parts.join(' · ');
  const lastQueue = entries.findLast((entry) => entry.step && computerQueueProgress(entry.step));
  const queue = lastQueue?.step && computerQueueProgress(lastQueue.step);
  return queue ? computerQueueLabel(queue) : t("process.reasoningHistory");
}

export function latestProgress(snapshot: Snapshot): string {
  return snapshot.items.findLast((item) => item.kind === 'text' && item.text?.trim())?.text ?? '';
}

export function processPanelLimit(availableHeight?: number): number {
  return availableHeight && Number.isFinite(availableHeight)
    ? Math.min(280, Math.max(48, Math.floor(availableHeight * 0.64)))
    : 280;
}

export function processNearBottom(offset: number, content: number, viewport: number): boolean {
  return content - Math.max(0, offset) - viewport <= 24;
}

export type SearchResult = { title: string; url: string; description?: string; publishedAt?: string };
export type SearchResults = { query: string; results: SearchResult[] };

function safePublicURL(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // Tool output must not turn a private or credential URL into a device image request.
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (url.username || url.password || !host.includes('.') || host.length > 253 ||
      host.split('.').some((label) => label.length > 63 || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label)) ||
      /(?:^|\.)(?:localhost|local|internal|test)$/.test(host) ||
      /^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\.|^::|^f[cd][\da-f]:|^fe[89ab][\da-f]:/i.test(host) ||
      (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535))) return null;
    return url.href;
  } catch { return null; }
}

export function website(url: string): { host: string; favicon?: string } | null {
  const safe = safePublicURL(url);
  if (!safe) return null;
  const parsed = new URL(safe);
  return { host: parsed.hostname.replace(/^www\./, '').replace(/\.$/, ''), favicon: parsed.protocol === 'https:' ? `${parsed.origin}/favicon.ico` : undefined };
}

export function searchResults(step: Step): SearchResults | null {
  if (step.name !== 'web_search' || !step.output) return null;
  try {
    const output: unknown = JSON.parse(step.output);
    if (!output || typeof output !== 'object' || !('results' in output) || !Array.isArray(output.results)) return null;
    const query = 'query' in output && typeof output.query === 'string' ? output.query
      : typeof step.arguments?.query === 'string' ? step.arguments.query : '';
    const urls = new Set<string>();
    const results: SearchResult[] = [];
    for (const item of output.results) {
      if (!item || typeof item !== 'object') continue;
      const url = safePublicURL(item.url);
      if (!url || urls.has(url)) continue;
      urls.add(url);
      results.push({
        title: typeof item.title === 'string' && item.title.trim() ? item.title : website(url)!.host,
        url,
        description: typeof item.description === 'string' ? item.description : undefined,
        publishedAt: typeof item.published_at === 'string' ? item.published_at : undefined,
      });
      if (results.length >= 30) break;
    }
    return { query, results };
  } catch { return null; }
}

export function stepTarget(step: Step): string {
  for (const key of ['command', 'cmd', 'path', 'url', 'query', 'name', 'reason', 'text']) {
    const value = step.arguments?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}
