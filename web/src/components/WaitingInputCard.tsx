import { t, useI18n } from "../lib/i18n";
import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { ComputerPermissionAnswer, WaitingInput } from "../lib/types";
import "./execution.css";

const computerChoices: {
  value: ComputerPermissionAnswer;
  labelKey: Parameters<typeof t>[0];
  className: string;
}[] = [
  { value: "allow_once", labelKey: "permission.once", className: "primary-button" },
  {
    value: "allow_session",
    labelKey: "permission.conversation",
    className: "secondary-button",
  },
  { value: "deny", labelKey: "permission.deny", className: "text-button" },
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
  useI18n();
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
      setError(reason instanceof Error ? reason.message : t("error.send"));
    } finally {
      setBusy(false);
    }
  }

  if (waiting.kind === "computer_permission") {
    return (
      <section className="permission-card" aria-busy={busy}>
        <div className="permission-heading">
          <ShieldCheck size={18} />
          <h3>{t("permission.computer")}</h3>
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
              {t(choice.labelKey)}
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
          placeholder={t("waiting.placeholder")}
          aria-label={t("waiting.reply")}
          disabled={busy}
        />
        <button
          type="button"
          onClick={() => void resume()}
          disabled={!answer.trim() || busy}
        >
          {t("common.continue")}
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
