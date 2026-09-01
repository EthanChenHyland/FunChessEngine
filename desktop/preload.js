"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("engineLabDesktop", {
  platform: process.platform,
  openFen: () => ipcRenderer.invoke("file:open-fen"),
  openPng: () => ipcRenderer.invoke("file:open-png"),
  saveText: (filename, text) => ipcRenderer.invoke("file:save-text", { filename, text }),
  saveBinary: (filename, bytes) => ipcRenderer.invoke("file:save-binary", { filename, bytes }),
  onCommand: (listener) => {
    const handler = (_event, command) => listener(command);
    ipcRenderer.on("menu:command", handler);
    return () => ipcRenderer.removeListener("menu:command", handler);
  },
});
