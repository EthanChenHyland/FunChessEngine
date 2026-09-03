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
import ipaddress
import json
import math
import os
import secrets
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import webbrowser
from contextlib import suppress
from dataclasses import asdict
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import chess
import chess.pgn
import chess.syzygy

import agent
from gui import workspace as workspace_files
from gui.imports import import_reference_file
from gui.jobs import JOBS, JobCancelled, progress, run_process, worker_slot
from harness import benchmark as benchmark_harness
from harness.process_io import terminate_active_processes
from harness.referee import FAILED_TERMINATIONS, play_match
from harness.regression import compare_runs as compare_regression_runs
from harness.regression import run_suite as run_regression_suite
from harness.sandbox import local
from harness.selfplay_data import generate_dataset as generate_selfplay_dataset
from harness.tuner import coordinate_tune
from integrations.tournament import calibrate_against_uci, run_tournament
from integrations.uci_client import ExternalUCIEngine
from librarydb import LibraryDatabase, parse_library_query
from librarydb.store import default_data_dir
from librarydb.workbench import LibraryWorkbench
from openingbook import OpeningBook
from plugins.manifest import validate_manifest
from reporting.generator import annotated_pgn, html_report

if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    ROOT = Path(str(sys._MEIPASS)) / "gui"
else:
    ROOT = Path(__file__).resolve().parent
DEFAULT_CLOCK_MS = 120_000
DEFAULT_INCREMENT_MS = 500
MAX_API_BODY_BYTES = 20 * 1024 * 1024
OPENING_DATA_PATH = ROOT / "openings.json"
DEFAULT_SYZYGY_PATH = os.environ.get("FUNCHESS_SYZYGY_PATH", "").strip()
LAN_LOCK = threading.RLock()
LAN_SERVER: ThreadingHTTPServer | None = None
LAN_THREAD: threading.Thread | None = None
LAN_TOKEN = ""
LIBRARY_DB_LOCK = threading.Lock()
LIBRARY_DB: LibraryDatabase | None = None
OPENING_BOOK_LOCK = threading.Lock()
OPENING_BOOK_STORE: OpeningBook | None = None


def _library_database() -> LibraryDatabase:
    global LIBRARY_DB
    with LIBRARY_DB_LOCK:
        if LIBRARY_DB is None:
            LIBRARY_DB = LibraryDatabase()
        return LIBRARY_DB


def _opening_book() -> OpeningBook:
    global OPENING_BOOK_STORE
    with OPENING_BOOK_LOCK:
        if OPENING_BOOK_STORE is None:
            OPENING_BOOK_STORE = OpeningBook()
        return OPENING_BOOK_STORE


def _board_from_fen(fen: str, *, chess960: bool = False) -> chess.Board:
    """Build a validated board with explicit standard/Chess960 semantics."""

    return chess.Board(fen, chess960=chess960)


def _load_opening_prefixes(
    path: Path = OPENING_DATA_PATH,
) -> dict[tuple[str, ...], tuple[str, str]]:
    """Load and validate the bundled FunChessEngine opening recognizer data."""

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Could not load opening data from {path.name}.") from exc
    if not isinstance(raw, dict) or raw.get("schema_version") != 1:
        raise RuntimeError("Opening data has an unsupported schema version.")
    entries = raw.get("entries")
    if not isinstance(entries, list) or not entries:
        raise RuntimeError("Opening data must contain a non-empty entries list.")

    result: dict[tuple[str, ...], tuple[str, str]] = {}
    for index, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            raise RuntimeError(f"Opening entry {index} must be an object.")
        eco = entry.get("eco")
        name = entry.get("name")
        moves = entry.get("moves")
        if (
            not isinstance(eco, str)
            or len(eco) != 3
            or eco[0] not in "ABCDE"
            or not eco[1:].isdigit()
        ):
            raise RuntimeError(f"Opening entry {index} has an invalid ECO code.")
        if not isinstance(name, str) or not name.strip():
            raise RuntimeError(f"Opening entry {index} has an invalid name.")
        if not isinstance(moves, list) or not moves or len(moves) > 32:
            raise RuntimeError(f"Opening entry {index} has an invalid move prefix.")

        board = chess.Board()
        prefix: list[str] = []
        for ply, raw_move in enumerate(moves, start=1):
            if not isinstance(raw_move, str):
                raise RuntimeError(f"Opening entry {index} move {ply} is not UCI text.")
            try:
                move = chess.Move.from_uci(raw_move)
            except ValueError as exc:
                raise RuntimeError(f"Opening entry {index} move {ply} is malformed.") from exc
            if move not in board.legal_moves:
                raise RuntimeError(f"Opening entry {index} move {ply} is illegal.")
            prefix.append(move.uci())
            board.push(move)
        key = tuple(prefix)
        if key in result:
            raise RuntimeError(f"Opening entry {index} duplicates an earlier move prefix.")
        result[key] = (eco, name.strip())
    return result


# The recognizer is local metadata, not an engine opening book: it labels games
# already played by the user and never supplies moves to agent.py. Longest UCI
# prefix wins so specific variations naturally refine broader opening families.
OPENING_PREFIXES = _load_opening_prefixes()


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


def _detect_tactical_motifs(board: chess.Board, move: chess.Move) -> list[str]:
    """Return deterministic tactical labels for a legal move."""

    if move not in board.legal_moves:
        return []
    mover = board.turn
    motifs: list[str] = []
    if board.is_capture(move):
        motifs.append("capture")
    if move.promotion:
        motifs.append("promotion")
    before_pins = {
        square
        for square, piece in board.piece_map().items()
        if piece.color != mover and board.is_pinned(piece.color, square)
    }
    before_slider_targets: set[tuple[int, int]] = set()
    for square, piece in board.piece_map().items():
        if piece.color != mover or piece.piece_type not in {chess.BISHOP, chess.ROOK, chess.QUEEN}:
            continue
        for target_square in board.attacks(square):
            target = board.piece_at(target_square)
            if (
                target is not None
                and target.color != mover
                and target.piece_type
                in {
                    chess.ROOK,
                    chess.QUEEN,
                    chess.KING,
                }
            ):
                before_slider_targets.add((square, target_square))
    child = board.copy(stack=False)
    child.push(move)
    if child.is_checkmate():
        motifs.append("mate")
    elif child.is_check():
        motifs.append("check")
        if len(list(child.legal_moves)) <= 2:
            motifs.append("mating net")
    moved_piece = child.piece_at(move.to_square)
    if moved_piece is not None:
        attacked_targets = []
        for square in child.attacks(move.to_square):
            target = child.piece_at(square)
            if target is not None and target.color != mover and target.piece_type != chess.PAWN:
                attacked_targets.append(target.piece_type)
        if len(attacked_targets) >= 2:
            motifs.append("fork")
        if moved_piece.piece_type in {chess.ROOK, chess.QUEEN}:
            enemy_king = child.king(not mover)
            if (
                enemy_king is not None
                and chess.square_rank(enemy_king) in {0, 7}
                and child.is_check()
            ):
                motifs.append("back-rank pressure")
                if child.is_checkmate():
                    motifs.append("back-rank mate")
        if moved_piece.piece_type in {chess.BISHOP, chess.ROOK, chess.QUEEN}:
            directions = (
                (1, 0),
                (-1, 0),
                (0, 1),
                (0, -1),
                (1, 1),
                (1, -1),
                (-1, 1),
                (-1, -1),
            )
            allowed: tuple[tuple[int, int], ...] = directions
            if moved_piece.piece_type == chess.BISHOP:
                allowed = directions[4:]
            elif moved_piece.piece_type == chess.ROOK:
                allowed = directions[:4]
            origin_file = chess.square_file(move.to_square)
            origin_rank = chess.square_rank(move.to_square)
            for file_step, rank_step in allowed:
                occupied: list[chess.Piece] = []
                file_index = origin_file + file_step
                rank_index = origin_rank + rank_step
                while 0 <= file_index < 8 and 0 <= rank_index < 8:
                    target = child.piece_at(chess.square(file_index, rank_index))
                    if target is not None:
                        occupied.append(target)
                        if len(occupied) == 2:
                            break
                    file_index += file_step
                    rank_index += rank_step
                if (
                    len(occupied) == 2
                    and occupied[0].color != mover
                    and occupied[1].color != mover
                    and occupied[0].piece_type in {chess.KING, chess.QUEEN, chess.ROOK}
                    and PIECE_VALUES.get(occupied[0].piece_type, 99)
                    > PIECE_VALUES.get(occupied[1].piece_type, 0)
                ):
                    motifs.append("skewer")
                    break
        attacked_enemy_squares = [
            square
            for square in child.attacks(move.to_square)
            if child.color_at(square) == (not mover)
        ]
        for target_square in attacked_enemy_squares:
            target = child.piece_at(target_square)
            if target is None or target.piece_type in {chess.PAWN, chess.KING}:
                continue
            escapes = [
                candidate
                for candidate in child.legal_moves
                if candidate.from_square == target_square
            ]
            if not escapes:
                motifs.append("trapped piece")
                break
    after_pins = {
        square
        for square, piece in child.piece_map().items()
        if piece.color != mover and child.is_pinned(piece.color, square)
    }
    if after_pins - before_pins:
        motifs.append("pin")
    after_slider_targets: set[tuple[int, int]] = set()
    for square, piece in child.piece_map().items():
        if (
            piece.color != mover
            or square == move.to_square
            or piece.piece_type not in {chess.BISHOP, chess.ROOK, chess.QUEEN}
        ):
            continue
        for target_square in child.attacks(square):
            target = child.piece_at(target_square)
            if (
                target is not None
                and target.color != mover
                and target.piece_type
                in {
                    chess.ROOK,
                    chess.QUEEN,
                    chess.KING,
                }
            ):
                after_slider_targets.add((square, target_square))
    if after_slider_targets - before_slider_targets:
        motifs.extend(["discovered attack", "clearance"])
    if board.is_capture(move):
        captured_square = move.to_square
        if board.is_en_passant(move):
            captured_square += -8 if mover == chess.WHITE else 8
        captured = board.piece_at(captured_square)
        if captured is not None and not board.is_attacked_by(captured.color, captured_square):
            motifs.append("hanging piece")
        if captured is not None:
            defended_before = {
                square
                for square in board.attacks(captured_square)
                if board.color_at(square) == captured.color and square != captured_square
            }
            newly_loose = [
                square
                for square in defended_before
                if child.piece_at(square) is not None
                and not child.is_attacked_by(not mover, square)
                and child.is_attacked_by(mover, square)
            ]
            if newly_loose:
                motifs.extend(["deflection", "removal of defender"])
    if (
        child.is_check()
        and not board.is_capture(move)
        and any(board.is_capture(candidate) for candidate in board.legal_moves)
    ):
        motifs.append("zwischenzug")
    if child.is_check() and moved_piece is not None:
        enemy_king = child.king(not mover)
        if (
            enemy_king is not None
            and chess.square_distance(enemy_king, move.to_square) == 1
            and any(
                candidate.from_square == enemy_king and candidate.to_square == move.to_square
                for candidate in child.legal_moves
            )
        ):
            motifs.append("attraction")
    return list(dict.fromkeys(motifs))


def _passed_pawns(board: chess.Board, color: chess.Color) -> list[str]:
    enemy_pawns = board.pieces(chess.PAWN, not color)
    result: list[str] = []
    for square in board.pieces(chess.PAWN, color):
        file_index = chess.square_file(square)
        rank_index = chess.square_rank(square)
        files = {file_index}
        if file_index > 0:
            files.add(file_index - 1)
        if file_index < 7:
            files.add(file_index + 1)
        blocked = False
        for enemy in enemy_pawns:
            if chess.square_file(enemy) not in files:
                continue
            enemy_rank = chess.square_rank(enemy)
            if (color == chess.WHITE and enemy_rank > rank_index) or (
                color == chess.BLACK and enemy_rank < rank_index
            ):
                blocked = True
                break
        if not blocked:
            result.append(chess.square_name(square))
    return result


PIECE_VALUES = {
    chess.PAWN: 1,
    chess.KNIGHT: 3,
    chess.BISHOP: 3,
    chess.ROOK: 5,
    chess.QUEEN: 9,
}


def _pawn_structure(board: chess.Board, color: chess.Color) -> dict[str, Any]:
    pawns = sorted(board.pieces(chess.PAWN, color))
    by_file: dict[int, list[int]] = {}
    for square in pawns:
        by_file.setdefault(chess.square_file(square), []).append(square)
    isolated: list[str] = []
    for square in pawns:
        file_index = chess.square_file(square)
        if not any(adjacent in by_file for adjacent in (file_index - 1, file_index + 1)):
            isolated.append(chess.square_name(square))
    doubled = [
        chr(ord("a") + file_index) for file_index, squares in by_file.items() if len(squares) > 1
    ]
    occupied_files = sorted(by_file)
    islands = 0
    previous: int | None = None
    for file_index in occupied_files:
        if previous is None or file_index != previous + 1:
            islands += 1
        previous = file_index
    return {
        "isolated": isolated,
        "doubled_files": doubled,
        "islands": islands,
        "passed": _passed_pawns(board, color),
    }


