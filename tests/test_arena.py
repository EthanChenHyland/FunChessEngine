from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import chess

from harness.arena import elo_from_score, load_openings, score_interval
from harness.rules import STDERR_TAIL_CAP
from harness.sandbox import Agent


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

    def test_score_interval_contains_observed_score_and_is_nonzero_at_extreme(self) -> None:
        low, high = score_interval(6, 0, 0)
        self.assertLess(low, 1.0)
        self.assertEqual(high, 1.0)
        low, high = score_interval(2, 2, 2)
        self.assertLess(low, 0.5)
        self.assertGreater(high, 0.5)

    def test_agent_stderr_tail_is_memory_bounded(self) -> None:
        code = (
            "import sys; "
            f"sys.stderr.write('x' * {STDERR_TAIL_CAP + 123}); sys.stderr.flush(); "
            "print('{\"ready\":true}', flush=True); sys.stdin.read()"
        )
        agent = Agent([sys.executable, "-u", "-c", code])
        try:
            agent.start(2)
        finally:
            agent.stop()
        self.assertEqual(len(agent.stderr_tail), STDERR_TAIL_CAP)



if __name__ == "__main__":
    unittest.main()
