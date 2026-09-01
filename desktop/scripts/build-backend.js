"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
const output = path.join(desktopRoot, "backend-dist");
const work = path.join(desktopRoot, ".cache", "pyinstaller");
const spec = path.join(desktopRoot, ".cache", "funchess-backend.spec");

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(work, { recursive: true });

const localUv = "/Users/ethius/AI-Workspace/runtimes/uv/bin/uv";
const uv = process.env.UV || (fs.existsSync(localUv) ? localUv : "uv");
const separator = process.platform === "win32" ? ";" : ":";
const args = [
  "run",
  "--with",
  "pyinstaller",
  "pyinstaller",
  "--noconfirm",
  "--clean",
  "--onefile",
  "--name",
  "funchess-backend",
  "--distpath",
  output,
  "--workpath",
  work,
  "--specpath",
  path.dirname(spec),
  "--add-data",
  `${path.join(projectRoot, "gui", "static")}${separator}gui/static`,
  "--add-data",
  `${path.join(projectRoot, "gui", "openings.json")}${separator}gui`,
  "--paths",
  projectRoot,
  path.join(projectRoot, "gui", "server.py"),
];

const result = spawnSync(uv, args, { cwd: projectRoot, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);

const binary = path.join(output, process.platform === "win32" ? "funchess-backend.exe" : "funchess-backend");
if (!fs.existsSync(binary)) throw new Error(`Backend binary was not produced at ${binary}`);
console.log(`Desktop backend ready: ${binary}`);
