const PIECES = {
  P: "♙", N: "♘", B: "♗", R: "♖", Q: "♕", K: "♔",
  p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚",
};
const STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const DISPLAY_KEY = "funChessEngine.display.v1";
const RECOVERY_KEY = "funChessEngine.recovery.v1";
const RECENTS_KEY = "funChessEngine.recents.v1";
const TRAINER_KEY = "funChessEngine.trainer.v1";
const ANNOTATIONS_KEY = "funChessEngine.annotations.v1";
const BENCHMARK_HISTORY_KEY = "funChessEngine.benchmarks.v1";
const VARIATIONS_KEY = "funChessEngine.variations.v1";
const DURABLE_DB_NAME = "FunChessEngine.LocalData";
const DURABLE_DB_VERSION = 1;
const DURABLE_STORE = "metadata";
const MAX_FEN_BYTES = 64 * 1024;
const MAX_PGN_BYTES = 2 * 1024 * 1024;
const MAX_SAVE_BYTES = 50 * 1024 * 1024;
const MAX_RECOVERY_BYTES = 512 * 1024;
const MAX_RESTART_SNAPSHOT_BYTES = 512 * 1024;
const DISPLAY_DEFAULTS = {
  theme: "forest",
  accent: "green",
  appearance: "dark",
  pieceTheme: "classic",
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
let homeAutoPaused = false;
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
let autoPositionAnalysisTimer = null;
let autoPositionAnalysisFen = null;
let autoPositionAnalysisQueued = false;
let variationMode = false;
let variationWorkspace = null;
let variationNodeId = null;
let savedVariationWorkspaces = loadVariationWorkspaces();
let annotationDragFrom = null;
let annotations = loadAnnotations();
let trainerItems = loadTrainerItems();
let trainerMode = false;
let trainerSnapshot = null;
let trainerItemIndex = -1;
let trainerSelected = null;
let trainerRevealBest = false;
let trainerAwaitingNext = false;
let trainerSessionSolved = 0;
let trainerSessionStreak = 0;
let trainerWasPaused = false;
let commandSelection = 0;
let evalBreakdownData = null;
let evalBreakdownBusy = false;
let evalBreakdownQueued = false;
let devLabBusy = false;
let benchmarkHistory = loadBenchmarkHistory();
let boardFocusSquare = null;
let durableDbPromise = null;
let durableMetadataHydrated = false;
const durableMetadataDirty = new Set();
const durableWriteChains = new Map();
let persistenceErrorShown = false;

const $ = (id) => document.getElementById(id);

function setStatus(message, tone = "info") {
  const target = $("statusLine");
  const launcherTarget = $("startStatus");
  const text = String(message || "");
  if (target) {
    target.textContent = text;
    target.dataset.tone = tone;
  }
  if (launcherTarget && !$("startScreen")?.hidden) {
    launcherTarget.textContent = text;
    launcherTarget.dataset.tone = tone;
  }
}

function reportPersistenceError(error) {
  console.warn("Local metadata persistence failed:", error);
  if (persistenceErrorShown) return;
  persistenceErrorShown = true;
  setStatus("Some local library/training metadata could not be saved. Free browser storage and try again.", "error");
}

function openDurableDb() {
  if (durableDbPromise) return durableDbPromise;
  durableDbPromise = new Promise((resolve, reject) => {
    const idb = globalThis.indexedDB;
    if (!idb) {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }
    const request = idb.open(DURABLE_DB_NAME, DURABLE_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DURABLE_STORE)) {
        request.result.createObjectStore(DURABLE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open IndexedDB."));
    request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked by another window."));
  });
  return durableDbPromise;
}

async function readDurableValue(key) {
  const db = await openDurableDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DURABLE_STORE, "readonly");
    const request = transaction.objectStore(DURABLE_STORE).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(`Could not read ${key}.`));
  });
}

async function writeDurableValue(key, value) {
  const db = await openDurableDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DURABLE_STORE, "readwrite");
    transaction.objectStore(DURABLE_STORE).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error(`Could not save ${key}.`));
    transaction.onabort = () => reject(transaction.error || new Error(`Saving ${key} was aborted.`));
  });
}

function persistDurableValue(key, value) {
  durableMetadataDirty.add(key);
  let serialized;
  let snapshot;
  let localError = null;
  try {
    serialized = JSON.stringify(value);
    snapshot = JSON.parse(serialized);
    // Keep a synchronous fallback until the IndexedDB transaction commits.
    localStorage.setItem(key, serialized);
  } catch (error) {
    localError = error;
    try {
      snapshot = snapshot ?? JSON.parse(JSON.stringify(value));
    } catch (cloneError) {
      reportPersistenceError(cloneError);
      return;
    }
  }

  const previous = durableWriteChains.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    await writeDurableValue(key, snapshot);
    try {
      localStorage.removeItem(key);
    } catch (_) {
      // IndexedDB is authoritative once its transaction commits.
    }
  }).catch((error) => {
    if (localError) reportPersistenceError(error);
    else console.warn(`IndexedDB save failed for ${key}; localStorage fallback retained.`, error);
  });
  durableWriteChains.set(key, pending);
}

function durableMetadataSpecs() {
  return [
    {
      key: RECENTS_KEY,
      get: () => recentGames,
      set: (value) => { recentGames = Array.isArray(value) ? value.filter((item) => item && Array.isArray(item.moves)).slice(0, 24) : []; },
    },
    {
      key: TRAINER_KEY,
      get: () => trainerItems,
      set: (value) => { trainerItems = Array.isArray(value) ? value.filter((item) => item?.fen && item?.best_uci).slice(0, 250) : []; },
    },
    {
      key: VARIATIONS_KEY,
      get: () => savedVariationWorkspaces,
      set: (value) => { savedVariationWorkspaces = value && typeof value === "object" && !Array.isArray(value) ? value : {}; },
    },
    {
      key: ANNOTATIONS_KEY,
      get: () => annotations,
      set: (value) => { annotations = value && typeof value === "object" && !Array.isArray(value) ? value : {}; },
    },
    {
      key: BENCHMARK_HISTORY_KEY,
      get: () => benchmarkHistory,
      set: (value) => { benchmarkHistory = Array.isArray(value) ? value.slice(0, 20) : []; },
    },
  ];
}

async function hydrateDurableMetadata() {
  try {
    await openDurableDb();
    for (const spec of durableMetadataSpecs()) {
      if (durableMetadataDirty.has(spec.key)) {
        persistDurableValue(spec.key, spec.get());
        continue;
      }
      let localRaw = null;
      try {
        localRaw = localStorage.getItem(spec.key);
      } catch (_) {
        localRaw = null;
      }
      if (localRaw !== null) {
        try {
          spec.set(JSON.parse(localRaw));
          await writeDurableValue(spec.key, spec.get());
          try { localStorage.removeItem(spec.key); } catch (_) {}
          continue;
        } catch (error) {
          console.warn(`Could not migrate ${spec.key}; checking IndexedDB copy instead.`, error);
        }
      }
      const stored = await readDurableValue(spec.key);
      if (stored !== undefined) spec.set(stored);
    }
    durableMetadataHydrated = true;
    if (state) {
      renderRecentGames();
      renderOpeningExplorer();
      renderTrainerPanel();
      renderDeveloperHistory();
      renderVariationWorkspace();
      renderBoard();
    }
  } catch (error) {
    durableMetadataHydrated = true;
    console.warn("IndexedDB metadata store unavailable; using localStorage fallback.", error);
  }
}

function setEngineStatus(message, mode = "ready") {
  const text = $("engineStatusText");
  const badge = $("engineBadge");
  if (text) text.textContent = message;
  if (!badge) return;
  badge.classList.toggle("is-busy", mode === "busy");
  badge.classList.toggle("is-error", mode === "error");
  badge.setAttribute("aria-busy", mode === "busy" ? "true" : "false");
}

function showConnectionError(message) {
  const banner = $("connectionBanner");
  if (!banner) return;
  $("connectionMessage").textContent = message || "The local backend could not be reached.";
  banner.hidden = false;
}

function clearConnectionError() {
  const banner = $("connectionBanner");
  if (banner) banner.hidden = true;
}

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
    const saved = JSON.parse(localStorage.getItem(RECOVERY_KEY) || "null");
    if (!saved || saved.version !== 1 || !Array.isArray(saved.moves)) return null;
    if (!saved.moves.length && saved.initial_fen === STARTING_FEN) return null;
    return saved;
  } catch (_) {
    return null;
  }
}

function loadRecentGames() {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(saved)
      ? saved.filter((item) => item && Array.isArray(item.moves)).slice(0, 24)
      : [];
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
  const entries = Object.entries(annotations).slice(-160);
  annotations = Object.fromEntries(entries);
  persistDurableValue(ANNOTATIONS_KEY, annotations);
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
  trainerItems = trainerItems.slice(0, 250);
  persistDurableValue(TRAINER_KEY, trainerItems);
}

function loadBenchmarkHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(BENCHMARK_HISTORY_KEY) || "[]");
    return Array.isArray(saved) ? saved.slice(0, 20) : [];
  } catch (_) {
    return [];
  }
}

function saveBenchmarkHistory() {
  benchmarkHistory = benchmarkHistory.slice(0, 20);
  persistDurableValue(BENCHMARK_HISTORY_KEY, benchmarkHistory);
}

