# Development

## Tools And Setup

The container workflow in the root README needs Docker Engine and Compose.
Source-level checks additionally need Go 1.23 or newer, Node.js 22 or newer, pnpm (use
the pinned `packageManager` in each client), and Python 3. Native builds need
Xcode/CocoaPods or a JDK and Android SDK; see [Releasing](releasing.md). The
root `Dockerfile` pins the tested Web/server toolchains. Its production build
embeds the Vite output in the Go executable; no separate Web container is needed.

```sh
(cd web && pnpm install --frozen-lockfile)
(cd mobile && pnpm install --frozen-lockfile)
python3 -m venv .venv
.venv/bin/python -m pip install -r workspace/requirements-test.txt
(cd web && VITE_DEV_API_TARGET=http://127.0.0.1:8090 pnpm dev)
```

Ordinary `go run ./cmd/server` remains API-only for Vite development. To check
the same combined application used in a release without publishing anything:

```sh
docker build -t ochi-server:check .
```

This local build deliberately identifies itself as a development build and
does not enable application self-update. Release CI supplies its full revision,
UTC build time and `BUILD_TYPE=release` to the Docker build. The `binary` target
exports the identical statically linked Linux executable for update archives.
`scripts/release.py` packages it and validates both-platform update manifests;
see [Repository Tools](../scripts/README.md).

The native client defaults to `https://ochi.bojin.co`. `EXPO_PUBLIC_API_URL`
explicitly overrides that default; a saved self-hosted origin takes precedence.
The login page accepts HTTPS and HTTP self-hosted origins. HTTP sends credentials
and conversation content without transport encryption; prefer HTTPS outside
trusted local networks. Simulator loopback and physical-device addresses differ.
Never put provider secrets in `VITE_*` or `EXPO_PUBLIC_*` values.

## Checks

Run the relevant commands from the repository root. Enter each client directory
before invoking pnpm so Corepack reads that client's `packageManager`:

```sh
(cd server && go test ./... && go vet ./...)
.venv/bin/python -B -m unittest discover -s scripts/tests -v
.venv/bin/python -B -m unittest discover -s workspace/tests -v
(cd web && pnpm build && pnpm test)
(cd mobile && pnpm typecheck && pnpm test)
(cd mobile && pnpm exec expo install --check)
```

Workspace fixtures use the test requirements above, including the same JSON
Schema implementation as the runtime, and mock browser/MCP/desktop dependencies.
Actual workspace dependencies are pinned in `workspace/Dockerfile`; a fixture
pass is not a full Linux runtime test. Process tests launch real local process
groups; the Linux image additionally exercises credentials and SDK processes.
Client tests exercise the shared controller/reducer and actual React renderers:
React DOM for Web and React Test Renderer for native hooks. They cover ownership
changes, stream updates, terminal handoff, retained input identity and idle
reconciliation. These maintained tests do not replace browser or device checks.
For a native dependency change also verify a real native build. JavaScript
export, type checking and fixture tests do not certify interaction or visuals.
The native bootstrap supplies Hermes' missing `Intl.Locale` and
`Intl.PluralRules` before loading the router, with English and Chinese plural
data. Node's Intl capabilities are not a substitute for Hermes checks: retain
the missing-capability bootstrap test and exercise counted process/tool status
on both built platforms.

CI runs the same Web and native checks on pull requests and client changes.
Container publication calls the shared checks workflow and waits for every
lane. Server tests run against an ephemeral `ochi_process_qa` database built
from `db/Dockerfile`, so persistence and HTTP integration tests are not silently
skipped. The QA database and its volumes are removed after the job. Mobile-only
pushes run checks without rebuilding server or workspace images.

For local database integration, set `OCHI_PROCESS_TEST_DATABASE_URL` to a
disposable database named exactly `ochi_process_qa`, with pgcrypto, pgvector and
pg_trgm available. The test fixtures create and drop their own schemas. Never
use an application database or credentials for this variable.

Language catalogs use semantic keys with explicit `en`, `zh-CN` and `zh-TW`
entries. Reuse complete sentences with named parameters instead of joining
translated fragments. Web's `i18n-shared.test.cjs` checks catalog coverage,
placeholder parity, locale resolution and formatting; client tests exercise
preference persistence, request headers and in-place updates. Add public server
errors to `server/internal/i18n/messages.json` and return typed errors from
business code. Do not identify failures by comparing translated prose, or add
client copies of the shared public error catalog. Language changes also need
browser/native checks for label width, menus, draft/focus preservation and
localized errors. See [Architecture](architecture.md) for the wire contract.

## Source And Output Boundaries

Commit maintained source/tests, lockfiles, generated design tokens, owned native
projects, public configuration examples, licensed assets and current documentation.
Native generated dependencies and build products are not native source.

Keep secrets, provisioning/signing inputs, browser profiles, database backups,
signed packages, device captures, private discussions and unreviewed research
outside the public tree. Local `build/`, `work/`, `outputs/` and tool caches are
ignored, but ignoring a file is not a privacy audit. Review the actual candidate
file list before the first commit or publishing any branch.

Reusable tools belong in `scripts/` (or the owning module's `scripts/`) with
documented inputs, dependencies and output paths. Test fixtures must be synthetic
and self-contained, never a production conversation/provider export.

## Documentation And Agent Context

Root `AGENTS.md` is a small entry point. Nested instructions add only module-local
rules. Current design has one canonical home in `docs/`; update that home rather
than appending another dated competing spec.

Research becomes public documentation only after its useful conclusions are
implemented or explicitly accepted, sources are checked and private content is
removed. Raw conversations and QA evidence are not default agent context.
Keep short rationale beside a non-obvious decision; avoid a chronological ledger
that makes an obsolete proposal look authoritative. Use real Git history once
available instead of duplicating it in a manually maintained changelog.

Before publication, settle the software license and artwork reuse terms and
audit the staged file set for credentials, personal paths and third-party notices.
