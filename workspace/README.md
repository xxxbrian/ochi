# Workspace

One Docker Engine image provides persistent shell/Python/Node files, lazy headed
Chromium, and a real XFCE desktop on Xvfb. It runs in Linux, including the VM behind
OrbStack/Docker Desktop; it never operates the host Mac or user's phone.
See [app startup](../README.md), [scope/lifetime decisions](../docs/architecture.md),
and [deployment](../docs/deployment.md).

## Persistence And Scope

- One long-lived `/data` volume per user. Rebuilding replaces the container only.
- `/data/work/<date>-<session-id>` for ordinary sessions, `/data/projects/<slug>-<id>`
  for shared projects. `X-Run-Scope` supplies user/session/run/project/cwd explicitly.
- Staged uploads use explicit absolute paths under `/data/files/uploads`.
  Relative file paths resolve only against the current session/project directory.
- `/data/published/<run>/<content-hash>/<name>` stores immutable artifact copies.
- User Python `/data/venv`, npm prefix, and dependency caches survive rebuilding.
- Shared `/opt/extensions` contains only public Skill assets and catalog metadata,
  writable only by plugin control. Global transport secrets use a different volume.
- Top-level directory ownership is prepared on image creation/first attach;
  existing files are not recursively re-owned or relocated.

Ordinary `exec`, `job`, file and `web_fetch` calls default to
`environment:"compute"`, even when Computer access is enabled. Each conversation
has a separate computation container and named data volume without desktop,
browser profiles, Project files or plugin credentials. Use
`environment:"desktop"` explicitly for the persistent Computer filesystem or a
GUI-capable command; Computer permission is checked before dispatch. Results
identify their environment, and `job` uses the same environment as its `exec`.
The same absolute path in the two environments refers to different bytes.
`files_copy` transfers one explicitly selected file between environments without
publishing it. Toggling Computer access never imports an entire scratch directory
or copies persistent Computer data into computation.

Desktop applications include Thunar, Xfce Terminal, Mousepad, Ristretto, Evince,
Xarchiver and LibreOffice Writer/Calc/Impress. The application menu, browser,
files and terminal launchers are available to both the agent and manual control.
XDG preferences/data/state use `/data/desktop`; cache uses `/data/cache/desktop`.
First-use defaults never overwrite existing preference files. HOME and existing
workspace files remain in place. Saved files/settings survive replacement; live
window state and unsaved documents are not a persistence contract. There is no
host device, USB, system login manager or audio-service integration.

Chromium starts only when needed, independently of Playwright, which attaches
over private loopback CDP. Ordinary sessions share the persistent `main` browser
identity; Project sessions use `project-<project-id>`. These identities are derived
from explicit session/project scope, never from directory names or the tab restore
ledger. `sessions.json` stores owned tab URLs, not login data. Browser tools reject
missing session scope. No Cookie files are read, copied or merged. Pages and popups remain
session-owned even when login identity is shared. Manual browser tabs are not
adopted by agent sessions. At most four browser processes and eight live session
states remain. Manual tabs, active/queued work and paused verification sessions
are protected from eviction; a fully protected pool fails closed. Eviction retains
on-disk login state and owned tab URLs, not live form state. Browser and desktop
share one X display, with a Go-side resource lease. CDP is not full native
Playwright protocol fidelity.

Desktop and bridge share one private DBus session and AT-SPI accessibility bus.
`computer_observe` gives bounded text, elements, windows, coordinates and expiring,
session-scoped refs. Actions revalidate element identity/ancestry; stale refs fail
instead of silently clicking a different item. Protected field contents are
omitted. Foreground apps/windows are visited first within the same bounded budget,
so background Office windows cannot consume the entire useful snapshot.
Pixel fallback supports Unicode input, double/right click, hover, drag,
keys and horizontal/vertical scrolling. `computer_apps` lists installed desktop
entries and opens scoped files/folders without a shell; `computer_windows` focuses
an existing window. Keyboard/mouse actions invalidate old desktop refs.

The desktop uses x11vnc ports 5900/5901 and websockify 6080/6081. View-only is
server-enforced on the second port. No ports are publicly exposed; the Go service
authenticates and proxies WebSocket connections. Agent screenshot tools are
separate from the noVNC live panel.

## Private Bridge

