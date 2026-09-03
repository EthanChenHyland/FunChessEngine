"""Synthetic streaming-library benchmark; uses a temporary profile, never user data."""

from __future__ import annotations

import argparse
import json
import tempfile
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import chess

from gui.imports import import_reference_file
from librarydb.store import LibraryDatabase
from librarydb.workbench import LibraryWorkbench


def benchmark(games: int) -> dict[str, Any]:
    if not 1 <= games <= 100_000:
        raise ValueError("Use between 1 and 100,000 synthetic games.")
    with tempfile.TemporaryDirectory(prefix="funchess-library-benchmark-") as directory:
        root = Path(directory)
        source = root / "synthetic.pgn"
        with source.open("w", encoding="utf-8") as stream:
            for index in range(games):
                stream.write(
                    f'[Event "Synthetic {index}"]\n[White "Player {index % 100}"]\n'
                    '[Result "*"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 '
                    "4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 *\n\n"
                )
        database = LibraryDatabase(root / "library.sqlite3")
        started = time.perf_counter()
        result = import_reference_file(database, source, "synthetic benchmark")
        elapsed = time.perf_counter() - started
        queries = {}
        query_cases: tuple[tuple[str, Callable[[], object]], ...] = (
            ("player", lambda: database.search_games({"player": "Player 42"})),
            ("opening", lambda: database.opening_moves(chess.STARTING_FEN)),
            (
                "browser",
                lambda: LibraryWorkbench(database).search({"filters": {"player": "Player 42"}}),
            ),
            (
                "duplicates",
                lambda: LibraryWorkbench(database).search({"filters": {"duplicates": True}}),
            ),
            ("reports", lambda: LibraryWorkbench(database).report({"player": "Player 42"})),
            ("opening_tree", lambda: LibraryWorkbench(database).explorer({})),
        )
        for label, query in query_cases:
            query_started = time.perf_counter()
            query()
            queries[label] = round((time.perf_counter() - query_started) * 1000, 2)
        return {
            "games": games,
            "plies_per_game": 12,
            "import": result,
            "seconds": round(elapsed, 2),
            "pgn_bytes": source.stat().st_size,
            "database_bytes": sum(path.stat().st_size for path in root.glob("*.sqlite3*")),
            "query_ms": queries,
            "note": "Synthetic repeated openings with distinct headers; not a diverse corpus.",
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--games", type=int, default=10_000)
    arguments = parser.parse_args()
    print(json.dumps(benchmark(arguments.games), indent=2))


if __name__ == "__main__":
    main()
