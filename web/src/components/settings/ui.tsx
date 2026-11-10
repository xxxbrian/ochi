import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import type { User } from "../../lib/types";

/** Tabs report a successful change here: the header chip says "Saved" and the row flashes. */
export const SavedContext = createContext<{ flash: string; saved: (row?: string) => void }>({ flash: "", saved: () => undefined });
export const useSaved = () => useContext(SavedContext);

export function Sec({ title, note, extra, index, children, danger }: { title?: ReactNode; note?: ReactNode; extra?: ReactNode; index: number; children: ReactNode; danger?: boolean }) {
  return (
    <section className="st-sec" style={{ "--i": index } as CSSProperties} data-danger={danger || undefined}>
      {(title || extra) && <div className="st-sec-h"><h3>{title}</h3>{extra}</div>}
      {children}
      {note && <p className="st-note">{note}</p>}
    </section>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`st-card ${className}`.trim()}>{children}</div>;
}

export function Row({ id, title, desc, children, wide }: { id?: string; title: string; desc?: string; children: ReactNode; wide?: boolean }) {
  const { flash } = useSaved();
  return (
    <div className={`st-row${wide ? " st-row-wide" : ""}`} data-flash={(id && flash === id) || undefined}>
      <div className="st-rt"><b>{title}</b>{desc && <small>{desc}</small>}</div>
      <div className="st-ctl">{children}</div>
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" className="toggle" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}><i /></button>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; label: string }) {
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  return (
    <div className="seg st-seg" role="radiogroup" aria-label={label} style={{ "--n": options.length, "--i": index } as CSSProperties}>
      <span className="seg-thumb" aria-hidden="true" />
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={option.value === value} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

/** Grid-row collapse: animates to natural height; inert keeps closed content out of the focus order. */
export function Collapse({ open, children, className = "" }: { open: boolean; children: ReactNode; className?: string }) {
  return <div className={`collapse ${className}`.trim()} data-open={open} inert={!open}><div className="collapse-in">{children}</div></div>;
}

export function Avatar({ user, large }: { user: User; large?: boolean }) {
  return <span className={`st-avatar${large ? " lg" : ""}`} aria-hidden="true">{(user.display_name || user.username).slice(0, 1).toUpperCase()}</span>;
}

export function Empty({ icon, title, hint }: { icon: ReactNode; title: string; hint: string }) {
  return <div className="st-empty">{icon}<b>{title}</b><span>{hint}</span></div>;
}

export function Skeleton({ label }: { label: string }) {
  return <div className="st-card st-skel" role="status"><span className="sr-only">{label}</span><i className="skel" /><i className="skel" /><i className="skel" /></div>;
}

export function ErrorAlert({ message, onRetry, retryLabel }: { message: string; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div className="st-alert" role="alert">
      <p>{message}</p>
      {onRetry && <button type="button" className="btn ghost sm" onClick={onRetry}>{retryLabel}</button>}
    </div>
  );
}
