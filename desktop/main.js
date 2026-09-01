"use strict";

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, screen, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

let mainWindow = null;
let backend = null;
let backendUrl = null;
let quitting = false;
const intentionalBackends = new WeakSet();

const MAX_FEN_BYTES = 64 * 1024;
const MAX_PGN_BYTES = 2 * 1024 * 1024;
const MAX_SAVE_BYTES = 50 * 1024 * 1024;

app.setName("FunChessEngine");

function projectRoot() {
  return path.resolve(__dirname, "..");
}

function settingsPath() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function loadWindowState() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    return {
      width: Math.max(900, Number(saved.width) || 1320),
      height: Math.max(680, Number(saved.height) || 900),
      x: Number.isFinite(saved.x) ? saved.x : undefined,
      y: Number.isFinite(saved.y) ? saved.y : undefined,
      maximized: Boolean(saved.maximized),
    };
  } catch (_) {
    return { width: 1320, height: 900, x: undefined, y: undefined, maximized: false };
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bounds = mainWindow.getNormalBounds();
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ ...bounds, maximized: mainWindow.isMaximized() }));
  } catch (_) {
    // Window persistence is optional.
  }
}

function visibleSavedPosition(saved) {
  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return {};
  const intersectsDisplay = screen.getAllDisplays().some(({ workArea }) => (
    saved.x < workArea.x + workArea.width
    && saved.x + saved.width > workArea.x
    && saved.y < workArea.y + workArea.height
    && saved.y + saved.height > workArea.y
  ));
  return intersectsDisplay ? { x: saved.x, y: saved.y } : {};
}

function devBackendCommand() {
  const root = projectRoot();
  const localPython = path.join(root, ".venv", "bin", "python");
  if (fs.existsSync(localPython)) {
    return { command: localPython, args: ["-m", "gui.server", "--no-open", "--port", "0"], cwd: root };
  }

  const uvCandidates = [
    process.env.UV,
    "/Users/ethius/AI-Workspace/runtimes/uv/bin/uv",
    "/opt/homebrew/bin/uv",
    "/usr/local/bin/uv",
  ].filter(Boolean);
  const uv = uvCandidates.find((candidate) => fs.existsSync(candidate));
  if (uv) {
    return { command: uv, args: ["run", "python", "-m", "gui.server", "--no-open", "--port", "0"], cwd: root };
  }
  return { command: "uv", args: ["run", "python", "-m", "gui.server", "--no-open", "--port", "0"], cwd: root };
}

function backendCommand() {
  if (!app.isPackaged) return devBackendCommand();
  const executable = path.join(process.resourcesPath, "bin", "funchess-backend");
  return { command: executable, args: ["--no-open", "--port", "0"], cwd: process.resourcesPath };
}

