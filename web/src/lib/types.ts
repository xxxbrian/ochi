export type User = {
  id: string;
  username: string;
  display_name: string;
  role: "admin" | "user";
  enabled?: boolean;
};

export type UserPreferences = {
  memory_enabled: boolean;
  computer_default: boolean;
};

export type ReasoningOption = {
  type: "toggle" | "effort" | "budget_tokens";
  values?: string[];
  min?: number;
  max?: number;
};

export type Model = {
  kind?: "chat" | "embedding" | "image";
  id: string;
  name: string;
  provider_id: string;
  provider_name?: string;
  model: string;
  source?: "remote" | "custom" | "catalog";
  enabled: boolean;
  available?: boolean;
  is_default: boolean;
  context_window: number;
  max_output_tokens?: number;
  supports_tools: boolean;
  supports_vision: boolean;
  supports_image_generation?: boolean;
  image_config?: {
    size?: string;
    quality?: string;
    output_format?: "png" | "jpeg" | "webp";
    background?: "auto" | "opaque" | "transparent";
    supports_edit?: boolean;
  };
  modalities?: { input?: string[]; output?: string[] };
  structured_output?: boolean;
  efforts: string[];
  default_effort: string;
  reasoning_kind?:
    | "unknown"
    | "none"
    | "effort"
    | "toggle"
    | "budget"
    | "always";
  reasoning_options?: ReasoningOption[];
  reasoning_budget_min?: number;
  reasoning_budget_max?: number;
  reasoning_budget_default?: number;
  effort_parameter?: string;
  effort_mapping?: Record<string, unknown>;
  metadata_source?: string;
  metadata_updated_at?: string;
  catalog_provider_id?: string;
  catalog_model_id?: string;
  last_test?: {
    ok: boolean;
    status?: number;
    error?: string;
    checked_at?: string;
    effort?: string;
    parameter_accepted?: boolean;
  };
  metadata_overrides?: Record<string, boolean>;
  metadata_known?: Record<string, boolean>;
  metadata_match?: string;
  icon?: string;
  provider_icon?: string;
};

export type CatalogModel = {
  id: string;
  name: string;
  provider_id: string;
  canonical_model_id?: string;
  type?: string;
  tool_call?: boolean;
  reasoning?: boolean;
  reasoning_options?: ReasoningOption[];
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context: number; output: number };
};
export type Provider = {
  id: string;
  name: string;
  base_url: string;
  protocol: string;
  enabled: boolean;
  has_api_key: boolean;
  timeout_seconds?: number;
  discover_models?: boolean;
  allow_no_key?: boolean;
  catalog_provider_id?: string;
  headers?: Record<string, string>;
  header_names?: string[];
  last_sync_at?: string;
  status?: string;
  error?: string;
  icon?: string;
  sync_error?: string;
  imported?: number;
};
export type Artifact = {
  id: string;
  name: string;
  path: string;
  mime_type: string;
  size: number;
  url: string;
  created_at: string;
  source_path?: string;
  version?: number;
  generation?: {
    prompt: string;
    revised_prompt?: string;
    model_id: string;
    model_name: string;
    size?: string;
    quality?: string;
    output_format?: string;
    width?: number;
    height?: number;
  };
};
export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  cache_read_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
};
export type Memory = {
  id: string;
  content: string;
  kind?: "fact" | "preference" | "session_summary" | "project_summary";
  project_id?: string;
  source_session_id?: string;
  source_run_id?: string;
  source_excerpt?: string;
  source?: "user" | "automatic" | "agent";
  created_at: string;
  updated_at?: string;
  has_embedding?: boolean;
};
export type Schedule = {
  id: string;
  name: string;
  prompt: string;
  recurrence?: "interval" | "once" | "daily" | "weekly";
  timezone?: string;
  time_of_day?: string;
  weekdays?: number[];
  once_at?: string;
  session_id?: string;
  project_id?: string;
  model_id?: string;
  effort?: string;
  context_mode?: "independent" | "session";
  interval_minutes: number;
  enabled: boolean;
  last_run_at?: string;
  next_run_at?: string;
  last_run_id?: string;
  last_error?: string;
  last_status?: string;
  execution_count?: number;
};
export type ScheduleExecution = {
  id: string;
  schedule_id: string;
  run_id?: string;
  session_id?: string;
  status:
    | "running"
    | "queued"
    | "completed"
    | "skipped"
    | "failed"
    | "cancelled";
  error?: string;
  output?: string;
  artifacts?: Artifact[];
  started_at?: string;
  finished_at?: string;
  snapshot?: Snapshot;
};
export type Skill = {
  id: string;
  name: string;
  description: string;
  version?: string;
  source?: string;
  ref?: string;
  subdir?: string;
  path?: string;
  enabled: boolean;
  installed_at?: string;
  updated_at?: string;
  content?: string;
  compatibility?: string;
  files: { path: string; size: number }[];
};
export type SkillDetail = Skill & { content: string };
export type MCPServer = {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  enabled: boolean;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  env_keys?: string[];
  header_keys?: string[];
  tools?: unknown[];
  status?: string;
  error?: string;
  updated_at?: string;
};
export type Plugin = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  default_enabled: boolean;
  skill_ids: string[];
  mcp_ids: string[];
  created_at: string;
  updated_at: string;
  effective_enabled?: boolean;
  locked?: boolean;
};
export type PluginConfig = Pick<
  Plugin,
  "id" | "name" | "description" | "enabled" | "default_enabled" | "skill_ids" | "mcp_ids"
