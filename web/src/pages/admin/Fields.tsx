import { t, useAdminI18n } from "./i18n";
import { LoaderCircle, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
export function Field({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  useAdminI18n();
  return (
    <label className="form-field">
      <span>{title}</span>
      {children}
    </label>
  );
}
export function Toggle({
  title,
  value,
  onChange,
  disabled,
}: {
  title: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  useAdminI18n();
  return (
    <label className="toggle-field">
      <span>{title}</span>
      <input
        type="checkbox"
        role="switch"
        checked={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
export function InlineSwitch({
  title,
  value,
  onChange,
  updating,
}: {
  title: string;
  value: boolean;
  onChange: (value: boolean) => void;
  updating?: boolean;
}) {
  useAdminI18n();
  return (
    <label className={`admin-inline-switch${updating ? " is-pending" : ""}`} title={title}>
      <input type="checkbox" role="switch" aria-label={title}
        checked={value} disabled={updating} aria-busy={updating}
        onChange={(event) => onChange(event.target.checked)} />
      {updating && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
    </label>
  );
}
export type KeyValue = { key: string; value: string; retained?: boolean };
export function keyRows(
  keys: string[] = [],
  values: Record<string, string> = {},
): KeyValue[] {
  return Array.from(new Set([...keys, ...Object.keys(values)])).map((key) => ({
    key,
    value: values[key] ?? "",
    retained: true,
  }));
}
export function rowsObject(rows: KeyValue[]) {
  return Object.fromEntries(
    rows
      .filter((row) => row.key.trim() && (row.value || !row.retained))
      .map((row) => [row.key.trim(), row.value]),
  );
}
export function KeyValueEditor({
  rows,
  onChange,
  onRemove,
  secret,
  labels = [t("name"), t("value")],
}: {
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  onRemove?: (key: string) => void;
  secret?: boolean;
  labels?: string[];
}) {
  useAdminI18n();
  return (
    <div className="key-value-editor">
      {rows.map((row, index) => (
        <div className="key-value-row" key={index}>
          <input
            aria-label={labels[0]}
            value={row.key}
            placeholder={labels[0]}
            readOnly={row.retained}
            onChange={(event) =>
              onChange(
                rows.map((item, i) =>
                  i === index ? { ...item, key: event.target.value } : item,
                ),
              )
            }
          />
          <input
            aria-label={labels[1]}
            value={row.value}
            placeholder={row.retained ? t("keepExistingValue") : labels[1]}
            type={secret ? "password" : "text"}
            autoComplete="off"
            onChange={(event) =>
              onChange(
                rows.map((item, i) =>
                  i === index ? { ...item, value: event.target.value } : item,
                ),
              )
            }
          />
          <button
            type="button"
            className="icon-button"
            aria-label={t("deleteConfigEntry")}
            onClick={() => {
              if (row.retained) onRemove?.(row.key);
              onChange(rows.filter((_, i) => i !== index));
            }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-button"
        onClick={() => onChange([...rows, { key: "", value: "" }])}
      >
        <Plus size={14} />
        {t("addEntry")}</button>
    </div>
  );
}
export function ErrorNotice({
  error,
  notice,
}: {
  error?: string;
  notice?: string;
}) {
  useAdminI18n();
  return (
    <>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="form-success" role="status">
          {notice}
        </div>
      )}
    </>
  );
}
