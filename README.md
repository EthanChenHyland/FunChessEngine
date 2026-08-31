# FunChessEngine
FunChessEngine is a standalone classical chess engine with local testing and analysis tools.
engine package, baselines to beat, and a local harness that speaks the same protocol and enforces the
same clock as the platform, so you can see whether a change actually helped before you package it.

```
git clone https://github.com/EthanChenHyland/FunChessEngine.git
cd FunChessEngine
make setup
make play
```

That plays your agent against a baseline over a full 120 s + 0.5 s game and prints the result.
Use `make zip` to build a portable `engine-package.zip` containing the standalone engine.

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
make play FEN="<fen>"                              # start from a given position
uv run python -m harness.play --black baselines/minimax --pgn game.pgn
uv run python -m harness.arena --opponent ../my-old-version --games 200
```

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

