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
| `server/internal/i18n` | Public error identities, translations and HTTP language negotiation |
| `web/src` | Browser routing, state and rendering |
| `mobile/app`, `mobile/src` | Native routing, state and rendering |
| `shared/contracts.ts`, `shared/conversation` | Public run contracts, conversation commands, stream reduction and presentation projections |
| `shared/i18n` | Client locale resolution, interpolation and process messages |
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

## Interface Languages

Web, native clients and public API errors support English (`en`), Simplified
Chinese (`zh-CN`) and Traditional Chinese (`zh-TW`). The account preference is
`system` or one of those explicit locales. Before login, each client restores
its local preference; after login, the account preference is authoritative.
`system` resolves the browser/device language list, including Hans/Hant and
regional aliases, with English as the unsupported-language fallback.

Translations use semantic keys and complete three-language catalogs. Client
formatting and subscriptions live in `shared/i18n`; each client owns storage
and React integration. Changing language updates mounted content without
recreating the composer, discarding drafts or restarting a run. Dates, numbers
and durations use the resolved interface locale. Native permission prompts use
the platform's app/system language and have resources for all three languages.
User text, model output, provider identifiers and technical tool/diagnostic
payloads are not translation keys. Interface language is not a model response
language instruction and is never inserted into the agent's prompt.

HTTP clients send the resolved locale in `Accept-Language`. The API negotiates
each request independently and returns `Content-Language` and
`Vary: Accept-Language`. Public failures have `{ error, code, params? }`, with
safe localized text and stable machine-readable identity. Internal causes
remain available for diagnosis, rather than becoming translated messages or
being returned indiscriminately to users.

Runs, completed messages, schedules and update state retain public error codes
separately from safe fallback text. Viewers translate those codes in their
current locale, including after reconnect or a language change. The clients
read the same JSON error catalog embedded by Go; there is no manually maintained
second copy. Browser EventSource retains its current transport and renders
locale-independent error/status identities. Empty new-conversation titles stay
empty in storage; clients supply the localized label until a real title exists.

The native Computer viewer receives its initial resolved locale through its
dedicated route and subsequent changes through a validated event. It does not
reload the desktop or write a separate browser/account language preference.

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

The runtime owns one ordered collection of public `items`: text, reasoning and
tool occurrences. Items have stable occurrence IDs and explicit model-round,
source, phase and lifecycle metadata. A provider may reuse an ID in another
round; that does not identify the same occurrence. `item_started` introduces an
empty text item, `item_delta` carries at most 4,096 UTF-8 bytes, and
`item_updated` carries metadata or a completed tool result. Neither token deltas
nor terminal status events resend accumulated prose. Subscribers recover a
sequence gap with a snapshot. There are no separately mutable public
output/reasoning/steps/timeline collections to reconcile.

Canonical provider history, these public items and durable checkpoints serve
different purposes. The provider transcript retains replay semantics; public
items retain what the user actually saw; checkpoints preserve current run
state. Successful completion projects final-phase text when present. An
interrupted run preserves its public text even if no final phase was reached.
Visible text that never committed to provider history is available to the next
turn as an explicitly incomplete observation. Private reasoning is not inserted
as that observation, and missing tool results remain unknown rather than being
invented or replayed.

Web and native clients use one conversation controller and stream reducer from
`shared/conversation`. Transport and platform lifecycle are adapters; UI hooks
do not independently merge command results, history and active runs. Ownership
includes backend origin, account and conversation/draft identity. Changing that
identity invalidates stale requests. Within one owner, serialized commands and
revision checks prevent older reads from replacing newer accepted state.

Periodic reconciliation uses `GET /api/sessions/{id}/head`: session metadata,
latest run identity/sequence/status and history/queue revisions. It does not
read or clone process bodies. Clients fetch changed history, queue or run detail
only when those identities/revisions require it; historical process detail is
loaded on expansion. Active runs continue through SSE, including recovery after
reconnect. New-chat creation adopts the accepted conversation in the same
controller instead of creating a second live state owner.

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

Within a run, the last successful provider request's actual prompt usage
calibrates the unchanged input prefix. Only appended growth uses the heuristic,
with additional headroom. Hashes of model, protocol, tools, history prefix and
semantic dynamic context determine whether the measurement still applies.
Rewriting/compacting the prefix invalidates it; a changing clock alone does not.
The anchor holds hashes and counts, not another copy of the conversation.
Billable usage across retries remains separate from this individual-request
measurement. Diagnostics expose both heuristic and calibrated input estimates.

Process events preserve thinking, interim replies and tool calls in occurrence
order. The clients derive compact grouped views without reordering the canonical
events. Finished message DTOs expose `attachments`; live run snapshots expose
`artifacts`. These are different contracts, not alternate names for one field.

## Task Continuity And Memory

Context compaction summarizes historical evidence; it does not discover
permanent rules by matching words such as "must" or "only". Continuity quotes
retain at most four recent accepted user messages within a 1,200-token estimate.
Original resource paths/links have a separate bounded allowance. Older
summaries cannot repopulate this protected user-evidence set. The current user
request remains verbatim, tool-call groups stay complete, and canonical
provider records are not shortened.

