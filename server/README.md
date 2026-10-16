# Go Server

One Go process owns JSON commands, background runs, SSE snapshots/deltas,
PostgreSQL input admission, scheduling, memory extraction, and private Docker
workspace I/O. PostgreSQL + pgvector persists configuration, canonical model
history, projections, projects, pending inputs, artifacts, memories, and task
execution history. No Redis, queue service, or separate worker.

See [startup](../README.md), [architecture](../docs/architecture.md), and
[deployment](../docs/deployment.md).

## Runtime Contracts

- A run outlives its creating HTTP request and SSE connection.
- One session's turns are sequential; other sessions may execute concurrently.
- Received follow-ups are durable `run_requests`. Canonical history is appended
  on claim/start, never while a message is still queued.
- Project-directory mutation and desktop resources use separate process-local
  leases, not an account-wide run lock. Explicit scope reaches every tool.
- Stopping cancels that run's exec process group. It does not reverse side effects.
- On restart, already-started runs become interrupted; unstarted inputs remain.
- Canonical tool-call/result IDs and native metadata are stored separately from
  visible replies. Model switching strips incompatible private reasoning replay.
- Compaction has an auxiliary configuration and bounded fallback. A failed step
  is not itself a failed run.
- The stable memory profile is cached per session; related recall runs per accepted
  turn. Edits, deletion, settings, and expiry invalidate retrieved context.
  Automatic extraction keeps user-quote provenance and revision checks.
- Schedule definitions and executions are separate; Go embeds IANA timezone data.

## API Areas

JSON requests use `Content-Type: application/json`; login uses a server-side
session cookie. All nonpublic routes recheck the account. Roles are admin/user.

| Area | Routes |
| --- | --- |
| Authentication | `/api/auth/login`, `/api/auth/me`, `/api/auth/logout` |
| Published models | `/api/models` |
| Sessions | `/api/sessions`, `/api/sessions/{id}`, `/messages`, `/runs` |
| Pending inputs | `/api/sessions/{id}/queue`, `/queue/{runId}`; edit/cancel |
| Runs | `/api/runs/{id}`, `/events`, `/cancel`, `/resume` |
| Projects | `/api/projects`, `/api/projects/{id}` |
| Files | `/api/files`, `/api/files/{id}/content`; multipart upload |
| Memory | `/api/preferences`, `/api/memories`, `/api/memories/{id}` |
| Tasks | `/api/schedules`, `/{id}`, `/run`, `/executions`, `/executions/{executionID}` |
| Desktop | `/api/computer/state?session_id=...`, `/control`, `/desktop` WebSocket |
| Administration | `/api/admin/providers`, `/models`, `/skills`, `/mcp`, `/users`, `/workspaces`, `/runs`, `/settings` |

Provider sync/discovery/catalog and model test routes are under `/api/admin`.
Secrets are never returned in ordinary client DTOs.

## Configuration And Checks

`DATABASE_URL` is required. `OCHI_USERS` and initial MODEL variables bootstrap
missing configuration without overriding later admin edits. `ADDR` defaults to
`:8080`; set `SECURE_COOKIES=true` with HTTPS. Docker tools use the private network
configured by `WORKSPACE_NETWORK` and image/socket settings. On Mac, prefer the
Compose server rather than assuming host DNS resolves workspace container names.

`RUNNER=demo` is explicit, not fallback for a broken model. Embedded `schema.sql`
initializes a fresh schema in one transaction only when `sessions` is absent.
Existing deployments require explicit maintenance, not automatic schema upgrades
or old-data backfills. The current DB image must provide pgvector.

```sh
go test ./...
go vet ./...
```

Focused tests cover provider tool replay, compaction, reasoning mappings, resource
wait/cancel, desktop socket release, calendar timing, SSE and run lifecycle.
Actual-model evidence and UI/device acceptance are distinct from passing tests.
This is a single-server design, not a crash-replay or distributed execution system.

### Real-Model Evaluation

`TestCoreFlowRealModelEvaluation` is an optional, billable controlled-corpus
regression test, not a general quality benchmark. It makes external inference
requests to one explicitly selected OpenAI Chat Completions-compatible model.
Tools use controlled fixtures; it does not operate Docker or a real desktop.
Both `OCHI_EVALUATION_CONFIG` and `OCHI_EVALUATION_OUTPUT` must be set, or the test
skips. The output directory receives private JSON/Markdown model evidence; keep
it and the configuration file outside this repository.

The configuration file uses `agent.Config` field names, for example:

```json
{
  "Protocol": "openai",
  "Model": "your-selected-model-id",
  "SupportsTools": true,
  "ContextWindow": 32768,
  "MaxOutputTokens": 2048
}
```

Supply the private `BaseURL` and `APIKey` fields separately in that same file
(or `AllowNoKey: true` for an explicitly unauthenticated endpoint). No model or
endpoint is chosen automatically. Compaction uses the same recorded model.
`OCHI_PROCESS_TEST_DATABASE_URL` must name the disposable `ochi_process_qa`
database with pgvector available. The fixture creates and removes only its own
isolated schema; never supply the application's database. After configuring
these three environment variables:

```sh
go test ./internal/api -run '^TestCoreFlowRealModelEvaluation$' -count=1 -timeout=30m
```

Optional `OCHI_EVALUATION_ONLY` selects `topic_shift`, `repeated_failure`,
`repeated_compaction_constraints`, `permission_revoke`, or
`immutable_artifact_delivery` and requires an existing baseline report. Full and
narrow reruns retain earlier attempts without rewriting their recorded outcomes.
