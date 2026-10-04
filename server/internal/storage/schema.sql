-- Current schema for a new installation. Existing deployments are updated explicitly.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE TABLE app_settings (
    id boolean DEFAULT true NOT NULL,
    system_prompt text DEFAULT ''::text NOT NULL,
    max_tool_rounds integer DEFAULT 48 NOT NULL,
    compaction_model_id text DEFAULT ''::text NOT NULL,
    memory_model_id text DEFAULT ''::text NOT NULL,
    embedding_model_id text DEFAULT ''::text NOT NULL,
    title_model_id text DEFAULT ''::text NOT NULL,
    image_model_id text DEFAULT ''::text NOT NULL,
    embedding_revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT app_settings_id_check CHECK (id)
);

CREATE TABLE artifacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    session_id uuid,
    run_id uuid,
    name text NOT NULL,
    path text NOT NULL,
    mime_type text DEFAULT 'application/octet-stream'::text NOT NULL,
    size bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_path text DEFAULT ''::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    storage_key text DEFAULT ''::text NOT NULL,
    generation jsonb
);

CREATE TABLE canonical_messages (
    seq bigint NOT NULL,
    session_id uuid NOT NULL,
    run_id uuid,
    model_id text DEFAULT ''::text NOT NULL,
    provider_id text DEFAULT ''::text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived boolean DEFAULT false NOT NULL
);

ALTER TABLE canonical_messages ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME canonical_messages_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE context_compactions (
    session_id uuid NOT NULL,
    through_seq bigint NOT NULL,
    summary text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE login_sessions (
    token_hash text NOT NULL,
    user_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

CREATE TABLE memories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text DEFAULT 'fact'::text NOT NULL,
    project_id uuid,
    source text DEFAULT 'user'::text NOT NULL,
    source_session_id uuid,
    source_run_id uuid,
    source_excerpt text DEFAULT ''::text NOT NULL,
    embedding vector,
    embedding_model_id text DEFAULT ''::text NOT NULL,
    trust text DEFAULT 'derived'::text NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    superseded_at timestamp with time zone,
    superseded_by uuid,
    embedding_revision bigint DEFAULT 0 NOT NULL
);

CREATE TABLE memory_embedding_dimensions (
    model_id text NOT NULL,
    dimensions integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_embedding_dimensions_dimensions_check CHECK (((dimensions >= 1) AND (dimensions <= 16000)))
);

CREATE TABLE memory_index_jobs (
    user_id text NOT NULL,
    model_id text NOT NULL,
    target_identity text NOT NULL,
    embedding_revision bigint NOT NULL,
    memory_revision bigint NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_until timestamp with time zone,
    lease_token uuid,
    last_error text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_index_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'leased'::text, 'completed'::text, 'skipped'::text, 'failed'::text])))
);

CREATE TABLE memory_jobs (
    run_id uuid NOT NULL,
    user_id text NOT NULL,
    session_id uuid NOT NULL,
    memory_revision bigint NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_until timestamp with time zone,
    lease_token uuid,
    last_error text DEFAULT ''::text NOT NULL,
    extraction jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'leased'::text, 'completed'::text, 'skipped'::text, 'failed'::text])))
);

CREATE TABLE memory_tombstones (
    user_id text NOT NULL,
    scope_id text DEFAULT ''::text NOT NULL,
    content_hash text NOT NULL,
    deleted_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    run_id uuid,
    role text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    model_id text DEFAULT ''::text NOT NULL,
    model_name text DEFAULT ''::text NOT NULL,
    effort text DEFAULT ''::text NOT NULL,
    attachments jsonb DEFAULT '[]'::jsonb NOT NULL,
    archived boolean DEFAULT false NOT NULL
);