def _file_features(board: chess.Board) -> dict[str, Any]:
    white_files = {chess.square_file(square) for square in board.pieces(chess.PAWN, chess.WHITE)}
    black_files = {chess.square_file(square) for square in board.pieces(chess.PAWN, chess.BLACK)}
    open_files = [
        chr(ord("a") + file_index)
        for file_index in range(8)
        if file_index not in white_files and file_index not in black_files
    ]
    return {
        "open": open_files,
        "semi_open": {
            "white": [
                chr(ord("a") + file_index)
                for file_index in range(8)
                if file_index not in white_files and file_index in black_files
            ],
            "black": [
                chr(ord("a") + file_index)
                for file_index in range(8)
                if file_index not in black_files and file_index in white_files
            ],
        },
    }


def _weak_squares(board: chess.Board, color: chess.Color) -> list[str]:
    enemy = not color
    candidates: list[tuple[int, int]] = []
    for square in chess.SQUARES:
        rank = chess.square_rank(square)
        if color == chess.WHITE and rank < 2:
            continue
        if color == chess.BLACK and rank > 5:
            continue
        enemy_attackers = len(board.attackers(enemy, square))
        defenders = len(board.attackers(color, square))
        if enemy_attackers <= defenders or enemy_attackers == 0:
            continue
        center_bonus = (
            2 if chess.square_file(square) in {2, 3, 4, 5} and rank in {2, 3, 4, 5} else 0
        )
        candidates.append((enemy_attackers - defenders + center_bonus, square))
    candidates.sort(reverse=True)
    return [chess.square_name(square) for _, square in candidates[:8]]


def _knight_outposts(board: chess.Board, color: chess.Color) -> list[str]:
    result: list[str] = []
    enemy_pawns = board.pieces(chess.PAWN, not color)
    own_pawns = board.pieces(chess.PAWN, color)
    for square in board.pieces(chess.KNIGHT, color):
        rank = chess.square_rank(square)
        if (color == chess.WHITE and rank < 3) or (color == chess.BLACK and rank > 4):
            continue
        if not any(square in board.attacks(pawn) for pawn in own_pawns):
            continue
        if any(square in board.attacks(pawn) for pawn in enemy_pawns):
            continue
        result.append(chess.square_name(square))
    return result


def _bishop_quality(board: chess.Board, color: chess.Color) -> list[dict[str, Any]]:
    own_pawns = board.pieces(chess.PAWN, color)
    rows: list[dict[str, Any]] = []
    for square in board.pieces(chess.BISHOP, color):
        square_color = (chess.square_file(square) + chess.square_rank(square)) % 2
        same_color_pawns = sum(
            1
            for pawn in own_pawns
            if (chess.square_file(pawn) + chess.square_rank(pawn)) % 2 == square_color
        )
        mobility = sum(1 for target in board.attacks(square) if board.color_at(target) != color)
        rows.append(
            {
                "square": chess.square_name(square),
                "quality": "bad" if same_color_pawns >= 4 and mobility <= 5 else "good",
                "same_color_pawns": same_color_pawns,
                "mobility": mobility,
            }
        )
    return rows


def _king_safety(board: chess.Board, color: chess.Color) -> dict[str, int]:
    king = board.king(color)
    if king is None:
        return {"shield": 0, "enemy_pressure": 0}
    king_file = chess.square_file(king)
    king_rank = chess.square_rank(king)
    forward = 1 if color == chess.WHITE else -1
    shield = 0
    for file_index in range(max(0, king_file - 1), min(7, king_file + 1) + 1):
        rank = king_rank + forward
        if 0 <= rank <= 7 and board.piece_at(chess.square(file_index, rank)) == chess.Piece(
            chess.PAWN, color
        ):
            shield += 1
    zone = set(board.attacks(king)) | {king}
    pressure = sum(len(board.attackers(not color, square)) for square in zone)
    return {"shield": shield, "enemy_pressure": pressure}


def _space_score(board: chess.Board, color: chess.Color) -> int:
    score = 0
    for square in chess.SQUARES:
        rank = chess.square_rank(square)
        enemy_half = rank >= 4 if color == chess.WHITE else rank <= 3
        if enemy_half and board.is_attacked_by(color, square):
            score += 1
    return score


def _candidate_pawn_breaks(board: chess.Board, color: chess.Color) -> list[str]:
    result: list[str] = []
    if board.turn != color:
        board = board.copy(stack=False)
        board.turn = color
    for move in board.legal_moves:
        piece = board.piece_at(move.from_square)
        if piece is None or piece.piece_type != chess.PAWN or board.is_capture(move):
            continue
        child = board.copy(stack=False)
        child.push(move)
        moved = child.piece_at(move.to_square)
        if moved is None:
            continue
        if any(
            child.piece_at(target) == chess.Piece(chess.PAWN, not color)
            for target in child.attacks(move.to_square)
        ):
            result.append(board.san(move))
    return result[:6]


def _piece_activity(board: chess.Board, color: chess.Color) -> dict[str, str | None]:
    ranked: list[tuple[int, int]] = []
    for square, piece in board.piece_map().items():
        if piece.color != color or piece.piece_type in {chess.PAWN, chess.KING}:
            continue
        mobility = sum(1 for target in board.attacks(square) if board.color_at(target) != color)
        file_index = chess.square_file(square)
        rank = chess.square_rank(square)
        center = 2 if file_index in {2, 3, 4, 5} and rank in {2, 3, 4, 5} else 0
        ranked.append((mobility + center, square))
    ranked.sort()
    return {
        "worst": chess.square_name(ranked[0][1]) if ranked else None,
        "best": chess.square_name(ranked[-1][1]) if ranked else None,
    }


def _structure_tags(board: chess.Board) -> list[str]:
    tags: list[str] = []
    white = _pawn_structure(board, chess.WHITE)
    black = _pawn_structure(board, chess.BLACK)
    if "d" in {square[0] for square in white["isolated"]}:
        tags.append("white IQP")
    if "d" in {square[0] for square in black["isolated"]}:
        tags.append("black IQP")
    white_pawns = {chess.square_name(square) for square in board.pieces(chess.PAWN, chess.WHITE)}
    black_pawns = {chess.square_name(square) for square in board.pieces(chess.PAWN, chess.BLACK)}
    if {"c4", "d4"}.issubset(white_pawns) and not ({"b4", "e4"} & white_pawns):
        tags.append("white hanging pawns")
    if {"c5", "d5"}.issubset(black_pawns) and not ({"b5", "e5"} & black_pawns):
        tags.append("black hanging pawns")
    if {"c4", "e4"}.issubset(white_pawns):
        tags.append("Maroczy bind")
    white_king = board.king(chess.WHITE)
    black_king = board.king(chess.BLACK)
    if white_king is not None and black_king is not None:
        white_file = chess.square_file(white_king)
        black_file = chess.square_file(black_king)
        if (white_file <= 2 and black_file >= 5) or (white_file >= 5 and black_file <= 2):
            tags.append("opposite-side castling")
    heavy = board.pieces(chess.QUEEN, chess.WHITE) | board.pieces(chess.QUEEN, chess.BLACK)
    if not heavy:
        rooks = board.pieces(chess.ROOK, chess.WHITE) | board.pieces(chess.ROOK, chess.BLACK)
        minors = (
            board.pieces(chess.BISHOP, chess.WHITE)
            | board.pieces(chess.BISHOP, chess.BLACK)
            | board.pieces(chess.KNIGHT, chess.WHITE)
            | board.pieces(chess.KNIGHT, chess.BLACK)
        )
        if rooks and not minors:
            tags.append("rook endgame")
    if any(square[1] in {"3", "6"} for square in white["passed"] + black["passed"]):
        tags.append("advanced passed pawn")
    return tags


def _human_plan(board: chess.Board) -> list[str]:
    """Produce compact strategic plan suggestions from board features."""

    plans: list[str] = []
    color = board.turn
    king = board.king(color)
    if king is not None and board.has_castling_rights(color) and board.fullmove_number <= 15:
        plans.append("Complete development and consider castling before starting operations.")
    passed = _passed_pawns(board, color)
    if passed:
        plans.append(f"Support and advance the passed pawn on {passed[0]} when tactics allow.")
    files_with_no_pawns: list[str] = []
    for file_index in range(8):
        if not any(
            chess.square_file(square) == file_index
            for square in (
                board.pieces(chess.PAWN, chess.WHITE) | board.pieces(chess.PAWN, chess.BLACK)
            )
        ):
            files_with_no_pawns.append(chr(ord("a") + file_index))
    if files_with_no_pawns:
        plans.append(f"Contest the open {files_with_no_pawns[0]}-file with a rook or queen.")
    enemy_king = board.king(not color)
    if enemy_king is not None:
        attackers = len(board.attackers(color, enemy_king))
        if attackers:
            plans.append("Keep pieces near the enemy king and look for forcing checks or captures.")
    if _phase_name(board) == "endgame":
        plans.append(
            "Activate the king; king activity is often worth more than passive material defense."
        )
    if not plans:
        plans.append("Improve the least active piece and avoid creating new pawn weaknesses.")
    return plans[:4]


def _position_insights(board: chess.Board) -> dict[str, Any]:
    attacks: dict[str, list[str]] = {"white": [], "black": []}
    loose: list[str] = []
    for square, piece in board.piece_map().items():
        color_name = "white" if piece.color == chess.WHITE else "black"
        for target in board.attacks(square):
            name = chess.square_name(target)
            if name not in attacks[color_name]:
                attacks[color_name].append(name)
        if piece.piece_type != chess.KING and not board.is_attacked_by(piece.color, square):
            loose.append(chess.square_name(square))
    material = {
        "white": {
            chess.piece_name(piece_type): len(board.pieces(piece_type, chess.WHITE))
            for piece_type in PIECE_VALUES
        },
        "black": {
            chess.piece_name(piece_type): len(board.pieces(piece_type, chess.BLACK))
            for piece_type in PIECE_VALUES
        },
    }
    white_total = sum(
        PIECE_VALUES[piece_type] * len(board.pieces(piece_type, chess.WHITE))
        for piece_type in PIECE_VALUES
    )
    black_total = sum(
        PIECE_VALUES[piece_type] * len(board.pieces(piece_type, chess.BLACK))
        for piece_type in PIECE_VALUES
    )
    return {
        "fen": board.fen(),
        "plans": _human_plan(board),
        "attacks": attacks,
        "loose_pieces": loose,
        "material": {**material, "balance": white_total - black_total},
        "pawn_structure": {
            "white": _pawn_structure(board, chess.WHITE),
            "black": _pawn_structure(board, chess.BLACK),
        },
        "files": _file_features(board),
        "weak_squares": {
            "white": _weak_squares(board, chess.WHITE),
            "black": _weak_squares(board, chess.BLACK),
        },
        "knight_outposts": {
            "white": _knight_outposts(board, chess.WHITE),
            "black": _knight_outposts(board, chess.BLACK),
        },
        "bishops": {
            "white": _bishop_quality(board, chess.WHITE),
            "black": _bishop_quality(board, chess.BLACK),
        },
        "king_safety": {
            "white": _king_safety(board, chess.WHITE),
            "black": _king_safety(board, chess.BLACK),
        },
        "space": {
            "white": _space_score(board, chess.WHITE),
            "black": _space_score(board, chess.BLACK),
        },
        "passed_pawns": {
            "white": _passed_pawns(board, chess.WHITE),
            "black": _passed_pawns(board, chess.BLACK),
        },
        "pawn_breaks": {
            "white": _candidate_pawn_breaks(board, chess.WHITE),
            "black": _candidate_pawn_breaks(board, chess.BLACK),
        },
        "piece_activity": {
            "white": _piece_activity(board, chess.WHITE),
            "black": _piece_activity(board, chess.BLACK),
        },
        "structure_tags": _structure_tags(board),
        "phase": _phase_name(board),
    }


def _tablebase_probe(fen: str, path: str = "") -> dict[str, Any]:
    tablebase_path = Path(path or DEFAULT_SYZYGY_PATH).expanduser()
    if not (path or DEFAULT_SYZYGY_PATH).strip() or not tablebase_path.is_dir():
        return {"available": False, "reason": "Configure a local Syzygy directory first."}
    board = chess.Board(fen)
    if not board.is_valid():
        raise ValueError("Tablebase lookup requires a valid position.")
    piece_count = len(board.piece_map())
    if piece_count > 7:
        return {"available": True, "eligible": False, "piece_count": piece_count}
    try:
        with chess.syzygy.open_tablebase(str(tablebase_path)) as tablebase:
            wdl = int(tablebase.probe_wdl(board))
            try:
                dtz = int(tablebase.probe_dtz(board))
            except KeyError:
                dtz = None
            move_rows: list[dict[str, Any]] = []
            for move in board.legal_moves:
                san = board.san(move)
                child = board.copy(stack=False)
                child.push(move)
                if child.is_checkmate():
                    mover_wdl = 2
                    child_dtz: int | None = None
                elif child.is_stalemate() or child.is_insufficient_material():
                    mover_wdl = 0
                    child_dtz = 0
                else:
                    mover_wdl = -int(tablebase.probe_wdl(child))
                    try:
                        child_dtz = -int(tablebase.probe_dtz(child))
                    except KeyError:
                        child_dtz = None
                move_rows.append(
                    {
                        "uci": board.uci(move),
                        "san": san,
                        "wdl": mover_wdl,
                        "dtz": child_dtz,
                    }
                )
            best_wdl = max((int(row["wdl"]) for row in move_rows), default=wdl)
            optimal_moves = [row for row in move_rows if int(row["wdl"]) == best_wdl]
    except (KeyError, OSError) as exc:
        return {
            "available": True,
            "eligible": True,
            "piece_count": piece_count,
            "missing": True,
            "reason": str(exc),
        }
    labels = {-2: "loss", -1: "blessed loss", 0: "draw", 1: "cursed win", 2: "win"}
    return {
        "available": True,
        "eligible": True,
        "piece_count": piece_count,
        "wdl": wdl,
        "result": labels.get(wdl, str(wdl)),
        "dtz": dtz,
        "moves": move_rows,
        "optimal_moves": optimal_moves,
        "move_policy": "WDL-preserving candidates; not a DTZ/50-move perfect-play policy",
        "only_winning_move": (
            optimal_moves[0]["uci"]
            if wdl > 0 and len(optimal_moves) == 1 and best_wdl > 0
            else None
        ),
    }


