import { Dialog } from "@base-ui/react/dialog";
import { Check, ChevronRight, ChevronsUpDown, X } from "lucide-react";
import { createContext, type CSSProperties, type KeyboardEvent, type ReactNode, useContext, useState } from "react";
import { createPortal } from "react-dom";
import { t, useAdminI18n } from "./i18n";
import { ActionMenu } from "../../components/ui/Menu";
import { Menu } from "@base-ui/react/menu";

/* Lab admin building blocks (js/admin.js shared builders). CSS owner: admin.css. */

export type Tone = "success" | "warn" | "danger" | "accent" | "neutral" | "";

export const hueOf = (text: string) => [...text].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 360, 11);

export function Card({ children, className = "", flush, ...rest }: { children: ReactNode; className?: string; flush?: boolean } & Record<string, unknown>) {
  return <section className={`ad-card${flush ? " ad-flush" : ""}${className ? ` ${className}` : ""}`} {...rest}>{children}</section>;
}

export function CardHead({ title, desc, right }: { title: ReactNode; desc?: ReactNode; right?: ReactNode }) {
  return (
    <header className="ad-ch">
      <div><h3>{title}</h3>{desc ? <p>{desc}</p> : null}</div>
      {right ? <div className="ad-ch-r">{right}</div> : null}
    </header>
  );
}

export function Stat({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: "success" | "warn" }) {
  return (
    <div className="ad-stat" data-tone={tone ?? ""}>
      <span>{label}</span><b className="tnum">{value}</b>{sub ? <small>{sub}</small> : null}
    </div>
  );
}

export function Empty({ icon, title, desc, action }: { icon: ReactNode; title: ReactNode; desc?: ReactNode; action?: ReactNode }) {
  return <div className="ad-empty">{icon}<b>{title}</b>{desc ? <p>{desc}</p> : null}{action}</div>;
}

export function Pill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className="pill" data-tone={tone}>{children}</span>;
}

export function StatusDot({ tone = "", children }: { tone?: Tone; children: ReactNode }) {
  return <span className="ad-status"><i className="dot" data-tone={tone} />{children}</span>;
}

/** Lab switch: a real button with role=switch so it works with and without a form. */
export function Switch({ on, onChange, label, disabled, busy }: { on: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean; busy?: boolean }) {
  return (
    <button type="button" className="toggle" role="switch" aria-checked={on} aria-label={label} aria-busy={busy || undefined}
      disabled={disabled || busy} onClick={() => onChange(!on)}><i /></button>
  );
}

export function Meter({ pct, tone = "" }: { pct: number; tone?: "warn" | "danger" | "" }) {
  return <div className="ad-meter" data-tone={tone}><i style={{ "--w": `${Math.max(0, Math.min(100, pct))}%` } as CSSProperties} /></div>;
}

export function Avatar({ name, size = "" }: { name: string; size?: "xs" | "" }) {
  const letter = [...(name.trim() || "?")][0]?.toUpperCase() ?? "?";
  return <span className={`ad-av ${size}`} style={{ "--h": hueOf(name) } as CSSProperties} aria-hidden="true">{letter}</span>;
}

export function Who({ name, sub, mono }: { name: string; sub?: ReactNode; mono?: boolean }) {
  return <div className="ad-who"><Avatar name={name} /><div><b>{name}</b>{sub ? <small className={mono ? "mono" : ""}>{sub}</small> : null}</div></div>;
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button type="button" className="ad-cb" role="checkbox" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}>
      <Check className="ic" />
    </button>
  );
}

/** Animated height disclosure shared by provider models, plugin tools and the danger zone. */
export function Collapse({ open, children, className = "" }: { open: boolean; children: ReactNode; className?: string }) {
  return <div className={`collapse ${className}`} data-open={open}><div className="collapse-in" inert={!open || undefined}>{children}</div></div>;
}

