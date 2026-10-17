"""Browser lifecycle contracts with fake CDP objects; never launch a real browser."""
from __future__ import annotations

import fcntl
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, call, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import workspace_browser as browser


class FakePage:
    def __init__(self, context, url="about:blank", opener=None):
        self.context, self.url, self._opener = context, url, opener
        self.closed = False
        self.evidence = None
        self.actions = []
        self.callbacks = {}
        self.target_id = f"fixture-{id(self)}"
        self.viewport_size = {"width": 1280, "height": 800}
        self.keyboard = SimpleNamespace(type=Mock(), press=Mock())
        self.mouse = SimpleNamespace(wheel=Mock())

    def is_closed(self):
        return self.closed

    def on(self, event, callback):
        self.callbacks[event] = callback

    def close(self):
        self.closed = True
        if self in self.context.pages:
            self.context.pages.remove(self)
        if self.callbacks.get("close") is not None:
            self.callbacks["close"](self)

    def wait_for_timeout(self, milliseconds):
        if self.closed:
            raise RuntimeError("fixture target closed")
        time.sleep(milliseconds / 1000)

    def opener(self):
        return self._opener

    def title(self):
        return "Fixture"

    def bring_to_front(self):
        self.actions.append("front")

    def goto(self, url, **kwargs):
        self.url = url
        self.actions.append(("goto", url))

    def evaluate(self, script, *args):
        if script == browser._CHALLENGE_SCRIPT:
            return self.evidence
        self.actions.append(("evaluate", script, args))
        return [{"ref": args[0]["prefix"] + "-1", "tag": "button", "text": "Fixture"}]

    def locator(self, selector):
        locator = Mock()
        locator.first = locator
        locator.inner_text.return_value = "Fixture text"
        locator.click.side_effect = lambda **kwargs: self.actions.append(("click", selector))
        return locator


class FakeContext:
    def __init__(self):
        self.pages = []
        self.callbacks = {}
        self.browser = SimpleNamespace(contexts=[self], is_connected=lambda: True, close=Mock(), new_browser_cdp_session=Mock(return_value=Mock()))
        self.new_page()

    def new_page(self, opener=None):
        page = FakePage(self, opener=opener)
        self.pages.append(page)
        callback = self.callbacks.get("page")
        if callback is not None:
            callback(page)
        return page

    def on(self, event, callback):
        self.callbacks[event] = callback

    def set_default_timeout(self, timeout):
        pass

    def set_default_navigation_timeout(self, timeout):
        pass

    def new_cdp_session(self, page):
        def send(method):
            if method == "Target.getTargetInfo":
                return {"targetInfo": {"targetId": page.target_id}}
            if method == "Page.getFrameTree":
                return {"frameTree": {"frame": {"id": page.target_id}}}
            raise AssertionError(f"unexpected fixture CDP method {method}")
        return SimpleNamespace(send=send, detach=Mock())


class FakeProcess:
    def __init__(self, profile):
        self.profile = profile
        self.manual_open = False
        self.context = FakeContext()
        self.browser = self.context.browser
        self.process = SimpleNamespace(poll=lambda: None)
        self.stopped = False
        self.endpoint = "http://127.0.0.1:32123"
        self.download_root = profile / "downloads-cache"
        self.normal_download_behavior = {"behavior": "allow", "downloadPath": str(browser.DATA_ROOT / "work" / "downloads"), "eventsEnabled": True}
        self.download_root.mkdir(parents=True, exist_ok=True)
        self.downloads = {}
        self.download_cdp = SimpleNamespace(send=Mock())

    def start(self, playwright):
        return self.context

    def stop(self):
        self.stopped = True


