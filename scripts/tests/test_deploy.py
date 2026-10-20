import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


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
        self.assertIn("networks: [app, compute, dokploy]", text)
        self.assertNotIn("\n  web:", text)
        self.assertNotIn("OCHI_WEB_IMAGE", text)


if __name__ == "__main__":
    unittest.main()
