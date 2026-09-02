from __future__ import annotations

import unittest

from harness.regression import CASES, compare_runs, run_suite


class RegressionHarnessTests(unittest.TestCase):
    def test_regression_suite_is_varied_and_legal(self) -> None:
        self.assertGreaterEqual(len(CASES), 4)
        self.assertGreaterEqual(len({case.theme for case in CASES}), 2)
        rows = run_suite(clock_scale=0.1)
        self.assertEqual(len(rows), len(CASES))
        self.assertTrue(all(row["legal"] for row in rows))
        self.assertTrue(all(int(row["elapsed_ms"]) >= 0 for row in rows))

    def test_regression_comparison_flags_expected_move_loss(self) -> None:
        baseline = [
            {
                "name": "x",
                "move": "a",
                "legal": True,
                "expected": True,
                "depth": 3,
                "nodes": 10,
                "elapsed_ms": 5,
            }
        ]
        current = [
            {
                "name": "x",
                "move": "b",
                "legal": True,
                "expected": False,
                "depth": 2,
                "nodes": 8,
                "elapsed_ms": 6,
            }
        ]
        result = compare_runs(current, baseline)
        self.assertEqual(result["regressions"], 1)
        self.assertEqual(result["changed_moves"], 1)
        self.assertEqual(result["changes"][0]["depth_delta"], -1)


if __name__ == "__main__":
    unittest.main()
