"""Shared scoped filesystem, subprocess and artifact primitives for the bridge."""
from __future__ import annotations

import base64
import contextlib
import contextvars
import hashlib
import io
import mimetypes
import os
import shutil
import signal
import struct
import subprocess
import threading
import time
import zipfile
from pathlib import Path
from typing import Any

DATA_ROOT = Path(os.environ.get("WORKSPACE_DATA", "/data"))
COMPUTE_ONLY = os.environ.get("COMPUTE_ONLY") == "1"
FILES_ROOT = DATA_ROOT / "files"
SCREENSHOT_ROOT = FILES_ROOT / "screenshots"
DISPLAY_SIZE = (1280, 800)
MAX_BODY_BYTES = 8 * 1024 * 1024
MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_OUTPUT_CHARS = 20_000
MAX_TEXT_CHARS = 24_000
RUN_SCOPE: contextvars.ContextVar[dict[str, Any]] = contextvars.ContextVar("run_scope", default={})
PROCESS_LOCK = threading.Lock()
RUN_PROCESSES: dict[str, set[Any]] = {}
CANCELLED_RUNS: set[str] = set()
OPERATION_PROCESSES: dict[str, Any] = {}
INTERRUPTED_OPERATIONS: dict[str, float] = {}

def _clamp_int(value: Any, default: int, low: int, high: int) -> int:
    try:
        value = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, value))


def _truncate(value: str, limit: int = MAX_OUTPUT_CHARS) -> tuple[str, bool]:
    if len(value) <= limit:
        return value, False
    return value[:limit] + "\n...[truncated]", True


def _json_error(message: str) -> dict[str, Any]:
    return {"ok": False, "error": message}


def _scope_cwd() -> Path:
    scope = RUN_SCOPE.get()
    path = Path(scope.get("cwd") or FILES_ROOT).resolve()
    path.relative_to(DATA_ROOT.resolve())
    path.mkdir(parents=True, exist_ok=True)
    return path


def _safe_relative(path: Any, root: Path | None = None) -> Path:
    if not isinstance(path, str) or not path.strip():
        raise ValueError("path is required")
    root = (root or _scope_cwd()).resolve()
    result = (root / Path(path)).resolve()
    result.relative_to(DATA_ROOT.resolve())
    # Session/project files plus explicitly staged attachments are readable. Shell is
    # a general computer; this boundary prevents accidental tool path drift.
    if RUN_SCOPE.get():
        allowed = [root, FILES_ROOT.resolve(), (DATA_ROOT / "published").resolve(), (DATA_ROOT / "logs").resolve()]
        if not any(result == item or result.is_relative_to(item) for item in allowed):
            raise ValueError("path is outside this session/project workspace")
    return result


def _safe_cwd(path: Any) -> Path:
    root = _scope_cwd()
    if path in (None, ""):
        return root
    if not isinstance(path, str):
        raise ValueError("cwd must be a string")
    result = (root / Path(path)).resolve()
    if not result.is_dir():
        raise ValueError("cwd must be an existing directory in the workspace container")
    return result