The active TaskState owns a complex task's objective, constraints, remaining
work and acceptance checks. Each new or changed constraint cites an exact
accepted user excerpt and source run. Updates replace the current set, so
superseded constraints disappear. `new_task` starts a new scope instead of
carrying old constraints into a different objective; completed task records are
not injected into later turns. Editing a source turn invalidates derived task
state in the same transaction. Source attribution is deterministic, while
recognizing a task switch and interpreting its requirements remain model work.

Task verification observes real artifact bytes, scoped files and recorded
execution outcomes. A deferred `exec` is joined to later `job` observations by
job identity within that run. Execution order, not completion order, determines
the latest check. Running services and cancelled/timed-out jobs do not count as
successful checks. Both the execution and result occurrence remain identifiable;
the initial tool result is never rewritten into a fictitious synchronous
success. Verification is evidence of the declared checks, not a claim that
semantic or visual quality was automatically proved.

Memory has two independent questions: whether a source is attributable to the
user, and whether its meaning should persist beyond the current task.
Automatic extraction and `memory_save` share a separate bounded semantic
assessment of the full accepted user statement. It distinguishes lasting
personal facts/standing preferences from task-local instructions, quoted text,
uncertain inference and sensitive content. Project-only applicability cannot
be broadened to account scope. A one-time "in English" instruction is not a
standing language preference. Failed or malformed assessment does not admit a
fact; this is a model judgment with explicit failure behavior, not a guarantee
of perfect classification.

Records carry `admission`: explicit user edits are `curated`, admitted
automatic/agent facts are `durable`, and summaries/methods are `episodic`.
Only admitted facts/preferences enter stable profiles and fact recall.
Unadmitted historical facts remain manageable by the user without influencing
profile, lexical or vector retrieval. Extraction retains the existing durable
job/lease mechanism and caches successful admission decisions for worker retry;
it does not introduce a second queue. Provenance, correction/supersession,
tombstones and revision guards remain authoritative. Recall is scoped and
bounded; ephemeral task directions stay in conversation/TaskState.

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

Computer ON authorizes access to the persistent per-user workspace, project
directories, browser/desktop and approved extensions. Ordinary commands, Jobs,
files and public HTTP still default to isolated per-session compute. Selecting
`environment: desktop` explicitly uses persistent files and GUI-capable commands
and requires Computer permission. Compute never mounts the persistent workspace
or exposes its Skills/MCP tools. Results identify their environment; subsequent
Job/file/publication calls must select the same one. The two filesystems remain
separate even at identically spelled paths. `files_copy` transfers one selected
file explicitly without publishing it or copying an entire workspace.

Shared resource admission is atomic across a tool's complete resource set.
Ready requests with overlapping keys follow FIFO, including manual desktop
control. A continuous GUI segment retains its lease between observations and
actions. Expanding a resource set ends the previous segment and queues the whole
set; it never holds one resource while waiting to acquire another. Tools claiming
shared resources are dispatch barriers. Independent computation/research,
`computer_release` and user decisions release the run's Go leases. Actual live
desktop Jobs remain occupied until the process authority confirms they drained.

A resource wait is a foreground blocking tool call. Its reporting checkpoint
defaults to 2 minutes, then 4, 8 and at most 15 minutes on explicit continuations;
this is separate from command execution deadlines. At a checkpoint the call
returns one successful `executed: false` result, parks without a lease and retains
its original FIFO sequence. Parked requests have no decision expiry, never run
in the background and do not block ready requests. `computer_queue` either
cancels the request or starts a new blocking wait with the same priority. The
first grant consumes that priority. Desktop admission provides fresh state and
never replays the original action or later stale calls from the same model
response. Project-only admission does not inspect the desktop. Run termination
or permission revocation removes pending requests; client disconnects do not.

`exec` starts an owned Job and returns its result or identity after a short
bounded wait. Tasks have finite deadlines and are cleaned up when their run
finishes; explicit services can survive successful completion for later turns
in the same conversation. Cancellation and failure clear the corresponding
work; revoking Computer clears desktop Jobs while independent compute continues.
Python owns the process groups, durable logs and state;
Go queries that authority instead of maintaining a second Job registry.
Tool metadata declares resource claims. Live Jobs keep those resources occupied
after a run releases its leases, including across a Go restart. Even the owning
conversation must drain a desktop Job before starting another GUI operation;
claim-free Job observation/cancellation remains available.

Provisioning and maintenance coordinate per container. A borrowed bridge
reference covers attachment through the complete request. Idle compute
containers stop only when neither requests nor Jobs remain, preserving their
named data volumes. See the [workspace contracts](../workspace/README.md) for
Job observation, cancellation and task/service limits.

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

The control runtime owns private plugin configuration and injects scoped MCP
credentials at transport/process startup. Ordinary user exec receives only
public catalog and Skill assets, never the global configuration volume.
The complete Skill catalog supports search and pagination; selected MCP slots
are replaceable rather than a permanent discovery limit. External MCP JSON
Schema remains separate from intrinsic tool validation and provider adaptation.
Skill readiness is keyed to the target user's runtime and content identity,
including the compiled resources actually executed there. Details belong to
the [workspace contracts](../workspace/README.md).

## Trust Boundaries

The Web client uses an authenticated server session; native clients keep the
bearer session in SecureStore. Untrusted artifacts and external image URLs do
not receive those credentials. HTML previews are isolated from application
origin privileges. Docker, CDP, VNC and the workspace bridge are private; the Go
service authenticates and proxies user computer access.

For configuration and backups, see [Deployment](deployment.md). For checks and
source organization, see [Development](development.md).
