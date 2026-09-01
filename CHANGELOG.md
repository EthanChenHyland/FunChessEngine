# Changelog

## 1.0.0

- Original FunChessEngine engine with iterative deepening, alpha-beta/PVS/LMR, transposition and evaluation caches, quiescence, aspiration windows, bounded check extensions, repetition awareness, tapered evaluation, and clock-aware search.
- Responsive local play UI with full clocks, two-player/engine modes, promotion, setup editor, PGN/FEN/portable PNG workflows, themes, keyboard board navigation, and accessibility semantics.
- Non-destructive review with evaluation graph, isolated post-game analysis, move grades/CPL, move explanations, evaluation components, Retry Move, and MultiPV.
- Persistent local studies with branching variations, comments/NAGs, arrows/highlights, opening recognition, personal opening statistics, Recent Games, recovery, and spaced-repetition mistake training.
- Integrated engine benchmark/A-B lab with paired opening positions, JSON output, benchmark history, and approximate score/Elo uncertainty reporting.
- Hardened loopback HTTP API, engine flag handling, Electron navigation/permission/file-I/O boundaries, backend crash restart/lifecycle cleanup, CI/release gates, and default engine packaging isolated to `agent.py`.

Engine changes are retained only when measured; the final pre-1.0 SEE and countermove experiments were rejected after benchmark/A-B testing rather than shipped without evidence.
