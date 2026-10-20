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

In **Administration > System**, **Debug mode** enables detailed upstream model
request diagnostics without a restart. The next HTTP attempt uses the new mode;
an existing in-flight capture completes normally. Inspect records under
**Request diagnostics**, or the same tab in a run's detail. The mode defaults
off. Captures can contain conversation and tool content even after credential
redaction; restrict administrator access and protect database backups accordingly.
Request/response bodies and SSE captures are bounded and marked when omitted or
truncated. Seven-day retention and oldest-first count limits apply, and the
administrator can clear global or per-run debug records without deleting chats.

For an existing development database, back it up before applying schema changes.
Debug capture needs `app_settings.debug_mode` and the `run_request_debug` table,
indexes and constraints from the current `server/internal/storage/schema.sql`.
If those objects are absent, add just their DDL in one explicit transaction
before starting the new server; do not rerun the full schema, reset a volume or
add startup migration aliases. Check that capture remains off after maintenance.

The server requires `DATABASE_URL` (supplied by Compose). `SECURE_COOKIES=true`
is required behind production HTTPS. The local Compose file uses
`ochi-workspace:local`; production uses exact GHCR digests. Workspace traffic
stays on private Docker networks.

## GitHub Actions And Dokploy

Builds run on GitHub, not on the deployment server or the developer's laptop:

```text
push main -> checks -> build/reuse four GHCR images -> save Compose bundle
          -> update Dokploy Raw Compose -> wait for deployment completion
```

`.github/workflows/containers.yml` publishes `<repo>-server`, `<repo>-web`,
`<repo>-postgres` and `<repo>-workspace` under `ghcr.io/<repository-owner>/`.
Each includes Linux amd64 and arm64 variants built on native GitHub-hosted
runners, without CPU emulation. The workflow uses the repository `GITHUB_TOKEN`
to publish; no registry password is needed for GitHub's build jobs.

Images with unchanged directory trees are reused, including across skipped
commits or a previous partially failed build. Registry layer caches accelerate
changed contexts. The first workspace build/download is large; later Web/server
changes do not rebuild the desktop image. To refresh unchanged base images or
OS packages, run **Actions > Containers > Run workflow** with **rebuild** checked.
Review upstream versions separately; this does not change Dockerfile pins.

Each workflow saves `images.json` and `compose.yaml` as a 90-day Actions artifact.
Images receive unique `sha-<full-commit>-run-<run-id>-<attempt>` tags; the Compose
file pins all four `@sha256:...` digests, including the workspace configuration.
`edge` is only a convenience alias, never a production dependency. Keep known
deployment bundles and their GHCR images for as long as rollback is needed;
artifact retention is not a backup policy. No Git tag, GitHub Release or product
version bump is required. Mobile builds remain a separate release process.

Workflows are serialized and an active deployment is never auto-cancelled.
Superseded pending workflows are skipped. Before deploying, the job checks
whether main has newer deploy-relevant changes; a documentation/mobile-only
commit does not strand a completed server build. All images must succeed before
any deployment starts. Never enable Dokploy's independent Git-push auto-deploy:
that could deploy before images are ready.

### First Setup

1. Enable GitHub Actions for the repository. Push the workflow to `main` or run
   it manually. It initially builds only: auto-deployment is off by default.
   Make the four GHCR packages public in their package settings so the server
   can pull anonymously. A public Git repository does not by itself guarantee
   that a newly created GHCR package is public. For private packages instead,
   configure read access to GHCR on the target Docker Engine/Dokploy.
2. In Dokploy create a **Docker Compose** service using **Raw** source, not
   Docker Stack/Swarm. Paste `compose.yaml` from the completed workflow's
   deployment artifact. Keep service names `db`, `server`, `web`,
   `workspace-image`; Dokploy domain settings attach to those names.
3. Paste a configured copy of `.env.dokploy.example` into that service's
   **Environment**. Use a URL-safe random database password (for example hex),
   since Compose embeds it in `DATABASE_URL`. Supply a strong bootstrap admin
   password. Provider settings can be configured after login. These values stay
   in Dokploy, not Actions artifacts or repository secrets.
4. Add the public HTTPS domain to service **web**, container port **80**. The
   template joins `dokploy-network`; no host port, database or desktop port is
   published. Deploy once and check `/healthz`, login and a Computer task. The
   Web health URL now proxies the actual API rather than returning SPA HTML.
