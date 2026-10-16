# Web Client Rules

- Read root `AGENTS.md` and current `docs/design.md`; preserve the React/Vite app.
- Keep one CSS owner per surface: `styles.css` foundations, `components/ui/`
  shared primitives, feature sheets for feature layouts, and `pages/pages.css`
  only for the common page shell. Remove obsolete rules, not override layers.
- `src/design/tokens.json` is the token source shared with native clients. Run
  `pnpm tokens`; never hand-edit generated `tokens.css`.
- Keep responsive, reduced-motion and container rules with their owner. Preserve
  import ordering and portal styling scope.
- Keep composer state separate from growing transcripts, batch streaming updates,
  memoize history and lazily render expensive tool/Markdown detail.
- Reasoning, progress and tools render in chronological order. Completed message
  attachments and live run artifacts are distinct API contracts, not aliases.
- Do not synthesize run completion from text or tool success. Preserve terminal
  snapshots, stale-request guards and per-conversation command ownership.
- User-message/history menus use touch long-press or desktop right-click;
  desktop action affordances appear on hover/focus, not permanent bubble footers.
- Keep neutral surfaces, consistent type/icons and compact information density.
  Do not introduce a new visual system for a local change.
- Sandbox artifact HTML/SVG without same-origin privilege; keep provider secrets
  server-side and do not leak tokens to external resource URLs.
- Use `pnpm build` and `pnpm test`. Verify relevant browser interactions,
  responsive layouts, light/dark, streaming/reconnect and console errors;
  compilation and static rendering are not visual acceptance.
