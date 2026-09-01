const PIECES = {
  P: "♙", N: "♘", B: "♗", R: "♖", Q: "♕", K: "♔",
  p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚",
};
const STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const DISPLAY_KEY = "funChessEngine.display.v1";
const RECOVERY_KEY = "funChessEngine.recovery.v1";
const RECOVERY_CLEAN_EXIT_KEY = "funChessEngine.recovery.cleanExit.v1";
const RECENTS_KEY = "funChessEngine.recents.v1";
const TRAINER_KEY = "funChessEngine.trainer.v1";
const ANNOTATIONS_KEY = "funChessEngine.annotations.v1";
const DISPLAY_DEFAULTS = {
  theme: "forest",
  accent: "lime",
  pieceScale: 78,
  coords: true,
  targets: true,
  lastMove: true,
  autoOrient: true,
  evalPerspective: "white",
  sound: true,
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
let reviewMode = false;
let reviewSnapshot = null;
let reviewSeries = null;
let reviewWasPaused = false;
let gameAnalysis = null;
let analysisPollTimer = null;
let retryMode = false;
let retryTargetPly = null;
let retryRevealBest = false;
let recoverySaveTimer = null;
let startupRecovery = loadRecoverySnapshot();
let recoveryResolved = !startupRecovery;
let recentGames = loadRecentGames();
let archivedResultKey = null;
let multiPvData = null;
let multiPvBusy = false;
let multiPvArrowMove = null;
let variationMode = false;
let variationWorkspace = null;
let variationNodeId = null;
let annotationDragFrom = null;
let annotations = loadAnnotations();
let trainerItems = loadTrainerItems();
let trainerMode = false;
let trainerSnapshot = null;
let trainerItemIndex = -1;
let trainerSelected = null;
let trainerRevealBest = false;
let trainerSessionSolved = 0;
let trainerSessionStreak = 0;
let trainerWasPaused = false;
let commandSelection = 0;
let evalBreakdownData = null;
let evalBreakdownBusy = false;

try {
  localStorage.setItem(RECOVERY_CLEAN_EXIT_KEY, "0");
} catch (_) {
  recoveryResolved = true;
  startupRecovery = null;
}

const $ = (id) => document.getElementById(id);

function setState(value) {
  state = value;
  if (reviewSeries && reviewSeries.total_plies !== (value.moves_uci?.length || 0)) reviewSeries = null;
  if (
    value.analysis_status === "idle"
    && gameAnalysis?.results?.length
    && gameAnalysis.results.length !== (value.moves_uci?.length || 0)
  ) gameAnalysis = null;
  if (multiPvData && multiPvData.total_plies !== (value.moves_uci?.length || 0)) {
    multiPvData = null;
    multiPvArrowMove = null;
  }
  clockAnchorMs = performance.now();
  flagRefreshPending = false;
  scheduleRecoverySave();
}

function loadRecoverySnapshot() {
  try {
    const cleanExit = localStorage.getItem(RECOVERY_CLEAN_EXIT_KEY) === "1";
    const saved = JSON.parse(localStorage.getItem(RECOVERY_KEY) || "null");
    if (cleanExit || !saved || saved.version !== 1 || !Array.isArray(saved.moves)) return null;
    if (!saved.moves.length && saved.initial_fen === STARTING_FEN) return null;
    return saved;
  } catch (_) {
    return null;
  }
}

function loadRecentGames() {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((item) => item && Array.isArray(item.moves)).slice(0, 12) : [];
  } catch (_) {
    return [];
  }
}

