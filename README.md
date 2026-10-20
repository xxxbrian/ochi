# Ochi

Ochi is a session-based AI assistant with a responsive Web client and native
iOS/Android clients. It supports streaming conversations, tools, projects,
scheduled tasks, memory, image generation, and an optional persistent Linux
computer. Administrators manage providers, models, and Skills/MCP plugins.

## Run Locally

Requirements: Docker Engine with Compose. Docker Desktop and OrbStack can
provide the engine on macOS. The desktop/workspace runs in Linux containers,
not on the host desktop.

```sh
cp .env.example .env
# Set a database password and an initial administrator in .env.
# Configure a provider here, or after login in the administrator UI.
docker compose build
docker compose up -d db server
```

Open <http://127.0.0.1:8090>. The default binding is loopback-only.
`RUNNER=demo` explicitly enables a development runner; it is never a silent
fallback for a missing provider. Provider keys stay on the server.

## Repository

| Path | Responsibility |
| --- | --- |
| `server/` | Go HTTP API, agent execution, storage, embedded production Web app |
| `web/` | React, TypeScript and Vite Web client |
| `mobile/` | Expo/React Native clients and versioned native projects |
| `workspace/` | Private Linux tool bridge, browser and XFCE desktop |
| `db/` | PostgreSQL image with pgvector |
| `assets/` | Original artwork and asset provenance |
| `scripts/` | Reusable repository tools |
| `docs/` | Current architecture, development and release guidance |

## Documentation

- [Architecture](docs/architecture.md): ownership, contracts and boundaries.
- [Design](docs/design.md): tokens, rendering and platform interaction rules.
- [Development](docs/development.md): setup, checks and repository conventions.
- [Deployment](docs/deployment.md): configuration, persistence and operations.
- [Releasing](docs/releasing.md): local iOS/Android packaging and signing.

Agent entry point: [AGENTS.md](AGENTS.md). Directory-specific instructions add
only the rules needed for that area. Private discussions, research captures,
credentials, device QA recordings and signed packages are not source documents
and are not included in this repository.

GitHub Actions builds multi-platform images and the combined Web/server binary.
An administrator explicitly requests application updates inside Ochi; a code
push never deploys or restarts an installation. The rolling `edge` prerelease is
an automated update channel, not a requirement to publish a milestone or bump
the product version on every change. Docker Compose and optional Dokploy setup
are described in [Deployment](docs/deployment.md).

## Publication Status

Source and artwork licensing must be settled before public distribution.
Bundled third-party assets retain their own notices; the Ochi artwork is not
implicitly licensed for unrelated reuse. See [asset provenance](assets/branding/README.md).
