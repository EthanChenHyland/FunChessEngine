"""Generate development-only value/policy labels with an external UCI engine.

The teacher engine is never copied into FunChessEngine or engine-package.zip.  This
tool is for offline training data generation only: sample positions from PGNs,
ask a UCI engine for an evaluation/best move, and save compact JSONL records.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path
from typing import TextIO

import chess
import chess.engine
import chess.pgn


def iter_positions(
    stream: TextIO,
    *,
    min_ply: int,
    max_ply: int,
    sample_rate: float,
    rng: random.Random,
):
    while game := chess.pgn.read_game(stream):
        board = game.board()
        for ply, move in enumerate(game.mainline_moves(), start=1):
            board.push(move)
            if ply < min_ply or ply > max_ply or board.is_game_over(claim_draw=True):
                continue
            if rng.random() <= sample_rate:
                yield board.copy(stack=False), game.headers.get("Result", "*")


def normalized_score(info: dict[str, object], turn: chess.Color) -> tuple[int | None, int | None]:
    score = info.get("score")
    if not isinstance(score, chess.engine.PovScore):
        return None, None
    relative = score.pov(turn)
    mate = relative.mate()
    cp = relative.score(mate_score=100_000)
    return cp, mate


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Label PGN positions with an external UCI teacher."
    )
    parser.add_argument(
        "--engine", type=Path, required=True, help="Path to Stockfish/other UCI engine."
    )
    parser.add_argument("--pgn", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--depth", type=int, default=14)
    parser.add_argument("--min-ply", type=int, default=10)
    parser.add_argument("--max-ply", type=int, default=140)
    parser.add_argument("--sample-rate", type=float, default=0.12)
    parser.add_argument("--limit", type=int, default=100_000)
    parser.add_argument("--seed", type=int, default=20260831)
    arguments = parser.parse_args()

    if not 0 < arguments.sample_rate <= 1:
        raise SystemExit("--sample-rate must be in (0, 1]")
    if not arguments.engine.is_file():
        raise SystemExit(f"teacher engine not found: {arguments.engine}")
    if not arguments.pgn.is_file():
        raise SystemExit(f"PGN not found: {arguments.pgn}")

    rng = random.Random(arguments.seed)
    arguments.out.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with (
        arguments.pgn.open(encoding="utf-8", errors="replace") as pgn,
        arguments.out.open("w", encoding="utf-8") as output,
        chess.engine.SimpleEngine.popen_uci(str(arguments.engine)) as teacher,
    ):
        for board, result in iter_positions(
            pgn,
            min_ply=arguments.min_ply,
            max_ply=arguments.max_ply,
            sample_rate=arguments.sample_rate,
            rng=rng,
        ):
            info = teacher.analyse(board, chess.engine.Limit(depth=max(1, arguments.depth)))
            cp, mate = normalized_score(info, board.turn)
            pv = info.get("pv")
            best_move = pv[0].uci() if isinstance(pv, list) and pv else None
            record = {
                "fen": board.fen(),
                "turn": "white" if board.turn == chess.WHITE else "black",
                "teacher_cp": cp,
                "teacher_mate": mate,
                "best_move": best_move,
                "game_result": result,
                "teacher_depth": info.get("depth"),
            }
            output.write(json.dumps(record, separators=(",", ":")) + "\n")
            count += 1
            if count % 1000 == 0:
                print(f"labeled {count:,} positions")
            if count >= arguments.limit:
                break

    print(f"wrote {count:,} labels to {arguments.out}")


if __name__ == "__main__":
    main()
