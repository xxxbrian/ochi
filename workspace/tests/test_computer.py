"""Desktop contracts with fake X/AT-SPI surfaces; never operate the host UI."""
from __future__ import annotations

import io
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bridge
import workspace_a11y as a11y
import workspace_computer as computer
import workspace_runtime as runtime
import workspace_browser as browser
from workspace_schema import ToolArgumentError, validate_arguments, validate_schema


class Node:
    def __init__(self, role="entry", name="Search", path="/entry/1", children=(), text=""):
        self.role, self.name, self.path, self.children = role, name, path, list(children)
        self.app = types.SimpleNamespace(bus_name=":1.12")
        self.flags = {"SHOWING", "ENABLED", "FOCUSABLE"}
        if role in {"entry", "password text"}:
            self.flags.add("EDITABLE")
        self.text, self.caretOffset = text, len(text)
        self.calls = []

    @property
    def childCount(self):
        return len(self.children)

    @property
    def characterCount(self):
        return len(self.text)

    def getChildAtIndex(self, index):
        return self.children[index]

    def getRoleName(self):
        return self.role

    def getState(self):
        return types.SimpleNamespace(contains=lambda flag: flag in self.flags)

    def queryComponent(self):
        return self

    def getExtents(self, _):
        return types.SimpleNamespace(x=20, y=30, width=100, height=60)

    def grabFocus(self):
        self.calls.append("focus")
        return True

    def queryAction(self):
        raise NotImplementedError

    def queryText(self):
        return self

    def getText(self, start, end):
        return self.text[start:end]

    def queryEditableText(self):
        return self

    def setTextContents(self, text):
        self.calls.append(("fill", text))
        self.text = text
        return True

    def insertText(self, offset, text, length):
        self.calls.append(("insert", text))
        inserted = text.encode("utf-8")[:length].decode("utf-8")
        self.text = self.text[:offset] + inserted + self.text[offset:]
        return True

    def setCaretOffset(self, offset):
        self.caretOffset = offset
        return True


def fake_api(children):
    desktop = Node("desktop", "", "/desktop", [Node("application", "Editor", "/app", children)])
    flags = {"STATE_" + name: name for name in ("SHOWING", "ENABLED", "FOCUSABLE", "FOCUSED", "ACTIVE", "EDITABLE", "DEFUNCT")}
    return types.SimpleNamespace(Registry=types.SimpleNamespace(getDesktop=lambda _: desktop),
                                 DESKTOP_COORDS=0, **flags), desktop


