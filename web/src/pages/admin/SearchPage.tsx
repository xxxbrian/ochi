import { t, useAdminI18n, type AdminMessageKey } from "./i18n";
import { useEffect, useState, type CSSProperties } from "react";
import { ExternalLink, Eye, EyeOff, Globe, Search, Trash2 } from "lucide-react";
import { request } from "../../lib/api";
import { AdminSkeleton, ErrorNotice, Field } from "./Fields";
import { AdminHeader, Card, CardHead, Empty, hueOf, Pill, SkeletonRows } from "./ui";

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
const providers: Record<Provider, { title: string; baseURL: string; docs: string; desc: AdminMessageKey; tag?: "selfHosted" }> = {
  exa: { title: "Exa", baseURL: "https://api.exa.ai", docs: "https://exa.ai/docs/reference/search", desc: "searchDescExa" },
  brave: { title: "Brave Search", baseURL: "https://api.search.brave.com/res/v1", docs: "https://api-dashboard.search.brave.com/documentation/quickstart", desc: "searchDescBrave" },
  searxng: { title: "SearXNG", baseURL: "", docs: "https://docs.searxng.org/dev/search_api.html", desc: "searchDescSearxng", tag: "selfHosted" },
};

function resultHost(address: string): string {
  try { return new URL(address).hostname; } catch { return ""; }
}

