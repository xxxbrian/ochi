# Deployment

## Configuration

Copy `.env.example` to a private `.env`. Set `POSTGRES_PASSWORD` and an initial
administrator in `OCHI_USERS`, a JSON array with `username`, `display_name`,
`password` and `role` (`admin` or `user`). Do not commit the configured file.

`RUNNER=openai` selects real provider execution. The optional `MODEL_BASE_URL`,
`MODEL_API_KEY` and `MODEL_NAME` bootstrap model configuration. Users, providers,
models, auxiliary tasks and search can then be managed in the administrator UI;
bootstrap values do not overwrite subsequent administrator edits.
`RUNNER=demo` is explicit development-only behavior.

The server requires `DATABASE_URL` (supplied by Compose). `SECURE_COOKIES=true`
is required behind production HTTPS. Workspace defaults use the built
`ochi-workspace:local` image and private `ochi`/`ochi-compute` networks.

## Start And Expose

```sh
docker compose --profile build build
docker compose up -d db server web
docker compose ps
docker compose exec -T server wget -qO- http://127.0.0.1:8080/healthz
```

Compose publishes only `127.0.0.1:8090`. Put an HTTPS reverse proxy in front of
the Web/API origin for physical-device access. Forward SSE without response
buffering and support WebSocket upgrade for the computer viewer. Set sensible
upload/timeouts for intended use. Do not expose PostgreSQL, Docker, bridge, CDP
or VNC ports publicly. Docker-socket access is a privileged server capability;
use a trusted, dedicated deployment host.

## Persistent Data

The named database volume holds PostgreSQL; the artifacts volume holds immutable
uploads/published bytes under `/var/lib/ochi/artifacts`. Per-user workspace
volumes hold `/data`, including user files, dependencies, browser login state
and desktop preferences. Compute scratch and shared extension storage are also
managed by the server. Never treat those as disposable build caches.

Back up PostgreSQL and the corresponding artifact/workspace volumes together.
Store backups and secrets outside the checkout. Stop writes or use a consistent
snapshot strategy, record image/config versions, and test restoration before
relying on a backup. Do not use `docker compose down -v` as a routine update.

## Maintenance

The database schema is the current complete definition, initialized only on a
fresh database. The service does not maintain historical upgrade aliases or
automatically transform old deployment data. A schema/identity change requires
an explicit one-off maintenance procedure and verified backup, or an explicitly
authorized reset. Changing Compose project/volume names does not rename or move
existing data; check target volumes before starting a changed deployment.

Deploying a changed workspace image requires replacing the corresponding
containers while retaining their data volumes. Schedule maintenance around
active runs. Restarting the server interrupts started runs; unstarted pending
inputs remain queued. A successful image build is not evidence that an existing
deployment has been updated.