def _file_metadata(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {"path": str(path.resolve()), "name": path.name,
            "type": "directory" if path.is_dir() else "file",
            "size": stat.st_size if path.is_file() else None,
            "mime_type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            "modified_at": stat.st_mtime}


def _directory_state(root: Path) -> dict[str, tuple[int, int]]:
    ignored = {".git", ".venv", "venv", "node_modules", "__pycache__", ".cache", "screenshots", "logs"}
    state = {}
    for directory, dirs, names in os.walk(root):
        dirs[:] = [name for name in dirs if not name.startswith(".") and name not in ignored]
        for name in names:
            if name.startswith("."):
                continue
            path = Path(directory) / name
            try:
                if path.is_symlink() or not path.is_file():
                    continue
                stat = path.stat()
                if stat.st_size <= MAX_FILE_BYTES:
                    state[str(path)] = (stat.st_mtime_ns, stat.st_size)
            except OSError:
                continue
    return state


def _publish_file(path: Any) -> dict[str, Any]:
    scope = RUN_SCOPE.get()
    if not scope.get("run_id"):
        raise ValueError("run scope is required")
    source = _safe_relative(path)
    if not source.is_file():
        raise FileNotFoundError("file does not exist")
    raw = source.read_bytes()
    if len(raw) > MAX_FILE_BYTES:
        raise ValueError("file exceeds 32 MB")
    digest = hashlib.sha256(raw).hexdigest()[:20]
    target = DATA_ROOT / "published" / scope["run_id"] / digest / source.name
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        temp = target.with_suffix(target.suffix + ".tmp")
        temp.write_bytes(raw)
        os.replace(temp, target)
    return {**_file_metadata(target), "source_path": str(source)}


def _export_scratch() -> bytes:
    root = _scope_cwd()
    buffer = io.BytesIO()
    total = 0
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for value in _directory_state(root):
            path = Path(value)
            total += path.stat().st_size
            if total > MAX_FILE_BYTES:
                raise ValueError("scratch transfer exceeds 32 MB; publish selected files first")
            archive.write(path, str(path.relative_to(root)))
    return buffer.getvalue()


def _import_scratch(raw: bytes) -> dict[str, Any]:
    root = _scope_cwd()
    imported = []
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        total = 0
        for item in archive.infolist():
            if item.is_dir():
                continue
            total += item.file_size
            if total > MAX_FILE_BYTES:
                raise ValueError("scratch transfer exceeds 32 MB")
            target = (root / item.filename).resolve()
            target.relative_to(root)
            target.parent.mkdir(parents=True, exist_ok=True)
            data = archive.read(item)
            if target.exists() and target.read_bytes() != data:
                # Preserve pre-existing Project files when granting access.
                target = root / "scratch-imports" / str(RUN_SCOPE.get().get("run_id", "import")) / item.filename
                target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            imported.append(str(target))
    return {"files": imported}


def _cancel_run() -> dict[str, Any]:
    run_id = RUN_SCOPE.get().get("run_id")
    if not run_id:
        raise ValueError("run scope is required")
    with PROCESS_LOCK:
        CANCELLED_RUNS.add(run_id)
        processes = list(RUN_PROCESSES.get(run_id, set()))
    for process in processes:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
    for process in processes:
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=2)
    return {"cancelled": True, "processes": len(processes)}


def _interrupt_operation() -> dict[str, Any]:
    operation = RUN_SCOPE.get().get("operation_id")
    if not operation:
        raise ValueError("operation scope is required")
    with PROCESS_LOCK:
        # A revoke may reach the bridge just before the exec request. Keep a
        # short-lived marker so that operation cannot start after cancellation.
        now = time.monotonic()
        for key, at in list(INTERRUPTED_OPERATIONS.items()):
            if now - at > 900:
                INTERRUPTED_OPERATIONS.pop(key, None)
        INTERRUPTED_OPERATIONS[operation] = now
        process = OPERATION_PROCESSES.get(operation)
    if process is not None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass
        # The shell can exit on TERM while children in its group ignore it.
        # Finish the group even when waiting for the shell already succeeded.
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=2)
    return {"interrupted": True, "processes": int(process is not None)}


def _workspace_env(extra: Any = None) -> dict[str, str]:
    if extra is not None and (not isinstance(extra, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in extra.items())):
        raise ValueError("env must be an object of string values")
    return {**os.environ, "PATH": f"{DATA_ROOT}/venv/bin:{DATA_ROOT}/npm/bin:" + os.environ.get("PATH", ""), "VIRTUAL_ENV": str(DATA_ROOT / "venv"), "NODE_PATH": f"{DATA_ROOT}/npm/lib/node_modules", "ASSISTANT_WORKDIR": str(_scope_cwd()), "ASSISTANT_SESSION_ID": str(RUN_SCOPE.get().get("session_id", "")), "ASSISTANT_PROJECT_ID": str(RUN_SCOPE.get().get("project_id", "")), "ASSISTANT_RUN_ID": str(RUN_SCOPE.get().get("run_id", "")), **(extra or {})}


def _run_command(argv: list[str], timeout_ms: int = 20_000, *, cwd: Path | None = None, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        check=False,
        capture_output=True,
        text=True,
        errors="replace",
        timeout=timeout_ms / 1000,
        cwd=str(cwd) if cwd else None,
        input=input_text,
        env={**os.environ, "DISPLAY": os.environ.get("DISPLAY", ":99")},
    )


def _image_result(path: Path, *, coordinate_space: str = "1280x800") -> dict[str, Any]:
    raw = path.read_bytes()
    if len(raw) > MAX_FILE_BYTES:
        raise ValueError("image exceeds 32 MB")
    mime_type = mimetypes.guess_type(path.name)[0] or "image/png"
    original_size = None
    try:
        from PIL import Image
        with Image.open(path) as image:
            width, height = image.size
            if coordinate_space == "file":
                original_size = image.size
                image.thumbnail((1280, 1280))
                if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
                    rgba = image.convert("RGBA")
                    preview = Image.new("RGB", rgba.size, "white")
                    preview.paste(rgba, mask=rgba.getchannel("A"))
                else:
                    preview = image.convert("RGB")
                output = io.BytesIO()
                preview.save(output, format="JPEG", quality=90)
                raw, mime_type = output.getvalue(), "image/jpeg"
                width, height = preview.size
    except ImportError:
        width, height = struct.unpack(">II", raw[16:24]) if raw.startswith(b"\x89PNG") else (0, 0)
    return {
        "mime_type": mime_type,
        "data": base64.b64encode(raw).decode("ascii"),
        "width": width,
        "height": height,
        "path": str(path.relative_to(DATA_ROOT)),
        "coordinate_space": coordinate_space,
        **({"original_width": original_size[0], "original_height": original_size[1]} if original_size else {}),
    }
