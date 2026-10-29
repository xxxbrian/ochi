import { t, useI18n } from "../lib/i18n";
import { memo } from "react";
import { instructionIssueText, instructionStatusLabel, type InstructionIssue, type InstructionReceipt } from "../lib/runInstructions";
import "./run-instructions.css";

export const RunInstructionStatus = memo(function RunInstructionStatus({
  items, error, syncError, retryPending, submitting, onRetry, onRefresh,
}: {
  items: InstructionReceipt[];
  error: InstructionIssue | null;
  syncError: InstructionIssue | null;
  retryPending: boolean;
  submitting: boolean;
  onRetry: () => Promise<boolean>;
  onRefresh: () => Promise<void>;
}) {
  useI18n();
  if (!items.length && !error && !syncError) return null;
  return <div className="run-instructions" aria-label={t("instruction.title")}>
    {items.map((item) => <div className="run-instructions__receipt" key={item.id}>
      <span className="run-instructions__content" title={item.content}>{item.content}</span>
      <span className="run-instructions__status" role="status">{instructionStatusLabel(item.status)}</span>
    </div>)}
    {(error || syncError) && <div className="run-instructions__notice" role="status">
      <span>{instructionIssueText(error || syncError)}</span>
      {(retryPending || syncError) && <button type="button" disabled={submitting}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void (retryPending ? onRetry() : onRefresh())}>{t("common.retry")}</button>}
    </div>}
  </div>;
});
