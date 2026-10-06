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
  const finalIds = new Set(publicRows.filter((row) => row.entry.final).map((row) => row.id));
  // Output is authoritative even when a saved timeline contains commentary only.
  const normalized = output.trim();
  const candidates = publicRows.filter((row) => row.entry.pending || row.entry.final);
  const candidatesMatch = Boolean(normalized) && candidates.map((row) => row.entry.text ?? "").join("").trim() === normalized;
  let represented = !normalized || candidatesMatch;
  if (candidatesMatch && status === "completed" && !finalIds.size) {
    for (const row of candidates) finalIds.add(row.id);
  }
  let suffix = "";
  for (let index = publicRows.length - 1; index >= 0 && !represented; index -= 1) {
    suffix = (publicRows[index].entry.text ?? "") + suffix;
    if (suffix.trim() !== normalized) continue;
    represented = true;
    if (status === "completed" && !finalIds.size) {
      for (const row of publicRows.slice(index)) finalIds.add(row.id);
    }
  }
  const fallback = represented ? "" : output;
  const hasFinal = finalIds.size > 0 || Boolean(fallback.trim());
  const hasWork = rows.some((row) => row.kind === "process" || !finalIds.has(row.id));
  return { rows, finalIds, fallback, hasWork, canRollUp: status === "completed" && hasFinal && hasWork };
}

export function formatReasoningDisplay(text: string) {
  const value = text.trim();
  // Some relays flatten complete bold-only titles. Repair only that exact format.
  if (!/^(?:\*\*[^*\r\n]+\*\*\s*){2,}$/.test(value)) return text;
  return (value.match(/\*\*[^*\r\n]+\*\*/g) ?? []).join("\n\n");
}
