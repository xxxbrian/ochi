import { t, useAdminI18n } from "./i18n";
import { useEffect, useState } from "react";
import { ExternalLink, LoaderCircle, Search, Trash2 } from "lucide-react";
import { request } from "../../lib/api";
import { SelectField } from "../../components/ui/Select";
import { ErrorNotice, Field, Toggle } from "./Fields";
import "./search.css";

type Provider = "exa" | "brave" | "searxng";
type Settings = {
  enabled: boolean;
  provider: Provider;
  base_url: string;
  has_api_key: boolean;
  max_results: number;
  timeout_seconds: number;
};
type SearchResult = {
  query: string;
  count: number;
  results: { title: string; url: string; description?: string }[];
};
const providers = {
  exa: { title: "Exa", baseURL: "https://api.exa.ai", docs: "https://exa.ai/docs/reference/search" },
  brave: { title: "Brave Search", baseURL: "https://api.search.brave.com/res/v1", docs: "https://api-dashboard.search.brave.com/documentation/quickstart" },
  searxng: { title: "SearXNG", baseURL: "", docs: "https://docs.searxng.org/dev/search_api.html" },
};

function resultHost(address: string): string {
  try { return new URL(address).hostname; } catch { return ""; }
}

export default function SearchPage() {
  useAdminI18n();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [key, setKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void request<Settings>("/api/admin/search", { signal: controller.signal })
      .then((value) => { setSettings(value); setSaved(value); })
      .catch((reason: Error) => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, []);

  function payload() {
    if (!settings) return {};
    const { has_api_key: _hasKey, ...config } = settings;
    return { ...config, api_key_action: key ? "replace" : removeKey ? "delete" : "keep", ...(key ? { api_key: key } : {}) };
  }
  async function save() {
    setBusy("save"); setError(""); setNotice("");
    try {
      const value = await request<Settings>("/api/admin/search", { method: "PATCH", body: JSON.stringify(payload()) });
      setSettings(value); setSaved(value);
      setKey(""); setRemoveKey(false); setNotice(t("saved"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("saveFailed"));
    } finally { setBusy(null); }
  }
  async function test() {
    setBusy("test"); setError(""); setNotice(""); setResult(null);
    try {
      setResult(await request<SearchResult>("/api/admin/search/test", { method: "POST", body: JSON.stringify({ ...payload(), query }) }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("testFailed"));
    } finally { setBusy(null); }
  }

  const retainedKey = Boolean(saved?.has_api_key && settings?.provider === saved.provider && !removeKey);
  return <>
    <div className="admin-page-heading"><h2>{t("webSearch")}</h2></div>
    <ErrorNotice error={error} notice={notice} />
    {!settings ? (error ? null : <div className="panel-loading"><LoaderCircle className="spin" size={22} /></div>) :
      <div className="search-settings">
        <form className="admin-form system-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <fieldset className="search-settings-fields" disabled={busy !== null}>
            <section className="settings-card">
              <Toggle title={t("enableWebSearch")} value={settings.enabled} onChange={(enabled) => setSettings({ ...settings, enabled })} />
              <Field title={t("searchProvider")}>
                <SelectField value={settings.provider} options={Object.entries(providers).map(([value, provider]) => ({ value, label: provider.title }))}
                  onChange={(value) => {
                    const provider = value as Provider;
                    const returning = provider === saved?.provider;
                    setSettings({ ...settings, provider, base_url: returning ? saved.base_url : providers[provider].baseURL });
                    setKey(""); setResult(null); setNotice("");
                  }} />
              </Field>
              <Field title={t("serviceURL")}><input type="url" required value={settings.base_url} placeholder={settings.provider === "searxng" ? "https://search.example.com" : providers[settings.provider].baseURL}
                onChange={(event) => setSettings({ ...settings, base_url: event.target.value })} /></Field>
              <Field title={settings.provider === "searxng" ? t("optionalAPIKey") : t("apiKey")}>
                <div className="search-key-control">
                  <input type="password" value={key} autoComplete="new-password" placeholder={retainedKey ? t("configuredKeepBlank") : t("enterKey")}
                    onChange={(event) => setKey(event.target.value)} />
                  {retainedKey && <button type="button" className="icon-button" title={t("clearSavedKey")} aria-label={t("clearSavedKey")} onClick={() => { setRemoveKey(true); setKey(""); }}><Trash2 size={16} /></button>}
                </div>
              </Field>
              {removeKey && saved?.has_api_key && settings.provider === saved.provider && <span className="search-config-note">{t("clearKeyAfterSave")}</span>}
              <Field title={t("maxResults")}><input type="number" min={1} max={20} required value={settings.max_results}
                onChange={(event) => setSettings({ ...settings, max_results: Number(event.target.value) })} /></Field>
              <Field title={t("timeoutSeconds")}><input type="number" min={3} max={60} required value={settings.timeout_seconds}
                onChange={(event) => setSettings({ ...settings, timeout_seconds: Number(event.target.value) })} /></Field>
              <div className="search-config-footer">
                <a href={providers[settings.provider].docs} target="_blank" rel="noreferrer">{providers[settings.provider].title} {t("documentation")}<ExternalLink size={13} /></a>
                <button type="submit" className="primary-button">{busy === "save" && <LoaderCircle className="spin" size={15} />}{t("save")}</button>
              </div>
            </section>
          </fieldset>
        </form>
        <form className="search-test" onSubmit={(event) => { event.preventDefault(); void test(); }}>
          <h3>{t("testSearch")}</h3>
          <div className="search-test-query">
            <input required aria-label={t("testSearchQuery")} maxLength={600} value={query} placeholder={t("enterSearchQuery")} disabled={busy !== null} onChange={(event) => setQuery(event.target.value)} />
            <button className="secondary-button" disabled={busy !== null || !query.trim()}>{busy === "test" ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />}{t("test")}</button>
          </div>
          {result && <div className="search-test-results" role="status">
            <span>{result.count ? t("searchResults", { count: result.count }) : t("noResults")}</span>
            {result.results.filter((item) => resultHost(item.url)).map((item) => <a key={item.url} href={item.url} target="_blank" rel="noreferrer"><strong>{item.title}</strong><span>{resultHost(item.url)}</span></a>)}
          </div>}
        </form>
      </div>}
  </>;
}
