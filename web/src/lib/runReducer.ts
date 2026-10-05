import type { RunEvent } from "./sse";
import type { Snapshot } from "./types";
import { orderedProcessEntries, upsertProcessEntry } from "./processTimeline";

export function reduceRunDelta(current: Snapshot, event: Exclude<RunEvent, { kind: "snapshot" }>): Snapshot {
  const next: Snapshot = { ...current, seq: event.value.seq, updated_at: event.value.updated_at };
  const value = event.value;
  if (event.kind === "text_delta") {
    next.output = current.output + event.value.text;
  } else if (event.kind === "reasoning_delta") {
    const delta = event.value.reasoning;
    const reasoning = (current.reasoning ?? []).slice();
    const index = reasoning.findIndex((part) => part.id === delta.id);
    if (index >= 0) reasoning[index] = { ...reasoning[index], text: reasoning[index].text + delta.text, done: delta.done };
    else if (delta.text) reasoning.push(delta);
    next.reasoning = reasoning;
  } else if (event.kind === "step") {
    const steps = current.steps.slice();
    const index = steps.findIndex((step) => step.id === event.value.step.id);
    if (index >= 0) steps[index] = event.value.step;
    else steps.push(event.value.step);
    next.steps = steps;
  } else if (event.kind === "output_reset") {
    next.output = "";
  } else if (event.kind === "output_commit") {
    next.output = event.value.text ?? "";
  } else if (event.kind === "progress") {
    next.output = event.value.text ?? "";
  } else if (event.kind === "usage") {
    next.usage = event.value.usage;
  } else if (event.kind === "waiting") {
    next.status = event.value.status;
    next.waiting_input = event.value.waiting_input;
    next.resource = event.value.resource;
    next.computer_granted = event.value.computer_granted ?? current.computer_granted;
  } else if (event.kind === "artifacts") {
    next.artifacts = event.value.artifacts;
  } else if (event.kind === "status") {
    next.status = event.value.status;
    next.waiting_input = event.value.status === "running" ? undefined : current.waiting_input;
    next.error = event.value.error;
    next.computer_granted = event.value.computer_granted ?? current.computer_granted;
  }
  if (value.timeline !== undefined) next.timeline = orderedProcessEntries(value.timeline);
  if (value.timeline_entry) next.timeline = upsertProcessEntry(next.timeline, value.timeline_entry);
  return next;
}