CREATE TABLE models (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id uuid NOT NULL,
    name text NOT NULL,
    model text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    context_window integer DEFAULT 64000 NOT NULL,
    supports_tools boolean DEFAULT true NOT NULL,
    supports_vision boolean DEFAULT false NOT NULL,
    efforts jsonb DEFAULT '[]'::jsonb NOT NULL,
    default_effort text DEFAULT ''::text NOT NULL,
    effort_parameter text DEFAULT ''::text NOT NULL,
    effort_mapping jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'custom'::text NOT NULL,
    kind text DEFAULT 'chat'::text NOT NULL,
    available boolean DEFAULT true NOT NULL,
    max_output_tokens integer DEFAULT 0 NOT NULL,
    modalities jsonb DEFAULT '{"input": ["text"], "output": ["text"]}'::jsonb NOT NULL,
    structured_output boolean DEFAULT false NOT NULL,
    reasoning_kind text DEFAULT 'unknown'::text NOT NULL,
    reasoning_options jsonb DEFAULT '[]'::jsonb NOT NULL,
    reasoning_budget_min integer DEFAULT 0 NOT NULL,
    reasoning_budget_max integer DEFAULT 0 NOT NULL,
    reasoning_budget_default integer DEFAULT 0 NOT NULL,
    metadata_source text DEFAULT 'admin'::text NOT NULL,
    metadata_updated_at timestamp with time zone,
    catalog_provider_id text DEFAULT ''::text NOT NULL,
    catalog_model_id text DEFAULT ''::text NOT NULL,
    last_test jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata_overrides jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata_known jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata_match text DEFAULT ''::text NOT NULL,
    supports_image_generation boolean DEFAULT false NOT NULL,
    image_config jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE plugin_components (
    plugin_id text NOT NULL,
    kind text NOT NULL,
    component_id text NOT NULL,
    CONSTRAINT plugin_components_kind_check CHECK ((kind = ANY (ARRAY['skills'::text, 'mcp'::text])))
);

CREATE TABLE plugins (
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    default_enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT plugins_description_check CHECK ((octet_length(description) <= 4000)),
    CONSTRAINT plugins_id_check CHECK ((id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'::text)),
    CONSTRAINT plugins_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 100)))
);

CREATE TABLE projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    instructions text DEFAULT ''::text NOT NULL,
    workspace_path text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    protocol text DEFAULT 'openai'::text NOT NULL,
    base_url text NOT NULL,
    api_key text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    headers jsonb DEFAULT '{}'::jsonb NOT NULL,
    timeout_seconds integer DEFAULT 480 NOT NULL,
    discover_models boolean DEFAULT true NOT NULL,
    allow_no_key boolean DEFAULT false NOT NULL,
    catalog_provider_id text DEFAULT ''::text NOT NULL,
    last_synced_at timestamp with time zone,
    last_test jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE run_context_inspections (
    run_id uuid NOT NULL,
    round text NOT NULL,
    inspection jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE run_diagnostics (
    id bigint NOT NULL,
    run_id uuid NOT NULL,
    event jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE run_diagnostics ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME run_diagnostics_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE run_instructions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    user_id text NOT NULL,
    client_key text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    canonical_seq bigint,
    queued_run_id uuid
);

CREATE TABLE run_requests (
    run_id uuid NOT NULL,
    user_id text NOT NULL,
    session_id uuid NOT NULL,
    message text NOT NULL,
    model_id text DEFAULT ''::text NOT NULL,
    effort text DEFAULT ''::text NOT NULL,
    attachment_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    revision jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL
);

CREATE TABLE runs (
    id uuid NOT NULL,
    session_id uuid NOT NULL,
    status text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    output text DEFAULT ''::text NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    seq bigint DEFAULT 0 NOT NULL,
    model_id text DEFAULT ''::text NOT NULL,
    model_name text DEFAULT ''::text NOT NULL,
    effort text DEFAULT ''::text NOT NULL,
    artifacts jsonb DEFAULT '[]'::jsonb NOT NULL,
    usage jsonb DEFAULT '{}'::jsonb NOT NULL,
    waiting_input jsonb,
    archived boolean DEFAULT false NOT NULL,
    resource text DEFAULT ''::text NOT NULL,
    schedule_id uuid,
    computer_granted boolean DEFAULT false NOT NULL,
    reasoning jsonb DEFAULT '[]'::jsonb NOT NULL,
    timeline jsonb DEFAULT '[]'::jsonb NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL
);

CREATE TABLE schedule_executions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    schedule_id uuid NOT NULL,
    run_id uuid,
    session_id uuid,
    status text DEFAULT 'queued'::text NOT NULL,
    error text DEFAULT ''::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone
);

CREATE TABLE schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    session_id uuid NOT NULL,
    name text NOT NULL,
    prompt text NOT NULL,
    interval_minutes integer NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    next_run_at timestamp with time zone NOT NULL,
    last_run_at timestamp with time zone,
    last_run_id uuid,
    last_error text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    recurrence text DEFAULT 'interval'::text NOT NULL,
    timezone text DEFAULT 'Asia/Shanghai'::text NOT NULL,
    time_of_day text DEFAULT '09:00'::text NOT NULL,
    weekdays jsonb DEFAULT '[1, 2, 3, 4, 5, 6, 7]'::jsonb NOT NULL,
    once_at timestamp with time zone,
    project_id uuid,
    model_id uuid,
    effort text DEFAULT ''::text NOT NULL,
    context_mode text DEFAULT 'independent'::text NOT NULL,
    CONSTRAINT schedules_interval_minutes_check CHECK (((interval_minutes >= 1) AND (interval_minutes <= 525600)))
);

