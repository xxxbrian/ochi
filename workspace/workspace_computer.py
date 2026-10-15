"""Private Linux desktop tools; AT-SPI is isolated from the bridge's venv."""
from __future__ import annotations

import configparser
import contextlib
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Iterator

from workspace_runtime import (CANCELLED_RUNS, COMPUTE_ONLY, DISPLAY_SIZE,
    INTERRUPTED_OPERATIONS, OPERATION_PROCESSES, PROCESS_LOCK, RUN_PROCESSES,
    RUN_SCOPE, SCREENSHOT_ROOT, _image_result, _safe_relative, _scope_cwd,
    _workspace_env)

DESKTOP_LOCK = threading.RLock()
DESKTOP_CLOSING = threading.Event()
DESKTOP_PROCESSES: set[subprocess.Popen[Any]] = set()
REF_LIFETIME = 180
SNAPSHOTS: dict[str, tuple[float, str, list[dict[str, Any]]]] = {}
LAUNCHED_APPS: dict[int, subprocess.Popen[Any]] = {}
A11Y_WORKER = Path(__file__).with_name("workspace_a11y.py")
APP_DIRS = tuple(dict.fromkeys((Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share"))) / "applications",
    Path.home() / ".local/share/applications", Path("/usr/local/share/applications"), Path("/usr/share/applications"))))


def _guard() -> None:
    if COMPUTE_ONLY:
        raise ValueError("desktop requires computer permission")
    if sys.platform != "linux":
        raise RuntimeError("computer tools operate only in the private Linux container")
    _scope_key()
    _check_cancelled()


def _check_cancelled() -> None:
    if DESKTOP_CLOSING.is_set():
        raise RuntimeError("desktop bridge is shutting down")
    scope = RUN_SCOPE.get()
    with PROCESS_LOCK:
        if scope.get("run_id") in CANCELLED_RUNS:
            raise RuntimeError("run was cancelled before desktop action")
        if scope.get("operation_id") in INTERRUPTED_OPERATIONS:
            raise RuntimeError("desktop operation was interrupted")


def _int(args: dict[str, Any], name: str, low: int, high: int, default: int | None = None) -> int:
    value = args.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f"{name} must be an integer between {low} and {high}")
    return value


def _text(args: dict[str, Any]) -> str:
    text = args.get("text")
    if not isinstance(text, str) or "\x00" in text or len(text) > 20_000:
        raise ValueError("text must contain at most 20,000 characters without NUL")
    return text


def _point(args: dict[str, Any], x: str = "x", y: str = "y") -> tuple[int, int]:
    return _int(args, x, 0, DISPLAY_SIZE[0] - 1), _int(args, y, 0, DISPLAY_SIZE[1] - 1)


def _kill(process: subprocess.Popen[Any]) -> None:
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        pass
    # A launcher may exit before its children; finish only this owned group.
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGKILL)
    with contextlib.suppress(subprocess.TimeoutExpired):
        process.wait(timeout=1)


@contextlib.contextmanager
def _managed_process(argv: list[str], **kwargs: Any) -> Iterator[subprocess.Popen[Any]]:
    scope = RUN_SCOPE.get()
    run_id, operation = scope.get("run_id", ""), scope.get("operation_id", "")
    with PROCESS_LOCK:
        if DESKTOP_CLOSING.is_set() or run_id in CANCELLED_RUNS or operation in INTERRUPTED_OPERATIONS:
            raise RuntimeError("desktop operation was interrupted before execution")
        process = subprocess.Popen(argv, env=_workspace_env(), cwd=str(_scope_cwd()),
                                   start_new_session=True, **kwargs)
        if run_id:
            RUN_PROCESSES.setdefault(run_id, set()).add(process)
        if operation:
            OPERATION_PROCESSES[operation] = process
        DESKTOP_PROCESSES.add(process)
    try:
        yield process
    finally:
        with PROCESS_LOCK:
            DESKTOP_PROCESSES.discard(process)
            RUN_PROCESSES.get(run_id, set()).discard(process)
            if run_id and not RUN_PROCESSES.get(run_id):
                RUN_PROCESSES.pop(run_id, None)
            if OPERATION_PROCESSES.get(operation) is process:
                OPERATION_PROCESSES.pop(operation, None)


