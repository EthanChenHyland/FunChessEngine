"""Deterministic tactical/endgame regression runner for engine development."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass

import chess

import agent


@dataclass(frozen=True)
class RegressionCase:
    name: str
    fen: str
    theme: str
    clock_ms: int = 2_000


CASES = (
    RegressionCase("mate-in-one", "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1", "mate"),
    RegressionCase("queen-capture", "4k3/8/8/3q4/3R4/8/8/4K3 w - - 0 1", "tactic"),
    RegressionCase("rook-endgame", "8/8/8/4k3/8/4K3/6P1/6R1 w - - 0 1", "endgame"),
    RegressionCase("promotion-race", "8/5k2/5P2/8/8/2K5/8/8 w - - 0 1", "endgame"),
)


def run_suite(clock_scale: float = 1.0) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for case in CASES:
        board = chess.Board(case.fen)
        clock = max(100, int(case.clock_ms * max(0.1, min(5.0, clock_scale))))
        agent.reset_game_state()
        move = agent.get_move(board.fen(), clock)
        legal = chess.Move.from_uci(move) in board.legal_moves
        info = agent.LAST_SEARCH_INFO
        rows.append(
            {
                **asdict(case),
                "move": move,
                "legal": legal,
                "depth": int(info.depth),
                "nodes": int(info.nodes),
                "elapsed_ms": int(info.elapsed_ms),
            }
        )
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clock-scale", type=float, default=1.0)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    rows = run_suite(args.clock_scale)
    if args.json:
        print(json.dumps(rows, indent=2))
        return
    for row in rows:
        print(
            f"{row['name']}: {row['move']} depth={row['depth']} "
            f"nodes={row['nodes']} elapsed={row['elapsed_ms']}ms"
        )


if __name__ == "__main__":
    main()

