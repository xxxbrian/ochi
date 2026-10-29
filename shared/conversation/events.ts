import type { Artifact, RunItem, RunStatus, Snapshot, Step, Usage, WaitingInput } from "../contracts";

type EventMetadata = { run_id: string; seq: number; updated_at: string };
export type ItemPatch = { item_id: string; phase?: RunItem["phase"]; state?: RunItem["state"]; step?: Step };
export type RunEvent =
  | { kind: "snapshot"; value: Snapshot }
  | { kind: "item_started"; value: EventMetadata & { item: RunItem } }
  | { kind: "item_delta"; value: EventMetadata & { item_id: string; delta: string } }
  | { kind: "item_updated"; value: EventMetadata & { patches: ItemPatch[] } }
  | { kind: "status"; value: EventMetadata & { status: RunStatus; error?: string; error_code?: string; computer_granted?: boolean; resource?: string } }
  | { kind: "waiting"; value: EventMetadata & { status: RunStatus; waiting_input?: WaitingInput; resource?: string; computer_granted?: boolean } }
  | { kind: "usage"; value: EventMetadata & { usage: Usage } }
  | { kind: "artifacts"; value: EventMetadata & { artifacts: Artifact[] } };

export const runEventNames = ["snapshot", "item_started", "item_delta", "item_updated", "status", "waiting", "usage", "artifacts"] as const;

export function parseRunEvent(event: { type: string; data: string }): RunEvent | null {
  if (!(runEventNames as readonly string[]).includes(event.type)) return null;
  try {
    const value: unknown = JSON.parse(event.data);
    if (!value || typeof value !== "object" || !("run_id" in value) || !("seq" in value) ||
      typeof value.run_id !== "string" || typeof value.seq !== "number") return null;
    return { kind: event.type, value } as RunEvent;
  } catch { return null; }
}

export function parseRunFrame(frame: string): RunEvent | null {
  let type = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length ? parseRunEvent({ type, data: data.join("\n") }) : null;
}

export function isActiveStatus(status?: string) {
  return status === "running" || status === "waiting_user" || status === "waiting_resource" || status === "cancelling";
}

// Only the owning item changes identity. Reading/expansion state stays attached
// to all other items while tokens arrive.
export function reduceRunDelta(current: Snapshot, event: Exclude<RunEvent, { kind: "snapshot" }>): Snapshot {
  if (event.value.run_id !== current.run_id || event.value.seq <= current.seq) return current;
  const next = { ...current, seq: event.value.seq, updated_at: event.value.updated_at };
  switch (event.kind) {
    case "item_started": {
      if (current.items.some((item) => item.id === event.value.item.id)) return next;
      return { ...next, items: [...current.items, event.value.item] };
    }
    case "item_delta":
      return { ...next, items: current.items.map((item) => item.id === event.value.item_id
        ? { ...item, text: (item.text ?? "") + event.value.delta } : item) };
    case "item_updated": {
      const patches = new Map(event.value.patches.map((patch) => [patch.item_id, patch]));
      return { ...next, items: current.items.map((item) => {
        const patch = patches.get(item.id);
        if (!patch) return item;
        const { item_id: _id, ...changes } = patch;
        return { ...item, ...changes };
      }) };
    }
    case "status":
      return { ...next, status: event.value.status, error: event.value.error, error_code: event.value.error_code,
        waiting_input: event.value.status === "waiting_user" ? current.waiting_input : undefined,
        resource: event.value.resource,
        computer_granted: event.value.computer_granted ?? current.computer_granted };
    case "waiting":
      return { ...next, status: event.value.status, waiting_input: event.value.waiting_input,
        resource: event.value.resource, computer_granted: event.value.computer_granted ?? current.computer_granted };
    case "usage": return { ...next, usage: event.value.usage };
    case "artifacts": return { ...next, artifacts: event.value.artifacts };
  }
}
