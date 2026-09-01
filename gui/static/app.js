const PIECES = {
  P: "♙", N: "♘", B: "♗", R: "♖", Q: "♕", K: "♔",
  p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚",
};
const STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const DISPLAY_KEY = "funChessEngine.display.v1";
const DISPLAY_DEFAULTS = {
  theme: "forest",
  accent: "lime",
  pieceScale: 78,
  coords: true,
  targets: true,
  lastMove: true,
  autoOrient: true,
  evalPerspective: "white",
};

let state = null;
let selected = null;
let flipped = false;
let busy = false;
let autoplay = false;
let autoplayTimer = null;
let display = loadDisplaySettings();
let previousHumanSide = "white";
let clockAnchorMs = performance.now();
let flagRefreshPending = false;
let lastResultKey = null;
let setupMode = false;
let setupBoard = {};
let setupPiece = "";
let setupWasPaused = false;

const $ = (id) => document.getElementById(id);

function setState(value) {
  state = value;
  clockAnchorMs = performance.now();
  flagRefreshPending = false;
}

function loadDisplaySettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(DISPLAY_KEY) || "null");
    return { ...DISPLAY_DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) };
  } catch (_) {
    return { ...DISPLAY_DEFAULTS };
  }
}

function saveDisplaySettings() {
  try {
    localStorage.setItem(DISPLAY_KEY, JSON.stringify(display));
  } catch (_) {
    // Display preferences are optional; the GUI still works if storage is blocked.
  }
}

function applyDisplaySettings(renderAfter = true) {
  const root = document.documentElement;
  root.dataset.boardTheme = display.theme;
  root.dataset.accent = display.accent;
  root.style.setProperty("--piece-size", `${display.pieceScale / 8}cqw`);

  $("themeSelect").value = display.theme;
  $("accentSelect").value = display.accent;
  $("evalPerspectiveSelect").value = display.evalPerspective;
  $("pieceSizeInput").value = String(display.pieceScale);
  $("pieceSizeValue").textContent = `${display.pieceScale}%`;
  $("coordsToggle").checked = Boolean(display.coords);
  $("targetsToggle").checked = Boolean(display.targets);
  $("lastMoveToggle").checked = Boolean(display.lastMove);
  $("autoOrientToggle").checked = Boolean(display.autoOrient);

  if (renderAfter && state) renderBoard();
}

