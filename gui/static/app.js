const PIECES = {
  P: "♙", N: "♘", B: "♗", R: "♖", Q: "♕", K: "♔",
  p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚",
};

let state = null;
let selected = null;
let flipped = false;
let busy = false;
let autoplay = false;
let autoplayTimer = null;

const $ = (id) => document.getElementById(id);

async function api(path, payload = null) {
  const options = payload === null ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function squareOrder() {
  const files = flipped ? "hgfedcba" : "abcdefgh";
  const ranks = flipped ? "12345678" : "87654321";
  return [...ranks].flatMap((rank) => [...files].map((file) => file + rank));
}

function legalTargets(square) {
  if (!state || !square) return new Set();
  return new Set(state.legal_moves.filter((move) => move.startsWith(square)).map((move) => move.slice(2, 4)));
}

function renderBoard() {
  const board = $("board");
  board.innerHTML = "";
  const targets = legalTargets(selected);
  const lastFrom = state?.last_move?.slice(0, 2);
  const lastTo = state?.last_move?.slice(2, 4);

  for (const square of squareOrder()) {
    const file = square.charCodeAt(0) - 97;
    const rank = Number(square[1]) - 1;
    const button = document.createElement("button");
    button.className = `square ${(file + rank) % 2 ? "light" : "dark"}`;
    if (selected === square) button.classList.add("selected");
    if (square === lastFrom || square === lastTo) button.classList.add("last");
    if (targets.has(square)) button.classList.add("target");
    if (state?.board[square]) button.classList.add("occupied");
    button.dataset.square = square;
    button.setAttribute("aria-label", square);
    button.addEventListener("click", () => clickSquare(square));

    if (state?.board[square]) {
      const piece = document.createElement("span");
      piece.className = "piece";
      piece.textContent = PIECES[state.board[square]];
      button.appendChild(piece);
    }
    const showFile = flipped ? square[1] === "8" : square[1] === "1";
    const showRank = flipped ? square[0] === "h" : square[0] === "a";
    if (showFile) button.insertAdjacentHTML("beforeend", `<span class="coord file">${square[0]}</span>`);
    if (showRank) button.insertAdjacentHTML("beforeend", `<span class="coord rank">${square[1]}</span>`);
    board.appendChild(button);
  }
}

async function clickSquare(square) {
  if (busy || state.game_over) return;
  const humanSide = $("humanSide").value;
  if (humanSide === "none" || (humanSide !== "both" && humanSide !== state.turn)) return;
  const piece = state.board[square];
  const isOwn = piece && ((state.turn === "white") === (piece === piece.toUpperCase()));
  if (!selected) {
    if (isOwn) { selected = square; renderBoard(); }
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
    const promotion = (prompt("Promote to q, r, b, or n", "q") || "q").toLowerCase();
    move = candidates.find((candidate) => candidate.endsWith(promotion)) || candidates[0];
  }
  selected = null;
  await act(() => api("/api/move", { move }), "Move played.");
  scheduleComputerReply();
}

function render() {
  if (!state) return;
  renderBoard();
  $("whiteClock").textContent = clock(state.white_ms);
  $("blackClock").textContent = clock(state.black_ms);
  $("fenInput").value = state.fen;
  const cp = state.eval_cp / 100;
  $("evalText").textContent = `${cp >= 0 ? "+" : ""}${cp.toFixed(2)}`;
  const pct = Math.max(5, Math.min(95, 50 + 45 * Math.tanh(cp / 4)));
  $("evalBar").style.width = `${pct}%`;
  $("turnPill").textContent = state.game_over ? (state.result || "Game over") : `${capitalize(state.turn)} to move`;
  $("searchTime").textContent = state.last_engine_ms ? `${state.last_engine_ms} ms` : "—";
  $("nodes").textContent = state.last_engine_nodes ? state.last_engine_nodes.toLocaleString() : "—";
  $("depth").textContent = state.last_engine_depth ?? "—";
  $("engineBtn").disabled = busy || state.game_over;
  $("analyzeBtn").disabled = busy || state.game_over;
  $("autoBtn").textContent = autoplay ? "Stop autoplay" : "Start autoplay";
  renderMoves();
  if (state.game_over) $("statusLine").textContent = `Game over · ${state.result} · ${state.termination}`;
  else if (state.check) $("statusLine").textContent = `${capitalize(state.turn)} is in check.`;
}

function renderMoves() {
  const target = $("moves");
  target.innerHTML = "";
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

function capitalize(text) { return text[0].toUpperCase() + text.slice(1); }

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
  }, 160);
}

function toggleAutoplay() {
  autoplay = !autoplay;
  if (autoplay && $("humanSide").value !== "none") $("humanSide").value = "none";
  if (!autoplay) clearTimeout(autoplayTimer);
  render();
  scheduleComputerReply();
}

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.remove("active"));
    button.classList.add("active");
    $(`${button.dataset.tab}Tab`).classList.add("active");
  });
});

$("flipBtn").addEventListener("click", () => { flipped = !flipped; selected = null; renderBoard(); });
$("undoBtn").addEventListener("click", () => act(() => api("/api/undo", {}), "Move undone."));
$("engineBtn").addEventListener("click", engineMove);
$("analyzeBtn").addEventListener("click", engineMove);
$("autoBtn").addEventListener("click", toggleAutoplay);
$("humanSide").addEventListener("change", () => {
  autoplay = $("humanSide").value === "none" && autoplay;
  selected = null;
  render();
  scheduleComputerReply();
});
$("newGameBtn").addEventListener("click", () => act(() => api("/api/reset", {}), "New game started."));
$("loadFenBtn").addEventListener("click", () => {
  const fen = $("fenInput").value.trim();
  const clockMs = Math.max(1, Number($("clockInput").value) || 120) * 1000;
  act(() => api("/api/reset", { fen, clock_ms: clockMs }), "Position loaded.");
});

api("/api/state").then((value) => { state = value; render(); scheduleComputerReply(); }).catch((error) => {
  $("statusLine").textContent = error.message;
});
