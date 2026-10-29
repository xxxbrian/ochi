"""Private transport settings and an atomically published, secret-free catalog."""
from __future__ import annotations

import contextlib
import json
import os
import re
import threading
import uuid
from pathlib import Path
from typing import Any
from workspace_control import CONTROL_ONLY, CONTROL_ROOT

EXTENSIONS_ROOT = Path(os.environ.get("EXTENSIONS_ROOT", "/opt/extensions"))
EXTENSIONS_CONFIG = CONTROL_ROOT / "extensions.json" if CONTROL_ONLY else EXTENSIONS_ROOT / "catalog.json"
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


def _write_config(path: Path, data: dict[str, Any], mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
    try:
        with temp.open("w", encoding="utf-8") as handle:
            os.chmod(temp, mode)
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.replace(temp, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temp.unlink()


def _public_catalog(data: dict[str, Any]) -> dict[str, Any]:
    skill_keys = ("id", "name", "description", "version", "revision", "path", "enabled", "installed_at", "updated_at", "compatibility")
    return {
        "skills": {key: {field: value[field] for field in skill_keys if field in value}
                   for key, value in data.get("skills", {}).items()},
        "mcp": {key: {field: value[field] for field in ("id", "name", "enabled", "tools") if field in value}
                for key, value in data.get("mcp", {}).items()},
    }


def _save_extensions(data: dict[str, Any]) -> None:
    if not CONTROL_ONLY:
        raise PermissionError("extension configuration belongs to plugin control")
    CONTROL_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(CONTROL_ROOT, 0o700)
    _write_config(EXTENSIONS_CONFIG, data, 0o600)
    _write_config(EXTENSIONS_ROOT / "catalog.json", _public_catalog(data), 0o644)

