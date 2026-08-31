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
- Last engine search time, searched node count, and completed iterative-deepening depth.
- Optional development search cap while retaining the production time manager by default.

The server and UI use only the Python standard library plus `python-chess`, and all browser assets
are local. Nothing loads from a CDN or external service.

## Engine package isolation

`harness/package.py` includes root-level Python files and optional weights. The GUI lives under
`gui/`, so `make zip` continues to produce a engine package containing only `agent.py` unless weights
are intentionally added later.