function loadVariationWorkspaces() {
  try {
    const saved = JSON.parse(localStorage.getItem(VARIATIONS_KEY) || "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  } catch (_) {
    return {};
  }
}

function persistVariationWorkspaces() {
  const entries = Object.entries(savedVariationWorkspaces)
    .sort(([, left], [, right]) => String(right?.updated_at || "").localeCompare(String(left?.updated_at || "")))
    .slice(0, 20);
  savedVariationWorkspaces = Object.fromEntries(entries);
  persistDurableValue(VARIATIONS_KEY, savedVariationWorkspaces);
}

function variationStorageKey(originPly) {
  const initial = state?.initial_fen || STARTING_FEN;
  const moves = (state?.moves_uci || []).slice(0, originPly).join(",");
  return `${initial}|${moves}|ply:${originPly}`;
}

function saveCurrentVariationWorkspace() {
  if (!variationWorkspace?.storage_key || !variationWorkspace.root) return;
  variationWorkspace.last_node = variationNodeId;
  variationWorkspace.updated_at = new Date().toISOString();
  savedVariationWorkspaces[variationWorkspace.storage_key] = variationWorkspace;
  persistVariationWorkspaces();
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
  recentGames = recentGames.slice(0, 24);
  persistDurableValue(RECENTS_KEY, recentGames);
}

function trimRecentGames() {
  while (recentGames.length > 24) {
    let removeIndex = -1;
    for (let index = recentGames.length - 1; index >= 0; index -= 1) {
      if (!recentGames[index]?.favorite) {
        removeIndex = index;
        break;
      }
    }
    if (removeIndex < 0) removeIndex = recentGames.length - 1;
    recentGames.splice(removeIndex, 1);
  }
}

function gameSignature(snapshot) {
  return `${snapshot.initial_fen || STARTING_FEN}|${(snapshot.moves || []).join(",")}|${snapshot.result || snapshot.manual_result || "*"}`;
}

function backendSnapshot(snapshot) {
  const { analysis: _analysis, ...rest } = snapshot || {};
  return rest;
}

function recoveryGameSnapshot() {
  const snapshot = gameSnapshot();
  for (const key of ["moves", "clock_history", "recorded_clock_history"]) {
    if (Array.isArray(snapshot[key]) && snapshot[key].length > 1_000) {
      throw new Error("Game is too long for a bounded recovery snapshot.");
    }
  }
  // Whole-game analysis can be much larger than the game itself. Preserve it
  // when it fits, but prefer a recoverable game over losing recovery entirely.
  if (snapshot.analysis && utf8ByteLength(JSON.stringify(snapshot)) > MAX_RECOVERY_BYTES) {
    snapshot.analysis = null;
  }
  return snapshot;
}

function boundedDesktopRestartSnapshot() {
  const snapshot = backendSnapshot(recoveryGameSnapshot());
  const encoded = new TextEncoder().encode(JSON.stringify(snapshot));
  if (encoded.byteLength > MAX_RESTART_SNAPSHOT_BYTES) {
    throw new Error("Current game is too large to restart the backend safely.");
  }
  return snapshot;
}

function archiveCurrentGame(allowIncomplete = false) {
  if (!state?.moves_uci?.length || (!allowIncomplete && !state.game_over)) return;
  const snapshot = gameSnapshot();
  const signature = gameSignature(snapshot);
  if (signature === archivedResultKey) return;
  archivedResultKey = signature;
  const existing = recentGames.findIndex((item) => gameSignature(item) === signature);
  if (existing >= 0) {
    const previous = recentGames[existing];
    snapshot.favorite = Boolean(previous.favorite);
    if (!snapshot.analysis && previous.analysis) snapshot.analysis = previous.analysis;
    recentGames.splice(existing, 1);
  }
  snapshot.recent_id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  recentGames.unshift(snapshot);
  trimRecentGames();
  saveRecentGames();
}

function archiveCompletedGame() {
  archiveCurrentGame(false);
}

function renderRecentGames() {
  const target = $("recentGamesList");
  if (!target) return;
  target.innerHTML = "";
  const query = $("recentGamesSearch")?.value.trim().toLowerCase() || "";
  const favoritesOnly = Boolean($("recentFavoritesOnly")?.checked);
  const entries = recentGames
    .map((snapshot, index) => ({ snapshot, index }))
    .filter(({ snapshot }) => {
      if (favoritesOnly && !snapshot.favorite) return false;
      if (!query) return true;
      const saved = snapshot.saved_at ? new Date(snapshot.saved_at) : null;
      const when = saved && !Number.isNaN(saved.getTime())
        ? `${saved.toLocaleDateString()} ${saved.toLocaleTimeString()}`
        : "saved game";
      const opening = snapshot.opening?.name || snapshot.opening?.eco || "";
      const result = snapshot.result || snapshot.manual_result || "*";
      const mode = snapshot.human_side || "";
      const headers = snapshot.pgn_headers || {};
      const people = `${headers.White || ""} ${headers.Black || ""} ${headers.Event || ""}`;
      return `${opening} ${snapshot.opening?.eco || ""} ${result} ${mode} ${when} ${people}`
        .toLowerCase()
        .includes(query);
    })
    .sort((left, right) => Number(Boolean(right.snapshot.favorite)) - Number(Boolean(left.snapshot.favorite)));
  $("recentGameCount").textContent = query || favoritesOnly
    ? `${entries.length}/${recentGames.length}`
    : String(recentGames.length);
  $("clearRecentGamesBtn").hidden = recentGames.length === 0;
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "hint recent-empty";
    empty.textContent = recentGames.length
      ? "No saved games match this filter."
      : "Completed and imported games will appear here.";
    target.appendChild(empty);
    return;
  }
  entries.forEach(({ snapshot, index }) => {
    const row = document.createElement("div");
    row.className = "recent-game-row";
    row.classList.toggle("favorite", Boolean(snapshot.favorite));
    const info = document.createElement("div");
    const result = snapshot.result || snapshot.manual_result || "*";
    const moves = snapshot.moves?.length || 0;
    const saved = snapshot.saved_at ? new Date(snapshot.saved_at) : null;
    const when = saved && !Number.isNaN(saved.getTime()) ? saved.toLocaleDateString() : "Saved game";
    const title = document.createElement("strong");
    const white = snapshot.pgn_headers?.White;
    const black = snapshot.pgn_headers?.Black;
    title.textContent = white || black
      ? `${white || "White"} – ${black || "Black"} · ${result}`
      : `${result} · ${Math.ceil(moves / 2)} moves`;
    const meta = document.createElement("span");
    const opening = snapshot.opening?.name || snapshot.opening?.eco || "Opening not recorded";
    meta.textContent = `${opening} · ${when}`;
    info.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "recent-game-actions";
    const favorite = document.createElement("button");
    favorite.className = "secondary compact recent-favorite";
    favorite.textContent = snapshot.favorite ? "★" : "☆";
    favorite.title = snapshot.favorite ? "Remove from favorites" : "Add to favorites";
    favorite.setAttribute("aria-label", favorite.title);
    favorite.addEventListener("click", () => toggleRecentFavorite(index));
    const open = document.createElement("button");
    open.className = "secondary compact";
    open.textContent = "Review";
    open.addEventListener("click", () => openRecentGame(index));
    const remove = document.createElement("button");
    remove.className = "text-button compact recent-delete";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => deleteRecentGame(index));
    actions.append(favorite, open, remove);
    row.append(info, actions);
    target.appendChild(row);
  });
}

function toggleRecentFavorite(index) {
  const snapshot = recentGames[index];
  if (!snapshot) return;
  snapshot.favorite = !snapshot.favorite;
  saveRecentGames();
  renderRecentGames();
  renderOpeningExplorer();
}

function deleteRecentGame(index) {
  if (!recentGames[index]) return;
  recentGames.splice(index, 1);
  saveRecentGames();
  renderRecentGames();
  renderOpeningExplorer();
}

async function openRecentGame(index) {
  const snapshot = recentGames[index];
  if (!snapshot) return;
  const confirmed = await confirmRestartIfNeeded(
    "Opening a recent game replaces the current game. Save anything you want to keep first.",
  );
  if (!confirmed) return;
  const mode = ["white", "black", "both", "none"].includes(snapshot.human_side)
    ? snapshot.human_side
    : "white";
  const succeeded = await act(
    () => api("/api/load-game", backendSnapshot(snapshot)),
    "Recent game opened for review.",
    clearTransientUiForReplacement,
  );
  if (succeeded) {
    $("humanSide").value = mode;
    previousHumanSide = mode;
    autoplay = false;
    gameAnalysis = snapshot.analysis && typeof snapshot.analysis === "object" ? snapshot.analysis : null;
    syncTimeControlsFromState();
    orientForHuman();
    render();
    await activateTab(document.querySelector('[data-tab="engine"]'));
  }
}