`GET /health` checks the bridge/X display without launching Chromium and reports
the current contract hash, protocol, capabilities and runtime mode. The contract
has one source, `server/internal/workspace/contract.json`, copied into the image
from the repository-root Docker build context. A healthy but incompatible bridge
fails immediately with a rebuild requirement.

Every container has an independently generated private bridge token. The Go
service recovers it through Docker inspection, never through an unauthenticated
workspace endpoint. Calls, uploads and management require that token. Only health
and secret-free catalog reads are public inside the private Docker network.
`GET /tools` returns intrinsic definitions only. `tool_search` ranks tested,
enabled MCP metadata by the current query and returns up to six schemas (16 KB
each, 64 KB total). Query and offset pagination make the whole catalog reachable,
including rejected-schema diagnostics. A scoped run retains the 16 most recently
discovered tools; new searches replace older entries instead of exhausting a
lifetime quota. `GET /tools?names=...` rechecks only those
selected extensions; search/index paths do not connect MCP clients or provision
a workspace.
`POST /tools/{name}` takes JSON arguments and returns:

```json
{"ok":true,"result":{"exit_code":0,"stdout":"hello","stderr":""}}
```

Tool errors use `ok:false`; transport/unknown-route errors use HTTP status codes.
Invalid tool contracts include `error_detail` with `invalid_arguments`,
`invalid_schema` or `unsupported_schema`. Intrinsic Go preflight and the bridge share
strict fixtures: required/type/unknown properties, exact decimal bounds,
local definitions and combinators. MCP schemas are a separate external contract:
Go checks JSON shape, preserves the original schema on provider transport, and
the bridge uses jsonschema with the declared standard dialect to validate calls.
The server currently uses OpenAI-compatible chat and Responses transports;
Responses sends external schemas with `strict:false`. This is not an assertion
that every provider's native schema subset accepts every MCP schema.
Patterns, local references, conditionals and tuple schemas are supported without
silently deleting predicates. References never fetch network or local resources.
`default` and `format` remain annotations, not automatic values/assertions.
Execution attributes are scheduler-only: trusted file/skill metadata reads can
parallelize; shell, desktop/browser and untrusted MCP remain conservative. The
attributes never enter model-facing tool JSON and do not authorize retries.
`exec` starts an owned process group and returns after a short wait (one second
by default, at most ten seconds). Its result always includes a `job_id` and
`running` or terminal status. `job` observes, waits for or cancels that job;
stdout/stderr byte cursors return bounded, UTF-8-safe chunks without repeating
output. State and complete logs are under `/data/jobs/<id>`. Ownership is the
user and session, so a later turn can manage an earlier service, while another
session cannot inspect or cancel it.

Tasks have a finite deadline (20 seconds by default, at most ten minutes) and
end when their run ends. Persistent foreground servers explicitly use
`kind:"service"` and a finite deadline (one hour by default, at most 24 hours).
They survive successful run completion, not explicit cancellation. Computer
revocation ends desktop jobs while isolated computation continues. The shell
exiting also terminates its remaining process group;
backgrounding with `&` is not a substitute for a service. Completed state/logs
remain readable after a container restart; live processes are not restored.

The job registry owns process lifetime, live resource claims and bridge activity.
Explicit desktop commands retain desktop/project claims for their entire lifetime;
observation/cancellation remains available without acquiring those claims.
Compute jobs have no desktop/project claims regardless of Computer permission.
`/runs/finish` ends a run's
tasks (and services on failure), `/runs/cancel` cancels that run, and
`/jobs/cancel-session` closes all existing jobs for the specified user/session.
Authenticated `/jobs/active` reports jobs, active requests and monotonic idle
duration. Health/activity probes do not reset that duration. Go uses this
authority for resource leases and idle scratch reclamation; live jobs or
requests prevent reclamation.

Go also carries a unique operation ID into browser/desktop calls. Stop or Computer
revocation interrupts that operation and drains it before releasing the desktop
lease. An in-flight browser mutation is aborted by closing only its armed,
session-owned target. Its URL can be restored on a later authorized call, but
unsaved forms can be lost; an already dispatched external effect cannot roll back.
The browser queue has a 130-second outer bound, not an automatic retry policy.

Other private routes include file PUT/GET, `/workspace/init`, `/publish`,
`/desktop/activate`, `/extensions/skills`, `/extensions/mcp`,
`/browser/desktop-launch`, and `/embeddings`. Desktop activation raises an already
owned browser tab when one exists; it never opens a blank browser as a side effect
of a screenshot or app operation. The desktop browser launcher uses the private
bridge, not a second unmanaged Chromium profile. File operations use scope.
Only an explicit `publish_file` call or successful image generation creates a
downloadable artifact. Research sources, cloned repositories and intermediate
files stay in the workspace; ending a run never scans or publishes them. Later
source edits require an explicit new publication and cannot change old bytes.

