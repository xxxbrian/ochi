import type { ProcessEntry, Step } from "../contracts";

const outputCache = new WeakMap<Step, { output: string | undefined; result: Record<string, unknown> | null }>();

function toolOutput(step: Step): Record<string, unknown> | null {
  const cached = outputCache.get(step);
  if (cached && cached.output === step.output) return cached.result;
  let result: Record<string, unknown> | null = null;
  if (step.output?.trimStart().startsWith("{") && step.output.includes('"executed"')) {
    try {
      const value: unknown = JSON.parse(step.output);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const fields = value as Record<string, unknown>;
        result = {
          executed: fields.executed, status: fields.status, resource: fields.resource, request_id: fields.request_id,
          active_wait_ms: fields.active_wait_ms, waiting_ahead: fields.waiting_ahead, observed_at: fields.observed_at,
        };
      }
    } catch { /* Unstructured tool output has no queue metadata. */ }
  }
  outputCache.set(step, { output: step.output, result });
  return result;
}

export function isExecutedStep(step: Step) {
  return step.outcome ? step.outcome !== "not_executed" : toolOutput(step)?.executed !== false;
}

export function isCompletedStep(step: Step) {
  return step.status === "completed" && step.outcome !== "needs_user" && isExecutedStep(step);
}

export type ComputerQueueProgress = { resource: "desktop" | "project" } & (
  | { status: "acquired" }
  | {
    status: "waiting" | "paused";
    requestId: string;
    activeWaitMs: number;
    waitingAhead: number;
    observedAt?: string;
  });

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function computerQueueProgress(step: Step): ComputerQueueProgress | null {
  const result = toolOutput(step);
  if (result?.executed !== false || (result.resource !== "desktop" && result.resource !== "project")) return null;
  const resource = result.resource;
  if (result.status === "acquired") return { status: "acquired", resource };
  if ((result.status !== "waiting" && result.status !== "paused") ||
    typeof result.request_id !== "string" || !result.request_id.trim() ||
    !nonnegativeInteger(result.active_wait_ms) || !nonnegativeInteger(result.waiting_ahead)) return null;
  return {
    status: result.status, resource, requestId: result.request_id,
    activeWaitMs: result.active_wait_ms, waitingAhead: result.waiting_ahead,
    observedAt: typeof result.observed_at === "string" && Number.isFinite(Date.parse(result.observed_at))
      ? result.observed_at : undefined,
  };
}

export function latestComputerQueue(entries: ProcessEntry[]) {
  let latest: { seq: number; progress: ComputerQueueProgress } | undefined;
  for (const entry of entries) {
    if (entry.step?.status !== "running" || latest && entry.seq < latest.seq) continue;
    const progress = computerQueueProgress(entry.step);
    if (progress?.status === "waiting") latest = { seq: entry.seq, progress };
  }
  return latest?.progress ?? null;
}

export function computerQueueWaitMilliseconds(progress: ComputerQueueProgress, now?: number) {
  if (progress.status === "acquired") return 0;
  const observed = Date.parse(progress.observedAt ?? "");
  return progress.activeWaitMs + (progress.status === "waiting" && now !== undefined && Number.isFinite(now) && Number.isFinite(observed)
    ? Math.max(0, now - observed) : 0);
}
