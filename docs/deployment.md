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

## Builds And The Update Channel

Builds run on GitHub, not on the deployment server or the developer's laptop:

```text
push main -> checks -> native amd64/arm64 images + combined Web/server binary
          -> GHCR deployment bundle + rolling edge update manifest
          -> no deployment or restart

administrator clicks Update in Ochi -> verify and replace application binary
administrator clicks Restart       -> drain runs, restart the same container
```

`.github/workflows/containers.yml` publishes three multi-platform images:
`<repo>-server`, `<repo>-postgres` and `<repo>-workspace` under
`ghcr.io/<repository-owner>/`. The server image contains the Go API and embedded
Vite production output in `/app/ochi-server`; there is no separate nginx/Web
container. Native GitHub runners build Linux amd64 and arm64 without CPU
emulation. `GITHUB_TOKEN` publishes the images and update assets; no Dokploy API
key, deployment webhook or registry password is required in GitHub Secrets.

The application is built for the exact source revision. Unchanged database and
workspace trees reuse existing images, and registry caches accelerate builds.
To refresh unchanged base images and OS packages, run **Actions > Containers >
Run workflow** with **rebuild** checked. Review upstream pins separately.

The workflow saves `images.json` and digest-pinned Dokploy `compose.yaml` in a
90-day Actions artifact. Images also receive immutable
`sha-<full-commit>-run-<run-id>-<attempt>` tags and an `edge` convenience alias.
Keep known deployment bundles and image digests for as long as recovery is
needed; Actions retention is not a backup policy.

### Rolling Prerelease, Not Per-Commit Versions

CI maintains one GitHub prerelease and moving tag named `edge`; it never marks
this as the latest formal release. Each build uploads two uniquely named
`ochi-linux-<arch>-<full-commit>-run-<run-id>-<attempt>.tar.gz` assets, each
containing only the `ochi-server` executable. They are not overwritten while
installations may be downloading them. Only after both assets are available
does CI replace `update.json` and move the development tag to the build's SHA.
The manifest records the product version, full revision, UTC build time, schema
hash and each archive's exact HTTPS URL, SHA-256 and byte size.

This is a technical download channel, not a manual release ceremony: normal
commits do not need semantic-version bumps, release notes or a milestone tag.
The product can stay at `0.1.0`; update availability is determined by the full
source revision. Build time is display metadata: rebuilding the same SHA does
not offer another application update. Formal releases remain optional, and
native client builds remain a separate process. The channel uses GitHub Release
assets rather than expiring Actions download links. Archived assets require
deliberate retention/cleanup; never remove the current manifest's assets or a
build still needed for recovery.

## First Installation

### Docker Compose

Use `compose.yaml` for a single Docker Engine without Dokploy. For source
experimentation, follow the root README; those development builds intentionally
do not enable self-update. To install published release images instead:

1. Enable Actions and complete a container workflow. Make the three GHCR
   packages public for anonymous pulls, or configure private registry read
   access on the target Engine. A public source repository alone does not make
   newly created container packages public.
2. Copy `.env.example` into a private `.env`, set database/admin credentials,
   and set `OCHI_SERVER_IMAGE`, `OCHI_POSTGRES_IMAGE`, `OCHI_WORKSPACE_IMAGE` to
   the exact digest references from that build's `images.json`. Preserve this
   configuration and all volume/network names across updates.
3. Run `docker compose pull db server workspace-image`, then
   `docker compose up -d --no-build db server`. The image override selects a
   release build; do not run a source `build` with those production image names.
4. Put an HTTPS reverse proxy in front of loopback port `8090` and set
   `SECURE_COOKIES=true`. Verify `/healthz`, sign-in and a Computer task.

The short-lived `workspace-image` service only preloads the desktop image onto
this Engine by running `/bin/true` with a temporary `/data`. It is not another
desktop; the API creates the real user containers. The database, Computer image
and app image are separate units, not three things to upgrade on each UI click.

### Optional Dokploy Installation

Dokploy may manage the container, domain, logs and host without participating
in application self-update:

1. Create a **Docker Compose** service with **Raw** source, not Docker
   Stack/Swarm. Paste `compose.yaml` from the completed workflow artifact.
   Retain the service names `db`, `server` and `workspace-image`.
2. Save a configured copy of `.env.dokploy.example` in the service's
   **Environment**. Use a URL-safe random database password (hex works), since
   Compose embeds it in `DATABASE_URL`. Supply a strong bootstrap administrator
   password. Provider configuration can be completed after sign-in.