class BrowserContracts(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ochi-browser-unit-")
        self.root = Path(self.temporary.name)
        self.token = browser.RUN_SCOPE.set({})

    def tearDown(self):
        browser.RUN_SCOPE.reset(self.token)
        self.temporary.cleanup()

    def runtime(self):
        runtime = browser.BrowserRuntime(self.root / "profiles")
        runtime.profiles = browser.BrowserProfiles(runtime.root)
        runtime.restore_tabs = dict(runtime.profiles.saved)
        runtime.playwright = object()
        runtime._submit = lambda fn, scope=None: fn()
        return runtime

    def test_state_requires_the_explicit_persistent_context(self):
        context = FakeContext()
        with self.assertRaisesRegex(TypeError, "context"):
            browser.BrowserRuntimeState(None, context.browser, {})
        context.browser.contexts = []
        context.browser.new_context = Mock(side_effect=AssertionError("created an unrelated browser context"))
        state = browser.BrowserRuntimeState(None, context.browser, {}, context, "one")
        self.assertIs(state._context(), context)
        self.assertIs(state.page()[1].context, context)
        context.browser.new_context.assert_not_called()
        context.browser.is_connected = lambda: False
        with self.assertRaisesRegex(RuntimeError, "connection was closed"):
            state._context()

    def test_main_and_project_identity_preserve_login_bytes(self):
        main = self.root / "main"
        main.mkdir()
        cookie = main / "Cookies"
        cookie.write_bytes(b"do-not-read-or-rewrite-private-cookie-database")
        (self.root / "project-project1").mkdir()
        (self.root / "sessions.json").write_text(json.dumps({"saved": {"profile": "main", "urls": []}}))
        with patch.object(browser, "_atomic_json", side_effect=AssertionError("loading rewrote browser identities")):
            profiles = browser.BrowserProfiles(self.root)
            self.assertEqual(profiles.identity({"session_id": "new1"}), ("new1", "main"))
            self.assertEqual(profiles.identity({"session_id": "new2"}), ("new2", "main"))
            self.assertEqual(profiles.identity({"session_id": "new2", "project_id": "project1"}), ("new2", "project-project1"))
        restarted = browser.BrowserProfiles(self.root)
        self.assertEqual(restarted.identity({"session_id": "new1"}), ("new1", "main"))
        self.assertEqual(restarted.identity({"session_id": "new2", "project_id": "project1"}), ("new2", "project-project1"))
        self.assertEqual(cookie.read_bytes(), b"do-not-read-or-rewrite-private-cookie-database")

    def test_identity_is_not_inferred_from_directories_or_tab_ledger(self):
        (self.root / "custom-profile").mkdir()
        (self.root / "sessions.json").write_text(json.dumps({"saved": {"profile": "project-other", "urls": []}}))
        profiles = browser.BrowserProfiles(self.root)
        self.assertEqual(profiles.identity({"session_id": "directory"}), ("directory", "main"))
        self.assertEqual(profiles.identity({"session_id": "saved"}), ("saved", "main"))
        self.assertEqual(profiles.saved["saved"]["profile"], "project-other")

    def test_metadata_reads_are_only_owned_url_ledgers(self):
        (self.root / "sessions.json").write_text("{}")
        read_text = Path.read_text
        reads = []

        def record(path, *args, **kwargs):
            reads.append(path.name)
            return read_text(path, *args, **kwargs)

        with patch.object(Path, "read_text", record):
            profiles = browser.BrowserProfiles(self.root)
            profiles.identity({"session_id": "new"})
        self.assertEqual(reads, ["sessions.json"])

    def test_corrupt_tab_ledger_fails_without_silently_resetting_it(self):
        metadata = self.root / "sessions.json"
        metadata.write_text("[]")
        with self.assertRaisesRegex(ValueError, "invalid browser metadata"):
            browser.BrowserProfiles(self.root)
        self.assertEqual(metadata.read_text(), "[]")
        metadata.write_text("not-json")
        with self.assertRaises(ValueError):
            browser.BrowserProfiles(self.root)
        self.assertEqual(metadata.read_text(), "not-json")

    def test_invalid_scope_cannot_choose_arbitrary_profile_directory(self):
        profiles = browser.BrowserProfiles(self.root)
        for scope in ({}, {"session_id": ""}, {"session_id": "../../escape"}, {"project_id": "../escape"}, {"session_id": 7}):
            with self.subTest(scope=scope), self.assertRaises(ValueError):
                profiles.identity(scope)

    def test_browser_tools_reject_missing_session_before_starting_browser(self):
        runtime = browser.BrowserRuntime(self.root / "profiles")
        with patch.object(runtime, "_start", side_effect=AssertionError("started an unscoped browser")):
            with self.assertRaisesRegex(ValueError, "session/project scope"):
                runtime.call(lambda _: self.fail("unscoped action ran"))

    def test_live_singleton_is_not_removed_or_force_killed(self):
        lock = self.root / "SingletonLock"
        lock.symlink_to(f"{socket.gethostname()}-{os.getpid()}")
        with self.assertRaisesRegex(RuntimeError, "already in use"):
            browser._clear_stale_singletons(self.root)
        self.assertTrue(lock.is_symlink())
        self.assertEqual(os.readlink(lock), f"{socket.gethostname()}-{os.getpid()}")

    def test_only_proven_stale_singletons_are_cleared(self):
        for name in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
            target = f"{socket.gethostname()}-99999999" if name == "SingletonLock" else str(self.root / "absent")
            (self.root / name).symlink_to(target)
        browser._clear_stale_singletons(self.root)
        self.assertFalse(any((self.root / name).is_symlink() for name in ("SingletonLock", "SingletonSocket", "SingletonCookie")))
        (self.root / "SingletonLock").write_text("unknown regular lock")
        with self.assertRaisesRegex(RuntimeError, "unknown singleton"):
            browser._clear_stale_singletons(self.root)

    def test_foreign_or_malformed_singleton_ownership_fails_closed(self):
        lock = self.root / "SingletonLock"
        singleton = self.root / "SingletonSocket"
        singleton.symlink_to(self.root / "absent-in-this-container")
        for target in ("another-container-host-99999999", "malformed-owner", ""):
            if not target:
                continue
            lock.symlink_to(target)
            with self.subTest(target=target), self.assertRaisesRegex(RuntimeError, "another host or unknown"):
                browser._clear_stale_singletons(self.root)
            self.assertTrue(lock.is_symlink())
            self.assertTrue(singleton.is_symlink())
            lock.unlink()

    def test_independent_launch_uses_nonzero_loopback_cdp_and_no_test_flags(self):
        context = FakeContext()
        child = Mock()
        child.poll.return_value = None
        argv = []

        def launch(arguments, **kwargs):
            argv.extend(arguments)
            self.assertTrue(kwargs["start_new_session"])
            self.assertEqual(kwargs["env"]["DISPLAY"], os.environ.get("DISPLAY", ":99"))
            self.assertEqual(kwargs["env"]["ACCESSIBILITY_ENABLED"], "1")
            return child

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def read(self, limit):
                port = next(arg.split("=", 1)[1] for arg in argv if arg.startswith("--remote-debugging-port="))
                return json.dumps({"webSocketDebuggerUrl": f"ws://127.0.0.1:{port}/devtools/browser/fixture"}).encode()

        opener = SimpleNamespace(open=lambda *args, **kwargs: Response())
        chromium = SimpleNamespace(connect_over_cdp=Mock(return_value=context.browser))
        process = browser.ChromiumProcess(self.root)
        with patch.object(browser.subprocess, "Popen", launch), patch.object(browser.urllib.request, "build_opener", return_value=opener):
            self.assertIs(process.start(SimpleNamespace(chromium=chromium)), context)
            endpoint = chromium.connect_over_cdp.call_args.args[0]
            self.assertTrue(endpoint.startswith("http://127.0.0.1:"))
            self.assertNotEqual(endpoint.rsplit(":", 1)[1], "0")
            self.assertIn("--remote-debugging-address=127.0.0.1", argv)
            self.assertIn("--force-renderer-accessibility", argv)
            self.assertIn(f"--user-data-dir={self.root}", argv)
            context.browser.new_browser_cdp_session.return_value.send.assert_called_once_with("Browser.setDownloadBehavior", process.normal_download_behavior)
            self.assertFalse(any("enable-automation" in arg or "headless" in arg or "AutomationControlled" in arg or "remote-allow-origins" in arg for arg in argv))
            process.stop()
        child.terminate.assert_called_once()
        child.kill.assert_not_called()

    def test_startup_failure_terminates_only_owned_child_and_releases_lock(self):
        child = Mock()
        child.poll.return_value = None
        process = browser.ChromiumProcess(self.root)
        with patch.object(browser.subprocess, "Popen", return_value=child):
            with self.assertRaises(TimeoutError):
                process.start(SimpleNamespace(), timeout=0)
        child.terminate.assert_called_once()
        self.assertIsNone(process.lock)
        with (self.root / ".ochi-browser.lock").open("a+") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_stop_removes_only_exact_owned_exited_child_singletons(self):
        for owner in (f"{socket.gethostname()}-7654321", "foreign-host-7654321", f"{socket.gethostname()}-7654322", "unknown-owner"):
            with self.subTest(owner=owner):
                process = browser.ChromiumProcess(self.root)
                process.process = SimpleNamespace(pid=7654321, poll=lambda: 0)
                process.lock = (self.root / ".ochi-browser.lock").open("a+")
                fcntl.flock(process.lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                process._owns_lock = True
                paths = [self.root / name for name in ("SingletonLock", "SingletonCookie", "SingletonSocket")]
                paths[0].symlink_to(owner)
                paths[1].symlink_to("opaque-cookie-token")
                paths[2].symlink_to("/tmp/fixture-chromium-socket")
                process.stop()
                owned = owner == f"{socket.gethostname()}-7654321"
                self.assertTrue(all(path.is_symlink() != owned for path in paths))
                self.assertIsNone(process.lock)
                for path in paths:
                    path.unlink(missing_ok=True)

    def test_stop_does_not_remove_singletons_without_child_exit_or_advisory_lock(self):
        singleton = self.root / "SingletonLock"
        singleton.symlink_to(f"{socket.gethostname()}-7654321")
        process = browser.ChromiumProcess(self.root)
        process.process = SimpleNamespace(pid=7654321, poll=lambda: 0)
        process.stop()
        self.assertTrue(singleton.is_symlink())
        process.lock = (self.root / ".ochi-browser.lock").open("a+")
        process.stop()
        self.assertTrue(singleton.is_symlink())
        process.lock = (self.root / ".ochi-browser.lock").open("a+")
        fcntl.flock(process.lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        process._owns_lock = True
        process.process = SimpleNamespace(pid=7654321, poll=lambda: None, terminate=Mock(), wait=Mock())
        process.stop()
        self.assertTrue(singleton.is_symlink())

    def test_sibling_sessions_share_login_identity_not_tabs_or_popups(self):
        runtime = self.runtime()
        with patch.object(browser, "ChromiumProcess", FakeProcess):
            first = runtime._state_for_scope({"session_id": "one"})
            second = runtime._state_for_scope({"session_id": "two"})
            self.assertIs(first.context, second.context)
            first_tab, first_page = first.page()
            second_tab, second_page = second.page()
            self.assertIsNot(first_page, second_page)
            first_page.url = "https://fixture.invalid/one"
            second_page.url = "https://fixture.invalid/two"
            popup = first.context.new_page(opener=first_page)
            popup.url = "https://fixture.invalid/popup"
            manual = first.context.new_page()
            manual.url = "https://fixture.invalid/user"
            self.assertEqual(len(first.list_tabs()), 2)
            self.assertEqual(len(second.list_tabs()), 1)
            self.assertEqual(runtime.page_owners[id(popup)], "one")
            self.assertNotIn(id(manual), runtime.page_owners)
            with self.assertRaisesRegex(ValueError, "another session"):
                second.register_page(first_page)
            self.assertEqual(second.page(second_tab)[1].url, "https://fixture.invalid/two")
            first_page.closed = True
            self.assertEqual(len(first.list_tabs()), 1)
            self.assertEqual(first.list_tabs()[0]["url"], popup.url)
            runtime.close()

    def test_eviction_flushes_owned_tabs_and_preserves_project_identity(self):
        runtime = self.runtime()
        scope = {"session_id": "one", "project_id": "project1"}
        with patch.object(browser, "ChromiumProcess", FakeProcess):
            state = runtime._state_for_scope(scope)
            state.page()[1].url = "https://fixture.invalid/logged-in"
            process = runtime.processes["project-project1"]
            runtime._evict_profile("project-project1")
            self.assertTrue(process.stopped)
            saved = json.loads((runtime.root / "sessions.json").read_text())
            self.assertEqual(saved["one"], {"profile": "project-project1", "urls": ["https://fixture.invalid/logged-in"]})
            restored = runtime._state_for_scope(scope)
            self.assertEqual(restored.page()[1].url, "https://fixture.invalid/logged-in")

    def test_restore_keeps_active_first_and_defers_other_urls_at_challenge(self):
        runtime = self.runtime()
        urls = [f"https://fixture.invalid/{index}" for index in range(3)]
        with patch.object(browser, "ChromiumProcess", FakeProcess):
            state = runtime._state_for_scope({"session_id": "one"})
            tab, challenged = state.page()
            challenged.evidence = {"provider": "cloudflare"}
            state.restore_urls(urls, use_current=True)
            self.assertEqual(challenged.url, urls[0])
            self.assertEqual(state.remaining_urls, urls[1:])
            self.assertEqual(len(state.tabs), 1)
            runtime._save_sessions()
            saved = json.loads((runtime.root / "sessions.json").read_text())
            self.assertEqual(saved["one"]["urls"], urls)
            challenged.evidence = None
            with patch.object(browser, "_browser_call", side_effect=lambda fn: fn(state)):
                self.assertTrue(browser.tool_browser_resume({"human_completed": True})["resumed"])
            self.assertEqual(state.remaining_urls, [])
            self.assertEqual([item["url"] for item in state.list_tabs()], urls)
            self.assertEqual(state.active_tab, tab)
            runtime._evict_profile("main")
            restored = runtime._state_for_scope({"session_id": "one"})
            self.assertEqual(restored.page()[1].url, urls[0])

    def test_profile_limit_uses_lru_without_evicting_manual_user_tabs(self):
        runtime = self.runtime()
        with patch.object(browser, "ChromiumProcess", FakeProcess):
            state = runtime._state_for_scope({"session_id": "ordinary"})
            state.page()
            manual = state.context.new_page()
            manual.url = "https://fixture.invalid/manual"
            for index in range(1, 4):
                runtime._state_for_scope({"session_id": f"s{index}", "project_id": f"p{index}"})
            runtime.used.update({"main": 0, "project-p1": 1, "project-p2": 2, "project-p3": 3})
            oldest = runtime.processes["project-p1"]
            runtime._state_for_scope({"session_id": "s4", "project_id": "p4"})
            self.assertEqual(len(runtime.contexts), 4)
            self.assertIn("main", runtime.contexts)
            self.assertNotIn("project-p1", runtime.contexts)
            self.assertTrue(oldest.stopped)

    def test_inactive_session_lru_bounds_shared_profile_and_restores_owned_tabs(self):
        runtime = self.runtime()
        with patch.object(browser, "ChromiumProcess", FakeProcess):
            first = runtime._state_for_scope({"session_id": "one"})
            _, first_page = first.page()
            first_page.url = "https://fixture.invalid/one"
            manual = first.context.new_page()
            manual.url = "https://fixture.invalid/manual"
            for index in range(100):
                state = runtime._state_for_scope({"session_id": f"ordinary-{index}"})
                state.page()[1].url = f"https://fixture.invalid/{index}"
            self.assertEqual(len(runtime.contexts), 1)
            self.assertEqual(len(runtime.states), browser.MAX_ACTIVE_BROWSER_SESSIONS)
            self.assertEqual(len(first.context.pages), browser.MAX_ACTIVE_BROWSER_SESSIONS + 1)
            self.assertTrue(first_page.closed)
            self.assertFalse(manual.closed)
            restored = runtime._state_for_scope({"session_id": "one"})
            restored_page = restored.page()[1]
            self.assertIsNot(restored_page, first_page)
            self.assertIsNot(restored_page, manual)
            self.assertEqual(restored_page.url, "https://fixture.invalid/one")
            self.assertEqual(manual.url, "https://fixture.invalid/manual")
            self.assertEqual(runtime.page_owners[id(restored_page)], "one")
            self.assertNotIn(id(manual), runtime.page_owners)

    def test_lru_keeps_paused_and_busy_sessions_and_reports_capacity(self):
        runtime = self.runtime()
        with patch.object(browser, "ChromiumProcess", FakeProcess):
            paused = runtime._state_for_scope({"session_id": "paused"})
            tab, page = paused.page()
            page.evidence = {"provider": "captcha"}
            paused.detect_challenge(tab, page)
            busy = runtime._state_for_scope({"session_id": "busy"})
            busy_page = busy.page()[1]
            runtime._busy_sessions["busy"] = 1
            for index in range(20):
                runtime._state_for_scope({"session_id": f"ordinary-{index}"}).page()
            self.assertIs(runtime.states["paused"], paused)
            self.assertFalse(page.closed)
            self.assertFalse(busy_page.closed)
            for state in runtime.states.values():
                state.pause = {"tab_id": state.active_tab, "provider": "captcha"}
            with self.assertRaisesRegex(RuntimeError, "capacity"):
                runtime._state_for_scope({"session_id": "cannot-evict"})
            self.assertEqual(len(runtime.states), browser.MAX_ACTIVE_BROWSER_SESSIONS)

    def test_profile_lru_keeps_human_challenge(self):
        runtime = self.runtime()
        with patch.object(browser, "ChromiumProcess", FakeProcess):
            state = runtime._state_for_scope({"session_id": "challenge"})
            tab, page = state.page()
            page.evidence = {"provider": "cloudflare"}
            state.detect_challenge(tab, page)
            for index in range(4):
                runtime._state_for_scope({"session_id": f"session-{index}", "project_id": f"project-{index}"})
            self.assertIn("main", runtime.contexts)
            self.assertFalse(page.closed)

    def test_closing_final_tab_succeeds_and_saves_empty_ledger_on_disconnect(self):
        runtime = self.runtime()
        with patch.object(browser, "ChromiumProcess", FakeProcess):
            state = runtime._state_for_scope({"session_id": "one"})
            tab, page = state.page()
            page.url = "https://fixture.invalid/old"
            runtime._save_sessions()
            close = page.close

            def disconnect():
                close()
                state.browser.is_connected = lambda: False

            with patch.object(browser, "_browser_call", side_effect=lambda fn: fn(state)), patch.object(page, "close", disconnect):
                result = browser.tool_browser_action({"action": "tab_close", "tab_id": tab})
            self.assertTrue(result["closed"])
            self.assertEqual(result["tabs"], [])
            runtime._save_sessions()
            saved = json.loads((runtime.root / "sessions.json").read_text())
            self.assertEqual(saved["one"]["urls"], [])

    def test_last_tab_retired_before_immediate_new_page_without_mutation_retry(self):
        runtime = self.runtime()
        with patch.object(browser, "ChromiumProcess", FakeProcess):
            state = runtime._state_for_scope({"session_id": "one", "project_id": "only"})
            _, page = state.page()
            page.url = "https://fixture.invalid/closed"
            process = runtime.processes["project-only"]
            with patch.object(browser, "_browser_call", side_effect=lambda fn: fn(state)):
                closed = browser.tool_browser_action({"action": "tab_close"})
            self.assertTrue(closed["closed"])
            self.assertEqual(closed["tabs"], [])
            self.assertTrue(process.stopped)
            self.assertNotIn("project-only", runtime.contexts)
            reopened = runtime._state_for_scope({"session_id": "one", "project_id": "only"})
            with patch.object(browser, "_browser_call", side_effect=lambda fn: fn(reopened)):
                result = browser.tool_browser_goto({"url": "https://fixture.invalid/reopened"})
            self.assertEqual(result["url"], "https://fixture.invalid/reopened")
            self.assertIsNot(reopened.context, state.context)
            new_page = reopened.page()[1]
            self.assertEqual([action for action in new_page.actions if isinstance(action, tuple) and action[0] == "goto"], [("goto", "https://fixture.invalid/reopened")])

    def test_last_owned_tab_never_retires_profile_with_sibling_or_manual_pages(self):
        runtime = self.runtime()
        with patch.object(browser, "ChromiumProcess", FakeProcess):
            state = runtime._state_for_scope({"session_id": "one"})
            state.page()
            sibling = runtime._state_for_scope({"session_id": "two"})
            sibling_page = sibling.page()[1]
            manual = state.context.new_page()
            process = runtime.processes["main"]
            with patch.object(browser, "_browser_call", side_effect=lambda fn: fn(state)):
                browser.tool_browser_action({"action": "tab_close"})
            self.assertFalse(process.stopped)
            self.assertFalse(sibling_page.closed)
            self.assertFalse(manual.closed)
            sibling_page.close()
            runtime.retire_empty_profile("main")
            self.assertFalse(process.stopped)
            self.assertFalse(manual.closed)

    def test_empty_context_is_replaced_even_before_async_browser_disconnect(self):
        runtime = self.runtime()
        with patch.object(browser, "ChromiumProcess", FakeProcess):
            state = runtime._state_for_scope({"session_id": "one"})
            page = state.page()[1]
            process = runtime.processes["main"]
            page.close()
            self.assertTrue(state.browser.is_connected())
            self.assertIsNone(process.process.poll())
            new_state = runtime._state_for_scope({"session_id": "one"})
            self.assertTrue(process.stopped)
            self.assertIsNot(state.context, new_state.context)
            self.assertFalse(new_state.page()[1].closed)

    def test_crashed_browser_does_not_erase_prior_owned_urls(self):
        runtime = self.runtime()
        with patch.object(browser, "ChromiumProcess", FakeProcess):
            state = runtime._state_for_scope({"session_id": "one"})
            state.page()[1].url = "https://fixture.invalid/persistent"
            runtime._save_sessions()
            state.browser.is_connected = lambda: False
            runtime._save_sessions()
            saved = json.loads((runtime.root / "sessions.json").read_text())
            self.assertEqual(saved["one"]["urls"], ["https://fixture.invalid/persistent"])

    def test_manual_launch_and_status_never_adopt_user_tabs(self):
        runtime = self.runtime()
        browser.RUN_SCOPE.set({"session_id": "one"})
        with patch.object(browser, "ChromiumProcess", FakeProcess):
            self.assertFalse(runtime.status({})["started"])
            self.assertEqual(runtime.contexts, {})
            opened = runtime.open_manual("https://fixture.invalid/user")
            self.assertTrue(opened["manual"])
            self.assertEqual(len(runtime.contexts["main"].pages), 1)
            manual_page = runtime.contexts["main"].pages[0]
            state = runtime._state_for_scope({"session_id": "one"})
            self.assertEqual(state.list_tabs(), [])
            model_page = state.page()[1]
            self.assertIsNot(model_page, manual_page)
            self.assertEqual(manual_page.url, "https://fixture.invalid/user")
            self.assertNotIn(id(manual_page), runtime.page_owners)

    def test_desktop_activation_does_not_start_browser(self):
        runtime = browser.BrowserRuntime(self.root)
        with patch.object(runtime, "_start", side_effect=AssertionError("desktop spawned browser")):
            self.assertEqual(runtime.activate_current({"session_id": "one"}), {"activated": False})

    def test_save_failure_still_stops_owned_process(self):
        runtime = self.runtime()
        with patch.object(browser, "ChromiumProcess", FakeProcess):
            state = runtime._state_for_scope({"session_id": "one"})
            process = runtime.processes["main"]
            with patch.object(browser, "_atomic_json", side_effect=OSError("fixture disk full")):
                with self.assertRaises(OSError):
                    runtime._evict_profile("main")
            self.assertTrue(process.stopped)
            self.assertEqual(runtime.contexts, {})

    def test_challenge_blocks_mutation_and_requires_real_user_completion(self):
        context = FakeContext()
        state = browser.BrowserRuntimeState(None, context.browser, {}, context, "one")
        tab, page = state.page()
        initial_pages = len(context.pages)
        page.evidence = {"provider": "cloudflare"}
        with patch.object(browser, "_browser_call", side_effect=lambda fn: fn(state)):
            blocked = browser.tool_browser_click({"selector": "button"})
            self.assertTrue(blocked["blocked"])
            self.assertTrue(blocked["automation"]["needs_user"])
            self.assertFalse(any(isinstance(action, tuple) and action[0] == "click" for action in page.actions))
            with patch.object(page, "locator") as locator:
                blocked_type = browser.tool_browser_type({"selector": "textarea", "text": "must-not-fill"})
                self.assertTrue(blocked_type["blocked"])
                locator.assert_not_called()
            page.keyboard.type.assert_not_called()
            browser.tool_browser_goto({"url": "https://fixture.invalid/retry", "new_tab": True})
            self.assertEqual(len(context.pages), initial_pages)
            with self.assertRaises(ValueError):
                browser.tool_browser_resume({})
            still_blocked = browser.tool_browser_resume({"human_completed": True})
            self.assertFalse(still_blocked["resumed"])
            self.assertIsNotNone(state.pause)
            page.evidence = None
            browser.tool_browser_goto({"url": "https://fixture.invalid/retry"})
            self.assertFalse(any(isinstance(action, tuple) and action[0] == "goto" for action in page.actions))
            resumed = browser.tool_browser_resume({"human_completed": True})
            self.assertTrue(resumed["resumed"])
            self.assertIsNone(state.pause)
            browser.tool_browser_click({"selector": "button"})
            self.assertIn(("click", "button"), page.actions)

    def test_type_fill_does_not_require_a_separate_pointer_hit(self):
        for options in ({}, {"clear": True}):
            with self.subTest(options=options):
                context = FakeContext()
                state = browser.BrowserRuntimeState(None, context.browser, {}, context, "one")
                _, page = state.page()
                target = Mock()
                target.first = target
                target.click.side_effect = browser.PlaywrightTimeoutError("editor presentation intercepts pointer")
                with patch.object(browser, "_browser_call", side_effect=lambda fn: fn(state)), patch.object(page, "locator", return_value=target):
                    browser.tool_browser_type({"selector": "textarea.inputarea", "text": "replacement", "press": "Enter", "timeout_ms": 2000, **options})
                target.fill.assert_called_once_with("replacement", timeout=2000)
                target.click.assert_not_called()
                page.keyboard.type.assert_not_called()
                page.keyboard.press.assert_called_once_with("Enter")

    def test_type_append_still_clicks_before_keyboard_input(self):
        context = FakeContext()
        state = browser.BrowserRuntimeState(None, context.browser, {}, context, "one")
        _, page = state.page()
        target = Mock()
        target.first = target
        actions = Mock()
        actions.attach_mock(target.click, "click")
        actions.attach_mock(page.keyboard.type, "type")
        actions.attach_mock(page.keyboard.press, "press")
        with patch.object(browser, "_browser_call", side_effect=lambda fn: fn(state)), patch.object(page, "locator", return_value=target):
            browser.tool_browser_type({"selector": "input", "text": "append", "clear": False, "press": "Enter"})
        self.assertEqual(actions.mock_calls, [call.click(timeout=10000), call.type("append"), call.press("Enter")])
        target.fill.assert_not_called()

    def test_type_failed_fill_never_replays_as_keyboard_input_or_submission(self):
        context = FakeContext()
        state = browser.BrowserRuntimeState(None, context.browser, {}, context, "one")
        _, page = state.page()
        target = Mock()
        target.first = target
        target.fill.side_effect = browser.PlaywrightTimeoutError("input is not editable")
        with patch.object(browser, "_browser_call", side_effect=lambda fn: fn(state)), patch.object(page, "locator", return_value=target):
            with self.assertRaisesRegex(browser.PlaywrightTimeoutError, "not editable"):
                browser.tool_browser_type({"selector": "textarea", "text": "must-not-replay", "press": "Enter"})
        target.fill.assert_called_once_with("must-not-replay", timeout=10000)
        target.click.assert_not_called()
        page.keyboard.type.assert_not_called()
        page.keyboard.press.assert_not_called()

    def test_resume_cannot_clear_different_tab_or_failed_observation(self):
        context = FakeContext()
        state = browser.BrowserRuntimeState(None, context.browser, {}, context, "one")
        tab, page = state.page()
        state.pause = {"tab_id": tab, "reason": "human_verification", "provider": "captcha"}
        other = state.register_page(context.new_page())
        with patch.object(browser, "_browser_call", side_effect=lambda fn: fn(state)):
            with self.assertRaisesRegex(ValueError, "tab that requested"):
                browser.tool_browser_resume({"tab_id": other, "human_completed": True})
            with patch.object(page, "evaluate", side_effect=RuntimeError("inaccessible page")):
                with self.assertRaisesRegex(RuntimeError, "could not verify"):
                    browser.tool_browser_resume({"tab_id": tab, "human_completed": True})
            self.assertIsNotNone(state.pause)

    def test_resume_unknown_tab_cannot_claim_closed_challenge(self):
        context = FakeContext()
        state = browser.BrowserRuntimeState(None, context.browser, {}, context, "one")
        state.page()
        with patch.object(browser, "_browser_call", side_effect=lambda fn: fn(state)):
            with self.assertRaisesRegex(ValueError, "unknown tab_id"):
                browser.tool_browser_resume({"tab_id": "tab-not-real", "human_completed": True})

    def test_navigation_checks_requested_tab_not_just_active_tab(self):
        context = FakeContext()
        state = browser.BrowserRuntimeState(None, context.browser, {}, context, "one")
        selected, challenged = state.page()
        challenged.evidence = {"provider": "captcha"}
        state.register_page(context.new_page())
        self.assertNotEqual(state.active_tab, selected)
        with patch.object(browser, "_browser_call", side_effect=lambda fn: fn(state)):
            result = browser.tool_browser_goto({"tab_id": selected, "url": "https://fixture.invalid/new"})
        self.assertTrue(result["needs_user"])
        self.assertFalse(any(isinstance(action, tuple) and action[0] == "goto" for action in challenged.actions))

    def test_observation_refs_are_unique_per_snapshot(self):
        context = FakeContext()
        state = browser.BrowserRuntimeState(None, context.browser, {}, context, "one")
        with patch.object(browser, "_browser_call", side_effect=lambda fn: fn(state)):
            one = browser.tool_browser_observe({})
            two = browser.tool_browser_observe({})
        self.assertNotEqual(one["interactive"][0]["ref"], two["interactive"][0]["ref"])
        script = next(action[1] for action in state.page()[1].actions if isinstance(action, tuple) and action[0] == "evaluate")
        self.assertIn("removeAttribute('data-assistant-ref')", script)
        self.assertNotIn("el.value", script)

    def test_html_observation_is_bounded_sanitized_not_arbitrary_evaluation(self):
        context = FakeContext()
        state = browser.BrowserRuntimeState(None, context.browser, {}, context, "one")
        page = state.page()[1]
        evaluations = []

        def evaluate(script, *args):
            evaluations.append((script, args))
            if script == browser._CHALLENGE_SCRIPT:
                return None
            self.assertEqual(script, browser._SANITIZED_HTML_SCRIPT)
            self.assertEqual(args, (1000,))
            return {"html": '<input type="password">', "truncated": True}

        with patch.object(browser, "_browser_call", side_effect=lambda fn: fn(state)), patch.object(page, "evaluate", evaluate):
            result = browser.tool_browser_observe({"format": "html", "max_chars": 1000})
            self.assertEqual(result["html"], '<input type="password">')
            self.assertTrue(result["html_truncated"])
            with self.assertRaises(ValueError):
                browser.tool_browser_observe({"format": "evaluate"})
        script = browser._SANITIZED_HTML_SCRIPT
        self.assertIn("cloneNode(true)", script)
        self.assertIn("attr.name === 'value'", script)
        self.assertIn("el.removeAttribute(attr.name)", script)
        self.assertIn("password|secret|token|authorization", script)
        self.assertIn("el.textContent = ''", script)
        self.assertIn("script,style,noscript,template", script)
        self.assertNotIn("eval(", script)

    def test_whitelisted_browser_actions_use_owned_element_refs(self):
        context = FakeContext()
        state = browser.BrowserRuntimeState(None, context.browser, {}, context, "one")
        page = state.page()[1]
        target = Mock()
        target.first = target
        destination = Mock()
        destination.first = destination
        locator_queries = []

        def locator(selector):
            locator_queries.append(selector)
            return destination if selector == '[data-assistant-ref="el-destination"]' else target

        with patch.object(browser, "_browser_call", side_effect=lambda fn: fn(state)), patch.object(page, "locator", locator):
            for action in ("hover", "double_click", "focus", "check", "uncheck"):
                result = browser.tool_browser_action({"action": action, "ref": "el-owned", "timeout_ms": 2000})
                self.assertEqual(result["action"], action)
            browser.tool_browser_action({"action": "select", "ref": "el-owned", "value": "option"})
            browser.tool_browser_action({"action": "drag", "ref": "el-owned", "target_ref": "el-destination"})
            browser.tool_browser_action({"action": "press", "key": "Control+a"})
            browser.tool_browser_action({"action": "press", "ref": "el-owned", "key": "Enter", "timeout_ms": 2000})
            with self.assertRaises(ValueError):
                browser.tool_browser_action({"action": "evaluate", "script": "dangerous"})
            with self.assertRaises(ValueError):
                browser.tool_browser_action({"action": "select", "ref": "el-owned"})
            with self.assertRaises(ValueError):
                browser.tool_browser_action({"action": "drag", "ref": "el-owned"})
        self.assertTrue(all(selector.startswith('[data-assistant-ref="el-') for selector in locator_queries))
        target.hover.assert_called_once_with(timeout=2000)
        target.dblclick.assert_called_once_with(button="left", timeout=2000)
        target.focus.assert_called_once_with(timeout=2000)
        target.check.assert_called_once_with(timeout=2000)
        target.uncheck.assert_called_once_with(timeout=2000)
        target.select_option.assert_called_once_with("option", timeout=10000)
        target.drag_to.assert_called_once_with(destination, timeout=10000)
        page.keyboard.press.assert_called_once_with("Control+a")
        target.press.assert_called_once_with("Enter", timeout=2000)

    def test_cancelled_or_revoked_operation_cannot_act(self):
        with browser.PROCESS_LOCK:
            browser.CANCELLED_RUNS.add("fixture-cancelled")
            browser.INTERRUPTED_OPERATIONS["fixture-revoked"] = 0
        try:
            for scope in ({"run_id": "fixture-cancelled"}, {"operation_id": "fixture-revoked"}):
                with self.subTest(scope=scope), self.assertRaisesRegex(RuntimeError, "revoked"):
                    browser._check_operation(scope)
        finally:
            with browser.PROCESS_LOCK:
                browser.CANCELLED_RUNS.discard("fixture-cancelled")
                browser.INTERRUPTED_OPERATIONS.pop("fixture-revoked", None)

    def test_inflight_revoke_or_expiry_aborts_wait_and_never_types_into_other_tab(self):
        class PlaywrightManager:
            def __enter__(self):
                return object()

            def __exit__(self, *args):
                pass

        for reason, clear in ((reason, clear) for reason in ("revoke", "expiry") for clear in (True, False)):
            with self.subTest(reason=reason, clear=clear):
                runtime = browser.BrowserRuntime(self.root / f"{reason}-{clear}")
                entered = threading.Event()
                release = threading.Event()
                errors, closed_targets, mutations = [], [], []
                operation = f"fixture-inflight-{reason}-{clear}"
                with patch.object(browser, "sync_playwright", PlaywrightManager), patch.object(browser, "ChromiumProcess", FakeProcess), patch.object(browser, "_browser_call", side_effect=runtime.call):
                    browser.RUN_SCOPE.set({"session_id": "one"})
                    state = runtime.call(lambda state: state)
                    page = runtime.call(lambda state: state.page()[1])
                    page.url = "https://fixture.invalid/form"
                    manual = state.context.new_page()
                    manual.url = "https://fixture.invalid/manual"
                    browser.RUN_SCOPE.set({"session_id": "two"})
                    sibling = runtime.call(lambda state: state.page()[1])
                    target = Mock()
                    target.first = target

                    def delayed_input(*args, **kwargs):
                        entered.set()
                        if not release.wait(3):
                            raise AssertionError("fixture was not interrupted")
                        if page.closed:
                            raise RuntimeError("fixture target closed")
                        mutations.append("late input")

                    (target.fill if clear else target.click).side_effect = delayed_input

                    def close_target(url, **kwargs):
                        self.assertEqual(kwargs["timeout"], 2)
                        self.assertEqual(url, "http://127.0.0.1:32123/json/close/" + page.target_id)
                        closed_targets.append(page.target_id)
                        page.close()
                        release.set()
                        response = Mock()
                        response.__enter__ = Mock(return_value=response)
                        response.__exit__ = Mock(return_value=None)
                        return response

                    opener = SimpleNamespace(open=close_target)

                    def action():
                        browser.RUN_SCOPE.set({"session_id": "one", "operation_id": operation})
                        try:
                            browser.tool_browser_type({"selector": "input", "text": "must-not-type", "clear": clear, "press": "Enter"})
                        except (RuntimeError, TimeoutError) as exc:
                            errors.append(str(exc))

                    with patch.object(page, "locator", return_value=target), patch.object(browser.urllib.request, "build_opener", return_value=opener), patch.object(browser, "BROWSER_CALL_TIMEOUT", 0.15 if reason == "expiry" else 130):
                        caller = threading.Thread(target=action)
                        try:
                            caller.start()
                            self.assertTrue(entered.wait(2))
                            if reason == "revoke":
                                with browser.PROCESS_LOCK:
                                    browser.INTERRUPTED_OPERATIONS[operation] = time.monotonic()
                                self.assertEqual(runtime.interrupt_operation({"operation_id": "unrelated"}), {"browser_targets_closed": 0})
                                self.assertEqual(runtime.interrupt_operation({"operation_id": operation}), {"browser_targets_closed": 1})
                            caller.join(timeout=3)
                            self.assertFalse(caller.is_alive())
                            self.assertEqual(closed_targets, [page.target_id])
                            self.assertEqual(mutations, [])
                            self.assertFalse(manual.closed)
                            self.assertFalse(sibling.closed)
                            if clear:
                                target.fill.assert_called_once_with("must-not-type", timeout=10000)
                                target.click.assert_not_called()
                            else:
                                target.fill.assert_not_called()
                            page.keyboard.type.assert_not_called()
                            page.keyboard.press.assert_not_called()
                            self.assertTrue(errors and ("revoked" if reason == "revoke" else "timed out") in errors[0])
                            saved = json.loads((runtime.root / "sessions.json").read_text())
                            self.assertEqual(saved["one"]["urls"], ["https://fixture.invalid/form"])
                            browser.RUN_SCOPE.set({"session_id": "two"})
                            self.assertIs(runtime.call(lambda state: state.page()[1]), sibling)
                        finally:
                            release.set()
                            runtime.close()
                            with browser.PROCESS_LOCK:
                                browser.INTERRUPTED_OPERATIONS.pop(operation, None)

    def test_restore_stops_after_revoke_instead_of_loading_remaining_urls(self):
        runtime = self.runtime()
        operation = "restore-revoked"
        browser.RUN_SCOPE.set({"session_id": "one", "operation_id": operation})
        try:
            with patch.object(browser, "ChromiumProcess", FakeProcess):
                state = runtime._state_for_scope({"session_id": "one"})
                _, page = state.page()

                def goto(url, **kwargs):
                    page.url = url
                    with browser.PROCESS_LOCK:
                        browser.INTERRUPTED_OPERATIONS[operation] = time.monotonic()

                with patch.object(page, "goto", goto), self.assertRaisesRegex(RuntimeError, "revoked"):
                    state.restore_urls(["https://fixture.invalid/one", "https://fixture.invalid/two"], use_current=True)
                self.assertEqual(len(state.tabs), 1)
                self.assertEqual(page.url, "https://fixture.invalid/one")
        finally:
            with browser.PROCESS_LOCK:
                browser.INTERRUPTED_OPERATIONS.pop(operation, None)

    def test_download_completion_is_bounded_and_never_cancels_manual_download(self):
        for completed in (False, True):
            with self.subTest(completed=completed), patch.object(browser, "ChromiumProcess", FakeProcess):
                runtime = self.runtime()
                state = runtime._state_for_scope({"session_id": "one"})
                _, page = state.page()
                process = runtime.processes["main"]
                manual = {"guid": "manual-guid", "frameId": "manual-frame", "state": "inProgress"}
                process.downloads["manual-guid"] = manual
                (process.download_root / "manual-guid.crdownload").write_bytes(b"private-user-download")
                download = SimpleNamespace(suggested_filename="fixture.txt", failure=Mock(side_effect=AssertionError("unbounded failure awaited")), save_as=Mock(side_effect=AssertionError("unbounded save awaited")))
                pending = Mock()
                pending.__enter__ = Mock(return_value=SimpleNamespace(value=download))
                pending.__exit__ = Mock(return_value=None)
                page.expect_download = Mock(return_value=pending)
                target = Mock()
                target.first = target

                def begin(**kwargs):
                    process.downloads["owned-guid"] = {"guid": "owned-guid", "frameId": page.target_id, "state": "completed" if completed else "inProgress"}
                    (process.download_root / ("owned-guid" if completed else "owned-guid.crdownload")).write_bytes(b"downloaded-bytes")

                target.click.side_effect = begin
                with patch.object(browser, "_browser_call", side_effect=lambda fn: fn(state)), patch.object(page, "locator", return_value=target), patch.object(browser, "_scope_cwd", return_value=self.root), patch.object(browser, "_file_metadata", side_effect=lambda path: {"path": str(path)}):
                    if completed:
                        result = browser.tool_browser_download({"selector": "a", "timeout_ms": 1000})
                        self.assertEqual(Path(result["file"]["path"]).read_bytes(), b"downloaded-bytes")
                        process.download_cdp.send.assert_has_calls([call("Browser.setDownloadBehavior", {"behavior": "allowAndName", "downloadPath": str(process.download_root), "eventsEnabled": True}), call("Browser.setDownloadBehavior", process.normal_download_behavior)])
                    else:
                        with self.assertRaisesRegex(TimeoutError, "complete before timeout"):
                            browser.tool_browser_download({"selector": "a", "timeout_ms": 1000})
                        process.download_cdp.send.assert_has_calls([call("Browser.setDownloadBehavior", {"behavior": "allowAndName", "downloadPath": str(process.download_root), "eventsEnabled": True}), call("Browser.cancelDownload", {"guid": "owned-guid"}), call("Browser.setDownloadBehavior", process.normal_download_behavior)])
                self.assertEqual(manual["state"], "inProgress")
                self.assertEqual((process.download_root / "manual-guid.crdownload").read_bytes(), b"private-user-download")
                self.assertFalse((process.download_root / "owned-guid.crdownload").exists())
                download.failure.assert_not_called()
                download.save_as.assert_not_called()

    def test_manual_url_validation_does_not_allow_host_files(self):
        with patch.object(browser, "DATA_ROOT", self.root):
            self.assertTrue(browser._restorable_url("https://fixture.invalid"))
            self.assertTrue(browser._restorable_url((self.root / "files" / "page.html").as_uri()))
            self.assertFalse(browser._restorable_url("file:///etc/passwd"))
            self.assertFalse(browser._restorable_url("file://remote-host/data/page.html"))
            self.assertFalse(browser._restorable_url("javascript:alert(1)"))
            self.assertFalse(browser._restorable_url("https://[invalid"))

    def test_runtime_shutdown_flushes_tabs_and_closes_managed_children(self):
        runtime = browser.BrowserRuntime(self.root / "profiles")
        class PlaywrightManager:
            def __enter__(self):
                return object()

            def __exit__(self, *args):
                pass

        browser.RUN_SCOPE.set({"session_id": "one"})
        with patch.object(browser, "sync_playwright", PlaywrightManager), patch.object(browser, "ChromiumProcess", FakeProcess):
            runtime.call(lambda state: state.page()[1].goto("https://fixture.invalid/persistent"))
            process = runtime.processes["main"]
            runtime.close()
            self.assertTrue(process.stopped)
            self.assertFalse(runtime._thread.is_alive())
            saved = json.loads((runtime.root / "sessions.json").read_text())
            self.assertEqual(saved["one"]["urls"], ["https://fixture.invalid/persistent"])
            with self.assertRaisesRegex(RuntimeError, "shutting down"):
                runtime.call(lambda state: self.fail("shutdown call ran"))

    def test_queued_revocation_is_checked_before_acquiring_browser_state(self):
        runtime = browser.BrowserRuntime(self.root / "profiles")
        entered = threading.Event()
        release = threading.Event()
        started_second = threading.Event()
        mutation = Mock()
        errors = []

        class PlaywrightManager:
            def __enter__(self):
                return object()

            def __exit__(self, *args):
                pass

        def first_job():
            runtime._submit(lambda: (entered.set(), release.wait(2)))

        def second_job():
            browser.RUN_SCOPE.set({"session_id": "two", "operation_id": "queued-revoked"})
            started_second.set()
            try:
                runtime.call(mutation)
            except RuntimeError as exc:
                errors.append(str(exc))

        with patch.object(browser, "sync_playwright", PlaywrightManager), patch.object(browser, "ChromiumProcess", FakeProcess):
            first = threading.Thread(target=first_job)
            second = threading.Thread(target=second_job)
            try:
                first.start()
                self.assertTrue(entered.wait(2))
                second.start()
                self.assertTrue(started_second.wait(2))
                with browser.PROCESS_LOCK:
                    browser.INTERRUPTED_OPERATIONS["queued-revoked"] = 0
                release.set()
                first.join(timeout=3)
                second.join(timeout=3)
                self.assertFalse(first.is_alive())
                self.assertFalse(second.is_alive())
                mutation.assert_not_called()
                self.assertTrue(errors and "revoked" in errors[0])
                self.assertNotIn("two", runtime.states)
            finally:
                release.set()
                runtime.close()
                with browser.PROCESS_LOCK:
                    browser.INTERRUPTED_OPERATIONS.pop("queued-revoked", None)


if __name__ == "__main__":
    unittest.main()
