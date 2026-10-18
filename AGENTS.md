# Ochi

Read the nearest directory's `AGENTS.md` before editing its code. Keep this
entry point small; detailed rules belong with the module that owns them.

## Sources Of Truth

- The current task sets scope. Current code, API contracts and tests describe
  what is implemented; documentation describes the intended current design.
- Start with `README.md`, then the relevant page in `docs/`. Do not load all
  documents or private research by default.
- Update the canonical document in the same change as its design. Remove
  superseded instructions instead of appending conflicting dated addenda.
- Private discussions, QA evidence and research are not product specifications.
  Do not restore archived implementation plans into active documentation.

## Boundaries

- Product name: Ochi. iOS Bundle ID and Android application ID: `co.bojin.ochi`.
- One Go API serves the existing Vite Web app and Expo native clients. Share
  tokens and domain contracts, not Web DOM/CSS or a WebView chat wrapper.
- Keep deployment to PostgreSQL, the Go service, Web and Docker workspaces.
  Do not add queues, workers or abstraction frameworks without a concrete need.
- Runs outlive HTTP/SSE connections. Queue turns within a session; preserve
  canonical provider/tool history separately from visible message projections.
- Computer permission, plugin policy and explicit tool scope are enforced at
  dispatch. The Docker socket and workspace bridge must stay private.
- This is a development-stage codebase. Change the current design directly;
  do not add old-client aliases or automatic historical migrations. Existing
  data changes need an explicit one-off maintenance plan, never silent deletion.
- Keep credentials and signing keys outside source control. Never copy login
  profiles/cookies into the repository or expose credentials in logs or URLs.

## Changes And Checks

- Preserve unrelated user changes. Prefer deleting obsolete code over adding
  another fallback. Keep actual provider interoperability and OS fallbacks.
- Before switching to an unrelated task, inspect outstanding changes and close
  the previous task's commit boundary. Commit independently verified, approved
  work after its privacy review; if it cannot be safely separated, ask first.
  Never silently mix unrelated tasks into one commit.
- Keep one owner for each component, state transition and style surface.
  Avoid speculative shared packages and arbitrary file-size-driven splitting.
- Preserve established neutral, compact UI and native interactions. Read
  `docs/design.md` before changing rendering, navigation or animation.
- Original artwork is `assets/branding/original.png`. Derive launcher icons
  with `scripts/generate-icons.py`; do not redraw it or add mascot/background
  UI without approval. Central/background logo work remains deferred.
- Compilation and fixture tests do not replace native/browser interaction
  verification. See `docs/development.md` for commands.
- Do not restart a deployment, alter stored data, publish packages or create
  commits as an incidental cleanup step. State verification limits honestly.
