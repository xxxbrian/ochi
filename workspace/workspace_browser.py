"""Session-owned headed Playwright/CDP runtime and browser tools."""
from __future__ import annotations

import contextlib
import contextvars
import fcntl
import json
import os
import queue
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
import urllib.parse
import uuid
from pathlib import Path
from typing import Any, Callable

from workspace_runtime import (CANCELLED_RUNS, COMPUTE_ONLY, DATA_ROOT, DISPLAY_SIZE,
    INTERRUPTED_OPERATIONS, MAX_TEXT_CHARS, PROCESS_LOCK, RUN_SCOPE,
    SCREENSHOT_ROOT, _clamp_int, _file_metadata, _image_result, _safe_relative,
    _scope_cwd, _truncate)

try:
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
    from playwright.sync_api import sync_playwright
except Exception as exc:  # pragma: no cover - shown through /health
    sync_playwright = None  # type: ignore[assignment]
    PlaywrightTimeoutError = TimeoutError  # type: ignore[assignment,misc]
    PLAYWRIGHT_IMPORT_ERROR = str(exc)
else:
    PLAYWRIGHT_IMPORT_ERROR = ""



_SCOPE_ID = re.compile(r"[a-zA-Z0-9_-]{1,80}")
_BROWSER_JOB: contextvars.ContextVar[Any] = contextvars.ContextVar("browser_job", default=None)
MAX_ACTIVE_BROWSER_SESSIONS = 8
BROWSER_CALL_TIMEOUT = 130


class BrowserJob:
    def __init__(self, scope: dict[str, Any]) -> None:
        self.scope = scope
        self.cancelled = threading.Event()
        self.expired = threading.Event()
        self.action: dict[str, Any] | None = None


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        try:
            json.dump(value, file, ensure_ascii=True, separators=(",", ":"))
            file.flush()
            os.fsync(file.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        if path.stat().st_size > 4 * 1024 * 1024:
            raise ValueError(f"browser metadata is too large: {path.name}")
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError(f"invalid browser metadata: {path.name}")
        return value
    except FileNotFoundError:
        return {}


class BrowserProfiles:
    """Resolve explicit browser identities without inspecting Chromium login data."""

    def __init__(self, root: Path) -> None:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.saved = _read_json(root / "sessions.json")

    @staticmethod
    def identity(scope: dict[str, Any]) -> tuple[str, str]:
        session = scope.get("session_id")
        project = scope.get("project_id")
        if not isinstance(session, str) or not _SCOPE_ID.fullmatch(session) or (project and (not isinstance(project, str) or not _SCOPE_ID.fullmatch(project))):
            raise ValueError("invalid browser session/project scope")
        return session, "project-" + project if project else "main"


def _check_operation(scope: dict[str, Any]) -> None:
    job = _BROWSER_JOB.get()
    if job is not None and job.expired.is_set():
        raise TimeoutError("browser operation timed out")
    with PROCESS_LOCK:
        cancelled = scope.get("run_id") in CANCELLED_RUNS or scope.get("operation_id") in INTERRUPTED_OPERATIONS
    if cancelled or (job is not None and job.cancelled.is_set()):
        raise RuntimeError("browser operation was cancelled or Computer access was revoked")


def _clear_stale_singletons(profile: Path) -> None:
    lock = profile / "SingletonLock"
    if lock.exists() and not lock.is_symlink():
        raise RuntimeError("browser profile has an unknown singleton lock; use Computer to check it")
    if lock.is_symlink():
        host, separator, pid = os.readlink(lock).rpartition("-")
        if not separator or not pid.isdecimal() or host != socket.gethostname():
            raise RuntimeError("browser singleton owner is on another host or unknown; it must be verified stopped before using this profile")
        try:
            os.kill(int(pid), 0)
        except ProcessLookupError:
            pass
        except PermissionError:
            raise RuntimeError("browser profile is already in use by another process") from None
        else:
            raise RuntimeError("browser profile is already in use by another process")
    singleton = profile / "SingletonSocket"
    if singleton.exists() and not singleton.is_symlink():
        raise RuntimeError("browser profile has an unknown singleton socket; use Computer to check it")
    if singleton.is_symlink():
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(0.2)
            try:
                connection.connect(str(singleton))
            except (FileNotFoundError, ConnectionRefusedError):
                pass
            except OSError:
                raise RuntimeError("browser singleton ownership could not be verified") from None
            else:
                raise RuntimeError("browser profile is already in use by another process")
    for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        path = profile / name
        if path.is_symlink():
            path.unlink()


class ChromiumProcess:
    """One independently launched, headed Chromium with a private CDP port."""

    def __init__(self, profile: Path, binary: str = "/usr/bin/chromium") -> None:
        self.profile = profile
        self.binary = binary
        self.process: Any = None
        self.browser: Any = None
        self.lock: Any = None
        self._owns_lock = False
        self.manual_open = False
        self.endpoint = ""
        self.download_root = profile / "downloads-cache"
        self.normal_download_behavior = {"behavior": "allow", "downloadPath": str(DATA_ROOT / "work" / "downloads"), "eventsEnabled": True}
        self.download_cdp: Any = None
        self.downloads: dict[str, dict[str, Any]] = {}

    def start(self, playwright: Any, timeout: float = 20) -> Any:
        self.profile.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = (self.profile / ".ochi-browser.lock").open("a+")
        os.fchmod(self.lock.fileno(), 0o600)
        try:
            fcntl.flock(self.lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self._owns_lock = True
            _clear_stale_singletons(self.profile)
            # A nonzero ephemeral port avoids Chromium's port=0 test mode.
            # No webdriver spoofing or CAPTCHA-bypass switches are installed.
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]
            argv = [self.binary, "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--force-renderer-accessibility",
                    f"--user-data-dir={self.profile}", "--remote-debugging-address=127.0.0.1", f"--remote-debugging-port={port}",
                    "--window-position=0,0", f"--window-size={DISPLAY_SIZE[0]},{DISPLAY_SIZE[1]}", "about:blank"]
            self.process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                            env={**os.environ, "DISPLAY": os.environ.get("DISPLAY", ":99"), "ACCESSIBILITY_ENABLED": "1"}, start_new_session=True)
            endpoint = f"http://127.0.0.1:{port}"
            self.endpoint = endpoint
            deadline = time.monotonic() + timeout
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            while time.monotonic() < deadline:
                _check_operation(RUN_SCOPE.get())
                if self.process.poll() is not None:
                    raise RuntimeError("headed Chromium exited before its private CDP endpoint became ready")
                try:
                    with opener.open(endpoint + "/json/version", timeout=0.3) as response:
                        version = json.loads(response.read(64 * 1024))
                    websocket = urllib.parse.urlsplit(version.get("webSocketDebuggerUrl", ""))
                    if websocket.hostname not in {"127.0.0.1", "localhost"} or websocket.port != port or not websocket.path.startswith("/devtools/browser/"):
                        raise RuntimeError("Chromium returned a nonlocal CDP endpoint")
                    self.browser = playwright.chromium.connect_over_cdp(endpoint, timeout=max(500, int((deadline - time.monotonic()) * 1000)))
                    if not self.browser.contexts:
                        raise RuntimeError("headed Chromium has no persistent browser context")
                    self.download_root.mkdir(mode=0o700, parents=True, exist_ok=True)
                    self.download_cdp = self.browser.new_browser_cdp_session()
                    self.download_cdp.on("Browser.downloadWillBegin", self._download_started)
                    self.download_cdp.on("Browser.downloadProgress", self._download_progress)
                    self.download_cdp.send("Browser.setDownloadBehavior", self.normal_download_behavior)
                    return self.browser.contexts[0]
                except (OSError, ValueError):
                    time.sleep(0.1)
            raise TimeoutError("headed Chromium startup timed out; check the workspace display")
        except BaseException:
            self.stop()
            raise

    def _download_started(self, event: dict[str, Any]) -> None:
        guid = event.get("guid", "")
        if not isinstance(guid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", guid):
            return
        self.downloads[guid] = {**event, "state": "inProgress"}
        while len(self.downloads) > 100:
            self.downloads.pop(next(iter(self.downloads)))

    def _download_progress(self, event: dict[str, Any]) -> None:
        if event.get("guid") in self.downloads:
            self.downloads[event["guid"]].update(event)

    def stop(self) -> None:
        if self.process is not None and self.process.poll() is None:
            # Only our child is terminated, never an unrelated user's browser.
            self.process.terminate()
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)
        if self.browser is not None:
            with contextlib.suppress(Exception):
                self.browser.close()
        if self.lock is not None:
            # TERM can leave Chromium's symlinks behind. Only a reaped child
            # whose exact singleton identity still matches is ours to clean.
            singleton = self.profile / "SingletonLock"
            if self._owns_lock and self.process is not None and self.process.poll() is not None:
                with contextlib.suppress(OSError):
                    if singleton.is_symlink() and os.readlink(singleton) == f"{socket.gethostname()}-{self.process.pid}":
                        for name in ("SingletonSocket", "SingletonCookie", "SingletonLock"):
                            path = self.profile / name
                            if path.is_symlink():
                                path.unlink()
            self.lock.close()
            self.lock = None
            self._owns_lock = False


