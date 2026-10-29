"""External JSON Schema is preserved and validated using its declared dialect."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from workspace_mcp_schema import validate_mcp_arguments, validate_mcp_schema
from workspace_schema import ToolArgumentError
import workspace_mcp
import workspace_skills


class ExternalSchemas(unittest.TestCase):
    def test_standard_predicates_and_local_references_are_not_intrinsic_subset(self):
        schema = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object", "properties": {"code": {"$ref": "#/$defs/code"}},
            "$defs": {"code": {"type": "string", "pattern": "^[A-Z]{2}[0-9]+$"}},
            "patternProperties": {"^tag_": {"type": "integer"}},
            "required": ["code"], "additionalProperties": False,
        }
        original = json.dumps(schema)
        validate_mcp_schema(schema)
        validate_mcp_arguments("fixture", schema, {"code": "AB123", "tag_one": 4})
        for args in ({"code": "bad"}, {"code": "AB1", "tag_one": "bad"}, {"code": "AB1", "other": 1}):
            with self.assertRaises(ToolArgumentError):
                validate_mcp_arguments("fixture", schema, args)
        self.assertEqual(json.dumps(schema), original)

    def test_draft7_tuple_and_conditional_schema(self):
        schema = {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object", "properties": {"items": {
                "type": "array", "items": [{"type": "string"}, {"type": "integer"}],
                "additionalItems": False,
            }},
            "if": {"required": ["items"]}, "then": {"required": ["label"]},
        }
        validate_mcp_arguments("fixture", schema, {"items": ["x", 2], "label": "ok"})
        with self.assertRaises(ToolArgumentError):
            validate_mcp_arguments("fixture", schema, {"items": ["x", "bad"], "label": "ok"})
        with self.assertRaises(ToolArgumentError):
            validate_mcp_arguments("fixture", schema, {"items": ["x", 2]})

    def test_remote_reference_and_unknown_dialect_fail_without_io(self):
        for ref in ("https://example.invalid/schema", "file:///etc/passwd"):
            with self.assertRaisesRegex(ToolArgumentError, "cannot be resolved"):
                validate_mcp_arguments("fixture", {"type": "object", "$ref": ref}, {})
        with self.assertRaisesRegex(ToolArgumentError, "unknown JSON Schema"):
            validate_mcp_schema({"$schema": "https://example.invalid/custom", "type": "object"})


class CompleteCatalog(unittest.TestCase):
    def test_mcp_every_matching_tool_is_reachable_with_offsets(self):
        tools = [{"name": f"lookup_{i:03}", "description": "lookup", "parameters": {"type": "object"}} for i in range(77)]
        config = {"mcp": {"fixture": {"id": "fixture", "name": "Fixture", "tools": tools}}}
        runtime = workspace_mcp.MCPRuntime()
        names, offset = [], 0
        with patch.object(workspace_mcp, "_load_extensions", return_value=config), patch.object(workspace_mcp, "extension_allowed", return_value=True), patch.object(runtime, "connection", side_effect=AssertionError("catalog connected")):
            while offset is not None:
                result = runtime.search({"offset": offset})
                self.assertLessEqual(len(result["tools"]), 6)
                names.extend(item["name"] for item in result["tools"])
                offset = result["next_offset"]
        self.assertEqual(len(names), 77)
        self.assertEqual(len(set(names)), 77)

    def test_skill_full_catalog_search_reaches_past_prompt_preview(self):
        config = {"skills": {f"skill-{i:03}": {"name": f"Skill {i}", "description": "Useful"} for i in range(77)}}
        with patch.object(workspace_skills, "_load_extensions", return_value=config), patch.object(workspace_skills, "extension_allowed", return_value=True):
            self.assertTrue(workspace_skills.skills_index()["truncated"])
            names, offset = [], 0
            while offset is not None:
                result = workspace_skills.tool_skills_list({"offset": offset})
                names.extend(item["id"] for item in result["skills"])
                offset = result["next_offset"]
            self.assertEqual(len(set(names)), 77)
            result = workspace_skills.tool_skills_list({"query": "skill-076"})
            self.assertEqual([item["id"] for item in result["skills"]], ["skill-076"])


if __name__ == "__main__":
    unittest.main()
