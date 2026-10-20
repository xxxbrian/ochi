import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  ArrowUp,
  Brain,
  LoaderCircle,
  Mic,
  Monitor,
  Paperclip,
  Plus,
  Square,
  SkipForward,
  X,
} from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import type { Artifact, Model } from "../lib/types";
import { api } from "../lib/api";
import type { InstructionAcceptance } from "../lib/runInstructions";
import { SelectField } from "./ui/Select";
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

export function effortLabel(effort: string) {
  return effort || "Provider default";
}

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
function ThinkingBudget({
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const [draftBudget, setDraftBudget] = useState(String(value));
  useEffect(() => setDraftBudget(String(value)), [value]);
  function commitBudget() {
    const parsed = Number(draftBudget);
    const next = draftBudget.trim() && Number.isFinite(parsed)
      ? Math.min(max, Math.max(min, Math.round(parsed)))
      : value;
    setDraftBudget(String(next));
    onChange(next);
  }
  return <Popover.Root>
    <Popover.Trigger type="button" className="ochi-composer__budget-trigger" disabled={disabled} aria-label="思考预算" title={`思考预算 · ${value} tokens`}>
      <Brain size={18} />
      <span>{value.toLocaleString()}</span>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner className="choice-positioner" side="top" sideOffset={7} align="start">
        <Popover.Popup className="ochi-composer__budget-popup">
          <div className="ochi-composer__budget-heading">
            <Popover.Title>思考预算</Popover.Title>
            <Popover.Close className="icon-button" aria-label="关闭"><X size={16} /></Popover.Close>
          </div>
          <label>
            <input type="number" aria-label="Thinking token budget" min={min} max={max} step={512} value={draftBudget} onChange={(event) => setDraftBudget(event.target.value)} onBlur={commitBudget} onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); commitBudget(); }
            }} />
            <span>tokens</span>
          </label>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
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
  const [draft, setDraft] = useState(initialDraft ?? readDraft(draftKey));
  const [submitting, setSubmitting] = useState(false);
  const [files, setFiles] = useState<Artifact[]>([]);
  const [uploading, setUploading] = useState(false);
  const [listening, setListening] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recognition = useRef<Recognition | null>(null);
  const rootRef = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
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
      event.key === "Enter" &&
      !event.shiftKey &&
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
      onError(reason instanceof Error ? reason.message : "上传失败");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
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
    instance.lang = "zh-CN";
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
      onError("未能使用麦克风");
    };
    recognition.current = instance;
    try {
      instance.start();
      setListening(true);
    } catch {
      onError("未能使用麦克风");
    }
  }

  return (
    <form
      className="composer ochi-composer"
      ref={rootRef}
      onSubmit={(event) => void submit(event)}
    >
      {files.length > 0 && (
        <div className="composer-files">
          {files.map((file) => (
            <div className={`composer-file ${file.mime_type.startsWith("image/") ? "composer-image" : ""}`} key={file.id}>
              {file.mime_type.startsWith("image/") ? <img src={file.url} alt={file.name} /> : <Paperclip size={15} />}
              <span>
                <strong>{file.name}</strong>
                <small>{sizeText(file.size)}</small>
              </span>
              <button
                type="button"
                className="icon-button"
                onClick={() =>
                  setFiles((current) =>
                    current.filter((item) => item.id !== file.id),
                  )
                }
                aria-label={`移除 ${file.name}`}
              >
                <X size={15} />
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
        placeholder={onSupplement ? "补充内容…" : "你想做些什么？"}
        aria-label="发消息"
      />
      <div className="ochi-composer__toolbar">
        <div className="ochi-composer__tools">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(event) => void upload(event.target.files)}
          />
          <button
            type="button"
            className="icon-button"
            aria-label="添加文件"
            title="添加文件"
            disabled={uploading || unavailable}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? (
              <LoaderCircle size={18} className="spin" />
            ) : (
              <Plus size={18} />
            )}
          </button>
          {models.length > 0 && (
            <div className="ochi-composer__model" title={currentModel?.name || "选择模型"}>
              <SelectField
                compact
                label="选择模型"
                title={currentModel?.name || "选择模型"}
                icon={<BrandIcon src={currentModel?.icon || currentModel?.provider_icon} size={18} />}
                value={modelId}
                onChange={onModel}
                disabled={unavailable}
                options={models.map((model) => ({
                  value: model.id,
                  label: model.name,
                  detail: model.provider_name,
                  icon: <BrandIcon src={model.icon || model.provider_icon} size={18} />,
                }))}
              />
            </div>
          )}
          {efforts.length > 0 && (
            <div className="ochi-composer__reasoning" title={`思考程度 · ${effort || "默认"}`}>
              <SelectField
                compact
                label="思考程度"
                title={`思考程度 · ${effort || "默认"}`}
                icon={<Brain size={18} />}
                value={effort}
                onChange={onEffort}
                disabled={unavailable}
                options={[{ value: "", label: "默认" }, ...efforts.map((value) => ({ value, label: value }))]}
              />
              {effort && <span className="ochi-composer__effort-dot" aria-hidden="true" />}
            </div>
          )}
          {configuredReasoning && toggleThinking && !efforts.length && (
            <button
              type="button"
              className={`effort-button ochi-composer__reasoning-toggle ${reasoningEnabled ? "is-active" : ""}`}
              aria-pressed={reasoningEnabled}
              aria-label="思考"
              title={reasoningEnabled ? "思考 · 开启" : "思考 · 关闭"}
              disabled={unavailable}
              onClick={() => onReasoningEnabled?.(!reasoningEnabled)}
            >
              <Brain size={18} />
              <span>{reasoningEnabled ? "开启" : "关闭"}</span>
            </button>
          )}
          {configuredReasoning && budgetThinking && (
            <ThinkingBudget value={budget ?? currentModel?.reasoning_budget_default ?? 2048} min={budgetOption?.min ?? currentModel?.reasoning_budget_min ?? 0} max={budgetOption?.max ?? currentModel?.reasoning_budget_max ?? 100000} disabled={unavailable} onChange={(value) => onBudget?.(value)} />
          )}
          <button
            type="button"
            role="switch"
            className={`computer-switch ochi-composer__computer ${computerEnabled ? "is-active" : ""} ${computerUpdating ? "is-pending" : ""}`}
            aria-label="允许使用电脑"
            aria-checked={computerEnabled}
            title={computerOnce ? "允许使用电脑 · 仅本次" : computerEnabled ? "允许使用电脑 · 开启" : "允许使用电脑 · 关闭"}
            disabled={unavailable || computerUpdating}
            onClick={() => onComputer(!computerEnabled)}
          >
            {computerUpdating ? (
              <LoaderCircle size={18} className="spin" />
            ) : (
              <Monitor size={18} />
            )}
            <span className="ochi-composer__computer-label">{computerOnce ? "电脑·本次" : "电脑"}</span>
            <span className="ochi-composer__switch-track" aria-hidden="true"><span /></span>
          </button>
        </div>
        <div className="ochi-composer__send-tools">
          {onSupplement && (
            <button type="button" className="ochi-composer__supplement"
              aria-label="补充当前任务要求" title={files.length ? "补充要求暂不支持附件" : "补充当前任务要求"}
              disabled={!draft.trim() || files.length > 0 || unavailable || submitting || supplementBusy || uploading}
              onMouseDown={(event) => event.preventDefault()} onClick={() => void supplement()}>补充</button>
          )}
          {voiceAvailable && (
            <button
              type="button"
              className={`icon-button voice-button ${listening ? "is-listening" : ""}`}
              aria-label={listening ? "停止录音" : "语音输入"}
              title="语音输入"
              onClick={toggleVoice}
            >
              <Mic size={19} />
            </button>
          )}
          {busy && (
            <button
              type="button"
              className="icon-button stop-run-button"
              aria-label="停止当前任务"
              title="停止"
              disabled={stopping || unavailable}
              onClick={onStop}
            >
              <Square size={15} fill="currentColor" />
            </button>
          )}
          {busy && onSubmitNow && (draft.trim() || files.length > 0) && (
            <button
              type="button"
              className="icon-button ochi-composer__send-now"
              aria-label="停止并立即发送"
              title="停止并立即发送"
              disabled={unavailable || submitting || supplementBusy || uploading}
              onClick={() => void submit(undefined, true)}
            >
              <SkipForward size={17} />
            </button>
          )}
          <button
            type="submit"
            className="send-button"
            aria-label={busy ? "排队发送" : "发送"}
            title={busy ? "排队发送" : "发送"}
            disabled={
              (!draft.trim() && !files.length) ||
              unavailable ||
              submitting ||
              supplementBusy ||
              uploading
            }
          >
            {submitting ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <ArrowUp size={19} />
            )}
          </button>
        </div>
      </div>
    </form>
  );
});
