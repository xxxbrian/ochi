import { useEffect, useState } from "react";
import { formatProcessElapsed, processElapsedMilliseconds } from "../lib/processTiming";

// A local header clock tick never rerenders the transcript.
export function useProcessElapsed(createdAt: string | undefined, updatedAt: string | undefined, active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || !Number.isFinite(Date.parse(createdAt ?? ""))) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, createdAt]);
  const elapsed = processElapsedMilliseconds(createdAt, updatedAt, active, now);
  return elapsed === null ? null : formatProcessElapsed(elapsed);
}
