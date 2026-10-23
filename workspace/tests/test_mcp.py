"""MCP error and HTTP observation contracts without an SDK or external service."""
from __future__ import annotations

import contextlib
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import workspace_mcp


class MCPDiagnostics(unittest.TestCase):
    config = {"id": "fixture", "transport": "http", "url": "https://example.invalid/mcp",
              "headers": {"Authorization": "Bearer fixture-token", "X-Key": "fixture-key"},
              "env": {"API_KEY": "fixture-env"}}

    def test_plain_single_and_nested_group_errors_keep_leaf_details(self) -> None:
        leaf = ConnectionError("connection refused")
        self.assertEqual(workspace_mcp._mcp_error({}, leaf), "ConnectionError: connection refused")
        for error in (ExceptionGroup("task group", [leaf]),
                      ExceptionGroup("task group", [ExceptionGroup("nested", [leaf])])):
            with self.subTest(error=error):
                self.assertEqual(workspace_mcp._mcp_error({}, error), "ConnectionError: connection refused")

    def test_explicit_cause_and_duplicate_leaves_are_bounded(self) -> None:
        cause = ConnectionError("connection refused")
        error = RuntimeError("transport failed")
        error.__cause__ = cause
        cause.__cause__ = error
        result = workspace_mcp._mcp_error({}, ExceptionGroup("task group", [error, cause, cause]))
        self.assertEqual(result, "RuntimeError: transport failed; ConnectionError: connection refused")

    def test_secrets_are_redacted_in_all_leaves_before_truncation(self) -> None:
        error = ExceptionGroup("task group", [
            ValueError("Bearer fixture-token fixture-token fixture-key fixture-env"),
            RuntimeError("x" * 590 + " fixture-token fixture-env"),
        ])
        result = workspace_mcp._mcp_error(self.config, error)
        for secret in ("fixture-token", "fixture-key", "fixture-env"):
            self.assertNotIn(secret, result)
        self.assertIn("[redacted]", result)
        self.assertNotIn("Bearer", result)

    def test_many_deep_and_large_errors_are_bounded(self) -> None:
        error: BaseException = ValueError("deep")
        for _ in range(20):
            error = ExceptionGroup("nested", [error])
        self.assertIn("truncated", workspace_mcp._mcp_error({}, error))
        wide = ExceptionGroup("wide", [ValueError(str(i) + "x" * 5000) for i in range(100)])
        result = workspace_mcp._mcp_error({}, wide)
        self.assertLessEqual(len(result), 4000)
        self.assertNotIn("99" + "x" * 20, result)

    @contextlib.contextmanager
    def connection(self, *, initialization=(200,), initialization_error=None, calls=(), listing_error=None):
        state = types.SimpleNamespace(statuses=[], calls=list(calls), http=None)

        class Response:
            def __init__(self, status, method):
                self.status_code = status
                self.request = types.SimpleNamespace(method=method)

            def __getattr__(self, name):
                raise AssertionError(f"HTTP diagnostics accessed {name}")

        class HTTPClient:
            def __init__(self, **kwargs):
                self.hooks = kwargs["event_hooks"]
                self.headers = kwargs["headers"]
                state.http = self

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def respond(self, status, method="POST"):
                for hook in self.hooks["request"]:
                    await hook(types.SimpleNamespace(method=method))
                if status is None:
                    return
                state.statuses.append(status)
                for hook in self.hooks["response"]:
                    await hook(Response(status, method))

        class Client:
            def __init__(self, target, **kwargs):
                self.http = target

            async def __aenter__(self):
                for status in initialization:
                    await self.http.respond(status)
                if initialization_error:
                    raise initialization_error
                return self

            async def __aexit__(self, *args):
                return False

            async def list_tools(self, **kwargs):
                if listing_error:
                    raise listing_error
                tool = types.SimpleNamespace(model_dump=lambda **_: {
                    "name": "lookup", "description": "Fixture lookup", "inputSchema": {"type": "object"},
                })
                return types.SimpleNamespace(tools=[tool], next_cursor=None)

            async def call_tool(self, *args, **kwargs):
                statuses, error = state.calls.pop(0)
                for status in statuses:
                    await self.http.respond(status)
                if error:
                    raise error
                return types.SimpleNamespace(model_dump=lambda **_: {"content": [{"type": "text", "text": "done"}]})

        sdk = types.ModuleType("mcp")
        sdk.Client = Client
        sdk.StdioServerParameters = object
        transport = types.ModuleType("mcp.client.streamable_http")
        transport.streamable_http_client = lambda url, http_client: http_client
        http = types.ModuleType("httpx2")
        http.AsyncClient = HTTPClient
        with patch.dict(sys.modules, {"mcp": sdk, "mcp.client": types.ModuleType("mcp.client"),
                                      "mcp.client.streamable_http": transport, "httpx2": http}):
            connection = workspace_mcp.MCPConnection(self.config)
            try:
                self.assertTrue(connection.ready.wait(3), "MCP fixture did not initialize")
                yield connection, state
            finally:
                connection.close()
                connection.thread.join(3)
                self.assertFalse(connection.thread.is_alive(), "MCP fixture did not close")

    def test_http_failure_keeps_status_and_leaf_without_reading_response_data(self) -> None:
        error = ExceptionGroup("task group", [RuntimeError("Server returned an error response")])
        with self.connection(initialization=(522,), initialization_error=error) as (connection, state):
            with self.assertRaisesRegex(RuntimeError, "HTTP 522.*Server returned an error response"):
                connection.wait_ready()
            self.assertEqual(state.http.headers, self.config["headers"])
            self.assertNotIn(self.config["url"], connection.error)
            self.assertNotIn("task group", connection.error)

    def test_discovery_rejection_then_successful_handshake_stays_successful(self) -> None:
        with self.connection(initialization=(404, 200)) as (connection, state):
            connection.wait_ready()
            self.assertEqual(state.statuses, [404, 200])
            self.assertEqual(connection.error, "")
            self.assertEqual(connection.tools[0]["name"], "lookup")

    def test_successful_handshake_clears_discovery_error_before_listing_failure(self) -> None:
        with self.connection(initialization=(404, 200), listing_error=ValueError("invalid tool listing")) as (connection, _):
            with self.assertRaisesRegex(RuntimeError, "invalid tool listing"):
                connection.wait_ready()
            self.assertNotIn("HTTP 404", connection.error)

    def test_fallback_request_timeout_does_not_reuse_discovery_status(self) -> None:
        with self.connection(initialization=(404, None), initialization_error=TimeoutError("connection timed out")) as (connection, _):
            with self.assertRaisesRegex(RuntimeError, "connection timed out"):
                connection.wait_ready()
            self.assertNotIn("HTTP 404", connection.error)

    def test_previous_call_failure_does_not_pollute_later_calls(self) -> None:
        calls = [((522,), RuntimeError("upstream failed")),
                 ((), ConnectionError("connection reset")),
                 ((200,), ValueError("tool rejected input")),
                 ((200,), None)]
        with self.connection(calls=calls) as (connection, _):
            with self.assertRaisesRegex(RuntimeError, "HTTP 522.*upstream failed"):
                connection.call("lookup", {})
            for detail in ("connection reset", "tool rejected input"):
                with self.assertRaisesRegex(RuntimeError, detail) as raised:
                    connection.call("lookup", {})
                self.assertNotIn("HTTP 522", str(raised.exception))
            self.assertEqual(connection.call("lookup", {})["text"], "done")

    def test_optional_stream_and_cleanup_do_not_replace_rpc_failure(self) -> None:
        async def observe():
            status = workspace_mcp._MCPHTTPStatus()
            await status.observe(types.SimpleNamespace(status_code=522, request=types.SimpleNamespace(method="POST")))
            for method in ("GET", "DELETE"):
                await status.observe(types.SimpleNamespace(status_code=405, request=types.SimpleNamespace(method=method)))
            self.assertEqual(status.status, 522)
        workspace_mcp.asyncio.run(observe())


if __name__ == "__main__":
    unittest.main()