>;
export type PluginComponent = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
};
export type PluginComponents = {
  skills: PluginComponent[];
  mcp: PluginComponent[];
};
export type Workspace = {
  user_id: string;
  container: string;
  state: string;
  running: boolean;
  image: string;
};
export type Project = {
  id: string;
  name: string;
  instructions?: string;
  workspace_path?: string;
  created_at: string;
  updated_at: string;
  session_count?: number;
};
export type ProjectDetail = Project & {
  sessions: Session[];
  next_cursor?: string;
};
export type PendingRun = {
  run_id: string;
  session_id: string;
  status: "queued";
  message: string;
  model_id?: string;
  model_name?: string;
  effort?: string;
  attachment_ids?: string[];
  created_at: string;
};
export type ComputerState = {
  available: boolean;
  session_id?: string;
  owner_session_id?: string;
  owner_run_id?: string;
  owner_status?: RunStatus;
  owner_title?: string;
  busy?: boolean;
  control_enabled: boolean;
  view_only: boolean;
  desktop_url?: string;
};
export type ComputerPermissionAnswer = "allow_once" | "allow_session" | "deny";
export type WaitingInput = {
  kind?: "question" | "computer_permission";
  question: string;
  options?: string[];
};

export type SessionPage = {
  items: Session[];
  next_cursor?: string;
};

export type Session = {
  id: string;
  title: string;
  title_source?: "pending" | "automatic" | "manual" | "fallback";
  excerpt?: string;
  project_name?: string;
  created_at: string;
  updated_at: string;
  model_id?: string;
  effort?: string;
  project_id?: string;
  workspace_path?: string;
  computer_enabled: boolean;
  run_status?: RunStatus | "queued" | "waiting_resource";
  active_run_id?: string;
  queued_count?: number;
  latest_run?: Snapshot | null;
};

export type Message = {
  id: string;
  run_id?: string;
  run_status?: RunStatus;
  run_created_at?: string;
  run_updated_at?: string;
  role: "user" | "assistant" | "system";
  content: string;
  step_count?: number;
  has_reasoning?: boolean;
  has_process?: boolean;
  created_at: string;
  model_id?: string;
  model_name?: string;
  effort?: string;
  attachments?: Artifact[];
};

export type RunStatus =
  | "running"
  | "queued"
  | "waiting_user"
  | "waiting_resource"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

export type Step = {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  arguments?: Record<string, unknown> | null;
  output?: string;
  screenshot?: string;
  duration_ms?: number;
};

