"""Private MCP lifecycle and demand-discovered tools via the official SDK."""
from __future__ import annotations

import asyncio
import contextlib
import contextvars
import hashlib
import json
import queue
import re
import threading
import time
import urllib.parse
import uuid
from typing import Any

from workspace_extensions import EXTENSIONS_LOCK, _extension_id, _load_extensions, _save_extensions
from workspace_plugins import extension_allowed
from workspace_runtime import FILES_ROOT, RUN_SCOPE, _safe_cwd, _scope_cwd, _workspace_env
from workspace_schema import ToolArgumentError, validate_arguments, validate_schema

MAX_DISCOVERED_TOOLS = 6
MAX_DISCOVERY_CANDIDATES = 32
MAX_TOOL_SCHEMA_BYTES = 16 * 1024
MAX_DISCOVERY_BYTES = 64 * 1024


def _checked_tool(tool: dict[str, Any]) -> dict[str, Any]:
    value = dict(tool)
    try:
        if len(json.dumps(value.get("parameters"), ensure_ascii=True).encode()) > MAX_TOOL_SCHEMA_BYTES:
            raise ToolArgumentError("unsupported_schema", "$", "schema exceeds 16 KB")
        validate_schema(value.get("parameters"))
        value.pop("schema_error", None)
    except ToolArgumentError as exc:
        value["schema_error"] = exc.detail
    return value

def _mcp_tool_name(server_id: str, tool_name: str) -> str:
    prefix = "mcp_" + re.sub(r"[^a-zA-Z0-9_]", "_", server_id)[:20] + "_"
    suffix = re.sub(r"[^a-zA-Z0-9_]", "_", tool_name)
    digest = hashlib.sha256((server_id + ":" + tool_name).encode()).hexdigest()[:6]
    return prefix + suffix[:64 - len(prefix) - 7] + "_" + digest


def _mcp_public(config: dict[str, Any]) -> dict[str, Any]:
    result = {key: config.get(key) for key in ("id", "name", "transport", "command", "args", "cwd", "url", "enabled", "tools", "status", "error", "updated_at")}
    result.update(env_keys=sorted(config.get("env", {})), header_keys=sorted(config.get("headers", {})))
    return result


def _mcp_error(config: dict[str, Any], error: BaseException) -> str:
    message = str(error) or type(error).__name__
    for mapping in (config.get("env", {}), config.get("headers", {})):
        for value in mapping.values():
            if isinstance(value, str) and value:
                message = message.replace(value, "[redacted]")
    return message[:4000]


def save_mcp(args: dict[str, Any], server_id: str | None = None) -> dict[str, Any]:
    with EXTENSIONS_LOCK:
        data = _load_extensions()
        server_id = _extension_id(server_id or args.get("id") or ("server-" + uuid.uuid4().hex[:8]))
        previous = data["mcp"].get(server_id, {})
        config = {**previous, **{key: value for key, value in args.items() if key in {"name", "transport", "command", "args", "cwd", "url", "enabled"}}, "id": server_id, "updated_at": time.time()}
        for key in ("env", "headers"):
            incoming = args.get(key, {})
            if not isinstance(incoming, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in incoming.items()):
                raise ValueError(f"{key} must contain string values")
            config[key] = {**previous.get(key, {}), **{k: v for k, v in incoming.items() if v != ""}}
            cleared = args.get("clear_" + key, [])
            if not isinstance(cleared, list) or not all(isinstance(k, str) for k in cleared):
                raise ValueError(f"clear_{key} must be a list of keys")
            for name in cleared:
                config[key].pop(name, None)
        config.setdefault("name", server_id)
        config.setdefault("transport", "http" if config.get("url") else "stdio")
        config.setdefault("enabled", True)
        config.setdefault("args", [])
        config.setdefault("env", {})
        config.setdefault("headers", {})
        config.setdefault("cwd", str(FILES_ROOT))
        if config["transport"] not in {"stdio", "http"}:
            raise ValueError("transport must be stdio or http")
        if config["transport"] == "stdio" and not isinstance(config.get("command"), str):
            raise ValueError("stdio MCP requires command")
        if config["transport"] == "http" and urllib.parse.urlsplit(config.get("url", "")).scheme not in {"http", "https"}:
            raise ValueError("HTTP MCP requires an http or https URL")
        if not isinstance(config["args"], list) or not all(isinstance(value, str) for value in config["args"]):
            raise ValueError("args must be a list of strings")
        for name in ("env", "headers"):
            if not isinstance(config[name], dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in config[name].items()):
                raise ValueError(f"{name} must contain string values")
        connection_keys = ("transport", "command", "args", "env", "cwd", "url", "headers")
        if not previous or any(config.get(key) != previous.get(key) for key in connection_keys):
            config["status"], config["error"], config["tools"] = "untested", "", []
        data["mcp"][server_id] = config
        _save_extensions(data)
    MCP.close(server_id)
    return _mcp_public(config)


