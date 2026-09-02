"""Classical chess engine for FunChessEngine.

The local runner imports this module once per game and calls ``get_move`` for every
position in which we are to move.  The engine deliberately uses only
``python-chess`` and the standard library so the engine source stays small,
auditable, and robust in the standalone runtime.

Strength comes from:

* a compact original position-based opening repertoire;
* iterative-deepening negamax with alpha-beta pruning;
* a persistent transposition table;
* a bounded evaluation cache for repeated transpositions;
* quiescence search to avoid stopping in the middle of exchanges;
* aspiration windows plus hash/capture/killer/history move ordering;
* bounded check extensions and conservative exchange-aware pruning;
* a tapered hand-written evaluation with piece-square, pawn, king-safety,
  mobility, bishop-pair and rook-file terms;
* clock-aware search that always keeps a completed iteration to return.

No third-party chess engine code or native binary is used or shipped.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass

import chess

INF = 1_000_000
MATE = 900_000
MAX_PLY = 128
ASPIRATION_WINDOW = 45
CHECK_EXTENSION_LIMIT = 1
EXCHANGE_PRUNE_MARGIN = 90

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

# Compact original opening repertoire.  The book is position based rather than
# history based, so transpositions reached by a different move order still
# work from the FEN supplied to get_move().  It deliberately covers only sound
# early development; search takes over once the position leaves these lines.
OPENING_LINES = (
    "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7",
    "e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 d2d3 f8c5 e1g1 d7d6",
    "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6",
    "e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g7g6 b1c3 f8g7",
    "e2e4 e7e6 d2d4 d7d5 b1c3 g8f6 e4e5 f6d7 f2f4 c7c5",
    "e2e4 c7c6 d2d4 d7d5 e4e5 c8f5 g1f3 e7e6 f1e2 c6c5",
    "e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4 g8f6 b1c3 f8b4",
    "e2e4 d7d6 d2d4 g8f6 b1c3 g7g6 f2f4 f8g7 g1f3 e8g8",
    "e2e4 d7d5 e4d5 d8d5 b1c3 d5d8 d2d4 g8f6 g1f3 c7c6",
    "e2e4 g8f6 e4e5 f6d5 d2d4 d7d6 g1f3 g7g6 c2c4 d5b6",
    "d2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7 e2e3 e8g8",
    "d2d4 d7d5 c2c4 d5c4 g1f3 g8f6 e2e3 e7e6 f1c4 c7c5",
    "d2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 d5c4 a2a4 c8f5",
    "d2d4 d7d5 g1f3 g8f6 c1f4 e7e6 e2e3 f8d6 f1d3 e8g8",
    "d2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 g1f3 e8g8",
    "d2d4 g8f6 c2c4 g7g6 b1c3 d7d5 c4d5 f6d5 e2e4 d5c3",
    "d2d4 g8f6 c2c4 e7e6 b1c3 f8b4 e2e3 e8g8 f1d3 d7d5",
    "d2d4 g8f6 c2c4 e7e6 g2g3 d7d5 f1g2 f8e7 g1f3 e8g8",
    "d2d4 f7f5 g2g3 g8f6 f1g2 g7g6 g1f3 f8g7 e1g1 e8g8",
    "c2c4 e7e5 b1c3 g8f6 g2g3 d7d5 c4d5 f6d5 f1g2 d5b6",
    "c2c4 c7c5 b1c3 b8c6 g2g3 g7g6 f1g2 f8g7 g1f3 g8f6",
    "g1f3 d7d5 g2g3 g8f6 f1g2 g7g6 e1g1 f8g7 d2d3 e8g8",
)


@dataclass(slots=True)
class TTEntry:
    depth: int
    score: int
    flag: int
    move: chess.Move | None


@dataclass(slots=True)
class SearchInfo:
    """Small local-search snapshot used only for local telemetry."""

    depth: int = 0
    score: int = 0
    nodes: int = 0
    elapsed_ms: int = 0
    aspiration_researches: int = 0
    tt_hits: int = 0
    beta_cutoffs: int = 0
    quiescence_nodes: int = 0
    budget_ms: int = 0
    pv: tuple[str, ...] = ()


class SearchTimeout(Exception):
    """Internal control flow used to abort an unfinished iteration."""


# State persists for the duration of one game.
TT: dict[object, TTEntry] = {}
EVAL_CACHE: dict[object, int] = {}
HISTORY: dict[tuple[bool, int, int], int] = {}
KILLERS: list[list[chess.Move | None]] = [[None, None] for _ in range(MAX_PLY)]
SEEN_POSITIONS: dict[object, int] = {}
OBSERVED_POSITIONS: deque[object] = deque()
LAST_OBSERVED_CHILD: object | None = None

DEADLINE_NS = 0
NODES = 0
QUIESCENCE_NODES = 0
TT_HITS = 0
BETA_CUTOFFS = 0
LAST_SEARCH_INFO = SearchInfo()


def _key(board: chess.Board) -> object:
    """Return a deterministic key including the fifty-move state."""

    # python-chess intentionally omits the halfmove clock from its position
    # transposition key.  Our terminal rules use that clock, so include it to
    # prevent a score cached at (say) halfmove 20 from being reused at 99.
    return board._transposition_key(), min(board.halfmove_clock, 100)


def _repetition_key(board: chess.Board) -> object:
    """Position identity used by the FIDE repetition rule.

    Unlike the search key this intentionally excludes the halfmove clock.
    python-chess's transposition key includes side to move, castling rights and
    the relevant en-passant state, which are the position details repetition
    needs.
    """

    return board._transposition_key()


def _build_opening_book() -> dict[object, tuple[chess.Move, ...]]:
    choices: dict[object, list[chess.Move]] = {}
    for line in OPENING_LINES:
        board = chess.Board()
        for raw in line.split():
            move = chess.Move.from_uci(raw)
            if move not in board.legal_moves:
                raise RuntimeError(f"invalid built-in opening move {raw} in {line}")
            key = _repetition_key(board)
            candidates = choices.setdefault(key, [])
            if move not in candidates:
                candidates.append(move)
            board.push(move)
    return {key: tuple(moves) for key, moves in choices.items()}


OPENING_BOOK = _build_opening_book()


def _opening_book_move(board: chess.Board, time_left_ms: int) -> chess.Move | None:
    choices = OPENING_BOOK.get(_repetition_key(board), ())
    legal = [move for move in choices if move in board.legal_moves]
    if not legal:
        return None
    # Keep the preferred line stable at ordinary clocks while letting different
    # time controls naturally exercise alternate sound choices at transpositions.
    index = (max(0, time_left_ms) // 10_000) % len(legal)
    return legal[index]


def reset_game_state() -> None:
    """Clear persistent search state (useful for local tools/new GUI games)."""

    global BETA_CUTOFFS, DEADLINE_NS, LAST_SEARCH_INFO, NODES, QUIESCENCE_NODES, TT_HITS
    global LAST_OBSERVED_CHILD
    LAST_OBSERVED_CHILD = None
    OBSERVED_POSITIONS.clear()
    TT.clear()
    EVAL_CACHE.clear()
    HISTORY.clear()
    SEEN_POSITIONS.clear()
    for killers in KILLERS:
        killers[0] = None
        killers[1] = None
    DEADLINE_NS = 0
    NODES = 0
    QUIESCENCE_NODES = 0
    TT_HITS = 0
    BETA_CUTOFFS = 0
    LAST_SEARCH_INFO = SearchInfo()


def _observe_position(key: object) -> None:
    # Only a bounded recent history is needed for repetition in a legal game.
    if len(OBSERVED_POSITIONS) >= 1024:
        old = OBSERVED_POSITIONS.popleft()
        count = SEEN_POSITIONS.get(old, 0) - 1
        if count > 0:
            SEEN_POSITIONS[old] = count
        else:
            SEEN_POSITIONS.pop(old, None)
    OBSERVED_POSITIONS.append(key)
    SEEN_POSITIONS[key] = SEEN_POSITIONS.get(key, 0) + 1


def set_game_history(board: chess.Board) -> None:
    """Seed known game history for tools that own a complete board, excluding the root."""
    global LAST_OBSERVED_CHILD
    SEEN_POSITIONS.clear()
    OBSERVED_POSITIONS.clear()
    LAST_OBSERVED_CHILD = None
    replay = board.root()
    for move in board.move_stack:
        _observe_position(_repetition_key(replay))
        replay.push(move)


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
    key = board._transposition_key()
    score = EVAL_CACHE.get(key)
    if score is None:
        score = _evaluate_white(board)
        EVAL_CACHE[key] = score
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


def _score_to_tt(score: int, ply: int) -> int:
    """Normalize mate scores so TT entries are independent of the current search ply."""

    if score >= MATE - MAX_PLY:
        return score + ply
    if score <= -MATE + MAX_PLY:
        return score - ply
    return score


def _score_from_tt(score: int, ply: int) -> int:
    """Restore a normalized TT mate score for the current search ply."""

    if score >= MATE - MAX_PLY:
        return score - ply
    if score <= -MATE + MAX_PLY:
        return score + ply
    return score


def _check_time() -> None:
    global NODES
    NODES += 1
    if NODES & 255 == 0 and time.monotonic_ns() >= DEADLINE_NS:
        raise SearchTimeout


def _captured_piece_type(board: chess.Board, move: chess.Move) -> int | None:
    victim = board.piece_type_at(move.to_square)
    if victim is None and board.is_en_passant(move):
        victim = chess.PAWN
    return victim


def _capture_score(board: chess.Board, move: chess.Move) -> int:
    victim = _captured_piece_type(board, move)
    attacker = board.piece_type_at(move.from_square) or chess.PAWN
    return 10_000 + MG_VALUE[victim or chess.PAWN] * 10 - MG_VALUE[attacker]


def _likely_losing_capture(board: chess.Board, move: chess.Move) -> bool:
    """Identify only obvious high-value-for-low-value defended captures.

    This is intentionally much simpler than a full static-exchange evaluator.
    It only rejects a capture when the attacker is substantially more valuable
    than the victim *and* the opponent has a legal immediate recapture.  Checks
    and promotions are never classified as losing here, preserving forcing
    tactical resources near the quiescence horizon.
    """

    if move.promotion is not None:
        return False
    victim = _captured_piece_type(board, move)
    attacker = board.piece_type_at(move.from_square)
    if victim is None or attacker is None:
        return False
    if MG_VALUE[attacker] <= MG_VALUE[victim] + EXCHANGE_PRUNE_MARGIN:
        return False

    board.push(move)
    try:
        if board.is_check():
            return False
        return any(
            reply.to_square == move.to_square and board.is_capture(reply)
            for reply in board.legal_moves
        )
    finally:
        board.pop()


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
    global BETA_CUTOFFS, QUIESCENCE_NODES

    _check_time()
    QUIESCENCE_NODES += 1
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
                BETA_CUTOFFS += 1
                return score
            if score > best:
                best = score
            if score > alpha:
                alpha = score
        return best

    stand_pat = evaluate(board)
    if stand_pat >= beta:
        BETA_CUTOFFS += 1
        return stand_pat
    if stand_pat > alpha:
        alpha = stand_pat

    for move in _ordered_moves(board, None, ply, captures_only=True):
        # Delta pruning: if even winning a modestly optimistic victim cannot
        # reach alpha, skip obviously hopeless captures (promotions are kept).
        if move.promotion is None:
            victim = _captured_piece_type(board, move)
            if victim is not None and stand_pat + MG_VALUE[victim] + 120 < alpha:
                continue
            if _likely_losing_capture(board, move):
                continue
        board.push(move)
        score = -quiescence(board, -beta, -alpha, ply + 1)
        board.pop()
        if score >= beta:
            BETA_CUTOFFS += 1
            return score
        if score > alpha:
            alpha = score
    return alpha


def negamax(
    board: chess.Board,
    depth: int,
    alpha: int,
    beta: int,
    ply: int,
    check_extensions: int = 0,
) -> int:
    global BETA_CUTOFFS, TT_HITS

    _check_time()
    terminal = _terminal_score(board, ply)
    if terminal is not None:
        return terminal
    # Spend at most one extra ply per branch when the side to move is in check.
    # Quiescence already searches evasions at depth zero; extending only positive
    # depth keeps the tree bounded while giving forcing checks a fuller reply.
    if board.is_check() and depth > 0 and check_extensions < CHECK_EXTENSION_LIMIT:
        depth += 1
        check_extensions += 1
    if depth <= 0:
        return quiescence(board, alpha, beta, ply)
    if ply >= MAX_PLY - 1:
        return evaluate(board)

    key = _key(board)
    entry = TT.get(key)
    tt_move = entry.move if entry is not None else None
    original_alpha = alpha
    if entry is not None and entry.depth >= depth:
        TT_HITS += 1
        entry_score = _score_from_tt(entry.score, ply)
        if entry.flag == EXACT:
            return entry_score
        if entry.flag == LOWER:
            alpha = max(alpha, entry_score)
        else:
            beta = min(beta, entry_score)
        if alpha >= beta:
            return entry_score

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
            score = -negamax(
                board, depth - 1, -beta, -alpha, ply + 1, check_extensions
            )
        else:
            reduced = depth >= 4 and index >= 4 and quiet and not board.is_check()
            probe_depth = depth - 2 if reduced else depth - 1
            score = -negamax(
                board, probe_depth, -alpha - 1, -alpha, ply + 1, check_extensions
            )
            if reduced and score > alpha:
                score = -negamax(
                    board, depth - 1, -alpha - 1, -alpha, ply + 1, check_extensions
                )
            if alpha < score < beta:
                score = -negamax(
                    board, depth - 1, -beta, -alpha, ply + 1, check_extensions
                )
        board.pop()

        if score > best_score:
            best_score = score
            best_move = move
        if score > alpha:
            alpha = score
        if alpha >= beta:
            BETA_CUTOFFS += 1
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
    TT[key] = TTEntry(depth, _score_to_tt(best_score, ply), flag, best_move)
    return best_score


def _search_root(
    board: chess.Board,
    depth: int,
    alpha: int,
    beta: int,
    preferred_move: chess.Move,
) -> tuple[int, chess.Move]:
    """Search one complete root pass within the supplied score window."""

    global BETA_CUTOFFS

    best_move = preferred_move
    best_score = -INF
    for move in _ordered_moves(board, preferred_move, 0):
        board.push(move)
        child_repetition_key = _repetition_key(board)
        score = -negamax(board, depth - 1, -beta, -alpha, 1)
        board.pop()

        # The referee automatically claims threefold. If this exact post-move
        # position has already occurred twice, the move is an immediate draw.
        if SEEN_POSITIONS.get(child_repetition_key, 0) >= 2:
            score = 0

        if score > best_score:
            best_score = score
            best_move = move
        if score > alpha:
            alpha = score
        if alpha >= beta:
            BETA_CUTOFFS += 1
            break
    return best_score, best_move


def _principal_variation(board: chess.Board, max_length: int = 16) -> tuple[str, ...]:
    """Follow legal TT moves to expose a compact principal variation locally."""

    pv: list[str] = []
    seen: set[object] = set()
    pushed = 0
    try:
        for _ in range(max_length):
            key = _key(board)
            if key in seen:
                break
            seen.add(key)
            entry = TT.get(key)
            if entry is None or entry.move is None or entry.move not in board.legal_moves:
                break
            pv.append(entry.move.uci())
            board.push(entry.move)
            pushed += 1
    finally:
        for _ in range(pushed):
            board.pop()
    return tuple(pv)


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
    if len(EVAL_CACHE) > 120_000:
        EVAL_CACHE.clear()
    if len(HISTORY) > 20_000:
        HISTORY.clear()


def _board_from_fen(fen: str) -> chess.Board:
    """Parse standard positions first, with a Chess960 fallback when needed.

    The competition/runtime protocol only provides a FEN string, so there is no
    separate variant flag to pass through.  python-chess marks Chess960-style
    castling rights as invalid on an ordinary Board; in that specific case we
    retry with ``chess960=True``.  Standard positions keep the existing board
    semantics and UCI castling representation unchanged.
    """

    board = chess.Board(fen)
    if board.is_valid():
        return board
    chess960_board = chess.Board(fen, chess960=True)
    if chess960_board.is_valid():
        return chess960_board
    return board


def get_move(fen: str, time_left_ms: int, *, move_budget_ms: int | None = None) -> str:
    """Return a legal UCI move before the game clock expires."""

    global BETA_CUTOFFS, DEADLINE_NS, LAST_SEARCH_INFO, NODES, QUIESCENCE_NODES, TT_HITS

    board = _board_from_fen(fen)
    legal = list(board.legal_moves)
    if not legal:
        # The referee never asks for a move after game over, but returning an
        # empty string is safer than throwing if a malformed test does.
        return ""
    repetition_key = _repetition_key(board)
    global LAST_OBSERVED_CHILD
    if repetition_key != LAST_OBSERVED_CHILD:
        _observe_position(repetition_key)
    if len(legal) == 1:
        forced = legal[0]
        board.push(forced)
        child_key = _repetition_key(board)
        board.pop()
        _observe_position(child_key)
        LAST_OBSERVED_CHILD = child_key
        LAST_SEARCH_INFO = SearchInfo(depth=0, score=0, nodes=0, elapsed_ms=0, pv=(forced.uci(),))
        return forced.uci()

    book_move = _opening_book_move(board, time_left_ms)
    if book_move is not None:
        board.push(book_move)
        played_key = _repetition_key(board)
        board.pop()
        _observe_position(played_key)
        LAST_OBSERVED_CHILD = played_key
        LAST_SEARCH_INFO = SearchInfo(
            depth=0,
            score=0,
            nodes=0,
            elapsed_ms=0,
            pv=(book_move.uci(),),
        )
        return book_move.uci()

    _trim_state()
    root_key = _key(board)

    budget_ms = (_time_budget_ms(board, max(1, time_left_ms)) if move_budget_ms is None
                 else max(1, min(2500, int(move_budget_ms), max(1, time_left_ms))))
    # Reserve a small fixed margin for Python unwinding + harness IPC.
    margin_ms = min(25, max(3, budget_ms // 12))
    DEADLINE_NS = time.monotonic_ns() + max(1, budget_ms - margin_ms) * 1_000_000
    NODES = 0
    QUIESCENCE_NODES = 0
    TT_HITS = 0
    BETA_CUTOFFS = 0
    started_ns = time.monotonic_ns()

    # Always have a legal fallback, preferably the previous hash move.
    root_entry = TT.get(root_key)
    best_move = root_entry.move if root_entry and root_entry.move in legal else legal[0]
    best_score = -INF

    # Seed ordering with a shallow static pass so depth one is tactically less
    # arbitrary even if the first timed iteration is interrupted.
    legal.sort(key=lambda move: _move_score(board, move, best_move, 0), reverse=True)
    best_move = legal[0]

    aspiration_researches = 0
    completed_depth = 0
    for depth in range(1, 64):
        if time.monotonic_ns() >= DEADLINE_NS:
            break
        try:
            if completed_depth == 0:
                alpha = -INF
                beta = INF
            else:
                alpha = best_score - ASPIRATION_WINDOW
                beta = best_score + ASPIRATION_WINDOW

            iteration_score, iteration_best = _search_root(
                board, depth, alpha, beta, best_move
            )

            # Aspiration windows improve pruning when the score is stable. If
            # the new iteration lands outside the narrow window, verify it once
            # with a full window rather than trusting a bound as the root score.
            if completed_depth > 0 and (
                iteration_score <= alpha or iteration_score >= beta
            ):
                aspiration_researches += 1
                iteration_score, iteration_best = _search_root(
                    board, depth, -INF, INF, iteration_best
                )
        except SearchTimeout:
            # If timeout happened while a move was pushed, negamax/quiescence
            # unwind through this frame only after their own pop sites.  Ensure
            # the root board itself is restored before returning.
            while board.move_stack:
                board.pop()
            break

        best_move = iteration_best
        best_score = iteration_score
        completed_depth = depth
        TT[root_key] = TTEntry(depth, best_score, EXACT, best_move)

        elapsed_ms = max(0, (time.monotonic_ns() - started_ns) // 1_000_000)
        LAST_SEARCH_INFO = SearchInfo(
            depth=completed_depth,
            score=best_score,
            nodes=NODES,
            elapsed_ms=int(elapsed_ms),
            aspiration_researches=aspiration_researches,
            tt_hits=TT_HITS,
            beta_cutoffs=BETA_CUTOFFS,
            quiescence_nodes=QUIESCENCE_NODES,
            budget_ms=budget_ms,
            pv=_principal_variation(board),
        )

        # A forced mate does not need another iteration.
        if best_score >= MATE - 256:
            break

    board.push(best_move)
    played_key = _repetition_key(board)
    board.pop()
    _observe_position(played_key)
    LAST_OBSERVED_CHILD = played_key
    if completed_depth == 0:
        elapsed_ms = max(0, (time.monotonic_ns() - started_ns) // 1_000_000)
        LAST_SEARCH_INFO = SearchInfo(
            depth=0,
            score=best_score,
            nodes=NODES,
            elapsed_ms=int(elapsed_ms),
            aspiration_researches=aspiration_researches,
            tt_hits=TT_HITS,
            beta_cutoffs=BETA_CUTOFFS,
            quiescence_nodes=QUIESCENCE_NODES,
            budget_ms=budget_ms,
            pv=(best_move.uci(),),
        )
    return best_move.uci()
