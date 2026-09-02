"""Generate bounded local self-play records for offline engine experiments."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import chess
import chess.pgn

import agent

DEFAULT_OPENINGS = (
    chess.STARTING_FEN,
    "rnbqkbnr/pp2pppp/2pp4/8/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3",
    "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
)


def generate_game(
    fen: str = chess.STARTING_FEN,
    *,
    clock_ms: int = 4_000,
    max_plies: int = 160,
) -> dict[str, Any]:
    board = chess.Board(fen)
    if not board.is_valid():
        raise ValueError("Self-play starting FEN is invalid.")
    agent.reset_game_state()
    records: list[dict[str, Any]] = []
    for ply in range(max(1, min(300, int(max_plies)))):
        if board.is_game_over(claim_draw=True):
            break
        before = board.fen()
        agent.set_game_history(board)
        move_uci = agent.get_move(before, max(500, min(60_000, int(clock_ms))))
        move = chess.Move.from_uci(move_uci)
        if move not in board.legal_moves:
            raise RuntimeError(f"Self-play engine returned illegal move {move_uci}.")
        info = agent.LAST_SEARCH_INFO
        records.append(
            {
                "ply": ply + 1,
                "fen": before,
                "move": move_uci,
                "score": int(info.score),
                "depth": int(info.depth),
                "nodes": int(info.nodes),
                "elapsed_ms": int(info.elapsed_ms),
                "pv": list(info.pv),
            }
        )
        board.push(move)
    outcome = board.outcome(claim_draw=True)
    result = outcome.result() if outcome is not None else "1/2-1/2"
    game = chess.pgn.Game.from_board(board)
    game.headers["Event"] = "FunChessEngine Self Play"
    game.headers["Result"] = result
    return {
        "initial_fen": fen,
        "result": result,
        "termination": outcome.termination.name.lower() if outcome is not None else "max_plies",
        "positions": records,
        "pgn": str(game),
    }


def generate_dataset(games: int = 2, clock_ms: int = 4_000) -> list[dict[str, Any]]:
    count = max(1, min(20, int(games)))
    return [
        generate_game(DEFAULT_OPENINGS[index % len(DEFAULT_OPENINGS)], clock_ms=clock_ms)
        for index in range(count)
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--games", type=int, default=2)
    parser.add_argument("--clock-ms", type=int, default=4_000)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    rows = generate_dataset(args.games, args.clock_ms)
    text = "\n".join(json.dumps(row, separators=(",", ":")) for row in rows) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding="utf-8")
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
