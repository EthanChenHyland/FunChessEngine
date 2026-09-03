# Database browser

Open **Database** in the top bar, **Open database browser** in Library, or the command palette.
Import reference PGNs from Library first, or use the browser's **Import PGN…** button. Your live
game is paused while browsing. The separate preview never replaces its board or move history;
closing the browser leaves the live game paused until you resume it.

The [40 workstation additions](WORKSTATION40_FEATURES.md) add piece sets, motion,
scrolling controls, layouts, and preparation tools.

The [final 20 additions](FINAL20_FEATURES.md) extend paging, selection, filters, previews, opening
preparation, and exports.

## Feature inventory

| # | Addition | Where to use it |
| --- | --- | --- |
| 1 | Spacious database workspace | Top-bar Database button; desktop uses side-by-side results and preview |
| 2 | Game table with ratings, dates, event, opening code, and length | Search results |
| 3 | Pagination with 25, 50, or 100 rows | Above and below the table |
| 4 | Ascending/descending column sorting | Click a column heading |
| 5 | Color-specific player filters | Advanced filters: White and Black |
| 6 | Event, site, opening, and import-source filters | Advanced filters |
| 7 | ECO-prefix and result filters | Advanced filters |
| 8 | Both-player rating bounds, year bounds, and game-length bounds | Advanced filters; lengths count plies |
| 9 | Search PGN annotations and private notes | Advanced filters; PGN text search also matches headers and notation |
| 10 | Search the current board position | Advanced filters; uncapturable en passant squares are normalized |
| 11 | Named saved searches | Save search, then choose it from the list; up to 25 |
| 12 | Favorites for reference games | Star column and Favorites filter |
| 13 | Collection folders | Selected games → Move selected |
| 14 | Custom game tags | Selected games → Apply tags; add, remove, or replace; Tag filter |
| 15 | Private notes attached to a reference game | Preview → Game notes |
| 16 | Selection across pages | Checkboxes; up to 500 selected games |
| 17 | Bulk favorite, folder, and tag changes | Selected games; updates are transactional |
| 18 | Selected-game PGN export | Selected games → Export selected PGN |
| 19 | Spreadsheet-friendly page CSV export | Selected games → Export page CSV; formula-like cells are escaped |
| 20 | Independent board preview | Click the White player's name, or double-click a row |
| 21 | Clickable annotated move list | Below the preview board |
| 22 | Move slider and first/previous/next/last controls | Preview navigation |
| 23 | Keyboard preview navigation | Left/Right and Home/End when outside text fields |
| 24 | Autoplay with slow, normal, and fast speeds | Preview Play and Speed controls |
| 25 | Preview orientation and coordinate controls | Flip preview and Coordinates |
| 26 | Last-move highlights and check/side-to-move status | Preview board and position line |
| 27 | PGN comments, NAGs, and recorded clocks | Preview comment and position areas |
| 28 | Copy the preview FEN or original PGN | Preview export actions |
| 29 | Printable HTML scoresheet export | Scoresheet HTML; open the downloaded file in a browser and print |
| 30 | PGN header editor with stale-edit protection | Preview → Edit PGN headers |
| 31 | Same-main-line duplicate finder | Advanced filters → Same main line |
| 32 | Compare two games and jump to their divergence | Select two games → Compare two games |
| 33 | Player dossier with results by color and peak recorded rating | Database insights; enter an exact player name |
| 34 | Head-to-head report | Add an exact opponent name to the dossier |
| 35 | Opening distribution with score and drill-down filters | Database insights → Build report |
| 36 | Games-by-year histogram and JSON report export | Database insights |
| 37 | Create a study directly from the preview position | Study this position |
| 38 | Comfortable/compact table density and active-filter count | Table toolbar and Advanced filters |

The existing **Open in Analysis** workflow is also available from a preview. It uses the normal
confirmation flow before replacing a game. Creating a study preserves the current live game.

## Collection navigation and undo

Expand **Collections** to browse all games, favorites, unfiled games, individual folders, or tags
with live game counts. Folder shortcuts match the exact folder; for example, `Models` does not
include `Models/endgames`. Advanced filters can switch between exact-folder and substring search.
The navigator shows up to 100 folders and the 100 most frequent tags.

**Selected games → Apply tags** adds tags by default. Choose Remove tags or Replace all tags when
needed. Adding tags preserves existing tags and ignores duplicate spellings regardless of case.
Each game supports 20 tags of up to 40 characters. A batch that would exceed this limit changes
nothing.

**Undo organization edits** retains the last ten changes to favorites, folders, tags, and private
notes, including across restarts and reference-data ZIP backups. An undo restores only fields
changed by that edit, preserving independent edits to other fields. If those same fields changed
again, undo the newer edit first. Edits must fit a 4 MB undo record; no-op updates do not consume
history. Header changes are protected by revision checks but are not part of organization undo.

