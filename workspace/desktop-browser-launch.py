#!/usr/bin/python3
"""Route user desktop links into the bridge's persistent main browser."""
from __future__ import annotations

import json
import contextlib
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request


def launch(urls: list[str]) -> None:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for url in urls or [""]:
        suffix = "?" + urllib.parse.urlencode({"url": url}) if url else ""
        with opener.open("http://127.0.0.1:8080/browser/desktop-launch" + suffix, timeout=50) as response:
            result = json.load(response)
            if result.get("error"):
                raise RuntimeError(str(result["error"]))


if __name__ == "__main__":
    try:
        launch(sys.argv[1:])
    except (OSError, ValueError, RuntimeError, urllib.error.URLError) as exc:
        message = f"Could not open Chromium: {exc}"
        print(message, file=sys.stderr)
        with contextlib.suppress(OSError, subprocess.SubprocessError):
            subprocess.run(["notify-send", "Chromium", message], timeout=5, check=False)
        raise SystemExit(1)