async function clearRecentGames() {
  if (!recentGames.length) return;
  const confirmed = await confirmAction(
    "Clear game library?",
    `Delete all ${recentGames.length} locally saved game${recentGames.length === 1 ? "" : "s"}, including favorites?`,
    "Clear library",
    true,
  );
  if (!confirmed) return;
  recentGames = [];
  archivedResultKey = null;
  saveRecentGames();
  renderRecentGames();
  renderOpeningExplorer();
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
    const serialized = JSON.stringify(recoveryGameSnapshot());
    if (new TextEncoder().encode(serialized).byteLength > MAX_RECOVERY_BYTES) {
      throw new Error("Session recovery snapshot is too large to save safely.");
    }
    localStorage.setItem(RECOVERY_KEY, serialized);
  } catch (error) {
    console.warn("Session recovery save failed:", error);
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

async function resumeRecovery(scheduleReply = true) {
  if (!startupRecovery) return false;
  const snapshot = startupRecovery;
  const confirmed = await confirmRestartIfNeeded(
    "Restoring the recovered game replaces the game currently on the board.",
    false,
  );
  if (!confirmed) return false;
  const mode = ["white", "black", "both", "none"].includes(snapshot.human_side)
    ? snapshot.human_side
    : "white";
  const succeeded = await act(
    () => api("/api/load-game", backendSnapshot(snapshot)),
    "Recovered autosaved game.",
    clearTransientUiForReplacement,
  );
  if (succeeded) {
    $("humanSide").value = mode;
    previousHumanSide = mode;
    autoplay = mode === "none" && Boolean(snapshot.autoplay);
    recoveryResolved = true;
    startupRecovery = null;
    gameAnalysis = snapshot.analysis && typeof snapshot.analysis === "object" ? snapshot.analysis : null;
    syncTimeControlsFromState();
    orientForHuman();
    render();
    if (scheduleReply) scheduleComputerReply();
    persistRecoverySnapshot();
  }
  return succeeded;
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
    const merged = { ...DISPLAY_DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) };
    // Logo color used to be configurable. Keep the mark intentionally fixed
    // and independent from appearance/accent settings, including old profiles.
    delete merged.logoColor;
    const legacyAccents = { lime: "green", cyan: "blue", violet: "purple", amber: "orange" };
    merged.accent = legacyAccents[merged.accent] || merged.accent;
    if (!["green", "blue", "purple", "orange"].includes(merged.accent)) {
      merged.accent = DISPLAY_DEFAULTS.accent;
    }
    if (!["dark", "light"].includes(merged.appearance)) merged.appearance = DISPLAY_DEFAULTS.appearance;
    if (!["forest", "walnut", "ocean", "slate"].includes(merged.theme)) merged.theme = DISPLAY_DEFAULTS.theme;
    if (!["classic", "clean", "bold", "soft", "outline", "tournament"].includes(merged.pieceTheme)) {
      merged.pieceTheme = DISPLAY_DEFAULTS.pieceTheme;
    }
    if (!["white", "turn"].includes(merged.evalPerspective)) merged.evalPerspective = DISPLAY_DEFAULTS.evalPerspective;
    const pieceScale = Number(merged.pieceScale);
    merged.pieceScale = Number.isFinite(pieceScale)
      ? Math.max(66, Math.min(90, pieceScale))
      : DISPLAY_DEFAULTS.pieceScale;
    for (const key of ["coords", "targets", "lastMove", "autoOrient", "sound"]) {
      if (typeof merged[key] !== "boolean") merged[key] = DISPLAY_DEFAULTS[key];
    }
    return merged;
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
  root.dataset.appearance = display.appearance;
  root.dataset.pieceTheme = display.pieceTheme;
  root.style.setProperty("--piece-size", `${display.pieceScale / 8}cqw`);

  $("themeSelect").value = display.theme;
  $("accentSelect").value = display.accent;
  $("appearanceSelect").value = display.appearance;
  $("pieceThemeSelect").value = display.pieceTheme;
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
  let response;
  try {
    response = await fetch(path, options);
    clearConnectionError();
  } catch (_) {
    const message = "Cannot reach the local engine backend. Check that FunChessEngine is running, then retry.";
    showConnectionError(message);
    throw new Error(message);
  }
  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw new Error(`Server returned an invalid response (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value ?? "")).byteLength;
}

function assertBrowserFileSize(file, maxBytes, label) {
  if (!file || !Number.isFinite(file.size)) return;
  if (file.size > maxBytes) {
    const maxMb = Math.max(1, Math.floor(maxBytes / 1024 / 1024));
    throw new Error(`${label} is too large. Maximum size is ${maxMb} MB.`);
  }
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
  const order = squareOrder();
  if (!boardFocusSquare || !order.includes(boardFocusSquare)) {
    const turn = setupMode ? null : view?.turn;
    boardFocusSquare = Object.keys(boardMap).find((square) => {
      const symbol = boardMap[square];
      return !turn || ((turn === "white") === (symbol === symbol.toUpperCase()));
    }) || order[0];
  }
  const targets = setupMode || (reviewMode && !retryMode && !variationMode && !trainerMode)
    ? new Set()
    : legalTargets(selected);
  const lastFrom = !setupMode && display.lastMove ? view?.last_move?.slice(0, 2) : null;
  const lastTo = !setupMode && display.lastMove ? view?.last_move?.slice(2, 4) : null;
  const marks = currentAnnotations();

  for (const square of order) {
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
    button.tabIndex = square === boardFocusSquare ? 0 : -1;
    button.addEventListener("focus", () => { boardFocusSquare = square; });
    button.addEventListener("keydown", (event) => handleBoardSquareKeydown(event, square));
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

function handleBoardSquareKeydown(event, square) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
  const order = squareOrder();
  const index = order.indexOf(square);
  if (index < 0) return;
  const row = Math.floor(index / 8);
  const column = index % 8;
  let nextIndex = index;
  if (event.key === "ArrowLeft" && column > 0) nextIndex -= 1;
  else if (event.key === "ArrowRight" && column < 7) nextIndex += 1;
  else if (event.key === "ArrowUp" && row > 0) nextIndex -= 8;
  else if (event.key === "ArrowDown" && row < 7) nextIndex += 8;
  else return;
  event.preventDefault();
  boardFocusSquare = order[nextIndex];
  $("board")?.querySelector(`[data-square="${boardFocusSquare}"]`)?.focus();
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
  if (retryMode) {
    setStatus("Return from Retry Move before starting a variation workspace.", "error");
    return;
  }
  if (!reviewMode) await enterReviewMode(state.moves_uci?.length || 0);
  if (!reviewSnapshot) return;
  const originPly = Number(reviewSnapshot.ply || 0);
  const storageKey = variationStorageKey(originPly);
  const restored = savedVariationWorkspaces[storageKey];
  if (restored?.root && restored?.nodes?.[restored.root]) {
    variationWorkspace = restored;
    variationWorkspace.storage_key = storageKey;
    variationNodeId = restored.nodes[restored.last_node] ? restored.last_node : restored.root;
    variationMode = true;
    selected = null;
    render();
    scheduleAutoPositionAnalysis(true);
    setStatus("Restored your saved analysis workspace for this position.", "success");
    return;
  }
  const root = newVariationNode({ ...reviewSnapshot });
  variationWorkspace = {
    root: root.id,
    origin_ply: originPly,
    storage_key: storageKey,
    nodes: { [root.id]: root },
  };
  variationNodeId = root.id;
  variationMode = true;
  selected = null;
  saveCurrentVariationWorkspace();
  render();
  scheduleAutoPositionAnalysis(true);
  setStatus("Variation workspace active — play either side to explore branches.", "success");
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
  await playVariationMove(move);
}

async function playVariationMove(move) {
  const node = variationNode();
  const snapshot = node?.snapshot;
  if (!variationMode || !snapshot || busy || snapshot.game_over) return false;
  if (!(snapshot.legal_moves || []).includes(move)) {
    setStatus("That continuation is not legal from the current variation position.", "error");
    return false;
  }
  const existing = node.children
    .map((id) => variationWorkspace.nodes[id])
    .find((child) => child?.move_uci === move);
  if (existing) {
    variationNodeId = existing.id;
    saveCurrentVariationWorkspace();
    render();
    scheduleAutoPositionAnalysis();
    return true;
  }
  if (Object.keys(variationWorkspace.nodes).length >= 500) {
    setStatus("This saved study has reached its 500-position local limit.", "error");
    return false;
  }
  try {
    const childSnapshot = await api("/api/variation-move", { fen: snapshot.fen, move });
    const child = newVariationNode(childSnapshot, node.id, move, childSnapshot.move_san || move);
    variationWorkspace.nodes[child.id] = child;
    node.children.push(child.id);
    variationNodeId = child.id;
    saveCurrentVariationWorkspace();
    playUiSound("move");
    render();
    scheduleAutoPositionAnalysis();
    return true;
  } catch (error) {
    setStatus(error.message, "error");
    return false;
  }
}

function navigateVariation(id) {
  if (!variationWorkspace?.nodes[id]) return;
  variationNodeId = id;
  selected = null;
  saveCurrentVariationWorkspace();
  render();
  scheduleAutoPositionAnalysis();
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
  saveCurrentVariationWorkspace();
  render();
  scheduleAutoPositionAnalysis();
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
  saveCurrentVariationWorkspace();
}

function resetVariationWorkspace() {
  if (!variationWorkspace) return;
  const oldRoot = variationWorkspace.nodes[variationWorkspace.root];
  const storageKey = variationWorkspace.storage_key;
  if (!oldRoot?.snapshot || !storageKey) return;
  delete savedVariationWorkspaces[storageKey];
  const root = newVariationNode({ ...oldRoot.snapshot });
  variationWorkspace = {
    root: root.id,
    origin_ply: variationWorkspace.origin_ply,
    storage_key: storageKey,
    nodes: { [root.id]: root },
  };
  variationNodeId = root.id;
  selected = null;
  saveCurrentVariationWorkspace();
  render();
  scheduleAutoPositionAnalysis(true);
  setStatus("Saved analysis workspace reset to its root position.", "success");
}

async function exitVariationWorkspace() {
  if (!variationMode) return;
  saveCurrentVariationWorkspace();
  variationMode = false;
  variationWorkspace = null;
  variationNodeId = null;
  selected = null;
  render();
  scheduleAutoPositionAnalysis();
  setStatus("Study saved locally. Returned to the main line.", "success");
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
  trainerAwaitingNext = false;
  trainerSnapshot = await api("/api/position", { fen: item.fen });
  trainerMode = true;
  render();
  return true;
}

async function startTrainer() {
  if (!trainerItems.length || busy || setupMode || variationMode) return;
  if (reviewMode || retryMode) {
    setStatus("Return to the live game before starting Personal Trainer.", "error");
    return;
  }
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
  trainerAwaitingNext = true;
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
}

async function nextTrainerItem() {
  if (!trainerMode) return;
  trainerAwaitingNext = false;
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

async function exitTrainer(resumeGame = true) {
  trainerMode = false;
  trainerSnapshot = null;
  trainerItemIndex = -1;
  trainerSelected = null;
  trainerRevealBest = false;
  trainerAwaitingNext = false;
  selected = null;
  render();
  if (resumeGame && !trainerWasPaused && state && !state.game_over && state.paused) {
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
  $("trainerNextBtn").hidden = !trainerMode || !trainerAwaitingNext;
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

function hasGameProgress() {
  if (!state) return false;
  return Boolean(state.pgn?.length) || state.initial_fen !== STARTING_FEN;
}

function launcherVisible() {
  return Boolean($("startScreen") && !$("startScreen").hidden);
}

function renderLauncher() {
  const summary = $("startSessionSummary");
  const playLabel = $("startPlayLabel");
  if (!summary || !playLabel) return;
  if (!state) {
    summary.textContent = "Connecting to local engine…";
    playLabel.textContent = "Start playing";
    return;
  }
  if (!recoveryResolved && startupRecovery) {
    const plies = startupRecovery.moves?.length || 0;
    const saved = startupRecovery.saved_at ? new Date(startupRecovery.saved_at) : null;
    const when = saved && !Number.isNaN(saved.getTime()) ? saved.toLocaleString() : "an earlier session";
    summary.textContent = `Last session · ${plies} ${plies === 1 ? "ply" : "plies"} · ${when}`;
    playLabel.textContent = "Resume last session";
    return;
  }
  const plies = state.moves_uci?.length || 0;
  const progressed = hasGameProgress();
  const opening = state.opening?.name || (state.initial_fen === STARTING_FEN ? "Starting position" : "Custom position");
  const clockText = formatTimeControl(Number(state.base_clock_ms || 120000), Number(state.increment_ms || 0));
  const positionState = state.game_over
    ? `${state.result || "Game over"}`
    : `${capitalize(state.turn)} to move${state.paused ? " · paused" : ""}`;
  summary.textContent = progressed
    ? `${plies} ${plies === 1 ? "ply" : "plies"} · ${opening} · ${positionState} · ${clockText}`
    : `${opening} · ${positionState} · ${clockText}`;
  playLabel.textContent = state.game_over ? "View finished game" : progressed ? "Continue game" : "Start playing";
}

async function continueFromLauncher() {
  if (!recoveryResolved && startupRecovery) {
    const resumed = await resumeRecovery();
    if (!resumed) return;
  }
  await enterWorkbench("game", true);
}

async function analyzeFromLauncher() {
  if (!recoveryResolved && startupRecovery) {
    const resumed = await resumeRecovery(false);
    if (!resumed) return;
  }
  await enterWorkbench("engine", false);
}

function confirmRestartIfNeeded(message, includeStartupRecovery = true) {
  const setupWarning = setupMode ? " Unapplied position-setup changes will also be discarded." : "";
  const recoveryWarning = includeStartupRecovery && !recoveryResolved && startupRecovery
    ? " The resumable last session will also be replaced."
    : "";
  return hasGameProgress() || setupMode || Boolean(recoveryWarning)
    ? confirmRestart(`${message}${setupWarning}${recoveryWarning}`)
    : Promise.resolve(true);
}

function clearTransientUiForReplacement() {
  // A successful reset/import replaces the live main line.  Clear every UI
  // workspace that may hold a snapshot of the previous game in one place so
  // Retry/Review/Trainer/Variation state can never leak across games.
  clearTimeout(autoplayTimer);
  autoplayTimer = null;
  clearTimeout(autoPositionAnalysisTimer);
  autoPositionAnalysisTimer = null;
  autoPositionAnalysisFen = null;
  autoPositionAnalysisQueued = false;
  homeAutoPaused = false;
  if (variationMode) saveCurrentVariationWorkspace();

  setupMode = false;
  setupBoard = {};
  setupPiece = "";
  $("setupControls").hidden = true;
  $("setupModeBtn").hidden = false;
  $("setupStatus").textContent = "Board editor";
  $("boardStage").classList.remove("setup-active");

  trainerMode = false;
  trainerSnapshot = null;
  trainerItemIndex = -1;
  trainerSelected = null;
  trainerRevealBest = false;
  trainerAwaitingNext = false;

  retryMode = false;
  retryTargetPly = null;
  retryRevealBest = false;
  reviewMode = false;
  reviewSnapshot = null;
  reviewSeries = null;

  variationMode = false;
  variationWorkspace = null;
  variationNodeId = null;

  selected = null;
  multiPvData = null;
  multiPvArrowMove = null;
  evalBreakdownData = null;
  evalBreakdownQueued = false;
  gameAnalysis = null;
  recoveryResolved = true;
  startupRecovery = null;
  try {
    localStorage.removeItem(RECOVERY_KEY);
  } catch (_) {
    // A successful replacement remains valid even if browser storage is unavailable.
  }
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
  if (trainerMode || variationMode || retryMode) {
    setStatus("Exit the current review/training workspace before entering position setup.", "error");
    return;
  }
  setupWasPaused = reviewMode ? reviewWasPaused : Boolean(state.paused);
  if (reviewMode) await exitReviewMode(false);
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
  const { baseMs, incrementMs } = selectedTimeControl();
  autoplay = $("humanSide").value === "none";
  const succeeded = await act(
    () => api("/api/reset", { clock_ms: baseMs, increment_ms: incrementMs }),
    successText,
    clearTransientUiForReplacement,
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

async function restartDesktopBackend() {
  const desktop = desktopApi();
  if (!desktop?.restartBackend) {
    setStatus("Backend restart is available in the desktop application.", "error");
    return false;
  }
  try {
    const snapshot = state ? boundedDesktopRestartSnapshot() : null;
    if (recoveryResolved && state) persistRecoverySnapshot();
    setStatus("Restarting the local engine backend…", "loading");
    setEngineStatus("Restarting backend", "busy");
    const nextUrl = await desktop.restartBackend(snapshot);
    const target = new URL(String(nextUrl || ""));
    if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") {
      throw new Error("Desktop backend returned an invalid local address.");
    }
    window.location.replace(target.href);
    return true;
  } catch (error) {
    setStatus(error.message, "error");
    setEngineStatus("Engine unavailable", "error");
    return false;
  }
}

async function downloadBlob(blob, filename) {
  const desktop = desktopApi();
  if (desktop?.saveBinary) {
    const saved = await desktop.saveBinary(filename, await blob.arrayBuffer());
    return Boolean(saved);
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
    recorded_initial_clocks: Array.isArray(state.recorded_initial_clocks) ? state.recorded_initial_clocks : null,
    recorded_clock_history: Array.isArray(state.recorded_clock_history) ? state.recorded_clock_history : [],
    human_side: $("humanSide").value,
    autoplay: Boolean(autoplay),
    paused: Boolean(state.paused),
    manual_result: state.manual_result || null,
    manual_termination: state.manual_termination || null,
    result: state.result || null,
    termination: state.termination || null,
    opening: state.opening || null,
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

function makePngITxtChunk(keyword, text) {
  const encoder = new TextEncoder();
  const type = encoder.encode("iTXt");
  // PNG iTXt: keyword\0, compression flag, compression method,
  // language tag\0, translated keyword\0, then uncompressed UTF-8 text.
  const data = new Uint8Array([
    ...encoder.encode(keyword),
    0, 0, 0, 0, 0,
    ...encoder.encode(text),
  ]);
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
      const chunk = makePngITxtChunk("FunChessEngine", JSON.stringify(snapshot));
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
  const validate = (text) => {
    const snapshot = JSON.parse(text);
    if (snapshot?.format !== "FunChessEngine.GamePNG" || snapshot?.version !== 1) {
      throw new Error("This PNG uses an unsupported Engine Lab save format.");
    }
    return snapshot;
  };
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset);
    if (offset + 12 + length > bytes.length) break;
    const type = decoder.decode(bytes.slice(offset + 4, offset + 8));
    if (type === "tEXt") {
      const data = bytes.slice(offset + 8, offset + 8 + length);
      const zero = data.indexOf(0);
      if (zero > 0 && decoder.decode(data.slice(0, zero)) === "FunChessEngine") {
        return validate(decoder.decode(data.slice(zero + 1)));
      }
    } else if (type === "iTXt") {
      const data = bytes.slice(offset + 8, offset + 8 + length);
      const keywordEnd = data.indexOf(0);
      if (keywordEnd > 0 && decoder.decode(data.slice(0, keywordEnd)) === "FunChessEngine") {
        const compressionFlag = data[keywordEnd + 1];
        const compressionMethod = data[keywordEnd + 2];
        const languageStart = keywordEnd + 3;
        const languageEnd = data.indexOf(0, languageStart);
        const translatedStart = languageEnd + 1;
        const translatedEnd = languageEnd >= 0 ? data.indexOf(0, translatedStart) : -1;
        if (compressionFlag !== 0 || compressionMethod !== 0 || languageEnd < 0 || translatedEnd < 0) {
          throw new Error("This saved PNG uses unsupported compressed metadata.");
        }
        return validate(decoder.decode(data.slice(translatedEnd + 1)));
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
    const saved = await downloadBlob(blob, `funchess-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    if (!saved) {
      setStatus("Save canceled.");
      return false;
    }
    setStatus("Game saved as a portable PNG.", "success");
    return true;
  } catch (error) {
    setStatus(error.message, "error");
    return false;
  }
}

