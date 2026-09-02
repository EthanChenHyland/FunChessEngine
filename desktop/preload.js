"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("engineLabDesktop", {
  platform: process.platform,
  openFen: () => ipcRenderer.invoke("file:open-fen"),
  openPgn: () => ipcRenderer.invoke("file:open-pgn"),
  openPng: () => ipcRenderer.invoke("file:open-png"),
  openBundle: () => ipcRenderer.invoke("file:open-bundle"),
  saveText: (filename, text) => ipcRenderer.invoke("file:save-text", { filename, text }),
  savePgn: (filename, text) => ipcRenderer.invoke("file:save-pgn", { filename, text }),
  saveBinary: (filename, bytes) => ipcRenderer.invoke("file:save-binary", { filename, bytes }),
  saveBundle: (filename, text) => ipcRenderer.invoke("file:save-bundle", { filename, text }),
  restartBackend: (snapshot) => ipcRenderer.invoke("backend:restart", snapshot),
  onOpenDocument: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("file:opened-document", handler);
    return () => ipcRenderer.removeListener("file:opened-document", handler);
  },
  onCommand: (listener) => {
    const handler = (_event, command) => listener(command);
    ipcRenderer.on("menu:command", handler);
    return () => ipcRenderer.removeListener("menu:command", handler);
  },
});
