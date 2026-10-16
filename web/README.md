# Ochi Web

React 19, Vite and TypeScript. Responsive session chat and role-gated
administrator pages share the Go API. Native clients remain in `../mobile`.

## Development

```sh
pnpm install --frozen-lockfile
VITE_DEV_API_TARGET=http://127.0.0.1:8090 pnpm dev
pnpm build
pnpm test
```

Node 22+ and pnpm are required. The dev server proxies API requests to
`VITE_DEV_API_TARGET`; do not put credentials in client environment variables.
Production Nginx serves History API routes and proxies HTTP, SSE and WebSocket.

## Source Ownership

- `src/components/`: chat and shared controls; `components/ui/` owns primitives.
- `src/pages/`: user destinations and administrator features.
- `src/lib/`: API/domain contracts and presentation/state helpers.
- `src/design/tokens.json`: design-token source, also consumed by native clients.
- `scripts/`: token generation and repeatable regression tests.

Run `pnpm tokens` after editing token JSON. Do not edit `tokens.css` manually.
Keep each CSS rule with its owning component/feature rather than appending
global overrides.

## Rendering And Verification

Streamdown handles streaming Markdown with lazy CJK, math/KaTeX and code
highlighting. Historical messages are memoized, composer state is independent
from streaming, and large tool output renders only when expanded. Tool and
reasoning entries retain chronological order; live snapshots and completed
message DTOs are separate contracts.

Artifact HTML/SVG previews run in a sandbox without same-origin privileges.
Computer uses a lazy noVNC panel. Provider keys remain server-side.

`pnpm build` includes TypeScript checking. `pnpm test` exercises current
presentation, state and transport contracts, not visual acceptance. Verify
responsive layouts, light/dark, pointer/keyboard/touch menus, streaming and
reconnect behavior in a real browser after relevant changes.

See [architecture](../docs/architecture.md), [design](../docs/design.md),
[development](../docs/development.md) and [deployment](../docs/deployment.md).
