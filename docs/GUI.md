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

The Electron shell starts and owns the local Python backend automatically, chooses a free loopback
port, shuts the backend down with the app, remembers window geometry, and enforces a single app
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
- Non-destructive game review: first/previous/next/last navigation and clickable move history.
- Clickable static evaluation-history graph; selecting a point jumps to that ply without
  replacing the live game.
- Review mode freezes clocks and can return to the underlying live game.
- Imported PGNs preserve common headers and open directly into a paused review workflow.
- Keyboard shortcuts for board flip, undo, engine move, pause/resume, and clearing the current selection.
- A shared original FunChessEngine mark is used for the in-app brand, Dock icon, and packaged macOS icon;
  icon binaries are generated from the SVG source during desktop builds rather than stored as build artifacts.
- Desktop 0.3 adds a native **Set Up Position…** command under the Game menu.

The browser server and UI use only the Python standard library plus `python-chess`, and all browser
assets are local. Nothing loads from a CDN or external service. Electron is desktop packaging only and remains separate from the portable engine package.

## Engine package isolation

`harness/package.py` includes root-level Python files and optional weights. The GUI lives under
`gui/`, so `make zip` continues to produce a engine package containing only `agent.py` unless weights
are intentionally added later.
