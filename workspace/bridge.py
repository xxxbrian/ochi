#!/usr/bin/env python3
"""Small internal tool bridge for a single assistant workspace.

The bridge deliberately exposes only the workspace container.  It does not
mount or access the host Docker socket. Headed Chromium is provisioned lazily
per persistent profile; session-owned browser pages and Computer Use share
the private Xvfb display behind a desktop lease.
"""
from __future__ import annotations

import base64
import asyncio
import contextlib
import contextvars
import io
import json
import mimetypes
import os
import queue
import re
import subprocess
import threading
import time
import traceback
import uuid
import struct
import signal
import shutil
import sys
import tarfile
import urllib.request
import urllib.parse
from html.parser import HTMLParser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

from workspace_runtime import (COMPUTE_ONLY, DATA_ROOT, FILES_ROOT, SCREENSHOT_ROOT,
    DISPLAY_SIZE, FILE_CHUNK_BYTES, MAX_BODY_BYTES, MAX_FILE_BYTES, MAX_OUTPUT_CHARS, MAX_TEXT_CHARS,
    MAX_PREVIEW_BYTES, MAX_PREVIEW_CHARS, MAX_DOCUMENT_BYTES,
    RUN_SCOPE, _clamp_int, _truncate, _json_error, _execution_environment, _scope_cwd,
    _safe_relative, _safe_cwd, _file_metadata,
    _publish_file, _stage_file, _file_digest, _cancel_run, _interrupt_operation, _workspace_env,
    _run_command, _image_result)
from workspace_extensions import EXTENSIONS_ROOT, EXTENSIONS_LOCK, _extension_id, _load_extensions, _save_extensions
from workspace_control import CONTROL_ONLY, authorize_control
from workspace_contract import CONTRACT
from workspace_jobs import JOBS, tracked_request
from workspace_plugins import set_extension_access
from workspace_skills import _skill_content, _skill_public, install_skill, prepare_skill, tool_skills_list, tool_skills_read, skills_index
from workspace_mcp import MCP, _mcp_public, save_mcp
from workspace_schema import ToolArgumentError, strict_json, validate_arguments, validate_schema
from workspace_browser import (BROWSER, sync_playwright, _browser_call, _page_summary,
    tool_browser_goto, tool_browser_observe, tool_browser_click, tool_browser_type,
    tool_browser_scroll, tool_browser_screenshot, tool_browser_tabs,
    tool_browser_select_tab, tool_browser_upload, tool_browser_download,
    tool_browser_status, tool_browser_resume, tool_browser_action)
from workspace_computer import (tool_computer_screenshot, tool_computer_observe,
    tool_computer_click, tool_computer_type, tool_computer_key, tool_computer_scroll,
    tool_computer_move, tool_computer_drag, tool_computer_windows, tool_computer_apps,
    close_computer)

HOST = os.environ.get("BRIDGE_HOST", "0.0.0.0")
PORT = int(os.environ.get("BRIDGE_PORT", "8080"))


# Intrinsic tool contract, mirrored by the Go server's embedded catalog.
# GET /tools returns the same definitions; tests enforce that both copies agree.
TOOLS: list[dict[str, Any]] = json.loads(Path(__file__).with_name("tools.json").read_text(encoding="utf-8"))
if COMPUTE_ONLY:
    TOOLS = [item for item in TOOLS if item["name"] in {"exec", "job", "files_list", "files_read", "files_write", "web_fetch"}]
TOOL_NAMES = {item["name"] for item in TOOLS}
for _tool in TOOLS:
    validate_schema(_tool["parameters"])


def tool_exec(args: dict[str, Any]) -> dict[str, Any]:
    return JOBS.execute(args)