def _command(argv: list[str], timeout_ms: int = 10_000, *, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    _check_cancelled()
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        with _managed_process(argv, stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
                              stdout=out, stderr=err) as process:
            try:
                process.communicate(input=input_text.encode("utf-8") if input_text is not None else None,
                                    timeout=timeout_ms / 1000)
            except BaseException:
                _kill(process)
                raise
            _check_cancelled()
        out.seek(0)
        err.seek(0)
        stdout, stderr = out.read(512_001), err.read(16_001)
        if len(stdout) > 512_000:
            raise RuntimeError("desktop command output exceeded 512 KB")
        return subprocess.CompletedProcess(argv, process.returncode, stdout.decode("utf-8", "replace"),
                                           stderr[:16_000].decode("utf-8", "replace"))


def _checked(argv: list[str], timeout_ms: int = 10_000) -> str:
    result = _command(argv, timeout_ms)
    if result.returncode:
        raise RuntimeError(result.stderr.strip()[:1000] or f"{argv[0]} failed ({result.returncode})")
    return result.stdout


def _sleep(seconds: float) -> None:
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        _check_cancelled()
        time.sleep(min(0.02, max(0, until - time.monotonic())))


def _scope_key() -> str:
    scope = RUN_SCOPE.get()
    session = scope.get("session_id")
    if not isinstance(session, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", session):
        raise ValueError("desktop session scope is required")
    return json.dumps([session, scope.get("project_id", "")])


def _invalidate_refs() -> None:
    SNAPSHOTS.clear()


def _store_refs(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    now = time.monotonic()
    for key, (created, _, _) in list(SNAPSHOTS.items()):
        if now - created > REF_LIFETIME:
            SNAPSHOTS.pop(key, None)
    if len(SNAPSHOTS) >= 32:
        SNAPSHOTS.pop(next(iter(SNAPSHOTS)))
    token = uuid.uuid4().hex[:12]
    locators = []
    result = []
    for item in items:
        public = {k: v for k, v in item.items() if k != "locator"}
        if item.get("locator"):
            locators.append(item["locator"])
            public["ref"] = f"d{token}:{len(locators)}"
        result.append(public)
    SNAPSHOTS[token] = (now, _scope_key(), locators)
    return result


def _locator(ref: Any) -> dict[str, Any]:
    if not isinstance(ref, str) or not (match := re.fullmatch(r"d([0-9a-f]{12}):([1-9][0-9]{0,3})", ref)):
        raise ValueError("ref must come from computer_observe, not browser_observe")
    snapshot = SNAPSHOTS.get(match[1])
    index = int(match[2]) - 1
    if (snapshot is None or time.monotonic() - snapshot[0] > REF_LIFETIME
            or snapshot[1] != _scope_key() or index >= len(snapshot[2])):
        raise ValueError("desktop ref expired or belongs to another session; observe again")
    return snapshot[2][index]


def _a11y(request: dict[str, Any]) -> dict[str, Any]:
    result = _command(["/usr/bin/python3", str(A11Y_WORKER)], timeout_ms=10_000,
                      input_text=json.dumps(request, ensure_ascii=False))
    if result.returncode:
        raise RuntimeError(result.stderr.strip()[:1000] or "desktop accessibility worker failed")
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise RuntimeError("desktop accessibility worker returned an invalid result")
    if value.get("error") and request["action"] != "snapshot":
        raise ValueError(value["error"])
    return value


def _ref_action(ref: str, action: str, **extra: Any) -> dict[str, Any]:
    return _a11y({"action": action, "locator": _locator(ref), **extra})


def _ref_point(ref: str) -> tuple[int, int]:
    result = _ref_action(ref, "point")
    point = result.get("fallback")
    if not isinstance(point, dict):
        raise ValueError("desktop element has no visible coordinates; observe again")
    return _point(point)


def desktop_capabilities() -> dict[str, bool]:
    return {"screenshot": bool(shutil.which("scrot")), "pointer": bool(shutil.which("xdotool")),
            "keyboard": bool(shutil.which("xdotool")), "unicode_clipboard": bool(shutil.which("xclip")),
            "windows": bool(shutil.which("wmctrl")), "accessibility_worker": A11Y_WORKER.is_file()}


def _windows(limit: int = 60) -> dict[str, Any]:
    if not shutil.which("wmctrl"):
        return {"windows": [], "available": False, "reason": "wmctrl is unavailable"}
    lines = _checked(["wmctrl", "-lpGx"]).splitlines()
    active = _command(["xprop", "-root", "_NET_ACTIVE_WINDOW"])
    active_match = re.search(r"0x[0-9a-fA-F]+", active.stdout) if not active.returncode else None
    active_id = int(active_match[0], 16) if active_match else None
    windows = []
    for line in lines[:limit]:
        row = line.split(None, 9)
        if len(row) < 9:
            continue
        try:
            ident, desktop, pid, x, y, width, height = (int(row[0], 16), *(int(v) for v in row[1:7]))
        except ValueError:
            continue
        windows.append({"window_id": f"0x{ident:x}", "desktop": desktop, "pid": pid,
                        "class": row[7][:200], "title": row[9][:300] if len(row) > 9 else "",
                        "bounds": {"x": x, "y": y, "width": width, "height": height},
                        "active": ident == active_id})
    return {"windows": windows, "available": True, "truncated": len(lines) > limit}


def tool_computer_screenshot(_: dict[str, Any]) -> dict[str, Any]:
    _guard()
    with DESKTOP_LOCK:
        SCREENSHOT_ROOT.mkdir(parents=True, exist_ok=True)
        path = SCREENSHOT_ROOT / f"computer-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}.png"
        _checked(["scrot", "-o", str(path)])
        if not path.is_file():
            raise RuntimeError("could not capture desktop screenshot")
        return {"image": _image_result(path, coordinate_space="1280x800")}


def tool_computer_observe(args: dict[str, Any]) -> dict[str, Any]:
    _guard()
    max_nodes = _int(args, "max_nodes", 1, 400, 180)
    max_depth = _int(args, "max_depth", 1, 16, 10)
    max_chars = _int(args, "max_chars", 1000, 40_000, 20_000)
    with DESKTOP_LOCK:
        snapshot = _a11y({"action": "snapshot", "max_nodes": max_nodes, "max_depth": max_depth,
                          "max_chars": max_chars, "width": DISPLAY_SIZE[0], "height": DISPLAY_SIZE[1]})
        items = snapshot.pop("elements", [])
        result = {"coordinate_space": "1280x800", "width": DISPLAY_SIZE[0], "height": DISPLAY_SIZE[1],
                  "accessibility": snapshot, "elements": _store_refs(items), **_windows(),
                  "capabilities": desktop_capabilities()}
        if args.get("include_image", False):
            result.update(tool_computer_screenshot({}))
        return result


def _click(x: int, y: int, button: int, count: int = 1) -> None:
    _checked(["xdotool", "mousemove", "--sync", str(x), str(y)], 5000)
    _checked(["xdotool", "click", "--repeat", str(count), "--delay", "100", str(button)], 5000)


def tool_computer_click(args: dict[str, Any]) -> dict[str, Any]:
    _guard()
    button = _int(args, "button", 1, 3, 1)
    count = _int(args, "click_count", 1, 2, 1)
    ref = args.get("ref")
    if ref and ("x" in args or "y" in args):
        raise ValueError("use ref or coordinates, not both")
    with DESKTOP_LOCK:
        try:
            if ref and count == 1 and button == 1:
                result = _ref_action(ref, "click")
                if result.get("acted"):
                    return {"ref": ref, "button": button, "click_count": count, "method": "accessibility"}
                x, y = _point(result.get("fallback", {}))
            else:
                x, y = _ref_point(ref) if ref else _point(args)
            _click(x, y, button, count)
            return {"x": x, "y": y, "button": button, "click_count": count,
                    "method": "coordinates", **({"ref": ref} if ref else {})}
        finally:
            _invalidate_refs()


def _paste(text: str) -> None:
    # Foreground xclip serves the selection until the target pastes it; its
    # process group remains cancellable and never leaves a clipboard daemon.
    with _managed_process(["xclip", "-quiet", "-selection", "clipboard", "-in", "-loops", "0"],
                          stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as process:
        try:
            assert process.stdin is not None
            process.stdin.write(text.encode("utf-8"))
            process.stdin.close()
            _sleep(0.05)
            if process.poll() is not None:
                raise RuntimeError("desktop clipboard could not be initialized")
            _checked(["xdotool", "key", "--clearmodifiers", "ctrl+v"])
            _sleep(0.12)
        finally:
            _kill(process)


def _type(text: str, delay: int, clear: bool) -> None:
    if clear:
        _checked(["xdotool", "key", "--clearmodifiers", "ctrl+a", "BackSpace"])
    if not text:
        return
    if any(ord(char) > 127 for char in text):
        _paste(text)
    else:
        # Split delayed typing into bounded batches rather than block for an
        # hour on a valid 20,000-character input with the maximum key delay.
        chunk_size = min(1000, max(1, 4000 // max(1, delay)))
        for start in range(0, len(text), chunk_size):
            _checked(["xdotool", "type", "--clearmodifiers", "--delay", str(delay), "--",
                      text[start:start + chunk_size]], 8000)


def tool_computer_type(args: dict[str, Any]) -> dict[str, Any]:
    _guard()
    text, delay = _text(args), _int(args, "delay_ms", 0, 200, 0)
    clear = args.get("clear", False)
    if not isinstance(clear, bool):
        raise ValueError("clear must be a boolean")
    if delay * len(text) > 30_000:
        raise ValueError("typing delay exceeds 30 seconds; reduce delay_ms or use smaller text")
    ref = args.get("ref")
    with DESKTOP_LOCK:
        try:
            if ref:
                result = _ref_action(ref, "fill" if clear else "type", text=text)
                if result.get("acted"):
                    return {"typed_chars": len(text), "ref": ref, "method": "accessibility", "cleared": clear}
                if not result.get("focused"):
                    x, y = _point(result.get("fallback", {}))
                    _click(x, y, 1)
            _type(text, delay, clear)
            return {"typed_chars": len(text), "method": "keyboard", "cleared": clear,
                    **({"ref": ref} if ref else {})}
        finally:
            _invalidate_refs()


def tool_computer_key(args: dict[str, Any]) -> dict[str, Any]:
    _guard()
    key = args.get("key")
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+){0,5}", key) or len(key) > 100:
        raise ValueError("key must be one X11 key name or a + separated chord")
    aliases = {"CTRL": "ctrl", "CONTROL": "ctrl", "ALT": "alt", "SHIFT": "shift", "META": "super",
               "CMD": "super", "ENTER": "Return", "RETURN": "Return", "ESC": "Escape", "ESCAPE": "Escape",
               "TAB": "Tab", "BACKSPACE": "BackSpace", "DELETE": "Delete", "SPACE": "space", "UP": "Up",
               "DOWN": "Down", "LEFT": "Left", "RIGHT": "Right", "HOME": "Home", "END": "End",
               "PAGEUP": "Prior", "PAGEDOWN": "Next"}
    normalized = "+".join(aliases.get(part.upper(), part.lower() if len(part) == 1 else part)
                          for part in key.split("+"))
    with DESKTOP_LOCK:
        try:
            _checked(["xdotool", "key", "--clearmodifiers", "--", normalized])
            return {"key": key}
        finally:
            _invalidate_refs()


def tool_computer_scroll(args: dict[str, Any]) -> dict[str, Any]:
    _guard()
    clicks = _int(args, "clicks", -20, 20)
    axis = args.get("axis", "vertical")
    if axis not in {"vertical", "horizontal"}:
        raise ValueError("axis must be vertical or horizontal")
    ref = args.get("ref")
    if ref and ("x" in args or "y" in args):
        raise ValueError("use ref or coordinates, not both")
    with DESKTOP_LOCK:
        try:
            if ref or "x" in args or "y" in args:
                x, y = _ref_point(ref) if ref else _point(args)
                _checked(["xdotool", "mousemove", "--sync", str(x), str(y)], 5000)
            if clicks:
                button = (4 if clicks > 0 else 5) if axis == "vertical" else (6 if clicks > 0 else 7)
                _checked(["xdotool", "click", "--repeat", str(abs(clicks)), "--delay", "50", str(button)], 5000)
            return {"clicks": clicks, "axis": axis, **({"ref": ref} if ref else {})}
        finally:
            _invalidate_refs()


def tool_computer_move(args: dict[str, Any]) -> dict[str, Any]:
    _guard()
    with DESKTOP_LOCK:
        if args.get("ref") and ("x" in args or "y" in args):
            raise ValueError("use ref or coordinates, not both")
        x, y = _ref_point(args["ref"]) if args.get("ref") else _point(args)
        _checked(["xdotool", "mousemove", "--sync", str(x), str(y)], 5000)
        _invalidate_refs()
        return {"x": x, "y": y}


def tool_computer_drag(args: dict[str, Any]) -> dict[str, Any]:
    _guard()
    x, y = _point(args)
    to_x, to_y = _point(args, "to_x", "to_y")
    button, duration = _int(args, "button", 1, 3, 1), _int(args, "duration_ms", 100, 3000, 400)
    with DESKTOP_LOCK:
        _checked(["xdotool", "mousemove", "--sync", str(x), str(y)], 5000)
        pressed = False
        try:
            pressed = True
            _checked(["xdotool", "mousedown", str(button)], 5000)
            for step in range(1, 13):
                _sleep(duration / 12_000)
                _checked(["xdotool", "mousemove", str(round(x + (to_x - x) * step / 12)),
                          str(round(y + (to_y - y) * step / 12))], 3000)
            return {"x": x, "y": y, "to_x": to_x, "to_y": to_y, "button": button, "duration_ms": duration}
        finally:
            if pressed:
                # Release the held pointer even if the action was cancelled.
                with contextlib.suppress(Exception):
                    subprocess.run(["xdotool", "mouseup", str(button)], stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, timeout=2,
                                   env={**os.environ, "DISPLAY": os.environ.get("DISPLAY", ":99")})
            _invalidate_refs()


def tool_computer_windows(args: dict[str, Any]) -> dict[str, Any]:
    _guard()
    action = args.get("action", "list")
    if action not in {"list", "focus"}:
        raise ValueError("action must be list or focus")
    with DESKTOP_LOCK:
        result = _windows()
        if action == "list":
            return result
        ident = args.get("window_id")
        if not isinstance(ident, str) or not re.fullmatch(r"0x[0-9a-fA-F]{1,16}", ident):
            raise ValueError("window_id must come from computer_windows or computer_observe")
        target = next((row for row in result["windows"] if int(row["window_id"], 16) == int(ident, 16)), None)
        if target is None:
            raise ValueError("window no longer exists; list windows again")
        _checked(["wmctrl", "-ia", target["window_id"]], 5000)
        _invalidate_refs()
        return {"focused": target["window_id"], "title": target["title"]}


def _desktop_entries() -> dict[str, dict[str, Any]]:
    entries = {}
    seen = set()
    deadline = time.monotonic() + 1
    scanned = 0
    for root in APP_DIRS:
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*.desktop")):
            scanned += 1
            if scanned > 1024 or time.monotonic() > deadline:
                return entries
            ident = "-".join(path.relative_to(root).parts)
            if ident in seen:
                continue
            seen.add(ident)
            try:
                path.resolve().relative_to(root.resolve())
                if path.stat().st_size > 64_000:
                    continue
                parser = configparser.ConfigParser(interpolation=None, strict=False)
                parser.read_string(path.read_text(encoding="utf-8"))
                section = parser["Desktop Entry"]
                if (section.get("Type") != "Application" or section.get("Hidden", "false").lower() == "true"
                        or section.get("NoDisplay", "false").lower() == "true"):
                    continue
                command = section.get("Exec", "").strip()
                argv = shlex.split(command)
                executable = shutil.which(argv[0]) if argv else None
                try_exec = section.get("TryExec")
                if not executable or (try_exec and not shutil.which(try_exec)):
                    continue
                entries[ident] = {"app_id": ident, "name": section.get("Name", ident)[:200],
                                  "description": section.get("Comment", "")[:300], "icon": section.get("Icon", "")[:200],
                                  "categories": section.get("Categories", "")[:300], "argv": argv,
                                  "desktop_file": str(path), "executable": executable,
                                  "terminal": section.get("Terminal", "false").lower() == "true"}
            except (OSError, ValueError, KeyError, configparser.Error):
                continue
    return entries


def _app_argv(entry: dict[str, Any], paths: list[Path]) -> list[str]:
    if entry["app_id"] == "ochi-files.desktop":
        return [entry["executable"], *(str(path) for path in paths)] if paths else [entry["executable"], str(_scope_cwd())]
    if entry["app_id"] == "ochi-terminal.desktop":
        if paths:
            raise ValueError("terminal launch does not accept files; use exec for a command")
        return [entry["executable"], "--working-directory=" + str(_scope_cwd())]
    result = []
    consumed = False
    for token in entry["argv"]:
        if token in {"%f", "%u", "%F", "%U"}:
            consumed = True
            if token in {"%f", "%u"} and len(paths) > 1:
                raise ValueError("this application accepts only one file at a time")
            result.extend(path.as_uri() if token in {"%u", "%U"} else str(path) for path in paths)
        elif token == "%i":
            if entry["icon"]:
                result.extend(["--icon", entry["icon"]])
        elif token == "%c":
            result.append(entry["name"])
        elif token == "%k":
            result.append(entry["desktop_file"])
        else:
            literal = token.replace("%%", "\x00")
            if "%" in literal:
                raise ValueError("unsupported or embedded desktop Exec field code")
            result.append(literal.replace("\x00", "%"))
    if paths and not consumed:
        raise ValueError("this application does not advertise file arguments")
    if not result:
        raise ValueError("desktop application has an empty command")
    result[0] = entry["executable"]
    if entry["terminal"]:
        terminal = shutil.which("x-terminal-emulator")
        if not terminal:
            raise ValueError("terminal application launcher is unavailable")
        result = [terminal, "-e", *result]
    return result


def tool_computer_apps(args: dict[str, Any]) -> dict[str, Any]:
    _guard()
    action = args.get("action", "list")
    if action not in {"list", "launch"}:
        raise ValueError("action must be list or launch")
    with DESKTOP_LOCK:
        entries = _desktop_entries()
        if action == "list":
            limit = _int(args, "limit", 1, 100, 50)
            apps = sorted(entries.values(), key=lambda row: row["name"].casefold())
            return {"apps": [{k: row[k] for k in ("app_id", "name", "description", "icon", "categories")}
                             for row in apps[:limit]], "truncated": len(apps) > limit}
        ident = args.get("app_id")
        if not isinstance(ident, str) or ident not in entries:
            raise ValueError("app_id must be an installed application from computer_apps")
        raw_paths = args.get("paths", [])
        if not isinstance(raw_paths, list) or len(raw_paths) > 16:
            raise ValueError("paths must contain at most 16 workspace files")
        paths = [_safe_relative(path) for path in raw_paths]
        if any(not path.exists() for path in paths):
            raise ValueError("application files/folders must exist in the session/project workspace")
        entry = entries[ident]
        argv = _app_argv(entry, paths)
        launcher = Path(entry["executable"]).name
        is_browser = launcher in {"chromium", "chromium-browser", "google-chrome", "ochi-browser", "workspace-browser-launch"}
        # XFCE's installed WebBrowser alias reaches the human-only launcher;
        # model launches must instead retain their scoped profile/tab ownership.
        is_browser = is_browser or (launcher == "exo-open" and entry["argv"][1:3] == ["--launch", "WebBrowser"])
        if is_browser:
            # Reuse the scoped managed browser; desktop launches must not create
            # an unrelated profile and lose the user's authenticated identity.
            from workspace_browser import tool_browser_goto
            if len(paths) > 1:
                raise ValueError("open browser files one at a time")
            result = tool_browser_goto({"url": paths[0].as_uri() if paths else "about:blank", "new_tab": True})
            _invalidate_refs()
            return {"app_id": ident, "launched": not bool(result.get("blocked")), "browser": result,
                    **({"blocked": True, "needs_user": True, "automation": result.get("automation", {})}
                       if result.get("blocked") else {})}
        for pid, process in list(LAUNCHED_APPS.items()):
            if process.poll() is not None:
                LAUNCHED_APPS.pop(pid, None)
        if len(LAUNCHED_APPS) >= 64:
            raise RuntimeError("too many active desktop application launches")
        with _managed_process(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL) as process:
            try:
                _sleep(0.2)
            except BaseException:
                _kill(process)
                raise
            if process.poll() not in (None, 0):
                raise RuntimeError(f"desktop application exited with code {process.returncode}")
            LAUNCHED_APPS[process.pid] = process
        _invalidate_refs()
        return {"app_id": ident, "name": entry["name"], "launched": True, "pid": process.pid,
                "cwd": str(_scope_cwd()), "paths": [str(path) for path in paths]}


def close_computer() -> None:
    DESKTOP_CLOSING.set()
    with PROCESS_LOCK:
        processes = set(DESKTOP_PROCESSES) | set(LAUNCHED_APPS.values())
    for process in processes:
        if process.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGTERM)
    LAUNCHED_APPS.clear()
    SNAPSHOTS.clear()
