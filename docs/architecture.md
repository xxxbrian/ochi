# Architecture

This is the current system map, not a dated implementation log. Module READMEs
describe local contracts; `docs/design.md` covers presentation.

## Ownership

| Module | Owns |
| --- | --- |
| `server/cmd/server` | Process startup and HTTP lifecycle |
| `server/internal/api` | Authenticated commands, subscriptions and resource admission |
| `server/internal/agent` | Agent loop, context, tools and provider behavior |
| `server/internal/storage` | PostgreSQL schema and persistence |
| `server/internal/runtime` | Run state, event publication and subscriptions |
| `server/internal/workspace` | Docker provisioning and private bridge access |
| `server/internal/webui` | Embedded production Web assets and SPA routing |
| `web/src` | Browser routing, state and rendering |
| `mobile/app`, `mobile/src` | Native routing, state and rendering |
| `workspace/` | Scoped Linux shell/files, browser, desktop and extensions |

The Go API and PostgreSQL are shared by all clients. No Redis, separate worker
or distributed queue is required. Docker Engine runs on Linux; macOS development
uses an engine-provided Linux VM.

The production Web build is embedded in the Go executable and served by the same
process as the API. Vite remains separate during source development. Linux
release installations can replace this executable through the administrator's
explicit update action, then restart the same container; no Dokploy API or
temporary updater service participates. GitHub publishes images and a rolling
update manifest but never triggers an installation update. PostgreSQL and
Computer images remain independently managed. See [Deployment](deployment.md)
for the writable-layer/recreation boundary and schema maintenance rules.

## Conversation And Run Lifetime

Creating a run returns its identity; the agent execution is independent of the
request and SSE subscription. Each subscription begins with a current snapshot
and then sequenced deltas. Reconnecting must not require replaying every token.

Pending inputs are durable PostgreSQL records. Turns within one conversation
are sequential; different conversations may run concurrently. Switching to a new
conversation does not cancel an existing run. On process restart, started work
that has not drained is interrupted, while unstarted inputs remain queued; this
is not crash replay. A normal deployment SIGTERM pauses queue claims and waits
up to ten minutes for current work before forced cancellation. New inputs stay
durably queued during this wait. Run ownership remains single-process; there
is no rolling multi-replica execution or zero-downtime guarantee.

Canonical model messages, completed tool calls and provider replay metadata are
stored separately from visible chat messages. Never reconstruct model context
from the final answer alone. Provider-specific reasoning replay is normalized
when switching models. Titles, memory extraction and context compaction use
separate auxiliary requests and do not masquerade as user conversation turns.

Ordinary chat and tool-loop requests omit output-token caps; the provider owns
the single-generation allowance. Model output metadata describes capability,
not an application quota, even when an administrator edits it. Input compaction
reserves context headroom independently (normally a quarter of the window,
adjusted for known output capability and selected thinking budgets), triggering
at 70% input use and targeting 55%, or earlier when the reservation requires it.
An unknown window uses a conservative 16,384-token estimate, not a generation
limit. Titles, memory extraction and summaries keep explicit task-sized output
budgets. Real upstream truncation retains visible partial output and usage,
never executes incomplete tools, and does not automatically replay the request.

Process events preserve thinking, interim replies and tool calls in occurrence
order. The clients derive compact grouped views without reordering the canonical
events. Finished message DTOs expose `attachments`; live run snapshots expose
`artifacts`. These are different contracts, not alternate names for one field.

## Storage And Permission

PostgreSQL with pgvector persists accounts/configuration, conversations,
projects, runs/inputs, schedules, memory and immutable artifact metadata. Live
subscriptions remain process-local. Schema initialization creates the current
schema on a fresh database; it does not run a historical migration chain.

The administrator's global Debug mode is off by default and is checked at the
start of each provider HTTP attempt, including attempts in an already-running
turn. An in-flight capture finishes using the mode selected at its start.
Detailed records include redacted request/response headers and bodies, ordered
SSE lines, request IDs, timing, termination markers and underlying errors.
Ordinary error diagnostics and context inspections remain independent of this
switch. Provider captures never enter the chat event stream or ordinary logs.
Per-attempt captures are bounded to 1 MiB per body and 2,048 stream lines, with
explicit redaction/truncation flags; binary image and embedding payloads are
omitted. Only administrators can list, inspect or clear captured requests.
Summaries are read separately from large payloads. Records expire after seven
days, with startup/hourly cleanup, and are limited to 256 per run and 2,048
globally, evicting the oldest. Bounded asynchronous writes do not block token
delivery; saturation/storage failures are reported in server logs.

Computer ON grants the session access to a persistent per-user workspace,
project directories, browser/desktop and approved extensions. Computer OFF uses
an isolated per-session compute container for ordinary code and public HTTP;
it never mounts the persistent workspace or exposes its Skills/MCP tools.
Resource leases serialize shared-directory mutations and desktop access without
locking every conversation for an account.

Every tool receives explicit user/session/run/project/cwd scope. Browser and
desktop operations revalidate ownership, cancellation and permissions. Ordinary
browser sessions use the `main` login identity; projects use their project
identity. Session-owned tabs stay distinct. Human verification pauses automation
for manual intervention; it is not bypassed.

## Files, Models And Extensions

Uploads and published outputs are immutable bytes. Only explicit publication
or successful image generation creates a downloadable artifact; research files,
source clones and intermediate scripts remain workspace files. Image input and
image generation are separate model capabilities. Published image models are
called through the provider Images API and can be used without Computer ON.

Administrators publish providers/models and configure auxiliary models and
search services. Users see published capabilities and supported reasoning
controls, never provider credentials. Search adapters are server-side; results
are grouped in the clients rather than one row for every fetched page.

Published chat models have one administrator-managed order across providers and
an independent initial default. An explicit user choice is stored with that
account's preferences and is reused for new conversations and after restart.
Opening history retains the conversation's model without changing this account
preference. An unpublished/removed preference falls back to the administrator
default, then the first published model; newly published models append after
the explicitly ordered list.

Plugins are administrator-managed bundles of Skills and MCP. Mandatory defaults
cannot be disabled by users; optional plugins have per-user switches. Discovery
and dispatch both enforce the current policy. There is no third-party catalog
or user plugin publication flow.

Memory recall is selective, provenance-aware and scoped to the request. Durable
preferences require durable evidence; a one-turn language instruction must not
be treated as a permanent account preference. See the implementation contracts
and tests in `server/internal/agent` and `server/internal/storage`.

## Trust Boundaries

The Web client uses an authenticated server session; native clients keep the
bearer session in SecureStore. Untrusted artifacts and external image URLs do
not receive those credentials. HTML previews are isolated from application
origin privileges. Docker, CDP, VNC and the workspace bridge are private; the Go
service authenticates and proxies user computer access.

For configuration and backups, see [Deployment](deployment.md). For checks and
source organization, see [Development](development.md).
