#!/usr/bin/env python3
"""Package the embedded application and render its checksum-pinned update feed."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
import tarfile


ROOT = Path(__file__).resolve().parents[1]
ARCHITECTURES = {"amd64": 62, "arm64": 183}
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_BINARY_BYTES = 1024 * 1024 * 1024
BINARY_NAME = "ochi-server"


class ReleaseError(Exception):
    pass


def source_metadata(root=ROOT):
    identity = (root / "server/internal/product/identity.go").read_text()
    version = re.search(r'^const Version = "([0-9]+\.[0-9]+\.[0-9]+)"$', identity, re.MULTILINE)
    if not version:
        raise ReleaseError("Product identity must define its three-part version")
    return {
        "version": version.group(1),
        "built_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "schema_sha256": hashlib.sha256((root / "server/internal/storage/schema.sql").read_bytes()).hexdigest(),
    }


def archive_name(arch, revision, run_id, attempt):
    if arch not in ARCHITECTURES:
        raise ReleaseError("Only Linux amd64 and arm64 updates are published")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ReleaseError("A full Git revision is required")
    if not all(re.fullmatch(r"[1-9][0-9]*", str(value)) for value in (run_id, attempt)):
        raise ReleaseError("Workflow run and attempt must be positive integers")
    return f"ochi-linux-{arch}-{revision}-run-{run_id}-{attempt}.tar.gz"


def check_elf(header, arch):
    if (
        len(header) < 20
        or header[:6] != b"\x7fELF\x02\x01"
        or int.from_bytes(header[18:20], "little") != ARCHITECTURES[arch]
    ):
        raise ReleaseError(f"Expected a Linux {arch} ELF executable")


def package_binary(binary, directory, arch, revision, run_id, attempt):
    name = archive_name(arch, revision, run_id, attempt)
    if binary.is_symlink() or not binary.is_file() or not 0 < binary.stat().st_size <= MAX_BINARY_BYTES:
        raise ReleaseError("Application must be a regular executable no larger than 1 GiB")
    with binary.open("rb") as source:
        check_elf(source.read(20), arch)
    directory.mkdir(parents=True, exist_ok=True)
    output = directory / name
    # Run-specific names are immutable: never replace an asset that is in use.
    with output.open("xb") as destination, tarfile.open(fileobj=destination, mode="w:gz") as archive:
        info = tarfile.TarInfo(BINARY_NAME)
        info.size = binary.stat().st_size
        info.mode = 0o755
        with binary.open("rb") as source:
            archive.addfile(info, source)
    if output.stat().st_size > MAX_ARCHIVE_BYTES:
        output.unlink()
        raise ReleaseError("Compressed application exceeds the 512 MiB update limit")
    return output


def asset_metadata(path, arch, repository):
    size = path.stat().st_size
    if not 0 < size <= MAX_ARCHIVE_BYTES:
        raise ReleaseError("Compressed application exceeds the 512 MiB update limit")
    with tarfile.open(path, "r:gz") as archive:
        member = archive.next()
        if member is None or member.name != BINARY_NAME or not member.isfile() or not 0 < member.size <= MAX_BINARY_BYTES:
            raise ReleaseError("Archive must contain only the top-level application executable")
        with archive.extractfile(member) as source:
            check_elf(source.read(20), arch)
        if archive.next() is not None:
            raise ReleaseError("Archive contains unexpected additional payloads")
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    return {
        "url": f"https://github.com/{repository}/releases/download/edge/{path.name}",
        "sha256": digest,
        "size": size,
    }


def update_manifest(directory, revision, run_id, attempt, repository, built_at, root=ROOT):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ReleaseError("Repository must be an owner/name pair")
    try:
        timestamp = datetime.fromisoformat(built_at.replace("Z", "+00:00"))
    except ValueError:
        raise ReleaseError("Build time must be an RFC 3339 timestamp") from None
    if not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)", built_at) or timestamp.tzinfo is None:
        raise ReleaseError("Build time must include a timezone")
    metadata = source_metadata(root)
    assets = {}
    for arch in ARCHITECTURES:
        path = directory / archive_name(arch, revision, run_id, attempt)
        assets[f"linux_{arch}"] = asset_metadata(path, arch, repository)
    return {
        "version": metadata["version"],
        "revision": revision,
        "built_at": built_at,
        "schema_sha256": metadata["schema_sha256"],
        "assets": assets,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("metadata", help="Print source build metadata as key=value lines")
    package = commands.add_parser("package", help="Create an immutable, single-executable archive")
    package.add_argument("--binary", type=Path, required=True)
    package.add_argument("--arch", choices=ARCHITECTURES, required=True)
    manifest = commands.add_parser("manifest", help="Write update.json after both platforms are ready")
    manifest.add_argument("--repository", required=True)
    manifest.add_argument("--built-at", required=True)
    for command in (package, manifest):
        command.add_argument("--directory", type=Path, required=True)
        command.add_argument("--revision", required=True)
        command.add_argument("--run-id", required=True)
        command.add_argument("--attempt", required=True)
    args = parser.parse_args()
    try:
        if args.command == "metadata":
            for key, value in source_metadata().items():
                print(f"{key}={value}")
        elif args.command == "package":
            print(package_binary(args.binary, args.directory, args.arch, args.revision, args.run_id, args.attempt))
        else:
            value = update_manifest(args.directory, args.revision, args.run_id, args.attempt, args.repository, args.built_at)
            (args.directory / "update.json").write_text(json.dumps(value, indent=2) + "\n")
        return 0
    except (ReleaseError, OSError, ValueError, tarfile.TarError) as error:
        print(f"Release failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
