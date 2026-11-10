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
  const [listening, setListening] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const recognition = useRef<Recognition | null>(null);
  const rootRef = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
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
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
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
    if ((!content && !files.length) || unavailable || submitting || supplementBusy || uploading)
      return;
    setDraft("");
    setSubmitting(true);
    const accepted = await (now && onSubmitNow
      ? onSubmitNow(content, files)
      : onSubmit(content, files));
    setSubmitting(false);
    if (!accepted) setDraft((current) => current || content);
    else setFiles([]);
  }
  async function supplement() {
    const content = draft.trim();
    if (!onSupplement || !content || files.length || unavailable || submitting || supplementBusy || uploading) return;
    setSubmitting(true);
    try {
      const accepted = await onSupplement(content);
      if (mounted.current && accepted && latestDraft.current.draft === draft && !latestDraft.current.files.length) setDraft("");
    } finally {
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
  async function upload(selected: FileList | null) {
    if (!selected?.length || uploading) return;
    setUploading(true);
    try {
      for (const file of Array.from(selected)) {
        const result = await api.upload(file);
        setFiles((current) => [...current, result]);
      }
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : t("error.upload"));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
      if (imageRef.current) imageRef.current.value = "";
    }
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
    <form className="composer" ref={rootRef} onSubmit={(event) => void submit(event)}>
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
        rows={1}
        placeholder={onSupplement ? t("composer.supplementPlaceholder") : t("composer.placeholder")}
        aria-label={t("composer.messageLabel")}
      />
      <div className="composer-bar">
        <input ref={fileRef} type="file" multiple hidden onChange={(event) => void upload(event.target.files)} />
        <input ref={imageRef} type="file" accept="image/*" multiple hidden onChange={(event) => void upload(event.target.files)} />
        <Menu.Root>
          <Menu.Trigger className={`icon-btn sm${uploading ? " btn-progress" : ""}`} aria-label={uploading ? t("composer.uploading") : t("composer.addFile")} title={uploading ? t("composer.uploading") : t("composer.addFile")} disabled={uploading || unavailable}>
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
