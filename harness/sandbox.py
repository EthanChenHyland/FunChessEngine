import json
import subprocess
import sys
import time
from pathlib import Path
from typing import IO

from harness.process_io import LineReader, PipeError, TailReader
from harness.rules import STDERR_TAIL_CAP, STDOUT_CAP, WATCHDOG_GRACE_MS

RUNNER = Path(__file__).resolve().parent / "runner.py"


class AgentFailure(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def local(directory: Path) -> "Agent":
    """Run an agent as a process on this machine, through the local runner."""
    return Agent([sys.executable, str(RUNNER), str(directory.resolve())])


class Agent:
    """One isolated engine process managed by the local harness protocol."""

    def __init__(self, command: list[str]) -> None:
        self.command = command
        self.stderr_tail = ""
        self._process: subprocess.Popen[bytes] | None = None
        self.reader: LineReader | None = None
        self.stderr_reader: TailReader | None = None

    def start(self, init_budget_s: float) -> None:
        process = subprocess.Popen(
            self.command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        self._process = process
        self.reader = LineReader(_pipe(process.stdout), line_limit=STDOUT_CAP)
        self.stderr_reader = TailReader(_pipe(process.stderr), STDERR_TAIL_CAP)
        ready = self._await_line(time.monotonic() + init_budget_s)
        if ready is None:
            raise AgentFailure("init" if process.poll() is None else "crash")
        if not _is_ready(ready):
            raise AgentFailure("init")

    def move(self, fen: str, time_left_ms: int) -> str:
        if self._process is None:
            raise RuntimeError("agent moved before start")
        request = json.dumps({"fen": fen, "time_left_ms": time_left_ms}).encode()
        try:
            _pipe(self._process.stdin).write(request + b"\n")
        except BrokenPipeError:
            raise AgentFailure("crash") from None
        line = self._await_line(time.monotonic() + (time_left_ms + WATCHDOG_GRACE_MS) / 1000.0)
        if line is None:
            raise AgentFailure("flag")
        return _parse_move(line)

    def stop(self) -> None:
        if self._process is None:
            return
        if self._process.poll() is None:
            self._process.kill()
        self._process.wait(timeout=5)
        if self.stderr_reader:
            self.stderr_reader.thread.join(timeout=1)
            self.stderr_tail = self.stderr_reader.tail.decode("utf-8", "replace")
        if self.reader:
            self.reader.thread.join(timeout=1)
        for stream in (self._process.stdin, self._process.stdout, self._process.stderr):
            if stream is not None:
                stream.close()
        self._process = None

    def _await_line(self, deadline: float) -> bytes | None:
        if self.reader is None:
            raise AgentFailure("init")
        try:
            return self.reader.readline(deadline)
        except PipeError as exc:
            if "timed out" in str(exc):
                return None
            reason = "crash" if "closed" in str(exc) else "illegal"
            raise AgentFailure(reason) from exc


def _pipe(stream: IO[bytes] | None) -> IO[bytes]:
    if stream is None:
        raise RuntimeError("the agent process exposed no pipe")
    return stream


def _is_ready(line: bytes) -> bool:
    try:
        payload = json.loads(line)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    return isinstance(payload, dict) and payload.get("ready") is True


def _parse_move(line: bytes) -> str:
    try:
        payload = json.loads(line)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise AgentFailure("illegal") from None
    move = payload.get("move") if isinstance(payload, dict) else None
    if not isinstance(move, str):
        raise AgentFailure("illegal")
    return move
