# Customization studio

The Settings tab now includes a visibility-first customization studio. New
profiles use the filled **Sculpted** set with bright White pieces, dark Black
pieces, and opposing outlines. Older profiles that used the original Font set
keep that choice but now render filled symbols by default, fixing the hollow
white-piece visibility problem without discarding saved preferences.

## Piece controls

- Choose Sculpted, filled glyph, or letter-token pieces independently for White
  and Black, or choose one set for both from the visual gallery.
- Switch font pieces between high-contrast filled silhouettes and traditional
  white/black Unicode symbols.
- Set independent fill and outline colors for each side.
- Adjust outline thickness, shadow strength, opacity, vertical alignment, and
  piece width.
- Choose Matte, Flat, Gloss, or Glass finishes and optionally add a glow.
- Apply one-click Maximum clarity, Tournament, Flat modern, Study letters,
  Classic solid, or Glass token recipes.
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

## Interface controls

- Compact, Cozy, and Airy spacing modes.
- Independent interface text scale and panel corner radius.
- Optional translucent panels, plus a Reduce transparency override.
- Slim, Standard, and Wide accent-colored scrollbars.
- Optional square/piece hover motion that honors reduced-motion preferences.
- The existing notation height, database split width, stacked/preview layouts,
  smooth scrolling, scroll lock, and motion-speed controls remain integrated.

## Recipes and portability

- **Surprise me** combines a board palette, piece recipe, texture, and corner style.
- **Undo customization** retains the latest 20 customization states in the
  current app session.
- **Reset customization** restores the new visibility-first defaults.
- Save up to 12 named workstation looks.
- Export a focused customization JSON file or import one on another profile.
  Imports are limited to 64 KB, require the versioned FunChessEngine format,
  whitelist known settings, validate enums and colors, and clamp every number.
- Full workspace backups continue to include these settings.

These controls affect presentation only. They never modify a game, study,
opening book, reference database, or engine search setting.