**Games from here** searches the library for the position currently displayed in the preview,
including transpositions, without changing the live board. Matching-position searches retain their
chosen position until you reset or change the filter.

## Opening tree

Expand **Opening tree** to explore moves in the filtered collection. Start from the normal initial
position or choose **From preview**, which retains that game's Standard/Chess960 rules. The tree
has its own small board and never moves the preview or live board.

- Click a move to explore its continuations; **Back** returns to the previous position.
- **Save to book** adds a Standard-chess continuation to the current engine profile’s local
  editable book with weight 10. Existing moves retain their weight, learned score, and source.
  In Library → Editable opening book, change a weight with **Save weight**, or use
  **Refresh current position** after moving the board. Zero is a valid weight; edits preserve
  learning and source and reject stale weights. The editor also shows entries after move 20.
- Each row shows game count, frequency, White score, a White/draw/Black/unfinished result bar,
  average Elo, and the most recent recorded year.
- **Show matching games** searches the current tree position with the same collection filters.
  **Copy tree FEN** copies that position.
- The tree supplies its own position and variant, while player, folder, tag, rating, and other
  search filters apply. **Refresh with filters** captures changes to those filters.
- Counts use each game's first occurrence of the position. Branch counts plus games ending at
  the position sum to the total. White score excludes unfinished games; average Elo excludes
  games missing either rating. Transpositions are included, so counts describe positions rather
  than only games following the exact path you clicked. Navigation retains up to 256 positions.

Advanced search now includes a **Variant** selector. Position searches created from the preview
or opening tree retain that variant. Comparison also distinguishes Standard and Chess960 while
ignoring half-move/full-move counters when determining whether starting positions match.

## Data behavior

- Organization and saved searches live in `library.sqlite3`, alongside the reference games. Workspace
  ZIP backups include them when reference data is included. Old databases and old backups migrate
  automatically without changing the existing game/position tables.
- Notes and headers have separate Save buttons. Switching previews or closing the browser warns about
  unsaved edits. Saving headers preserves unsaved note text. Notes and header saves preserve text typed while a
  request is pending and cannot overwrite a different preview. Notes reject stale stored values.
  Header editing preserves PGN comments,
  NAGs, and variations; unsupported embedded quotes/backslashes and multiline fields are rejected.
- Private notes, folders, and tags stay in the database. They are not injected into standard PGN exports.
- Duplicate detection groups the same initial FEN and main-line moves. Two matches may have different
  headers, comments, or variations. Nothing is deleted automatically.
- Preview shows the main line; side variations remain in exported PGN and are counted at branch points.
- Player dossiers match exact names (case insensitive). Text search fields match literal substrings.
  Ratings must be known for both players when rating bounds are active. Scores exclude unfinished games.
- PGN batch export is limited to 500 games and 16 MB per export. CSV exports the currently displayed page.
- The browser follows the existing local-only access boundary; LAN guests cannot read or edit the database.

## Bug repairs included

- Opening explorer statistics count each game once per continuation, even when a position repeats.
- A zero-ply search no longer generates a query referencing an unjoined positions table.
- Study positions and variation moves can explicitly retain Standard/Chess960 rules independently of the live game.
- Removing plugin training cards keeps the active trainer index aligned with its displayed board; if the active card is removed, training exits without resuming the live clock.
- Database searches reject stale responses, header edits reject stale revisions, and failed bulk organization updates roll back together.

## Verification

The release gate exercises Python correctness tests, strict mypy, Ruff, JavaScript behavior checks,
the standalone engine package, and Electron workflows. Database tests cover legacy migration, SQL
filtering, pagination, annotations and clocks, transactional edits, reports, exports, and ZIP restore.
Electron exercises a 34-game collection, independent preview, header/notes preservation, organization,
comparison, saved searches, player reports, study creation, additive/removal tag operations,
collection counts, position searches, persistent undo, and opening-tree navigation. Optional screenshots inspect desktop
and narrow-screen layouts. Engine search is unchanged.

Local validation passed with **204 Python tests and 52 JavaScript tests**, plus the Electron
workflow and layout checks. A single synthetic 10,000-game benchmark (12 plies per game) imported
130,000 positions in 12.13 seconds. Measured database calls took 3.44 ms for browser search,
5.95 ms for duplicate search, and 5.98 ms for reports. These are local timings on repeated opening
lines with distinct headers, not guarantees for a large, varied corpus.

The opening-tree follow-up measured 33.7 ms for the initial-position query on a synthetic
10,000-game / 130,000-position library. This is one local measurement on repeated openings.
