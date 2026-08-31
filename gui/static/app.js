const PIECES = {
  P: "♙", N: "♘", B: "♗", R: "♖", Q: "♕", K: "♔",
  p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚",
};

const DISPLAY_KEY = "funChessEngine.display.v1";
const DISPLAY_DEFAULTS = {
  theme: "forest",
  accent: "lime",
  boardMax: 720,
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

const $ = (id) => document.getElementById(id);

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
  root.style.setProperty("--board-max", `${display.boardMax}px`);
  root.style.setProperty("--piece-size", `${display.pieceScale / 8}cqw`);

  $("themeSelect").value = display.theme;
  $("accentSelect").value = display.accent;
  $("evalPerspectiveSelect").value = display.evalPerspective;
  $("boardSizeInput").value = String(display.boardMax);
  $("boardSizeValue").textContent = `${display.boardMax} px`;
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
  const targets = legalTargets(selected);
  const lastFrom = display.lastMove ? state?.last_move?.slice(0, 2) : null;
  const lastTo = display.lastMove ? state?.last_move?.slice(2, 4) : null;

  for (const square of squareOrder()) {
    const file = square.charCodeAt(0) - 97;
    const rank = Number(square[1]) - 1;
    const symbol = state?.board[square] || null;
    const button = document.createElement("button");
    button.className = `square ${(file + rank) % 2 ? "light" : "dark"}`;
    if (selected === square) button.classList.add("selected");
    if (square === lastFrom || square === lastTo) button.classList.add("last");
    if (targets.has(square)) button.classList.add("target");
    if (symbol) button.classList.add("occupied");
    button.dataset.square = square;
    button.setAttribute("aria-label", symbol ? `${pieceName(symbol)} on ${square}` : `empty square ${square}`);
    button.setAttribute("aria-pressed", selected === square ? "true" : "false");
    button.addEventListener("click", () => clickSquare(square));

    if (symbol) {
      const piece = document.createElement("span");
      piece.className = "piece";
      piece.textContent = PIECES[symbol];
      button.appendChild(piece);
    }

    if (display.coords) {
      const showFile = flipped ? square[1] === "8" : square[1] === "1";
      const showRank = flipped ? square[0] === "h" : square[0] === "a";
      if (showFile) button.insertAdjacentHTML("beforeend", `<span class="coord file">${square[0]}</span>`);
      if (showRank) button.insertAdjacentHTML("beforeend", `<span class="coord rank">${square[1]}</span>`);
    }
    board.appendChild(button);
  }
}

function choosePromotion(candidates) {
  const dialog = $("promotionDialog");
  dialog.returnValue = "cancel";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      const choice = dialog.returnValue;
      resolve(choice === "cancel" ? null : candidates.find((candidate) => candidate.endsWith(choice)) || null);
    }, { once: true });
    dialog.showModal();
  });
}

async function clickSquare(square) {
  if (busy || !state || state.game_over) return;
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
  const humanSide = $("humanSide").value;
  $("whiteRole").textContent = humanSide === "both" || humanSide === "white" ? "Human" : "Engine";
  $("blackRole").textContent = humanSide === "both" || humanSide === "black" ? "Human" : "Engine";
}

function render() {
  if (!state) return;
  renderBoard();
  $("whiteClock").textContent = clock(state.white_ms);
  $("blackClock").textContent = clock(state.black_ms);
  $("whiteClock").classList.toggle("active", !state.game_over && state.turn === "white");
  $("blackClock").classList.toggle("active", !state.game_over && state.turn === "black");
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
  const searchScore = state.last_engine_score;
  $("searchScore").textContent = Number.isFinite(searchScore)
    ? `${searchScore >= 0 ? "+" : ""}${(searchScore / 100).toFixed(2)}`
    : "—";
  const pv = Array.isArray(state.last_engine_pv) ? state.last_engine_pv : [];
  $("pvLine").textContent = pv.length ? pv.join(" ") : "No completed search yet.";
  const researches = Number(state.last_engine_researches || 0);
  $("researches").textContent = `${researches} ${researches === 1 ? "research" : "researches"}`;
  $("engineBtn").disabled = busy || state.game_over;
  $("analyzeBtn").disabled = busy || state.game_over;
  $("undoBtn").disabled = busy || state.pgn.length === 0;
  $("autoBtn").disabled = busy || state.game_over;
  $("autoBtn").textContent = autoplay ? "Stop autoplay" : "Start autoplay";
  updatePlayerRoles();
  renderMoves();
  if (state.game_over) $("statusLine").textContent = `Game over · ${state.result} · ${state.termination}`;
  else if (state.check) $("statusLine").textContent = `${capitalize(state.turn)} is in check.`;
}

