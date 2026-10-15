"""Per-request extension allowlists supplied by the trusted Go service."""
from __future__ import annotations

import contextvars
import json
import re
from typing import Any

from workspace_runtime import RUN_SCOPE

EXTENSION_ACCESS: contextvars.ContextVar[dict[str, frozenset[str]] | None] = contextvars.ContextVar("extension_access", default=None)


def set_extension_access(raw: str | None) -> None:
    # ThreadingHTTPServer can reuse a request thread. Never inherit its previous
    # user's permissions, even if this request has no policy or malformed JSON.
    EXTENSION_ACCESS.set(None)
    if raw is None:
        return
    EXTENSION_ACCESS.set({"skills": frozenset(), "mcp": frozenset()})
    if len(raw) > 64 * 1024:
        raise ValueError("plugin policy exceeds request limit")
    value = json.loads(raw)
    if not isinstance(value, dict) or set(value) != {"skills", "mcp"}:
        raise ValueError("invalid plugin policy")
    result = {}
    for kind in ("skills", "mcp"):
        ids = value[kind]
        if not isinstance(ids, list) or len(ids) > 512 or any(
            not isinstance(item, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", item) for item in ids
        ):
            raise ValueError("invalid plugin components")
        result[kind] = frozenset(ids)
    EXTENSION_ACCESS.set(result)


def extension_allowed(kind: str, component_id: str) -> bool:
    access = EXTENSION_ACCESS.get()
    if access is not None:
        return component_id in access.get(kind, ())
    # Unscoped administrator management can inspect the global catalog. Model
    # runs require a resolved per-user policy, even when the allowlist is empty.
    scope: dict[str, Any] = RUN_SCOPE.get()
    return not scope.get("session_id") and not scope.get("run_id")
