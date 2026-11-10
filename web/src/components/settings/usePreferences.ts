import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../../lib/api";
import type { Model, UserPreferences } from "../../lib/types";
import { usePreferencesOwner } from "../../hooks/useAccountPreferences";

/** Settings and chat share the account's current preferences and write queue. */
export function usePreferences() {
  const owner = usePreferencesOwner();
  const { preferences, error } = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  const update = useCallback(async (patch: Partial<UserPreferences>): Promise<boolean> => {
    try {
      return Boolean(await owner.update(patch));
    } catch {
      return false;
    }
  }, [owner]);
  const reload = useCallback(() => { void owner.load().catch(() => undefined); }, [owner]);
  return { preferences, error, update, reload };
}

/** Chat models the user may select; embedding and image models are not chat targets. */
export function useChatModels() {
  const [models, setModels] = useState<Model[] | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    setError("");
    api.models()
      .then((value) => { if (!disposed) setModels((value ?? []).filter((model) => (model.kind ?? "chat") === "chat" && model.enabled)); })
      .catch((reason: Error) => { if (!disposed) setError(reason.message); });
    return () => { disposed = true; };
  }, [revision]);
  return { models, error, reload: () => setRevision((value) => value + 1) };
}
