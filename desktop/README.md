# FunChessEngine Desktop

Electron wraps the local Engine Lab while keeping desktop code separate from the standalone engine module.

```bash
cd /Users/ethius/VSCode/FunChessEngine
cd desktop && npm ci
make desktop-dev
make desktop-build
```

Development regenerates the native app icon from `gui/static/app-mark.svg`, launches the Python GUI
backend from the project environment, and opens it inside a native window. A production build creates
a standalone backend executable with PyInstaller, cleans stale desktop artifacts, and packages Electron
as a native Apple Silicon macOS app/DMG.

The renderer has no Node.js access. Native file dialogs and menu commands are exposed through the narrow `preload.js` IPC bridge. FunChessEngine 1.0 includes PGN/FEN/portable-game dialogs, setup and promotion workflows, non-destructive review and persisted variation studies, isolated analysis/MultiPV, personal training, crash recovery, local opening/evaluation insights, drag/drop, a command palette, and native Analyze actions. The shell also constrains navigation/permissions, bounds native file I/O, owns the loopback backend lifecycle, and can restart that backend after a crash.
