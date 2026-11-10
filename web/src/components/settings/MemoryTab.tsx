import { t, getLocale } from "../../lib/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Brain, ChevronDown, ListFilter, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import type { Memory, Project } from "../../lib/types";
import { SelectField } from "../ui/Select";
import { toast } from "../ui/Toast";
import { Card, Collapse, Empty, ErrorAlert, Row, Sec, Skeleton, Toggle, useSaved } from "./ui";
import { usePreferences } from "./usePreferences";
import { useMemories } from "./memoryStore";

const MINUTE = 60_000;
/** "2 hours ago" style stamps for the first weeks, then a short date. */
function stamp(value: string): string {
  const age = Date.now() - new Date(value).getTime();
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" });
  if (age < MINUTE) return rtf.format(0, "minute");
  if (age < 60 * MINUTE) return rtf.format(-Math.floor(age / MINUTE), "minute");
  if (age < 24 * 60 * MINUTE) return rtf.format(-Math.floor(age / (60 * MINUTE)), "hour");
  if (age < 7 * 24 * 60 * MINUTE) return rtf.format(-Math.floor(age / (24 * 60 * MINUTE)), "day");
  if (age < 35 * 24 * 60 * MINUTE) return rtf.format(-Math.floor(age / (7 * 24 * 60 * MINUTE)), "week");
  return new Date(value).toLocaleDateString(getLocale(), { year: "numeric", month: "short", day: "numeric" });
}
export function MemoryTab({ accountId, projects, onClose, onNavigate }: { accountId: string; projects: Project[]; onClose: () => void; onNavigate?: (path: string) => void }) {
  const { saved } = useSaved();
  const { preferences, error: preferenceError, update } = usePreferences();
  const { memories, loading, error: loadError, leaving, fresh, reload, remove: removeMemory, upsert } = useMemories(accountId);
  const [saveError, setSaveError] = useState("");
  const [editing, setEditing] = useState<Partial<Memory> | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [kind, setKind] = useState("all");
  const [filtering, setFiltering] = useState(false);
  const mounted = useRef(true);
  const error = saveError || loadError;

  const kinds = [
    { value: "fact", label: t("memory.fact") },
    { value: "preference", label: t("memory.preference") },
    { value: "session_summary", label: t("memory.sessionSummary") },
    { value: "project_summary", label: t("memory.projectSummary") },
  ];

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const filtered = useMemo(
    () => memories.filter((memory) =>
      (scope === "all" || (scope === "user" && !memory.project_id) || memory.project_id === scope) &&
      (kind === "all" || memory.kind === kind) &&
      memory.content.toLowerCase().includes(query.trim().toLowerCase())),
    [memories, scope, kind, query],
  );
  const filterActive = scope !== "all" || kind !== "all" || query.trim() !== "";
  const adding = editing !== null && !editing.id;
  const enabled = preferences?.memory_enabled ?? true;

  async function save() {
    if (!editing?.content?.trim() || busy) return;
    setBusy(true);
    setSaveError("");
    try {
      const metadata = { kind: editing.kind ?? "fact", project_id: editing.project_id ?? "" };
      const memory = editing.id
        ? await api.updateMemory(editing.id, editing.content.trim(), metadata)
        : await api.addMemory(editing.content.trim(), metadata);
      if (!upsert(memory)) return;
      if (mounted.current) {
        saved();
        setEditing(null);
      }
      toast(editing.id ? t("memory.updated") : t("memory.added"));
    } catch (reason) {
      if (mounted.current) setSaveError(reason instanceof Error ? reason.message : t("error.save"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function remove(memory: Memory) {
    if (removeMemory(memory)) {
      setSaveError("");
      if (editing?.id === memory.id) setEditing(null);
      saved();
    }
  }

  const scopeName = (memory: Partial<Memory>) =>
    memory.project_id ? (projects.find((project) => project.id === memory.project_id)?.name ?? t("projects.title")) : t("memory.personal");
  const kindLabel = (memory: Memory) => kinds.find((item) => item.value === memory.kind)?.label ?? t("memory.fact");

  const editor = (compact: boolean) => editing && (
    <form
      className="st-editor"
      aria-label={editing.id ? t("memory.edit") : t("memory.add")}
      onSubmit={(event) => { event.preventDefault(); void save(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); setEditing(null); }
        else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
      }}
    >
      <textarea
        autoFocus
        className="textarea"
        rows={compact ? 2 : 3}
        aria-label={t("common.content")}
        placeholder={t("memory.placeholder")}
        value={editing.content ?? ""}
        onChange={(event) => setEditing({ ...editing, content: event.target.value })}
      />
      <div className="st-editor-fields">
        <SelectField label={t("memory.kind")} value={editing.kind ?? "fact"} onChange={(value) => setEditing({ ...editing, kind: value as Memory["kind"] })} options={kinds} />
        <SelectField
          label={t("memory.scopeLabel")}
          value={editing.project_id ?? ""}
          onChange={(project_id) => setEditing({ ...editing, project_id })}
          options={[{ value: "", label: t("memory.personal") }, ...projects.map((project) => ({ value: project.id, label: project.name }))]}
        />
      </div>
      <div className="st-btns">
        <button type="button" className="btn ghost sm" onClick={() => setEditing(null)}>{t("common.cancel")}</button>
        <button type="submit" className={`btn primary sm${busy ? " btn-progress" : ""}`} disabled={busy || !editing.content?.trim()}>
          {busy ? t("common.saving") : editing.id ? t("common.save") : t("common.add")}
        </button>
      </div>
    </form>
  );

  return (
    <>
      {(error || preferenceError) && <ErrorAlert message={error || preferenceError} onRetry={loadError && !memories.length ? reload : undefined} retryLabel={t("common.retry")} />}
      <Sec index={0}>
        <Card>
          <Row id="memory" title={t("memory.enable")} desc={t("memory.enableHint")}>
            <Toggle label={t("memory.enable")} checked={enabled} disabled={!preferences} onChange={(value) => void update({ memory_enabled: value }).then((ok) => ok && saved("memory"))} />
          </Row>
        </Card>
      </Sec>
      <Sec index={1} title={<>{t("memory.saved")}<span className="st-count tnum">{memories.length}</span></>}>
        <div className="st-mem-wrap" data-off={!enabled}>
          <div className="st-tools">
            <div className="search-field">
              <Search size={15} className="ic" aria-hidden="true" />
              <input className="input st-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("memory.search")} aria-label={t("memory.search")} />
            </div>
            <button type="button" className="icon-btn st-filter" aria-label={t("memory.filter")} title={t("memory.filter")} aria-expanded={filtering} onClick={() => setFiltering((value) => !value)}>
              <ListFilter size={16} />
              {(scope !== "all" || kind !== "all") && <span className="st-filter-dot" />}
            </button>
            <button type="button" className="btn secondary" aria-expanded={adding} onClick={() => setEditing(adding ? null : { content: "", kind: "fact" })}>
              <Plus size={15} />{t("memory.add")}
            </button>
          </div>
          <Collapse open={filtering}>
            <div className="st-filters">
              <SelectField value={scope} onChange={setScope} label={t("memory.scopeLabel")} options={[{ value: "all", label: t("memory.allScopes") }, { value: "user", label: t("memory.personal") }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} />
              <SelectField value={kind} onChange={setKind} label={t("memory.kind")} options={[{ value: "all", label: t("memory.allKinds") }, ...kinds]} />
              <button type="button" className="btn ghost sm" onClick={() => { setScope("all"); setKind("all"); }}>{t("common.reset")}</button>
            </div>
          </Collapse>
          <Collapse open={adding}>
            <div className="st-composer">{adding && editor(true)}</div>
          </Collapse>
          {loading ? <Skeleton label={t("status.loading")} /> : filtered.length ? (
            <Card className="st-mem-list">
              {filtered.map((item) => {
                const editingThis = editing?.id === item.id;
                return (
                  <article key={item.id} className="st-mem collapse" data-open={!leaving.has(item.id)} data-new={fresh === item.id || undefined}>
                    <div className="collapse-in">
                      <div className="st-mem-in">
                        {editingThis ? <div className="st-mem-edit">{editor(false)}</div> : <>
                          <div className="st-mem-main">
                            <p>{item.content}</p>
                            <span className="st-meta">
                              <span className="pill" data-tone={item.kind === "preference" ? "accent" : undefined}>{kindLabel(item)}</span>
                              <time dateTime={item.updated_at ?? item.created_at}>{stamp(item.updated_at ?? item.created_at)}</time>
                              {item.project_id && <span>{scopeName(item)}</span>}
                              {item.source === "automatic" && <span>{t("common.automatic")}</span>}
                              {item.source === "agent" && <span>{t("memory.assistant")}</span>}
                              {item.source_session_id && (
                                <button type="button" className="st-link" onClick={() => { onClose(); onNavigate?.(`/c/${item.source_session_id}`); }}>
                                  {t("memory.sourceConversation")}<ArrowUpRight size={12} />
                                </button>
                              )}
                            </span>
                            {item.source_excerpt && (
                              <details className="st-excerpt">
                                <summary>{t("memory.sourceExcerpt")}<ChevronDown size={13} /></summary>
                                <blockquote>{item.source_excerpt}</blockquote>
                              </details>
                            )}
                          </div>
                          <div className="st-acts">
                            <button type="button" className="icon-btn sm" disabled={leaving.has(item.id)} onClick={() => setEditing(item)} aria-label={t("memory.edit")}><Pencil size={14} /></button>
                            <button type="button" className="icon-btn sm st-del" disabled={leaving.has(item.id)} onClick={() => remove(item)} aria-label={t("memory.delete")}><Trash2 size={14} /></button>
                          </div>
                        </>}
                      </div>
                    </div>
                  </article>
                );
              })}
            </Card>
          ) : !adding && (
            <Empty
              icon={filterActive ? <Search size={20} aria-hidden="true" /> : <Brain size={20} aria-hidden="true" />}
              title={filterActive ? t("memory.noResults") : t("memory.empty")}
              hint={filterActive ? t("memory.noResultsHint") : t("memory.emptyHint")}
            />
          )}
        </div>
      </Sec>
    </>
  );
}
