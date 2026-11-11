import { t, useAdminI18n } from "./i18n";
import { CircleAlert, CircleCheck, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { SkeletonRows, Switch } from "./ui";

/** Lab `.ad-field`: label above, control, optional hint. Wrapping in <label> keeps click-to-focus. */
export function Field({ title, children, hint }: { title: string; children: ReactNode; hint?: ReactNode }) {
  useAdminI18n();
  return (
    <label className="ad-field">
      <span className="field-label">{title}</span>
      {children}
      {hint ? <p className="field-hint">{hint}</p> : null}
    </label>
  );
}

/** Settings row: title and detail on the left, switch on the right (lab `.ad-setrow`). */
export function Toggle({ title, value, onChange, disabled, detail }: {
  title: string; value: boolean; onChange: (value: boolean) => void; disabled?: boolean; detail?: ReactNode;
}) {
  useAdminI18n();
  return (
    <div className="ad-setrow">
      <div><b>{title}</b>{detail ? <small>{detail}</small> : null}</div>
      <Switch on={value} label={title} onChange={onChange} disabled={disabled} />
    </div>
  );
}

export function InlineSwitch({ title, value, onChange, updating }: {
  title: string; value: boolean; onChange: (value: boolean) => void; updating?: boolean;
}) {
  useAdminI18n();
  return <Switch on={value} label={title} onChange={onChange} busy={updating} />;
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
    <div className="ad-kve">
      {rows.map((row, index) => (
        <div className="ad-kve-row" key={index}>
          <input
            className="input mono"
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
            className="input mono"
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
            className="icon-btn"
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
        className="btn ghost sm"
        onClick={() => onChange([...rows, { key: "", value: "" }])}
      >
        <Plus size={14} />
        {t("addEntry")}</button>
    </div>
  );
}
export function ErrorNotice({ error, notice }: { error?: string; notice?: string }) {
  useAdminI18n();
  return (
    <>
      {error && <div className="ad-alert" role="alert"><CircleAlert className="ic" /><div>{error}</div></div>}
      {notice && <div className="ad-alert ad-ok" role="status"><CircleCheck className="ic" /><div>{notice}</div></div>}
    </>
  );
}

/** Placeholder rows shown while an admin page loads; announced once to assistive tech. */
export function AdminSkeleton({ rows = 3 }: { label?: string; rows?: number }) {
  return <section className="ad-card ad-flush"><SkeletonRows rows={rows} /></section>;
}

/** Destructive actions stay disabled until the operator types the target's name. */
export function TypedConfirm({
  name,
  value,
  onChange,
  disabled,
}: {
  name: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  useAdminI18n();
  const label = t("typeToConfirm", { name });
  return (
    <Field title={label}>
      <input className="input mono" value={value} disabled={disabled} autoComplete="off" autoCapitalize="off" spellCheck={false}
        placeholder={name} aria-label={label} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}
export const confirmMatches = (value: string, name: string) => value.trim() === name.trim();
