# FunChessEngine Desktop

Electron wraps the local Engine Lab while keeping desktop code separate from the standalone engine module.

```bash
cd /Users/ethius/VSCode/FunChessEngine
cd desktop && npm install
make desktop-dev
make desktop-build
```

Development regenerates the native app icon from `gui/static/app-mark.svg`, launches the Python GUI
backend from the project environment, and opens it inside a native window. A production build creates
a standalone backend executable with PyInstaller, cleans stale desktop artifacts, and packages Electron
as a native Apple Silicon macOS app/DMG.

The renderer has no Node.js access. Native file dialogs and menu commands are exposed through the narrow `preload.js` IPC bridge. Version 0.4 adds native PGN open/export dialogs plus the non-destructive review/evaluation-graph workflow on top of the 0.3 board setup and promotion work. Version 0.4.1 adds an isolated post-game analysis worker, move quality/CPL summaries, and non-destructive Retry Move training. Version 0.4.2 adds clean-exit-aware crash recovery and a small persistent Recent Games library.