def _captured_name(board: chess.Board, move: chess.Move) -> str | None:
    square = move.to_square
    if board.is_en_passant(move):
        square += -8 if board.turn == chess.WHITE else 8
    piece = board.piece_at(square)
    return chess.piece_name(piece.piece_type) if piece is not None else None


def _analysis_summary(results: list[dict[str, Any]]) -> dict[str, Any]:
    by_side: dict[str, list[int]] = {"white": [], "black": []}
    phase_cpl: dict[str, list[int]] = {"opening": [], "middlegame": [], "endgame": []}
    class_counts: dict[str, int] = {}
    counts = {"Inaccuracy": 0, "Mistake": 0, "Blunder": 0}
    biggest: dict[str, Any] | None = None
    for result in results:
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
    all_cpl = [max(0, int(result.get("cpl", 0))) for result in results]
    accuracy = (
        round(sum(100.0 * math.exp(-value / 300.0) for value in all_cpl) / len(all_cpl), 1)
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


def _run_analysis_worker(payload: dict[str, Any]) -> None:
    """Analyze a main line in an isolated process and stream one JSON record per ply."""

    initial_fen = str(payload.get("initial_fen", chess.STARTING_FEN))
    moves_raw = payload.get("moves", [])
    budget_ms = max(80, min(1_500, int(payload.get("budget_ms", 100))))
    if not isinstance(moves_raw, list) or len(moves_raw) > 1_000:
        raise ValueError("Analysis move list is invalid.")
    board = _board_from_fen(initial_fen, chess960=bool(payload.get("chess960", False)))
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
        best_move = board.parse_uci(best_uci)
        best_uci = board.uci(best_move)
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
            "motifs": _detect_tactical_motifs(board, move),
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

    board = _board_from_fen(
        str(payload.get("fen", chess.STARTING_FEN)),
        chess960=bool(payload.get("chess960", False)),
    )
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
            "changed_moves": sum(a.move != b.move for a, b in zip(rows, other, strict=True)),
        }
    print(json.dumps(result, separators=(",", ":")), flush=True)


def _run_regression_worker(payload: dict[str, Any]) -> None:
    scale = max(0.1, min(5.0, float(payload.get("clock_scale", 0.5))))
    rows = run_regression_suite(scale)
    result: dict[str, Any] = {"clock_scale": scale, "rows": rows}
    baseline = payload.get("baseline")
    if isinstance(baseline, list):
        safe_baseline = [item for item in baseline if isinstance(item, dict)][:100]
        result["comparison"] = compare_regression_runs(rows, safe_baseline)
    print(json.dumps(result, separators=(",", ":")), flush=True)


def _run_selfplay_worker(payload: dict[str, Any]) -> None:
    games = max(1, min(20, int(payload.get("games", 2))))
    clock_ms = max(500, min(30_000, int(payload.get("clock_ms", 4_000))))
    rows = generate_selfplay_dataset(games, clock_ms)
    positions = sum(len(row.get("positions", [])) for row in rows)
    print(
        json.dumps(
            {"games": games, "clock_ms": clock_ms, "positions": positions, "rows": rows},
            separators=(",", ":"),
        ),
        flush=True,
    )


def _run_tuner_worker(payload: dict[str, Any]) -> None:
    raw = payload.get("parameters")
    parameters = [str(item) for item in raw] if isinstance(raw, list) else None
    print(json.dumps(coordinate_tune(parameters), separators=(",", ":")), flush=True)


def _run_tournament_worker(payload: dict[str, Any]) -> None:
    print(json.dumps(run_tournament(payload), separators=(",", ":")), flush=True)


