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

The server binds to `127.0.0.1:8765` by default and opens the browser automatically. Use
`--port <port>` or `--no-open` when needed.

## Features

- Click-to-move legal chess board with move-target highlighting and promotion choice.
- Board flip, undo, new game, arbitrary FEN loading, and configurable local clock.
- Human controls White, Black, both sides, or neither.
- Human-vs-engine automatic replies and engine-vs-engine autoplay.
- Move list, game result/check status, static white-perspective evaluation, and an evaluation bar.
- Responsive board sizing that is bounded by the available column, viewport height, and a user
  configurable maximum instead of stretching with the page.
- Persistent display customization: four board themes, four interface accents, board-size and
  piece-scale sliders, coordinate/legal-target/last-move toggles, and automatic human-side
  orientation.
- White-perspective or side-to-move evaluation display.
- Last engine search time, searched node count, completed iterative-deepening depth, search score,
  aspiration re-search count, and principal variation.
- Optional development search cap while retaining the production time manager by default.
- Keyboard shortcuts for board flip, undo, engine move, and clearing the current selection.

The server and UI use only the Python standard library plus `python-chess`, and all browser assets
are local. Nothing loads from a CDN or external service.

## Engine package isolation

`harness/package.py` includes root-level Python files and optional weights. The GUI lives under
`gui/`, so `make zip` continues to produce a engine package containing only `agent.py` unless weights
are intentionally added later.
