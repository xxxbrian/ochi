import type { ProcessEntry, RunStatus } from "./types";
import { orderedProcessEntries } from "./processTimeline";

export type TranscriptRow =
  | { kind: "public"; id: string; entry: ProcessEntry }
  | { kind: "process"; id: string; entries: ProcessEntry[] };

export function transcriptRows(timeline: ProcessEntry[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const entry of orderedProcessEntries(timeline)) {
    if (entry.kind === "progress") {
      if (entry.text?.trim()) rows.push({ kind: "public", id: entry.id, entry });
      continue;
    }
    if (!entry.step && !entry.reasoning?.text.trim()) continue;
    const previous = rows.at(-1);
    if (previous?.kind === "process") previous.entries.push(entry);
    else rows.push({ kind: "process", id: `process:${entry.id}`, entries: [entry] });
  }
  return rows;
}

export function transcriptPlan(timeline: ProcessEntry[], output: string, status?: RunStatus) {
  const rows = transcriptRows(timeline);
  const publicRows = rows.filter((row) => row.kind === "public");
  const publicEntries = orderedProcessEntries(timeline).filter((entry) => entry.kind === "progress");
  const finalIds = new Set(publicRows.filter((row) => row.entry.final).map((row) => row.id));
  // Output is authoritative even when a saved timeline contains commentary only.
  const normalized = output.trim();
  const candidates = publicEntries.filter((entry) => entry.pending || entry.final);
  const matchesOutput = (texts: string[]) => Boolean(normalized) && (
    texts.join("").trim() === normalized || texts.join("\n\n").trim() === normalized
  );
  const candidatesMatch = matchesOutput(candidates.map((entry) => entry.text ?? ""));
  let represented = !normalized || candidatesMatch;
  if (candidatesMatch && status === "completed" && !finalIds.size) {
    for (const entry of candidates) finalIds.add(entry.id);
  }
  const suffix: string[] = [];
  for (let index = publicEntries.length - 1; index >= 0 && !represented; index -= 1) {
    suffix.unshift(publicEntries[index].text ?? "");
    if (!matchesOutput(suffix)) continue;
    represented = true;
    if (status === "completed" && !finalIds.size) {
      for (const entry of publicEntries.slice(index)) finalIds.add(entry.id);
    }
  }
  const fallback = represented ? "" : output;
  const hasFinal = finalIds.size > 0 || Boolean(fallback.trim());
  const hasWork = rows.some((row) => row.kind === "process" || !finalIds.has(row.id));
  return { rows, finalIds, fallback, hasWork, canRollUp: status === "completed" && hasFinal && hasWork };
}

export function terminalPublicReply(timeline: ProcessEntry[], output: string, status?: RunStatus) {
  if (status === "completed" && output.trim()) return output;
  const plan = transcriptPlan(timeline, output, status);
  const entries = orderedProcessEntries(timeline).filter((entry) => entry.kind === "progress");
  const candidates = entries.filter((entry) => entry.pending || entry.final);
  const mergeCandidates = Boolean(output.trim()) && candidates.map((entry) => entry.text ?? "").join("").trim() === output.trim();
  const groups: { source: string; candidate: boolean; text: string }[] = [];
  for (const entry of entries) {
    const source = entry.id.replace(/:segment-\d+$/, "");
    const candidate = Boolean(entry.pending || entry.final);
    const previous = groups.at(-1);
    // Copy the original public bytes, not the separate chronological Markdown roots.
    if (previous && ((source && previous.source === source) || (mergeCandidates && candidate && previous.candidate))) {
      previous.text += entry.text ?? "";
      previous.candidate = previous.candidate && candidate;
    } else groups.push({ source, candidate, text: entry.text ?? "" });
  }
  const blocks = groups.filter((group) => group.text.trim()).map((group) => group.text);
  if (plan.fallback.trim()) blocks.push(plan.fallback);
  return blocks.join("\n\n");
}

export function formatReasoningDisplay(text: string) {
  const value = text.trim();
  // Some relays flatten complete bold-only titles. Repair only that exact format.
  if (!/^(?:\*\*[^*\r\n]+\*\*\s*){2,}$/.test(value)) return text;
  return (value.match(/\*\*[^*\r\n]+\*\*/g) ?? []).join("\n\n");
}
