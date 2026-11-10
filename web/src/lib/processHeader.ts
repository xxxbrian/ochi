import { t } from "./i18n";
import { latestComputerQueue, type ComputerQueueProgress } from "../../../shared/conversation/computerQueue";
import { computerQueueLabel } from "../../../shared/i18n/process";
import { formatProcessElapsed } from "./processTiming";
import { countedSteps, lastMatching, orderedProcessEntries, toolInfo, toolSubject } from "./processTimeline";
import type { ProcessEntry, RunStatus, WaitingInput } from "./types";

export type HeaderState = "running" | "waiting" | "done" | "failed" | "stopped";

export type HeaderModel = {
  // Changes whenever the label should roll (not on every token), so the header animates per phase.
  id: string;
  state: HeaderState;
  label: string;
  // Subject of the running tool call (command, path, URL, query), shown in monospace after the label.
  sub: string;
  mono: boolean;
  // Live resource queue for the computer, when the run is waiting for it.
  queue: ComputerQueueProgress | null;
  counted: ReturnType<typeof countedSteps>;
  // Settled duration, shown at the far right of a finished header (failed/stopped keep it in the sentence).
  duration: string;
};

const clip = (value: string, length: number) => (value.length > length ? `${value.slice(0, length)}…` : value);

export function describeHeader({ status, active, entries, waitingKind, resource, durationMs }: {
  status?: RunStatus;
  active: boolean;
  entries: ProcessEntry[];
  waitingKind?: WaitingInput["kind"];
  resource?: string;
  durationMs: number | null;
}): HeaderModel {
  const ordered = orderedProcessEntries(entries);
  const steps = ordered.flatMap((entry) => (entry.step ? [entry.step] : []));
  const counted = countedSteps(ordered);
  const queue = status === "waiting_resource" ? latestComputerQueue(ordered) : null;
  const latest = lastMatching(ordered, (entry) => Boolean(entry.step || entry.reasoning?.text.trim() || entry.text?.trim()));
  const tool = lastMatching(steps, (step) => step.status === "running");
  const working = active && status === "running";
  const failed = status === "failed" || status === "interrupted";
  const stopped = status === "cancelled";
  const waiting = status === "waiting_user" || status === "waiting_resource";
  const thinking = working && latest?.kind === "reasoning" && !latest.reasoning?.done;
  const duration = durationMs === null ? "" : formatProcessElapsed(durationMs);
  const state: HeaderState = failed ? "failed" : stopped ? "stopped" : waiting ? "waiting" : active ? "running" : "done";
  const model = (id: string, label: string, sub = "", mono = false, settled = ""): HeaderModel => ({ id, state, label, sub, mono, queue, counted, duration: settled });

  if (failed) return model("failed", duration ? t("process.failedAfter", { duration }) : t("status.failed"));
  if (stopped) return model("stopped", duration ? t("process.stoppedAfter", { duration }) : t("status.stopped"));
  if (status === "cancelling") return model("stopping", t("status.stopping"));
  if (status === "queued") return model("queued", t("status.queued"));
  if (status === "waiting_resource") {
    const label = queue ? computerQueueLabel(queue) : resource?.includes("desktop") || resource?.includes("computer") ? t("process.waitComputer") : t("process.waitProject");
    return model(`wait:${label}`, label);
  }
  if (status === "waiting_user") {
    const label = waitingKind === "computer_permission" ? t("status.awaitingPermission") : t("status.awaitingReply");
    return model(`wait:${label}`, label);
  }
  if (working && tool) return model(`tool:${tool.id}`, toolInfo(tool.name).running, clip(toolSubject(tool), 80), true);
  if (thinking) return model("think", t("process.thinking"));
  if (active) {
    if (!ordered.length) return model("work", t("status.processing"));
    return model("write", latest?.kind === "progress" ? t("process.replying") : t("process.writing"));
  }
  if (status === "completed" && ordered.length) {
    if (counted.length) return model("done", duration ? t("process.processed") : t("status.completed"), t("process.toolCalls", { count: counted.length }), false, duration);
    const reasoned = ordered.some((entry) => entry.kind === "reasoning");
    return model("done", reasoned ? t("process.thought") : duration ? t("process.processed") : t("status.completed"), "", false, duration);
  }
  return model("done", status === "completed" ? t("status.completed") : t("process.title"));
}
