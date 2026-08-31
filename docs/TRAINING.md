# Offline teacher-data workflow

FunChessEngine may use external engines as **offline teachers** for local data generation. Third-party engines remain outside the runtime engine and are never bundled or launched by it.

`tools/generate_teacher_data.py` makes that separation explicit. It reads ordinary PGN games,
samples non-terminal positions, asks a separately installed UCI engine for a score and principal
move, and emits JSONL. The teacher executable remains outside this repository and outside the zip.

Example after installing a UCI teacher locally:

```bash
uv run python tools/generate_teacher_data.py \
  --engine /path/to/stockfish \
  --pgn data/games.pgn \
  --out data/teacher-labels.jsonl \
  --depth 14 \
  --limit 100000
```

Each record contains the FEN, side to move, teacher centipawn/mate score, teacher best move, game
result, and reported teacher depth. A future small value/policy model can be trained entirely by
this team from those records, then compared against the hand-written evaluation in controlled A/B
matches before any weights are added to `engine-package.zip`.

Do not copy teacher source code into `agent.py`, vendor its binary, or launch the teacher at runtime.
The intended workflow is **teacher offline -> our dataset -> our trained model -> our agent**.
