# Engine Lab GUI

The local GUI is a development and play surface for FunChessEngine. It stays separate from the standalone `agent.py` runtime.

## Launch

```bash
make gui
```

or:

```bash
uv run python -m gui.server
```

Desktop mode is also available:

```bash
make desktop-dev
make desktop-build
```

The Electron shell starts and owns the local Python backend automatically, prefers a stable loopback
port (falling forward only when it is occupied), shuts the backend down with the app, remembers/clamps
window geometry to the current displays, and enforces a single app
instance. Native Game/Play/View menus and macOS file dialogs are exposed through a narrow sandboxed
preload bridge. Production builds bundle a standalone Python backend, so the packaged app does not
depend on the terminal environment.

The server binds to `127.0.0.1:8765` by default and opens the browser automatically. Use
`--port <port>` or `--no-open` when needed.

## Features

- Click-to-move or drag-and-drop legal chess board with move-target highlighting and promotion choice.
- Board flip, undo, new game, arbitrary FEN loading, and 17 built-in clock presets plus custom time.
- Human controls White, Black, both sides, or neither.
- Human-vs-engine automatic replies and engine-vs-engine autoplay.
- Pause/resume with frozen clocks, resignation, draw agreement, result/rematch dialog, captured-piece
  display, and material-advantage indicators.
- Portable PNG saves include FEN, move history, clocks, increment, mode, and manual game-result state;
  desktop open/save uses native file dialogs.
- Position setup mode edits a copy of the current board, supports placing/erasing or dragging pieces,
  Start/Clear controls, side to move, castling rights, en-passant, and move counters. Applying the
  setup validates the resulting chess position before replacing the current game.
- Pawn promotion supports queen, rook, bishop, and knight for either color, with color-correct icons
  plus Q/R/B/N keyboard selection. Underpromotion is supported by the same backend move path.
- Move list, game result/check status, static white-perspective evaluation, and an evaluation bar.
- Responsive board sizing bounded automatically by the available column and viewport height instead
  of exposing an unnecessary manual board-size control.
- Persistent appearance customization: four board themes, four interface accents, piece-scale slider,
  coordinate/legal-target/last-move toggles, and automatic human-side orientation.
- White-perspective or side-to-move evaluation display.
- Last engine search time, searched node count, NPS, completed iterative-deepening depth, search score,
  aspiration re-search count, and principal variation. Low-level controls live under Advanced diagnostics.
- Optional development search cap while retaining the production time manager by default.
- Standard PGN import/export in both browser and Electron builds.
- Untouched PGN imports retain comments, NAGs, side variations/RAVs, headers, and clock annotations on
  export. Once the live main line is edited, the retained annotation tree is discarded and export is
  regenerated from the authoritative board so stale annotations can never migrate onto new moves.
- Non-destructive game review: first/previous/next/last navigation and clickable move history.
- Clickable static evaluation-history graph; selecting a point jumps to that ply without
  replacing the live game.
- Review mode freezes clocks and can return to the underlying live game.
- Imported PGNs preserve common headers and open directly into a paused review workflow.
- Post-game analysis runs in a separate local engine process so review searches do not overwrite
  the live game's transposition/history/repetition state. Quick, Standard, and Deep presets stream
  progress back to the UI and can be canceled.
- Analyzed moves show the engine's preferred move, searched principal variation, centipawn loss,
  and a local Best/Excellent/Good/Inaccuracy/Mistake/Blunder classification. These labels are
  FunChessEngine heuristics, not a claim to reproduce another site's proprietary review model.
- Once a move is analyzed, **Retry this move** reconstructs the position immediately before that
  move without editing the saved game. A wrong attempt reveals the engine's preferred move with a
  board arrow; Escape returns to the reviewed main line.
- Evaluation-graph points upgrade from fast static values to searched post-game values as analysis
  results arrive.
- Session recovery continuously stores a bounded current-game snapshot in local app/browser storage.
  The last in-progress game remains resumable after either a normal quit or an interrupted session;
  explicitly discarding/replacing it clears the recovery state.
- The latest 24 completed or imported games are retained locally in a collapsed **Recent games**
  section. Reopening one restores the game and jumps directly into the existing review workflow.
- MultiPV position analysis ranks the top 1, 3, or 5 legal root moves in another isolated worker,
  reporting comparable scores, SAN principal variations, depth, nodes, and elapsed time. Clicking a
  candidate line draws its move on the current board.
- The 1.0 analysis workspace branches from any live/reviewed position without changing the saved
  game. Variations can carry comments and standard annotation glyphs, persist locally by root
  position, and restore automatically when that study is reopened.
