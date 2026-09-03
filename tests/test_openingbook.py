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

    def test_weight_edit_preserves_metadata_and_rejects_stale_edits(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            book = OpeningBook(Path(directory) / "book.sqlite3")
            book.add_move(chess.STARTING_FEN, "e2e4", weight=25, learn=18, source="teacher")
            book.update_weight(chess.STARTING_FEN, "e2e4", 0, expected_weight=25)
            move = book.moves(chess.STARTING_FEN)[0]
            self.assertEqual((move["weight"], move["learn"], move["source"]), (0, 18, "teacher"))
            with self.assertRaisesRegex(ValueError, "changed"):
                book.update_weight(chess.STARTING_FEN, "e2e4", 5, expected_weight=25)
            with self.assertRaises(ValueError):
                book.update_weight(chess.STARTING_FEN, "e2e4", -1)
            self.assertEqual(book.moves(chess.STARTING_FEN)[0]["weight"], 0)

    def test_adding_reference_move_retains_existing_settings(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            book = OpeningBook(Path(directory) / "book.sqlite3")
            self.assertTrue(
                book.add_move(
                    chess.STARTING_FEN,
                    "e2e4",
                    weight=25,
                    learn=12,
                    source="custom",
                    overwrite=False,
                )["saved"]
            )
            self.assertFalse(
                book.add_move(
                    chess.STARTING_FEN,
                    "e2e4",
                    weight=10,
                    source="database explorer",
                    overwrite=False,
                )["saved"]
            )
            move = book.moves(chess.STARTING_FEN)[0]
            self.assertEqual((move["weight"], move["learn"], move["source"]), (25, 12, "custom"))

    def test_profile_normalization_is_consistent_across_operations(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            book = OpeningBook(Path(directory) / "book.sqlite3")
            book.add_move(chess.STARTING_FEN, "e2e4", profile="  repertoire  ")
            self.assertEqual(len(book.moves(chess.STARTING_FEN, profile=" repertoire ")), 1)
            self.assertEqual(book.stats(" repertoire ")["moves"], 1)
            self.assertTrue(
                book.learn_result(chess.STARTING_FEN, "e2e4", 1, profile=" repertoire ")
            )
            book.update_weight(chess.STARTING_FEN, "e2e4", 5, profile=" repertoire ")
            self.assertTrue(book.remove_move(chess.STARTING_FEN, "e2e4", profile=" repertoire "))
            self.assertEqual(book.stats("repertoire")["moves"], 0)


if __name__ == "__main__":
    unittest.main()
