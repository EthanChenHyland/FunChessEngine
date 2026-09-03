# Follow-up audit and repairs — September 2, 2026

Restarted from the clean, committed `1ea09b0` checkout after saving unfinished edits outside the repository. Reviewed the preceding agent's changes in `d334f3d` and `1ea09b0`. The existing release gate passed, but targeted behavioral reproductions exposed the following gaps.

## Confirmed issues and fixes

| Finding | Repair and evidence |
| --- | --- |
| Valid study backups were rejected after ordinary double pawn moves such as `e2e4`. Validation compared the raw en passant square with a FEN that correctly omitted an unavailable capture. | Compare legal en passant rights. The regression test and Electron backup smoke now include `e2e4`. |
| Legacy study normalization silently removed secondary transposition links when edge metadata was missing. | Keep those links. The backend recovers an edge only when exactly one legal move reaches its saved child position, rejecting inconsistent graphs. Tests cover both `Nf3 Nf6 Nc3` and `Nc3 Nf6 Nf3`. Already-deleted links cannot be reconstructed without an earlier copy. |
| Plugin installation and backup restoration accepted syntactically plausible but illegal training solutions and opening sequences. | Use backend chess validation before installing/restoring plugins; also reject null training moves and unsupported commands. Standalone study imports and saved-study opening now receive backend graph validation. |
| External comparison advertised 50–5000 ms even though internal MultiPV used 100–2000 ms. | Apply the same 100–2000 ms range to both sides, report the effective budget, and display internal elapsed time. This makes time allocation explicit; it does not establish an Elo rating. |
| Worker timeouts started after a synchronous stdin write. A child that never read its input could block the request beyond its deadline. Cleanup could also mask the original failure or leak a worker slot. | Send bounded input through an owned writer thread while enforcing cancellation/deadlines; terminate before joining readers/writers and release worker slots in a final cleanup block. A child sleeping without reading a 1 MB payload now times out promptly. |
| Recovered tournaments and calibrations navigated to Analysis, leaving their actual results hidden in Play or Training. Recovery from Home also left the workspace hidden. | Enter the correct workspace, expand enclosing panels, and reveal the result. Saved tournament history uses the same visible standings view. Behavioral and Electron smoke tests cover recovery. |

Process cleanup additionally retains ownership until termination and bounds Windows `taskkill` duration. Large protocol lines no longer rescan their entire accumulated buffer after every chunk.

## Verification

`make release-gate` passed locally using Python 3.12.14:

- Ruff and strict mypy: 34 source files.
- 164 Python tests and 10 JavaScript behavior tests.
- Two random-opponent sanity games and standalone engine-package isolation.
- JavaScript/desktop syntax checks and `npm audit` (zero reported vulnerabilities).
- Electron smoke: launcher, play/review, preload persistence, reload, port migration, regression job, valid study backup, consumed-download cleanup, and recovered result navigation.

This follow-up does not change engine search. Windows/macOS CI coverage remains configured; these local results do not claim execution on Windows. Existing native installers were not rebuilt as part of this focused source repair.

## Further improvements

- Store desktop metadata per collection so frequent clock recovery writes do not rewrite the whole metadata file.
- Persist background-job summaries across backend restarts, with explicit interrupted status and resumable work where supported.
- Move tournament management and development tools into a dedicated workspace while preserving ordinary board navigation.
