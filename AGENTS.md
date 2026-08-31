# Working in this repo

FunChessEngine is a standalone classical chess engine and local chess workstation.
Keep engine changes measurable, source-original, and easy to audit.

## Engine contract

- `agent.py` exposes `get_move(fen: str, time_left_ms: int) -> str`.
- Return a legal UCI move such as `e2e4` or `e7e8q`.
- Keep module state bounded and deterministic across moves in one game.
- Use Python 3.12 and the dependencies declared in `pyproject.toml`.
- Keep the engine independent from the GUI, desktop shell, and development harness.

## Development rules

- Do not vendor or wrap third-party chess engines inside the runtime engine.
- External engines may be used only as optional offline teachers for locally generated training data.
- Keep search changes isolated and benchmark them against a frozen baseline before retaining them.
- Do not stack unvalidated search heuristics.
- Prefer correctness, legal-move safety, bounded memory, and clock safety over speculative strength.

## Verify

```
make play
make arena
make benchmark
make zip       # build engine-package.zip with agent.py at the root
make gate
```

## Style

Python 3.12, type-annotated, Ruff and mypy clean. Keep `agent.py` readable and source-original.
