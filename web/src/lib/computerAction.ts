import type { Step } from "./types";

/** The workspace desktop is a fixed 1280x800 coordinate space. */
export const DESKTOP_WIDTH = 1280;
export const DESKTOP_HEIGHT = 800;

export const COMPUTER_ACTIONS = [
  "click", "move", "drag", "scroll", "type", "key", "screenshot", "observe", "windows", "apps",
] as const;
export type ComputerActionName = (typeof COMPUTER_ACTIONS)[number];
export type Point = { x: number; y: number };
export type ComputerListRow = { title: string; detail?: string; focused?: boolean };

export type ComputerAction = {
  name: ComputerActionName;
  point?: Point;
  to?: Point;
  button?: "left" | "middle" | "right" | "double";
  text?: string;
  keys?: string[];
  scroll?: { direction: "up" | "down" | "left" | "right"; clicks: number };
  rows?: ComputerListRow[];
};

const KEY_SYMBOLS: Record<string, string> = {
  meta: "⌘", cmd: "⌘", command: "⌘", super: "⌘", ctrl: "⌃", control: "⌃", alt: "⌥", option: "⌥",
  shift: "⇧", enter: "↵", return: "↵", kp_enter: "↵", esc: "Esc", escape: "Esc", tab: "⇥",
  backspace: "⌫", delete: "⌦", space: "␣", up: "↑", down: "↓", left: "←", right: "→",
};

/** Split an xdotool-style chord such as "ctrl+shift+t" into display keycaps. */
export function keycaps(chord: string): string[] {
  return chord.split(/[+\s]+/).filter(Boolean).map((part) => {
    const mapped = KEY_SYMBOLS[part.toLowerCase()];
    return mapped ?? (part.length === 1 ? part.toUpperCase() : part);
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, max: number) {
  return Math.min(Math.max(Math.round(value), 0), max);
}

function pointFrom(source: Record<string, unknown> | null, xKey: string, yKey: string): Point | undefined {
  const x = finite(source?.[xKey]);
  const y = finite(source?.[yKey]);
  return x === undefined || y === undefined
    ? undefined
    : { x: clamp(x, DESKTOP_WIDTH - 1), y: clamp(y, DESKTOP_HEIGHT - 1) };
}

function outputObject(step: Step): Record<string, unknown> | null {
  const text = step.output?.trimStart();
  if (!text?.startsWith("{")) return null;
  try {
    return record(JSON.parse(text));
  } catch {
    return null;
  }
}

function text(row: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function listRows(name: "windows" | "apps", result: Record<string, unknown> | null): ComputerListRow[] {
  if (!result) return [];
  const source = name === "windows" ? result.windows : result.apps;
  if (Array.isArray(source)) {
    return source.slice(0, 40).flatMap((item) => {
      const row = record(item);
      if (!row) return typeof item === "string" && item ? [{ title: item }] : [];
      const title = name === "windows" ? text(row, "title", "class", "window_id") : text(row, "name", "app_id");
      if (!title) return [];
      return [{
        title,
        detail: name === "windows" ? text(row, "class") || undefined : text(row, "description") || undefined,
        focused: name === "windows" && row.active === true,
      }];
    });
  }
  // focus / launch results describe a single target.
  const single = name === "windows" ? text(result, "title", "focused") : text(result, "name", "app_id");
  return single ? [{ title: single, focused: name === "windows" }] : [];
}

export function computerActionName(toolName: string): ComputerActionName | null {
  const name = toolName.replace(/^computer_/, "");
  return toolName.startsWith("computer_") && (COMPUTER_ACTIONS as readonly string[]).includes(name)
    ? (name as ComputerActionName)
    : null;
}

export function parseComputerAction(step: Step): ComputerAction | null {
  const name = computerActionName(step.name);
  if (!name) return null;
  const args = record(step.arguments);
  const result = outputObject(step);
  const action: ComputerAction = { name };
  const at = pointFrom(args, "x", "y") ?? pointFrom(result, "x", "y");
  if (name === "click") {
    action.point = at;
    const count = finite(args?.click_count) ?? finite(result?.click_count) ?? 1;
    const button = finite(args?.button) ?? finite(result?.button) ?? 1;
    action.button = count >= 2 ? "double" : button === 3 ? "right" : button === 2 ? "middle" : "left";
  } else if (name === "move") {
    action.point = at;
  } else if (name === "drag") {
    action.point = at;
    action.to = pointFrom(args, "to_x", "to_y") ?? pointFrom(result, "to_x", "to_y");
  } else if (name === "scroll") {
    action.point = at;
    const clicks = finite(args?.clicks) ?? finite(result?.clicks) ?? 0;
    const axis = args?.axis ?? result?.axis;
    const horizontal = axis === "horizontal";
    // Positive clicks scroll up/left, negative down/right.
    action.scroll = {
      direction: horizontal ? (clicks > 0 ? "left" : "right") : clicks > 0 ? "up" : "down",
      clicks: Math.abs(clicks),
    };
  } else if (name === "type") {
    const value = args?.text;
    action.text = typeof value === "string" ? value : "";
  } else if (name === "key") {
    const value = args?.key ?? result?.key;
    action.keys = typeof value === "string" ? keycaps(value) : [];
  } else if (name === "windows" || name === "apps") {
    action.rows = listRows(name, result);
  }
  return action;
}

export type PermissionDecision = "once" | "conversation" | "denied";

/**
 * The permission tool returns fixed server sentences; the resolved choice is the
 * only structured fact in them. Returns null while the question is unanswered.
 */
export function permissionDecision(step: Step): PermissionDecision | null {
  if (step.status === "running") return null;
  const output = step.output ?? "";
  if (step.status === "failed" || /^Computer access denied/i.test(output)) return "denied";
  if (/this turn only/i.test(output)) return "once";
  return "conversation";
}

export function permissionAnswerDecision(answer: string): PermissionDecision {
  return answer === "allow_once" ? "once" : answer === "allow_session" ? "conversation" : "denied";
}

export type QueueSlots = { shown: number; overflow: number };
/** Cap the drawn queue slots; the remainder is reported as a count. */
export function queueSlots(ahead: number, limit = 5): QueueSlots {
  const shown = Math.min(Math.max(0, Math.floor(ahead)), limit);
  return { shown, overflow: Math.max(0, Math.floor(ahead)) - shown };
}
