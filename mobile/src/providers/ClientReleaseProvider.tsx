import { createContext, useContext, useEffect, useState, useSyncExternalStore, type PropsWithChildren } from "react";
import { AppState } from "react-native";
import { getAPIBaseURL, isConfiguredAPIBaseURL } from "../lib/api";
import { clientUpdateDriver } from "../lib/clientUpdateNative";
import { createClientUpdateController, type ClientUpdateController } from "../lib/clientUpdates";
import { useApp } from "./AppProvider";

const Context = createContext<ClientUpdateController | null>(null);

export function ClientReleaseProvider({ children }: PropsWithChildren) {
  const { authReady } = useApp();
  const [controller] = useState(() => createClientUpdateController(clientUpdateDriver));
  const server = authReady && isConfiguredAPIBaseURL() ? getAPIBaseURL() : "";
  useEffect(() => {
    let active = true;
    void controller.configure(server).then(() => {
      if (active && (AppState.currentState === "active" || AppState.currentState === null))
        void controller.foreground();
    });
    return () => { active = false; };
  }, [controller, server]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (status) => {
      if (status === "active") void controller.foreground();
    });
    return () => { subscription.remove(); controller.dispose(); };
  }, [controller]);
  return <Context.Provider value={controller}>{children}</Context.Provider>;
}

export function useClientUpdates() {
  const controller = useContext(Context);
  if (!controller) throw new Error("ClientReleaseProvider is missing");
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return { state, controller };
}
