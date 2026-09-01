"use strict";

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

let mainWindow = null;
let backend = null;
let quitting = false;

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
    backend = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
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
    backend.stdout.on("data", inspect);
    backend.stderr.on("data", inspect);
    backend.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
    backend.once("exit", (code, signal) => {
      backend = null;
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Engine backend exited before startup (${code ?? signal ?? "unknown"}).\n${output.trim()}`));
      } else if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBox(mainWindow, {
          type: "error",
          title: "Engine backend stopped",
          message: "The local chess engine backend stopped unexpectedly.",
          detail: "Restart FunChessEngine to resume play.",
        });
      }
    });
  });
}

function stopBackend() {
  if (!backend) return;
  backend.kill("SIGTERM");
  backend = null;
}

function sendCommand(command) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("menu:command", command);
}

function installMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{
      label: app.name,
      submenu: [
        { role: "about" },
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
        { role: "togglefullscreen" },
      ],
    },
    ...(!app.isPackaged ? [{
      role: "help",
      submenu: [{ label: "Project Folder", click: () => shell.openPath(projectRoot()) }],
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
    return fs.readFileSync(result.filePaths[0], "utf8");
  });

  ipcMain.handle("file:open-pgn", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Open PGN Game",
      properties: ["openFile"],
      filters: [{ name: "Portable Game Notation", extensions: ["pgn"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return fs.readFileSync(result.filePaths[0], "utf8");
  });

  ipcMain.handle("file:open-png", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Open FunChessEngine Saved Game",
      properties: ["openFile"],
      filters: [{ name: "PNG saved game", extensions: ["png"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const bytes = fs.readFileSync(result.filePaths[0]);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  });

  ipcMain.handle("file:save-text", async (_event, payload) => {
    if (!payload || typeof payload.text !== "string") return false;
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
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Save FunChessEngine Game",
      defaultPath: payload.filename || "funchess-game.png",
      filters: [{ name: "PNG saved game", extensions: ["png"] }],
    });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, Buffer.from(payload.bytes));
    return true;
  });
}

async function createWindow() {
  const saved = loadWindowState();
  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
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
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });

  try {
    const url = await startBackend();
    await mainWindow.loadURL(url);
  } catch (error) {
    await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "FunChessEngine could not start",
      message: "The local engine backend could not be launched.",
      detail: String(error?.message || error),
    });
    app.quit();
  }
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
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
