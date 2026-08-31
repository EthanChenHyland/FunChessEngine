"""Classical chess engine for FunChessEngine.

The local runner imports this module once per game and calls ``get_move`` for every
position in which we are to move.  The engine deliberately uses only
``python-chess`` and the standard library so the engine source stays small,
auditable, and robust in the standalone runtime.

Strength comes from:

* iterative-deepening negamax with alpha-beta pruning;
* a persistent transposition table;
* quiescence search to avoid stopping in the middle of exchanges;
* hash/capture/killer/history move ordering;
* a tapered hand-written evaluation with piece-square, pawn, king-safety,
  mobility, bishop-pair and rook-file terms;
* clock-aware search that always keeps a completed iteration to return.

No third-party chess engine code or native binary is used or shipped.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import chess

INF = 1_000_000
MATE = 900_000
MAX_PLY = 128

# Bound flags for the transposition table.
EXACT = 0
LOWER = 1
UPPER = 2

# Middlegame/endgame material.  The king is intentionally zero here; its
# positional value is represented by the king tables below.
MG_VALUE = (0, 100, 320, 330, 500, 900, 0)
EG_VALUE = (0, 120, 310, 325, 510, 900, 0)

# Phase weights.  24 is a full-material middlegame; 0 is a bare-king ending.
PHASE_WEIGHT = (0, 0, 1, 1, 2, 4, 0)
MAX_PHASE = 24

# Piece-square tables are written from White's point of view (a1 .. h8).
# They are intentionally modest relative to material so search remains the
# dominant source of tactical strength.
PAWN_MG = (
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, -15, -15, 10, 10, 5,
    5, -5, -10, 0, 0, -10, -5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, 5, 10, 25, 25, 10, 5, 5,
    10, 10, 20, 30, 30, 20, 10, 10,
    50, 50, 50, 50, 50, 50, 50, 50,
    0, 0, 0, 0, 0, 0, 0, 0,
)
PAWN_EG = (
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 5, 5, 5, 5, 5, 5, 5,
    10, 10, 10, 15, 15, 10, 10, 10,
    20, 20, 20, 25, 25, 20, 20, 20,
    35, 35, 35, 40, 40, 35, 35, 35,
    55, 55, 55, 60, 60, 55, 55, 55,
    80, 80, 80, 80, 80, 80, 80, 80,
    0, 0, 0, 0, 0, 0, 0, 0,
)
KNIGHT = (
    -50, -35, -25, -25, -25, -25, -35, -50,
    -35, -15, 0, 5, 5, 0, -15, -35,
    -25, 5, 10, 15, 15, 10, 5, -25,
    -20, 5, 15, 20, 20, 15, 5, -20,
    -20, 5, 15, 20, 20, 15, 5, -20,
    -25, 0, 10, 15, 15, 10, 0, -25,
    -35, -15, 0, 0, 0, 0, -15, -35,
    -50, -35, -25, -25, -25, -25, -35, -50,
)
BISHOP = (
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 0, 10, 15, 15, 10, 0, -10,
    -10, 5, 5, 15, 15, 5, 5, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
)
ROOK = (
    0, 0, 5, 10, 10, 5, 0, 0,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    5, 10, 10, 10, 10, 10, 10, 5,
    0, 0, 5, 10, 10, 5, 0, 0,
)
QUEEN = (
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -10, 5, 5, 5, 5, 5, 0, -10,
    0, 0, 5, 5, 5, 5, 0, -5,
    -5, 0, 5, 5, 5, 5, 0, -5,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
)
KING_MG = (
    20, 30, 10, 0, 0, 10, 30, 20,
    20, 20, 0, 0, 0, 0, 20, 20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
)
KING_EG = (
    -50, -35, -25, -20, -20, -25, -35, -50,
    -30, -15, -5, 0, 0, -5, -15, -30,
    -20, -5, 10, 15, 15, 10, -5, -20,
    -15, 0, 15, 25, 25, 15, 0, -15,
    -15, 0, 15, 25, 25, 15, 0, -15,
    -20, -5, 10, 15, 15, 10, -5, -20,
    -30, -20, -10, -5, -5, -10, -20, -30,
    -50, -35, -25, -20, -20, -25, -35, -50,
)

MG_TABLE = ((), PAWN_MG, KNIGHT, BISHOP, ROOK, QUEEN, KING_MG)
EG_TABLE = ((), PAWN_EG, KNIGHT, BISHOP, ROOK, QUEEN, KING_EG)

PASSED_BONUS = (0, 5, 10, 20, 35, 60, 100, 0)


@dataclass(slots=True)
class TTEntry:
    depth: int
    score: int
    flag: int
    move: chess.Move | None


class SearchTimeout(Exception):
    """Internal control flow used to abort an unfinished iteration."""


# State persists for the duration of one game.
TT: dict[object, TTEntry] = {}
HISTORY: dict[tuple[bool, int, int], int] = {}
KILLERS: list[list[chess.Move | None]] = [[None, None] for _ in range(MAX_PLY)]
SEEN_ROOTS: dict[object, int] = {}

DEADLINE_NS = 0
NODES = 0


def _key(board: chess.Board) -> object:
    """Return a deterministic key including the fifty-move state."""

    # python-chess intentionally omits the halfmove clock from its position
    # transposition key.  Our terminal rules use that clock, so include it to
    # prevent a score cached at (say) halfmove 20 from being reused at 99.
    return board._transposition_key(), min(board.halfmove_clock, 100)


def _pst_square(square: int, color: chess.Color) -> int:
    return square if color == chess.WHITE else chess.square_mirror(square)


def _is_passed(board: chess.Board, square: int, color: chess.Color) -> bool:
    file_index = chess.square_file(square)
    rank_index = chess.square_rank(square)
    enemy_pawns = board.pieces(chess.PAWN, not color)
    for enemy_square in enemy_pawns:
        enemy_file = chess.square_file(enemy_square)
        if abs(enemy_file - file_index) > 1:
            continue
        enemy_rank = chess.square_rank(enemy_square)
        if color == chess.WHITE and enemy_rank > rank_index:
            return False
        if color == chess.BLACK and enemy_rank < rank_index:
            return False
    return True


def _mobility(board: chess.Board, color: chess.Color) -> int:
    """Cheap pseudo-mobility that avoids generating a second legal move list."""

    own = board.occupied_co[color]
    score = 0
    for square in board.pieces(chess.KNIGHT, color):
        score += chess.popcount(chess.BB_KNIGHT_ATTACKS[square] & ~own)
    for square in board.pieces(chess.BISHOP, color):
        score += chess.popcount(board.attacks_mask(square) & ~own)
    for square in board.pieces(chess.ROOK, color):
        score += chess.popcount(board.attacks_mask(square) & ~own)
    for square in board.pieces(chess.QUEEN, color):
        score += chess.popcount(board.attacks_mask(square) & ~own)
    return score


def _king_safety(board: chess.Board, color: chess.Color) -> int:
    king = board.king(color)
    if king is None:
        return 0
    king_file = chess.square_file(king)
    king_rank = chess.square_rank(king)
    direction = 1 if color == chess.WHITE else -1
    shield_rank = king_rank + direction
    shield = 0
    if 0 <= shield_rank <= 7:
        pawns = board.pieces(chess.PAWN, color)
        for file_index in range(max(0, king_file - 1), min(7, king_file + 1) + 1):
            if chess.square(file_index, shield_rank) in pawns:
                shield += 7

    # Direct enemy pressure around the king matters more than perfect pawn shape.
    ring = chess.BB_KING_ATTACKS[king]
    pressure = 0
    for target in chess.scan_forward(ring):
        pressure += min(2, len(board.attackers(not color, target)))
    return shield - pressure * 4


def _evaluate_white(board: chess.Board) -> int:
    mg = 0
    eg = 0
    phase = 0

    for color in (chess.WHITE, chess.BLACK):
        sign = 1 if color == chess.WHITE else -1
        for piece_type in range(chess.PAWN, chess.KING + 1):
            squares = board.pieces(piece_type, color)
            phase += PHASE_WEIGHT[piece_type] * len(squares)
            for square in squares:
                psq = _pst_square(square, color)
                mg += sign * (MG_VALUE[piece_type] + MG_TABLE[piece_type][psq])
                eg += sign * (EG_VALUE[piece_type] + EG_TABLE[piece_type][psq])

        pawns = board.pieces(chess.PAWN, color)
        file_counts = [0] * 8
        for square in pawns:
            file_counts[chess.square_file(square)] += 1
        for count in file_counts:
            if count > 1:
                mg -= sign * 12 * (count - 1)
                eg -= sign * 8 * (count - 1)
        for square in pawns:
            file_index = chess.square_file(square)
            neighbors = 0
            if file_index > 0:
                neighbors += file_counts[file_index - 1]
            if file_index < 7:
                neighbors += file_counts[file_index + 1]
            if neighbors == 0:
                mg -= sign * 10
                eg -= sign * 6
            if _is_passed(board, square, color):
                rank = chess.square_rank(square)
                relative_rank = rank if color == chess.WHITE else 7 - rank
                eg += sign * PASSED_BONUS[relative_rank]

        if len(board.pieces(chess.BISHOP, color)) >= 2:
            mg += sign * 28
            eg += sign * 35

        # Rooks like open and semi-open files.
        enemy_pawns = board.pieces(chess.PAWN, not color)
        for rook in board.pieces(chess.ROOK, color):
            file_mask = chess.BB_FILES[chess.square_file(rook)]
            if not (pawns & file_mask):
                mg += sign * (16 if not (enemy_pawns & file_mask) else 9)

        mg += sign * 3 * _mobility(board, color)
        mg += sign * _king_safety(board, color)

    phase = min(MAX_PHASE, phase)
    return (mg * phase + eg * (MAX_PHASE - phase)) // MAX_PHASE


def evaluate(board: chess.Board) -> int:
    score = _evaluate_white(board)
    return score if board.turn == chess.WHITE else -score


def _terminal_score(board: chess.Board, ply: int) -> int | None:
    if board.is_checkmate():
        return -MATE + ply
    if board.is_stalemate() or board.is_insufficient_material():
        return 0
    # Search positions built from FEN do not contain the actual game history, so
    # repetition is handled at the root from positions the process has observed.
    if board.halfmove_clock >= 100:
        return 0
    return None


def _check_time() -> None:
    global NODES
    NODES += 1
    if NODES & 255 == 0 and time.monotonic_ns() >= DEADLINE_NS:
        raise SearchTimeout


def _capture_score(board: chess.Board, move: chess.Move) -> int:
    victim = board.piece_type_at(move.to_square)
    if victim is None and board.is_en_passant(move):
        victim = chess.PAWN
    attacker = board.piece_type_at(move.from_square) or chess.PAWN
    return 10_000 + MG_VALUE[victim or chess.PAWN] * 10 - MG_VALUE[attacker]


def _move_score(
    board: chess.Board, move: chess.Move, tt_move: chess.Move | None, ply: int
) -> int:
    if move == tt_move:
        return 1_000_000
    if move.promotion:
        return 30_000 + MG_VALUE[move.promotion]
    if board.is_capture(move):
        return _capture_score(board, move)
    if ply < MAX_PLY:
        first, second = KILLERS[ply]
        if move == first:
            return 9_000
        if move == second:
            return 8_000
    return HISTORY.get((board.turn, move.from_square, move.to_square), 0)


def _ordered_moves(
    board: chess.Board, tt_move: chess.Move | None, ply: int, captures_only: bool = False
) -> list[chess.Move]:
    if captures_only:
        moves = [
            move
            for move in board.legal_moves
            if board.is_capture(move) or move.promotion is not None
        ]
    else:
        moves = list(board.legal_moves)
    moves.sort(key=lambda move: _move_score(board, move, tt_move, ply), reverse=True)
    return moves


def quiescence(board: chess.Board, alpha: int, beta: int, ply: int) -> int:
    _check_time()
    terminal = _terminal_score(board, ply)
    if terminal is not None:
        return terminal
    if ply >= MAX_PLY - 1:
        return evaluate(board)

    if board.is_check():
        best = -INF
        moves = _ordered_moves(board, None, ply)
        for move in moves:
            board.push(move)
            score = -quiescence(board, -beta, -alpha, ply + 1)
            board.pop()
            if score >= beta:
                return score
            if score > best:
                best = score
            if score > alpha:
                alpha = score
        return best

    stand_pat = evaluate(board)
    if stand_pat >= beta:
        return stand_pat
    if stand_pat > alpha:
        alpha = stand_pat

    for move in _ordered_moves(board, None, ply, captures_only=True):
        # Delta pruning: if even winning a modestly optimistic victim cannot
        # reach alpha, skip obviously hopeless captures (promotions are kept).
        if move.promotion is None:
            victim = board.piece_type_at(move.to_square)
            if victim is None and board.is_en_passant(move):
                victim = chess.PAWN
            if victim is not None and stand_pat + MG_VALUE[victim] + 120 < alpha:
                continue
        board.push(move)
        score = -quiescence(board, -beta, -alpha, ply + 1)
        board.pop()
        if score >= beta:
            return score
        if score > alpha:
            alpha = score
    return alpha


def negamax(board: chess.Board, depth: int, alpha: int, beta: int, ply: int) -> int:
    _check_time()
    terminal = _terminal_score(board, ply)
    if terminal is not None:
        return terminal
    if depth <= 0:
        return quiescence(board, alpha, beta, ply)
    if ply >= MAX_PLY - 1:
        return evaluate(board)

    key = _key(board)
    entry = TT.get(key)
    tt_move = entry.move if entry is not None else None
    original_alpha = alpha
    if entry is not None and entry.depth >= depth:
        if entry.flag == EXACT:
            return entry.score
        if entry.flag == LOWER:
            alpha = max(alpha, entry.score)
        else:
            beta = min(beta, entry.score)
        if alpha >= beta:
            return entry.score

    best_score = -INF
    best_move: chess.Move | None = None
    moves = _ordered_moves(board, tt_move, ply)
    if not moves:
        return _terminal_score(board, ply) or 0

    for index, move in enumerate(moves):
        quiet = not board.is_capture(move) and move.promotion is None
        board.push(move)

        # Principal variation search: after the first well-ordered move, first
        # prove later moves cannot beat alpha with a zero-width window.  Late
        # quiet moves get a conservative one-ply reduction; if the reduced
        # search says they may improve alpha, immediately verify at full depth.
        if index == 0:
            score = -negamax(board, depth - 1, -beta, -alpha, ply + 1)
        else:
            reduced = depth >= 4 and index >= 4 and quiet and not board.is_check()
            probe_depth = depth - 2 if reduced else depth - 1
            score = -negamax(board, probe_depth, -alpha - 1, -alpha, ply + 1)
            if reduced and score > alpha:
                score = -negamax(board, depth - 1, -alpha - 1, -alpha, ply + 1)
            if alpha < score < beta:
                score = -negamax(board, depth - 1, -beta, -alpha, ply + 1)
        board.pop()

        if score > best_score:
            best_score = score
            best_move = move
        if score > alpha:
            alpha = score
        if alpha >= beta:
            if quiet and ply < MAX_PLY:
                first = KILLERS[ply][0]
                if move != first:
                    KILLERS[ply][1] = first
                    KILLERS[ply][0] = move
                hkey = (board.turn, move.from_square, move.to_square)
                HISTORY[hkey] = min(100_000, HISTORY.get(hkey, 0) + depth * depth)
            break

    flag = EXACT
    if best_score <= original_alpha:
        flag = UPPER
    elif best_score >= beta:
        flag = LOWER
    TT[key] = TTEntry(depth, best_score, flag, best_move)
    return best_score


def _time_budget_ms(board: chess.Board, time_left_ms: int) -> int:
    """Conservative per-move budget for the fixed 120s + 0.5s game clock."""

    if time_left_ms <= 1_000:
        return max(8, time_left_ms // 12)
    if time_left_ms <= 5_000:
        return max(20, min(180, time_left_ms // 18))

    # Spend a slightly larger fraction in low-material positions, where the
    # remaining game is usually shorter and deeper calculation is valuable.
    non_pawn_material = sum(
        len(board.pieces(piece, color)) * MG_VALUE[piece]
        for color in (chess.WHITE, chess.BLACK)
        for piece in (chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN)
    )
    fraction = 0.018 if non_pawn_material < 2_000 else 0.014
    budget = int(time_left_ms * fraction + 180)
    return max(60, min(2_500, budget, time_left_ms // 6))


def _trim_state() -> None:
    # A Python dict entry is much larger than its payload.  Keep memory bounded
    # comfortably below the 2 GB container limit and avoid unbounded game-long
    # growth.  Clearing occasionally is cheap and deterministic.
    if len(TT) > 180_000:
        TT.clear()
    if len(HISTORY) > 20_000:
        HISTORY.clear()


def get_move(fen: str, time_left_ms: int) -> str:
    """Return a legal UCI move before the game clock expires."""

    global DEADLINE_NS, NODES

    board = chess.Board(fen)
    legal = list(board.legal_moves)
    if not legal:
        # The referee never asks for a move after game over, but returning an
        # empty string is safer than throwing if a malformed test does.
        return ""
    if len(legal) == 1:
        return legal[0].uci()

    _trim_state()
    root_key = _key(board)
    SEEN_ROOTS[root_key] = SEEN_ROOTS.get(root_key, 0) + 1

    budget_ms = _time_budget_ms(board, max(1, time_left_ms))
    # Reserve a small fixed margin for Python unwinding + harness IPC.
    margin_ms = min(25, max(3, budget_ms // 12))
    DEADLINE_NS = time.monotonic_ns() + max(1, budget_ms - margin_ms) * 1_000_000
    NODES = 0

    # Always have a legal fallback, preferably the previous hash move.
    root_entry = TT.get(root_key)
    best_move = root_entry.move if root_entry and root_entry.move in legal else legal[0]
    best_score = -INF

    # Seed ordering with a shallow static pass so depth one is tactically less
    # arbitrary even if the first timed iteration is interrupted.
    legal.sort(key=lambda move: _move_score(board, move, best_move, 0), reverse=True)
    best_move = legal[0]

    for depth in range(1, 64):
        if time.monotonic_ns() >= DEADLINE_NS:
            break
        alpha = -INF
        beta = INF
        iteration_best = best_move
        iteration_score = -INF
        try:
            moves = _ordered_moves(board, best_move, 0)
            for move in moves:
                board.push(move)
                score = -negamax(board, depth - 1, -beta, -alpha, 1)
                board.pop()

                if score > iteration_score:
                    iteration_score = score
                    iteration_best = move
                if score > alpha:
                    alpha = score
        except SearchTimeout:
            # If timeout happened while a move was pushed, negamax/quiescence
            # unwind through this frame only after their own pop sites.  Ensure
            # the root board itself is restored before returning.
            while board.move_stack:
                board.pop()
            break

        best_move = iteration_best
        best_score = iteration_score
        TT[root_key] = TTEntry(depth, best_score, EXACT, best_move)

        # A forced mate does not need another iteration.
        if best_score >= MATE - 256:
            break

    return best_move.uci()
