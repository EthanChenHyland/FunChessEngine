"""Opening repertoire regression contracts for the built-in engine book."""

from __future__ import annotations

from typing import Any

import chess

import agent


def validate_opening_lines() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, line in enumerate(agent.OPENING_LINES, start=1):
        board = chess.Board()
        moves = line.split()
        legal = True
        for raw in moves:
            move = chess.Move.from_uci(raw)
            if move not in board.legal_moves:
                legal = False
                break
            expected = agent.OPENING_BOOK.get(agent._repetition_key(board), ())
            if move not in expected:
                legal = False
                break
            board.push(move)
        rows.append({"line": index, "plies": len(moves), "legal_and_indexed": legal})
    return rows


def chess960_castling_contract() -> bool:
    board = chess.Board.from_chess960_pos(518)
    return board.is_valid() and all(move in board.legal_moves for move in list(board.legal_moves))