function loadAnnotations() {
  try {
    const saved = JSON.parse(localStorage.getItem(ANNOTATIONS_KEY) || "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch (_) {
    return {};
  }
}

function saveAnnotations() {
  try {
    const entries = Object.entries(annotations).slice(-160);
    localStorage.setItem(ANNOTATIONS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch (_) {
    // Board markup is optional local metadata.
  }
}

function loadTrainerItems() {
  try {
    const saved = JSON.parse(localStorage.getItem(TRAINER_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((item) => item?.fen && item?.best_uci).slice(0, 250) : [];
  } catch (_) {
    return [];
  }
}

function saveTrainerItems() {
  try {
    localStorage.setItem(TRAINER_KEY, JSON.stringify(trainerItems.slice(0, 250)));
  } catch (_) {
    // Trainer history is optional local data.
  }
}

function cacheCurrentAnalysis() {
  if (!state || !gameAnalysis?.results?.length) return;
  const snapshot = gameSnapshot();
  const signature = gameSignature(snapshot);
  const existing = recentGames.findIndex((item) => gameSignature(item) === signature);
  if (existing >= 0) {
    recentGames[existing] = { ...recentGames[existing], analysis: gameAnalysis };
    saveRecentGames();
  }
  persistRecoverySnapshot();
}

function ingestTrainerFromAnalysis() {
  if (!gameAnalysis?.results?.length) return;
  const source = state ? gameSignature(gameSnapshot()) : "analysis";
  let changed = false;
  for (const result of gameAnalysis.results) {
    const cpl = Number(result.cpl || 0);
    if (!result.fen_before || !result.best_uci || cpl < 80) continue;
    const key = `${result.fen_before}|${result.best_uci}`;
    if (trainerItems.some((item) => item.key === key)) continue;
    trainerItems.unshift({
      key,
      fen: result.fen_before,
      best_uci: result.best_uci,
      best_san: result.best_san,
      played_san: result.played_san,
      classification: result.classification,
      cpl,
      phase: result.phase || "middlegame",
      explanation: result.explanation || "",
      source,
      created_at: new Date().toISOString(),
      attempts: 0,
      solved: 0,
      due_at: Date.now(),
    });
    changed = true;
  }
  if (changed) {
    trainerItems = trainerItems.slice(0, 250);
    saveTrainerItems();
  }
}

function saveRecentGames() {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recentGames.slice(0, 12)));
  } catch (_) {
    // Recent games are optional local convenience data.
  }
}

function gameSignature(snapshot) {
  return `${snapshot.initial_fen || STARTING_FEN}|${(snapshot.moves || []).join(",")}|${snapshot.result || snapshot.manual_result || "*"}`;
}

function backendSnapshot(snapshot) {
  const { analysis: _analysis, ...rest } = snapshot || {};
  return rest;
}

function archiveCompletedGame() {
  if (!state?.game_over || !state.moves_uci?.length) return;
  const snapshot = gameSnapshot();
  const signature = gameSignature(snapshot);
  if (signature === archivedResultKey) return;
  archivedResultKey = signature;
  const existing = recentGames.findIndex((item) => gameSignature(item) === signature);
  if (existing >= 0) recentGames.splice(existing, 1);
  snapshot.recent_id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  recentGames.unshift(snapshot);
  recentGames = recentGames.slice(0, 12);
  saveRecentGames();
}

function renderRecentGames() {
  const target = $("recentGamesList");
  if (!target) return;
  target.innerHTML = "";
  $("recentGameCount").textContent = String(recentGames.length);
  $("clearRecentGamesBtn").hidden = recentGames.length === 0;
  if (!recentGames.length) {
    const empty = document.createElement("p");
    empty.className = "hint recent-empty";
    empty.textContent = "Completed and imported games will appear here.";
    target.appendChild(empty);
    return;
  }
  recentGames.forEach((snapshot, index) => {
    const row = document.createElement("div");
    row.className = "recent-game-row";
    const info = document.createElement("div");
    const result = snapshot.result || snapshot.manual_result || "*";
    const moves = snapshot.moves?.length || 0;
    const saved = snapshot.saved_at ? new Date(snapshot.saved_at) : null;
    const when = saved && !Number.isNaN(saved.getTime()) ? saved.toLocaleDateString() : "Saved game";
    const title = document.createElement("strong");
    title.textContent = `${result} · ${Math.ceil(moves / 2)} moves`;
    const meta = document.createElement("span");
    meta.textContent = when;
    info.append(title, meta);
    const open = document.createElement("button");
    open.className = "secondary compact";
    open.textContent = "Review";
    open.addEventListener("click", () => openRecentGame(index));
    row.append(info, open);
    target.appendChild(row);
  });
}

async function openRecentGame(index) {
  const snapshot = recentGames[index];
  if (!snapshot) return;
  if (setupMode) await leaveSetupMode(false);
  if (reviewMode) {
    reviewMode = false;
    reviewSnapshot = null;
  }
  const mode = ["white", "black", "both", "none"].includes(snapshot.human_side)
    ? snapshot.human_side
    : "white";
  $("humanSide").value = mode;
  previousHumanSide = mode;
  autoplay = false;
  selected = null;
  gameAnalysis = snapshot.analysis && typeof snapshot.analysis === "object" ? snapshot.analysis : null;
  const succeeded = await act(() => api("/api/load-game", backendSnapshot(snapshot)), "Recent game opened for review.");
  if (succeeded) {
    syncTimeControlsFromState();
    orientForHuman();
    document.querySelector('[data-tab="engine"]')?.click();
    await enterReviewMode(state.moves_uci?.length || 0);
  }
}

function clearRecentGames() {
  recentGames = [];
  archivedResultKey = null;
  saveRecentGames();
  renderRecentGames();
}

function scheduleRecoverySave() {
  if (!state || !recoveryResolved) return;
  clearTimeout(recoverySaveTimer);
  recoverySaveTimer = setTimeout(persistRecoverySnapshot, 120);
}

function persistRecoverySnapshot() {
  if (!state || !recoveryResolved) return;
  try {
    const hasProgress = Boolean(state.moves_uci?.length) || state.initial_fen !== STARTING_FEN;
    if (!hasProgress) {
      localStorage.removeItem(RECOVERY_KEY);
      return;
    }
    localStorage.setItem(RECOVERY_KEY, JSON.stringify(gameSnapshot()));
  } catch (_) {
    // Recovery is best-effort and must never interfere with play.
  }
}

function renderRecoveryCard() {
  const card = $("recoveryCard");
  if (!card) return;
  card.hidden = recoveryResolved || !startupRecovery;
  if (card.hidden) return;
  const moves = startupRecovery.moves?.length || 0;
  const saved = startupRecovery.saved_at ? new Date(startupRecovery.saved_at) : null;
  const when = saved && !Number.isNaN(saved.getTime()) ? saved.toLocaleString() : "an earlier session";
  $("recoveryText").textContent = `Recovered ${moves} ${moves === 1 ? "ply" : "plies"} from ${when}.`;
}

async function resumeRecovery() {
  if (!startupRecovery) return;
  const snapshot = startupRecovery;
  const mode = ["white", "black", "both", "none"].includes(snapshot.human_side)
    ? snapshot.human_side
    : "white";
  $("humanSide").value = mode;
  previousHumanSide = mode;
  autoplay = mode === "none" && Boolean(snapshot.autoplay);
  recoveryResolved = true;
  startupRecovery = null;
  selected = null;
  gameAnalysis = snapshot.analysis && typeof snapshot.analysis === "object" ? snapshot.analysis : null;
  const succeeded = await act(() => api("/api/load-game", backendSnapshot(snapshot)), "Recovered autosaved game.");
  if (succeeded) {
    syncTimeControlsFromState();
    orientForHuman();
    scheduleComputerReply();
    persistRecoverySnapshot();
  }
}

function discardRecovery() {
  recoveryResolved = true;
  startupRecovery = null;
  try {
    localStorage.removeItem(RECOVERY_KEY);
  } catch (_) {
    // Nothing else to do if browser storage is unavailable.
  }
  render();
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
  $("soundToggle").checked = Boolean(display.sound);

  if (renderAfter && state) render();
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

function currentBoardView() {
  if (trainerMode && trainerSnapshot) return trainerSnapshot;
  if (variationMode && variationWorkspace) return variationWorkspace.nodes[variationNodeId]?.snapshot || null;
  if (reviewMode && reviewSnapshot) return reviewSnapshot;
  return state;
}

function currentAnnotationFen() {
  return currentBoardView()?.fen || state?.fen || "";
}

function currentAnnotations() {
  const fen = currentAnnotationFen();
  if (!fen) return { squares: {}, arrows: [] };
  if (!annotations[fen]) annotations[fen] = { squares: {}, arrows: [] };
  return annotations[fen];
}

function legalTargets(square) {
  if (!state || !square || !display.targets) return new Set();
  const view = currentBoardView();
  const moves = (retryMode || trainerMode || variationMode) && view
    ? (view.legal_moves || [])
    : state.legal_moves;
  return new Set(moves.filter((move) => move.startsWith(square)).map((move) => move.slice(2, 4)));
}

function pieceName(symbol) {
  const names = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
  return `${symbol === symbol.toUpperCase() ? "white" : "black"} ${names[symbol.toLowerCase()]}`;
}

function renderBoard() {
  const board = $("board");
  board.innerHTML = "";
  const view = currentBoardView();
  const boardMap = setupMode ? setupBoard : view?.board || {};
  const targets = setupMode || (reviewMode && !retryMode && !variationMode && !trainerMode)
    ? new Set()
    : legalTargets(selected);
  const lastFrom = !setupMode && display.lastMove ? view?.last_move?.slice(0, 2) : null;
  const lastTo = !setupMode && display.lastMove ? view?.last_move?.slice(2, 4) : null;
  const marks = currentAnnotations();

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
    if (marks.squares?.[square]) {
      button.classList.add("annotation-highlight");
      button.style.setProperty("--annotation-color", annotationColorValue(marks.squares[square], .42));
    }
    button.dataset.square = square;
    button.setAttribute("aria-label", symbol ? `${pieceName(symbol)} on ${square}` : `empty square ${square}`);
    button.setAttribute("aria-pressed", selected === square ? "true" : "false");
    button.addEventListener("click", () => setupMode
      ? setupSquareClick(square)
      : trainerMode
      ? trainerSquareClick(square)
      : variationMode
      ? variationSquareClick(square)
      : retryMode
      ? retrySquareClick(square)
      : clickSquare(square));
    button.addEventListener("contextmenu", (event) => {
      if (setupMode) return;
      event.preventDefault();
      toggleSquareAnnotation(square);
    });
    button.addEventListener("pointerdown", (event) => {
      if (event.button === 2 && !setupMode) annotationDragFrom = square;
    });
    button.addEventListener("pointerup", (event) => {
      if (event.button !== 2 || !annotationDragFrom || setupMode) return;
      const from = annotationDragFrom;
      annotationDragFrom = null;
      if (from !== square) toggleArrowAnnotation(from, square);
    });

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
      const moves = currentBoardView()?.legal_moves || state?.legal_moves || [];
      if (from && moves.some((move) => move.startsWith(from + square))) {
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
      if (trainerMode) {
        trainerSelected = from;
        await trainerSquareClick(square);
      }
      else if (variationMode) await variationSquareClick(square);
      else if (retryMode) await retrySquareClick(square);
      else await clickSquare(square);
    });

    if (display.coords) {
      const showFile = flipped ? square[1] === "8" : square[1] === "1";
      const showRank = flipped ? square[0] === "h" : square[0] === "a";
      if (showFile) button.insertAdjacentHTML("beforeend", `<span class="coord file">${square[0]}</span>`);
      if (showRank) button.insertAdjacentHTML("beforeend", `<span class="coord rank">${square[1]}</span>`);
    }
    board.appendChild(button);
  }
  renderBestMoveArrow();
  renderAnnotationArrows();
}

function canHumanMovePiece(symbol) {
  if (variationMode || trainerMode) {
    const view = currentBoardView();
    if (!view || busy) return false;
    return (view.turn === "white") === (symbol === symbol.toUpperCase());
  }
  if (reviewMode || busy || !state || state.game_over || state.paused) return false;
  const humanSide = $("humanSide").value;
  if (humanSide === "none" || (humanSide !== "both" && humanSide !== state.turn)) return false;
  return (state.turn === "white") === (symbol === symbol.toUpperCase());
}

function choosePromotion(candidates, turn = state?.turn) {
  const dialog = $("promotionDialog");
  const isWhite = turn === "white";
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

function boardPoint(square) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return flipped
    ? { x: 7 - file + 0.5, y: rank + 0.5 }
    : { x: file + 0.5, y: 7 - rank + 0.5 };
}

function annotationColorValue(name, alpha = 1) {
  const colors = {
    amber: [255, 201, 103],
    cyan: [99, 230, 255],
    violet: [199, 163, 255],
    lime: [183, 242, 104],
  };
  const [r, g, b] = colors[name] || colors.amber;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function annotationColor() {
  return $("annotationColor")?.value || "amber";
}

function toggleSquareAnnotation(square) {
  const marks = currentAnnotations();
  marks.squares ||= {};
  if (marks.squares[square]) delete marks.squares[square];
  else marks.squares[square] = annotationColor();
  saveAnnotations();
  renderBoard();
}

function toggleArrowAnnotation(from, to) {
  const marks = currentAnnotations();
  marks.arrows ||= [];
  const index = marks.arrows.findIndex((arrow) => arrow.from === from && arrow.to === to);
  if (index >= 0) marks.arrows.splice(index, 1);
  else marks.arrows.push({ from, to, color: annotationColor() });
  saveAnnotations();
  renderBoard();
}

function clearCurrentAnnotations() {
  const fen = currentAnnotationFen();
  if (fen) delete annotations[fen];
  saveAnnotations();
  renderBoard();
}

function renderAnnotationArrows() {
  const overlay = $("boardOverlay");
  if (!overlay) return;
  overlay.querySelectorAll(".annotation-arrow").forEach((node) => node.remove());
  const marks = currentAnnotations();
  for (const arrow of marks.arrows || []) {
    if (!arrow?.from || !arrow?.to) continue;
    const from = boardPoint(arrow.from);
    const to = boardPoint(arrow.to);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    const shorten = 0.24;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.classList.add("annotation-arrow");
    line.setAttribute("x1", String(from.x + dx / length * shorten));
    line.setAttribute("y1", String(from.y + dy / length * shorten));
    line.setAttribute("x2", String(to.x - dx / length * shorten));
    line.setAttribute("y2", String(to.y - dy / length * shorten));
    line.setAttribute("stroke", annotationColorValue(arrow.color || "amber", .84));
    line.setAttribute("marker-end", "url(#bestArrowHead)");
    overlay.insertBefore(line, $("bestMoveArrow"));
  }
}

function renderBestMoveArrow() {
  const line = $("bestMoveArrow");
  if (!line) return;
  line.hidden = true;
  let move = "";
  if (retryMode && retryRevealBest && retryTargetPly) {
    const result = analysisResultForPly(retryTargetPly);
    move = String(result?.best_uci || "");
  } else if (trainerMode && trainerRevealBest && trainerItemIndex >= 0) {
    move = String(trainerItems[trainerItemIndex]?.best_uci || "");
  } else if (multiPvArrowMove && multiPvData) {
    if (String(multiPvData.fen || "") === String(currentBoardView()?.fen || "")) move = multiPvArrowMove;
  }
  if (move.length < 4) return;
  const from = boardPoint(move.slice(0, 2));
  const to = boardPoint(move.slice(2, 4));
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const shorten = 0.24;
  line.setAttribute("x1", String(from.x + dx / length * shorten));
  line.setAttribute("y1", String(from.y + dy / length * shorten));
  line.setAttribute("x2", String(to.x - dx / length * shorten));
  line.setAttribute("y2", String(to.y - dy / length * shorten));
  line.hidden = false;
}

async function retrySquareClick(square) {
  if (!retryMode || !reviewSnapshot || !retryTargetPly || busy) return;
  const piece = reviewSnapshot.board?.[square];
  const isOwn = piece && ((reviewSnapshot.turn === "white") === (piece === piece.toUpperCase()));
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
  const candidates = (reviewSnapshot.legal_moves || []).filter((move) => move.startsWith(selected + square));
  if (!candidates.length) {
    selected = null;
    renderBoard();
    return;
  }
  let move = candidates[0];
  if (candidates.length > 1) {
    move = await choosePromotion(candidates, reviewSnapshot.turn);
    if (!move) {
      selected = null;
      renderBoard();
      return;
    }
  }
  selected = null;
  const result = analysisResultForPly(retryTargetPly);
  retryRevealBest = true;
  if (move === result?.best_uci) {
    $("statusLine").textContent = `Correct — ${result.best_san} was the engine's top choice.`;
  } else {
    $("statusLine").textContent = `Not the top choice. The engine preferred ${result?.best_san || result?.best_uci || "another move"}.`;
  }
  renderBoard();
}

async function startRetryMove() {
  if (!reviewMode || !reviewSnapshot) return;
  const ply = Number(reviewSnapshot.ply || 0);
  if (ply <= 0 || !analysisResultForPly(ply)) return;
  retryTargetPly = ply;
  retryRevealBest = false;
  reviewSnapshot = await api("/api/review", { ply: ply - 1 });
  retryMode = true;
  selected = null;
  render();
  $("statusLine").textContent = `Retry move ${ply}: find the engine's preferred move.`;
}

async function exitRetryMove() {
  if (!retryMode || !retryTargetPly) return;
  const target = retryTargetPly;
  retryMode = false;
  retryTargetPly = null;
  retryRevealBest = false;
  selected = null;
  reviewSnapshot = await api("/api/review", { ply: target });
  render();
}

function variationNode() {
  return variationMode && variationWorkspace ? variationWorkspace.nodes[variationNodeId] || null : null;
}

function newVariationNode(snapshot, parent = null, moveUci = null, moveSan = "Root") {
  const id = globalThis.crypto?.randomUUID?.() || `v-${Date.now()}-${Math.random()}`;
  return { id, parent, move_uci: moveUci, move_san: moveSan, snapshot, children: [], comment: "", nag: "" };
}

async function startVariationWorkspace() {
  if (!state || setupMode || trainerMode || busy) return;
  if (!reviewMode) await enterReviewMode(state.moves_uci?.length || 0);
  if (!reviewSnapshot) return;
  const root = newVariationNode({ ...reviewSnapshot });
  variationWorkspace = {
    root: root.id,
    origin_ply: Number(reviewSnapshot.ply || 0),
    nodes: { [root.id]: root },
  };
  variationNodeId = root.id;
  variationMode = true;
  selected = null;
  render();
  $("statusLine").textContent = "Variation workspace active — play either side to explore branches.";
}

async function variationSquareClick(square) {
  const node = variationNode();
  const snapshot = node?.snapshot;
  if (!variationMode || !snapshot || busy || snapshot.game_over) return;
  const piece = snapshot.board?.[square];
  const isOwn = piece && ((snapshot.turn === "white") === (piece === piece.toUpperCase()));
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
  const candidates = (snapshot.legal_moves || []).filter((move) => move.startsWith(selected + square));
  if (!candidates.length) {
    selected = null;
    renderBoard();
    return;
  }
  let move = candidates[0];
  if (candidates.length > 1) {
    move = await choosePromotion(candidates, snapshot.turn);
    if (!move) {
      selected = null;
      renderBoard();
      return;
    }
  }
  selected = null;
  const existing = node.children
    .map((id) => variationWorkspace.nodes[id])
    .find((child) => child?.move_uci === move);
  if (existing) {
    variationNodeId = existing.id;
    render();
    return;
  }
  try {
    const childSnapshot = await api("/api/variation-move", { fen: snapshot.fen, move });
    const child = newVariationNode(childSnapshot, node.id, move, childSnapshot.move_san || move);
    variationWorkspace.nodes[child.id] = child;
    node.children.push(child.id);
    variationNodeId = child.id;
    playUiSound("move");
    render();
  } catch (error) {
    $("statusLine").textContent = error.message;
  }
}

function navigateVariation(id) {
  if (!variationWorkspace?.nodes[id]) return;
  variationNodeId = id;
  selected = null;
  render();
}

function variationBack() {
  const node = variationNode();
  if (node?.parent) navigateVariation(node.parent);
}

function deleteVariationBranch() {
  const node = variationNode();
  if (!node?.parent || !variationWorkspace) return;
  const parent = variationWorkspace.nodes[node.parent];
  if (parent) parent.children = parent.children.filter((id) => id !== node.id);
  const remove = (id) => {
    const item = variationWorkspace.nodes[id];
    for (const child of item?.children || []) remove(child);
    delete variationWorkspace.nodes[id];
  };
  const parentId = node.parent;
  remove(node.id);
  variationNodeId = parentId;
  render();
}

function variationPath() {
  const path = [];
  let node = variationNode();
  while (node) {
    path.unshift(node);
    node = node.parent ? variationWorkspace.nodes[node.parent] : null;
  }
  return path;
}

function saveVariationMetadata() {
  const node = variationNode();
  if (!node) return;
  node.nag = $("variationNag").value;
  node.comment = $("variationComment").value;
}

async function exitVariationWorkspace() {
  if (!variationMode) return;
  variationMode = false;
  variationWorkspace = null;
  variationNodeId = null;
  selected = null;
  render();
  $("statusLine").textContent = "Returned to the saved main line.";
}

function renderVariationWorkspace() {
  if (!$("variationStatus")) return;
  $("variationStartBtn").hidden = variationMode;
  $("variationExitBtn").hidden = !variationMode;
  $("variationControls").hidden = !variationMode;
  if (!variationMode) {
    $("variationStatus").textContent = "Main line";
    return;
  }
  const node = variationNode();
  const path = variationPath();
  $("variationStatus").textContent = `${Math.max(0, path.length - 1)} ply branch`;
  $("variationBackBtn").disabled = !node?.parent;
  $("variationDeleteBtn").disabled = !node?.parent;
  $("variationNag").value = node?.nag || "";
  $("variationComment").value = node?.comment || "";
  const breadcrumb = $("variationBreadcrumb");
  breadcrumb.innerHTML = "";
  path.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.classList.toggle("current", item.id === variationNodeId);
    button.textContent = index === 0 ? "Root" : `${item.move_san}${item.nag || ""}`;
    button.addEventListener("click", () => navigateVariation(item.id));
    breadcrumb.appendChild(button);
  });
  const children = $("variationChildren");
  children.innerHTML = "";
  for (const childId of node?.children || []) {
    const child = variationWorkspace.nodes[childId];
    if (!child) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${child.move_san}${child.nag || ""}`;
    button.addEventListener("click", () => navigateVariation(child.id));
    children.appendChild(button);
  }
  if (!node?.children?.length) {
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "Play a move on the board to create a branch.";
    children.appendChild(hint);
  }
}

function trainerDueItems() {
  const now = Date.now();
  return trainerItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => Number(item.due_at || 0) <= now)
    .sort((a, b) => Number(b.item.cpl || 0) - Number(a.item.cpl || 0));
}

async function loadTrainerItem(index) {
  const item = trainerItems[index];
  if (!item) return false;
  trainerItemIndex = index;
  trainerSelected = null;
  trainerRevealBest = false;
  trainerSnapshot = await api("/api/position", { fen: item.fen });
  trainerMode = true;
  render();
  return true;
}

async function startTrainer() {
  if (!trainerItems.length || busy || setupMode || variationMode) return;
  trainerWasPaused = Boolean(state?.paused || state?.game_over);
  if (state && !state.game_over && !state.paused) {
    const paused = await act(() => api("/api/pause", { paused: true }), "Game paused for training.");
    if (!paused) return;
  }
  const due = trainerDueItems();
  const target = due[0]?.index ?? 0;
  trainerSessionSolved = 0;
  trainerSessionStreak = 0;
  await loadTrainerItem(target);
  document.querySelector('[data-tab="train"]')?.click();
  $("statusLine").textContent = "Personal trainer active — find the engine's best move.";
}

async function trainerSquareClick(square) {
  const item = trainerItems[trainerItemIndex];
  const snapshot = trainerSnapshot;
  if (!trainerMode || !item || !snapshot || busy) return;
  const piece = snapshot.board?.[square];
  const isOwn = piece && ((snapshot.turn === "white") === (piece === piece.toUpperCase()));
  if (!trainerSelected) {
    if (isOwn) {
      trainerSelected = square;
      selected = square;
      renderBoard();
    }
    return;
  }
  if (isOwn) {
    trainerSelected = square;
    selected = square;
    renderBoard();
    return;
  }
  const candidates = (snapshot.legal_moves || []).filter((move) => move.startsWith(trainerSelected + square));
  if (!candidates.length) {
    trainerSelected = null;
    selected = null;
    renderBoard();
    return;
  }
  let move = candidates[0];
  if (candidates.length > 1) {
    move = await choosePromotion(candidates, snapshot.turn);
    if (!move) return;
  }
  trainerSelected = null;
  selected = null;
  item.attempts = Number(item.attempts || 0) + 1;
  trainerRevealBest = true;
  if (move === item.best_uci) {
    item.solved = Number(item.solved || 0) + 1;
    trainerSessionSolved += 1;
    trainerSessionStreak += 1;
    const intervalDays = Math.min(30, Math.max(1, 2 ** Math.min(5, item.solved - 1)));
    item.due_at = Date.now() + intervalDays * 86_400_000;
    $("trainerPrompt").textContent = `Correct — ${item.best_san || item.best_uci}. Next review in ${intervalDays} day${intervalDays === 1 ? "" : "s"}.`;
    playUiSound("success");
  } else {
    trainerSessionStreak = 0;
    item.due_at = Date.now() + 15 * 60_000;
    $("trainerPrompt").textContent = `Not quite. The engine preferred ${item.best_san || item.best_uci}.`;
    playUiSound("error");
  }
  saveTrainerItems();
  renderBoard();
  renderTrainerPanel();
  setTimeout(nextTrainerItem, 900);
}

async function nextTrainerItem() {
  if (!trainerMode) return;
  const due = trainerDueItems().filter(({ index }) => index !== trainerItemIndex);
  if (!due.length) {
    $("trainerPrompt").textContent = "Training queue complete for now.";
    renderTrainerPanel();
    return;
  }
  await loadTrainerItem(due[0].index);
}

function trainerHint() {
  const item = trainerItems[trainerItemIndex];
  if (!trainerMode || !item) return;
  trainerRevealBest = true;
  $("trainerPrompt").textContent = `Hint: look for ${item.best_san || item.best_uci}.`;
  renderBoard();
}

async function exitTrainer() {
  trainerMode = false;
  trainerSnapshot = null;
  trainerItemIndex = -1;
  trainerSelected = null;
  trainerRevealBest = false;
  selected = null;
  render();
  if (!trainerWasPaused && state && !state.game_over && state.paused) {
    const resumed = await act(() => api("/api/pause", { paused: false }), "Returned to live game.");
    if (resumed) scheduleComputerReply();
  }
}

function clearTrainer() {
  trainerItems = [];
  saveTrainerItems();
  if (trainerMode) exitTrainer();
  renderTrainerPanel();
}

function renderTrainerPanel() {
  if (!$("trainerCount")) return;
  const due = trainerDueItems();
  const solved = trainerItems.reduce((sum, item) => sum + (Number(item.solved || 0) > 0 ? 1 : 0), 0);
  $("trainerCount").textContent = `${trainerItems.length} position${trainerItems.length === 1 ? "" : "s"}`;
  $("trainerDue").textContent = String(due.length);
  $("trainerSolved").textContent = String(solved);
  $("trainerStreak").textContent = String(trainerSessionStreak);
  $("trainerStartBtn").disabled = trainerItems.length === 0 || trainerMode;
  $("trainerSession").hidden = !trainerMode;
  if (trainerMode) {
    const item = trainerItems[trainerItemIndex];
    $("trainerLabel").textContent = `${capitalize(item?.classification || "Training")} · ${capitalize(item?.phase || "position")}`;
    $("trainerProgress").textContent = `${trainerSessionSolved} solved`;
    if (!trainerRevealBest) $("trainerPrompt").textContent = `You played ${item?.played_san || "a weaker move"}. Find a better move.`;
  }
  const queue = $("trainerQueue");
  queue.innerHTML = "";
  trainerItems.slice(0, 12).forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "trainer-item";
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${item.classification || "Position"} · ${item.cpl || 0} CPL`;
    const meta = document.createElement("span");
    meta.textContent = `${capitalize(item.phase || "middlegame")} · best ${item.best_san || item.best_uci}`;
    info.append(title, meta);
    const open = document.createElement("button");
    open.className = "secondary compact";
    open.textContent = "Train";
    open.addEventListener("click", async () => {
      if (!trainerMode) await startTrainer();
      await loadTrainerItem(index);
    });
    row.append(info, open);
    queue.appendChild(row);
  });
  if (!trainerItems.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Analyze a game; significant misses will be added automatically.";
    queue.appendChild(empty);
  }
  renderWeaknessProfile();
}

