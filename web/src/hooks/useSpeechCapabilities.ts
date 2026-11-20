import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { SpeechCapabilities } from "../lib/types";

export function useSpeechCapabilities(account: string, inAdmin: boolean) {
  const [value, setValue] = useState<{ account: string; capabilities: SpeechCapabilities } | null>(null);
  useEffect(() => {
    setValue(null);
    if (!account || inAdmin) return;
    let pending: AbortController | undefined;
    const refresh = () => {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      void api.speechCapabilities(controller.signal)
        .then((capabilities) => {
          if (!controller.signal.aborted) setValue({ account, capabilities });
        })
        .catch(() => { /* Keep the last known state until a later refresh. */ });
    };
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      pending?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [account, inAdmin]);
  return account && !inAdmin && value?.account === account ? value.capabilities : undefined;
}
