import { COMPOSE_EVENT } from "../lib/composeEvent";
import { t, useI18n, getLocale } from "../lib/i18n";
import { sendsOnEnter } from "../lib/appearance";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  FileUp,
  ImagePlus,
  Mic,
  Monitor,
  Paperclip,
  Plus,
  Search,
  SkipForward,
  Square,
  X,
} from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import { Menu } from "@base-ui/react/menu";
import type { Artifact, Model } from "../lib/types";
import { api } from "../lib/api";
import type { InstructionAcceptance } from "../lib/runInstructions";
import { contextLabel } from "../lib/modelSelection";
import { effortLabel } from "../lib/reasoningLabels";
import { sizeText } from "./FileCards";
import { BrandIcon } from "./BrandIcon";
import "./composer.css";

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((event: {
        results: {
          [key: number]: { [key: number]: { transcript: string } };
          length: number;
        };
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};
const recognitionConstructor = () =>
  (
    window as unknown as {
      SpeechRecognition?: new () => Recognition;
      webkitSpeechRecognition?: new () => Recognition;
    }
  ).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: new () => Recognition })
    .webkitSpeechRecognition;

type Props = {
  onSubmit: (value: string, files: Artifact[]) => Promise<boolean>;
  onStop: () => void;
  onSubmitNow?: (value: string, files: Artifact[]) => Promise<boolean>;
  onSupplement?: (value: string) => Promise<boolean>;
  supplementBusy?: boolean;
  supplementAccepted?: InstructionAcceptance;
  budget?: number;
  onBudget?: (value: number) => void;
  reasoningEnabled?: boolean;
  onReasoningEnabled?: (value: boolean) => void;
  computerEnabled: boolean;
  computerOnce?: boolean;
  computerUpdating?: boolean;
  onComputer: (value: boolean) => void;
  onError: (error: string) => void;
  busy: boolean;
  unavailable: boolean;
  stopping: boolean;
  draftKey: string;
  models: Model[];
  modelId: string;
  effort: string;
  onModel: (id: string) => void;
  onEffort: (effort: string) => void;
  initialDraft?: string;
};

function readDraft(key: string) {
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function hasFiles(data: DataTransfer) {
  return Array.from(data.types).includes("Files") ||
    Array.from(data.items).some((item) => item.kind === "file");
}

function transferFiles(data: DataTransfer) {
  const items = Array.from(data.items).filter((item) => item.kind === "file");
  const entries = items.map((item) => ({
    item,
    directory: item.webkitGetAsEntry?.()?.isDirectory ?? false,
  }));
  const directories = entries.some((entry) => entry.directory);
  const files = directories || !data.files.length
    ? entries.filter((entry) => !entry.directory).map((entry) => entry.item.getAsFile()).filter((file): file is File => file !== null)
    : Array.from(data.files);
  return { files, directories };
}

function ThinkingBudget({ value, min, max, disabled, onChange }: { value: number; min: number; max: number; disabled: boolean; onChange: (value: number) => void }) {
  useI18n();
  const [draftBudget, setDraftBudget] = useState(String(value));
  useEffect(() => setDraftBudget(String(value)), [value]);
  function commitBudget() {
    const parsed = Number(draftBudget);
    const next = draftBudget.trim() && Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : value;
    setDraftBudget(String(next));
    onChange(next);
  }
  return <Popover.Root>
    <Popover.Trigger type="button" className="chip-btn" disabled={disabled} aria-label={t("reasoning.budget")} title={t("reasoning.budgetValue", { count: value })}>
      <Brain className="ic" />
      <span className="chip-label">{value.toLocaleString(getLocale())}</span>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner className="pop-positioner" side="top" sideOffset={8} align="end">
        <Popover.Popup className="pop budget-pop">
          <div className="menu-label"><Popover.Title render={<span />}>{t("reasoning.budget")}</Popover.Title></div>
          <label className="budget-field">
            <input className="input" type="number" aria-label={t("reasoning.budget")} min={min} max={max} step={512} value={draftBudget} onChange={(event) => setDraftBudget(event.target.value)} onBlur={commitBudget} onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); commitBudget(); }
            }} />
            <span className="field-hint">{t("common.tokens")}</span>
          </label>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