def _run_calibration_worker(payload: dict[str, Any]) -> None:
    print(json.dumps(calibrate_against_uci(payload), separators=(",", ":")), flush=True)


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
        self.chess960 = False
        self.white_ms = DEFAULT_CLOCK_MS
        self.black_ms = DEFAULT_CLOCK_MS
        self.base_clock_ms = DEFAULT_CLOCK_MS
        self.white_base_clock_ms = DEFAULT_CLOCK_MS
        self.black_base_clock_ms = DEFAULT_CLOCK_MS
        self.increment_ms = DEFAULT_INCREMENT_MS
        self.delay_ms = 0
        self.clock_mode = "increment"
        self.time_stages: list[dict[str, int]] = []
        self.last_move: chess.Move | None = None
        self.last_engine_ms = 0
        self.last_engine_nodes = 0
        self.last_engine_depth: int | None = None
        self.last_engine_score: int | None = None
        self.last_engine_pv: tuple[str, ...] = ()
        self.last_engine_researches = 0
        self.last_engine_tt_hits = 0
        self.last_engine_beta_cutoffs = 0
        self.last_engine_quiescence_nodes = 0
        self.last_engine_budget_ms = 0
        self.last_engine_pv_changed = False
        self.engine_profile = "maximum"
        self.engine_skill = 100
        self.engine_move_time_cap_ms = 2_500
        self.history: list[tuple[int, int]] = []
        # `history` is the undo baseline (pre-increment). Keep a separate clock
        # record for review so Analysis can show the time actually displayed
        # after each played move without re-running a live timer.
        self.recorded_initial_clocks: tuple[int | None, int | None] = (
            DEFAULT_CLOCK_MS,
            DEFAULT_CLOCK_MS,
        )
        self.recorded_clocks: list[tuple[int | None, int | None]] = []
        self.paused = False
        self.manual_result: str | None = None
        self.manual_termination: str | None = None
        self.pgn_headers: dict[str, str] = {}
        # Keep the parsed import tree solely as a fidelity-preserving export
        # template. The live board remains the authoritative main line. Any
        # move-stack mutation invalidates this tree before export so comments,
        # NAGs, or RAVs from an older line can never be attached to new play.
        self._imported_pgn_game: chess.pgn.Game | None = None
        self.analysis_status = "idle"
        self.analysis_completed = 0
        self.analysis_total = 0
        self.analysis_results: list[dict[str, Any]] = []
        self.analysis_error: str | None = None
        self.analysis_budget_ms = 100
        self.analysis_generation = 0
        self.analysis_cancel = threading.Event()
        self.turn_started_ns = time.monotonic_ns()

    def _cancel_analysis_locked(self) -> None:
        """Invalidate and stop a local post-game analysis worker if one exists."""

        self.analysis_generation += 1
        self.analysis_cancel.set()
        self.analysis_cancel = threading.Event()
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
        *,
        chess960: bool = False,
        white_clock_ms: int | None = None,
        black_clock_ms: int | None = None,
        clock_mode: str = "increment",
        delay_ms: int = 0,
        time_stages: list[dict[str, int]] | None = None,
    ) -> None:
        board = _board_from_fen(fen, chess960=bool(chess960))
        if not board.is_valid():
            raise ValueError(
                "Invalid chess position. Check that both kings exist, pawns are off the back "
                "ranks, kings are not adjacent, and castling/en-passant rights match the board."
            )
        mode = str(clock_mode).strip().lower()
        if mode not in {"increment", "bronstein", "hourglass"}:
            raise ValueError("Clock mode must be increment, bronstein, or hourglass.")
        stages: list[dict[str, int]] = []
        for raw in time_stages or []:
            if not isinstance(raw, dict):
                raise ValueError("Time-control stages must be objects.")
            moves = int(raw.get("moves", 0))
            add_ms = int(raw.get("add_ms", 0))
            if moves < 1 or moves > 500 or add_ms < 1 or add_ms > 24 * 60 * 60 * 1_000:
                raise ValueError("Time-control stage is outside the supported range.")
            stages.append({"moves": moves, "add_ms": add_ms})
        if len(stages) > 8 or len({stage["moves"] for stage in stages}) != len(stages):
            raise ValueError("Time-control stages must use unique move numbers (maximum 8 stages).")
        stages.sort(key=lambda item: item["moves"])
        base = max(1, int(clock_ms))
        white_base = max(1, int(white_clock_ms if white_clock_ms is not None else base))
        black_base = max(1, int(black_clock_ms if black_clock_ms is not None else base))
        with self.lock:
            self._cancel_analysis_locked()
            agent.reset_game_state()
            self.board = board
            self.initial_fen = fen
            self.chess960 = bool(chess960)
            self.white_ms = white_base
            self.black_ms = black_base
            self.base_clock_ms = base
            self.white_base_clock_ms = white_base
            self.black_base_clock_ms = black_base
            self.increment_ms = max(0, int(increment_ms))
            self.delay_ms = max(0, int(delay_ms))
            self.clock_mode = mode
            self.time_stages = stages
            self.last_move = None
            self.last_engine_ms = 0
            self.last_engine_nodes = 0
            self.last_engine_depth = None
            self.last_engine_score = None
            self.last_engine_pv = ()
            self.last_engine_researches = 0
            self.last_engine_tt_hits = 0
            self.last_engine_beta_cutoffs = 0
            self.last_engine_quiescence_nodes = 0
            self.last_engine_budget_ms = 0
            self.last_engine_pv_changed = False
            self.history.clear()
            self.recorded_initial_clocks = (self.white_base_clock_ms, self.black_base_clock_ms)
            self.recorded_clocks.clear()
            self.paused = False
            self.manual_result = None
            self.manual_termination = None
            self.pgn_headers = {}
            self._imported_pgn_game = None
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
            if self.clock_mode == "hourglass":
                black_ms += elapsed_ms
        else:
            black_ms -= elapsed_ms
            if self.clock_mode == "hourglass":
                white_ms += elapsed_ms
        return max(0, int(white_ms)), max(0, int(black_ms))

    def _commit_clock(self) -> int:
        now = time.monotonic_ns()
        elapsed_ms = max(0, (now - self.turn_started_ns) // 1_000_000)
        self.white_ms, self.black_ms = self._current_clocks(now)
        self.turn_started_ns = now
        return int(elapsed_ms)

    def _apply_elapsed(self, color: chess.Color, elapsed_ms: int) -> None:
        elapsed = max(0, int(elapsed_ms))
        if color == chess.WHITE:
            self.white_ms = max(0, self.white_ms - elapsed)
            if self.clock_mode == "hourglass":
                self.black_ms += elapsed
        else:
            self.black_ms = max(0, self.black_ms - elapsed)
            if self.clock_mode == "hourglass":
                self.white_ms += elapsed

    def _post_move_clock(self, mover: chess.Color, elapsed_ms: int) -> None:
        bonus = 0
        if self.clock_mode == "increment":
            bonus = self.increment_ms
        elif self.clock_mode == "bronstein":
            bonus = min(self.delay_ms, max(0, int(elapsed_ms)))
        move_number = len(self.board.move_stack) // 2 + 1
        bonus += sum(stage["add_ms"] for stage in self.time_stages if stage["moves"] == move_number)
        if mover == chess.WHITE:
            self.white_ms += bonus
        else:
            self.black_ms += bonus

    def _clock_flag(self, white_ms: int, black_ms: int) -> chess.Color | None:
        if self.manual_result is not None or self.board.is_game_over(claim_draw=True):
            return None
        if self.board.turn == chess.WHITE and white_ms <= 0:
            return chess.WHITE
        if self.board.turn == chess.BLACK and black_ms <= 0:
            return chess.BLACK
        return None

    def configure_engine(
        self,
        *,
        profile: str | None = None,
        skill: int | None = None,
        move_time_cap_ms: int | None = None,
    ) -> dict[str, Any]:
        """Configure GUI-only playing style without changing the competition API."""

        with self.lock:
            if profile is not None:
                normalized = str(profile).strip().lower()
                allowed = {"maximum", "fast", "beginner", "aggressive", "solid", "adaptive"}
                if normalized not in allowed:
                    raise ValueError("Unknown engine personality.")
                self.engine_profile = normalized
            if skill is not None:
                self.engine_skill = max(1, min(100, int(skill)))
            if move_time_cap_ms is not None:
                self.engine_move_time_cap_ms = max(50, min(10_000, int(move_time_cap_ms)))
            return {
                "profile": self.engine_profile,
                "skill": self.engine_skill,
                "move_time_cap_ms": self.engine_move_time_cap_ms,
            }

    def time_management_coaching(self) -> dict[str, Any]:
        """Summarize clock usage and analysis quality without mutating the game."""

        with self.lock:
            initial_white, initial_black = self.recorded_initial_clocks
            previous = [initial_white, initial_black]
            replay = _board_from_fen(self.initial_fen, chess960=self.chess960)
            think_times: dict[str, list[int]] = {"white": [], "black": []}
            long_thinks = 0
            time_trouble_errors = 0
            impulsive_errors = 0
            analysis_by_ply = {
                int(item.get("ply", -1)): item
                for item in self.analysis_results
                if isinstance(item, dict)
            }
            for ply, clocks in enumerate(self.recorded_clocks, start=1):
                mover = replay.turn
                side_index = 0 if mover == chess.WHITE else 1
                side_name = "white" if mover == chess.WHITE else "black"
                before = previous[side_index]
                after = clocks[side_index]
                spent = 0
                if before is not None and after is not None:
                    bonus = self.increment_ms if self.clock_mode == "increment" else 0
                    spent = max(0, int(before) + bonus - int(after))
                    think_times[side_name].append(spent)
                    base = (
                        self.white_base_clock_ms
                        if mover == chess.WHITE
                        else self.black_base_clock_ms
                    )
                    if spent > max(5_000, int(base * 0.18)):
                        long_thinks += 1
                    item = analysis_by_ply.get(ply)
                    cpl = int(item.get("cpl", 0)) if item else 0
                    if cpl >= 120 and spent < 1_200:
                        impulsive_errors += 1
                    if cpl >= 120 and int(after) < max(5_000, int(base * 0.12)):
                        time_trouble_errors += 1
                previous = [clocks[0], clocks[1]]
                if ply <= len(self.board.move_stack):
                    replay.push(self.board.move_stack[ply - 1])

            averages = {
                side: round(sum(values) / len(values)) if values else 0
                for side, values in think_times.items()
            }
            advice: list[str] = []
            if impulsive_errors:
                advice.append(
                    f"You made {impulsive_errors} analyzed error(s) after thinking under "
                    "1.2 seconds."
                )
            if time_trouble_errors:
                advice.append(
                    f"{time_trouble_errors} analyzed error(s) happened with less than 12% "
                    "of the clock left."
                )
            if long_thinks >= 3:
                advice.append(
                    "Several moves used over 18% of the starting clock; reserve time for later "
                    "decisions."
                )
            if not advice:
                advice.append(
                    "Clock usage is balanced so far; keep matching thinking time to position "
                    "complexity."
                )
            return {
                "average_think_ms": averages,
                "long_thinks": long_thinks,
                "impulsive_errors": impulsive_errors,
                "time_trouble_errors": time_trouble_errors,
                "advice": advice,
            }

    def position_insights(self, fen: str) -> dict[str, Any]:
        board = _board_from_fen(fen, chess960=self.chess960)
        if not board.is_valid():
            raise ValueError("Position insights require a valid board.")
        return _position_insights(board)

    def tactical_motifs(self, fen: str, move_uci: str) -> dict[str, Any]:
        board = _board_from_fen(fen, chess960=self.chess960)
        if not board.is_valid():
            raise ValueError("Tactical motif detection requires a valid board.")
        try:
            move = board.parse_uci(move_uci)
        except ValueError as exc:
            raise ValueError("Tactical motif move must be legal UCI.") from exc
        if move not in board.legal_moves:
            raise ValueError("Tactical motif move must be legal UCI.")
        return {
            "fen": board.fen(),
            "move": board.uci(move),
            "san": board.san(move),
            "motifs": _detect_tactical_motifs(board, move),
        }

    def tablebase_probe(self, fen: str, path: str = "") -> dict[str, Any]:
        return _tablebase_probe(fen, path)

    def compare_external_uci(
        self,
        executable: str,
        fen: str,
        budget_ms: int = 300,
        lines: int = 3,
    ) -> dict[str, Any]:
        """Compare FunChessEngine with a user-selected local UCI executable."""

        budget = max(100, min(2_000, int(budget_ms)))
        line_count = max(1, min(5, int(lines)))
        board = _board_from_fen(fen, chess960=self.chess960)
        if not board.is_valid() or board.is_game_over(claim_draw=True):
            raise ValueError("Engine comparison requires a valid non-terminal position.")
        ours = self.multipv_fen(board.fen(), line_count, budget)
        with (
            worker_slot(),
            ExternalUCIEngine(executable, timeout_s=max(3.0, budget / 1_000 + 2.0)) as external,
        ):
            external.new_game(chess960=self.chess960)
            theirs = external.analyze(
                board.fen(),
                budget,
                chess960=self.chess960,
                multipv=line_count,
            )
        our_line = ours.get("lines", [{}])[0] if ours.get("lines") else {}
        return {
            "fen": board.fen(),
            "budget_ms": budget,
            "lines": line_count,
            "funchess": {
                "move": our_line.get("move"),
                "san": our_line.get("san"),
                "score": our_line.get("score"),
                "depth": ours.get("depth"),
                "nodes": ours.get("nodes"),
                "elapsed_ms": ours.get("elapsed_ms"),
                "lines": list(ours.get("lines", [])),
            },
            "external": {
                "move": theirs.move,
                "san": board.san(board.parse_uci(theirs.move)),
                "name": theirs.engine_name,
                "elapsed_ms": theirs.elapsed_ms,
                "lines": [asdict(line) for line in theirs.lines],
                "options": {
                    name: asdict(option)
                    for name, option in external.options.items()
                    if name in {"MultiPV", "UCI_Elo", "UCI_LimitStrength", "Skill Level"}
                },
                "info": list(theirs.info[-20:]),
            },
            "agree": our_line.get("move") == theirs.move,
        }

    @staticmethod
    def _profile_static_score(board: chess.Board, move: chess.Move, profile: str) -> int:
        mover = board.turn
        is_capture = board.is_capture(move)
        is_castling = board.is_castling(move)
        moving_piece = board.piece_at(move.from_square)
        board.push(move)
        try:
            score = -int(agent.evaluate(board))
            if profile == "aggressive":
                if is_capture:
                    score += 45
                if board.is_check():
                    score += 35
                if move.promotion:
                    score += 30
            elif profile == "solid":
                if is_castling:
                    score += 55
                if (
                    moving_piece
                    and moving_piece.piece_type == chess.QUEEN
                    and board.fullmove_number <= 8
                ):
                    score -= 20
                # Prefer pieces that remain defended after moving, all else equal.
                if board.is_attacked_by(mover, move.to_square):
                    score += 12
            return score
        finally:
            board.pop()

    def _select_profile_move(
        self,
        board: chess.Board,
        searched_uci: str,
        profile: str,
        skill: int,
    ) -> str:
        if profile in {"maximum", "fast"} or (profile == "adaptive" and skill >= 75):
            return searched_uci
        legal = list(board.legal_moves)
        if len(legal) <= 1:
            return searched_uci
        scoring_profile = profile if profile in {"aggressive", "solid"} else "maximum"
        ranked = sorted(
            legal,
            key=lambda move: self._profile_static_score(board, move, scoring_profile),
            reverse=True,
        )
        searched = chess.Move.from_uci(searched_uci)
        if searched in ranked:
            ranked.remove(searched)
            # Keep the searched move in the candidate set, but let an explicit
            # personality occasionally prefer a characteristic near-equal move.
            ranked.insert(0, searched)
        if profile in {"aggressive", "solid"}:
            candidates = ranked[: min(4, len(ranked))]
            return max(
                candidates,
                key=lambda move: self._profile_static_score(board, move, profile),
            ).uci()
        # Beginner/adaptive weakening is deterministic for a position so saved
        # games and tests remain reproducible. Lower skill allows a wider rank.
        spread = 1 + max(0, (70 - skill) // 15)
        index = sum(ord(char) for char in board.fen()) % min(spread, len(ranked))
        return ranked[index].uci()

    def _moves_uci(self) -> list[str]:
        return [move.uci() for move in self.board.move_stack]

    @staticmethod
    def _captures(board: chess.Board) -> tuple[list[str], list[str]]:
        replay = board.root()
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

    def load_snapshot(self, payload: dict[str, Any], *, reset_engine: bool = True) -> None:
        """Restore a game exported by the local Engine Lab."""

        initial_fen = str(payload.get("initial_fen", chess.STARTING_FEN))
        moves_raw = payload.get("moves", [])
        history_raw = payload.get("clock_history", [])
        recorded_raw = payload.get("recorded_clock_history", [])
        recorded_initial_raw = payload.get("recorded_initial_clocks")
        if not isinstance(moves_raw, list) or len(moves_raw) > 1_000:
            raise ValueError("Saved game contains an invalid move list.")
        if not isinstance(history_raw, list) or len(history_raw) > 1_000:
            raise ValueError("Saved game contains invalid clock history.")
        if not isinstance(recorded_raw, list) or len(recorded_raw) > 1_000:
            raise ValueError("Saved game contains invalid recorded clock history.")

        chess960 = str(payload.get("variant", "standard")).lower() == "chess960" or bool(
            payload.get("chess960", False)
        )
        board = _board_from_fen(initial_fen, chess960=chess960)
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

        def optional_clock_pair(raw: Any, label: str) -> tuple[int | None, int | None]:
            if not isinstance(raw, (list, tuple)) or len(raw) != 2:
                raise ValueError(f"Saved game contains invalid {label}.")
            result: list[int | None] = []
            for value in raw:
                result.append(None if value is None else max(0, int(value)))
            return result[0], result[1]

        recorded: list[tuple[int | None, int | None]] = [
            optional_clock_pair(item, "recorded clock history") for item in recorded_raw
        ]
        if recorded and len(recorded) != len(moves):
            raise ValueError("Saved game recorded clock history does not match its moves.")

        with self.lock:
            self._cancel_analysis_locked()
            if reset_engine:
                agent.reset_game_state()
            self.board = board
            self.initial_fen = initial_fen
            self.chess960 = chess960
            self.white_ms = max(0, int(payload.get("white_ms", DEFAULT_CLOCK_MS)))
            self.black_ms = max(0, int(payload.get("black_ms", DEFAULT_CLOCK_MS)))
            self.base_clock_ms = max(
                1, int(payload.get("base_clock_ms", max(self.white_ms, self.black_ms, 1)))
            )
            self.white_base_clock_ms = max(
                1, int(payload.get("white_base_clock_ms", self.base_clock_ms))
            )
            self.black_base_clock_ms = max(
                1, int(payload.get("black_base_clock_ms", self.base_clock_ms))
            )
            self.increment_ms = max(0, int(payload.get("increment_ms", DEFAULT_INCREMENT_MS)))
            self.delay_ms = max(0, int(payload.get("delay_ms", 0)))
            clock_mode = str(payload.get("clock_mode", "increment")).lower()
            self.clock_mode = (
                clock_mode if clock_mode in {"increment", "bronstein", "hourglass"} else "increment"
            )
            stages_raw = payload.get("time_stages", [])
            self.time_stages = []
            if isinstance(stages_raw, list):
                seen_moves: set[int] = set()
                for raw in stages_raw[:8]:
                    if not isinstance(raw, dict):
                        continue
                    stage_moves = max(1, min(500, int(raw.get("moves", 0))))
                    add_ms = max(1, min(24 * 60 * 60 * 1_000, int(raw.get("add_ms", 0))))
                    if stage_moves not in seen_moves:
                        self.time_stages.append({"moves": stage_moves, "add_ms": add_ms})
                        seen_moves.add(stage_moves)
                self.time_stages.sort(key=lambda item: item["moves"])
            if recorded_initial_raw is None:
                self.recorded_initial_clocks = (
                    self.white_base_clock_ms,
                    self.black_base_clock_ms,
                )
            else:
                self.recorded_initial_clocks = optional_clock_pair(
                    recorded_initial_raw,
                    "recorded initial clocks",
                )
            self.last_move = moves[-1] if moves else None
            self.last_engine_ms = 0
            self.last_engine_nodes = 0
            self.last_engine_depth = None
            self.last_engine_score = None
            self.last_engine_pv = ()
            self.last_engine_researches = 0
            self.last_engine_tt_hits = 0
            self.last_engine_beta_cutoffs = 0
            self.last_engine_quiescence_nodes = 0
            self.last_engine_budget_ms = 0
            self.last_engine_pv_changed = False
            self.history = history if history else [(self.white_ms, self.black_ms) for _ in moves]
            if recorded:
                self.recorded_clocks = recorded
            elif history and self.clock_mode == "increment":
                # Older FunChessEngine saves only stored the undo clock
                # baseline. Reconstruct the post-move display clock by adding
                # increment to the mover, matching play_move()/engine_move().
                self.recorded_clocks = []
                for index, (white, black) in enumerate(history):
                    if index % 2 == 0:
                        white += self.increment_ms
                    else:
                        black += self.increment_ms
                    self.recorded_clocks.append((white, black))
            else:
                self.recorded_clocks = [(None, None) for _ in moves]
            self.paused = bool(payload.get("paused", False))
            manual_result = payload.get("manual_result")
            manual_termination = payload.get("manual_termination")
            self.manual_result = (
                str(manual_result) if manual_result in {"1-0", "0-1", "1/2-1/2"} else None
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
            # Saved-game snapshots contain only the live main line, not a PGN
            # annotation tree. Never retain an unrelated tree across a load.
            self._imported_pgn_game = None
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
            "variant": "chess960" if board.chess960 else "standard",
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

    def position_from_fen(self, fen: str, *, chess960: bool | None = None) -> dict[str, Any]:
        if chess960 is not None and not isinstance(chess960, bool):
            raise ValueError("Chess960 must be true or false.")
        board = _board_from_fen(fen, chess960=self.chess960 if chess960 is None else chess960)
        if not board.is_valid():
            raise ValueError("Analysis workspace requires a valid chess position.")
        return self._position_payload(board)

    def variation_move(self, fen: str, uci: str, *, chess960: bool | None = None) -> dict[str, Any]:
        if chess960 is not None and not isinstance(chess960, bool):
            raise ValueError("Chess960 must be true or false.")
        board = _board_from_fen(fen, chess960=self.chess960 if chess960 is None else chess960)
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

        board = _board_from_fen(fen, chess960=self.chess960)
        if not board.is_valid():
            raise ValueError("Evaluation breakdown requires a valid chess position.")
        material = 0
        for piece_type in range(chess.PAWN, chess.KING):
            material += agent.MG_VALUE[piece_type] * (
                len(board.pieces(piece_type, chess.WHITE))
                - len(board.pieces(piece_type, chess.BLACK))
            )
        mobility = 3 * (agent._mobility(board, chess.WHITE) - agent._mobility(board, chess.BLACK))
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
        if game.errors:
            raise ValueError("PGN contains invalid or illegal notation.")

        board = game.board()
        if not board.is_valid():
            raise ValueError("PGN starts from an invalid chess position.")
        initial_fen = board.fen()
        moves: list[chess.Move] = []
        clock_nodes: list[tuple[chess.Color, float | None]] = []
        replay = game.board()
        for node in game.mainline():
            move = node.move
            if move is None:
                continue
            if move not in replay.legal_moves:
                raise ValueError(f"PGN contains illegal move {move.uci()}.")
            mover = replay.turn
            replay.push(move)
            moves.append(move)
            clock_nodes.append((mover, node.clock()))
            if len(moves) > 1_000:
                raise ValueError("PGN contains too many moves for the local review workspace.")
        board = replay

        headers = {
            str(key): str(value)
            for key, value in game.headers.items()
            if str(value) not in {"?", ""}
        }
        time_control = headers.get("TimeControl", "")
        base_clock_ms: int | None = None
        increment_ms = 0
        if time_control:
            fields = time_control.split("+", 1)
            try:
                if len(fields) == 1 and fields[0].isdigit():
                    base_clock_ms = max(1, int(fields[0]) * 1_000)
                elif len(fields) == 2 and fields[0].isdigit() and fields[1].isdigit():
                    base_clock_ms = max(1, int(fields[0]) * 1_000)
                    increment_ms = max(0, int(fields[1]) * 1_000)
            except ValueError:
                base_clock_ms = None
                increment_ms = 0

        recorded_initial: tuple[int | None, int | None] = (
            base_clock_ms,
            base_clock_ms,
        )
        last_known: list[int | None] = [base_clock_ms, base_clock_ms]
        recorded_clocks: list[tuple[int | None, int | None]] = []
        for mover, clock_seconds in clock_nodes:
            mover_index = 0 if mover == chess.WHITE else 1
            if clock_seconds is None:
                # Do not invent elapsed time when an imported PGN has no clock
                # annotation for this move. Preserve only the opponent's last
                # known value and mark the mover's value unknown.
                last_known[mover_index] = None
            else:
                last_known[mover_index] = max(0, round(clock_seconds * 1_000))
            recorded_clocks.append((last_known[0], last_known[1]))
        result = headers.get("Result")
        with self.lock:
            self._cancel_analysis_locked()
            agent.reset_game_state()
            self.board = board
            self.initial_fen = initial_fen
            self.chess960 = bool(board.chess960)
            if base_clock_ms is not None:
                self.base_clock_ms = base_clock_ms
                self.increment_ms = increment_ms
            else:
                # Imported games without a TimeControl tag must not inherit the
                # unrelated clock settings from whichever game happened to be
                # open before the import.
                self.base_clock_ms = DEFAULT_CLOCK_MS
                self.increment_ms = DEFAULT_INCREMENT_MS
            self.white_base_clock_ms = self.base_clock_ms
            self.black_base_clock_ms = self.base_clock_ms
            self.clock_mode = "increment"
            self.delay_ms = 0
            self.time_stages = []
            self.white_ms = self.base_clock_ms
            self.black_ms = self.base_clock_ms
            self.recorded_initial_clocks = recorded_initial
            self.recorded_clocks = recorded_clocks
            self.last_move = moves[-1] if moves else None
            self.last_engine_ms = 0
            self.last_engine_nodes = 0
            self.last_engine_depth = None
            self.last_engine_score = None
            self.last_engine_pv = ()
            self.last_engine_researches = 0
            self.last_engine_tt_hits = 0
            self.last_engine_beta_cutoffs = 0
            self.last_engine_quiescence_nodes = 0
            self.last_engine_budget_ms = 0
            self.last_engine_pv_changed = False
            self.history = [(self.base_clock_ms, self.base_clock_ms) for _ in moves]
            self.paused = True
            self.manual_result = result if result in {"1-0", "0-1", "1/2-1/2"} else None
            self.manual_termination = (
                headers.get("Termination", "pgn_import") if self.manual_result is not None else None
            )
            self.pgn_headers = headers
            self._imported_pgn_game = game
            self.turn_started_ns = time.monotonic_ns()

    @staticmethod
    def parse_pgn_batch(text: str, max_games: int = 200) -> list[dict[str, Any]]:
        """Parse a bounded multi-game PGN without mutating the live session."""

        if not text.strip():
            raise ValueError("PGN file is empty.")
        if len(text.encode("utf-8")) > 2 * 1024 * 1024:
            raise ValueError("PGN file is too large for the local game library.")
        limit = max(1, min(500, int(max_games)))
        stream = io.StringIO(text)
        games: list[dict[str, Any]] = []
        while len(games) < limit:
            try:
                game = chess.pgn.read_game(stream)
            except (ValueError, UnicodeError) as exc:
                raise ValueError("Could not parse this PGN collection.") from exc
            if game is None:
                break
            if game.errors:
                raise ValueError(f"PGN game {len(games) + 1} contains invalid notation.")
            moves = [move.uci() for move in game.mainline_moves()]
            if len(moves) > 1_000:
                raise ValueError(f"PGN game {len(games) + 1} contains too many moves.")
            board = game.board()
            games.append(
                {
                    "index": len(games) + 1,
                    "pgn": str(game),
                    "headers": {str(key): str(value) for key, value in game.headers.items()},
                    "initial_fen": board.fen(),
                    "moves_uci": moves,
                    "variant": "chess960" if board.chess960 else "standard",
                }
            )
        if not games:
            raise ValueError("No chess games were found in this PGN.")
        # Reaching the limit is fine for exactly `limit` games, but reject a
        # collection that contains still more data rather than silently
        # truncating a user's database import.
        if len(games) == limit:
            try:
                extra = chess.pgn.read_game(stream)
            except (ValueError, UnicodeError) as exc:
                raise ValueError("Could not parse this PGN collection.") from exc
            if extra is not None:
                raise ValueError(f"PGN collection exceeds the {limit}-game import limit.")
        return games

    def analyze_pgn(self, text: str, budget_ms: int = 100) -> dict[str, Any]:
        """Analyze one PGN in an isolated worker without replacing the live game."""

        item = self.parse_pgn_batch(text, max_games=1)[0]
        moves = list(item["moves_uci"])
        if not moves:
            raise ValueError("Analyze a PGN containing at least one move.")
        budget = max(80, min(1_500, int(budget_ms)))
        payload = {
            "initial_fen": item["initial_fen"],
            "moves": moves,
            "budget_ms": budget,
            "chess960": item["variant"] == "chess960",
        }
        if getattr(sys, "frozen", False):
            command = [sys.executable, "--analysis-worker"]
        else:
            command = [sys.executable, "-m", "gui.server", "--analysis-worker"]
        results: list[dict[str, Any]] = []

        def record(message: dict[str, Any]) -> None:
            if message.get("type") == "move":
                results.append(message)
                progress({"completed": len(results), "total": len(moves)})

        completed = run_process(
            command,
            payload,
            max(20.0, len(moves) * (budget / 1000 * 5 + 0.35)),
            str(Path(__file__).resolve().parents[1]),
            on_message=record,
        )
        if completed.get("type") != "done":
            raise RuntimeError("Analysis worker did not complete.")
        return {
            "headers": item["headers"],
            "variant": item["variant"],
            "total": len(moves),
            "budget_ms": budget,
            "results": results,
            "summary": _analysis_summary(results),
        }

    def export_pgn(self) -> str:
        """Return a standards-compatible PGN without stale imported annotations."""

        with self.lock:
            game = self._imported_pgn_game
            using_imported_tree = game is not None
            if game is not None:
                imported_moves = [move.uci() for move in game.mainline_moves()]
                if game.board().fen() != self.initial_fen or imported_moves != self._moves_uci():
                    # Defensive guard in addition to explicit invalidation at
                    # mutation sites. The live board always wins if state ever
                    # diverges from the retained import tree.
                    self._imported_pgn_game = None
                    game = None
                    using_imported_tree = False

            if game is None:
                game = chess.pgn.Game()
                for key, value in self.pgn_headers.items():
                    game.headers[key] = value
                if self.initial_fen != chess.STARTING_FEN:
                    game.setup(_board_from_fen(self.initial_fen, chess960=self.chess960))
                if self.chess960:
                    game.headers["Variant"] = "Chess960"

                node: chess.pgn.GameNode = game
                replay = _board_from_fen(self.initial_fen, chess960=self.chess960)
                for index, move in enumerate(self.board.move_stack):
                    if move not in replay.legal_moves:
                        raise RuntimeError("Current game history cannot be exported as legal PGN.")
                    node = node.add_variation(move)
                    if index < len(self.recorded_clocks):
                        pair = self.recorded_clocks[index]
                        mover_clock = pair[0] if replay.turn == chess.WHITE else pair[1]
                        if mover_clock is not None:
                            node.set_clock(mover_clock / 1_000)
                    replay.push(move)

            state = self.state()
            result = state["result"] or "*"
            game.headers["Result"] = str(result)
            if state["termination"]:
                # ``pgn_import`` is an internal UI reason used when a finished
                # import omitted Termination. Do not invent that header on an
                # otherwise untouched round trip.
                if not (
                    using_imported_tree
                    and state["termination"] == "pgn_import"
                    and "Termination" not in self.pgn_headers
                ):
                    game.headers["Termination"] = str(state["termination"]).replace("_", " ")
            elif "Termination" in game.headers:
                # Undoing an imported finished game clears its result. Do not
                # leave a now-stale termination header behind on regenerated
                # main-line PGN.
                del game.headers["Termination"]
            return str(game)

    def review_state(self, ply: int) -> dict[str, Any]:
        """Return a board snapshot at a main-line ply without mutating the live game."""

        with self.lock:
            total = len(self.board.move_stack)
            target = max(0, min(int(ply), total))
            replay = _board_from_fen(self.initial_fen, chess960=self.chess960)
            moves = list(self.board.move_stack)
            for move in moves[:target]:
                replay.push(move)
            last_move = moves[target - 1].uci() if target else None
            captured_by_white, captured_by_black = self._captures(replay)
            opening = _opening_from_moves(self.initial_fen, [move.uci() for move in moves[:target]])
            if target == 0:
                recorded_white_ms, recorded_black_ms = self.recorded_initial_clocks
            elif target <= len(self.recorded_clocks):
                recorded_white_ms, recorded_black_ms = self.recorded_clocks[target - 1]
            else:
                recorded_white_ms = recorded_black_ms = None
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
                "recorded_white_ms": recorded_white_ms,
                "recorded_black_ms": recorded_black_ms,
            }

    def review_series(self) -> dict[str, Any]:
        """Return static white-perspective evaluations for each main-line ply."""

        with self.lock:
            replay = _board_from_fen(self.initial_fen, chess960=self.chess960)
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
        return _analysis_summary(self.analysis_results)

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
            replay = _board_from_fen(self.initial_fen, chess960=self.chess960)
            for move in list(self.board.move_stack)[:target]:
                replay.push(move)
            worker_budget = max(100, min(2_000, int(budget_ms)))
            payload = {
                "fen": replay.fen(),
                "lines": max(1, min(5, int(lines))),
                "budget_ms": worker_budget,
                "chess960": self.chess960,
            }
        return self._multipv_payload(
            payload,
            target=target,
            total=total,
            turn="white" if replay.turn == chess.WHITE else "black",
        )

    def multipv_fen(self, fen: str, lines: int = 3, budget_ms: int = 350) -> dict[str, Any]:
        """Analyze an arbitrary valid position without touching the live game."""

        board = _board_from_fen(fen, chess960=self.chess960)
        if not board.is_valid() or board.is_game_over(claim_draw=True):
            raise ValueError("MultiPV requires a valid non-terminal chess position.")
        worker_budget = max(100, min(2_000, int(budget_ms)))
        payload = {
            "fen": board.fen(),
            "lines": max(1, min(5, int(lines))),
            "budget_ms": worker_budget,
            "chess960": self.chess960,
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
        result = self._run_json_worker(
            "--multipv-worker", payload, timeout=max(8.0, worker_budget / 1_000 * 5 + 3)
        )
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
        return run_process(command, payload, timeout, cwd=str(Path(__file__).resolve().parents[1]))

    def benchmark_engine(self, clock_ms: int = 10_000, compare_path: str = "") -> dict[str, Any]:
        """Run the development benchmark outside the live engine process."""

        clock = max(1_500, min(30_000, int(clock_ms)))
        payload = {"clock_ms": clock, "compare_path": str(compare_path).strip()}
        # The clock-aware manager allocates only a small fraction of clock_ms per
        # position, but leave ample headroom for 12 positions plus a comparison.
        return self._run_json_worker("--benchmark-worker", payload, timeout=45.0)

    def regression_engine(
        self,
        baseline: list[dict[str, Any]] | None = None,
        clock_scale: float = 0.5,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"clock_scale": max(0.1, min(5.0, float(clock_scale)))}
        if baseline is not None:
            payload["baseline"] = baseline[:100]
        return self._run_json_worker("--regression-worker", payload, timeout=35.0)

    def selfplay_dataset(self, games: int = 2, clock_ms: int = 4_000) -> dict[str, Any]:
        count = max(1, min(20, int(games)))
        clock = max(500, min(30_000, int(clock_ms)))
        return self._run_json_worker(
            "--selfplay-worker",
            {"games": count, "clock_ms": clock},
            timeout=max(30.0, count * 160 * 2.7),
        )

    def tune_parameters(self, parameters: list[str] | None = None) -> dict[str, Any]:
        payload = {"parameters": list(parameters or [])}
        return self._run_json_worker("--tuner-worker", payload, timeout=120.0)

    def uci_tournament(self, payload: dict[str, Any]) -> dict[str, Any]:
        participants = payload.get("participants", [])
        count = len(participants) if isinstance(participants, list) else 0
        return self._run_json_worker(
            "--uci-tournament-worker",
            payload,
            timeout=max(
                120.0,
                count
                * max(8, count - 1)
                * 180
                * (min(2000, max(20, int(payload.get("movetime_ms", 80)))) / 1000 + 0.2),
            ),
        )

    def uci_calibration(self, payload: dict[str, Any]) -> dict[str, Any]:
        games = max(2, min(12, int(payload.get("games", 4))))
        return self._run_json_worker(
            "--uci-calibration-worker",
            payload,
            timeout=max(120.0, games * 180 * 1.2),
        )

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
            if (
                not self.paused
                and self.manual_result is None
                and not self.board.is_game_over(claim_draw=True)
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
                "chess960": self.chess960,
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
        with self.lock:
            if generation != self.analysis_generation:
                return
            cancellation = self.analysis_cancel

        def record(message: dict[str, Any]) -> None:
            with self.lock:
                if generation != self.analysis_generation:
                    raise JobCancelled("Analysis cancelled.")
                if message.get("type") == "move":
                    self.analysis_results.append(message)
                    self.analysis_completed = len(self.analysis_results)

        try:
            completed = run_process(
                command,
                payload,
                max(20.0, len(payload["moves"]) * (payload["budget_ms"] / 1000 * 5 + 0.35)),
                str(Path(__file__).resolve().parents[1]),
                on_message=record,
                cancel=cancellation,
            )
            if completed.get("type") != "done":
                raise RuntimeError("Analysis worker did not complete.")
            with self.lock:
                if generation == self.analysis_generation:
                    self.analysis_status = "complete"
        except Exception as exc:
            with self.lock:
                if generation == self.analysis_generation:
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
                "white_base_clock_ms": self.white_base_clock_ms,
                "black_base_clock_ms": self.black_base_clock_ms,
                "increment_ms": self.increment_ms,
                "delay_ms": self.delay_ms,
                "clock_mode": self.clock_mode,
                "time_stages": [dict(stage) for stage in self.time_stages],
                "variant": "chess960" if self.chess960 else "standard",
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
                "recorded_initial_clocks": list(self.recorded_initial_clocks),
                "recorded_clock_history": [list(pair) for pair in self.recorded_clocks],
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
                "last_engine_tt_hits": self.last_engine_tt_hits,
                "last_engine_beta_cutoffs": self.last_engine_beta_cutoffs,
                "last_engine_quiescence_nodes": self.last_engine_quiescence_nodes,
                "last_engine_budget_ms": self.last_engine_budget_ms,
                "last_engine_pv_changed": self.last_engine_pv_changed,
                "engine_profile": self.engine_profile,
                "engine_skill": self.engine_skill,
                "engine_move_time_cap_ms": self.engine_move_time_cap_ms,
                "analysis_status": self.analysis_status,
                "analysis_total": self.analysis_total,
                "phase": _phase_name(board),
                "opening": opening,
                "plans": _human_plan(board),
                "time_coaching": self.time_management_coaching(),
            }

    @staticmethod
    def _board_payload(board: chess.Board) -> dict[str, str]:
        return {
            chess.square_name(square): piece.symbol() for square, piece in board.piece_map().items()
        }

    @staticmethod
    def _pgn_moves(board: chess.Board) -> list[dict[str, Any]]:
        replay = board.root()
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
            elapsed_ms = self._commit_clock()
            mover = self.board.turn
            remaining = self.white_ms if mover == chess.WHITE else self.black_ms
            if remaining <= 0:
                side = "White" if mover == chess.WHITE else "Black"
                raise ValueError(f"{side} has flagged on time.")
            self._imported_pgn_game = None
            self.history.append((self.white_ms, self.black_ms))
            self._post_move_clock(mover, elapsed_ms)
            self.recorded_clocks.append((self.white_ms, self.black_ms))
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
            committed_elapsed_ms = self._commit_clock()
            available = self.white_ms if color == chess.WHITE else self.black_ms
            if available <= 0:
                side = "White" if color == chess.WHITE else "Black"
                raise ValueError(f"{side} has flagged on time.")
            requested = available if budget_ms is None else min(available, max(1, budget_ms))
            requested = min(requested, self.engine_move_time_cap_ms)
            skill_scale = 0.12 + 0.88 * (self.engine_skill / 100.0) ** 2
            if self.engine_profile == "fast":
                skill_scale *= 0.45
            requested = max(20, min(requested, int(requested * skill_scale)))
            fen = self.board.fen()
            before = time.monotonic_ns()
            agent.set_game_history(self.board)
            searched_uci = self.board.uci(self.board.parse_uci(agent.get_move(fen, requested)))
            uci = self._select_profile_move(
                self.board,
                searched_uci,
                self.engine_profile,
                self.engine_skill,
            )
            elapsed_ms = max(0, (time.monotonic_ns() - before) // 1_000_000)

            try:
                move = chess.Move.from_uci(uci)
            except ValueError as exc:
                raise RuntimeError(f"Engine returned malformed move {uci!r}.") from exc
            if move not in self.board.legal_moves:
                raise RuntimeError(f"Engine returned illegal move {uci!r}.")

            self._apply_elapsed(color, int(elapsed_ms))
            self.last_engine_ms = int(elapsed_ms)
            info = agent.LAST_SEARCH_INFO
            self.last_engine_nodes = int(info.nodes)
            self.last_engine_depth = int(info.depth)
            previous_pv = self.last_engine_pv
            if uci == searched_uci:
                self.last_engine_score = int(info.score)
                self.last_engine_pv = tuple(info.pv)
            else:
                self.last_engine_score = self._profile_static_score(
                    self.board,
                    move,
                    self.engine_profile,
                )
                self.last_engine_pv = (uci,)
            self.last_engine_researches = int(info.aspiration_researches)
            self.last_engine_tt_hits = int(info.tt_hits)
            self.last_engine_beta_cutoffs = int(info.beta_cutoffs)
            self.last_engine_quiescence_nodes = int(info.quiescence_nodes)
            self.last_engine_budget_ms = int(info.budget_ms)
            self.last_engine_pv_changed = bool(
                previous_pv and self.last_engine_pv and previous_pv[0] != self.last_engine_pv[0]
            )
            self.turn_started_ns = time.monotonic_ns()
            remaining = self.white_ms if color == chess.WHITE else self.black_ms
            if remaining <= 0:
                # A move completed after the clock expired is a time forfeit.
                # Do not push the late move or award increment: state() will
                # report the flag while the board remains at the pre-search
                # position, matching the referee's wall-clock semantics.
                return ""
            self._imported_pgn_game = None
            self.history.append((self.white_ms, self.black_ms))
            self._post_move_clock(color, committed_elapsed_ms + int(elapsed_ms))
            self.recorded_clocks.append((self.white_ms, self.black_ms))
            self.board.push(move)
            self.last_move = move
            return uci

    def undo(self, plies: int = 1) -> None:
        with self.lock:
            # Review navigation is handled entirely by review_state() and never
            # calls this method.  Undo is a live-game mutation, so invalidate
            # any analysis tied to the old main line before changing the board.
            self._cancel_analysis_locked()
            plies = max(1, min(8, int(plies)))
            preserve_pause = self.paused and self.manual_result is None
            self.manual_result = None
            self.manual_termination = None
            self.paused = preserve_pause
            if not self.board.move_stack:
                self.turn_started_ns = time.monotonic_ns()
                return
            self._imported_pgn_game = None
            for _ in range(min(plies, len(self.board.move_stack))):
                self.board.pop()
                if self.history:
                    self.white_ms, self.black_ms = self.history.pop()
                if self.recorded_clocks:
                    self.recorded_clocks.pop()
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


def _validate_workspace_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    """Validate chess-bearing backup metadata independently of the renderer."""

    def board_from_record(
        record: Any,
        label: str,
        *,
        default_chess960: bool = False,
    ) -> chess.Board:
        if not isinstance(record, dict) or not isinstance(record.get("fen"), str):
            raise ValueError(f"{label} is missing a FEN position.")
        chess960 = str(record.get("variant", "")).lower() == "chess960" or default_chess960
        try:
            board = _board_from_fen(str(record["fen"]), chess960=chess960)
        except ValueError as exc:
            raise ValueError(f"{label} contains an invalid FEN position.") from exc
        if not board.is_valid() and not chess960:
            # Older saved study snapshots did not carry an explicit variant.
            # A legal Chess960 FEN can therefore look invalid under standard
            # castling semantics; recover it without weakening position checks.
            try:
                chess960_board = _board_from_fen(str(record["fen"]), chess960=True)
            except ValueError:
                chess960_board = None
            if chess960_board is not None and chess960_board.is_valid():
                board = chess960_board
        if not board.is_valid():
            raise ValueError(f"{label} contains an invalid chess position.")
        return board

    def validate_acyclic(graph: dict[str, list[str]]) -> None:
        visiting: set[str] = set()
        complete: set[str] = set()

        def visit(node_id: str) -> None:
            if node_id in visiting:
                raise ValueError("Workspace study contains a cycle.")
            if node_id in complete:
                return
            visiting.add(node_id)
            for child_id in graph[node_id]:
                visit(child_id)
            visiting.remove(node_id)
            complete.add(node_id)

        for node_id in graph:
            visit(node_id)

    studies = metadata.get("studies", {})
    if studies is not None:
        if not isinstance(studies, dict) or len(studies) > 20:
            raise ValueError("Workspace studies are invalid or exceed the local limit.")
        for workspace in studies.values():
            if not isinstance(workspace, dict):
                raise ValueError("Workspace study must be an object.")
            nodes = workspace.get("nodes", {})
            edges = workspace.get("edges", {})
            root_id = workspace.get("root")
            if (
                not isinstance(nodes, dict)
                or len(nodes) > 500
                or not isinstance(edges, dict)
                or not isinstance(root_id, str)
                or root_id not in nodes
            ):
                raise ValueError("Workspace study graph is invalid or too large.")
            default_chess960 = str(workspace.get("variant", "")).lower() == "chess960"
            boards: dict[str, chess.Board] = {}
            for node_id, node in nodes.items():
                if (
                    not isinstance(node_id, str)
                    or not isinstance(node, dict)
                    or node.get("id") != node_id
                ):
                    raise ValueError("Workspace study node is invalid.")
                snapshot = node.get("snapshot")
                boards[node_id] = board_from_record(
                    snapshot,
                    "Workspace study node",
                    default_chess960=default_chess960,
                )
            expected_edges: set[str] = set()
            missing_edges: list[tuple[str, str]] = []
            graph: dict[str, list[str]] = {}
            for parent_id, node in nodes.items():
                children = node.get("children", [])
                if not isinstance(children, list) or len(children) > 500:
                    raise ValueError("Workspace study child list is invalid.")
                graph[parent_id] = []
                for child_id in children:
                    if not isinstance(child_id, str) or child_id not in boards:
                        raise ValueError("Workspace study references a missing child.")
                    graph[parent_id].append(child_id)
                    edge_key = f"{parent_id}>{child_id}"
                    expected_edges.add(edge_key)
                    edge = edges.get(edge_key)
                    if edge is None:
                        missing_edges.append((parent_id, child_id))
                        continue
                    if not isinstance(edge, dict) or not isinstance(edge.get("move_uci"), str):
                        raise ValueError("Workspace study edge is invalid.")
                    parent = boards[parent_id].copy(stack=False)
                    try:
                        move = parent.parse_uci(str(edge["move_uci"]))
                    except ValueError as exc:
                        raise ValueError("Workspace study edge move is invalid.") from exc
                    if move not in parent.legal_moves:
                        raise ValueError("Workspace study edge move is illegal.")
                    parent.push(move)
                    child = boards[child_id]
                    if (
                        parent.board_fen() != child.board_fen()
                        or parent.turn != child.turn
                        or parent.castling_rights != child.castling_rights
                        or (parent.ep_square if parent.has_legal_en_passant() else None)
                        != (child.ep_square if child.has_legal_en_passant() else None)
                    ):
                        raise ValueError("Workspace study edge does not reach its child position.")
            if any(not isinstance(key, str) or key not in expected_edges for key in edges):
                raise ValueError("Workspace study contains an orphan edge.")

            validate_acyclic(graph)
            for parent_id, child_id in missing_edges:
                parent = boards[parent_id].copy(stack=False)
                target = boards[child_id].fen().split()[:4]
                matching = []
                for move in list(parent.legal_moves):
                    parent.push(move)
                    if parent.fen().split()[:4] == target:
                        matching.append(move)
                    parent.pop()
                if len(matching) != 1:
                    raise ValueError("Cannot recover the move for a legacy study edge.")
                move = matching[0]
                edges[f"{parent_id}>{child_id}"] = {
                    "move_uci": parent.uci(move),
                    "move_san": parent.san(move),
                }
            workspace["edges"] = edges
            workspace.pop("needs_edge_migration", None)

    def validate_positions(key: str, limit: int, *, cards: bool = False) -> None:
        rows = metadata.get(key, [])
        if rows is None:
            return
        if not isinstance(rows, list) or len(rows) > limit:
            raise ValueError(f"Workspace {key} collection is invalid or too large.")
        candidates: list[Any] = []
        if cards:
            for lesson in rows:
                if not isinstance(lesson, dict) or not isinstance(lesson.get("cards", []), list):
                    raise ValueError("Workspace lesson is invalid.")
                if len(lesson.get("cards", [])) > 250:
                    raise ValueError("Workspace lesson contains too many cards.")
                candidates.extend(lesson.get("cards", []))
        else:
            candidates = rows
        for record in candidates:
            board = board_from_record(record, f"Workspace {key} item")
            best = record.get("best_uci") if isinstance(record, dict) else None
            if best is not None:
                try:
                    move = board.parse_uci(str(best))
                except ValueError as exc:
                    raise ValueError(f"Workspace {key} best move is invalid.") from exc
                if move not in board.legal_moves:
                    raise ValueError(f"Workspace {key} best move is illegal.")

    validate_positions("bookmarks", 100)
    validate_positions("trainer", 250)
    validate_positions("lessons", 100, cards=True)
    plugins = metadata.get("plugins", [])
    if not isinstance(plugins, list) or len(plugins) > 50:
        raise ValueError("Workspace plugins are invalid or exceed the local limit.")
    for raw_plugin in plugins:
        plugin = validate_manifest(raw_plugin)
        if plugin.kind == "training":
            for item in plugin.items:
                board = board_from_record(item, "Plugin training item")
                if not item.get("best_uci"):
                    raise ValueError("Plugin training item needs a legal best move.")
                try:
                    solution = board.parse_uci(str(item["best_uci"]))
                    if solution not in board.legal_moves:
                        raise ValueError("A null move is not a training solution.")
                except ValueError as exc:
                    raise ValueError("Plugin training best move is illegal.") from exc
        elif plugin.kind == "commands":
            allowed = {
                "open-analysis",
                "open-training",
                "start-engine",
                "start-repertoire-training",
                "export-report",
            }
            if any(item["action"] not in allowed for item in plugin.items):
                raise ValueError("Plugin command is unsupported.")
    current = metadata.get("current_game")
    if current is not None:
        if not isinstance(current, dict):
            raise ValueError("Backup live game must be an object.")
        GameSession().load_snapshot(current, reset_engine=False)
    return {"valid": True}


def _submit_job(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    workers = {
        "analyze-pgn": lambda: SESSION.analyze_pgn(
            str(payload.get("pgn", "")), int(payload.get("budget_ms", 120))
        ),
        "tournament": lambda: SESSION.uci_tournament(payload),
        "calibration": lambda: SESSION.uci_calibration(payload),
        "regression": lambda: SESSION.regression_engine(
            payload.get("baseline"), float(payload.get("clock_scale", 0.5))
        ),
        "selfplay": lambda: SESSION.selfplay_dataset(
            int(payload.get("games", 2)), int(payload.get("clock_ms", 4000))
        ),
        "tuner": lambda: SESSION.tune_parameters(payload.get("parameters")),
        "benchmark": lambda: SESSION.benchmark_engine(
            int(payload.get("clock_ms", 10000)), str(payload.get("compare_path", ""))
        ),
        "arena": lambda: SESSION.arena_compare(
            str(payload.get("opponent_path", "")),
            int(payload.get("games", 6)),
            int(payload.get("base_ms", 5000)),
            int(payload.get("increment_ms", 100)),
        ),
    }
    if kind == "reference-import":
        token = str(payload.get("token", ""))
        workspace_files.uploaded_file(token)

        def import_file() -> dict[str, Any]:
            try:
                with workspace_files.leased_file(token) as (path, name):
                    return import_reference_file(_library_database(), path, name)
            finally:
                # The server owns the import once the job starts. Browser-side
                # cleanup is only a fallback; release the transfer even if the
                # renderer disconnects while the import is running.
                with suppress(ValueError):
                    workspace_files.upload({"action": "cancel", "token": token})

        return JOBS.submit(kind, import_file)
    if kind not in workers:
        raise ValueError("Unknown background job kind.")
    return JOBS.submit(kind, workers[kind])


class Handler(SimpleHTTPRequestHandler):
    """Static assets plus a tiny JSON API."""

    server: ThreadingHTTPServer

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
        if self.path.startswith("/api/workspace-download?"):
            if isinstance(self, LanHandler):
                self.send_error(HTTPStatus.FORBIDDEN)
                return
            token = parse_qs(urlsplit(self.path).query).get("token", [""])[0]
            try:
                with workspace_files.leased_file(token) as (path, _):
                    self.send_response(HTTPStatus.OK)
                    self.send_header("Content-Type", "application/zip")
                    self.send_header(
                        "Content-Disposition",
                        'attachment; filename="FunChessEngine-workspace.fce.zip"',
                    )
                    self.send_header("Content-Length", str(path.stat().st_size))
                    self.end_headers()
                    with path.open("rb") as stream:
                        while chunk := stream.read(1024 * 1024):
                            self.wfile.write(chunk)
            except ValueError:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            finally:
                with suppress(ValueError):
                    workspace_files.upload({"action": "cancel", "token": token})
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
            if self.__class__.__name__ == "LanHandler" and self.path in {
                "/api/jobs",
                "/api/jobs/status",
                "/api/jobs/cancel",
                "/api/jobs/dismiss",
                "/api/workspace-data",
                "/api/library-upload",
                "/api/external-uci",
                "/api/tablebase",
                "/api/opening-book",
                "/api/dev-benchmark",
                "/api/dev-arena",
                "/api/dev-regression",
                "/api/dev-selfplay",
                "/api/dev-tuner",
                "/api/uci-tournament",
                "/api/uci-calibration",
                "/api/lan",
                "/api/library-workbench",
                "/api/library-db/status",
                "/api/library-db/import",
                "/api/library-db/search",
                "/api/library-db/game",
                "/api/library-db/explorer",
            }:
                raise ValueError("This host-local action is unavailable to LAN guests.")
            if self.path == "/api/library-upload":
                self._json(workspace_files.upload(payload))
                return
            elif self.path == "/api/workspace-data":
                action = payload.get("action", "backup")
                if action == "backup":
                    metadata = payload.get("metadata")
                    if not isinstance(metadata, dict):
                        raise ValueError("Backup metadata must be an object.")
                    _validate_workspace_metadata(metadata)
                    self._json(
                        workspace_files.create_bundle(
                            metadata, bool(payload.get("include_reference", True))
                        )
                    )
                elif action == "inspect":
                    self._json(workspace_files.inspect_bundle(str(payload.get("token", ""))))
                elif action == "validate-metadata":
                    metadata = payload.get("metadata")
                    if not isinstance(metadata, dict):
                        raise ValueError("Backup metadata must be an object.")
                    validated = _validate_workspace_metadata(metadata)
                    self._json({**validated, "studies": metadata.get("studies", {})})
                elif action == "restore":
                    if any(row["status"] == "running" for row in JOBS.list()):
                        raise ValueError(
                            "Finish or cancel background jobs before restoring databases."
                        )
                    token = str(payload.get("token", ""))
                    inspected = workspace_files.inspect_bundle(token)
                    _validate_workspace_metadata(inspected["metadata"])
                    current = inspected["metadata"].get("current_game")
                    with SESSION.lock:
                        if current is not None:
                            if not isinstance(current, dict):
                                raise ValueError("Backup live game must be an object.")
                            GameSession().load_snapshot(current, reset_engine=False)
                        result = workspace_files.restore_bundle(token)
                        if current is not None:
                            SESSION.load_snapshot({**current, "paused": True})
                            result["restored_state"] = SESSION.state()
                    self._json(result)
                else:
                    raise ValueError("Unknown workspace action.")
                return
            elif self.path == "/api/jobs":
                kind = str(payload.get("kind", ""))
                arguments = payload.get("payload", {})
                if not isinstance(arguments, dict):
                    raise ValueError("Job payload must be an object.")
                self._json(_submit_job(kind, arguments))
                return
            elif self.path == "/api/jobs/status":
                identifier = payload.get("id")
                self._json(JOBS.get(str(identifier)) if identifier else {"jobs": JOBS.list()})
                return
            elif self.path == "/api/jobs/cancel":
                self._json(JOBS.cancel(str(payload.get("id", ""))))
                return
            elif self.path == "/api/jobs/dismiss":
                self._json(JOBS.dismiss(str(payload.get("id", ""))))
                return
            elif self.path == "/api/move":
                SESSION.play_move(str(payload.get("move", "")))
            elif self.path == "/api/engine":
                budget = payload.get("budget_ms")
                SESSION.engine_move(int(budget) if budget is not None else None)
            elif self.path == "/api/engine-config":
                config = SESSION.configure_engine(
                    profile=(
                        str(payload["profile"]) if payload.get("profile") is not None else None
                    ),
                    skill=(int(payload["skill"]) if payload.get("skill") is not None else None),
                    move_time_cap_ms=(
                        int(payload["move_time_cap_ms"])
                        if payload.get("move_time_cap_ms") is not None
                        else None
                    ),
                )
                self._json(config)
                return
            elif self.path == "/api/reset":
                variant = str(payload.get("variant", "standard")).strip().lower()
                chess960 = variant == "chess960" or bool(payload.get("chess960", False))
                fen = str(payload.get("fen", chess.STARTING_FEN))
                chess960_pos = payload.get("chess960_pos")
                if chess960_pos is not None:
                    index = int(chess960_pos)
                    if index < 0 or index > 959:
                        raise ValueError("Chess960 position number must be between 0 and 959.")
                    fen = chess.Board.from_chess960_pos(index).fen()
                    chess960 = True
                SESSION.reset(
                    fen,
                    int(payload.get("clock_ms", DEFAULT_CLOCK_MS)),
                    int(payload.get("increment_ms", DEFAULT_INCREMENT_MS)),
                    chess960=chess960,
                    white_clock_ms=(
                        int(payload["white_clock_ms"])
                        if payload.get("white_clock_ms") is not None
                        else None
                    ),
                    black_clock_ms=(
                        int(payload["black_clock_ms"])
                        if payload.get("black_clock_ms") is not None
                        else None
                    ),
                    clock_mode=str(payload.get("clock_mode", "increment")),
                    delay_ms=int(payload.get("delay_ms", 0)),
                    time_stages=(
                        payload.get("time_stages")
                        if isinstance(payload.get("time_stages"), list)
                        else []
                    ),
                )
            elif self.path == "/api/load-game":
                SESSION.load_snapshot(payload)
            elif self.path == "/api/load-pgn":
                SESSION.load_pgn(str(payload.get("pgn", "")))
            elif self.path == "/api/parse-pgn-batch":
                games = SESSION.parse_pgn_batch(
                    str(payload.get("pgn", "")),
                    int(payload.get("max_games", 200)),
                )
                self._json({"games": games, "count": len(games)})
                return
            elif self.path == "/api/analyze-pgn":
                result = SESSION.analyze_pgn(
                    str(payload.get("pgn", "")),
                    int(payload.get("budget_ms", 100)),
                )
                self._json(result)
                return
            elif self.path == "/api/library-workbench":
                workbench = LibraryWorkbench(_library_database())
                action = payload.get("action", "search")
                if action == "search":
                    self._json(workbench.search(payload))
                elif action == "preview":
                    self._json(workbench.preview(int(payload.get("id", 0))))
                elif action == "organize":
                    self._json(workbench.organize(payload))
                elif action == "collections":
                    self._json(workbench.collections())
                elif action == "undo":
                    self._json(workbench.undo_organization(str(payload.get("id", ""))))
                elif action == "export":
                    self._json(workbench.export(payload.get("ids")))
                elif action == "headers":
                    self._json(workbench.edit_headers(payload))
                elif action == "views":
                    self._json(workbench.views(payload.get("view", {})))
                elif action == "report":
                    self._json(workbench.report(payload))
                elif action == "explorer":
                    self._json(workbench.explorer(payload))
                else:
                    raise ValueError("Unknown database workspace action.")
                return
            elif self.path == "/api/library-db/status":
                self._json(_library_database().stats())
                return
            elif self.path == "/api/library-db/import":
                self._json(
                    _library_database().import_pgn_text(
                        str(payload.get("pgn", "")),
                        source=str(payload.get("source", "reference")),
                        max_games=int(payload.get("max_games", 10_000)),
                    )
                )
                return
            elif self.path == "/api/library-db/search":
                filters = payload.get("filters", {})
                if not isinstance(filters, dict):
                    raise ValueError("Library filters must be a JSON object.")
                query = str(payload.get("query", "")).strip()
                parsed = parse_library_query(query) if query else {}
                merged = {**parsed, **filters}
                result = _library_database().search_games(
                    merged,
                    limit=int(payload.get("limit", 50)),
                    offset=int(payload.get("offset", 0)),
                )
                self._json({**result, "filters": merged})
                return
            elif self.path == "/api/library-db/game":
                game = _library_database().game(int(payload.get("id", 0)))
                if game is None:
                    raise ValueError("Indexed game was not found.")
                self._json({"game": game})
                return
            elif self.path == "/api/library-db/explorer":
                filters = payload.get("filters", {})
                if not isinstance(filters, dict):
                    raise ValueError("Explorer filters must be a JSON object.")
                self._json(
                    _library_database().opening_moves(
                        str(payload.get("fen", chess.STARTING_FEN)),
                        filters,
                        limit=int(payload.get("limit", 20)),
                    )
                )
                return
            elif self.path == "/api/opening-book":
                action = str(payload.get("action", "query")).strip().lower()
                book = _opening_book()
                profile = str(payload.get("profile", "default")).strip()[:48] or "default"
                if action == "stats":
                    result = book.stats(profile)
                elif action == "query":
                    result = {
                        "moves": book.moves(
                            str(payload.get("fen", chess.STARTING_FEN)),
                            depth_limit=(
                                int(payload["depth_limit"])
                                if payload.get("depth_limit") is not None
                                else None
                            ),
                            profile=profile,
                        )
                    }
                elif action == "add":
                    result = book.add_move(
                        str(payload.get("fen", chess.STARTING_FEN)),
                        str(payload.get("move", "")),
                        weight=int(payload.get("weight", 1)),
                        learn=int(payload.get("learn", 0)),
                        profile=profile,
                    )
                elif action == "remove":
                    result = {
                        "removed": book.remove_move(
                            str(payload.get("fen", chess.STARTING_FEN)),
                            str(payload.get("move", "")),
                            profile=profile,
                        )
                    }
                elif action == "learn":
                    result = {
                        "updated": book.learn_result(
                            str(payload.get("fen", chess.STARTING_FEN)),
                            str(payload.get("move", "")),
                            float(payload.get("score", 0.5)),
                            profile=profile,
                        )
                    }
                elif action == "import_polyglot":
                    positions = _library_database().distinct_fens(
                        int(payload.get("position_limit", 100_000))
                    )
                    result = book.import_polyglot_for_positions(
                        str(payload.get("path", "")),
                        positions,
                        profile=profile,
                    )
                else:
                    raise ValueError(
                        "Opening-book action must be stats, query, add, remove, learn, "
                        "or import_polyglot."
                    )
                self._json(result)
                return
            elif self.path == "/api/export-pgn":
                self._json({"pgn": SESSION.export_pgn()})
                return
            elif self.path == "/api/export-annotated-pgn":
                self._json(
                    {
                        "pgn": annotated_pgn(
                            SESSION.export_pgn(),
                            list(SESSION.analysis_results),
                        )
                    }
                )
                return
            elif self.path == "/api/export-html-report":
                games = payload.get("games", [])
                profile = payload.get("profile", {})
                if not isinstance(games, list) or not isinstance(profile, dict):
                    raise ValueError("Report data is invalid.")
                self._json(
                    {
                        "html": html_report(
                            str(payload.get("title", "FunChessEngine report")),
                            games,
                            profile,
                        )
                    }
                )
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
                self._json(
                    SESSION.position_from_fen(
                        str(payload.get("fen", chess.STARTING_FEN)),
                        chess960=payload.get("chess960"),
                    )
                )
                return
            elif self.path == "/api/variation-move":
                self._json(
                    SESSION.variation_move(
                        str(payload.get("fen", chess.STARTING_FEN)),
                        str(payload.get("move", "")),
                        chess960=payload.get("chess960"),
                    )
                )
                return
            elif self.path == "/api/eval-breakdown":
                self._json(
                    SESSION.evaluation_breakdown(str(payload.get("fen", chess.STARTING_FEN)))
                )
                return
            elif self.path == "/api/position-insights":
                self._json(SESSION.position_insights(str(payload.get("fen", chess.STARTING_FEN))))
                return
            elif self.path == "/api/tactical-motifs":
                self._json(
                    SESSION.tactical_motifs(
                        str(payload.get("fen", chess.STARTING_FEN)),
                        str(payload.get("move", "")),
                    )
                )
                return
            elif self.path == "/api/tablebase":
                self._json(
                    SESSION.tablebase_probe(
                        str(payload.get("fen", chess.STARTING_FEN)),
                        str(payload.get("path", "")),
                    )
                )
                return
            elif self.path == "/api/external-uci":
                self._json(
                    SESSION.compare_external_uci(
                        str(payload.get("executable", "")),
                        str(payload.get("fen", chess.STARTING_FEN)),
                        int(payload.get("budget_ms", 300)),
                        int(payload.get("lines", 3)),
                    )
                )
                return
            elif self.path == "/api/lan":
                if self.__class__.__name__ == "LanHandler":
                    raise ValueError("LAN hosting can only be controlled from the host computer.")
                self._json(_lan_control(str(payload.get("action", "status"))))
                return
            elif self.path == "/api/dev-benchmark":
                self._json(
                    SESSION.benchmark_engine(
                        int(payload.get("clock_ms", 10_000)),
                        str(payload.get("compare_path", "")),
                    )
                )
                return
            elif self.path == "/api/dev-regression":
                baseline = payload.get("baseline")
                if baseline is not None and not isinstance(baseline, list):
                    raise ValueError("Regression baseline must be a list of prior case results.")
                self._json(
                    SESSION.regression_engine(
                        baseline=baseline,
                        clock_scale=float(payload.get("clock_scale", 0.5)),
                    )
                )
                return
            elif self.path == "/api/dev-selfplay":
                self._json(
                    SESSION.selfplay_dataset(
                        int(payload.get("games", 2)),
                        int(payload.get("clock_ms", 4_000)),
                    )
                )
                return
            elif self.path == "/api/dev-tuner":
                raw_parameters = payload.get("parameters")
                if raw_parameters is not None and not isinstance(raw_parameters, list):
                    raise ValueError("Tuner parameters must be a list.")
                self._json(SESSION.tune_parameters([str(item) for item in raw_parameters or []]))
                return
            elif self.path == "/api/uci-tournament":
                self._json(SESSION.uci_tournament(payload))
                return
            elif self.path == "/api/uci-calibration":
                self._json(SESSION.uci_calibration(payload))
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
                SESSION.undo(int(payload.get("plies", 1)))
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
        except (
            TypeError,
            ValueError,
            RuntimeError,
            OSError,
            subprocess.TimeoutExpired,
            sqlite3.Error,
        ) as exc:
            self._json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)

    def _body(self) -> dict[str, Any]:
        size = int(self.headers.get("Content-Length", "0"))
        if size < 0:
            raise ValueError("Request body length is invalid.")
        if size > MAX_API_BODY_BYTES:
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


def _private_ip(value: str | None) -> bool:
    if not value:
        return False
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return value == "localhost"
    return address.is_private or address.is_loopback or address.is_link_local


class LanHandler(Handler):
    """Token-authenticated handler used only by the explicitly enabled LAN server."""

    def _lan_cookie_valid(self) -> bool:
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except KeyError:
            return False
        value = cookie.get("fce_lan")
        return bool(value and LAN_TOKEN and secrets.compare_digest(value.value, LAN_TOKEN))

    def _request_is_local(self) -> bool:
        if not _private_ip(self.client_address[0]):
            return False
        host_header = self.headers.get("Host", "")
        try:
            host = urlsplit(f"//{host_header}")
            if not _private_ip(host.hostname) or host.port != self.server.server_port:
                return False
        except ValueError:
            return False
        origin_header = self.headers.get("Origin")
        if origin_header:
            try:
                origin = urlsplit(origin_header)
                if (
                    origin.scheme != "http"
                    or not _private_ip(origin.hostname)
                    or origin.port != self.server.server_port
                ):
                    return False
            except ValueError:
                return False
        return self._lan_cookie_valid()

    def do_GET(self) -> None:
        parts = urlsplit(self.path)
        token = parse_qs(parts.query).get("token", [""])[0]
        if token and LAN_TOKEN and secrets.compare_digest(token, LAN_TOKEN):
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "/")
            self.send_header("Set-Cookie", f"fce_lan={LAN_TOKEN}; Path=/; SameSite=Strict")
            self.end_headers()
            return
        super().do_GET()


def _lan_host_ip() -> str:
    candidates: list[str] = []
    with suppress(OSError):
        candidates.extend(
            str(item[4][0])
            for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
            if item[4]
        )
    for candidate in candidates:
        if _private_ip(candidate) and not ipaddress.ip_address(candidate).is_loopback:
            return candidate
    return "127.0.0.1"


def _lan_status() -> dict[str, Any]:
    with LAN_LOCK:
        server = LAN_SERVER
        if server is None:
            return {"running": False}
        host = _lan_host_ip()
        return {
            "running": True,
            "host": host,
            "port": server.server_port,
            "url": f"http://{host}:{server.server_port}/?token={LAN_TOKEN}",
        }


def _start_lan_server() -> dict[str, Any]:
    global LAN_SERVER, LAN_THREAD, LAN_TOKEN
    with LAN_LOCK:
        if LAN_SERVER is not None:
            return _lan_status()
        token = secrets.token_urlsafe(18)
        port = 8766
        while True:
            try:
                server = ThreadingHTTPServer(("0.0.0.0", port), LanHandler)
                break
            except OSError as exc:
                if exc.errno != errno.EADDRINUSE or port >= 8786:
                    raise
                port += 1
        LAN_TOKEN = token
        LAN_SERVER = server
        LAN_THREAD = threading.Thread(target=server.serve_forever, daemon=True)
        LAN_THREAD.start()
        return _lan_status()


def _stop_lan_server() -> dict[str, Any]:
    global LAN_SERVER, LAN_THREAD, LAN_TOKEN
    with LAN_LOCK:
        server = LAN_SERVER
        thread = LAN_THREAD
        LAN_SERVER = None
        LAN_THREAD = None
        LAN_TOKEN = ""
    if server is not None:
        server.shutdown()
        server.server_close()
    if thread is not None:
        thread.join(timeout=2.0)
    return {"running": False}


def _lan_control(action: str) -> dict[str, Any]:
    normalized = action.strip().lower()
    if normalized == "start":
        return _start_lan_server()
    if normalized == "stop":
        return _stop_lan_server()
    if normalized == "status":
        return _lan_status()
    raise ValueError("LAN action must be start, stop, or status.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Launch the local FunChessEngine GUI.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-open", action="store_true", help="Do not open a browser tab.")
    parser.add_argument("--analysis-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--multipv-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--benchmark-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--arena-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--regression-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--selfplay-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--tuner-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--uci-tournament-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--uci-calibration-worker", action="store_true", help=argparse.SUPPRESS)
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

    for enabled, worker, label in (
        (arguments.regression_worker, _run_regression_worker, "Regression"),
        (arguments.selfplay_worker, _run_selfplay_worker, "Self-play"),
        (arguments.tuner_worker, _run_tuner_worker, "Tuner"),
        (arguments.uci_tournament_worker, _run_tournament_worker, "Tournament"),
        (arguments.uci_calibration_worker, _run_calibration_worker, "Calibration"),
    ):
        if not enabled:
            continue
        try:
            payload = json.load(sys.stdin)
            if not isinstance(payload, dict):
                raise ValueError(f"{label} worker input must be an object.")
            worker(payload)
        except Exception as exc:
            print(json.dumps({"error": str(exc)}), flush=True)
            raise SystemExit(1) from exc
        return

    JOBS.enable_history(default_data_dir() / "job-history")
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

    previous_handlers: dict[int, Any] = {}

    def stop_backend(_signum: int, _frame: Any) -> None:
        # Electron restarts the backend with SIGTERM on POSIX. Cancel job state
        # and kill every registered worker/UCI child before the host exits so
        # expensive engine processes cannot be orphaned.
        JOBS.cancel_all()
        terminate_active_processes()
        raise KeyboardInterrupt

    for signum in (signal.SIGINT, signal.SIGTERM):
        with suppress(ValueError):
            previous_handlers[signum] = signal.getsignal(signum)
            signal.signal(signum, stop_backend)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        JOBS.cancel_all()
        terminate_active_processes()
        for saved_signum, handler in previous_handlers.items():
            with suppress(ValueError):
                signal.signal(saved_signum, handler)
        _stop_lan_server()
        server.server_close()


if __name__ == "__main__":
    main()
