import type { ProcessEntry, ProcessEventFields, Snapshot, Step } from './types';

export type ToolFamily = 'commands' | 'files' | 'browser' | 'computer' | 'integration';
export type ProcessRow =
  | { kind: 'entry'; id: string; entry: ProcessEntry }
  | { kind: 'tools'; id: string; family: ToolFamily | null; steps: Step[] };

function sameEntry(left: ProcessEntry, right: ProcessEntry) {
  if (left === right) return true;
  return left.id === right.id && left.seq === right.seq && left.kind === right.kind &&
    left.text === right.text && left.pending === right.pending && left.final === right.final && left.reasoning?.id === right.reasoning?.id &&
    left.reasoning?.kind === right.reasoning?.kind && left.reasoning?.text === right.reasoning?.text &&
    left.reasoning?.done === right.reasoning?.done && (left.step === right.step || (
      left.step?.id === right.step?.id && left.step?.name === right.step?.name &&
      left.step?.status === right.step?.status && left.step?.output === right.step?.output &&
      left.step?.screenshot === right.step?.screenshot && left.step?.duration_ms === right.step?.duration_ms &&
      JSON.stringify(left.step?.arguments) === JSON.stringify(right.step?.arguments)
    ));
}

function ordered(entries: ProcessEntry[]) {
  return entries.some((entry, index) => index > 0 && entry.seq < entries[index - 1]!.seq)
    ? [...entries].sort((left, right) => left.seq - right.seq)
    : entries;
}

export function applyProcessEvent(current: Snapshot['timeline'], fields: ProcessEventFields): Snapshot['timeline'] {
  let entries = current;
  if (fields.timeline !== undefined) {
    const previous = new Map(current.map((entry) => [entry.id, entry]));
    const incoming = ordered(fields.timeline.map((entry) => {
      const retained = previous.get(entry.id);
      return retained && sameEntry(retained, entry) ? retained : entry;
    }));
    entries = current.length === incoming.length && incoming.every((entry, index) => entry === current[index])
      ? current : incoming;
  }
  if (!fields.timeline_entry) return entries;
  const entry = fields.timeline_entry;
  const index = entries.findIndex((previous) => previous.id === entry.id);
  if (index < 0) return ordered([...entries, entry]);
  // Delta updates replace content, never the entry's original place in the process.
  const next = entry.seq === entries[index]!.seq ? entry : { ...entry, seq: entries[index]!.seq };
  if (sameEntry(entries[index]!, next)) return entries;
  return entries.map((previous, position) => position === index ? next : previous);
}

export function toolFamily(step: Step): ToolFamily | null {
  if (step.status === 'failed' || /(?:^|_)request|permission|waiting/.test(step.name)) return null;
  if (step.name === 'exec') return 'commands';
  if (step.name.startsWith('files_')) return 'files';
  if (step.name.startsWith('browser_')) return 'browser';
  if (step.name.startsWith('computer_')) return 'computer';
  if (step.name.startsWith('mcp_')) return 'integration';
  // Search queries and page reads remain independent chronological entries.
  return null;
}

function appendTool(rows: ProcessRow[], step: Step, id: string) {
  const family = toolFamily(step);
  const previous = rows.at(-1);
  if (family && previous?.kind === 'tools' && previous.family === family) previous.steps.push(step);
  else rows.push({ kind: 'tools', id, family, steps: [step] });
}

export function processRows(entries: ProcessEntry[]): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const entry of ordered(entries)) {
    if (entry.kind === 'tool' && entry.step) appendTool(rows, entry.step, entry.id);
    else rows.push({ kind: 'entry', id: entry.id, entry });
  }
  return rows;
}

export type TimelineSegment =
  | { kind: 'text'; id: string; entry: ProcessEntry }
  | { kind: 'details'; id: string; entries: ProcessEntry[] };

export function hasPublicText(snapshot: Snapshot): boolean {
  return snapshot.timeline.some((entry) => entry.kind === 'progress' && Boolean(entry.text?.trim()));
}

// Segment keys come from the first real event, never the current stream status.
export function timelineSegments(entries: ProcessEntry[]): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  for (const entry of ordered(entries)) {
    if (entry.kind === 'progress') {
      if (entry.text?.trim()) segments.push({ kind: 'text', id: entry.id, entry });
    } else {
      const last = segments.at(-1);
      if (last?.kind === 'details') last.entries.push(entry);
      else segments.push({ kind: 'details', id: entry.id, entries: [entry] });
    }
  }
  return segments;
}

export function finalPublicEntries(snapshot: Snapshot): ProcessEntry[] {
  return snapshot.timeline.filter((entry) => entry.kind === 'progress' && entry.final && entry.text?.trim());
}

export function hasProcessHistory(snapshot: Snapshot): boolean {
  return snapshot.timeline.some((entry) => entry.kind === 'progress'
    ? !entry.final && Boolean(entry.text?.trim())
    : entry.kind === 'tool' || Boolean(entry.reasoning?.text.trim()));
}

function terminal(snapshot: Snapshot): boolean {
  return snapshot.status === 'completed' || snapshot.status === 'cancelled' || snapshot.status === 'failed' || snapshot.status === 'interrupted';
}

