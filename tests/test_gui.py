from __future__ import annotations

import time
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

    def test_pgn_round_trip_and_review_are_non_destructive(self) -> None:
        self.game.play_move("e2e4")
        self.game.play_move("e7e5")
        self.game.play_move("g1f3")
        final_fen = self.game.board.fen()

        exported = self.game.export_pgn()
        self.assertIn("1. e4 e5 2. Nf3", exported)

        review = self.game.review_state(1)
        self.assertEqual(review["ply"], 1)
        self.assertEqual(review["last_move"], "e2e4")
        self.assertEqual(self.game.board.fen(), final_fen)

        series = self.game.review_series()
        self.assertEqual(series["total_plies"], 3)
        self.assertEqual(len(series["evals"]), 4)
        self.assertEqual(len(series["labels"]), 4)

        restored = GameSession()
        restored.load_pgn(exported)
        self.assertEqual(restored.board.fen(), final_fen)
        self.assertTrue(restored.paused)

    def test_load_pgn_preserves_headers_and_result(self) -> None:
        pgn = """[Event \"Review Test\"]
[White \"Alpha\"]
[Black \"Beta\"]
[Result \"1-0\"]

1. e4 e5 2. Nf3 Nc6 1-0
"""
        self.game.load_pgn(pgn)
        state = self.game.state()
        self.assertEqual(state["pgn_headers"]["Event"], "Review Test")
        self.assertEqual(state["result"], "1-0")
        self.assertEqual(state["termination"], "pgn_import")
        self.assertEqual(state["moves_uci"], ["e2e4", "e7e5", "g1f3", "b8c6"])

    def test_pgn_round_trip_preserves_custom_start_position(self) -> None:
        fen = "8/8/8/8/8/4k3/8/4K2R w K - 0 1"
        self.game.reset(fen, 30_000)
        self.game.play_move("h1h3")
        exported = self.game.export_pgn()
        self.assertIn('[SetUp "1"]', exported)
        self.assertIn(f'[FEN "{fen}"]', exported)

        restored = GameSession()
        restored.load_pgn(exported)
        self.assertEqual(restored.initial_fen, fen)
        self.assertEqual(restored.board.fen(), self.game.board.fen())

    def test_game_analysis_is_isolated_and_reports_move_quality(self) -> None:
        self.game.play_move("e2e4")
        self.game.play_move("e7e5")
        final_fen = self.game.board.fen()
        started = self.game.start_analysis(80)
        self.assertEqual(started["status"], "running")
        deadline = time.monotonic() + 10
        result = started
        while result["status"] == "running" and time.monotonic() < deadline:
            time.sleep(0.05)
            result = self.game.analysis_state()
        self.assertEqual(result["status"], "complete", result.get("error"))
        self.assertEqual(result["completed"], 2)
        self.assertEqual(len(result["results"]), 2)
        self.assertIn(result["results"][0]["classification"], {
            "Best", "Excellent", "Good", "Inaccuracy", "Mistake", "Blunder", "Forced"
        })
        self.assertGreaterEqual(result["results"][0]["cpl"], 0)
        self.assertTrue(result["results"][0]["best_uci"])
        self.assertEqual(self.game.board.fen(), final_fen)
        self.assertTrue(self.game.paused)

    def test_multipv_returns_ranked_legal_lines_without_mutating_game(self) -> None:
        self.game.play_move("e2e4")
        self.game.play_move("e7e5")
        final_fen = self.game.board.fen()
        result = self.game.multipv(1, lines=3, budget_ms=120)
        self.assertEqual(result["ply"], 1)
        self.assertGreaterEqual(result["depth"], 1)
        self.assertGreater(result["nodes"], 0)
        self.assertEqual(len(result["lines"]), 3)
        review = chess.Board(self.game.initial_fen)
        review.push(chess.Move.from_uci("e2e4"))
        moves = [chess.Move.from_uci(item["move"]) for item in result["lines"]]
        self.assertEqual(len(set(moves)), 3)
        self.assertTrue(all(move in review.legal_moves for move in moves))
        self.assertEqual(self.game.board.fen(), final_fen)

    def test_arbitrary_variation_position_is_non_destructive(self) -> None:
        self.game.play_move("e2e4")
        live_fen = self.game.board.fen()
        root = self.game.position_from_fen(chess.STARTING_FEN)
        self.assertIn("e2e4", root["legal_moves"])
        self.assertEqual(root["legal_san"]["e2e4"], "e4")
        child = self.game.variation_move(chess.STARTING_FEN, "d2d4")
        self.assertEqual(child["move_san"], "d4")
        self.assertEqual(child["turn"], "black")
        self.assertEqual(self.game.board.fen(), live_fen)

    def test_opening_recognition_and_review_phase_are_exposed(self) -> None:
        for move in ("e2e4", "e7e5", "g1f3", "b8c6", "f1b5"):
            self.game.play_move(move)
        state = self.game.state()
        self.assertEqual(state["opening"]["eco"], "C60")
        self.assertEqual(state["opening"]["name"], "Ruy Lopez")
        review = self.game.review_state(5)
        self.assertEqual(review["opening"]["eco"], "C60")
        self.assertEqual(review["phase"], "opening")

    def test_evaluation_breakdown_is_non_destructive_and_sums_to_total(self) -> None:
        self.game.play_move("e2e4")
        live_fen = self.game.board.fen()
        result = self.game.evaluation_breakdown(live_fen)
        self.assertEqual(result["fen"], live_fen)
        self.assertEqual(
            result["total"],
            result["material"]
            + result["mobility"]
            + result["king_safety"]
            + result["position_pawns"],
        )
        self.assertEqual(self.game.board.fen(), live_fen)

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
