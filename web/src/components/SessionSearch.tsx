import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CornerDownLeft, Folder, LoaderCircle, MessageSquare, Search } from "lucide-react";
import { api } from "../lib/api";
import type { Session } from "../lib/types";
import { Modal } from "./Modal";
import "./session-search.css";

function Highlight({ text, query }: { text: string; query: string }) {
  const index = query ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
  return index < 0 ? text : <>{text.slice(0, index)}<mark>{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>;
}

export function SessionSearch({ onClose, onSelect, projectId, onSelectSession }: {
  onClose: () => void;
  onSelect: (id: string) => void;
  projectId?: string;
  onSelectSession?: (session: Session) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Session[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const search = query.trim();

  useEffect(() => {
    const token = ++generation.current;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setActive(0);
    setMoreLoading(false);
    const timer = window.setTimeout(() => {
      void api.sessionsPage({ q: search, project_id: projectId, limit: 25 }, controller.signal)
        .then((page) => {
          if (token !== generation.current) return;
          setItems(page.items);
          setCursor(page.next_cursor);
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "搜索失败");
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, search ? 180 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); generation.current += 1; };
  }, [search, projectId]);

  useEffect(() => {
    list.current?.querySelector(`[data-result="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function select(id: string) {
    const selected = items.find((item) => item.id === id);
    if (selected) onSelectSession?.(selected);
    onSelect(id);
    onClose();
  }
  function keyboard(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((value) => Math.max(0, Math.min(items.length - 1, value + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (event.key === "Enter" && items[active] && !loading) {
      event.preventDefault();
      select(items[active].id);
    }
  }
  async function more() {
    if (!cursor || moreLoading || loading) return;
    const token = generation.current;
    setMoreLoading(true);
    try {
      const page = await api.sessionsPage({ q: search, cursor, project_id: projectId, limit: 25 });
      if (token !== generation.current) return;
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setCursor(page.next_cursor);
    } catch (reason) {
      if (token === generation.current) setError(reason instanceof Error ? reason.message : "加载失败");
    } finally { if (token === generation.current) setMoreLoading(false); }
  }

  return <Modal title="搜索对话" onClose={onClose} bodyClassName="session-search-body">
    <div className="session-search-input">
      <Search size={18} />
      <input autoFocus aria-label="搜索全部对话" placeholder="搜索对话" value={query} maxLength={200}
        onChange={(event) => setQuery(event.target.value)} onKeyDown={keyboard}
        role="combobox" aria-autocomplete="list" aria-controls="session-search-results"
        aria-expanded={items.length > 0} aria-activedescendant={!loading && items[active] ? `search-${items[active].id}` : undefined} />
      {loading && <LoaderCircle size={16} className="spin" />}
    </div>
    <div className="session-search-results" ref={list} role="listbox" id="session-search-results" aria-label="搜索结果" aria-busy={loading}>
      {error ? <div className="search-empty form-error">{error}</div> : !loading && !items.length ? <div className="search-empty">没有找到对话</div> :
        !loading && items.map((item, index) => <button key={item.id} id={`search-${item.id}`} data-result={index}
          className={`session-search-result ${index === active ? "is-active" : ""}`} role="option" aria-selected={index === active}
          onMouseEnter={() => setActive(index)} onClick={() => select(item.id)}>
          <MessageSquare size={17} className="search-result-icon" />
          <span className="search-result-content">
            <strong><Highlight text={item.title || "新对话"} query={search} /></strong>
            {item.excerpt && <span className="search-result-excerpt"><Highlight text={item.excerpt.replace(/\s+/g, " ")} query={search} /></span>}
            <span className="search-result-meta">
              {item.project_name && <><Folder size={12} />{item.project_name}<span>·</span></>}
              {new Date(item.updated_at).toLocaleDateString("zh-CN", { month: "short", day: "numeric", year: "numeric" })}
            </span>
          </span>
          {index === active && <CornerDownLeft size={15} className="search-result-enter" />}
        </button>)}
      {!loading && cursor && <button className="search-load-more" onClick={() => void more()} disabled={moreLoading}>
        {moreLoading ? <LoaderCircle size={14} className="spin" /> : "加载更多"}
      </button>}
    </div>
  </Modal>;
}
