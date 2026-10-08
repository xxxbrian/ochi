"""Fixture-only contracts: no Chromium, MCP client, shell or network activity."""
from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bridge
import workspace_mcp
import workspace_runtime
import workspace_skills
from workspace_schema import ToolArgumentError, strict_json, validate_arguments


class ToolContracts(unittest.TestCase):
    def test_working_files_publish_only_when_explicit_and_keep_immutable_bytes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ochi-publication-") as tmp:
            data = Path(tmp)
            files = data / "files"
            files.mkdir()
            cwd = data / "work" / "session"
            cwd.mkdir(parents=True)
            token = workspace_runtime.RUN_SCOPE.set({"run_id": "fixture-run", "session_id": "session", "cwd": str(cwd)})
            try:
                with patch.object(workspace_runtime, "DATA_ROOT", data), patch.object(workspace_runtime, "FILES_ROOT", files):
                    bridge.tool_files_write({"path": "final.txt", "content": "delivered"})
                    reference = cwd / "cloned-repo" / "README.md"
                    reference.parent.mkdir()
                    reference.write_text("research reference")
                    self.assertFalse((data / "published").exists())
                    self.assertFalse((data / "runs").exists())
                    first = workspace_runtime._publish_file("final.txt")
                    self.assertEqual(Path(first["path"]).read_text(), "delivered")
                    bridge.tool_files_write({"path": "final.txt", "content": "new source"})
                    self.assertEqual(Path(first["path"]).read_text(), "delivered")
                    self.assertEqual(len(list((data / "published").rglob("*.txt"))), 1)
                    second = workspace_runtime._publish_file("final.txt")
                    self.assertNotEqual(first["path"], second["path"])
                    self.assertEqual(Path(second["path"]).read_text(), "new source")
                    self.assertTrue(reference.is_file())
                    self.assertEqual(len(list((data / "published").rglob("README.md"))), 0)
            finally:
                workspace_runtime.RUN_SCOPE.reset(token)

    def test_scratch_transfer_still_copies_working_files_without_publication(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ochi-scratch-transfer-") as tmp:
            data = Path(tmp)
            files = data / "files"
            files.mkdir()
            first, second = data / "work" / "one", data / "work" / "two"
            token = workspace_runtime.RUN_SCOPE.set({"run_id": "fixture-run", "session_id": "session", "cwd": str(first)})
            try:
                with patch.object(workspace_runtime, "DATA_ROOT", data), patch.object(workspace_runtime, "FILES_ROOT", files):
                    bridge.tool_files_write({"path": "notes/reference.txt", "content": "private working bytes"})
                    bundle = workspace_runtime._export_scratch()
                    workspace_runtime.RUN_SCOPE.set({"run_id": "fixture-run", "session_id": "session", "cwd": str(second)})
                    result = workspace_runtime._import_scratch(bundle)
                    self.assertEqual(len(result["files"]), 1)
                    self.assertEqual((second / "notes" / "reference.txt").read_text(), "private working bytes")
                    self.assertFalse((data / "published").exists())
                    self.assertFalse((data / "runs").exists())
            finally:
                workspace_runtime.RUN_SCOPE.reset(token)

    def test_file_reads_use_current_scope_and_explicit_upload_paths(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ochi-file-scope-") as tmp:
            data = Path(tmp)
            files = data / "files"
            files.mkdir()
            (files / "notes.txt").write_text("outside this session")
            upload = files / "uploads" / "fixture.txt"
            upload.parent.mkdir()
            upload.write_text("current upload")
            cwd = data / "work" / "session"
            cwd.mkdir(parents=True)
            token = workspace_runtime.RUN_SCOPE.set({"session_id": "session", "cwd": str(cwd)})
            try:
                with patch.object(workspace_runtime, "DATA_ROOT", data), patch.object(workspace_runtime, "FILES_ROOT", files):
                    with self.assertRaises(FileNotFoundError):
                        bridge.tool_files_read({"path": "notes.txt"})
                    (cwd / "notes.txt").write_text("current session")
                    self.assertEqual(bridge.tool_files_read({"path": "notes.txt"})["content"], "current session")
                    self.assertEqual(bridge.tool_files_read({"path": str(upload)})["content"], "current upload")
            finally:
                workspace_runtime.RUN_SCOPE.reset(token)

    def test_shared_schema_fixtures(self) -> None:
        source = Path(__file__).resolve().parents[2] / "server/internal/agent/testdata/tool_schema.json"
        for case in json.loads(source.read_text()):
            with self.subTest(case=case["name"]):
                code = ""
                try:
                    try:
                        schema = strict_json(case["schema"])
                    except (ValueError, ToolArgumentError):
                        raise ToolArgumentError("invalid_schema", "$", "schema must be valid JSON") from None
                    try:
                        args = strict_json(case["arguments"])
                    except (ValueError, ToolArgumentError):
                        raise ToolArgumentError("invalid_arguments", "$", "arguments must be valid JSON") from None
                    validate_arguments({"name": "fixture", "parameters": schema}, args)
                except ToolArgumentError as exc:
                    code = exc.detail["code"]
                self.assertEqual(code, case["code"])

    def test_discovery_is_bounded_and_does_not_connect(self) -> None:
        tools = [{"name": f"search_{i}", "description": "Search website documents", "parameters": {"type": "object"},
                  "annotations": {"readOnlyHint": True}} for i in range(15)]
        tools.append({"name": "search_000_bad", "description": "Search website documents", "parameters": {"patternProperties": {}}})
        config = {"skills": {}, "mcp": {"enabled": {"name": "Documentation", "enabled": True, "tools": tools},
                  "disabled": {"enabled": False, "tools": tools}}}
        runtime = workspace_mcp.MCPRuntime()
        with patch.object(workspace_mcp, "_load_extensions", return_value=config), patch.object(runtime, "connection", side_effect=AssertionError("discovery connected")):
            result = runtime.search({"query": "website search", "limit": 6})
            self.assertEqual(len(result["tools"]), 6)
            self.assertTrue(result["truncated"])
            self.assertEqual(len(result["unsupported"]), 1)
            self.assertTrue(all("execution" not in tool for tool in result["tools"]))
            self.assertEqual(runtime.search({"query": "unrelatedword"})["tools"], [])
            name = result["tools"][0]["name"]
            config["mcp"]["enabled"]["enabled"] = False
            self.assertIsNone(runtime.definition(name))
            with self.assertRaisesRegex(ValueError, "unavailable or disabled"):
                runtime.call(name, {})

    def test_invalid_mcp_arguments_do_not_connect(self) -> None:
        config = {"mcp": {"fixture": {"enabled": True, "tools": [{"name": "send", "parameters": {
            "type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"], "additionalProperties": False}}]}}}
        runtime = workspace_mcp.MCPRuntime()
        with patch.object(workspace_mcp, "_load_extensions", return_value=config), patch.object(runtime, "connection", side_effect=AssertionError("invalid call connected")):
            with self.assertRaises(ToolArgumentError):
                runtime.call(workspace_mcp._mcp_tool_name("fixture", "send"), {"text": 7})

    def test_skills_index_has_no_body_reads(self) -> None:
        config = {"skills": {f"skill-{i:02}": {"name": f"skill-{i:02}", "description": "Usage " * 100, "path": "/does-not-exist"} for i in range(70)}}
        with patch.object(workspace_skills, "_load_extensions", return_value=config), patch.object(workspace_skills, "_skill_content", side_effect=AssertionError("index read instruction body")):
            index = workspace_skills.skills_index()
            self.assertLessEqual(len(index["skills"]), 32)
            self.assertLessEqual(len(json.dumps(index, ensure_ascii=True).encode()), 8 * 1024)
            self.assertEqual(index["total"], 70)
            self.assertTrue(index["truncated"])
            self.assertTrue(all(set(item) == {"id", "name", "description"} for item in index["skills"]))
        config = {"skills": {"one": {"name": "one", "path": "/fake", "enabled": True}}}
        with patch.object(workspace_skills, "_load_extensions", return_value=config), patch.object(workspace_skills, "_skill_content", return_value=({}, "frontmatter and body", "actual instructions")), patch.object(workspace_skills, "_skill_public", return_value={"id": "one"}):
            self.assertEqual(workspace_skills.tool_skills_read({"id": "one"})["instructions"], "actual instructions")
            config["skills"]["one"]["enabled"] = False
            with self.assertRaisesRegex(ValueError, "disabled"):
                workspace_skills.tool_skills_read({"id": "one"})

    def handler(self, path: str, raw: bytes = b"{}") -> tuple[bridge.Handler, list]:
        handler = object.__new__(bridge.Handler)
        handler.path, handler.headers, handler.rfile = path, {"Content-Length": str(len(raw))}, io.BytesIO(raw)
        outputs = []
        handler._write = lambda payload, status=200: outputs.append((payload, status))
        return handler, outputs

    def test_invalid_bridge_args_never_dispatch(self) -> None:
        for raw in (b'{"command":7}', b'{"command":"x","unexpected":1}', b'{"command":"x","command":"y"}', b'{', b'{"env":{"x":1e-999999},"command":"x"}'):
            handler, outputs = self.handler("/tools/exec", raw)
            with patch.dict(bridge.DISPATCH, {"exec": lambda _: self.fail("invalid arguments executed")}):
                handler.do_POST()
            self.assertEqual(outputs[0][1], 200)
            self.assertEqual(outputs[0][0]["error_detail"]["code"], "invalid_arguments")

    def test_bridge_discovery_opt_in_and_compute_gate(self) -> None:
        handler, outputs = self.handler("/tools")
        with patch.object(bridge.MCP, "definitions", side_effect=AssertionError("default tool listing loaded MCP schemas")):
            handler.do_GET()
        self.assertEqual(outputs[0][0], bridge.TOOLS)
        handler, outputs = self.handler("/tools?names=" + ",".join("mcp_" + str(i) for i in range(17)))
        handler.do_GET()
        self.assertEqual(outputs[0][1], 400)
        handler, outputs = self.handler("/skills/index")
        with patch.object(bridge, "COMPUTE_ONLY", True), patch.object(bridge, "skills_index", side_effect=AssertionError("compute read skills")):
            handler.do_GET()
        self.assertEqual(outputs[0][1], 403)
        basic = [tool for tool in bridge.TOOLS if tool["name"] in {"exec", "files_list", "files_read", "files_write", "web_fetch"}]
        handler, outputs = self.handler("/tools/skills_read", b'{"id":"one"}')
        with patch.object(bridge, "COMPUTE_ONLY", True), patch.object(bridge, "TOOLS", basic), patch.object(bridge.MCP, "definition", side_effect=AssertionError("compute queried MCP")):
            handler.do_POST()
        self.assertEqual(outputs[0][1], 404)


if __name__ == "__main__":
    unittest.main()
