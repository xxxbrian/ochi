import { t, useI18n } from "../lib/i18n";
import { memo } from "react";
import { useProcessElapsed } from "../hooks/useProcessElapsed";

export const ProcessElapsed = memo(function ProcessElapsed({ createdAt, updatedAt, active = false }: {
  createdAt?: string;
  updatedAt?: string;
  active?: boolean;
}) {
  useI18n();
  const elapsed = useProcessElapsed(createdAt, updatedAt, active);
  return elapsed ? <span className="process-elapsed" aria-label={t("process.elapsed", { duration: elapsed })}><span aria-hidden="true">·</span> {elapsed}</span> : null;
});
