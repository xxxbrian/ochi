import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { ComputerPermissionAnswer, WaitingInput } from "../lib/types";
import "./execution.css";

const computerChoices: {
  value: ComputerPermissionAnswer;
  label: string;
  className: string;
}[] = [
  { value: "allow_once", label: "仅本次", className: "primary-button" },
  {
    value: "allow_session",
    label: "此对话允许",
    className: "secondary-button",
  },
  { value: "deny", label: "不允许", className: "text-button" },
];

export function WaitingInputCard({
  waiting,
  runId,
  onResume,
}: {
  waiting: WaitingInput;
  runId: string;
  onResume: (runId: string, answer: string) => Promise<void>;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function resume(value = answer) {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await onResume(runId, value.trim());
      setAnswer("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "发送失败");
    } finally {
      setBusy(false);
    }
  }

  if (waiting.kind === "computer_permission") {
    return (
      <section className="permission-card" aria-busy={busy}>
        <div className="permission-heading">
          <ShieldCheck size={18} />
          <h3>使用电脑</h3>
        </div>
        <p>{waiting.question}</p>
        <div className="permission-actions">
          {computerChoices.map((choice) => (
            <button
              key={choice.value}
              type="button"
              className={choice.className}
              disabled={busy}
              onClick={() => void resume(choice.value)}
            >
              {choice.label}
            </button>
          ))}
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="waiting-card" aria-busy={busy}>
      <p>{waiting.question}</p>
      {waiting.options?.length ? (
        <div className="waiting-options">
          {waiting.options.map((option) => (
            <button
              type="button"
              key={option}
              className={answer === option ? "is-selected" : undefined}
              aria-pressed={answer === option}
              onClick={() => setAnswer(option)}
              disabled={busy}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <div className="waiting-input">
        <input
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing)
              void resume();
          }}
          placeholder="输入回复"
          aria-label="回复"
          disabled={busy}
        />
        <button
          type="button"
          onClick={() => void resume()}
          disabled={!answer.trim() || busy}
        >
          继续
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
