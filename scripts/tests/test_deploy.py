import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error


SPEC = importlib.util.spec_from_file_location("deploy", Path(__file__).resolve().parents[1] / "deploy.py")
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


def bundle():
    return {
        "revision": "a" * 40,
        "images": {name: f"ghcr.io/example/ochi-{name}@sha256:" + "b" * 64 for name in deploy.COMPONENTS},
    }


class BundleTests(unittest.TestCase):
    def read(self, value):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "images.json"
            path.write_text(json.dumps(value))
            return deploy.read_bundle(path)

    def test_complete_pinned_bundle(self):
        self.assertEqual(self.read(bundle()), bundle())

    def test_rejects_incomplete_or_extra_components(self):
        for name in deploy.COMPONENTS:
            value = bundle()
            del value["images"][name]
            with self.subTest(name=name), self.assertRaises(deploy.DeploymentError):
                self.read(value)
        value = bundle()
        value["images"]["other"] = value["images"]["server"]
        with self.assertRaises(deploy.DeploymentError):
            self.read(value)

    def test_rejects_mutable_or_malformed_images(self):
        for ref in ("ghcr.io/example/ochi-server:edge", "image@sha256:bad", "ghcr.io/example/app@sha256:" + "a" * 64 + "\nOTHER=bad", None):
            value = bundle()
            value["images"]["server"] = ref
            with self.subTest(ref=ref), self.assertRaises(deploy.DeploymentError):
                self.read(value)

    def test_rejects_missing_or_short_revision(self):
        for revision in (None, "aaaaaaa", "not-a-git-revision"):
            value = bundle()
            value["revision"] = revision
            with self.subTest(revision=revision), self.assertRaises(deploy.DeploymentError):
                self.read(value)

    def test_render_replaces_only_image_variables(self):
        value = bundle()
        original = copy.deepcopy(value)
        with patch.dict("os.environ", {"POSTGRES_PASSWORD": "do-not-copy-secret"}):
            text = deploy.render_compose(value)
        self.assertEqual(value, original)
        for ref in value["images"].values():
            self.assertIn(ref, text)
        self.assertEqual(text.count(value["images"]["workspace"]), 2)
        self.assertNotIn("${OCHI_SERVER_IMAGE", text)
        self.assertIn("${POSTGRES_PASSWORD:?", text)
        self.assertIn("${OCHI_DATABASE_VOLUME:-ochi-database}", text)
        self.assertNotIn("do-not-copy-secret", text)
        self.assertNotIn("127.0.0.1:8090", text)


class DokployTests(unittest.TestCase):
    def setUp(self):
        self.client = deploy.Dokploy("https://deploy.example.test/", "private-api-key")
        self.current = {"sourceType": "raw", "composeType": "docker-compose", "autoDeploy": False, "env": "SECRET=private-value"}

    def response(self, value):
        return io.BytesIO(json.dumps(value).encode())

    def test_auth_and_update_payload_do_not_replace_environment(self):
        calls = []
        title = ""

        def request(req, timeout):
            nonlocal title
            calls.append(req)
            self.assertEqual(timeout, 60)
            self.assertEqual(req.get_header("X-api-key"), "private-api-key")
            if "/compose.one?" in req.full_url:
                return self.response(self.current)
            payload = json.loads(req.data) if req.data else {}
            if req.full_url.endswith("/compose.update"):
                self.assertEqual(payload, {"composeId": "test-compose", "composeFile": "public-compose"})
                return self.response({"composeId": "test-compose"})
            if req.full_url.endswith("/compose.deploy"):
                self.assertFalse(payload["freshVolumes"])
                title = payload["title"]
                return self.response({"message": "Deployment queued"})
            return self.response([{"title": title, "status": "done"}])

        with patch.object(deploy.urllib.request, "urlopen", side_effect=request):
            self.client.deploy("test-compose", "public-compose", "a" * 40)
        self.assertEqual(len(calls), 4)
        self.assertNotIn("private-value", b"".join(req.data or b"" for req in calls).decode())

    def test_wrong_source_or_swarm_or_autodeploy_never_updates(self):
        for changes in ({"sourceType": "github"}, {"composeType": "stack"}, {"autoDeploy": True}, {"composeStatus": "running"}):
            current = self.current | changes
            with self.subTest(changes=changes), patch.object(self.client, "call", return_value=current) as call:
                with self.assertRaises(deploy.DeploymentError):
                    self.client.deploy("test", "compose", "a" * 40)
                self.assertEqual(call.call_count, 1)

    def run_statuses(self, statuses):
        saved_title = ""
        responses = iter(statuses)

        def call(method, procedure, payload):
            nonlocal saved_title
            if procedure == "compose.one":
                return self.current
            if procedure == "compose.deploy":
                saved_title = payload["title"]
                return {}
            if procedure == "compose.update":
                return {}
            status = next(responses)
            if status is None:
                return [{"title": "another-deployment", "status": "done"}]
            return [{"title": saved_title, "status": status}]

        return patch.object(self.client, "call", side_effect=call)

    def test_queue_acknowledgment_and_other_deployment_do_not_count_as_success(self):
        with self.run_statuses([None, "running", "done"]), patch.object(deploy.time, "sleep") as sleep:
            self.client.deploy("test", "compose", "a" * 40)
        self.assertEqual(sleep.call_count, 2)

    def test_errors_and_cancelled_are_failures(self):
        for status in ("error", "cancelled"):
            with self.subTest(status=status), self.run_statuses([status]):
                with self.assertRaisesRegex(deploy.DeploymentError, status):
                    self.client.deploy("test", "compose", "a" * 40)

    def test_timeout_warns_deployment_may_still_run(self):
        with self.run_statuses(["running"]), patch.object(deploy.time, "monotonic", side_effect=[0, 1, 3]), patch.object(deploy.time, "sleep"):
            with self.assertRaisesRegex(deploy.DeploymentError, "may still be running"):
                self.client.deploy("test", "compose", "a" * 40, wait_seconds=2)

    def test_http_errors_never_print_response_secrets(self):
        error = urllib.error.HTTPError("https://deploy.example.test", 500, "failure", {}, io.BytesIO(b"SECRET=private-value"))
        with patch.object(deploy.urllib.request, "urlopen", side_effect=error):
            with self.assertRaises(deploy.DeploymentError) as raised:
                self.client.call("POST", "compose.update", {})
        self.assertEqual(str(raised.exception), "Dokploy compose.update returned HTTP 500")

    def test_rejects_invalid_or_credential_bearing_url(self):
        for url in ("file:///tmp/dokploy", "https://user:password@deploy.example.test", "https://deploy.example.test?token=bad", "", "https://deploy.example.test#bad"):
            with self.subTest(url=url), self.assertRaises(deploy.DeploymentError):
                deploy.Dokploy(url, "key")


if __name__ == "__main__":
    unittest.main()
