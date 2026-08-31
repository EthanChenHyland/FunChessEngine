from __future__ import annotations

import unittest

import chess

from gui.server import GameSession


class GameSessionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.game = GameSession()

    def test_human_move_and_undo(self) -> None:
        self.game.play_move("e2e4")
        self.assertEqual(self.game.board.peek().uci(), "e2e4")
        self.assertEqual(self.game.state()["turn"], "black")
        self.game.undo()
        self.assertEqual(self.game.board.fen(), chess.STARTING_FEN)

    def test_rejects_illegal_move(self) -> None:
        with self.assertRaises(ValueError):
            self.game.play_move("e2e5")

    def test_engine_move_is_legal_and_records_metrics(self) -> None:
        before = self.game.board.copy()
        uci = self.game.engine_move(100)
        self.assertIn(chess.Move.from_uci(uci), before.legal_moves)
        state = self.game.state()
        self.assertIsNotNone(state["last_move"])
        self.assertGreaterEqual(state["last_engine_ms"], 0)
        self.assertGreater(state["last_engine_nodes"], 0)

    def test_reset_accepts_fen_and_resets_clock(self) -> None:
        fen = "8/8/8/8/8/4k3/8/4K3 w - - 0 1"
        self.game.reset(fen, 30_000)
        state = self.game.state()
        self.assertEqual(state["fen"], fen)
        self.assertEqual(state["white_ms"], 30_000)
        self.assertEqual(state["black_ms"], 30_000)


if __name__ == "__main__":
    unittest.main()