function renderWeaknessProfile() {
  const target = $("weaknessProfile");
  if (!target) return;
  const phases = { opening: [], middlegame: [], endgame: [] };
  trainerItems.forEach((item) => {
    if (phases[item.phase]) phases[item.phase].push(Number(item.cpl || 0));
  });
  target.innerHTML = "";
  const averages = Object.fromEntries(Object.entries(phases).map(([phase, values]) => [
    phase,
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
  ]));
  const max = Math.max(1, ...Object.values(averages));
  for (const phase of ["opening", "middlegame", "endgame"]) {
    const row = document.createElement("div");
    row.className = "weakness-row";
    row.innerHTML = `<strong>${capitalize(phase)}</strong><span class="weakness-bar"><i style="width:${averages[phase] * 100 / max}%"></i></span><span>${averages[phase] ? averages[phase].toFixed(0) : "—"}</span>`;
    target.appendChild(row);
  }
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
  if (reviewMode) await exitReviewMode();
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
  reviewMode = false;
  reviewSnapshot = null;
  reviewSeries = null;
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
    result: state.result || null,
    termination: state.termination || null,
    pgn_headers: state.pgn_headers || {},
    analysis: gameAnalysis?.results?.length ? gameAnalysis : null,
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
    gameAnalysis = snapshot.analysis && typeof snapshot.analysis === "object" ? snapshot.analysis : null;
    const succeeded = await act(() => api("/api/load-game", backendSnapshot(snapshot)), "Saved game restored from PNG.");
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
  if (reviewMode || busy || !state || state.game_over || state.paused) return;
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
  const succeeded = await act(() => api("/api/move", { move }), "Move played.");
  if (succeeded) {
    playUiSound(state?.check ? "check" : "move");
    scheduleComputerReply();
  }
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
  const source = currentBoardView() || state;
  const renderCaptured = (id, pieces) => {
    $(id).textContent = (Array.isArray(pieces) ? pieces : [])
      .map((symbol) => PIECES[symbol] || "")
      .join("");
  };
  renderCaptured("whiteCaptured", source.captured_by_white);
  renderCaptured("blackCaptured", source.captured_by_black);
  const balance = Number(source.material_balance || 0);
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
  const view = currentBoardView() || state;
  renderBoard();
  renderClocks();
  $("whiteClock").classList.toggle("active", !state.game_over && !state.paused && state.turn === "white");
  $("blackClock").classList.toggle("active", !state.game_over && !state.paused && state.turn === "black");
  $("fenInput").value = state.fen;
  const rawEval = Number(view.eval_cp || 0);
  const evalCp = display.evalPerspective === "turn" && view.turn === "black"
    ? -rawEval
    : rawEval;
  const cp = evalCp / 100;
  $("evalLabel").textContent = display.evalPerspective === "turn"
    ? `${capitalize(view.turn)} perspective`
    : "White perspective";
  $("evalText").textContent = `${cp >= 0 ? "+" : ""}${cp.toFixed(2)}`;
  const pct = Math.max(5, Math.min(95, 50 + 45 * Math.tanh(cp / 4)));
  $("evalBar").style.width = `${pct}%`;
  $("turnPill").textContent = trainerMode
    ? "Training"
    : variationMode
    ? "Variation"
    : reviewMode
    ? `Review · ${reviewSnapshot?.ply ?? 0}/${reviewSnapshot?.total_plies ?? 0}`
    : state.game_over ? (state.result || "Game over") : `${capitalize(state.turn)} to move`;
  const opening = view.opening || state.opening;
  $("openingEco").textContent = opening?.eco || "—";
  $("openingName").textContent = opening?.name || (state.initial_fen === STARTING_FEN ? "Opening not identified" : "Custom position");
  $("phaseLabel").textContent = capitalize(view.phase || state.phase || "opening");
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
  $("engineBtn").disabled = reviewMode || setupMode || busy || state.game_over || state.paused;
  $("undoBtn").disabled = reviewMode || setupMode || busy || state.pgn.length === 0;
  $("pauseBtn").disabled = reviewMode || setupMode || busy || state.game_over;
  $("pauseBtn").textContent = state.paused ? "Resume clocks" : "Pause clocks";
  $("drawBtn").disabled = setupMode || busy || state.game_over;
  $("drawBtn").hidden = $("humanSide").value !== "both";
  $("resignBtn").disabled = setupMode || busy || state.game_over;
  $("resignBtn").hidden = $("humanSide").value === "none";
  if (!busy) {
    $("engineStatusText").textContent = gameAnalysis?.status === "running"
      ? "Analyzing game"
      : state.game_over
      ? "Game complete"
      : state.paused
      ? "Game paused"
      : "Engine ready";
  }
  updatePlayerRoles();
  renderCapturedMaterial();
  renderRecoveryCard();
  archiveCompletedGame();
  renderRecentGames();
  renderMoves();
  renderReviewPanel();
  renderVariationWorkspace();
  renderAnalysisPanel();
  renderMultiPvPanel();
  renderOpeningExplorer();
  renderEvaluationBreakdown();
  renderTrainerPanel();
  if ($("engineTab").classList.contains("active") && evalBreakdownData?.fen !== view.fen && !evalBreakdownBusy) {
    setTimeout(refreshEvaluationBreakdown, 0);
  }
  if (trainerMode) {
    $("statusLine").textContent = $("trainerPrompt").textContent || "Personal trainer active.";
  } else if (variationMode) {
    $("statusLine").textContent = "Variation workspace · play either side without changing the saved game.";
  } else if (reviewMode) {
    $("statusLine").textContent = `Reviewing ply ${reviewSnapshot?.ply ?? 0} of ${reviewSnapshot?.total_plies ?? 0}.`;
  } else if (state.game_over) {
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
    const white = document.createElement("button");
    white.type = "button";
    white.className = "move-link";
    const whiteSan = document.createElement("span");
    whiteSan.textContent = state.pgn[i]?.san || "";
    white.appendChild(whiteSan);
    if (state.pgn[i]) {
      const ply = i + 1;
      white.dataset.ply = String(ply);
      white.classList.toggle("review-current", reviewMode && reviewSnapshot?.ply === ply);
      appendMoveGrade(white, ply);
      white.addEventListener("click", () => enterReviewMode(ply));
    } else white.disabled = true;
    target.appendChild(white);
    const black = document.createElement("button");
    black.type = "button";
    black.className = "move-link";
    const blackSan = document.createElement("span");
    blackSan.textContent = state.pgn[i + 1]?.san || "";
    black.appendChild(blackSan);
    if (state.pgn[i + 1]) {
      const ply = i + 2;
      black.dataset.ply = String(ply);
      black.classList.toggle("review-current", reviewMode && reviewSnapshot?.ply === ply);
      appendMoveGrade(black, ply);
      black.addEventListener("click", () => enterReviewMode(ply));
    } else black.disabled = true;
    target.appendChild(black);
  }
  target.scrollTop = target.scrollHeight;
}

