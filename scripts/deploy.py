#!/usr/bin/env python3
"""Render a digest-pinned Compose bundle and submit it to Dokploy."""

import argparse
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parents[1]
COMPONENTS = ("postgres", "server", "web", "workspace")
IMAGE_REF = re.compile(r"ghcr\.io/[a-z0-9_.\-/]+@sha256:[0-9a-f]{64}\Z")


class DeploymentError(Exception):
    pass


def read_bundle(path):
    bundle = json.loads(Path(path).read_text())
    if not isinstance(bundle, dict) or not re.fullmatch(
        r"[0-9a-f]{40}", str(bundle.get("revision", ""))
    ):
        raise DeploymentError("Bundle must identify a full Git revision")
    images = bundle.get("images")
    if not isinstance(images, dict) or set(images) != set(COMPONENTS):
        raise DeploymentError("Bundle must contain exactly the four Ochi images")
    for component, ref in images.items():
        if not isinstance(ref, str) or not IMAGE_REF.fullmatch(ref):
            raise DeploymentError(f"{component}: expected a GHCR image pinned by digest")
    return bundle


def render_compose(bundle):
    text = (ROOT / "compose.dokploy.yaml").read_text()
    for component, ref in bundle["images"].items():
        marker = "${OCHI_" + component.upper() + "_IMAGE:?Use the Compose file from the container workflow}"
        if marker not in text:
            raise DeploymentError(f"Compose template is missing {component}")
        text = text.replace(marker, ref)
    return f"# Ochi source revision: {bundle['revision']}\n" + text


class Dokploy:
    def __init__(self, url, api_key):
        parsed = urllib.parse.urlsplit(url)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.netloc
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise DeploymentError("DOKPLOY_URL must be an HTTP(S) origin without credentials")
        self.url = url.rstrip("/")
        self.api_key = api_key

    def call(self, method, procedure, payload):
        url = self.url + "/api/" + procedure
        data = None
        if method == "GET":
            url += "?" + urllib.parse.urlencode(payload)
        else:
            data = json.dumps(payload).encode()
        request = urllib.request.Request(
            url,
            data=data,
            headers={
                "x-api-key": self.api_key,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "Ochi/deploy",
            },
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            # Dokploy error bodies can contain the saved environment or API key.
            raise DeploymentError(f"Dokploy {procedure} returned HTTP {error.code}") from None
        except (urllib.error.URLError, TimeoutError, ValueError):
            raise DeploymentError(f"Dokploy {procedure} request failed") from None

    def deploy(self, compose_id, compose_file, revision, wait_seconds=1800):
        current = self.call("GET", "compose.one", {"composeId": compose_id})
        if not isinstance(current, dict) or current.get("sourceType") != "raw":
            raise DeploymentError("Use a Dokploy Raw Compose service; Git auto-deploy must be disabled")
        if current.get("composeType") != "docker-compose":
            raise DeploymentError("Use Docker Compose, not Docker Stack/Swarm, for Ochi")
        if current.get("autoDeploy"):
            raise DeploymentError("Disable Dokploy Git/webhook auto-deploy before enabling CI deployment")
        if current.get("composeStatus") == "running":
            raise DeploymentError("Dokploy is already deploying this service; wait for it to finish")
        title = f"Ochi {revision[:12]} {uuid.uuid4().hex[:12]}"
        # Patch only the public template. Credentials and domain settings stay in Dokploy.
        self.call("POST", "compose.update", {"composeId": compose_id, "composeFile": compose_file})
        self.call(
            "POST",
            "compose.deploy",
            {"composeId": compose_id, "title": title, "freshVolumes": False},
        )
        deadline = time.monotonic() + wait_seconds
        while time.monotonic() < deadline:
            deployments = self.call("GET", "deployment.allByCompose", {"composeId": compose_id})
            if not isinstance(deployments, list):
                raise DeploymentError("Dokploy returned an invalid deployment list")
            matching = next((item for item in deployments if item.get("title") == title), None)
            if matching:
                status = matching.get("status")
                if status == "done":
                    return
                if status in ("error", "cancelled"):
                    raise DeploymentError(f"Dokploy deployment {status}; inspect its deployment log")
            time.sleep(5)
        raise DeploymentError("Dokploy deployment wait timed out; inspect it before retrying (it may still be running)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("render", "deploy"))
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--output", type=Path, help="Rendered public Compose output")
    parser.add_argument("--wait-seconds", type=int, default=1800, help="Deployment completion timeout (default: 1800)")
    args = parser.parse_args()
    try:
        bundle = read_bundle(args.bundle)
        if args.wait_seconds <= 0:
            raise DeploymentError("--wait-seconds must be positive")
        compose_file = render_compose(bundle)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(compose_file)
        if args.command == "render":
            if not args.output:
                print(compose_file, end="")
            return 0
        values = {name: os.environ.get(name, "").strip() for name in ("DOKPLOY_URL", "DOKPLOY_API_KEY", "DOKPLOY_COMPOSE_ID")}
        if not all(values.values()):
            raise DeploymentError("Set DOKPLOY_URL, DOKPLOY_API_KEY and DOKPLOY_COMPOSE_ID")
        Dokploy(values["DOKPLOY_URL"], values["DOKPLOY_API_KEY"]).deploy(
            values["DOKPLOY_COMPOSE_ID"], compose_file, bundle["revision"], args.wait_seconds
        )
        print(f"Dokploy completed deployment of {bundle['revision'][:12]}. Check /healthz and sign in to verify the application.")
        return 0
    except (DeploymentError, OSError, ValueError) as error:
        print(f"Deployment failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