def tool_files_list(args: dict[str, Any]) -> dict[str, Any]:
    path = _safe_relative(args.get("path", "")) if args.get("path") else _scope_cwd()
    if not path.exists():
        raise FileNotFoundError("path does not exist")
    if not path.is_dir():
        raise ValueError("path is not a directory")
    recursive = bool(args.get("recursive", False))
    max_entries = _clamp_int(args.get("max_entries"), 200, 1, 500)
    iterator = path.rglob("*") if recursive else path.iterdir()
    entries: list[dict[str, Any]] = []
    for child in sorted(iterator, key=lambda item: str(item)):
        if len(entries) >= max_entries:
            break
        try:
            child.resolve().relative_to(DATA_ROOT.resolve())
            entries.append(_file_metadata(child))
        except (OSError, ValueError):
            continue
    return {"root": str(path), "entries": entries, "truncated": len(entries) >= max_entries}


def tool_files_read(args: dict[str, Any]) -> dict[str, Any]:
    path = _safe_relative(args.get("path"))
    if not path.is_file():
        raise FileNotFoundError("file does not exist")
    mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    metadata = _file_metadata(path)
    if mime_type.startswith("image/"):
        if mime_type != "image/svg+xml":
            return {**metadata, "image": _image_result(path, coordinate_space="file")}
    if path.suffix.lower() in {".pdf", ".docx", ".xlsx", ".pptx"}:
        if path.stat().st_size > MAX_DOCUMENT_BYTES:
            return {**metadata, "content": "", "truncated": True, "extraction": "Document exceeds the automatic preview input budget; use exec for targeted analysis."}
        try:
            result = subprocess.run(
                [sys.executable, "-B", str(Path(__file__).with_name("workspace_document_preview.py")), str(path),
                 str(_clamp_int(args.get("max_chars"), MAX_TEXT_CHARS, 1, MAX_PREVIEW_CHARS)),
                 str(_clamp_int(args.get("max_pages"), 30, 1, 100))],
                capture_output=False, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                check=False, timeout=15)
            if result.returncode or len(result.stdout) > 1_000_000:
                raise ValueError("document preview budget exceeded")
            preview = json.loads(result.stdout)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            preview = {"content": "", "truncated": True, "extraction": "Automatic text extraction could not finish within the preview budget; use exec for targeted analysis."}
        return {**metadata, **preview}
    max_bytes = _clamp_int(args.get("max_bytes"), 64_000, 1, MAX_PREVIEW_BYTES)
    with path.open("rb") as handle:
        data = handle.read(max_bytes + 1)
    text = data[:max_bytes].decode("utf-8", errors="replace")
    chars = _clamp_int(args.get("max_chars"), MAX_TEXT_CHARS, 1, MAX_PREVIEW_CHARS)
    text, clipped = _truncate(text, chars)
    return {**metadata, "content": text, "bytes": metadata["size"], "sampled_bytes": min(len(data), max_bytes), "truncated": len(data) > max_bytes or clipped}


def tool_files_write(args: dict[str, Any]) -> dict[str, Any]:
    path = _safe_relative(args.get("path"))
    content = args.get("content")
    if not isinstance(content, str):
        raise ValueError("content must be a string")
    encoded = content.encode("utf-8")
    if len(encoded) > 5_000_000:
        raise ValueError("content exceeds 5 MB")
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = "ab" if bool(args.get("append", False)) else "wb"
    with path.open(mode) as handle:
        handle.write(encoded)
    return {**_file_metadata(path), "bytes_written": len(encoded), "append": mode == "ab"}


