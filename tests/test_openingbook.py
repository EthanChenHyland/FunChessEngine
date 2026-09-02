from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import chess

from openingbook.store import OpeningBook


class OpeningBookTests(unittest.TestCase):
    def test_edit_query_depth_and_learning(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            book = OpeningBook(Path(directory) / "book.sqlite3")
            row = book.add_move(chess.STARTING_FEN, "e2e4", weight=25)
            self.assertEqual(row["move"], "e2e4")
            book.add_move(chess.STARTING_FEN, "d2d4", weight=10)
            moves = book.moves(chess.STARTING_FEN)
            self.assertEqual([item["move"] for item in moves], ["e2e4", "d2d4"])
            self.assertEqual(book.moves(chess.STARTING_FEN, depth_limit=0), [])
            self.assertTrue(book.learn_result(chess.STARTING_FEN, "d2d4", 1.0))
            learned = {item["move"]: item["learn"] for item in book.moves(chess.STARTING_FEN)}
            self.assertGreater(learned["d2d4"], 0)
            self.assertEqual(book.stats(), {"moves": 2, "positions": 1})

    def test_rejects_illegal_book_move(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            book = OpeningBook(Path(directory) / "book.sqlite3")
            with self.assertRaisesRegex(ValueError, "legal UCI"):
                book.add_move(chess.STARTING_FEN, "e2e5")


if __name__ == "__main__":
    unittest.main()
