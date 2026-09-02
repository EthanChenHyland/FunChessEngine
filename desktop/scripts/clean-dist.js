"use strict";

const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
fs.rmSync(path.join(desktopRoot, "dist"), { recursive: true, force: true });
