# FunChessEngine

FunChessEngine is an original classical chess engine and fully local chess workstation. The project keeps development tooling, GUI code, tests,
and benchmarks outside the engine package so `engine-package.zip` remains small and auditable.

```
cd /Users/ethius/VSCode/FunChessEngine
make setup
make play
make gui
make desktop-dev
```

That plays your agent against a baseline over a full 120 s + 0.5 s game and prints the result.
Use `make zip` to build a portable `engine-package.zip` containing the standalone engine.

`make gui` launches the local Engine Lab in your browser. `make desktop-dev` launches the same
Engine Lab in an Electron desktop shell, and `make desktop-build` produces an Apple Silicon macOS
app/DMG with a bundled standalone Python backend. Desktop and GUI code stay outside the engine
package, so they are never included in `engine-package.zip`.

The Engine Lab includes a responsive board, click-to-move or drag-and-drop play, human/engine,
two-player and engine/engine modes, 17 built-in clock presets plus custom controls, pause/resume,
resign/draw/rematch, captured-piece/material tracking, portable PNG saves, FEN and PGN import/export,
a full piece-by-piece setup editor, keyboard-friendly pawn promotion, non-destructive move-by-move
review, a clickable evaluation-history graph, search telemetry/PV, themes, accent colors, piece
sizing, orientation preferences, and display toggles. Post-game analysis runs in an isolated local
engine process and adds best-move comparisons, CPL, move grades, searched graph points, and a
non-destructive Retry Move trainer. Crash recovery autosaves interrupted sessions, and a collapsed
Recent Games library keeps the latest completed/imported games available for one-click review.
Analyze also supports isolated MultiPV ranking for the top 1, 3, or 5 candidate lines at the live
or reviewed position. Version 0.5 adds a non-destructive variation-tree workspace with comments and
NAGs, persistent square highlights/arrows, local opening/ECO recognition, personal opening statistics,
FunChess Accuracy and phase-by-phase CPL, deterministic move explanations, an inspectable evaluation
breakdown, a spaced-repetition mistake trainer built from analyzed games, local move sounds, drag/drop
for PGN/FEN/saved PNG files, and a Cmd/Ctrl+K command palette. Preferences and training data stay local.

## Writing an agent

`agent.py` is the whole engine package. One function:

```python
def get_move(fen: str, time_left_ms: int) -> str:
    return "e2e4"
```

The project includes a legal random baseline, so the loop works before you write anything. Replace the body.

```
make play                                          # one game, real time control
make arena                                         # 20 fast games, prints a score
make benchmark                                     # varied-position depth/node benchmark
make benchmark COMPARE=../old-engine               # side-by-side search comparison
make gui                                           # local browser Engine Lab
make desktop-dev                                   # Electron desktop Engine Lab
make desktop-build                                 # build macOS app + DMG (Apple Silicon)
make play FEN="<fen>"                              # start from a given position
uv run python -m harness.play --black baselines/minimax --pgn game.pgn
uv run python -m harness.arena --opponent ../my-old-version --games 200
```

Offline teacher labels can also be generated from a separately installed UCI engine for training
your own future evaluation/policy model; see `docs/TRAINING.md`. The teacher itself is never
packaged or called by the runtime engine.

Local harness runs can capture stdout/stderr for diagnostics.

## The ladder

Measured with `harness/arena.py`. Beating greedy is a search. Beating minimax is a search plus an
evaluation worth searching with.

| Matchup | Games | Time control | Score |
|---|---|---|---|
| random vs greedy | 20 | 10 s + 0.1 s | 10.0% (+1 =2 -17) |
| greedy vs minimax | 6 | 120 s + 0.5 s | 0.0% (+0 =0 -6) |
| numba vs minimax | 6 | 10 s + 0.5 s | 66.7% (+2 =4 -0) |

- `baselines/random` plays a uniformly random legal move. It is what `agent.py` starts as.
- `baselines/greedy` searches one ply on material.
- `baselines/minimax` searches two plies on material and mobility, with no time management.
- `baselines/numba` is `minimax` with the evaluation jitted. It is barely stronger, which is
  the point: jitting a shallow search buys headroom, not depth. Read it for the warm-up call
  at the bottom, which is how you keep compilation off your clock.

## What's here

```
agent.py             your engine package
baselines/           random, greedy, minimax, numba; each is a directory with an agent.py
harness/runner.py    process wrapper used by the local harness
harness/referee.py   the clock, legality, draw and adjudication rules
harness/rules.py     local match defaults enforced by the harness
harness/sandbox.py   isolated engine-process protocol used by the harness
harness/play.py      one game between two agent directories
harness/arena.py     many games, with a score
harness/package.py   builds engine-package.zip with agent.py at the root
docs/IDEAS.md        where the strength actually comes from
```

Local games start from the normal position unless you pass `--fen`. Automated local games start from
curated neutral positions.

The harness provides repeatable local matches, clock handling, legality checks, and regression testing.

