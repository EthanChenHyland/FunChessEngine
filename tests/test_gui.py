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
        self.assertGreaterEqual(state["last_engine_depth"], 1)
        self.assertIsInstance(state["last_engine_score"], int)
        self.assertTrue(state["last_engine_pv"])
        self.assertEqual(state["last_engine_pv"][0], uci)
        self.assertGreaterEqual(state["last_engine_researches"], 0)

    def test_reset_accepts_fen_and_resets_clock(self) -> None:
        fen = "8/8/8/8/8/4k3/8/4K3 w - - 0 1"
        self.game.reset(fen, 30_000, 2_000)
        state = self.game.state()
        self.assertEqual(state["fen"], fen)
        self.assertEqual(state["white_ms"], 30_000)
        self.assertEqual(state["black_ms"], 30_000)
        self.assertEqual(state["base_clock_ms"], 30_000)
        self.assertEqual(state["increment_ms"], 2_000)

    def test_reset_rejects_invalid_setup_position(self) -> None:
        with self.assertRaisesRegex(ValueError, "Invalid chess position"):
            self.game.reset("8/8/8/8/8/8/8/8 w - - 0 1")

    def test_pawn_promotion_and_underpromotion_are_legal(self) -> None:
        fen = "8/P7/8/8/8/8/7k/4K3 w - - 0 1"
        self.game.reset(fen)
        self.game.play_move("a7a8q")
        self.assertEqual(self.game.board.piece_at(chess.A8), chess.Piece(chess.QUEEN, chess.WHITE))

        self.game.reset(fen)
        self.game.play_move("a7a8n")
        self.assertEqual(self.game.board.piece_at(chess.A8), chess.Piece(chess.KNIGHT, chess.WHITE))

    def test_human_clock_consumes_time_and_applies_increment(self) -> None:
        self.game.reset(clock_ms=10_000, increment_ms=2_000)
        self.game.turn_started_ns -= 1_000_000_000
        self.game.play_move("e2e4")
        state = self.game.state()
        self.assertGreaterEqual(state["white_ms"], 10_900)
        self.assertLessEqual(state["white_ms"], 11_100)
        self.assertGreater(state["black_ms"], 9_900)

    def test_clock_flag_is_reported_as_game_over(self) -> None:
        self.game.reset(clock_ms=1, increment_ms=0)
        self.game.turn_started_ns -= 10_000_000
        state = self.game.state()
        self.assertTrue(state["game_over"])
        self.assertEqual(state["result"], "0-1")
        self.assertEqual(state["termination"], "time_forfeit")

    def test_saved_snapshot_round_trip_preserves_game_and_clocks(self) -> None:
        self.game.reset(clock_ms=60_000, increment_ms=1_000)
        self.game.play_move("e2e4")
        original = self.game.state()
        snapshot = {
            "initial_fen": original["initial_fen"],
            "moves": original["moves_uci"],
            "white_ms": original["white_ms"],
            "black_ms": original["black_ms"],
            "base_clock_ms": original["base_clock_ms"],
            "increment_ms": original["increment_ms"],
            "clock_history": original["clock_history"],
        }

        restored = GameSession()
        restored.load_snapshot(snapshot)
        loaded = restored.state()
        self.assertEqual(loaded["fen"], original["fen"])
        self.assertEqual(loaded["moves_uci"], ["e2e4"])
        self.assertEqual(loaded["base_clock_ms"], 60_000)
        self.assertEqual(loaded["increment_ms"], 1_000)
        self.assertAlmostEqual(loaded["white_ms"], original["white_ms"], delta=30)
        restored.undo()
        self.assertEqual(restored.board.fen(), chess.STARTING_FEN)

    def test_saved_snapshot_rejects_illegal_move(self) -> None:
        with self.assertRaisesRegex(ValueError, "illegal move"):
            self.game.load_snapshot({"moves": ["e2e5"]})

    def test_pause_stops_clock_and_blocks_moves(self) -> None:
        self.game.reset(clock_ms=10_000, increment_ms=0)
        self.game.turn_started_ns -= 1_000_000_000
        self.game.set_paused(True)
        paused = self.game.state()
        self.assertTrue(paused["paused"])
        paused_white = paused["white_ms"]
        self.game.turn_started_ns -= 5_000_000_000
        self.assertEqual(self.game.state()["white_ms"], paused_white)
        with self.assertRaisesRegex(ValueError, "paused"):
            self.game.play_move("e2e4")
        self.game.set_paused(False)
        self.game.play_move("e2e4")
        self.assertEqual(self.game.state()["turn"], "black")

    def test_resignation_and_draw_are_reported(self) -> None:
        self.game.resign("white")
        resigned = self.game.state()
        self.assertTrue(resigned["game_over"])
        self.assertEqual(resigned["result"], "0-1")
        self.assertEqual(resigned["termination"], "resignation")

        self.game.reset()
        self.game.agree_draw()
        drawn = self.game.state()
        self.assertTrue(drawn["game_over"])
        self.assertEqual(drawn["result"], "1/2-1/2")
        self.assertEqual(drawn["termination"], "draw_agreement")

    def test_captured_material_is_exposed(self) -> None:
        for move in ("e2e4", "d7d5", "e4d5"):
            self.game.play_move(move)
        state = self.game.state()
        self.assertEqual(state["captured_by_white"], ["p"])
        self.assertEqual(state["captured_by_black"], [])
        self.assertEqual(state["material_balance"], 1)


if __name__ == "__main__":
    unittest.main()
