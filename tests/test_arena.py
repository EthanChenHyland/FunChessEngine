from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import chess

from harness.arena import elo_from_score, load_openings


class ArenaTests(unittest.TestCase):
    def test_default_opening_is_start_position(self) -> None:
        self.assertEqual(load_openings(None), [chess.STARTING_FEN])

    def test_opening_file_skips_comments_and_validates_positions(self) -> None:
        board = chess.Board()
        board.push_uci("e2e4")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "openings.fen"
            path.write_text(f"# paired suite\n\n{board.fen()}\n")
            self.assertEqual(load_openings(path), [board.fen()])

    def test_elo_estimate_is_symmetric(self) -> None:
        self.assertIsNone(elo_from_score(0.0))
        self.assertIsNone(elo_from_score(1.0))
        midpoint = elo_from_score(0.5)
        upper = elo_from_score(0.75)
        lower = elo_from_score(0.25)
        self.assertIsNotNone(midpoint)
        self.assertIsNotNone(upper)
        self.assertIsNotNone(lower)
        self.assertAlmostEqual(midpoint or 0.0, 0.0)
        self.assertAlmostEqual(upper or 0.0, -(lower or 0.0))


if __name__ == "__main__":
    unittest.main()