async function loadGamePng(file) {
  const fromLauncher = launcherVisible();
  try {
    assertBrowserFileSize(file, MAX_SAVE_BYTES, "Saved PNG");
    const snapshot = extractPngSnapshot(new Uint8Array(await file.arrayBuffer()));
    const confirmed = await confirmRestartIfNeeded(
      "Opening a saved PNG replaces the current game. Save anything you want to keep first.",
    );
    if (!confirmed) return false;
    const mode = ["white", "black", "both", "none"].includes(snapshot.human_side) ? snapshot.human_side : "white";
    const succeeded = await act(
      () => api("/api/load-game", backendSnapshot(snapshot)),
      "Saved game restored from PNG.",
      clearTransientUiForReplacement,
    );
    if (succeeded) {
      $("humanSide").value = mode;
      previousHumanSide = mode;
      autoplay = mode === "none" && Boolean(snapshot.autoplay);
      gameAnalysis = snapshot.analysis && typeof snapshot.analysis === "object" ? snapshot.analysis : null;
      syncTimeControlsFromState();
      orientForHuman();
      render();
      if (fromLauncher) await enterWorkbench("engine", false);
      else scheduleComputerReply();
    }
    return succeeded;
  } catch (error) {
    setStatus(error.message, "error");
    return false;
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

function recordedClockText(value) {
  return Number.isFinite(Number(value)) ? clock(Number(value)) : "—";
}

function renderClocks() {
  if (!state) return;
  const analysisWorkspace = Boolean($("engineTab")?.classList.contains("active"));
  if (reviewMode || variationMode || analysisWorkspace) {
    const view = currentBoardView();
    const hasRecordedClockFields = view
      && Object.prototype.hasOwnProperty.call(view, "recorded_white_ms")
      && Object.prototype.hasOwnProperty.call(view, "recorded_black_ms");
    const white = hasRecordedClockFields ? view.recorded_white_ms : null;
    const black = hasRecordedClockFields ? view.recorded_black_ms : null;
    $("whiteClock").textContent = recordedClockText(white);
    $("blackClock").textContent = recordedClockText(black);
    $("whiteClock").classList.remove("active");
    $("blackClock").classList.remove("active");
    $("whiteClock").classList.toggle("recorded", hasRecordedClockFields);
    $("blackClock").classList.toggle("recorded", hasRecordedClockFields);
    $("whiteClock").classList.toggle("unavailable", white == null);
    $("blackClock").classList.toggle("unavailable", black == null);
    if (variationMode && !hasRecordedClockFields) {
      $("clockContext").textContent = "Analysis position · no game-clock time";
    } else if (hasRecordedClockFields) {
      const ply = Number(view?.ply ?? reviewSnapshot?.ply ?? 0);
      $("clockContext").textContent = `Recorded game clocks · ply ${ply}`;
    } else {
      $("clockContext").textContent = "Analysis workspace · clocks stopped";
    }
    return;
  }

  const white = liveClockMs("white");
  const black = liveClockMs("black");
  $("whiteClock").textContent = clock(white);
  $("blackClock").textContent = clock(black);
  $("whiteClock").classList.remove("recorded", "unavailable");
  $("blackClock").classList.remove("recorded", "unavailable");
  $("whiteClock").classList.toggle("active", !state.game_over && !state.paused && state.turn === "white");
  $("blackClock").classList.toggle("active", !state.game_over && !state.paused && state.turn === "black");
  $("clockContext").textContent = state.paused ? "Live game clocks · paused" : "Live game clocks";
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
  renderLauncher();
  renderBoard();
  renderClocks();
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
  const analysisRunning = gameAnalysis
    ? gameAnalysis.status === "running"
    : state.analysis_status === "running";
  const liveControlsLocked = reviewMode || setupMode || trainerMode || variationMode || retryMode;
  const humanSide = $("humanSide").value;
  const smartTakeback = (humanSide === "white" || humanSide === "black")
    && (state.moves_uci?.length || 0) >= 2
    && state.turn === humanSide;
  $("engineBtn").disabled = liveControlsLocked || busy || state.game_over || state.paused;
  $("undoBtn").disabled = liveControlsLocked || busy || state.pgn.length === 0;
  $("undoBtn").textContent = smartTakeback ? "Take back turn" : "Undo";
  $("undoBtn").title = reviewMode
    ? "Undo changes the live game. Return to the live game first; review arrows are non-destructive."
    : trainerMode
    ? "Exit Personal Trainer before undoing the live game."
    : variationMode
    ? "Use variation navigation inside the workspace; Undo changes only the live game."
    : setupMode
    ? "Finish or cancel position setup before undoing the live game."
    : smartTakeback
    ? "Take back your last move and the engine reply, returning the move to you (U)."
    : "Undo the most recent live-game move (U).";
  $("pauseBtn").disabled = liveControlsLocked || busy || state.game_over || analysisRunning;
  $("pauseBtn").textContent = state.paused ? "Resume clocks" : "Pause clocks";
  $("drawBtn").disabled = liveControlsLocked || busy || state.game_over;
  $("drawBtn").hidden = $("humanSide").value !== "both";
  $("resignBtn").disabled = liveControlsLocked || busy || state.game_over;
  $("resignBtn").hidden = $("humanSide").value === "none";
  $("humanSide").disabled = busy || reviewMode || setupMode || trainerMode || variationMode || retryMode;
  $("humanSide").title = $("humanSide").disabled
    ? "Return to the live game before changing who controls each side."
    : "Changing control mode starts a new game when the current game has progress.";
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
  renderAnalysisNotation();
  renderVariationWorkspace();
  renderAnalysisPanel();
  renderMultiPvPanel();
  renderOpeningExplorer();
  renderEvaluationBreakdown();
  renderTrainerPanel();
  renderDeveloperHistory();
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
  const reviewLinksLocked = busy || setupMode || trainerMode || variationMode || retryMode;
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
      white.disabled = reviewLinksLocked;
      white.title = reviewLinksLocked
        ? "Finish the current workspace before navigating the saved main line."
        : "Review this position without changing the live game.";
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
      black.disabled = reviewLinksLocked;
      black.title = reviewLinksLocked
        ? "Finish the current workspace before navigating the saved main line."
        : "Review this position without changing the live game.";
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

function recordedClockTextForPly(ply) {
  const pair = ply === 0
    ? state?.recorded_initial_clocks
    : state?.recorded_clock_history?.[ply - 1];
  const sideIndex = ply % 2 === 1 ? 0 : 1;
  const value = Array.isArray(pair) ? pair[sideIndex] : null;
  return Number.isFinite(value) ? clock(Number(value)) : "Clock —";
}

function renderAnalysisNotation() {
  const target = $("analysisNotation");
  const meta = $("analysisNotationMeta");
  if (!target || !meta || !state) return;
  const total = state.pgn?.length || 0;
  const currentPly = reviewMode ? Number(reviewSnapshot?.ply || 0) : total;
  const navigationLocked = busy || setupMode || trainerMode || variationMode || retryMode;
  meta.textContent = `${total} ${total === 1 ? "ply" : "plies"}`;
  target.innerHTML = "";
  if (!total) {
    const empty = document.createElement("p");
    empty.className = "analysis-notation-empty";
    empty.textContent = "Moves will appear here as the game develops or after you import a PGN.";
    target.appendChild(empty);
    return;
  }

  const makeMove = (index) => {
    const move = state.pgn[index];
    if (!move) {
      const placeholder = document.createElement("span");
      placeholder.className = "analysis-notation-move";
      placeholder.setAttribute("aria-hidden", "true");
      return placeholder;
    }
    const ply = index + 1;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "analysis-notation-move";
    button.classList.toggle("review-current", reviewMode && currentPly === ply);
    button.disabled = navigationLocked;
    button.title = navigationLocked
      ? "Finish the current workspace before navigating the saved main line."
      : `Review ply ${ply} without changing the live game.`;
    const san = document.createElement("span");
    san.className = "analysis-notation-san";
    san.textContent = move.san || "";
    button.appendChild(san);
    appendMoveGrade(button, ply);
    const recordedClock = document.createElement("span");
    recordedClock.className = "analysis-notation-clock";
    recordedClock.textContent = recordedClockTextForPly(ply);
    button.appendChild(recordedClock);
    button.addEventListener("click", () => enterReviewMode(ply));
    return button;
  };

  for (let index = 0; index < total; index += 2) {
    const row = document.createElement("div");
    row.className = "analysis-notation-row";
    const moveNumber = document.createElement("span");
    moveNumber.className = "analysis-move-number";
    moveNumber.textContent = `${index / 2 + 1}.`;
    row.append(moveNumber, makeMove(index), makeMove(index + 1));
    target.appendChild(row);
  }
}

function analysisErrorPlies() {
  const notable = new Set(["Inaccuracy", "Mistake", "Blunder"]);
  return (Array.isArray(gameAnalysis?.results) ? gameAnalysis.results : [])
    .filter((result) => notable.has(result.classification))
    .map((result) => Number(result.ply))
    .filter((ply) => Number.isInteger(ply) && ply > 0)
    .sort((a, b) => a - b);
}

async function jumpAnalysisError(direction) {
  const errors = analysisErrorPlies();
  const current = reviewMode ? Number(reviewSnapshot?.ply || 0) : (state?.moves_uci?.length || 0);
  const target = direction < 0
    ? [...errors].reverse().find((ply) => ply < current)
    : errors.find((ply) => ply > current);
  if (!target) {
    setStatus(direction < 0 ? "No earlier analyzed error." : "No later analyzed error.");
    return;
  }
  await enterReviewMode(target);
}

async function copyCurrentAnalysisFen() {
  const fen = currentBoardView()?.fen || state?.fen || "";
  if (!fen) return;
  try {
    await navigator.clipboard.writeText(fen);
    setStatus("Current analysis FEN copied.", "success");
  } catch (_) {
    const textarea = document.createElement("textarea");
    textarea.value = fen;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    setStatus(copied ? "Current analysis FEN copied." : "Could not copy the analysis FEN.", copied ? "success" : "error");
  }
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
  scheduleAutoPositionAnalysis();
}

async function enterReviewMode(ply = null) {
  if (!state || setupMode || busy) return;
  if (retryMode) {
    setStatus("Finish Retry Move or return to the reviewed move before navigating elsewhere.", "error");
    return;
  }
  if (trainerMode || variationMode) {
    setStatus(
      trainerMode
        ? "Exit Personal Trainer before navigating the saved game."
        : "Exit the variation workspace before navigating the saved main line.",
      "error",
    );
    return;
  }
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

async function exitReviewMode(resumeGame = true) {
  if (!reviewMode) return;
  reviewMode = false;
  reviewSnapshot = null;
  retryMode = false;
  retryTargetPly = null;
  retryRevealBest = false;
  selected = null;
  render();
  if (resumeGame && !reviewWasPaused && state && !state.game_over && state.paused) {
    const resumed = await act(() => api("/api/pause", { paused: false }), "Returned to live game.");
    if (resumed) scheduleComputerReply();
  }
}

function renderReviewPanel() {
  const total = state?.moves_uci?.length || 0;
  const ply = reviewMode ? Number(reviewSnapshot?.ply || 0) : total;
  const navigationLocked = busy || setupMode || trainerMode || variationMode || retryMode;
  const errors = analysisErrorPlies();
  const hasPreviousError = errors.some((errorPly) => errorPly < ply);
  const hasNextError = errors.some((errorPly) => errorPly > ply);
  $("reviewPositionLabel").textContent = retryMode && retryTargetPly
    ? `Retry ply ${retryTargetPly}`
    : reviewMode ? `Ply ${ply} / ${total}` : `${total} plies`;
  $("reviewExitBtn").hidden = !reviewMode;
  $("reviewFirstBtn").disabled = navigationLocked || total === 0 || ply <= 0;
  $("reviewPrevBtn").disabled = navigationLocked || total === 0 || ply <= 0;
  $("reviewNextBtn").disabled = navigationLocked || total === 0 || ply >= total;
  $("reviewLastBtn").disabled = navigationLocked || total === 0 || ply >= total;
  const navigationTitle = retryMode
    ? "Finish Retry Move before navigating review positions."
    : variationMode
    ? "Variation navigation is separate from main-line review navigation."
    : trainerMode
    ? "Exit Personal Trainer before navigating the saved game."
    : "Review navigation changes only the viewed position; it never changes the live game.";
  for (const id of ["reviewFirstBtn", "reviewPrevBtn", "reviewNextBtn", "reviewLastBtn"]) {
    $(id).title = navigationTitle;
  }
  $("reviewPlySlider").min = "0";
  $("reviewPlySlider").max = String(total);
  $("reviewPlySlider").value = String(Math.max(0, Math.min(total, ply)));
  $("reviewPlySlider").disabled = navigationLocked || total === 0;
  $("reviewSliderLabel").textContent = `${ply} / ${total}`;
  $("reviewPrevErrorBtn").disabled = navigationLocked || !hasPreviousError;
  $("reviewNextErrorBtn").disabled = navigationLocked || !hasNextError;
  $("reviewPrevErrorBtn").title = errors.length ? "Jump to the previous inaccuracy, mistake, or blunder." : "Analyze the game first to enable error navigation.";
  $("reviewNextErrorBtn").title = $("reviewPrevErrorBtn").title;
  $("copyAnalysisFenBtn").disabled = !state || navigationLocked;
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
  $("analysisProgressTrack").setAttribute("aria-valuenow", String(Math.round(percent)));
  $("analysisProgressTrack").setAttribute("aria-valuetext", `${completed} of ${total} moves`);

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

function scheduleAutoPositionAnalysis(force = false) {
  clearTimeout(autoPositionAnalysisTimer);
  autoPositionAnalysisTimer = null;
  if (
    !$("analysisAutoToggle")?.checked
    || launcherVisible()
    || !$("engineTab")?.classList.contains("active")
    || !state
    || busy
    || gameAnalysis?.status === "running"
  ) {
    autoPositionAnalysisQueued = false;
    return;
  }
  if (multiPvBusy) {
    autoPositionAnalysisQueued = true;
    return;
  }
  autoPositionAnalysisQueued = false;
  const fen = currentBoardView()?.fen || state.fen;
  if (!fen || (!force && autoPositionAnalysisFen === fen)) return;
  autoPositionAnalysisTimer = setTimeout(() => {
    autoPositionAnalysisTimer = null;
    const currentFen = currentBoardView()?.fen || state?.fen;
    if (
      currentFen !== fen
      || !$("analysisAutoToggle")?.checked
      || launcherVisible()
      || !$("engineTab")?.classList.contains("active")
      || busy
      || multiPvBusy
      || gameAnalysis?.status === "running"
    ) return;
    runMultiPv({ quiet: true });
  }, 220);
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
  if (!fen || evalBreakdownData?.fen === fen) return;
  if (evalBreakdownBusy) {
    evalBreakdownQueued = true;
    return;
  }
  evalBreakdownBusy = true;
  evalBreakdownQueued = false;
  try {
    evalBreakdownData = await api("/api/eval-breakdown", { fen });
  } catch (_) {
    evalBreakdownData = null;
  } finally {
    evalBreakdownBusy = false;
    renderEvaluationBreakdown();
    const latestFen = currentBoardView()?.fen || state?.fen;
    const shouldRerun = evalBreakdownQueued || Boolean(latestFen && latestFen !== fen);
    evalBreakdownQueued = false;
    if (shouldRerun) setTimeout(refreshEvaluationBreakdown, 0);
  }
}

function renderDeveloperHistory() {
  const target = $("devBenchmarkHistory");
  if (!target) return;
  target.innerHTML = "";
  benchmarkHistory.slice(0, 10).forEach((entry) => {
    const row = document.createElement("div");
    row.className = "dev-history-row";
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = entry.kind === "arena"
      ? `A/B ${entry.wins || 0}-${entry.losses || 0} (${Math.round(Number(entry.score || 0) * 100)}%)`
      : `Depth ${Number(entry.mean_depth || 0).toFixed(2)} · ${Number(entry.aggregate_nps || 0).toLocaleString()} NPS`;
    const meta = document.createElement("span");
    meta.textContent = `${new Date(entry.saved_at).toLocaleString()}${entry.note ? ` · ${entry.note}` : ""}`;
    info.append(title, meta);
    const delta = document.createElement("span");
    if (entry.kind === "benchmark" && entry.nps_delta != null) {
      delta.textContent = `${Number(entry.nps_delta) >= 0 ? "+" : ""}${Number(entry.nps_delta).toLocaleString()} NPS`;
    } else if (entry.kind === "arena") {
      delta.textContent = `+${entry.wins} =${entry.draws} -${entry.losses}`;
    } else delta.textContent = `${entry.clock_ms || ""} ms`;
    row.append(info, delta);
    target.appendChild(row);
  });
  if (!benchmarkHistory.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Benchmark and A/B results will be retained here locally.";
    target.appendChild(empty);
  }
}

function renderDevLabResult(title, detail) {
  const target = $("devLabResult");
  if (!target) return;
  target.innerHTML = "";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const body = document.createElement("span");
  body.textContent = detail;
  target.append(heading, body);
}

async function runDeveloperBenchmark() {
  if (devLabBusy) return;
  devLabBusy = true;
  $("devLabStatus").textContent = "Benchmarking…";
  $("devBenchmarkBtn").disabled = true;
  $("devArenaBtn").disabled = true;
  try {
    const clockMs = Number($("devClockMs").value || 10000);
    const comparePath = $("devComparePath").value.trim();
    const result = await api("/api/dev-benchmark", { clock_ms: clockMs, compare_path: comparePath });
    const summary = result.summary || {};
    const comparison = result.comparison || null;
    const detail = comparison
      ? `Mean depth ${Number(summary.mean_depth).toFixed(2)} · ${Number(summary.aggregate_nps).toLocaleString()} NPS · Δdepth ${Number(comparison.depth_delta) >= 0 ? "+" : ""}${Number(comparison.depth_delta).toFixed(2)} · ΔNPS ${Number(comparison.nps_delta) >= 0 ? "+" : ""}${Number(comparison.nps_delta).toLocaleString()} · ${comparison.changed_moves}/12 moves changed.`
      : `Mean depth ${Number(summary.mean_depth).toFixed(2)} · ${Number(summary.aggregate_nps).toLocaleString()} aggregate NPS · ${Number(summary.nodes).toLocaleString()} nodes.`;
    renderDevLabResult("Benchmark complete", detail);
    benchmarkHistory.unshift({
      kind: "benchmark",
      saved_at: new Date().toISOString(),
      clock_ms: result.clock_ms,
      mean_depth: summary.mean_depth,
      aggregate_nps: summary.aggregate_nps,
      nodes: summary.nodes,
      depth_delta: comparison?.depth_delta ?? null,
      nps_delta: comparison?.nps_delta ?? null,
      changed_moves: comparison?.changed_moves ?? null,
      note: comparison?.path ? `vs ${comparison.path}` : "current engine",
    });
    benchmarkHistory = benchmarkHistory.slice(0, 20);
    saveBenchmarkHistory();
    renderDeveloperHistory();
    $("devLabStatus").textContent = "Complete";
  } catch (error) {
    $("devLabStatus").textContent = "Error";
    renderDevLabResult("Benchmark failed", error.message);
  } finally {
    devLabBusy = false;
    $("devBenchmarkBtn").disabled = false;
    $("devArenaBtn").disabled = false;
  }
}

async function runDeveloperArena() {
  if (devLabBusy) return;
  const opponentPath = $("devComparePath").value.trim();
  if (!opponentPath) {
    renderDevLabResult("A/B needs a baseline", "Enter a comparison agent folder containing agent.py.");
    return;
  }
  devLabBusy = true;
  $("devLabStatus").textContent = "Playing A/B…";
  $("devBenchmarkBtn").disabled = true;
  $("devArenaBtn").disabled = true;
  try {
    const result = await api("/api/dev-arena", {
      opponent_path: opponentPath,
      games: Number($("devArenaGames").value || 6),
      base_ms: 5000,
      increment_ms: 100,
    });
    renderDevLabResult(
      "A/B complete",
      `+${result.wins} =${result.draws} -${result.losses} · ${(Number(result.score) * 100).toFixed(1)}% · ${Object.entries(result.terminations || {}).map(([name, count]) => `${name} ${count}`).join(", ")}.`,
    );
    benchmarkHistory.unshift({
      kind: "arena",
      saved_at: new Date().toISOString(),
      wins: result.wins,
      draws: result.draws,
      losses: result.losses,
      score: result.score,
      note: `vs ${result.opponent_path}`,
    });
    benchmarkHistory = benchmarkHistory.slice(0, 20);
    saveBenchmarkHistory();
    renderDeveloperHistory();
    $("devLabStatus").textContent = "Complete";
  } catch (error) {
    $("devLabStatus").textContent = "Error";
    renderDevLabResult("A/B failed", error.message);
  } finally {
    devLabBusy = false;
    $("devBenchmarkBtn").disabled = false;
    $("devArenaBtn").disabled = false;
  }
}

async function runMultiPv(options = {}) {
  if (!state || multiPvBusy || gameAnalysis?.status === "running") return;
  const quiet = Boolean(options?.quiet);
  const ply = reviewMode ? Number(reviewSnapshot?.ply || 0) : (state.moves_uci?.length || 0);
  const fen = currentBoardView()?.fen || state.fen;
  const lines = Math.max(1, Math.min(5, Number($("multipvCount").value) || 3));
  const budgetMs = Math.max(100, Math.min(2000, Number($("positionAnalysisQuality")?.value || 350)));
  multiPvBusy = true;
  multiPvArrowMove = null;
  renderMultiPvPanel();
  try {
    multiPvData = await api("/api/multipv", { ply, fen, lines, budget_ms: budgetMs });
    autoPositionAnalysisFen = fen;
    if (!quiet) setStatus(`Candidate lines searched to depth ${multiPvData.depth}.`, "success");
  } catch (error) {
    multiPvData = null;
    setStatus(error.message, "error");
  } finally {
    multiPvBusy = false;
    renderMultiPvPanel();
    renderBoard();
    if (autoPositionAnalysisQueued) {
      autoPositionAnalysisQueued = false;
      scheduleAutoPositionAnalysis(true);
    }
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
  if (setupMode || trainerMode || variationMode || retryMode) {
    setStatus("Exit the current board workspace before starting whole-game analysis.", "error");
    return;
  }
  const analysisTab = document.querySelector('[data-tab="engine"]');
  if (analysisTab && !analysisTab.classList.contains("active")) await activateTab(analysisTab);
  if (!reviewMode) await enterReviewMode(state.moves_uci.length);
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

async function act(fn, successText = "Ready.", beforeState = null) {
  if (busy) return false;
  busy = true;
  setStatus("Working…", "loading");
  setEngineStatus("Engine busy", "busy");
  render();
  try {
    const value = await fn();
    if (beforeState) beforeState(value);
    setState(value);
    setStatus(successText, "success");
    setEngineStatus("Engine ready");
    return true;
  } catch (error) {
    setStatus(error.message, "error");
    setEngineStatus("Engine error", "error");
    return false;
  } finally {
    busy = false;
    render();
  }
}

async function undoLiveMove() {
  if (!state || busy) return false;
  if (reviewMode || retryMode || setupMode || trainerMode || variationMode) {
    setStatus(
      reviewMode
        ? "Undo changes the live game. Use the review arrows to browse without changing it, or return to the live game first."
        : "Finish the current workspace before undoing the live game.",
      "error",
    );
    return false;
  }
  const humanSide = $("humanSide").value;
  const moveCount = state.moves_uci?.length || 0;
  const versusEngine = humanSide === "white" || humanSide === "black";
  const takeBackTurn = versusEngine && moveCount >= 2 && state.turn === humanSide;
  const plies = takeBackTurn ? 2 : 1;
  const succeeded = await act(
    () => api("/api/undo", { plies }),
    takeBackTurn ? "Last turn taken back." : "Live-game move undone.",
  );
  if (succeeded) scheduleComputerReply();
  return succeeded;
}

async function engineMove() {
  if (reviewMode || retryMode || setupMode || trainerMode || variationMode) {
    setStatus("Return to the live game before asking the engine to play a move.", "error");
    return false;
  }
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
    setStatus("FEN copied to clipboard.", "success");
  } catch (_) {
    $("fenInput").focus();
    $("fenInput").select();
    setStatus("FEN selected — copy it with your keyboard shortcut.");
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
  setStatus("FEN downloaded.", "success");
}

async function currentPgnText() {
  const result = await api("/api/export-pgn", {});
  const pgn = String(result.pgn || "").trim();
  if (!pgn) throw new Error("The current game could not be exported as PGN.");
  return `${pgn}\n`;
}

async function copyPgn() {
  try {
    const pgn = await currentPgnText();
    await navigator.clipboard.writeText(pgn);
    setStatus("PGN copied to clipboard.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function exportPgn() {
  try {
    const pgn = await currentPgnText();
    const desktop = desktopApi();
    if (desktop?.savePgn) {
      const saved = await desktop.savePgn("funchess-game.pgn", pgn);
      if (!saved) return;
    } else {
      await downloadBlob(new Blob([pgn], { type: "application/x-chess-pgn;charset=utf-8" }), "funchess-game.pgn");
    }
    setStatus("PGN exported.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function loadPgnText(pgn) {
  const text = String(pgn || "");
  if (!text.trim()) return false;
  if (utf8ByteLength(text) > MAX_PGN_BYTES) {
    throw new Error("PGN is too large. Maximum size is 2 MB.");
  }
  const confirmed = await confirmRestartIfNeeded(
    "Opening a PGN replaces the current game. Save or export a copy first if you want to keep it.",
  );
  if (!confirmed) return false;
  autoplay = false;
  clearTimeout(autoplayTimer);
  const succeeded = await act(
    () => api("/api/load-pgn", { pgn: text }),
    "PGN opened for review.",
    clearTransientUiForReplacement,
  );
  if (!succeeded) return false;
  syncTimeControlsFromState();
  archiveCurrentGame(true);
  await enterWorkbench("engine", false);
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
  if (reviewMode || retryMode || setupMode || trainerMode || variationMode) {
    setStatus("Return to the live game before changing the live clock state.", "error");
    return;
  }
  const analysisRunning = gameAnalysis
    ? gameAnalysis.status === "running"
    : state.analysis_status === "running";
  if (analysisRunning) {
    setStatus("Cancel game analysis before resuming or changing the live clock state.", "error");
    return;
  }
  clearTimeout(autoplayTimer);
  const wasPaused = Boolean(state.paused);
  const succeeded = await act(
    () => api("/api/pause", { paused: !wasPaused }),
    wasPaused ? "Game resumed." : "Game paused.",
  );
  if (succeeded) homeAutoPaused = false;
  if (succeeded && !state?.paused) scheduleComputerReply();
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
  const value = String(fen || "").trim();
  if (!value) {
    setStatus("Enter a FEN position first.", "error");
    return false;
  }
  if (utf8ByteLength(value) > MAX_FEN_BYTES) {
    setStatus("FEN is too large. Maximum size is 64 KB.", "error");
    return false;
  }
  const fromLauncher = !$("startScreen").hidden;
  const confirmed = await confirmRestartIfNeeded(
    "Loading a FEN replaces the current game. Save or export a copy first if you want to keep it.",
  );
  if (!confirmed) return false;
  const { baseMs, incrementMs } = selectedTimeControl();
  autoplay = $("humanSide").value === "none";
  const succeeded = await act(
    () => api("/api/reset", { fen: value, clock_ms: baseMs, increment_ms: incrementMs }),
    "FEN loaded as a new game.",
    clearTransientUiForReplacement,
  );
  if (succeeded) {
    if (fromLauncher) await enterWorkbench("engine", false);
    else scheduleComputerReply();
  }
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
    { label: "Analyze game", hint: "Post-game review", action: startGameAnalysis },
    { label: "Analyze candidate lines", hint: "MultiPV", action: async () => { await activateTab(document.querySelector('[data-tab="engine"]')); await runMultiPv(); } },
    { label: "Branch from current position", hint: "Variation workspace", action: async () => { await activateTab(document.querySelector('[data-tab="engine"]')); await startVariationWorkspace(); } },
    { label: "Start mistake trainer", hint: "Personal puzzles", action: startTrainer },
    { label: "Run engine benchmark", hint: "Developer lab", action: async () => { await activateTab(document.querySelector('[data-tab="engine"]')); await runDeveloperBenchmark(); } },
    { label: "Flip board", hint: "F", action: () => $("flipBtn").click() },
    { label: "Undo live move", hint: "U", action: undoLiveMove },
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
    setStatus(error.message, "error");
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
    if (name.endsWith(".pgn")) {
      assertBrowserFileSize(file, MAX_PGN_BYTES, "PGN");
      await loadPgnText(await file.text());
    } else if (name.endsWith(".fen") || name.endsWith(".txt")) {
      assertBrowserFileSize(file, MAX_FEN_BYTES, "FEN");
      await loadFenValue((await file.text()).trim());
    }
    else if (name.endsWith(".png")) await loadGamePng(file);
    else throw new Error("Drop a .pgn, .fen, or FunChessEngine .png file.");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

const tabButtons = [...document.querySelectorAll(".tab")];

function setLauncherVisible(visible) {
  $("startScreen").hidden = !visible;
  $("mainWorkspace").hidden = visible;
  $("homeBtn").hidden = visible;
  $("commandOpenBtn").hidden = visible;
  const skipLink = document.querySelector(".skip-link");
  if (skipLink) skipLink.hidden = visible;
  if (visible) renderLauncher();
}

async function enterWorkbench(tabName = "game", resumeHomeClock = false) {
  setLauncherVisible(false);
  const target = tabButtons.find((button) => button.dataset.tab === tabName) || tabButtons[0];
  await activateTab(target);
  if (resumeHomeClock && homeAutoPaused && state?.paused && !state.game_over) {
    const resumed = await act(() => api("/api/pause", { paused: false }), "Game resumed.");
    if (resumed) {
      homeAutoPaused = false;
      scheduleComputerReply();
    }
  } else if (resumeHomeClock && (!state?.paused || state?.game_over)) {
    homeAutoPaused = false;
  }
}

async function showLauncher() {
  if (variationMode || trainerMode || setupMode || retryMode) {
    setStatus("Exit the current board workspace before returning Home.", "error");
    return;
  }
  if (reviewMode) await exitReviewMode(false);
  if (state && !state.game_over && !state.paused) {
    const paused = await act(() => api("/api/pause", { paused: true }), "Game paused while Home is open.");
    homeAutoPaused = Boolean(paused);
  } else if (state?.game_over) {
    homeAutoPaused = false;
  }
  setLauncherVisible(true);
}

async function startNewGameFromLauncher() {
  const confirmed = await confirmRestartIfNeeded(
    "Starting a new game replaces the current game. Save or export a copy first if you want to keep it.",
  );
  if (!confirmed) return false;
  await enterWorkbench("game", false);
  return restartStandardGame();
}

async function activateTab(button, focus = false) {
  if (!button) return;
  const previous = tabButtons.find((tab) => tab.classList.contains("active"));
  const previousTab = previous?.dataset.tab;
  const nextTab = button.dataset.tab;
  $("mainWorkspace").dataset.activeTab = nextTab;
  if (nextTab !== "engine") {
    clearTimeout(autoPositionAnalysisTimer);
    autoPositionAnalysisTimer = null;
  }

  if (
    previousTab === "engine"
    && nextTab !== "engine"
    && reviewMode
    && !variationMode
    && !retryMode
  ) {
    await exitReviewMode(true);
  }

  tabButtons.forEach((tab) => {
    const active = tab === button;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
    const panel = $(`${tab.dataset.tab}Tab`);
    panel?.classList.toggle("active", active);
    panel?.setAttribute("aria-hidden", active ? "false" : "true");
  });
  if (focus) button.focus();
  if (
    nextTab === "engine"
    && state
    && !reviewMode
    && !setupMode
    && !trainerMode
    && !variationMode
    && !retryMode
  ) {
    await enterReviewMode(state.moves_uci?.length || 0);
  } else if (nextTab === "engine" && state?.moves_uci?.length) {
    ensureReviewSeries().then(renderReviewPanel).catch((error) => setStatus(error.message, "error"));
  }
  if (nextTab === "engine") scheduleAutoPositionAnalysis();
}

tabButtons.forEach((button, index) => {
  button.addEventListener("click", () => { activateTab(button); });
  button.addEventListener("keydown", (event) => {
    let target = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      target = tabButtons[(index + 1) % tabButtons.length];
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      target = tabButtons[(index - 1 + tabButtons.length) % tabButtons.length];
    } else if (event.key === "Home") {
      target = tabButtons[0];
    } else if (event.key === "End") {
      target = tabButtons[tabButtons.length - 1];
    }
    if (!target) return;
    event.preventDefault();
    activateTab(target, true);
  });
});

$("homeBtn").addEventListener("click", showLauncher);
$("startPlayBtn").addEventListener("click", continueFromLauncher);
$("startAnalysisBtn").addEventListener("click", analyzeFromLauncher);
$("startNewGameBtn").addEventListener("click", startNewGameFromLauncher);
$("startPgnBtn").addEventListener("click", openPgnFile);
$("startFenBtn").addEventListener("click", openFenFile);
$("startLibraryBtn").addEventListener("click", () => enterWorkbench("position", false));
$("startSettingsBtn").addEventListener("click", () => enterWorkbench("display", false));

$("flipBtn").addEventListener("click", () => {
  flipped = !flipped;
  selected = null;
  renderBoard();
});
$("undoBtn").addEventListener("click", undoLiveMove);
$("engineBtn").addEventListener("click", engineMove);
$("multipvBtn").addEventListener("click", runMultiPv);
$("multipvCount").addEventListener("change", () => {
  autoPositionAnalysisFen = null;
  scheduleAutoPositionAnalysis(true);
});
$("positionAnalysisQuality").addEventListener("change", () => {
  autoPositionAnalysisFen = null;
  scheduleAutoPositionAnalysis(true);
});
$("analysisAutoToggle").addEventListener("change", (event) => {
  clearTimeout(autoPositionAnalysisTimer);
  autoPositionAnalysisTimer = null;
  if (event.target.checked) {
    autoPositionAnalysisFen = null;
    scheduleAutoPositionAnalysis(true);
  }
});
$("analyzeGameBtn").addEventListener("click", startGameAnalysis);
$("cancelAnalysisBtn").addEventListener("click", cancelGameAnalysis);
$("variationStartBtn").addEventListener("click", startVariationWorkspace);
$("variationExitBtn").addEventListener("click", exitVariationWorkspace);
$("variationBackBtn").addEventListener("click", variationBack);
$("variationDeleteBtn").addEventListener("click", deleteVariationBranch);
$("variationResetBtn").addEventListener("click", resetVariationWorkspace);
$("variationNag").addEventListener("change", () => { saveVariationMetadata(); renderVariationWorkspace(); });
$("variationComment").addEventListener("input", saveVariationMetadata);
$("clearAnnotationsBtn").addEventListener("click", clearCurrentAnnotations);
$("trainerStartBtn").addEventListener("click", startTrainer);
$("trainerHintBtn").addEventListener("click", trainerHint);
$("trainerExitBtn").addEventListener("click", exitTrainer);
$("trainerNextBtn").addEventListener("click", nextTrainerItem);
$("clearTrainerBtn").addEventListener("click", clearTrainer);
$("devBenchmarkBtn").addEventListener("click", runDeveloperBenchmark);
$("devArenaBtn").addEventListener("click", runDeveloperArena);
$("clearDevHistoryBtn").addEventListener("click", () => {
  benchmarkHistory = [];
  saveBenchmarkHistory();
  renderDeveloperHistory();
});
$("resumeRecoveryBtn").addEventListener("click", resumeRecovery);
$("discardRecoveryBtn").addEventListener("click", discardRecovery);
$("clearRecentGamesBtn").addEventListener("click", clearRecentGames);
$("recentGamesSearch").addEventListener("input", renderRecentGames);
$("recentFavoritesOnly").addEventListener("change", renderRecentGames);
$("copyFenBtn").addEventListener("click", copyFen);
$("downloadFenBtn").addEventListener("click", downloadFen);
$("openPgnBtn").addEventListener("click", openPgnFile);
$("copyPgnBtn").addEventListener("click", copyPgn);
$("exportPgnBtn").addEventListener("click", exportPgn);
$("loadPgnInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    assertBrowserFileSize(file, MAX_PGN_BYTES, "PGN");
    await loadPgnText(await file.text());
  } catch (error) {
    setStatus(error.message, "error");
  }
});
$("savePngBtn").addEventListener("click", saveGamePng);
$("loadPngBtn").addEventListener("click", openPngFile);
$("loadPngInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    assertBrowserFileSize(file, MAX_SAVE_BYTES, "Saved PNG");
    await loadGamePng(file);
  } catch (error) {
    setStatus(error.message, "error");
  }
});
$("loadFenFileBtn").addEventListener("click", openFenFile);
$("loadFenFileInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    assertBrowserFileSize(file, MAX_FEN_BYTES, "FEN");
    const fen = (await file.text()).trim();
    $("fenInput").value = fen;
    await loadFenValue(fen);
  } catch (error) {
    setStatus(error.message, "error");
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
    activateTab(document.querySelector('[data-tab="engine"]'));
  }, 0);
});

$("reviewFirstBtn").addEventListener("click", () => enterReviewMode(0));
$("reviewPrevBtn").addEventListener("click", () => enterReviewMode(Math.max(0, Number(reviewSnapshot?.ply ?? state?.moves_uci?.length ?? 0) - 1)));
$("reviewNextBtn").addEventListener("click", () => enterReviewMode(Math.min(state?.moves_uci?.length || 0, Number(reviewSnapshot?.ply ?? 0) + 1)));
$("reviewLastBtn").addEventListener("click", () => enterReviewMode(state?.moves_uci?.length || 0));
$("reviewExitBtn").addEventListener("click", exitReviewMode);
$("reviewPlySlider").addEventListener("input", (event) => {
  $("reviewSliderLabel").textContent = `${event.target.value} / ${state?.moves_uci?.length || 0}`;
});
$("reviewPlySlider").addEventListener("change", (event) => enterReviewMode(Number(event.target.value || 0)));
$("reviewPrevErrorBtn").addEventListener("click", () => jumpAnalysisError(-1));
$("reviewNextErrorBtn").addEventListener("click", () => jumpAnalysisError(1));
$("copyAnalysisFenBtn").addEventListener("click", copyCurrentAnalysisFen);
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
  const priorSide = previousHumanSide;
  const confirmed = await confirmRestartIfNeeded(
    "Changing game mode starts a new standard game and replaces the current one. Save or export a copy first if you want to keep it.",
  );
  if (!confirmed) {
    $("humanSide").value = priorSide;
    render();
    return;
  }
  autoplay = nextSide === "none";
  selected = null;
  orientForHuman();
  render();
  const succeeded = await restartStandardGame(`${nextSide === "both" ? "Two-player" : nextSide === "none" ? "Engine vs Engine" : `Human ${capitalize(nextSide)}`} mode started.`);
  if (!succeeded) {
    $("humanSide").value = priorSide;
    autoplay = priorSide === "none";
    orientForHuman();
    render();
  }
});

$("newGameBtn").addEventListener("click", async () => {
  const confirmed = await confirmRestartIfNeeded(
    "Starting a new game replaces the current game. Save or export a copy first if you want to keep it.",
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
    "Applying a new time control starts a new game and replaces the current one. Save or export a copy first if you want to keep it.",
  );
  if (!confirmed) return;
  await restartStandardGame("Time control applied and game restarted.");
});

$("themeSelect").addEventListener("change", (event) => updateDisplay({ theme: event.target.value }));
$("accentSelect").addEventListener("change", (event) => updateDisplay({ accent: event.target.value }));
$("appearanceSelect").addEventListener("change", (event) => updateDisplay({ appearance: event.target.value }));
$("pieceThemeSelect").addEventListener("change", (event) => updateDisplay({ pieceTheme: event.target.value }));
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
$("commandOpenBtn").addEventListener("click", openCommandPalette);
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
    if (launcherVisible()) return;
    openCommandPalette();
    return;
  }
  if (launcherVisible()) return;
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
    } else if (retryMode && ["arrowleft", "arrowright", "home", "end"].includes(key)) {
      event.preventDefault();
      setStatus("Finish Retry Move or return to the reviewed move before navigating elsewhere.", "error");
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
    undoLiveMove();
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
    handleDesktopCommand(command).catch((error) => setStatus(error.message, "error"));
  });
}