function analysisResultForPly(ply) {
  const results = Array.isArray(gameAnalysis?.results) ? gameAnalysis.results : [];
  return results.find((result) => Number(result.ply) === Number(ply)) || null;
}

function appendMoveGrade(button, ply) {
  const result = analysisResultForPly(ply);
  if (!result) return;
  const grade = document.createElement("span");
  grade.className = `move-grade grade-${String(result.classification || "").toLowerCase()}`;
  const short = {
    Best: "Best",
    Excellent: "Excl",
    Good: "Good",
    Inaccuracy: "?!",
    Mistake: "?",
    Blunder: "??",
    Forced: "Forced",
  };
  grade.textContent = short[result.classification] || result.classification || "";
  grade.title = `${result.classification || "Move"} · ${Number(result.cpl || 0)} CPL`;
  button.appendChild(grade);
}

async function ensureReviewSeries() {
  const total = state?.moves_uci?.length || 0;
  if (reviewSeries?.total_plies === total) return reviewSeries;
  reviewSeries = await api("/api/review-series", {});
  return reviewSeries;
}

async function jumpReview(ply) {
  if (!state) return;
  reviewSnapshot = await api("/api/review", { ply });
  reviewMode = true;
  if (multiPvData && Number(multiPvData.ply) !== Number(reviewSnapshot.ply)) {
    multiPvData = null;
    multiPvArrowMove = null;
  }
  selected = null;
  render();
}

