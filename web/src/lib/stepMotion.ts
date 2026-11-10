// Running motion of a process row's tile. The tile keeps its own family icon; this names the small
// animation that belongs to that family (CSS keys off data-motion). Nothing here rotates a box.
export type StepMotion = "caret" | "sweep" | "lines" | "ripple" | "twinkle" | "nudge" | "glow" | "stack" | "pulse";

export function stepMotion(name: string, family: string): StepMotion {
  if (family === "reasoning") return "glow";
  if (family === "group") return "stack";
  if (name === "web_fetch") return "ripple";
  switch (family) {
    case "terminal": return "caret";
    case "search": return "sweep";
    case "files": return "lines";
    case "browser": return "ripple";
    case "image": return "twinkle";
    case "computer": return "nudge";
    default: return "pulse";
  }
}