async function handleDesktopCommand(command) {
  if (command === "restart-backend") {
    await restartDesktopBackend();
  } else if (command === "new-game") {
    if (launcherVisible()) await startNewGameFromLauncher();
    else $("newGameBtn").click();
  } else if (command === "setup-position") {
    if (launcherVisible()) await enterWorkbench("position", false);
    else await activateTab(document.querySelector('[data-tab="position"]'));
    await enterSetupMode();
  } else if (command === "open-fen") await openFenFile();
  else if (command === "open-pgn") await openPgnFile();
  else if (command === "open-png") await openPngFile();
  else if (command === "save-fen") await downloadFen();
  else if (command === "save-pgn") await exportPgn();
  else if (command === "save-png") await saveGamePng();
  else if (command === "undo") {
    if (launcherVisible()) await enterWorkbench("game", false);
    await undoLiveMove();
  } else if (command === "flip") {
    if (launcherVisible()) await enterWorkbench("game", false);
    $("flipBtn").click();
  } else if (command === "engine-move") {
    if (launcherVisible()) await enterWorkbench("game", true);
    await engineMove();
  } else if (command === "pause") {
    if (launcherVisible()) await enterWorkbench("game", false);
    await togglePause();
  } else if (command === "analyze-game") {
    if (launcherVisible()) await enterWorkbench("engine", false);
    else await activateTab(document.querySelector('[data-tab="engine"]'));
    await startGameAnalysis();
  } else if (command === "multipv") {
    if (launcherVisible()) await enterWorkbench("engine", false);
    else await activateTab(document.querySelector('[data-tab="engine"]'));
    await runMultiPv();
  } else if (command === "variation") {
    if (launcherVisible()) await enterWorkbench("engine", false);
    else await activateTab(document.querySelector('[data-tab="engine"]'));
    await startVariationWorkspace();
  } else if (command === "trainer") {
    if (launcherVisible()) await enterWorkbench("train", false);
    await startTrainer();
  } else if (command === "command-palette") {
    if (launcherVisible()) setStatus("Quick actions are already available on Home.");
    else openCommandPalette();
  }
}

