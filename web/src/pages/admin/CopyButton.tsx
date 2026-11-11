import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t } from "./i18n";

/** Icon button that copies text and flashes a check mark (lab `ad-copy`). */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button type="button" className={`icon-btn sm${done ? " flash" : ""}`} aria-label={label ?? t("copyText")} title={done ? t("copied") : label ?? t("copyText")}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setDone(false), 1200);
        }).catch(() => undefined);
      }}>
      {done ? <Check className="ic" /> : <Copy className="ic" />}
    </button>
  );
}