async function enterReviewMode(ply = null) {
  if (!state || setupMode || busy) return;
  retryMode = false;
  retryTargetPly = null;
  retryRevealBest = false;
  const target = ply === null ? state.moves_uci.length : ply;
  if (!reviewMode) {
    reviewWasPaused = Boolean(state.paused || state.game_over);
    clearTimeout(autoplayTimer);
    if (!state.game_over && !state.paused) {
      const paused = await act(() => api("/api/pause", { paused: true }), "Game paused for review.");
      if (!paused) return;
    }
  }
  try {
    await ensureReviewSeries();
    await jumpReview(target);
  } catch (error) {
    $("statusLine").textContent = error.message;
  }
}

async function exitReviewMode() {
  if (!reviewMode) return;
  reviewMode = false;
  reviewSnapshot = null;
  retryMode = false;
  retryTargetPly = null;
  retryRevealBest = false;
  selected = null;
  render();
  if (!reviewWasPaused && state && !state.game_over && state.paused) {
    const resumed = await act(() => api("/api/pause", { paused: false }), "Returned to live game.");
    if (resumed) scheduleComputerReply();
  }
}

function renderReviewPanel() {
  const total = state?.moves_uci?.length || 0;
  const ply = reviewMode ? Number(reviewSnapshot?.ply || 0) : total;
  $("reviewPositionLabel").textContent = retryMode && retryTargetPly
    ? `Retry ply ${retryTargetPly}`
    : reviewMode ? `Ply ${ply} / ${total}` : `${total} plies`;
  $("reviewExitBtn").hidden = !reviewMode;
  $("reviewFirstBtn").disabled = busy || total === 0 || ply <= 0;
  $("reviewPrevBtn").disabled = busy || total === 0 || ply <= 0;
  $("reviewNextBtn").disabled = busy || total === 0 || ply >= total;
  $("reviewLastBtn").disabled = busy || total === 0 || ply >= total;
  if (reviewMode && reviewSnapshot) {
    const cp = Number(reviewSnapshot.eval_cp || 0) / 100;
    $("reviewEval").textContent = `${cp >= 0 ? "+" : ""}${cp.toFixed(2)}`;
    $("reviewFen").textContent = reviewSnapshot.fen;
  } else {
    $("reviewEval").textContent = "—";
    $("reviewFen").textContent = "Select a move or graph point to review.";
  }
  renderEvalGraph();
}

