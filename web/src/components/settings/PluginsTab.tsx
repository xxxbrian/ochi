import { t } from "../../lib/i18n";
import { useEffect, useRef, useState } from "react";
import { LockKeyhole, Plug, Puzzle, RefreshCw } from "lucide-react";
import { api } from "../../lib/api";
import type { ApiError, Plugin } from "../../lib/types";
import { Card, Empty, ErrorAlert, Sec, Skeleton, Toggle, useSaved } from "./ui";

/** Administrator-published plugins; the account can switch the optional ones on or off. */
export function PluginsTab() {
  const { saved } = useSaved();
  const [items, setItems] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const pendingRef = useRef(new Set<string>());
  const needsRefresh = useRef(false);
  const mounted = useRef(false);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api.plugins(controller.signal)
      .then((value) => { if (!controller.signal.aborted) setItems(value ?? []); })
      .catch((reason: Error) => { if (!controller.signal.aborted) setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);

  async function toggle(plugin: Plugin, enabled: boolean) {
    if (plugin.default_enabled || plugin.locked || pendingRef.current.has(plugin.id)) return;
    pendingRef.current.add(plugin.id);
    setPending(new Set(pendingRef.current));
    setError("");
    setItems((current) => current.map((item) => (item.id === plugin.id ? { ...item, effective_enabled: enabled } : item)));
    try {
      const value = await api.updatePlugin(plugin.id, enabled);
      if (mounted.current) { setItems((current) => current.map((item) => (item.id === plugin.id ? value : item))); saved(`plugin-${plugin.id}`); }
    } catch (reason) {
      if (!mounted.current) return;
      setItems((current) => current.map((item) => (item.id === plugin.id ? plugin : item)));
      setError(reason instanceof Error ? reason.message : t("error.save"));
      // A catalog change may have locked or removed the switch since it loaded.
      if ([403, 404, 409].includes((reason as ApiError | null)?.status ?? 0)) needsRefresh.current = true;
    } finally {
      pendingRef.current.delete(plugin.id);
      if (mounted.current) {
        setPending(new Set(pendingRef.current));
        if (!pendingRef.current.size && needsRefresh.current) { needsRefresh.current = false; setRevision((value) => value + 1); }
      }
    }
  }
  const refresh = () => setRevision((value) => value + 1);

  return (
    <>
      {error && <ErrorAlert message={error} onRetry={refresh} retryLabel={t("common.retry")} />}
      <Sec
        index={0}
        title={<>{t("plugins.sec.title")}{!loading && <span className="st-count tnum">{items.length}</span>}</>}
        note={t("plugins.note")}
        extra={<button type="button" className="icon-btn sm" aria-label={t("plugins.refresh")} title={t("plugins.refresh")} disabled={loading || pending.size > 0} onClick={refresh}><RefreshCw size={14} className={loading ? "ic-turn" : undefined} /></button>}
      >
        {loading ? <Skeleton label={t("plugins.loading")} /> : items.length ? (
          <Card className="st-plugs">
            {items.map((plugin) => {
              const locked = plugin.default_enabled || Boolean(plugin.locked);
              const on = locked || Boolean(plugin.effective_enabled);
              return (
                <article key={plugin.id} className="st-plug" data-on={on} data-busy={pending.has(plugin.id) || undefined}>
                  <div className="st-prov-h">
                    <div className="st-exp">
                      <span className="st-ico" aria-hidden="true"><Puzzle size={15} /></span>
                      <span className="st-rt">
                        <b>{plugin.name}</b>
                        {plugin.description && <small>{plugin.description}</small>}
                        <small className="st-cnt">
                          {[
                            plugin.skill_ids?.length > 0 && t("plugins.skillCount", { count: plugin.skill_ids.length }),
                            plugin.mcp_ids?.length > 0 && t("plugins.mcpCount", { count: plugin.mcp_ids.length }),
                            locked && t("plugins.required"),
                          ].filter(Boolean).join(" · ")}
                        </small>
                      </span>
                      <span className="st-state">
                        {plugin.skill_ids?.length > 0 && <span className="pill">{t("plugins.skillCount", { count: plugin.skill_ids.length })}</span>}
                        {plugin.mcp_ids?.length > 0 && <span className="pill"><Plug size={11} />{t("plugins.mcpCount", { count: plugin.mcp_ids.length })}</span>}
                        {locked && <span className="pill" data-tone="accent"><LockKeyhole size={11} />{t("plugins.required")}</span>}
                      </span>
                    </div>
                    <Toggle label={plugin.name} checked={on} disabled={locked || pending.has(plugin.id)} onChange={(value) => void toggle(plugin, value)} />
                  </div>
                </article>
              );
            })}
          </Card>
        ) : !error && <Empty icon={<Puzzle size={20} aria-hidden="true" />} title={t("plugins.empty")} hint={t("plugins.emptyHint")} />}
      </Sec>
    </>
  );
}