async function api(path, payload = null) {
  const options = payload === null ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
  const response = await fetch(path, options);
  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw new Error(`Server returned an invalid response (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function squareOrder() {
  const files = flipped ? "hgfedcba" : "abcdefgh";
  const ranks = flipped ? "12345678" : "87654321";
  return [...ranks].flatMap((rank) => [...files].map((file) => file + rank));
}

function legalTargets(square) {
  if (!state || !square || !display.targets) return new Set();
  return new Set(state.legal_moves.filter((move) => move.startsWith(square)).map((move) => move.slice(2, 4)));
}

function pieceName(symbol) {
  const names = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
  return `${symbol === symbol.toUpperCase() ? "white" : "black"} ${names[symbol.toLowerCase()]}`;
}

function renderBoard() {
  const board = $("board");
  board.innerHTML = "";
  const boardMap = setupMode ? setupBoard : state?.board || {};
  const targets = setupMode ? new Set() : legalTargets(selected);
  const lastFrom = !setupMode && display.lastMove ? state?.last_move?.slice(0, 2) : null;
  const lastTo = !setupMode && display.lastMove ? state?.last_move?.slice(2, 4) : null;

  for (const square of squareOrder()) {
    const file = square.charCodeAt(0) - 97;
    const rank = Number(square[1]) - 1;
    const symbol = boardMap[square] || null;
    const button = document.createElement("button");
    button.className = `square ${(file + rank) % 2 ? "light" : "dark"}`;
    if (selected === square) button.classList.add("selected");
    if (square === lastFrom || square === lastTo) button.classList.add("last");
    if (targets.has(square)) button.classList.add("target");
    if (symbol) button.classList.add("occupied");
    button.dataset.square = square;
    button.setAttribute("aria-label", symbol ? `${pieceName(symbol)} on ${square}` : `empty square ${square}`);
    button.setAttribute("aria-pressed", selected === square ? "true" : "false");
    button.addEventListener("click", () => setupMode ? setupSquareClick(square) : clickSquare(square));

    if (symbol) {
      const piece = document.createElement("span");
      piece.className = "piece";
      piece.textContent = PIECES[symbol];
      piece.draggable = setupMode || canHumanMovePiece(symbol);
      piece.addEventListener("dragstart", (event) => {
        if (!piece.draggable) return;
        if (setupMode) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", `setup:${square}`);
          return;
        }
        selected = square;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", square);
      });
      button.appendChild(piece);
    }
    button.addEventListener("dragover", (event) => {
      if (setupMode) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        return;
      }
      const from = event.dataTransfer?.getData("text/plain") || selected;
      if (from && state?.legal_moves.some((move) => move.startsWith(from + square))) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      }
    });
    button.addEventListener("drop", async (event) => {
      event.preventDefault();
      const from = event.dataTransfer?.getData("text/plain") || selected;
      if (setupMode) {
        if (from?.startsWith("setup:")) {
          moveSetupPiece(from.slice(6), square);
        }
        return;
      }
      if (!from) return;
      selected = from;
      await clickSquare(square);
    });

    if (display.coords) {
      const showFile = flipped ? square[1] === "8" : square[1] === "1";
      const showRank = flipped ? square[0] === "h" : square[0] === "a";
      if (showFile) button.insertAdjacentHTML("beforeend", `<span class="coord file">${square[0]}</span>`);
      if (showRank) button.insertAdjacentHTML("beforeend", `<span class="coord rank">${square[1]}</span>`);
    }
    board.appendChild(button);
  }
}

function canHumanMovePiece(symbol) {
  if (busy || !state || state.game_over || state.paused) return false;
  const humanSide = $("humanSide").value;
  if (humanSide === "none" || (humanSide !== "both" && humanSide !== state.turn)) return false;
  return (state.turn === "white") === (symbol === symbol.toUpperCase());
}

function choosePromotion(candidates) {
  const dialog = $("promotionDialog");
  const isWhite = state?.turn === "white";
  $("promotionTitle").textContent = `Promote ${isWhite ? "White" : "Black"} pawn`;
  $("promotionHint").textContent = "Choose a piece or press Q, R, B, or N.";
  document.querySelectorAll("[data-promotion-icon]").forEach((icon) => {
    const piece = icon.dataset.promotionIcon;
    icon.textContent = PIECES[isWhite ? piece.toUpperCase() : piece] || "";
  });
  dialog.returnValue = "cancel";
  return new Promise((resolve) => {
    let settled = false;
    const finish = (choice) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("keydown", keyHandler);
      const move = choice === "cancel"
        ? null
        : candidates.find((candidate) => candidate.endsWith(choice)) || null;
      resolve(move);
    };
    const keyHandler = (event) => {
      const key = event.key.toLowerCase();
      if (["q", "r", "b", "n"].includes(key)) {
        event.preventDefault();
        finish(key);
        if (dialog.open) dialog.close(key);
      }
    };
    dialog.addEventListener("keydown", keyHandler);
    dialog.addEventListener("close", () => {
      finish(dialog.returnValue);
    }, { once: true });
    dialog.showModal();
    dialog.querySelector('[data-promotion="q"]')?.focus();
  });
}

function confirmRestart(message) {
  const dialog = $("restartDialog");
  $("restartMessage").textContent = message;
  dialog.returnValue = "cancel";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "restart"), { once: true });
    dialog.showModal();
  });
}

function confirmAction(title, message, confirmLabel, dangerous = false) {
  const dialog = $("actionDialog");
  const confirmButton = $("actionConfirmBtn");
  $("actionTitle").textContent = title;
  $("actionMessage").textContent = message;
  confirmButton.textContent = confirmLabel;
  confirmButton.className = dangerous ? "danger" : "primary";
  dialog.returnValue = "cancel";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
    dialog.showModal();
  });
}

function hasUnsavedProgress() {
  if (!state) return false;
  return Boolean(state.pgn?.length) || state.initial_fen !== STARTING_FEN;
}

function confirmRestartIfNeeded(message) {
  return hasUnsavedProgress() ? confirmRestart(message) : Promise.resolve(true);
}

function boardMapFromFen(fen) {
  const placement = String(fen || STARTING_FEN).split(" ")[0];
  const ranks = placement.split("/");
  const map = {};
  if (ranks.length !== 8) return map;
  ranks.forEach((rankText, rankIndex) => {
    let file = 0;
    for (const char of rankText) {
      if (/\d/.test(char)) {
        file += Number(char);
        continue;
      }
      if (file < 8) map[`${"abcdefgh"[file]}${8 - rankIndex}`] = char;
      file += 1;
    }
  });
  return map;
}

function setupBoardPlacement() {
  const ranks = [];
  for (let rank = 8; rank >= 1; rank -= 1) {
    let row = "";
    let empty = 0;
    for (const file of "abcdefgh") {
      const piece = setupBoard[`${file}${rank}`];
      if (!piece) {
        empty += 1;
        continue;
      }
      if (empty) {
        row += String(empty);
        empty = 0;
      }
      row += piece;
    }
    if (empty) row += String(empty);
    ranks.push(row || "8");
  }
  return ranks.join("/");
}

function setupCastlingRights() {
  const rights = [
    ["setupCastleK", "K"],
    ["setupCastleQ", "Q"],
    ["setupCastlek", "k"],
    ["setupCastleq", "q"],
  ].filter(([id]) => $(id).checked).map(([, symbol]) => symbol).join("");
  return rights || "-";
}

function setupFen() {
  const epRaw = $("setupEp").value.trim().toLowerCase();
  const ep = !epRaw || epRaw === "-" ? "-" : epRaw;
  if (ep !== "-" && !/^[a-h][36]$/.test(ep)) {
    throw new Error("En-passant square must be '-' or a square on rank 3 or 6.");
  }
  const halfmove = Math.max(0, Math.floor(Number($("setupHalfmove").value) || 0));
  const fullmove = Math.max(1, Math.floor(Number($("setupFullmove").value) || 1));
  return `${setupBoardPlacement()} ${$("setupTurn").value} ${setupCastlingRights()} ${ep} ${halfmove} ${fullmove}`;
}

function setSetupPiece(piece) {
  setupPiece = piece;
  document.querySelectorAll("[data-setup-piece]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.setupPiece === piece);
  });
  $("setupStatus").textContent = piece ? `${pieceName(piece)} selected` : "Erase selected";
}

function setupSquareClick(square) {
  if (!setupMode) return;
  if (setupPiece) setupBoard[square] = setupPiece;
  else delete setupBoard[square];
  renderBoard();
}

function moveSetupPiece(from, to) {
  if (!setupMode || !setupBoard[from]) return;
  const piece = setupBoard[from];
  delete setupBoard[from];
  setupBoard[to] = piece;
  renderBoard();
}

function syncSetupFieldsFromFen(fen) {
  const fields = String(fen || STARTING_FEN).split(" ");
  setupBoard = boardMapFromFen(fen);
  $("setupTurn").value = fields[1] === "b" ? "b" : "w";
  const castling = fields[2] || "-";
  $("setupCastleK").checked = castling.includes("K");
  $("setupCastleQ").checked = castling.includes("Q");
  $("setupCastlek").checked = castling.includes("k");
  $("setupCastleq").checked = castling.includes("q");
  $("setupEp").value = fields[3] && fields[3] !== "-" ? fields[3] : "";
  $("setupHalfmove").value = String(Math.max(0, Number(fields[4]) || 0));
  $("setupFullmove").value = String(Math.max(1, Number(fields[5]) || 1));
}

async function enterSetupMode() {
  if (setupMode || !state) return;
  setupWasPaused = Boolean(state.paused);
  if (!state.game_over && !state.paused) {
    const paused = await act(() => api("/api/pause", { paused: true }), "Game paused for position setup.");
    if (!paused) return;
  }
  clearTimeout(autoplayTimer);
  setupMode = true;
  selected = null;
  syncSetupFieldsFromFen(state.fen);
  setSetupPiece("");
  $("setupControls").hidden = false;
  $("setupModeBtn").hidden = true;
  $("boardStage").classList.add("setup-active");
  $("blackRole").textContent = "Setup";
  $("whiteRole").textContent = "Setup";
  renderBoard();
}

async function leaveSetupMode(resumeGame = true) {
  if (!setupMode) return;
  setupMode = false;
  setupBoard = {};
  selected = null;
  $("setupControls").hidden = true;
  $("setupModeBtn").hidden = false;
  $("setupStatus").textContent = "Board editor";
  $("boardStage").classList.remove("setup-active");
  render();
  if (resumeGame && !setupWasPaused && state && !state.game_over && state.paused) {
    await act(() => api("/api/pause", { paused: false }), "Position setup canceled. Game resumed.");
    scheduleComputerReply();
  }
}

async function applySetupPosition() {
  if (!setupMode) return;
  let fen;
  try {
    fen = setupFen();
  } catch (error) {
    $("setupStatus").textContent = error.message;
    return;
  }
  const confirmed = await confirmRestartIfNeeded(
    "Using this setup replaces the current game. Unsaved progress will be lost.",
  );
  if (!confirmed) return;
  const { baseMs, incrementMs } = selectedTimeControl();
  selected = null;
  autoplay = $("humanSide").value === "none";
  const succeeded = await act(
    () => api("/api/reset", { fen, clock_ms: baseMs, increment_ms: incrementMs }),
    "Custom position loaded.",
  );
  if (!succeeded) {
    $("setupStatus").textContent = "Invalid position — check kings, pawns, and castling rights.";
    return;
  }
  setupMode = false;
  $("setupControls").hidden = true;
  $("setupModeBtn").hidden = false;
  $("setupStatus").textContent = "Board editor";
  $("boardStage").classList.remove("setup-active");
  setupBoard = {};
  $("fenInput").value = state.fen;
  render();
  scheduleComputerReply();
}

function selectedTimeControl() {
  const preset = $("timePreset").value;
  if (preset !== "custom") {
    const [baseSeconds, incrementMs] = preset.split(",").map(Number);
    return { baseMs: Math.max(1000, baseSeconds * 1000), incrementMs: Math.max(0, incrementMs) };
  }
  const baseMinutes = Math.max(0.1, Number($("baseTimeInput").value) || 2);
  const incrementSeconds = Math.max(0, Number($("incrementInput").value) || 0);
  return { baseMs: Math.round(baseMinutes * 60_000), incrementMs: Math.round(incrementSeconds * 1000) };
}

function formatTimeControl(baseMs, incrementMs) {
  const totalSeconds = Math.max(1, Math.round(baseMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const base = seconds ? `${minutes}:${String(seconds).padStart(2, "0")}` : String(minutes);
  const increment = incrementMs % 1000 === 0 ? String(incrementMs / 1000) : (incrementMs / 1000).toFixed(1);
  return `${base} + ${increment}`;
}

function syncTimeControlsFromState() {
  if (!state) return;
  const baseMs = Number(state.base_clock_ms || 120000);
  const incrementMs = Number(state.increment_ms || 0);
  $("timeSummary").textContent = formatTimeControl(baseMs, incrementMs);
  $("baseTimeInput").value = String(Number((baseMs / 60_000).toFixed(2)));
  $("incrementInput").value = String(incrementMs / 1000);
  const matching = [...$("timePreset").options].find((option) => option.value === `${baseMs / 1000},${incrementMs}`);
  $("timePreset").value = matching ? matching.value : "custom";
  $("customTimeRow").hidden = $("timePreset").value !== "custom";
}

async function restartStandardGame(successText = "New game started.") {
  if (setupMode) await leaveSetupMode(false);
  const { baseMs, incrementMs } = selectedTimeControl();
  autoplay = $("humanSide").value === "none";
  selected = null;
  const succeeded = await act(
    () => api("/api/reset", { clock_ms: baseMs, increment_ms: incrementMs }),
    successText,
  );
  if (succeeded) {
    previousHumanSide = $("humanSide").value;
    orientForHuman();
    scheduleComputerReply();
  }
  return succeeded;
}

function desktopApi() {
  return window.engineLabDesktop || null;
}

async function downloadBlob(blob, filename) {
  const desktop = desktopApi();
  if (desktop?.saveBinary) {
    const saved = await desktop.saveBinary(filename, await blob.arrayBuffer());
    if (saved) return true;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

function gameSnapshot() {
  if (!state) throw new Error("There is no game to save.");
  return {
    format: "FunChessEngine.GamePNG",
    version: 1,
    saved_at: new Date().toISOString(),
    initial_fen: state.initial_fen,
    moves: Array.isArray(state.moves_uci) ? state.moves_uci : [],
    white_ms: Math.round(liveClockMs("white")),
    black_ms: Math.round(liveClockMs("black")),
    base_clock_ms: Number(state.base_clock_ms || 120000),
    increment_ms: Number(state.increment_ms || 0),
    clock_history: Array.isArray(state.clock_history) ? state.clock_history : [],
    human_side: $("humanSide").value,
    autoplay: Boolean(autoplay),
    paused: Boolean(state.paused),
    manual_result: state.manual_result || null,
    manual_termination: state.manual_termination || null,
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u32Bytes(value) {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

function makePngTextChunk(keyword, text) {
  const encoder = new TextEncoder();
  const type = encoder.encode("tEXt");
  const data = new Uint8Array([...encoder.encode(keyword), 0, ...encoder.encode(text)]);
  const crcInput = new Uint8Array(type.length + data.length);
  crcInput.set(type, 0);
  crcInput.set(data, type.length);
  const chunk = new Uint8Array(12 + data.length);
  chunk.set(u32Bytes(data.length), 0);
  chunk.set(type, 4);
  chunk.set(data, 8);
  chunk.set(u32Bytes(crc32(crcInput)), 8 + data.length);
  return chunk;
}

function readU32(bytes, offset) {
  return (((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function embedPngSnapshot(bytes, snapshot) {
  const encoder = new TextEncoder();
  const iend = encoder.encode("IEND");
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset);
    const typeOffset = offset + 4;
    if (bytes.slice(typeOffset, typeOffset + 4).every((value, index) => value === iend[index])) {
      const chunk = makePngTextChunk("FunChessEngine", JSON.stringify(snapshot));
      const output = new Uint8Array(bytes.length + chunk.length);
      output.set(bytes.slice(0, offset), 0);
      output.set(chunk, offset);
      output.set(bytes.slice(offset), offset + chunk.length);
      return output;
    }
    offset += 12 + length;
  }
  throw new Error("Could not encode game data into the PNG.");
}

function extractPngSnapshot(bytes) {
  const decoder = new TextDecoder();
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset);
    if (offset + 12 + length > bytes.length) break;
    const type = decoder.decode(bytes.slice(offset + 4, offset + 8));
    if (type === "tEXt") {
      const data = bytes.slice(offset + 8, offset + 8 + length);
      const zero = data.indexOf(0);
      if (zero > 0 && decoder.decode(data.slice(0, zero)) === "FunChessEngine") {
        const snapshot = JSON.parse(decoder.decode(data.slice(zero + 1)));
        if (snapshot?.format !== "FunChessEngine.GamePNG" || snapshot?.version !== 1) {
          throw new Error("This PNG uses an unsupported Engine Lab save format.");
        }
        return snapshot;
      }
    }
    offset += 12 + length;
  }
  throw new Error("No Engine Lab game data was found in this PNG. Load a PNG previously saved by this app.");
}

async function renderGamePng(snapshot) {
  const canvas = document.createElement("canvas");
  const size = 960;
  const header = 92;
  const footer = 118;
  canvas.width = size;
  canvas.height = header + size + footer;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas export is not available in this browser.");
  const styles = getComputedStyle(document.documentElement);
  const light = styles.getPropertyValue("--light-square").trim() || "#d9dccd";
  const dark = styles.getPropertyValue("--dark-square").trim() || "#65705d";
  const background = styles.getPropertyValue("--panel").trim() || "#171b18";
  const text = styles.getPropertyValue("--text").trim() || "#f3f5f1";
  const muted = styles.getPropertyValue("--muted").trim() || "#9da69c";
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = text;
  context.font = "700 32px system-ui";
  context.fillText("FunChessEngine · Saved Game", 28, 50);
  context.fillStyle = muted;
  context.font = "20px ui-monospace, monospace";
  context.fillText(`${formatTimeControl(snapshot.base_clock_ms, snapshot.increment_ms)} · ${snapshot.moves.length} plies`, 28, 78);
  const order = squareOrder();
  const squareSize = size / 8;
  for (let index = 0; index < order.length; index += 1) {
    const row = Math.floor(index / 8);
    const col = index % 8;
    const square = order[index];
    const file = square.charCodeAt(0) - 97;
    const rank = Number(square[1]) - 1;
    context.fillStyle = (file + rank) % 2 ? light : dark;
    context.fillRect(col * squareSize, header + row * squareSize, squareSize, squareSize);
    const symbol = state.board[square];
    if (symbol) {
      context.fillStyle = "#111";
      context.font = `92px "Arial Unicode MS", "Segoe UI Symbol", sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(PIECES[symbol], col * squareSize + squareSize / 2, header + row * squareSize + squareSize / 2 + 3);
    }
  }
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.fillStyle = text;
  context.font = "700 24px ui-monospace, monospace";
  context.fillText(`White ${clock(snapshot.white_ms)}   Black ${clock(snapshot.black_ms)}`, 28, header + size + 45);
  context.fillStyle = muted;
  context.font = "17px ui-monospace, monospace";
  const fen = state.fen.length > 98 ? `${state.fen.slice(0, 95)}…` : state.fen;
  context.fillText(fen, 28, header + size + 80);
  context.fillText("This PNG contains embedded Engine Lab game data and can be loaded back into the app.", 28, header + size + 106);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not create the game PNG.");
  const encoded = embedPngSnapshot(new Uint8Array(await blob.arrayBuffer()), snapshot);
  return new Blob([encoded], { type: "image/png" });
}

