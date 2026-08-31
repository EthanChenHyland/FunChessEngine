"""Repeatable local search benchmark over varied, legal chess positions."""

from __future__ import annotations

import argparse
import importlib.util
import sys
import time
from pathlib import Path
from types import ModuleType

import chess

# Short opening traces produce stable, non-book-only positions while keeping the
# suite auditable. Every trace is replayed and validated by python-chess.
LINES = (
    "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7",
    "d2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7 e2e3 e8g8",
    "c2c4 e7e5 b1c3 g8f6 g2g3 d7d5 c4d5 f6d5 f1g2 d5b6",
    "g1f3 d7d5 g2g3 c7c5 f1g2 b8c6 e1g1 e7e5 d2d3 g8f6",
    "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6",
    "e2e4 e7e6 d2d4 d7d5 b1c3 g8f6 e4e5 f6d7 f2f4 c7c5",
    "d2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 g1f3 e8g8",
    "d2d4 g8f6 c2c4 e7e6 b1c3 f8b4 e2e3 e8g8 f1d3 d7d5",
    "e2e4 c7c6 d2d4 d7d5 e4e5 c8f5 g1f3 e7e6 f1e2 c6c5",
    "c2c4 g8f6 b1c3 e7e5 g1f3 b8c6 g2g3 f8b4 f1g2 e8g8",
    "d2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 d5c4 a2a4 c8f5",
    "e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g7g6 c2c4 f8g7",
)


def positions() -> list[chess.Board]:
    result: list[chess.Board] = []
    for line in LINES:
        board = chess.Board()
        for uci in line.split():
            move = chess.Move.from_uci(uci)
            if move not in board.legal_moves:
                raise RuntimeError(f"benchmark trace contains illegal move {uci}: {line}")
            board.push(move)
        result.append(board)
    return result


def load_agent(path: Path) -> ModuleType:
    source = path / "agent.py"
    spec = importlib.util.spec_from_file_location("bench_agent", source)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {source}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark search speed on varied positions.")
    parser.add_argument("--agent", type=Path, default=Path("."))
    parser.add_argument("--clock-ms", type=int, default=10_000)
    arguments = parser.parse_args()

    engine = load_agent(arguments.agent.resolve())
    boards = positions()
    total_ms = total_nodes = total_depth = 0
    print("#  move   depth      nodes       ms   nps")
    for index, board in enumerate(boards, start=1):
        reset = getattr(engine, "reset_game_state", None)
        if callable(reset):
            reset()
        started = time.monotonic_ns()
        uci = engine.get_move(board.fen(), arguments.clock_ms)
        elapsed = max(1, (time.monotonic_ns() - started) // 1_000_000)
        move = chess.Move.from_uci(uci)
        if move not in board.legal_moves:
            raise RuntimeError(f"position {index}: illegal engine move {uci}")
        nodes = int(getattr(engine, "NODES", 0))
        key_fn = getattr(engine, "_key", None)
        table = getattr(engine, "TT", {})
        entry = table.get(key_fn(board)) if callable(key_fn) else None
        depth = int(getattr(entry, "depth", 0)) if entry is not None else 0
        nps = nodes * 1000 // elapsed
        total_ms += elapsed
        total_nodes += nodes
        total_depth += depth
        print(f"{index:2d} {uci:6s} {depth:5d} {nodes:10,d} {elapsed:8,d} {nps:7,d}")

    count = len(boards)
    print(
        f"\nmean depth {total_depth / count:.2f} | "
        f"{total_nodes:,} nodes | {total_ms:,} ms | "
        f"{total_nodes * 1000 // max(1, total_ms):,} aggregate nps"
    )


if __name__ == "__main__":
    main()
