import type { Model } from "./types";

export function preferredChatModel(models: readonly Model[], preferredID?: string): Model | undefined {
  return models.find((model) => model.id === preferredID) ??
    models.find((model) => model.is_default) ?? models[0];
}

export function moveModel(ids: readonly string[], id: string, offset: -1 | 1): string[] {
  const next = [...ids];
  const index = next.indexOf(id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export const contextLabel = (tokens: number) => (tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens));