async function saveGamePng() {
  try {
    const snapshot = gameSnapshot();
    const blob = await renderGamePng(snapshot);
    await downloadBlob(blob, `funchess-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    $("statusLine").textContent = "Game saved as a portable PNG.";
  } catch (error) {
    $("statusLine").textContent = error.message;
  }
}

async function loadGamePng(file) {
  try {
    if (setupMode) await leaveSetupMode(false);
    const snapshot = extractPngSnapshot(new Uint8Array(await file.arrayBuffer()));
    const mode = ["white", "black", "both", "none"].includes(snapshot.human_side) ? snapshot.human_side : "white";
    $("humanSide").value = mode;
    previousHumanSide = mode;
    autoplay = mode === "none" && Boolean(snapshot.autoplay);
    selected = null;
    const succeeded = await act(() => api("/api/load-game", snapshot), "Saved game restored from PNG.");
    if (succeeded) {
      syncTimeControlsFromState();
      orientForHuman();
      scheduleComputerReply();
    }
  } catch (error) {
    $("statusLine").textContent = error.message;
  }
}

async function clickSquare(square) {
  if (busy || !state || state.game_over || state.paused) return;
  const humanSide = $("humanSide").value;
  if (humanSide === "none" || (humanSide !== "both" && humanSide !== state.turn)) return;
  const piece = state.board[square];
  const isOwn = piece && ((state.turn === "white") === (piece === piece.toUpperCase()));
  if (!selected) {
    if (isOwn) {
      selected = square;
      renderBoard();
    }
    return;
  }
  if (isOwn) {
    selected = square;
    renderBoard();
    return;
  }
  const candidates = state.legal_moves.filter((move) => move.startsWith(selected + square));
  if (!candidates.length) {
    selected = null;
    renderBoard();
    return;
  }

  let move = candidates[0];
  if (candidates.length > 1) {
    move = await choosePromotion(candidates);
    if (!move) {
      selected = null;
      renderBoard();
      return;
    }
  }
  selected = null;
  await act(() => api("/api/move", { move }), "Move played.");
  scheduleComputerReply();
}

function updatePlayerRoles() {
  if (setupMode) {
    $("whiteRole").textContent = "Setup";
    $("blackRole").textContent = "Setup";
    return;
  }
  const humanSide = $("humanSide").value;
  $("whiteRole").textContent = humanSide === "both" || humanSide === "white" ? "Human" : "Engine";
  $("blackRole").textContent = humanSide === "both" || humanSide === "black" ? "Human" : "Engine";
}

function renderCapturedMaterial() {
  if (!state) return;
  const renderCaptured = (id, pieces) => {
    $(id).textContent = (Array.isArray(pieces) ? pieces : [])
      .map((symbol) => PIECES[symbol] || "")
      .join("");
  };
  renderCaptured("whiteCaptured", state.captured_by_white);
  renderCaptured("blackCaptured", state.captured_by_black);
  const balance = Number(state.material_balance || 0);
  $("whiteMaterial").textContent = balance > 0 ? `+${balance}` : "";
  $("blackMaterial").textContent = balance < 0 ? `+${Math.abs(balance)}` : "";
}

function maybeShowResult() {
  if (!state?.game_over || !state.result) {
    lastResultKey = null;
    return;
  }
  const key = `${state.result}:${state.termination}:${state.moves_uci?.length || 0}`;
  if (key === lastResultKey) return;
  lastResultKey = key;
  const dialog = $("resultDialog");
  $("resultTitle").textContent = state.result === "1/2-1/2"
    ? "Draw"
    : `${state.result === "1-0" ? "White" : "Black"} wins`;
  $("resultMessage").textContent = `${state.result} · ${(state.termination || "game over").replaceAll("_", " ")}`;
  if (!dialog.open) dialog.showModal();
}

function liveClockMs(side) {
  if (!state) return 0;
  const key = side === "white" ? "white_ms" : "black_ms";
  let remaining = Number(state[key] || 0);
  if (!state.game_over && !state.paused && state.turn === side) {
    remaining -= performance.now() - clockAnchorMs;
  }
  return Math.max(0, remaining);
}

function renderClocks() {
  if (!state) return;
  const white = liveClockMs("white");
  const black = liveClockMs("black");
  $("whiteClock").textContent = clock(white);
  $("blackClock").textContent = clock(black);
  const active = state.turn === "white" ? white : black;
  if (!state.game_over && active <= 0 && !busy && !flagRefreshPending) {
    flagRefreshPending = true;
    api("/api/state").then((value) => {
      setState(value);
      render();
    }).catch(() => {
      flagRefreshPending = false;
    });
  }
}

function render() {
  if (!state) return;
  renderBoard();
  renderClocks();
  $("whiteClock").classList.toggle("active", !state.game_over && !state.paused && state.turn === "white");
  $("blackClock").classList.toggle("active", !state.game_over && !state.paused && state.turn === "black");
  $("fenInput").value = state.fen;
  const evalCp = display.evalPerspective === "turn" && state.turn === "black"
    ? -state.eval_cp
    : state.eval_cp;
  const cp = evalCp / 100;
  $("evalLabel").textContent = display.evalPerspective === "turn"
    ? `${capitalize(state.turn)} perspective`
    : "White perspective";
  $("evalText").textContent = `${cp >= 0 ? "+" : ""}${cp.toFixed(2)}`;
  const pct = Math.max(5, Math.min(95, 50 + 45 * Math.tanh(cp / 4)));
  $("evalBar").style.width = `${pct}%`;
  $("turnPill").textContent = state.game_over ? (state.result || "Game over") : `${capitalize(state.turn)} to move`;
  $("searchTime").textContent = state.last_engine_ms ? `${state.last_engine_ms} ms` : "—";
  $("nodes").textContent = state.last_engine_nodes ? state.last_engine_nodes.toLocaleString() : "—";
  $("depth").textContent = state.last_engine_depth ?? "—";
  const searchMs = Number(state.last_engine_ms || 0);
  const searchNodes = Number(state.last_engine_nodes || 0);
  $("nps").textContent = searchMs > 0 && searchNodes > 0
    ? Math.round(searchNodes * 1000 / searchMs).toLocaleString()
    : "—";
  const searchScore = state.last_engine_score;
  $("searchScore").textContent = Number.isFinite(searchScore)
    ? `${searchScore >= 0 ? "+" : ""}${(searchScore / 100).toFixed(2)}`
    : "—";
  const pv = Array.isArray(state.last_engine_pv) ? state.last_engine_pv : [];
  $("pvLine").textContent = pv.length ? pv.join(" ") : "No completed search yet.";
  const researches = Number(state.last_engine_researches || 0);
  $("researches").textContent = String(researches);
  $("engineBtn").disabled = setupMode || busy || state.game_over || state.paused;
  $("undoBtn").disabled = setupMode || busy || state.pgn.length === 0;
  $("pauseBtn").disabled = setupMode || busy || state.game_over;
  $("pauseBtn").textContent = state.paused ? "Resume clocks" : "Pause clocks";
  $("drawBtn").disabled = setupMode || busy || state.game_over;
  $("drawBtn").hidden = $("humanSide").value !== "both";
  $("resignBtn").disabled = setupMode || busy || state.game_over;
  $("resignBtn").hidden = $("humanSide").value === "none";
  if (!busy) {
    $("engineStatusText").textContent = state.game_over
      ? "Game complete"
      : state.paused
      ? "Game paused"
      : "Engine ready";
  }
  updatePlayerRoles();
  renderCapturedMaterial();
  renderMoves();
  if (state.game_over) {
    $("statusLine").textContent = `Game over · ${state.result} · ${state.termination}`;
    maybeShowResult();
  }
  else if (state.paused) $("statusLine").textContent = "Game paused · clocks stopped.";
  else if (state.check) $("statusLine").textContent = `${capitalize(state.turn)} is in check.`;
}

function renderMoves() {
  const target = $("moves");
  target.innerHTML = "";
  const plies = state.pgn.length;
  $("moveCount").textContent = `${plies} ${plies === 1 ? "ply" : "plies"}`;
  if (!state.pgn.length) {
    const empty = document.createElement("div");
    empty.className = "moves-empty";
    empty.textContent = "Moves will appear here.";
    target.appendChild(empty);
    return;
  }
  for (let i = 0; i < state.pgn.length; i += 2) {
    const number = document.createElement("div");
    number.className = "move-num";
    number.textContent = `${i / 2 + 1}.`;
    target.appendChild(number);
    const white = document.createElement("div");
    white.textContent = state.pgn[i]?.san || "";
    target.appendChild(white);
    const black = document.createElement("div");
    black.textContent = state.pgn[i + 1]?.san || "";
    target.appendChild(black);
  }
  target.scrollTop = target.scrollHeight;
}

function clock(ms) {
  const safe = Math.max(0, ms);
  const min = Math.floor(safe / 60000);
  const sec = Math.floor((safe % 60000) / 1000);
  const tenth = Math.floor((safe % 1000) / 100);
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${tenth}`;
}

function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

async function act(fn, successText = "Ready.") {
  if (busy) return false;
  busy = true;
  $("statusLine").textContent = "Working…";
  $("engineStatusText").textContent = "Engine busy";
  render();
  try {
    setState(await fn());
    $("statusLine").textContent = successText;
    $("engineStatusText").textContent = "Engine ready";
    return true;
  } catch (error) {
    $("statusLine").textContent = error.message;
    $("engineStatusText").textContent = "Engine ready";
    return false;
  } finally {
    busy = false;
    render();
  }
}

async function engineMove() {
  const raw = $("budgetInput").value.trim();
  return act(() => api("/api/engine", raw ? { budget_ms: Number(raw) } : {}), "Engine move complete.");
}

function scheduleComputerReply() {
  clearTimeout(autoplayTimer);
  autoplayTimer = null;
  if (!state || state.game_over || state.paused) return;
  const humanSide = $("humanSide").value;
  const shouldMove = humanSide === "none" ? autoplay : humanSide !== "both" && state.turn !== humanSide;
  if (!shouldMove) return;

  // A role change can happen while another request (reset, undo, FEN load,
  // etc.) is still finishing. Previously that made the automatic engine turn
  // disappear permanently because `busy` caused an early return. Retry the
  // scheduling decision after the in-flight request has had time to settle.
  if (busy) {
    autoplayTimer = setTimeout(scheduleComputerReply, 75);
    return;
  }

  autoplayTimer = setTimeout(async () => {
    autoplayTimer = null;
    const succeeded = await engineMove();
    if (succeeded && autoplay && $("humanSide").value === "none") scheduleComputerReply();
  }, 180);
}

async function copyFen() {
  const value = $("fenInput").value.trim();
  try {
    await navigator.clipboard.writeText(value);
    $("statusLine").textContent = "FEN copied to clipboard.";
  } catch (_) {
    $("fenInput").focus();
    $("fenInput").select();
    $("statusLine").textContent = "FEN selected — copy it with your keyboard shortcut.";
  }
}

async function downloadFen() {
  const fen = $("fenInput").value.trim();
  if (!fen) return;
  const desktop = desktopApi();
  if (desktop?.saveText) {
    const saved = await desktop.saveText("funchess-position.fen", `${fen}\n`);
    if (!saved) return;
  } else {
    await downloadBlob(new Blob([`${fen}\n`], { type: "text/plain;charset=utf-8" }), "funchess-position.fen");
  }
  $("statusLine").textContent = "FEN downloaded.";
}

async function openFenFile() {
  const desktop = desktopApi();
  if (!desktop?.openFen) {
    $("loadFenFileInput").click();
    return;
  }
  const fen = await desktop.openFen();
  if (!fen) return;
  $("fenInput").value = fen.trim();
  await loadFenValue(fen.trim());
}

async function openPngFile() {
  const desktop = desktopApi();
  if (!desktop?.openPng) {
    $("loadPngInput").click();
    return;
  }
  const value = await desktop.openPng();
  if (!value) return;
  const bytes = value instanceof ArrayBuffer ? value : value.buffer;
  await loadGamePng(new File([bytes], "saved-game.png", { type: "image/png" }));
}

async function togglePause() {
  if (!state || state.game_over) return;
  clearTimeout(autoplayTimer);
  const wasPaused = Boolean(state.paused);
  await act(
    () => api("/api/pause", { paused: !wasPaused }),
    wasPaused ? "Game resumed." : "Game paused.",
  );
  if (!state?.paused) scheduleComputerReply();
}

async function agreeDraw() {
  if (!state || state.game_over) return;
  const confirmed = await confirmAction(
    "Agree to a draw?",
    "This ends the current local two-player game as ½–½.",
    "Agree draw",
  );
  if (!confirmed) return;
  autoplay = false;
  clearTimeout(autoplayTimer);
  await act(() => api("/api/draw", {}), "Draw agreed.");
}

async function resignGame() {
  if (!state || state.game_over) return;
  const mode = $("humanSide").value;
  const color = mode === "white" || mode === "black" ? mode : state.turn;
  const confirmed = await confirmAction(
    `${capitalize(color)} resigns?`,
    `Resigning immediately ends the game and awards the win to ${color === "white" ? "Black" : "White"}.`,
    "Resign game",
    true,
  );
  if (!confirmed) return;
  autoplay = false;
  clearTimeout(autoplayTimer);
  await act(() => api("/api/resign", { color }), `${capitalize(color)} resigned.`);
}

async function loadFenValue(fen) {
  const confirmed = await confirmRestartIfNeeded(
    "Loading a FEN replaces the current game. The current game is not saved automatically and unsaved progress will be lost.",
  );
  if (!confirmed) return false;
  if (setupMode) await leaveSetupMode(false);
  const { baseMs, incrementMs } = selectedTimeControl();
  autoplay = $("humanSide").value === "none";
  selected = null;
  const succeeded = await act(
    () => api("/api/reset", { fen: fen.trim(), clock_ms: baseMs, increment_ms: incrementMs }),
    "FEN loaded as a new game.",
  );
  if (succeeded) scheduleComputerReply();
  return succeeded;
}

function updateDisplay(patch) {
  display = { ...display, ...patch };
  saveDisplaySettings();
  applyDisplaySettings();
}

function orientForHuman() {
  if (!display.autoOrient) return;
  const humanSide = $("humanSide").value;
  if (humanSide === "white") flipped = false;
  else if (humanSide === "black") flipped = true;
}

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.remove("active"));
    button.classList.add("active");
    $(`${button.dataset.tab}Tab`).classList.add("active");
  });
});

