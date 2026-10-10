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
import type { MCPServer, Skill } from "../../lib/types";
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
  const [result, setResult] = useState("");
  const [deleting, setDeleting] = useState<Skill | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await adminApi.skills());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加载失败");
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
      setError(reason instanceof Error ? reason.message : "读取失败");
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
      setNotice("已保存");
      void refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
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
      setError(reason instanceof Error ? reason.message : "上传失败");
    } finally {
      setBusy("");
    }
  }
  async function test(skill: Skill) {
    setBusy(skill.id);
    try {
      const value = await adminApi.test("skills", skill.id);
      if (!value.ok) throw new Error(value.error ?? "检查失败");
      setNotice("检查通过");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "检查失败");
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
      setNotice("已更新");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更新失败");
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <div className="admin-page-heading">
        <h2>Skill 组件</h2>
        <button className="primary-button" onClick={() => void edit()}>
          <Plus size={16} />
          安装 Skill
        </button>
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
                      skill.source === "inline" ? "SKILL.md" : skill.source?.startsWith("http") || skill.source?.startsWith("git") ? "Git" : "压缩包",
                    ].filter(Boolean).join(" · ")}
                  </small>
                </span>
                <p>{skill.description}</p>
              </button>
              <InlineSwitch
                title={`启用 ${skill.name}`}
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
                label="Skill 操作"
              >
                <MenuAction onClick={() => void edit(skill)}>
                  <Pencil size={15} />
                  详情
                </MenuAction>
                <MenuAction onClick={() => void test(skill)}>
                  <Check size={15} />
                  检查
                </MenuAction>
                <MenuAction
                  onClick={() => {
                    setInstall(skill);
                    setCommand("");
                    setResult("");
                  }}
                >
                  <Terminal size={15} />
                  安装依赖
                </MenuAction>
                {(skill.source?.startsWith("http") ||
                  skill.source?.startsWith("git")) && (
                  <MenuAction onClick={() => void update(skill)}>
                    <RefreshCw size={15} />
                    更新
                  </MenuAction>
                )}
                <MenuAction danger onClick={() => setDeleting(skill)}>
                  <Trash2 size={15} />
                  删除
                </MenuAction>
              </ActionMenu>
            </article>
          ))}
          {!items.length && <div className="empty-page">暂无 Skills</div>}
        </div>
      )}
      {editor && (
        <Modal
          className="ochi-admin-modal"
          title={editor.id ? editor.name || "Skill 详情" : "安装 Skill"}
          onClose={() => setEditor(null)}
          size={editor.id || sourceType === "inline" ? "large" : "form"}
          footer={
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setEditor(null)}
              >
                取消
              </button>
              <button
                type="submit"
                form="skill-editor"
                className="primary-button"
                disabled={busy === "save" || busy === "upload"}
              >
                保存
              </button>
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
                { id: "bundle", label: "压缩包", icon: <Upload size={15} /> },
                {
                  id: "inline",
                  label: "直接编写",
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
                <Field title="仓库地址">
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
                  <Field title="分支 / 版本">
                    <input
                      value={editor.ref ?? ""}
                      onChange={(event) =>
                        setEditor({ ...editor, ref: event.target.value })
                      }
                    />
                  </Field>
                  <Field title="仓库目录">
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
                    "选择压缩包"
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
                  文件
                  <ChevronDown size={14} />
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
              title="启用"
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
          title={`安装依赖 · ${install.name}`}
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
                执行
              </button>
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
                .installSkill(install.id, command)
                .then((value) => {
                  setResult(
                    [value.stdout, value.stderr].filter(Boolean).join("\n") ||
                      "安装完成",
                  );
                })
                .catch((reason: Error) => setError(reason.message))
                .finally(() => setBusy(""));
            }}
          >
            <Field title="命令">
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
          title="删除 Skill？"
          onClose={() => setDeleting(null)}
          size="small"
          footer={
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => setDeleting(null)}
              >
                取消
              </button>
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
                删除
              </button>
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
      setError(reason instanceof Error ? reason.message : "加载失败");
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
            cwd: "",
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
      setNotice("已保存");
      void refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setBusy("");
    }
  }
  async function test(server: MCPServer) {
    setBusy(server.id);
    setError("");
    try {
      const result = await adminApi.test("mcp", server.id);
      if (!result.ok) throw new Error(result.error ?? "连接失败");
      setTestTools({ ...server, tools: result.tools });
      setNotice(`已连接 · ${result.tools?.length ?? 0} 个工具`);
      void refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "连接失败");
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
        throw new Error("未找到 MCP 配置");
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
          ? "JSON 格式不正确"
          : reason instanceof Error
            ? reason.message
            : "导入失败",
      );
    }
  }
  return (
    <>
      <div className="admin-page-heading">
        <h2>MCP 组件</h2>
        <div className="toolbar-actions">
          <button
            className="secondary-button"
            onClick={() => {
              setImporting(true);
              setJson("");
              setError("");
            }}
          >
            导入 JSON
          </button>
          <button className="primary-button" onClick={() => edit()}>
            <Plus size={16} />
            添加 MCP
          </button>
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
                    {server.error ? "连接失败" : server.status === "connected" ? `${server.tools?.length ?? 0} 个工具` : server.transport === "http" ? "HTTP" : "Stdio"}
                  </small>
                </span>
                <p className="integration-command">
                  {server.transport === "http"
                    ? server.url
                    : [server.command, ...(server.args ?? [])].join(" ")}
                </p>
              </button>
              <InlineSwitch
                title={`启用 ${server.name}`}
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
                label="MCP 操作"
              >
                <MenuAction onClick={() => edit(server)}>
                  <Pencil size={15} />
                  编辑
                </MenuAction>
                <MenuAction onClick={() => void test(server)}>
                  <Zap size={15} />
                  测试连接
                </MenuAction>
                <MenuAction onClick={() => setTestTools(server)}>
                  <Plug size={15} />
                  工具
                </MenuAction>
                <MenuAction danger onClick={() => setDeleting(server)}>
                  <Trash2 size={15} />
                  删除
                </MenuAction>
              </ActionMenu>
            </article>
          ))}
          {!items.length && <div className="empty-page">暂无 MCP</div>}
        </div>
      )}
      {editor && (
        <Modal
          className="ochi-admin-modal"
          title={editor.id ? "编辑 MCP" : "添加 MCP"}
          onClose={() => setEditor(null)}
          size="form"
          footer={
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setEditor(null)}
              >
                取消
              </button>
              <button
                type="submit"
                form="mcp-editor"
                className="primary-button"
                disabled={busy === "save"}
              >
                保存
              </button>
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
              <Field title="名称">
                <input
                  required
                  value={editor.name ?? ""}
                  onChange={(event) =>
                    setEditor({ ...editor, name: event.target.value })
                  }
                />
              </Field>
              <Field title="连接方式">
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
                  <summary>请求头</summary>
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
                <Field title="命令">
                  <input
                    required
                    value={editor.command ?? ""}
                    onChange={(event) =>
                      setEditor({ ...editor, command: event.target.value })
                    }
                  />
                </Field>
                <div className="form-field">
                  <span>参数</span>
                  <div className="argument-editor">
                    {args.map((arg, index) => (
                      <div key={index}>
                        <input
                          value={arg}
                          aria-label={`参数 ${index + 1}`}
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
                          aria-label="删除参数"
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
                      添加参数
                    </button>
                  </div>
                </div>
                <details className="advanced-section">
                  <summary>高级设置</summary>
                  <Field title="工作目录">
                    <input
                      value={editor.cwd ?? ""}
                      onChange={(event) =>
                        setEditor({ ...editor, cwd: event.target.value })
                      }
                    />
                  </Field>
                  <div className="form-field">
                    <span>环境变量</span>
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
              title="启用"
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
          title="导入 MCP JSON"
          onClose={() => setImporting(false)}
          size="large"
          footer={
            <div className="modal-actions">
              <button
                className="primary-button"
                disabled={!json.trim()}
                onClick={importJSON}
              >
                导入
              </button>
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
          title={`${testTools.name} · 工具`}
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
                      <summary>参数</summary>
                      <pre>{JSON.stringify(value.inputSchema, null, 2)}</pre>
                    </details>
                  ) : null}
                </article>
              );
            })}
            {!testTools.tools?.length && (
              <div className="empty-page">暂无工具</div>
            )}
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal
          className="ochi-admin-modal"
          title="删除 MCP？"
          onClose={() => setDeleting(null)}
          size="small"
          footer={
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => setDeleting(null)}
              >
                取消
              </button>
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
                删除
              </button>
            </div>
          }
        >
          <p>{deleting.name}</p>
        </Modal>
      )}
    </>
  );
}