export function Disclosure({ open, onClick, children }: { open: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className="ad-disc" aria-expanded={open} onClick={onClick}>{children}<ChevronRight className="ic chev" /></button>;
}

export function Seg<T extends string>({ value, options, onChange, small, label }: { value: T; options: { v: T; l: ReactNode }[]; onChange: (next: T) => void; small?: boolean; label?: string }) {
  const index = Math.max(0, options.findIndex((option) => option.v === value));
  return (
    <div className={`seg${small ? " sm" : ""}`} role="radiogroup" aria-label={label} style={{ "--n": options.length, "--i": index } as CSSProperties}>
      <i className="seg-thumb" />
      {options.map((option) => (
        <button type="button" key={option.v} role="radio" aria-checked={option.v === value} onClick={() => onChange(option.v)}>{option.l}</button>
      ))}
    </div>
  );
}

/** Toolbar select: a lab `.select-btn` opening a radio menu. */
export function MenuSelect<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { v: T; l: string }[]; onChange: (next: T) => void }) {
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.v === value);
  return (
    <ActionMenu open={open} onOpenChange={setOpen} label={label} className="select-btn"
      trigger={<><span>{label}{current ? `: ${current.l}` : ""}</span><ChevronsUpDown className="ic" /></>} align="end">
      <Menu.RadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
        {options.map((option) => (
          <Menu.RadioItem key={option.v} value={option.v} className="menu-item">
            <span>{option.l}</span><Check className="ic tick" />
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>
    </ActionMenu>
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  useAdminI18n();
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div className="ad-skel-row" key={index} style={{ "--i": index } as CSSProperties} aria-hidden="true">
          <i className="skel circle" style={{ width: 22, height: 22 }} />
          <div>
            <i className="skel" style={{ width: `${46 - index * 3}%` }} />
            <i className="skel line" style={{ width: `${28 + index * 2}%`, marginTop: 8 }} />
          </div>
          <i className="skel" style={{ width: 64 }} />
        </div>
      ))}
    </div>
  );
}

/** Right-edge sheet (lab openDrawer). Base UI supplies focus trap, Escape and outside press; CSS animates the data-*-style states. */
export function Drawer({ title, sub, children, footer, onClose, wide, className = "" }: {
  title: ReactNode; sub?: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean; className?: string;
}) {
  useAdminI18n();
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="ad-scrim" />
        <Dialog.Popup className={`ad-drawer${wide ? " ad-wide" : ""}${className ? ` ${className}` : ""}`}>
          <header className="ad-dh">
            <div><Dialog.Title render={<h2 />}>{title}</Dialog.Title>{sub ? <p>{sub}</p> : null}</div>
            <Dialog.Close className="icon-btn" aria-label={t("close")}><X className="ic" /></Dialog.Close>
          </header>
          <div className="ad-db">{children}</div>
          {footer}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function onActivate(action: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); action(); }
  };
}

/** Removable chip list with an inline add field (domain rules, allowed users). Enter adds, Backspace removes the last. */
export function ChipInput({ values, onChange, placeholder, label, mono = true }: { values: string[]; onChange: (next: string[]) => void; placeholder: string; label: string; mono?: boolean }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const value = draft.trim();
    if (!value || values.includes(value)) { setDraft(""); return; }
    onChange([...values, value]);
    setDraft("");
  };
  return (
    <div className="ad-chips" aria-label={label}>
      {values.map((value) => (
        <span className="ad-chip" key={value} style={mono ? undefined : { fontFamily: "var(--font-ui)" }}>
          {value}
          <button type="button" aria-label={t("remove")} onClick={() => onChange(values.filter((item) => item !== value))}><X className="ic" /></button>
        </span>
      ))}
      <input className="ad-chip-in" value={draft} placeholder={placeholder} aria-label={label}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); add(); }
          else if (event.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1));
        }}
        onBlur={add} />
    </div>
  );
}

/* ---- header slots -------------------------------------------------------------------------------------------- */

export type AdminSlots = { actions: HTMLElement | null; toolbar: HTMLElement | null };
export const AdminSlotContext = createContext<AdminSlots>({ actions: null, toolbar: null });

/** Pages describe their sticky-header buttons and toolbar; the console renders them into the lab header. */
export function AdminHeader({ actions, toolbar }: { actions?: ReactNode; toolbar?: ReactNode }) {
  const slots = useContext(AdminSlotContext);
  return <>
    {actions && slots.actions ? createPortal(actions, slots.actions) : null}
    {toolbar && slots.toolbar ? createPortal(toolbar, slots.toolbar) : null}
  </>;
}
