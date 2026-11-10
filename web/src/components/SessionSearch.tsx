import { t, useI18n, getLocale } from "../lib/i18n";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { CornerDownLeft, MessageSquare, Search } from "lucide-react";
import { api } from "../lib/api";
import type { Session } from "../lib/types";
import type { PaletteCommand } from "./Sidebar";
import { Modal } from "./Modal";
import { LoadingDots } from "./ui/Loading";
import "./session-search.css";

function Highlight({ text, query }: { text: string; query: string }) {
  useI18n();
  const index = query ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
  return index < 0 ? text : <>{text.slice(0, index)}<mark>{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>;
}

export function SessionSearch({ onClose, onSelect, projectId, onSelectSession, commands = [] }: {
  commands?: PaletteCommand[];
  onClose: () => void;
  onSelect: (id: string) => void;
  projectId?: string;
  onSelectSession?: (session: Session) => void;
}) {
  useI18n();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Session[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(true);
  const [intro, setIntro] = useState(true);
  const generation = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const search = query.trim();
  const shown = projectId ? [] : commands.filter((command) => !search || command.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const total = shown.length + items.length;

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
          if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t("error.search"));
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, search ? 180 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); generation.current += 1; };
  }, [search, projectId]);

  useEffect(() => { const timer = window.setTimeout(() => setIntro(false), 700); return () => window.clearTimeout(timer); }, []);
  useEffect(() => {
    list.current?.querySelector(`[data-result="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function select(id: string) {
    const selected = items.find((item) => item.id === id);
    if (selected) onSelectSession?.(selected);
    onSelect(id);
    setOpen(false);
  }
  function keyboard(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((value) => Math.max(0, Math.min(total - 1, value + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (event.key === "Enter") {
      if (active < shown.length) { event.preventDefault(); const command = shown[active]; setOpen(false); command.run(); }
      else if (items[active - shown.length] && !loading) { event.preventDefault(); select(items[active - shown.length].id); }
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
      if (token === generation.current) setError(reason instanceof Error ? reason.message : t("error.load"));
    } finally { if (token === generation.current) setMoreLoading(false); }
  }

  const activeId = active < shown.length ? `cmd-${shown[active]?.id}` : !loading && items[active - shown.length] ? `search-${items[active - shown.length].id}` : undefined;
  return <Modal title={t("search.conversations")} size="palette" open={open} onClose={onClose} bodyClassName="palette-body">
    <div className="pal-input">
      <Search className="ic" />
      <input autoFocus aria-label={t("search.allConversations")} placeholder={t("palette.placeholder")} value={query} maxLength={200}
        onChange={(event) => setQuery(event.target.value)} onKeyDown={keyboard}
        role="combobox" aria-autocomplete="list" aria-controls="session-search-results"
        aria-expanded={total > 0} aria-activedescendant={activeId} />
      <kbd aria-hidden="true">Esc</kbd>
    </div>
    <div className="pal-list" data-intro={intro || undefined} ref={list} role="listbox" id="session-search-results" aria-label={t("search.results")} aria-busy={loading}>
      {shown.length > 0 && <div className="menu-label">{t("palette.commands")}</div>}
      {shown.map((command, index) => <button key={command.id} id={`cmd-${command.id}`} data-result={index} style={{ "--i": index } as CSSProperties} className="menu-item pal-item" role="option"
        aria-selected={index === active} data-highlighted={index === active || undefined} onMouseEnter={() => setActive(index)}
        onClick={() => { setOpen(false); command.run(); }}>
        {command.icon}<span className="mi-text">{command.label}</span>{command.hint && <kbd>{command.hint}</kbd>}
      </button>)}
      {error ? <div className="pal-empty form-error">{error}</div> : !loading && !items.length && !shown.length ? <div className="pal-empty">{t("search.noConversations")}</div> : null}
      {loading && !error && [0, 1, 2].map((i) => <div key={i} className="pal-skel" aria-hidden="true">
        <span className="skel circle" /><span className="pal-skel-text"><span className="skel line" style={{ width: `${[58, 72, 46][i]}%` }} /><span className="skel line" style={{ width: `${[34, 40, 30][i]}%` }} /></span>
      </div>)}
      {loading && !error && <span className="sr-only" role="status">{t("status.loading")}</span>}
      {!error && !loading && items.length > 0 && <div className="menu-label">{t("palette.conversations")}</div>}
      {!error && !loading && items.map((item, i) => { const index = shown.length + i; return <button key={item.id} id={`search-${item.id}`} data-result={index} style={{ "--i": index } as CSSProperties}
          className="menu-item rich pal-item" role="option" aria-selected={index === active} data-highlighted={index === active || undefined}
          onMouseEnter={() => setActive(index)} onClick={() => select(item.id)}>
          <MessageSquare className="ic" />
          <span className="mi-text">
            <b><Highlight text={item.title || t("chat.newConversation")} query={search} /></b>
            {item.excerpt && <small className="pal-excerpt"><Highlight text={item.excerpt.replace(/\s+/g, " ")} query={search} /></small>}
            <small>
              {item.project_name && <>{item.project_name} · </>}
              {new Date(item.updated_at).toLocaleDateString(getLocale(), { month: "short", day: "numeric", year: "numeric" })}
            </small>
          </span>
          {index === active && <CornerDownLeft className="ic" />}
        </button>; })}
      {!loading && cursor && <button className="menu-item pal-more" onClick={() => void more()} disabled={moreLoading}>
        {moreLoading ? <LoadingDots label={t("status.loading")} /> : t("common.loadMore")}
      </button>}
    </div>
  </Modal>;
}
