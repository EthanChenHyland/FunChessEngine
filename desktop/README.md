# FunChessEngine Desktop

Electron wraps the local Engine Lab while keeping desktop code separate from the standalone engine module.

```bash
git clone https://github.com/EthanChenHyland/FunChessEngine.git
cd FunChessEngine
cd desktop && npm ci
cd ..
make desktop-dev
make desktop-build
```

The desktop project also exposes reproducible platform packaging commands:

```bash
cd desktop
npm run build:mac      # Apple Silicon macOS DMG + ZIP
npm run build:linux    # Linux x64 AppImage + ZIP
npm run build:win      # Windows x64 NSIS installer + ZIP
```

Linux and Windows packages are built automatically as downloadable GitHub Actions artifacts on version
tags and manual workflow runs. macOS release builds remain available through `make desktop-build`, which
also performs the native arm64 packaged-backend smoke test and optional Apple signing/notarization.

Development regenerates the native app icon from `gui/static/app-mark.svg`, launches the Python GUI
backend from the project environment, and opens it inside a native window. A production build creates
a standalone backend executable with PyInstaller, cleans stale desktop artifacts, and packages Electron
as a native Apple Silicon macOS app/DMG.

The renderer has no Node.js access. Native file dialogs and menu commands are exposed through the narrow `preload.js` IPC bridge. FunChessEngine 1.0 includes PGN/FEN/portable-game dialogs, setup and promotion workflows, non-destructive review and persisted variation studies, isolated analysis/MultiPV, personal training, crash recovery, local opening/evaluation insights, drag/drop, a command palette, and native Analyze actions. The shell also constrains navigation/permissions, bounds native file I/O, owns the loopback backend lifecycle, and can restart that backend after a crash.
