import { t } from "./i18n";

const levels = {
  on: "reasoning.level.on",
  off: "reasoning.level.off",
  none: "reasoning.level.none",
  minimal: "reasoning.level.minimal",
  low: "reasoning.level.low",
  medium: "reasoning.level.medium",
  high: "reasoning.level.high",
  xhigh: "reasoning.level.xhigh",
  max: "reasoning.level.max",
} as const;

export function effortLabel(effort: string): string {
  if (!effort) return t("reasoning.providerDefault");
  if (effort in levels) return t(levels[effort as keyof typeof levels]);
  if (/^budget:\d+$/.test(effort)) return t("reasoning.budgetValue", { count: Number(effort.slice(7)) });
  return effort;
}