class ComputerContracts(unittest.TestCase):
    def setUp(self):
        self.scope = runtime.RUN_SCOPE.set({"session_id": "one", "cwd": "/data/work/one"})
        computer.SNAPSHOTS.clear()
        computer.DESKTOP_CLOSING.clear()

    def tearDown(self):
        runtime.RUN_SCOPE.reset(self.scope)
        computer.SNAPSHOTS.clear()
        computer.DESKTOP_CLOSING.clear()
        runtime.CANCELLED_RUNS.discard("computer-test")
        runtime.INTERRUPTED_OPERATIONS.pop("desktop-test", None)

    def test_catalog_is_synchronized_strict_and_compatible(self):
        root = Path(__file__).resolve().parents[2]
        self.assertEqual((root / "workspace/tools.json").read_bytes(), (root / "server/internal/workspace/tools.json").read_bytes())
        tools = {tool["name"]: tool for tool in json.loads((root / "workspace/tools.json").read_text())}
        for name, tool in tools.items():
            validate_schema(tool["parameters"])
            if name.startswith("computer_"):
                self.assertIn(name, bridge.DISPATCH)
                self.assertFalse(tool["execution"]["parallel_safe"])
        valid = [("computer_click", {"x": 1279, "y": 799, "button": 3}),
                 ("computer_click", {"ref": "d000000000000:1", "click_count": 2}),
                 ("computer_type", {"text": "Hello"}), ("computer_key", {"key": "CTRL+L"}),
                 ("computer_scroll", {"clicks": -4})]
        for name, args in valid:
            validate_arguments(tools[name], args)
        for args in ({"x": 1280, "y": 0}, {"x": True, "y": 0}, {"x": 0}, {"ref": "d0:1", "x": 0, "y": 0}):
            with self.assertRaises(ToolArgumentError):
                validate_arguments(tools["computer_click"], args)

    def test_compute_only_cannot_dispatch_any_computer_tool(self):
        with patch.object(computer, "COMPUTE_ONLY", True), patch.object(computer, "_command", side_effect=AssertionError("ran UI")):
            for name, function in bridge.DISPATCH.items():
                if name.startswith("computer_"):
                    with self.subTest(tool=name), self.assertRaisesRegex(ValueError, "permission"):
                        function({})

    def test_refs_fail_closed_for_expiry_other_scope_and_ui_mutation(self):
        item = {"role": "entry", "name": "Search", "locator": {"identity": {"bus": ":1.2", "path": "/one"}}}
        ref = computer._store_refs([item])[0]["ref"]
        self.assertEqual(computer._locator(ref), item["locator"])
        token = runtime.RUN_SCOPE.set({"session_id": "two"})
        with self.assertRaisesRegex(ValueError, "another session"):
            computer._locator(ref)
        runtime.RUN_SCOPE.reset(token)
        with patch.object(computer.time, "monotonic", return_value=computer.SNAPSHOTS[ref[1:13]][0] + 181):
            with self.assertRaisesRegex(ValueError, "expired"):
                computer._locator(ref)
        with patch.object(computer, "_guard"), patch.object(computer, "_checked") as command:
            computer.tool_computer_click({"x": 20, "y": 30, "button": 3, "click_count": 2})
            self.assertEqual(command.call_args_list[1].args[0][-1], "3")
            self.assertIn("2", command.call_args_list[1].args[0])
        with self.assertRaisesRegex(ValueError, "expired"):
            computer._locator(ref)

    def test_desktop_refs_require_explicit_session_scope(self):
        token = runtime.RUN_SCOPE.set({})
        try:
            with self.assertRaisesRegex(ValueError, "session scope"):
                computer._store_refs([])
            self.assertFalse(computer.SNAPSHOTS)
        finally:
            runtime.RUN_SCOPE.reset(token)

    def test_real_accessible_identity_not_index_guesses_and_text_editing(self):
        entry = Node(text="old")
        api, desktop = fake_api([entry])
        snapshot = a11y.handle({"action": "snapshot", "max_nodes": 10, "max_depth": 6, "max_chars": 4000}, api)
        item = next(row for row in snapshot["elements"] if row["role"] == "entry")
        locator = item["locator"]
        self.assertEqual(entry.calls, [])
        self.assertTrue(a11y.handle({"action": "fill", "locator": locator, "text": "Ochi"}, api)["acted"])
        self.assertTrue(a11y.handle({"action": "type", "locator": locator, "text": "!"}, api)["acted"])
        self.assertEqual(entry.text, "Ochi!")
        self.assertTrue(a11y.handle({"action": "type", "locator": locator, "text": " 中文 \U0001f600"}, api)["acted"])
        self.assertEqual(entry.text, "Ochi! 中文 \U0001f600")
        # Same index, role and name do not authorize a replacement UI object.
        desktop.children[0].children[0] = Node(path="/entry/2")
        with self.assertRaisesRegex(ValueError, "changed"):
            a11y.handle({"action": "click", "locator": locator}, api)

    def test_snapshot_bounded_protected_text_and_explicit_coordinate_fallback(self):
        protected = Node("password text", "Password", text="do not reveal")
        api, _ = fake_api([protected, Node("push button", "Copy", path="/copy")])
        snapshot = a11y.handle({"action": "snapshot", "max_nodes": 4, "max_depth": 6, "max_chars": 4000}, api)
        self.assertNotIn("do not reveal", json.dumps(snapshot))
        item = next(row for row in snapshot["elements"] if row["name"] == "Copy")
        result = a11y.handle({"action": "click", "locator": item["locator"]}, api)
        self.assertEqual(result, {"acted": False, "fallback": {"x": 70, "y": 60}})
        limited = a11y.handle({"action": "snapshot", "max_nodes": 1, "max_depth": 6, "max_chars": 1000}, api)
        self.assertEqual(len(limited["elements"]), 1)
        self.assertTrue(limited["truncated"])

    def test_snapshot_foreground_window_precedes_large_older_apps_without_reindexing(self):
        def background(path):
            return Node("frame", path, path, [Node("push button", str(i), f"{path}/{i}") for i in range(100)])

        entry = Node("entry", "Foreground document", "/active/editor", text="original")
        foreground = Node("frame", "Active browser", "/active", [entry])
        foreground.flags.add("ACTIVE")
        app = Node("application", "Browser", "/browser", [background("/older-browser-window"), foreground])
        api, desktop = fake_api([])
        desktop.children = [Node("application", f"Office {i}", f"/office/{i}", [background(f"/office/{i}/window")]) for i in range(3)] + [app]
        snapshot = a11y.handle({"action": "snapshot", "max_nodes": 6, "max_depth": 6, "max_chars": 4000}, api)
        self.assertEqual(snapshot["elements"][0]["name"], "Browser")
        item = next(row for row in snapshot["elements"] if row["name"] == entry.name)
        self.assertEqual(item["locator"]["indices"], [3, 1, 0])
        self.assertEqual(item["locator"]["ancestors"], [a11y._identity(app), a11y._identity(foreground)])
        self.assertIs(a11y._resolve(api, item["locator"]), entry)
        self.assertEqual(entry.calls, [])
        self.assertTrue(a11y.handle({"action": "fill", "locator": item["locator"], "text": "updated"}, api)["acted"])
        self.assertEqual(entry.text, "updated")
        self.assertEqual(len(snapshot["elements"]), 6)
        self.assertTrue(snapshot["truncated"])

    def test_snapshot_focused_window_priority_preserves_background_observation(self):
        background = Node("frame", "Background", "/background", [Node("entry", "Background editor", "/background/editor")])
        focused = Node("frame", "Focused window", "/focused", [Node("entry", "Focused editor", "/focused/editor")])
        focused.flags.add("FOCUSED")
        api, _ = fake_api([background, focused])
        snapshot = a11y.handle({"action": "snapshot", "max_nodes": 20, "max_depth": 6, "max_chars": 4000}, api)
        names = [row["name"] for row in snapshot["elements"]]
        self.assertLess(names.index("Focused editor"), names.index("Background"))
        self.assertIn("Background editor", names)
        item = next(row for row in snapshot["elements"] if row["name"] == "Focused editor")
        self.assertEqual(item["locator"]["indices"], [0, 1, 0])
        self.assertFalse(snapshot["truncated"])

    def test_unicode_paste_stays_scoped_and_drag_releases_on_interrupt(self):
        with patch.object(computer, "_guard"), patch.object(computer, "_checked") as command, patch.object(computer, "_paste") as paste:
            computer.tool_computer_type({"text": "Ochi 中文", "clear": True})
            paste.assert_called_once_with("Ochi 中文")
            self.assertEqual(command.call_args.args[0][-2:], ["ctrl+a", "BackSpace"])
            with self.assertRaisesRegex(ValueError, "30 seconds"):
                computer.tool_computer_type({"text": "long" * 1000, "delay_ms": 200})
        with patch.object(computer, "_guard"), patch.object(computer, "_checked"), patch.object(computer, "_sleep", side_effect=RuntimeError("interrupted")), patch.object(computer.subprocess, "run") as release:
            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                computer.tool_computer_drag({"x": 10, "y": 20, "to_x": 70, "to_y": 80, "button": 2})
            self.assertEqual(release.call_args.args[0], ["xdotool", "mouseup", "2"])

    def test_cancelled_desktop_command_never_spawns_a_process(self):
        token = runtime.RUN_SCOPE.set({"run_id": "computer-test", "operation_id": "desktop-test"})
        try:
            runtime.CANCELLED_RUNS.add("computer-test")
            with patch.object(computer.subprocess, "Popen", side_effect=AssertionError("spawned")):
                with self.assertRaisesRegex(RuntimeError, "cancelled"):
                    computer._command(["xdotool", "click", "1"])
            runtime.CANCELLED_RUNS.discard("computer-test")
            runtime.INTERRUPTED_OPERATIONS["desktop-test"] = 1
            with patch.object(computer.subprocess, "Popen", side_effect=AssertionError("spawned")):
                with self.assertRaisesRegex(RuntimeError, "interrupted"):
                    computer._command(["xdotool", "click", "1"])
        finally:
            runtime.RUN_SCOPE.reset(token)

    def test_shutdown_stops_only_owned_children_and_prevents_new_actions(self):
        process = Mock()
        process.pid, process.poll.return_value = 101, None
        computer.LAUNCHED_APPS[101] = process
        with patch.object(computer.os, "killpg") as terminate:
            computer.close_computer()
            terminate.assert_called_once_with(101, computer.signal.SIGTERM)
        self.assertFalse(computer.LAUNCHED_APPS)
        with patch.object(computer.subprocess, "Popen", side_effect=AssertionError("spawned during shutdown")):
            with self.assertRaisesRegex(RuntimeError, "shutting down"):
                computer._command(["xdotool", "click", "1"])

    def test_desktop_entry_launch_expands_argv_not_shell_and_honors_overrides(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            preferred, system = root / "preferred", root / "system"
            preferred.mkdir()
            system.mkdir()
            (preferred / "editor.desktop").write_text("[Desktop Entry]\nType=Application\nName=My Editor\nExec=mousepad %F\n")
            (system / "editor.desktop").write_text("[Desktop Entry]\nType=Application\nName=Ignored\nExec=wrong\n")
            (preferred / "hidden.desktop").write_text("[Desktop Entry]\nType=Application\nHidden=true\nName=Hidden\nExec=mousepad\n")
            file = root / "note $(never-execute).txt"
            file.write_text("Hello")
            with patch.object(computer, "APP_DIRS", (preferred, system)), patch.object(computer.shutil, "which", return_value="/usr/bin/mousepad"):
                apps = computer._desktop_entries()
                self.assertEqual(list(apps), ["editor.desktop"])
                argv = computer._app_argv(apps["editor.desktop"], [file])
                self.assertEqual(argv, ["/usr/bin/mousepad", str(file)])
            malicious = {**apps["editor.desktop"], "argv": ["sh", "-c", "tool %f"]}
            with self.assertRaisesRegex(ValueError, "embedded"):
                computer._app_argv(malicious, [file])
            with patch.object(computer, "_scope_cwd", return_value=root):
                shortcut = {**apps["editor.desktop"], "app_id": "ochi-terminal.desktop"}
                self.assertEqual(computer._app_argv(shortcut, []), ["/usr/bin/mousepad", "--working-directory=" + str(root)])

    def test_xfce_browser_helper_uses_scoped_owned_browser_not_manual_launcher(self):
        entry = {"app_id": "xfce4-web-browser.desktop", "name": "Web Browser", "icon": "web-browser",
                 "executable": "/usr/bin/exo-open", "argv": ["exo-open", "--launch", "WebBrowser", "%u"],
                 "desktop_file": "/usr/share/applications/xfce4-web-browser.desktop", "terminal": False}
        observed_scopes = []
        token = runtime.RUN_SCOPE.set({"session_id": "project-chat", "project_id": "project-one", "cwd": "/data/projects/project-one"})
        try:
            with patch.object(computer, "_guard"), patch.object(computer, "_desktop_entries", return_value={entry["app_id"]: entry}), patch.object(computer.subprocess, "Popen", side_effect=AssertionError("launched unowned helper")), patch.object(browser.BROWSER, "open_manual", side_effect=AssertionError("opened manual profile")):
                def navigate(args):
                    observed_scopes.append(dict(runtime.RUN_SCOPE.get()))
                    return {"tab_id": "owned-tab", "automation": {"needs_user": False}}

                with patch.object(browser, "tool_browser_goto", side_effect=navigate) as goto:
                    self.assertTrue(computer.tool_computer_apps({"action": "launch", "app_id": entry["app_id"]})["launched"])
                    goto.assert_called_once_with({"url": "about:blank", "new_tab": True})
                    self.assertEqual(observed_scopes[0]["project_id"], "project-one")
                    self.assertEqual(observed_scopes[0]["session_id"], "project-chat")
                with patch.object(browser, "tool_browser_goto", return_value={"blocked": True, "needs_user": True, "automation": {"reason": "human_verification"}}):
                    result = computer.tool_computer_apps({"action": "launch", "app_id": entry["app_id"]})
                    self.assertFalse(result["launched"])
                    self.assertTrue(result["needs_user"])
                entry["argv"] = ["exo-open", "--launch", "FileManager", "%u"]
                with patch.object(browser, "tool_browser_goto", side_effect=AssertionError("hijacked non-browser app")), patch.object(computer, "_managed_process", side_effect=AssertionError("ordinary helper")):
                    with self.assertRaisesRegex(AssertionError, "ordinary helper"):
                        computer.tool_computer_apps({"action": "launch", "app_id": entry["app_id"]})
        finally:
            runtime.RUN_SCOPE.reset(token)

    def test_desktop_activation_is_not_browser_provisioning(self):
        handler = object.__new__(bridge.Handler)
        handler.path, handler.headers, handler.rfile = "/desktop/activate", {"Content-Length": "2"}, io.BytesIO(b"{}")
        outputs = []
        handler._write = lambda value, status=200: outputs.append((value, status))
        with patch.object(bridge, "COMPUTE_ONLY", False), patch.object(bridge.BROWSER, "activate_current", return_value={"activated": False}) as activate, patch.object(bridge, "_browser_call", side_effect=AssertionError("created browser")):
            handler.do_POST()
            activate.assert_called_once()
            self.assertEqual(outputs[0][0], {"activated": False})

    def test_bridge_interrupt_marks_scope_before_aborting_owned_browser_target(self):
        for route, marker in (("/runs/interrupt", "_interrupt_operation"), ("/runs/cancel", "_cancel_run")):
            handler = object.__new__(bridge.Handler)
            handler.path, handler.headers, handler.rfile = route, {"Content-Length": "2", "X-Run-Scope": json.dumps({"session_id": "one"})}, io.BytesIO(b"{}")
            outputs, sequence = [], []
            handler._write = lambda value, status=200: outputs.append((value, status))

            def mark():
                sequence.append("marker")
                return {"interrupted": True}

            def abort(scope):
                self.assertEqual(scope["session_id"], "one")
                sequence.append("browser")
                return {"browser_targets_closed": 1}

            with patch.object(bridge, "COMPUTE_ONLY", False), patch.object(bridge, marker, side_effect=mark), patch.object(bridge.BROWSER, "interrupt_operation", side_effect=abort):
                handler.do_POST()
                self.assertEqual(sequence, ["marker", "browser"])
                self.assertEqual(outputs[0][0], {"interrupted": True, "browser_targets_closed": 1})
            handler.rfile = io.BytesIO(b"{}")
            outputs.clear()
            with patch.object(bridge, "COMPUTE_ONLY", True), patch.object(bridge, marker, return_value={"interrupted": True}), patch.object(bridge.BROWSER, "interrupt_operation", side_effect=AssertionError("computed browser access")):
                handler.do_POST()
                self.assertEqual(outputs[0][0], {"interrupted": True})


if __name__ == "__main__":
    unittest.main()
