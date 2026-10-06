import { useState } from "react";
import { Clock3, Pencil, Trash2 } from "lucide-react";
import type { PendingRun } from "../lib/types";
import { Modal } from "./Modal";
import "./execution.css";
export function QueueTray({
  items,
  onCancel,
  onEdit,
}: {
  items: PendingRun[];
  onCancel: (id: string) => Promise<void>;
  onEdit: (id: string, message: string) => Promise<void>;
}) {
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
      setError(reason instanceof Error ? reason.message : "保存失败");
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
              <small>排队 {index + 1}</small>
              {item.message}
            </span>
            <button
              className="icon-button"
              aria-label="编辑排队消息"
              onClick={() => {
                setEditing(item);
                setText(item.message);
                setError("");
              }}
            >
              <Pencil size={14} />
            </button>
            <button
              className="icon-button"
              aria-label="取消排队消息"
              onClick={() => void onCancel(item.run_id)}
            >
              <Trash2 size={14} />
            </button>
          </article>
        ))}
      </div>
      {editing && (
        <Modal
          title="编辑排队消息"
          onClose={() => setEditing(null)}
          footer={
            <>
              <button
                className="secondary-button"
                onClick={() => setEditing(null)}
                disabled={busy}
              >
                取消
              </button>
              <button
                className="primary-button"
                disabled={busy || !text.trim()}
                onClick={() => void save()}
              >
                保存
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
              className="field-input"
              rows={5}
              value={text}
              onChange={(event) => setText(event.target.value)}
              aria-label="排队消息内容"
            />
            {error && <p className="form-error">{error}</p>}
          </form>
        </Modal>
      )}
    </>
  );
}
