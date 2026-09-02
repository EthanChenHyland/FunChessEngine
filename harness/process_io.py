"""Bounded pipe readers that work with subprocesses on Windows, macOS and Linux."""

from __future__ import annotations

import os
import queue
import subprocess
import threading
import time
from contextlib import suppress
from typing import IO


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
        import signal

        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
    elif process.poll() is None:
        process.kill()
    process.wait(timeout=5)
