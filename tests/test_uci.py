from __future__ import annotations

import io
import subprocess
import sys
import unittest
from unittest import mock

import chess

import agent
import uci


class UCIAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        agent.reset_game_state()
        self.output = io.StringIO()
        self.adapter = uci.UCIAdapter(self.output)

    def lines(self) -> list[str]:
        return self.output.getvalue().splitlines()

    def test_uci_handshake_and_ready(self) -> None:
        self.assertTrue(self.adapter.handle_line("uci"))
        self.assertTrue(self.adapter.handle_line("isready"))
        self.assertEqual(
            self.lines(),
            [
                "id name FunChessEngine 1.0",
                "id author FunChessEngine contributors",
                "option name UCI_Chess960 type check default false",
                "uciok",
                "readyok",
            ],
        )

    def test_position_startpos_and_fen_apply_only_legal_moves(self) -> None:
        self.adapter.handle_line("position startpos moves e2e4 e7e5 g1f3")
        expected = chess.Board()
        for raw_move in ("e2e4", "e7e5", "g1f3"):
            expected.push_uci(raw_move)
        self.assertEqual(self.adapter.board.fen(), expected.fen())

        previous = self.adapter.board.fen()
        self.adapter.handle_line("position startpos moves e2e5")
        self.assertEqual(self.adapter.board.fen(), previous)

        fen = "7k/8/8/8/8/8/5K2/6R1 b - - 0 1"
        self.adapter.handle_line(f"position fen {fen} moves h8h7")
        expected = chess.Board(fen)
        expected.push_uci("h8h7")
        self.assertEqual(self.adapter.board.fen(), expected.fen())

    def test_go_uses_side_to_move_clock_and_bounded_increment_credit(self) -> None:
        self.adapter.handle_line("position startpos moves e2e4")
        with mock.patch("uci.agent.get_move", return_value="e7e5") as get_move:
            self.adapter.handle_line("go wtime 9000 btime 4000 winc 100 binc 700")

        get_move.assert_called_once()
        called_fen, called_clock = get_move.call_args.args
        self.assertEqual(called_fen, self.adapter.board.fen())
        self.assertEqual(called_clock, 4700)
        self.assertEqual(self.lines(), ["bestmove e7e5"])

    def test_movetime_is_mapped_to_existing_engine_budget(self) -> None:
        clock = self.adapter._clock_for_movetime(100)
        budget = agent._time_budget_ms(self.adapter.board, clock)
        self.assertGreaterEqual(budget, 100)
        if clock > 1:
            self.assertLess(agent._time_budget_ms(self.adapter.board, clock - 1), 100)

    def test_ucinewgame_resets_engine_state(self) -> None:
        agent.SEEN_POSITIONS[agent._repetition_key(chess.Board())] = 2
        self.adapter.handle_line("position startpos moves e2e4")
        self.adapter.handle_line("ucinewgame")
        self.assertFalse(agent.SEEN_POSITIONS)
        self.assertEqual(self.adapter.board.fen(), chess.STARTING_FEN)

    def test_chess960_option_uses_shredder_fen_and_uci_castling_mode(self) -> None:
        source = chess.Board.from_chess960_pos(518)
        self.adapter.handle_line("setoption name UCI_Chess960 value true")
        self.adapter.handle_line(f"position fen {source.fen()}")

        with mock.patch("uci.agent.get_move", return_value="e2e4") as get_move:
            self.adapter.handle_line("go wtime 5000 btime 5000")

        called_fen = get_move.call_args.args[0]
        self.assertIn(" HAha ", called_fen)
        self.assertEqual(self.lines(), ["bestmove e2e4"])

    def test_game_over_reports_null_bestmove(self) -> None:
        self.adapter.handle_line("position fen 7k/7Q/7K/8/8/8/8/8 b - - 0 1")
        self.adapter.handle_line("go movetime 50")
        self.assertEqual(self.lines(), ["bestmove 0000"])

    def test_bad_engine_move_falls_back_to_legal_bestmove(self) -> None:
        with mock.patch("uci.agent.get_move", return_value="e2e5"):
            self.adapter.handle_line("go wtime 5000 btime 5000")
        raw_move = self.lines()[0].removeprefix("bestmove ")
        self.assertIn(chess.Move.from_uci(raw_move), chess.Board().legal_moves)

    def test_subprocess_protocol_has_no_non_uci_output(self) -> None:
        completed = subprocess.run(
            [sys.executable, "-m", "uci"],
            input="uci\nisready\nposition startpos\ngo movetime 50\nquit\n",
            text=True,
            capture_output=True,
            check=True,
            timeout=5,
        )
        lines = completed.stdout.splitlines()
        self.assertIn("uciok", lines)
        self.assertIn("readyok", lines)
        bestmoves = [line for line in lines if line.startswith("bestmove ")]
        self.assertEqual(len(bestmoves), 1)
        self.assertIn(chess.Move.from_uci(bestmoves[0].split()[1]), chess.Board().legal_moves)
        self.assertEqual(completed.stderr, "")


if __name__ == "__main__":
    unittest.main()
