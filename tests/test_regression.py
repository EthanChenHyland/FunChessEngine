from __future__ import annotations

import unittest

from harness.regression import CASES, run_suite


class RegressionHarnessTests(unittest.TestCase):
    def test_regression_suite_is_varied_and_legal(self) -> None:
        self.assertGreaterEqual(len(CASES), 4)
        self.assertGreaterEqual(len({case.theme for case in CASES}), 2)
        rows = run_suite(clock_scale=0.1)
        self.assertEqual(len(rows), len(CASES))
        self.assertTrue(all(row["legal"] for row in rows))
        self.assertTrue(all(int(row["elapsed_ms"]) >= 0 for row in rows))


if __name__ == "__main__":
    unittest.main()
