# Final 20 workstation additions

Open **Database** from the top bar. These additions use the local reference database and its
independent preview; browsing, opening examples, and exporting diagrams do not replace the live game.

| # | Feature | Where to use it |
| --- | --- | --- |
| 1 | Jump directly to a results page | Enter a number in **Go to page** and click Go or press Enter; oversized numbers go to the last page |
| 2 | First/last results-page navigation | **First** and **Last** beside the paging controls |
| 3 | Select all filtered matches | **Selected games → Select all matches**, across pages, up to 500 games |
| 4 | Invert the current page's selection | **Selected games → Invert page selection**; selections on other pages remain intact |
| 5 | Remove individual active filters | Click a filter chip's × above the opening tree |
| 6 | Rename a saved search | Select the saved search, enter the new name, and click **Rename selected search** |
| 7 | Match exact player names | **Advanced filters → Exact player names**, applied to either-color, White, and Black player searches |
| 8 | Find incomplete game metadata | **Advanced filters → Missing metadata**: ECO, ratings, dates, or player names |
| 9 | Previous/next reference-game preview | **Previous game / Next game** above the preview, within the current results page |
| 10 | Preview material balance and inventory | Below the move slider; hover the balance for each side's piece counts |
| 11 | Jump between annotations | **Find moves and annotations → Previous/Next annotation**; includes comments, NAGs, and variation points |
| 12 | Search game notation and comments | **Find moves and annotations**: type SAN or comment text, then Next match or Enter; matches are highlighted |
| 13 | Sort opening continuations | **Opening tree → Sort, filter, and export continuations**: frequency, score, average Elo, latest year, or move name |
| 14 | Hide rare opening continuations | Set **Minimum games** in the opening-tree options |
| 15 | Change the score perspective | Choose White, Black, or the side to move in **Score for** |
| 16 | Jump back along an opening line | Click any earlier move in the opening-tree breadcrumb path |
| 17 | Export opening statistics as CSV | **Export table CSV** includes the displayed rows, ordering, score perspective, and result counts |
| 18 | Export the explored preparation line as PGN | **Export preparation PGN** retains its starting position, Standard/Chess960 variant, legal moves, and sample-statistics comments |
| 19 | Open a reference example for a continuation | **Preview example** beside an opening-tree move opens a matching game at that move |
| 20 | Export a standalone vector board diagram | **Board SVG** in the preview exports the selected position and orientation with coordinates and game labels |

Selection operations retain the 500-game bound and reject oversized selections without partially
changing the selection. Saved-search renaming preserves its filters and rejects name collisions.

Annotation and notation searches wrap around the game. Material balance uses pawn=1, knight/bishop=3,
rook=5, and queen=9; it is a piece-count aid rather than an engine evaluation. Unknown opening scores
and ratings sort last. Minimum-game filtering does not change the underlying frequency denominator.

Preparation exports support up to 255 moves and validate each move before producing the PGN.
The diagram uses a classic green palette and Unicode chess glyphs in a standalone SVG. Exported
CSV cells are quoted and protected against formula interpretation.

The release checks cover query semantics, selection bounds and stale responses, renaming collisions,
legal Standard/Chess960 PGN round trips, annotation navigation, score ordering, and SVG escaping.
Electron exercises page jumps, selection across pages, renaming, chips, notation, opening controls,
example previews, and exports, with desktop and narrow-screen layout checks.
