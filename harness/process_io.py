"""Bounded pipe readers that work with subprocesses on Windows, macOS and Linux."""

from __future__ import annotations

import atexit
import os
import queue
import signal
import subprocess
import threading
import time
from contextlib import suppress
from typing import IO

_ACTIVE_LOCK = threading.RLock()
_ACTIVE_PROCESSES: dict[int, tuple[subprocess.Popen[bytes], bool]] = {}


class PipeError(RuntimeError):
    """A subprocess exceeded its protocol limits or stopped responding."""


class LineReader:
    def __init__(
        self, stream: IO[bytes], *, line_limit: int = 65_536, total_limit: int = 8 * 1024 * 1024
    ) -> None:
        self.stream = stream
        self.line_limit = line_limit
        self.total_limit = total_limit
        self.lines: queue.Queue[bytes] = queue.Queue(maxsize=256)
        self.done = threading.Event()
        self.error: str | None = None
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self) -> None:
        buffer = bytearray()
        total = 0
        try:
            while chunk := os.read(self.stream.fileno(), 4096):
                total += len(chunk)
                if total > self.total_limit:
                    raise PipeError("Subprocess output exceeds the byte limit.")
                buffer.extend(chunk)
                while b"\n" in buffer:
                    raw, _, remaining = buffer.partition(b"\n")
                    if len(raw) > self.line_limit:
                        raise PipeError("Subprocess output line is too long.")
                    self.lines.put_nowait(bytes(raw).rstrip(b"\r"))
                    buffer = bytearray(remaining)
                if len(buffer) > self.line_limit:
                    raise PipeError("Subprocess output line is too long.")
        except queue.Full:
            self.error = "Subprocess output queue is full."
        except (OSError, ValueError, PipeError) as exc:
            self.error = str(exc)
        finally:
            self.done.set()

    def readline(self, deadline: float) -> bytes:
        while True:
            if time.monotonic() >= deadline:
                raise PipeError("Subprocess response timed out.")
            if self.error:
                raise PipeError(self.error)
            try:
                return self.lines.get(timeout=max(0.001, min(0.05, deadline - time.monotonic())))
            except queue.Empty:
                if self.error:
                    raise PipeError(self.error) from None
                if self.done.is_set():
                    raise PipeError("Subprocess closed its output stream.") from None
                if time.monotonic() >= deadline:
                    raise PipeError("Subprocess response timed out.") from None


class TailReader:
    def __init__(self, stream: IO[bytes], limit: int = 8192) -> None:
        self.stream = stream
        self.limit = limit
        self.tail = b""
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self) -> None:
        try:
            while chunk := os.read(self.stream.fileno(), 4096):
                self.tail = (self.tail + chunk)[-self.limit :]
        except (OSError, ValueError):
            pass


def register_process(process: subprocess.Popen[bytes], *, group: bool = False) -> None:
    """Register a child that must not outlive this Python process."""

    with _ACTIVE_LOCK:
        _ACTIVE_PROCESSES[process.pid] = (process, group)


def unregister_process(process: subprocess.Popen[bytes]) -> None:
    with _ACTIVE_LOCK:
        _ACTIVE_PROCESSES.pop(process.pid, None)


def _posix_descendants(root_pid: int) -> list[int]:
    """Return descendants deepest-first without relying on Linux-only /proc."""

    try:
        result = subprocess.run(
            ["ps", "-eo", "pid=,ppid="],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    children: dict[int, list[int]] = {}
    for raw in result.stdout.splitlines():
        parts = raw.split()
        if len(parts) != 2:
            continue
        try:
            pid, parent = (int(parts[0]), int(parts[1]))
        except ValueError:
            continue
        children.setdefault(parent, []).append(pid)
    ordered: list[int] = []

    def visit(parent: int) -> None:
        for child in children.get(parent, []):
            visit(child)
            ordered.append(child)

    visit(root_pid)
    return ordered


def terminate_tree(process: subprocess.Popen[bytes], *, group: bool = False) -> None:
    """Stop a worker and its descendants; group requires start_new_session on POSIX."""
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    elif group:
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
    else:
        # External UCI executables are intentionally not moved to their own
        # session because tournament workers already live in an isolated
        # process group. Walk their descendants explicitly so helper processes
        # cannot survive a normal close in the host backend.
        for pid in _posix_descendants(process.pid):
            with suppress(ProcessLookupError, PermissionError):
                os.kill(pid, signal.SIGKILL)
        if process.poll() is None:
            with suppress(ProcessLookupError):
                process.kill()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        with suppress(ProcessLookupError):
            process.kill()
        with suppress(subprocess.TimeoutExpired):
            process.wait(timeout=1)


def terminate_active_processes() -> None:
    """Best-effort emergency cleanup for backend shutdown/restart."""

    with _ACTIVE_LOCK:
        active = list(_ACTIVE_PROCESSES.values())
        _ACTIVE_PROCESSES.clear()
    for process, group in active:
        with suppress(OSError, subprocess.SubprocessError):
            terminate_tree(process, group=group)


atexit.register(terminate_active_processes)
