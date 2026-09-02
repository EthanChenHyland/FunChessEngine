from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import chess

from librarydb.store import LibraryDatabase, parse_library_query, structure_tags

SAMPLE_PGN = """[Event "Reference One"]
[Date "2024.01.01"]
[White "Alpha"]
[Black "Beta"]
[WhiteElo "2400"]
[BlackElo "2350"]
[Result "1-0"]
[ECO "B20"]
[Opening "Sicilian Defense"]

1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 1-0

[Event "Reference Two"]
[Date "2020.05.03"]
[White "Gamma"]
[Black "Delta"]
[WhiteElo "2100"]
[BlackElo "2150"]
[Result "1/2-1/2"]
[ECO "D30"]
[Opening "Queen's Gambit Declined"]

1. d4 d5 2. c4 e6 3. Nc3 Nf6 1/2-1/2
"""


class LibraryDatabaseTests(unittest.TestCase):
    def test_import_indexes_games_positions_and_deduplicates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = LibraryDatabase(Path(directory) / "library.sqlite3")
            first = database.import_pgn_text(SAMPLE_PGN)
            second = database.import_pgn_text(SAMPLE_PGN)
            self.assertEqual(first["imported"], 2)
            self.assertGreater(first["positions"], 2)
            self.assertEqual(second["imported"], 0)
            self.assertEqual(second["duplicates"], 2)
            self.assertEqual(database.stats()["games"], 2)

    def test_metadata_search_and_opening_explorer_are_indexed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = LibraryDatabase(Path(directory) / "library.sqlite3")
            database.import_pgn_text(SAMPLE_PGN)
            sicilian = database.search_games({"opening": "Sicilian", "min_elo": 2300})
            self.assertEqual(sicilian["total"], 1)
            self.assertEqual(sicilian["games"][0]["white"], "Alpha")
            explorer = database.opening_moves(chess.STARTING_FEN)
            self.assertEqual(explorer["moves"][0]["games"], 1)
            self.assertEqual(
                {row["move_uci"] for row in explorer["moves"]},
                {"e2e4", "d2d4"},
            )

    def test_structure_tags_and_natural_language_parser(self) -> None:
        board = chess.Board("4k3/p7/8/8/2P1P3/8/8/4K3 w - - 0 1")
        self.assertIn("Maroczy bind", structure_tags(board))
        parsed = parse_library_query("Sicilian games with an isolated queen pawn since 2020")
        self.assertEqual(parsed["opening"], "Sicilian")
        self.assertEqual(parsed["structure"], "IQP")
        self.assertEqual(parsed["year_from"], 2020)


if __name__ == "__main__":
    unittest.main()
