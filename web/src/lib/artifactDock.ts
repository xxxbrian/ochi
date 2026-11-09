import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { Artifact } from "./types";
import { versionsOf } from "./files";

// One right-hand artifact panel per window. A mounted <ArtifactDock /> is the host;
// without a host (standalone pages) callers fall back to a modal of their own.
type DockState = { owner: string | null; file: Artifact | null; hosts: number };
let state: DockState = { owner: null, file: null, hosts: 0 };
const listeners = new Set<() => void>();
function set(next: Partial<DockState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

// Every dock-capable file rendered in the transcript, so a saved-again file can list its earlier versions.
const known = new Map<string, Artifact>();
export function setArtifactOwner(owner: string | null) {
  if (state.owner === owner) return;
  known.clear();
  set({ owner, file: null });
}
export function rememberArtifacts(files: Artifact[], owner: string | null) {
  if (!owner || owner !== state.owner) return;
  for (const file of files) known.set(file.id, file);
}
export const artifactVersions = (file: Artifact, owner: string | null) =>
  versionsOf(file, owner && owner === state.owner ? [...known.values()] : []);

export const openArtifact = (file: Artifact, owner: string | null) => {
  if (!owner || owner !== state.owner) return;
  known.set(file.id, file);
  set({ file });
};
export const closeArtifact = () => {
  if (state.file) set({ file: null });
};
export const hasDockHost = () => state.owner !== null && state.hosts > 0;
export function registerDockHost() {
  set({ hosts: state.hosts + 1 });
  return () => set({ hosts: state.hosts - 1, file: state.hosts === 1 ? null : state.file });
}
export const useArtifactDock = () =>
  useSyncExternalStore(subscribe, () => state, () => state);
export const useArtifactOwner = () =>
  useSyncExternalStore(subscribe, () => state.owner, () => null);

// Artifact HTML renders in an opaque-origin sandbox, so it cannot read the app theme itself:
// the document gets the current color-scheme injected and is reloaded when the theme flips.
const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | undefined;
const subscribeTheme = (listener: () => void) => {
  themeListeners.add(listener);
  if (!themeObserver && typeof MutationObserver !== "undefined") {
    themeObserver = new MutationObserver(() => themeListeners.forEach((fn) => fn()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
  return () => {
    themeListeners.delete(listener);
    if (!themeListeners.size) {
      themeObserver?.disconnect();
      themeObserver = undefined;
    }
  };
};
const currentTheme = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
export const useResolvedTheme = () => useSyncExternalStore(subscribeTheme, currentTheme, () => "light" as const);
export const themedDocument = (html: string, theme: "light" | "dark") => {
  const style = `<style>:root{color-scheme:${theme}}</style>`;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${style}</head>`) : `${style}${html}`;
};

/** SVG artifacts are only ever drawn through <img>, so their scripts never run. */
export function useSvgUrl(text: string | null) {
  const url = useMemo(() => (text === null ? "" : URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }))), [text]);
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);
  return url;
}
