import { t, useI18n } from "../lib/i18n";
import { useState } from "react";
import { Clock3, Pencil, Trash2 } from "lucide-react";
import type { PendingRun } from "../lib/types";
import { Modal } from "./Modal";
import "./composer.css";
export function QueueTray({
  items,
  onCancel,
  onEdit,
}: {
  items: PendingRun[];
  onCancel: (id: string) => Promise<void>;
  onEdit: (id: string, message: string) => Promise<void>;
}) {
  useI18n();
  const [editing, setEditing] = useState<PendingRun | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    if (!editing || busy || !text.trim()) return;
    setBusy(true);
    setError("");
    try {
      await onEdit(editing.run_id, text.trim());
      setEditing(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("error.save"));
    } finally {
      setBusy(false);
    }
  }
  if (!items.length && !editing) return null;
  return (
    <>
      <div className="queue-tray">
        {items.map((item, index) => (
          <article key={item.run_id}>
            <Clock3 size={15} />
            <span>
              <small>{t("queue.title")} {index + 1}</small>
              {item.message}
            </span>
            <button
              className="icon-btn sm"
              aria-label={t("queue.edit")}
              onClick={() => {
                setEditing(item);
                setText(item.message);
                setError("");
              }}
            >
              <Pencil size={14} />
            </button>
            <button
              className="icon-btn sm"
              aria-label={t("queue.cancel")}
              onClick={() => void onCancel(item.run_id)}
            >
              <Trash2 size={14} />
            </button>
          </article>
        ))}
      </div>
      {editing && (
        <Modal
          title={t("queue.edit")}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button
                className="btn secondary"
                onClick={() => setEditing(null)}
                disabled={busy}
              >
                {t("common.cancel")}
              </button>
              <button
                className="btn primary"
                disabled={busy || !text.trim()}
                onClick={() => void save()}
              >
                {t("common.save")}
              </button>
            </>
          }
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <textarea
              className="textarea"
              rows={5}
              value={text}
              onChange={(event) => setText(event.target.value)}
              aria-label={t("queue.content")}
            />
            {error && <p className="form-error">{error}</p>}
          </form>
        </Modal>
      )}
    </>
  );
}