class _PageText(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.skip = 0
        self.parts: list[str] = []
        self.links: list[dict[str, str]] = []
        self.anchor: dict[str, str] | None = None
        self.in_title = False
        self.title = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript"}:
            self.skip += 1
        if tag == "title":
            self.in_title = True
        if not self.skip and tag == "a":
            href = dict(attrs).get("href", "")
            self.anchor = {"url": href or "", "text": ""}
        if not self.skip and tag in {"p", "br", "div", "li", "h1", "h2", "h3", "tr"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript"} and self.skip:
            self.skip -= 1
        if tag == "title":
            self.in_title = False
        if tag == "a" and self.anchor:
            if self.anchor["url"] and len(self.links) < 80:
                self.links.append({"url": self.anchor["url"][:2048], "text": self.anchor["text"][:256]})
            self.anchor = None

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title += data
        if not self.skip:
            self.parts.append(data)
            if self.anchor:
                self.anchor["text"] += data


def tool_web_fetch(args: dict[str, Any]) -> dict[str, Any]:
    url = args.get("url", "")
    if not isinstance(url, str) or urllib.parse.urlsplit(url).scheme not in {"http", "https"}:
        raise ValueError("url must be http or https")
    request = urllib.request.Request(url, headers={"User-Agent": "Ochi/0.1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        mime = response.headers.get_content_type()
        charset = response.headers.get_content_charset() or "utf-8"
        final_url = response.url
        status = response.status
        filename = Path(urllib.parse.unquote(urllib.parse.urlsplit(final_url).path)).name or "download.bin"
        path = _safe_relative(args["path"]) if args.get("path") else _scope_cwd() / "downloads" / f"{uuid.uuid4().hex[:8]}-{filename}"
        length = response.headers.get("Content-Length")
        expected = int(length) if length and length.isdecimal() else None
        temporary, _, _ = _stage_file(response, path.parent, expected_bytes=expected)
        try:
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
    saved = _file_metadata(path)
    raw = b""
    if mime.startswith("text/") or mime in {"application/json", "application/xml"}:
        with path.open("rb") as handle:
            raw = handle.read(MAX_PREVIEW_BYTES + 1)
    sampled = saved["size"] > MAX_PREVIEW_BYTES
    raw = raw[:MAX_PREVIEW_BYTES]
    chars = _clamp_int(args.get("max_chars"), MAX_TEXT_CHARS, 1_000, MAX_PREVIEW_CHARS)
    if mime == "text/html":
        parser = _PageText()
        parser.feed(raw.decode(charset, errors="replace"))
        text = re.sub(r"[ \t]+", " ", "".join(parser.parts))
        text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
        text, truncated = _truncate(text, chars)
        links = []
        link_chars = 0
        for link in parser.links:
            link = {**link, "url": urllib.parse.urljoin(final_url, link["url"])[:2048]}
            link_chars += len(link["url"]) + len(link["text"])
            if link_chars > 8_000:
                break
            links.append(link)
        return {"url": final_url, "status": status, "mime_type": mime, "title": parser.title.strip()[:500], "text": text, "links": links, "truncated": truncated or sampled, "sampled_bytes": len(raw), "file": saved}
    if mime.startswith("text/") or mime in {"application/json", "application/xml"}:
        text, truncated = _truncate(raw.decode(charset, errors="replace"), chars)
        return {"url": final_url, "status": status, "mime_type": mime, "text": text, "truncated": truncated or sampled, "sampled_bytes": len(raw), "file": saved}
    return {"url": final_url, "status": status, "mime_type": mime, "file": saved}


DISPATCH: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "exec": tool_exec,
    "job": JOBS.call,
    "files_list": tool_files_list,
    "files_read": tool_files_read,
    "files_write": tool_files_write,
    "browser_goto": tool_browser_goto,
    "browser_observe": tool_browser_observe,
    "browser_click": tool_browser_click,
    "browser_type": tool_browser_type,
    "browser_scroll": tool_browser_scroll,
    "browser_screenshot": tool_browser_screenshot,
    "browser_tabs": tool_browser_tabs,
    "browser_select_tab": tool_browser_select_tab,
    "browser_upload": tool_browser_upload,
    "browser_download": tool_browser_download,
    "browser_status": tool_browser_status,
    "browser_resume": tool_browser_resume,
    "browser_action": tool_browser_action,
    "web_fetch": tool_web_fetch,
    "skills_list": tool_skills_list,
    "skills_read": tool_skills_read,
    "tool_search": MCP.search,
    "computer_screenshot": tool_computer_screenshot,
    "computer_observe": tool_computer_observe,
    "computer_click": tool_computer_click,
    "computer_type": tool_computer_type,
    "computer_key": tool_computer_key,
    "computer_scroll": tool_computer_scroll,
    "computer_move": tool_computer_move,
    "computer_drag": tool_computer_drag,
    "computer_windows": tool_computer_windows,
    "computer_apps": tool_computer_apps,
}


class Handler(BaseHTTPRequestHandler):
    server_version = "WorkspaceBridge/0.2"

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep normal access logs useful without dumping request bodies.
        print(f"{self.address_string()} - {fmt % args}", flush=True)

    def _write(self, payload: Any, status: int = HTTPStatus.OK) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def _route(self) -> tuple[str, dict[str, str]]:
        parsed = urllib.parse.urlsplit(self.path)
        route = urllib.parse.unquote(parsed.path).rstrip("/") or "/"
        authorize_control(getattr(self, "command", "GET"), route, self.headers.get("Authorization", ""))
        scope = json.loads(self.headers.get("X-Run-Scope", "{}"))
        if not isinstance(scope, dict):
            raise ValueError("invalid run scope")
        for key in ("run_id", "session_id", "project_id"):
            if scope.get(key) and not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", scope[key]):
                raise ValueError("invalid scope id")
        RUN_SCOPE.set(scope)
        set_extension_access(self.headers.get("X-Ochi-Extensions"))
        return route, {key: values[0] for key, values in urllib.parse.parse_qs(parsed.query).items()}

    def _read_body(self, limit: int = MAX_BODY_BYTES) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("invalid Content-Length") from exc
        if length < 0 or length > limit:
            raise ValueError(f"request body exceeds {limit // (1024 * 1024)} MB")
        return self.rfile.read(length)

    def _read_json(self) -> dict[str, Any]:
        raw = self._read_body(44 * 1024 * 1024 if CONTROL_ONLY else MAX_BODY_BYTES)
        self._last_json_bytes = raw or b"{}"
        # Validate the raw spelling before normal decoding for handlers/SDKs.
        strict_json(self._last_json_bytes)
        data = json.loads(self._last_json_bytes)
        if not isinstance(data, dict):
            raise ValueError("request body must be a JSON object")
        return data

    def _extensions(self, route: str, method: str, args: dict[str, Any] | None = None) -> bool:
        if not route.startswith("/extensions/"):
            return False
        if COMPUTE_ONLY:
            self._write(_json_error("extensions require computer permission"), HTTPStatus.FORBIDDEN)
            return True
        args = args or {}
        segments = route.strip("/").split("/")
        if len(segments) < 2 or segments[1] not in {"skills", "mcp"}:
            self._write(_json_error("not found"), HTTPStatus.NOT_FOUND)
            return True
        kind = segments[1]
        item_id = _extension_id(segments[2]) if len(segments) > 2 else None
        suffix = segments[3] if len(segments) > 3 else None
        if not CONTROL_ONLY and not (kind == "skills" and method == "POST" and suffix == "install"):
            raise PermissionError("extension management belongs to plugin control")
        config = _load_extensions()
        if method == "GET" and item_id is None:
            values = config[kind]
            public = _skill_public if kind == "skills" else _mcp_public
            self._write({kind: [public(item) for _, item in sorted(values.items())]})
            return True
        if method == "POST" and item_id is None:
            self._write(install_skill(args) if kind == "skills" else save_mcp(args), HTTPStatus.CREATED)
            return True
        item = config[kind].get(item_id)
        if not item:
            self._write(_json_error("extension not found"), HTTPStatus.NOT_FOUND)
            return True
        if method == "GET" and suffix is None:
            if kind == "skills":
                _, content, instructions = _skill_content(Path(item["path"]))
                self._write({**_skill_public(item), "content": content, "instructions": instructions})
            else:
                self._write(_mcp_public(item))
            return True
        if method == "POST" and kind == "mcp" and suffix == "test":
            self._write(MCP.test(item_id))
            return True
        if method == "POST" and kind == "skills" and suffix == "test":
            metadata, content, _ = _skill_content(Path(item["path"]))
            self._write({"ok": True, "name": metadata["name"], "files": _skill_public(item)["files"], "content_bytes": len(content.encode("utf-8"))})
            return True
        if method == "POST" and kind == "skills" and suffix == "install":
            if CONTROL_ONLY:
                raise ValueError("select a user workspace for skill dependency installation")
            self._write(prepare_skill(item, args, lambda values: JOBS.execute(values, wait_until_done=True)))
            return True
        if method == "PATCH" and suffix is None:
            if kind == "mcp":
                self._write(save_mcp(args, item_id))
                return True
            if args.get("content") is not None or args.get("source") or args.get("path"):
                self._write(install_skill({**args, "id": item_id}))
                return True
            with EXTENSIONS_LOCK:
                config = _load_extensions()
                config[kind][item_id].update(enabled=bool(args.get("enabled", item["enabled"])), updated_at=time.time())
                _save_extensions(config)
            self._write(_skill_public(config[kind][item_id]))
            return True
        if method == "DELETE" and suffix is None:
            with EXTENSIONS_LOCK:
                config = _load_extensions()
                del config[kind][item_id]
                _save_extensions(config)
                if kind == "skills":
                    shutil.rmtree(EXTENSIONS_ROOT / "skills" / item_id, ignore_errors=True)
                else:
                    MCP.close(item_id)
            self._write({"ok": True})
            return True
        self._write(_json_error("unsupported extension operation"), HTTPStatus.NOT_FOUND)
        return True

    @tracked_request
    def do_GET(self) -> None:  # noqa: N802
        try:
            route, query = self._route()
        except (ValueError, TypeError, PermissionError) as exc:
            self._write(_json_error(str(exc)), HTTPStatus.FORBIDDEN if isinstance(exc, PermissionError) else HTTPStatus.BAD_REQUEST)
            return
        if route == "/health":
            mode = "control" if CONTROL_ONLY else "compute" if COMPUTE_ONLY else "workspace"
            if COMPUTE_ONLY or CONTROL_ONLY:
                self._write({**CONTRACT, "status": "ok", "mode": mode, "browser": False})
                return
            try:
                display = _run_command(["xdpyinfo", "-display", os.environ.get("DISPLAY", ":99")], timeout_ms=1_000)
                status = HTTPStatus.OK if display.returncode == 0 else HTTPStatus.SERVICE_UNAVAILABLE
            except Exception:
                status = HTTPStatus.SERVICE_UNAVAILABLE
            self._write({**CONTRACT, "status": "ok" if status == HTTPStatus.OK else "unavailable", "mode": mode, "browser": sync_playwright is not None, "display": os.environ.get("DISPLAY", ":99")}, status)
            return
        if route == "/tools":
            names = set(query.get("names", "").split(",")) - {""}
            if len(names) > 16 or any(not re.fullmatch(r"mcp_[a-zA-Z0-9_]{1,60}", name) for name in names):
                self._write(_json_error("tool metadata names exceed the supported run catalog"), HTTPStatus.BAD_REQUEST)
                return
            self._write(TOOLS + (MCP.definitions(names) if names and not COMPUTE_ONLY else []))
            return
        if route == "/skills/index":
            if COMPUTE_ONLY:
                self._write(_json_error("skills require computer permission"), HTTPStatus.FORBIDDEN)
            else:
                self._write(skills_index())
            return
        try:
            if route == "/browser/desktop-launch":
                if COMPUTE_ONLY:
                    raise ValueError("browser requires computer permission")
                self._write(BROWSER.open_manual(query.get("url")))
                return
            if self._extensions(route, "GET"):
                return
            if route == "/files":
                self._write(tool_files_list({"path": query.get("path"), "recursive": query.get("recursive") == "true", "max_entries": query.get("limit", "200")}))
                return
            if route == "/file":
                path = _safe_relative(query.get("path"))
                if not path.is_file():
                    raise FileNotFoundError("file not found")
                metadata = _file_metadata(path)
                if metadata["size"] > MAX_FILE_BYTES:
                    raise ValueError("file exceeds the configured transfer limit")
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", metadata["mime_type"])
                self.send_header("Content-Length", str(metadata["size"]))
                disposition = "inline" if query.get("inline") == "true" else "attachment"
                self.send_header("Content-Disposition", f"{disposition}; filename*=UTF-8''{urllib.parse.quote(path.name)}")
                self.send_header("Cache-Control", "private, no-store")
                self.end_headers()
                with path.open("rb") as handle:
                    remaining = metadata["size"]
                    while remaining:
                        chunk = handle.read(min(FILE_CHUNK_BYTES, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
                return
        except FileNotFoundError as exc:
            self._write(_json_error(str(exc)), HTTPStatus.NOT_FOUND)
            return
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as exc:
            self._write(_json_error(str(exc)), HTTPStatus.BAD_REQUEST)
            return
        self._write(_json_error("not found"), HTTPStatus.NOT_FOUND)

    @tracked_request
    def do_POST(self) -> None:  # noqa: N802
        try:
            route, _ = self._route()
        except (ValueError, TypeError, PermissionError) as exc:
            self._write(_json_error(str(exc)), HTTPStatus.FORBIDDEN if isinstance(exc, PermissionError) else HTTPStatus.BAD_REQUEST)
            return
        try:
            if route == "/jobs/active":
                self._write({"ok": True, "result": JOBS.active()})
                return
            args = self._read_json()
            if route == "/runs/finish":
                self._write({"ok": True, "result": JOBS.finish(RUN_SCOPE.get(), services=bool(args.get("cancel_services", False)))})
                return
            if route == "/jobs/cancel-session":
                self._write({"ok": True, "result": JOBS.finish(RUN_SCOPE.get(), services=True, session=True)})
                return
            if route == "/workspace/init":
                self._write({"path": str(_scope_cwd())})
                return
            if route == "/runs/cancel":
                result = _cancel_run()
                if not COMPUTE_ONLY:
                    result.update(BROWSER.interrupt_operation(RUN_SCOPE.get()))
                self._write(result)
                return
            if route == "/runs/interrupt":
                result = _interrupt_operation()
                if not COMPUTE_ONLY:
                    result.update(BROWSER.interrupt_operation(RUN_SCOPE.get()))
                self._write(result)
                return
            if route == "/embeddings":
                if COMPUTE_ONLY:
                    raise ValueError("embedding service is unavailable in computation")
                from memory_embeddings import embed as local_embeddings
                self._write(local_embeddings(args))
                return
            if route == "/publish":
                self._write(_publish_file(args.get("path")), HTTPStatus.CREATED)
                return
            if route == "/desktop/activate":
                if COMPUTE_ONLY:
                    raise ValueError("desktop requires computer permission")
                self._write(BROWSER.activate_current(RUN_SCOPE.get()))
                return
            if self._extensions(route, "POST", args):
                return
        except Exception as exc:
            if route.startswith("/tools/"):
                detail = {"code": "invalid_arguments", "path": "$", "message": "arguments must be valid JSON", "tool": route[len("/tools/"):]}
                self._write({**_json_error(str(exc)), "error_detail": detail}, HTTPStatus.OK)
            else:
                self._write(_json_error(str(exc)), HTTPStatus.BAD_REQUEST)
            return
        if not route.startswith("/tools/"):
            self._write(_json_error("not found"), HTTPStatus.NOT_FOUND)
            return
        tool_name = route[len("/tools/"):]
        definition = next((tool for tool in TOOLS if tool["name"] == tool_name), None)
        if definition is None and not COMPUTE_ONLY:
            definition = MCP.definition(tool_name)
        if definition is None:
            self._write(_json_error(f"unknown tool: {tool_name}"), HTTPStatus.NOT_FOUND)
            return
        try:
            if tool_name in DISPATCH:
                validate_arguments(definition, strict_json(self._last_json_bytes))
            environment = None
            if tool_name in {"exec", "job", "files_list", "files_read", "files_write", "web_fetch"}:
                environment = _execution_environment({**args, "environment": args.get("environment", "compute")})
            resources = (definition.get("execution") or {}).get("resources", [])
            desktop = JOBS.desktop(RUN_SCOPE.get()) if not COMPUTE_ONLY and "desktop" in resources else contextlib.nullcontext()
            with desktop:
                result = DISPATCH[tool_name](args) if tool_name in DISPATCH else MCP.call(tool_name, args)
            if environment is not None:
                result = {**result, "environment": environment}
            self._write({"ok": True, "result": result})
        except ToolArgumentError as exc:
            self._write({**_json_error(str(exc)), "error_detail": exc.detail}, HTTPStatus.OK)
        except Exception as exc:  # tool failures are data for the agent, not bridge crashes
            print(f"tool {tool_name} failed: {exc}\n{traceback.format_exc(limit=2)}", flush=True)
            self._write(_json_error(str(exc)), HTTPStatus.OK)

    @tracked_request
    def do_PUT(self) -> None:  # noqa: N802
        try:
            route, query = self._route()
        except (ValueError, TypeError, PermissionError) as exc:
            self._write(_json_error(str(exc)), HTTPStatus.FORBIDDEN if isinstance(exc, PermissionError) else HTTPStatus.BAD_REQUEST)
            return
        if route != "/file":
            self._write(_json_error("not found"), HTTPStatus.NOT_FOUND)
            return
        try:
            if self.headers.get("Transfer-Encoding"):
                raise ValueError("file transfers require Content-Length")
            if self.headers.get("Content-Length") is None:
                raise ValueError("file transfers require Content-Length")
            length = int(self.headers["Content-Length"])
            path = _safe_relative(query.get("path"))
            temporary, _, latest = _stage_file(self.rfile, path.parent, expected_bytes=length)
            try:
                written = False
                if query.get("if_digest") is not None:
                    expected = set(query["if_digest"].split(","))
                    current = _file_digest(path) if path.exists() else ""
                    if current and current != latest and current not in expected:
                        self._write({**_file_metadata(path), "source_conflict": True, "written": False}, HTTPStatus.OK)
                        return
                    if current != latest:
                        os.replace(temporary, path)
                        written = True
                elif query.get("if_missing") == "1":
                    try:
                        os.link(temporary, path)
                        written = True
                    except FileExistsError:
                        pass
                else:
                    os.replace(temporary, path)
                    written = True
                self._write({**_file_metadata(path), "source_conflict": False, "written": written}, HTTPStatus.CREATED)
            finally:
                temporary.unlink(missing_ok=True)
        except Exception as exc:
            self._write(_json_error(str(exc)), HTTPStatus.BAD_REQUEST)

    @tracked_request
    def do_PATCH(self) -> None:  # noqa: N802
        try:
            route, _ = self._route()
            if not self._extensions(route, "PATCH", self._read_json()):
                self._write(_json_error("not found"), HTTPStatus.NOT_FOUND)
        except Exception as exc:
            self._write(_json_error(str(exc)), HTTPStatus.FORBIDDEN if isinstance(exc, PermissionError) else HTTPStatus.BAD_REQUEST)

    @tracked_request
    def do_DELETE(self) -> None:  # noqa: N802
        try:
            route, _ = self._route()
            if not self._extensions(route, "DELETE"):
                self._write(_json_error("not found"), HTTPStatus.NOT_FOUND)
        except Exception as exc:
            self._write(_json_error(str(exc)), HTTPStatus.FORBIDDEN if isinstance(exc, PermissionError) else HTTPStatus.BAD_REQUEST)


def main() -> None:
    FILES_ROOT.mkdir(parents=True, exist_ok=True)
    SCREENSHOT_ROOT.mkdir(parents=True, exist_ok=True)
    if not COMPUTE_ONLY and not CONTROL_ONLY:
        BROWSER._start()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    stopping = threading.Event()

    def request_stop(_signum: int, _frame: Any) -> None:
        if not stopping.is_set():
            stopping.set()
            # shutdown waits for serve_forever; never call it on that thread.
            threading.Thread(target=httpd.shutdown, name="bridge-shutdown", daemon=True).start()

    signal.signal(signal.SIGTERM, request_stop)
    print(f"workspace bridge listening on {HOST}:{PORT}", flush=True)
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        JOBS.close()
        MCP.close_all()
        if not COMPUTE_ONLY and not CONTROL_ONLY:
            try:
                close_computer()
            finally:
                BROWSER.close()


if __name__ == "__main__":
    main()
