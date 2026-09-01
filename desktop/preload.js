"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("engineLabDesktop", {
  platform: process.platform,
  openFen: () => ipcRenderer.invoke("file:open-fen"),
  openPgn: () => ipcRenderer.invoke("file:open-pgn"),
  openPng: () => ipcRenderer.invoke("file:open-png"),
  saveText: (filename, text) => ipcRenderer.invoke("file:save-text", { filename, text }),
  savePgn: (filename, text) => ipcRenderer.invoke("file:save-pgn", { filename, text }),
  saveBinary: (filename, bytes) => ipcRenderer.invoke("file:save-binary", { filename, bytes }),
  restartBackend: (snapshot) => ipcRenderer.invoke("backend:restart", snapshot),
  onCommand: (listener) => {
    const handler = (_event, command) => listener(command);
    ipcRenderer.on("menu:command", handler);
    return () => ipcRenderer.removeListener("menu:command", handler);
  },
});
