from __future__ import annotations

import unittest

import chess

import agent


class AgentTests(unittest.TestCase):
    def setUp(self) -> None:
        agent.reset_game_state()

    def test_returns_legal_move(self) -> None:
        board = chess.Board()
        move = chess.Move.from_uci(agent.get_move(board.fen(), 2_000))
        self.assertIn(move, board.legal_moves)

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
        agent.reset_game_state()
        self.assertFalse(agent.SEEN_POSITIONS)
        self.assertFalse(agent.HISTORY)
        self.assertFalse(agent.TT)


if __name__ == "__main__":
    unittest.main()
