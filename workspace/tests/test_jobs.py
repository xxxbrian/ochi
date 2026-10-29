"""Real local subprocess checks, confined to temporary directories."""
from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import workspace_jobs as jobs
import workspace_runtime as runtime


def python(code: str) -> str:
    return shlex.quote(sys.executable) + " -c " + shlex.quote(code)


class OwnedJobs(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.registry = jobs.JobRegistry(self.root / "jobs")
        self.scope = {"user_id": "alice", "session_id": "one", "run_id": "run-a",
                      "operation_id": "op-a", "cwd": str(self.root)}
        self.context = runtime.RUN_SCOPE.set(self.scope)
        self.data = patch.object(runtime, "DATA_ROOT", self.root)
        self.data.start()

    def tearDown(self):
        self.registry.close()
        self.data.stop()
        runtime.RUN_SCOPE.reset(self.context)
        self.temp.cleanup()

    def test_short_wait_returns_owned_job_and_incremental_unicode_logs(self):
        command = python("import time; print('first', flush=True); time.sleep(.2); print('中' * 20000)")
        initial = self.registry.execute({"command": command, "wait_ms": 0, "timeout_ms": 3000})
        self.assertEqual(initial["status"], "running")
        job_id = initial["job_id"]
        collected = initial["stdout"]
        result = self.registry.call({"action": "wait", "job_id": job_id, "wait_ms": 3000,
                                     "stdout_offset": initial["stdout_offset"]})
        collected += result["stdout"]
        while result["has_more"]:
            result = self.registry.call({"action": "status", "job_id": job_id,
                                         "stdout_offset": result["stdout_offset"], "stderr_offset": result["stderr_offset"]})
            collected += result["stdout"]
        self.assertEqual(collected, "first\n" + "中" * 20000 + "\n")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(self.registry.active()["jobs"], [])
        restored = jobs.JobRegistry(self.root / "jobs")
        self.assertEqual(restored.call({"action": "status", "job_id": job_id})["status"], "completed")

    def test_owner_follows_session_across_turns_but_never_other_user_or_session(self):
        result = self.registry.execute({"command": python("import time; time.sleep(5)"),
                                        "kind": "service", "wait_ms": 0})
        for scope in ({**self.scope, "user_id": "bob"}, {**self.scope, "session_id": "two"}):
            token = runtime.RUN_SCOPE.set(scope)
            try:
                for action in ("status", "cancel"):
                    with self.assertRaises(PermissionError):
                        self.registry.call({"action": action, "job_id": result["job_id"]})
            finally:
                runtime.RUN_SCOPE.reset(token)
        token = runtime.RUN_SCOPE.set({**self.scope, "run_id": "next-turn"})
        try:
            cancelled = self.registry.call({"action": "cancel", "job_id": result["job_id"]})
            self.assertEqual(cancelled["status"], "cancelled")
        finally:
            runtime.RUN_SCOPE.reset(token)

    def test_run_finish_removes_tasks_but_service_requires_explicit_cancel(self):
        command = python("import time; time.sleep(5)")
        task = self.registry.execute({"command": command, "wait_ms": 0})
        service = self.registry.execute({"command": command, "kind": "service", "wait_ms": 0})
        self.assertEqual(self.registry.finish(self.scope, services=False)["jobs"], 1)
        self.assertEqual(self.registry.call({"action": "status", "job_id": task["job_id"]})["status"], "cancelled")
        self.assertEqual(self.registry.call({"action": "status", "job_id": service["job_id"]})["status"], "running")
        self.assertEqual(self.registry.finish(self.scope, services=True, session=True)["jobs"], 1)
        # Revoking a previous turn does not permanently disable later authorized turns.
        token = runtime.RUN_SCOPE.set({**self.scope, "run_id": "next-turn"})
        try:
            self.assertEqual(self.registry.execute({"command": "true"})["status"], "completed")
        finally:
            runtime.RUN_SCOPE.reset(token)

    def test_shell_exit_terminates_background_children_not_only_the_shell(self):
        script = "import subprocess,sys; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); print(p.pid,flush=True)"
        result = self.registry.execute({"command": python(script)})
        self.assertEqual(result["status"], "completed")
        pid = int(result["stdout"].strip())
        state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        self.assertTrue(not state or state.startswith("Z"), f"background child still running: {state}")

    def test_session_revoke_does_not_close_a_reauthorized_run(self):
        self.registry.execute({"command": python("import time; time.sleep(5)"), "kind": "service", "wait_ms": 0})
        self.assertEqual(self.registry.finish(self.scope, services=True, session=True)["jobs"], 1)
        token = runtime.RUN_SCOPE.set({**self.scope, "operation_id": "reauthorized-operation"})
        try:
            self.assertEqual(self.registry.execute({"command": "true"})["status"], "completed")
        finally:
            runtime.RUN_SCOPE.reset(token)

    def test_timeout_and_interrupt_release_resource_claims(self):
        command = python("import time; time.sleep(5)")
        result = self.registry.execute({"command": command, "timeout_ms": 1000, "wait_ms": 3000})
        self.assertEqual(result["status"], "timed_out")
        self.assertEqual(result["exit_code"], 124)
        job = self.registry.execute({"command": command, "wait_ms": 0})
        self.assertEqual(self.registry.interrupt("op-a"), 1)
        self.assertEqual(self.registry.call({"action": "status", "job_id": job["job_id"]})["status"], "cancelled")
        self.assertFalse(self.registry.active()["jobs"])

    def test_live_jobs_and_calls_hold_desktop_claims_and_idle_clock(self):
        result = self.registry.execute({"command": python("import time; time.sleep(5)"), "wait_ms": 0})
        active = self.registry.active()
        self.assertEqual(active["jobs"][0]["resource_claims"], ["desktop", "project"])
        with self.assertRaisesRegex(RuntimeError, "another session"):
            with self.registry.desktop({**self.scope, "session_id": "two"}):
                self.fail("conflicting desktop admitted")
        with self.registry.desktop(self.scope):
            pass
        with self.registry.activity():
            self.assertEqual(self.registry.active()["active_calls"], 1)
            with self.registry.activity(False):
                self.assertEqual(self.registry.active()["active_calls"], 1)
        self.assertEqual(self.registry.active()["active_calls"], 0)
        self.registry.call({"action": "cancel", "job_id": result["job_id"]})
        with self.registry.desktop({**self.scope, "session_id": "two"}):
            with self.assertRaisesRegex(RuntimeError, "another session"):
                self.registry.start({"command": "true"}, self.scope)
        compute = self.registry.start({"command": "true"}, self.scope, compute=True)
        self.assertEqual(compute["resource_claims"], [])
        compute["done"].wait(2)

    def test_active_pool_is_bounded_and_prearrival_cancellation_prevents_spawn(self):
        with patch.object(jobs, "MAX_ACTIVE_JOBS", 1):
            self.registry.execute({"command": python("import time; time.sleep(5)"), "wait_ms": 0})
            with self.assertRaisesRegex(RuntimeError, "active job limit"):
                self.registry.execute({"command": "true"})
        self.registry.finish(self.scope, services=True)
        with patch.object(jobs.subprocess, "Popen", side_effect=AssertionError("closed run spawned")):
            with self.assertRaisesRegex(RuntimeError, "already finished"):
                self.registry.execute({"command": "true"})

    def test_live_output_does_not_consume_a_partial_utf8_character(self):
        command = python("import os,time; os.write(1,b'\\xe4'); time.sleep(.3); os.write(1,b'\\xb8\\xad')")
        result = self.registry.execute({"command": command, "wait_ms": 100})
        self.assertEqual(result["status"], "running")
        self.assertEqual(result["stdout"], "")
        self.assertEqual(result["stdout_offset"], 0)
        final = self.registry.call({"job_id": result["job_id"], "action": "wait", "wait_ms": 2000,
                                    "stdout_offset": result["stdout_offset"]})
        self.assertEqual(final["stdout"], "中")
        self.assertEqual(final["stdout_offset"], 3)

    def test_unwritable_state_never_leaks_process_or_blocks_completion(self):
        processes = []
        popen = jobs.subprocess.Popen
        def spawn(*args, **kwargs):
            process = popen(*args, **kwargs)
            processes.append(process)
            return process
        with patch.object(self.registry, "_persist", side_effect=OSError("fixture disk full")), \
             patch.object(jobs.subprocess, "Popen", side_effect=spawn):
            with self.assertRaises(OSError):
                self.registry.execute({"command": python("import time; time.sleep(5)")})
        self.assertEqual(self.registry.active()["jobs"], [])
        self.assertIsNotNone(processes[0].poll())
        job = self.registry.start({"command": python("import time; time.sleep(.2)")}, self.scope)
        with patch.object(self.registry, "_persist", side_effect=OSError("fixture disk full")), \
             patch("builtins.print"):
            self.assertTrue(job["done"].wait(2))
        self.assertEqual(job["status"], "completed")
        self.assertEqual(self.registry.active()["jobs"], [])


if __name__ == "__main__":
    unittest.main()
