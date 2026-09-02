from __future__ import annotations

import http.client
import io
import json
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import chess
import chess.pgn

from gui.server import (
    DEFAULT_CLOCK_MS,
    DEFAULT_INCREMENT_MS,
    SESSION,
    GameSession,
    Handler,
    _detect_tactical_motifs,
    _start_lan_server,
    _stop_lan_server,
)


class GameSessionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.game = GameSession()

    def test_human_move_and_undo(self) -> None:
        self.game.play_move("e2e4")
        self.assertEqual(self.game.board.peek().uci(), "e2e4")
        self.assertEqual(self.game.state()["turn"], "black")
        self.game.undo()
        self.assertEqual(self.game.board.fen(), chess.STARTING_FEN)

    def test_undo_preserves_manual_pause(self) -> None:
        self.game.play_move("e2e4")
        self.game.set_paused(True)
        paused_black = self.game.state()["black_ms"]

        self.game.undo()

        state = self.game.state()
        self.assertTrue(state["paused"])
        self.assertEqual(self.game.board.fen(), chess.STARTING_FEN)
        time.sleep(0.01)
        self.assertEqual(self.game.state()["black_ms"], paused_black)

    def test_multi_ply_undo_restores_position_and_clock_history(self) -> None:
        self.game.reset(clock_ms=60_000, increment_ms=1_000)
        self.game.play_move("e2e4")
        after_white = self.game.state()
        self.game.play_move("e7e5")
        self.game.play_move("g1f3")

        self.game.undo(2)

        state = self.game.state()
        self.assertEqual(state["moves_uci"], ["e2e4"])
        self.assertEqual(state["turn"], "black")
        self.assertAlmostEqual(state["white_ms"], after_white["white_ms"], delta=30)

    def test_undo_reopens_manual_result_without_preserving_result_pause(self) -> None:
        self.game.play_move("e2e4")
        self.game.resign("black")
        self.assertTrue(self.game.state()["paused"])

        self.game.undo()

        state = self.game.state()
        self.assertFalse(state["paused"])
        self.assertFalse(state["game_over"])
        self.assertIsNone(state["result"])
        self.assertEqual(self.game.board.fen(), chess.STARTING_FEN)

    def test_undo_invalidates_running_analysis_state(self) -> None:
        self.game.play_move("e2e4")
        self.game.paused = True
        self.game.analysis_status = "running"
        self.game.analysis_results = [{"ply": 1, "cpl": 0}]
        self.game.analysis_completed = 1
        self.game.analysis_total = 1

        self.game.undo()

        analysis = self.game.analysis_state()
        self.assertEqual(analysis["status"], "idle")
        self.assertEqual(analysis["results"], [])
        self.assertEqual(analysis["completed"], 0)
        self.assertEqual(analysis["total"], 0)

    def test_rejects_illegal_move(self) -> None:
        with self.assertRaises(ValueError):
            self.game.play_move("e2e5")

    def test_engine_move_is_legal_and_records_metrics(self) -> None:
        # Leave the built-in opening repertoire so this test exercises search telemetry.
        self.game.play_move("e2e3")
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

    def test_engine_personality_and_skill_configuration_remain_legal(self) -> None:
        config = self.game.configure_engine(profile="aggressive", skill=55, move_time_cap_ms=250)
        self.assertEqual(config["profile"], "aggressive")
        self.assertEqual(config["skill"], 55)
        self.assertEqual(config["move_time_cap_ms"], 250)
        before = self.game.board.copy()
        uci = self.game.engine_move(120)
        self.assertIn(chess.Move.from_uci(uci), before.legal_moves)
        state = self.game.state()
        self.assertEqual(state["engine_profile"], "aggressive")
        self.assertEqual(state["engine_skill"], 55)

        with self.assertRaisesRegex(ValueError, "Unknown engine personality"):
            self.game.configure_engine(profile="reckless-random")

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

    def test_chess960_reset_move_review_and_export_preserve_variant(self) -> None:
        start = chess.Board.from_chess960_pos(0)
        self.game.reset(start.fen(), chess960=True)
        before = self.game.state()
        self.assertEqual(before["variant"], "chess960")
        self.assertTrue(self.game.board.chess960)

        move = next(iter(self.game.board.legal_moves))
        self.game.play_move(move.uci())
        review = self.game.review_state(1)
        self.assertEqual(review["fen"], self.game.board.fen())
        self.assertTrue(self.game.board.chess960)

        exported = self.game.export_pgn()
        parsed = chess.pgn.read_game(io.StringIO(exported))
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed.headers.get("Variant"), "Chess960")
        self.assertTrue(parsed.board().chess960)
        self.assertEqual([item.uci() for item in parsed.mainline_moves()], [move.uci()])

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
        parsed = chess.pgn.read_game(io.StringIO(exported))
        self.assertIsNotNone(parsed)
        self.assertEqual(
            [move.uci() for move in parsed.mainline_moves()] if parsed else [],
            ["e2e4", "e7e5", "g1f3"],
        )
        self.assertIn("[%clk", exported)

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

    def test_review_exposes_stable_recorded_clock_snapshots(self) -> None:
        self.game.reset(clock_ms=10_000, increment_ms=2_000)
        self.game.play_move("e2e4")
        first = self.game.review_state(1)
        self.assertGreater(first["recorded_white_ms"], 11_500)
        self.assertLessEqual(first["recorded_white_ms"], 12_000)
        self.assertGreater(first["recorded_black_ms"], 9_500)
        self.assertLessEqual(first["recorded_black_ms"], 10_000)

        self.game.play_move("e7e5")
        second = self.game.review_state(2)
        self.assertGreater(second["recorded_black_ms"], 11_500)
        self.assertEqual(self.game.review_state(1)["recorded_white_ms"], first["recorded_white_ms"])
        self.assertEqual(self.game.review_state(1)["recorded_black_ms"], first["recorded_black_ms"])
        self.assertEqual(self.game.review_state(0)["recorded_white_ms"], 10_000)
        self.assertEqual(self.game.review_state(0)["recorded_black_ms"], 10_000)

    def test_pgn_clock_comments_drive_review_clock_snapshots(self) -> None:
        pgn = """[Event \"Clock Review\"]
[TimeControl \"600+5\"]
[Result \"*\"]

1. e4 {[%clk 0:09:58]} e5 {[%clk 0:09:57]} 2. Nf3 {[%clk 0:09:55]} *
"""
        self.game.load_pgn(pgn)
        self.assertEqual(self.game.state()["base_clock_ms"], 600_000)
        self.assertEqual(self.game.state()["increment_ms"], 5_000)
        self.assertEqual(self.game.review_state(0)["recorded_white_ms"], 600_000)
        self.assertEqual(self.game.review_state(1)["recorded_white_ms"], 598_000)
        self.assertEqual(self.game.review_state(1)["recorded_black_ms"], 600_000)
        self.assertEqual(self.game.review_state(2)["recorded_white_ms"], 598_000)
        self.assertEqual(self.game.review_state(2)["recorded_black_ms"], 597_000)
        self.assertEqual(self.game.review_state(3)["recorded_white_ms"], 595_000)

    def test_imported_pgn_round_trip_preserves_comments_nags_and_variations(self) -> None:
        pgn = """[Event \"Annotated Review\"]
[TimeControl \"600+5\"]
[Result \"*\"]

1. e4 $1 {King pawn [%clk 0:09:58]} (1. d4 $2 {Queen pawn} d5) e5 $5
{Central reply [%clk 0:09:57]} 2. Nf3 {Develops a knight [%clk 0:09:55]} *
"""
        self.game.load_pgn(pgn)

        exported = self.game.export_pgn()
        parsed = chess.pgn.read_game(io.StringIO(exported))

        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed.headers["TimeControl"], "600+5")
        self.assertEqual([move.uci() for move in parsed.mainline_moves()], ["e2e4", "e7e5", "g1f3"])
        self.assertEqual(len(parsed.variations), 2)
        e4 = parsed.variations[0]
        d4 = parsed.variations[1]
        self.assertIn(1, e4.nags)
        self.assertIn("King pawn", e4.comment)
        self.assertAlmostEqual(e4.clock() or 0, 598.0)
        self.assertEqual(d4.move.uci(), "d2d4")
        self.assertIn(2, d4.nags)
        self.assertIn("Queen pawn", d4.comment)
        e5 = e4.variations[0]
        self.assertIn(5, e5.nags)
        self.assertIn("Central reply", e5.comment)
        self.assertAlmostEqual(e5.clock() or 0, 597.0)

    def test_imported_pgn_tree_is_discarded_after_live_mainline_mutation(self) -> None:
        pgn = """[Event \"Annotated Review\"]
[TimeControl \"600+5\"]
[Result \"*\"]

1. e4 $1 {King pawn [%clk 0:09:58]} (1. d4 $2 {Queen pawn} d5) e5
{[%clk 0:09:57]} 2. Nf3 {[%clk 0:09:55]} *
"""
        self.game.load_pgn(pgn)
        self.game.set_paused(False)
        self.game.play_move("b8c6")

        exported = self.game.export_pgn()
        parsed = chess.pgn.read_game(io.StringIO(exported))

        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed.headers["TimeControl"], "600+5")
        self.assertEqual(
            [move.uci() for move in parsed.mainline_moves()],
            ["e2e4", "e7e5", "g1f3", "b8c6"],
        )
        self.assertEqual(len(parsed.variations), 1)
        self.assertNotIn(1, parsed.variations[0].nags)
        self.assertNotIn("King pawn", exported)
        self.assertNotIn("Queen pawn", exported)
        self.assertIn("[%clk", exported)

    def test_imported_pgn_tree_is_discarded_by_undo_and_reset(self) -> None:
        pgn = """[Event \"Annotated Finished\"]
[TimeControl \"600+5\"]
[Termination \"normal\"]
[Result \"1-0\"]

1. e4 $1 {King pawn [%clk 0:09:58]} (1. d4 $2 {Queen pawn} d5) e5
{[%clk 0:09:57]} 2. Nf3 {[%clk 0:09:55]} 1-0
"""
        self.game.load_pgn(pgn)
        self.game.undo()

        exported_after_undo = self.game.export_pgn()
        parsed_after_undo = chess.pgn.read_game(io.StringIO(exported_after_undo))
        self.assertIsNotNone(parsed_after_undo)
        assert parsed_after_undo is not None
        self.assertEqual(
            [move.uci() for move in parsed_after_undo.mainline_moves()], ["e2e4", "e7e5"]
        )
        self.assertEqual(parsed_after_undo.headers["Result"], "*")
        self.assertNotIn("Termination", parsed_after_undo.headers)
        self.assertEqual(len(parsed_after_undo.variations), 1)
        self.assertNotIn("King pawn", exported_after_undo)
        self.assertNotIn("Queen pawn", exported_after_undo)
        self.assertIn("[%clk", exported_after_undo)

        self.game.reset()
        exported_after_reset = self.game.export_pgn()
        self.assertNotIn("Annotated Finished", exported_after_reset)
        self.assertNotIn("King pawn", exported_after_reset)
        self.assertNotIn("Queen pawn", exported_after_reset)
        self.assertNotIn("600+5", exported_after_reset)

    def test_pgn_tree_fidelity_keeps_existing_size_and_mainline_move_limits(self) -> None:
        oversized = '[Result "*"]\n\n' + (" " * (2 * 1024 * 1024)) + "*\n"
        with self.assertRaisesRegex(ValueError, "too large"):
            self.game.load_pgn(oversized)

        game = chess.pgn.Game()
        node: chess.pgn.GameNode = game
        board = game.board()
        cycle = ("g1f3", "g8f6", "f3g1", "f6g8")
        for ply in range(1_001):
            move = chess.Move.from_uci(cycle[ply % len(cycle)])
            self.assertIn(move, board.legal_moves)
            node = node.add_variation(move)
            board.push(move)
        with self.assertRaisesRegex(ValueError, "too many moves"):
            self.game.load_pgn(str(game))

    def test_pgn_without_time_control_does_not_inherit_previous_game_clock(self) -> None:
        self.game.reset(clock_ms=600_000, increment_ms=10_000)
        self.game.load_pgn('[Result "*"]\n\n1. e4 e5 *\n')
        state = self.game.state()
        self.assertEqual(state["base_clock_ms"], DEFAULT_CLOCK_MS)
        self.assertEqual(state["increment_ms"], DEFAULT_INCREMENT_MS)
        self.assertEqual(state["recorded_initial_clocks"], [None, None])
        self.assertIsNone(self.game.review_state(1)["recorded_white_ms"])

    def test_pgn_with_parser_errors_is_rejected_instead_of_partially_loaded(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid or illegal notation"):
            self.game.load_pgn('[Result "*"]\n\n1. e4 e5 2. Bh6 *\n')

    def test_batch_pgn_parser_preserves_games_without_mutating_live_board(self) -> None:
        live_fen = self.game.board.fen()
        pgn = """[Event "First"]
[Result "*"]

1. e4 {first note} e5 *

[Event "Second"]
[Result "1/2-1/2"]

1. d4 d5 2. c4 1/2-1/2
"""
        games = self.game.parse_pgn_batch(pgn)
        self.assertEqual(len(games), 2)
        self.assertEqual(games[0]["headers"]["Event"], "First")
        self.assertIn("first note", games[0]["pgn"])
        self.assertEqual(games[1]["moves_uci"], ["d2d4", "d7d5", "c2c4"])
        self.assertEqual(self.game.board.fen(), live_fen)

    def test_isolated_pgn_analysis_does_not_replace_live_game(self) -> None:
        self.game.play_move("d2d4")
        live_fen = self.game.board.fen()
        result = self.game.analyze_pgn('[Event "Queued"]\n[Result "*"]\n\n1. e4 e5 *\n', 80)
        self.assertEqual(result["total"], 2)
        self.assertEqual(len(result["results"]), 2)
        self.assertIn("accuracy", result["summary"])
        self.assertEqual(result["headers"]["Event"], "Queued")
        self.assertEqual(self.game.board.fen(), live_fen)

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

    def test_development_benchmark_runs_in_isolated_worker(self) -> None:
        live_fen = self.game.board.fen()
        result = self.game.benchmark_engine(1_500)
        self.assertEqual(result["summary"]["positions"], 12)
        self.assertGreaterEqual(result["summary"]["mean_depth"], 1)
        self.assertGreater(result["summary"]["aggregate_nps"], 0)
        self.assertEqual(self.game.board.fen(), live_fen)

    def test_human_clock_consumes_time_and_applies_increment(self) -> None:
        self.game.reset(clock_ms=10_000, increment_ms=2_000)
        self.game.turn_started_ns -= 1_000_000_000
        self.game.play_move("e2e4")
        state = self.game.state()
        self.assertGreaterEqual(state["white_ms"], 10_900)
        self.assertLessEqual(state["white_ms"], 11_100)
        self.assertGreater(state["black_ms"], 9_900)

    def test_bronstein_clock_refunds_only_the_configured_delay(self) -> None:
        self.game.reset(clock_ms=10_000, increment_ms=0, clock_mode="bronstein", delay_ms=500)
        self.game.turn_started_ns -= 1_000_000_000
        self.game.play_move("e2e4")
        state = self.game.state()
        self.assertEqual(state["clock_mode"], "bronstein")
        self.assertEqual(state["delay_ms"], 500)
        self.assertAlmostEqual(state["white_ms"], 9_500, delta=40)
        self.assertAlmostEqual(state["black_ms"], 10_000, delta=40)

    def test_hourglass_clock_transfers_elapsed_time_to_opponent(self) -> None:
        self.game.reset(
            clock_ms=10_000,
            white_clock_ms=8_000,
            black_clock_ms=12_000,
            increment_ms=0,
            clock_mode="hourglass",
        )
        self.game.turn_started_ns -= 1_000_000_000
        self.game.play_move("e2e4")
        state = self.game.state()
        self.assertEqual(state["clock_mode"], "hourglass")
        self.assertAlmostEqual(state["white_ms"], 7_000, delta=40)
        self.assertAlmostEqual(state["black_ms"], 13_000, delta=40)
        self.assertEqual(state["white_base_clock_ms"], 8_000)
        self.assertEqual(state["black_base_clock_ms"], 12_000)

    def test_staged_time_control_awards_time_at_move_threshold(self) -> None:
        self.game.reset(
            clock_ms=10_000,
            increment_ms=0,
            time_stages=[{"moves": 1, "add_ms": 5_000}],
        )
        self.game.play_move("e2e4")
        after_white = self.game.state()
        self.assertGreater(after_white["white_ms"], 14_900)
        self.game.play_move("e7e5")
        after_black = self.game.state()
        self.assertGreater(after_black["black_ms"], 14_900)

    def test_clock_flag_is_reported_as_game_over(self) -> None:
        self.game.reset(clock_ms=1, increment_ms=0)
        self.game.turn_started_ns -= 10_000_000
        state = self.game.state()
        self.assertTrue(state["game_over"])
        self.assertEqual(state["result"], "0-1")
        self.assertEqual(state["termination"], "time_forfeit")

    def test_engine_move_finishing_after_flag_is_not_played_or_incremented(self) -> None:
        self.game.reset(clock_ms=10, increment_ms=100)
        before = self.game.board.fen()

        def slow_move(fen: str, _time_left_ms: int) -> str:
            time.sleep(0.03)
            return next(iter(chess.Board(fen).legal_moves)).uci()

        with patch("gui.server.agent.get_move", side_effect=slow_move):
            self.assertEqual(self.game.engine_move(), "")

        state = self.game.state()
        self.assertEqual(self.game.board.fen(), before)
        self.assertEqual(state["white_ms"], 0)
        self.assertEqual(state["black_ms"], 10)
        self.assertEqual(state["moves_uci"], [])
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

    def test_running_analysis_blocks_resume_until_canceled(self) -> None:
        self.game.set_paused(True)
        self.game.analysis_status = "running"

        with self.assertRaisesRegex(ValueError, "Cancel game analysis"):
            self.game.set_paused(False)

        self.game.cancel_analysis()
        self.game.set_paused(False)
        self.assertFalse(self.game.state()["paused"])

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

    def test_tactical_motifs_and_human_plans_are_exposed(self) -> None:
        board = chess.Board("4k3/8/8/3q4/3R4/8/8/4K3 w - - 0 1")
        move = chess.Move.from_uci("d4d5")
        motifs = _detect_tactical_motifs(board, move)
        self.assertIn("capture", motifs)

        insights = self.game.position_insights(chess.STARTING_FEN)
        self.assertEqual(insights["phase"], "opening")
        self.assertTrue(insights["plans"])
        self.assertIn("white", insights["attacks"])
        self.assertIn("black", insights["passed_pawns"])
        self.assertTrue(self.game.state()["plans"])

    def test_tablebase_probe_is_optional_and_local(self) -> None:
        result = self.game.tablebase_probe("8/8/8/8/8/3k4/8/3K4 w - - 0 1", "/no/such/path")
        self.assertFalse(result["available"])
        self.assertIn("Syzygy", result["reason"])

    def test_time_management_coaching_uses_recorded_clocks_and_analysis(self) -> None:
        self.game.reset(clock_ms=60_000, increment_ms=1_000)
        self.game.recorded_initial_clocks = (60_000, 60_000)
        self.game.recorded_clocks = [(59_900, 60_000), (59_900, 50_000)]
        self.game.board.push_uci("e2e4")
        self.game.board.push_uci("e7e5")
        self.game.analysis_results = [
            {"ply": 1, "cpl": 160},
            {"ply": 2, "cpl": 0},
        ]
        coaching = self.game.time_management_coaching()
        self.assertEqual(coaching["impulsive_errors"], 1)
        self.assertGreater(coaching["average_think_ms"]["black"], 0)
        self.assertTrue(coaching["advice"])


class HandlerSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.server.server_port
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def test_explicit_lan_server_requires_random_token_cookie(self) -> None:
        status = _start_lan_server()
        try:
            self.assertTrue(status["running"])
            parsed = urlsplit(status["url"])
            token = parse_qs(parsed.query)["token"][0]
            connection = http.client.HTTPConnection("127.0.0.1", int(status["port"]), timeout=2)
            connection.request(
                "GET",
                f"/?token={token}",
                headers={"Host": f"127.0.0.1:{status['port']}"},
            )
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 302)
            cookie = response.getheader("Set-Cookie")
            self.assertIn("fce_lan=", cookie or "")
            connection.request(
                "GET",
                "/api/state",
                headers={
                    "Host": f"127.0.0.1:{status['port']}",
                    "Cookie": (cookie or "").split(";", 1)[0],
                },
            )
            api_response = connection.getresponse()
            payload = json.loads(api_response.read())
            self.assertEqual(api_response.status, 200)
            self.assertIn("fen", payload)
            connection.close()
        finally:
            _stop_lan_server()

    def setUp(self) -> None:
        SESSION.reset()

    def request(
        self,
        method: str,
        path: str,
        *,
        body: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, object], dict[str, str]]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        raw = response.read()
        response_headers = {name.lower(): value for name, value in response.getheaders()}
        connection.close()
        payload = json.loads(raw) if raw else {}
        return response.status, payload, response_headers

    def test_rejects_cross_origin_post(self) -> None:
        status, payload, _headers = self.request(
            "POST",
            "/api/reset",
            body="{}",
            headers={"Content-Type": "application/json", "Origin": "https://evil.example"},
        )
        self.assertEqual(status, 403)
        self.assertIn("local FunChessEngine", str(payload.get("error")))

    def test_rejects_non_json_post(self) -> None:
        status, payload, _headers = self.request(
            "POST",
            "/api/reset",
            body="{}",
            headers={"Content-Type": "text/plain"},
        )
        self.assertEqual(status, 403)
        self.assertIn("application/json", str(payload.get("error")))

    def test_rejects_non_loopback_host(self) -> None:
        status, _payload, _headers = self.request(
            "GET", "/api/state", headers={"Host": f"evil.example:{self.port}"}
        )
        self.assertEqual(status, 403)

    def test_accepts_same_origin_json_and_sends_security_headers(self) -> None:
        origin = f"http://127.0.0.1:{self.port}"
        status, payload, headers = self.request(
            "POST",
            "/api/reset",
            body="{}",
            headers={"Content-Type": "application/json", "Origin": origin},
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["fen"], chess.STARTING_FEN)
        self.assertEqual(headers.get("x-content-type-options"), "nosniff")
        self.assertEqual(headers.get("cross-origin-resource-policy"), "same-origin")

    def test_accepts_reasonably_large_local_json_for_game_imports(self) -> None:
        origin = f"http://127.0.0.1:{self.port}"
        body = json.dumps({"clock_ms": 120_000, "padding": "x" * 70_000})
        status, payload, _headers = self.request(
            "POST",
            "/api/reset",
            body=body,
            headers={"Content-Type": "application/json", "Origin": origin},
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["fen"], chess.STARTING_FEN)


if __name__ == "__main__":
    unittest.main()