class MCPConnection:
    """Keep the official SDK's transport and subprocess alive on one async task."""

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.jobs: queue.Queue[tuple[str, dict[str, Any], threading.Event, list[Any]]] = queue.Queue()
        self.ready = threading.Event()
        self.tools: list[dict[str, Any]] = []
        self.error = ""
        call_context = contextvars.copy_context()
        self.thread = threading.Thread(target=lambda: call_context.run(asyncio.run, self._loop()), name=f"mcp-{config['id']}", daemon=True)
        self.thread.start()

    async def _loop(self) -> None:
        try:
            from mcp import Client, StdioServerParameters
            from mcp.client.streamable_http import streamable_http_client
            async with contextlib.AsyncExitStack() as stack:
                if self.config["transport"] == "stdio":
                    cwd = _safe_cwd(self.config.get("cwd"))
                    target = StdioServerParameters(command=self.config["command"], args=self.config.get("args", []), env=_workspace_env(self.config.get("env")), cwd=str(cwd))
                else:
                    import httpx2
                    http = await stack.enter_async_context(httpx2.AsyncClient(headers=self.config.get("headers", {}), timeout=60, follow_redirects=True))
                    target = streamable_http_client(self.config["url"], http_client=http)
                client = await stack.enter_async_context(Client(target, read_timeout_seconds=60))
                cursor = None
                for _ in range(20):
                    listing = await client.list_tools(cursor=cursor)
                    for tool in listing.tools:
                        raw = tool.model_dump(mode="json", by_alias=True)
                        # Annotations remain visible to the administrator, but an
                        # untrusted server cannot grant itself scheduler safety.
                        self.tools.append(_checked_tool({"name": raw["name"], "description": raw.get("description", ""), "parameters": raw.get("inputSchema", {"type": "object", "properties": {}}), "annotations": raw.get("annotations")}))
                    cursor = listing.next_cursor
                    if not cursor:
                        break
                self.ready.set()
                while True:
                    name, args, done, result = await asyncio.to_thread(self.jobs.get)
                    if name == "__close__":
                        done.set()
                        return
                    try:
                        called = await client.call_tool(name, args, read_timeout_seconds=120)
                        payload = called.model_dump(mode="json", by_alias=True)
                        blocks = payload.get("content", [])
                        payload["text"] = "\n".join(block.get("text", "") for block in blocks if block.get("type") == "text")
                        image = next((block for block in blocks if block.get("type") == "image"), None)
                        if image:
                            payload["image"] = {"mime_type": image.get("mimeType", "image/png"), "data": image.get("data", ""), "coordinate_space": "mcp"}
                            payload["content"] = [{key: value for key, value in block.items() if key != "data"} if block.get("type") == "image" else block for block in blocks]
                        result.append(payload)
                    except Exception as exc:
                        result.append(RuntimeError(_mcp_error(self.config, exc)))
                    finally:
                        done.set()
        except BaseException as exc:
            self.error = _mcp_error(self.config, exc)
            self.ready.set()
        finally:
            while not self.jobs.empty():
                _, _, done, result = self.jobs.get_nowait()
                result.append(RuntimeError(self.error or "MCP connection closed"))
                done.set()

    def wait_ready(self) -> None:
        if not self.ready.wait(60):
            raise TimeoutError("MCP initialization timed out")
        if self.error:
            raise RuntimeError(self.error)
        if not self.thread.is_alive():
            raise RuntimeError("MCP connection is closed")

    def call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        self.wait_ready()
        done, result = threading.Event(), []
        self.jobs.put((name, args, done, result))
        if not done.wait(125):
            raise TimeoutError("MCP tool call timed out")
        if not result:
            raise RuntimeError("MCP connection closed before a result")
        if isinstance(result[0], BaseException):
            raise result[0]
        return result[0]

    def close(self) -> None:
        self.jobs.put(("__close__", {}, threading.Event(), []))


