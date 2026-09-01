"""Repeatable local search benchmark over varied, legal chess positions."""

from __future__ import annotations

import argparse
import importlib.util
import json
import statistics
import sys
import time
from dataclasses import asdict, dataclass
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


@dataclass(frozen=True)
class BenchRow:
    index: int
    move: str
    depth: int
    nodes: int
    elapsed_ms: int
    nps: int


def benchmark(engine: ModuleType, clock_ms: int) -> list[BenchRow]:
    rows: list[BenchRow] = []
    for index, board in enumerate(positions(), start=1):
        reset = getattr(engine, "reset_game_state", None)
        if callable(reset):
            reset()
        started = time.monotonic_ns()
        uci = engine.get_move(board.fen(), clock_ms)
        elapsed = max(1, (time.monotonic_ns() - started) // 1_000_000)
        move = chess.Move.from_uci(uci)
        if move not in board.legal_moves:
            raise RuntimeError(f"position {index}: illegal engine move {uci}")
        nodes = int(getattr(engine, "NODES", 0))
        key_fn = getattr(engine, "_key", None)
        table = getattr(engine, "TT", {})
        entry = table.get(key_fn(board)) if callable(key_fn) else None
        depth = int(getattr(entry, "depth", 0)) if entry is not None else 0
        rows.append(
            BenchRow(
                index=index,
                move=uci,
                depth=depth,
                nodes=nodes,
                elapsed_ms=elapsed,
                nps=nodes * 1000 // elapsed,
            )
        )
    return rows


def summary(rows: list[BenchRow]) -> dict[str, float | int]:
    total_ms = sum(row.elapsed_ms for row in rows)
    total_nodes = sum(row.nodes for row in rows)
    total_depth = sum(row.depth for row in rows)
    count = max(1, len(rows))
    depths = [row.depth for row in rows]
    nps_values = [row.nps for row in rows]
    return {
        "positions": len(rows),
        "mean_depth": total_depth / count,
        "median_depth": float(statistics.median(depths)) if depths else 0.0,
        "min_depth": min(depths, default=0),
        "max_depth": max(depths, default=0),
        "nodes": total_nodes,
        "elapsed_ms": total_ms,
        "aggregate_nps": total_nodes * 1000 // max(1, total_ms),
        "median_nps": int(statistics.median(nps_values)) if nps_values else 0,
    }


def print_rows(rows: list[BenchRow]) -> None:
    print("#  move   depth      nodes       ms   nps")
    for row in rows:
        print(
            f"{row.index:2d} {row.move:6s} {row.depth:5d} {row.nodes:10,d} "
            f"{row.elapsed_ms:8,d} {row.nps:7,d}"
        )
    stats = summary(rows)
    print(
        f"\nmean depth {stats['mean_depth']:.2f} | "
        f"median {stats['median_depth']:.1f} | "
        f"{stats['nodes']:,} nodes | {stats['elapsed_ms']:,} ms | "
        f"{stats['aggregate_nps']:,} aggregate nps"
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
    parser.add_argument("--compare", type=Path)
    parser.add_argument("--clock-ms", type=int, default=10_000)
    parser.add_argument("--json", type=Path, dest="json_path")
    arguments = parser.parse_args()

    engine = load_agent(arguments.agent.resolve())
    rows = benchmark(engine, arguments.clock_ms)
    print_rows(rows)

    payload: dict[str, object] = {
        "agent": str(arguments.agent.resolve()),
        "clock_ms": arguments.clock_ms,
        "summary": summary(rows),
        "positions": [asdict(row) for row in rows],
    }

    if arguments.compare is not None:
        print(f"\ncomparison: {arguments.compare}")
        other_rows = benchmark(load_agent(arguments.compare.resolve()), arguments.clock_ms)
        print_rows(other_rows)
        left = summary(rows)
        right = summary(other_rows)
        depth_delta = float(left["mean_depth"]) - float(right["mean_depth"])
        nps_delta = int(left["aggregate_nps"]) - int(right["aggregate_nps"])
        baseline_nps = max(1, int(right["aggregate_nps"]))
        nps_percent = nps_delta * 100.0 / baseline_nps
        changed_moves = sum(a.move != b.move for a, b in zip(rows, other_rows, strict=True))
        print(
            f"\ndelta vs comparison: depth {depth_delta:+.2f}, "
            f"nps {nps_delta:+,} ({nps_percent:+.1f}%), "
            f"changed moves {changed_moves}/{len(rows)}"
        )
        payload["comparison"] = {
            "agent": str(arguments.compare.resolve()),
            "summary": right,
            "positions": [asdict(row) for row in other_rows],
            "depth_delta": depth_delta,
            "nps_delta": nps_delta,
            "nps_percent": nps_percent,
            "changed_moves": changed_moves,
        }

    if arguments.json_path is not None:
        arguments.json_path.write_text(json.dumps(payload, indent=2) + "\n")


if __name__ == "__main__":
    main()
