# FunChessEngine Engine

This project currently uses a fully original, classical CPU chess engine in `agent.py`.
The engine package does not ship Stockfish, Lc0, Maia, native binaries, or third-party engine code.

## Current architecture

- Iterative-deepening negamax with alpha-beta pruning.
- Narrow aspiration windows after the first completed iteration, with a full-window
  verification search on fail-low/fail-high.
- Principal-variation search and conservative late-move reductions.
- One bounded check extension per branch for forcing lines.
- Persistent transposition table across moves in the same game.
- Quiescence search for captures, promotions, and check evasions, with conservative
  delta and exchange-aware pruning for obviously losing defended captures.
- MVV-LVA capture ordering plus hash, killer, and history heuristics.
- Tapered middlegame/endgame evaluation.
- Evaluation terms for material, piece-square placement, pawn structure, passed pawns,
  bishop pair, rook files, mobility, and king safety.
- Clock-aware move budgeting with a hard internal deadline and legal fallback move.
- Bounded game-long state to stay well inside the 2 GB memory limit.
- Game-long position tracking that treats an observed immediate threefold as a draw in root search.
- Local-only `LAST_SEARCH_INFO` telemetry exposing completed depth, score, nodes,
  elapsed time, aspiration re-search count, and a legal TT-derived PV.

## Local validation as of 2026-08-31

Fast harness matches:

- 6-0 vs `baselines/greedy`, all wins by checkmate.
- 4-0 vs `baselines/minimax`, all wins by checkmate.
- 6-0 vs `baselines/numba`, all wins by checkmate.
- LMR revision vs the frozen pre-LMR revision: +1 =11 -0 over 12 games.
- Repetition-aware revision: regression-tested to choose a seeded threefold from a losing position.
- Conservative null-move pruning experiment: rejected after +0 =12 -0 and no benchmark depth gain.
- 2026-08-31 selective-search revision vs frozen pre-change `agent.py`: +5 =3 -0
  over 8 alternating-color smoke games at 3.0 s + 0.05 s, with all games ending
  by checkmate or threefold and no engine failures.
- On the 12-position benchmark at the same 10,000 ms reported clock, the frozen
  pre-change engine completed mean depth 2.50 in 3,593 ms aggregate; this revision
  completed mean depth 2.67 in 3,606 ms aggregate. This is a small local sample,
  so it is evidence for keeping the change rather than an Elo claim.
- A second independent comparison by the integrated branch at 4.0 s + 0.1 s scored +7 =1 -0
  against commit `0fcea4f`, again with no crashes, flags, or illegal moves. On the shorter
  12-position benchmark it completed mean depth 2.50 vs 2.00 and about 25.97k vs 20.45k
  aggregate NPS. These are development measurements, not a claimed tournament Elo.

The last match is much more informative than the baseline sweeps because both sides share the
same evaluation and nearly the same search. More games are required before treating the small
edge as a precise Elo estimate.

## Next strength work

1. Expand the repeatable varied-position benchmark beyond the current 12-position smoke suite.
2. Expand the GUI/benchmark telemetry into per-iteration depth/score graphs without changing the
   engine API.
3. Continue testing selective search additions independently. A fuller static-exchange
   evaluator may outperform the intentionally conservative current capture filter; revisit
   null-move only once routine completed depth is high enough.
4. Expand game-history logic from observed-position counts to full inferred ply reconstruction.
5. Only after the classical engine is stable, experiment with a small model trained by this team
   (for evaluation or move ordering) and require it to beat the classical engine in A/B matches.

The offline teacher-data workflow is documented in `docs/TRAINING.md`. Existing engines may be
used to label training positions offline, but no third-party engine source/binary is shipped or
invoked by `agent.py`.

The engine package should remain simple and auditable. A feature is not worth shipping if
it gains benchmark strength at the cost of flagging, crashes, or opaque behavior.
