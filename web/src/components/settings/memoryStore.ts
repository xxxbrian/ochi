import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import type { Memory } from "../../lib/types";
import { toast } from "../ui/Toast";

const COLLAPSE_MS = 300;
const UNDO_MS = 6000;
type Pending = {
  memory: Memory;
  phase: "collapsing" | "waiting" | "committing";
  timer?: ReturnType<typeof setTimeout>;
  toast?: ReturnType<typeof toast>;
};
type State = { memories: Memory[]; loading: boolean; error: string; leaving: ReadonlySet<string>; fresh: string | null };

/** The collection and Undo actions share one account owner; closing a settings tab does not commit them. */
class MemoryStore {
  private state: State = { memories: [], loading: true, error: "", leaving: new Set(), fresh: null };
  private collection: Memory[] = [];
  private listeners = new Set<() => void>();
  private pending = new Map<string, Pending>();
  private generation = 0;
  private disposed = false;
  private freshTimer?: ReturnType<typeof setTimeout>;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private change(patch: Partial<State>) {
    if (this.disposed) return;
    const memories = this.collection.filter((memory) => {
      const operation = this.pending.get(memory.id);
      return !operation || operation.phase === "collapsing";
    });
    this.state = { ...this.state, ...patch, memories };
    for (const listener of this.listeners) listener();
  }
  private mutated() {
    // A GET started before an edit/delete cannot restore the old collection afterwards.
    this.generation++;
  }
  private flash(id: string) {
    clearTimeout(this.freshTimer);
    this.change({ fresh: id });
    this.freshTimer = setTimeout(() => this.change({ fresh: null }), 1700);
  }
  load = async () => {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.change({ loading: true, error: "" });
    try {
      const memories = await api.memories();
      if (this.disposed || generation !== this.generation) return;
      // Keep hidden entries in the collection until their own Undo window closes.
      this.collection = (memories ?? []).slice();
      for (const operation of this.pending.values()) {
        if (!this.collection.some((memory) => memory.id === operation.memory.id)) this.collection.push(operation.memory);
      }
      this.change({ loading: false });
    } catch (reason) {
      if (this.disposed || generation !== this.generation) return;
      this.change({ error: reason instanceof Error ? reason.message : t("error.load"), loading: false });
    }
  };
  upsert = (memory: Memory) => {
    if (this.disposed) return false;
    this.mutated();
    const exists = this.collection.some((item) => item.id === memory.id);
    this.collection = exists
      ? this.collection.map((item) => item.id === memory.id ? memory : item)
      : [memory, ...this.collection];
    this.change({ loading: false, error: "" });
    this.flash(memory.id);
    return true;
  };
  private restore(operation: Pending) {
    if (this.disposed || this.pending.get(operation.memory.id) !== operation || operation.phase === "committing") return;
    clearTimeout(operation.timer);
    this.pending.delete(operation.memory.id);
    this.mutated();
    this.change({ loading: false, leaving: new Set([...this.state.leaving].filter((id) => id !== operation.memory.id)) });
    this.flash(operation.memory.id);
  }
  private async commit(operation: Pending) {
    if (this.disposed || this.pending.get(operation.memory.id) !== operation || operation.phase !== "waiting") return;
    operation.phase = "committing";
    this.mutated();
    try {
      await api.deleteMemory(operation.memory.id);
      if (this.disposed || this.pending.get(operation.memory.id) !== operation) return;
      this.mutated();
      this.collection = this.collection.filter((memory) => memory.id !== operation.memory.id);
      this.pending.delete(operation.memory.id);
      this.change({ loading: false });
    } catch (reason) {
      if (this.disposed || this.pending.get(operation.memory.id) !== operation) return;
      operation.phase = "waiting";
      this.restore(operation);
      const error = reason instanceof Error ? reason.message : t("error.delete");
      this.change({ error });
      toast(error, { icon: "info" });
    }
  }
  remove = (memory: Memory) => {
    if (this.disposed || this.pending.has(memory.id) || !this.collection.some((item) => item.id === memory.id)) return false;
    const operation: Pending = { memory, phase: "collapsing" };
    this.pending.set(memory.id, operation);
    this.mutated();
    this.change({ leaving: new Set([...this.state.leaving, memory.id]), loading: false, error: "" });
    operation.timer = setTimeout(() => {
      if (this.disposed || this.pending.get(memory.id) !== operation) return;
      operation.phase = "waiting";
      this.mutated();
      this.change({ loading: false, leaving: new Set([...this.state.leaving].filter((id) => id !== memory.id)) });
      operation.toast = toast(t("memory.deleted"), {
        icon: "info", duration: UNDO_MS,
        action: { label: t("common.undo"), run: () => this.restore(operation) },
        onDismiss: (reason) => {
          if (reason === "timeout") void this.commit(operation);
          else if (reason !== "action") this.restore(operation);
        },
      });
    }, COLLAPSE_MS);
    return true;
  };
  dispose() {
    this.disposed = true;
    this.generation++;
    clearTimeout(this.freshTimer);
    for (const operation of this.pending.values()) {
      clearTimeout(operation.timer);
      operation.toast?.dismiss();
    }
    this.pending.clear();
    this.listeners.clear();
  }
}
const owners = new Map<string, MemoryStore>();
export function releaseMemoryOwner(accountId: string) {
  owners.get(accountId)?.dispose();
  owners.delete(accountId);
}
export function useMemories(accountId: string) {
  const store = useMemo(() => {
    let owner = owners.get(accountId);
    if (!owner) { owner = new MemoryStore(); owners.set(accountId, owner); }
    return owner;
  }, [accountId]);
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  useEffect(() => { void store.load(); }, [store]);
  return { ...state, reload: store.load, remove: store.remove, upsert: store.upsert };
}