function matchesOutput(text: string, snapshot: Snapshot): boolean {
  return text === snapshot.output || (terminal(snapshot) && text.trim() === snapshot.output.trim());
}

export function unrepresentedOutput(snapshot: Snapshot): string {
  if (!snapshot.output.trim()) return '';
  if (representedOutputEntries(snapshot).length) return '';
  const publicEntries = ordered(snapshot.timeline).filter((entry) => entry.kind === 'progress');
  let suffix = '';
  for (let index = publicEntries.length - 1; index >= 0; index--) {
    suffix = (publicEntries[index]!.text ?? '') + suffix;
    if (matchesOutput(suffix, snapshot)) return '';
    if (suffix.trim().length >= snapshot.output.trim().length) break;
  }
  return snapshot.output;
}

export function publicReply(snapshot: Snapshot): string {
  if (snapshot.status === 'completed' && snapshot.output.trim()) return snapshot.output;
  if (!terminal(snapshot)) return snapshot.output;
  const entries = ordered(snapshot.timeline).filter((entry) => entry.kind === 'progress');
  const candidates = entries.filter((entry) => entry.pending || entry.final);
  const mergeCandidates = Boolean(snapshot.output.trim()) && candidates.length > 0 && matchesOutput(candidates.map((entry) => entry.text ?? '').join(''), snapshot);
  const groups: { source: string; candidate: boolean; text: string }[] = [];
  for (const entry of entries) {
    const source = entry.id.replace(/:segment-\d+$/, '');
    const candidate = Boolean(entry.pending || entry.final);
    const previous = groups.at(-1);
    // Reasoning can divide a provider's sentence without ending its Markdown.
    if (previous && ((source && previous.source === source) || (mergeCandidates && candidate && previous.candidate))) {
      previous.text += entry.text ?? '';
      previous.candidate = previous.candidate && candidate;
    } else groups.push({ source, candidate, text: entry.text ?? '' });
  }
  const blocks = groups.filter((group) => group.text.trim()).map((group) => group.text);
  const output = unrepresentedOutput(snapshot);
  if (output.trim()) blocks.push(output);
  return blocks.join('\n\n');
}

export function reconcileTerminalText(snapshot: Snapshot, output: string): ProcessEntry[] {
  if (!output.trim()) return snapshot.timeline;
  const confirmed = { ...snapshot, output };
  const current = representedOutputEntries(confirmed);
  if (current.length) {
    const ids = new Set(current.map((entry) => entry.id));
    return snapshot.timeline.map((entry) => entry.kind === 'progress'
      ? { ...entry, pending: false, final: ids.has(entry.id) } : entry);
  }
  const publicEntries = ordered(snapshot.timeline).filter((entry) => entry.kind === 'progress');
  let suffix = '';
  const ids = new Set<string>();
  for (let index = publicEntries.length - 1; index >= 0; index--) {
    const entry = publicEntries[index]!;
    suffix = (entry.text ?? '') + suffix;
    ids.add(entry.id);
    if (matchesOutput(suffix, confirmed)) return snapshot.timeline.map((item) => item.kind === 'progress'
      ? { ...item, pending: false, final: ids.has(item.id) } : item);
    if (suffix.trim().length >= output.trim().length) break;
  }
  return snapshot.timeline;
}

function representedOutputEntries(snapshot: Snapshot): ProcessEntry[] {
  const publicEntries = ordered(snapshot.timeline).filter((entry) => entry.kind === 'progress');
  const finals = publicEntries.filter((entry) => entry.final);
  if (finals.length && matchesOutput(finals.map((entry) => entry.text ?? '').join(''), snapshot)) return finals;
  const current = publicEntries.filter((entry) => entry.final || entry.pending);
  return current.length && matchesOutput(current.map((entry) => entry.text ?? '').join(''), snapshot) ? current : [];
}

// Some relays flatten a title-only summary into adjacent bold spans. Only that
// exact presentation form is separated; ordinary prose/Markdown stays intact.
export function formatReasoningText(content: string): string {
  const value = content.trim();
  return /^(?:\*\*[^*\r\n]+\*\*\s*){2,}$/.test(value)
    ? [...value.matchAll(/\*\*[^*\r\n]+\*\*/g)].map((match) => match[0]).join('\n\n') : content;
}

export function detailLabel(entries: ProcessEntry[]): string {
  let searches = 0, pages = 0, tools = 0;
  for (const entry of entries) {
    if (!entry.step) continue;
    if (entry.step.name === 'web_search') searches++;
    else if (entry.step.name === 'web_fetch') pages++;
    else tools++;
  }
  const parts: string[] = [];
  if (searches) parts.push(`搜索 ${searches} 次`);
  if (pages) parts.push(`读取 ${pages} 个网页`);
  if (tools) parts.push(`调用 ${tools} 个工具`);
  return parts.join(' · ') || '思考过程';
}

export function latestProgress(snapshot: Snapshot): string {
  for (let index = snapshot.timeline.length - 1; index >= 0; index--) {
    const entry = snapshot.timeline[index]!;
    if (entry.kind === 'progress' && entry.text?.trim()) return entry.text;
  }
  return '';
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
