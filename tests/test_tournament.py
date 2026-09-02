from __future__ import annotations

import unittest

from integrations.tournament import (
    gauntlet_pairings,
    performance_elo,
    round_robin_pairings,
    score_interval,
)


class TournamentTests(unittest.TestCase):
    def test_round_robin_and_gauntlet_reverse_colors(self) -> None:
        round_robin = round_robin_pairings(3, color_reversal=True)
        self.assertEqual(len(round_robin), 6)
        self.assertIn((0, 1), {(row.white, row.black) for row in round_robin})
        self.assertIn((1, 0), {(row.white, row.black) for row in round_robin})
        gauntlet = gauntlet_pairings(4, color_reversal=True)
        self.assertEqual(len(gauntlet), 6)
        self.assertTrue(all(0 in {row.white, row.black} for row in gauntlet))

    def test_performance_elo_and_score_interval_are_bounded(self) -> None:
        self.assertGreater(performance_elo(1500, 0.75), 1500)
        low, high = score_interval(3.0, 4)
        self.assertGreaterEqual(low, 0.0)
        self.assertLessEqual(high, 1.0)
        self.assertLess(low, high)


if __name__ == "__main__":
    unittest.main()
