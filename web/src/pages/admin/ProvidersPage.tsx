import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronRight,
  Cpu,
  Database,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Zap,
  Image,
  ImagePlus,
  Wrench,
  Brain,
} from "lucide-react";
import { adminApi } from "../../lib/api";
import type { CatalogModel, Model, Provider } from "../../lib/types";
import { Modal } from "../../components/Modal";
import { BrandIcon } from "../../components/BrandIcon";
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

type ProviderDraft = Partial<Provider> & {
  api_key?: string;
  api_key_action?: string;
};
function modelDraft(providerId: string): Model {
  return {
    id: "",
    provider_id: providerId,
    name: "",
    model: "",
    enabled: false,
    is_default: false,
    context_window: 0,
    supports_tools: true,
    supports_vision: false,
    metadata_known: {},
    efforts: [],
    default_effort: "",
    effort_parameter: "",
    effort_mapping: {},
    reasoning_kind: "unknown",
    source: "custom",
  };
}
export default function ProvidersPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [providerEditor, setProviderEditor] = useState<ProviderDraft | null>(
    null,
  );
  const [headers, setHeaders] = useState<KeyValue[]>([]);
  const [clearHeaders, setClearHeaders] = useState<string[]>([]);
  const [modelEditor, setModelEditor] = useState<Model | null>(null);
  const [modelOriginal, setModelOriginal] = useState<Model | null>(null);
  const [modelTouched, setModelTouched] = useState(false);
  const [matching, setMatching] = useState(false);
  const [matchStatus, setMatchStatus] = useState("");
  const [modelSection, setModelSection] = useState("basic");
  const [effortsText, setEffortsText] = useState("");
  const [mappingText, setMappingText] = useState("{}");
  const [deleting, setDeleting] = useState<{
    kind: string;
    id: string;
    name: string;
  } | null>(null);
  const [catalogFor, setCatalogFor] = useState<Model | null>(null);
  const [catalogProviders, setCatalogProviders] = useState<
    { id: string; name: string }[]
  >([]);
  const [catalogProvider, setCatalogProvider] = useState("");
  const [catalogModels, setCatalogModels] = useState<CatalogModel[]>([]);
  const [catalogQuery, setCatalogQuery] = useState("");
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, available] = await Promise.all([
        adminApi.providers(),
        adminApi.models(),
      ]);
      setProviders(list ?? []);
      setModels(available ?? []);
      setSelected((current) =>
        list.some((item) => item.id === current)
          ? current
          : (list[0]?.id ?? ""),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const provider = providers.find((item) => item.id === selected);
  const filtered = useMemo(
    () =>
      models.filter(
        (model) =>
          model.provider_id === selected &&
          (!onlyEnabled || model.enabled) &&
          `${model.name} ${model.model}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [models, selected, query, onlyEnabled],
  );
  function editProvider(value?: Provider) {
    setHeaders(
      keyRows(value?.header_names ?? Object.keys(value?.headers ?? {})),
    );
    setClearHeaders([]);
    setProviderEditor(
      value
        ? { ...value, api_key_action: "keep", api_key: "" }
        : {
            name: "",
            base_url: "",
            enabled: true,
            protocol: "openai",
            timeout_seconds: 480,
            discover_models: true,
            allow_no_key: false,
            api_key_action: "replace",
            api_key: "",
          },
    );
  }
  function editModel(value?: Model) {
    const next = value ?? modelDraft(selected);
    setModelEditor({ ...next });
    setModelOriginal({ ...next });
    setModelTouched(false);
    setMatchStatus("");
    setModelSection("basic");
    setEffortsText(next.efforts?.join(", ") ?? "");
    setMappingText(JSON.stringify(next.effort_mapping ?? {}, null, 2));
  }
  async function saveProvider() {
    if (!providerEditor) return;
    setBusy("save-provider");
    setError("");
    try {
      const saved = await adminApi.save<Provider>(
        "providers",
        {
          id: providerEditor.id,
          name: providerEditor.name,
          base_url: providerEditor.base_url,
          protocol: providerEditor.protocol,
          enabled: providerEditor.enabled,
          timeout_seconds: providerEditor.timeout_seconds,
          discover_models: providerEditor.discover_models,
          allow_no_key: providerEditor.allow_no_key,
          catalog_provider_id: providerEditor.catalog_provider_id,
          api_key: providerEditor.api_key,
          api_key_action: providerEditor.api_key_action,
          headers: rowsObject(headers),
          clear_headers: clearHeaders,
        },
        Boolean(providerEditor.id),
      );
      setProviderEditor(null);
      await refresh();
      setSelected(saved.id);
      setNotice(saved.sync_error ? `已保存 · ${saved.sync_error}` : saved.imported ? `已保存 · ${saved.imported} 个模型` : "已保存");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setBusy("");
    }
  }
  async function saveModel() {
    if (!modelEditor) return;
    if (!modelEditor.name.trim() || !modelEditor.model.trim()) {
      setModelSection("basic");
      return;
    }
    setBusy("save-model");
    setError("");
    try {
      const configurable = ["effort", "toggle", "budget"].includes(
        modelEditor.reasoning_kind ?? "unknown",
      );
      const value: Model = {
        ...modelEditor,
        is_default:
          modelEditor.kind && modelEditor.kind !== "chat" ? false : modelEditor.is_default,
        efforts:
          configurable && modelEditor.reasoning_kind !== "budget"
            ? effortsText
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean)
            : [],
        default_effort:
          configurable && modelEditor.reasoning_kind !== "budget"
            ? modelEditor.default_effort
            : "",
        effort_parameter: configurable ? modelEditor.effort_parameter : "",
        effort_mapping: configurable ? JSON.parse(mappingText || "{}") : {},
      };
      const fields: (keyof Model)[] = ["provider_id", "name", "model", "kind", "enabled", "is_default", "context_window", "max_output_tokens", "supports_tools", "supports_vision", "supports_image_generation", "image_config", "structured_output", "reasoning_kind", "efforts", "default_effort", "effort_parameter", "effort_mapping", "reasoning_budget_min", "reasoning_budget_max", "reasoning_budget_default"];
      const payload: Record<string, unknown> = { id: value.id };
      for (const field of fields) {
        if (!value.id && ["provider_id", "name", "model", "kind", "enabled", "is_default"].includes(field)) {
          payload[field] = value[field];
          continue;
        }
        if (modelOriginal && JSON.stringify(value[field]) === JSON.stringify(modelOriginal[field])) continue;
        payload[field] = value[field];
      }
      await adminApi.save<Model>("models", payload, Boolean(value.id));
      setModelEditor(null);
      await refresh();
      setNotice("已保存");
    } catch (reason) {
      setError(
        reason instanceof SyntaxError
          ? "参数映射格式不正确"
          : reason instanceof Error
            ? reason.message
            : "保存失败",
      );
    } finally {
      setBusy("");
    }
  }
  async function test(kind: "providers" | "models", id: string, options = {}) {
    setBusy(id);
    setError("");
    setNotice("");
    try {
      const value = await adminApi.test(kind, id, options);
      if (!value.ok) throw new Error(value.error ?? "连接失败");
      setNotice(
        kind === "providers"
          ? `连接成功${value.models ? ` · ${value.models.length} 个模型` : ""}`
          : `模型可用${value.parameter_accepted ? " · 参数已接受" : ""}`,
      );
      if (kind === "models") await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "测试失败");
    } finally {
      setBusy("");
    }
  }
  async function sync() {
    if (!provider) return;
    setBusy("sync");
    setError("");
    try {
      const result = await adminApi.syncProvider(provider.id);
      await refresh();
      setNotice(
        `已同步 · ${result.imported} 个新增模型${result.unavailable ? ` · ${result.unavailable} 个不可用` : ""}`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "同步失败");
    } finally {
      setBusy("");
    }
  }
  async function refreshMetadata() {
    if (!provider) return;
    setBusy("metadata");
    setError("");
    try {
      const result = await adminApi.refreshMetadata(provider.id);
      await refresh();
      setNotice(`已匹配 ${result.matched} 个模型${result.unmatched ? ` · ${result.unmatched} 个未收录` : ""}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "匹配失败");
    } finally {
      setBusy("");
    }
  }
  async function autoMatchModel() {
    if (!modelEditor) return;
    setMatching(true);
    setError("");
    try {
      if (modelEditor.id) {
        const value = await adminApi.autoMatchModel(modelEditor.id);
        editModel(value);
        await refresh();
      } else {
        const value = await adminApi.resolveMetadata(selected, modelEditor.model);
        if (!value.matched || !value.model) throw new Error("目录中未找到此模型");
        const next = { ...modelEditor, ...value.model, id: "", provider_id: selected, model: modelEditor.model, enabled: modelEditor.enabled, is_default: modelEditor.is_default };
        setModelEditor(next);
        setModelOriginal(next);
        setEffortsText(value.model.efforts?.join(", ") ?? "");
        setMappingText(JSON.stringify(value.model.effort_mapping ?? {}, null, 2));
      }
      setMatchStatus("models.dev");
      setModelTouched(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "匹配失败");
    } finally {
      setMatching(false);
    }
  }
  useEffect(() => {
    if (!modelEditor || modelEditor.id || !modelEditor.model.trim()) return;
    let disposed = false;
    const timer = setTimeout(() => {
      setMatching(true);
      void adminApi.resolveMetadata(selected, modelEditor.model).then((value) => {
        if (disposed) return;
        setMatchStatus(value.matched ? "models.dev" : "未收录");
        if (!value.model || modelTouched) return;
        const next = { ...modelEditor, ...value.model, id: "", provider_id: selected, model: modelEditor.model, enabled: modelEditor.enabled, is_default: modelEditor.is_default };
        setModelEditor((current) => current ? { ...current, ...next, name: current.name && current.name !== current.model ? current.name : value.model!.name } : current);
        setModelOriginal(next);
        setEffortsText(value.model.efforts?.join(", ") ?? "");
        setMappingText(JSON.stringify(value.model.effort_mapping ?? {}, null, 2));
      }).catch(() => { if (!disposed) setMatchStatus("目录暂不可用"); }).finally(() => { if (!disposed) setMatching(false); });
    }, 500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [modelEditor?.id, modelEditor?.model, selected, modelTouched]);
  async function publish(model: Model, enabled: boolean) {
    setBusy(model.id);
    try {
      const value = await adminApi.save<Model>(
        "models",
        { id: model.id, enabled, ...(enabled ? {} : { is_default: false }) },
        true,
      );
      setModels((current) =>
        current.map((item) => (item.id === model.id ? value : item)),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setBusy("");
    }
  }
  async function openCatalog(model: Model) {
    setCatalogFor(model);
    setCatalogModels([]);
    setCatalogQuery("");
    setCatalogProvider(
      model.catalog_provider_id ?? provider?.catalog_provider_id ?? "",
    );
    try {
      setCatalogProviders(await adminApi.catalogProviders());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "目录加载失败");
    }
  }
  useEffect(() => {
    if (!catalogFor || !catalogProvider) return;
    let disposed = false;
    const timer = setTimeout(
      () =>
        void adminApi
          .catalogModels(catalogProvider, catalogQuery)
          .then((list) => {
            if (!disposed) setCatalogModels(list ?? []);
          })
          .catch((reason: Error) => {
            if (!disposed) setError(reason.message);
          }),
      250,
    );
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [catalogFor, catalogProvider, catalogQuery]);
  return (
    <>
      <div className="admin-page-heading">
        <h2>模型服务</h2>
        <button className="primary-button" onClick={() => editProvider()}>
          <Plus size={16} />
          添加 Provider
        </button>
      </div>
      <ErrorNotice error={error} notice={notice} />
      {loading && !providers.length ? (
        <div className="panel-loading">
          <LoaderCircle className="spin" size={22} />
        </div>
      ) : (
        <div className="provider-layout">
          <nav className="provider-rail">
            {providers.map((item) => (
              <button
                className={selected === item.id ? "selected" : ""}
                key={item.id}
                title={item.name}
                onClick={() => {
                  setSelected(item.id);
                  setError("");
                  setNotice("");
                }}
              >
                <span className="provider-avatar">
                  <BrandIcon src={item.icon} size={21} />
                </span>
                <span>
                  <span>{item.name}</span>
                  <small>
                    {
                      models.filter(
                        (model) =>
                          model.provider_id === item.id && model.enabled,
                      ).length
                    }{" "}
                    个启用
                  </small>
                </span>
                {!item.enabled && <span className="connection-dot" />}
                <ChevronRight size={14} />
              </button>
            ))}
            {!providers.length && <div className="empty-page">暂无服务</div>}
          </nav>
          {provider && (
            <section className="provider-detail">
              <header className="provider-heading">
                <div>
                  <h3>{provider.name}</h3>
                  <a href={provider.base_url} target="_blank" rel="noreferrer">
                    {provider.base_url}
                  </a>
                </div>
                <div className="toolbar-actions">
                  <button
                    className="secondary-button provider-settings-action"
                    aria-label="编辑服务"
                    title="编辑服务"
                    onClick={() => editProvider(provider)}
                  >
                    <Settings2 size={16} />
                    <span>设置</span>
                  </button>
                  <button className="icon-button" title="测试连接" aria-label="测试服务连接"
                    disabled={busy === provider.id} onClick={() => void test("providers", provider.id)}>
                    <Zap size={16} />
                  </button>
                  <ActionMenu
                    trigger={<MoreHorizontal size={19} />}
                    label="服务操作"
                  >
                    <MenuAction
                      onClick={() => void test("providers", provider.id)}
                    >
                      <Zap size={15} />
                      测试连接
                    </MenuAction>
                    <MenuAction
                      danger
                      onClick={() =>
                        setDeleting({
                          kind: "providers",
                          id: provider.id,
                          name: provider.name,
                        })
                      }
                    >
                      <Trash2 size={15} />
                      删除服务
                    </MenuAction>
                  </ActionMenu>
                </div>
              </header>
              <div className="provider-overview">
                <span className={`admin-state${provider.enabled ? " is-enabled" : ""}`}>
                  <i />{provider.enabled ? "已启用" : "已停用"}
                </span>
                <span>{provider.protocol === "openai-responses" ? "Responses" : "Chat Completions"}</span>
                <span>{provider.has_api_key ? "Key 已配置" : "无 Key"}</span>
              </div>
              <div className="model-list-toolbar">
                <div className="search-input">
                  <Search size={16} />
                  <input
                    placeholder="搜索模型"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                <label className="filter-check">
                  <input
                    type="checkbox"
                    checked={onlyEnabled}
                    onChange={(event) => setOnlyEnabled(event.target.checked)}
                  />
                  已启用
                </label>
                <button
                  className="secondary-button"
                  disabled={
                    busy === "sync" || provider.discover_models === false
                  }
                  onClick={() => void sync()}
                >
                  <RefreshCw
                    className={busy === "sync" ? "spin" : ""}
                    size={15}
                  />
                  同步
                </button>
                <button
                  className="icon-button"
                  aria-label="更新模型元数据"
                  title="更新元数据"
                  disabled={busy === "metadata"}
                  onClick={() => void refreshMetadata()}
                >
                  <Database size={16} className={busy === "metadata" ? "spin" : ""} />
                </button>
                <button
                  className="icon-button"
                  aria-label="自定义模型"
                  title="自定义模型"
                  onClick={() => editModel()}
                >
                  <Plus size={18} />
                </button>
              </div>
              <div className="provider-models">
                {filtered.map((model) => (
                  <article key={model.id}>
                    <button
                      className="model-row-main"
                      aria-label={model.name || model.model}
                      onClick={() => editModel(model)}
                    >
                      <span className="model-kind-icon">
                        {(model as Model & { kind?: string }).kind ===
                        "embedding" ? (
                          <Database size={18} />
                        ) : model.kind === "image" ? (
                          <ImagePlus size={18} />
                        ) : (
                          <BrandIcon src={model.icon} size={20} />
                        )}
                      </span>
                      <div>
                        <span className="model-name-line">
                          <strong>{model.name || model.model}</strong>
                          {model.is_default && <span className="model-default">默认</span>}
                        </span>
                        {model.name && model.name !== model.model && (
                          <small>{model.model}</small>
                        )}
                        {model.available === false && (
                          <small className="danger">远端不可用</small>
                        )}
                        <span className="model-row-meta">
                          {model.context_window > 0 && <span className="model-context">{Math.round(model.context_window / 1000)}k 上下文</span>}
                          <span className="model-capability-icons">
                            {model.supports_image_generation && <span title="图像生成"><ImagePlus size={14} /></span>}
                            {model.metadata_known?.supports_vision && model.supports_vision && <span title="图像理解"><Image size={14} /></span>}
                            {model.metadata_known?.supports_tools && model.supports_tools && <span title="工具调用"><Wrench size={14} /></span>}
                            {model.reasoning_kind && !["none", "unknown"].includes(model.reasoning_kind) && <span title={model.efforts?.length ? model.efforts.join(", ") : "思考"}><Brain size={14} /></span>}
                          </span>
                        </span>
                      </div>
                    </button>
                    <InlineSwitch title={`启用 ${model.name}`} value={model.enabled}
                      updating={busy === model.id} onChange={(enabled) => void publish(model, enabled)} />
                    <ActionMenu
                      trigger={<MoreHorizontal size={18} />}
                      label="模型操作"
                    >
                      <MenuAction onClick={() => editModel(model)}>
                        <Settings2 size={15} />
                        编辑能力
                      </MenuAction>
                      <MenuAction onClick={() => void openCatalog(model)}>
                        <Database size={15} />
                        参考目录
                      </MenuAction>
                      <MenuAction onClick={() => {
                        setBusy(model.id);
                        void adminApi.autoMatchModel(model.id).then(() => refresh()).then(() => setNotice("已自动匹配")).catch((reason: Error) => setError(reason.message)).finally(() => setBusy(""));
                      }}>
                        <RefreshCw size={15} />
                        自动匹配
                      </MenuAction>
                      <MenuAction
                        onClick={() =>
                          void test(
                            "models",
                            model.id,
                            model.default_effort
                              ? { effort: model.default_effort }
                              : {},
                          )
                        }
                      >
                        <Zap size={15} />
                        测试模型
                      </MenuAction>
                      <MenuAction
                        danger
                        onClick={() =>
                          setDeleting({
                            kind: "models",
                            id: model.id,
                            name: model.name,
                          })
                        }
                      >
                        <Trash2 size={15} />
                        删除
                      </MenuAction>
                    </ActionMenu>
                  </article>
                ))}
                {!filtered.length && <div className="empty-page">暂无模型</div>}
              </div>
            </section>
          )}
        </div>
      )}
      {providerEditor && (
        <Modal
          className="ochi-admin-modal"
          title={providerEditor.id ? "编辑 Provider" : "添加 Provider"}
          onClose={() => setProviderEditor(null)}
          size="form"
          footer={
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setProviderEditor(null)}
              >
                取消
              </button>
              <button
                type="submit"
                form="provider-editor"
                className="primary-button"
                disabled={busy === "save-provider"}
              >
                保存
              </button>
            </div>
          }
        >
          <form
            id="provider-editor"
            className="admin-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveProvider();
            }}
          >
            <Field title="名称">
              <input
                required
                autoFocus
                value={providerEditor.name ?? ""}
                onChange={(event) =>
                  setProviderEditor({
                    ...providerEditor,
                    name: event.target.value,
                  })
                }
              />
            </Field>
            <Field title="协议">
              <SelectField
                label="Provider 协议"
                value={providerEditor.protocol ?? "openai"}
                options={[
                  { value: "openai", label: "OpenAI · Chat Completions" },
                  { value: "openai-responses", label: "OpenAI · Responses" },
                ]}
                onChange={(protocol) => setProviderEditor({ ...providerEditor, protocol })}
              />
            </Field>
            <Field title="Base URL">
              <input
                required
                type="url"
                placeholder="https://example.com/v1"
                value={providerEditor.base_url ?? ""}
                onChange={(event) =>
                  setProviderEditor({
                    ...providerEditor,
                    base_url: event.target.value,
                  })
                }
              />
            </Field>
            <div className={providerEditor.id ? "form-grid" : ""}>
              <Field title="API Key">
                {providerEditor.id ? (
                  <SelectField
                    value={providerEditor.api_key_action ?? "keep"}
                    onChange={(api_key_action) =>
                      setProviderEditor({ ...providerEditor, api_key_action })
                    }
                    options={[
                      ...(providerEditor.id
                        ? [{ value: "keep", label: "保留当前密钥" }]
                        : []),
                      { value: "replace", label: "设置新密钥" },
                      { value: "delete", label: "删除密钥" },
                    ]}
                  />
                ) : (
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={providerEditor.api_key ?? ""}
                    required={!providerEditor.allow_no_key}
                    onChange={(event) =>
                      setProviderEditor({
                        ...providerEditor,
                        api_key: event.target.value,
                        api_key_action: event.target.value
                          ? "replace"
                          : providerEditor.allow_no_key
                            ? "delete"
                            : "replace",
                      })
                    }
                  />
                )}
              </Field>
              {providerEditor.id &&
                providerEditor.api_key_action === "replace" && (
                  <Field title="新密钥">
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={providerEditor.api_key ?? ""}
                      required={!providerEditor.allow_no_key}
                      onChange={(event) =>
                        setProviderEditor({
                          ...providerEditor,
                          api_key: event.target.value,
                        })
                      }
                    />
                  </Field>
                )}
            </div>
            <Toggle
              title="启用"
              value={providerEditor.enabled ?? true}
              onChange={(enabled) =>
                setProviderEditor({ ...providerEditor, enabled })
              }
            />
            <details className="advanced-section">
              <summary>高级设置</summary>
              <Field title="超时（秒）">
                <input
                  type="number"
                  min={10}
                  value={providerEditor.timeout_seconds ?? 480}
                  onChange={(event) =>
                    setProviderEditor({
                      ...providerEditor,
                      timeout_seconds: Number(event.target.value),
                    })
                  }
                />
              </Field>
              <Field title="目录 Provider ID">
                <input
                  value={providerEditor.catalog_provider_id ?? ""}
                  onChange={(event) =>
                    setProviderEditor({
                      ...providerEditor,
                      catalog_provider_id: event.target.value,
                    })
                  }
                />
              </Field>
              <Toggle
                title="发现远端模型"
                value={providerEditor.discover_models ?? true}
                onChange={(discover_models) =>
                  setProviderEditor({ ...providerEditor, discover_models })
                }
              />
              <Toggle
                title="允许无密钥"
                value={providerEditor.allow_no_key ?? false}
                onChange={(allow_no_key) =>
                  setProviderEditor({
                    ...providerEditor,
                    allow_no_key,
                    ...(!providerEditor.id &&
                    allow_no_key &&
                    !providerEditor.api_key
                      ? { api_key_action: "delete" }
                      : {}),
                  })
                }
              />
              <div className="form-field">
                <span>请求头</span>
                <KeyValueEditor
                  rows={headers}
                  onChange={setHeaders}
                  secret
                  onRemove={(key) =>
                    setClearHeaders((current) => [...current, key])
                  }
                />
              </div>
            </details>
            <ErrorNotice error={error} />
          </form>
        </Modal>
      )}
      {modelEditor && !catalogFor && (
        <Modal
          className="ochi-admin-modal"
          title={modelEditor.id ? "模型能力" : "自定义模型"}
          onClose={() => setModelEditor(null)}
          size="large"
          footer={
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setModelEditor(null)}
              >
                取消
              </button>
              <button
                type="submit"
                form="model-editor"
                className="primary-button"
                disabled={
                  busy === "save-model" ||
                  !modelEditor.name.trim() ||
                  !modelEditor.model.trim()
                }
              >
                保存
              </button>
            </div>
          }
        >
          <form
            id="model-editor"
            className="admin-form model-editor-form"
            onChangeCapture={(event) => {
              const target = event.target;
              if (!(target instanceof HTMLInputElement) || !["model-name", "model-id"].includes(target.name)) setModelTouched(true);
            }}
            onSubmit={(event) => {
              event.preventDefault();
              void saveModel();
            }}
          >
            <div className="segmented-control" aria-label="模型配置分类">
              {[
                { id: "basic", label: "基础" },
                ...(modelEditor.kind === "image" ? [{ id: "image", label: "生图" }] : modelEditor.kind !== "embedding" ? [{ id: "reasoning", label: "思考" }] : []),
                { id: "metadata", label: "元数据" },
              ].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={modelSection === item.id ? "selected" : ""}
                  aria-pressed={modelSection === item.id}
                  onClick={() => setModelSection(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="metadata-preview">
              <BrandIcon src={modelEditor.icon} size={17} />
              <span>{matching ? "匹配中" : matchStatus || modelEditor.metadata_source || "未匹配"}</span>
              {modelEditor.catalog_provider_id && <span>{modelEditor.catalog_provider_id}/{modelEditor.catalog_model_id}</span>}
              {modelEditor.metadata_overrides && Object.keys(modelEditor.metadata_overrides).length > 0 && <span>手动覆盖 {Object.keys(modelEditor.metadata_overrides).length}</span>}
            </div>
            <div className="toolbar-actions">
              <button
                type="button"
                className="text-button"
                disabled={matching || !modelEditor.model.trim()}
                onClick={() => void autoMatchModel()}
              >
                <RefreshCw size={14} className={matching ? "spin" : ""} />
                自动匹配
              </button>
              {modelEditor.id && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void openCatalog(modelEditor)}
                >
                  <Database size={14} />
                  参考目录
                </button>
              )}
            </div>
            {modelSection === "basic" ? (
              <section className="model-editor-section">
                <div className="form-grid">
                  <Field title="显示名称">
                    <input
                      required
                      name="model-name"
                      value={modelEditor.name}
                      onChange={(event) =>
                        setModelEditor({
                          ...modelEditor,
                          name: event.target.value,
                        })
                      }
                    />
                  </Field>
                  <Field title="模型 ID">
                    <input
                      required
                      name="model-id"
                      value={modelEditor.model}
                      onChange={(event) =>
                        (setModelTouched(false), setMatchStatus(""), setModelEditor({
                          ...modelEditor,
                          model: event.target.value,
                        }))
                      }
                    />
                  </Field>
                </div>
                <div className="form-grid">
                  <Field title="类型">
                    <SelectField
                      value={
                        (modelEditor as Model & { kind?: string }).kind ??
                        "chat"
                      }
                      onChange={(kind) => setModelEditor({
                        ...modelEditor,
                        kind,
                        ...(kind === "image" ? { supports_image_generation: true, is_default: false } : {}),
                        ...(kind === "embedding" ? { is_default: false } : {}),
                      } as Model)}
                      options={[
                        { value: "chat", label: "聊天模型" },
                        { value: "image", label: "生图模型" },
                        { value: "embedding", label: "Embedding" },
                      ]}
                    />
                  </Field>
                  <Toggle
                    title="启用"
                    value={modelEditor.enabled}
                    onChange={(enabled) =>
                      setModelEditor({ ...modelEditor, enabled })
                    }
                  />
                </div>
                {modelEditor.kind !== "image" && <div className="form-grid">
                  <Field title="上下文长度">
                    <input
                      type="number"
                      min={0}
                      value={modelEditor.context_window ?? 0}
                      onChange={(event) =>
                        setModelEditor({
                          ...modelEditor,
                          context_window: Number(event.target.value),
                        })
                      }
                    />
                  </Field>
                  {modelEditor.kind !== "embedding" && <Field title="最大输出（0 = 自动）">
                    <input
                      type="number"
                      min={0}
                      title="目录值是模型能力上限。未手动覆盖时，常规自动预算取 65,536 tokens 与上下文四分之一的较小值；选择思考 token 预算时至少预留预算加 1,024 tokens，再受模型上限约束。输出上限包含思考与正文。"
                      value={modelEditor.max_output_tokens ?? 0}
                      onChange={(event) =>
                        setModelEditor({
                          ...modelEditor,
                          max_output_tokens: Number(event.target.value),
                        })
                      }
                    />
                  </Field>}
                </div>}
                <div className="form-grid">
                  {modelEditor.kind !== "image" && modelEditor.kind !== "embedding" && <Toggle
                    title={modelEditor.metadata_known?.supports_tools ? "工具调用" : "工具调用 · 未确认"}
                    value={modelEditor.supports_tools}
                    onChange={(supports_tools) =>
                      setModelEditor({ ...modelEditor, supports_tools })
                    }
                  />}
                  {modelEditor.kind !== "image" && modelEditor.kind !== "embedding" && <Toggle
                    title={modelEditor.metadata_known?.supports_vision ? "图像理解" : "图像理解 · 未确认"}
                    value={modelEditor.supports_vision}
                    onChange={(supports_vision) =>
                      setModelEditor({ ...modelEditor, supports_vision })
                    }
                  />}
                  {modelEditor.kind !== "image" && modelEditor.kind !== "embedding" && <Toggle
                    title={modelEditor.metadata_known?.structured_output ? "结构化输出" : "结构化输出 · 未确认"}
                    value={modelEditor.structured_output ?? false}
                    onChange={(structured_output) =>
                      setModelEditor({ ...modelEditor, structured_output })
                    }
                  />}
                  {modelEditor.kind !== "image" && modelEditor.kind !== "embedding" && <Toggle
                    title="默认模型"
                    value={modelEditor.is_default}
                    onChange={(is_default) =>
                      setModelEditor({
                        ...modelEditor,
                        is_default,
                        enabled: is_default || modelEditor.enabled,
                      })
                    }
                  />}
                </div>
              </section>
            ) : modelSection === "image" ? (
              <section className="model-editor-section">
                <div className="form-grid">
                  <Field title="尺寸">
                    <input
                      value={modelEditor.image_config?.size ?? ""}
                      placeholder="服务默认"
                      onChange={(event) => setModelEditor({ ...modelEditor, image_config: { ...modelEditor.image_config, size: event.target.value } })}
                    />
                  </Field>
                  <Field title="质量">
                    <input
                      value={modelEditor.image_config?.quality ?? ""}
                      placeholder="服务默认"
                      onChange={(event) => setModelEditor({ ...modelEditor, image_config: { ...modelEditor.image_config, quality: event.target.value } })}
                    />
                  </Field>
                  <Field title="输出格式">
                    <SelectField
                      value={modelEditor.image_config?.output_format ?? ""}
                      options={[{ value: "", label: "服务默认" }, ...["png", "jpeg", "webp"].map((value) => ({ value, label: value.toUpperCase() }))]}
                      onChange={(value) => setModelEditor({ ...modelEditor, image_config: { ...modelEditor.image_config, output_format: value as NonNullable<Model["image_config"]>["output_format"] } })}
                    />
                  </Field>
                  <Field title="背景">
                    <SelectField
                      value={modelEditor.image_config?.background ?? ""}
                      options={[{ value: "", label: "服务默认" }, { value: "auto", label: "自动" }, { value: "opaque", label: "不透明" }, { value: "transparent", label: "透明" }]}
                      onChange={(value) => setModelEditor({ ...modelEditor, image_config: { ...modelEditor.image_config, background: value as NonNullable<Model["image_config"]>["background"] } })}
                    />
                  </Field>
                </div>
                <Toggle
                  title="支持参考图编辑"
                  value={modelEditor.image_config?.supports_edit ?? false}
                  onChange={(supports_edit) => setModelEditor({ ...modelEditor, image_config: { ...modelEditor.image_config, supports_edit } })}
                />
              </section>
            ) : modelSection === "reasoning" ? (
              <section className="model-editor-section">
                <Field title="思考方式">
                  <SelectField
                    value={modelEditor.reasoning_kind ?? "unknown"}
                    options={[
                      "unknown",
                      "none",
                      "effort",
                      "toggle",
                      "budget",
                      "always",
                    ].map((value) => ({
                      value,
                      label: value === "unknown" ? "服务默认" : value,
                    }))}
                    onChange={(value) => {
                      setModelTouched(true);
                      const configurable = [
                        "effort",
                        "toggle",
                        "budget",
                      ].includes(value);
                      setModelEditor({
                        ...modelEditor,
                        reasoning_kind: value as Model["reasoning_kind"],
                        ...(value === "toggle" ? { default_effort: "on" } : {}),
                        ...(!configurable
                          ? {
                              effort_parameter: "",
                              default_effort: "",
                              effort_mapping: {},
                            }
                          : {}),
                        ...(value === "budget"
                          ? { default_effort: "", effort_mapping: {} }
                          : {}),
                      });
                      if (value === "toggle") {
                        setEffortsText("on, off");
                        setMappingText(
                          JSON.stringify({ on: true, off: false }, null, 2),
                        );
                      } else if (!configurable || value === "budget") {
                        setEffortsText("");
                        setMappingText("{}");
                      }
                    }}
                  />
                </Field>
                {["effort", "toggle", "budget"].includes(
                  modelEditor.reasoning_kind ?? "unknown",
                ) && (
                  <div className="form-grid">
                    <Field title="思考参数">
                      <input
                        value={modelEditor.effort_parameter ?? ""}
                        onChange={(event) =>
                          setModelEditor({
                            ...modelEditor,
                            effort_parameter: event.target.value,
                          })
                        }
                        placeholder="reasoning_effort"
                      />
                    </Field>
                    {modelEditor.reasoning_kind !== "budget" && (
                      <Field title="支持档位">
                        <input
                          placeholder="none, low, high, max"
                          value={effortsText}
                          onChange={(event) =>
                            setEffortsText(event.target.value)
                          }
                        />
                      </Field>
                    )}
                  </div>
                )}
                {["effort", "toggle"].includes(
                  modelEditor.reasoning_kind ?? "unknown",
                ) && (
                  <Field title="默认档位">
                    <SelectField
                      value={modelEditor.default_effort ?? ""}
                      options={[
                        { value: "", label: "服务默认" },
                        ...effortsText
                          .split(",")
                          .map((value) => value.trim())
                          .filter(Boolean)
                          .map((value) => ({ value, label: value })),
                      ]}
                      onChange={(default_effort) =>
                        setModelEditor({ ...modelEditor, default_effort })
                      }
                    />
                  </Field>
                )}
                {modelEditor.reasoning_kind === "budget" && (
                  <div className="form-grid">
                    {(["min", "max", "default"] as const).map((name) => (
                      <Field title={`Budget ${name}`} key={name}>
                        <input
                          type="number"
                          min={0}
                          value={modelEditor[`reasoning_budget_${name}`] ?? 0}
                          onChange={(event) =>
                            setModelEditor({
                              ...modelEditor,
                              [`reasoning_budget_${name}`]: Number(
                                event.target.value,
                              ),
                            })
                          }
                        />
                      </Field>
                    ))}
                  </div>
                )}
              </section>
            ) : (
              <section className="model-editor-section">
                <Field title="参数映射">
                  <textarea
                    className="code-input"
                    rows={5}
                    value={mappingText}
                    onChange={(event) => setMappingText(event.target.value)}
                  />
                </Field>
                <div className="metadata-strip">
                  <span>{modelEditor.source ?? "custom"}</span>
                  <span>{modelEditor.metadata_source || "unknown"}</span>
                  {modelEditor.metadata_updated_at && (
                    <time>
                      {new Date(
                        modelEditor.metadata_updated_at,
                      ).toLocaleString()}
                    </time>
                  )}
                </div>
                {modelEditor.reasoning_options?.length ? (
                  <div className="reference-options">
                    {modelEditor.reasoning_options.map((option, index) => (
                      <span key={index}>
                        {option.type}:{" "}
                        {option.values?.join(", ") ??
                          `${option.min ?? 0}–${option.max ?? ""}`}
                      </span>
                    ))}
                  </div>
                ) : null}
                {modelEditor.last_test && (
                  <span
                    className={
                      modelEditor.last_test.ok ? "form-success" : "form-error"
                    }
                  >
                    {modelEditor.last_test.ok
                      ? "测试通过"
                      : modelEditor.last_test.error}
                    {modelEditor.last_test.checked_at
                      ? ` · ${new Date(modelEditor.last_test.checked_at).toLocaleString()}`
                      : ""}
                  </span>
                )}
              </section>
            )}
            <ErrorNotice error={error} />
          </form>
        </Modal>
      )}
      {catalogFor && (
        <Modal
          className="ochi-admin-modal"
          title="参考模型目录"
          onClose={() => setCatalogFor(null)}
          size="large"
        >
          <div className="admin-form">
            <SelectField
              label="目录 Provider"
              value={catalogProvider}
              options={[
                { value: "", label: "选择 Provider" },
                ...catalogProviders.map((item) => ({
                  value: item.id,
                  label: item.name,
                })),
              ]}
              onChange={setCatalogProvider}
            />
            <div className="search-input">
              <Search size={16} />
              <input
                placeholder="搜索模型"
                value={catalogQuery}
                onChange={(event) => setCatalogQuery(event.target.value)}
              />
            </div>
            <div className="catalog-list">
              {catalogModels.map((model, index) => (
                <button
                  key={model.id || index}
                  disabled={busy === "catalog"}
                  onClick={() => {
                    setBusy("catalog");
                    void adminApi
                      .applyCatalog(catalogFor.id, catalogProvider, model.id)
                      .then((value) => {
                        setCatalogFor(null);
                        if (modelEditor?.id === value.id) editModel(value);
                        void refresh();
                        setNotice("目录已应用");
                      })
                      .catch((reason: Error) => setError(reason.message))
                      .finally(() => setBusy(""));
                  }}
                >
                  <span>
                    <strong>{model.name || model.id}</strong>
                    <small>{model.id}</small>
                  </span>
                  <span>
                    {model.limit?.context
                      ? `${Math.round(model.limit.context / 1000)}k`
                      : ""}
                    <ChevronRight size={15} />
                  </span>
                </button>
              ))}
            </div>
            <ErrorNotice error={error} />
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal
          className="ochi-admin-modal"
          title="删除配置？"
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
                    .remove(deleting.kind, deleting.id)
                    .then(() => {
                      setDeleting(null);
                      void refresh();
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
