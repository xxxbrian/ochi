import { t, useI18n } from "../lib/i18n";
import { Code2, Globe, Image as ImageIcon, Monitor } from "lucide-react";
import { COMPOSE_EVENT } from "../lib/composeEvent";

const SUGGESTIONS = [
  { key: "hero.suggest.code", Icon: Code2 },
  { key: "hero.suggest.research", Icon: Globe },
  { key: "hero.suggest.image", Icon: ImageIcon },
  { key: "hero.suggest.computer", Icon: Monitor },
] as const;

function greetingKey(hour: number) {
  return hour < 12 ? "hero.morning" : hour < 18 ? "hero.afternoon" : "hero.evening";
}

/** Empty-conversation hero: time-of-day greeting plus starter prompts that fill (never send) the composer. */
export function EmptyHero({ name }: { name?: string }) {
  useI18n();
  const greeting = t(greetingKey(new Date().getHours()), { name: name || "" }).replace(/[,，]\s*$/, "");
  return (
    <div className="hero">
      <h1 className="hero-title">{greeting}</h1>
      <p className="hero-sub">{t("hero.sub")}</p>
      <div className="suggests">
        {SUGGESTIONS.map(({ key, Icon }) => (
          <button key={key} type="button" className="suggest" onClick={() => window.dispatchEvent(new CustomEvent<string>(COMPOSE_EVENT, { detail: t(key) }))}>
            <Icon className="ic" aria-hidden="true" />
            <span>{t(key)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