- Right-click square highlights and right-drag arrows are stored locally by position and support
  multiple colors.
- A bundled, original FunChessEngine-curated opening dataset recognizes common ECO families and named
  variations by longest played-move prefix. It is review metadata only (not an engine opening book),
  stays fully local, and is included in both source and packaged desktop builds. A personal explorer
  uses recent local games to summarize next moves and outcomes.
- Post-game summaries include a transparent FunChess Accuracy score, opening/middlegame/endgame CPL,
  deterministic move explanations, and an inspectable evaluation-component breakdown.
- Significant analyzed misses feed a local personal trainer with best-move puzzles, hints, progress,
  a phase weakness profile, and lightweight spaced repetition.
- Cmd/Ctrl+K opens a command palette; PGN, FEN, and FunChessEngine PNG files can also be dropped onto
  the window. Optional move/check/training sounds are generated locally with WebAudio.
- Tools can launch the repeatable 12-position benchmark in an isolated worker, retain
  benchmark history locally, compare against another agent folder, and run paired A/B games from a
  source checkout. Packaged builds retain benchmark support; source A/B intentionally requires agent.py.
- Keyboard shortcuts for board flip, undo, engine move, pause/resume, and clearing the current selection.
- A shared original FunChessEngine mark is used for the in-app brand, Dock icon, and packaged macOS icon;
  icon binaries are generated from the SVG source during desktop builds rather than stored as build artifacts.
- Recent games, studies, annotations, trainer items, and benchmark history use IndexedDB as the durable
  browser/Electron store with migration/fallback for older localStorage profiles. Persistence failures
  are surfaced instead of silently dropping growing study data.
- Browser/drop imports enforce the same bounded FEN/PGN/PNG sizes as the desktop dialogs before reading
  file contents. New portable PNG saves use UTF-8 PNG `iTXt` metadata while existing `tEXt` saves remain loadable.
- Restarting the Electron backend routes through the sandboxed renderer bridge, carries a bounded live-game
  snapshot into the replacement backend before navigation, and therefore preserves the current position,
  clocks, mode metadata, and main-line history instead of silently starting a fresh game.
- The 1.0 desktop application combines setup/promotion, PGN review, isolated post-game analysis,
  Retry Move training, crash recovery, Recent Games, MultiPV, persisted studies/annotations, personal
  training, opening/evaluation insights, a command palette, document drop, and native Analyze actions.

The browser server and UI use only the Python standard library plus `python-chess`, and all browser
assets are local. Nothing loads from a CDN or external service. Electron is desktop packaging only and remains separate from the portable engine package.

## Engine package isolation

`harness/package.py` includes only `agent.py` by default, plus files/weights that are explicitly
requested. The GUI, desktop shell, harness, tests, and development tools therefore stay outside the
engine archive. `make verify-zip` asserts that isolation before release.

## Tools and recent background work

Open **Tools** from Home, the sixth workspace tab, or **Alt+6**. Existing Alt+1–5 shortcuts
keep their previous meaning. The command palette also opens the tournament manager or recent jobs.
Tools groups UCI tournaments, the development lab, and experiment history. Search telemetry stays in Analysis;
the internal strength match series stays in Play.

Benchmark and A/B runs use the same cancellable job system as tournaments, reference imports,
regressions, calibration, self-play, and parameter experiments. Tools shows start times and progress,
with controls to refresh status, open results, export JSON, and dismiss finished jobs. Dismissal removes
the job record; it leaves separately saved experiment and calibration history intact.

The backend retains up to 12 recent jobs in `job-history/` under its local data directory
(`FUNCHESS_DATA_DIR` overrides that directory). Progress is checkpointed at most once per second;
completion, failure, and cancellation are saved immediately. Work stopped by a backend restart is marked
**interrupted**. Engines are never restarted automatically. Saved partial tournament standings and import
counts can be opened. Reselect the same reference PGN in Library to resume from its committed import checkpoint;
other job kinds require a new run. Completed reference batches are already in the database.

Each durable job record is limited to 16 MB. Larger results remain available in the running app and
show a prompt to export before closing; only their summary survives restart. Job records are local operational
history and are not included in workspace ZIP exports; results saved into experiment/calibration collections
are included. JSON export is available directly from recent jobs.

Desktop metadata is stored as separate files in `workspace-collections/` under the Electron profile.
Clock recovery saves therefore do not rewrite studies or large histories. The first launch after upgrading
migrates the previous `workspace-metadata.json`, preserves newer collection files, and keeps the original as
`workspace-metadata.<id>.legacy.json`. Atomic replacements retain the previous value on a failed save.
Active collections share the existing 32 MB quota; the migration backup is preserved separately.
