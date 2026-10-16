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

## Module Tools

- `web/scripts/`: shared-token generation and Web contract regressions; use
  `pnpm --dir web tokens` and `pnpm --dir web test`.
- `mobile/scripts/`: native contract regressions and local release helpers; use
  `pnpm --dir mobile test` and see `docs/releasing.md` for distribution commands.
- `workspace/tests/`: isolated Python tool, browser and desktop contract tests.
- `server/`: package-local Go tests; real-provider evaluations are explicitly
  opt-in and are described in `server/README.md`.