/** Model chip + searchable, provider-grouped menu (lab composer model menu). */
function ModelPicker({ models, value, disabled, onChange }: { models: Model[]; value: string; disabled: boolean; onChange: (id: string) => void }) {
  useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = models.find((model) => model.id === value);
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const map = new Map<string, Model[]>();
    for (const model of models) {
      if (needle && !model.name.toLowerCase().includes(needle) && !(model.provider_name ?? "").toLowerCase().includes(needle)) continue;
      const key = model.provider_name ?? "";
      map.set(key, [...(map.get(key) ?? []), model]);
    }
    return [...map.entries()];
  }, [models, query]);
  return <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
    <Popover.Trigger type="button" className="chip-btn model-chip" disabled={disabled} aria-label={t("composer.chooseModel")} title={current?.name || t("composer.chooseModel")}>
      <BrandIcon src={current?.icon || current?.provider_icon} size={15} />
      <span className="chip-label">{current?.name || t("composer.chooseModel")}</span>
      <ChevronDown className="ic chev down" />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner className="pop-positioner" side="top" sideOffset={8} align="end" collisionPadding={8}>
        <Popover.Popup className="pop model-pop" aria-label={t("composer.chooseModel")} initialFocus={false}>
          <div className="search-field model-search">
            <Search className="ic" />
            <input className="input" autoFocus placeholder={t("composer.searchModels")} aria-label={t("composer.searchModels")} autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          <div className="menu model-list" role="menu">
            {groups.length === 0 && <div className="menu-label model-empty">{t("composer.noModels")}</div>}
            {groups.map(([provider, items]) => <div key={provider} role="group">
              {provider && <div className="menu-label">{provider}</div>}
              {items.map((model) => <button key={model.id} type="button" role="menuitemradio" aria-checked={model.id === value} className="menu-item rich"
                onClick={() => { onChange(model.id); setOpen(false); }}>
                <BrandIcon src={model.icon || model.provider_icon} size={16} />
                <span className="mi-text"><b>{model.name}</b>{model.context_window > 0 && <small className="mono">{contextLabel(model.context_window)}</small>}</span>
                <Check className="ic tick" />
              </button>)}
            </div>)}
          </div>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

/** Reasoning-effort chip + radio menu. */
function EffortPicker({ efforts, value, disabled, onChange }: { efforts: string[]; value: string; disabled: boolean; onChange: (value: string) => void }) {
  useI18n();
  const options = ["", ...efforts];
  return <Menu.Root>
    <Menu.Trigger className="chip-btn" disabled={disabled} aria-label={t("reasoning.effort")} title={t("reasoning.effortValue", { level: effortLabel(value) })}>
      <Brain className="ic" />
      <span className="chip-label">{value ? effortLabel(value) : t("reasoning.effort")}</span>
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Positioner className="pop-positioner" side="top" sideOffset={8} align="end" collisionPadding={8}>
        <Menu.Popup className="pop">
          <Menu.RadioGroup className="menu" value={value} onValueChange={(next) => onChange(String(next))}>
            {options.map((option) => <Menu.RadioItem key={option || "default"} value={option} className="menu-item" closeOnClick>
              <span className="mi-text">{option ? effortLabel(option) : t("common.default")}</span>
              <Menu.RadioItemIndicator className="tick-on"><Check className="ic" /></Menu.RadioItemIndicator>
            </Menu.RadioItem>)}
          </Menu.RadioGroup>
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>;
}

