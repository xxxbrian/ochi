import type {
  ArtifactsEvent,
  OutputReset,
  OutputCommit,
  ProgressEvent,
  ReasoningDelta,
  Snapshot,
  StatusEvent,
  StepEvent,
  TextDelta,
  UsageEvent,
  WaitingEvent,
} from './types'

export type RunEvent =
  | { kind: 'snapshot'; value: Snapshot }
  | { kind: 'text_delta'; value: TextDelta }
  | { kind: 'reasoning_delta'; value: ReasoningDelta }
  | { kind: 'step'; value: StepEvent }
  | { kind: 'status'; value: StatusEvent }
  | { kind: 'output_reset'; value: OutputReset }
  | { kind: 'output_commit'; value: OutputCommit }
  | { kind: 'progress'; value: ProgressEvent }
  | { kind: 'usage'; value: UsageEvent }
  | { kind: 'waiting'; value: WaitingEvent }
  | { kind: 'artifacts'; value: ArtifactsEvent }

export function parseRunEvent(event: MessageEvent<string>): RunEvent | null {
  try {
    const value = JSON.parse(event.data) as Record<string, unknown>
    switch (event.type) {
      case 'snapshot':
        return { kind: 'snapshot', value: value as unknown as Snapshot }
      case 'text_delta':
        return { kind: 'text_delta', value: value as unknown as TextDelta }
      case 'reasoning_delta':
        return { kind: 'reasoning_delta', value: value as unknown as ReasoningDelta }
      case 'step':
        return { kind: 'step', value: value as unknown as StepEvent }
      case 'status':
        return { kind: 'status', value: value as unknown as StatusEvent }
      case 'output_reset':
        return { kind: 'output_reset', value: value as unknown as OutputReset }
      case 'output_commit':
        return { kind: 'output_commit', value: value as unknown as OutputCommit }
      case 'progress':
        return { kind: 'progress', value: value as unknown as ProgressEvent }
      case 'usage':
        return { kind: 'usage', value: value as unknown as UsageEvent }
      case 'waiting':
        return { kind: 'waiting', value: value as unknown as WaitingEvent }
      case 'artifacts':
        return { kind: 'artifacts', value: value as unknown as ArtifactsEvent }
      default:
        return null
    }
  } catch {
    return null
  }
}
