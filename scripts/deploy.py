#!/usr/bin/env python3
"""Render a digest-pinned Compose bundle without contacting a deployment host."""

import argparse
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
COMPONENTS = ("postgres", "server", "workspace")
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
        raise DeploymentError("Bundle must contain exactly the three Ochi images")
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("render",))
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--output", type=Path, help="Rendered public Compose output")
    args = parser.parse_args()
    try:
        bundle = read_bundle(args.bundle)
        compose_file = render_compose(bundle)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(compose_file)
        if not args.output:
            print(compose_file, end="")
        return 0
    except (DeploymentError, OSError, ValueError) as error:
        print(f"Deployment failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
