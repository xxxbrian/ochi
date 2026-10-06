import { memo } from "react";
import { useProcessElapsed } from "../hooks/useProcessElapsed";

export const ProcessElapsed = memo(function ProcessElapsed({ createdAt, updatedAt, active = false }: {
  createdAt?: string;
  updatedAt?: string;
  active?: boolean;
}) {
  const elapsed = useProcessElapsed(createdAt, updatedAt, active);
  return elapsed ? <span className="process-elapsed" aria-label={`用时 ${elapsed}`}><span aria-hidden="true">·</span> {elapsed}</span> : null;
});
