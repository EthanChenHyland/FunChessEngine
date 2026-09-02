from __future__ import annotations

import unittest

from harness.book_tests import chess960_castling_contract, validate_opening_lines
from harness.tuner import coordinate_tune


class DevelopmentToolTests(unittest.TestCase):
    def test_opening_lines_are_legal_and_position_indexed(self) -> None:
        rows = validate_opening_lines()
        self.assertTrue(rows)
        self.assertTrue(all(row["legal_and_indexed"] for row in rows))
        self.assertTrue(chess960_castling_contract())

    def test_tuner_is_whitelisted_and_never_applies_changes(self) -> None:
        result = coordinate_tune(["ASPIRATION_WINDOW"])
        self.assertFalse(result["applied"])
        self.assertIn("ASPIRATION_WINDOW", result["suggested"])
        with self.assertRaisesRegex(ValueError, "Unsupported tunable"):
            coordinate_tune(["NOT_A_PARAMETER"])


if __name__ == "__main__":
    unittest.main()