export default function SearchPage() {
  useAdminI18n();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [key, setKey] = useState("");
  const [reveal, setReveal] = useState(false);
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
  const current = settings ? providers[settings.provider] : null;
  return <>
    <AdminHeader actions={<button type="submit" form="search-settings" className={`btn primary${busy === "save" ? " btn-progress" : ""}`} disabled={!settings || busy !== null}>
      {busy === "save" ? t("savingEllipsis") : t("save")}</button>} />
    <ErrorNotice error={error} notice={notice} />
    {!settings ? (error ? null : <AdminSkeleton rows={3} />) : <>
      <form id="search-settings" className="ochi-admin-stack-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <Card>
          <CardHead title={t("searchProvider")} desc={t("searchProviderHint")}
            right={<label className="ochi-admin-inline-switch"><span>{t("enableWebSearch")}</span>
              <button type="button" className="toggle" role="switch" aria-checked={settings.enabled} aria-label={t("enableWebSearch")}
                onClick={() => setSettings({ ...settings, enabled: !settings.enabled })}><i /></button></label>} />
          <div className="ochi-admin-pick">
            {(Object.keys(providers) as Provider[]).map((id) => (
              <button type="button" key={id} className="ochi-admin-opt" aria-pressed={settings.provider === id} disabled={busy !== null}
                onClick={() => {
                  const returning = id === saved?.provider;
                  setSettings({ ...settings, provider: id, base_url: returning ? saved.base_url : providers[id].baseURL });
                  setKey(""); setResult(null); setNotice("");
                }}>
                <span className="ochi-admin-glyph" style={{ "--h": hueOf(providers[id].title) } as CSSProperties}>{providers[id].title[0]}</span>
                <span className="ochi-admin-opt-t">
                  <b>{providers[id].title}{providers[id].tag ? <Pill tone="accent">{t("selfHosted")}</Pill> : null}</b>
                  <small>{t(providers[id].desc)}</small>
                </span>
                <i className="ochi-admin-radio" />
              </button>
            ))}
          </div>
        </Card>
        <Card>
          <fieldset className="ochi-admin-fieldset" disabled={busy !== null}>
            <Field title={t("serviceURL")}>
              <input className="input mono" type="url" required value={settings.base_url}
                placeholder={settings.provider === "searxng" ? "https://search.example.com" : providers[settings.provider].baseURL}
                onChange={(event) => setSettings({ ...settings, base_url: event.target.value })} />
            </Field>
            <div className="ochi-admin-grid2">
              <Field title={settings.provider === "searxng" ? t("optionalAPIKey") : t("apiKey")} hint={removeKey && retainedKey === false && saved?.has_api_key ? t("clearKeyAfterSave") : t("searchKeyHint")}>
                <div className="ochi-admin-input-row">
                  <input className="input mono" type={reveal ? "text" : "password"} value={key} autoComplete="new-password"
                    placeholder={retainedKey ? t("configuredKeepBlank") : t("enterKey")} onChange={(event) => setKey(event.target.value)} />
                  <button type="button" className="icon-btn" aria-label={reveal ? t("hideKey") : t("showKey")} onClick={() => setReveal(!reveal)}>
                    {reveal ? <EyeOff className="ic" /> : <Eye className="ic" />}</button>
                  {retainedKey && <button type="button" className="icon-btn" title={t("clearSavedKey")} aria-label={t("clearSavedKey")} onClick={() => { setRemoveKey(true); setKey(""); }}><Trash2 className="ic" /></button>}
                </div>
              </Field>
              <Field title={t("timeoutSeconds")}>
                <input className="input" type="number" min={3} max={60} required value={settings.timeout_seconds}
                  onChange={(event) => setSettings({ ...settings, timeout_seconds: Number(event.target.value) })} />
              </Field>
            </div>
            <Field title={`${t("maxResults")}`} hint={t("maxResultsHint")}>
              <div className="ochi-admin-range-row">
                <input className="slider" type="range" min={1} max={20} value={settings.max_results}
                  style={{ "--p": `${((settings.max_results - 1) / 19) * 100}%` } as CSSProperties}
                  onChange={(event) => setSettings({ ...settings, max_results: Number(event.target.value) })} />
                <b className="ochi-admin-range-v tnum">{settings.max_results}</b>
              </div>
            </Field>
            {current && <a className="ochi-admin-doc-link" href={current.docs} target="_blank" rel="noreferrer">{current.title} {t("documentation")}<ExternalLink className="ic" /></a>}
          </fieldset>
        </Card>
      </form>
      <Card>
        <CardHead title={t("testSearch")} desc={current ? t("testSearchWith", { name: current.title }) : undefined} />
        <form className="ochi-admin-input-row" onSubmit={(event) => { event.preventDefault(); void test(); }}>
          <div className="search-field grow"><Search className="ic" />
            <input className="input" required aria-label={t("testSearchQuery")} maxLength={600} value={query} placeholder={t("enterSearchQuery")} disabled={busy !== null} onChange={(event) => setQuery(event.target.value)} /></div>
          <button className={`btn primary${busy === "test" ? " btn-progress" : ""}`} disabled={busy !== null || !query.trim()}>
            <span className="ochi-admin-btn-in"><Search className="ic" />{busy === "test" ? t("testingEllipsis") : t("testSearch")}</span></button>
        </form>
        <div className="ochi-admin-results" role="status" aria-live="polite">
          {busy === "test" ? <SkeletonRows rows={3} />
            : result ? <>
              <div className="ochi-admin-rhead muted"><span>{result.count ? t("searchResults", { count: result.count }) : t("noResults")}</span></div>
              {result.results.filter((item) => resultHost(item.url)).map((item, index) => (
                <a className="ochi-admin-res" key={item.url} href={item.url} target="_blank" rel="noreferrer" style={{ "--i": index } as CSSProperties}>
                  <span className="ochi-admin-glyph sm" style={{ "--h": hueOf(resultHost(item.url)) } as CSSProperties}>{resultHost(item.url)[0]?.toUpperCase()}</span>
                  <div><b>{item.title}</b><small className="mono">{resultHost(item.url)}</small>{item.description ? <p>{item.description}</p> : null}</div>
                </a>
              ))}
            </>
            : <Empty icon={<Globe className="ic" />} title={t("searchNotTested")} desc={t("searchNotTestedHint")} />}
        </div>
      </Card>
    </>}
  </>;
}
