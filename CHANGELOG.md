# Changelog

## Unreleased

- Fixed Windows backup-test cleanup locks by explicitly closing SQLite connections, including snapshot and restore failure paths; added retained-handle regression tests and expanded Windows/macOS database coverage.

- Added a filtered reference opening tree with position navigation, result bars, move frequencies, ratings, matching-game searches, and Standard/Chess960 support.
- Added explicit variant filtering; position shortcuts retain chess rules, comparisons ignore move counters, and older report responses cannot overwrite newer dossiers.

- Added collection navigation with counts, exact-folder/unfiled filters, additive/removal tag editing, preview-position searches, and persistent undo for the last ten organization edits.
- Fixed in-flight note/header saves overwriting newer edits or the newly selected game; reject stale notes, ignore obsolete request errors, and protect edits made during preview loading.
- Validate real calendar dates and ECO codes in header changes; submit only changed headers.

- Added a database browser with 38 documented additions spanning game tables, filters, saved searches, organization, preview/replay, header editing, exports, comparison, and player/opening reports; see `docs/DATABASE_BROWSER.md`.
- Fixed repeated-position opening statistics, zero-ply searches, Standard/Chess960 study isolation, and plugin-removal trainer indexing.

- Added a Tools workspace and Home/command-palette shortcuts for UCI tournaments, engine experiments, and recent jobs.
- Retain recent background results across backend restarts, mark interrupted work explicitly, and support opening partial results, JSON export, and durable dismissal.
- Fixed benchmark and A/B requests bypassing job cancellation and recovery.
- Save desktop metadata per collection with atomic replacements and resumable migration, avoiding full-workspace rewrites for clock autosaves.

## 1.1.0

- Expanded local chess intelligence with richer position/structure analysis, deeper tactical motifs, Syzygy optimal-move guidance, game-quality timelines, and MultiPV alternatives.
- Added disk-backed SQLite reference-game indexing with player/year/Elo/structure search, deterministic natural-language queries, and indexed opening exploration.
- Added robust external-UCI identity/options/MultiPV support, measured calibration tooling, advanced local tournament scheduling, regression comparison, self-play datasets, and safe parameter-tuning experiments.
- Upgraded studies into shared-position transposition graphs and expanded repertoire training with color-aware spaced repetition, automatic repertoire construction, tactical puzzle extraction, interactive lesson choices, and daily training goals.
- Added a separate editable profile-specific opening-book store with result learning and Polyglot mapping against known indexed positions.
- Expanded local search telemetry while preserving competition move-selection semantics and `agent.py` package isolation.
- Kept desktop and LAN security boundaries intact while expanding the workstation feature set and release validation.

## 1.0.0

- Original FunChessEngine engine with iterative deepening, alpha-beta/PVS/LMR, transposition and evaluation caches, quiescence, aspiration windows, bounded check extensions, repetition awareness, tapered evaluation, and clock-aware search.
- Responsive local play UI with full clocks, two-player/engine modes, promotion, setup editor, PGN/FEN/portable PNG workflows, themes, keyboard board navigation, and accessibility semantics.
- Non-destructive review with evaluation graph, isolated post-game analysis, move grades/CPL, move explanations, evaluation components, Retry Move, and MultiPV.
- Persistent local studies with branching variations, comments/NAGs, arrows/highlights, opening recognition, personal opening statistics, Recent Games, recovery, and spaced-repetition mistake training.
- Integrated engine benchmark/A-B lab with paired opening positions, JSON output, benchmark history, and approximate score/Elo uncertainty reporting.
- Hardened loopback HTTP API, engine flag handling, Electron navigation/permission/file-I/O boundaries, backend crash restart/lifecycle cleanup, CI/release gates, and default engine packaging isolated to `agent.py`.

Engine changes are retained only when measured; the final pre-1.0 SEE and countermove experiments were rejected after benchmark/A-B testing rather than shipped without evidence.
