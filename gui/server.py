"""Dependency-free local web UI for FunChessEngine.

Run with::

    python -m gui.server

The GUI is local-only.  It is deliberately kept below ``gui/`` so the
engine packager, which includes root-level Python files plus optional
weights, never puts the UI into ``engine-package.zip``.
"""

from __future__ import annotations

import argparse
import errno
import io
import json
import math
import subprocess
import sys
import threading
import time
import webbrowser
from dataclasses import asdict
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import chess
import chess.pgn

import agent
from harness import benchmark as benchmark_harness
from harness.referee import FAILED_TERMINATIONS, play_match
from harness.sandbox import local

if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    ROOT = Path(str(sys._MEIPASS)) / "gui"
else:
    ROOT = Path(__file__).resolve().parent
DEFAULT_CLOCK_MS = 120_000
DEFAULT_INCREMENT_MS = 500

# A compact original opening recognizer for the most common families.  This is
# intentionally local metadata rather than a bundled third-party opening book.
# Longest matching UCI prefix wins.
OPENING_PREFIXES: dict[tuple[str, ...], tuple[str, str]] = {
    ("e2e4",): ("B00", "King's Pawn Game"),
    ("d2d4",): ("A40", "Queen's Pawn Game"),
    ("c2c4",): ("A10", "English Opening"),
    ("g1f3",): ("A04", "Réti Opening"),
    ("e2e4", "c7c5"): ("B20", "Sicilian Defense"),
    ("e2e4", "e7e6"): ("C00", "French Defense"),
    ("e2e4", "c7c6"): ("B10", "Caro-Kann Defense"),
    ("e2e4", "e7e5"): ("C20", "Open Game"),
    ("e2e4", "e7e5", "g1f3", "b8c6", "f1b5"): ("C60", "Ruy Lopez"),
    ("e2e4", "e7e5", "g1f3", "b8c6", "f1c4"): ("C50", "Italian Game"),
    ("e2e4", "e7e5", "g1f3", "g8f6"): ("C42", "Petrov's Defense"),
    ("e2e4", "e7e5", "f2f4"): ("C30", "King's Gambit"),
    ("e2e4", "c7c5", "g1f3", "d7d6"): ("B50", "Sicilian · Modern"),
    ("e2e4", "c7c5", "g1f3", "b8c6"): ("B30", "Sicilian · Old Sicilian"),
    ("e2e4", "c7c5", "g1f3", "e7e6"): ("B40", "Sicilian · French Variation"),
    ("d2d4", "d7d5", "c2c4"): ("D06", "Queen's Gambit"),
    ("d2d4", "d7d5", "c2c4", "e7e6"): ("D30", "Queen's Gambit Declined"),
    ("d2d4", "d7d5", "c2c4", "c7c6"): ("D10", "Slav Defense"),
    ("d2d4", "g8f6", "c2c4", "e7e6"): ("E00", "Indian Game"),
    ("d2d4", "g8f6", "c2c4", "g7g6"): ("E60", "King's Indian Defense"),
    ("d2d4", "g8f6", "c2c4", "e7e6", "b1c3", "f8b4"): ("E20", "Nimzo-Indian Defense"),
    ("c2c4", "e7e5"): ("A20", "English · King's English"),
    ("c2c4", "c7c5"): ("A30", "English · Symmetrical"),
    ("g1f3", "d7d5", "g2g3"): ("A05", "Réti · King's Indian Attack setup"),
}


def _phase_name(board: chess.Board) -> str:
    """Return a coarse human-facing phase label for review summaries."""

    if board.fullmove_number <= 10:
        return "opening"
    queens = len(board.pieces(chess.QUEEN, chess.WHITE)) + len(
        board.pieces(chess.QUEEN, chess.BLACK)
    )
    non_pawn = sum(
        len(board.pieces(piece, color)) * agent.MG_VALUE[piece]
        for color in (chess.WHITE, chess.BLACK)
        for piece in (chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN)
    )
    if queens == 0 or non_pawn <= 2_600:
        return "endgame"
    return "middlegame"


def _opening_from_moves(initial_fen: str, moves: list[str]) -> dict[str, Any] | None:
    if initial_fen != chess.STARTING_FEN:
        return None
    best: tuple[tuple[str, ...], tuple[str, str]] | None = None
    move_tuple = tuple(moves)
    for prefix, metadata in OPENING_PREFIXES.items():
        if (
            len(prefix) <= len(move_tuple)
            and move_tuple[: len(prefix)] == prefix
            and (best is None or len(prefix) > len(best[0]))
        ):
            best = (prefix, metadata)
    if best is None:
        return None
    prefix, (eco, name) = best
    return {"eco": eco, "name": name, "book_plies": len(prefix)}


def _analysis_time_left_ms(board: chess.Board, target_budget_ms: int) -> int:
    """Reverse the rated time manager approximately for local fixed-budget review."""

    target = max(80, min(1_500, int(target_budget_ms)))
    if target <= 180:
        return max(1_001, target * 18)
    non_pawn_material = sum(
        len(board.pieces(piece, color)) * agent.MG_VALUE[piece]
        for color in (chess.WHITE, chess.BLACK)
        for piece in (chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN)
    )
    fraction = 0.018 if non_pawn_material < 2_000 else 0.014
    return max(5_001, int((target - 180) / fraction))


def _analysis_score(info: agent.SearchInfo, board: chess.Board) -> int:
    """Use completed search score, falling back to static eval on a tiny timeout."""

    if info.depth > 0:
        return int(info.score)
    return int(agent.evaluate(board))


def _review_classification(cpl: int, played_is_best: bool, legal_count: int) -> str:
    if legal_count == 1:
        return "Forced"
    if played_is_best:
        return "Best"
    if cpl <= 25:
        return "Excellent"
    if cpl <= 60:
        return "Good"
    if cpl <= 120:
        return "Inaccuracy"
    if cpl <= 250:
        return "Mistake"
    return "Blunder"


def _pv_to_san(board: chess.Board, pv: tuple[str, ...]) -> list[str]:
    replay = board.copy(stack=False)
    result: list[str] = []
    for raw in pv:
        try:
            move = chess.Move.from_uci(raw)
        except ValueError:
            break
        if move not in replay.legal_moves:
            break
        result.append(replay.san(move))
        replay.push(move)
    return result


def _move_explanation(
    board: chess.Board,
    move: chess.Move,
    classification: str,
    best_san: str,
) -> str:
    """Build a deterministic human-facing explanation from chess features."""

    piece = board.piece_at(move.from_square)
    reasons: list[str] = []
    san = board.san(move)
    if board.is_castling(move):
        reasons.append("improves king safety by castling")
    if board.is_capture(move):
        victim = _captured_name(board, move)
        reasons.append(f"captures {victim}" if victim else "makes a capture")
    if move.promotion:
        reasons.append(f"promotes to a {chess.piece_name(move.promotion)}")
    child = board.copy(stack=False)
    child.push(move)
    if child.is_check():
        reasons.append("gives check")
    if piece is not None and piece.piece_type in {chess.KNIGHT, chess.BISHOP}:
        home_rank = 0 if piece.color == chess.WHITE else 7
        if chess.square_rank(move.from_square) == home_rank:
            reasons.append("develops a minor piece")
    if piece is not None and piece.piece_type == chess.PAWN:
        file_index = chess.square_file(move.to_square)
        if file_index in {3, 4}:
            reasons.append("contests the center")
    if not reasons:
        reasons.append("changes piece activity and control of key squares")
    lead = f"{san} {', '.join(reasons[:3])}."
    if classification in {"Mistake", "Blunder", "Inaccuracy"} and san != best_san:
        return f"{lead} The engine preferred {best_san}, which preserves a stronger evaluation."
    if classification in {"Best", "Excellent"}:
        return f"{lead} It keeps the position close to the engine's preferred continuation."
    return lead


