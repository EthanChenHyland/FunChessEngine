from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import chess

from gui.server import OPENING_PREFIXES, _load_opening_prefixes, _opening_from_moves


class OpeningRecognitionTests(unittest.TestCase):
    def test_bundled_dataset_is_expanded(self) -> None:
        self.assertGreaterEqual(len(OPENING_PREFIXES), 80)

    def test_longest_prefix_selects_specific_variation(self) -> None:
        moves = [
            "e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4",
            "f3d4", "g8f6", "b1c3", "a7a6", "f1e2",
        ]
        opening = _opening_from_moves(chess.STARTING_FEN, moves)
        self.assertEqual(
            opening,
            {
                "eco": "B90",
                "name": "Sicilian Defense · Najdorf Variation",
                "book_plies": 10,
            },
        )

    def test_custom_start_position_is_not_labeled(self) -> None:
        custom = "8/8/8/8/8/4k3/8/4K2R w K - 0 1"
        self.assertIsNone(_opening_from_moves(custom, ["h1h3"]))

    def test_loader_rejects_duplicate_or_illegal_prefixes(self) -> None:
        fixtures = [
            {
                "schema_version": 1,
                "entries": [
                    {"eco": "B00", "name": "One", "moves": ["e2e4"]},
                    {"eco": "B01", "name": "Two", "moves": ["e2e4"]},
                ],
            },
            {
                "schema_version": 1,
                "entries": [{"eco": "B00", "name": "Bad", "moves": ["e2e5"]}],
            },
        ]
        for fixture in fixtures:
            with self.subTest(fixture=fixture), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "openings.json"
                path.write_text(json.dumps(fixture), encoding="utf-8")
                with self.assertRaises(RuntimeError):
                    _load_opening_prefixes(path)


if __name__ == "__main__":
    unittest.main()
