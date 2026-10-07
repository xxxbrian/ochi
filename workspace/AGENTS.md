# Private Workspace

Read the root `AGENTS.md` and `docs/architecture.md` first. This image runs inside
a private Linux container, never on the user's desktop.

## Boundaries

- `bridge.py` is private HTTP dispatch; `workspace_runtime.py` owns shared scope,
  filesystem, process groups, and artifact primitives.
- `workspace_browser.py` owns headed Chromium, CDP, and session-owned browser tabs.
- `workspace_computer.py` owns desktop actions; `workspace_a11y.py` runs through the
  system Python because AT-SPI is not part of the bridge virtual environment.
- Skills/MCP configuration is administrator-owned; check per-user plugin access
  during discovery and invocation. Computer-off scratch denies both.
- Browser and desktop tools require explicit session scope. Ordinary browser
  sessions use `main`; projects use `project-<project-id>`. Never inspect, merge,
  or rewrite Chromium cookie databases or silently adopt manual tabs.
- Keep browser objects on their owning Playwright thread. Cancellation must drain
  dispatched actions before the server releases its shared desktop lease.
- Fail closed on stale refs, unknown locks, verification challenges, and scope drift.
- Bound returned text and subprocess output; preserve full logs within `/data`.
- Publish only explicit deliverables as immutable bytes, not files discovered by
  scanning a workspace at the end of a run.
- Treat desktop defaults as first-use defaults: never overwrite user preferences.
- Keep intrinsic tool schemas synchronized with the server's embedded catalog.

## Checks

From the repository root, run `python3 -B -m unittest discover -s workspace/tests -v`.
Fixtures do not operate the host UI or require Chromium, MCP, Docker, or a provider.
Native desktop/browser end-to-end checks are separate from these fixture tests.