def _captured_name(board: chess.Board, move: chess.Move) -> str | None:
    square = move.to_square
    if board.is_en_passant(move):
        square += -8 if board.turn == chess.WHITE else 8
    piece = board.piece_at(square)
    return chess.piece_name(piece.piece_type) if piece is not None else None


def _run_analysis_worker(payload: dict[str, Any]) -> None:
    """Analyze a main line in an isolated process and stream one JSON record per ply."""

    initial_fen = str(payload.get("initial_fen", chess.STARTING_FEN))
    moves_raw = payload.get("moves", [])
    budget_ms = max(80, min(1_500, int(payload.get("budget_ms", 100))))
    if not isinstance(moves_raw, list) or len(moves_raw) > 1_000:
        raise ValueError("Analysis move list is invalid.")
    board = chess.Board(initial_fen)
    if not board.is_valid():
        raise ValueError("Analysis starts from an invalid position.")

    for index, raw in enumerate(moves_raw, start=1):
        move = chess.Move.from_uci(str(raw))
        if move not in board.legal_moves:
            raise ValueError(f"Analysis move {move.uci()} is illegal at ply {index}.")
        mover = board.turn
        fen_before = board.fen()
        phase = _phase_name(board)
        legal_count = board.legal_moves.count()
        played_san = board.san(move)

        agent.reset_game_state()
        best_uci = agent.get_move(board.fen(), _analysis_time_left_ms(board, budget_ms))
        best_info = agent.LAST_SEARCH_INFO
        best_score_mover = _analysis_score(best_info, board)
        best_move = chess.Move.from_uci(best_uci)
        best_san = board.san(best_move) if best_move in board.legal_moves else best_uci
        pv_san = _pv_to_san(board, best_info.pv)

        child = board.copy(stack=False)
        child.push(move)
        terminal = agent._terminal_score(child, 1)
        if terminal is not None:
            played_score_mover = -int(terminal)
        else:
            agent.reset_game_state()
            agent.get_move(child.fen(), _analysis_time_left_ms(child, budget_ms))
            child_info = agent.LAST_SEARCH_INFO
            played_score_mover = -_analysis_score(child_info, child)

        best_for_loss = max(-2_000, min(2_000, best_score_mover))
        played_for_loss = max(-2_000, min(2_000, played_score_mover))
        cpl = 0 if move == best_move else max(0, best_for_loss - played_for_loss)
        classification = _review_classification(cpl, move == best_move, legal_count)
        eval_after_white = played_score_mover if mover == chess.WHITE else -played_score_mover
        best_eval_white = best_score_mover if mover == chess.WHITE else -best_score_mover
        explanation = _move_explanation(board, move, classification, best_san)
        record = {
            "type": "move",
            "ply": index,
            "mover": "white" if mover == chess.WHITE else "black",
            "played_uci": move.uci(),
            "played_san": played_san,
            "fen_before": fen_before,
            "phase": phase,
            "explanation": explanation,
            "best_uci": best_uci,
            "best_san": best_san,
            "classification": classification,
            "cpl": cpl,
            "eval_after_white": eval_after_white,
            "best_eval_white": best_eval_white,
            "depth": int(best_info.depth),
            "nodes": int(best_info.nodes),
            "pv": list(best_info.pv),
            "pv_san": pv_san,
        }
        print(json.dumps(record, separators=(",", ":")), flush=True)
        board.push(move)
    print(json.dumps({"type": "done"}), flush=True)


