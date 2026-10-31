"""Scoped byte transfers preserve existing files and report actual writes."""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import threading
import unittest
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bridge
import workspace_control
import workspace_jobs
import workspace_runtime


class FileHTTP(unittest.TestCase):
    def test_conditional_put_reports_written_bytes_without_overwriting_local_edits(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            jobs = workspace_jobs.JobRegistry(root / "jobs")
            scope = {"user_id": "fixture", "session_id": "conversation", "run_id": "turn", "cwd": str(root)}

            class QuietHandler(bridge.Handler):
                def log_message(self, *args):
                    pass

            with patch.object(bridge, "JOBS", jobs), patch.object(workspace_runtime, "DATA_ROOT", root), \
                 patch.object(workspace_control, "BRIDGE_TOKEN", "fixture-private-token"):
                server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()

                def put(value, **condition):
                    query = urllib.parse.urlencode({"path": "selected.txt", **condition})
                    req = urllib.request.Request(
                        f"http://127.0.0.1:{server.server_port}/file?{query}", method="PUT", data=value,
                        headers={"Authorization": "Bearer fixture-private-token", "X-Run-Scope": json.dumps(scope)})
                    with urllib.request.urlopen(req, timeout=5) as response:
                        return json.loads(response.read())

                try:
                    self.assertTrue(put(b"original", if_missing="1")["written"])
                    self.assertFalse(put(b"replacement", if_missing="1")["written"])
                    self.assertEqual((root / "selected.txt").read_bytes(), b"original")
                    digest = hashlib.sha256(b"original").hexdigest()[:20]
                    self.assertFalse(put(b"original", if_digest=digest)["written"])
                    conflict = put(b"replacement", if_digest="absent")
                    self.assertTrue(conflict["source_conflict"])
                    self.assertFalse(conflict["written"])
                    self.assertEqual((root / "selected.txt").read_bytes(), b"original")
                    self.assertTrue(put(b"replacement", if_digest=digest)["written"])
                    self.assertEqual((root / "selected.txt").read_bytes(), b"replacement")
                finally:
                    jobs.close()
                    server.shutdown()
                    server.server_close()
                    worker.join(2)


if __name__ == "__main__":
    unittest.main()
