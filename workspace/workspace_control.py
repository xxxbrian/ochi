"""The plugin control process is separate from user-executable workspaces."""
from __future__ import annotations

import hashlib
import hmac
import os
from pathlib import Path
from typing import Any

CONTROL_ONLY = os.environ.get("OCHI_CONTROL_ONLY") == "1"
CONTROL_ROOT = Path(os.environ.get("OCHI_CONTROL_ROOT", "/var/lib/ochi-control"))
BRIDGE_TOKEN = os.environ.get("OCHI_BRIDGE_TOKEN", "")
MCP_ROOT = Path("/data/mcp")


def authorize_control(method: str, route: str, authorization: str) -> None:
    # Catalog metadata is public; it contains no transport settings or secrets.
    if method == "GET" and route in {"/health", "/tools", "/skills/index"}:
        return
    if not BRIDGE_TOKEN or not hmac.compare_digest(authorization, "Bearer " + BRIDGE_TOKEN):
        raise PermissionError("private bridge authentication required")
    if not CONTROL_ONLY:
        return
    if route.startswith("/extensions/"):
        return
    if method == "POST" and route == "/embeddings":
        return
    if method == "POST" and (route == "/tools/tool_search" or route.startswith("/tools/mcp_")):
        return
    raise PermissionError("operation is unavailable in plugin control")


def stdio_runtime(config: dict[str, Any]) -> tuple[str, list[str], dict[str, str], str]:
    """Each administrator-provided component gets its own unprivileged identity."""
    if not CONTROL_ONLY or os.getuid() != 0:
        raise RuntimeError("stdio MCP requires the plugin control runtime")
    uid = config.get("runtime_uid")
    if not isinstance(uid, int) or not 20_000 <= uid <= 2_000_000_000:
        raise ValueError("stdio MCP has no runtime identity")
    from workspace_runtime import RUN_SCOPE
    scope = RUN_SCOPE.get()
    identity = scope.get("user_id", "") + ":" + scope.get("session_id", "")
    scope_id = hashlib.sha256(identity.encode()).hexdigest()[:24] if identity != ":" else "test"
    parent = MCP_ROOT / config["id"]
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chown(parent, uid, uid)
    os.chmod(parent, 0o700)
    cwd = parent / scope_id
    cwd.mkdir(exist_ok=True, mode=0o700)
    os.chown(cwd, uid, uid)
    os.chmod(cwd, 0o700)
    env = {
        "PATH": "/opt/venv/bin:/usr/local/bin:/usr/bin:/bin",
        "HOME": str(cwd), "LANG": "C.UTF-8", "TMPDIR": str(cwd),
        "OCHI_PLUGIN_WORKDIR": str(cwd),
        "OCHI_SESSION_ID": scope.get("session_id", ""),
        **config.get("env", {}),
    }
    # No ambient control token, global credentials, DISPLAY or DBus are inherited.
    argv = [
        "--reuid", str(uid), "--regid", str(uid), "--clear-groups",
        "--no-new-privs", "--bounding-set=-all", "--",
        config["command"], *config.get("args", []),
    ]
    return "/usr/bin/setpriv", argv, env, str(cwd)