$("flipBtn").addEventListener("click", () => {
  flipped = !flipped;
  selected = null;
  renderBoard();
});
$("undoBtn").addEventListener("click", async () => {
  const succeeded = await act(() => api("/api/undo", {}), "Move undone.");
  if (succeeded) scheduleComputerReply();
});
$("engineBtn").addEventListener("click", engineMove);
$("copyFenBtn").addEventListener("click", copyFen);
$("downloadFenBtn").addEventListener("click", downloadFen);
$("savePngBtn").addEventListener("click", saveGamePng);
$("loadPngBtn").addEventListener("click", openPngFile);
$("loadPngInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file) await loadGamePng(file);
});
$("loadFenFileBtn").addEventListener("click", openFenFile);
$("loadFenFileInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const fen = (await file.text()).trim();
    $("fenInput").value = fen;
    await loadFenValue(fen);
  } catch (error) {
    $("statusLine").textContent = error.message;
  }
});

$("setupModeBtn").addEventListener("click", enterSetupMode);
$("setupCancelBtn").addEventListener("click", () => leaveSetupMode(true));
$("setupStartBtn").addEventListener("click", () => {
  syncSetupFieldsFromFen(STARTING_FEN);
  setSetupPiece("");
  renderBoard();
});
$("setupClearBtn").addEventListener("click", () => {
  setupBoard = {};
  $("setupCastleK").checked = false;
  $("setupCastleQ").checked = false;
  $("setupCastlek").checked = false;
  $("setupCastleq").checked = false;
  $("setupEp").value = "";
  $("setupHalfmove").value = "0";
  $("setupFullmove").value = "1";
  setSetupPiece("");
  renderBoard();
});
$("setupApplyBtn").addEventListener("click", applySetupPosition);
document.querySelectorAll("[data-setup-piece]").forEach((button) => {
  button.addEventListener("click", () => setSetupPiece(button.dataset.setupPiece || ""));
});

