# FunChessEngine Engine

This project currently uses a fully original, classical CPU chess engine in `agent.py`.
The engine package does not ship Stockfish, Lc0, Maia, native binaries, or third-party engine code.

## Current architecture

- Iterative-deepening negamax with alpha-beta pruning.
- Principal-variation search and conservative late-move reductions.
- Persistent transposition table across moves in the same game.
- Quiescence search for captures, promotions, and check evasions.
- MVV-LVA capture ordering plus hash, killer, and history heuristics.
- Tapered middlegame/endgame evaluation.
- Evaluation terms for material, piece-square placement, pawn structure, passed pawns,
  bishop pair, rook files, mobility, and king safety.
- Clock-aware move budgeting with a hard internal deadline and legal fallback move.
- Bounded game-long state to stay well inside the 2 GB memory limit.
- Game-long position tracking that treats an observed immediate threefold as a draw in root search.

## Local validation as of 2026-08-31

Fast harness matches:

- 6-0 vs `baselines/greedy`, all wins by checkmate.
- 4-0 vs `baselines/minimax`, all wins by checkmate.
- 6-0 vs `baselines/numba`, all wins by checkmate.
- LMR revision vs the frozen pre-LMR revision: +1 =11 -0 over 12 games.
- Repetition-aware revision: regression-tested to choose a seeded threefold from a losing position.
- Conservative null-move pruning experiment: rejected after +0 =12 -0 and no benchmark depth gain.

The last match is much more informative than the baseline sweeps because both sides share the
same evaluation and nearly the same search. More games are required before treating the small
edge as a precise Elo estimate.

## Next strength work

1. Expand the repeatable varied-position benchmark beyond the current 12-position smoke suite.
2. Add principal-variation reporting in local-only tooling alongside depth/node metrics.
3. Test selective search additions independently: static-exchange pruning, aspiration windows,
   and check extensions. Revisit null-move only once routine completed depth is high enough.
4. Expand game-history logic from observed-position counts to full inferred ply reconstruction.
5. Only after the classical engine is stable, experiment with a small model trained by this team
   (for evaluation or move ordering) and require it to beat the classical engine in A/B matches.

The engine package should remain simple and auditable. A feature is not worth shipping if
it gains benchmark strength at the cost of flagging, crashes, or opaque behavior.
