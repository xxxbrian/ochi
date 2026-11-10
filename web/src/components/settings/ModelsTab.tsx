import { t } from "../../lib/i18n";
import { useMemo, useState } from "react";
import { ChevronRight, Cpu } from "lucide-react";
import { BrandIcon } from "../BrandIcon";
import type { Model } from "../../lib/types";
import { contextLabel, preferredChatModel } from "../../lib/modelSelection";
import { Card, Collapse, Empty, ErrorAlert, Sec, Skeleton, useSaved } from "./ui";
import { useChatModels, usePreferences } from "./usePreferences";


type Provider = { id: string; name: string; icon?: string; models: Model[] };

/** Read-only catalogue of the models this account can chat with; keys and availability are admin-managed. */
export function ModelsTab() {
  const { saved } = useSaved();
  const { models, error, reload } = useChatModels();
  const { preferences, error: preferenceError, update } = usePreferences();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const providers = useMemo(() => {
    const map = new Map<string, Provider>();
    for (const model of models ?? []) {
      const entry = map.get(model.provider_id) ?? { id: model.provider_id, name: model.provider_name || model.provider_id, icon: model.provider_icon, models: [] };
      entry.models.push(model);
      map.set(model.provider_id, entry);
    }
    return [...map.values()];
  }, [models]);
  const current = models && preferences ? preferredChatModel(models, preferences.preferred_model_id)?.id : undefined;
  return (
    <>
      {(error || preferenceError) && <ErrorAlert message={error || preferenceError} onRetry={error ? reload : undefined} retryLabel={t("common.retry")} />}
      <Sec index={0} title={t("settings.providers")} note={t("settings.modelsNote")}>
        {!models ? <Skeleton label={t("status.loading")} /> : providers.length ? (
          <Card className="st-provs">
            {providers.map((provider) => {
              const expanded = open[provider.id] ?? providers.length === 1;
              return (
                <div key={provider.id} className="st-prov" data-on="true">
                  <div className="st-prov-h">
                    <button type="button" className="st-exp" aria-expanded={expanded} onClick={() => setOpen({ ...open, [provider.id]: !expanded })}>
                      <span className="st-logo"><BrandIcon src={provider.icon} size={16} /></span>
                      <span className="st-rt"><b>{provider.name}</b><small>{t("settings.modelsAvailable", { count: provider.models.length })}</small></span>
                      <ChevronRight size={14} className="st-chev" aria-hidden="true" />
                    </button>
                  </div>
                  <Collapse open={expanded}>
                    <div className="st-prov-b">
                      <div className="st-mlist">
                        {provider.models.map((model) => (
                          <div key={model.id} className="st-model" data-default={model.id === current || undefined}>
                            <span className="st-rt"><b>{model.name}</b><small className="mono">{model.model}</small></span>
                            <span className="st-chips">
                              {model.supports_vision && <span className="pill">{t("settings.modelVision")}</span>}
                              {model.supports_tools && <span className="pill">{t("settings.modelTools")}</span>}
                              {model.supports_image_generation && <span className="pill">{t("settings.modelImage")}</span>}
                              {model.context_window > 0 && <span className="st-ctx mono">{contextLabel(model.context_window)}</span>}
                            </span>
                            <span className="st-model-act">
                              {model.id === current
                                ? <span className="pill" data-tone="accent">{t("settings.modelDefault")}</span>
                                : <button type="button" className="btn ghost sm" disabled={!preferences} onClick={() => void update({ preferred_model_id: model.id }).then((ok) => ok && saved("model"))}>{t("settings.setDefault")}</button>}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </Collapse>
                </div>
              );
            })}
          </Card>
        ) : !error && <Empty icon={<Cpu size={20} aria-hidden="true" />} title={t("settings.modelsEmpty")} hint={t("settings.modelsEmptyHint")} />}
      </Sec>
    </>
  );
}
