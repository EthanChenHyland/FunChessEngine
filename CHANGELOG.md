# Changelog

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