$("pauseBtn").addEventListener("click", togglePause);
$("drawBtn").addEventListener("click", agreeDraw);
$("resignBtn").addEventListener("click", resignGame);
$("rematchBtn").addEventListener("click", () => {
  setTimeout(() => restartStandardGame("Rematch started."), 0);
});

$("humanSide").addEventListener("change", async () => {
  const nextSide = $("humanSide").value;
  if (nextSide === previousHumanSide) return;
  const confirmed = await confirmRestartIfNeeded(
    "Changing game mode restarts from the standard position. The current game is not saved automatically and unsaved progress will be lost.",
  );
  if (!confirmed) {
    $("humanSide").value = previousHumanSide;
    render();
    return;
  }
  previousHumanSide = nextSide;
  autoplay = nextSide === "none";
  selected = null;
  orientForHuman();
  render();
  await restartStandardGame(`${nextSide === "both" ? "Two-player" : nextSide === "none" ? "Engine vs Engine" : `Human ${capitalize(nextSide)}`} mode started.`);
});

$("newGameBtn").addEventListener("click", async () => {
  const confirmed = await confirmRestartIfNeeded(
    "Starting a new game discards the current game unless you save it first.",
  );
  if (!confirmed) return;
  await restartStandardGame();
});

$("loadFenBtn").addEventListener("click", async () => {
  await loadFenValue($("fenInput").value.trim());
});

