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

## Local validation as of 2026-08-31

Fast harness matches:

- 6-0 vs `baselines/greedy`, all wins by checkmate.
- 4-0 vs `baselines/minimax`, all wins by checkmate.
- 6-0 vs `baselines/numba`, all wins by checkmate.
- LMR revision vs the frozen pre-LMR revision: +1 =11 -0 over 12 games.

The last match is much more informative than the baseline sweeps because both sides share the
same evaluation and nearly the same search. More games are required before treating the small
edge as a precise Elo estimate.

## Next strength work

1. Build a repeatable benchmark suite from many neutral midgame FENs rather than only the
   standard starting position.
2. Track completed depth, node count, and principal variation in local-only tooling so search
   changes can be compared by speed and playing strength.
3. Test selective search additions independently: check extensions, static-exchange pruning,
   aspiration windows, and carefully guarded null-move pruning.
4. Improve repetition handling by reconstructing game history between successive API calls.
5. Only after the classical engine is stable, experiment with a small model trained by this team
   (for evaluation or move ordering) and require it to beat the classical engine in A/B matches.

The engine package should remain simple and auditable. A feature is not worth shipping if
it gains benchmark strength at the cost of flagging, crashes, or opaque behavior.
