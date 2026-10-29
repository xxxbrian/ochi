"""Control-plane visibility and private RPC boundaries; fixtures contain no secrets."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import workspace_control as control
import workspace_extensions as extensions
from workspace_runtime import RUN_SCOPE


class ControlBoundary(unittest.TestCase):
    def test_public_catalog_never_contains_transport_or_secret_configuration(self):
        private = {
            "skills": {"skill": {"id": "skill", "name": "Skill", "source": "private-source", "path": "/opt/extensions/skills/skill"}},
            "mcp": {"one": {"id": "one", "name": "Server", "tools": [], "transport": "stdio", "command": "secret-command",
                            "args": ["private-argument"], "env": {"KEY": "env-fixture"}, "headers": {"Authorization": "header-fixture"},
                            "url": "private-url", "cwd": "private-path", "runtime_uid": 20000}},
        }
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with patch.object(extensions, "CONTROL_ONLY", True), patch.object(extensions, "CONTROL_ROOT", root / "private"), patch.object(extensions, "EXTENSIONS_CONFIG", root / "private/extensions.json"), patch.object(extensions, "EXTENSIONS_ROOT", root / "public"):
                extensions._save_extensions(private)
            catalog = (root / "public/catalog.json").read_text()
            self.assertEqual(json.loads(catalog)["mcp"]["one"], {"id": "one", "name": "Server", "tools": []})
            for secret in ("private-source", "secret-command", "private-argument", "env-fixture", "header-fixture", "private-url", "private-path"):
                self.assertNotIn(secret, catalog)
            self.assertEqual((root / "private/extensions.json").stat().st_mode & 0o777, 0o600)
            self.assertEqual((root / "private").stat().st_mode & 0o777, 0o700)
            self.assertEqual((root / "public/catalog.json").stat().st_mode & 0o777, 0o644)
        with patch.object(extensions, "CONTROL_ONLY", False):
            with self.assertRaises(PermissionError):
                extensions._save_extensions(private)

    def test_network_access_does_not_grant_control_execution_or_credentials(self):
        with patch.object(control, "CONTROL_ONLY", True), patch.object(control, "BRIDGE_TOKEN", "control-fixture"):
            for route in ("/extensions/mcp", "/tools/tool_search", "/tools/mcp_one"):
                for token in ("", "Bearer user-fixture"):
                    with self.assertRaises(PermissionError):
                        control.authorize_control("POST", route, token)
                control.authorize_control("POST", route, "Bearer control-fixture")
            for route in ("/tools/exec", "/file", "/files", "/workspace/export", "/workspace/init", "/runs/cancel"):
                with self.assertRaises(PermissionError):
                    control.authorize_control("POST", route, "Bearer control-fixture")
            for route in ("/health", "/tools", "/skills/index"):
                control.authorize_control("GET", route, "")
        with patch.object(control, "CONTROL_ONLY", False), patch.object(control, "BRIDGE_TOKEN", "user-fixture"):
            with self.assertRaises(PermissionError):
                control.authorize_control("POST", "/tools/exec", "Bearer other-user")
            control.authorize_control("POST", "/tools/exec", "Bearer user-fixture")

    def test_stdio_environment_is_scoped_not_inherited(self):
        with tempfile.TemporaryDirectory() as temp:
            scope = RUN_SCOPE.set({"user_id": "alice", "session_id": "one"})
            try:
                with patch.object(control, "CONTROL_ONLY", True), patch.object(control, "MCP_ROOT", Path(temp)), patch.object(control.os, "getuid", return_value=0), patch.object(control.os, "chown"), patch.dict(os.environ, {"OCHI_BRIDGE_TOKEN": "control-token", "OTHER_TOKEN": "global-token", "DISPLAY": ":99"}):
                    command, argv, env, cwd = control.stdio_runtime({"id": "one", "runtime_uid": 20001, "command": "node", "args": ["server.js"], "env": {"KEY": "component-token"}})
                self.assertEqual(command, "/usr/bin/setpriv")
                self.assertIn("--no-new-privs", argv)
                self.assertEqual(env["KEY"], "component-token")
                self.assertFalse({"OCHI_BRIDGE_TOKEN", "OTHER_TOKEN", "DISPLAY", "DBUS_SESSION_BUS_ADDRESS"} & env.keys())
                self.assertEqual(env["HOME"], cwd)
                self.assertEqual(Path(cwd).stat().st_mode & 0o777, 0o700)
            finally:
                RUN_SCOPE.reset(scope)

    @unittest.skipUnless(sys.platform == "linux" and os.getuid() == 0, "runs in the disposable Linux control-runtime check")
    def test_real_stdio_uid_cannot_read_control_or_other_component(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            root.chmod(0o755)
            secret = root / "control.json"
            secret.write_text("fixture-control-value")
            secret.chmod(0o600)
            other = root / "other-component"
            other.mkdir(mode=0o700)
            os.chown(other, 20002, 20002)
            (other / "credential").write_text("fixture-other-value")
            with patch.object(control, "CONTROL_ONLY", True), patch.object(control, "MCP_ROOT", root / "runtimes"):
                (root / "runtimes").mkdir(mode=0o755)
                config = {"id": "one", "runtime_uid": 20001, "command": "/usr/bin/python3", "args": ["-c", "import pathlib,sys; [pathlib.Path(p).read_text() for p in sys.argv[1:]]"]}
                command, argv, env, cwd = control.stdio_runtime(config)
                for path in (secret, other / "credential"):
                    result = subprocess.run([command, *argv, str(path)], env=env, cwd=cwd, capture_output=True, timeout=5)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(b"PermissionError", result.stderr)
                    self.assertNotIn(b"fixture-", result.stdout)

    @unittest.skipUnless(sys.platform == "linux" and os.getuid() == 0, "runs in the disposable Linux control-runtime check")
    def test_official_sdk_stdio_handshake_runs_with_component_identity(self):
        import workspace_mcp
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            root.chmod(0o755)
            fixture = root / "server.py"
            fixture.write_text('''import asyncio, json, os
from mcp import types
from mcp.server import Server
from mcp.server.stdio import stdio_server
async def tools(context, params):
    return types.ListToolsResult(tools=[types.Tool(name="identity", inputSchema={"type":"object","properties":{}})])
async def call(context, params):
    value = {"uid": os.getuid(), "component_env": os.environ.get("FIXTURE_KEY") == "synthetic",
             "control_env": "OCHI_BRIDGE_TOKEN" in os.environ}
    return types.CallToolResult(content=[types.TextContent(type="text", text=json.dumps(value))])
async def main():
    server = Server("fixture", on_list_tools=tools, on_call_tool=call)
    async with stdio_server() as streams:
        await server.run(*streams, server.create_initialization_options())
asyncio.run(main())
''')
            with patch.object(control, "CONTROL_ONLY", True), patch.object(control, "MCP_ROOT", root / "runtimes"), patch.object(workspace_mcp, "CONTROL_ONLY", True):
                (root / "runtimes").mkdir(mode=0o755)
                connection = workspace_mcp.MCPConnection({
                    "id": "fixture", "runtime_uid": 20001, "transport": "stdio",
                    "command": sys.executable, "args": [str(fixture)], "env": {"FIXTURE_KEY": "synthetic"},
                })
                try:
                    connection.wait_ready()
                    self.assertEqual([tool["name"] for tool in connection.tools], ["identity"])
                    result = json.loads(connection.call("identity", {})["text"])
                    self.assertEqual(result, {"uid": 20001, "component_env": True, "control_env": False})
                finally:
                    connection.close()
                    connection.thread.join(timeout=10)
                    self.assertFalse(connection.thread.is_alive())


if __name__ == "__main__":
    unittest.main()
