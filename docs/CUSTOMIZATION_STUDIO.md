# Customization studio

The Settings tab now includes a visibility-first customization studio. New
profiles use the filled **Sculpted** set with bright White pieces, dark Black
pieces, and opposing outlines. Older profiles that used the original Font set
keep that choice but now render filled symbols by default, fixing the hollow
white-piece visibility problem without discarding saved preferences.

## Piece controls

- Choose Sculpted, Neo, Staunton, Minimal, filled glyph, or letter-token pieces independently for White
  and Black, or choose one set for both from the visual gallery.
- Switch font pieces between high-contrast filled silhouettes and traditional
  white/black Unicode symbols.
- Set independent fill and outline colors for each side.
- Adjust outline thickness, shadow strength, opacity, vertical alignment, and
  piece width.
- Scale White and Black independently, choose a solid or engraved outline, set
  the shadow color, or let the app choose contrasting outlines automatically.
- Choose Matte, Flat, Gloss, or Glass finishes and optionally add a glow.
- Apply one-click Maximum clarity, Tournament, Flat modern, Study letters,
  Classic solid, Glass token, Staunton club, or Minimal analysis recipes.
- The live contrast dashboard scores all four piece/square combinations. It
  accounts for the outline as well as the fill and flags weak combinations.

## Board controls

- Twelve ready-made palettes: Classic, Tournament, Midnight, Ocean glass,
  Rosewood, Amethyst, High contrast, Monochrome, Sandstone, Candy, Blueprint,
  and Coffee.
- Fully custom light and dark squares remain available.
- Six surfaces: Plain, Wood grain, Linen, Marble, Carbon, and Dot grid.
- Customize frame thickness and color, corner radius, shadow strength,
  brightness, and saturation.
- Give last moves, selected squares, legal targets, and checked kings their own
  colors.
- Show legal moves as dots, rings, or square fills.
- Adjust coordinate size and force light or dark labels when automatic contrast
  is not desired.
- Optionally glow the board frame for the side to move.
- Control texture scale, frame style, highlight opacity, legal-target size, and
  last-move treatment. Coordinates can appear on the edges or every square.

## Interface controls

- Compact, Cozy, and Airy spacing modes.
- Independent interface text scale and panel corner radius.
- Optional translucent panels, plus a Reduce transparency override.
- Slim, Standard, and Wide accent-colored scrollbars.
- Optional square/piece hover motion that honors reduced-motion preferences.
- Set a custom app accent, background, panel, text, muted-text, and keyboard
  focus color. Choose plain, grid, aurora, or vignette backgrounds.
- Choose square, rounded, or pill buttons and Smooth, Snappy, Spring, or Linear
  animation timing.
- The existing notation height, database split width, stacked/preview layouts,
  smooth scrolling, scroll lock, and motion-speed controls remain integrated.

## Recipes and portability

- **Surprise me** combines a board palette, piece recipe, texture, and corner style.
- **Undo customization** retains the latest 20 customization states in the
  current app session.
- **Reset customization** restores the new visibility-first defaults.
- Save up to 12 named workstation looks. Each look now includes the app theme,
  accent, light/dark appearance, legacy font theme, piece size, and sidebar width.
- Export a focused customization JSON file or import one on another profile.
  Imports are limited to 64 KB, require the versioned FunChessEngine format,
  whitelist known settings, validate enums and colors, and clamp every number.
- Full workspace backups continue to include these settings.

These controls affect presentation only. They never modify a game, study,
opening book, reference database, or engine search setting.


## Board workspace presentation

- Resize the board from 420–900 px and align it left, center, or right.
- Add a subtle board tilt while keeping move input and annotations aligned.
- Show or hide captured pieces, player roles, material-advantage chips, and move numbers.
- Switch player rows between plain labels and bordered player cards.
- Choose Boxed, Minimal, or Digital clocks; scale them from 80–140%.
- Customize active-clock and low-time colors and choose a 5–60 second warning threshold.
- Enable or disable an accessible reduced-motion-aware low-time pulse.
- Hide clock tenths for a calmer display while retaining exact internal clock time.

## Finding and applying settings

- Search the studio by control name; matching sections open automatically and
  nonmatching controls disappear. Press `/` while the Settings tab is active to focus search.
- Expand or collapse all matching settings sections at once.
- Auto-fix piece contrast selects opposing outline colors, strengthens the
  outline, and restores full opacity without changing the board palette.
- Cycle through board and piece recipes with Previous/Next buttons.
- Undo is disabled until a customization change exists, then tracks the last
  20 changes in the current session.
- The board toolbar includes a **Customize board** shortcut that opens and
  focuses the searchable studio.