function renderAnalysisPanel() {
  if (!$("analysisStatus")) return;
  const status = gameAnalysis?.status || "idle";
  const totalMoves = state?.moves_uci?.length || 0;
  const completed = Number(gameAnalysis?.completed || 0);
  const total = Number(gameAnalysis?.total || totalMoves);
  const running = status === "running";
  const complete = status === "complete";
  const failed = status === "error";
  $("analysisStatus").textContent = running
    ? `${completed}/${total}`
    : complete
    ? "Complete"
    : failed
    ? "Error"
    : "Not analyzed";
  $("analyzeGameBtn").disabled = busy || running || totalMoves === 0;
  $("analyzeGameBtn").textContent = complete ? "Analyze again" : "Analyze game";
  $("analysisProgressWrap").hidden = !running;
  const percent = total > 0 ? Math.max(0, Math.min(100, completed * 100 / total)) : 0;
  $("analysisProgress").style.width = `${percent}%`;
  $("analysisProgressText").textContent = `${completed} / ${total}`;

  const summary = gameAnalysis?.summary || {};
  const hasResults = Array.isArray(gameAnalysis?.results) && gameAnalysis.results.length > 0;
  $("analysisSummary").hidden = !hasResults;
  if (hasResults) {
    $("accuracyScore").textContent = summary.accuracy == null ? "—" : `${summary.accuracy}%`;
    $("whiteCpl").textContent = String(summary.white_avg_cpl ?? 0);
    $("blackCpl").textContent = String(summary.black_avg_cpl ?? 0);
    $("openingCpl").textContent = summary.phase_avg_cpl?.opening == null ? "—" : String(summary.phase_avg_cpl.opening);
    $("middlegameCpl").textContent = summary.phase_avg_cpl?.middlegame == null ? "—" : String(summary.phase_avg_cpl.middlegame);
    $("endgameCpl").textContent = summary.phase_avg_cpl?.endgame == null ? "—" : String(summary.phase_avg_cpl.endgame);
    $("mistakeCount").textContent = String(summary.mistakes ?? 0);
    $("blunderCount").textContent = String(summary.blunders ?? 0);
    if (complete) {
      cacheCurrentAnalysis();
      ingestTrainerFromAnalysis();
    }
  }

  const currentPly = retryMode && retryTargetPly
    ? retryTargetPly
    : reviewMode ? Number(reviewSnapshot?.ply || 0) : 0;
  const insight = currentPly > 0 ? analysisResultForPly(currentPly) : null;
  $("moveInsight").hidden = !insight;
  if (insight) {
    $("moveInsightClass").textContent = insight.classification || "Move";
    $("moveInsightCpl").textContent = `${Number(insight.cpl || 0)} CPL`;
    $("moveInsightText").textContent = insight.played_uci === insight.best_uci
      ? `${insight.played_san} matched the engine's top choice.`
      : `${insight.played_san} was played; the engine preferred ${insight.best_san}.`;
    $("moveInsightExplain").textContent = insight.explanation || "";
    const pv = Array.isArray(insight.pv_san) ? insight.pv_san : [];
    $("moveInsightPv").textContent = pv.length ? `Best line: ${pv.join(" ")}` : "";
  }
  $("retryMoveBtn").hidden = retryMode || !insight;
  $("retryBackBtn").hidden = !retryMode;
  if (failed && gameAnalysis?.error) $("statusLine").textContent = gameAnalysis.error;
}

function renderMultiPvPanel() {
  if (!$("multipvLines")) return;
  const target = $("multipvLines");
  const currentPly = reviewMode ? Number(reviewSnapshot?.ply || 0) : (state?.moves_uci?.length || 0);
  const currentFen = currentBoardView()?.fen || state?.fen || "";
  const relevant = multiPvData && String(multiPvData.fen || "") === String(currentFen);
  $("multipvBtn").disabled = multiPvBusy || gameAnalysis?.status === "running" || !state || state.game_over && !reviewMode;
  $("multipvBtn").textContent = multiPvBusy ? "Searching…" : "Analyze position";
  $("multipvMeta").textContent = multiPvBusy
    ? "Searching"
    : relevant
    ? `Depth ${multiPvData.depth} · ${Number(multiPvData.nodes || 0).toLocaleString()} nodes · ${multiPvData.elapsed_ms} ms`
    : `Ply ${currentPly}`;
  target.innerHTML = "";
  if (!relevant || !Array.isArray(multiPvData.lines) || !multiPvData.lines.length) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = multiPvBusy
      ? "Searching candidate moves in an isolated engine process…"
      : "Rank the strongest candidate moves for the live or reviewed position.";
    target.appendChild(hint);
    return;
  }
  multiPvData.lines.forEach((line) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "multipv-line";
    button.classList.toggle("selected", multiPvArrowMove === line.move);
    const displayScore = display.evalPerspective === "white" && multiPvData.turn === "black"
      ? -Number(line.score || 0)
      : Number(line.score || 0);
    const scoreText = `${displayScore >= 0 ? "+" : ""}${(displayScore / 100).toFixed(2)}`;
    const pv = Array.isArray(line.pv_san) ? line.pv_san.join(" ") : "";
    button.innerHTML = `<span class="multipv-rank">#${line.rank}</span><span class="multipv-move"></span><span class="multipv-score">${scoreText}</span><span class="multipv-pv"></span>`;
    button.querySelector(".multipv-move").textContent = line.san || line.move;
    button.querySelector(".multipv-pv").textContent = pv;
    button.addEventListener("click", () => {
      multiPvArrowMove = line.move;
      renderMultiPvPanel();
      renderBoard();
    });
    target.appendChild(button);
  });
}

function currentMovePrefix() {
  if (!state) return [];
  if (variationMode && variationWorkspace) {
    const base = (state.moves_uci || []).slice(0, variationWorkspace.origin_ply || 0);
    const branch = variationPath().slice(1).map((node) => node.move_uci).filter(Boolean);
    return [...base, ...branch];
  }
  const ply = reviewMode ? Number(reviewSnapshot?.ply || 0) : (state.moves_uci?.length || 0);
  return (state.moves_uci || []).slice(0, ply);
}

function renderOpeningExplorer() {
  const target = $("openingExplorer");
  if (!target || !state) return;
  target.innerHTML = "";
  const prefix = currentMovePrefix();
  const view = currentBoardView() || state;
  const stats = new Map();
  for (const game of recentGames) {
    if ((game.initial_fen || STARTING_FEN) !== state.initial_fen) continue;
    const moves = Array.isArray(game.moves) ? game.moves : [];
    if (moves.length <= prefix.length) continue;
    if (!prefix.every((move, index) => moves[index] === move)) continue;
    const next = moves[prefix.length];
    const row = stats.get(next) || { move: next, games: 0, white: 0, black: 0, draws: 0 };
    row.games += 1;
    const result = game.result || game.manual_result;
    if (result === "1-0") row.white += 1;
    else if (result === "0-1") row.black += 1;
    else if (result === "1/2-1/2") row.draws += 1;
    stats.set(next, row);
  }
  const rows = [...stats.values()].sort((a, b) => b.games - a.games).slice(0, 8);
  $("explorerMeta").textContent = `${rows.reduce((sum, row) => sum + row.games, 0)} matching games`;
  if (!rows.length) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "No matching recent games yet. Your personal explorer grows as you play and save games.";
    target.appendChild(hint);
    return;
  }
  rows.forEach((row) => {
    const item = document.createElement("div");
    item.className = "explorer-row";
    const move = document.createElement("strong");
    move.textContent = view.legal_san?.[row.move] || row.move;
    const outcomes = document.createElement("span");
    outcomes.textContent = `${row.white}W · ${row.draws}D · ${row.black}B`;
    const count = document.createElement("span");
    count.className = "explorer-score";
    count.textContent = `${row.games}×`;
    item.append(move, outcomes, count);
    target.appendChild(item);
  });
}

