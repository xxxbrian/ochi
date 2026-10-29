"""The private HTTP lifecycle contract uses the same live job authority."""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bridge
import workspace_control
import workspace_jobs
import workspace_runtime


class JobHTTP(unittest.TestCase):
    def test_lifecycle_activity_scope_and_completion_over_real_http(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            jobs = workspace_jobs.JobRegistry(root / "jobs")
            scope = {"user_id": "fixture", "session_id": "conversation", "run_id": "turn", "cwd": str(root)}
            class QuietHandler(bridge.Handler):
                def log_message(self, *args):
                    pass
            with patch.object(bridge, "JOBS", jobs), patch.object(workspace_jobs, "JOBS", jobs), \
                 patch.object(workspace_runtime, "DATA_ROOT", root), \
                 patch.object(workspace_control, "BRIDGE_TOKEN", "fixture-private-token"):
                server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()
                def request(path, value, token="fixture-private-token"):
                    req = urllib.request.Request(f"http://127.0.0.1:{server.server_port}" + path,
                        data=json.dumps(value).encode(), headers={"Content-Type": "application/json",
                        "Authorization": "Bearer " + token, "X-Run-Scope": json.dumps(scope)})
                    try:
                        with urllib.request.urlopen(req, timeout=5) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as exc:
                        with exc:
                            return exc.code, json.loads(exc.read())
                try:
                    self.assertEqual(request("/jobs/active", {}, "wrong")[0], 403)
                    state = request("/jobs/active", {})[1]["result"]
                    self.assertEqual(state["jobs"], [])
                    self.assertEqual(state["active_calls"], 0)
                    self.assertGreaterEqual(state["idle_seconds"], 0)
                    result = request("/tools/exec", {"command": "sleep 5", "wait_ms": 0})[1]["result"]
                    self.assertEqual(result["status"], "running")
                    active = request("/jobs/active", {})[1]["result"]["jobs"]
                    self.assertEqual(active[0]["job_id"], result["job_id"])
                    self.assertEqual(active[0]["user_id"], "fixture")
                    finished = request("/runs/finish", {"cancel_services": False})[1]
                    self.assertTrue(finished["ok"])
                    self.assertEqual(finished["result"]["jobs"], 1)
                    scope["run_id"] = "next-turn"
                    # DISPATCH's callable is replaced for this isolated registry.
                    with patch.dict(bridge.DISPATCH, {"job": jobs.call}):
                        status = request("/tools/job", {"action": "status", "job_id": result["job_id"]})[1]["result"]
                    self.assertEqual(status["status"], "cancelled")
                    self.assertEqual(request("/jobs/active", {})[1]["result"]["jobs"], [])
                finally:
                    jobs.close()
                    server.shutdown()
                    server.server_close()
                    worker.join(2)


if __name__ == "__main__":
    unittest.main()