function renderMoves() {
  const target = $("moves");
  target.innerHTML = "";
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
  if (busy) return;
  busy = true;
  $("statusLine").textContent = "Engine working…";
  render();
  try {
    state = await fn();
    $("statusLine").textContent = successText;
  } catch (error) {
    $("statusLine").textContent = error.message;
  } finally {
    busy = false;
    render();
  }
}

async function engineMove() {
  const raw = $("budgetInput").value.trim();
  await act(() => api("/api/engine", raw ? { budget_ms: Number(raw) } : {}), "Engine move complete.");
}

function scheduleComputerReply() {
  if (!state || state.game_over || busy) return;
  const humanSide = $("humanSide").value;
  const shouldMove = humanSide === "none" ? autoplay : humanSide !== "both" && state.turn !== humanSide;
  if (!shouldMove) return;
  clearTimeout(autoplayTimer);
  autoplayTimer = setTimeout(async () => {
    await engineMove();
    if (autoplay && $("humanSide").value === "none") scheduleComputerReply();
  }, 180);
}

function toggleAutoplay() {
  autoplay = !autoplay;
  if (autoplay && $("humanSide").value !== "none") $("humanSide").value = "none";
  if (!autoplay) clearTimeout(autoplayTimer);
  selected = null;
  render();
  scheduleComputerReply();
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
$("undoBtn").addEventListener("click", () => act(() => api("/api/undo", {}), "Move undone."));
$("engineBtn").addEventListener("click", engineMove);
$("analyzeBtn").addEventListener("click", engineMove);
$("autoBtn").addEventListener("click", toggleAutoplay);
$("copyFenBtn").addEventListener("click", copyFen);

$("humanSide").addEventListener("change", () => {
  autoplay = $("humanSide").value === "none" && autoplay;
  selected = null;
  orientForHuman();
  render();
  scheduleComputerReply();
});

$("newGameBtn").addEventListener("click", () => {
  autoplay = false;
  selected = null;
  act(() => api("/api/reset", {}), "New game started.");
});

$("loadFenBtn").addEventListener("click", () => {
  const fen = $("fenInput").value.trim();
  const clockMs = Math.max(1, Number($("clockInput").value) || 120) * 1000;
  autoplay = false;
  selected = null;
  act(() => api("/api/reset", { fen, clock_ms: clockMs }), "Position loaded.");
});

$("themeSelect").addEventListener("change", (event) => updateDisplay({ theme: event.target.value }));
$("accentSelect").addEventListener("change", (event) => updateDisplay({ accent: event.target.value }));
$("evalPerspectiveSelect").addEventListener("change", (event) => updateDisplay({ evalPerspective: event.target.value }));
$("boardSizeInput").addEventListener("input", (event) => updateDisplay({ boardMax: Number(event.target.value) }));
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
  if (key === "escape") {
    selected = null;
    if (state) renderBoard();
  } else if (key === "f") {
    flipped = !flipped;
    selected = null;
    if (state) renderBoard();
  } else if (key === "u" && state?.pgn.length && !busy) {
    act(() => api("/api/undo", {}), "Move undone.");
  } else if (key === "e" && state && !state.game_over && !busy) {
    engineMove();
  }
});

applyDisplaySettings(false);
orientForHuman();
api("/api/state").then((value) => {
  state = value;
  render();
  scheduleComputerReply();
}).catch((error) => {
  $("statusLine").textContent = error.message;
});
