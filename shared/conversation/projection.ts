import type { Message, ProcessEntry, RunItem, RunStatus, Snapshot, Step } from "../contracts";
import { isActiveStatus } from "./events";
import { isExecutedStep } from "./computerQueue";

const entryCache = new WeakMap<RunItem, ProcessEntry>();
export function processEntry(item: RunItem): ProcessEntry {
  const cached = entryCache.get(item);
  if (cached) return cached;
  const base = { id: item.id, seq: item.seq, source_id: item.source_id, round_id: item.round_id };
  const entry: ProcessEntry = item.kind === "text"
    ? { ...base, kind: "progress", text: item.text, pending: item.phase === "pending", final: item.phase === "final" }
    : item.kind === "reasoning"
      ? { ...base, kind: "reasoning", reasoning: { id: item.id, kind: item.reasoning_kind ?? "reasoning",
          text: item.text ?? "", done: item.state !== "streaming" } }
      : { ...base, kind: "tool", step: item.step };
  entryCache.set(item, entry);
  return entry;
}

export function orderedProcessEntries(entries: ProcessEntry[]) {
  return entries.some((entry, index) => index > 0 && entry.seq < entries[index - 1]!.seq)
    ? [...entries].sort((a, b) => a.seq - b.seq) : entries;
}

export type TranscriptRow =
  | { kind: "public"; id: string; entry: ProcessEntry }
  | { kind: "process"; id: string; entries: ProcessEntry[] };

export function transcriptRows(entries: ProcessEntry[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const entry of orderedProcessEntries(entries)) {
    if (entry.kind === "progress") {
      if (entry.text?.trim()) rows.push({ kind: "public", id: entry.id, entry });
    } else if (entry.step || entry.reasoning?.text.trim()) {
      const last = rows.at(-1);
      if (last?.kind === "process") last.entries.push(entry);
      else rows.push({ kind: "process", id: `process:${entry.id}`, entries: [entry] });
    }
  }
  return rows;
}

export function transcriptPlan(entries: ProcessEntry[], status?: RunStatus) {
  const rows = transcriptRows(entries);
  const finalIds = new Set(entries.filter((entry) => entry.final && entry.text?.trim()).map((entry) => entry.id));
  const hasWork = rows.some((row) => row.kind === "process" || !finalIds.has(row.id));
  return { rows, finalIds, hasWork, canRollUp: status === "completed" && finalIds.size > 0 && hasWork };
}

function joinText(items: RunItem[]) {
  const blocks: { source: string; round: string; text: string }[] = [];
  for (const item of items) {
    if (item.kind !== "text" || !item.text) continue;
    const last = blocks.at(-1);
    if (last && last.source === item.source_id && last.round === item.round_id) last.text += item.text;
    else blocks.push({ source: item.source_id, round: item.round_id, text: item.text });
  }
  return blocks.filter((block) => block.text.trim()).map((block) => block.text).join("\n\n");
}

export function publicReply(snapshot: Pick<Snapshot, "items" | "status">) {
  const text = snapshot.items.filter((item) => item.kind === "text");
  const finals = text.filter((item) => item.phase === "final");
  return joinText(snapshot.status === "completed" && finals.some((item) => item.text?.trim()) ? finals : text);
}

export function projectRun(snapshot: Snapshot) {
  const entries = snapshot.items.map(processEntry);
  const plan = transcriptPlan(entries, snapshot.status);
  return {
    entries, plan, text: publicReply(snapshot),
    steps: snapshot.items.flatMap((item) => item.step ? [item.step] : []),
    reasoning: snapshot.items.filter((item) => item.kind === "reasoning").map(processEntry).flatMap((entry) => entry.reasoning ? [entry.reasoning] : []),
    finalEntries: entries.filter((entry) => plan.finalIds.has(entry.id)),
    hasPublicText: entries.some((entry) => entry.kind === "progress" && Boolean(entry.text?.trim())),
    active: isActiveStatus(snapshot.status),
  };
}

export function chatMessageKey(message: Message) {
  return message.role === "assistant" && message.run_id ? `assistant-${message.run_id}` : message.id;
}

export function projectChatMessages(messages: Message[], snapshot: Snapshot | null): Message[] {
  if (!snapshot || messages.some((message) => message.role === "assistant" && message.run_id === snapshot.run_id)) return messages;
  return [...messages, {
    id: `run-${snapshot.run_id}`, run_id: snapshot.run_id, run_status: snapshot.status,
    run_error: snapshot.error, run_error_code: snapshot.error_code,
    role: "assistant", content: publicReply(snapshot), attachments: snapshot.artifacts,
    model_id: snapshot.model_id, model_name: snapshot.model_name, effort: snapshot.effort,
    created_at: snapshot.created_at,
  }];
}

export function messagePresentation(message: Message, snapshot: Snapshot | null) {
  const needsTerminal = Boolean(snapshot && isActiveStatus(snapshot.status) && message.run_status && !isActiveStatus(message.run_status));
  const recovering = snapshot && needsTerminal ? {
    ...snapshot, status: message.run_status!, error: message.run_error || snapshot.error,
    error_code: message.run_error_code || snapshot.error_code,
    created_at: message.run_created_at ?? snapshot.created_at, updated_at: message.run_updated_at ?? snapshot.updated_at,
    artifacts: message.attachments ?? snapshot.artifacts, waiting_input: undefined,
    items: snapshot.items.filter((item) => item.kind !== "text"),
  } : snapshot;
  return {
    needsTerminal,
    snapshot: recovering,
    fallback: !snapshot || needsTerminal ? message.content : "",
    copyText: needsTerminal || !snapshot ? message.content : publicReply(snapshot),
  };
}

export function isToolFailure(step: Step) { return step.status === "failed" || step.outcome === "failure"; }
export function toolNeedsUser(step: Step) { return step.outcome === "needs_user"; }
export function toolGroupFamily(step: Step): "commands" | "files" | "browser" | "computer" | "integration" | null {
  if (!isExecutedStep(step) || isToolFailure(step) || toolNeedsUser(step) || /(?:^|_)request|permission|waiting/.test(step.name)) return null;
  if (step.name === "exec") return "commands";
  if (step.name.startsWith("files_") || step.name === "publish_file") return "files";
  if (step.name.startsWith("browser_")) return "browser";
  if (step.name.startsWith("computer_")) return "computer";
  if (step.name.startsWith("mcp_")) return "integration";
  return null;
}

export function formatReasoningText(content: string) {
  const value = content.trim();
  return /^(?:\*\*[^*\r\n]+\*\*\s*){2,}$/.test(value)
    ? [...value.matchAll(/\*\*[^*\r\n]+\*\*/g)].map((match) => match[0]).join("\n\n") : content;
}
