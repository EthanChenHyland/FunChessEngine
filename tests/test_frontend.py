from __future__ import annotations

import re
import unittest
from pathlib import Path

APP_JS = Path(__file__).resolve().parents[1] / "gui" / "static" / "app.js"
INDEX_HTML = Path(__file__).resolve().parents[1] / "gui" / "static" / "index.html"
STYLE_CSS = Path(__file__).resolve().parents[1] / "gui" / "static" / "style.css"
ICON_BUILD = Path(__file__).resolve().parents[1] / "desktop" / "scripts" / "build-icon.sh"


class FrontendTransitionContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = APP_JS.read_text(encoding="utf-8")
        cls.html = INDEX_HTML.read_text(encoding="utf-8")
        cls.css = STYLE_CSS.read_text(encoding="utf-8")
        cls.icon_build = ICON_BUILD.read_text(encoding="utf-8")

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

    def test_appearance_settings_are_backward_compatible_and_independent(self) -> None:
        self.assertIn('appearance: "dark"', self.source)
        self.assertIn('pieceTheme: "classic"', self.source)
        self.assertIn("const merged = { ...DISPLAY_DEFAULTS,", self.source)
        self.assertIn("delete merged.logoColor", self.source)
        self.assertIn("return merged;", self.source)
        self.assertIn('root.dataset.appearance = display.appearance', self.source)
        self.assertIn('root.dataset.pieceTheme = display.pieceTheme', self.source)

    def test_light_mode_and_piece_theme_controls_exist(self) -> None:
        for control in ("appearanceSelect", "pieceThemeSelect"):
            self.assertIn(f'id="{control}"', self.html)
        for theme in ("classic", "clean", "bold", "soft", "outline", "tournament"):
            self.assertIn(f'value="{theme}"', self.html)
        self.assertIn(':root[data-appearance="light"]', self.css)
        self.assertIn(':root[data-piece-theme="clean"]', self.css)
        self.assertIn(':root[data-piece-theme="bold"]', self.css)
        self.assertIn(':root[data-piece-theme="soft"]', self.css)
        self.assertIn(':root[data-piece-theme="outline"]', self.css)
        self.assertIn(':root[data-piece-theme="tournament"]', self.css)
        self.assertIn('background: var(--logo-color)', self.css)
        self.assertIn('mask: url("/app-mark.svg")', self.css)

    def test_logo_is_fixed_and_not_user_configurable(self) -> None:
        self.assertNotIn('id="logoColorSelect"', self.html)
        self.assertNotIn("data-logo-color", self.css)
        self.assertIn("--logo-color: #5667e8", self.css)
        self.assertNotIn("root.dataset.logoColor", self.source)

    def test_light_mode_uses_tuned_accent_variants(self) -> None:
        for accent in ("lime", "cyan", "violet", "amber"):
            self.assertIn(
                f':root[data-appearance="light"][data-accent="{accent}"]',
                self.css,
            )
        self.assertIn("--accent-contrast: #ffffff", self.css)
        self.assertIn("color: var(--accent-contrast)", self.css)

    def test_dock_icon_build_preserves_svg_transparency(self) -> None:
        self.assertIn('sips -s format png "$SOURCE"', self.icon_build)
        self.assertNotIn("qlmanage -t", self.icon_build)


if __name__ == "__main__":
    unittest.main()
