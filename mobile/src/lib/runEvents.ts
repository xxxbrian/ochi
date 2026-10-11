import type { RunEvent } from '../../../web/src/lib/sse';
import type { Snapshot } from './types';
import { applyProcessEvent } from './processTimeline';

const eventNames = new Set(['snapshot', 'text_delta', 'reasoning_delta', 'step', 'status', 'output_reset', 'output_commit', 'progress', 'usage', 'waiting', 'artifacts']);

export function parseRunFrame(frame: string): RunEvent | null {
  let kind = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) kind = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!eventNames.has(kind) || !data.length) return null;
  try {
    const value: unknown = JSON.parse(data.join('\n'));
    if (!value || typeof value !== 'object' || !('run_id' in value) || !('seq' in value)) return null;
    return { kind, value } as RunEvent;
  } catch { return null; }
}


export function applyRunEvent(current: Snapshot, event: Exclude<RunEvent, { kind: 'snapshot' }>): Snapshot {
  if (event.value.run_id !== current.run_id || event.value.seq <= current.seq) return current;
  const timeline = applyProcessEvent(current.timeline, event.value);
  const next = { ...current, seq: event.value.seq, updated_at: event.value.updated_at,
    ...(timeline !== current.timeline ? { timeline } : {}) };
  switch (event.kind) {
    case 'text_delta': return { ...next, output: current.output + event.value.text };
    case 'reasoning_delta': {
      const delta = event.value.reasoning;
      const reasoning = [...(current.reasoning ?? [])];
      const index = reasoning.findIndex((part) => part.id === delta.id);
      if (index >= 0) {
        const previous = reasoning[index]!;
        reasoning[index] = { ...previous, text: previous.text + delta.text, done: delta.done };
      } else if (delta.text) reasoning.push(delta);
      return { ...next, reasoning };
    }
    case 'step': {
      const steps = [...(current.steps ?? [])];
      const index = steps.findIndex((step) => step.id === event.value.step.id);
      if (index >= 0) steps[index] = event.value.step;
      else steps.push(event.value.step);
      return { ...next, steps };
    }
    case 'output_reset': return { ...next, output: '' };
    case 'output_commit': return { ...next, output: event.value.text ?? '' };
    case 'progress': return { ...next, output: event.value.text ?? '' };
    case 'usage': return { ...next, usage: event.value.usage };
    case 'waiting': return { ...next, status: event.value.status, waiting_input: event.value.waiting_input,
      resource: event.value.resource,
      computer_granted: event.value.computer_granted ?? current.computer_granted };
    case 'artifacts': return { ...next, artifacts: event.value.artifacts };
    case 'status': return { ...next, status: event.value.status, error: event.value.error,
      waiting_input: event.value.status === 'running' ? undefined : current.waiting_input,
      computer_granted: event.value.computer_granted ?? current.computer_granted };
  }
}