5. Create a Dokploy API key with permission to read/update/deploy this Compose
   service and read its deployments. In GitHub **Settings > Secrets and
   variables > Actions**, add these repository secrets:

   | Secret | Value |
   | --- | --- |
   | `DOKPLOY_URL` | The Dokploy origin, e.g. `https://deploy.example.com` |
   | `DOKPLOY_API_KEY` | The Dokploy API key |
   | `DOKPLOY_COMPOSE_ID` | The service's Compose ID, not its project/environment ID |

   GitHub-hosted runners must be able to reach this API. Set repository
   **variable** `DOKPLOY_DEPLOY_ENABLED=true` only after initial setup succeeds.
   Leave Dokploy Git/webhook auto-deploy off. Re-run the workflow to exercise the
   integration; it patches only the public Compose file, never the saved
   environment or domain records. The helper uses the current Dokploy API's
   `x-api-key` header, not a browser login cookie.

The workflow uses ordinary Compose on one Docker Engine. There is no extra
worker, container registry server, VM, Kubernetes, or distributed execution
layer to operate. GitHub performs the heavy build; Dokploy performs the pulls
and container replacement. This setup needs a brief restart interval, not an
additional high-availability architecture.

`workspace-image` is a short-lived preload service: it runs `/bin/true` with a
temporary `/data`, not another desktop. The API starts only after this succeeds,
so dynamic user containers can find the configured image on the same Engine.
The database and artifacts have explicit physical volume names; do not change
them during routine updates. When adopting existing data, set the existing
volume/network names explicitly before the first deploy. The template does not
copy a local database, credentials, login state or uploads onto a new server.

### Updating And Rolling Back

Push to `main` for normal automatic updates. Use the Dokploy log for pull/start
details; the workflow waits for its own uniquely identified deployment to reach
`done`, `error` or `cancelled`, rather than treating a queued API response as
success. Check the public `/healthz` and application after an initial deployment.
If the workflow times out, inspect Dokploy before retrying: an already queued
deployment is not cancelled by a GitHub timeout.

To pause automatic deployments, set `DOKPLOY_DEPLOY_ENABLED=false`. To roll back,
paste a previous bundle's `compose.yaml` into the same Dokploy Raw service and
deploy, retaining its environment, domains and volumes. Or use `scripts/deploy.py`
from the corresponding source checkout with that bundle's `images.json` and
the three `DOKPLOY_*` variables. Do not delete old digests needed for rollback.
An image rollback does not undo schema changes or restore overwritten data.
For schema changes, pause automation, back up, apply the explicit maintenance
plan, then resume; this workflow intentionally does not invent migrations.

Dokploy's ordinary Compose update stops/recreates changed containers, not a
rolling second API replica. On SIGTERM the API stops claiming queued work and
pauses scheduling, while current runs get up to ten minutes to finish. New
inputs remain queued in PostgreSQL and resume on startup. Long-running or
waiting-for-user runs still get cancelled at the deadline. Forced cleanup and
HTTP shutdown fit inside the Compose `700s` stop grace. SIGINT or a second
signal requests immediate cancellation. Crash/power loss cannot drain runs.
This drain covers API restarts while its dependencies remain available. Treat
PostgreSQL image/schema changes as explicit maintenance too: Compose may replace
the database before dependent API work has finished.

### Computer Image Updates

Publishing a workspace image does not automatically replace an existing user
desktop. That would kill applications and background processes. Workspace state
reports the current/configured image IDs and whether an update is available;
an unavailable configured image is reported as unknown, not as up to date.
Use the administrator's **rebuild** action when that user's work can stop.
It verifies the new image exists before stopping the old desktop, and retains
the named `/data` and shared plugin volumes. Rebuilding restarts processes; it
does not preserve in-memory applications.

Computer-off compute containers also retain their named scratch volume. A
stopped outdated one is recreated on its next use; a running one is not killed
by normal tool attachment. For an explicit compute refresh, first stop/drain
the API so no new tools can race the operation, then identify the intended
containers on the target Engine:

```sh
docker ps -a --filter label=app=ochi --filter label=scope=compute --format '{{.Names}}'
docker stop --time 15 <selected-container>
docker rm <selected-container>
```

Start the API again. Next use recreates the container with the configured image
and reuses its data. Never add `-v`, remove its named volume, or use the
session-deletion operation to perform an image upgrade.

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
or VNC ports publicly. The Docker socket remains a private server capability;
the deployment uses the same single Dokploy host.

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

Schedule explicit workspace maintenance around active work. A successful image
build is not evidence that existing desktops were replaced or that Dokploy
finished deploying. Retain data volumes and verify the actual deployment state.

## References

- [GitHub: publishing Docker images](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [GitHub: container registry and visibility](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [Dokploy: Docker Compose](https://docs.dokploy.com/docs/core/docker-compose)
- [Dokploy: Compose API](https://docs.dokploy.com/docs/api/compose)
- [Dokploy: deployment API](https://docs.dokploy.com/docs/api/deployment)
- [Docker: Compose stop grace](https://docs.docker.com/reference/compose-file/services/#stop_grace_period)
