"""Safe synchronous client for optional third-party UCI engines.

The client never uses a shell and never bundles or downloads an engine.  A user
must explicitly select an executable already installed on their machine.
"""

from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

import chess

from harness.process_io import LineReader, PipeError


class UCIClientError(RuntimeError):
    """Raised when an external UCI engine violates the expected protocol."""


@dataclass(frozen=True)
class UCIResult:
    move: str
    elapsed_ms: int
    info: tuple[str, ...]


@dataclass(frozen=True)
class UCIOption:
    name: str
    kind: str
    default: str | None = None
    minimum: int | None = None
    maximum: int | None = None
    choices: tuple[str, ...] = ()


@dataclass(frozen=True)
class UCIAnalysisLine:
    multipv: int
    move: str
    depth: int | None
    seldepth: int | None
    score_cp: int | None
    mate: int | None
    nodes: int | None
    nps: int | None
    pv: tuple[str, ...]


@dataclass(frozen=True)
class UCIAnalysis:
    move: str
    elapsed_ms: int
    engine_name: str
    lines: tuple[UCIAnalysisLine, ...]
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
        self.reader: LineReader | None = None
        self.engine_name = self.executable.name
        self.options: dict[str, UCIOption] = {}

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
            assert self.process.stdout is not None
            self.reader = LineReader(self.process.stdout)
            self._send("uci")
            handshake = self._read_until("uciok")
            self._parse_handshake(handshake)
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
        if self.reader is None:
            raise UCIClientError("UCI engine is not running.")
        try:
            return self.reader.readline(deadline).decode("utf-8", errors="replace")
        except PipeError as exc:
            raise UCIClientError(str(exc)) from exc

    def _read_until(self, terminal: str) -> tuple[str, ...]:
        deadline = time.monotonic() + self.timeout_s
        lines: list[str] = []
        while True:
            line = self._readline(deadline)
            if len(lines) >= 512:
                raise UCIClientError("UCI handshake is too large.")
            lines.append(line)
            if line == terminal:
                return tuple(lines)

    def _parse_handshake(self, lines: tuple[str, ...]) -> None:
        self.options.clear()
        for line in lines:
            if line.startswith("id name "):
                name = line.removeprefix("id name ").strip()
                if name:
                    self.engine_name = name[:160]
            elif line.startswith("option name "):
                option = self._parse_option(line)
                if option is not None:
                    self.options[option.name] = option

    @staticmethod
    def _parse_option(line: str) -> UCIOption | None:
        tokens = line.split()
        if len(tokens) < 5 or tokens[:2] != ["option", "name"] or "type" not in tokens:
            return None
        type_index = tokens.index("type")
        name = " ".join(tokens[2:type_index]).strip()
        if not name or type_index + 1 >= len(tokens):
            return None
        kind = tokens[type_index + 1]
        fields: dict[str, list[str]] = {"default": [], "min": [], "max": [], "var": []}
        current: str | None = None
        for token in tokens[type_index + 2 :]:
            if token in fields:
                current = token
                if token == "var" and fields[token]:
                    fields[token].append("\0")
                continue
            if current is not None:
                fields[current].append(token)
        choices = tuple(
            part.strip()
            for part in " ".join(fields["var"]).split("\0")
            if part.strip()
        )

        def integer(field: str) -> int | None:
            try:
                return int(" ".join(fields[field])) if fields[field] else None
            except ValueError:
                return None

        default = " ".join(fields["default"]).strip() or None
        return UCIOption(name, kind, default, integer("min"), integer("max"), choices)

    def set_option(self, name: str, value: str | int | bool | None = None) -> None:
        if name not in self.options:
            raise ValueError(f"UCI engine does not expose option {name!r}.")
        command = f"setoption name {name}"
        if value is not None:
            rendered = str(value).lower() if isinstance(value, bool) else str(value)
            command += f" value {rendered}"
        self._send(command)
        self._send("isready")
        self._read_until("readyok")

    def configure_strength(
        self,
        elo: int | None = None,
        skill: int | None = None,
    ) -> dict[str, int]:
        """Apply standard UCI strength controls when the selected engine exposes them."""

        applied: dict[str, int] = {}
        if elo is not None and {"UCI_Elo", "UCI_LimitStrength"} <= self.options.keys():
            option = self.options["UCI_Elo"]
            target = int(elo)
            if option.minimum is not None:
                target = max(target, option.minimum)
            if option.maximum is not None:
                target = min(target, option.maximum)
            if "UCI_LimitStrength" in self.options:
                self.set_option("UCI_LimitStrength", True)
            self.set_option("UCI_Elo", target)
            applied["elo"] = target
        if skill is not None and "Skill Level" in self.options:
            option = self.options["Skill Level"]
            target = int(skill)
            if option.minimum is not None:
                target = max(target, option.minimum)
            if option.maximum is not None:
                target = min(target, option.maximum)
            self.set_option("Skill Level", target)
            applied["skill"] = target
        return applied

    def new_game(self, chess960: bool = False) -> None:
        if "UCI_Chess960" in self.options:
            self._send(f"setoption name UCI_Chess960 value {'true' if chess960 else 'false'}")
        self._send("ucinewgame")
        self._send("isready")
        self._read_until("readyok")

    def bestmove(self, fen: str, movetime_ms: int = 250, *, chess960: bool = False) -> UCIResult:
        analysis = self.analyze(fen, movetime_ms, chess960=chess960, multipv=1)
        return UCIResult(analysis.move, analysis.elapsed_ms, analysis.info)

    def analyze(
        self,
        fen: str,
        movetime_ms: int = 250,
        *,
        chess960: bool = False,
        multipv: int = 1,
    ) -> UCIAnalysis:
        board = chess.Board(fen, chess960=chess960)
        if not board.is_valid() or board.is_game_over(claim_draw=True):
            raise ValueError("UCI comparison requires a valid non-terminal position.")
        budget = max(20, min(10_000, int(movetime_ms)))
        line_count = max(1, min(10, int(multipv)))
        if line_count > 1 and "MultiPV" in self.options:
            option = self.options["MultiPV"]
            if option.maximum is not None:
                line_count = min(line_count, option.maximum)
            self.set_option("MultiPV", line_count)
        elif line_count > 1:
            line_count = 1
        self._send(f"position fen {board.fen(shredder=chess960)}")
        started = time.monotonic_ns()
        self._send(f"go movetime {budget}")
        deadline = time.monotonic() + max(self.timeout_s, budget / 1000 + 2.0)
        info: list[str] = []
        parsed: dict[int, UCIAnalysisLine] = {}
        while True:
            line = self._readline(deadline)
            if line.startswith("info "):
                info.append(line)
                if len(info) > 128:
                    del info[0]
                structured = self._parse_info_line(board, line)
                if structured is not None and structured.multipv <= line_count:
                    parsed[structured.multipv] = structured
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
            canonical = board.uci(move, chess960=chess960)
            if 1 not in parsed:
                parsed[1] = UCIAnalysisLine(
                    1,
                    canonical,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    (canonical,),
                )
            return UCIAnalysis(
                canonical,
                elapsed_ms,
                self.engine_name,
                tuple(parsed[index] for index in sorted(parsed) if index <= line_count),
                tuple(info),
            )

    @staticmethod
    def _parse_info_line(board: chess.Board, line: str) -> UCIAnalysisLine | None:
        tokens = line.split()
        if not tokens or tokens[0] != "info" or "pv" not in tokens:
            return None

        def number(name: str) -> int | None:
            if name not in tokens:
                return None
            index = tokens.index(name) + 1
            if index >= len(tokens):
                return None
            try:
                return int(tokens[index])
            except ValueError:
                return None

        pv_index = tokens.index("pv") + 1
        raw_pv = tokens[pv_index:]
        if not raw_pv:
            return None
        pv_board = board.copy(stack=False)
        pv: list[str] = []
        for raw in raw_pv:
            try:
                move = pv_board.parse_uci(raw)
            except ValueError:
                break
            if move not in pv_board.legal_moves:
                break
            pv.append(pv_board.uci(move, chess960=pv_board.chess960))
            pv_board.push(move)
        if not pv:
            return None
        score_cp: int | None = None
        mate: int | None = None
        if "score" in tokens:
            score_index = tokens.index("score") + 1
            if score_index + 1 < len(tokens):
                try:
                    value = int(tokens[score_index + 1])
                except ValueError:
                    value = 0
                if tokens[score_index] == "cp":
                    score_cp = value
                elif tokens[score_index] == "mate":
                    mate = value
        return UCIAnalysisLine(
            multipv=number("multipv") or 1,
            move=pv[0],
            depth=number("depth"),
            seldepth=number("seldepth"),
            score_cp=score_cp,
            mate=mate,
            nodes=number("nodes"),
            nps=number("nps"),
            pv=tuple(pv),
        )


def calibration_score(results: list[float]) -> int:
    """Convert game scores (0/0.5/1) into a conservative local rating estimate."""

    if not results:
        return 1200
    score = sum(max(0.0, min(1.0, float(value))) for value in results) / len(results)
    centered = (score - 0.5) * 1000.0
    return int(max(400, min(3000, round(1500 + centered))))
