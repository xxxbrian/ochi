import type { ComputerQueueProgress } from "../../../shared/conversation/computerQueue";
import { computerQueueDetail } from "../../../shared/i18n/process";
import { memo, useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { AppText } from "./ScreenChrome";

export const ComputerQueueDetails = memo(function ComputerQueueDetails({ progress, live = false }: {
  progress: ComputerQueueProgress; live?: boolean;
}) {
  useI18n();
  const [now, setNow] = useState(Date.now);
  const ticking = live && progress.status === "waiting" && Boolean(progress.observedAt);
  const requestId = progress.status === "acquired" ? "" : progress.requestId;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking, requestId]);
  const detail = computerQueueDetail(progress, live ? now : undefined);
  return detail ? <AppText muted size={12} style={{ flexShrink: 1, fontVariant: ["tabular-nums"] }}>{detail}</AppText> : null;
});