async function reconnectBackend() {
  setStatus("Reconnecting to the local engine…", "loading");
  setEngineStatus("Connecting…", "busy");
  try {
    const value = await api("/api/state");
    setState(value);
    if (!$("startScreen").hidden && state && !state.game_over && !state.paused) {
      setState(await api("/api/pause", { paused: true }));
      homeAutoPaused = true;
    }
    previousHumanSide = $("humanSide").value;
    syncTimeControlsFromState();
    render();
    if ($("startScreen").hidden) scheduleComputerReply();
    setStatus("Engine connection restored.", "success");
    setEngineStatus("Engine ready");
  } catch (error) {
    setStatus(error.message, "error");
    setEngineStatus("Engine unavailable", "error");
  }
}

$("retryConnectionBtn").addEventListener("click", reconnectBackend);

applyDisplaySettings(false);
orientForHuman();
void hydrateDurableMetadata();
api("/api/state").then(async (value) => {
  setState(value);
  if (!state.game_over && !state.paused) {
    setState(await api("/api/pause", { paused: true }));
    homeAutoPaused = true;
  }
  previousHumanSide = $("humanSide").value;
  syncTimeControlsFromState();
  render();
  setLauncherVisible(true);
  setEngineStatus("Engine ready");
  if (value.analysis_status && value.analysis_status !== "idle") refreshAnalysisStatus();
}).catch((error) => {
  setStatus(error.message, "error");
  setEngineStatus("Engine unavailable", "error");
});
setInterval(renderClocks, 100);
setInterval(() => {
  if (recoveryResolved && state && !state.paused && !state.game_over) persistRecoverySnapshot();
}, 2_000);
window.addEventListener("beforeunload", () => {
  if (recoveryResolved) persistRecoverySnapshot();
});
