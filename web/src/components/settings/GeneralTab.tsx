import { t, useI18n, type LanguagePreference } from "../../lib/i18n";
import { useEffect, useRef, useState } from "react";
import { BrandIcon } from "../BrandIcon";
import { SelectField } from "../ui/Select";
import { preferredChatModel } from "../../lib/modelSelection";
import { getSendKey, setSendKey, type SendKey } from "../../lib/appearance";
import { Card, ErrorAlert, Row, Sec, Seg, Toggle, useSaved } from "./ui";
import { useChatModels, usePreferences } from "./usePreferences";

export function GeneralTab({ onLanguage }: { onLanguage: (language: LanguagePreference) => Promise<void> }) {
  const { language } = useI18n();
  const { saved } = useSaved();
  const { preferences, error, update, reload } = usePreferences();
  const { models } = useChatModels();
  const [languageError, setLanguageError] = useState("");
  const [languageSaving, setLanguageSaving] = useState(false);
  const [sendKey, setSendKeyState] = useState<SendKey>(getSendKey);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = models && preferences ? preferredChatModel(models, preferences.preferred_model_id) : undefined;
  return (
    <>
      {(error || languageError) && <ErrorAlert message={languageError || error} onRetry={error ? reload : undefined} retryLabel={t("common.retry")} />}
      <Sec index={0} title={t("settings.sec.languageInput")}>
        <Card>
          <Row id="language" title={t("settings.language")} desc={t("settings.languageHint")}>
            <SelectField
              value={language}
              label={t("settings.language")}
              disabled={languageSaving}
              onChange={(value) => {
                setLanguageSaving(true);
                setLanguageError("");
                void onLanguage(value as LanguagePreference)
                  .then(() => { if (mounted.current) saved("language"); })
                  .catch((reason: unknown) => { if (mounted.current) setLanguageError(reason instanceof Error ? reason.message : t("error.save")); })
                  .finally(() => { if (mounted.current) setLanguageSaving(false); });
              }}
              options={[
                { value: "system", label: t("settings.systemLanguage") },
                { value: "en", label: t("settings.languageEnglish") },
                { value: "zh-CN", label: t("settings.languageSimplified") },
                { value: "zh-TW", label: t("settings.languageTraditional") },
              ]}
            />
          </Row>
          <Row id="send" title={t("settings.sendKey")} desc={t("settings.sendKeyHint")}>
            <Seg<SendKey>
              label={t("settings.sendKey")}
              value={sendKey}
              onChange={(value) => { setSendKeyState(value); setSendKey(value); saved("send"); }}
              options={[{ value: "enter", label: "Enter" }, { value: "mod", label: t("settings.sendKeyMod") }]}
            />
          </Row>
        </Card>
      </Sec>
      <Sec index={1} title={t("settings.sec.defaults")}>
        <Card>
          <Row id="model" title={t("settings.defaultModel")} desc={t("settings.defaultModelHint")}>
            <SelectField
              value={current?.id ?? ""}
              label={t("settings.defaultModel")}
              disabled={!models?.length || !preferences}
              triggerClassName="st-select"
              onChange={(value) => void update({ preferred_model_id: value }).then((ok) => ok && saved("model"))}
              options={(models ?? []).map((model) => ({
                value: model.id,
                label: model.name,
                detail: model.provider_name,
                icon: <BrandIcon src={model.provider_icon} size={16} />,
              }))}
            />
          </Row>
          <Row id="computer" title={t("settings.computerDefault")} desc={t("settings.computerDefaultHint")}>
            <Toggle
              label={t("settings.computerDefault")}
              checked={Boolean(preferences?.computer_default)}
              disabled={!preferences}
              onChange={(value) => void update({ computer_default: value }).then((ok) => ok && saved("computer"))}
            />
          </Row>
        </Card>
      </Sec>
    </>
  );
}
