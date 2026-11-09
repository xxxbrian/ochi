import { memo, useMemo } from "react";
import { formatNumber, t, useI18n } from "../lib/i18n";
import { MAX_LINES, splitLines } from "../lib/files";
import { highlightLines, type Flavor } from "../lib/highlight";

/** Numbered, optionally wrapped source (Design Lab .pv-code). Tokens are classified synchronously, so nothing flashes. */
export const CodeView = memo(function CodeView({ text, flavor, wrap = false, label }: { text: string; flavor: Flavor; wrap?: boolean; label: string }) {
  useI18n();
  const all = useMemo(() => splitLines(text), [text]);
  const clipped = all.length > MAX_LINES;
  const lines = useMemo(() => highlightLines((clipped ? all.slice(0, MAX_LINES) : all).join("\n"), flavor), [all, clipped, flavor]);
  return (
    <div className="pv-code" data-wrap={wrap} tabIndex={0} role="region" aria-label={label}>
      {lines.map((tokens, index) => (
        <div className="pv-line" key={index}>
          <span className="pv-n" aria-hidden="true">{index + 1}</span>
          <span className="pv-t">
            {tokens.length ? tokens.map((token, position) => (token.cls ? <span key={position} className={token.cls}>{token.text}</span> : token.text)) : " "}
          </span>
        </div>
      ))}
      {clipped && <p className="pv-clip">{t("file.linesClipped", { count: formatNumber(MAX_LINES) })}</p>}
    </div>
  );
});