function startBackend() {
  return new Promise((resolve, reject) => {
    const spec = backendCommand();
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    backend = child;

    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        intentionalBackends.add(child);
        child.kill("SIGTERM");
        if (backend === child) backend = null;
        reject(new Error(`Engine backend did not become ready.\n${output.trim()}`));
      }
    }, 15000);

    const inspect = (chunk) => {
      const text = chunk.toString();
      output += text;
      const match = output.match(/FunChessEngine GUI:\s+(http:\/\/127\.0\.0\.1:\d+)/);
      if (!settled && match) {
        settled = true;
        clearTimeout(timeout);
        resolve(match[1]);
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        if (backend === child) backend = null;
        reject(error);
      }
    });
    child.once("exit", (code, signal) => {
      if (backend === child) backend = null;
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Engine backend exited before startup (${code ?? signal ?? "unknown"}).\n${output.trim()}`));
      } else if (!quitting && !intentionalBackends.has(child) && mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBox(mainWindow, {
          type: "error",
          title: "Engine backend stopped",
          message: "The local chess engine backend stopped unexpectedly.",
          detail: "You can restart the local backend without closing the application.",
          buttons: ["Restart Backend", "Quit"],
          defaultId: 0,
          cancelId: 1,
        }).then(async ({ response }) => {
          if (response === 0) {
            try {
              await restartBackend();
            } catch (error) {
              await showBackendFailure(error);
            }
          } else {
            app.quit();
          }
        });
      }
    });
  });
}

function stopBackend() {
  if (!backend) return;
  const child = backend;
  intentionalBackends.add(child);
  child.kill("SIGTERM");
  backend = null;
  backendUrl = null;
}

async function restartBackend() {
  stopBackend();
  const url = await startBackend();
  backendUrl = url;
  if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(url);
}

async function showBackendFailure(error) {
  await dialog.showMessageBox(mainWindow, {
    type: "error",
    title: "FunChessEngine could not start",
    message: "The local engine backend could not be launched.",
    detail: String(error?.message || error),
  });
}

function readBounded(filePath, maxBytes, encoding = null) {
  const size = fs.statSync(filePath).size;
  if (size > maxBytes) throw new Error(`File is too large (${Math.ceil(size / 1024 / 1024)} MB).`);
  return encoding ? fs.readFileSync(filePath, encoding) : fs.readFileSync(filePath);
}

function showAbout() {
  return dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "About FunChessEngine",
    message: `FunChessEngine ${app.getVersion()}`,
    detail: [
      "Original classical chess engine + local analysis and training workspace.",
      "All analysis stays on this computer; the standalone engine remains isolated from the desktop shell.",
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    ].join("\n\n"),
  });
}

function sendCommand(command) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("menu:command", command);
}

function installMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{
      label: app.name,
      submenu: [
        { label: `About ${app.name}`, click: () => showAbout() },
        { label: "Restart Engine Backend", click: () => restartBackend().catch(showBackendFailure) },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    }] : []),
    {
      label: "Game",
      submenu: [
        { label: "New Game", accelerator: "CmdOrCtrl+N", click: () => sendCommand("new-game") },
        { label: "Set Up Position…", accelerator: "CmdOrCtrl+Shift+P", click: () => sendCommand("setup-position") },
        { type: "separator" },
        { label: "Open FEN…", accelerator: "CmdOrCtrl+O", click: () => sendCommand("open-fen") },
        { label: "Open PGN…", accelerator: "CmdOrCtrl+Alt+O", click: () => sendCommand("open-pgn") },
        { label: "Open Saved Game PNG…", accelerator: "CmdOrCtrl+Shift+O", click: () => sendCommand("open-png") },
        { type: "separator" },
        { label: "Save Game PNG…", accelerator: "CmdOrCtrl+S", click: () => sendCommand("save-png") },
        { label: "Export PGN…", accelerator: "CmdOrCtrl+Alt+S", click: () => sendCommand("save-pgn") },
        { label: "Export FEN…", accelerator: "CmdOrCtrl+Shift+S", click: () => sendCommand("save-fen") },
        { type: "separator" },
        { label: "Pause / Resume", accelerator: "Space", click: () => sendCommand("pause") },
      ],
    },
    {
      label: "Play",
      submenu: [
        { label: "Undo Move", accelerator: "CmdOrCtrl+Z", click: () => sendCommand("undo") },
        { label: "Engine Move", accelerator: "CmdOrCtrl+E", click: () => sendCommand("engine-move") },
        { label: "Flip Board", accelerator: "CmdOrCtrl+F", click: () => sendCommand("flip") },
      ],
    },
    {
      label: "Analyze",
      submenu: [
        { label: "Analyze Game", accelerator: "CmdOrCtrl+Shift+A", click: () => sendCommand("analyze-game") },
        { label: "Candidate Lines", accelerator: "CmdOrCtrl+Alt+A", click: () => sendCommand("multipv") },
        { label: "Branch From Position", accelerator: "CmdOrCtrl+Alt+V", click: () => sendCommand("variation") },
        { type: "separator" },
        { label: "Mistake Trainer", accelerator: "CmdOrCtrl+Shift+T", click: () => sendCommand("trainer") },
      ],
    },
    {
      label: "View",
      submenu: [
        ...(!app.isPackaged ? [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
        ] : []),
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { label: "Command Palette…", accelerator: "CmdOrCtrl+K", click: () => sendCommand("command-palette") },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    ...(!app.isPackaged ? [{
      role: "help",
      submenu: [
        { label: "About FunChessEngine", click: () => showAbout() },
        { label: "Project Folder", click: () => shell.openPath(projectRoot()) },
      ],
    }] : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerFileHandlers() {
  ipcMain.handle("file:open-fen", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Open FEN Position",
      properties: ["openFile"],
      filters: [{ name: "FEN position", extensions: ["fen", "txt"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return readBounded(result.filePaths[0], MAX_FEN_BYTES, "utf8");
  });

  ipcMain.handle("file:open-pgn", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Open PGN Game",
      properties: ["openFile"],
      filters: [{ name: "Portable Game Notation", extensions: ["pgn"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return readBounded(result.filePaths[0], MAX_PGN_BYTES, "utf8");
  });

  ipcMain.handle("file:open-png", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Open FunChessEngine Saved Game",
      properties: ["openFile"],
      filters: [{ name: "PNG saved game", extensions: ["png"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const bytes = readBounded(result.filePaths[0], MAX_SAVE_BYTES);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  });

  ipcMain.handle("file:save-text", async (_event, payload) => {
    if (!payload || typeof payload.text !== "string") return false;
    if (Buffer.byteLength(payload.text, "utf8") > MAX_FEN_BYTES) throw new Error("FEN export is too large.");
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export FEN",
      defaultPath: payload.filename || "funchess-position.fen",
      filters: [{ name: "FEN position", extensions: ["fen"] }],
    });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, payload.text, "utf8");
    return true;
  });

  ipcMain.handle("file:save-pgn", async (_event, payload) => {
    if (!payload || typeof payload.text !== "string") return false;
    if (Buffer.byteLength(payload.text, "utf8") > MAX_PGN_BYTES) throw new Error("PGN export is too large.");
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export PGN Game",
      defaultPath: payload.filename || "funchess-game.pgn",
      filters: [{ name: "Portable Game Notation", extensions: ["pgn"] }],
    });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, payload.text, "utf8");
    return true;
  });

  ipcMain.handle("file:save-binary", async (_event, payload) => {
    if (!payload?.bytes) return false;
    const bytes = Buffer.from(payload.bytes);
    if (bytes.byteLength > MAX_SAVE_BYTES) throw new Error("Saved game is too large.");
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Save FunChessEngine Game",
      defaultPath: payload.filename || "funchess-game.png",
      filters: [{ name: "PNG saved game", extensions: ["png"] }],
    });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, bytes);
    return true;
  });
}

async function createWindow() {
  const saved = loadWindowState();
  const position = visibleSavedPosition(saved);
  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...position,
    minWidth: 900,
    minHeight: 680,
    show: false,
    backgroundColor: "#0d100e",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (saved.maximized) mainWindow.maximize();
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("close", saveWindowState);
  mainWindow.on("closed", () => {
    mainWindow = null;
    // On macOS closing the last window does not quit the app. Stop its local
    // backend here so Activate can create one fresh backend/window instead of
    // orphaning the old child and accumulating loopback servers.
    if (!quitting) stopBackend();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!backendUrl) return event.preventDefault();
    try {
      if (new URL(targetUrl).origin !== new URL(backendUrl).origin) event.preventDefault();
    } catch (_) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  try {
    const url = await startBackend();
    backendUrl = url;
    await mainWindow.loadURL(url);
  } catch (error) {
    await showBackendFailure(error);
    app.quit();
  }
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", async () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      await createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    if (process.platform === "darwin" && !app.isPackaged) {
      const dockIcon = nativeImage.createFromPath(path.join(__dirname, "assets", "icon.png"));
      if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
    }
    registerFileHandlers();
    installMenu();
    await createWindow();
    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) await createWindow();
    });
  });
}

app.on("before-quit", () => {
  quitting = true;
  saveWindowState();
  stopBackend();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