Skills support SKILL.md, Git ref/subdir, archive and inline install, file listing
and validation. MCP uses the official Python SDK stdio/Streamable HTTP, scoped
clients, stable tool names, configuration import and secret preserve/replace/delete.
The control runtime owns MCP transport and receives the current user's effective
plugin policy on every call. Its root-owned configuration lives in
`/var/lib/ochi-control`; that volume is never mounted into user workspaces.
It exposes no general shell or file access. HTTP headers are injected only at
transport. Each stdio component runs with its own unprivileged UID, a minimal
environment containing only that component's configured values, and a private
per-user/session directory. It cannot access the control token, another
component's credentials or the user's Computer files. Skill scripts still execute
in the user's workspace; the two environments are explicit, not interchangeable.
Connection/tool errors expose bounded, credential-redacted exception details and
the current RPC's HTTP failure status. HTTP observation never reads response
bodies or headers and does not change SDK protocol negotiation or retries.
No OAuth or public bridge access is included.
MCP connections are leased while initializing or executing, reclaimed after five
idle minutes, and capped at 64 per control runtime. A full busy pool reports
capacity rather than interrupting a live call. Reclamation closes the SDK
connection and its stdio process; it never retries a tool effect.
`GET /skills/index` is metadata only, bounded to 32 skills/8 KB. Instruction
bodies are read only with `skills_read`; `skills_list` searches and pages through
the complete permitted catalog. Dependency preparation targets an explicit user
workspace and records the Skill content revision and current container runtime.
Only a successful command marks it ready. `skills_read` returns the prepared path
so package-local build outputs are used; a Skill update or runtime rebuild makes
that preparation stale. Readiness is not a global installation claim. Computer-off bridges deny Skills/MCP
while retaining isolated shell/files/public HTTP computation. Verified private
methods live in the user's PostgreSQL namespace, separate from shared extensions;
promotion requires a completed task and genuine current-run check evidence.

Fixture contracts can be checked without a browser, Docker, MCP server or model
provider. Job tests run short real subprocesses in temporary directories:

```sh
python3 -m pip install -r workspace/requirements-test.txt
python3 -B -m unittest discover -s workspace/tests -v
cd server && go test ./internal/workspace ./internal/agent -run 'Test(Catalog|Registry|InvalidToolArgs|ToolSchema)'
```

Default local embeddings use fastembed/BGE-small-zh-v1.5 and a persistent management
cache, CPU two threads, 512 dimensions. Agent user tools do not expose `/embeddings`.

`files_read` supports UTF-8 text, images, and basic PDF/Office extraction. Rich
editing/OCR/analysis is performed with code and libraries, not claimed as built-in
full Office support. New outputs belong in the current cwd; scratch helper files
can use hidden directories to avoid cluttering deliverable discovery.

Browser DOM tools use reference IDs/selectors, a bounded read-only HTML snapshot,
and a whitelisted `browser_action` for hover, selection, checked state, drag,
keyboard and navigation. `browser_status` reports identity and pause state without
launching Chromium. A detected human-verification page pauses automatic actions;
the agent asks via `request_user_input`, releasing its desktop lease for manual
control. After user confirmation, `browser_resume` checks the page actually
cleared. This does not bypass CAPTCHA, spoof identity or promise Cloudflare will
accept a server-hosted browser. Unknown/stale browser locks are not force-killed.

Browser downloads have a completion deadline as well as a start deadline. The
helper matches CDP download events to the owned page's frames, stages by download
GUID, and publishes only completed bytes into the current scope. Timeout/revoke
cancels that GUID and discards its partial file, never another tab's download.
Outside this helper, browser downloads retain normal filenames/extensions in
`/data/work/downloads`; the temporary staging behavior is restored in `finally`.

Tini reaps children. Shutdown lets Chromium flush while X/DBus remain alive, then
stops desktop/VNC and the bus/display. Computer-OFF starts none of these services,
exposes no desktop/browser tools and mounts only its isolated scratch volume.
Real browsing/mobile/noVNC verification still requires permission; fixture tests
alone do not prove those interactions work.