CREATE TABLE search_settings (
    id boolean DEFAULT true NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    provider text DEFAULT 'exa'::text NOT NULL,
    base_url text DEFAULT 'https://api.exa.ai'::text NOT NULL,
    api_key text DEFAULT ''::text NOT NULL,
    max_results integer DEFAULT 6 NOT NULL,
    timeout_seconds integer DEFAULT 20 NOT NULL,
    CONSTRAINT search_settings_id_check CHECK (id),
    CONSTRAINT search_settings_max_results_check CHECK (((max_results >= 1) AND (max_results <= 20))),
    CONSTRAINT search_settings_timeout_seconds_check CHECK (((timeout_seconds >= 3) AND (timeout_seconds <= 60)))
);

CREATE TABLE session_tasks (
    session_id uuid NOT NULL,
    user_id text NOT NULL,
    state jsonb NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text DEFAULT '新对话'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id text NOT NULL,
    model_id uuid,
    effort text DEFAULT ''::text NOT NULL,
    system_prompt text DEFAULT ''::text NOT NULL,
    project_id uuid,
    workspace_path text DEFAULT ''::text NOT NULL,
    memory_context text,
    source text DEFAULT 'chat'::text NOT NULL,
    computer_enabled boolean DEFAULT false NOT NULL,
    title_source text DEFAULT 'pending'::text NOT NULL,
    title_attempts integer DEFAULT 0 NOT NULL,
    title_claimed_at timestamp with time zone,
    memory_profile_expires_at timestamp with time zone
);

CREATE TABLE user_plugins (
    user_id text NOT NULL,
    plugin_id text NOT NULL,
    enabled boolean NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE user_preferences (
    user_id text NOT NULL,
    memory_enabled boolean DEFAULT true NOT NULL,
    memory_revision bigint DEFAULT 0 NOT NULL,
    computer_default boolean DEFAULT false NOT NULL
);

CREATE TABLE users (
    id text NOT NULL,
    username text NOT NULL,
    display_name text NOT NULL,
    password_hash text NOT NULL,
    role text DEFAULT 'user'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE verified_skills (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    body text NOT NULL,
    project_id uuid,
    source_session_id uuid,
    source_run_id uuid,
    source_objective text NOT NULL,
    source_task_revision bigint NOT NULL,
    source_evidence jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT verified_skills_body_check CHECK (((octet_length(body) >= 1) AND (octet_length(body) <= 16384)))
);

ALTER TABLE ONLY app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY artifacts
    ADD CONSTRAINT artifacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY artifacts
    ADD CONSTRAINT artifacts_user_id_path_key UNIQUE (user_id, path);

ALTER TABLE ONLY canonical_messages
    ADD CONSTRAINT canonical_messages_pkey PRIMARY KEY (seq);

ALTER TABLE ONLY context_compactions
    ADD CONSTRAINT context_compactions_pkey PRIMARY KEY (session_id);

ALTER TABLE ONLY login_sessions
    ADD CONSTRAINT login_sessions_pkey PRIMARY KEY (token_hash);

ALTER TABLE ONLY memories
    ADD CONSTRAINT memories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY memory_embedding_dimensions
    ADD CONSTRAINT memory_embedding_dimensions_pkey PRIMARY KEY (model_id);

ALTER TABLE ONLY memory_index_jobs
    ADD CONSTRAINT memory_index_jobs_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY memory_jobs
    ADD CONSTRAINT memory_jobs_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY memory_tombstones
    ADD CONSTRAINT memory_tombstones_pkey PRIMARY KEY (user_id, scope_id, content_hash);

ALTER TABLE ONLY messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY models
    ADD CONSTRAINT models_pkey PRIMARY KEY (id);

ALTER TABLE ONLY plugin_components
    ADD CONSTRAINT plugin_components_pkey PRIMARY KEY (kind, component_id);

ALTER TABLE ONLY plugins
    ADD CONSTRAINT plugins_pkey PRIMARY KEY (id);

ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY providers
    ADD CONSTRAINT providers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY run_context_inspections
    ADD CONSTRAINT run_context_inspections_pkey PRIMARY KEY (run_id, round);

ALTER TABLE ONLY run_diagnostics
    ADD CONSTRAINT run_diagnostics_pkey PRIMARY KEY (id);

ALTER TABLE ONLY run_instructions
    ADD CONSTRAINT run_instructions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY run_instructions
    ADD CONSTRAINT run_instructions_run_id_client_key_key UNIQUE (run_id, client_key);

ALTER TABLE ONLY run_requests
    ADD CONSTRAINT run_requests_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY schedule_executions
    ADD CONSTRAINT schedule_executions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY schedules
    ADD CONSTRAINT schedules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY search_settings
    ADD CONSTRAINT search_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_tasks
    ADD CONSTRAINT session_tasks_pkey PRIMARY KEY (session_id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY user_plugins
    ADD CONSTRAINT user_plugins_pkey PRIMARY KEY (user_id, plugin_id);

ALTER TABLE ONLY user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_username_key UNIQUE (username);

ALTER TABLE ONLY verified_skills
    ADD CONSTRAINT verified_skills_pkey PRIMARY KEY (id);

ALTER TABLE ONLY verified_skills
    ADD CONSTRAINT verified_skills_user_id_name_key UNIQUE (user_id, name);

CREATE INDEX artifacts_user_created_idx ON artifacts USING btree (user_id, created_at DESC);

CREATE INDEX canonical_session_seq_idx ON canonical_messages USING btree (session_id, seq);

CREATE INDEX login_sessions_expiry_idx ON login_sessions USING btree (expires_at);

CREATE INDEX memories_active_scope_idx ON memories USING btree (user_id, project_id, updated_at DESC) WHERE (superseded_at IS NULL);

CREATE INDEX memories_scope_updated_idx ON memories USING btree (user_id, project_id, updated_at DESC);

CREATE UNIQUE INDEX memories_summary_source_idx ON memories USING btree (source_run_id, kind) WHERE (kind = ANY (ARRAY['session_summary'::text, 'project_summary'::text]));

CREATE INDEX memories_text_idx ON memories USING gin (to_tsvector('simple'::regconfig, content));

CREATE INDEX memories_user_created_idx ON memories USING btree (user_id, created_at DESC);

CREATE INDEX memory_index_jobs_ready_idx ON memory_index_jobs USING btree (next_attempt_at, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'leased'::text]));

CREATE INDEX memory_jobs_ready_idx ON memory_jobs USING btree (next_attempt_at, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'leased'::text]));