export type Snapshot = {
  run_id: string;
  session_id: string;
  status: RunStatus;
  output: string;
  reasoning?: ReasoningPart[];
  timeline: ProcessEntry[];
  error?: string;
  seq: number;
  created_at: string;
  updated_at: string;
  steps: Step[];
  model_id?: string;
  model_name?: string;
  effort?: string;
  usage?: Usage;
  waiting_input?: WaitingInput;
  computer_granted?: boolean;
  resource?: string;
  artifacts?: Artifact[];
};

export type ReasoningPart = {
  id: string;
  kind: "reasoning" | "summary";
  text: string;
  done: boolean;
};

export type ProcessEntry = {
  id: string;
  seq: number;
  kind: "reasoning" | "progress" | "tool";
  reasoning?: ReasoningPart;
  text?: string;
  pending?: boolean;
  final?: boolean;
  step?: Step;
};

export type ProcessEventFields = {
  updated_at: string;
  timeline_entry?: ProcessEntry;
  timeline?: ProcessEntry[];
};

export type ReasoningDelta = ProcessEventFields & {
  type: "reasoning_delta";
  run_id: string;
  seq: number;
  reasoning: ReasoningPart;
};

export type AdminRun = Pick<
  Snapshot,
  | "run_id"
  | "session_id"
  | "status"
  | "model_name"
  | "effort"
  | "error"
  | "usage"
  | "updated_at"
> & {
  user_id: string;
  username: string;
  display_name: string;
  session_title: string;
  prompt: string;
  model_id: string;
  provider_name: string;
  duration_ms: number;
  step_count: number;
  artifact_count: number;
  created_at: string;
};

export type AdminRunFilter = {
  q?: string;
  status?: string;
  model_id?: string;
  user_id?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};
export type AdminRunPage = {
  items: AdminRun[];
  total: number;
  limit: number;
  offset: number;
};
export type AdminRunDetail = AdminRun & {
  output: string;
  steps: Step[];
  artifacts: Artifact[];
  resource?: string;
  archived: boolean;
};
export type AdminModelUsage = {
  model_id: string;
  model_name: string;
  provider_name: string;
  runs: number;
  failed: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number | null;
};
export type AdminRunStats = {
  runs: number;
  completed: number;
  failed: number;
  interrupted: number;
  cancelled: number;
  active: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number | null;
  usage_reported_runs: number;
  average_duration_ms: number | null;
  from: string;
  to: string;
  models: AdminModelUsage[];
};

export type TextDelta = ProcessEventFields & {
  type: "text_delta";
  run_id: string;
  seq: number;
  text: string;
};
export type StepEvent = ProcessEventFields & {
  type: "step";
  run_id: string;
  seq: number;
  step: Step;
};
export type StatusEvent = ProcessEventFields & {
  type: "status";
  run_id: string;
  seq: number;
  status: RunStatus;
  error?: string;
  computer_granted?: boolean;
};
export type OutputReset = ProcessEventFields & {
  type: "output_reset";
  run_id: string;
  seq: number;
};
export type OutputCommit = ProcessEventFields & {
  type: "output_commit";
  run_id: string;
  seq: number;
  text: string;
};
export type ProgressEvent = ProcessEventFields & {
  type: "progress";
  run_id: string;
  seq: number;
  text?: string;
};
export type UsageEvent = ProcessEventFields & {
  type: "usage";
  run_id: string;
  seq: number;
  usage: Usage;
};
export type WaitingEvent = ProcessEventFields & {
  type: "waiting";
  run_id: string;
  seq: number;
  status: RunStatus;
  waiting_input: WaitingInput;
  computer_granted?: boolean;
  resource?: string;
};
export type ArtifactsEvent = ProcessEventFields & {
  type: "artifacts";
  run_id: string;
  seq: number;
  artifacts: Artifact[];
};
export type ApiError = Error & { status?: number; detail?: string };

export type RunInstruction = {
  id: string;
  content: string;
  client_key: string;
  created_at: string;
  canonical_seq?: number;
  queued_run_id?: string;
  status: "pending" | "applied" | "queued" | "not_applied";
  run_status?: RunStatus;
};
