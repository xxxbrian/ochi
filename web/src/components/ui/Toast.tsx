import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { Check, Info } from "lucide-react";

type CloseReason = "timeout" | "action" | "dismiss" | "unmount";
type ToastOptions = {
  icon?: "check" | "info";
  action?: { label: string; run: () => void };
  duration?: number;
  onDismiss?: (reason: CloseReason) => void;
};
type ToastItem = { id: number; text: string; icon: "check" | "info"; action?: ToastOptions["action"]; open: boolean };
type ToastRecord = {
  active: boolean;
  options: ToastOptions;
  frame: number;
  timer: ReturnType<typeof setTimeout>;
  removal?: ReturnType<typeof setTimeout>;
};
let items: ToastItem[] = [];
let next = 0;
const hosts = new Map<symbol, number>();
let activeHost: symbol | undefined;
const records = new Map<number, ToastRecord>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

function selectHost() {
  activeHost = undefined;
  let priority = -1;
  for (const [host, depth] of hosts) {
    if (depth >= priority) {
      activeHost = host;
      priority = depth;
    }
  }
}

function close(id: number, reason: CloseReason, animate = true) {
  const record = records.get(id);
  if (!record) return;
  cancelAnimationFrame(record.frame);
  clearTimeout(record.timer);
  if (record.removal) clearTimeout(record.removal);
  const notify = record.active;
  record.active = false;
  items = items.map((item) => item.id === id ? { ...item, open: false, action: undefined } : item);
  const remove = () => {
    records.delete(id);
    items = items.filter((item) => item.id !== id);
    emit();
  };
  if (animate) record.removal = setTimeout(remove, 400);
  else remove();
  emit();
  if (notify) record.options.onDismiss?.(reason);
}

/** An action is usable for its whole visible lifetime, even when its originating panel closes. */
export function toast(text: string, options: ToastOptions = {}) {
  if (!hosts.size) {
    options.onDismiss?.("unmount");
    return { dismiss: () => undefined };
  }
  const id = ++next;
  const action = options.action ? {
    label: options.action.label,
    run: () => {
      if (!records.get(id)?.active) return;
      close(id, "action");
      options.action?.run();
    },
  } : undefined;
  items = [...items, { id, text, icon: options.icon ?? "check", action, open: false }];
  const record: ToastRecord = {
    active: true, options, frame: 0,
    timer: setTimeout(() => close(id, "timeout"), options.duration ?? (action ? 6000 : 3200)),
  };
  records.set(id, record);
  emit();
  record.frame = requestAnimationFrame(() => {
    record.frame = requestAnimationFrame(() => {
      if (!record.active) return;
      items = items.map((item) => item.id === id ? { ...item, open: true } : item);
      emit();
    });
  });
  return { dismiss: () => close(id, "dismiss") };
}
/** Modal hosts keep actions inside their focus boundary without owning a second timer. */
export function ToastHost({ priority = 0 }: { priority?: number }) {
  const [host] = useState(() => Symbol());
  const list = useSyncExternalStore(subscribe, () => activeHost === host ? items : null, () => null);
  useLayoutEffect(() => {
    hosts.set(host, priority);
    selectHost();
    emit();
    return () => {
      hosts.delete(host);
      selectHost();
      if (!hosts.size) for (const id of records.keys()) close(id, "unmount", false);
      emit();
    };
  }, [host, priority]);
  if (!list) return null;
  return (
    <div className="toasts" data-modal={priority > 0 || undefined} role="status" aria-live="polite">
      {list.map((item) => (
        <div key={item.id} className="toast" data-open={item.open}>
          {item.icon === "info" ? <Info className="toast-ic" /> : <Check className="toast-ic" />}
          <span>{item.text}</span>
          {item.action && <button className="toast-act" onClick={item.action.run}>{item.action.label}</button>}
        </div>
      ))}
    </div>
  );
}
