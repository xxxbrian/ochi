#!/usr/bin/python3
"""Seed first-use desktop preferences without replacing user settings."""
from __future__ import annotations

import os
from pathlib import Path


def prepare_desktop(defaults: Path, config: Path, share: Path, state: Path, cache: Path) -> int:
    created = 0
    for directory in (config, share, state, cache):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    for kind, destination in (("config", config), ("share", share)):
        for source in sorted((defaults / kind).rglob("*")):
            if not source.is_file():
                continue
            target = destination / source.relative_to(defaults / kind)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            try:
                # O_EXCL also leaves an existing symlink untouched.
                with target.open("xb") as output:
                    output.write(source.read_bytes())
            except FileExistsError:
                continue
            created += 1
    return created


def main() -> None:
    os.umask(0o077)
    data = Path("/data")
    for directory in (data / "desktop" / "Desktop", data / "desktop" / "Templates", data / "work" / "downloads"):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    created = prepare_desktop(
        Path(__file__).with_name("desktop-defaults"),
        Path(os.environ["XDG_CONFIG_HOME"]),
        Path(os.environ["XDG_DATA_HOME"]),
        Path(os.environ["XDG_STATE_HOME"]),
        Path(os.environ["XDG_CACHE_HOME"]),
    )
    print(f"workspace desktop: seeded {created} missing preference files", flush=True)


if __name__ == "__main__":
    main()
