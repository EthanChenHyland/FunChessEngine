from __future__ import annotations

import re
import unittest
from pathlib import Path

APP_JS = Path(__file__).resolve().parents[1] / "gui" / "static" / "app.js"


class FrontendTransitionContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = APP_JS.read_text(encoding="utf-8")

    def assert_function_contains(self, name: str, text: str, span: int = 6_000) -> None:
        match = re.search(rf"(?:async\s+)?function\s+{re.escape(name)}\b", self.source)
        self.assertIsNotNone(match, f"missing frontend function {name}")
        start = match.start() if match else 0
        self.assertIn(text, self.source[start : start + span], f"{name} must contain {text}")

    def test_live_undo_has_one_guarded_backend_entry_point(self) -> None:
        self.assertEqual(self.source.count('api("/api/undo"'), 1)
        self.assert_function_contains("undoLiveMove", 'api("/api/undo"')
        self.assert_function_contains("undoLiveMove", "takeBackTurn")
        self.assert_function_contains("undoLiveMove", "{ plies }")
        self.assertIn('$("undoBtn").addEventListener("click", undoLiveMove)', self.source)
        self.assertIn('command === "undo") undoLiveMove()', self.source)

    def test_game_library_supports_search_favorites_and_delete(self) -> None:
        self.assert_function_contains("renderRecentGames", '$("recentGamesSearch")')
        self.assert_function_contains("renderRecentGames", '$("recentFavoritesOnly")')
        self.assert_function_contains("toggleRecentFavorite", "snapshot.favorite")
        self.assert_function_contains("deleteRecentGame", "recentGames.splice")

    def test_game_replacements_clear_transient_workspaces_only_after_success(self) -> None:
        for name in (
            "restartStandardGame",
            "loadGamePng",
            "loadPgnText",
            "loadFenValue",
            "openRecentGame",
            "resumeRecovery",
        ):
            self.assert_function_contains(name, "clearTransientUiForReplacement")

    def test_external_game_loads_warn_before_replacing_progress(self) -> None:
        replacements = (
            "loadGamePng",
            "loadPgnText",
            "loadFenValue",
            "openRecentGame",
            "resumeRecovery",
        )
        for name in replacements:
            self.assert_function_contains(name, "confirmRestartIfNeeded")

    def test_review_navigation_and_live_controls_are_mutually_gated(self) -> None:
        self.assert_function_contains("renderReviewPanel", "navigationLocked")
        self.assert_function_contains("render", "liveControlsLocked")
        self.assert_function_contains("render", '$("humanSide").disabled')
        self.assertIn("Review navigation changes only the viewed position", self.source)


if __name__ == "__main__":
    unittest.main()
