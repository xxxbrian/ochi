import { t, useAdminI18n } from "./i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  FileCode2,
  Link,
  Folder,
  GitBranch,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
  Upload,
  WandSparkles,
  Wrench,
  Zap,
} from "lucide-react";
import { adminApi, api } from "../../lib/api";
import type { MCPServer, Skill, User } from "../../lib/types";
import { Modal } from "../../components/Modal";
import { SelectField } from "../../components/ui/Select";
import { ActionMenu, MenuAction } from "../../components/ui/Menu";
import {
  ErrorNotice,
  Field,
  KeyValueEditor,
  keyRows,
  rowsObject,
  Toggle,
  type KeyValue,
} from "./Fields";
import { Card, CardHead, Collapse, Disclosure, Empty, Pill, SkeletonRows, StatusDot, Switch } from "./ui";

type SkillDraft = Partial<Skill> & {
  ref?: string;
  subdir?: string;
  artifact_id?: string;
};
export function SkillsPage() {
  useAdminI18n();
  const [items, setItems] = useState<Skill[]>([]);
  const [editor, setEditor] = useState<SkillDraft | null>(null);
  const [original, setOriginal] = useState<SkillDraft | null>(null);
  const [sourceType, setSourceType] = useState("git");
  const [uploadName, setUploadName] = useState("");
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [install, setInstall] = useState<Skill | null>(null);
  const [command, setCommand] = useState("");
  const [targetUser, setTargetUser] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [result, setResult] = useState("");
  const [deleting, setDeleting] = useState<Skill | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!install) return;
    let cancelled = false;
    setTargetUser("");
    void adminApi.users().then((value) => { if (!cancelled) setUsers(value); })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, [install]);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await adminApi.skills());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function edit(skill?: Skill) {
    setError("");
    setUploadName("");
    setOriginal(null);
    if (!skill) {
      setSourceType("git");
      setEditor({ source: "", content: "", enabled: true });
      return;
    }
    setBusy(skill.id);
    try {
      const details = await adminApi.skill(skill.id);
      setSourceType(
        details.source?.startsWith("http") || details.source?.startsWith("git")
          ? "git"
          : details.source === "inline"
            ? "inline"
            : "bundle",
      );
      setEditor(details);
      setOriginal(details);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("readFailed"));
    } finally {
      setBusy("");
    }
  }
  async function save() {
    if (!editor) return;
    setBusy("save");
    try {
      const value: Record<string, unknown> = {
        id: editor.id,
        source: sourceType === "inline" ? "inline" : editor.source,
        ref: editor.ref,
        subdir: editor.subdir,
        content: editor.content,
        artifact_id: editor.artifact_id,
        enabled: editor.enabled,
      };
      if (original)
        for (const key of ["source", "ref", "subdir", "content", "artifact_id"])
          if (value[key] === (original as Record<string, unknown>)[key])
            delete value[key];
      await adminApi.save<Skill>("skills", value, Boolean(editor.id));
      setEditor(null);
      setNotice(t("saved"));
      void refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("saveFailed"));
    } finally {
      setBusy("");
    }
  }
  async function upload(file?: File) {
    if (!file || !editor) return;
    setBusy("upload");
    try {
      const artifact = await api.upload(file);
      setUploadName(file.name);
      setEditor({ ...editor, artifact_id: artifact.id, source: artifact.path });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("uploadFailed"));
    } finally {
      setBusy("");
    }
  }
  async function test(skill: Skill) {
    setBusy(skill.id);
    try {
      const value = await adminApi.test("skills", skill.id);
      if (!value.ok) throw new Error(value.error ?? t("validationFailed"));
      setNotice(t("validationPassed"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("validationFailed"));
    } finally {
      setBusy("");
    }
  }
  async function update(skill: Skill) {
    setBusy(skill.id);
    setError("");
    try {
      const details = await adminApi.skill(skill.id);
      await adminApi.save<Skill>(
        "skills",
        {
          id: details.id,
          source: details.source,
          ref: details.ref,
          subdir: details.subdir,
          enabled: details.enabled,
        },
        true,
      );
      setNotice(t("updated"));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("updateFailed"));
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <Card>
        <CardHead title={t("skillComponents")} desc={t("skillsCardHint", { count: items.length })}
          right={<button className="btn primary sm" onClick={() => void edit()}><Plus className="ic" />{t("installSkill")}</button>} />
        <ErrorNotice error={error} notice={notice} />
        {loading ? (
          <div className="ochi-admin-plist"><SkeletonRows rows={2} /></div>
        ) : items.length ? (
          <div className="ochi-admin-plist">
            {items.map((skill) => {
              const kind = skill.source === "inline" ? "SKILL.md" : skill.source?.startsWith("http") || skill.source?.startsWith("git") ? "Git" : t("archive");
              return (
                <div className="ochi-admin-prow" key={skill.id}>
                  <div className="ochi-admin-prow-h">
                    <span className="ochi-admin-tile"><WandSparkles className="ic" /></span>
                    <button type="button" className="ochi-admin-prow-t ochi-admin-rowbtn" onClick={() => void edit(skill)}>
                      <b>{skill.name}</b><small>{skill.description}</small>
                    </button>
                    <span className="ochi-admin-pcol"><Pill tone="accent">{[skill.version ? `v${skill.version}` : "", kind].filter(Boolean).join(" · ")}</Pill></span>
                    <span className="ochi-admin-pcol"><StatusDot tone={skill.enabled ? "success" : ""}>{skill.enabled ? t("ready") : t("disabled")}</StatusDot></span>
                    <Switch on={skill.enabled} label={t("enableNamed", { name: skill.name })} busy={busy === skill.id}
                      onChange={(enabled) => {
                        setBusy(skill.id);
                        void adminApi.save<Skill>("skills", { id: skill.id, enabled }, true)
                          .then(() => refresh())
                          .catch((reason: Error) => setError(reason.message))
                          .finally(() => setBusy(""));
                      }} />
                    <ActionMenu trigger={<MoreHorizontal className="ic" />} label={t("skillActions")} className="icon-btn sm">
                      <MenuAction onClick={() => void edit(skill)}><Pencil className="ic" />{t("details")}</MenuAction>
                      <MenuAction onClick={() => void test(skill)}><Check className="ic" />{t("validate")}</MenuAction>
                      <MenuAction onClick={() => { setInstall(skill); setCommand(""); setResult(""); }}><Terminal className="ic" />{t("installDependencies")}</MenuAction>
                      {(skill.source?.startsWith("http") || skill.source?.startsWith("git")) && (
                        <MenuAction onClick={() => void update(skill)}><RefreshCw className="ic" />{t("update")}</MenuAction>
                      )}
                      <MenuAction danger onClick={() => setDeleting(skill)}><Trash2 className="ic" />{t("delete")}</MenuAction>
                    </ActionMenu>
                  </div>
                </div>
              );
            })}
          </div>
        ) : <Empty icon={<WandSparkles className="ic" />} title={t("noSkills")} />}
      </Card>
      {editor && (
        <Modal
          className="ochi-admin-modal"
          title={editor.id ? editor.name || t("skillDetails") : t("installSkill")}
          onClose={() => setEditor(null)}
          size={editor.id || sourceType === "inline" ? "large" : "form"}
          footer={
            <div className="modal-actions">
              <button
                type="button"
                className="btn secondary"
                onClick={() => setEditor(null)}
              >
                {t("cancel")}</button>
              <button
                type="submit"
                form="skill-editor"
                className={`btn primary${busy === "save" ? " btn-progress" : ""}`}
                disabled={busy === "save" || busy === "upload"}
              >
                {busy === "save" ? t("savingEllipsis") : t("save")}</button>
            </div>
          }
        >
          <form
            id="skill-editor"
            className="admin-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {editor.id && (
              <div className="skill-metadata">
                <p>{editor.description}</p>
                <div className="record-tags">
                  {editor.version && <span>{editor.version}</span>}
                  {editor.compatibility && <span>{editor.compatibility}</span>}
                </div>
              </div>
            )}
            <div className="segmented-control">
              {[
                { id: "git", label: "Git", icon: <GitBranch size={15} /> },
                { id: "bundle", label: t("archive"), icon: <Upload size={15} /> },
                {
                  id: "inline",
                  label: t("inlineSource"),
                  icon: <FileCode2 size={15} />,
                },
              ].map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={sourceType === item.id ? "selected" : ""}
                  onClick={() => setSourceType(item.id)}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </div>
            {sourceType === "git" ? (
              <>
                <Field title={t("repositoryURL")}>
                  <input
                    required
                    type="url"
                    value={editor.source ?? ""}
                    onChange={(event) =>
                      setEditor({ ...editor, source: event.target.value })
                    }
                  />
                </Field>
                <div className="ochi-admin-grid2">
                  <Field title={t("branchOrVersion")}>
                    <input
                      value={editor.ref ?? ""}
                      onChange={(event) =>
                        setEditor({ ...editor, ref: event.target.value })
                      }
                    />
                  </Field>
                  <Field title={t("repositoryDirectory")}>
                    <input
                      value={editor.subdir ?? ""}
                      onChange={(event) =>
                        setEditor({ ...editor, subdir: event.target.value })
                      }
                    />
                  </Field>
                </div>
              </>
            ) : sourceType === "bundle" ? (
              <div className="bundle-upload">
                <input
                  ref={uploadInput}
                  type="file"
                  hidden
                  accept=".zip,.tar,.gz,.tgz"
                  onChange={(event) => void upload(event.target.files?.[0])}
                />
                <Upload size={26} />
                <span>{uploadName || editor.source || ""}</span>
                <button
                  type="button"
                  className={`btn secondary${busy === "upload" ? " btn-progress" : ""}`}
                  disabled={busy === "upload"}
                  onClick={() => uploadInput.current?.click()}
                >
                  {busy === "upload" ? t("uploadingEllipsis") : t("chooseArchive")}
                </button>
              </div>
            ) : null}
            {(sourceType === "inline" || editor.id) && (
              <Field title="SKILL.md">
                <textarea
                  className="input mono"
                  rows={13}
                  value={editor.content ?? ""}
                  onChange={(event) =>
                    setEditor({ ...editor, content: event.target.value })
                  }
                  required={sourceType === "inline"}
                />
              </Field>
            )}
            {editor.files?.length ? (
              <details className="advanced-section">
                <summary>
                  {t("files")}<ChevronDown size={14} />
                </summary>
                <div className="skill-files">
                  {editor.files.map((file) => (
                    <div key={file.path}>
                      <Folder size={14} />
                      {file.path}
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
            <Toggle
              title={t("enable")}
              value={editor.enabled ?? true}
              onChange={(enabled) => setEditor({ ...editor, enabled })}
            />
            <ErrorNotice error={error} />
          </form>
        </Modal>
      )}
      {install && (
        <Modal
          className="ochi-admin-modal"
          title={t("installDependenciesNamed", { name: install.name })}
          onClose={() => setInstall(null)}
          size="form"
          footer={
            <div className="modal-actions">
              <button
                type="submit"
                form="skill-install"
                className={`btn primary${busy === "install" ? " btn-progress" : ""}`}
                disabled={busy === "install" || !command.trim()}
              >
                <Terminal size={15} />
                {busy === "install" ? t("installingEllipsis") : t("execute")}</button>
            </div>
          }
        >
          <form
            id="skill-install"
            className="admin-form"
            onSubmit={(event) => {
              event.preventDefault();
              setBusy("install");
              void adminApi
                .installSkill(install.id, command, targetUser)
                .then((value) => {
                  setResult(
                    [value.stdout, value.stderr].filter(Boolean).join("\n") ||
                      t("installationComplete"),
                  );
                })
                .catch((reason: Error) => setError(reason.message))
                .finally(() => setBusy(""));
            }}
          >
            <Field title={t("skillTargetWorkspace")}>
              <SelectField value={targetUser} onChange={setTargetUser}
                options={[{ value: "", label: t("skillCurrentWorkspace") },
                  ...users.map((user) => ({ value: user.id, label: user.username }))]} />
              <p className="field-help">{t("skillPreparationScope")}</p>
            </Field>
            <Field title={t("command")}>
              <textarea
                rows={4}
                className="input mono"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
              />
            </Field>
            {result && <pre className="console-output">{result}</pre>}
            <ErrorNotice error={error} />
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal
          className="ochi-admin-modal"
          title={t("deleteSkillQuestion")}
          onClose={() => setDeleting(null)}
          size="small"
          footer={
            <div className="modal-actions">
              <button
                className="btn secondary"
                onClick={() => setDeleting(null)}
              >
                {t("cancel")}</button>
              <button
                className={`btn danger${busy === "delete" ? " btn-progress" : ""}`}
                disabled={busy === "delete"}
                onClick={() => {
                  setBusy("delete");
                  void adminApi
                    .remove("skills", deleting.id)
                    .then(() => {
                      setDeleting(null);
                      return refresh();
                    })
                    .catch((reason: Error) => setError(reason.message))
                    .finally(() => setBusy(""));
                }}
              >
                {busy === "delete" ? t("deletingEllipsis") : t("delete")}</button>
            </div>
          }
        >
          <p>{deleting.name}</p>
        </Modal>
      )}
    </>
  );
}
export function MCPPage() {
  useAdminI18n();
  const [items, setItems] = useState<MCPServer[]>([]);
  const [editor, setEditor] = useState<Partial<MCPServer> | null>(null);
  const [env, setEnv] = useState<KeyValue[]>([]);
  const [headers, setHeaders] = useState<KeyValue[]>([]);
  const [clearEnv, setClearEnv] = useState<string[]>([]);
  const [clearHeaders, setClearHeaders] = useState<string[]>([]);
  const [args, setArgs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [importing, setImporting] = useState(false);
  const [json, setJson] = useState("");
  const [testTools, setTestTools] = useState<MCPServer | null>(null);
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const [deleting, setDeleting] = useState<MCPServer | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await adminApi.mcp());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  function edit(server?: Partial<MCPServer>) {
    setEditor(
      server
        ? { ...server }
        : {
            name: "",
            enabled: true,
            transport: "stdio",
            command: "",
            url: "",
          },
    );
    setArgs(server?.args ?? []);
    setEnv(keyRows(server?.env_keys, server?.env));
    setHeaders(keyRows(server?.header_keys, server?.headers));
    setClearEnv([]);
    setClearHeaders([]);
    setError("");
  }
  async function save() {
    if (!editor) return;
    setBusy("save");
    try {
      await adminApi.save<MCPServer>(
        "mcp",
        {
          ...editor,
          args,
          env: rowsObject(env),
          headers: rowsObject(headers),
          clear_env: clearEnv,
          clear_headers: clearHeaders,
        },
        Boolean(editor.id),
      );
      setEditor(null);
      setNotice(t("saved"));
      void refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("saveFailed"));
    } finally {
      setBusy("");
    }
  }
  async function test(server: MCPServer) {
    setBusy(server.id);
    setError("");
    try {
      const result = await adminApi.test("mcp", server.id);
      if (!result.ok) throw new Error(result.error ?? t("connectionFailed"));
      setTestTools({ ...server, tools: result.tools });
      setNotice(t("connectedTools", { count: result.tools?.length ?? 0 }));
      void refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("connectionFailed"));
    } finally {
      setBusy("");
    }
  }
  function importJSON() {
    try {
      const parsed = JSON.parse(json);
      const map = parsed.mcpServers ?? parsed;
      const first = Object.entries(map)[0];
      const server = (
        parsed.command || parsed.url ? parsed : first?.[1]
      ) as Partial<MCPServer>;
      if (!server || (!server.command && !server.url))
        throw new Error(t("noMCPConfig"));
      edit({
        ...server,
        name: server.name || first?.[0] || "",
        transport: server.url ? "http" : "stdio",
        enabled: true,
      });
      setEnv(
        Object.entries(server.env ?? {}).map(([key, value]) => ({
          key,
          value,
        })),
      );
      setHeaders(
        Object.entries(server.headers ?? {}).map(([key, value]) => ({
          key,
          value,
        })),
      );
      setImporting(false);
    } catch (reason) {
      setError(
        reason instanceof SyntaxError
          ? t("invalidJSON")
          : reason instanceof Error
            ? reason.message
            : t("importFailed"),
      );
    }
  }
  return (
    <>
      <Card>
        <CardHead title={t("mcpComponents")} desc={t("mcpCardHint", { count: items.length })}
          right={<>
            <button className="btn secondary sm" onClick={() => { setImporting(true); setJson(""); setError(""); }}><Link className="ic" />{t("importJSON")}</button>
            <button className="btn primary sm" onClick={() => edit()}><Plus className="ic" />{t("addMCP")}</button>
          </>} />
        <ErrorNotice error={error} notice={notice} />
        {loading ? (
          <div className="ochi-admin-plist"><SkeletonRows rows={2} /></div>
        ) : items.length ? (
          <div className="ochi-admin-plist">
            {items.map((server) => {
              const tools = (server.tools ?? []) as { name?: string; description?: string; inputSchema?: unknown }[];
              const expanded = Boolean(openRows[server.id]);
              const tone = server.error ? "danger" : server.status === "connected" ? "success" : "";
              return (
                <div className="ochi-admin-prow" key={server.id} data-open={expanded}>
                  <div className="ochi-admin-prow-h">
                    <span className="ochi-admin-tile"><Plug className="ic" /></span>
                    <button type="button" className="ochi-admin-prow-t ochi-admin-rowbtn" onClick={() => edit(server)}>
                      <b>{server.name}</b>
                      <small className="mono">{server.transport === "http" ? server.url : [server.command, ...(server.args ?? [])].join(" ")}</small>
                    </button>
                    <span className="ochi-admin-pcol"><Pill>{server.transport === "http" ? "http" : "stdio"}</Pill></span>
                    <span className="ochi-admin-pcol"><StatusDot tone={tone}>{server.error ? t("connectionFailed") : server.status === "connected" ? t("connected") : t("disabled")}</StatusDot></span>
                    <Disclosure open={expanded} onClick={() => setOpenRows((current) => ({ ...current, [server.id]: !expanded }))}>{t("toolsCount", { count: tools.length })}</Disclosure>
                    <Switch on={server.enabled} label={t("enableNamed", { name: server.name })} busy={busy === server.id}
                      onChange={(enabled) => {
                        setBusy(server.id);
                        void adminApi.save<MCPServer>("mcp", { id: server.id, enabled }, true)
                          .then(() => refresh())
                          .catch((reason: Error) => setError(reason.message))
                          .finally(() => setBusy(""));
                      }} />
                    <ActionMenu trigger={<MoreHorizontal className="ic" />} label={t("mcpActions")} className="icon-btn sm">
                      <MenuAction onClick={() => edit(server)}><Pencil className="ic" />{t("edit")}</MenuAction>
                      <MenuAction onClick={() => void test(server)}><Zap className="ic" />{t("testConnection")}</MenuAction>
                      <MenuAction danger onClick={() => setDeleting(server)}><Trash2 className="ic" />{t("delete")}</MenuAction>
                    </ActionMenu>
                  </div>
                  <Collapse open={expanded}>
                    <div className="ochi-admin-tools">
                      {server.error ? <div className="ochi-admin-alert"><CircleAlert className="ic" /><div>{server.error}</div></div> : null}
                      {tools.length ? tools.map((tool, index) => (
                        <div key={index}>
                          <div className="ochi-admin-tool"><code className="mono">{tool.name}</code><span>{tool.description}</span></div>
                          {tool.inputSchema ? <details className="ochi-admin-schema"><summary>{t("arguments")}</summary><pre className="ochi-admin-code">{JSON.stringify(tool.inputSchema, null, 2)}</pre></details> : null}
                        </div>
                      )) : server.error ? null : <Empty icon={<Wrench className="ic" />} title={t("noTools")} />}
                    </div>
                  </Collapse>
                </div>
              );
            })}
          </div>
        ) : <Empty icon={<Plug className="ic" />} title={t("noMCP")} />}
      </Card>
      {editor && (
        <Modal
          className="ochi-admin-modal"
          title={editor.id ? t("editMCP") : t("addMCP")}
          onClose={() => setEditor(null)}
          size="form"
          footer={
            <div className="modal-actions">
              <button
                type="button"
                className="btn secondary"
                onClick={() => setEditor(null)}
              >
                {t("cancel")}</button>
              <button
                type="submit"
                form="mcp-editor"
                className={`btn primary${busy === "save" ? " btn-progress" : ""}`}
                disabled={busy === "save"}
              >
                {busy === "save" ? t("savingEllipsis") : t("save")}</button>
            </div>
          }
        >
          <form
            id="mcp-editor"
            className="admin-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="ochi-admin-grid2">
              <Field title={t("name")}>
                <input
                  required
                  value={editor.name ?? ""}
                  onChange={(event) =>
                    setEditor({ ...editor, name: event.target.value })
                  }
                />
              </Field>
              <Field title={t("transport")}>
                <SelectField
                  value={editor.transport ?? "stdio"}
                  onChange={(transport) =>
                    setEditor({
                      ...editor,
                      transport: transport as MCPServer["transport"],
                    })
                  }
                  options={[
                    { value: "stdio", label: "Stdio" },
                    { value: "http", label: "HTTP" },
                  ]}
                />
              </Field>
            </div>
            {editor.transport === "http" ? (
              <>
                <Field title="URL">
                  <input
                    type="url"
                    required
                    value={editor.url ?? ""}
                    onChange={(event) =>
                      setEditor({ ...editor, url: event.target.value })
                    }
                  />
                </Field>
                <details className="advanced-section">
                  <summary>{t("requestHeaders")}</summary>
                  <KeyValueEditor
                    rows={headers}
                    onChange={setHeaders}
                    onRemove={(key) =>
                      setClearHeaders((current) => [...current, key])
                    }
                    secret
                  />
                </details>
              </>
            ) : (
              <>
                <Field title={t("command")}>
                  <input
                    required
                    value={editor.command ?? ""}
                    onChange={(event) =>
                      setEditor({ ...editor, command: event.target.value })
                    }
                  />
                </Field>
                <div className="form-field">
                  <span>{t("arguments")}</span>
                  <div className="argument-editor">
                    {args.map((arg, index) => (
                      <div key={index}>
                        <input
                          value={arg}
                          aria-label={t("argumentNumber", { number: index + 1 })}
                          onChange={(event) =>
                            setArgs(
                              args.map((value, i) =>
                                i === index ? event.target.value : value,
                              ),
                            )
                          }
                        />
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={t("deleteArgument")}
                          onClick={() =>
                            setArgs(args.filter((_, i) => i !== index))
                          }
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => setArgs([...args, ""])}
                    >
                      <Plus size={14} />
                      {t("addArgument")}</button>
                  </div>
                </div>
                <details className="advanced-section">
                  <summary>{t("advancedSettings")}</summary>
                  <p className="field-help">{t("stdioRuntimeHint")}</p>
                  <div className="form-field">
                    <span>{t("environmentVariables")}</span>
                    <KeyValueEditor
                      rows={env}
                      onChange={setEnv}
                      onRemove={(key) =>
                        setClearEnv((current) => [...current, key])
                      }
                      secret
                    />
                  </div>
                </details>
              </>
            )}
            <Toggle
              title={t("enable")}
              value={editor.enabled ?? true}
              onChange={(enabled) => setEditor({ ...editor, enabled })}
            />
            <ErrorNotice error={error} />
          </form>
        </Modal>
      )}
      {importing && (
        <Modal
          className="ochi-admin-modal"
          title={t("importMCPJSON")}
          onClose={() => setImporting(false)}
          size="large"
          footer={
            <div className="modal-actions">
              <button
                className="btn primary"
                disabled={!json.trim()}
                onClick={importJSON}
              >
                {t("import")}</button>
            </div>
          }
        >
          <textarea
            className="input input mono"
            rows={13}
            value={json}
            onChange={(event) => setJson(event.target.value)}
          />
          <ErrorNotice error={error} />
        </Modal>
      )}
      {testTools && (
        <Modal
          className="ochi-admin-modal"
          title={t("namedTools", { name: testTools.name })}
          onClose={() => setTestTools(null)}
          size="large"
        >
          <div className="tool-catalog">
            {testTools.tools?.map((tool, index) => {
              const value = tool as {
                name?: string;
                description?: string;
                inputSchema?: unknown;
              };
              return (
                <article key={index}>
                  <strong>{value.name}</strong>
                  <p>{value.description}</p>
                  {value.inputSchema ? (
                    <details className="technical-details">
                      <summary>{t("arguments")}</summary>
                      <pre>{JSON.stringify(value.inputSchema, null, 2)}</pre>
                    </details>
                  ) : null}
                </article>
              );
            })}
            {!testTools.tools?.length && (
              <div className="empty-page">{t("noTools")}</div>
            )}
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal
          className="ochi-admin-modal"
          title={t("deleteMCPQuestion")}
          onClose={() => setDeleting(null)}
          size="small"
          footer={
            <div className="modal-actions">
              <button
                className="btn secondary"
                onClick={() => setDeleting(null)}
              >
                {t("cancel")}</button>
              <button
                className={`btn danger${busy === "delete" ? " btn-progress" : ""}`}
                disabled={busy === "delete"}
                onClick={() => {
                  setBusy("delete");
                  void adminApi
                    .remove("mcp", deleting.id)
                    .then(() => {
                      setDeleting(null);
                      return refresh();
                    })
                    .catch((reason: Error) => setError(reason.message))
                    .finally(() => setBusy(""));
                }}
              >
                {busy === "delete" ? t("deletingEllipsis") : t("delete")}</button>
            </div>
          }
        >
          <p>{deleting.name}</p>
        </Modal>
      )}
    </>
  );
}