class MCPRuntime:
    def __init__(self) -> None:
        self.connections: dict[str, tuple[str, MCPConnection]] = {}
        self.lock = threading.Lock()

    def connection(self, config: dict[str, Any]) -> MCPConnection:
        fingerprint = json.dumps({key: config.get(key) for key in ("transport", "command", "args", "env", "cwd", "url", "headers", "enabled")}, sort_keys=True)
        with self.lock:
            existing = self.connections.get(config.get("connection_id",config["id"]))
            if existing and existing[0] == fingerprint and existing[1].thread.is_alive() and not existing[1].error:
                return existing[1]
            if existing:
                existing[1].close()
            connection = MCPConnection(config)
            self.connections[config.get("connection_id",config["id"])] = (fingerprint, connection)
            return connection

    def close(self, server_id: str) -> None:
        with self.lock:
            for key in [key for key in self.connections if key == server_id or key.startswith(server_id + ":")]:
                existing = self.connections.pop(key)
                existing[1].close()

    def definitions(self, names: set[str] | None = None) -> list[dict[str, Any]]:
        definitions = []
        configs = _load_extensions()["mcp"]
        with self.lock:
            removed = {key for key in self.connections if key.split(":",1)[0] not in configs}
        for server_id in removed:
            self.close(server_id)
        for server_id, config in sorted(configs.items()):
            if not config.get("enabled", True):
                self.close(server_id)
                continue
            if not extension_allowed("mcp", server_id):
                continue
            for tool in config.get("tools", []):
                name = _mcp_tool_name(server_id, tool["name"])
                if names is not None and name not in names:
                    continue
                checked = _checked_tool(tool)
                if "schema_error" in checked:
                    continue
                # Missing execution attributes mean conservative serial calls.
                definitions.append({"name": name, "description": f"[{config.get('name', server_id)}] {str(tool.get('description', ''))[:1200]}", "parameters": tool["parameters"]})
        return definitions

    def definition(self, name: str) -> dict[str, Any] | None:
        return next(iter(self.definitions({name})), None)

    def search(self, args: dict[str, Any]) -> dict[str, Any]:
        query = args["query"].strip().casefold()
        words = set(re.findall(r"[^\W_]+", query)) - {"the", "a", "an", "to", "for", "and", "with", "tool", "tools"}
        if not words:
            return {"tools": [], "matched": 0, "truncated": False, "unsupported": []}
        candidates, unsupported = [], []
        # Discovery reads already tested metadata only. It never launches a
        # subprocess or connects to the extension merely to find a tool.
        for server_id, config in sorted(_load_extensions()["mcp"].items()):
            if not config.get("enabled", True) or not extension_allowed("mcp", server_id):
                continue
            for tool in config.get("tools", []):
                name = _mcp_tool_name(server_id, tool["name"])
                label = str(config.get("name", server_id)) + " " + tool["name"]
                description = str(tool.get("description", ""))[:1200]
                score = sum(4 * (word in label.casefold()) + (word in description.casefold()) for word in words)
                if not score:
                    continue
                candidates.append((-score, name, {"name": name, "description": f"[{config.get('name', server_id)}] {description}", "parameters": tool.get("parameters")}))
        candidates.sort(key=lambda item: (item[0], item[1]))
        limit = min(MAX_DISCOVERED_TOOLS, int(args.get("limit", MAX_DISCOVERED_TOOLS)))
        selected, size = [], 0
        for _, name, definition in candidates[:MAX_DISCOVERY_CANDIDATES]:
            if len(selected) >= limit:
                break
            checked = _checked_tool(definition)
            if "schema_error" in checked:
                if len(unsupported) < 6:
                    unsupported.append({"name": name, "error": checked["schema_error"]})
                continue
            encoded = len(json.dumps(definition, ensure_ascii=True).encode())
            if size + encoded > MAX_DISCOVERY_BYTES:
                break
            selected.append(definition)
            size += encoded
        return {"tools": selected, "matched": len(candidates), "truncated": len(selected) < len(candidates), "unsupported": unsupported}

    def call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        for server_id, config in _load_extensions()["mcp"].items():
            if config.get("enabled", True) and extension_allowed("mcp", server_id):
                for tool in config.get("tools", []):
                    if _mcp_tool_name(server_id, tool["name"]) == name:
                        validate_arguments({"name": name, "parameters": tool["parameters"]}, args)
                        scope = RUN_SCOPE.get()
                        if scope.get("session_id"):
                            cwd = str(_scope_cwd())
                            config = {**config, "connection_id": server_id + ":" + scope["session_id"], "cwd": cwd,
                                      "env": {**config.get("env", {}), "ASSISTANT_WORKDIR": cwd, "ASSISTANT_SESSION_ID": scope["session_id"], "ASSISTANT_RUN_ID": scope.get("run_id", "")}}
                        return self.connection(config).call(tool["name"], args)
        raise ValueError("MCP tool is unavailable or disabled")

    def test(self, server_id: str) -> dict[str, Any]:
        config = _load_extensions()["mcp"].get(server_id)
        if not config:
            raise ValueError("MCP server does not exist")
        try:
            connection = self.connection(config)
            connection.wait_ready()
            result = {"ok": True, "tools": connection.tools, "error": ""}
        except Exception as exc:
            result = {"ok": False, "tools": [], "error": _mcp_error(config, exc)}
        with EXTENSIONS_LOCK:
            data = _load_extensions()
            if server_id in data["mcp"]:
                data["mcp"][server_id].update(tools=result["tools"], status="connected" if result["ok"] else "error", error=result["error"])
                _save_extensions(data)
        return result


MCP = MCPRuntime()
