# Go Server

Read the root `AGENTS.md` and `docs/architecture.md` first. This directory is one
Go module and one service; do not introduce workers, queues, or services without
a concrete need.

## Boundaries

- `internal/agent` owns provider protocols, context construction, and the tool loop.
- `internal/runtime` owns in-process run state, timeline events, and subscriptions.
- `internal/storage` owns PostgreSQL transactions and the current `schema.sql`.
- `internal/api` authenticates requests and coordinates those modules.
- `internal/workspace` owns Docker lifecycle and the private workspace bridge.
- Keep HTTP/SSE connection lifetime separate from agent execution lifetime.
- Preserve canonical model/tool history separately from visible chat projections.
- Persist accepted inputs before admitting them into a running turn.
- Check Computer/plugin access at dispatch, not just tool discovery or presentation.
- Never expose provider secrets, the Docker socket, or unscoped workspace access.
- Keep the reusable prompt prefix stable; put per-turn context after it.
- Maintain one current schema, not runtime migrations or old-client wire aliases.
- Provider-specific protocols are current integrations, not app-version fallbacks.

## Checks

From `server/`, run `go test ./...` and `go vet ./...`.
Database tests are opt-in via `OCHI_PROCESS_TEST_DATABASE_URL` and refuse databases
outside the disposable `ochi_process_qa` naming boundary. Never point tests at the
application database. Real-provider evaluation is separately opt-in and billable;
do not enable it for ordinary unit checks. Update the relevant test beside the
changed package, rather than adding a separate one-off runner.
