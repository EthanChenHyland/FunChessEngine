from __future__ import annotations

import unittest

from harness.benchmark import BenchRow, positions, summary


class BenchmarkTests(unittest.TestCase):
    def test_position_suite_is_legal_and_varied(self) -> None:
        boards = positions()
        self.assertGreaterEqual(len(boards), 12)
        self.assertEqual(len({board.fen() for board in boards}), len(boards))
        for board in boards:
            self.assertFalse(board.is_game_over(claim_draw=True))
            self.assertGreater(board.legal_moves.count(), 0)

    def test_summary_aggregates_rows(self) -> None:
        rows = [
            BenchRow(1, "e2e4", 4, 1_000, 100, 10_000),
            BenchRow(2, "d2d4", 6, 3_000, 150, 20_000),
        ]
        stats = summary(rows)
        self.assertEqual(stats["positions"], 2)
        self.assertEqual(stats["mean_depth"], 5.0)
        self.assertEqual(stats["median_depth"], 5.0)
        self.assertEqual(stats["min_depth"], 4)
        self.assertEqual(stats["max_depth"], 6)
        self.assertEqual(stats["nodes"], 4_000)
        self.assertEqual(stats["elapsed_ms"], 250)
        self.assertEqual(stats["aggregate_nps"], 16_000)
        self.assertEqual(stats["median_nps"], 15_000)


if __name__ == "__main__":
    unittest.main()
