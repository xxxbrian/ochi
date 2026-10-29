"""Preparation is bound to the current Skill bytes and the target runtime."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import workspace_skills as skills


class SkillPreparation(unittest.TestCase):
    def test_prepared_path_contains_local_build_outputs_and_is_target_scoped(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            source.mkdir()
            (source / "SKILL.md").write_text("---\nname: fixture\ndescription: A fixture\n---\nRun build/output.txt\n")
            skill = {"id": "fixture", "name": "fixture", "path": str(source), "revision": skills._skill_revision(source)}
            def compile_fixture(args):
                output = Path(args["cwd"]) / "build/output.txt"
                output.parent.mkdir()
                output.write_text("compiled fixture")
                return {"exit_code": 0, "stdout": "", "stderr": ""}
            with patch.object(skills, "DATA_ROOT", root / "alice"), patch.object(skills, "_runtime_revision", return_value="image-a"), patch.object(skills, "_load_extensions", return_value={"skills": {"fixture": skill}}), patch.object(skills, "extension_allowed", return_value=True):
                self.assertEqual(skills.skill_readiness(skill)["state"], "not_prepared")
                result = skills.prepare_skill(skill, {"command": "compile fixture"}, compile_fixture)
                self.assertEqual(result["readiness"]["state"], "ready")
                read = skills.tool_skills_read({"id": "fixture"})
                self.assertEqual((Path(read["path"]) / "build/output.txt").read_text(), "compiled fixture")
                with patch.object(skills, "DATA_ROOT", root / "bob"):
                    self.assertEqual(skills.skill_readiness(skill)["state"], "not_prepared")
                with patch.object(skills, "_runtime_revision", return_value="image-b"):
                    self.assertEqual(skills.skill_readiness(skill)["state"], "not_prepared")
                (source / "SKILL.md").write_text("---\nname: fixture\ndescription: Updated fixture\n---\nNew version\n")
                skill["revision"] = skills._skill_revision(source)
                self.assertEqual(skills.skill_readiness(skill)["state"], "not_prepared")
                self.assertEqual(skills.tool_skills_read({"id": "fixture"})["path"], str(source))

    def test_failure_clears_previous_ready_and_partial_outputs_never_become_active(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            source.mkdir()
            (source / "SKILL.md").write_text("fixture")
            skill = {"id": "fixture", "path": str(source), "revision": skills._skill_revision(source)}
            with patch.object(skills, "DATA_ROOT", root / "user"):
                skills.prepare_skill(skill, {"command": "ok"}, lambda _: {"exit_code": 0})
                result = skills.prepare_skill(skill, {"command": "failed"}, lambda _: {"exit_code": 1})
                self.assertEqual(result["readiness"]["state"], "not_prepared")
                self.assertEqual(result["readiness"]["path"], str(source))
                self.assertFalse((root / "user/skill-deps/fixture/.ochi-ready.json").exists())


if __name__ == "__main__":
    unittest.main()
