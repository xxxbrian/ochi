import type { CSSProperties } from "react";
import { useI18n } from "../../lib/i18n";

/** Text-only progressive label: the word followed by three dots that fade in turn. Used for "load more" actions. */
export function LoadingDots({ label }: { label: string }) {
  return (
    <span className="loading-dots">
      {label}<i aria-hidden="true">.</i><i aria-hidden="true">.</i><i aria-hidden="true">.</i>
    </span>
  );
}

const WIDTHS = [62, 78, 48, 70, 56];

/** Placeholder rows shaped like list rows (title line plus a short trailing meta block). `className` lets the owner
 *  apply its own row padding and borders so the skeleton occupies the same space as the real rows. */
export function SkelRows({ count = 4, className = "skel-row" }: { count?: number; className?: string }) {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t("status.loading")}>
      {Array.from({ length: count }, (_, i) => (
        <div className={className} key={i} aria-hidden="true">
          <span className="skel line" style={{ width: `${WIDTHS[i % WIDTHS.length]}%` } as CSSProperties} />
          <span className="skel line skel-meta" />
        </div>
      ))}
    </div>
  );
}
