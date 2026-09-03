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

const localPython = path.join(
  projectRoot,
  ".venv",
  ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]),
);
const pythonProbe = fs.existsSync(localPython)
  ? spawnSync(localPython, ["-c", "import PyInstaller"], { cwd: projectRoot, stdio: "ignore" })
  : null;
const conventionalUv = [
  process.env.HOME && path.join(process.env.HOME, ".local", "bin", process.platform === "win32" ? "uv.exe" : "uv"),
  process.platform === "darwin" ? "/opt/homebrew/bin/uv" : null,
  process.platform === "win32" && process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, ".local", "bin", "uv.exe")
    : null,
  process.platform !== "win32" ? "/usr/local/bin/uv" : null,
].filter(Boolean);
const uv = process.env.UV || conventionalUv.find((candidate) => fs.existsSync(candidate)) || "uv";
const separator = process.platform === "win32" ? ";" : ":";
const pyinstallerArgs = [
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
const useLocalPython = pythonProbe?.status === 0;
const command = useLocalPython ? localPython : uv;
const args = useLocalPython
  ? ["-m", "PyInstaller", ...pyinstallerArgs]
  : ["run", "--with", "pyinstaller==6.22.2", "pyinstaller", ...pyinstallerArgs];
const result = spawnSync(command, args, { cwd: projectRoot, stdio: "inherit" });
if (result.error?.code === "ENOENT") {
  console.error(
    "Desktop packaging needs the project environment or uv. Run `uv sync` first, " +
    "or set UV to the full path of the uv executable.",
  );
  process.exit(1);
}
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);

const binary = path.join(output, process.platform === "win32" ? "funchess-backend.exe" : "funchess-backend");
if (!fs.existsSync(binary)) throw new Error(`Backend binary was not produced at ${binary}`);
console.log(`Desktop backend ready: ${binary}`);
