import { t, useAdminI18n, getLocale, translateError } from "./i18n";
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
  ArrowUp,
  ArrowDown,
  ArrowUpToLine,
  ListOrdered,
} from "lucide-react";
import { adminApi } from "../../lib/api";
import { moveModel } from "../../lib/modelSelection";
import { effortLabel } from "../../lib/reasoningLabels";
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
  useAdminI18n();
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
  const [modelOrder, setModelOrder] = useState<string[] | null>(null);
  const [defaultModel, setDefaultModel] = useState("");
  const [orderError, setOrderError] = useState("");
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
      setError(reason instanceof Error ? reason.message : t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const provider = providers.find((item) => item.id === selected);
  function editModelOrder() {
    const published = models.filter((model) => model.enabled && model.available !== false &&
      (!model.kind || model.kind === "chat") && providers.some((item) => item.id === model.provider_id && item.enabled));
    setModelOrder(published.map((model) => model.id));
    setDefaultModel((published.find((model) => model.is_default) ?? published[0])?.id ?? "");
    setOrderError("");
  }
  async function saveModelOrder() {
    if (!modelOrder) return;
    setBusy("model-order");
    setOrderError("");
    try {
      await adminApi.saveModelOrder(modelOrder, defaultModel);
      await refresh();
      setModelOrder(null);
      setNotice(t("modelOrderSaved"));
    } catch (reason) {
      setOrderError(reason instanceof Error ? reason.message : t("saveFailed"));
    } finally { setBusy(""); }
  }
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
      setNotice(saved.sync_error ? t("savedWithError", { error: translateError(saved.sync_error_code) ?? saved.sync_error }) : saved.imported ? t("modelsSaved", { count: saved.imported }) : t("saved"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("saveFailed"));
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
      setNotice(t("saved"));
    } catch (reason) {
      setError(
        reason instanceof SyntaxError
          ? t("invalidParameterMapping")
          : reason instanceof Error
            ? reason.message
            : t("saveFailed"),
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
      if (!value.ok) throw new Error(translateError(value.error_code, value.error_params) ?? value.error ?? t("connectionFailed"));
      setNotice(
        kind === "providers"
          ? value.models ? t("connectionModelCount", { count: value.models.length }) : t("connectionSucceeded")
          : t(value.parameter_accepted ? "modelAvailableWithParams" : "modelAvailable"),
      );
      if (kind === "models") await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("testFailed"));
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
        t(result.unavailable ? "syncResultUnavailable" : "syncResult", { count: result.imported, unavailable: result.unavailable ?? 0 }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("syncFailed"));
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
      setNotice(t(result.unmatched ? "modelMatchStatus" : "modelMatches", { count: result.matched, unmatched: result.unmatched ?? 0 }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("matchFailed"));
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
        if (!value.matched || !value.model) throw new Error(t("modelNotInCatalog"));
        const next = { ...modelEditor, ...value.model, id: "", provider_id: selected, model: modelEditor.model, enabled: modelEditor.enabled, is_default: modelEditor.is_default };
        setModelEditor(next);
        setModelOriginal(next);
        setEffortsText(value.model.efforts?.join(", ") ?? "");
        setMappingText(JSON.stringify(value.model.effort_mapping ?? {}, null, 2));
      }
      setMatchStatus("models.dev");
      setModelTouched(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("matchFailed"));
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
        setMatchStatus(value.matched ? "models.dev" : t("notListed"));
        if (!value.model || modelTouched) return;
        const next = { ...modelEditor, ...value.model, id: "", provider_id: selected, model: modelEditor.model, enabled: modelEditor.enabled, is_default: modelEditor.is_default };
        setModelEditor((current) => current ? { ...current, ...next, name: current.name && current.name !== current.model ? current.name : value.model!.name } : current);
        setModelOriginal(next);
        setEffortsText(value.model.efforts?.join(", ") ?? "");
        setMappingText(JSON.stringify(value.model.effort_mapping ?? {}, null, 2));
      }).catch(() => { if (!disposed) setMatchStatus(t("catalogUnavailable")); }).finally(() => { if (!disposed) setMatching(false); });
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
      setError(reason instanceof Error ? reason.message : t("saveFailed"));
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
      setError(reason instanceof Error ? reason.message : t("catalogLoadFailed"));
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
        <h2>{t("modelProviders")}</h2>
        <div className="toolbar-actions">
          <button className="secondary-button" onClick={editModelOrder} disabled={loading}>
            <ListOrdered size={16} />
            {t("orderAndDefault")}</button>
          <button className="primary-button" onClick={() => editProvider()}>
            <Plus size={16} />
            {t("addProvider")}</button>
        </div>
      </div>
      <ErrorNotice error={error} notice={notice} />
      {modelOrder && <Modal title={t("orderAndDefault")} onClose={() => { if (busy !== "model-order") setModelOrder(null); }}
        bodyClassName="model-order-body"
        footer={<>
          <button className="secondary-button" onClick={() => setModelOrder(null)} disabled={busy === "model-order"}>{t("cancel")}</button>
          <button className="primary-button" onClick={() => void saveModelOrder()} disabled={busy === "model-order"}>
            {busy === "model-order" && <LoaderCircle size={15} className="spin" />}{t("save")}</button>
        </>}>
        <p className="model-order-hint">{t("modelOrderHint")}</p>
        <ErrorNotice error={orderError} />
        <ol className="model-order-list">
          {modelOrder.map((id, index) => {
            const model = models.find((item) => item.id === id);
            if (!model) return null;
            const name = model.name || model.model;
            return <li key={id}>
              <label className="model-order-default">
                <input type="radio" name="default-model" checked={defaultModel === id} onChange={() => setDefaultModel(id)}
                  disabled={busy === "model-order"} aria-label={t("defaultModelNamed", { name })} />
                <BrandIcon src={model.icon} size={20} />
                <span><strong>{name}</strong><small>{model.provider_name}</small></span>
                {defaultModel === id && <span className="model-default">{t("default")}</span>}
              </label>
              <div className="model-order-actions">
                <button className="icon-button" aria-label={t("moveToTopNamed", { name })} title={t("moveToTop")} disabled={!index || busy === "model-order"}
                  onClick={() => setModelOrder([id, ...modelOrder.filter((item) => item !== id)])}><ArrowUpToLine size={15} /></button>
                <button className="icon-button" aria-label={t("moveUpNamed", { name })} title={t("moveUp")} disabled={!index || busy === "model-order"}
                  onClick={() => setModelOrder(moveModel(modelOrder, id, -1))}><ArrowUp size={15} /></button>
                <button className="icon-button" aria-label={t("moveDownNamed", { name })} title={t("moveDown")} disabled={index === modelOrder.length - 1 || busy === "model-order"}
                  onClick={() => setModelOrder(moveModel(modelOrder, id, 1))}><ArrowDown size={15} /></button>
              </div>
            </li>;
          })}
        </ol>
        {!modelOrder.length && <div className="empty-page">{t("noEnabledChatModels")}</div>}
      </Modal>}
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
                  <small>{t("enabledModelCount", {
                    count: models.filter((model) => model.provider_id === item.id && model.enabled).length,
                  })}</small>
                </span>
                {!item.enabled && <span className="connection-dot" />}
                <ChevronRight size={14} />
              </button>
            ))}
            {!providers.length && <div className="empty-page">{t("noProviders")}</div>}
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
                    aria-label={t("editProvider")}
                    title={t("editProvider")}
                    onClick={() => editProvider(provider)}
                  >
                    <Settings2 size={16} />
                    <span>{t("settings")}</span>
                  </button>
                  <button className="icon-button" title={t("testConnection")} aria-label={t("testProviderConnection")}
                    disabled={busy === provider.id} onClick={() => void test("providers", provider.id)}>
                    <Zap size={16} />
                  </button>
                  <ActionMenu
                    trigger={<MoreHorizontal size={19} />}
                    label={t("providerActions")}
                  >
                    <MenuAction
                      onClick={() => void test("providers", provider.id)}
                    >
                      <Zap size={15} />
                      {t("testConnection")}</MenuAction>
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
                      {t("deleteProvider")}</MenuAction>
                  </ActionMenu>
                </div>
              </header>
              <div className="provider-overview">
                <span className={`admin-state${provider.enabled ? " is-enabled" : ""}`}>
                  <i />{provider.enabled ? t("enabled") : t("disabled")}
                </span>
                <span>{provider.protocol === "openai-responses" ? "Responses" : "Chat Completions"}</span>
                <span>{provider.has_api_key ? t("keyConfigured") : t("noKey")}</span>
              </div>
              <div className="model-list-toolbar">
                <div className="search-input">
                  <Search size={16} />
                  <input
                    placeholder={t("searchModels")}
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
                  {t("enabled")}</label>
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
                  {t("sync")}</button>
                <button
                  className="icon-button"
                  aria-label={t("updateModelMetadata")}
                  title={t("updateMetadata")}
                  disabled={busy === "metadata"}
                  onClick={() => void refreshMetadata()}
                >
                  <Database size={16} className={busy === "metadata" ? "spin" : ""} />
                </button>
                <button
                  className="icon-button"
                  aria-label={t("customModel")}
                  title={t("customModel")}
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
                          {model.is_default && <span className="model-default">{t("default")}</span>}
                        </span>
                        {model.name && model.name !== model.model && (
                          <small>{model.model}</small>
                        )}
                        {model.available === false && (
                          <small className="danger">{t("remoteUnavailable")}</small>
                        )}
                        <span className="model-row-meta">
                          {model.context_window > 0 && <span className="model-context">{t("contextCount", { count: Math.round(model.context_window / 1000) })}</span>}
                          <span className="model-capability-icons">
                            {model.supports_image_generation && <span title={t("imageGeneration")}><ImagePlus size={14} /></span>}
                            {model.metadata_known?.supports_vision && model.supports_vision && <span title={t("imageUnderstanding")}><Image size={14} /></span>}
                            {model.metadata_known?.supports_tools && model.supports_tools && <span title={t("toolCalling")}><Wrench size={14} /></span>}
                            {model.reasoning_kind && !["none", "unknown"].includes(model.reasoning_kind) && <span title={model.efforts?.length ? model.efforts.join(", ") : t("reasoning")}><Brain size={14} /></span>}
                          </span>
                        </span>
                      </div>
                    </button>
                    <InlineSwitch title={t("enableNamed", { name: model.name })} value={model.enabled}
                      updating={busy === model.id} onChange={(enabled) => void publish(model, enabled)} />
                    <ActionMenu
                      trigger={<MoreHorizontal size={18} />}
                      label={t("modelActions")}
                    >
                      <MenuAction onClick={() => editModel(model)}>
                        <Settings2 size={15} />
                        {t("editCapabilities")}</MenuAction>
                      <MenuAction onClick={() => void openCatalog(model)}>
                        <Database size={15} />
                        {t("browseCatalog")}</MenuAction>
                      <MenuAction onClick={() => {
                        setBusy(model.id);
                        void adminApi.autoMatchModel(model.id).then(() => refresh()).then(() => setNotice(t("autoMatched"))).catch((reason: Error) => setError(reason.message)).finally(() => setBusy(""));
                      }}>
                        <RefreshCw size={15} />
                        {t("autoMatch")}</MenuAction>
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
                        {t("testModel")}</MenuAction>
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
                        {t("delete")}</MenuAction>
                    </ActionMenu>
                  </article>
                ))}
                {!filtered.length && <div className="empty-page">{t("noModels")}</div>}
              </div>
            </section>
          )}
        </div>
      )}
      {providerEditor && (
        <Modal
          className="ochi-admin-modal"
          title={providerEditor.id ? t("editProviderDialog") : t("addProvider")}
          onClose={() => setProviderEditor(null)}
          size="form"
          footer={
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setProviderEditor(null)}
              >
                {t("cancel")}</button>
              <button
                type="submit"
                form="provider-editor"
                className="primary-button"
                disabled={busy === "save-provider"}
              >
                {t("save")}</button>
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
            <Field title={t("name")}>
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
            <Field title={t("protocol")}>
              <SelectField
                label={t("providerProtocol")}
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
                        ? [{ value: "keep", label: t("keepCurrentKey") }]
                        : []),
                      { value: "replace", label: t("setNewKey") },
                      { value: "delete", label: t("deleteKey") },
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
                  <Field title={t("newKey")}>
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
              title={t("enable")}
              value={providerEditor.enabled ?? true}
              onChange={(enabled) =>
                setProviderEditor({ ...providerEditor, enabled })
              }
            />
            <details className="advanced-section">
              <summary>{t("advancedSettings")}</summary>
              <Field title={t("timeoutSeconds")}>
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
              <Field title={t("catalogProviderID")}>
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
                title={t("discoverRemoteModels")}
                value={providerEditor.discover_models ?? true}
                onChange={(discover_models) =>
                  setProviderEditor({ ...providerEditor, discover_models })
                }
              />
              <Toggle
                title={t("allowWithoutKey")}
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
                <span>{t("requestHeaders")}</span>
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
          title={modelEditor.id ? t("modelCapabilities") : t("customModel")}
          onClose={() => setModelEditor(null)}
          size="large"
          footer={
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setModelEditor(null)}
              >
                {t("cancel")}</button>
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
                {t("save")}</button>
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
            <div className="segmented-control" aria-label={t("modelConfigSections")}>
              {[
                { id: "basic", label: t("general") },
                ...(modelEditor.kind === "image" ? [{ id: "image", label: t("image") }] : modelEditor.kind !== "embedding" ? [{ id: "reasoning", label: t("reasoning") }] : []),
                { id: "metadata", label: t("metadata") },
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
              <span>{matching ? t("matching") : matchStatus || modelEditor.metadata_source || t("notMatched")}</span>
              {modelEditor.catalog_provider_id && <span>{modelEditor.catalog_provider_id}/{modelEditor.catalog_model_id}</span>}
              {modelEditor.metadata_overrides && Object.keys(modelEditor.metadata_overrides).length > 0 && <span>{t("manualOverrides")}{Object.keys(modelEditor.metadata_overrides).length}</span>}
            </div>
            <div className="toolbar-actions">
              <button
                type="button"
                className="text-button"
                disabled={matching || !modelEditor.model.trim()}
                onClick={() => void autoMatchModel()}
              >
                <RefreshCw size={14} className={matching ? "spin" : ""} />
                {t("autoMatch")}</button>
              {modelEditor.id && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void openCatalog(modelEditor)}
                >
                  <Database size={14} />
                  {t("browseCatalog")}</button>
              )}
            </div>
            {modelSection === "basic" ? (
              <section className="model-editor-section">
                <div className="form-grid">
                  <Field title={t("displayName")}>
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
                  <Field title={t("modelID")}>
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
                  <Field title={t("type")}>
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
                        { value: "chat", label: t("chatModel") },
                        { value: "image", label: t("imageModel") },
                        { value: "embedding", label: t("embeddingModel") },
                      ]}
                    />
                  </Field>
                  <Toggle
                    title={t("enable")}
                    value={modelEditor.enabled}
                    onChange={(enabled) =>
                      setModelEditor({ ...modelEditor, enabled })
                    }
                  />
                </div>
                {modelEditor.kind !== "image" && <div className="form-grid">
                  <Field title={t("contextWindow")}>
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
                  {modelEditor.kind !== "embedding" && <Field title={t("maxOutputCapability")}>
                    <input
                      type="number"
                      min={0}
                      title={t("maxOutputHint")}
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
                    title={modelEditor.metadata_known?.supports_tools ? t("toolCalling") : t("toolCallingUnknown")}
                    value={modelEditor.supports_tools}
                    onChange={(supports_tools) =>
                      setModelEditor({ ...modelEditor, supports_tools })
                    }
                  />}
                  {modelEditor.kind !== "image" && modelEditor.kind !== "embedding" && <Toggle
                    title={modelEditor.metadata_known?.supports_vision ? t("imageUnderstanding") : t("visionUnknown")}
                    value={modelEditor.supports_vision}
                    onChange={(supports_vision) =>
                      setModelEditor({ ...modelEditor, supports_vision })
                    }
                  />}
                  {modelEditor.kind !== "image" && modelEditor.kind !== "embedding" && <Toggle
                    title={modelEditor.metadata_known?.structured_output ? t("structuredOutput") : t("structuredOutputUnknown")}
                    value={modelEditor.structured_output ?? false}
                    onChange={(structured_output) =>
                      setModelEditor({ ...modelEditor, structured_output })
                    }
                  />}
                  {modelEditor.kind !== "image" && modelEditor.kind !== "embedding" && <Toggle
                    title={t("defaultModel")}
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
                  <Field title={t("size")}>
                    <input
                      value={modelEditor.image_config?.size ?? ""}
                      placeholder={t("providerDefault")}
                      onChange={(event) => setModelEditor({ ...modelEditor, image_config: { ...modelEditor.image_config, size: event.target.value } })}
                    />
                  </Field>
                  <Field title={t("quality")}>
                    <input
                      value={modelEditor.image_config?.quality ?? ""}
                      placeholder={t("providerDefault")}
                      onChange={(event) => setModelEditor({ ...modelEditor, image_config: { ...modelEditor.image_config, quality: event.target.value } })}
                    />
                  </Field>
                  <Field title={t("outputFormat")}>
                    <SelectField
                      value={modelEditor.image_config?.output_format ?? ""}
                      options={[{ value: "", label: t("providerDefault") }, ...["png", "jpeg", "webp"].map((value) => ({ value, label: value.toUpperCase() }))]}
                      onChange={(value) => setModelEditor({ ...modelEditor, image_config: { ...modelEditor.image_config, output_format: value as NonNullable<Model["image_config"]>["output_format"] } })}
                    />
                  </Field>
                  <Field title={t("background")}>
                    <SelectField
                      value={modelEditor.image_config?.background ?? ""}
                      options={[{ value: "", label: t("providerDefault") }, { value: "auto", label: t("automatic") }, { value: "opaque", label: t("opaque") }, { value: "transparent", label: t("transparent") }]}
                      onChange={(value) => setModelEditor({ ...modelEditor, image_config: { ...modelEditor.image_config, background: value as NonNullable<Model["image_config"]>["background"] } })}
                    />
                  </Field>
                </div>
                <Toggle
                  title={t("referenceImageEditing")}
                  value={modelEditor.image_config?.supports_edit ?? false}
                  onChange={(supports_edit) => setModelEditor({ ...modelEditor, image_config: { ...modelEditor.image_config, supports_edit } })}
                />
              </section>
            ) : modelSection === "reasoning" ? (
              <section className="model-editor-section">
                <Field title={t("reasoningMode")}>
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
                      label: {
                        unknown: t("providerDefault"), none: t("reasoningNone"),
                        effort: t("reasoningEffort"), toggle: t("reasoningToggle"),
                        budget: t("reasoningBudget"), always: t("reasoningAlways"),
                      }[value]!,
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
                    <Field title={t("reasoningParameter")}>
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
                      <Field title={t("supportedLevels")}>
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
                  <Field title={t("defaultLevel")}>
                    <SelectField
                      value={modelEditor.default_effort ?? ""}
                      options={[
                        { value: "", label: t("providerDefault") },
                        ...effortsText
                          .split(",")
                          .map((value) => value.trim())
                          .filter(Boolean)
                          .map((value) => ({ value, label: effortLabel(value) })),
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
                      <Field title={t(({ min: "budgetMinimum", max: "budgetMaximum", default: "budgetDefault" } as const)[name])} key={name}>
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
                <Field title={t("parameterMapping")}>
                  <textarea
                    className="code-input"
                    rows={5}
                    value={mappingText}
                    onChange={(event) => setMappingText(event.target.value)}
                  />
                </Field>
                <div className="metadata-strip">
                  <span>{t(({ custom: "sourceCustom", remote: "sourceRemote", catalog: "sourceCatalog" } as const)[modelEditor.source ?? "custom"])}</span>
                  <span>{modelEditor.metadata_source || t("unknown")}</span>
                  {modelEditor.metadata_updated_at && (
                    <time>
                      {new Date(
                        modelEditor.metadata_updated_at,
                      ).toLocaleString(getLocale())}
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
                  <div
                    className={
                      modelEditor.last_test.ok ? "form-success" : "form-error"
                    }
                  >
                    {modelEditor.last_test.ok
                      ? t("testPassed")
                      : translateError(modelEditor.last_test.error_code, modelEditor.last_test.error_params) ?? modelEditor.last_test.error}
                    {modelEditor.last_test.checked_at
                      ? ` · ${new Date(modelEditor.last_test.checked_at).toLocaleString(getLocale())}`
                      : ""}
                    {modelEditor.last_test.detail && <details className="technical-details"><summary>{t("details")}</summary><pre>{modelEditor.last_test.detail}</pre></details>}
                  </div>
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
          title={t("modelCatalog")}
          onClose={() => setCatalogFor(null)}
          size="large"
        >
          <div className="admin-form">
            <SelectField
              label={t("catalogProvider")}
              value={catalogProvider}
              options={[
                { value: "", label: t("chooseProvider") },
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
                placeholder={t("searchModels")}
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
                        setNotice(t("catalogApplied"));
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
          title={t("deleteConfigQuestion")}
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
                    .remove(deleting.kind, deleting.id)
                    .then(() => {
                      setDeleting(null);
                      void refresh();
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