CREATE UNIQUE INDEX messages_assistant_run_idx ON messages USING btree (run_id) WHERE (role = 'assistant'::text);

CREATE INDEX messages_content_search_idx ON messages USING gin (content gin_trgm_ops) WHERE (NOT archived);

CREATE INDEX messages_run_role_idx ON messages USING btree (run_id, role, created_at, id);

CREATE INDEX messages_session_created_idx ON messages USING btree (session_id, created_at, id);

CREATE UNIQUE INDEX models_one_default_idx ON models USING btree (is_default) WHERE is_default;

CREATE INDEX models_provider_remote_idx ON models USING btree (provider_id, model);

CREATE INDEX plugin_components_plugin_idx ON plugin_components USING btree (plugin_id);

CREATE INDEX projects_user_updated_idx ON projects USING btree (user_id, updated_at DESC);

CREATE INDEX run_diagnostics_run_idx ON run_diagnostics USING btree (run_id, id);

CREATE INDEX run_instructions_pending_idx ON run_instructions USING btree (run_id, created_at, id) WHERE ((canonical_seq IS NULL) AND (queued_run_id IS NULL));

CREATE INDEX run_requests_session_created_idx ON run_requests USING btree (session_id, created_at, run_id);

CREATE INDEX runs_created_id_idx ON runs USING btree (created_at DESC, id DESC);

CREATE UNIQUE INDEX runs_session_active_idx ON runs USING btree (session_id) WHERE (status = ANY (ARRAY['running'::text, 'cancelling'::text, 'waiting_user'::text, 'waiting_resource'::text]));

CREATE INDEX runs_session_created_idx ON runs USING btree (session_id, created_at DESC);

CREATE INDEX schedule_executions_history_idx ON schedule_executions USING btree (schedule_id, started_at DESC);

CREATE UNIQUE INDEX schedule_executions_run_idx ON schedule_executions USING btree (run_id) WHERE (run_id IS NOT NULL);

CREATE INDEX schedules_due_idx ON schedules USING btree (next_run_at) WHERE enabled;

CREATE INDEX sessions_chat_cursor_idx ON sessions USING btree (user_id, updated_at DESC, id DESC) WHERE (source = 'chat'::text);

CREATE INDEX sessions_title_search_idx ON sessions USING gin (title gin_trgm_ops) WHERE (source = 'chat'::text);

CREATE INDEX sessions_user_updated_idx ON sessions USING btree (user_id, updated_at DESC);