3. Add the public HTTPS domain to **server**, container port **8080**. The
   template attaches this service to `dokploy-network`. No database, desktop or
   host application port is published by this template.
4. Keep Git/webhook auto-deploy disabled. Deploy the initial bundle manually,
   then verify public `/healthz`, login and a Computer task.

Environment values stay in Dokploy, not Actions artifacts or source control.
No Dokploy API credentials are used by Ochi or the workflow. Creating or updating
an image does not automatically replace the running application.

## Application Self-Update

Linux amd64/arm64 **release** builds with the embedded Web app expose update
controls in **Administration > System**. Source/API-only development processes
and unsupported platforms cannot install updates. The default manifest is:

```text
https://github.com/xxxbrian/ochi/releases/download/edge/update.json
```

`OCHI_UPDATE_URL` optionally selects another HTTPS manifest, for example in a
maintained fork. It is not a deployment-service endpoint. Clicking **Update**
downloads the selected build, verifies its declared size and mandatory SHA-256,
checks that it contains the single expected executable and replaces the running
binary while retaining a backup. This changes the on-disk executable, not the
current process. The administrator explicitly requests **Restart** to run it.
The page reconnects after the process restarts; an interrupted HTTP response is
not proof of an unsuccessful update.

The restart drains active work before exiting. The Docker configuration uses
`restart: unless-stopped`, so Docker restarts the same container after process
exit. A directly managed binary installation needs an equivalent service
supervisor with restart-on-exit; the application does not launch its own
replacement process. A source development server is not such an installation.

### Writable Layer And Recovery

The executable, update record and backup live in the container's writable
`/app` directory, **not** in the database/artifact volumes. Do not make the
container read-only or bind-mount a single executable file. This deliberately
follows the simple in-container binary update model:

| Operation | Application used afterward |
| --- | --- |
| Ochi restart or Docker restart of the same container | Updated executable |
| Delete/recreate container from the original image | Executable from that image |
| Pull a newer pinned image and recreate container | Executable from the new image |

Dokploy still manages the container, but its image identity does not change
when Ochi changes the executable. Ochi's build information is the authority for
which application revision is running. A Dokploy redeploy/recreate or
`docker compose up --force-recreate` may revert it to the configured image;
this is expected, not a durable image upgrade. When deliberately refreshing the
base image, update the server image digest to the desired build first and
preserve environment, routes, networks and volumes.

The retained application backup can be restored through the same administrator
controls while Ochi is running. If a new binary cannot start, use host/container
access to restore `/app/ochi-server.backup` to `/app/ochi-server`, or deliberately
recreate just the server from a known-good pinned image. Do not remove database,
artifacts or workspace volumes. Binary recovery does not roll back schema/data,
base OS packages or the desktop image. This is not an automatic health rollback
or zero-downtime deployment system.

Application self-update requires the target schema hash to match the running
schema. A schema change needs a verified backup and explicit one-off maintenance
before starting the matching image; there is no silent runtime migration chain.
Database major versions, OS/runtime dependencies, Compose topology and Computer
images likewise remain explicit maintenance rather than ordinary app updates.

### Graceful Restart

On SIGTERM or an administrator-requested restart the API stops claiming queued
work and pauses scheduling. Current runs get up to ten minutes to finish; new
inputs remain queued in PostgreSQL and resume on startup. Runs still active or
waiting for a user at the deadline are cancelled. Forced cleanup and HTTP
shutdown fit inside Compose's `700s` stop grace. SIGINT or a second signal
requests immediate cancellation; crashes and power loss cannot drain work.
This protects API restarts only while its dependencies remain available.

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
docker compose build
docker compose up -d db server
docker compose ps
docker compose exec -T server wget -qO- http://127.0.0.1:8080/healthz
```

Compose publishes only `127.0.0.1:8090`. Put an HTTPS reverse proxy in front of
the Web/API origin for physical-device access. Forward SSE without response
buffering and support WebSocket upgrade for the computer viewer. Set sensible
upload/timeouts for intended use. Do not expose PostgreSQL, Docker, bridge, CDP
or VNC ports publicly. The Docker socket remains a private server capability;
the application and its workspaces use the same single Docker Engine.

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
- [GitHub: release assets](https://docs.github.com/en/rest/releases/assets)
- [Docker: container restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/)
- [Docker: Compose stop grace](https://docs.docker.com/reference/compose-file/services/#stop_grace_period)
