"""Owned process groups, durable logs and explicit task/service lifetimes."""
from __future__ import annotations

import codecs
import contextlib
import functools
import json
import os
import re
import signal
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from workspace_runtime import (DATA_ROOT, COMPUTE_ONLY, RUN_SCOPE, PROCESS_LOCK,
                               CANCELLED_RUNS, INTERRUPTED_OPERATIONS,
                               _clamp_int, _safe_cwd, _workspace_env)

MAX_ACTIVE_JOBS = 32
MAX_LOG_CHUNK = 32 * 1024


def _owner(scope: dict[str, Any]) -> tuple[str, str]:
    user, session = scope.get("user_id"), scope.get("session_id")
    if not user or not session:
        raise ValueError("job requires explicit user and session scope")
    return user, session


def _kill_group(process: subprocess.Popen[Any]) -> None:
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGTERM)
    with contextlib.suppress(subprocess.TimeoutExpired):
        process.wait(timeout=0.5)
    # The shell may already be gone while a child ignores TERM.
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGKILL)
    with contextlib.suppress(subprocess.TimeoutExpired):
        process.wait(timeout=2)


class JobRegistry:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.lock = threading.RLock()
        self.jobs: dict[str, dict[str, Any]] = {}
        self.active_calls = 0
        self.last_activity = time.monotonic()
        self.desktop_calls: dict[tuple[str, str], int] = {}
        self.closed_runs: dict[tuple[str, str, str], float] = {}

    @contextlib.contextmanager
    def activity(self, enabled: bool = True):
        if enabled:
            with self.lock:
                self.active_calls += 1
                self.last_activity = time.monotonic()
        try:
            yield
        finally:
            if enabled:
                with self.lock:
                    self.active_calls -= 1
                    self.last_activity = time.monotonic()

    def active(self) -> dict[str, Any]:
        with self.lock:
            fields = ("job_id", "user_id", "session_id", "run_id", "kind", "cwd", "resource_claims")
            return {"jobs": [{key: job[key] for key in fields} for job in self.jobs.values() if job["status"] == "running"],
                    "active_calls": self.active_calls, "idle_seconds": max(0, time.monotonic() - self.last_activity)}

    def _desktop_conflict(self, owner: tuple[str, str]) -> bool:
        return any(other != owner and count for other, count in self.desktop_calls.items()) or any(
            job["status"] == "running" and "desktop" in job["resource_claims"] and
            (job["user_id"], job["session_id"]) != owner for job in self.jobs.values())

    @contextlib.contextmanager
    def desktop(self, scope: dict[str, Any]):
        owner = _owner(scope)
        with self.lock:
            if self._desktop_conflict(owner):
                raise RuntimeError("desktop is in use by another session's job")
            self.desktop_calls[owner] = self.desktop_calls.get(owner, 0) + 1
        try:
            yield
        finally:
            with self.lock:
                self.desktop_calls[owner] -= 1
                if not self.desktop_calls[owner]:
                    del self.desktop_calls[owner]

    def _persist(self, job: dict[str, Any]) -> None:
        fields = ("job_id", "user_id", "session_id", "run_id", "kind", "cwd", "resource_claims",
                  "status", "exit_code", "created_at", "finished_at", "duration_ms", "stdout_path", "stderr_path")
        root = self.root / job["job_id"]
        temp = root / "state.tmp"
        temp.write_text(json.dumps({key: job.get(key) for key in fields}))
        os.replace(temp, root / "state.json")

    def start(self, args: dict[str, Any], scope: dict[str, Any], *, compute: bool = COMPUTE_ONLY) -> dict[str, Any]:
        owner = _owner(scope)
        command = args.get("command")
        if not isinstance(command, str) or not command.strip():
            raise ValueError("command is required")
        kind = args.get("kind", "task")
        if kind not in {"task", "service"}:
            raise ValueError("job kind must be task or service")
        if kind == "task" and args.get("timeout_ms", 20_000) > 600_000:
            raise ValueError("task deadline exceeds 600000 ms; persistent servers require kind=service")
        timeout = _clamp_int(args.get("timeout_ms"), 20_000 if kind == "task" else 3_600_000,
                             1000, 600_000 if kind == "task" else 86_400_000)
        cwd, env = _safe_cwd(args.get("cwd")), _workspace_env(args.get("env"))
        with self.lock, PROCESS_LOCK:
            now = time.monotonic()
            for key, stopped in list(self.closed_runs.items()):
                if now - stopped > 900:
                    del self.closed_runs[key]
            if (*owner, scope.get("run_id", "")) in self.closed_runs:
                raise RuntimeError("job scope has already finished")
            if scope.get("run_id") in CANCELLED_RUNS or scope.get("operation_id") in INTERRUPTED_OPERATIONS:
                raise RuntimeError("operation was interrupted before execution")
            if not compute and self._desktop_conflict(owner):
                raise RuntimeError("desktop is in use by another session's job")
            if sum(job["status"] == "running" for job in self.jobs.values()) >= MAX_ACTIVE_JOBS:
                raise RuntimeError("workspace has reached its active job limit")
            job_id = uuid.uuid4().hex
            root = self.root / job_id
            root.mkdir(parents=True)
            stdout, stderr = root / "stdout.log", root / "stderr.log"
            with stdout.open("wb") as out, stderr.open("wb") as err:
                process = subprocess.Popen(["bash", "-c", command], cwd=str(cwd), env=env,
                                           stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True)
            job = {"job_id": job_id, "user_id": owner[0], "session_id": owner[1],
                   "run_id": scope.get("run_id", ""), "operation_id": scope.get("operation_id", ""),
                   "kind": kind, "cwd": str(cwd), "resource_claims": [] if compute else ["desktop", "project"],
                   "status": "running", "exit_code": None, "created_at": time.time(), "duration_ms": 0,
                   "stdout_path": str(stdout), "stderr_path": str(stderr),
                   "process": process, "done": threading.Event(), "started": now, "stop_reason": ""}
            self.jobs[job_id] = job
            try:
                self._persist(job)
            except OSError:
                self.jobs.pop(job_id)
                _kill_group(process)
                raise
            self.last_activity = now
        threading.Thread(target=self._watch, args=(job, timeout / 1000), name="job-" + job_id[:8], daemon=True).start()
        return job

    def _watch(self, job: dict[str, Any], timeout: float) -> None:
        process = job["process"]
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            with self.lock:
                job["stop_reason"] = job["stop_reason"] or "timed_out"
        finally:
            _kill_group(process)
        with self.lock:
            job["status"] = job["stop_reason"] or ("completed" if process.returncode == 0 else "failed")
            job["exit_code"] = 124 if job["status"] == "timed_out" else process.returncode
            job["finished_at"] = time.time()
            job["duration_ms"] = round((time.monotonic() - job["started"]) * 1000)
            try:
                self._persist(job)
            except OSError:
                # Process ownership and cancellation must still complete when
                # its volume is full or no longer writable.
                print(f"job {job['job_id']} final state could not be persisted", flush=True)
            finally:
                job["done"].set()
                self.last_activity = time.monotonic()
            # Durable state/logs remain queryable; completed Popen objects don't.
            finished = [item for item in self.jobs.values() if item["status"] != "running"]
            for old in sorted(finished, key=lambda item: item["created_at"])[:-128]:
                self.jobs.pop(old["job_id"], None)

    def _owned(self, job_id: Any, scope: dict[str, Any]) -> dict[str, Any]:
        owner = _owner(scope)
        if not isinstance(job_id, str) or not re.fullmatch("[0-9a-f]{32}", job_id):
            raise ValueError("invalid job id")
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None:
                try:
                    job = json.loads((self.root / job_id / "state.json").read_text())
                except FileNotFoundError:
                    raise ValueError("job does not exist") from None
                # A container restart ends its process namespace; PIDs are never
                # restored from disk or signalled after they can be reused.
                if job["status"] == "running":
                    job = {**job, "status": "cancelled", "exit_code": None}
            if (job["user_id"], job["session_id"]) != owner:
                raise PermissionError("job belongs to another session")
            return job

    @staticmethod
    def _log(path: str, offset: int, complete: bool) -> tuple[str, int, bool]:
        with open(path, "rb") as source:
            size = os.fstat(source.fileno()).st_size
            if offset > size:
                raise ValueError("log offset exceeds current output")
            source.seek(offset)
            raw = source.read(MAX_LOG_CHUNK)
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        text = decoder.decode(raw, final=complete and offset + len(raw) >= size)
        consumed = len(raw) - len(decoder.getstate()[0])
        return text, offset + consumed, offset + consumed < size

    def snapshot(self, job: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
        fields = ("job_id", "kind", "status", "exit_code", "cwd", "resource_claims", "duration_ms", "stdout_path", "stderr_path")
        with self.lock:
            result = {key: job.get(key) for key in fields}
            if job["status"] == "running":
                result["duration_ms"] = round((time.monotonic() - job["started"]) * 1000)
        complete = result["status"] != "running"
        stdout, stdout_offset, out_more = self._log(job["stdout_path"], max(0, int(args.get("stdout_offset", 0))), complete)
        stderr, stderr_offset, err_more = self._log(job["stderr_path"], max(0, int(args.get("stderr_offset", 0))), complete)
        return {**result, "stdout": stdout, "stderr": stderr, "stdout_offset": stdout_offset,
                "stderr_offset": stderr_offset, "has_more": out_more or err_more,
                "truncated": out_more or err_more, "timed_out": result["status"] == "timed_out"}

    def execute(self, args: dict[str, Any], *, wait_until_done: bool = False) -> dict[str, Any]:
        job = self.start(args, RUN_SCOPE.get())
        wait = 86_401 if wait_until_done else _clamp_int(args.get("wait_ms"), 1000, 0, 10_000) / 1000
        job["done"].wait(wait)
        return self.snapshot(job, {})

    def call(self, args: dict[str, Any]) -> dict[str, Any]:
        job = self._owned(args.get("job_id"), RUN_SCOPE.get())
        action = args.get("action", "status")
        if action == "cancel":
            self._stop([job])
        elif action == "wait":
            if "done" in job:
                job["done"].wait(_clamp_int(args.get("wait_ms"), 1000, 0, 10_000) / 1000)
        elif action != "status":
            raise ValueError("unknown job action")
        return self.snapshot(job, args)

    def _stop(self, jobs: list[dict[str, Any]]) -> None:
        for job in jobs:
            with self.lock:
                if job["status"] != "running":
                    continue
                job["stop_reason"] = job["stop_reason"] or "cancelled"
            _kill_group(job["process"])
            if not job["done"].wait(3):
                raise RuntimeError("job process group did not stop")

    def finish(self, scope: dict[str, Any], *, services: bool, session: bool = False) -> dict[str, Any]:
        owner = _owner(scope)
        run_id = scope.get("run_id", "")
        if not session and not run_id:
            raise ValueError("run scope is required")
        with self.lock:
            if not session:
                self.closed_runs[(*owner, run_id)] = time.monotonic()
            jobs = [job for job in self.jobs.values() if job["status"] == "running"
                    and (job["user_id"], job["session_id"]) == owner
                    and (session or job["run_id"] == run_id) and (services or job["kind"] == "task")]
        self._stop(jobs)
        return {"cancelled": True, "jobs": len(jobs)}

    def interrupt(self, operation: str) -> int:
        with self.lock:
            jobs = [job for job in self.jobs.values() if job["operation_id"] == operation and job["status"] == "running"]
        self._stop(jobs)
        return len(jobs)

    def close(self) -> None:
        with self.lock:
            jobs = [job for job in self.jobs.values() if job["status"] == "running"]
        self._stop(jobs)


JOBS = JobRegistry(DATA_ROOT / "jobs")


def tracked_request(handler):
    @functools.wraps(handler)
    def call(self):
        path = self.path.split("?", 1)[0].rstrip("/")
        with JOBS.activity(path not in {"/health", "/jobs/active"}):
            return handler(self)
    return call
