import { memo, useEffect, useState } from "react";
import { formatProcessElapsed, processElapsedMilliseconds } from "../../../web/src/lib/processTiming";
import { AppText } from "./ScreenChrome";

export const ProcessElapsed = memo(function ProcessElapsed({ createdAt, updatedAt, active = false }: {
  createdAt?: string;
  updatedAt?: string;
  active?: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || !Number.isFinite(Date.parse(createdAt ?? ""))) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, createdAt]);
  const elapsed = processElapsedMilliseconds(createdAt, updatedAt, active, now);
  if (elapsed === null) return null;
  const label = formatProcessElapsed(elapsed);
  return <AppText muted size={12} accessibilityLabel={`用时 ${label}`} style={{ fontVariant: ["tabular-nums"] }}>· {label}</AppText>;
});
