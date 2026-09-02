"""Bounded background work, cancellation, progress and child-process ownership."""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from harness.process_io import LineReader, PipeError, TailReader, terminate_tree

_CONTEXT = threading.local()
_PROCESS_SLOTS = threading.BoundedSemaphore(2)


class JobCancelled(RuntimeError):
    pass


def check_cancelled() -> None:
    event = getattr(_CONTEXT, "cancel", None)
    if event is not None and event.is_set():
        raise JobCancelled(
            "Job cancelled. Completed import batches and reported results are retained."
        )


def progress(value: dict[str, Any]) -> None:
    check_cancelled()
    callback = getattr(_CONTEXT, "progress", None)
    if callback is not None:
        callback(value)


@contextmanager
def worker_slot() -> Iterator[None]:
    if not _PROCESS_SLOTS.acquire(blocking=False):
        raise RuntimeError("Two engine workers are already running. Cancel one or retry later.")
    try:
        yield
    finally:
        _PROCESS_SLOTS.release()


def run_process(
    command: list[str],
    payload: dict[str, Any],
    timeout: float,
    cwd: str,
    *,
    on_message: Callable[[dict[str, Any]], None] | None = None,
    cancel: threading.Event | None = None,
) -> dict[str, Any]:
    if not _PROCESS_SLOTS.acquire(blocking=False):
        raise RuntimeError("Two engine workers are already running. Cancel one or retry later.")
    process: subprocess.Popen[bytes] | None = None
    try:
        check_cancelled()
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
            start_new_session=os.name != "nt",
        )
        assert process.stdin and process.stdout and process.stderr
        reader = LineReader(
            process.stdout, line_limit=32 * 1024 * 1024, total_limit=64 * 1024 * 1024
        )
        errors = TailReader(process.stderr)
        process.stdin.write(json.dumps(payload).encode())
        process.stdin.close()
        deadline = time.monotonic() + timeout
        result: dict[str, Any] | None = None
        while True:
            check_cancelled()
            if cancel is not None and cancel.is_set():
                raise JobCancelled("Analysis cancelled.")
            if time.monotonic() >= deadline:
                raise RuntimeError(f"Worker timed out after {timeout:g} seconds.")
            try:
                raw = reader.readline(min(deadline, time.monotonic() + 0.1))
            except PipeError as exc:
                if "timed out" in str(exc):
                    continue
                if "closed" in str(exc):
                    break
                raise
            message = json.loads(raw)
            if not isinstance(message, dict):
                raise RuntimeError("Worker returned an invalid response.")
            if on_message is not None:
                on_message(message)
            if message.get("type") == "error":
                raise RuntimeError(str(message.get("error", "Worker failed.")))
            if message.get("type") == "progress":
                progress(message)
            else:
                result = message
        process.wait(timeout=5)
        if process.returncode != 0 or result is None or result.get("error"):
            detail = (result or {}).get("error") or errors.tail.decode(errors="replace")
            raise RuntimeError(str(detail or "Worker failed without a result."))
        return result
    finally:
        if process is not None:
            # Also remove descendants left behind by a failed or completed worker.
            terminate_tree(process, group=os.name != "nt")
            if "reader" in locals():
                reader.thread.join(timeout=1)
            if "errors" in locals():
                errors.thread.join(timeout=1)
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream and not stream.closed:
                    stream.close()
        _PROCESS_SLOTS.release()


class JobRegistry:
    def __init__(self, limit: int = 2) -> None:
        self.limit = limit
        self.lock = threading.RLock()
        self.jobs: dict[str, dict[str, Any]] = {}
        self.cancels: dict[str, threading.Event] = {}

    def submit(self, kind: str, work: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        with self.lock:
            if sum(row["status"] == "running" for row in self.jobs.values()) >= self.limit:
                raise RuntimeError("Background job limit reached. Cancel a running job first.")
            finished = [key for key, row in self.jobs.items() if row["status"] != "running"]
            while len(self.jobs) >= 12 and finished:
                old = finished.pop(0)
                self.jobs.pop(old)
                self.cancels.pop(old, None)
            identifier = uuid.uuid4().hex
            self.jobs[identifier] = {
                "id": identifier,
                "kind": kind,
                "status": "running",
                "progress": {},
                "started_at": time.time(),
            }
            self.cancels[identifier] = threading.Event()
            threading.Thread(target=self._run, args=(identifier, work), daemon=True).start()
            return self.get(identifier)

    def _run(self, identifier: str, work: Callable[[], dict[str, Any]]) -> None:
        _CONTEXT.cancel = self.cancels[identifier]
        _CONTEXT.progress = lambda value: self._update(identifier, progress=value)
        try:
            result = work()
            check_cancelled()
            self._update(identifier, status="completed", result=result)
        except JobCancelled as exc:
            self._update(identifier, status="cancelled", error=str(exc))
        except Exception as exc:
            self._update(identifier, status="failed", error=str(exc))
        finally:
            _CONTEXT.cancel = None
            _CONTEXT.progress = None

    def _update(self, identifier: str, **values: Any) -> None:
        with self.lock:
            self.jobs[identifier].update(values)

    def get(self, identifier: str) -> dict[str, Any]:
        with self.lock:
            if identifier not in self.jobs:
                raise ValueError("Job is unknown or its retained result has expired.")
            return dict(self.jobs[identifier])

    def cancel(self, identifier: str) -> dict[str, Any]:
        with self.lock:
            row = self.get(identifier)
            if row["status"] == "running":
                self.cancels[identifier].set()
            return row

    def list(self) -> list[dict[str, Any]]:
        with self.lock:
            return [
                {key: value for key, value in row.items() if key != "result"}
                for row in self.jobs.values()
            ]


JOBS = JobRegistry()
