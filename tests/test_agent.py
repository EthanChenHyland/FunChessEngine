from __future__ import annotations

import time
import unittest

import chess

import agent


class AgentTests(unittest.TestCase):
    def setUp(self) -> None:
        agent.reset_game_state()

    def test_returns_legal_move(self) -> None:
        board = chess.Board()
        for raw in [
            "e2e4", "e7e5", "g1f3", "b8c6", "f1b5",
            "a7a6", "b5a4", "g8f6", "e1g1", "f8e7",
        ]:
            board.push_uci(raw)
        move = chess.Move.from_uci(agent.get_move(board.fen(), 2_000))
        self.assertIn(move, board.legal_moves)
        self.assertGreaterEqual(agent.LAST_SEARCH_INFO.depth, 1)
        self.assertGreater(agent.LAST_SEARCH_INFO.nodes, 0)
        self.assertTrue(agent.LAST_SEARCH_INFO.pv)
        self.assertEqual(agent.LAST_SEARCH_INFO.pv[0], move.uci())

    def test_builtin_opening_book_is_legal_and_position_based(self) -> None:
        board = chess.Board()
        self.assertGreaterEqual(len(agent.OPENING_BOOK), 150)
        self.assertEqual(
            {move.uci() for move in agent.OPENING_BOOK[agent._repetition_key(board)]},
            {"e2e4", "d2d4", "c2c4", "g1f3"},
        )
        first = chess.Move.from_uci(agent.get_move(board.fen(), 120_000))
        self.assertEqual(first.uci(), "e2e4")
        self.assertIn(first, board.legal_moves)

        board.push(first)
        reply = agent._opening_book_move(board, 120_000)
        self.assertIsNotNone(reply)
        self.assertIn(reply, board.legal_moves)

    def test_exchange_filter_only_marks_obvious_defended_loss(self) -> None:
        defended = chess.Board("4k3/8/2p5/3p4/4Q3/8/8/4K3 w - - 0 1")
        hanging = chess.Board("4k3/8/8/3p4/4Q3/8/8/4K3 w - - 0 1")
        capture = chess.Move.from_uci("e4d5")

        self.assertTrue(agent._likely_losing_capture(defended, capture))
        self.assertFalse(agent._likely_losing_capture(hanging, capture))
        self.assertEqual(defended.fen(), "4k3/8/2p5/3p4/4Q3/8/8/4K3 w - - 0 1")

    def test_check_extension_is_bounded_and_recorded_in_tt_depth(self) -> None:
        board = chess.Board("4k3/8/8/8/8/8/4r3/4K3 w - - 0 1")
        self.assertTrue(board.is_check())
        agent.DEADLINE_NS = time.monotonic_ns() + 1_000_000_000
        agent.negamax(board, 1, -agent.INF, agent.INF, 0)
        self.assertEqual(agent.TT[agent._key(board)].depth, 2)

    def test_prefers_seeded_threefold_when_losing(self) -> None:
        fen = "7k/8/8/5K2/8/8/2Q5/8 b - - 0 1"
        board = chess.Board(fen)
        preferred = chess.Move.from_uci("h8h7")
        self.assertIn(preferred, board.legal_moves)

        board.push(preferred)
        repetition_key = agent._repetition_key(board)
        board.pop()
        agent.SEEN_POSITIONS[repetition_key] = 2

        self.assertEqual(agent.get_move(fen, 5_000), preferred.uci())

    def test_reset_clears_persistent_state(self) -> None:
        board = chess.Board()
        agent.SEEN_POSITIONS[agent._repetition_key(board)] = 2
        agent.HISTORY[(True, 1, 2)] = 42
        agent.evaluate(board)
        self.assertTrue(agent.EVAL_CACHE)
        agent.reset_game_state()
        self.assertFalse(agent.SEEN_POSITIONS)
        self.assertFalse(agent.HISTORY)
        self.assertFalse(agent.TT)
        self.assertFalse(agent.EVAL_CACHE)
        self.assertEqual(agent.LAST_SEARCH_INFO, agent.SearchInfo())


if __name__ == "__main__":
    unittest.main()
