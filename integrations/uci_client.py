"""Safe synchronous client for optional third-party UCI engines.

The client never uses a shell and never bundles or downloads an engine.  A user
must explicitly select an executable already installed on their machine.
"""

from __future__ import annotations

import os
import select
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

import chess


class UCIClientError(RuntimeError):
    """Raised when an external UCI engine violates the expected protocol."""


@dataclass(frozen=True)
class UCIResult:
    move: str
    elapsed_ms: int
    info: tuple[str, ...]


def validate_engine_path(value: str | os.PathLike[str]) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise ValueError("UCI engine path must point to an existing file.")
    if not os.access(path, os.X_OK):
        raise ValueError("UCI engine file is not executable.")
    return path


class ExternalUCIEngine:
    """Small bounded UCI process wrapper for comparison and calibration tools."""

    def __init__(self, executable: str | os.PathLike[str], timeout_s: float = 5.0) -> None:
        self.executable = validate_engine_path(executable)
        self.timeout_s = max(0.25, min(30.0, float(timeout_s)))
        self.process: subprocess.Popen[bytes] | None = None
        self._stdout_buffer = bytearray()

    def __enter__(self) -> ExternalUCIEngine:
        self.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def start(self) -> None:
        if self.process is not None:
            return
        try:
            self.process = subprocess.Popen(
                [str(self.executable)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                bufsize=0,
                shell=False,
            )
            self._stdout_buffer.clear()
            self._send("uci")
            self._read_until("uciok")
            self._send("isready")
            self._read_until("readyok")
        except Exception:
            self.close()
            raise

    def close(self) -> None:
        process = self.process
        self.process = None
        if process is None:
            return
        try:
            if process.poll() is None and process.stdin:
                process.stdin.write(b"quit\n")
                process.stdin.flush()
                process.wait(timeout=0.5)
        except (BrokenPipeError, subprocess.TimeoutExpired):
            process.kill()
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=1.0)
            if process.stdin is not None:
                process.stdin.close()
            if process.stdout is not None:
                process.stdout.close()

    def _send(self, command: str) -> None:
        process = self.process
        if process is None or process.poll() is not None or process.stdin is None:
            raise UCIClientError("UCI engine process is not running.")
        process.stdin.write(f"{command}\n".encode())
        process.stdin.flush()

    def _readline(self, deadline: float) -> str:
        process = self.process
        if process is None or process.poll() is not None or process.stdout is None:
            raise UCIClientError("UCI engine exited unexpectedly.")
        while True:
            newline = self._stdout_buffer.find(b"\n")
            if newline >= 0:
                raw = bytes(self._stdout_buffer[:newline])
                del self._stdout_buffer[: newline + 1]
                return raw.rstrip(b"\r").decode("utf-8", errors="replace")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise UCIClientError("UCI engine response timed out.")
            readable, _, _ = select.select([process.stdout], [], [], remaining)
            if not readable:
                raise UCIClientError("UCI engine response timed out.")
            chunk = os.read(process.stdout.fileno(), 4096)
            if not chunk:
                raise UCIClientError("UCI engine closed its output stream.")
            self._stdout_buffer.extend(chunk)

    def _read_until(self, terminal: str) -> tuple[str, ...]:
        deadline = time.monotonic() + self.timeout_s
        lines: list[str] = []
        while True:
            line = self._readline(deadline)
            lines.append(line)
            if line == terminal:
                return tuple(lines)

    def new_game(self, chess960: bool = False) -> None:
        self._send(f"setoption name UCI_Chess960 value {'true' if chess960 else 'false'}")
        self._send("ucinewgame")
        self._send("isready")
        self._read_until("readyok")

    def bestmove(self, fen: str, movetime_ms: int = 250, *, chess960: bool = False) -> UCIResult:
        board = chess.Board(fen, chess960=chess960)
        if not board.is_valid() or board.is_game_over(claim_draw=True):
            raise ValueError("UCI comparison requires a valid non-terminal position.")
        budget = max(20, min(10_000, int(movetime_ms)))
        self._send(f"position fen {board.fen(shredder=chess960)}")
        started = time.monotonic_ns()
        self._send(f"go movetime {budget}")
        deadline = time.monotonic() + max(self.timeout_s, budget / 1000 + 2.0)
        info: list[str] = []
        while True:
            line = self._readline(deadline)
            if line.startswith("info "):
                info.append(line)
                continue
            if not line.startswith("bestmove "):
                continue
            parts = line.split()
            if len(parts) < 2 or parts[1] == "0000":
                raise UCIClientError("UCI engine did not return a legal move.")
            move = board.parse_uci(parts[1])
            if move not in board.legal_moves:
                raise UCIClientError("UCI engine returned an illegal move.")
            elapsed_ms = max(0, int((time.monotonic_ns() - started) / 1_000_000))
            return UCIResult(board.uci(move, chess960=chess960), elapsed_ms, tuple(info))


def calibration_score(results: list[float]) -> int:
    """Convert game scores (0/0.5/1) into a conservative local rating estimate."""

    if not results:
        return 1200
    score = sum(max(0.0, min(1.0, float(value))) for value in results) / len(results)
    centered = (score - 0.5) * 1000.0
    return int(max(400, min(3000, round(1500 + centered))))