def _run_multipv_worker(payload: dict[str, Any]) -> None:
    """Search all legal root moves to expose a few comparable candidate lines."""

    board = chess.Board(str(payload.get("fen", chess.STARTING_FEN)))
    if not board.is_valid() or board.is_game_over(claim_draw=True):
        raise ValueError("MultiPV requires a valid non-terminal chess position.")
    line_count = max(1, min(5, int(payload.get("lines", 3))))
    budget_ms = max(100, min(2_000, int(payload.get("budget_ms", 350))))
    legal = list(board.legal_moves)
    if not legal:
        raise ValueError("There are no legal candidate moves in this position.")

    agent.reset_game_state()
    agent.NODES = 0
    started_ns = time.monotonic_ns()
    agent.DEADLINE_NS = started_ns + max(20, budget_ms - 8) * 1_000_000
    preferred = agent.TT.get(agent._key(board))
    preferred_move = preferred.move if preferred is not None else None
    completed: list[tuple[int, chess.Move]] = []
    completed_depth = 0

    for depth in range(1, 16):
        if time.monotonic_ns() >= agent.DEADLINE_NS:
            break
        current: list[tuple[int, chess.Move]] = []
        try:
            for move in agent._ordered_moves(board, preferred_move, 0):
                board.push(move)
                try:
                    score = -agent.negamax(board, depth - 1, -agent.INF, agent.INF, 1)
                finally:
                    board.pop()
                current.append((score, move))
        except agent.SearchTimeout:
            while board.move_stack:
                board.pop()
            break
        if len(current) == len(legal):
            completed = current
            completed_depth = depth
            preferred_move = max(current, key=lambda item: item[0])[1]

    if not completed:
        for move in legal:
            board.push(move)
            score = -agent.evaluate(board)
            board.pop()
            completed.append((score, move))

    completed.sort(key=lambda item: item[0], reverse=True)
    result_lines: list[dict[str, Any]] = []
    for rank, (score, move) in enumerate(completed[:line_count], start=1):
        san = board.san(move)
        board.push(move)
        tail = agent._principal_variation(board, max_length=7)
        board.pop()
        pv = (move.uci(), *tail)
        result_lines.append(
            {
                "rank": rank,
                "move": move.uci(),
                "san": san,
                "score": int(score),
                "pv": list(pv),
                "pv_san": _pv_to_san(board, pv),
            }
        )
    elapsed_ms = max(0, (time.monotonic_ns() - started_ns) // 1_000_000)
    print(
        json.dumps(
            {
                "depth": completed_depth,
                "nodes": int(agent.NODES),
                "elapsed_ms": int(elapsed_ms),
                "lines": result_lines,
            },
            separators=(",", ":"),
        ),
        flush=True,
    )


def _run_benchmark_worker(payload: dict[str, Any]) -> None:
    """Run the repeatable position suite in an isolated process."""

    clock_ms = max(1_500, min(30_000, int(payload.get("clock_ms", 10_000))))
    agent.reset_game_state()
    rows = benchmark_harness.benchmark(agent, clock_ms)
    result: dict[str, Any] = {
        "clock_ms": clock_ms,
        "summary": benchmark_harness.summary(rows),
        "positions": [asdict(row) for row in rows],
    }
    compare_raw = str(payload.get("compare_path", "")).strip()
    if compare_raw:
        compare = Path(compare_raw).expanduser().resolve()
        if not (compare / "agent.py").is_file():
            raise ValueError("Comparison path must be a directory containing agent.py.")
        other = benchmark_harness.benchmark(benchmark_harness.load_agent(compare), clock_ms)
        left = benchmark_harness.summary(rows)
        right = benchmark_harness.summary(other)
        result["comparison"] = {
            "path": str(compare),
            "summary": right,
            "depth_delta": float(left["mean_depth"]) - float(right["mean_depth"]),
            "nps_delta": int(left["aggregate_nps"]) - int(right["aggregate_nps"]),
            "changed_moves": sum(
                a.move != b.move for a, b in zip(rows, other, strict=True)
            ),
        }
    print(json.dumps(result, separators=(",", ":")), flush=True)


def _run_arena_worker(payload: dict[str, Any]) -> None:
    """Run a paired source-checkout A/B match and return aggregate results."""

    if getattr(sys, "frozen", False):
        raise ValueError("A/B matches require the source checkout so agent.py can be sandboxed.")
    opponent = Path(str(payload.get("opponent_path", ""))).expanduser().resolve()
    project = ROOT.parent.resolve()
    if not (project / "agent.py").is_file():
        raise ValueError("Current source checkout does not contain agent.py.")
    if not (opponent / "agent.py").is_file():
        raise ValueError("Opponent path must be a directory containing agent.py.")
    games = max(2, min(40, int(payload.get("games", 6))))
    if games % 2:
        games += 1
    base_ms = max(1_000, min(30_000, int(payload.get("base_ms", 5_000))))
    increment_ms = max(0, min(2_000, int(payload.get("increment_ms", 100))))
    wins = draws = losses = 0
    terminations: dict[str, int] = {}
    for game in range(games):
        plays_white = game % 2 == 0
        white, black = (project, opponent) if plays_white else (opponent, project)
        outcome = play_match(local(white), local(black), base_ms, increment_ms)
        terminations[outcome.termination] = terminations.get(outcome.termination, 0) + 1
        if outcome.result in {"draw", "void"}:
            draws += 1
        elif (outcome.result == "white") == plays_white:
            wins += 1
        else:
            losses += 1
    broken = {name: count for name, count in terminations.items() if name in FAILED_TERMINATIONS}
    if broken:
        raise RuntimeError(
            "A/B match contained engine failures: "
            + ", ".join(f"{name} {count}" for name, count in broken.items())
        )
    print(
        json.dumps(
            {
                "opponent_path": str(opponent),
                "games": games,
                "base_ms": base_ms,
                "increment_ms": increment_ms,
                "wins": wins,
                "draws": draws,
                "losses": losses,
                "score": (wins + draws / 2) / games,
                "terminations": terminations,
            },
            separators=(",", ":"),
        ),
        flush=True,
    )


class GameSession:
    """Owns one local board and the clocks used by the browser UI."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.board = chess.Board()
        self.initial_fen = chess.STARTING_FEN
        self.white_ms = DEFAULT_CLOCK_MS
        self.black_ms = DEFAULT_CLOCK_MS
        self.base_clock_ms = DEFAULT_CLOCK_MS
        self.increment_ms = DEFAULT_INCREMENT_MS
        self.last_move: chess.Move | None = None
        self.last_engine_ms = 0
        self.last_engine_nodes = 0
        self.last_engine_depth: int | None = None
        self.last_engine_score: int | None = None
        self.last_engine_pv: tuple[str, ...] = ()
        self.last_engine_researches = 0
        self.history: list[tuple[int, int]] = []
        self.paused = False
        self.manual_result: str | None = None
        self.manual_termination: str | None = None
        self.pgn_headers: dict[str, str] = {}
        self.analysis_status = "idle"
        self.analysis_completed = 0
        self.analysis_total = 0
        self.analysis_results: list[dict[str, Any]] = []
        self.analysis_error: str | None = None
        self.analysis_budget_ms = 100
        self.analysis_generation = 0
        self.analysis_process: subprocess.Popen[str] | None = None
        self.turn_started_ns = time.monotonic_ns()

    def _cancel_analysis_locked(self) -> None:
        """Invalidate and stop a local post-game analysis worker if one exists."""

        self.analysis_generation += 1
        process = self.analysis_process
        self.analysis_process = None
        if process is not None and process.poll() is None:
            process.terminate()
        self.analysis_status = "idle"
        self.analysis_completed = 0
        self.analysis_total = 0
        self.analysis_results = []
        self.analysis_error = None

    def reset(
        self,
        fen: str = chess.STARTING_FEN,
        clock_ms: int = DEFAULT_CLOCK_MS,
        increment_ms: int = DEFAULT_INCREMENT_MS,
    ) -> None:
        board = chess.Board(fen)
        if not board.is_valid():
            raise ValueError(
                "Invalid chess position. Check that both kings exist, pawns are off the back "
                "ranks, kings are not adjacent, and castling/en-passant rights match the board."
            )
        with self.lock:
            self._cancel_analysis_locked()
            agent.reset_game_state()
            self.board = board
            self.initial_fen = fen
            self.white_ms = max(1, int(clock_ms))
            self.black_ms = max(1, int(clock_ms))
            self.base_clock_ms = max(1, int(clock_ms))
            self.increment_ms = max(0, int(increment_ms))
            self.last_move = None
            self.last_engine_ms = 0
            self.last_engine_nodes = 0
            self.last_engine_depth = None
            self.last_engine_score = None
            self.last_engine_pv = ()
            self.last_engine_researches = 0
            self.history.clear()
            self.paused = False
            self.manual_result = None
            self.manual_termination = None
            self.pgn_headers = {}
            self.turn_started_ns = time.monotonic_ns()

    def _current_clocks(self, now_ns: int | None = None) -> tuple[int, int]:
        """Return live clock values without mutating the stored turn baseline."""

        white_ms = self.white_ms
        black_ms = self.black_ms
        if (
            self.paused
            or self.manual_result is not None
            or self.board.is_game_over(claim_draw=True)
        ):
            return max(0, white_ms), max(0, black_ms)
        now = time.monotonic_ns() if now_ns is None else now_ns
        elapsed_ms = max(0, (now - self.turn_started_ns) // 1_000_000)
        if self.board.turn == chess.WHITE:
            white_ms -= elapsed_ms
        else:
            black_ms -= elapsed_ms
        return max(0, int(white_ms)), max(0, int(black_ms))

    def _commit_clock(self) -> None:
        now = time.monotonic_ns()
        self.white_ms, self.black_ms = self._current_clocks(now)
        self.turn_started_ns = now

    def _clock_flag(self, white_ms: int, black_ms: int) -> chess.Color | None:
        if self.manual_result is not None or self.board.is_game_over(claim_draw=True):
            return None
        if self.board.turn == chess.WHITE and white_ms <= 0:
            return chess.WHITE
        if self.board.turn == chess.BLACK and black_ms <= 0:
            return chess.BLACK
        return None

    def _moves_uci(self) -> list[str]:
        return [move.uci() for move in self.board.move_stack]

    @staticmethod
    def _captures(board: chess.Board) -> tuple[list[str], list[str]]:
        replay = chess.Board(board.root().fen())
        by_white: list[str] = []
        by_black: list[str] = []
        for move in board.move_stack:
            captured: chess.Piece | None = None
            if replay.is_capture(move):
                if replay.is_en_passant(move):
                    offset = -8 if replay.turn == chess.WHITE else 8
                    captured = replay.piece_at(move.to_square + offset)
                else:
                    captured = replay.piece_at(move.to_square)
            if captured is not None:
                (by_white if replay.turn == chess.WHITE else by_black).append(captured.symbol())
            replay.push(move)
        return by_white, by_black

    @staticmethod
    def _material_balance(board: chess.Board) -> int:
        values = {
            chess.PAWN: 1,
            chess.KNIGHT: 3,
            chess.BISHOP: 3,
            chess.ROOK: 5,
            chess.QUEEN: 9,
        }
        white = sum(
            len(board.pieces(piece, chess.WHITE)) * value for piece, value in values.items()
        )
        black = sum(
            len(board.pieces(piece, chess.BLACK)) * value for piece, value in values.items()
        )
        return white - black

    def load_snapshot(self, payload: dict[str, Any]) -> None:
        """Restore a game exported by the local Engine Lab."""

        initial_fen = str(payload.get("initial_fen", chess.STARTING_FEN))
        moves_raw = payload.get("moves", [])
        history_raw = payload.get("clock_history", [])
        if not isinstance(moves_raw, list) or len(moves_raw) > 1_000:
            raise ValueError("Saved game contains an invalid move list.")
        if not isinstance(history_raw, list) or len(history_raw) > 1_000:
            raise ValueError("Saved game contains invalid clock history.")

        board = chess.Board(initial_fen)
        if not board.is_valid():
            raise ValueError("Saved game starts from an invalid chess position.")
        moves: list[chess.Move] = []
        for raw in moves_raw:
            try:
                move = chess.Move.from_uci(str(raw))
            except ValueError as exc:
                raise ValueError("Saved game contains a malformed move.") from exc
            if move not in board.legal_moves:
                raise ValueError(f"Saved game contains illegal move {move.uci()}.")
            board.push(move)
            moves.append(move)

        history: list[tuple[int, int]] = []
        for item in history_raw:
            if not isinstance(item, list) or len(item) != 2:
                raise ValueError("Saved game contains invalid clock history.")
            history.append((max(0, int(item[0])), max(0, int(item[1]))))
        if history and len(history) != len(moves):
            raise ValueError("Saved game clock history does not match its moves.")

        with self.lock:
            self._cancel_analysis_locked()
            agent.reset_game_state()
            self.board = board
            self.initial_fen = initial_fen
            self.white_ms = max(0, int(payload.get("white_ms", DEFAULT_CLOCK_MS)))
            self.black_ms = max(0, int(payload.get("black_ms", DEFAULT_CLOCK_MS)))
            self.base_clock_ms = max(
                1, int(payload.get("base_clock_ms", max(self.white_ms, self.black_ms, 1)))
            )
            self.increment_ms = max(0, int(payload.get("increment_ms", DEFAULT_INCREMENT_MS)))
            self.last_move = moves[-1] if moves else None
            self.last_engine_ms = 0
            self.last_engine_nodes = 0
            self.last_engine_depth = None
            self.last_engine_score = None
            self.last_engine_pv = ()
            self.last_engine_researches = 0
            self.history = history if history else [
                (self.white_ms, self.black_ms) for _ in moves
            ]
            self.paused = bool(payload.get("paused", False))
            manual_result = payload.get("manual_result")
            manual_termination = payload.get("manual_termination")
            self.manual_result = (
                str(manual_result)
                if manual_result in {"1-0", "0-1", "1/2-1/2"}
                else None
            )
            self.manual_termination = (
                str(manual_termination) if self.manual_result is not None else None
            )
            headers_raw = payload.get("pgn_headers", {})
            self.pgn_headers = (
                {
                    str(key): str(value)
                    for key, value in headers_raw.items()
                    if isinstance(key, str) and isinstance(value, str)
                }
                if isinstance(headers_raw, dict)
                else {}
            )
            self.turn_started_ns = time.monotonic_ns()

    @staticmethod
    def _white_eval(board: chess.Board) -> int:
        score = agent.evaluate(board)
        return score if board.turn == chess.WHITE else -score

    @classmethod
    def _position_payload(
        cls,
        board: chess.Board,
        last_move: chess.Move | None = None,
    ) -> dict[str, Any]:
        captured_by_white, captured_by_black = cls._captures(board)
        legal = list(board.legal_moves)
        return {
            "fen": board.fen(),
            "turn": "white" if board.turn == chess.WHITE else "black",
            "board": cls._board_payload(board),
            "legal_moves": [move.uci() for move in legal],
            "legal_san": {move.uci(): board.san(move) for move in legal},
            "last_move": last_move.uci() if last_move else None,
            "eval_cp": cls._white_eval(board),
            "check": board.is_check(),
            "game_over": board.is_game_over(claim_draw=True),
            "captured_by_white": captured_by_white,
            "captured_by_black": captured_by_black,
            "material_balance": cls._material_balance(board),
            "phase": _phase_name(board),
        }

    def position_from_fen(self, fen: str) -> dict[str, Any]:
        board = chess.Board(fen)
        if not board.is_valid():
            raise ValueError("Analysis workspace requires a valid chess position.")
        return self._position_payload(board)

    def variation_move(self, fen: str, uci: str) -> dict[str, Any]:
        board = chess.Board(fen)
        if not board.is_valid():
            raise ValueError("Variation starts from an invalid chess position.")
        try:
            move = chess.Move.from_uci(uci)
        except ValueError as exc:
            raise ValueError("Variation move is malformed.") from exc
        if move not in board.legal_moves:
            raise ValueError("Variation move is not legal in this position.")
        san = board.san(move)
        board.push(move)
        result = self._position_payload(board, move)
        result["move_uci"] = move.uci()
        result["move_san"] = san
        return result

    def evaluation_breakdown(self, fen: str) -> dict[str, Any]:
        """Expose a compact white-perspective decomposition for the local GUI."""

        board = chess.Board(fen)
        if not board.is_valid():
            raise ValueError("Evaluation breakdown requires a valid chess position.")
        material = 0
        for piece_type in range(chess.PAWN, chess.KING):
            material += agent.MG_VALUE[piece_type] * (
                len(board.pieces(piece_type, chess.WHITE))
                - len(board.pieces(piece_type, chess.BLACK))
            )
        mobility = 3 * (
            agent._mobility(board, chess.WHITE) - agent._mobility(board, chess.BLACK)
        )
        king_safety = agent._king_safety(board, chess.WHITE) - agent._king_safety(
            board, chess.BLACK
        )
        total = self._white_eval(board)
        positional = total - material - mobility - king_safety
        return {
            "fen": board.fen(),
            "total": int(total),
            "material": int(material),
            "mobility": int(mobility),
            "king_safety": int(king_safety),
            "position_pawns": int(positional),
        }

    def load_pgn(self, text: str) -> None:
        """Load the main line of one PGN as a paused/reviewable game."""

        if not text.strip():
            raise ValueError("PGN file is empty.")
        if len(text.encode("utf-8")) > 2 * 1024 * 1024:
            raise ValueError("PGN file is too large for the local review workspace.")

        try:
            game = chess.pgn.read_game(io.StringIO(text))
        except (ValueError, UnicodeError) as exc:
            raise ValueError("Could not parse this PGN.") from exc
        if game is None:
            raise ValueError("No chess game was found in this PGN.")

        board = game.board()
        if not board.is_valid():
            raise ValueError("PGN starts from an invalid chess position.")
        initial_fen = board.fen()
        moves: list[chess.Move] = []
        for move in game.mainline_moves():
            if move not in board.legal_moves:
                raise ValueError(f"PGN contains illegal move {move.uci()}.")
            board.push(move)
            moves.append(move)
            if len(moves) > 1_000:
                raise ValueError("PGN contains too many moves for the local review workspace.")

        headers = {
            str(key): str(value)
            for key, value in game.headers.items()
            if str(value) not in {"?", ""}
        }
        result = headers.get("Result")
        with self.lock:
            self._cancel_analysis_locked()
            agent.reset_game_state()
            self.board = board
            self.initial_fen = initial_fen
            self.white_ms = self.base_clock_ms
            self.black_ms = self.base_clock_ms
            self.last_move = moves[-1] if moves else None
            self.last_engine_ms = 0
            self.last_engine_nodes = 0
            self.last_engine_depth = None
            self.last_engine_score = None
            self.last_engine_pv = ()
            self.last_engine_researches = 0
            self.history = [(self.base_clock_ms, self.base_clock_ms) for _ in moves]
            self.paused = True
            self.manual_result = result if result in {"1-0", "0-1", "1/2-1/2"} else None
            self.manual_termination = (
                headers.get("Termination", "pgn_import") if self.manual_result is not None else None
            )
            self.pgn_headers = headers
            self.turn_started_ns = time.monotonic_ns()

    def export_pgn(self) -> str:
        """Return the current main line as a standards-compatible PGN string."""

        with self.lock:
            game = chess.pgn.Game()
            for key, value in self.pgn_headers.items():
                game.headers[key] = value
            if self.initial_fen != chess.STARTING_FEN:
                game.setup(chess.Board(self.initial_fen))

            node: chess.pgn.GameNode = game
            replay = chess.Board(self.initial_fen)
            for move in self.board.move_stack:
                if move not in replay.legal_moves:
                    raise RuntimeError("Current game history cannot be exported as legal PGN.")
                node = node.add_variation(move)
                replay.push(move)

            state = self.state()
            result = state["result"] or "*"
            game.headers["Result"] = str(result)
            if state["termination"]:
                game.headers["Termination"] = str(state["termination"]).replace("_", " ")
            return str(game)

    def review_state(self, ply: int) -> dict[str, Any]:
        """Return a board snapshot at a main-line ply without mutating the live game."""

        with self.lock:
            total = len(self.board.move_stack)
            target = max(0, min(int(ply), total))
            replay = chess.Board(self.initial_fen)
            moves = list(self.board.move_stack)
            for move in moves[:target]:
                replay.push(move)
            last_move = moves[target - 1].uci() if target else None
            captured_by_white, captured_by_black = self._captures(replay)
            opening = _opening_from_moves(self.initial_fen, [move.uci() for move in moves[:target]])
            return {
                "ply": target,
                "total_plies": total,
                "fen": replay.fen(),
                "turn": "white" if replay.turn == chess.WHITE else "black",
                "board": self._board_payload(replay),
                "legal_moves": [move.uci() for move in replay.legal_moves],
                "legal_san": {move.uci(): replay.san(move) for move in replay.legal_moves},
                "last_move": last_move,
                "eval_cp": self._white_eval(replay),
                "check": replay.is_check(),
                "captured_by_white": captured_by_white,
                "captured_by_black": captured_by_black,
                "material_balance": self._material_balance(replay),
                "phase": _phase_name(replay),
                "opening": opening,
            }

    def review_series(self) -> dict[str, Any]:
        """Return static white-perspective evaluations for each main-line ply."""

        with self.lock:
            replay = chess.Board(self.initial_fen)
            values = [self._white_eval(replay)]
            labels = ["Start"]
            for index, move in enumerate(self.board.move_stack, start=1):
                san = replay.san(move)
                replay.push(move)
                values.append(self._white_eval(replay))
                move_number = (index + 1) // 2
                labels.append(f"{move_number}.{'..' if index % 2 == 0 else ''}{san}")
            return {"evals": values, "labels": labels, "total_plies": len(self.board.move_stack)}

    def _analysis_summary_locked(self) -> dict[str, Any]:
        by_side: dict[str, list[int]] = {"white": [], "black": []}
        phase_cpl: dict[str, list[int]] = {"opening": [], "middlegame": [], "endgame": []}
        class_counts: dict[str, int] = {}
        counts = {"Inaccuracy": 0, "Mistake": 0, "Blunder": 0}
        biggest: dict[str, Any] | None = None
        for result in self.analysis_results:
            mover = str(result.get("mover", "white"))
            cpl = max(0, int(result.get("cpl", 0)))
            if mover in by_side:
                by_side[mover].append(cpl)
            classification = str(result.get("classification", ""))
            class_counts[classification] = class_counts.get(classification, 0) + 1
            if classification in counts:
                counts[classification] += 1
            phase = str(result.get("phase", "middlegame"))
            if phase in phase_cpl:
                phase_cpl[phase].append(cpl)
            if biggest is None or cpl > int(biggest.get("cpl", -1)):
                biggest = result
        all_cpl = [max(0, int(result.get("cpl", 0))) for result in self.analysis_results]
        # FunChess Accuracy is intentionally our own transparent local metric.
        accuracy = (
            round(
                sum(100.0 * math.exp(-value / 300.0) for value in all_cpl) / len(all_cpl),
                1,
            )
            if all_cpl
            else 0.0
        )
        return {
            "white_avg_cpl": round(sum(by_side["white"]) / len(by_side["white"]), 1)
            if by_side["white"]
            else 0.0,
            "black_avg_cpl": round(sum(by_side["black"]) / len(by_side["black"]), 1)
            if by_side["black"]
            else 0.0,
            "inaccuracies": counts["Inaccuracy"],
            "mistakes": counts["Mistake"],
            "blunders": counts["Blunder"],
            "accuracy": accuracy,
            "classifications": class_counts,
            "phase_avg_cpl": {
                phase: round(sum(values) / len(values), 1) if values else None
                for phase, values in phase_cpl.items()
            },
            "biggest_turning_point": biggest,
        }

    def analysis_state(self) -> dict[str, Any]:
        with self.lock:
            return {
                "status": self.analysis_status,
                "completed": self.analysis_completed,
                "total": self.analysis_total,
                "budget_ms": self.analysis_budget_ms,
                "error": self.analysis_error,
                "results": list(self.analysis_results),
                "summary": self._analysis_summary_locked(),
            }

    def multipv(self, ply: int, lines: int = 3, budget_ms: int = 350) -> dict[str, Any]:
        """Analyze one main-line position in a short-lived isolated worker process."""

        with self.lock:
            total = len(self.board.move_stack)
            target = max(0, min(int(ply), total))
            replay = chess.Board(self.initial_fen)
            for move in list(self.board.move_stack)[:target]:
                replay.push(move)
            worker_budget = max(100, min(2_000, int(budget_ms)))
            payload = {
                "fen": replay.fen(),
                "lines": max(1, min(5, int(lines))),
                "budget_ms": worker_budget,
            }
        return self._multipv_payload(
            payload,
            target=target,
            total=total,
            turn="white" if replay.turn == chess.WHITE else "black",
        )

    def multipv_fen(self, fen: str, lines: int = 3, budget_ms: int = 350) -> dict[str, Any]:
        """Analyze an arbitrary valid position without touching the live game."""

        board = chess.Board(fen)
        if not board.is_valid() or board.is_game_over(claim_draw=True):
            raise ValueError("MultiPV requires a valid non-terminal chess position.")
        worker_budget = max(100, min(2_000, int(budget_ms)))
        payload = {
            "fen": board.fen(),
            "lines": max(1, min(5, int(lines))),
            "budget_ms": worker_budget,
        }
        return self._multipv_payload(
            payload,
            target=-1,
            total=len(self.board.move_stack),
            turn="white" if board.turn == chess.WHITE else "black",
        )

    def _multipv_payload(
        self,
        payload: dict[str, Any],
        *,
        target: int,
        total: int,
        turn: str,
    ) -> dict[str, Any]:
        worker_budget = int(payload["budget_ms"])
        if getattr(sys, "frozen", False):
            command = [sys.executable, "--multipv-worker"]
        else:
            command = [sys.executable, "-m", "gui.server", "--multipv-worker"]
        completed = subprocess.run(
            command,
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            cwd=str(Path(__file__).resolve().parents[1]),
            timeout=max(8.0, worker_budget / 1_000 * 5 + 3),
            check=False,
        )
        if completed.returncode != 0:
            detail = (
                completed.stdout.strip()
                or completed.stderr.strip()
                or "MultiPV worker failed."
            )
            try:
                message = json.loads(detail.splitlines()[-1])
                detail = str(message.get("error", detail))
            except json.JSONDecodeError:
                pass
            raise RuntimeError(detail)
        lines_out = [line for line in completed.stdout.splitlines() if line.strip()]
        if not lines_out:
            raise RuntimeError("MultiPV worker returned no result.")
        result = json.loads(lines_out[-1])
        if not isinstance(result, dict):
            raise RuntimeError("MultiPV worker returned an invalid result.")
        result["ply"] = target
        result["total_plies"] = total
        result["turn"] = turn
        result["fen"] = str(payload["fen"])
        return result

    @staticmethod
    def _run_json_worker(flag: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        if getattr(sys, "frozen", False):
            command = [sys.executable, flag]
        else:
            command = [sys.executable, "-m", "gui.server", flag]
        completed = subprocess.run(
            command,
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            cwd=str(Path(__file__).resolve().parents[1]),
            timeout=timeout,
            check=False,
        )
        output = [line for line in completed.stdout.splitlines() if line.strip()]
        if completed.returncode != 0 or not output:
            detail = (
                output[-1]
                if output
                else completed.stderr.strip()
                or f"Worker {flag} failed without output."
            )
            try:
                message = json.loads(detail)
                detail = str(message.get("error", detail))
            except json.JSONDecodeError:
                pass
            raise RuntimeError(detail)
        result = json.loads(output[-1])
        if not isinstance(result, dict):
            raise RuntimeError(f"Worker {flag} returned an invalid result.")
        return result

    def benchmark_engine(self, clock_ms: int = 10_000, compare_path: str = "") -> dict[str, Any]:
        """Run the development benchmark outside the live engine process."""

        clock = max(1_500, min(30_000, int(clock_ms)))
        payload = {"clock_ms": clock, "compare_path": str(compare_path).strip()}
        # The clock-aware manager allocates only a small fraction of clock_ms per
        # position, but leave ample headroom for 12 positions plus a comparison.
        return self._run_json_worker("--benchmark-worker", payload, timeout=45.0)

    def arena_compare(
        self,
        opponent_path: str,
        games: int = 6,
        base_ms: int = 5_000,
        increment_ms: int = 100,
    ) -> dict[str, Any]:
        """Run a paired A/B match from a source checkout."""

        payload = {
            "opponent_path": str(opponent_path).strip(),
            "games": int(games),
            "base_ms": int(base_ms),
            "increment_ms": int(increment_ms),
        }
        game_count = max(2, min(40, int(games)))
        return self._run_json_worker(
            "--arena-worker",
            payload,
            timeout=max(60.0, game_count * max(8.0, base_ms / 1_000 * 3)),
        )

    def start_analysis(self, budget_ms: int = 100) -> dict[str, Any]:
        """Start isolated main-line analysis without touching the live agent search state."""

        with self.lock:
            moves = self._moves_uci()
            if not moves:
                raise ValueError("Play or import at least one move before analyzing the game.")
            self._cancel_analysis_locked()
            if not self.paused and self.manual_result is None and not self.board.is_game_over(
                claim_draw=True
            ):
                self._commit_clock()
                self.paused = True
            self.analysis_budget_ms = max(80, min(1_500, int(budget_ms)))
            self.analysis_status = "running"
            self.analysis_total = len(moves)
            self.analysis_completed = 0
            self.analysis_results = []
            self.analysis_error = None
            generation = self.analysis_generation
            payload = {
                "initial_fen": self.initial_fen,
                "moves": moves,
                "budget_ms": self.analysis_budget_ms,
            }
        thread = threading.Thread(
            target=self._analysis_thread_main,
            args=(generation, payload),
            daemon=True,
            name="game-analysis",
        )
        thread.start()
        return self.analysis_state()

    def cancel_analysis(self) -> dict[str, Any]:
        with self.lock:
            self._cancel_analysis_locked()
            return self.analysis_state()

    def _analysis_thread_main(self, generation: int, payload: dict[str, Any]) -> None:
        if getattr(sys, "frozen", False):
            command = [sys.executable, "--analysis-worker"]
        else:
            command = [sys.executable, "-m", "gui.server", "--analysis-worker"]
        process: subprocess.Popen[str] | None = None
        try:
            process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                cwd=str(Path(__file__).resolve().parents[1]),
            )
            with self.lock:
                if generation != self.analysis_generation:
                    process.terminate()
                    return
                self.analysis_process = process
            assert process.stdin is not None
            assert process.stdout is not None
            process.stdin.write(json.dumps(payload))
            process.stdin.close()
            with process.stdout:
                for line in process.stdout:
                    try:
                        message = json.loads(line)
                    except json.JSONDecodeError as exc:
                        if line.strip():
                            raise RuntimeError(line.strip()) from exc
                        continue
                    with self.lock:
                        if generation != self.analysis_generation:
                            process.terminate()
                            return
                        if message.get("type") == "move":
                            self.analysis_results.append(message)
                            self.analysis_completed = len(self.analysis_results)
                        elif message.get("type") == "done":
                            self.analysis_status = "complete"
                        elif message.get("type") == "error":
                            self.analysis_status = "error"
                            self.analysis_error = str(
                                message.get("error", "Analysis worker failed.")
                            )
            return_code = process.wait()
            with self.lock:
                if generation != self.analysis_generation:
                    return
                self.analysis_process = None
                if return_code != 0 and self.analysis_status != "complete":
                    self.analysis_status = "error"
                    self.analysis_error = f"Analysis worker exited with code {return_code}."
                elif self.analysis_status == "running":
                    self.analysis_status = "complete"
        except Exception as exc:
            if process is not None and process.poll() is None:
                process.terminate()
            with self.lock:
                if generation != self.analysis_generation:
                    return
                self.analysis_process = None
                self.analysis_status = "error"
                self.analysis_error = str(exc)

    def state(self) -> dict[str, Any]:
        with self.lock:
            board = self.board
            outcome = board.outcome(claim_draw=True)
            white_ms, black_ms = self._current_clocks()
            flagged = self._clock_flag(white_ms, black_ms)
            captured_by_white, captured_by_black = self._captures(board)
            legal_moves = [move.uci() for move in board.legal_moves]
            legal_san = {move.uci(): board.san(move) for move in board.legal_moves}
            eval_cp = self._white_eval(board)
            opening = _opening_from_moves(self.initial_fen, self._moves_uci())
            return {
                "fen": board.fen(),
                "turn": "white" if board.turn == chess.WHITE else "black",
                "board": self._board_payload(board),
                "legal_moves": legal_moves,
                "legal_san": legal_san,
                "last_move": self.last_move.uci() if self.last_move else None,
                "white_ms": white_ms,
                "black_ms": black_ms,
                "base_clock_ms": self.base_clock_ms,
                "increment_ms": self.increment_ms,
                "eval_cp": eval_cp,
                "check": board.is_check(),
                "game_over": (
                    self.manual_result is not None or outcome is not None or flagged is not None
                ),
                "result": (
                    self.manual_result
                    if self.manual_result is not None
                    else outcome.result()
                    if outcome is not None
                    else (
                        "0-1"
                        if flagged == chess.WHITE
                        else "1-0"
                        if flagged == chess.BLACK
                        else None
                    )
                ),
                "termination": (
                    self.manual_termination
                    if self.manual_result is not None
                    else outcome.termination.name.lower()
                    if outcome is not None
                    else "time_forfeit"
                    if flagged is not None
                    else None
                ),
                "pgn": self._pgn_moves(board),
                "initial_fen": self.initial_fen,
                "moves_uci": self._moves_uci(),
                "clock_history": [[white, black] for white, black in self.history],
                "paused": self.paused,
                "manual_result": self.manual_result,
                "manual_termination": self.manual_termination,
                "pgn_headers": self.pgn_headers,
                "captured_by_white": captured_by_white,
                "captured_by_black": captured_by_black,
                "material_balance": self._material_balance(board),
                "last_engine_ms": self.last_engine_ms,
                "last_engine_nodes": self.last_engine_nodes,
                "last_engine_depth": self.last_engine_depth,
                "last_engine_score": self.last_engine_score,
                "last_engine_pv": self.last_engine_pv,
                "last_engine_researches": self.last_engine_researches,
                "analysis_status": self.analysis_status,
                "analysis_total": self.analysis_total,
                "phase": _phase_name(board),
                "opening": opening,
            }

    @staticmethod
    def _board_payload(board: chess.Board) -> dict[str, str]:
        return {
            chess.square_name(square): piece.symbol()
            for square, piece in board.piece_map().items()
        }

    @staticmethod
    def _pgn_moves(board: chess.Board) -> list[dict[str, Any]]:
        replay = chess.Board(board.root().fen())
        result: list[dict[str, Any]] = []
        for ply, move in enumerate(board.move_stack):
            san = replay.san(move)
            result.append({"ply": ply + 1, "uci": move.uci(), "san": san})
            replay.push(move)
        return result

    def play_move(self, uci: str) -> None:
        with self.lock:
            if self.manual_result is not None or self.board.is_game_over(claim_draw=True):
                raise ValueError("The game is already over.")
            if self.paused:
                raise ValueError("The game is paused.")
            try:
                move = chess.Move.from_uci(uci)
            except ValueError as exc:
                raise ValueError("Invalid UCI move.") from exc
            if move not in self.board.legal_moves:
                raise ValueError("That move is not legal in the current position.")
            self._cancel_analysis_locked()
            self._commit_clock()
            mover = self.board.turn
            remaining = self.white_ms if mover == chess.WHITE else self.black_ms
            if remaining <= 0:
                side = "White" if mover == chess.WHITE else "Black"
                raise ValueError(f"{side} has flagged on time.")
            self.history.append((self.white_ms, self.black_ms))
            if mover == chess.WHITE:
                self.white_ms += self.increment_ms
            else:
                self.black_ms += self.increment_ms
            self.board.push(move)
            self.last_move = move
            self.turn_started_ns = time.monotonic_ns()

    def engine_move(self, budget_ms: int | None = None) -> str:
        with self.lock:
            if self.manual_result is not None or self.board.is_game_over(claim_draw=True):
                raise ValueError("The game is already over.")
            if self.paused:
                raise ValueError("The game is paused.")
            self._cancel_analysis_locked()
            color = self.board.turn
            self._commit_clock()
            available = self.white_ms if color == chess.WHITE else self.black_ms
            if available <= 0:
                side = "White" if color == chess.WHITE else "Black"
                raise ValueError(f"{side} has flagged on time.")
            requested = available if budget_ms is None else min(available, max(1, budget_ms))
            fen = self.board.fen()
            before = time.monotonic_ns()
            uci = agent.get_move(fen, requested)
            elapsed_ms = max(0, (time.monotonic_ns() - before) // 1_000_000)

            try:
                move = chess.Move.from_uci(uci)
            except ValueError as exc:
                raise RuntimeError(f"Engine returned malformed move {uci!r}.") from exc
            if move not in self.board.legal_moves:
                raise RuntimeError(f"Engine returned illegal move {uci!r}.")

            if color == chess.WHITE:
                self.white_ms = max(0, self.white_ms - elapsed_ms)
            else:
                self.black_ms = max(0, self.black_ms - elapsed_ms)
            self.last_engine_ms = int(elapsed_ms)
            info = agent.LAST_SEARCH_INFO
            self.last_engine_nodes = int(info.nodes)
            self.last_engine_depth = int(info.depth)
            self.last_engine_score = int(info.score)
            self.last_engine_pv = tuple(info.pv)
            self.last_engine_researches = int(info.aspiration_researches)
            self.turn_started_ns = time.monotonic_ns()
            remaining = self.white_ms if color == chess.WHITE else self.black_ms
            if remaining <= 0:
                # A move completed after the clock expired is a time forfeit.
                # Do not push the late move or award increment: state() will
                # report the flag while the board remains at the pre-search
                # position, matching the referee's wall-clock semantics.
                return ""
            self.history.append((self.white_ms, self.black_ms))
            if color == chess.WHITE:
                self.white_ms += self.increment_ms
            else:
                self.black_ms += self.increment_ms
            self.board.push(move)
            self.last_move = move
            return uci

    def undo(self) -> None:
        with self.lock:
            # Review navigation is handled entirely by review_state() and never
            # calls this method.  Undo is a live-game mutation, so invalidate
            # any analysis tied to the old main line before changing the board.
            self._cancel_analysis_locked()
            preserve_pause = self.paused and self.manual_result is None
            self.manual_result = None
            self.manual_termination = None
            self.paused = preserve_pause
            if not self.board.move_stack:
                self.turn_started_ns = time.monotonic_ns()
                return
            self.board.pop()
            if self.history:
                self.white_ms, self.black_ms = self.history.pop()
            self.last_move = self.board.peek() if self.board.move_stack else None
            self.turn_started_ns = time.monotonic_ns()

    def set_paused(self, paused: bool) -> None:
        with self.lock:
            if self.manual_result is not None or self.board.is_game_over(claim_draw=True):
                raise ValueError("The game is already over.")
            if not paused and self.analysis_status == "running":
                raise ValueError("Cancel game analysis before resuming the live game.")
            if paused == self.paused:
                return
            if paused:
                self._commit_clock()
                self.paused = True
            else:
                self.paused = False
                self.turn_started_ns = time.monotonic_ns()

    def resign(self, color_name: str) -> None:
        with self.lock:
            if self.manual_result is not None or self.board.is_game_over(claim_draw=True):
                raise ValueError("The game is already over.")
            if color_name not in {"white", "black"}:
                raise ValueError("Resigning color must be white or black.")
            self._commit_clock()
            self.manual_result = "0-1" if color_name == "white" else "1-0"
            self.manual_termination = "resignation"
            self.paused = True

    def agree_draw(self) -> None:
        with self.lock:
            if self.manual_result is not None or self.board.is_game_over(claim_draw=True):
                raise ValueError("The game is already over.")
            self._commit_clock()
            self.manual_result = "1/2-1/2"
            self.manual_termination = "draw_agreement"
            self.paused = True


SESSION = GameSession()


class Handler(SimpleHTTPRequestHandler):
    """Static assets plus a tiny JSON API."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT / "static"), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep the terminal quiet unless there is an HTTP error.
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; connect-src 'self'; img-src 'self' blob: data:; "
            "style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:",
        )
        super().end_headers()

    @staticmethod
    def _loopback_hostname(hostname: str | None) -> bool:
        return hostname in {"127.0.0.1", "localhost", "::1"}

    def _request_is_local(self) -> bool:
        host_header = self.headers.get("Host", "")
        try:
            host = urlsplit(f"//{host_header}")
            if not self._loopback_hostname(host.hostname):
                return False
            if host.port != self.server.server_port:
                return False
        except ValueError:
            return False

        origin_header = self.headers.get("Origin")
        if not origin_header:
            return True
        try:
            origin = urlsplit(origin_header)
            return (
                origin.scheme == "http"
                and self._loopback_hostname(origin.hostname)
                and origin.port == self.server.server_port
            )
        except ValueError:
            return False

    def _deny_nonlocal_request(self) -> bool:
        if self._request_is_local():
            return False
        self._json(
            {"error": "Requests must originate from this local FunChessEngine instance."},
            status=HTTPStatus.FORBIDDEN,
        )
        return True

    def do_GET(self) -> None:
        if self._deny_nonlocal_request():
            return
        if self.path == "/api/state":
            self._json(SESSION.state())
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self._deny_nonlocal_request():
            return
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self._json(
                {"error": "POST requests require application/json."},
                status=HTTPStatus.FORBIDDEN,
            )
            return
        try:
            payload = self._body()
            if self.path == "/api/move":
                SESSION.play_move(str(payload.get("move", "")))
            elif self.path == "/api/engine":
                budget = payload.get("budget_ms")
                SESSION.engine_move(int(budget) if budget is not None else None)
            elif self.path == "/api/reset":
                SESSION.reset(
                    str(payload.get("fen", chess.STARTING_FEN)),
                    int(payload.get("clock_ms", DEFAULT_CLOCK_MS)),
                    int(payload.get("increment_ms", DEFAULT_INCREMENT_MS)),
                )
            elif self.path == "/api/load-game":
                SESSION.load_snapshot(payload)
            elif self.path == "/api/load-pgn":
                SESSION.load_pgn(str(payload.get("pgn", "")))
            elif self.path == "/api/export-pgn":
                self._json({"pgn": SESSION.export_pgn()})
                return
            elif self.path == "/api/review":
                self._json(SESSION.review_state(int(payload.get("ply", 0))))
                return
            elif self.path == "/api/review-series":
                self._json(SESSION.review_series())
                return
            elif self.path == "/api/analyze-game":
                self._json(SESSION.start_analysis(int(payload.get("budget_ms", 100))))
                return
            elif self.path == "/api/analysis-status":
                self._json(SESSION.analysis_state())
                return
            elif self.path == "/api/cancel-analysis":
                self._json(SESSION.cancel_analysis())
                return
            elif self.path == "/api/multipv":
                if payload.get("fen"):
                    result = SESSION.multipv_fen(
                        str(payload["fen"]),
                        int(payload.get("lines", 3)),
                        int(payload.get("budget_ms", 350)),
                    )
                else:
                    result = SESSION.multipv(
                        int(payload.get("ply", len(SESSION.board.move_stack))),
                        int(payload.get("lines", 3)),
                        int(payload.get("budget_ms", 350)),
                    )
                self._json(result)
                return
            elif self.path == "/api/position":
                self._json(SESSION.position_from_fen(str(payload.get("fen", chess.STARTING_FEN))))
                return
            elif self.path == "/api/variation-move":
                self._json(
                    SESSION.variation_move(
                        str(payload.get("fen", chess.STARTING_FEN)),
                        str(payload.get("move", "")),
                    )
                )
                return
            elif self.path == "/api/eval-breakdown":
                self._json(
                    SESSION.evaluation_breakdown(
                        str(payload.get("fen", chess.STARTING_FEN))
                    )
                )
                return
            elif self.path == "/api/dev-benchmark":
                self._json(
                    SESSION.benchmark_engine(
                        int(payload.get("clock_ms", 10_000)),
                        str(payload.get("compare_path", "")),
                    )
                )
                return
            elif self.path == "/api/dev-arena":
                self._json(
                    SESSION.arena_compare(
                        str(payload.get("opponent_path", "")),
                        int(payload.get("games", 6)),
                        int(payload.get("base_ms", 5_000)),
                        int(payload.get("increment_ms", 100)),
                    )
                )
                return
            elif self.path == "/api/undo":
                SESSION.undo()
            elif self.path == "/api/pause":
                SESSION.set_paused(bool(payload.get("paused", True)))
            elif self.path == "/api/resign":
                SESSION.resign(str(payload.get("color", "")))
            elif self.path == "/api/draw":
                SESSION.agree_draw()
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self._json(SESSION.state())
        except (TypeError, ValueError, RuntimeError) as exc:
            self._json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)

    def _body(self) -> dict[str, Any]:
        size = int(self.headers.get("Content-Length", "0"))
        if size > 64 * 1024:
            raise ValueError("Request body is too large.")
        raw = self.rfile.read(size) if size else b"{}"
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("JSON request must be an object.")
        return value

    def _json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser(description="Launch the local FunChessEngine GUI.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-open", action="store_true", help="Do not open a browser tab.")
    parser.add_argument("--analysis-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--multipv-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--benchmark-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--arena-worker", action="store_true", help=argparse.SUPPRESS)
    arguments = parser.parse_args()

    if arguments.analysis_worker:
        try:
            payload = json.load(sys.stdin)
            if not isinstance(payload, dict):
                raise ValueError("Analysis worker input must be an object.")
            _run_analysis_worker(payload)
        except Exception as exc:
            print(json.dumps({"type": "error", "error": str(exc)}), flush=True)
            raise SystemExit(1) from exc
        return

    if arguments.multipv_worker:
        try:
            payload = json.load(sys.stdin)
            if not isinstance(payload, dict):
                raise ValueError("MultiPV worker input must be an object.")
            _run_multipv_worker(payload)
        except Exception as exc:
            print(json.dumps({"type": "error", "error": str(exc)}), flush=True)
            raise SystemExit(1) from exc
        return

    if arguments.benchmark_worker:
        try:
            payload = json.load(sys.stdin)
            if not isinstance(payload, dict):
                raise ValueError("Benchmark worker input must be an object.")
            _run_benchmark_worker(payload)
        except Exception as exc:
            print(json.dumps({"error": str(exc)}), flush=True)
            raise SystemExit(1) from exc
        return

    if arguments.arena_worker:
        try:
            payload = json.load(sys.stdin)
            if not isinstance(payload, dict):
                raise ValueError("Arena worker input must be an object.")
            _run_arena_worker(payload)
        except Exception as exc:
            print(json.dumps({"error": str(exc)}), flush=True)
            raise SystemExit(1) from exc
        return

    port = arguments.port
    while True:
        try:
            server = ThreadingHTTPServer((arguments.host, port), Handler)
            break
        except OSError as exc:
            if exc.errno != errno.EADDRINUSE or port >= arguments.port + 20:
                raise
            port += 1
    url = f"http://{arguments.host}:{server.server_port}"
    if arguments.port != 0 and server.server_port != arguments.port:
        print(f"Port {arguments.port} is busy; using {server.server_port} instead.")
    print(f"FunChessEngine GUI: {url}", flush=True)
    if not arguments.no_open:
        threading.Timer(0.35, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