class BrowserRuntime:
    """Own all Playwright objects on one thread (sync API is thread-affine)."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = root or DATA_ROOT / "browser-profiles"
        self._jobs: queue.Queue[Any] = queue.Queue()
        self._thread: threading.Thread | None = None
        self._start_lock = threading.Lock()
        self._closing = threading.Event()
        self.ready = False
        self.start_error = "browser is starting"
        self.contexts: dict[str, Any] = {}
        self.processes: dict[str, ChromiumProcess] = {}
        self.states: dict[str, BrowserRuntimeState] = {}
        self.page_owners: dict[int, str] = {}
        self.used: dict[str, float] = {}
        self.bootstrap: dict[str, Any] = {}
        self.session_used: dict[str, float] = {}
        self._action_lock = threading.Lock()
        self._active_job: BrowserJob | None = None
        self._busy_sessions: dict[str | None, int] = {}

    def _start(self) -> None:
        if COMPUTE_ONLY:
            raise RuntimeError("browser requires Computer permission")
        with self._start_lock:
            if self._closing.is_set():
                raise RuntimeError("browser runtime is shutting down")
            if self._thread is None:
                self._thread = threading.Thread(target=self._loop, name="playwright", daemon=True)
                self._thread.start()

    def _submit(self, fn: Callable[[], Any], scope: dict[str, Any] | None = None) -> Any:
        self._start()
        scope = dict(RUN_SCOPE.get() if scope is None else scope)
        _check_operation(scope)
        done = threading.Event()
        job = BrowserJob(scope)
        result: list[Any] = []
        call_context = contextvars.copy_context()
        session = scope.get("session_id")
        with self._action_lock:
            self._busy_sessions[session] = self._busy_sessions.get(session, 0) + 1

        def run() -> Any:
            if job.expired.is_set() or self._closing.is_set():
                raise RuntimeError("browser operation expired before it could start")
            _check_operation(scope)
            token = RUN_SCOPE.set(scope)
            job_token = _BROWSER_JOB.set(job)
            with self._action_lock:
                self._active_job = job
            try:
                value = fn()
                _check_operation(scope)
                return value
            finally:
                with self._action_lock:
                    self._active_job = None
                _BROWSER_JOB.reset(job_token)
                RUN_SCOPE.reset(token)

        def queued() -> Any:
            try:
                return call_context.run(run)
            finally:
                with self._action_lock:
                    remaining = self._busy_sessions[session] - 1
                    if remaining:
                        self._busy_sessions[session] = remaining
                    else:
                        self._busy_sessions.pop(session, None)

        with self._start_lock:
            if self._closing.is_set():
                with self._action_lock:
                    remaining = self._busy_sessions[session] - 1
                    if remaining:
                        self._busy_sessions[session] = remaining
                    else:
                        self._busy_sessions.pop(session, None)
                raise RuntimeError("browser runtime is shutting down")
            self._jobs.put((queued, done, result))
        deadline = time.monotonic() + BROWSER_CALL_TIMEOUT
        cancel_error: BaseException | None = None
        while not done.wait(0.05):
            with PROCESS_LOCK:
                cancelled = scope.get("run_id") in CANCELLED_RUNS or scope.get("operation_id") in INTERRUPTED_OPERATIONS
            if time.monotonic() >= deadline:
                job.expired.set()
            if cancelled or job.expired.is_set():
                try:
                    self._cancel_job(job)
                except Exception as exc:
                    cancel_error = exc
        # Drain server-side actions before releasing the desktop lease. A closed
        # target aborts Playwright auto-wait; cancelling a Python await does not.
        if cancel_error is not None:
            raise cancel_error
        if job.expired.is_set():
            raise TimeoutError("browser operation timed out")
        if job.cancelled.is_set():
            raise RuntimeError("browser operation was cancelled or Computer access was revoked")
        if result and isinstance(result[0], BaseException):
            raise result[0]
        return result[0] if result else None

    def _cancel_job(self, job: BrowserJob) -> dict[str, Any]:
        with self._action_lock:
            job.cancelled.set()
            action = job.action
            if self._active_job is not job or action is None or action.get("close_requested"):
                return {"browser_targets_closed": 0}
            action["close_requested"] = True
            endpoint = urllib.parse.urlsplit(action["endpoint"])
            target = action["target"]
            if endpoint.scheme != "http" or endpoint.hostname != "127.0.0.1" or not endpoint.port or endpoint.path or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", target):
                raise RuntimeError("cannot interrupt browser: invalid private CDP target")
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            try:
                with opener.open(action["endpoint"] + "/json/close/" + target, timeout=2) as response:
                    response.read(1024)
                action["closed"] = True
            except OSError as exc:
                raise RuntimeError("could not close the in-flight browser tab; waiting for its action to drain") from exc
            return {"browser_targets_closed": 1}

    def interrupt_operation(self, scope: dict[str, Any]) -> dict[str, Any]:
        """Called off the Playwright thread after the bridge sets its marker."""
        with self._action_lock:
            job = self._active_job
            matches = job is not None and ((scope.get("operation_id") and scope["operation_id"] == job.scope.get("operation_id")) or
                (not scope.get("operation_id") and scope.get("run_id") and scope["run_id"] == job.scope.get("run_id")))
        return self._cancel_job(job) if matches else {"browser_targets_closed": 0}

    @contextlib.contextmanager
    def mutation(self, state: "BrowserRuntimeState", page: Any) -> Any:
        _check_operation(RUN_SCOPE.get())
        job = _BROWSER_JOB.get()
        action = None
        if job is not None:
            if self.page_owners.get(id(page)) != state.session:
                raise RuntimeError("browser mutation requires a session-owned tab")
            cdp = state.context.new_cdp_session(page)
            try:
                target = cdp.send("Target.getTargetInfo")["targetInfo"]["targetId"]
            finally:
                cdp.detach()
            action = {"endpoint": self.processes[state.profile].endpoint, "target": target, "url": page.url}
            with self._action_lock:
                job.action = action
        try:
            _check_operation(RUN_SCOPE.get())
            yield
            _check_operation(RUN_SCOPE.get())
        finally:
            with self._action_lock:
                if job is not None:
                    job.action = None
            if action is not None and action.get("closed"):
                # Only URLs are retained; unsaved live form state may be lost.
                state._forget_page(page, intentional=True)
                if _restorable_url(action["url"]) and action["url"] not in state.remaining_urls:
                    state.remaining_urls.append(action["url"])

    def call(self, fn: Callable[["BrowserRuntimeState"], Any]) -> Any:
        scope = dict(RUN_SCOPE.get())
        BrowserProfiles.identity(scope)
        return self._submit(lambda: fn(self._state_for_scope(scope)), scope)

    def _loop(self) -> None:
        try:
            if sync_playwright is None:
                raise RuntimeError(f"Playwright import failed: {PLAYWRIGHT_IMPORT_ERROR}")
            with sync_playwright() as playwright:
                self.playwright = playwright
                self.profiles = BrowserProfiles(self.root)
                self.restore_tabs = dict(self.profiles.saved)
                self.ready = True
                self.start_error = ""
                try:
                    self._serve_jobs()
                finally:
                    for profile in list(self.contexts):
                        try:
                            self._evict_profile(profile)
                        except Exception as exc:
                            self.start_error = f"browser shutdown: {exc}"
        except BaseException as exc:
            self.ready = False
            self.start_error = str(exc)
            if not self._closing.is_set():
                self._serve_jobs(error=exc)
        finally:
            self.ready = False

    def _serve_jobs(self, error: BaseException | None = None) -> None:
        while True:
            job = self._jobs.get()
            if job is None:
                return
            fn, done, result = job
            try:
                if error is not None:
                    raise RuntimeError(self.start_error)
                result.append(fn())
            except BaseException as exc:
                result.append(exc)
            finally:
                if error is None:
                    with contextlib.suppress(Exception):
                        self._save_sessions()
                done.set()

    def _context_for_profile(self, profile: str) -> Any:
        if profile in self.contexts:
            context = self.contexts[profile]
            if self.processes[profile].browser.is_connected() and self.processes[profile].process.poll() is None and any(not page.is_closed() for page in context.pages):
                self.used[profile] = time.monotonic()
                return context
            self._evict_profile(profile)
        while len(self.contexts) >= 4:
            inactive = [key for key in self.contexts if not self._profile_protected(key)]
            if not inactive:
                raise RuntimeError("all four browser profiles are active or need user attention; close an unused browser first")
            self._evict_profile(min(inactive, key=lambda key: self.used.get(key, 0)))
        process = ChromiumProcess(self.root / profile)
        try:
            context = process.start(self.playwright)
            context.set_default_timeout(15_000)
            context.set_default_navigation_timeout(30_000)
        except BaseException:
            process.stop()
            raise
        self.contexts[profile] = context
        self.processes[profile] = process
        self.used[profile] = time.monotonic()
        self.bootstrap[profile] = next((page for page in context.pages if page.url == "about:blank"), None)
        context.on("page", lambda page: self._claim_popup(context, page))
        return context

    def retire_empty_profile(self, profile: str) -> None:
        context = self.contexts.get(profile)
        if context is not None and not any(not page.is_closed() for page in context.pages):
            self._evict_profile(profile)

    def _claim_popup(self, context: Any, page: Any) -> None:
        with contextlib.suppress(Exception):
            opener = page.opener()
            session = self.page_owners.get(id(opener)) if opener is not None else None
            state = self.states.get(session)
            if state is not None and state.context is context:
                state.register_page(page)

    def _state_for_scope(self, scope: dict[str, Any]) -> "BrowserRuntimeState":
        session, profile = self.profiles.identity(scope)
        context = self._context_for_profile(profile)
        state = self.states.get(session)
        if state is not None and state.context is context:
            self.session_used[session] = time.monotonic()
            return state
        if state is not None:
            self._save_state(state)
            for page in state.tabs.values():
                self.page_owners.pop(id(page), None)
        self._trim_session_states(session)
        state = BrowserRuntimeState(self.playwright, context.browser, {}, context, session, self.page_owners, profile, self)
        self.states[session] = state
        self.session_used[session] = time.monotonic()
        bootstrap = self.bootstrap.pop(profile, None)
        if bootstrap is not None and not bootstrap.is_closed() and not self.processes[profile].manual_open:
            state.register_page(bootstrap)
        saved = self.restore_tabs.pop(session, None)
        if isinstance(saved, dict) and saved.get("profile") == profile:
            state.restore_urls(saved.get("urls", []), use_current=True)
        return state

    def _profile_protected(self, profile: str) -> bool:
        with self._action_lock:
            busy = set(self._busy_sessions)
        return self._has_manual_pages(profile) or any(state.profile == profile and (state.pause or session in busy) for session, state in self.states.items())

    def _trim_session_states(self, current: str) -> None:
        while len(self.states) >= MAX_ACTIVE_BROWSER_SESSIONS:
            with self._action_lock:
                busy = set(self._busy_sessions)
            candidates = [session for session, state in self.states.items() if session != current and session not in busy and state.pause is None]
            if not candidates:
                raise RuntimeError("browser session capacity is busy or waiting for human verification; finish or close an unused session first")
            session = min(candidates, key=lambda key: self.session_used.get(key, 0))
            state = self.states[session]
            self._save_state(state)
            self._save_sessions()
            self.states.pop(session)
            self.session_used.pop(session, None)
            for page in list(state.tabs.values()):
                if self.page_owners.get(id(page)) == session:
                    try:
                        if not page.is_closed():
                            page.close()
                    finally:
                        self.page_owners.pop(id(page), None)

    def _has_manual_pages(self, profile: str) -> bool:
        try:
            bootstrap = self.bootstrap.get(profile)
            return any(id(page) not in self.page_owners and page is not bootstrap and not page.is_closed() for page in self.contexts[profile].pages)
        except Exception:
            return False

    def _save_state(self, state: "BrowserRuntimeState") -> None:
        if not state.browser.is_connected() and not state.explicitly_empty:
            return
        ordered = ([state.active_tab] if state.active_tab else []) + [tab for tab in state.tabs if tab != state.active_tab]
        urls = []
        for tab in ordered[:20]:
            page = state.tabs.get(tab)
            with contextlib.suppress(Exception):
                if page is not None and not page.is_closed() and _restorable_url(page.url):
                    urls.append(page.url)
        self.restore_tabs[state.session] = {"profile": state.profile, "urls": (urls + state.remaining_urls)[:20]}

    def _save_sessions(self) -> None:
        for state in self.states.values():
            self._save_state(state)
        _atomic_json(self.root / "sessions.json", self.restore_tabs)

    def _evict_profile(self, profile: str) -> None:
        context = self.contexts[profile]
        for session, state in list(self.states.items()):
            if state.context is context:
                self._save_state(state)
                for page in state.tabs.values():
                    self.page_owners.pop(id(page), None)
                self.states.pop(session)
                self.session_used.pop(session, None)
        try:
            self._save_sessions()
        finally:
            try:
                self.processes.pop(profile).stop()
            finally:
                self.contexts.pop(profile, None)
                self.bootstrap.pop(profile, None)
                self.used.pop(profile, None)

    def activate_current(self, scope: dict[str, Any] | None = None) -> dict[str, Any]:
        """Raise an existing owned tab; desktop actions never spawn a browser."""
        if self._thread is None:
            return {"activated": False}
        scope = dict(RUN_SCOPE.get() if scope is None else scope)
        session, _ = self.profiles.identity(scope)

        def run() -> dict[str, Any]:
            state = self.states.get(session)
            if state is None or not state.browser.is_connected():
                return {"activated": False}
            state._refresh_tabs()
            if state.active_tab is None:
                return {"activated": False}
            _, page = state.page(state.active_tab)
            return {"activated": True, "tab": state.summary(state.active_tab, page, True)}

        return self._submit(run, scope)

    def open_manual(self, url: str | None = None) -> dict[str, Any]:
        if url is not None and not _restorable_url(url):
            raise ValueError("desktop browser URL must use http(s), about:blank, or a file inside /data")

        def run() -> dict[str, Any]:
            context = self._context_for_profile("main")
            self.processes["main"].manual_open = True
            bootstrap = self.bootstrap.pop("main", None)
            manual = next((page for page in context.pages if id(page) not in self.page_owners and not page.is_closed()), None)
            if bootstrap is not None and not bootstrap.is_closed() and id(bootstrap) not in self.page_owners:
                page = bootstrap
            else:
                page = context.new_page() if url is not None or manual is None else manual
            if url is not None:
                page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            page.bring_to_front()
            return {"opened": True, "profile": "main", "manual": True, "headed": True}

        return self._submit(run, {})

    def status(self, args: dict[str, Any]) -> dict[str, Any]:
        scope = dict(RUN_SCOPE.get())

        def run() -> dict[str, Any]:
            session, profile = self.profiles.identity(scope)
            state = self.states.get(session)
            if state is None or state.profile != profile or not state.browser.is_connected():
                return {"profile": profile, "started": False, "headed": True, "transport": "cdp", "tabs": [], "automation": {"status": "ready", "needs_user": False}}
            if args.get("tab_id") is not None:
                tab_id, page = state.page(args["tab_id"])
                state.detect_challenge(tab_id, page)
            else:
                state._refresh_tabs()
                for tab_id, page in state.tabs.items():
                    state.detect_challenge(tab_id, page)
            return {"profile": profile, "started": True, "headed": True, "transport": "cdp", "tabs": state.list_tabs(), "automation": state.automation()}

        return self._submit(run, scope)

    def close(self) -> None:
        with self._start_lock:
            if self._closing.is_set():
                return
            self._closing.set()
            if self._thread is not None:
                self._jobs.put(None)
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=65)


def _restorable_url(url: Any) -> bool:
    if not isinstance(url, str) or len(url) > 16_000:
        return False
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    if parsed.scheme in {"http", "https"}:
        return bool(parsed.hostname)
    if url == "about:blank":
        return True
    if parsed.scheme == "file" and parsed.hostname in {None, "", "localhost"}:
        return Path(urllib.parse.unquote(parsed.path)).resolve().is_relative_to(DATA_ROOT.resolve())
    return False


class BrowserRuntimeState:
    def __init__(self, playwright: Any, browser: Any, tabs: dict[str, Any], context: Any, session: str, page_owners: dict[int, str] | None = None, profile: str = "main", runtime: BrowserRuntime | None = None) -> None:
        self.playwright = playwright
        self.browser = browser
        self.tabs = tabs
        self.context = context
        self.session = session
        self.profile = profile
        self.runtime = runtime
        self.page_owners = page_owners if page_owners is not None else {}
        self.next_tab = 1
        self.active_tab: str | None = None
        self.start_error = ""
        self.pause: dict[str, Any] | None = None
        self.remaining_urls: list[str] = []
        self.explicitly_empty = False

    def _require_browser(self) -> Any:
        if self.browser is None:
            raise RuntimeError(self.start_error or "Chromium CDP is unavailable")
        if not self.browser.is_connected():
            raise RuntimeError("Chromium CDP connection was closed")
        return self.browser

    def _context(self) -> Any:
        self._require_browser()
        return self.context

    def register_page(self, page: Any) -> str:
        owner = self.page_owners.get(id(page))
        if owner is not None and owner != self.session:
            raise ValueError("tab belongs to another session")
        for tab_id, existing in self.tabs.items():
            if existing is page:
                return tab_id
        tab_id = f"tab-{self.next_tab}"
        self.next_tab += 1
        self.tabs[tab_id] = page
        self.explicitly_empty = False
        self.page_owners[id(page)] = self.session
        self.active_tab = tab_id
        page.on("close", lambda closed_page: self._forget_page(closed_page))
        return tab_id

    def _forget_page(self, page: Any, *, intentional: bool = False) -> None:
        for tab_id, existing in list(self.tabs.items()):
            if existing is page:
                self.tabs.pop(tab_id)
        if self.page_owners.get(id(page)) == self.session:
            self.page_owners.pop(id(page), None)
        if self.active_tab not in self.tabs:
            self.active_tab = next(iter(self.tabs), None)
        if intentional and not self.tabs:
            self.explicitly_empty = True

    def _refresh_tabs(self) -> None:
        if not self.browser.is_connected():
            return
        pages = self._context().pages
        known_pages = {id(page) for page in pages}
        for tab_id, page in list(self.tabs.items()):
            if id(page) not in known_pages or page.is_closed():
                self._forget_page(page)
        mapped = {id(page) for page in self.tabs.values()}
        for page in pages:
            if id(page) not in mapped:
                with contextlib.suppress(Exception):
                    opener = page.opener()
                    if self.page_owners.get(id(page)) == self.session or (opener and self.page_owners.get(id(opener)) == self.session):
                        self.register_page(page)
        if self.active_tab not in self.tabs:
            self.active_tab = next(iter(self.tabs), None)

    def page(self, tab_id: str | None = None) -> tuple[str, Any]:
        self._refresh_tabs()
        if tab_id is not None and tab_id not in self.tabs:
            raise ValueError(f"unknown tab_id: {tab_id}")
        selected = tab_id or self.active_tab
        if selected is None:
            page = self._context().new_page()
            selected = self.register_page(page)
        self.active_tab = selected
        self.tabs[selected].bring_to_front()
        return selected, self.tabs[selected]

    @staticmethod
    def summary(tab_id: str, page: Any, active: bool = False) -> dict[str, Any]:
        try:
            title = page.title()
        except Exception:
            title = ""
        return {"tab_id": tab_id, "url": page.url, "title": title, "active": active, "closed": page.is_closed()}

    def list_tabs(self) -> list[dict[str, Any]]:
        self._refresh_tabs()
        return [self.summary(tab_id, page, tab_id == self.active_tab) for tab_id, page in self.tabs.items()]

    def restore_urls(self, urls: list[Any], *, use_current: bool) -> None:
        if not isinstance(urls, list):
            raise ValueError("invalid saved browser tabs")
        urls = [url for url in urls[:20] if _restorable_url(url)]
        preferred = self.active_tab if not use_current else None
        self.remaining_urls = list(urls)
        for index, url in enumerate(urls):
            _check_operation(RUN_SCOPE.get())
            if index == 0 and use_current:
                tab_id, page = self.page()
            else:
                page = self._context().new_page()
                tab_id = self.register_page(page)
            preferred = preferred or tab_id
            try:
                with _mutation(self, page):
                    page.goto(url, wait_until="domcontentloaded", timeout=5_000)
            except Exception:
                _check_operation(RUN_SCOPE.get())
            _check_operation(RUN_SCOPE.get())
            self.remaining_urls = urls[index + 1:]
            self.detect_challenge(tab_id, page)
            if self.pause:
                break
        if self.pause is None and preferred is not None:
            self.active_tab = preferred

    def detect_challenge(self, tab_id: str, page: Any, *, strict: bool = False) -> dict[str, Any] | None:
        try:
            evidence = page.evaluate(_CHALLENGE_SCRIPT)
        except Exception:
            if strict:
                raise RuntimeError("could not verify that the browser challenge was completed") from None
            return None
        if isinstance(evidence, dict) and evidence.get("provider") in {"cloudflare", "captcha", "verification"}:
            self.pause = {"tab_id": tab_id, "provider": evidence["provider"], "reason": "human_verification"}
            return self.pause
        return None

    def automation(self) -> dict[str, Any]:
        if self.pause:
            return {"status": "needs_user", "needs_user": True, **self.pause,
                    "message": "Human verification is required. Ask the user to complete it in Computer, then call browser_resume. Do not retry or solve the challenge automatically."}
        return {"status": "ready", "needs_user": False}

    def blocked(self) -> dict[str, Any] | None:
        if not self.pause:
            return None
        return {"blocked": True, "needs_user": True, "automation": self.automation()}


# This is a bounded detection hint, not a CAPTCHA solver. A CAPTCHA mentioned in
# an article or an invisible reCAPTCHA badge is not enough to stop automation.
_CHALLENGE_SCRIPT = r"""
() => {
  const visible = el => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (!(r.width > 0 && r.height > 0) || style.visibility === 'hidden' || style.display === 'none') return false;
    if (el.closest('.grecaptcha-badge') || /[?&#]size=invisible(?:[&#]|$)/i.test(el.getAttribute('src') || '')) return false;
    for (let node = el, depth = 0; node && depth < 12; node = node.parentElement, depth++) {
      if (getComputedStyle(node).opacity === '0') return false;
    }
    return true;
  };
  const text = (document.body?.innerText || '').slice(0, 6000).toLowerCase();
  const title = document.title.toLowerCase();
  const cloudflare = Array.from(document.querySelectorAll('#challenge-running,#challenge-form,#cf-challenge-running,iframe[src*="challenges.cloudflare.com"]')).slice(0, 20).some(visible);
  const human = /verify (?:that )?you are human|verifying you are human|confirm you are human|checking your browser before accessing|complete the security check|验证您是真人|确认您是真人|请完成安全验证/.test(text);
  if (cloudflare || ((title.includes('just a moment') || title.includes('attention required')) && human)) return {provider:'cloudflare'};
  const answered = Array.from(document.querySelectorAll('[name="g-recaptcha-response"],[name="h-captcha-response"]')).slice(0, 10).some(el => typeof el.value === 'string' && el.value.trim().length > 0);
  const captcha = Array.from(document.querySelectorAll('iframe[src*="hcaptcha.com"][title],iframe[src*="recaptcha"][title*="recaptcha" i],iframe[title*="captcha challenge" i]')).slice(0, 20).some(el => {
    if (!visible(el)) return false;
    const source = el.getAttribute('src') || '';
    const checkbox = /recaptcha\/(?:api2|enterprise)\/anchor|[&#?]frame=checkbox(?:[&#]|$)/i.test(source);
    return !answered || !checkbox;
  });
  if (captcha) return {provider:'captcha'};
  const heading = (document.querySelector('h1')?.innerText || '').toLowerCase();
  const verificationHeading = /human verification|security verification|verify (?:that )?you are human|security check|人机验证|安全验证/;
  if (!answered && human && text.length < 4000 && (verificationHeading.test(title) || verificationHeading.test(heading))) return {provider:'verification'};
  return null;
}
"""


BROWSER = BrowserRuntime()


def _browser_call(fn: Callable[[BrowserRuntimeState], Any]) -> Any:
    return BROWSER.call(fn)


def _locator(page: Any, args: dict[str, Any]) -> Any:
    ref = args.get("ref")
    selector = args.get("selector")
    if ref and selector:
        raise ValueError("provide ref or selector, not both")
    if ref:
        if not isinstance(ref, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", ref):
            raise ValueError("invalid element ref")
        return page.locator(f'[data-assistant-ref="{ref}"]').first
    if selector:
        return page.locator(str(selector)).first
    raise ValueError("ref or selector is required")


def _page_summary(state: BrowserRuntimeState, tab_id: str, page: Any) -> dict[str, Any]:
    state.detect_challenge(tab_id, page)
    return {**state.summary(tab_id, page, tab_id == state.active_tab), "automation": state.automation(), **(state.blocked() or {})}


def _before_action(state: BrowserRuntimeState, tab_id: str, page: Any) -> dict[str, Any] | None:
    _check_operation(RUN_SCOPE.get())
    state.detect_challenge(tab_id, page)
    blocked = state.blocked()
    if blocked is not None:
        return {**state.summary(tab_id, page, tab_id == state.active_tab), **blocked}
    return None


@contextlib.contextmanager
def _mutation(state: BrowserRuntimeState, page: Any) -> Any:
    if state.runtime is not None:
        with state.runtime.mutation(state, page):
            yield
    else:
        _check_operation(RUN_SCOPE.get())
        yield
        _check_operation(RUN_SCOPE.get())


def tool_browser_status(args: dict[str, Any]) -> dict[str, Any]:
    return BROWSER.status(args)


def tool_browser_resume(args: dict[str, Any]) -> dict[str, Any]:
    if args.get("human_completed") is not True:
        raise ValueError("browser_resume requires human_completed=true after the user completed verification")

    def run(state: BrowserRuntimeState) -> dict[str, Any]:
        tab_id = args.get("tab_id") or (state.pause or {}).get("tab_id")
        if state.pause and tab_id != state.pause["tab_id"]:
            raise ValueError("resume must check the tab that requested human verification")
        state._refresh_tabs()
        if tab_id is not None and tab_id not in state.tabs and state.pause:
            state.pause = None
            if state.remaining_urls:
                state.restore_urls(state.remaining_urls, use_current=False)
            return {"resumed": True, "closed": True, "automation": state.automation()}
        tab_id, page = state.page(tab_id)
        evidence = state.detect_challenge(tab_id, page, strict=True)
        if evidence is None:
            state.pause = None
            if state.remaining_urls:
                state.restore_urls(state.remaining_urls, use_current=False)
            if state.pause:
                tab_id, page = state.page(state.pause["tab_id"])
        return {**state.summary(tab_id, page, tab_id == state.active_tab), "resumed": state.pause is None,
                "automation": state.automation(), **(state.blocked() or {})}

    return _browser_call(run)


def tool_browser_goto(args: dict[str, Any]) -> dict[str, Any]:
    url = args.get("url")
    if not isinstance(url, str) or not url.strip():
        raise ValueError("url is required")
    timeout = _clamp_int(args.get("timeout_ms"), 30_000, 1_000, 60_000)

    def run(state: BrowserRuntimeState) -> dict[str, Any]:
        state._refresh_tabs()
        if state.active_tab is not None:
            current = state.tabs[state.active_tab]
            blocked = _before_action(state, state.active_tab, current)
            if blocked is not None:
                return blocked
        elif state.pause:
            return state.blocked()
        if bool(args.get("new_tab", False)):
            _check_operation(RUN_SCOPE.get())
            page = state._context().new_page()
            tab_id = state.register_page(page)
        else:
            tab_id, page = state.page(args.get("tab_id"))
        blocked = _before_action(state, tab_id, page)
        if blocked is not None:
            return blocked
        try:
            with _mutation(state, page):
                page.goto(url, wait_until="domcontentloaded", timeout=timeout)
        except PlaywrightTimeoutError:
            # A slow page is still usable; report its current state.
            pass
        return _page_summary(state, tab_id, page)

    return _browser_call(run)


def tool_browser_observe(args: dict[str, Any]) -> dict[str, Any]:
    max_chars = _clamp_int(args.get("max_chars"), MAX_TEXT_CHARS, 1_000, 40_000)
    output_format = args.get("format", "snapshot")
    if output_format not in {"snapshot", "html"}:
        raise ValueError("browser observation format must be snapshot or html")

    def run(state: BrowserRuntimeState) -> dict[str, Any]:
        tab_id, page = state.page(args.get("tab_id"))
        if output_format == "html":
            payload = page.evaluate(_SANITIZED_HTML_SCRIPT, max_chars)
            return {**_page_summary(state, tab_id, page), "html": payload["html"], "html_truncated": payload["truncated"]}
        prefix = "el-" + uuid.uuid4().hex[:8]
        payload = page.evaluate(
            """
            ({maxItems, prefix}) => {
              const selectors = 'a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]';
              const items = Array.from(document.querySelectorAll(selectors)).slice(0, maxItems);
              document.querySelectorAll('[data-assistant-ref]').forEach(el => el.removeAttribute('data-assistant-ref'));
              return items.map((el, i) => {
                const ref = `${prefix}-${i + 1}`;
                el.setAttribute('data-assistant-ref', ref);
                const rect = el.getBoundingClientRect();
                return {
                  ref,
                  tag: el.tagName.toLowerCase(),
                  role: el.getAttribute('role') || '',
                  text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 240),
                  placeholder: el.getAttribute('placeholder') || '',
                  type: el.getAttribute('type') || '',
                  disabled: !!el.disabled,
                  visible: !!(rect.width && rect.height)
                };
              });
            }
            """,
            {"maxItems": 100, "prefix": prefix},
        )
        text = page.locator("body").inner_text(timeout=5_000) if page.url else ""
        text, truncated = _truncate(text, max_chars)
        return {**_page_summary(state, tab_id, page), "text": text, "text_truncated": truncated, "interactive": payload}

    return _browser_call(run)


_SANITIZED_HTML_SCRIPT = """
(limit) => {
  const clone = (document.body || document.documentElement).cloneNode(true);
  clone.querySelectorAll('script,style,noscript,template').forEach(el => el.remove());
  for (const el of [clone, ...clone.querySelectorAll('*')]) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name === 'value' || attr.name === 'srcdoc' || /^on/i.test(attr.name) || /password|secret|token|authorization|api[-_]key/i.test(attr.name)) {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === 'TEXTAREA' || el.tagName === 'OPTION' || el.hasAttribute('contenteditable')) el.textContent = '';
    if (el.tagName === 'INPUT') el.removeAttribute('checked');
  }
  const html = clone.outerHTML;
  return {html:html.slice(0, limit), truncated:html.length > limit};
}
"""


def tool_browser_action(args: dict[str, Any]) -> dict[str, Any]:
    action = args.get("action")
    targets = {"hover", "double_click", "focus", "select", "check", "uncheck", "drag"}
    if action not in targets | {"press", "go_back", "go_forward", "reload", "tab_close", "wait"}:
        raise ValueError("unsupported browser action")
    timeout = _clamp_int(args.get("timeout_ms"), 1_000 if action == "wait" else 10_000, 1, 30_000)
    button = args.get("button", "left")
    if button not in {"left", "middle", "right"}:
        raise ValueError("button must be left, middle, or right")
    if action == "select" and not isinstance(args.get("value"), str):
        raise ValueError("select requires a string value")
    if action == "press" and (not isinstance(args.get("key"), str) or not args["key"] or len(args["key"]) > 128):
        raise ValueError("press requires a key or key chord")

    def run(state: BrowserRuntimeState) -> dict[str, Any]:
        tab_id, page = state.page(args.get("tab_id"))
        blocked = _before_action(state, tab_id, page)
        if blocked is not None:
            return blocked
        target = _locator(page, args) if action in targets or (action == "press" and (args.get("ref") or args.get("selector"))) else None
        if action == "tab_close":
            with _mutation(state, page):
                page.close()
                state._forget_page(page, intentional=True)
            if state.runtime is not None:
                state.runtime.retire_empty_profile(state.profile)
            return {"tab_id": tab_id, "closed": True, "tabs": state.list_tabs(), "automation": state.automation()}
        try:
            with (_mutation(state, page) if action != "wait" else contextlib.nullcontext()):
                if action == "double_click":
                    target.dblclick(button=button, timeout=timeout)
                elif action == "select":
                    target.select_option(args["value"], timeout=timeout)
                elif action == "drag":
                    destination = _locator(page, {"ref": args.get("target_ref"), "selector": args.get("target_selector")})
                    target.drag_to(destination, timeout=timeout)
                elif action in {"hover", "focus", "check", "uncheck"}:
                    getattr(target, action)(timeout=timeout)
                elif action == "press":
                    if target is not None:
                        target.press(args["key"], timeout=timeout)
                    else:
                        page.keyboard.press(args["key"])
                elif action in {"go_back", "go_forward", "reload"}:
                    getattr(page, action)(wait_until="domcontentloaded", timeout=timeout)
                elif action == "wait":
                    deadline = time.monotonic() + timeout / 1000
                    while time.monotonic() < deadline:
                        _check_operation(RUN_SCOPE.get())
                        page.wait_for_timeout(min(100, max(1, (deadline - time.monotonic()) * 1000)))
        except PlaywrightTimeoutError:
            if action not in {"go_back", "go_forward", "reload"}:
                raise
        return {**_page_summary(state, tab_id, page), "action": action}

    return _browser_call(run)


def tool_browser_click(args: dict[str, Any]) -> dict[str, Any]:
    timeout = _clamp_int(args.get("timeout_ms"), 10_000, 1_000, 30_000)
    button = args.get("button", "left")
    if button not in {"left", "middle", "right"}:
        raise ValueError("button must be left, middle, or right")

    def run(state: BrowserRuntimeState) -> dict[str, Any]:
        tab_id, page = state.page(args.get("tab_id"))
        blocked = _before_action(state, tab_id, page)
        if blocked is not None:
            return blocked
        target = _locator(page, args)
        with _mutation(state, page):
            target.click(button=button, timeout=timeout)
        return _page_summary(state, tab_id, page)

    return _browser_call(run)


def tool_browser_type(args: dict[str, Any]) -> dict[str, Any]:
    text = args.get("text")
    if not isinstance(text, str):
        raise ValueError("text is required")
    if len(text) > 20_000:
        raise ValueError("text exceeds 20,000 characters")
    timeout = _clamp_int(args.get("timeout_ms"), 10_000, 1_000, 30_000)

    def run(state: BrowserRuntimeState) -> dict[str, Any]:
        tab_id, page = state.page(args.get("tab_id"))
        blocked = _before_action(state, tab_id, page)
        if blocked is not None:
            return blocked
        with _mutation(state, page):
            if args.get("ref") or args.get("selector"):
                target = _locator(page, args)
                target.click(timeout=timeout)
                _check_operation(RUN_SCOPE.get())
                if bool(args.get("clear", True)):
                    # Do not replay failed/ambiguous fills as keyboard input.
                    target.fill(text, timeout=timeout)
                else:
                    page.keyboard.type(text)
            else:
                page.keyboard.type(text)
            _check_operation(RUN_SCOPE.get())
            if args.get("press"):
                page.keyboard.press(str(args["press"]))
        return _page_summary(state, tab_id, page)

    return _browser_call(run)


def tool_browser_scroll(args: dict[str, Any]) -> dict[str, Any]:
    delta = _clamp_int(args.get("delta_y"), 0, -100_000, 100_000)

    def run(state: BrowserRuntimeState) -> dict[str, Any]:
        tab_id, page = state.page(args.get("tab_id"))
        blocked = _before_action(state, tab_id, page)
        if blocked is not None:
            return blocked
        with _mutation(state, page):
            page.mouse.wheel(0, delta)
        return _page_summary(state, tab_id, page)

    return _browser_call(run)


def tool_browser_screenshot(args: dict[str, Any]) -> dict[str, Any]:
    def run(state: BrowserRuntimeState) -> dict[str, Any]:
        tab_id, page = state.page(args.get("tab_id"))
        SCREENSHOT_ROOT.mkdir(parents=True, exist_ok=True)
        path = SCREENSHOT_ROOT / f"browser-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}.png"
        # The container's Xvfb is 1280x800; clip protects us if a page reports
        # a larger viewport after an external resize.
        viewport = page.viewport_size
        if viewport is None:
            # CDP preserves the user's real window instead of emulating a
            # Playwright viewport; the toolbar is not part of page pixels.
            viewport = page.evaluate("() => ({width: innerWidth, height: innerHeight})")
        clip = {"x": 0, "y": 0, "width": _clamp_int(viewport["width"], DISPLAY_SIZE[0], 1, DISPLAY_SIZE[0]),
                "height": _clamp_int(viewport["height"], DISPLAY_SIZE[1], 1, DISPLAY_SIZE[1])}
        page.screenshot(path=str(path), type="png", clip=clip)
        return {"tab": _page_summary(state, tab_id, page), "image": _image_result(path, coordinate_space="browser_viewport"), "automation": state.automation()}

    return _browser_call(run)


def tool_browser_tabs(_: dict[str, Any]) -> dict[str, Any]:
    def run(state: BrowserRuntimeState) -> dict[str, Any]:
        state._refresh_tabs()
        for tab_id, page in state.tabs.items():
            state.detect_challenge(tab_id, page)
        return {"tabs": state.list_tabs(), "automation": state.automation(), **(state.blocked() or {})}

    return _browser_call(run)


def tool_browser_select_tab(args: dict[str, Any]) -> dict[str, Any]:
    tab_id = args.get("tab_id")
    if not isinstance(tab_id, str):
        raise ValueError("tab_id is required")
    return _browser_call(lambda state: {"selected": tab_id, **_page_summary(state, *state.page(tab_id))})


def tool_browser_upload(args: dict[str, Any]) -> dict[str, Any]:
    paths = args.get("paths")
    if not isinstance(paths, list) or not paths or not all(isinstance(path, str) for path in paths):
        raise ValueError("paths must be a non-empty list of workspace file paths")
    files = [_safe_relative(path) for path in paths]
    if any(not path.is_file() for path in files):
        raise ValueError("all upload paths must exist")

    def run(state: BrowserRuntimeState) -> dict[str, Any]:
        tab_id, page = state.page(args.get("tab_id"))
        blocked = _before_action(state, tab_id, page)
        if blocked is not None:
            return blocked
        timeout = _clamp_int(args.get("timeout_ms"), 15_000, 1_000, 60_000)
        with _mutation(state, page):
            if bool(args.get("file_chooser", False)):
                with page.expect_file_chooser(timeout=timeout) as chooser:
                    _locator(page, args).click(timeout=timeout)
                _check_operation(RUN_SCOPE.get())
                chooser.value.set_files([str(path) for path in files], timeout=timeout)
            else:
                locator = _locator(page, args) if args.get("ref") or args.get("selector") else page.locator('input[type="file"]').first
                locator.set_input_files([str(path) for path in files], timeout=timeout)
        return {**_page_summary(state, tab_id, page), "files": [_file_metadata(path) for path in files]}

    return _browser_call(run)


def tool_browser_download(args: dict[str, Any]) -> dict[str, Any]:
    def run(state: BrowserRuntimeState) -> dict[str, Any]:
        tab_id, page = state.page(args.get("tab_id"))
        blocked = _before_action(state, tab_id, page)
        if blocked is not None:
            return blocked
        timeout = _clamp_int(args.get("timeout_ms"), 30_000, 1_000, 60_000)
        if state.runtime is None:
            raise RuntimeError("browser download requires its managed CDP runtime")
        process = state.runtime.processes[state.profile]
        cdp = state.context.new_cdp_session(page)
        try:
            tree = cdp.send("Page.getFrameTree")["frameTree"]
        finally:
            cdp.detach()

        def frame_ids(node: dict[str, Any]) -> set[str]:
            return {node["frame"]["id"]} | set().union(*(frame_ids(child) for child in node.get("childFrames", [])))

        owned_frames = frame_ids(tree)
        previous = set(process.downloads)
        deadline = time.monotonic() + timeout / 1000
        record: dict[str, Any] | None = None

        def started_download() -> dict[str, Any] | None:
            return next((event for guid, event in process.downloads.items() if guid not in previous and event.get("frameId") in owned_frames), None)

        with _mutation(state, page):
            try:
                process.download_cdp.send("Browser.setDownloadBehavior", {"behavior": "allowAndName", "downloadPath": str(process.download_root), "eventsEnabled": True})
                with page.expect_download(timeout=timeout) as pending:
                    if args.get("url"):
                        url = str(args["url"])
                        if urllib.parse.urlsplit(url).scheme not in {"http", "https", "blob", "data"}:
                            raise ValueError("download URL must use http, https, blob or data")
                        page.evaluate("url => { const a = document.createElement('a'); a.href = url; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); }", url)
                    else:
                        _locator(page, args).click(timeout=timeout)
                download = pending.value
                while True:
                    _check_operation(RUN_SCOPE.get())
                    record = record or started_download()
                    if record is not None and record.get("state") == "completed":
                        break
                    if record is not None and record.get("state") == "canceled":
                        raise RuntimeError("browser download was cancelled")
                    if time.monotonic() >= deadline:
                        raise TimeoutError("browser download did not complete before timeout")
                    page.wait_for_timeout(min(100, max(1, (deadline - time.monotonic()) * 1000)))
                # Artifact.failure/save_as have no completion timeout and can
                # outlive the page. Copy only Chromium's proven-complete GUID.
                _check_operation(RUN_SCOPE.get())
                path = _safe_relative(args["path"]) if args.get("path") else _scope_cwd() / "downloads" / f"{uuid.uuid4().hex[:8]}-{Path(download.suggested_filename).name}"
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(process.download_root / record["guid"], path)
            finally:
                try:
                    record = record or started_download()
                    if record is not None:
                        if record.get("state") != "completed":
                            with contextlib.suppress(Exception):
                                process.download_cdp.send("Browser.cancelDownload", {"guid": record["guid"]})
                        for suffix in ("", ".crdownload"):
                            (process.download_root / (record["guid"] + suffix)).unlink(missing_ok=True)
                finally:
                    # Human downloads keep their filenames/extensions in the
                    # desktop's normal directory, not the helper's GUID cache.
                    try:
                        process.download_cdp.send("Browser.setDownloadBehavior", process.normal_download_behavior)
                    except Exception:
                        if process.browser.is_connected():
                            raise RuntimeError("could not restore the browser's normal download location") from None
        return {**_page_summary(state, tab_id, page), "file": _file_metadata(path), "suggested_filename": download.suggested_filename}

    return _browser_call(run)


