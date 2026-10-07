import { memo } from "react";
import { instructionStatusLabel, type InstructionReceipt } from "../lib/runInstructions";
import "./run-instructions.css";

export const RunInstructionStatus = memo(function RunInstructionStatus({
  items, error, syncError, retryPending, submitting, onRetry, onRefresh,
}: {
  items: InstructionReceipt[];
  error: string;
  syncError: string;
  retryPending: boolean;
  submitting: boolean;
  onRetry: () => Promise<boolean>;
  onRefresh: () => Promise<void>;
}) {
  if (!items.length && !error && !syncError) return null;
  return <div className="run-instructions" aria-label="补充要求">
    {items.map((item) => <div className="run-instructions__receipt" key={item.id}>
      <span className="run-instructions__content" title={item.content}>{item.content}</span>
      <span className="run-instructions__status" role="status">{instructionStatusLabel(item.status)}</span>
    </div>)}
    {(error || syncError) && <div className="run-instructions__notice" role="status">
      <span>{error || syncError}</span>
      {(retryPending || syncError) && <button type="button" disabled={submitting}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void (retryPending ? onRetry() : onRefresh())}>重试</button>}
    </div>}
  </div>;
});
