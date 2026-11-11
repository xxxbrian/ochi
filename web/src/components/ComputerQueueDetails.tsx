import type { ComputerQueueProgress } from "../../../shared/conversation/computerQueue";
import { computerQueueDetail } from "../../../shared/i18n/process";
import { memo, useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";

/** One-second clock for a live waiting queue; undefined once nothing is ticking. */
export function useQueueNow(progress: ComputerQueueProgress, live: boolean) {
  const [now, setNow] = useState(Date.now);
  const ticking = live && progress.status === "waiting" && Boolean(progress.observedAt);
  const requestId = progress.status === "acquired" ? "" : progress.requestId;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking, requestId]);
  return live ? now : undefined;
}

export const ComputerQueueDetails = memo(function ComputerQueueDetails({ progress, live = false }: {
  progress: ComputerQueueProgress; live?: boolean;
}) {
  useI18n();
  const now = useQueueNow(progress, live);
  const detail = computerQueueDetail(progress, now);
  return detail ? <span className="process-queue-meta">{detail}</span> : null;
});