$("timePreset").addEventListener("change", () => {
  $("customTimeRow").hidden = $("timePreset").value !== "custom";
  const { baseMs, incrementMs } = selectedTimeControl();
  $("timeSummary").textContent = formatTimeControl(baseMs, incrementMs);
});
$("baseTimeInput").addEventListener("input", () => {
  const { baseMs, incrementMs } = selectedTimeControl();
  $("timeSummary").textContent = formatTimeControl(baseMs, incrementMs);
});
$("incrementInput").addEventListener("input", () => {
  const { baseMs, incrementMs } = selectedTimeControl();
  $("timeSummary").textContent = formatTimeControl(baseMs, incrementMs);
});
$("applyTimeBtn").addEventListener("click", async () => {
  const confirmed = await confirmRestartIfNeeded(
    "Applying a new time control restarts the game. The current game is not saved automatically and unsaved progress will be lost.",
  );
  if (!confirmed) return;
  await restartStandardGame("Time control applied and game restarted.");
});

$("themeSelect").addEventListener("change", (event) => updateDisplay({ theme: event.target.value }));
$("accentSelect").addEventListener("change", (event) => updateDisplay({ accent: event.target.value }));
$("evalPerspectiveSelect").addEventListener("change", (event) => updateDisplay({ evalPerspective: event.target.value }));
$("pieceSizeInput").addEventListener("input", (event) => updateDisplay({ pieceScale: Number(event.target.value) }));
$("coordsToggle").addEventListener("change", (event) => updateDisplay({ coords: event.target.checked }));
$("targetsToggle").addEventListener("change", (event) => updateDisplay({ targets: event.target.checked }));
$("lastMoveToggle").addEventListener("change", (event) => updateDisplay({ lastMove: event.target.checked }));
$("autoOrientToggle").addEventListener("change", (event) => {
  updateDisplay({ autoOrient: event.target.checked });
  orientForHuman();
  if (state) renderBoard();
});
$("resetDisplayBtn").addEventListener("click", () => {
  display = { ...DISPLAY_DEFAULTS };
  saveDisplaySettings();
  applyDisplaySettings();
});

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  const tag = document.activeElement?.tagName;
  if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(tag) || document.activeElement?.isContentEditable) return;
  const key = event.key.toLowerCase();
  if (setupMode) {
    if (key === "escape") {
      event.preventDefault();
      leaveSetupMode(true);
    } else if (key === "f") {
      flipped = !flipped;
      renderBoard();
    }
    return;
  }
  if (key === "escape") {
    selected = null;
    if (state) renderBoard();
  } else if (key === "f") {
    flipped = !flipped;
    selected = null;
    if (state) renderBoard();
  } else if (key === "u" && state?.pgn.length && !busy) {
    act(() => api("/api/undo", {}), "Move undone.").then((succeeded) => {
      if (succeeded) scheduleComputerReply();
    });
  } else if (key === "e" && state && !state.game_over && !busy) {
    engineMove();
  } else if (key === " " && state && !state.game_over && !busy) {
    event.preventDefault();
    togglePause();
  }
});

const desktop = desktopApi();
if (desktop) {
  document.documentElement.dataset.desktop = "true";
  desktop.onCommand?.((command) => {
    if (command === "new-game") $("newGameBtn").click();
    else if (command === "setup-position") {
      document.querySelector('[data-tab="position"]')?.click();
      enterSetupMode();
    }
    else if (command === "open-fen") openFenFile();
    else if (command === "open-png") openPngFile();
    else if (command === "save-fen") downloadFen();
    else if (command === "save-png") saveGamePng();
    else if (command === "undo") $("undoBtn").click();
    else if (command === "flip") $("flipBtn").click();
    else if (command === "engine-move") $("engineBtn").click();
    else if (command === "pause") $("pauseBtn").click();
  });
}

applyDisplaySettings(false);
orientForHuman();
api("/api/state").then((value) => {
  setState(value);
  previousHumanSide = $("humanSide").value;
  syncTimeControlsFromState();
  render();
  scheduleComputerReply();
}).catch((error) => {
  $("statusLine").textContent = error.message;
});
setInterval(renderClocks, 100);
