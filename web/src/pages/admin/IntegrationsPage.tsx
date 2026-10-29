import { t, useAdminI18n } from "./i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  FileCode2,
  Folder,
  GitBranch,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
  Upload,
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
  InlineSwitch,
  KeyValueEditor,
  keyRows,
  rowsObject,
  Toggle,
  type KeyValue,
} from "./Fields";

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
      <div className="admin-page-heading">
        <h2>{t("skillComponents")}</h2>
        <button className="primary-button" onClick={() => void edit()}>
          <Plus size={16} />
          {t("installSkill")}</button>
      </div>
      <ErrorNotice error={error} notice={notice} />
      {loading ? (
        <div className="panel-loading">
          <LoaderCircle className="spin" size={22} />
        </div>
      ) : (
        <div className="integration-list">
          {items.map((skill) => (
            <article key={skill.id}>
              <span className="integration-icon">
                <FileCode2 size={18} />
              </span>
              <button
                className="integration-main"
                onClick={() => void edit(skill)}
              >
                <span className="integration-name-line">
                  <strong>{skill.name}</strong>
                  <small title={skill.source}>
                    {[
                      skill.version ? `v${skill.version}` : "",
                      skill.source === "inline" ? "SKILL.md" : skill.source?.startsWith("http") || skill.source?.startsWith("git") ? "Git" : t("archive"),
                    ].filter(Boolean).join(" · ")}
                  </small>
                </span>
                <p>{skill.description}</p>
              </button>
              <InlineSwitch
                title={t("enableNamed", { name: skill.name })}
                value={skill.enabled}
                updating={busy === skill.id}
                onChange={(enabled) => {
                  setBusy(skill.id);
                  void adminApi
                    .save<Skill>(
                      "skills",
                      { id: skill.id, enabled },
                      true,
                    )
                    .then(() => refresh())
                    .catch((reason: Error) => setError(reason.message))
                    .finally(() => setBusy(""));
                }}
              />
              <ActionMenu
                trigger={<MoreHorizontal size={18} />}
                label={t("skillActions")}
              >
                <MenuAction onClick={() => void edit(skill)}>
                  <Pencil size={15} />
                  {t("details")}</MenuAction>
                <MenuAction onClick={() => void test(skill)}>
                  <Check size={15} />
                  {t("validate")}</MenuAction>
                <MenuAction
                  onClick={() => {
                    setInstall(skill);
                    setCommand("");
                    setResult("");
                  }}
                >
                  <Terminal size={15} />
                  {t("installDependencies")}</MenuAction>
                {(skill.source?.startsWith("http") ||
                  skill.source?.startsWith("git")) && (
                  <MenuAction onClick={() => void update(skill)}>
                    <RefreshCw size={15} />
                    {t("update")}</MenuAction>
                )}
                <MenuAction danger onClick={() => setDeleting(skill)}>
                  <Trash2 size={15} />
                  {t("delete")}</MenuAction>
              </ActionMenu>
            </article>
          ))}
          {!items.length && <div className="empty-page">{t("noSkills")}</div>}
        </div>
      )}
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
                className="secondary-button"
                onClick={() => setEditor(null)}
              >
                {t("cancel")}</button>
              <button
                type="submit"
                form="skill-editor"
                className="primary-button"
                disabled={busy === "save" || busy === "upload"}
              >
                {t("save")}</button>
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
                <div className="form-grid">
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
                  className="secondary-button"
                  disabled={busy === "upload"}
                  onClick={() => uploadInput.current?.click()}
                >
                  {busy === "upload" ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    t("chooseArchive")
                  )}
                </button>
              </div>
            ) : null}
            {(sourceType === "inline" || editor.id) && (
              <Field title="SKILL.md">
                <textarea
                  className="code-input"
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
                className="primary-button"
                disabled={busy === "install" || !command.trim()}
              >
                {busy === "install" ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <Terminal size={15} />
                )}
                {t("execute")}</button>
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
                className="code-input"
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
                className="secondary-button"
                onClick={() => setDeleting(null)}
              >
                {t("cancel")}</button>
              <button
                className="danger-button"
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
                {t("delete")}</button>
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
      <div className="admin-page-heading">
        <h2>{t("mcpComponents")}</h2>
        <div className="toolbar-actions">
          <button
            className="secondary-button"
            onClick={() => {
              setImporting(true);
              setJson("");
              setError("");
            }}
          >
            {t("importJSON")}</button>
          <button className="primary-button" onClick={() => edit()}>
            <Plus size={16} />
            {t("addMCP")}</button>
        </div>
      </div>
      <ErrorNotice error={error} notice={notice} />
      {loading ? (
        <div className="panel-loading">
          <LoaderCircle className="spin" size={22} />
        </div>
      ) : (
        <div className="integration-list">
          {items.map((server) => (
            <article key={server.id}>
              <span className="integration-icon">
                <Plug size={18} />
              </span>
              <button className="integration-main" onClick={() => edit(server)}>
                <span className="integration-name-line">
                  <strong>{server.name}</strong>
                  <small className={server.error ? "danger" : ""} title={server.error || undefined}>
                    {server.error ? t("connectionFailed") : server.status === "connected" ? t("toolsCount", { count: server.tools?.length ?? 0 }) : server.transport === "http" ? "HTTP" : "Stdio"}
                  </small>
                </span>
                <p className="integration-command">
                  {server.transport === "http"
                    ? server.url
                    : [server.command, ...(server.args ?? [])].join(" ")}
                </p>
              </button>
              <InlineSwitch
                title={t("enableNamed", { name: server.name })}
                value={server.enabled}
                updating={busy === server.id}
                onChange={(enabled) => {
                  setBusy(server.id);
                  void adminApi
                    .save<MCPServer>(
                      "mcp",
                      { id: server.id, enabled },
                      true,
                    )
                    .then(() => refresh())
                    .catch((reason: Error) => setError(reason.message))
                    .finally(() => setBusy(""));
                }}
              />
              <ActionMenu
                trigger={<MoreHorizontal size={18} />}
                label={t("mcpActions")}
              >
                <MenuAction onClick={() => edit(server)}>
                  <Pencil size={15} />
                  {t("edit")}</MenuAction>
                <MenuAction onClick={() => void test(server)}>
                  <Zap size={15} />
                  {t("testConnection")}</MenuAction>
                <MenuAction onClick={() => setTestTools(server)}>
                  <Plug size={15} />
                  {t("tools")}</MenuAction>
                <MenuAction danger onClick={() => setDeleting(server)}>
                  <Trash2 size={15} />
                  {t("delete")}</MenuAction>
              </ActionMenu>
            </article>
          ))}
          {!items.length && <div className="empty-page">{t("noMCP")}</div>}
        </div>
      )}
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
                className="secondary-button"
                onClick={() => setEditor(null)}
              >
                {t("cancel")}</button>
              <button
                type="submit"
                form="mcp-editor"
                className="primary-button"
                disabled={busy === "save"}
              >
                {t("save")}</button>
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
            <div className="form-grid">
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
                          className="icon-button"
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
                      className="text-button"
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
                className="primary-button"
                disabled={!json.trim()}
                onClick={importJSON}
              >
                {t("import")}</button>
            </div>
          }
        >
          <textarea
            className="field-input code-input"
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
                className="secondary-button"
                onClick={() => setDeleting(null)}
              >
                {t("cancel")}</button>
              <button
                className="danger-button"
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
                {t("delete")}</button>
            </div>
          }
        >
          <p>{deleting.name}</p>
        </Modal>
      )}
    </>
  );
}
