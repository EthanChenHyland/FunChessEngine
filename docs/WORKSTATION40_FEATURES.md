# 40 workstation additions and improvements

The later [customization studio expansion](CUSTOMIZATION_STUDIO.md) adds contrast scoring,
independent side styling, palettes, surfaces, and interface controls.

Open **Settings → Workstation appearance & navigation** for the new visual and
scrolling options. The game browser has new **Preview tools** and opening-tree
**Tree display & preparation** sections. Everything runs locally.

These are 40 individual tools, settings, and usability improvements—not 40 new
subsystems. Existing blindfold modes, font themes, database reports, and the
previous 20-feature batch are not counted again.

## Pieces, boards, and motion

1. **Sculpted SVG pieces:** six original vector silhouettes for both colors,
   shared by the live board, reference preview, tree board, and promotion picker.
2. **Lettered pieces:** labeled K/Q/R/B/N/P tokens for learning and easy recognition.
3. **Interactive piece gallery:** compare Font, Sculpted, and Letters before
   selecting a set; the selected card stays highlighted.
4. **White-piece color:** choose a custom color across all three boards.
5. **Black-piece color:** independently customize the opposing pieces.
6. **Vector outline control:** adjust the stroke around sculpted and lettered pieces.
7. **Custom square palette:** choose light and dark square colors, with a toggle
   to return to the existing board theme.
8. **Board textures:** plain, wood-grain, and linen options.
9. **Board frames:** adjustable frame thickness, including a borderless setting.
10. **Motion preference:** follow the operating system, force reduced motion,
    or explicitly enable full motion. System changes take effect immediately.
11. **Animated piece movement:** slide identifiable pieces between squares with
    an adjustable 80–500 ms duration. Ambiguous jumps and orientation changes
    do not invent a move animation; reduced motion disables slides.
12. **Tab entry transitions:** optional subtle fade and slide when changing tabs.

## Scrolling and layout

13. **Smart move following:** move lists follow a newly selected position while
    preserving manual scrolling during unrelated redraws.
14. **Notation scroll lock:** keep the reading position fixed even as moves change.
15. **Smooth-scroll option:** control animated notation and back-to-top scrolling;
    reduced motion always makes these immediate.
16. **Show current move:** explicit recenter buttons in the live notation and preview.
17. **Wheel preview navigation:** opt in to stepping moves over the preview board;
    horizontal scrolling and zoom gestures remain available.
18. **Notation height:** set a bounded 120–480 px reading area for both move lists.
19. **Preview width:** adjust the desktop database preview from 280–520 px.
20. **Database arrangement:** side-by-side, stacked, or preview-focused layouts,
    with a Show game list button to leave preview focus.
21. **Sticky table tools:** keep database count and display controls available
    while scrolling; this can be disabled.
22. **Back-to-top controls:** return to the top of each workspace or database pane,
    including the shared scrolling container in narrow and stacked layouts.

## Reference games and opening preparation

23. **Collection suggestions:** existing folder and single-tag names appear as
    suggestions in organization and search fields.
24. **Single-game PGN download:** export the previewed game without changing the
    selection; saved annotations and variations remain in the PGN.
25. **Played SAN line copying:** copy only the moves through the current preview
    ply, with correct numbering for custom Black-to-move starting positions.
26. **Independent tree-board flip:** change tree orientation without flipping the
    live or reference-preview boards.
27. **Tree-board visibility:** hide the diagram when concentrating on statistics.
28. **Explored SAN line copying:** copy the current opening-tree path as notation.
29. **Tree SAN filter:** narrow displayed continuations by move text and see the
    matching count. This display filter does not change database search filters
    or the existing tree CSV export.
30. **Both-color score display:** show White and Black percentages together;
    positions without a finished-game score show that explicitly.
31. **Note counters:** live word and character counts, plus the text-field storage
    limit (Unicode characters and storage units can differ).
32. **Unsaved-editor badges:** separate notes and header indicators, updated after
    edits and saves without discarding newer drafts.

## Study conveniences and saved preferences

33. **Hide future notation:** reveal the reference line incrementally with the
    existing next-move controls; toggling it off restores the whole move list.
34. **Preview auto-orientation:** optionally place the side to move at the bottom.
35. **Direct ply jump:** enter a valid ply number, with range validation and Enter support.
36. **Random matching game:** sample across the current search, including pages
    not currently displayed; obsolete responses cannot replace a newer preview.
37. **Player quick searches:** find games involving either previewed player using
    the exact player name across both colors.
38. **Page citation export:** download readable player/result/event/date/reference
    summaries for the current result page.
39. **Study from the opening tree:** start an independent study at the explored
    position, preserving the live game and checking unsaved edits.
40. **Named workstation looks:** save, apply, replace, and delete up to twelve presets
    for the new piece, board, motion, navigation, and layout settings. Application
    theme, accent, appearance, font theme, piece size, and sidebar width are
    included with each saved look. Presets persist with
    the profile's display preferences and backups.

## GUI repairs included

- Move lists no longer snap to the bottom or recenter on every redraw.
- Scrollbars reserve space and nested scroll areas contain scrolling.
- Preview and tree pieces share the selected font, scale, vector set, and colors.
- Animated pieces can travel beyond their destination square without clipping.
- Board frames preserve the live-board annotation overlay's alignment.
- New controls use labels, keyboard-operable buttons, bounded inputs, and
  collapsible sections. Database layouts continue to fit narrow windows.
- Study creation rechecks drafts typed during position loading, and ignores
  position responses after the preview has changed or closed.

## Validation

Local validation passed with **204 Python tests and 72 JavaScript tests**.
The release gate covers lint/type checks,
engine package isolation, a short engine arena, desktop syntax checks, dependency
audit, and the Electron smoke suite. Workstation smoke coverage exercises actual
DOM controls, export contents, long-notation scrolling, motion, saved settings,
random/player searches, and study isolation. Desktop and narrow-window screenshots
are also inspected. No search or engine-strength changes are part of this batch.
