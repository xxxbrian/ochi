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

The native client has a configurable server origin. Simulator loopback and
physical-device addresses differ; release builds require a reachable HTTPS
origin. Never put provider secrets in `VITE_*` or `EXPO_PUBLIC_*` values.

## Checks

Run the relevant commands from the repository root. Enter each client directory
before invoking pnpm so Corepack reads that client's `packageManager`:

```sh
(cd server && go test ./... && go vet ./...)
python3 -B -m unittest discover -s scripts/tests -v
python3 -B -m unittest discover -s workspace/tests -v
(cd web && pnpm build && pnpm test)
(cd mobile && pnpm typecheck && pnpm test)
(cd mobile && pnpm exec expo install --check)
```

Workspace fixture tests run with the Python standard library and mock external
browser/MCP/desktop dependencies. Actual workspace dependencies are pinned in
`workspace/Dockerfile`; a fixture pass is not a full Linux runtime test.
Test scripts under the client `scripts/` directories are repeatable contract
regressions, not private one-off smoke runs. Their READMEs describe ownership.
For a native dependency change also verify a real native build. JavaScript
export, type checking and fixture tests do not certify interaction or visuals.

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
