# Repository Tools

Only maintained, repeatable tools belong here. Inputs must be explicit and must
not depend on private conversations, signing files or another developer's home
directory. Temporary experiments and deployment-specific maintenance stay out of
the public tree.

## App Icons

`generate-icons.py` derives the current platform icons from the preserved
`assets/branding/original.png`. It does not generate, redraw, recolor or retouch
the image. Requirements: Python 3 and Pillow 12.1.1 (use a virtual environment).

```sh
python3 scripts/generate-icons.py
```

The tool updates the owned Web/Expo/native launcher assets. The Android adaptive
foreground includes safe margins; iOS receives an opaque square without baked-in
rounding. A contact sheet and checksum manifest go under ignored `build/branding/`,
not into the source documentation. The original source bytes are never modified.

## Build And Release Tools

`deploy.py` uses only Python's standard library. It renders the production
Dokploy Compose template from the three digest-pinned images in a workflow
bundle (the Web app is embedded in the server image):

```sh
python3 scripts/deploy.py render --bundle /path/to/images.json --output /tmp/ochi-compose.yaml
```

This is a pure renderer: it never reads private environment values, calls a
deployment service, updates a running installation or needs API credentials.
Use the checkout corresponding to the bundle; its production template comes
from that checkout. See [setup and recovery](../docs/deployment.md).

`release.py` also uses only the standard library. `metadata` reads the current
product version/schema and emits UTC build metadata. `package` validates a
Linux amd64/arm64 ELF binary and creates an immutable run-specific archive with
exactly one `ochi-server` executable. `manifest` requires both architectures,
validates their payloads, and writes HTTPS asset URLs, sizes and SHA-256 values
to `update.json`. It reads no configured `.env` and performs no publishing:

```sh
python3 scripts/release.py metadata
docker build --target binary --output type=local,dest=build/binary .
python3 scripts/release.py package --binary build/binary/ochi-server --arch arm64 \
  --directory build/release --revision "$(git rev-parse HEAD)" --run-id 1 --attempt 1
```

The example exports the local Docker Engine's architecture. CI supplies release
build arguments and runs natively for each architecture; it uploads the unique
archives before replacing the rolling prerelease's manifest. Existing archive
assets are never clobbered. The workflow automatically builds/publishes only;
installed Ochi applications require an explicit administrator update/restart.

```sh
python3 -B -m unittest discover -s scripts/tests -v
```

## Module Tools

- `web/scripts/`: shared-token generation and Web contract regressions; use
  `pnpm --dir web tokens` and `pnpm --dir web test`.
- `mobile/scripts/`: native contract regressions and local release helpers; use
  `pnpm --dir mobile test` and see `docs/releasing.md` for distribution commands.
- `workspace/tests/`: isolated Python tool, browser and desktop contract tests.
- `server/`: package-local Go tests; real-provider evaluations are explicitly
  opt-in and are described in `server/README.md`.
