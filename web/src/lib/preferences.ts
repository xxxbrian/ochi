import type { UserPreferences } from "./types";

export type PreferencesSnapshot = {
  preferences: UserPreferences | null;
  error: string;
  loading: boolean;
};

type Transport = {
  preferences(): Promise<UserPreferences>;
  updatePreferences(patch: Partial<UserPreferences>): Promise<UserPreferences>;
};

/** One account owns reads, optimistic edits and their serialized server writes. */
export function createPreferencesOwner(account: string, transport: Transport) {
  let snapshot: PreferencesSnapshot = { preferences: null, error: "", loading: false };
  let confirmed: UserPreferences | null = null;
  let operations = Promise.resolve();
  let active = Boolean(account);
  let generation = 0;
  let revision = 0;
  let loading: Promise<UserPreferences | null> | null = null;
  const pending = new Map<number, Partial<UserPreferences>>();
  const listeners = new Set<() => void>();
  const emit = (patch: Partial<PreferencesSnapshot> = {}) => {
    const preferences = confirmed ? Object.assign({}, confirmed, ...pending.values()) : null;
    snapshot = { ...snapshot, ...patch, preferences };
    listeners.forEach((listener) => listener());
  };
  const enqueue = <T,>(operation: () => Promise<T>) => {
    const result = operations.then(operation);
    operations = result.then(() => undefined, () => undefined);
    return result;
  };
  const current = (epoch: number) => active && epoch === generation;
  const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
  const owner = {
    account,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    activate() { active = Boolean(account); },
    deactivate() {
      active = false;
      generation++;
      pending.clear();
      confirmed = null;
      loading = null;
      operations = Promise.resolve();
      emit({ error: "", loading: false });
    },
    load(): Promise<UserPreferences | null> {
      if (!active) return Promise.resolve(null);
      if (loading) return loading;
      const epoch = generation;
      emit({ error: "", loading: true });
      const result = enqueue(async () => {
        if (!current(epoch)) return null;
        try {
          const value = await transport.preferences();
          if (!current(epoch)) return null;
          confirmed = value;
          emit({ error: "" });
          return snapshot.preferences;
        } catch (reason) {
          if (!current(epoch)) return null;
          emit({ error: message(reason) });
          throw reason;
        } finally {
          if (current(epoch)) {
            loading = null;
            emit({ loading: false });
          }
        }
      });
      loading = result;
      return result;
    },
    update(patch: Partial<UserPreferences>): Promise<UserPreferences | null> {
      if (!active) return Promise.resolve(null);
      const epoch = generation;
      const id = ++revision;
      pending.set(id, patch);
      emit({ error: "" });
      return enqueue(async () => {
        if (!current(epoch)) return null;
        try {
          const value = await transport.updatePreferences(patch);
          if (!current(epoch)) return null;
          confirmed = value;
          pending.delete(id);
          emit({ error: "" });
          return value;
        } catch (reason) {
          if (!current(epoch)) return null;
          pending.delete(id);
          emit(id === revision ? { error: message(reason) } : {});
          throw reason;
        }
      });
    },
  };
  return owner;
}

export type PreferencesOwner = ReturnType<typeof createPreferencesOwner>;
