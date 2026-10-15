"""Atomic shared extension configuration; no model-visible secret values."""
from __future__ import annotations

import contextlib
import json
import os
import re
import threading
import uuid
from pathlib import Path
from typing import Any

EXTENSIONS_ROOT = Path(os.environ.get("EXTENSIONS_ROOT", "/opt/extensions"))
EXTENSIONS_CONFIG = EXTENSIONS_ROOT / "extensions.json"
EXTENSIONS_LOCK = threading.RLock()

def _extension_id(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", value):
        raise ValueError("extension id must be 1-64 letters, numbers, hyphens or underscores")
    return value


def _load_extensions() -> dict[str, Any]:
    with EXTENSIONS_LOCK:
        try:
            data = json.loads(EXTENSIONS_CONFIG.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"skills": {}, "mcp": {}}
        return {"skills": data.get("skills", {}), "mcp": data.get("mcp", {})}


def _save_extensions(data: dict[str, Any]) -> None:
    EXTENSIONS_ROOT.mkdir(parents=True, exist_ok=True)
    temp = EXTENSIONS_CONFIG.with_suffix(f".{uuid.uuid4().hex}.tmp")
    try:
        with temp.open("w", encoding="utf-8") as handle:
            os.chmod(temp, 0o600)
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.replace(temp, EXTENSIONS_CONFIG)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temp.unlink()