CREATE INDEX verified_skills_owner_scope_idx ON verified_skills USING btree (user_id, project_id, name);

ALTER TABLE ONLY artifacts
    ADD CONSTRAINT artifacts_run_id_fkey FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL;

ALTER TABLE ONLY artifacts
    ADD CONSTRAINT artifacts_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY canonical_messages
    ADD CONSTRAINT canonical_messages_run_id_fkey FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY canonical_messages
    ADD CONSTRAINT canonical_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY context_compactions
    ADD CONSTRAINT context_compactions_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY login_sessions
    ADD CONSTRAINT login_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY memories
    ADD CONSTRAINT memories_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY memories
    ADD CONSTRAINT memories_source_run_id_fkey FOREIGN KEY (source_run_id) REFERENCES runs(id) ON DELETE SET NULL;

ALTER TABLE ONLY memories
    ADD CONSTRAINT memories_source_session_id_fkey FOREIGN KEY (source_session_id) REFERENCES sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY memories
    ADD CONSTRAINT memories_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES memories(id) ON DELETE SET NULL;

ALTER TABLE ONLY memories
    ADD CONSTRAINT memories_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY memory_index_jobs
    ADD CONSTRAINT memory_index_jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY memory_jobs
    ADD CONSTRAINT memory_jobs_run_id_fkey FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY memory_jobs
    ADD CONSTRAINT memory_jobs_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY memory_jobs
    ADD CONSTRAINT memory_jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY memory_tombstones
    ADD CONSTRAINT memory_tombstones_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY messages
    ADD CONSTRAINT messages_run_id_fkey FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL;

ALTER TABLE ONLY messages
    ADD CONSTRAINT messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY models
    ADD CONSTRAINT models_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE;

ALTER TABLE ONLY plugin_components
    ADD CONSTRAINT plugin_components_plugin_id_fkey FOREIGN KEY (plugin_id) REFERENCES plugins(id) ON DELETE CASCADE;

ALTER TABLE ONLY run_context_inspections
    ADD CONSTRAINT run_context_inspections_run_id_fkey FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY run_diagnostics
    ADD CONSTRAINT run_diagnostics_run_id_fkey FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY run_instructions
    ADD CONSTRAINT run_instructions_queued_run_id_fkey FOREIGN KEY (queued_run_id) REFERENCES runs(id) ON DELETE SET NULL;

ALTER TABLE ONLY run_instructions
    ADD CONSTRAINT run_instructions_run_id_fkey FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY run_instructions
    ADD CONSTRAINT run_instructions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY run_requests
    ADD CONSTRAINT run_requests_run_id_fkey FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY run_requests
    ADD CONSTRAINT run_requests_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY runs
    ADD CONSTRAINT runs_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE SET NULL;

ALTER TABLE ONLY runs
    ADD CONSTRAINT runs_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY schedule_executions
    ADD CONSTRAINT schedule_executions_run_id_fkey FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL;

ALTER TABLE ONLY schedule_executions
    ADD CONSTRAINT schedule_executions_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE;

ALTER TABLE ONLY schedule_executions
    ADD CONSTRAINT schedule_executions_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY schedules
    ADD CONSTRAINT schedules_last_run_id_fkey FOREIGN KEY (last_run_id) REFERENCES runs(id) ON DELETE SET NULL;

ALTER TABLE ONLY schedules
    ADD CONSTRAINT schedules_model_id_fkey FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL;

ALTER TABLE ONLY schedules
    ADD CONSTRAINT schedules_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE ONLY schedules
    ADD CONSTRAINT schedules_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_tasks
    ADD CONSTRAINT session_tasks_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_tasks
    ADD CONSTRAINT session_tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_model_id_fkey FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE ONLY user_plugins
    ADD CONSTRAINT user_plugins_plugin_id_fkey FOREIGN KEY (plugin_id) REFERENCES plugins(id) ON DELETE CASCADE;

ALTER TABLE ONLY user_plugins
    ADD CONSTRAINT user_plugins_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY verified_skills
    ADD CONSTRAINT verified_skills_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY verified_skills
    ADD CONSTRAINT verified_skills_source_run_id_fkey FOREIGN KEY (source_run_id) REFERENCES runs(id) ON DELETE SET NULL;

ALTER TABLE ONLY verified_skills
    ADD CONSTRAINT verified_skills_source_session_id_fkey FOREIGN KEY (source_session_id) REFERENCES sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY verified_skills
    ADD CONSTRAINT verified_skills_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

INSERT INTO app_settings (id) VALUES (true);
INSERT INTO search_settings (id) VALUES (true);
