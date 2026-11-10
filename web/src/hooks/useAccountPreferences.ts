import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { createPreferencesOwner, type PreferencesOwner } from "../lib/preferences";

const PreferencesContext = createContext<PreferencesOwner | null>(null);
export const PreferencesProvider = PreferencesContext.Provider;

export function useAccountPreferences(account: string) {
  const owner = useMemo(() => createPreferencesOwner(account, api), [account]);
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  useEffect(() => {
    owner.activate();
    return () => owner.deactivate();
  }, [owner]);
  return { owner, ...snapshot };
}

export function usePreferencesOwner() {
  const owner = useContext(PreferencesContext);
  if (!owner) throw new Error("Account preferences require their owner");
  return owner;
}