// Input owns draft state independently from the growing run snapshot.
export const Composer = memo(function Composer({
  onSubmit,
  onStop,
  onSubmitNow,
  onSupplement,
  supplementBusy,
  supplementAccepted,
  budget,
  onBudget,
  reasoningEnabled,
  onReasoningEnabled,
  computerEnabled,
  computerOnce,
  computerUpdating,
  onComputer,
  onError,
  busy,
  unavailable,
  stopping,
  draftKey,
  models,
  modelId,
  effort,
  onModel,
  onEffort,
  initialDraft,
}: Props) {
  useI18n();
  const [draft, setDraft] = useState(initialDraft ?? readDraft(draftKey));
  const [submitting, setSubmitting] = useState(false);
  const [files, setFiles] = useState<Artifact[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [listening, setListening] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const recognition = useRef<Recognition | null>(null);
  const rootRef = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  const pendingUploads = useRef<File[]>([]);
  const uploadController = useRef<AbortController | null>(null);
  const uploadingRef = useRef(false);
  const submittingRef = useRef(false);
  const dragDepth = useRef(0);
  useEffect(() => {
    const compose = (event: Event) => {
      setDraft((event as CustomEvent<string>).detail);
      inputRef.current?.focus();
    };
    window.addEventListener(COMPOSE_EVENT, compose);
    return () => window.removeEventListener(COMPOSE_EVENT, compose);
  }, []);
  const latestDraft = useRef({ draft, files });
  latestDraft.current = { draft, files };
  const currentModel = models.find((model) => model.id === modelId);
  const configuredReasoning = Boolean(currentModel?.effort_parameter);
  const efforts =
    configuredReasoning &&
    currentModel?.reasoning_kind !== "toggle" &&
    currentModel?.reasoning_kind !== "budget"
      ? (currentModel?.efforts ?? [])
      : [];
  const reasoningOptions =
    configuredReasoning && currentModel?.reasoning_kind !== "unknown"
      ? (currentModel?.reasoning_options ?? [])
      : [];
  const toggleThinking = currentModel?.reasoning_kind === "toggle";
  const budgetOption = reasoningOptions.find(
    (option) => option.type === "budget_tokens",
  );
  const budgetThinking = currentModel?.reasoning_kind === "budget";
  const voiceAvailable = Boolean(recognitionConstructor());

  useEffect(() => {
    try {
      draft
        ? sessionStorage.setItem(draftKey, draft)
        : sessionStorage.removeItem(draftKey);
    } catch {
      /* An unavailable storage does not block chat. */
    }
  }, [draft, draftKey]);
  useEffect(() => () => recognition.current?.stop(), []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingUploads.current = [];
      uploadController.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!dragging) return;
    const clear = () => { dragDepth.current = 0; setDragging(false); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") clear(); };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    window.addEventListener("blur", clear);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", escape);
    };
  }, [dragging]);
  useEffect(() => {
    const current = latestDraft.current;
    if (supplementAccepted && !current.files.length && current.draft.trim() === supplementAccepted.content)
      setDraft("");
  }, [supplementAccepted?.id]);
  useLayoutEffect(() => {
    const node = inputRef.current;
    if (node) {
      node.style.height = "auto";
      node.style.height = `${Math.min(node.scrollHeight, 250)}px`;
    }
  }, [draft]);

  async function submit(event?: FormEvent, now = false) {
    event?.preventDefault();
    const content = draft.trim();
    if ((!content && !files.length) || unavailable || submittingRef.current || supplementBusy || uploadingRef.current)
      return;
    submittingRef.current = true;
    setDraft("");
    setSubmitting(true);
    const accepted = await (now && onSubmitNow
      ? onSubmitNow(content, files)
      : onSubmit(content, files));
    setSubmitting(false);
    submittingRef.current = false;
    if (!accepted) setDraft((current) => current || content);
    else setFiles([]);
  }
  async function supplement() {
    const content = draft.trim();
    if (!onSupplement || !content || files.length || unavailable || submittingRef.current || supplementBusy || uploadingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const accepted = await onSupplement(content);
      if (mounted.current && accepted && latestDraft.current.draft === draft && !latestDraft.current.files.length) setDraft("");
    } finally {
      submittingRef.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      sendsOnEnter(event) &&
      !event.nativeEvent.isComposing &&
      event.nativeEvent.keyCode !== 229 &&
      !window.matchMedia("(pointer: coarse)").matches
    ) {
      event.preventDefault();
      void submit();
    }
  }
  async function upload(selected: File[]) {
    if (!selected.length || unavailable || submittingRef.current || supplementBusy) return;
    pendingUploads.current.push(...selected);
    if (uploadingRef.current) return;
    uploadingRef.current = true;
    const controller = new AbortController();
    uploadController.current = controller;
    setUploading(true);
    try {
      while (pendingUploads.current.length && mounted.current && !controller.signal.aborted) {
        const file = pendingUploads.current.shift()!;
        try {
          const result = await api.upload(file, controller.signal);
          if (mounted.current && !controller.signal.aborted)
            setFiles((current) => [...current, result]);
        } catch (reason) {
          if (mounted.current && !controller.signal.aborted)
            onError(reason instanceof Error ? reason.message : t("error.upload"));
        }
      }
    } finally {
      if (uploadController.current === controller) {
        uploadController.current = null;
        uploadingRef.current = false;
        if (mounted.current) setUploading(false);
      }
    }
  }
  const attachmentsBlocked = unavailable || submitting || supplementBusy;
  function acceptTransfer(data: DataTransfer) {
    const { files, directories } = transferFiles(data);
    if (directories) onError(t("composer.foldersUnsupported"));
    void upload(files);
  }
  function dragEnter(event: DragEvent<HTMLFormElement>) {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current += 1;
    if (!attachmentsBlocked) setDragging(true);
  }
  function dragOver(event: DragEvent<HTMLFormElement>) {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = attachmentsBlocked ? "none" : "copy";
  }
  function dragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  }
  function drop(event: DragEvent<HTMLFormElement>) {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!unavailable && !submittingRef.current && !supplementBusy)
      acceptTransfer(event.dataTransfer);
  }
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!hasFiles(event.clipboardData)) return;
    // Let the browser insert mixed clipboard text at the existing selection.
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    if (!unavailable && !submittingRef.current && !supplementBusy)
      acceptTransfer(event.clipboardData);
  }
  function toggleVoice() {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const Constructor = recognitionConstructor();
    if (!Constructor) return;
    const instance = new Constructor();
    instance.lang = getLocale();
    instance.continuous = false;
    instance.interimResults = false;
    instance.onresult = (event) => {
      let text = "";
      for (let i = 0; i < event.results.length; i += 1)
        text += event.results[i][0].transcript;
      setDraft((current) => (current ? `${current}\n${text}` : text));
    };
    instance.onend = () => setListening(false);
    instance.onerror = () => {
      setListening(false);
      onError(t("error.microphone"));
    };
    recognition.current = instance;
    try {
      instance.start();
      setListening(true);
    } catch {
      onError(t("error.microphone"));
    }
  }

  const canSend = Boolean(draft.trim() || files.length) && !unavailable && !submitting && !supplementBusy && !uploading;
  return (
    <form className="composer" ref={rootRef} onSubmit={(event) => void submit(event)}
      data-dragging={dragging && !attachmentsBlocked || undefined}
      onDragEnter={dragEnter} onDragOver={dragOver} onDragLeave={dragLeave} onDrop={drop}>
      {dragging && !attachmentsBlocked && <div className="composer-drop-target" role="status">
        <FileUp className="ic" />
        <span>{t("composer.dropFiles")}</span>
      </div>}
      {files.length > 0 && (
        <div className="composer-files">
          {files.map((file) => (
            <div className={`composer-file ${file.mime_type.startsWith("image/") ? "composer-image" : ""}`} key={file.id}>
              {file.mime_type.startsWith("image/") ? <img src={file.url} alt={file.name} /> : <Paperclip className="ic" />}
              <span>
                <strong>{file.name}</strong>
                <small>{sizeText(file.size)}</small>
              </span>
              <button type="button" className="icon-btn sm" onClick={() => setFiles((current) => current.filter((item) => item.id !== file.id))} aria-label={t("file.remove", { name: file.name })}>
                <X className="ic" />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={inputRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={keyDown}
        onPaste={paste}
        rows={1}
        placeholder={onSupplement ? t("composer.supplementPlaceholder") : t("composer.placeholder")}
        aria-label={t("composer.messageLabel")}
      />
      <div className="composer-bar">
        <input ref={fileRef} type="file" multiple hidden onChange={(event) => {
          const selected = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          void upload(selected);
        }} />
        <input ref={imageRef} type="file" accept="image/*" multiple hidden onChange={(event) => {
          const selected = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          void upload(selected);
        }} />
        <Menu.Root>
          <Menu.Trigger className={`icon-btn sm${uploading ? " btn-progress" : ""}`} aria-label={uploading ? t("composer.uploading") : t("composer.addFile")} title={uploading ? t("composer.uploading") : t("composer.addFile")} disabled={uploading || attachmentsBlocked}>
            <Plus className="ic" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner className="pop-positioner" side="top" sideOffset={8} align="start">
              <Menu.Popup className="pop">
                <div className="menu">
                  <Menu.Item className="menu-item" onClick={() => fileRef.current?.click()}><FileUp className="ic" />{t("composer.uploadFile")}</Menu.Item>
                  <Menu.Item className="menu-item" onClick={() => imageRef.current?.click()}><ImagePlus className="ic" />{t("composer.uploadImage")}</Menu.Item>
                </div>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        <button
          type="button"
          role="switch"
          className={`chip-btn computer-chip-btn${computerUpdating ? " btn-progress" : ""}`}
          aria-label={t("computer.allow")}
          aria-checked={computerEnabled}
          aria-pressed={computerEnabled}
          data-pending={computerUpdating || undefined}
          title={computerOnce ? t("computer.allowOnce") : computerEnabled ? t("computer.allowOn") : t("computer.allowOff")}
          disabled={unavailable || computerUpdating}
          onClick={() => onComputer(!computerEnabled)}
        >
          <Monitor className="ic" />
          <span className="chip-label">{computerOnce ? t("computer.once") : t("computer.title")}</span>
        </button>
        <span className="grow" />
        {models.length > 0 && <ModelPicker models={models} value={modelId} disabled={unavailable} onChange={onModel} />}
        {efforts.length > 0 && <EffortPicker efforts={efforts} value={effort} disabled={unavailable} onChange={onEffort} />}
        {configuredReasoning && toggleThinking && !efforts.length && (
          <button type="button" className="chip-btn" aria-pressed={reasoningEnabled} aria-label={t("reasoning.thinking")}
            title={reasoningEnabled ? t("reasoning.on") : t("reasoning.off")} disabled={unavailable} onClick={() => onReasoningEnabled?.(!reasoningEnabled)}>
            <Brain className="ic" />
            <span className="chip-label">{reasoningEnabled ? t("common.on") : t("common.close")}</span>
          </button>
        )}
        {configuredReasoning && budgetThinking && (
          <ThinkingBudget value={budget ?? currentModel?.reasoning_budget_default ?? 2048} min={budgetOption?.min ?? currentModel?.reasoning_budget_min ?? 0} max={budgetOption?.max ?? currentModel?.reasoning_budget_max ?? 100000} disabled={unavailable} onChange={(value) => onBudget?.(value)} />
        )}
        {onSupplement && (
          <button type="button" className="btn sm secondary" aria-label={t("composer.supplementLabel")} title={files.length ? t("composer.supplementNoFiles") : t("composer.supplementLabel")}
            disabled={!draft.trim() || files.length > 0 || unavailable || submitting || supplementBusy || uploading}
            onMouseDown={(event) => event.preventDefault()} onClick={() => void supplement()}>{t("composer.supplement")}</button>
        )}
        {voiceAvailable && (
          <button type="button" className="icon-btn sm" aria-pressed={listening} data-listening={listening || undefined}
            aria-label={listening ? t("composer.stopRecording") : t("composer.voiceInput")} title={t("composer.voiceInput")} onClick={toggleVoice}>
            <Mic className="ic" />
          </button>
        )}
        {busy && onSubmitNow && (draft.trim() || files.length > 0) && (
          <button type="button" className="icon-btn sm" aria-label={t("composer.stopAndSend")} title={t("composer.stopAndSend")}
            disabled={unavailable || submitting || supplementBusy || uploading} onClick={() => void submit(undefined, true)}>
            <SkipForward className="ic" />
          </button>
        )}
        {(!busy || canSend) && (
          <button type="submit" className="send" data-pending={submitting || undefined} aria-label={busy ? t("composer.queue") : t("common.send")} title={busy ? t("composer.queue") : t("common.send")} disabled={!canSend}>
            <ArrowUp className="ic" />
          </button>
        )}
        {busy && (
          <button type="button" className="send" data-mode="stop" aria-label={t("composer.stopTask")} title={t("common.stop")} disabled={stopping || unavailable} onClick={onStop}>
            <Square className="ic" />
          </button>
        )}
      </div>
    </form>
  );
});