function scoreText(value) {
  const number = Number(value || 0) / 100;
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}`;
}

function renderEvaluationBreakdown() {
  if (!$("breakdownTotal")) return;
  const fen = currentBoardView()?.fen || state?.fen || "";
  const relevant = evalBreakdownData && evalBreakdownData.fen === fen;
  const set = (id, value) => { $(id).textContent = relevant ? scoreText(value) : "—"; };
  set("breakdownTotal", evalBreakdownData?.total);
  set("breakdownMaterial", evalBreakdownData?.material);
  set("breakdownMobility", evalBreakdownData?.mobility);
  set("breakdownKing", evalBreakdownData?.king_safety);
  set("breakdownPosition", evalBreakdownData?.position_pawns);
}

async function refreshEvaluationBreakdown() {
  const fen = currentBoardView()?.fen || state?.fen;
  if (!fen || evalBreakdownBusy || evalBreakdownData?.fen === fen) return;
  evalBreakdownBusy = true;
  try {
    evalBreakdownData = await api("/api/eval-breakdown", { fen });
  } catch (_) {
    evalBreakdownData = null;
  } finally {
    evalBreakdownBusy = false;
    renderEvaluationBreakdown();
  }
}

async function runMultiPv() {
  if (!state || multiPvBusy || gameAnalysis?.status === "running") return;
  const ply = reviewMode ? Number(reviewSnapshot?.ply || 0) : (state.moves_uci?.length || 0);
  const fen = currentBoardView()?.fen || state.fen;
  const lines = Math.max(1, Math.min(5, Number($("multipvCount").value) || 3));
  multiPvBusy = true;
  multiPvArrowMove = null;
  renderMultiPvPanel();
  try {
    multiPvData = await api("/api/multipv", { ply, fen, lines, budget_ms: 350 });
    $("statusLine").textContent = `Candidate lines searched to depth ${multiPvData.depth}.`;
  } catch (error) {
    multiPvData = null;
    $("statusLine").textContent = error.message;
  } finally {
    multiPvBusy = false;
    renderMultiPvPanel();
    renderBoard();
  }
}

function scheduleAnalysisPoll() {
  clearTimeout(analysisPollTimer);
  if (gameAnalysis?.status !== "running") return;
  analysisPollTimer = setTimeout(refreshAnalysisStatus, 300);
}

async function refreshAnalysisStatus() {
  try {
    gameAnalysis = await api("/api/analysis-status", {});
    render();
    scheduleAnalysisPoll();
  } catch (error) {
    clearTimeout(analysisPollTimer);
    $("statusLine").textContent = error.message;
  }
}

async function startGameAnalysis() {
  if (!state?.moves_uci?.length || gameAnalysis?.status === "running") return;
  const budgetMs = Math.max(80, Number($("analysisQuality").value) || 180);
  try {
    gameAnalysis = await api("/api/analyze-game", { budget_ms: budgetMs });
    setState(await api("/api/state"));
    $("statusLine").textContent = "Analyzing the played game locally…";
    render();
    scheduleAnalysisPoll();
  } catch (error) {
    $("statusLine").textContent = error.message;
  }
}

async function cancelGameAnalysis() {
  clearTimeout(analysisPollTimer);
  try {
    gameAnalysis = await api("/api/cancel-analysis", {});
    render();
    $("statusLine").textContent = "Game analysis canceled.";
  } catch (error) {
    $("statusLine").textContent = error.message;
  }
}

function renderEvalGraph() {
  const canvas = $("evalGraph");
  if (!canvas) return;
  const widthCss = Math.max(220, canvas.clientWidth || 320);
  const heightCss = 150;
  const scale = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(widthCss * scale);
  canvas.height = Math.round(heightCss * scale);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.scale(scale, scale);
  context.clearRect(0, 0, widthCss, heightCss);
  const styles = getComputedStyle(document.documentElement);
  const line = styles.getPropertyValue("--line").trim() || "#303730";
  const accent = styles.getPropertyValue("--accent").trim() || "#b7f268";
  const muted = styles.getPropertyValue("--muted").trim() || "#9da69c";
  context.strokeStyle = line;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, heightCss / 2);
  context.lineTo(widthCss, heightCss / 2);
  context.stroke();

  const staticValues = Array.isArray(reviewSeries?.evals) ? reviewSeries.evals : [];
  const values = staticValues.map((value, index) => {
    if (index === 0) return value;
    const analyzed = analysisResultForPly(index);
    return analyzed ? Number(analyzed.eval_after_white ?? value) : value;
  });
  if (values.length < 2) {
    context.fillStyle = muted;
    context.font = "11px system-ui";
    context.fillText("Evaluation history appears after moves are played or a PGN is opened.", 10, 22);
    return;
  }
  const xFor = (index) => index * (widthCss - 12) / Math.max(1, values.length - 1) + 6;
  const yFor = (cp) => heightCss / 2 - Math.tanh(Number(cp) / 500) * (heightCss / 2 - 10);
  context.strokeStyle = accent;
  context.lineWidth = 2;
  context.beginPath();
  values.forEach((cp, index) => {
    const x = xFor(index);
    const y = yFor(cp);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();
  const active = reviewMode ? Number(reviewSnapshot?.ply || 0) : values.length - 1;
  context.fillStyle = accent;
  context.beginPath();
  context.arc(xFor(active), yFor(values[active]), 4, 0, Math.PI * 2);
  context.fill();
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

function playUiSound(kind = "move") {
  if (!display.sound) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const context = playUiSound.context || new AudioContext();
    playUiSound.context = context;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const frequencies = { move: 420, success: 660, error: 210, check: 520 };
    oscillator.frequency.value = frequencies[kind] || frequencies.move;
    oscillator.type = kind === "error" ? "square" : "sine";
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.035, context.currentTime + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.11);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.12);
  } catch (_) {
    // Audio feedback is optional and must never interfere with chess actions.
  }
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
  const succeeded = await act(() => api("/api/engine", raw ? { budget_ms: Number(raw) } : {}), "Engine move complete.");
  if (succeeded) playUiSound(state?.check ? "check" : "move");
  return succeeded;
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

async function exportPgn() {
  try {
    const result = await api("/api/export-pgn", {});
    const pgn = String(result.pgn || "");
    if (!pgn.trim()) throw new Error("The current game could not be exported as PGN.");
    const desktop = desktopApi();
    if (desktop?.savePgn) {
      const saved = await desktop.savePgn("funchess-game.pgn", pgn);
      if (!saved) return;
    } else {
      await downloadBlob(new Blob([`${pgn.trim()}\n`], { type: "application/x-chess-pgn;charset=utf-8" }), "funchess-game.pgn");
    }
    $("statusLine").textContent = "PGN exported.";
  } catch (error) {
    $("statusLine").textContent = error.message;
  }
}

async function loadPgnText(pgn) {
  if (!String(pgn || "").trim()) return false;
  const confirmed = await confirmRestartIfNeeded(
    "Opening a PGN replaces the current game. Save the current game first if you want to keep it.",
  );
  if (!confirmed) return false;
  if (setupMode) await leaveSetupMode(false);
  if (reviewMode) {
    reviewMode = false;
    reviewSnapshot = null;
  }
  autoplay = false;
  clearTimeout(autoplayTimer);
  selected = null;
  const succeeded = await act(() => api("/api/load-pgn", { pgn }), "PGN opened for review.");
  if (!succeeded) return false;
  syncTimeControlsFromState();
  reviewSeries = null;
  reviewWasPaused = true;
  document.querySelector('[data-tab="engine"]')?.click();
  await enterReviewMode(state.moves_uci.length);
  return true;
}

async function openPgnFile() {
  const desktop = desktopApi();
  if (!desktop?.openPgn) {
    $("loadPgnInput").click();
    return;
  }
  const pgn = await desktop.openPgn();
  if (pgn) await loadPgnText(pgn);
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

function commandDefinitions() {
  return [
    { label: "New game", hint: "⌘N", action: () => $("newGameBtn").click() },
    { label: "Open PGN", hint: "Files", action: openPgnFile },
    { label: "Open FEN", hint: "Files", action: openFenFile },
    { label: "Open saved PNG", hint: "Files", action: openPngFile },
    { label: "Export PGN", hint: "Files", action: exportPgn },
    { label: "Save game PNG", hint: "Files", action: saveGamePng },
    { label: "Set up position", hint: "Board editor", action: () => { document.querySelector('[data-tab="position"]')?.click(); enterSetupMode(); } },
    { label: "Analyze game", hint: "Post-game review", action: () => { document.querySelector('[data-tab="engine"]')?.click(); startGameAnalysis(); } },
    { label: "Analyze candidate lines", hint: "MultiPV", action: () => { document.querySelector('[data-tab="engine"]')?.click(); runMultiPv(); } },
    { label: "Branch from current position", hint: "Variation workspace", action: () => { document.querySelector('[data-tab="engine"]')?.click(); startVariationWorkspace(); } },
    { label: "Start mistake trainer", hint: "Personal puzzles", action: startTrainer },
    { label: "Flip board", hint: "F", action: () => $("flipBtn").click() },
    { label: "Undo move", hint: "U", action: () => $("undoBtn").click() },
    { label: "Pause / resume", hint: "Space", action: togglePause },
    { label: "Play engine move", hint: "E", action: engineMove },
    { label: "Appearance", hint: "Themes and pieces", action: () => document.querySelector('[data-tab="display"]')?.click() },
    { label: "Recent games", hint: "Local library", action: () => document.querySelector('[data-tab="position"]')?.click() },
  ];
}

function renderCommandPalette() {
  const target = $("commandResults");
  if (!target) return;
  const query = $("commandSearch").value.trim().toLowerCase();
  const matches = commandDefinitions().filter((command) => `${command.label} ${command.hint}`.toLowerCase().includes(query));
  commandSelection = Math.max(0, Math.min(commandSelection, Math.max(0, matches.length - 1)));
  target.innerHTML = "";
  matches.forEach((command, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "command-result";
    button.classList.toggle("selected", index === commandSelection);
    const label = document.createElement("span");
    label.textContent = command.label;
    const hint = document.createElement("small");
    hint.textContent = command.hint;
    button.append(label, hint);
    button.addEventListener("click", () => runPaletteCommand(command));
    target.appendChild(button);
  });
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No matching command.";
    target.appendChild(empty);
  }
}

function openCommandPalette() {
  commandSelection = 0;
  $("commandSearch").value = "";
  renderCommandPalette();
  if (!$("commandDialog").open) $("commandDialog").showModal();
  setTimeout(() => $("commandSearch").focus(), 0);
}

function closeCommandPalette() {
  if ($("commandDialog").open) $("commandDialog").close();
}

function runPaletteCommand(command) {
  closeCommandPalette();
  Promise.resolve(command?.action?.()).catch((error) => {
    $("statusLine").textContent = error.message;
  });
}

function commandMatches() {
  const query = $("commandSearch").value.trim().toLowerCase();
  return commandDefinitions().filter((command) => `${command.label} ${command.hint}`.toLowerCase().includes(query));
}

async function handleDroppedFiles(files) {
  const file = files?.[0];
  if (!file) return;
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith(".pgn")) await loadPgnText(await file.text());
    else if (name.endsWith(".fen") || name.endsWith(".txt")) await loadFenValue((await file.text()).trim());
    else if (name.endsWith(".png")) await loadGamePng(file);
    else throw new Error("Drop a .pgn, .fen, or FunChessEngine .png file.");
  } catch (error) {
    $("statusLine").textContent = error.message;
  }
}

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.remove("active"));
    button.classList.add("active");
    $(`${button.dataset.tab}Tab`).classList.add("active");
    if (button.dataset.tab === "engine" && state?.moves_uci?.length) {
      ensureReviewSeries().then(renderReviewPanel).catch((error) => {
        $("statusLine").textContent = error.message;
      });
    }
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
$("multipvBtn").addEventListener("click", runMultiPv);
$("analyzeGameBtn").addEventListener("click", startGameAnalysis);
$("cancelAnalysisBtn").addEventListener("click", cancelGameAnalysis);
$("variationStartBtn").addEventListener("click", startVariationWorkspace);
$("variationExitBtn").addEventListener("click", exitVariationWorkspace);
$("variationBackBtn").addEventListener("click", variationBack);
$("variationDeleteBtn").addEventListener("click", deleteVariationBranch);
$("variationNag").addEventListener("change", () => { saveVariationMetadata(); renderVariationWorkspace(); });
$("variationComment").addEventListener("input", saveVariationMetadata);
$("clearAnnotationsBtn").addEventListener("click", clearCurrentAnnotations);
$("trainerStartBtn").addEventListener("click", startTrainer);
$("trainerHintBtn").addEventListener("click", trainerHint);
$("trainerExitBtn").addEventListener("click", exitTrainer);
$("clearTrainerBtn").addEventListener("click", clearTrainer);
$("resumeRecoveryBtn").addEventListener("click", resumeRecovery);
$("discardRecoveryBtn").addEventListener("click", discardRecovery);
$("clearRecentGamesBtn").addEventListener("click", clearRecentGames);
$("copyFenBtn").addEventListener("click", copyFen);
$("downloadFenBtn").addEventListener("click", downloadFen);
$("openPgnBtn").addEventListener("click", openPgnFile);
$("exportPgnBtn").addEventListener("click", exportPgn);
$("loadPgnInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    await loadPgnText(await file.text());
  } catch (error) {
    $("statusLine").textContent = error.message;
  }
});
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
$("reviewGameBtn").addEventListener("click", () => {
  setTimeout(() => {
    document.querySelector('[data-tab="engine"]')?.click();
    enterReviewMode(state?.moves_uci?.length || 0);
  }, 0);
});

$("reviewFirstBtn").addEventListener("click", () => enterReviewMode(0));
$("reviewPrevBtn").addEventListener("click", () => enterReviewMode(Math.max(0, Number(reviewSnapshot?.ply ?? state?.moves_uci?.length ?? 0) - 1)));
$("reviewNextBtn").addEventListener("click", () => enterReviewMode(Math.min(state?.moves_uci?.length || 0, Number(reviewSnapshot?.ply ?? 0) + 1)));
$("reviewLastBtn").addEventListener("click", () => enterReviewMode(state?.moves_uci?.length || 0));
$("reviewExitBtn").addEventListener("click", exitReviewMode);
$("retryMoveBtn").addEventListener("click", startRetryMove);
$("retryBackBtn").addEventListener("click", exitRetryMove);
$("evalGraph").addEventListener("click", (event) => {
  const total = state?.moves_uci?.length || 0;
  if (!total) return;
  const rect = $("evalGraph").getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
  enterReviewMode(Math.round(ratio * total));
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
$("soundToggle").addEventListener("change", (event) => updateDisplay({ sound: event.target.checked }));
$("resetDisplayBtn").addEventListener("click", () => {
  display = { ...DISPLAY_DEFAULTS };
  saveDisplaySettings();
  applyDisplaySettings();
});

$("commandCloseBtn").addEventListener("click", closeCommandPalette);
$("commandSearch").addEventListener("input", () => {
  commandSelection = 0;
  renderCommandPalette();
});
$("commandSearch").addEventListener("keydown", (event) => {
  const matches = commandMatches();
  if (event.key === "ArrowDown") {
    event.preventDefault();
    commandSelection = Math.min(matches.length - 1, commandSelection + 1);
    renderCommandPalette();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    commandSelection = Math.max(0, commandSelection - 1);
    renderCommandPalette();
  } else if (event.key === "Enter" && matches[commandSelection]) {
    event.preventDefault();
    runPaletteCommand(matches[commandSelection]);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeCommandPalette();
  }
});

let fileDragDepth = 0;
window.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  fileDragDepth += 1;
  $("dropOverlay").hidden = false;
});
window.addEventListener("dragover", (event) => {
  if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
});
window.addEventListener("dragleave", (event) => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  fileDragDepth = Math.max(0, fileDragDepth - 1);
  if (!fileDragDepth) $("dropOverlay").hidden = true;
});
window.addEventListener("drop", (event) => {
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault();
  fileDragDepth = 0;
  $("dropOverlay").hidden = true;
  handleDroppedFiles(event.dataTransfer.files);
});

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openCommandPalette();
    return;
  }
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
  if (trainerMode) {
    if (key === "escape") {
      event.preventDefault();
      exitTrainer();
    } else if (key === "f") {
      flipped = !flipped;
      renderBoard();
    }
    return;
  }
  if (variationMode) {
    if (key === "escape") {
      event.preventDefault();
      exitVariationWorkspace();
    } else if (key === "arrowleft") {
      event.preventDefault();
      variationBack();
    } else if (key === "f") {
      flipped = !flipped;
      renderBoard();
    }
    return;
  }
  if (reviewMode) {
    if (key === "escape") {
      event.preventDefault();
      if (retryMode) exitRetryMove();
      else exitReviewMode();
    } else if (key === "arrowleft") {
      event.preventDefault();
      enterReviewMode(Math.max(0, Number(reviewSnapshot?.ply || 0) - 1));
    } else if (key === "arrowright") {
      event.preventDefault();
      enterReviewMode(Math.min(state?.moves_uci?.length || 0, Number(reviewSnapshot?.ply || 0) + 1));
    } else if (key === "home") {
      event.preventDefault();
      enterReviewMode(0);
    } else if (key === "end") {
      event.preventDefault();
      enterReviewMode(state?.moves_uci?.length || 0);
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
    else if (command === "open-pgn") openPgnFile();
    else if (command === "open-png") openPngFile();
    else if (command === "save-fen") downloadFen();
    else if (command === "save-pgn") exportPgn();
    else if (command === "save-png") saveGamePng();
    else if (command === "undo") $("undoBtn").click();
    else if (command === "flip") $("flipBtn").click();
    else if (command === "engine-move") $("engineBtn").click();
    else if (command === "pause") $("pauseBtn").click();
    else if (command === "analyze-game") {
      document.querySelector('[data-tab="engine"]')?.click();
      startGameAnalysis();
    }
    else if (command === "multipv") {
      document.querySelector('[data-tab="engine"]')?.click();
      runMultiPv();
    }
    else if (command === "variation") {
      document.querySelector('[data-tab="engine"]')?.click();
      startVariationWorkspace();
    }
    else if (command === "trainer") startTrainer();
    else if (command === "command-palette") openCommandPalette();
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
  if (value.analysis_status && value.analysis_status !== "idle") refreshAnalysisStatus();
}).catch((error) => {
  $("statusLine").textContent = error.message;
});
setInterval(renderClocks, 100);
setInterval(() => {
  if (recoveryResolved && state && !state.paused && !state.game_over) persistRecoverySnapshot();
}, 2_000);
window.addEventListener("beforeunload", () => {
  if (recoveryResolved) persistRecoverySnapshot();
  try {
    localStorage.setItem(RECOVERY_CLEAN_EXIT_KEY, "1");
  } catch (_) {
    // Browser storage is optional.
  }
});
