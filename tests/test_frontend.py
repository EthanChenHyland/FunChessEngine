from __future__ import annotations

import re
import unittest
from pathlib import Path

APP_JS = Path(__file__).resolve().parents[1] / "gui" / "static" / "app.js"
INDEX_HTML = Path(__file__).resolve().parents[1] / "gui" / "static" / "index.html"
STYLE_CSS = Path(__file__).resolve().parents[1] / "gui" / "static" / "style.css"
LOGO_SVG = Path(__file__).resolve().parents[1] / "gui" / "static" / "app-mark.svg"
ICON_BUILD = Path(__file__).resolve().parents[1] / "desktop" / "scripts" / "build-icon.sh"
DESKTOP_MAIN = Path(__file__).resolve().parents[1] / "desktop" / "main.js"
DESKTOP_PRELOAD = Path(__file__).resolve().parents[1] / "desktop" / "preload.js"
DESKTOP_PACKAGE = Path(__file__).resolve().parents[1] / "desktop" / "package.json"
DESKTOP_UI_SMOKE = Path(__file__).resolve().parents[1] / "desktop" / "scripts" / "ui-smoke.js"
DESKTOP_VERIFY_BUILD = (
    Path(__file__).resolve().parents[1] / "desktop" / "scripts" / "verify-build.js"
)
DESKTOP_NOTARIZE = Path(__file__).resolve().parents[1] / "desktop" / "scripts" / "notarize.js"
CI_WORKFLOW = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "ci.yml"
DESKTOP_BUILDS_WORKFLOW = (
    Path(__file__).resolve().parents[1] / ".github" / "workflows" / "desktop-builds.yml"
)


class FrontendTransitionContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = APP_JS.read_text(encoding="utf-8")
        cls.html = INDEX_HTML.read_text(encoding="utf-8")
        cls.css = STYLE_CSS.read_text(encoding="utf-8")
        cls.logo_svg = LOGO_SVG.read_text(encoding="utf-8")
        cls.icon_build = ICON_BUILD.read_text(encoding="utf-8")
        cls.desktop_main = DESKTOP_MAIN.read_text(encoding="utf-8")
        cls.desktop_preload = DESKTOP_PRELOAD.read_text(encoding="utf-8")
        cls.desktop_package = DESKTOP_PACKAGE.read_text(encoding="utf-8")
        cls.desktop_ui_smoke = DESKTOP_UI_SMOKE.read_text(encoding="utf-8")
        cls.desktop_verify_build = DESKTOP_VERIFY_BUILD.read_text(encoding="utf-8")
        cls.desktop_notarize = DESKTOP_NOTARIZE.read_text(encoding="utf-8")
        cls.ci = CI_WORKFLOW.read_text(encoding="utf-8")
        cls.desktop_builds = DESKTOP_BUILDS_WORKFLOW.read_text(encoding="utf-8")

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
        self.assert_function_contains("handleDesktopCommand", 'command === "undo"')
        self.assert_function_contains("handleDesktopCommand", "await undoLiveMove()")

    def test_game_library_supports_search_favorites_and_delete(self) -> None:
        self.assert_function_contains("renderRecentGames", '$("recentGamesSearch")')
        self.assert_function_contains("renderRecentGames", '$("recentFavoritesOnly")')
        self.assert_function_contains("toggleRecentFavorite", "snapshot.favorite")
        self.assert_function_contains("deleteRecentGame", "recentGames.splice")

    def test_sidebar_scrolls_per_tab_and_engine_strength_is_live_configurable(self) -> None:
        self.assertIn('id="engineStrengthSelect"', self.html)
        self.assertIn('id="engineStrengthValue"', self.html)
        self.assert_function_contains("applyEngineStrength", 'api("/api/engine-config"')
        self.assert_function_contains("applyEngineStrength", "engineProfileForSkill")
        self.assert_function_contains("activateTab", "tabScrollPositions.set")
        self.assert_function_contains("activateTab", "nextPanel.scrollTop")
        self.assertIn("grid-template-rows: auto minmax(0, 1fr);", self.css)
        self.assertIn("overscroll-behavior-y: contain;", self.css)
        self.assertIn("-webkit-overflow-scrolling: touch;", self.css)

    def test_variant_advanced_clocks_and_engine_profiles_are_exposed(self) -> None:
        for control in (
            "variantSelect",
            "chess960Position",
            "clockModeSelect",
            "delayInput",
            "whiteBaseInput",
            "blackBaseInput",
            "stageMovesInput",
            "stageAddInput",
            "engineProfileSelect",
            "engineMoveCapInput",
        ):
            self.assertIn(f'id="{control}"', self.html)
        self.assert_function_contains("resetPayloadFromControls", "white_clock_ms")
        self.assert_function_contains("resetPayloadFromControls", "black_clock_ms")
        self.assert_function_contains("resetPayloadFromControls", "time_stages")
        self.assert_function_contains("resetPayloadFromControls", "chess960_pos")
        self.assert_function_contains("applyEngineConfig", 'api("/api/engine-config"')

    def test_bulk_library_analysis_and_position_search_are_local_and_non_destructive(self) -> None:
        for control in (
            "bulkPgnBtn",
            "analyzeLibraryBtn",
            "analysisQueueCount",
            "searchPositionBtn",
            "positionSearchResults",
        ):
            self.assertIn(f'id="{control}"', self.html)
        self.assert_function_contains("importPgnCollectionText", 'api("/api/parse-pgn-batch"')
        self.assert_function_contains("runLibraryAnalysisQueue", 'runBackgroundJob("analyze-pgn"')
        self.assert_function_contains("renderPositionSearch", "fenPositionKey")
        self.assert_function_contains("openRecentGame", 'api("/api/load-pgn"')

    def test_training_prep_profile_and_visual_study_features_exist(self) -> None:
        for control in (
            "openingPrepReport",
            "playerProfile",
            "variationTree",
            "variationPromoteBtn",
            "endgameSelect",
            "customPuzzleMove",
            "visionModeSelect",
            "coordinateDrillBtn",
        ):
            self.assertIn(f'id="{control}"', self.html)
        self.assert_function_contains("renderOpeningPrepReport", "openingCpl")
        self.assert_function_contains("renderPlayerProfile", "training")
        self.assert_function_contains("renderVariationWorkspace", "renderedIds")
        self.assert_function_contains("renderVariationWorkspace", "parents")
        self.assert_function_contains("startEndgameDrill", "ENDGAME_DRILLS")
        self.assert_function_contains("saveCustomPuzzle", 'api("/api/variation-move"')
        self.assertIn(':root[data-vision-mode="blindfold"] .piece', self.css)

    def test_workspace_backup_share_onboarding_and_persistent_analysis_cache(self) -> None:
        for control in (
            "backupWorkspaceBtn",
            "restoreWorkspaceBtn",
            "copyShareBtn",
            "shareImageBtn",
            "showOnboardingBtn",
            "onboardingDialog",
        ):
            self.assertIn(f'id="{control}"', self.html)
        self.assert_function_contains(
            "workspaceBackupPayload", 'format: "FunChessEngine.WorkspaceBackup"'
        )
        self.assert_function_contains("restoreWorkspaceText", "validateWorkspaceBackup")
        self.assert_function_contains("copyShareText", "currentPgnText")
        self.assert_function_contains("showOnboarding", "ONBOARDING_KEY")
        self.assertIn('const POSITION_CACHE_KEY = "funChessEngine.positionCache.v1"', self.source)
        self.assert_function_contains("rememberPositionAnalysis", "savePositionAnalysisCache")

    def test_engine_match_series_and_native_open_documents_are_wired(self) -> None:
        for control in (
            "tournamentGames",
            "tournamentWhiteSkill",
            "tournamentBlackSkill",
            "startTournamentBtn",
            "stopTournamentBtn",
        ):
            self.assertIn(f'id="{control}"', self.html)
        self.assert_function_contains("startTournament", "tournamentState")
        self.assert_function_contains("scheduleComputerReply", "configureTournamentSide")
        self.assert_function_contains("handleNativeDocument", "importPgnCollectionText")
        self.assertIn("desktop.onOpenDocument?.", self.source)

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
        self.assertIn('lime: "green"', self.source)
        self.assertIn('cyan: "blue"', self.source)
        self.assertIn('violet: "purple"', self.source)
        self.assertIn('amber: "orange"', self.source)
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
        self.assertIn('background: url("/app-mark.svg")', self.css)

    def test_logo_is_fixed_and_not_user_configurable(self) -> None:
        self.assertNotIn('id="logoColorSelect"', self.html)
        self.assertNotIn("data-logo-color", self.css)
        self.assertNotIn("--logo-color", self.css)
        self.assertNotIn("root.dataset.logoColor", self.source)
        self.assertIn('fill="#ffffff"', self.logo_svg)
        self.assertIn('stroke="#111111"', self.logo_svg)
        self.assertIn('viewBox="48 48 928 928"', self.logo_svg)
        self.assertIn('class="brand-title-row"', self.html)
        self.assertIn('class="brand-copy"', self.html)
        self.assertIn("width: 56px", self.css)

    def test_light_mode_uses_tuned_accent_variants(self) -> None:
        for accent in ("green", "blue", "purple", "orange"):
            self.assertIn(
                f':root[data-appearance="light"][data-accent="{accent}"]',
                self.css,
            )
            self.assertIn(f'value="{accent}"', self.html)
        self.assertIn("--accent-contrast: #ffffff", self.css)
        self.assertIn("color: var(--accent-contrast)", self.css)

    def test_launcher_precedes_board_and_analysis_uses_recorded_clocks(self) -> None:
        self.assertIn('id="startScreen"', self.html)
        self.assertIn('id="mainWorkspace" class="workspace" hidden', self.html)
        for control in (
            "startPlayBtn",
            "startAnalysisBtn",
            "startNewGameBtn",
            "startPgnBtn",
            "startFenBtn",
            "startLibraryBtn",
            "startSettingsBtn",
            "homeBtn",
        ):
            self.assertIn(f'id="{control}"', self.html)
        self.assertNotIn('id="workspaceSelect"', self.html)
        self.assertIn('id="clockContext"', self.html)
        self.assert_function_contains("renderClocks", "recorded_white_ms")
        self.assert_function_contains("renderClocks", "Recorded game clocks")
        self.assert_function_contains("activateTab", 'nextTab === "engine"')
        self.assert_function_contains("activateTab", "enterReviewMode")
        self.assert_function_contains("showLauncher", 'api("/api/pause"')
        self.assert_function_contains("enterWorkbench", "homeAutoPaused")
        self.assertIn('id="startSessionSummary"', self.html)
        self.assert_function_contains("renderLauncher", "startPlayLabel")

    def test_analysis_workspace_has_chessbase_style_navigation_and_engine_tools(self) -> None:
        for control in (
            "reviewPlySlider",
            "reviewPrevErrorBtn",
            "reviewNextErrorBtn",
            "copyAnalysisFenBtn",
            "analysisNotation",
            "positionAnalysisQuality",
            "analysisAutoToggle",
        ):
            self.assertIn(f'id="{control}"', self.html)
        self.assert_function_contains("renderAnalysisNotation", "recordedClockTextForPly")
        self.assert_function_contains("jumpAnalysisError", "analysisErrorPlies")
        self.assert_function_contains("scheduleAutoPositionAnalysis", "analysisAutoToggle")
        self.assert_function_contains("runMultiPv", "positionAnalysisQuality")
        self.assertNotIn('.workspace[data-active-tab="engine"]', self.css)

    def test_launcher_blocks_hidden_board_shortcuts_and_routes_desktop_commands(self) -> None:
        self.assertIn("if (launcherVisible()) return;", self.source)
        self.assert_function_contains("loadGamePng", "fromLauncher")
        self.assert_function_contains("handleDesktopCommand", "enterWorkbench")
        self.assert_function_contains("togglePause", "homeAutoPaused = false")

    def test_display_settings_sanitize_corrupt_local_storage_values(self) -> None:
        self.assert_function_contains(
            "loadDisplaySettings",
            '["forest", "walnut", "ocean", "slate"]',
        )
        self.assert_function_contains("loadDisplaySettings", '["white", "turn"]')
        self.assert_function_contains("loadDisplaySettings", "Number.isFinite(pieceScale)")

    def test_dock_icon_build_preserves_svg_transparency(self) -> None:
        self.assertIn('sips -s format png "$SOURCE"', self.icon_build)
        self.assertNotIn("qlmanage -t", self.icon_build)

    def test_desktop_and_backend_pgn_import_limits_are_aligned(self) -> None:
        self.assertIn("const MAX_PGN_BYTES = 2 * 1024 * 1024;", self.desktop_main)

    def test_second_desktop_launch_reopens_a_closed_mac_window(self) -> None:
        self.assertIn('app.on("second-instance", async (_event, argv) => {', self.desktop_main)
        self.assertIn("await createWindow();", self.desktop_main)
        self.assertIn("candidateDocumentArgs(argv)", self.desktop_main)

    def test_saved_desktop_window_bounds_are_clamped_to_a_current_display(self) -> None:
        self.assertIn("function restoredWindowState(saved)", self.desktop_main)
        self.assertIn("screen.getAllDisplays()", self.desktop_main)
        self.assertIn("const restored = restoredWindowState(saved);", self.desktop_main)
        self.assertIn("Math.min(saved.width, workArea.width)", self.desktop_main)
        self.assertIn("Math.min(saved.height, workArea.height)", self.desktop_main)

    def test_desktop_backend_restart_preserves_a_bounded_renderer_snapshot(self) -> None:
        self.assertIn(
            'restartBackend: (snapshot) => ipcRenderer.invoke("backend:restart", snapshot)',
            self.desktop_preload,
        )
        self.assertIn("function validateRestartSnapshot(snapshot)", self.desktop_main)
        self.assertIn("async function restoreBackendSnapshot(url, snapshot)", self.desktop_main)
        self.assertIn('sendCommand("restart-backend")', self.desktop_main)
        self.assert_function_contains("restartDesktopBackend", "boundedDesktopRestartSnapshot")
        self.assert_function_contains("handleDesktopCommand", 'command === "restart-backend"')
        self.assertIn("const DESKTOP_BACKEND_PORT = 8765;", self.desktop_main)
        self.assertIn("function terminateBackendTree(child, force = false)", self.desktop_main)
        self.assertIn(
            'spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]',
            self.desktop_main,
        )
        self.assertIn("posixDescendants(child.pid)", self.desktop_main)

    def test_large_local_metadata_moves_to_indexeddb_with_fallback(self) -> None:
        self.assertIn('const DURABLE_DB_NAME = "FunChessEngine.LocalData"', self.source)
        self.assertIn("globalThis.indexedDB", self.source)
        self.assert_function_contains("persistDurableValue", "writeDurableValue")
        self.assert_function_contains("hydrateDurableMetadata", "readDurableValue")
        self.assertIn("hydrateDesktopPreferences().then(hydrateDurableMetadata)", self.source)

    def test_browser_imports_are_bounded_before_file_contents_are_read(self) -> None:
        self.assert_function_contains("assertBrowserFileSize", "file.size > maxBytes")
        self.assert_function_contains("handleDroppedFiles", "MAX_PGN_BYTES")
        self.assert_function_contains("handleDroppedFiles", "MAX_FEN_BYTES")
        self.assert_function_contains("loadGamePng", "MAX_SAVE_BYTES")

    def test_analysis_refreshes_queue_the_latest_position_after_busy_searches(self) -> None:
        self.assertIn("let autoPositionAnalysisQueued = false", self.source)
        self.assertIn("let evalBreakdownQueued = false", self.source)
        self.assert_function_contains(
            "scheduleAutoPositionAnalysis", "autoPositionAnalysisQueued = true"
        )
        self.assert_function_contains("runMultiPv", "scheduleAutoPositionAnalysis(true)")
        self.assert_function_contains("refreshEvaluationBreakdown", "evalBreakdownQueued = true")

    def test_last_session_recovery_survives_normal_quit_and_is_launcher_accessible(self) -> None:
        self.assertNotIn("RECOVERY_CLEAN_EXIT_KEY", self.source)
        self.assert_function_contains(
            "renderLauncher", 'playLabel.textContent = "Resume last session"'
        )
        self.assert_function_contains("continueFromLauncher", "resumeRecovery")
        self.assertIn(
            '$("startPlayBtn").addEventListener("click", continueFromLauncher)', self.source
        )

    def test_portable_png_uses_utf8_itxt_and_keeps_legacy_text_compatibility(self) -> None:
        self.assert_function_contains("makePngITxtChunk", 'encoder.encode("iTXt")')
        self.assert_function_contains("extractPngSnapshot", 'type === "tEXt"')
        self.assert_function_contains("extractPngSnapshot", 'type === "iTXt"')
        self.assert_function_contains("saveGamePng", 'setStatus("Save canceled.")')

    def test_linux_ci_configures_electron_suid_sandbox(self) -> None:
        self.assertIn("chrome-sandbox", self.ci)
        self.assertIn("node node_modules/electron/install.js", self.ci)
        self.assertIn("node -p \"require('electron')\"", self.ci)
        self.assertIn('SANDBOX_PATH="$(dirname "$ELECTRON_PATH")/chrome-sandbox"', self.ci)
        self.assertIn('test -f "$SANDBOX_PATH"', self.ci)
        self.assertIn("sudo chown root:root", self.ci)
        self.assertIn("sudo chmod 4755", self.ci)
        self.assertNotIn("--no-sandbox", self.ci)

    def test_desktop_release_has_behavioral_and_packaged_smokes(self) -> None:
        self.assertIn('"smoke:ui": "electron scripts/ui-smoke.js"', self.desktop_package)
        self.assertIn('"verify:build": "node scripts/verify-build.js"', self.desktop_package)
        self.assertIn(
            '"build:mac": "npm run build:icon && npm run build:backend '
            '&& npm run clean:dist && electron-builder --mac --arm64 '
            '&& npm run verify:build"',
            self.desktop_package,
        )
        self.assertIn("Review navigation mutated the live game", self.desktop_ui_smoke)
        self.assertIn("Packaged macOS build smoke OK", self.desktop_verify_build)
        self.assertIn("requireArm64(appExecutable)", self.desktop_verify_build)
        self.assertIn("requireArm64(backendExecutable)", self.desktop_verify_build)

    def test_cross_platform_desktop_packaging_is_available_without_weakening_mac_checks(
        self,
    ) -> None:
        self.assertIn('"build:linux":', self.desktop_package)
        self.assertIn("electron-builder --linux --x64", self.desktop_package)
        self.assertIn('"build:win":', self.desktop_package)
        self.assertIn("electron-builder --win --x64", self.desktop_package)
        self.assertIn('process.platform === "win32" ? "funchess-backend.exe"', self.desktop_main)
        self.assertIn("ubuntu-latest", self.desktop_builds)
        self.assertIn("windows-latest", self.desktop_builds)
        self.assertIn("actions/upload-artifact@v4", self.desktop_builds)

    def test_chess_intelligence_maps_tablebases_and_external_engines_are_wired(self) -> None:
        for control in (
            "threatMapToggle",
            "heatMapToggle",
            "humanPlanList",
            "positionFeatureGrid",
            "tacticalMotifs",
            "syzygyPathInput",
            "externalEnginePath",
            "externalEngineSelect",
            "externalEngineLines",
        ):
            self.assertIn(f'id="{control}"', self.html)
        self.assert_function_contains("refreshPositionInsights", 'api("/api/position-insights"')
        self.assert_function_contains("probeTablebase", 'api("/api/tablebase"')
        self.assert_function_contains("compareExternalEngine", 'api("/api/external-uci"')
        self.assert_function_contains("compareExternalEngine", "lines })")
        self.assert_function_contains("renderStrategicInsights", '$("positionFeatureGrid")')
        self.assert_function_contains("probeTablebase", "only_winning_move")
        self.assert_function_contains("renderBoard", 'button.classList.add("engine-heat")')
        self.assertIn(
            'openEngine: () => ipcRenderer.invoke("file:open-engine")',
            self.desktop_preload,
        )
        self.assertIn('ipcMain.handle("file:open-engine"', self.desktop_main)

    def test_repertoire_similarity_lessons_and_rating_history_are_durable(self) -> None:
        for control in (
            "similarGameResults",
            "openingDatabaseInput",
            "openingDatabaseSearch",
            "openingDatabasePlayer",
            "openingDatabaseStructure",
            "openingDatabaseResults",
            "openingDatabaseExplorer",
            "repertoireGapReport",
            "repertoireTrainerSelect",
            "lessonList",
            "ratingHistoryGraph",
            "studyFolderInput",
            "studyTagsInput",
        ):
            self.assertIn(f'id="{control}"', self.html)
        self.assert_function_contains("searchSimilarGames", "positionSimilarity")
        self.assert_function_contains(
            "importOpeningDatabaseFiles", 'runBackgroundJob("reference-import"'
        )
        self.assert_function_contains("searchOpeningDatabase", 'api("/api/library-db/search"')
        self.assert_function_contains("exploreOpeningDatabase", 'api("/api/library-db/explorer"')
        self.assert_function_contains("renderRepertoireGaps", "repertoirePreparedMoves")
        self.assert_function_contains("learnRepertoireConfidence", "child.confidence")
        self.assert_function_contains("startRepertoireTraining", "trainerItems.unshift")
        self.assert_function_contains("renderPerformanceHistory", "timeControlBucket")
        self.assertIn("LESSONS_KEY", self.source)

    def test_visible_advanced_controls_are_bound_to_their_implemented_workflows(self) -> None:
        bindings = (
            (
                '$("calibrateEngineBtn").addEventListener("click", runMeasuredCalibration)',
                "runMeasuredCalibration",
            ),
            ('$("buildRepertoireBtn").addEventListener("click"', "buildAutomaticRepertoire"),
            ('$("generateLibraryPuzzlesBtn").addEventListener("click"', "generateLibraryPuzzles"),
            (
                '$("saveSessionGoalsBtn").addEventListener("click", saveSessionGoalTargets)',
                "saveSessionGoalTargets",
            ),
            ('$("reviewNextLossBtn").addEventListener("click"', "reviewNextLoss"),
            ('$("refreshAlternativesBtn").addEventListener("click"', "refreshMoveAlternatives"),
            ('$("addOpeningBookMoveBtn").addEventListener("click"', "addCurrentOpeningBookMove"),
            ('$("importPolyglotBtn").addEventListener("click"', "importPolyglotBook"),
        )
        for binding, function_name in bindings:
            self.assertIn(binding, self.source)
            self.assertRegex(
                self.source,
                rf"(?:async\s+)?function\s+{re.escape(function_name)}\b",
                f"missing frontend function {function_name}",
            )
        self.assert_function_contains("render", "renderCalibrationEngines()", span=8_000)
        self.assert_function_contains("render", "renderSessionGoals()", span=8_000)
        self.assert_function_contains("activateTab", 'nextTab === "position"')
        self.assert_function_contains("activateTab", "refreshOpeningBook()")
        self.assertNotIn("calibrateEngineFromHistory", self.source)

    def test_privileged_desktop_ipc_requires_the_trusted_renderer(self) -> None:
        self.assertIn("function assertTrustedRenderer(event, action)", self.desktop_main)
        for channel in (
            "file:open-fen",
            "file:open-pgn",
            "file:open-png",
            "file:open-engine",
            "file:save-text",
            "file:save-pgn",
            "file:save-binary",
            "file:open-bundle",
            "file:save-bundle",
            "backend:restart",
        ):
            match = re.search(
                rf'ipcMain\.handle\("{re.escape(channel)}"[\s\S]{{0,260}}?assertTrustedRenderer\(event,',
                self.desktop_main,
            )
            self.assertIsNotNone(match, f"{channel} must reject untrusted renderer senders")

    def test_reports_image_import_share_editor_and_encrypted_sync_are_local(self) -> None:
        for control in (
            "boardImageInput",
            "shareImageTitle",
            "shareAnnotationsToggle",
            "exportAnnotatedPgnBtn",
            "exportHtmlReportBtn",
            "syncPassphraseInput",
            "encryptedSyncInput",
        ):
            self.assertIn(f'id="{control}"', self.html)
        self.assert_function_contains("recognizeBoardImage", "createImageBitmap")
        self.assert_function_contains("renderShareCard", "currentAnnotations")
        self.assert_function_contains("exportAnnotatedPgn", 'api("/api/export-annotated-pgn"')
        self.assert_function_contains("exportHtmlReport", 'api("/api/export-html-report"')
        self.assert_function_contains("exportEncryptedSync", 'name: "AES-GCM"')
        self.assert_function_contains("syncEncryptionKey", "PBKDF2")

    def test_plugins_lan_presets_and_command_palette_are_expanded_safely(self) -> None:
        for control in (
            "pluginInput",
            "pluginList",
            "lanStatus",
            "lanLink",
            "enginePresetSelect",
        ):
            self.assertIn(f'id="{control}"', self.html)
        self.assert_function_contains("validatePluginManifestClient", "SAFE_PLUGIN_ACTIONS")
        self.assert_function_contains("toggleLanSharing", 'api("/api/lan"')
        self.assert_function_contains("saveCurrentEnginePreset", "saveEnginePresets")
        self.assert_function_contains("commandDefinitions", "pluginManifests")
        self.assertIn("data-only", self.html.lower())

    def test_mac_notarization_hook_is_opt_in_and_credential_gated(self) -> None:
        self.assertIn('"afterSign": "scripts/notarize.js"', self.desktop_package)
        for name in ("APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"):
            self.assertIn(name, self.desktop_notarize)
        self.assertIn('tool: "notarytool"', self.desktop_notarize)


if __name__ == "__main__":
    unittest.main()
