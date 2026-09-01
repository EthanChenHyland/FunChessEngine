"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const desktopRoot = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const version = String(packageJson.version || "");
const appPath = path.join(desktopRoot, "dist", "mac-arm64", "FunChessEngine.app");
const appExecutable = path.join(appPath, "Contents", "MacOS", "FunChessEngine");
const backendExecutable = path.join(appPath, "Contents", "Resources", "bin", "funchess-backend");
const dmgPath = path.join(desktopRoot, "dist", `FunChessEngine-${version}-arm64.dmg`);
const zipPath = path.join(desktopRoot, "dist", `FunChessEngine-${version}-arm64.zip`);

function requireFile(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing release artifact: ${filePath}`);
}

function requireArm64(filePath) {
  const result = spawnSync("file", [filePath], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `Could not inspect ${filePath}`);
  if (!result.stdout.includes("arm64")) {
    throw new Error(`Release artifact is not arm64: ${result.stdout.trim()}`);
  }
}

function fetchState(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${url}/api/state`, { timeout: 5000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Packaged backend state smoke returned HTTP ${response.statusCode}.`));
          return;
        }
        try {
          const state = JSON.parse(body);
          if (!state?.fen || !state?.board) throw new Error("state payload is incomplete");
          resolve(state);
        } catch (error) {
          reject(new Error(`Packaged backend returned invalid state: ${error.message}`));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Packaged backend state smoke timed out.")));
    request.on("error", reject);
  });
}

function smokeBackend() {
  return new Promise((resolve, reject) => {
    const child = spawn(backendExecutable, ["--no-open", "--port", "0"], {
      cwd: path.dirname(backendExecutable),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => finish(new Error(`Packaged backend did not start.\n${output}`)), 20000);
    const inspect = async (chunk) => {
      output += chunk.toString();
      const match = output.match(/FunChessEngine GUI:\s+(http:\/\/127\.0\.0\.1:\d+)/);
      if (!match || settled) return;
      try {
        await fetchState(match[1]);
        finish();
      } catch (error) {
        finish(error);
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", finish);
    child.once("exit", (code, signal) => {
      if (!settled) finish(new Error(`Packaged backend exited early (${code ?? signal ?? "unknown"}).\n${output}`));
    });
  });
}

async function main() {
  for (const filePath of [appPath, appExecutable, backendExecutable, dmgPath, zipPath]) requireFile(filePath);
  requireArm64(appExecutable);
  requireArm64(backendExecutable);
  await smokeBackend();
  console.log("Packaged macOS build smoke OK (arm64 app + backend + API)");
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
