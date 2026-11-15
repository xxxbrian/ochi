"""Real disk/HTTP file transfers stay separate from bounded model previews."""
from __future__ import annotations

import base64
import hashlib
import http.client
import io
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse
import urllib.request
import zipfile
import zlib
from contextlib import ExitStack, contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bridge
import workspace_control
import workspace_jobs
import workspace_runtime as runtime


CHUNK = b"x" * (64 * 1024)
LARGE_SIZE = 40 * 1024 * 1024 + 137


def write_large(path: Path, size: int = LARGE_SIZE) -> bytes:
    digest = hashlib.sha256()
    with path.open("wb") as target:
        remaining = size
        while remaining:
            part = CHUNK[:min(len(CHUNK), remaining)]
            target.write(part)
            digest.update(part)
            remaining -= len(part)
    return digest.digest()


@contextmanager
def http_server(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        worker.join(2)


class QuietBridge(bridge.Handler):
    def log_message(self, *args):
        pass


class FileLimits(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ochi-file-limit-")
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(runtime, "DATA_ROOT", self.root))
        self.stack.enter_context(patch.object(runtime, "FILES_ROOT", self.root / "files"))
        self.stack.enter_context(patch.object(workspace_control, "BRIDGE_TOKEN", "fixture-file-token"))
        self.jobs = workspace_jobs.JobRegistry(self.root / "jobs")
        self.addCleanup(self.jobs.close)
        self.stack.enter_context(patch.object(bridge, "JOBS", self.jobs))
        self.scope = {"user_id": "fixture", "session_id": "session", "run_id": "run", "cwd": str(self.root)}
        token = runtime.RUN_SCOPE.set(self.scope)
        self.addCleanup(runtime.RUN_SCOPE.reset, token)

    def headers(self):
        return {"Authorization": "Bearer fixture-file-token", "X-Run-Scope": json.dumps(self.scope)}

    def test_above_32mib_http_put_get_and_publication_are_exact_streams(self):
        source = self.root / "source.bin"
        expected = write_large(source)
        with http_server(QuietBridge) as server:
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=15)
            with source.open("rb") as body:
                connection.request("PUT", "/file?path=large.bin", body=body,
                                   headers={**self.headers(), "Content-Length": str(LARGE_SIZE)})
                response = connection.getresponse()
                result = json.loads(response.read())
            connection.close()
            self.assertEqual(response.status, 201)
            self.assertTrue(result["written"])
            self.assertEqual(result["size"], LARGE_SIZE)
            digest = hashlib.sha256()
            request = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/file?path=large.bin", headers=self.headers())
            with urllib.request.urlopen(request, timeout=15) as response:
                self.assertEqual(int(response.headers["Content-Length"]), LARGE_SIZE)
                while chunk := response.read(len(CHUNK)):
                    digest.update(chunk)
            self.assertEqual(digest.digest(), expected)
        with patch.object(Path, "read_bytes", side_effect=AssertionError("publication read all bytes")):
            published = runtime._publish_file("large.bin")
        self.assertEqual(published["size"], LARGE_SIZE)
        self.assertEqual(runtime._file_digest(Path(published["path"])), expected.hex()[:20])
        self.assertFalse(list(self.root.rglob(".ochi-transfer-*")))

    def test_short_and_oversize_put_preserve_destination_and_remove_temporaries(self):
        path = self.root / "selected.bin"
        path.write_bytes(b"existing destination")
        with http_server(QuietBridge) as server:
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            connection.putrequest("PUT", "/file?path=selected.bin")
            for name, value in {**self.headers(), "Content-Length": "10000"}.items():
                connection.putheader(name, value)
            connection.endheaders()
            connection.send(b"partial transfer")
            connection.sock.shutdown(socket.SHUT_WR)
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            self.assertIn("incomplete file transfer", response.read().decode())
            connection.close()
            with patch.object(runtime, "MAX_FILE_BYTES", 1024):
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                connection.putrequest("PUT", "/file?path=selected.bin")
                for name, value in {**self.headers(), "Content-Length": "1025"}.items():
                    connection.putheader(name, value)
                connection.endheaders()
                response = connection.getresponse()
                self.assertEqual(response.status, 400)
                self.assertIn("configured transfer limit", response.read().decode())
                connection.close()
        self.assertEqual(path.read_bytes(), b"existing destination")
        self.assertFalse(list(self.root.rglob(".ochi-transfer-*")))

    def test_get_does_not_stream_bytes_added_after_size_check(self):
        path = self.root / "growing.txt"
        path.write_bytes(b"first")

        def metadata(selected):
            result = runtime._file_metadata(selected)
            with selected.open("ab") as handle:
                handle.write(b"bytes appended after the header size check")
            return result

        with http_server(QuietBridge) as server, patch.object(bridge, "_file_metadata", side_effect=metadata):
            with socket.create_connection(("127.0.0.1", server.server_port), timeout=5) as connection:
                headers = self.headers()
                raw = f"GET /file?path=growing.txt HTTP/1.0\r\nHost: fixture\r\n"
                raw += "".join(f"{name}: {value}\r\n" for name, value in headers.items()) + "\r\n"
                connection.sendall(raw.encode())
                response = bytearray()
                while chunk := connection.recv(4096):
                    response.extend(chunk)
        _, body = bytes(response).split(b"\r\n\r\n", 1)
        self.assertEqual(body, b"first")

    def test_environment_can_raise_transfer_cap_without_raising_context_caps(self):
        script = "import json,workspace_runtime as r; print(json.dumps([r.MAX_FILE_BYTES,r.MAX_IMAGE_BYTES,r.MAX_PREVIEW_BYTES]))"
        for value, expected in (("2147483648", 2 << 30), ("2_147_483_648", 1 << 30), ("0", 1 << 30)):
            with self.subTest(value=value):
                output = subprocess.check_output(
                    [sys.executable, "-B", "-c", script],
                    env={**os.environ, "PYTHONPATH": str(Path(runtime.__file__).parent), "OCHI_MAX_FILE_BYTES": value},
                    timeout=5)
                self.assertEqual(json.loads(output), [expected, 8 << 20, 256 << 10])

    def test_streaming_stage_limits_reads_and_cleans_unknown_length_failures(self):
        class BoundedReader(io.BytesIO):
            def read(self, size=-1):
                if not 0 < size <= 64 * 1024:
                    raise AssertionError("unbounded file read")
                return super().read(size)

        with patch.object(runtime, "MAX_FILE_BYTES", 1024):
            for expected in (None, 1025):
                with self.assertRaisesRegex(ValueError, "configured transfer limit"):
                    runtime._stage_file(BoundedReader(b"x" * 1025), self.root, expected_bytes=expected)
        self.assertFalse(list(self.root.rglob(".ochi-transfer-*")))
        self.assertEqual(runtime.MAX_IMAGE_BYTES, 8 << 20)
        self.assertEqual(runtime.MAX_PREVIEW_BYTES, 256 << 10)

    def test_large_text_and_svg_reads_return_small_explicit_samples(self):
        for filename in ("large.txt", "large.svg"):
            with self.subTest(filename=filename):
                path = self.root / filename
                write_large(path)
                with path.open("ab") as target:
                    target.write(b"TAIL_NOT_INCLUDED_IN_PREVIEW")
                with patch.object(Path, "read_text", side_effect=AssertionError("preview read full text")):
                    result = bridge.tool_files_read({"path": filename, "max_bytes": 2_000_000, "max_chars": 200_000})
                self.assertTrue(result["truncated"])
                self.assertLessEqual(len(result["content"]), runtime.MAX_PREVIEW_CHARS + 20)
                self.assertEqual(result["sampled_bytes"], runtime.MAX_PREVIEW_BYTES)
                self.assertNotIn("TAIL_NOT_INCLUDED_IN_PREVIEW", result["content"])
                self.assertEqual(result["size"], path.stat().st_size)

    def test_public_fetch_streams_large_file_and_only_samples_text(self):
        class PublicFile(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(LARGE_SIZE))
                self.end_headers()
                remaining = LARGE_SIZE
                while remaining:
                    part = CHUNK[:min(len(CHUNK), remaining)]
                    self.wfile.write(part)
                    remaining -= len(part)

        with http_server(PublicFile) as server:
            result = bridge.tool_web_fetch({"url": f"http://127.0.0.1:{server.server_port}/large.txt", "path": "fetched.txt", "max_chars": 100_000})
        saved = Path(result["file"]["path"])
        self.assertEqual(saved.stat().st_size, LARGE_SIZE)
        self.assertEqual(runtime._file_digest(saved), runtime._file_digest(self._comparison_file()))
        self.assertTrue(result["truncated"])
        self.assertLessEqual(len(result["text"]), runtime.MAX_PREVIEW_CHARS + 20)
        self.assertEqual(result["sampled_bytes"], runtime.MAX_PREVIEW_BYTES)
        self.assertFalse(list(self.root.rglob(".ochi-transfer-*")))

    def _comparison_file(self):
        path = self.root / "comparison.bin"
        write_large(path)
        return path

    def test_failed_public_fetch_leaves_existing_file_and_no_partial_file(self):
        destination = self.root / "keep.txt"
        destination.write_text("keep")

        class IncompleteFile(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", "10000")
                self.end_headers()
                self.wfile.write(b"incomplete")
                self.close_connection = True

        with http_server(IncompleteFile) as server, self.assertRaises(ValueError):
            bridge.tool_web_fetch({"url": f"http://127.0.0.1:{server.server_port}/incomplete.txt", "path": "keep.txt"})
        self.assertEqual(destination.read_text(), "keep")
        self.assertFalse(list(self.root.rglob(".ochi-transfer-*")))

    def test_office_expansion_and_large_document_previews_are_bounded(self):
        document = self.root / "expanded.docx"
        with zipfile.ZipFile(document, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("word/document.xml", b"<document><t>" + b"x" * (9 << 20) + b"</t></document>")
        result = bridge.tool_files_read({"path": str(document), "max_chars": 200_000})
        self.assertTrue(result["truncated"])
        self.assertEqual(result["content"], "")
        huge = self.root / "large.pdf"
        with huge.open("wb") as target:
            target.truncate(40 << 20)
        with patch.object(bridge.subprocess, "run", side_effect=AssertionError("large document reached parser")):
            result = bridge.tool_files_read({"path": str(huge)})
        self.assertTrue(result["truncated"])
        self.assertIn("preview input budget", result["extraction"])

    def test_above_32mib_image_is_resized_before_base64_context(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow is provided by the workspace image")
        path = self.root / "large.png"
        Image.new("RGB", (4000, 3000), "white").save(path, compress_level=0)
        self.assertGreater(path.stat().st_size, 32 << 20)
        with patch.object(Path, "read_bytes", side_effect=AssertionError("image preview read all source bytes")):
            image = bridge.tool_files_read({"path": str(path)})["image"]
        self.assertLessEqual(max(image["width"], image["height"]), 1280)
        self.assertEqual((image["original_width"], image["original_height"]), (4000, 3000))
        self.assertLess(len(base64.b64decode(image["data"])), runtime.MAX_IMAGE_BYTES)

    def test_image_pixel_budget_is_independent_of_transfer_limit(self):
        try:
            import PIL
        except ImportError:
            self.skipTest("Pillow is provided by the workspace image")
        path = self.root / "oversize-dimensions.png"

        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

        header = struct.pack(">IIBBBBB", 9000, 8000, 8, 2, 0, 0, 0)
        path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"")) + chunk(b"IEND", b""))
        with self.assertRaisesRegex(ValueError, "dimensions exceed the preview budget"):
            runtime._image_result(path, coordinate_space="file")


if __name__ == "__main__":
    unittest.main()
