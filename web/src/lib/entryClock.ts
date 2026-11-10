import { useRef } from "react";
import type { ProcessEntry } from "./types";

// Entries present when a timeline first mounts are history: they neither animate in nor get a clock.
// Entries that arrive afterwards are timed locally, because the API does not persist reasoning time.
export type EntryClock = { initial: Set<string>; times: Map<string, { t0: number; t1?: number }> };

export function useEntryClock(timeline: ProcessEntry[]): EntryClock {
  const clock = useRef<EntryClock | null>(null);
  clock.current ??= { initial: new Set(timeline.map((entry) => entry.id)), times: new Map() };
  const { initial, times } = clock.current;
  for (const entry of timeline) {
    if (initial.has(entry.id)) continue;
    const record = times.get(entry.id) ?? { t0: Date.now() };
    times.set(entry.id, record);
    const done = entry.kind === "reasoning" ? Boolean(entry.reasoning?.done) : entry.step ? entry.step.status !== "running" : false;
    if (done && record.t1 === undefined) record.t1 = Date.now();
  }
  return clock.current;
}
