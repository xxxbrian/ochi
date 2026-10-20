import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("release", Path(__file__).resolve().parents[1] / "release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
REVISION = "a" * 40
BUILT_AT = "2026-10-20T08:30:00Z"


def elf(arch):
    data = bytearray(64)
    data[:6] = b"\x7fELF\x02\x01"
    data[18:20] = release.ARCHITECTURES[arch].to_bytes(2, "little")
    return bytes(data)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.directory = self.root / "release"
        (self.root / "server/internal/product").mkdir(parents=True)
        (self.root / "server/internal/storage").mkdir(parents=True)
        (self.root / "server/internal/product/identity.go").write_text('package product\n\nconst Version = "0.1.0"\n')
        (self.root / "server/internal/storage/schema.sql").write_text("-- synthetic schema\n")

    def package(self, arch):
        binary = self.root / arch
        binary.write_bytes(elf(arch))
        return release.package_binary(binary, self.directory, arch, REVISION, "123", "2")

    def test_metadata_uses_source_bytes_not_environment(self):
        with patch.dict("os.environ", {"MODEL_API_KEY": "must-not-leak"}):
            result = release.source_metadata(self.root)
        self.assertEqual(result["version"], "0.1.0")
        self.assertEqual(result["schema_sha256"], hashlib.sha256(b"-- synthetic schema\n").hexdigest())
        self.assertRegex(result["built_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertNotIn("must-not-leak", json.dumps(result))

    def test_archive_is_single_regular_executable_and_immutable(self):
        output = self.package("amd64")
        self.assertEqual(output.name, f"ochi-linux-amd64-{REVISION}-run-123-2.tar.gz")
        with tarfile.open(output) as archive:
            members = archive.getmembers()
            self.assertEqual(len(members), 1)
            self.assertEqual(members[0].name, "ochi-server")
            self.assertTrue(members[0].isfile())
            self.assertEqual(members[0].mode, 0o755)
            self.assertEqual(archive.extractfile(members[0]).read(), elf("amd64"))
        with self.assertRaises(FileExistsError):
            self.package("amd64")

    def test_manifest_requires_both_platforms_with_exact_archive_hashes(self):
        amd64 = self.package("amd64")
        with self.assertRaises(FileNotFoundError):
            release.update_manifest(self.directory, REVISION, "123", "2", "example/ochi", BUILT_AT, self.root)
        arm64 = self.package("arm64")
        value = release.update_manifest(self.directory, REVISION, "123", "2", "example/ochi", BUILT_AT, self.root)
        self.assertEqual(value["revision"], REVISION)
        self.assertEqual(value["built_at"], BUILT_AT)
        self.assertEqual(set(value["assets"]), {"linux_amd64", "linux_arm64"})
        for arch, path in (("amd64", amd64), ("arm64", arm64)):
            self.assertEqual(value["assets"][f"linux_{arch}"], {
                "url": f"https://github.com/example/ochi/releases/download/edge/{path.name}",
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "size": path.stat().st_size,
            })

    def test_platform_mismatch_and_non_elf_are_rejected(self):
        for data in (elf("arm64"), b"plain text", b"MZ executable"):
            with self.subTest(data=data):
                binary = self.root / "binary"
                binary.write_bytes(data)
                with self.assertRaisesRegex(release.ReleaseError, "ELF"):
                    release.package_binary(binary, self.directory, "amd64", REVISION, "123", "2")

    def test_symlink_binary_is_rejected(self):
        actual = self.root / "actual"
        actual.write_bytes(elf("amd64"))
        link = self.root / "link"
        link.symlink_to(actual)
        with self.assertRaisesRegex(release.ReleaseError, "regular"):
            release.package_binary(link, self.directory, "amd64", REVISION, "123", "2")

    def test_archive_names_bind_revision_run_attempt_and_architecture(self):
        invalid = (
            ("x86", REVISION, "123", "2"),
            ("amd64", "short", "123", "2"),
            ("amd64", REVISION, "../123", "2"),
            ("amd64", REVISION, "123", "0"),
        )
        for args in invalid:
            with self.subTest(args=args), self.assertRaises(release.ReleaseError):
                release.archive_name(*args)

    def test_extra_payload_links_paths_and_wrong_arch_are_rejected(self):
        self.directory.mkdir()
        for name, kind in (("ochi-server", tarfile.SYMTYPE), ("../ochi-server", tarfile.REGTYPE), ("extra", tarfile.REGTYPE), ("ochi-server", tarfile.REGTYPE)):
            with self.subTest(name=name, kind=kind):
                archive_path = self.directory / "unsafe.tar.gz"
                with tarfile.open(archive_path, "w:gz") as archive:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    if kind == tarfile.REGTYPE:
                        member.size = len(elf("arm64"))
                        archive.addfile(member, io.BytesIO(elf("arm64")))
                    else:
                        member.linkname = "somewhere"
                        archive.addfile(member)
                with self.assertRaises(release.ReleaseError):
                    release.asset_metadata(archive_path, "amd64", "example/ochi")
        with tarfile.open(archive_path, "w:gz") as archive:
            for name in ("ochi-server", "extra"):
                member = tarfile.TarInfo(name)
                member.size = len(elf("amd64"))
                archive.addfile(member, io.BytesIO(elf("amd64")))
        with self.assertRaisesRegex(release.ReleaseError, "additional"):
            release.asset_metadata(archive_path, "amd64", "example/ochi")

    def test_timestamp_and_repository_must_be_well_formed(self):
        for timestamp in ("yesterday", "2026-10-20T08:30:00", "2026-10-20 08:30:00Z"):
            with self.subTest(timestamp=timestamp), self.assertRaises(release.ReleaseError):
                release.update_manifest(self.directory, REVISION, "123", "2", "example/ochi", timestamp, self.root)
        for repository in ("https://github.com/example/ochi", "example/ochi?token=bad", "../example/ochi"):
            with self.subTest(repository=repository), self.assertRaises(release.ReleaseError):
                release.update_manifest(self.directory, REVISION, "123", "2", repository, BUILT_AT, self.root)


if __name__ == "__main__":
    unittest.main()
