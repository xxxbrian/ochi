import { t, useI18n } from "../lib/i18n";
import { useState, type CSSProperties, type ReactNode } from "react";
import { FolderOpen, LockKeyhole, Monitor, ShieldAlert, Wrench } from "lucide-react";
import type { WaitingInput } from "../lib/types";
import { permissionAnswerDecision, type PermissionDecision } from "../lib/computerAction";
import { PermissionResult } from "./ComputerSteps";
import "./waiting-input.css";

const capabilities: {
  icon: ReactNode;
  title: Parameters<typeof t>[0];
  hint: Parameters<typeof t>[0];
}[] = [
  { icon: <FolderOpen size={15} />, title: "permission.capFiles", hint: "permission.capFilesHint" },
  { icon: <Monitor size={15} />, title: "permission.capDesktop", hint: "permission.capDesktopHint" },
  { icon: <Wrench size={15} />, title: "permission.capTools", hint: "permission.capToolsHint" },
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
  // The permission card resolves in place as soon as a choice is sent.
  const [decision, setDecision] = useState<PermissionDecision | null>(null);

  async function resume(value = answer) {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError("");
    if (waiting.kind === "computer_permission") setDecision(permissionAnswerDecision(value));
    try {
      await onResume(runId, value.trim());
      setAnswer("");
    } catch (reason) {
      setDecision(null);
      setError(reason instanceof Error ? reason.message : t("error.send"));
    } finally {
      setBusy(false);
    }
  }

  if (waiting.kind === "computer_permission") {
    const pending = !decision;
    return (
      <section className="cu-perm" data-state={decision ?? "pending"} aria-busy={busy}>
        <div className="cu-fold" data-open={pending} inert={!pending}>
          <div>
            <div className="cu-perm-body">
              <div className="cu-perm-top">
                <span className="cu-perm-tile" aria-hidden><Monitor size={20} /><i /></span>
                <div>
                  <h3>{t("permission.heading")}</h3>
                  <p>{t("permission.intro")}</p>
                </div>
              </div>
              <blockquote className="cu-perm-reason">{waiting.question}</blockquote>
              <ul className="cu-caps">
                {capabilities.map(({ icon, title, hint }, index) => (
                  <li key={title} style={{ "--i": index } as CSSProperties}>
                    {icon}<b>{t(title)}</b><span>{t(hint)}</span>
                  </li>
                ))}
              </ul>
              <div className="cu-perm-note">
                <span className="cu-scope"><LockKeyhole size={13} aria-hidden />{t("permission.scopeChip")}</span>
                <span><ShieldAlert size={13} aria-hidden />{t("permission.notice")}</span>
              </div>
              <div className="cu-perm-actions">
                <button type="button" className="btn ghost" disabled={busy} onClick={() => void resume("deny")}>
                  {t("permission.deny")}
                </button>
                <span className="cu-spacer" />
                <button type="button" className="btn secondary" disabled={busy} onClick={() => void resume("allow_once")}>
                  {t("permission.once")}
                </button>
                <button type="button" className="btn primary" disabled={busy} onClick={() => void resume("allow_session")}>
                  {t("permission.conversation")}
                </button>
              </div>
              {error && <p className="form-error" role="alert">{error}</p>}
            </div>
          </div>
        </div>
        <div className="cu-fold" data-open={!pending} inert={pending}>
          <div>{decision && <PermissionResult decision={decision} />}</div>
        </div>
      </section>
    );
  }

  return (
    <section className="ask-card" aria-busy={busy}>
      <p className="q">{waiting.question}</p>
      {waiting.options?.length ? (
        <div className="opts">
          {waiting.options.map((option) => (
            <button
              type="button"
              key={option}
              className="opt"
              aria-pressed={answer === option}
              onClick={() => setAnswer(option)}
              disabled={busy}
            >
              <b>{option}</b>
            </button>
          ))}
        </div>
      ) : null}
      <div className="free">
        <input
          className="input"
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
          className="btn primary sm"
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
