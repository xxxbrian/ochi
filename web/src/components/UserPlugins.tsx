import { useEffect, useRef, useState } from "react";
import { LoaderCircle, LockKeyhole, Puzzle, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import type { ApiError, Plugin } from "../lib/types";
import "./user-plugins.css";

export function UserPlugins() {
  const [items, setItems] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const pendingRef = useRef(new Set<string>());
  const needsRefresh = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
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
    setItems((current) => current.map((item) => item.id === plugin.id ? { ...item, effective_enabled: enabled } : item));
    try {
      const value = await api.updatePlugin(plugin.id, enabled);
      if (mounted.current) setItems((current) => current.map((item) => item.id === plugin.id ? value : item));
    } catch (reason) {
      if (!mounted.current) return;
      setItems((current) => current.map((item) => item.id === plugin.id ? plugin : item));
      setError(reason instanceof Error ? reason.message : "保存失败");
      // A catalog change may have locked or removed the switch since it loaded.
      if ([403, 404, 409].includes((reason as ApiError | null)?.status ?? 0)) needsRefresh.current = true;
    } finally {
      pendingRef.current.delete(plugin.id);
      if (mounted.current) {
        setPending(new Set(pendingRef.current));
        if (!pendingRef.current.size && needsRefresh.current) {
          needsRefresh.current = false;
          setRevision((value) => value + 1);
        }
      }
    }
  }

  return (
    <section className="ochi-settings__panel user-plugins" id="settings-plugins" aria-label="插件">
      <div className="ochi-settings__heading">
        <h3><Puzzle size={16} />插件{!loading && <span>{items.length}</span>}</h3>
        <button className="icon-button" aria-label="刷新插件" title="刷新插件" disabled={loading || pending.size > 0} onClick={() => setRevision((value) => value + 1)}>
          <RefreshCw size={16} />
        </button>
      </div>
      {error && <div className="user-plugins__error" role="alert"><p>{error}</p><button className="text-button" disabled={loading || pending.size > 0} onClick={() => setRevision((value) => value + 1)}>重试</button></div>}
      {loading ? <div className="panel-loading" role="status"><LoaderCircle className="spin" size={20} /><span className="sr-only">加载插件</span></div> : (
        <div className="user-plugins__list">
          {items.map((plugin) => {
            const locked = plugin.default_enabled || Boolean(plugin.locked);
            const updating = pending.has(plugin.id);
            return <article key={plugin.id}>
              <div className="user-plugins__main">
                <strong id={`plugin-name-${plugin.id}`}>{plugin.name}</strong>
                {plugin.description && <p>{plugin.description}</p>}
                {locked && <span className="user-plugins__locked" id={`plugin-lock-${plugin.id}`}><LockKeyhole size={12} />管理员默认开启</span>}
              </div>
              <label className={`user-plugins__switch${updating ? " is-pending" : ""}`}>
                <input type="checkbox" role="switch" aria-labelledby={`plugin-name-${plugin.id}`} aria-describedby={locked ? `plugin-lock-${plugin.id}` : undefined}
                  checked={locked || Boolean(plugin.effective_enabled)} disabled={locked || updating} aria-busy={updating}
                  onChange={(event) => void toggle(plugin, event.target.checked)} />
                {updating && <LoaderCircle className="spin" size={16} aria-hidden="true" />}
              </label>
            </article>;
          })}
          {!items.length && !error && <p className="user-plugins__empty">暂无可用插件</p>}
        </div>
      )}
    </section>
  );
}
