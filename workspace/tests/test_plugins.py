"""Plugin policy contracts; no external services or extension processes."""
from __future__ import annotations

import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bridge
import workspace_mcp
import workspace_skills
from workspace_plugins import EXTENSION_ACCESS, extension_allowed, set_extension_access
from workspace_runtime import RUN_SCOPE


class PluginPolicyContracts(unittest.TestCase):
    def setUp(self) -> None:
        self.scope = RUN_SCOPE.set({"user_id": "alice", "run_id": "run-a", "session_id": "chat-a"})
        self.policy = EXTENSION_ACCESS.set(None)

    def tearDown(self) -> None:
        EXTENSION_ACCESS.reset(self.policy)
        RUN_SCOPE.reset(self.scope)

    def allow(self, skills: list[str] | None = None, mcp: list[str] | None = None) -> None:
        set_extension_access(json.dumps({"skills": skills or [], "mcp": mcp or []}))

    def test_missing_invalid_and_empty_policy_fail_closed(self) -> None:
        self.assertFalse(extension_allowed("skills", "one"))
        self.allow(["one"])
        self.assertTrue(extension_allowed("skills", "one"))
        for raw in ('{}', '{', '{"skills":["../bad"],"mcp":[]}', '{"skills":null,"mcp":[]}'):
            with self.assertRaises(ValueError):
                set_extension_access(raw)
            self.assertFalse(extension_allowed("skills", "one"))
        set_extension_access(None)
        self.assertFalse(extension_allowed("skills", "one"))
        RUN_SCOPE.set({})
        self.assertTrue(extension_allowed("skills", "one"))

    def test_skill_policy_applies_before_budget_and_body_read(self) -> None:
        skills = {f"a-disabled-{i:02}": {"name": "Hidden", "description": "x"} for i in range(40)}
        skills["z-visible"] = {"id": "z-visible", "name": "Visible", "description": "Useful", "path": "/fake"}
        self.allow(["z-visible"])
        with patch.object(workspace_skills, "_load_extensions", return_value={"skills": skills}), patch.object(workspace_skills, "_skill_content", return_value=({}, "body", "instructions")) as body, patch.object(workspace_skills, "_skill_public", return_value={"id": "z-visible"}):
            index = workspace_skills.skills_index()
            self.assertEqual(index["total"], 1)
            self.assertFalse(index["truncated"])
            self.assertEqual([item["id"] for item in index["skills"]], ["z-visible"])
            body.assert_not_called()
            self.assertEqual(workspace_skills.tool_skills_read({"id": "z-visible"})["instructions"], "instructions")
            self.allow([])
            body.reset_mock()
            with self.assertRaisesRegex(ValueError, "disabled"):
                workspace_skills.tool_skills_read({"id": "z-visible"})
            body.assert_not_called()
            self.assertEqual(workspace_skills.skills_index()["skills"], [])

    def test_mcp_discovery_and_known_tool_dispatch_recheck_user_policy(self) -> None:
        tool = {"name": "search", "description": "Find documents", "parameters": {"type": "object"}}
        config = {"mcp": {
            "alice": {"id": "alice", "name": "Alice search", "enabled": True, "tools": [tool]},
            "bob": {"id": "bob", "name": "Bob search", "enabled": True, "tools": [tool]},
        }}
        runtime = workspace_mcp.MCPRuntime()
        alice_tool = workspace_mcp._mcp_tool_name("alice", "search")
        bob_tool = workspace_mcp._mcp_tool_name("bob", "search")
        with patch.object(workspace_mcp, "_load_extensions", return_value=config), patch.object(runtime, "connection") as connection:
            self.allow(mcp=["alice"])
            self.assertEqual([item["name"] for item in runtime.search({"query": "search"})["tools"]], [alice_tool])
            self.assertEqual([item["name"] for item in runtime.definitions()], [alice_tool])
            self.assertIsNone(runtime.definition(bob_tool))
            with self.assertRaisesRegex(ValueError, "disabled"):
                runtime.call(bob_tool, {})
            connection.assert_not_called()
            # Same process and same known tool name, new request/user policy.
            self.allow(mcp=["bob"])
            self.assertIsNone(runtime.definition(alice_tool))
            with self.assertRaisesRegex(ValueError, "disabled"):
                runtime.call(alice_tool, {})
            connection.assert_not_called()
            RUN_SCOPE.set({})
            connection.return_value.call.return_value = {"ok": True}
            self.assertEqual(runtime.call(bob_tool, {}), {"ok": True})
            connection.assert_called_once()
            config["mcp"]["bob"]["enabled"] = False
            with self.assertRaisesRegex(ValueError, "disabled"):
                runtime.call(bob_tool, {})
            self.assertEqual(connection.call_count, 1)

    def test_request_policy_does_not_leak_and_invalid_header_does_not_dispatch(self) -> None:
        handler = object.__new__(bridge.Handler)
        handler.path = "/skills/index"
        handler.headers = {"X-Run-Scope": json.dumps(RUN_SCOPE.get()), "X-Ochi-Extensions": '{"skills":["one"],"mcp":[]}'}
        handler._route()
        self.assertTrue(extension_allowed("skills", "one"))
        del handler.headers["X-Ochi-Extensions"]
        handler._route()
        self.assertFalse(extension_allowed("skills", "one"))
        handler.headers["X-Ochi-Extensions"] = '{"skills":[42],"mcp":[]}'
        outputs = []
        handler._write = lambda payload, status=200: outputs.append((payload, status))
        with patch.object(bridge, "skills_index", side_effect=AssertionError("invalid policy dispatched")):
            handler.do_GET()
        self.assertEqual(outputs[0][1], 400)


if __name__ == "__main__":
    unittest.main()
