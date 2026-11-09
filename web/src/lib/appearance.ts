// Per-browser appearance: theme, look, canvas, text size, density and reduced motion.
// index.html restores theme/look/canvas before first paint; this module owns changing them and
// restores the display scales (which need the look's own defaults, so they run after the DOM is ready).

export type ThemePref = "system" | "light" | "dark";
export type DensityPref = "compact" | "cozy" | "roomy";

const KEYS = {
  theme: "assistant.theme.v1",
  look: "assistant.look.v1",
  canvas: "assistant.canvas.v1",
  size: "assistant.textsize.v1",
  density: "assistant.density.v1",
  reduce: "assistant.reduce.v1",
  send: "assistant.sendkey.v1",
} as const;
const DENSITY_FACTOR: Record<DensityPref, number> = { compact: 0.88, cozy: 1, roomy: 1.12 };
export const TEXT_SIZE = { min: 85, max: 125, step: 5, base: 100 } as const;

const root = () => document.documentElement;
function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* Optional storage. */ }
}
// Respect the OS setting even when the stored preference is explicit.
const reducedByOs = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function getThemePref(): ThemePref {
  const value = read(KEYS.theme);
  return value === "system" || value === "dark" ? value : "light";
}
export function getLook(): "quiet" | "mono" { return root().dataset.look === "mono" ? "mono" : "quiet"; }
export function getCanvas(): "paper" | "flat" { return root().dataset.canvas === "flat" ? "flat" : "paper"; }
export function getTextSize(): number {
  const value = Number(read(KEYS.size));
  return Number.isFinite(value) && value >= TEXT_SIZE.min && value <= TEXT_SIZE.max ? value : TEXT_SIZE.base;
}
export function getDensity(): DensityPref {
  const value = read(KEYS.density);
  return value === "compact" || value === "roomy" ? value : "cozy";
}
export function getReduceMotion(): boolean { return read(KEYS.reduce) === "true"; }

export type SendKey = "enter" | "mod";
/** Per-browser: "enter" sends on Enter (Shift+Enter breaks the line); "mod" sends on Cmd/Ctrl+Enter. */
export function getSendKey(): SendKey { return read(KEYS.send) === "mod" ? "mod" : "enter"; }
export function setSendKey(value: SendKey) { write(KEYS.send, value === "enter" ? null : value); }
/** True when this key press should send a message under the current send-key preference. */
export function sendsOnEnter(event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): boolean {
  if (event.key !== "Enter") return false;
  return getSendKey() === "mod" ? event.metaKey || event.ctrlKey : !event.shiftKey;
}

const prefersDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
function paintTheme(dark: boolean) {
  root().dataset.theme = dark ? "dark" : "light";
  root().classList.toggle("dark", dark);
}
/** Theme swaps cross-fade through a view transition unless motion is reduced. */
function swap(change: () => void) {
  const start = (document as Document & { startViewTransition?: (fn: () => void) => unknown }).startViewTransition;
  if (start && !reducedByOs() && !getReduceMotion()) start.call(document, change); else change();
}
let systemWatch: MediaQueryList | null = null;
function watchSystem() {
  if (systemWatch) return;
  systemWatch = matchMedia("(prefers-color-scheme: dark)");
  systemWatch.addEventListener("change", (event) => { if (getThemePref() === "system") paintTheme(event.matches); });
}
export function setThemePref(value: ThemePref) {
  write(KEYS.theme, value);
  if (value === "system") watchSystem();
  swap(() => paintTheme(value === "system" ? prefersDark() : value === "dark"));
}
// Defaults (quiet, paper) are the absence of the attribute, matching the boot script.
export function setLook(value: "quiet" | "mono") {
  write(KEYS.look, value);
  if (value === "quiet") delete root().dataset.look; else root().dataset.look = value;
  applyDisplay();
}
export function setCanvas(value: "paper" | "flat") {
  write(KEYS.canvas, value);
  if (value === "paper") delete root().dataset.canvas; else root().dataset.canvas = value;
}
/** Text size and density multiply the look's own scale so Mono keeps its tighter defaults. */
export function applyDisplay() {
  const style = root().style;
  style.removeProperty("--font-scale");
  style.removeProperty("--density");
  const own = (name: string) => Number.parseFloat(getComputedStyle(root()).getPropertyValue(name)) || 1;
  const size = getTextSize();
  const density = getDensity();
  if (size !== TEXT_SIZE.base) style.setProperty("--font-scale", String((own("--font-scale") * size) / 100));
  if (density !== "cozy") style.setProperty("--density", String(own("--density") * DENSITY_FACTOR[density]));
}
export function setTextSize(value: number) {
  write(KEYS.size, value === TEXT_SIZE.base ? null : String(value));
  applyDisplay();
}
export function setDensity(value: DensityPref) {
  write(KEYS.density, value === "cozy" ? null : value);
  applyDisplay();
}
export function applyReduceMotion() {
  if (getReduceMotion()) root().dataset.reduce = "true"; else delete root().dataset.reduce;
}
export function setReduceMotion(value: boolean) {
  write(KEYS.reduce, value ? "true" : null);
  applyReduceMotion();
}

if (typeof document !== "undefined") {
  if (getThemePref() === "system") watchSystem();
  applyDisplay();
  applyReduceMotion();
}
