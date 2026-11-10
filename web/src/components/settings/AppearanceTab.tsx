import { t } from "../../lib/i18n";
import { useEffect, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import {
  TEXT_SIZE, getCanvas, getDensity, getLook, getReduceMotion, getTextSize, getThemePref,
  setCanvas, setDensity, setLook, setReduceMotion, setTextSize, setThemePref,
  type DensityPref, type ThemePref,
} from "../../lib/appearance";
import { Card, Row, Sec, Seg, Toggle, useSaved } from "./ui";

/** Preview cards share one mini layout; light/dark and look differences come from the scoped tokens in settings.css. */
function Mini({ tone, look }: { tone: "light" | "dark"; look?: "quiet" | "mono" }) {
  return (
    <span className="st-mini" data-t={tone} data-l={look} aria-hidden="true">
      <i className="m-side" /><i className="m-top" /><i className="m-a" /><i className="m-b" /><i className="m-u" /><i className="m-in" />
    </span>
  );
}
type Choice<T extends string> = { value: T; label: string; preview: React.ReactNode };

// A radio group of preview cards with roving focus; arrows move and select like native radios.
function Cards<T extends string>({ label, value, choices, onChange }: { label: string; value: T; choices: Choice<T>[]; onChange: (value: T) => void }) {
  function move(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = choices[(choices.findIndex((choice) => choice.value === value) + step + choices.length) % choices.length];
    onChange(next.value);
    const group = event.currentTarget;
    requestAnimationFrame(() => group.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus());
  }
  return (
    <div className="st-themes" role="radiogroup" aria-label={label} onKeyDown={move}>
      {choices.map((choice) => (
        <button key={choice.value} type="button" role="radio" aria-checked={choice.value === value} data-value={choice.value} tabIndex={choice.value === value ? 0 : -1} className="st-theme" onClick={() => onChange(choice.value)}>
          <span className="st-tprev">{choice.preview}</span>
          <span className="st-tl">{choice.label}<span className="st-tick"><Check size={10} strokeWidth={3} aria-hidden="true" /></span></span>
        </button>
      ))}
    </div>
  );
}

const fraction = (value: number) => (value - TEXT_SIZE.min) / (TEXT_SIZE.max - TEXT_SIZE.min);

export function AppearanceTab() {
  const { saved } = useSaved();
  const [theme, setTheme] = useState<ThemePref>(getThemePref);
  const [look, setLookState] = useState(getLook);
  const [canvas, setCanvasState] = useState(getCanvas);
  const [size, setSize] = useState(getTextSize);
  const [density, setDensityState] = useState<DensityPref>(getDensity);
  const [reduce, setReduce] = useState(getReduceMotion);
  const [dragging, setDragging] = useState(false);
  // The look decides which tone the style/layout previews are drawn in; follow what is actually shown.
  const [shown, setShown] = useState<"light" | "dark">(() => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
  useEffect(() => {
    const observer = new MutationObserver(() => setShown(document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <Sec index={0} title={t("settings.theme")}>
        <Cards<ThemePref>
          label={t("settings.theme")}
          value={theme}
          onChange={(value) => { setTheme(value); setThemePref(value); saved(); }}
          choices={[
            { value: "system", label: t("settings.themeSystem"), preview: <><Mini tone="light" look={look} /><span className="over"><Mini tone="dark" look={look} /></span></> },
            { value: "light", label: t("settings.light"), preview: <Mini tone="light" look={look} /> },
            { value: "dark", label: t("settings.dark"), preview: <Mini tone="dark" look={look} /> },
          ]}
        />
      </Sec>
      <Sec index={1} title={t("settings.look")}>
        <Cards<"quiet" | "mono">
          label={t("settings.look")}
          value={look}
          onChange={(value) => { setLookState(value); setLook(value); saved(); }}
          choices={[
            { value: "quiet", label: t("settings.lookQuiet"), preview: <Mini tone={shown} look="quiet" /> },
            { value: "mono", label: t("settings.lookMono"), preview: <Mini tone={shown} look="mono" /> },
          ]}
        />
      </Sec>
      <Sec index={2} title={t("settings.canvas")}>
        <Cards<"paper" | "flat">
          label={t("settings.canvas")}
          value={canvas}
          onChange={(value) => { setCanvasState(value); setCanvas(value); saved(); }}
          choices={[
            { value: "paper", label: t("settings.canvasSheet"), preview: <span className="st-layout" data-v="paper"><Mini tone={shown} look={look} /></span> },
            { value: "flat", label: t("settings.canvasFlat"), preview: <span className="st-layout" data-v="flat"><Mini tone={shown} look={look} /></span> },
          ]}
        />
      </Sec>
      <Sec index={3} title={t("settings.sec.display")}>
        <Card>
          <Row id="size" wide title={t("settings.textSize")} desc={t("settings.textSizeHint")}>
            <div className="st-size">
              <span className="st-a sm" aria-hidden="true">A</span>
              <div className="st-slider" style={{ "--f": fraction(size) } as CSSProperties} data-drag={dragging || undefined}>
                <span className="st-bubble" aria-hidden="true">{t("settings.textSizeValue", { value: size })}</span>
                <input
                  type="range"
                  className="slider st-range"
                  min={TEXT_SIZE.min}
                  max={TEXT_SIZE.max}
                  step={TEXT_SIZE.step}
                  value={size}
                  style={{ "--p": `${fraction(size) * 100}%` } as CSSProperties}
                  aria-label={t("settings.textSize")}
                  aria-valuetext={t("settings.textSizeValue", { value: size })}
                  onPointerDown={() => setDragging(true)}
                  onPointerUp={() => setDragging(false)}
                  onBlur={() => setDragging(false)}
                  onChange={(event) => { const value = Number(event.target.value); setSize(value); setTextSize(value); }}
                  onMouseUp={() => saved("size")}
                  onKeyUp={() => saved("size")}
                />
              </div>
              <span className="st-a lg" aria-hidden="true">A</span>
            </div>
          </Row>
          <Row id="density" title={t("settings.density")} desc={t("settings.densityHint")}>
            <Seg<DensityPref>
              label={t("settings.density")}
              value={density}
              onChange={(value) => { setDensityState(value); setDensity(value); saved("density"); }}
              options={[
                { value: "compact", label: t("settings.densityCompact") },
                { value: "cozy", label: t("settings.densityCozy") },
                { value: "roomy", label: t("settings.densityRoomy") },
              ]}
            />
          </Row>
          <Row id="reduce" title={t("settings.reduceMotion")} desc={t("settings.reduceMotionHint")}>
            <Toggle label={t("settings.reduceMotion")} checked={reduce} onChange={(value) => { setReduce(value); setReduceMotion(value); saved("reduce"); }} />
          </Row>
        </Card>
      </Sec>
    </>
  );
}
