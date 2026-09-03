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
const BOOKMARKS_KEY = "funChessEngine.bookmarks.v1";
const ONBOARDING_KEY = "funChessEngine.onboarding.v1";
const ANALYSIS_QUEUE_KEY = "funChessEngine.analysisQueue.v1";
const TOURNAMENT_HISTORY_KEY = "funChessEngine.tournaments.v1";
const POSITION_CACHE_KEY = "funChessEngine.positionCache.v1";
const LESSONS_KEY = "funChessEngine.lessons.v1";
const ENGINE_PRESETS_KEY = "funChessEngine.enginePresets.v1";
const PLUGINS_KEY = "funChessEngine.plugins.v1";
const EXTERNAL_ENGINES_KEY = "funChessEngine.externalEngines.v1";
const SESSION_GOALS_KEY = "funChessEngine.sessionGoals.v1";
const CALIBRATION_HISTORY_KEY = "funChessEngine.calibrationHistory.v1";
const EXTERNAL_COMPARE_HISTORY_KEY = "funChessEngine.externalCompareHistory.v1";
const REGRESSION_HISTORY_KEY = "funChessEngine.regressionHistory.v1";
const DURABLE_DB_NAME = "FunChessEngine.LocalData";
const DURABLE_DB_VERSION = 1;
const DURABLE_STORE = "metadata";
const MAX_FEN_BYTES = 64 * 1024;
const MAX_PGN_BYTES = 2 * 1024 * 1024;
const MAX_SAVE_BYTES = 50 * 1024 * 1024;
const MAX_RECOVERY_BYTES = 512 * 1024;
const MAX_RESTART_SNAPSHOT_BYTES = 512 * 1024;
const MAX_STUDY_BYTES = 2 * 1024 * 1024;
const MAX_BACKUP_BYTES = 16 * 1024 * 1024;
const MAX_LIBRARY_GAMES = 500;
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
  sidebarWidth: 460,
  zen: false,
  highContrast: false,
  largeText: false,
  analysisPreset: "balanced",
  visionMode: "normal",
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
let positionBookmarks = loadPositionBookmarks();
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
let trainerFocusMode = "due";
let trainerSessionKeys = null;
let applyingAnalysisPreset = false;
let manualPositionAnalysisQueued = false;
const positionAnalysisCache = new Map(loadPositionAnalysisCache());
const tabScrollPositions = new Map();
let analysisQueue = loadAnalysisQueue();
let analysisQueueBusy = false;
let analysisQueueCancel = false;
let tournamentState = null;
let tournamentHistory = loadTournamentHistory();
let coordinateTarget = null;
let coordinateCorrect = 0;
let coordinateAttempts = 0;
let coordinateWasPaused = true;
let onboardingStep = 0;
let lessons = loadLessons();
let lessonDraftCards = [];
let enginePresets = loadEnginePresets();
let pluginManifests = loadPluginManifests();
let externalEngines = loadExternalEngines();
let sessionGoals = loadSessionGoals();
let calibrationHistory = loadCalibrationHistory();
let externalCompareHistory = loadExternalCompareHistory();
let regressionHistory = loadRegressionHistory();
let positionInsightsData = null;
let positionInsightsBusy = false;
let lanInfo = { running: false };
let indexedLibraryStatus = { games: 0, positions: 0 };

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[char]));
}

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
    if (globalThis.engineLabDesktop?.writeMetadata) await globalThis.engineLabDesktop.writeMetadata(key, snapshot);
    await writeDurableValue(key, snapshot);
    try {
      if (localStorage.getItem(key) === serialized) localStorage.removeItem(key);
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
    { key: CALIBRATION_HISTORY_KEY, get: () => calibrationHistory,
      set: value => { calibrationHistory = Array.isArray(value) ? value.slice(0, 20) : []; } },
    { key: EXTERNAL_COMPARE_HISTORY_KEY, get: () => externalCompareHistory,
      set: value => { externalCompareHistory = Array.isArray(value) ? value.slice(0, 30) : []; } },
    { key: REGRESSION_HISTORY_KEY, get: () => regressionHistory,
      set: value => { regressionHistory = Array.isArray(value) ? value.slice(0, 30) : []; } },
    {
      key: RECENTS_KEY,
      get: () => recentGames,
      set: (value) => { recentGames = Array.isArray(value) ? value.filter((item) => item && Array.isArray(item.moves)).slice(0, MAX_LIBRARY_GAMES) : []; },
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
      key: BOOKMARKS_KEY,
      get: () => positionBookmarks,
      set: (value) => { positionBookmarks = Array.isArray(value) ? value.filter((item) => item?.fen).slice(0, 100) : []; },
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
    {
      key: ANALYSIS_QUEUE_KEY,
      get: () => analysisQueue,
      set: (value) => { analysisQueue = Array.isArray(value) ? value.filter((item) => item?.recent_id).slice(0, 100) : []; },
    },
    {
      key: TOURNAMENT_HISTORY_KEY,
      get: () => tournamentHistory,
      set: (value) => { tournamentHistory = Array.isArray(value) ? value.slice(0, 20) : []; },
    },
    {
      key: LESSONS_KEY,
      get: () => lessons,
      set: (value) => { lessons = Array.isArray(value) ? value.filter((item) => item?.title).slice(0, 100) : []; },
    },
    {
      key: ENGINE_PRESETS_KEY,
      get: () => enginePresets,
      set: (value) => { enginePresets = Array.isArray(value) ? value.filter((item) => item?.name).slice(0, 30) : []; },
    },
    {
      key: PLUGINS_KEY,
      get: () => pluginManifests,
      set: (value) => { pluginManifests = Array.isArray(value) ? value.filter((item) => item?.id).slice(0, 50) : []; },
    },
    {
      key: EXTERNAL_ENGINES_KEY,
      get: () => externalEngines,
      set: (value) => { externalEngines = Array.isArray(value) ? value.filter((item) => item?.path).slice(0, 12) : []; },
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
      if (globalThis.engineLabDesktop?.readMetadata) {
        const native = await globalThis.engineLabDesktop.readMetadata(spec.key);
        if (native.found) { spec.set(native.value); continue; }
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
          if (globalThis.engineLabDesktop?.writeMetadata) await globalThis.engineLabDesktop.writeMetadata(spec.key, spec.get());
          try { localStorage.removeItem(spec.key); } catch (_) {}
          continue;
        } catch (error) {
          console.warn(`Could not migrate ${spec.key}; checking IndexedDB copy instead.`, error);
        }
      }
      const stored = await readDurableValue(spec.key);
      if (stored !== undefined) {
        spec.set(stored);
        if (globalThis.engineLabDesktop?.writeMetadata) await globalThis.engineLabDesktop.writeMetadata(spec.key, spec.get());
      }
    }
    durableMetadataHydrated = true;
    if (state) {
      renderRecentGames();
      renderOpeningExplorer();
      renderTrainerPanel();
      renderDeveloperHistory();
      renderVariationWorkspace();
      renderStudyLibrary();
      renderBookmarks();
      renderLessons();
      renderEnginePresets();
      renderPlugins();
      renderExternalEngines();
      renderCalibrationEngines();
      renderAdvancedTournament();
      renderWorkstationHistory();
      renderExternalComparisonHistory();
      renderLauncher();
      renderBoard();
    }
  } catch (error) {
    durableMetadataHydrated = true;
    console.warn("IndexedDB metadata store unavailable; using localStorage fallback.", error);
  }
}

function mirrorDesktopPreference(key) {
  if (!globalThis.engineLabDesktop?.writeMetadata) return;
  const value = JSON.parse(localStorage.getItem(key) || "null");
  void globalThis.engineLabDesktop.writeMetadata(key, value).catch(reportPersistenceError);
}

async function hydrateDesktopPreferences() {
  if (!globalThis.engineLabDesktop?.readMetadata) return;
  try {
    for (const key of [DISPLAY_KEY, SESSION_GOALS_KEY, RECOVERY_KEY, POSITION_CACHE_KEY, ONBOARDING_KEY]) {
      const saved = await globalThis.engineLabDesktop.readMetadata(key);
      if (saved.found) {
        if (saved.value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, key === ONBOARDING_KEY ? saved.value : JSON.stringify(saved.value));
      } else {
        const value = localStorage.getItem(key);
        if (value != null) await globalThis.engineLabDesktop.writeMetadata(key, key === ONBOARDING_KEY ? value : JSON.parse(value));
      }
    }
    display = loadDisplaySettings();
    sessionGoals = loadSessionGoals();
    startupRecovery = loadRecoverySnapshot();
    recoveryResolved = !startupRecovery;
    positionAnalysisCache.clear();
    for (const [key, value] of loadPositionAnalysisCache()) positionAnalysisCache.set(key, value);
    applyDisplaySettings(false);
  } catch (error) { reportPersistenceError(error); }
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

const ENGINE_STRENGTH_LABELS = new Map([
  [20, ["Beginner · ~800", "Short searches with deliberately forgiving move selection."]],
  [40, ["Casual · ~1200", "Reduced search time with more varied, beatable choices."]],
  [60, ["Intermediate · ~1600", "Moderate calculation with occasional non-best choices."]],
  [70, ["Advanced · ~1900", "Strong calculation with a reduced search budget."]],
  [85, ["Expert · ~2200", "Near-full search strength with reduced thinking time."]],
  [100, ["Maximum", "Full search strength and the engine's strongest move selection."]],
]);

function engineProfileForSkill(skill) {
  if (skill <= 60) return "beginner";
  return "maximum";
}

function estimatedAdaptiveSkill() {
  const analyzed = recentGames.filter((item) => item.analysis?.summary || item.analysis?.results?.length);
  if (!analyzed.length) return 60;
  const accuracies = analyzed.map((item) => Number(item.analysis?.summary?.accuracy || item.analysis?.summary?.accuracy_score || 0)).filter((value) => value > 0);
  const avgAccuracy = accuracies.length ? accuracies.reduce((sum, value) => sum + value, 0) / accuracies.length : 75;
  return nearestEngineSkill(Math.max(30, Math.min(90, 25 + avgAccuracy * 0.7)));
}

function nearestEngineSkill(rawSkill) {
  const skill = Math.max(1, Math.min(100, Number(rawSkill) || 100));
  return [...ENGINE_STRENGTH_LABELS.keys()].reduce((best, value) => (
    Math.abs(value - skill) < Math.abs(best - skill) ? value : best
  ), 100);
}

function renderEngineStrength() {
  const select = $("engineStrengthSelect");
  if (!select || !state) return;
  const skill = nearestEngineSkill(state.engine_skill);
  const [label, hint] = ENGINE_STRENGTH_LABELS.get(skill) || ENGINE_STRENGTH_LABELS.get(100);
  const adaptive = state.engine_profile === "adaptive";
  if (document.activeElement !== select) select.value = adaptive ? "adaptive" : String(skill);
  $("engineStrengthValue").textContent = adaptive ? `Adaptive · ${label}` : label;
  $("engineStrengthHint").textContent = $("humanSide").value === "both"
    ? "Engine strength is not used in local two-player mode."
    : adaptive
    ? `Adaptive mode currently targets ${label} from your analyzed local games.`
    : hint;
  select.disabled = busy || $("humanSide").value === "both";
  if ($("engineProfileSelect") && document.activeElement !== $("engineProfileSelect")) {
    $("engineProfileSelect").value = ["maximum", "fast", "beginner", "aggressive", "solid", "adaptive"].includes(state.engine_profile)
      ? state.engine_profile
      : "maximum";
  }
  if ($("engineMoveCapInput") && document.activeElement !== $("engineMoveCapInput")) {
    $("engineMoveCapInput").value = String(Number(state.engine_move_time_cap_ms || 2500));
  }
}

async function applyEngineStrength() {
  const select = $("engineStrengthSelect");
  if (!select || busy) return;
  const adaptive = select.value === "adaptive";
  const skill = adaptive ? estimatedAdaptiveSkill() : nearestEngineSkill(select.value);
  const profile = adaptive ? "adaptive" : engineProfileForSkill(skill);
  const [label] = ENGINE_STRENGTH_LABELS.get(skill) || ENGINE_STRENGTH_LABELS.get(100);
  select.disabled = true;
  setStatus(`Setting engine strength to ${label}…`, "loading");
  try {
    const config = await api("/api/engine-config", { profile, skill });
    state.engine_profile = config.profile;
    state.engine_skill = config.skill;
    state.engine_move_time_cap_ms = config.move_time_cap_ms;
    setStatus(`Engine strength set to ${adaptive ? `Adaptive (${label})` : label}.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    renderEngineStrength();
  }
}

async function applyEngineConfig() {
  if (!state || busy) return;
  const profile = $("engineProfileSelect")?.value || "maximum";
  const moveCap = Math.max(50, Math.min(10000, Math.floor(Number($("engineMoveCapInput")?.value) || 2500)));
  try {
    const config = await api("/api/engine-config", {
      profile,
      skill: Number(state.engine_skill || 100),
      move_time_cap_ms: moveCap,
    });
    state.engine_profile = config.profile;
    state.engine_skill = config.skill;
    state.engine_move_time_cap_ms = config.move_time_cap_ms;
    renderEngineStrength();
    setStatus(`Engine personality set to ${capitalize(config.profile)} with a ${config.move_time_cap_ms} ms move cap.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
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
      ? saved.filter((item) => item && Array.isArray(item.moves)).slice(0, MAX_LIBRARY_GAMES)
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

function loadAnalysisQueue() {
  try {
    const saved = JSON.parse(localStorage.getItem(ANALYSIS_QUEUE_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((item) => item?.recent_id).slice(0, 100) : [];
  } catch (_) {
    return [];
  }
}

function saveAnalysisQueue() {
  analysisQueue = analysisQueue.slice(0, 100);
  persistDurableValue(ANALYSIS_QUEUE_KEY, analysisQueue);
}

function loadTournamentHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(TOURNAMENT_HISTORY_KEY) || "[]");
    return Array.isArray(saved) ? saved.slice(0, 20) : [];
  } catch (_) {
    return [];
  }
}

function loadLessons() {
  try {
    const saved = JSON.parse(localStorage.getItem(LESSONS_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((item) => item?.title).slice(0, 100) : [];
  } catch (_) {
    return [];
  }
}

function loadEnginePresets() {
  try {
    const saved = JSON.parse(localStorage.getItem(ENGINE_PRESETS_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((item) => item?.name).slice(0, 30) : [];
  } catch (_) {
    return [];
  }
}

function loadPluginManifests() {
  try {
    const saved = JSON.parse(localStorage.getItem(PLUGINS_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((item) => item?.id).slice(0, 50) : [];
  } catch (_) {
    return [];
  }
}

function loadExternalEngines() {
  try {
    const saved = JSON.parse(localStorage.getItem(EXTERNAL_ENGINES_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((item) => item?.path).slice(0, 12) : [];
  } catch (_) {
    return [];
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function loadSessionGoals() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_GOALS_KEY) || "null");
    const normalized = saved && typeof saved === "object" ? saved : {};
    if (normalized.date !== todayKey()) {
      normalized.date = todayKey();
      normalized.progress = { tactics: 0, repertoire: 0, endgames: 0, losses: 0 };
    }
    normalized.targets = {
      tactics: Math.max(0, Math.min(200, Number(normalized.targets?.tactics || 20))),
      repertoire: Math.max(0, Math.min(200, Number(normalized.targets?.repertoire || 10))),
      endgames: Math.max(0, Math.min(50, Number(normalized.targets?.endgames || 1))),
      losses: Math.max(0, Math.min(50, Number(normalized.targets?.losses || 1))),
    };
    normalized.progress = {
      tactics: Math.max(0, Number(normalized.progress?.tactics || 0)),
      repertoire: Math.max(0, Number(normalized.progress?.repertoire || 0)),
      endgames: Math.max(0, Number(normalized.progress?.endgames || 0)),
      losses: Math.max(0, Number(normalized.progress?.losses || 0)),
    };
    return normalized;
  } catch (_) {
    return {
      date: todayKey(),
      targets: { tactics: 20, repertoire: 10, endgames: 1, losses: 1 },
      progress: { tactics: 0, repertoire: 0, endgames: 0, losses: 0 },
    };
  }
}

function loadCalibrationHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(CALIBRATION_HISTORY_KEY) || "[]");
    return Array.isArray(saved) ? saved.slice(0, 20) : [];
  } catch (_) { return []; }
}

function loadExternalCompareHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(EXTERNAL_COMPARE_HISTORY_KEY) || "[]");
    return Array.isArray(saved) ? saved.slice(0, 30) : [];
  } catch (_) { return []; }
}

function loadRegressionHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(REGRESSION_HISTORY_KEY) || "[]");
    return Array.isArray(saved) ? saved.slice(0, 30) : [];
  } catch (_) { return []; }
}

function saveLessons() {
  lessons = lessons.slice(0, 100);
  persistDurableValue(LESSONS_KEY, lessons);
}

function saveEnginePresets() {
  enginePresets = enginePresets.slice(0, 30);
  persistDurableValue(ENGINE_PRESETS_KEY, enginePresets);
}

function savePluginManifests() {
  pluginManifests = pluginManifests.slice(0, 50);
  persistDurableValue(PLUGINS_KEY, pluginManifests);
}

function saveExternalEngines() {
  externalEngines = externalEngines.slice(0, 12);
  persistDurableValue(EXTERNAL_ENGINES_KEY, externalEngines);
}

function saveSessionGoals() {
  localStorage.setItem(SESSION_GOALS_KEY, JSON.stringify(sessionGoals));
    mirrorDesktopPreference(SESSION_GOALS_KEY);
}

function saveCalibrationHistory() {
  calibrationHistory = calibrationHistory.slice(0, 20);
  persistDurableValue(CALIBRATION_HISTORY_KEY, calibrationHistory);
}

function saveExternalCompareHistory() {
  externalCompareHistory = externalCompareHistory.slice(0, 30);
  persistDurableValue(EXTERNAL_COMPARE_HISTORY_KEY, externalCompareHistory);
}

function saveRegressionHistory() {
  regressionHistory = regressionHistory.slice(0, 30);
  persistDurableValue(REGRESSION_HISTORY_KEY, regressionHistory);
}

function loadPositionAnalysisCache() {
  try {
    const saved = JSON.parse(localStorage.getItem(POSITION_CACHE_KEY) || "[]");
    return Array.isArray(saved)
      ? saved.filter((entry) => Array.isArray(entry) && typeof entry[0] === "string" && entry[1]).slice(-30)
      : [];
  } catch (_) {
    return [];
  }
}

function savePositionAnalysisCache() {
  try {
    localStorage.setItem(POSITION_CACHE_KEY, JSON.stringify([...positionAnalysisCache.entries()].slice(-30)));
    mirrorDesktopPreference(POSITION_CACHE_KEY);
  } catch (_) {
    // The cache is an optimization only; analysis still works when storage is unavailable.
  }
}

function saveTournamentHistory() {
  tournamentHistory = tournamentHistory.slice(0, 20);
  persistDurableValue(TOURNAMENT_HISTORY_KEY, tournamentHistory);
}

function saveBenchmarkHistory() {
  benchmarkHistory = benchmarkHistory.slice(0, 20);
  persistDurableValue(BENCHMARK_HISTORY_KEY, benchmarkHistory);
}

function loadVariationWorkspaces() {
  try {
    const saved = JSON.parse(localStorage.getItem(VARIATIONS_KEY) || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(
      Object.entries(saved)
        .map(([key, workspace]) => [key, normalizeVariationWorkspace(workspace)])
        .filter(([, workspace]) => workspace?.root && workspace?.nodes?.[workspace.root]),
    );
  } catch (_) {
    return {};
  }
}

function normalizeVariationWorkspace(workspace) {
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return null;
  if (!workspace.nodes || typeof workspace.nodes !== "object") return workspace;
  workspace.edges = workspace.edges && typeof workspace.edges === "object" ? workspace.edges : {};
  for (const node of Object.values(workspace.nodes)) {
    if (!node || typeof node !== "object") continue;
    node.children = Array.isArray(node.children) ? [...new Set(node.children)] : [];
    node.parents = Array.isArray(node.parents) ? [...new Set(node.parents)] : [];
    if (node.parent && !node.parents.includes(node.parent)) node.parents.unshift(node.parent);
    if (!node.parent && node.parents.length) node.parent = node.parents[0];
  }
  // Rebuild parent references first. Legacy studies kept the incoming move on
  // the child node, which is only trustworthy for that child's primary parent.
  for (const [parentId, parent] of Object.entries(workspace.nodes)) {
    for (const childId of parent?.children || []) {
      const child = workspace.nodes[childId];
      if (!child) continue;
      if (!child.parents.includes(parentId)) child.parents.push(parentId);
      if (!child.parent) child.parent = parentId;
    }
  }
  for (const [parentId, parent] of Object.entries(workspace.nodes)) {
    const keptChildren = [];
    for (const childId of parent?.children || []) {
      const child = workspace.nodes[childId];
      if (!child) continue;
      const edgeKey = `${parentId}>${childId}`;
      if (!workspace.edges[edgeKey]) {
        if (child.parents.length > 1 && child.parent !== parentId) {
          workspace.needs_edge_migration = true;
          keptChildren.push(childId);
          continue;
        }
        workspace.edges[edgeKey] = {
          move_uci: child.move_uci || "",
          move_san: child.move_san || child.move_uci || "Move",
        };
      }
      keptChildren.push(childId);
    }
    parent.children = keptChildren;
  }
  if (workspace.root && workspace.nodes[workspace.root]) {
    workspace.nodes[workspace.root].parent = null;
    workspace.nodes[workspace.root].parents = [];
  }
  try { validateStudyGraph(workspace); } catch (_) { return null; }
  return workspace;
}

function loadPositionBookmarks() {
  try {
    const saved = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((item) => item?.fen).slice(0, 100) : [];
  } catch (_) {
    return [];
  }
}

function savePositionBookmarks() {
  positionBookmarks = positionBookmarks.slice(0, 100);
  persistDurableValue(BOOKMARKS_KEY, positionBookmarks);
}

function persistVariationWorkspaces() {
  const entries = Object.entries(savedVariationWorkspaces)
    .map(([key, workspace]) => [key, normalizeVariationWorkspace(workspace)])
    .filter(([, workspace]) => workspace)
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
  normalizeVariationWorkspace(variationWorkspace);
  variationWorkspace.name = String(variationWorkspace.name || defaultStudyName(variationWorkspace.origin_ply)).slice(0, 80);
  variationWorkspace.kind = variationWorkspace.kind === "repertoire" ? "repertoire" : "study";
  variationWorkspace.last_node = variationNodeId;
  variationWorkspace.updated_at = new Date().toISOString();
  savedVariationWorkspaces[variationWorkspace.storage_key] = variationWorkspace;
  persistVariationWorkspaces();
}

function defaultStudyName(originPly = 0) {
  const opening = state?.opening?.name || (state?.initial_fen === STARTING_FEN ? "Starting position" : "Custom position");
  return `${opening} · ply ${Number(originPly || 0)}`.slice(0, 80);
}

function cacheCurrentAnalysis() {
  if (!state || !gameAnalysis?.results?.length) return;
  const snapshot = gameSnapshot();
  const signature = gameSignature(snapshot);
  const existing = recentGames.findIndex((item) => gameSignature(item) === signature);
  if (existing >= 0) {
    recentGames[existing] = { ...recentGames[existing], analysis: gameAnalysis };
    saveRecentGames();
    void learnOpeningBookFromGame(recentGames[existing]);
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
      motifs: Array.isArray(result.motifs) ? result.motifs.slice(0, 12) : [],
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
  recentGames = recentGames.slice(0, MAX_LIBRARY_GAMES);
  persistDurableValue(RECENTS_KEY, recentGames);
}

function trimRecentGames() {
  while (recentGames.length > MAX_LIBRARY_GAMES) {
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
  if (snapshot.analysis?.results?.length) void learnOpeningBookFromGame(snapshot);
}

async function learnOpeningBookFromGame(snapshot) {
  const score = personalGameScore(snapshot);
  if (score === null || !Array.isArray(snapshot.analysis?.results)) return;
  const profile = snapshot.engine_profile || state?.engine_profile || "default";
  for (const result of snapshot.analysis.results.slice(0, 30)) {
    if (!result?.fen_before || !result?.played_uci) continue;
    try {
      await api("/api/opening-book", {
        action: "learn",
        fen: result.fen_before,
        move: result.played_uci,
        score,
        profile,
      });
    } catch (_) {
      // Learning only affects book entries that already exist for this profile.
    }
  }
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
  const analyzedOnly = Boolean($("recentAnalyzedOnly")?.checked);
  const resultFilter = $("recentResultFilter")?.value || "all";
  const sortMode = $("recentSort")?.value || "recent";
  const analyzedCount = recentGames.filter((snapshot) => Array.isArray(snapshot.analysis?.results) && snapshot.analysis.results.length).length;
  const favoriteCount = recentGames.filter((snapshot) => snapshot.favorite).length;
  const decisiveCount = recentGames.filter((snapshot) => ["1-0", "0-1"].includes(snapshot.result || snapshot.manual_result)).length;
  const stats = $("libraryStats");
  if (stats) {
    stats.innerHTML = "";
    [["Games", recentGames.length], ["Analyzed", analyzedCount], ["Favorites", favoriteCount], ["Decisive", decisiveCount]].forEach(([label, value]) => {
      const cell = document.createElement("div");
      cell.className = "library-stat";
      const caption = document.createElement("span");
      caption.textContent = label;
      const number = document.createElement("strong");
      number.textContent = String(value);
      cell.append(caption, number);
      stats.appendChild(cell);
    });
  }
  const entries = recentGames
    .map((snapshot, index) => ({ snapshot, index }))
    .filter(({ snapshot }) => {
      if (favoritesOnly && !snapshot.favorite) return false;
      if (analyzedOnly && !(Array.isArray(snapshot.analysis?.results) && snapshot.analysis.results.length)) return false;
      if (resultFilter !== "all" && (snapshot.result || snapshot.manual_result || "*") !== resultFilter) return false;
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
    .sort((left, right) => {
      if (sortMode === "favorite") {
        return Number(Boolean(right.snapshot.favorite)) - Number(Boolean(left.snapshot.favorite))
          || String(right.snapshot.saved_at || "").localeCompare(String(left.snapshot.saved_at || ""));
      }
      if (sortMode === "moves") return (right.snapshot.moves?.length || 0) - (left.snapshot.moves?.length || 0);
      return String(right.snapshot.saved_at || "").localeCompare(String(left.snapshot.saved_at || ""));
    });
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
  renderLauncherRecents();
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
    () => snapshot.pgn_text
      ? api("/api/load-pgn", { pgn: snapshot.pgn_text })
      : api("/api/load-game", backendSnapshot(snapshot)),
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
    if (launcherVisible()) await enterWorkbench("engine", false);
    else await activateTab(document.querySelector('[data-tab="engine"]'));
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

function importedGameSnapshot(game, sourceName = "PGN collection", referenceDatabase = false) {
  const headers = game?.headers && typeof game.headers === "object" ? game.headers : {};
  const result = ["1-0", "0-1", "1/2-1/2"].includes(headers.Result) ? headers.Result : "*";
  return {
    format: "FunChessEngine.GamePNG",
    version: 1,
    recent_id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    saved_at: new Date().toISOString(),
    imported_from: sourceName,
    reference_database: Boolean(referenceDatabase),
    initial_fen: game.initial_fen || STARTING_FEN,
    moves: Array.isArray(game.moves_uci) ? game.moves_uci.slice(0, 1000) : [],
    pgn_text: String(game.pgn || ""),
    pgn_headers: headers,
    result,
    manual_result: result === "*" ? null : result,
    human_side: "white",
    autoplay: false,
    paused: true,
    variant: game.variant === "chess960" ? "chess960" : "standard",
    favorite: false,
    analysis: null,
  };
}

async function importPgnCollectionText(text, sourceName = "PGN collection", referenceDatabase = false) {
  const pgn = String(text || "");
  if (!pgn.trim()) return 0;
  if (utf8ByteLength(pgn) > MAX_PGN_BYTES) throw new Error(`${sourceName} exceeds the 2 MB import limit.`);
  const parsed = await api("/api/parse-pgn-batch", { pgn, max_games: MAX_LIBRARY_GAMES });
  const games = Array.isArray(parsed.games) ? parsed.games : [];
  let added = 0;
  for (const game of games) {
    const snapshot = importedGameSnapshot(game, sourceName, referenceDatabase);
    const signature = gameSignature(snapshot);
    const existing = recentGames.findIndex((item) => gameSignature(item) === signature);
    if (existing >= 0) {
      const prior = recentGames[existing];
      snapshot.favorite = Boolean(prior.favorite);
      snapshot.analysis = prior.analysis || null;
      snapshot.recent_id = prior.recent_id || snapshot.recent_id;
      recentGames.splice(existing, 1);
    } else {
      added += 1;
    }
    recentGames.unshift(snapshot);
  }
  trimRecentGames();
  saveRecentGames();
  renderRecentGames();
  renderOpeningExplorer();
  renderOpeningPrepReport();
  renderPlayerProfile();
  return added;
}

async function importPgnCollectionFiles(files) {
  const list = [...(files || [])];
  if (!list.length) return;
  let added = 0;
  for (const file of list) {
    assertBrowserFileSize(file, MAX_PGN_BYTES, file.name || "PGN file");
    added += await importPgnCollectionText(await file.text(), file.name || "PGN collection");
  }
  setStatus(`Imported ${added} new game${added === 1 ? "" : "s"} into the local library.`, "success");
}

async function importOpeningDatabaseFiles(files) {
  const list = [...(files || [])];
  if (!list.length) return;
  let imported = 0;
  let duplicates = 0;
  let positions = 0;
  for (const file of list) {
    const token = await uploadLocalFile(file);
    let result;
    try { result = await runBackgroundJob("reference-import", {token}); }
    finally { await api("/api/library-upload", {action:"cancel",token}).catch(()=>{}); }
    imported += Number(result.imported || 0);
    duplicates += Number(result.duplicates || 0);
    positions += Number(result.positions || 0);
  }
  await refreshOpeningDatabaseStatus();
  renderRepertoireGaps();
  setStatus(
    `Indexed ${imported} new reference game${imported === 1 ? "" : "s"} and ${positions} positions${duplicates ? ` · ${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped` : ""}.`,
    "success",
  );
}

function queueableLibraryGames() {
  return recentGames.filter((snapshot) => (
    snapshot?.recent_id
    && snapshot.pgn_text
    && !(Array.isArray(snapshot.analysis?.results) && snapshot.analysis.results.length)
  ));
}

function renderAnalysisQueue() {
  const count = $("analysisQueueCount");
  const text = $("queueProgressText");
  const bar = $("queueProgressBar");
  if (!count || !text || !bar) return;
  const total = analysisQueue.length;
  const done = analysisQueue.filter((item) => item.status === "done").length;
  const failed = analysisQueue.filter((item) => item.status === "error").length;
  const pending = analysisQueue.filter((item) => !["done", "error"].includes(item.status)).length;
  count.textContent = analysisQueueBusy ? `${pending} queued` : `${queueableLibraryGames().length} available`;
  const pct = total ? Math.round(((done + failed) / total) * 100) : 0;
  bar.style.width = `${pct}%`;
  text.textContent = analysisQueueBusy
    ? `${done + failed} / ${total}${failed ? ` · ${failed} failed` : ""}`
    : total && done + failed === total
    ? `Finished ${done}/${total}${failed ? ` · ${failed} failed` : ""}`
    : "Idle";
  $("cancelQueueBtn").disabled = !analysisQueueBusy;
  $("analyzeLibraryBtn").disabled = analysisQueueBusy || queueableLibraryGames().length === 0;
}

async function runLibraryAnalysisQueue() {
  if (analysisQueueBusy) return;
  const games = queueableLibraryGames();
  if (!games.length) {
    setStatus("No imported unanalyzed PGN games are waiting in the library.");
    renderAnalysisQueue();
    return;
  }
  analysisQueue = games.map((snapshot) => ({ recent_id: snapshot.recent_id, status: "queued" }));
  analysisQueueBusy = true;
  analysisQueueCancel = false;
  saveAnalysisQueue();
  renderAnalysisQueue();
  setStatus(`Analyzing ${analysisQueue.length} library games locally…`, "loading");
  for (const item of analysisQueue) {
    if (analysisQueueCancel) break;
    const snapshot = recentGames.find((game) => game.recent_id === item.recent_id);
    if (!snapshot?.pgn_text) {
      item.status = "error";
      item.error = "PGN source unavailable";
      continue;
    }
    item.status = "running";
    saveAnalysisQueue();
    renderAnalysisQueue();
    try {
      const result = await runBackgroundJob("analyze-pgn", { pgn: snapshot.pgn_text, budget_ms: 120 });
      snapshot.analysis = { status: "complete", ...result };
      item.status = "done";
      saveRecentGames();
    } catch (error) {
      item.status = "error";
      item.error = String(error?.message || error);
    }
    saveAnalysisQueue();
    renderAnalysisQueue();
  }
  analysisQueueBusy = false;
  const canceled = analysisQueueCancel;
  analysisQueueCancel = false;
  saveAnalysisQueue();
  renderRecentGames();
  renderAnalysisQueue();
  renderOpeningPrepReport();
  renderPlayerProfile();
  renderWeaknessProfile();
  setStatus(canceled ? "Library analysis queue canceled." : "Library analysis queue finished.", canceled ? "info" : "success");
}

function fenPositionKey(fen) {
  return String(fen || "").trim().split(/\s+/).slice(0, 4).join(" ");
}

function renderPositionSearch() {
  const target = $("positionSearchResults");
  if (!target) return;
  target.innerHTML = "";
  const key = fenPositionKey(currentBoardView()?.fen || state?.fen);
  if (!key) return;
  const matches = [];
  recentGames.forEach((snapshot, index) => {
    const positions = new Set([
      fenPositionKey(snapshot.initial_fen),
      fenPositionKey(snapshot.final_fen),
      ...(snapshot.analysis?.results || []).map((result) => fenPositionKey(result.fen_before)),
    ].filter(Boolean));
    if (positions.has(key)) matches.push({ snapshot, index });
  });
  $("positionSearchCount").textContent = `${matches.length} match${matches.length === 1 ? "" : "es"}`;
  if (!matches.length) {
    target.innerHTML = '<p class="hint">No saved game contains this exact stored/analyzed position yet.</p>';
    return;
  }
  matches.slice(0, 30).forEach(({ snapshot, index }) => {
    const button = document.createElement("button");
    button.className = "compact-list-row";
    const headers = snapshot.pgn_headers || {};
    const strong = document.createElement("strong");
    strong.textContent = `${headers.White || "White"} – ${headers.Black || "Black"}`;
    const span = document.createElement("span");
    span.textContent = snapshot.opening?.name || headers.Event || "Saved game";
    button.append(strong, span);
    button.addEventListener("click", () => openRecentGame(index));
    target.appendChild(button);
  });
}

function studyEntries() {
  return Object.entries(savedVariationWorkspaces)
    .filter(([, workspace]) => workspace?.root && workspace?.nodes?.[workspace.root]);
}

function studyNodeCount(workspace) {
  return workspace?.nodes ? Object.keys(workspace.nodes).length : 0;
}

function renderStudyLibrary() {
  const target = $("studyLibraryList");
  if (!target) return;
  const query = $("studyLibrarySearch")?.value.trim().toLowerCase() || "";
  const kind = $("studyKindFilter")?.value || "all";
  const sort = $("studySort")?.value || "updated";
  let entries = studyEntries().filter(([, workspace]) => {
    const workspaceKind = workspace.kind === "repertoire" ? "repertoire" : "study";
    if (kind !== "all" && workspaceKind !== kind) return false;
    if (!query) return true;
    return `${workspace.name || "Untitled study"} ${workspaceKind} ${workspace.folder || ""} ${(workspace.tags || []).join(" ")}`.toLowerCase().includes(query);
  });
  entries.sort((left, right) => {
    if (sort === "name") return String(left[1].name || "").localeCompare(String(right[1].name || ""));
    if (sort === "size") return studyNodeCount(right[1]) - studyNodeCount(left[1]);
    return Number(Boolean(right[1].favorite)) - Number(Boolean(left[1].favorite))
      || String(right[1].updated_at || "").localeCompare(String(left[1].updated_at || ""));
  });
  $("studyLibraryCount").textContent = query || kind !== "all" ? `${entries.length}/${studyEntries().length}` : String(entries.length);
  target.innerHTML = "";
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "hint recent-empty";
    empty.textContent = studyEntries().length ? "No studies match this filter." : "Branch from an analysis position to create your first named study.";
    target.appendChild(empty);
    renderLauncherRecents();
    return;
  }
  entries.forEach(([key, workspace]) => {
    const row = document.createElement("div");
    row.className = "study-library-row";
    row.classList.toggle("favorite", Boolean(workspace.favorite));
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = workspace.name || "Untitled study";
    const meta = document.createElement("span");
    const updated = workspace.updated_at ? new Date(workspace.updated_at) : null;
    const when = updated && !Number.isNaN(updated.getTime()) ? updated.toLocaleDateString() : "Local";
    const organization = [workspace.folder, ...(workspace.tags || []).slice(0, 3)].filter(Boolean).join(" · ");
    meta.textContent = `${workspace.kind === "repertoire" ? "Repertoire" : "Study"} · ${studyNodeCount(workspace)} positions · ${when}${organization ? ` · ${organization}` : ""}`;
    info.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "study-library-actions";
    const favorite = document.createElement("button");
    favorite.className = "secondary compact";
    favorite.textContent = workspace.favorite ? "★" : "☆";
    favorite.setAttribute("aria-label", workspace.favorite ? "Remove study bookmark" : "Bookmark study");
    favorite.addEventListener("click", () => toggleStudyFavorite(key));
    const open = document.createElement("button");
    open.className = "secondary compact";
    open.textContent = "Open";
    open.addEventListener("click", () => openSavedStudy(key));
    const exportButton = document.createElement("button");
    exportButton.className = "secondary compact";
    exportButton.textContent = "Export";
    exportButton.addEventListener("click", () => exportStudyWorkspace(key));
    const remove = document.createElement("button");
    remove.className = "text-button compact";
    remove.textContent = "Delete";
    remove.disabled = variationMode && variationWorkspace?.storage_key === key;
    remove.title = remove.disabled ? "Close the active study before deleting it." : "Delete study";
    remove.addEventListener("click", () => deleteStudyWorkspace(key));
    actions.append(favorite, open, exportButton, remove);
    row.append(info, actions);
    target.appendChild(row);
  });
  renderLauncherRecents();
}

function toggleStudyFavorite(key) {
  const workspace = savedVariationWorkspaces[key];
  if (!workspace) return;
  workspace.favorite = !workspace.favorite;
  workspace.updated_at = new Date().toISOString();
  persistVariationWorkspaces();
  if (variationWorkspace?.storage_key === key) variationWorkspace.favorite = workspace.favorite;
  renderStudyLibrary();
  renderVariationWorkspace();
}

async function deleteStudyWorkspace(key) {
  const workspace = savedVariationWorkspaces[key];
  if (!workspace || variationWorkspace?.storage_key === key) return;
  const confirmed = await confirmAction(
    "Delete study?",
    `Delete “${workspace.name || "Untitled study"}” and its ${studyNodeCount(workspace)} saved positions?`,
    "Delete study",
    true,
  );
  if (!confirmed) return;
  delete savedVariationWorkspaces[key];
  persistVariationWorkspaces();
  renderStudyLibrary();
}

async function openSavedStudy(key) {
  let stored = savedVariationWorkspaces[key];
  if (!stored?.root || !stored.nodes?.[stored.root]) return;
  if (setupMode || trainerMode || retryMode || busy) {
    setStatus("Finish the current board task before opening a saved study.", "error");
    return;
  }
  try {
    const checked = await api("/api/workspace-data", {action:"validate-metadata", metadata:{studies:{[key]:stored}}});
    stored = normalizeVariationWorkspace(checked.studies[key]);
    savedVariationWorkspaces[key] = stored;
  } catch (error) { setStatus(error.message,"error"); return; }
  if (launcherVisible()) await enterWorkbench("engine", false);
  else await activateTab(document.querySelector('[data-tab="engine"]'));
  if (reviewMode) await exitReviewMode(false);
  variationWorkspace = stored;
  variationWorkspace.storage_key = key;
  variationNodeId = stored.nodes[stored.last_node] ? stored.last_node : stored.root;
  variationMode = true;
  selected = null;
  saveCurrentVariationWorkspace();
  render();
  scheduleAutoPositionAnalysis(true);
  setStatus(`Opened ${stored.name || "saved study"}.`, "success");
}

async function exportStudyWorkspace(key = variationWorkspace?.storage_key) {
  const workspace = key ? savedVariationWorkspaces[key] || (variationWorkspace?.storage_key === key ? variationWorkspace : null) : variationWorkspace;
  if (!workspace) return;
  const payload = {
    format: "FunChessEngine.Study",
    version: 1,
    exported_at: new Date().toISOString(),
    workspace,
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (new TextEncoder().encode(text).byteLength > MAX_STUDY_BYTES) {
    setStatus("This study is too large to export safely.", "error");
    return;
  }
  const slug = String(workspace.name || "funchess-study").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "funchess-study";
  await downloadBlob(new Blob([text], { type: "application/json;charset=utf-8" }), `${slug}.fce-study.json`);
  setStatus("Study exported.", "success");
}

async function importStudyFile(file) {
  if (!file) return;
  assertBrowserFileSize(file, MAX_STUDY_BYTES, "Study");
  const payload = JSON.parse(await file.text());
  let workspace = payload?.format === "FunChessEngine.Study" && payload?.version === 1 ? payload.workspace : null;
  if (!workspace?.root || !workspace.nodes?.[workspace.root] || studyNodeCount(workspace) > 500) {
    throw new Error("This is not a valid FunChessEngine study file.");
  }
  for (const node of Object.values(workspace.nodes)) {
    if (!node?.id || !node?.snapshot?.fen || !Array.isArray(node.children)) throw new Error("Study contains an invalid position node.");
  }
  validateStudyGraph(workspace);
  const checked = await api("/api/workspace-data", {action:"validate-metadata",metadata:{studies:{imported:workspace}}});
  workspace = normalizeVariationWorkspace(checked.studies.imported);
  const key = `import:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`}`;
  workspace.storage_key = key;
  workspace.name = String(workspace.name || "Imported study").slice(0, 80);
  workspace.kind = workspace.kind === "repertoire" ? "repertoire" : "study";
  workspace.updated_at = new Date().toISOString();
  savedVariationWorkspaces[key] = workspace;
  persistVariationWorkspaces();
  renderStudyLibrary();
  setStatus(`Imported “${workspace.name}”.`, "success");
}

async function bookmarkCurrentPosition() {
  const view = currentBoardView() || state;
  if (!view?.fen) return;
  const existing = positionBookmarks.findIndex((item) => item.fen === view.fen);
  if (existing >= 0) {
    positionBookmarks[existing].updated_at = new Date().toISOString();
    positionBookmarks.unshift(positionBookmarks.splice(existing, 1)[0]);
    setStatus("Position bookmark refreshed.", "success");
  } else {
    const ply = Number(view.ply ?? reviewSnapshot?.ply ?? state?.moves_uci?.length ?? 0);
    const opening = view.opening?.name || state?.opening?.name || "Position";
    positionBookmarks.unshift({
      id: globalThis.crypto?.randomUUID?.() || `bookmark-${Date.now()}-${Math.random()}`,
      fen: view.fen,
      name: `${opening} · ply ${ply}`.slice(0, 80),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    setStatus("Position bookmarked for later analysis.", "success");
  }
  savePositionBookmarks();
  renderBookmarks();
}

function renderBookmarks() {
  const target = $("bookmarkList");
  if (!target) return;
  $("bookmarkCount").textContent = String(positionBookmarks.length);
  target.innerHTML = "";
  positionBookmarks.slice(0, 20).forEach((bookmark, index) => {
    const row = document.createElement("div");
    row.className = "bookmark-row";
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = bookmark.name || "Bookmarked position";
    const meta = document.createElement("span");
    meta.textContent = bookmark.fen;
    info.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "bookmark-actions";
    const open = document.createElement("button");
    open.className = "secondary compact";
    open.textContent = "Analyze";
    open.addEventListener("click", () => openBookmarkedPosition(index));
    const remove = document.createElement("button");
    remove.className = "text-button compact";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => {
      positionBookmarks.splice(index, 1);
      savePositionBookmarks();
      renderBookmarks();
    });
    actions.append(open, remove);
    row.append(info, actions);
    target.appendChild(row);
  });
  if (!positionBookmarks.length) {
    const empty = document.createElement("p");
    empty.className = "hint recent-empty";
    empty.textContent = "Bookmark useful review positions from the Analysis tab.";
    target.appendChild(empty);
  }
}

async function openBookmarkedPosition(index) {
  const bookmark = positionBookmarks[index];
  if (!bookmark || busy || setupMode || trainerMode || retryMode) return;
  if (launcherVisible()) await enterWorkbench("engine", false);
  else await activateTab(document.querySelector('[data-tab="engine"]'));
  if (reviewMode) await exitReviewMode(false);
  const snapshot = await api("/api/position", { fen: bookmark.fen });
  const root = newVariationNode(snapshot);
  const key = `bookmark-study:${bookmark.id}`;
  variationWorkspace = savedVariationWorkspaces[key] || {
    root: root.id,
    origin_ply: 0,
    storage_key: key,
    name: bookmark.name || "Bookmarked position",
    kind: "study",
    nodes: { [root.id]: root },
  };
  variationNodeId = variationWorkspace.nodes[variationWorkspace.last_node] ? variationWorkspace.last_node : variationWorkspace.root;
  variationMode = true;
  saveCurrentVariationWorkspace();
  render();
  scheduleAutoPositionAnalysis(true);
}

function renderLauncherRecents() {
  const target = $("startRecents");
  if (!target) return;
  target.innerHTML = "";
  const groups = [
    {
      title: "Recent games",
      empty: "No saved games yet",
      entries: recentGames.slice(0, 3).map((snapshot, index) => ({
        title: snapshot.opening?.name || `${snapshot.result || snapshot.manual_result || "*"} game`,
        meta: `${Math.ceil((snapshot.moves?.length || 0) / 2)} moves${snapshot.favorite ? " · ★" : ""}`,
        action: () => openRecentGame(index),
      })),
    },
    {
      title: "Recent studies",
      empty: "No studies yet",
      entries: studyEntries()
        .sort((left, right) => Number(Boolean(right[1].favorite)) - Number(Boolean(left[1].favorite)) || String(right[1].updated_at || "").localeCompare(String(left[1].updated_at || "")))
        .slice(0, 3)
        .map(([key, workspace]) => ({
          title: workspace.name || "Untitled study",
          meta: `${workspace.kind === "repertoire" ? "Repertoire" : "Study"} · ${studyNodeCount(workspace)} positions${workspace.favorite ? " · ★" : ""}`,
          action: () => openSavedStudy(key),
        })),
    },
  ];
  groups.forEach((group) => {
    const section = document.createElement("div");
    section.className = "start-recent-group";
    const head = document.createElement("div");
    head.className = "start-recent-head";
    const title = document.createElement("strong");
    title.textContent = group.title;
    const count = document.createElement("span");
    count.textContent = group.entries.length ? `${group.entries.length} shown` : "Local";
    head.append(title, count);
    const list = document.createElement("div");
    list.className = "start-recent-list";
    if (!group.entries.length) {
      const empty = document.createElement("span");
      empty.className = "hint recent-empty";
      empty.textContent = group.empty;
      list.appendChild(empty);
    } else {
      group.entries.forEach((entry) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "start-recent-item";
        const label = document.createElement("strong");
        label.textContent = entry.title;
        const meta = document.createElement("span");
        meta.textContent = entry.meta;
        button.append(label, meta);
        button.addEventListener("click", entry.action);
        list.appendChild(button);
      });
    }
    section.append(head, list);
    target.appendChild(section);
  });
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
    mirrorDesktopPreference(RECOVERY_KEY);
      return;
    }
    const serialized = JSON.stringify(recoveryGameSnapshot());
    if (new TextEncoder().encode(serialized).byteLength > MAX_RECOVERY_BYTES) {
      throw new Error("Session recovery snapshot is too large to save safely.");
    }
    localStorage.setItem(RECOVERY_KEY, serialized);
    mirrorDesktopPreference(RECOVERY_KEY);
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
    mirrorDesktopPreference(RECOVERY_KEY);
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
    if (!["quick", "balanced", "deep", "study", "custom"].includes(merged.analysisPreset)) merged.analysisPreset = DISPLAY_DEFAULTS.analysisPreset;
    if (!["normal", "blindfold", "hide-white", "hide-black"].includes(merged.visionMode)) merged.visionMode = DISPLAY_DEFAULTS.visionMode;
    const pieceScale = Number(merged.pieceScale);
    merged.pieceScale = Number.isFinite(pieceScale)
      ? Math.max(66, Math.min(90, pieceScale))
      : DISPLAY_DEFAULTS.pieceScale;
    const sidebarWidth = Number(merged.sidebarWidth);
    merged.sidebarWidth = Number.isFinite(sidebarWidth) ? Math.max(330, Math.min(520, sidebarWidth)) : DISPLAY_DEFAULTS.sidebarWidth;
    for (const key of ["coords", "targets", "lastMove", "autoOrient", "sound", "zen", "highContrast", "largeText"]) {
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
    mirrorDesktopPreference(DISPLAY_KEY);
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
  root.dataset.zen = display.zen ? "true" : "false";
  root.dataset.highContrast = display.highContrast ? "true" : "false";
  root.dataset.largeText = display.largeText ? "true" : "false";
  root.dataset.visionMode = display.visionMode || "normal";
  root.style.setProperty("--piece-size", `${display.pieceScale / 8}cqw`);
  root.style.setProperty("--sidebar-width", `${display.sidebarWidth}px`);

  $("themeSelect").value = display.theme;
  $("accentSelect").value = display.accent;
  $("appearanceSelect").value = display.appearance;
  $("pieceThemeSelect").value = display.pieceTheme;
  $("evalPerspectiveSelect").value = display.evalPerspective;
  $("pieceSizeInput").value = String(display.pieceScale);
  $("pieceSizeValue").textContent = `${display.pieceScale}%`;
  $("sidebarWidthInput").value = String(display.sidebarWidth);
  $("sidebarWidthValue").textContent = `${display.sidebarWidth} px`;
  $("coordsToggle").checked = Boolean(display.coords);
  $("targetsToggle").checked = Boolean(display.targets);
  $("lastMoveToggle").checked = Boolean(display.lastMove);
  $("autoOrientToggle").checked = Boolean(display.autoOrient);
  $("soundToggle").checked = Boolean(display.sound);
  $("zenToggle").checked = Boolean(display.zen);
  $("highContrastToggle").checked = Boolean(display.highContrast);
  $("largeTextToggle").checked = Boolean(display.largeText);
  if ($("visionModeSelect")) $("visionModeSelect").value = display.visionMode || "normal";
  applyAnalysisPreset(display.analysisPreset || "balanced", false);

  if (typeof wsApply === "function") wsApply();
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
  const threatMap = Boolean($("threatMapToggle")?.checked && positionInsightsData?.fen === view?.fen);
  const heatMap = Boolean($("heatMapToggle")?.checked && multiPvData?.fen === view?.fen);
  const heatMoves = heatMap ? (multiPvData?.lines || []).map((line, index) => ({
    square: String(line.move || "").slice(2, 4),
    rank: index,
  })) : [];
  const attackedWhite = new Set(positionInsightsData?.attacks?.white || []);
  const attackedBlack = new Set(positionInsightsData?.attacks?.black || []);
  const looseSquares = new Set(positionInsightsData?.loose_pieces || []);

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
    if (!setupMode && view?.check && symbol?.toLowerCase() === "k" && ((view.turn === "white") === (symbol === symbol.toUpperCase()))) button.classList.add("check-king");
    if (threatMap && attackedWhite.has(square)) button.classList.add("threat-white");
    if (threatMap && attackedBlack.has(square)) button.classList.add("threat-black");
    if (threatMap && looseSquares.has(square)) button.classList.add("loose-piece");
    const heat = heatMoves.find((item) => item.square === square);
    if (heat) {
      button.classList.add("engine-heat");
      button.style.setProperty("--engine-heat", String(Math.max(.18, .6 - heat.rank * .16)));
    }
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
      piece.className = `piece ${symbol === symbol.toUpperCase() ? "white-piece" : "black-piece"}`;
      piece.textContent = PIECES[symbol];
      if (typeof wsPaintPiece === "function") wsPaintPiece(piece, symbol);
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
  if (typeof wsAnimateBoard === "function") wsAnimateBoard(board, view?.fen, flipped);
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
    if (typeof wsPaintPiece === "function") wsPaintPiece(icon, isWhite ? piece.toUpperCase() : piece);
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
  return {
    id,
    parent,
    parents: parent ? [parent] : [],
    move_uci: moveUci,
    move_san: moveSan,
    snapshot,
    children: [],
    comment: "",
    nag: "",
  };
}

function variationEdge(parentId, childId) {
  const child = variationWorkspace?.nodes?.[childId];
  return workspaceEdge(variationWorkspace, parentId, childId) || {
    move_uci: child?.move_uci || "",
    move_san: child?.move_san || child?.move_uci || "Move",
  };
}

function workspaceEdge(workspace, parentId, childId) {
  const child = workspace?.nodes?.[childId];
  if (!child) return null;
  return workspace?.edges?.[`${parentId}>${childId}`] || {
    move_uci: child.move_uci || "",
    move_san: child.move_san || child.move_uci || "Move",
  };
}

function variationParentFor(node) {
  if (!node) return null;
  const parents = Array.isArray(node.parents) ? node.parents : (node.parent ? [node.parent] : []);
  if (node.last_parent && parents.includes(node.last_parent)) return node.last_parent;
  return parents[0] || null;
}

function variationAncestorIds(startId = variationNodeId) {
  const result = new Set();
  let node = variationWorkspace?.nodes?.[startId];
  while (node) {
    if (result.has(node.id)) break;
    result.add(node.id);
    const parentId = variationParentFor(node);
    node = parentId ? variationWorkspace.nodes[parentId] : null;
  }
  return result;
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
    variationWorkspace = normalizeVariationWorkspace(restored);
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
    name: defaultStudyName(originPly),
    kind: "study",
    favorite: false,
    nodes: { [root.id]: root },
    edges: {},
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
    .find((child) => child && variationEdge(node.id, child.id).move_uci === move);
  if (existing) {
    existing.last_parent = node.id;
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
    const childSnapshot = await api("/api/variation-move", { fen: snapshot.fen, move, chess960: snapshot.variant ? snapshot.variant === "chess960" : undefined });
    const childKey = fenPositionKey(childSnapshot.fen);
    const ancestors = variationAncestorIds(node.id);
    const transposition = Object.values(variationWorkspace.nodes).find((candidate) => (
      candidate?.id !== node.id
      && !ancestors.has(candidate?.id)
      && fenPositionKey(candidate?.snapshot?.fen) === childKey
    ));
    if (transposition) {
      if (!node.children.includes(transposition.id)) node.children.push(transposition.id);
      transposition.parents = Array.isArray(transposition.parents) ? transposition.parents : [];
      if (!transposition.parents.includes(node.id)) transposition.parents.push(node.id);
      transposition.last_parent = node.id;
      variationWorkspace.edges[`${node.id}>${transposition.id}`] = {
        move_uci: move,
        move_san: childSnapshot.move_san || move,
      };
      variationNodeId = transposition.id;
      saveCurrentVariationWorkspace();
      render();
      scheduleAutoPositionAnalysis();
      setStatus("Linked this line to an existing transposition in the study.", "success");
      return true;
    }
    const child = newVariationNode(childSnapshot, node.id, move, childSnapshot.move_san || move);
    variationWorkspace.nodes[child.id] = child;
    node.children.push(child.id);
    variationWorkspace.edges[`${node.id}>${child.id}`] = {
      move_uci: move,
      move_san: childSnapshot.move_san || move,
    };
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

function navigateVariation(id, fromParent = null) {
  if (!variationWorkspace?.nodes[id]) return;
  const node = variationWorkspace.nodes[id];
  if (fromParent && node.parents?.includes(fromParent)) node.last_parent = fromParent;
  variationNodeId = id;
  selected = null;
  saveCurrentVariationWorkspace();
  render();
  scheduleAutoPositionAnalysis();
}

function variationBack() {
  const node = variationNode();
  const parentId = variationParentFor(node);
  if (parentId) navigateVariation(parentId);
}

function deleteVariationBranch() {
  const node = variationNode();
  const parentId = variationParentFor(node);
  if (!parentId || !variationWorkspace) return;
  const parent = variationWorkspace.nodes[parentId];
  if (parent) parent.children = parent.children.filter((id) => id !== node.id);
  delete variationWorkspace.edges?.[`${parentId}>${node.id}`];
  node.parents = (node.parents || []).filter((id) => id !== parentId);
  if (node.parent === parentId) node.parent = node.parents[0] || null;
  const removeOrphans = (id) => {
    const item = variationWorkspace.nodes[id];
    if (!item || id === variationWorkspace.root || (item.parents || []).length) return;
    for (const childId of item.children || []) {
      const child = variationWorkspace.nodes[childId];
      if (child) {
        child.parents = (child.parents || []).filter((value) => value !== id);
        if (child.parent === id) child.parent = child.parents[0] || null;
      }
      delete variationWorkspace.edges?.[`${id}>${childId}`];
      removeOrphans(childId);
    }
    delete variationWorkspace.nodes[id];
  };
  removeOrphans(node.id);
  variationNodeId = parentId;
  saveCurrentVariationWorkspace();
  render();
  scheduleAutoPositionAnalysis();
}

function promoteVariationBranch() {
  const node = variationNode();
  const parentId = variationParentFor(node);
  if (!parentId || !variationWorkspace) return;
  const parent = variationWorkspace.nodes[parentId];
  if (!parent?.children?.includes(node.id)) return;
  parent.children = [node.id, ...parent.children.filter((id) => id !== node.id)];
  saveCurrentVariationWorkspace();
  renderVariationWorkspace();
  setStatus("Variation promoted to the first branch at this position.", "success");
}

function variationPath() {
  const path = [];
  let node = variationNode();
  const visited = new Set();
  while (node && !visited.has(node.id)) {
    visited.add(node.id);
    path.unshift(node);
    const parentId = variationParentFor(node);
    node = parentId ? variationWorkspace.nodes[parentId] : null;
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

function saveStudyIdentity() {
  if (!variationWorkspace) return;
  variationWorkspace.name = String($("studyNameInput")?.value || defaultStudyName(variationWorkspace.origin_ply)).trim().slice(0, 80) || defaultStudyName(variationWorkspace.origin_ply);
  variationWorkspace.kind = $("studyKindSelect")?.value === "repertoire" ? "repertoire" : "study";
  variationWorkspace.folder = String($("studyFolderInput")?.value || "").trim().slice(0, 48);
  variationWorkspace.tags = String($("studyTagsInput")?.value || "")
    .split(",")
    .map((tag) => tag.trim().slice(0, 32))
    .filter(Boolean)
    .slice(0, 12);
  saveCurrentVariationWorkspace();
  renderStudyLibrary();
  renderVariationWorkspace();
}

function toggleCurrentStudyFavorite() {
  if (!variationWorkspace) return;
  variationWorkspace.favorite = !variationWorkspace.favorite;
  saveCurrentVariationWorkspace();
  renderVariationWorkspace();
  renderStudyLibrary();
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
    name: variationWorkspace.name,
    kind: variationWorkspace.kind,
    favorite: variationWorkspace.favorite,
    nodes: { [root.id]: root },
    edges: {},
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
  $("variationStatus").textContent = `${variationWorkspace?.kind === "repertoire" ? "Repertoire" : "Study"} · ${Math.max(0, path.length - 1)} ply branch`;
  if ($("studyNameInput") && document.activeElement !== $("studyNameInput")) $("studyNameInput").value = variationWorkspace?.name || defaultStudyName(variationWorkspace?.origin_ply);
  if ($("studyKindSelect")) $("studyKindSelect").value = variationWorkspace?.kind === "repertoire" ? "repertoire" : "study";
  if ($("studyFolderInput") && document.activeElement !== $("studyFolderInput")) $("studyFolderInput").value = variationWorkspace?.folder || "";
  if ($("studyTagsInput") && document.activeElement !== $("studyTagsInput")) $("studyTagsInput").value = (variationWorkspace?.tags || []).join(", ");
  if ($("studyFavoriteBtn")) $("studyFavoriteBtn").textContent = variationWorkspace?.favorite ? "★ Bookmarked study" : "☆ Bookmark study";
  const activeParentId = variationParentFor(node);
  $("variationBackBtn").disabled = !activeParentId;
  $("variationPromoteBtn").disabled = !activeParentId;
  $("variationDeleteBtn").disabled = !activeParentId;
  $("variationNag").value = node?.nag || "";
  $("variationComment").value = node?.comment || "";
  const breadcrumb = $("variationBreadcrumb");
  breadcrumb.innerHTML = "";
  path.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.classList.toggle("current", item.id === variationNodeId);
    const parent = index > 0 ? path[index - 1] : null;
    const edge = parent ? variationEdge(parent.id, item.id) : null;
    button.textContent = index === 0 ? "Root" : `${edge?.move_san || item.move_san}${item.nag || ""}`;
    button.addEventListener("click", () => navigateVariation(item.id, parent?.id || null));
    breadcrumb.appendChild(button);
  });
  const tree = $("variationTree");
  tree.innerHTML = "";
  const renderedIds = new Set();
  const appendTreeNode = (id, depth = 0, parentId = null) => {
    const item = variationWorkspace.nodes[id];
    if (!item || depth > 40) return;
    const alreadyRendered = renderedIds.has(id);
    renderedIds.add(id);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "variation-tree-row";
    row.classList.toggle("current", id === variationNodeId);
    row.style.setProperty("--tree-depth", String(depth));
    const edge = parentId ? variationEdge(parentId, id) : null;
    const label = id === variationWorkspace.root
      ? "Root"
      : `${edge?.move_san || item.move_san || item.move_uci || "Move"}${item.nag || ""}`;
    const transposes = Number(item.parents?.length || 0) > 1 || alreadyRendered;
    row.textContent = `${label}${item.comment ? " · ✎" : ""}${transposes ? " · ↔" : ""}`;
    row.title = transposes
      ? "Shared position reached by more than one move order."
      : (item.comment || label);
    row.addEventListener("click", () => navigateVariation(id, parentId));
    tree.appendChild(row);
    if (alreadyRendered) return;
    for (const childId of item.children || []) appendTreeNode(childId, depth + 1, id);
  };
  appendTreeNode(variationWorkspace.root);
  const children = $("variationChildren");
  children.innerHTML = "";
  for (const childId of node?.children || []) {
    const child = variationWorkspace.nodes[childId];
    if (!child) continue;
    const edge = variationEdge(node.id, childId);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${edge.move_san || child.move_san}${child.nag || ""}${child.parents?.length > 1 ? " ↔" : ""}`;
    button.addEventListener("click", () => navigateVariation(child.id, node.id));
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

function trainerFocusedItems(mode = trainerFocusMode) {
  if (trainerSessionKeys) return trainerItems.map((item, index) => ({ item, index }))
    .filter(({ item }) => trainerSessionKeys.has(item.key) && Number(item.due_at || 0) <= Date.now());
  const due = trainerDueItems();
  if (mode === "due") return due;
  const source = trainerItems.map((item, index) => ({ item, index }));
  let filtered;
  if (mode === "unsolved") filtered = source.filter(({ item }) => Number(item.solved || 0) === 0);
  else if (mode === "blunder") filtered = source.filter(({ item }) => String(item.classification || "").toLowerCase() === "blunder");
  else if (["opening", "middlegame", "endgame"].includes(mode)) filtered = source.filter(({ item }) => item.phase === mode);
  else filtered = due;
  return filtered.sort((a, b) => {
    const aDue = Number(a.item.due_at || 0) <= Date.now() ? 1 : 0;
    const bDue = Number(b.item.due_at || 0) <= Date.now() ? 1 : 0;
    return bDue - aDue || Number(b.item.cpl || 0) - Number(a.item.cpl || 0);
  });
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

function trainerGoalCategory(item) {
  const source = String(item?.source || "");
  if (source.startsWith("repertoire:")) return "repertoire";
  if (item?.phase === "endgame" || source.includes("endgame")) return "endgames";
  return "tactics";
}

function recordSessionGoal(category) {
  if (!sessionGoals?.progress || !(category in sessionGoals.progress)) return;
  sessionGoals.progress[category] = Number(sessionGoals.progress[category] || 0) + 1;
  saveSessionGoals();
  renderSessionGoals();
}

function gradeTrainerMove(move) {
  const item = trainerItems[trainerItemIndex];
  if (!trainerMode || !item || trainerAwaitingNext) return false;
  item.attempts = Number(item.attempts || 0) + 1;
  item.ease = Math.max(1.3, Math.min(3.0, Number(item.ease || 2.3)));
  item.confidence = Math.max(0, Math.min(100, Number(item.confidence ?? 50)));
  trainerRevealBest = true;
  trainerAwaitingNext = true;
  const correct = move === item.best_uci;
  if (correct) {
    item.solved = Number(item.solved || 0) + 1;
    item.streak = Number(item.streak || 0) + 1;
    item.ease = Math.min(3.0, item.ease + 0.08);
    item.confidence = Math.min(100, item.confidence + 12);
    trainerSessionSolved += 1;
    trainerSessionStreak += 1;
    const baseDays = Math.max(1, Number(item.interval_days || 1));
    const intervalDays = Math.min(60, Math.max(1, Math.round(baseDays * item.ease)));
    item.interval_days = intervalDays;
    item.due_at = Date.now() + intervalDays * 86_400_000;
    $("trainerPrompt").textContent = `Correct — ${item.best_san || item.best_uci}. Next review in ${intervalDays} day${intervalDays === 1 ? "" : "s"}.`;
    recordSessionGoal(trainerGoalCategory(item));
    playUiSound("success");
  } else {
    item.lapses = Number(item.lapses || 0) + 1;
    item.streak = 0;
    item.ease = Math.max(1.3, item.ease - 0.2);
    item.confidence = Math.max(0, item.confidence - 18);
    item.interval_days = 1;
    trainerSessionStreak = 0;
    item.due_at = Date.now() + 15 * 60_000;
    $("trainerPrompt").textContent = `Not quite. The engine preferred ${item.best_san || item.best_uci}. This line returns to the queue soon.`;
    playUiSound("error");
  }
  saveTrainerItems();
  renderBoard();
  renderTrainerPanel();
  return correct;
}

async function startTrainer(focus = "due", keys = null) {
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
  trainerFocusMode = focus;
  trainerSessionKeys = keys ? new Set(keys) : null;
  if ($("trainerFocusSelect")) $("trainerFocusSelect").value = focus;
  const focused = trainerFocusedItems(focus);
  if (!focused.length) { setStatus("No positions due in this training selection.", "success"); return; }
  const target = focused[0].index;
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
  gradeTrainerMove(move);
}

async function nextTrainerItem() {
  if (!trainerMode) return;
  trainerAwaitingNext = false;
  const focused = trainerFocusedItems(trainerFocusMode).filter(({ index }) => index !== trainerItemIndex);
  if (!focused.length) {
    $("trainerPrompt").textContent = "Training queue complete for now.";
    renderTrainerPanel();
    return;
  }
  await loadTrainerItem(focused[0].index);
}

function trainerHint() {
  const item = trainerItems[trainerItemIndex];
  if (!trainerMode || !item) return;
  trainerRevealBest = true;
  $("trainerPrompt").textContent = `Hint: look for ${item.best_san || item.best_uci}.`;
  renderBoard();
}

async function exitTrainer(resumeGame = true) {
  trainerSessionKeys = null;
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
  $("trainerFocusBtn").disabled = trainerItems.length === 0 || trainerMode;
  $("trainerSession").hidden = !trainerMode;
  $("trainerNextBtn").hidden = !trainerMode || !trainerAwaitingNext;
  const choices = $("trainerChoices");
  if (choices) {
    choices.innerHTML = "";
    choices.hidden = true;
  }
  if (trainerMode) {
    const item = trainerItems[trainerItemIndex];
    $("trainerLabel").textContent = `${capitalize(item?.classification || "Training")} · ${capitalize(item?.phase || "position")}`;
    $("trainerProgress").textContent = `${trainerSessionSolved} solved`;
    if (!trainerRevealBest) $("trainerPrompt").textContent = `You played ${item?.played_san || "a weaker move"}. Find a better move.`;
    if (choices && Array.isArray(item?.choices) && item.choices.length >= 2 && !trainerAwaitingNext) {
      choices.hidden = false;
      item.choices.slice(0, 4).forEach((choice) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary compact";
        button.textContent = choice.san || choice.move;
        button.title = choice.feedback || "Choose this move";
        button.addEventListener("click", () => gradeTrainerMove(choice.move));
        choices.appendChild(button);
      });
    }
  }
  const attempts = trainerItems.reduce((sum, item) => sum + Number(item.attempts || 0), 0);
  const correct = trainerItems.reduce((sum, item) => sum + Number(item.solved || 0), 0);
  const mastered = trainerItems.filter((item) => Number(item.solved || 0) >= 3).length;
  const endgames = trainerItems.filter((item) => item.phase === "endgame").length;
  const dashboard = $("trainerDashboard");
  if (dashboard) {
    dashboard.innerHTML = "";
    [["Accuracy", attempts ? `${Math.min(100, Math.round(correct * 100 / attempts))}%` : "—"], ["Mastered", mastered], ["Endgames", endgames]].forEach(([label, value]) => {
      const cell = document.createElement("div");
      const caption = document.createElement("span");
      caption.textContent = label;
      const number = document.createElement("strong");
      number.textContent = String(value);
      cell.append(caption, number);
      dashboard.appendChild(cell);
    });
  }
  const queue = $("trainerQueue");
  queue.innerHTML = "";
  const visibleItems = trainerFocusedItems($("trainerFocusSelect")?.value || trainerFocusMode).slice(0, 12);
  visibleItems.forEach(({ item, index }) => {
    const row = document.createElement("div");
    row.className = "trainer-item";
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${item.classification || "Position"} · ${item.cpl || 0} CPL`;
    const meta = document.createElement("span");
    const confidence = Number.isFinite(Number(item.confidence)) ? ` · ${Math.round(Number(item.confidence))}% confidence` : "";
    meta.textContent = `${capitalize(item.phase || "middlegame")} · best ${item.best_san || item.best_uci}${confidence}`;
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
  renderTrainingVisualization();
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
  const motifCounts = new Map();
  trainerItems.forEach((item) => {
    for (const motif of item.motifs || []) {
      const name = String(motif || "").trim();
      if (name) motifCounts.set(name, (motifCounts.get(name) || 0) + 1);
    }
  });
  [...motifCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .forEach(([motif, count]) => {
      const row = document.createElement("div");
      row.className = "weakness-row motif-weakness-row";
      row.innerHTML = `<strong>${escapeHtml(capitalize(motif))}</strong><span class="weakness-bar"><i style="width:${Math.min(100, count * 20)}%"></i></span><span>${count}</span>`;
      target.appendChild(row);
    });
}

function renderTrainingVisualization() {
  const target = $("trainingVisualization");
  if (!target) return;
  target.innerHTML = "";
  const groups = ["Blunder", "Mistake", "Inaccuracy"];
  const counts = Object.fromEntries(groups.map((name) => [name, trainerItems.filter((item) => item.classification === name).length]));
  const max = Math.max(1, ...Object.values(counts));
  groups.forEach((name) => {
    const row = document.createElement("div");
    row.className = "training-viz-row";
    const label = document.createElement("span");
    label.textContent = name;
    const track = document.createElement("span");
    track.className = "training-viz-track";
    const fill = document.createElement("i");
    fill.style.width = `${counts[name] * 100 / max}%`;
    track.appendChild(fill);
    const value = document.createElement("span");
    value.textContent = String(counts[name]);
    row.append(label, track, value);
    target.appendChild(row);
  });
}

const ENDGAME_DRILLS = {
  opposition: {
    label: "King + pawn opposition",
    fen: "8/8/8/4k3/8/4K3/4P3/8 w - - 0 1",
  },
  queen: {
    label: "Queen mate technique",
    fen: "7k/8/8/8/8/5K2/6Q1/8 w - - 0 1",
  },
  rook: {
    label: "Rook mate technique",
    fen: "7k/8/8/8/8/5K2/6R1/8 w - - 0 1",
  },
  "rook-pawn": {
    label: "Rook + passer technique",
    fen: "8/1P1k4/1K6/8/8/8/8/R7 w - - 0 1",
  },
  "minor-pawn": {
    label: "Minor-piece endgame",
    fen: "8/5k2/8/4P3/3K4/8/5N2/8 w - - 0 1",
  },
};

async function bestMoveForFen(fen, budgetMs = 500) {
  const result = await api("/api/multipv", { fen, lines: 1, budget_ms: budgetMs });
  const line = result?.lines?.[0];
  if (!line?.move) throw new Error("The engine could not produce a training move for this position.");
  return { move: line.move, san: line.san || line.move, line };
}

async function startEndgameDrill() {
  if (busy || setupMode || variationMode || trainerMode) return;
  const drill = ENDGAME_DRILLS[$("endgameSelect")?.value] || ENDGAME_DRILLS.opposition;
  setStatus(`Preparing ${drill.label}…`, "loading");
  try {
    const best = await bestMoveForFen(drill.fen, 650);
    const key = `endgame:${drill.fen}|${best.move}`;
    let index = trainerItems.findIndex((item) => item.key === key);
    if (index < 0) {
      trainerItems.unshift({
        key,
        title: drill.label,
        fen: drill.fen,
        best_uci: best.move,
        best_san: best.san,
        classification: "Endgame",
        cpl: 999,
        phase: "endgame",
        explanation: "Practice the engine's preferred technique from this curated endgame position.",
        source: "curated-endgame",
        created_at: new Date().toISOString(),
        attempts: 0,
        solved: 0,
        due_at: Date.now(),
      });
      saveTrainerItems();
      index = 0;
    } else {
      trainerItems[index].due_at = Date.now();
      trainerItems[index].cpl = 999;
      saveTrainerItems();
    }
    trainerFocusMode = "endgame";
    await startTrainer("endgame");
    setStatus(`${drill.label} drill ready.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function suggestPuzzleMove() {
  const fen = currentBoardView()?.fen || state?.fen;
  if (!fen) return;
  setStatus("Finding a puzzle solution from the current position…", "loading");
  try {
    const best = await bestMoveForFen(fen, 500);
    $("customPuzzleMove").value = best.move;
    setStatus(`Suggested ${best.san}.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function saveCustomPuzzle() {
  const fen = currentBoardView()?.fen || state?.fen;
  const move = String($("customPuzzleMove")?.value || "").trim().toLowerCase();
  const title = String($("customPuzzleTitle")?.value || "Custom puzzle").trim().slice(0, 60) || "Custom puzzle";
  if (!fen || !move) {
    setStatus("Choose a position and enter a solution move first.", "error");
    return;
  }
  try {
    const child = await api("/api/variation-move", { fen, move });
    const snapshot = await api("/api/position", { fen });
    const san = snapshot.legal_san?.[move] || child.move_san || move;
    const key = `custom:${fen}|${move}`;
    const existing = trainerItems.findIndex((item) => item.key === key);
    const item = {
      key,
      title,
      fen,
      best_uci: move,
      best_san: san,
      classification: "Custom",
      cpl: 500,
      phase: snapshot.phase || "middlegame",
      explanation: title,
      source: "custom-puzzle",
      created_at: new Date().toISOString(),
      attempts: existing >= 0 ? Number(trainerItems[existing].attempts || 0) : 0,
      solved: existing >= 0 ? Number(trainerItems[existing].solved || 0) : 0,
      due_at: Date.now(),
    };
    if (existing >= 0) trainerItems.splice(existing, 1);
    trainerItems.unshift(item);
    saveTrainerItems();
    renderTrainerPanel();
    renderPlayerProfile();
    setStatus(`Saved puzzle “${title}”.`, "success");
  } catch (error) {
    setStatus(`Puzzle solution is not legal here: ${error.message}`, "error");
  }
}

function nextCoordinateTarget() {
  const files = "abcdefgh";
  coordinateTarget = `${files[Math.floor(Math.random() * 8)]}${1 + Math.floor(Math.random() * 8)}`;
  $("coordinatePrompt").textContent = `Click ${coordinateTarget}.`;
  $("coordinateScore").textContent = `${coordinateCorrect} / ${coordinateAttempts}`;
}

async function toggleCoordinateDrill() {
  if (coordinateTarget) {
    coordinateTarget = null;
    $("coordinateDrillBtn").textContent = "Start coordinate drill";
    $("coordinatePrompt").textContent = `Finished · ${coordinateCorrect}/${coordinateAttempts} correct.`;
    if (!coordinateWasPaused && state && !state.game_over && state.paused) {
      await act(() => api("/api/pause", { paused: false }), "Coordinate drill ended. Game resumed.");
      scheduleComputerReply();
    }
    return;
  }
  if (setupMode || trainerMode || variationMode || retryMode) {
    setStatus("Exit the current board workspace before starting a coordinate drill.", "error");
    return;
  }
  coordinateWasPaused = Boolean(state?.paused || state?.game_over);
  if (state && !state.game_over && !state.paused) {
    const paused = await act(() => api("/api/pause", { paused: true }), "Game paused for coordinate training.");
    if (!paused) return;
  }
  coordinateCorrect = 0;
  coordinateAttempts = 0;
  $("coordinateDrillBtn").textContent = "Stop coordinate drill";
  nextCoordinateTarget();
  renderBoard();
}

function handleCoordinateClick(square) {
  if (!coordinateTarget) return false;
  coordinateAttempts += 1;
  if (square === coordinateTarget) {
    coordinateCorrect += 1;
    playUiSound("success");
  } else {
    playUiSound("error");
  }
  nextCoordinateTarget();
  return true;
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
    mirrorDesktopPreference(RECOVERY_KEY);
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
  selected = null;
  autoplay = $("humanSide").value === "none";
  const succeeded = await act(
    () => api("/api/reset", resetPayloadFromControls({ fen, useChess960Position: false })),
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
  let baseMs;
  let incrementMs;
  if (preset !== "custom") {
    const [baseSeconds, presetIncrementMs] = preset.split(",").map(Number);
    baseMs = Math.max(1000, baseSeconds * 1000);
    incrementMs = Math.max(0, presetIncrementMs);
  } else {
    const baseMinutes = Math.max(0.1, Number($("baseTimeInput").value) || 2);
    const incrementSeconds = Math.max(0, Number($("incrementInput").value) || 0);
    baseMs = Math.round(baseMinutes * 60_000);
    incrementMs = Math.round(incrementSeconds * 1000);
  }
  const whiteMinutes = Math.max(0.1, Number($("whiteBaseInput")?.value) || baseMs / 60_000);
  const blackMinutes = Math.max(0.1, Number($("blackBaseInput")?.value) || baseMs / 60_000);
  const clockMode = ["increment", "bronstein", "hourglass"].includes($("clockModeSelect")?.value)
    ? $("clockModeSelect").value
    : "increment";
  const delayMs = Math.max(0, Math.round((Number($("delayInput")?.value) || 0) * 1000));
  const stageMoves = Math.max(0, Math.floor(Number($("stageMovesInput")?.value) || 0));
  const stageAddMs = Math.max(0, Math.round((Number($("stageAddInput")?.value) || 0) * 60_000));
  return {
    baseMs,
    incrementMs,
    whiteMs: Math.round(whiteMinutes * 60_000),
    blackMs: Math.round(blackMinutes * 60_000),
    clockMode,
    delayMs,
    timeStages: stageMoves > 0 && stageAddMs > 0 ? [{ moves: stageMoves, add_ms: stageAddMs }] : [],
  };
}

function selectedVariant() {
  const variant = $("variantSelect")?.value === "chess960" ? "chess960" : "standard";
  const chess960Pos = Math.max(0, Math.min(959, Math.floor(Number($("chess960Position")?.value) || 0)));
  return { variant, chess960Pos };
}

function resetPayloadFromControls(options = {}) {
  const control = selectedTimeControl();
  const variant = selectedVariant();
  const payload = {
    clock_ms: control.baseMs,
    increment_ms: control.incrementMs,
    white_clock_ms: control.whiteMs,
    black_clock_ms: control.blackMs,
    clock_mode: control.clockMode,
    delay_ms: control.delayMs,
    time_stages: control.timeStages,
    variant: variant.variant,
  };
  if (options.fen) payload.fen = options.fen;
  if (variant.variant === "chess960" && options.useChess960Position !== false && !options.fen) {
    payload.chess960_pos = variant.chess960Pos;
  }
  return payload;
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
  $("whiteBaseInput").value = String(Number((Number(state.white_base_clock_ms || baseMs) / 60_000).toFixed(2)));
  $("blackBaseInput").value = String(Number((Number(state.black_base_clock_ms || baseMs) / 60_000).toFixed(2)));
  $("clockModeSelect").value = ["increment", "bronstein", "hourglass"].includes(state.clock_mode) ? state.clock_mode : "increment";
  $("delayInput").value = String(Number(state.delay_ms || 0) / 1000);
  const firstStage = Array.isArray(state.time_stages) ? state.time_stages[0] : null;
  $("stageMovesInput").value = String(Math.max(0, Number(firstStage?.moves || 0)));
  $("stageAddInput").value = String(Math.max(0, Number(firstStage?.add_ms || 0)) / 60_000);
  $("variantSelect").value = state.variant === "chess960" ? "chess960" : "standard";
  $("variantValue").textContent = state.variant === "chess960" ? "Chess960" : "Standard";
  $("chess960Controls").hidden = state.variant !== "chess960";
}

async function restartStandardGame(successText = "New game started.") {
  autoplay = $("humanSide").value === "none";
  const { variant } = selectedVariant();
  const succeeded = await act(
    () => api("/api/reset", resetPayloadFromControls()),
    successText === "New game started." && variant === "chess960" ? "New Chess960 game started." : successText,
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

function workspaceBackupPayload() {
  return {
    format: "FunChessEngine.WorkspaceBackup",
    version: 2,
    session_goals: sessionGoals,
    calibration_history: calibrationHistory,
    external_comparisons: externalCompareHistory,
    regression_history: regressionHistory,
    current_game: state ? gameSnapshot() : null,
    created_at: new Date().toISOString(),
    display,
    recent_games: recentGames,
    studies: savedVariationWorkspaces,
    bookmarks: positionBookmarks,
    trainer: trainerItems,
    annotations,
    benchmarks: benchmarkHistory,
    tournaments: tournamentHistory,
    analysis_queue: analysisQueue,
    position_cache: [...positionAnalysisCache.entries()],
    lessons,
    engine_presets: enginePresets,
    plugins: pluginManifests,
    external_engines: externalEngines,
  };
}

function validateWorkspaceBackup(payload) {
  validateBackupCollections(payload);
  if (payload?.format !== "FunChessEngine.WorkspaceBackup" || ![1, 2].includes(payload?.version)) {
    throw new Error("This file is not a supported FunChessEngine workspace backup.");
  }
  const games = Array.isArray(payload.recent_games) ? payload.recent_games : [];
  if (games.length > MAX_LIBRARY_GAMES) throw new Error("Backup contains too many library games.");
  for (const game of games) {
    if (!game || !Array.isArray(game.moves) || game.moves.length > 1000) throw new Error("Backup contains an invalid game record.");
  }
  const studies = payload.studies && typeof payload.studies === "object" && !Array.isArray(payload.studies) ? payload.studies : {};
  if (Object.keys(studies).length > 20) throw new Error("Backup contains too many studies.");
  for (const workspace of Object.values(studies)) {
    validateStudyGraph(workspace);
  }
  if (Array.isArray(payload.bookmarks) && payload.bookmarks.length > 100) throw new Error("Backup contains too many bookmarks.");
  if (Array.isArray(payload.trainer) && payload.trainer.length > 250) throw new Error("Backup contains too many training positions.");
  for (const key of ["lessons", "engine_presets", "plugins", "external_engines", "calibration_history", "external_comparisons", "regression_history", "analysis_queue", "benchmarks", "tournaments"]) {
    if (payload[key] != null && (!Array.isArray(payload[key]) || payload[key].length > 100)) throw new Error(`Invalid backup collection: ${key}.`);
    if (payload[key]?.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new Error(`Invalid records in ${key}.`);
  }
  if (payload.plugins) payload.plugins = payload.plugins.map(item => ({...validatePluginManifestClient(item), enabled:Boolean(item.enabled)}));
  if (payload.session_goals && (!payload.session_goals.targets || !payload.session_goals.progress)) throw new Error("Invalid session goals.");
  return payload;
}

async function backupWorkspace() {
  try {
    await hydrateDurableMetadata();
    const metadata = workspaceBackupPayload();
    const bundle = await api("/api/workspace-data", {action:"backup",metadata,include_reference:$("backupReferenceDatabase").checked});
    const link = document.createElement("a");
    link.href = `/api/workspace-download?token=${encodeURIComponent(bundle.token)}`;
    link.download = "FunChessEngine-workspace.fce.zip";
    document.body.append(link); link.click(); link.remove();
    setStatus("Workspace backup saved.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function restoreWorkspaceText(text, beforeApply = null) {
  try {
    const raw = String(text || "");
    if (utf8ByteLength(raw) > MAX_BACKUP_BYTES) throw new Error("Workspace backup exceeds the 16 MB restore limit.");
    const payload = validateWorkspaceBackup(JSON.parse(raw));
    const checked = await api("/api/workspace-data", { action: "validate-metadata", metadata: payload });
    payload.studies = checked.studies;
    const confirmed = await confirmAction(
      "Restore workspace backup?",
      "This replaces the included library, book, studies, training, histories and settings. A saved live game is restored paused. Excluded databases are kept.",
      "Restore backup",
      true,
    );
    if (!confirmed) return false;
    if (beforeApply) await beforeApply();
    if (payload.current_game && !beforeApply) setState(await api("/api/load-game", {...payload.current_game, paused:true}));
    recentGames = payload.recent_games || [];
    savedVariationWorkspaces = payload.studies || {};
    positionBookmarks = Array.isArray(payload.bookmarks) ? payload.bookmarks : [];
    trainerItems = Array.isArray(payload.trainer) ? payload.trainer : [];
    annotations = payload.annotations && typeof payload.annotations === "object" ? payload.annotations : {};
    benchmarkHistory = Array.isArray(payload.benchmarks) ? payload.benchmarks : [];
    tournamentHistory = Array.isArray(payload.tournaments) ? payload.tournaments : [];
    analysisQueue = Array.isArray(payload.analysis_queue) ? payload.analysis_queue : [];
    lessons = Array.isArray(payload.lessons) ? payload.lessons.slice(0, 100) : [];
    enginePresets = Array.isArray(payload.engine_presets) ? payload.engine_presets.slice(0, 30) : [];
    pluginManifests = Array.isArray(payload.plugins) ? payload.plugins.slice(0, 50) : [];
    externalEngines = Array.isArray(payload.external_engines) ? payload.external_engines.slice(0, 12) : [];
    calibrationHistory = payload.calibration_history || [];
    externalCompareHistory = payload.external_comparisons || [];
    regressionHistory = payload.regression_history || [];
    if (payload.session_goals) { sessionGoals = payload.session_goals; saveSessionGoals(); }
    saveCalibrationHistory(); saveExternalCompareHistory(); saveRegressionHistory();
    positionAnalysisCache.clear();
    for (const entry of Array.isArray(payload.position_cache) ? payload.position_cache.slice(-30) : []) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && entry[1]) positionAnalysisCache.set(entry[0], entry[1]);
    }
    try {
      localStorage.setItem(DISPLAY_KEY, JSON.stringify(payload.display || DISPLAY_DEFAULTS));
      mirrorDesktopPreference(DISPLAY_KEY);
    } catch (_) {}
    display = loadDisplaySettings();
    saveRecentGames();
    persistVariationWorkspaces();
    savePositionBookmarks();
    saveTrainerItems();
    saveAnnotations();
    saveBenchmarkHistory();
    saveTournamentHistory();
    saveAnalysisQueue();
    savePositionAnalysisCache();
    saveLessons();
    saveEnginePresets();
    savePluginManifests();
    saveExternalEngines();
    applyDisplaySettings(false);
    render();
    renderStudyLibrary();
    renderBookmarks();
    renderRecentGames();
    renderTrainerPanel();
    renderAnalysisQueue();
    renderOpeningPrepReport();
    renderPlayerProfile();
    renderLessons();
    renderEnginePresets();
    renderPlugins();
    renderExternalEngines();
    await Promise.all([...durableWriteChains.values()]);
    setStatus("Workspace restored from backup.", "success");
    return true;
  } catch (error) {
    setStatus(error.message, "error");
    return false;
  }
}

async function restoreWorkspace() {
  $("restoreWorkspaceInput").click();
}

async function copyShareText() {
  if (!state) return;
  try {
    const pgn = await currentPgnText();
    const opening = state.opening?.name || state.opening?.eco || "Unclassified position";
    const result = state.result || state.manual_result || "*";
    const text = `FunChessEngine · ${result}\n${opening}\nFEN: ${state.fen}\n\n${pgn}`;
    await navigator.clipboard.writeText(text);
    setStatus("Share text copied with result, opening, FEN, and PGN.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function syncEncryptionKey(passphrase, salt) {
  if (!globalThis.crypto?.subtle) throw new Error("Encrypted sync requires Web Crypto support.");
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function exportEncryptedSync() {
  try {
    const passphrase = $("syncPassphraseInput").value;
    if (passphrase.length < 8) throw new Error("Use a sync passphrase of at least 8 characters.");
    const plaintext = new TextEncoder().encode(JSON.stringify(workspaceBackupPayload()));
    if (plaintext.byteLength > MAX_BACKUP_BYTES) throw new Error("Workspace exceeds the encrypted sync size limit.");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await syncEncryptionKey(passphrase, salt);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
    const envelope = JSON.stringify({
      format: "FunChessEngine.EncryptedWorkspace",
      version: 1,
      kdf: "PBKDF2-SHA256-250000",
      cipher: "AES-256-GCM",
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      data: bytesToBase64(encrypted),
    });
    const filename = `FunChessEngine-sync-${new Date().toISOString().slice(0, 10)}.fcex`;
    await downloadBlob(new Blob([envelope], { type: "application/json;charset=utf-8" }), filename);
    setStatus("Encrypted workspace sync file exported.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function importEncryptedSyncFile(file) {
  try {
    assertBrowserFileSize(file, MAX_BACKUP_BYTES * 2, "Encrypted sync file");
    const envelope = JSON.parse(await file.text());
    if (envelope?.format !== "FunChessEngine.EncryptedWorkspace" || envelope?.version !== 1) {
      throw new Error("This is not a supported FunChessEngine encrypted sync file.");
    }
    const passphrase = $("syncPassphraseInput").value;
    if (passphrase.length < 8) throw new Error("Enter the passphrase used to encrypt this workspace.");
    const salt = base64ToBytes(envelope.salt);
    const iv = base64ToBytes(envelope.iv);
    const data = base64ToBytes(envelope.data);
    const key = await syncEncryptionKey(passphrase, salt);
    let decrypted;
    try {
      decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    } catch (_) {
      throw new Error("Could not decrypt this workspace. Check the passphrase and file integrity.");
    }
    await restoreWorkspaceText(new TextDecoder().decode(decrypted));
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function renderEnginePresets() {
  const select = $("enginePresetSelect");
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">Saved presets…</option>';
  enginePresets.forEach((preset, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${preset.name} · ${capitalize(preset.profile)} · ${preset.skill}`;
    select.appendChild(option);
  });
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function saveCurrentEnginePreset() {
  const name = $("enginePresetName").value.trim().slice(0, 40);
  if (!name || !state) {
    setStatus("Enter a name for the engine preset first.", "error");
    return;
  }
  const preset = {
    name,
    profile: $("engineProfileSelect").value || state.engine_profile || "maximum",
    skill: Number(state.engine_skill || 100),
    move_time_cap_ms: Math.max(50, Math.min(10000, Number($("engineMoveCapInput").value) || 2500)),
  };
  const existing = enginePresets.findIndex((item) => item.name.toLowerCase() === name.toLowerCase());
  if (existing >= 0) enginePresets.splice(existing, 1);
  enginePresets.unshift(preset);
  saveEnginePresets();
  renderEnginePresets();
  $("enginePresetName").value = "";
  setStatus(`Saved engine preset “${name}”.`, "success");
}

async function applySavedEnginePreset() {
  const index = Number($("enginePresetSelect").value);
  const preset = Number.isInteger(index) ? enginePresets[index] : null;
  if (!preset) return;
  const config = await api("/api/engine-config", {
    profile: preset.profile,
    skill: preset.skill,
    move_time_cap_ms: preset.move_time_cap_ms,
  });
  state.engine_profile = config.profile;
  state.engine_skill = config.skill;
  state.engine_move_time_cap_ms = config.move_time_cap_ms;
  renderEngineStrength();
  setStatus(`Applied engine preset “${preset.name}”.`, "success");
}

const SAFE_PLUGIN_ACTIONS = new Set([
  "open-analysis",
  "open-training",
  "start-engine",
  "start-repertoire-training",
  "export-report",
]);

function validatePluginManifestClient(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Plugin manifest must be a JSON object.");
  const id = String(payload.id || "").trim();
  const name = String(payload.name || "").trim();
  const version = String(payload.version || "").trim();
  const kind = String(payload.kind || "").trim().toLowerCase();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || !name || name.length > 80 || !version || version.length > 32) {
    throw new Error("Plugin id, name, or version is invalid.");
  }
  if (!["training", "openings", "commands"].includes(kind)) throw new Error("Plugin kind is not supported.");
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length > 500) throw new Error("Plugin has too many items.");
  const normalized = items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Plugin items must be objects.");
    if (kind === "training") {
      const fen = String(item.fen || "").slice(0, 120);
      const best = String(item.best_uci || "").slice(0, 5);
      if (!validFenText(fen) || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(best)) throw new Error("Training plugin item needs a valid FEN and best_uci.");
      return { fen, best_uci: best, title: String(item.title || "Plugin training").slice(0, 100) };
    }
    if (kind === "openings") {
      const moves = Array.isArray(item.moves) ? item.moves.map(String).slice(0, 40) : [];
      if (!String(item.name || "").trim() || !moves.length || moves.some((move) => !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move))) {
        throw new Error("Opening plugin items need a name and UCI move prefix.");
      }
      return { name: String(item.name || "Opening").slice(0, 100), moves };
    }
    const action = String(item.action || "").slice(0, 64);
    if (!SAFE_PLUGIN_ACTIONS.has(action)) throw new Error(`Unsupported safe plugin command: ${action}`);
    return { label: String(item.label || "Plugin command").slice(0, 80), action };
  });
  return { id, name, version, kind, items: normalized, enabled: false };
}

function applyPluginContributions(plugin) {
  if (!plugin?.enabled) return;
  if (plugin.kind === "training") {
    for (const item of plugin.items || []) {
      const key = `plugin:${plugin.id}:${item.fen}:${item.best_uci}`;
      if (trainerItems.some((entry) => entry.key === key)) continue;
      trainerItems.unshift({
        key,
        fen: item.fen,
        best_uci: item.best_uci,
        best_san: item.best_uci,
        classification: "Plugin",
        cpl: 100,
        phase: "middlegame",
        explanation: item.title || plugin.name,
        source: `plugin:${plugin.name}`,
        plugin_id: plugin.id,
        created_at: new Date().toISOString(),
        attempts: 0,
        solved: 0,
        due_at: Date.now(),
      });
    }
    saveTrainerItems();
    renderTrainerPanel();
  }
}

function removePluginContributions(pluginId) {
  const activeKey = trainerItems[trainerItemIndex]?.key;
  const before = trainerItems.length;
  trainerItems = trainerItems.filter((item) => item.plugin_id !== pluginId && !String(item.key || "").startsWith(`plugin:${pluginId}:`));
  if (trainerItems.length !== before) {
    trainerItemIndex = activeKey ? trainerItems.findIndex(item => item.key === activeKey) : -1;
    if (trainerMode && trainerItemIndex < 0) void exitTrainer(false);
    saveTrainerItems();
    renderTrainerPanel();
  }
}

function pluginOpeningForMoves(moves) {
  if (!Array.isArray(moves)) return null;
  let best = null;
  for (const plugin of pluginManifests) {
    if (!plugin?.enabled || plugin.kind !== "openings") continue;
    for (const item of plugin.items || []) {
      const prefix = Array.isArray(item.moves) ? item.moves : [];
      if (!prefix.length || prefix.length > moves.length) continue;
      if (!prefix.every((move, index) => moves[index] === move)) continue;
      if (!best || prefix.length > best.plies) best = { name: item.name, eco: "Plugin", plies: prefix.length };
    }
  }
  return best;
}

function renderPlugins() {
  const target = $("pluginList");
  if (!target) return;
  target.innerHTML = "";
  $("pluginCount").textContent = `${pluginManifests.length} installed`;
  pluginManifests.forEach((plugin, index) => {
    const row = document.createElement("div");
    row.className = "compact-list-row static-row";
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = plugin.name;
    const description = document.createElement("span");
    description.textContent = `${plugin.kind} · v${plugin.version} · ${(plugin.items || []).length} items`;
    info.append(name, description);
    const toggle = document.createElement("button");
    toggle.className = "secondary compact";
    toggle.textContent = plugin.enabled ? "Disable" : "Enable";
    toggle.addEventListener("click", () => {
      plugin.enabled = !plugin.enabled;
      if (!plugin.enabled) removePluginContributions(plugin.id);
      savePluginManifests();
      applyPluginContributions(plugin);
      if (plugin.kind === "openings" && state) render();
      else renderPlugins();
    });
    const remove = document.createElement("button");
    remove.className = "text-button compact";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      removePluginContributions(plugin.id);
      pluginManifests.splice(index, 1);
      savePluginManifests();
      if (plugin.kind === "openings" && state) render();
      else renderPlugins();
    });
    row.append(info, toggle, remove);
    target.appendChild(row);
  });
  if (!pluginManifests.length) target.innerHTML = '<p class="hint">No data-only plugins installed.</p>';
}

async function installPluginFile(file) {
  try {
    assertBrowserFileSize(file, 256 * 1024, "Plugin manifest");
    const plugin = validatePluginManifestClient(JSON.parse(await file.text()));
    await api("/api/workspace-data", {action:"validate-metadata",metadata:{plugins:[plugin]}});
    const existing = pluginManifests.findIndex((item) => item.id === plugin.id);
    if (existing >= 0) {
      removePluginContributions(pluginManifests[existing].id);
      pluginManifests.splice(existing, 1);
    }
    pluginManifests.unshift(plugin);
    savePluginManifests();
    renderPlugins();
    setStatus(`Installed data-only plugin “${plugin.name}”. Enable it to apply its contributions.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function refreshLanStatus() {
  try {
    lanInfo = await api("/api/lan", { action: "status" });
  } catch (_) {
    lanInfo = { running: false };
  }
  renderLanStatus();
}

function renderLanStatus() {
  if (!$("lanStatus")) return;
  $("lanStatus").textContent = lanInfo.running ? "Sharing" : "Off";
  $("toggleLanBtn").textContent = lanInfo.running ? "Stop LAN sharing" : "Start LAN sharing";
  $("copyLanLinkBtn").disabled = !lanInfo.running || !lanInfo.url;
  $("lanLink").textContent = lanInfo.url || "Not running";
}

async function toggleLanSharing() {
  try {
    lanInfo = await api("/api/lan", { action: lanInfo.running ? "stop" : "start" });
    renderLanStatus();
    setStatus(lanInfo.running ? "LAN multiplayer link is active on your private network." : "LAN sharing stopped.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function copyLanLink() {
  if (!lanInfo.url) return;
  await navigator.clipboard.writeText(lanInfo.url);
  setStatus("LAN join link copied.", "success");
}

const ONBOARDING_STEPS = [
  ["Play your way", "Choose Standard or Chess960, set engine strength, and use Fischer, Bronstein, hourglass, asymmetric, or staged clocks."],
  ["Build a real library", "Import PGN collections, search saved positions, favorite games, and run isolated background analysis without replacing the live board."],
  ["Study deeply", "Use review, MultiPV, comments, arrows, repertoires, bookmarks, the visual variation tree, opening preparation, and persistent local analysis cache."],
  ["Train deliberately", "Turn mistakes into spaced-repetition puzzles, create your own puzzles, practice endgames, use blindfold modes, and run coordinate drills."],
  ["Keep it portable", "Back up the whole workspace to a .fce.zip bundle, save portable game PNGs, share PGN/FEN, and keep all analysis local on this computer."],
];

function renderOnboarding() {
  const target = $("onboardingContent");
  if (!target) return;
  const [title, text] = ONBOARDING_STEPS[onboardingStep] || ONBOARDING_STEPS[0];
  target.innerHTML = "";
  const progress = document.createElement("span");
  progress.className = "onboarding-progress";
  progress.textContent = `${onboardingStep + 1} / ${ONBOARDING_STEPS.length}`;
  const heading = document.createElement("h3");
  heading.textContent = title;
  const copy = document.createElement("p");
  copy.textContent = text;
  target.append(progress, heading, copy);
  $("onboardingPrevBtn").disabled = onboardingStep === 0;
  $("onboardingNextBtn").textContent = onboardingStep === ONBOARDING_STEPS.length - 1 ? "Finish" : "Next";
}

function showOnboarding(force = false) {
  if (!force) {
    try {
      if (localStorage.getItem(ONBOARDING_KEY) === "done") return;
    } catch (_) {}
  }
  onboardingStep = 0;
  renderOnboarding();
  if (!$("onboardingDialog").open) $("onboardingDialog").showModal();
}

function closeOnboarding() {
  try {
    localStorage.setItem(ONBOARDING_KEY, "done");
    if (globalThis.engineLabDesktop?.writeMetadata) void globalThis.engineLabDesktop.writeMetadata(ONBOARDING_KEY, "done").catch(reportPersistenceError);
  } catch (_) {}
  if ($("onboardingDialog").open) $("onboardingDialog").close();
}

function gameSnapshot() {
  if (!state) throw new Error("There is no game to save.");
  return {
    format: "FunChessEngine.GamePNG",
    version: 1,
    saved_at: new Date().toISOString(),
    initial_fen: state.initial_fen,
    final_fen: state.fen,
    moves: Array.isArray(state.moves_uci) ? state.moves_uci : [],
    white_ms: Math.round(liveClockMs("white")),
    black_ms: Math.round(liveClockMs("black")),
    base_clock_ms: Number(state.base_clock_ms || 120000),
    white_base_clock_ms: Number(state.white_base_clock_ms || state.base_clock_ms || 120000),
    black_base_clock_ms: Number(state.black_base_clock_ms || state.base_clock_ms || 120000),
    increment_ms: Number(state.increment_ms || 0),
    delay_ms: Number(state.delay_ms || 0),
    clock_mode: state.clock_mode || "increment",
    time_stages: Array.isArray(state.time_stages) ? state.time_stages : [],
    variant: state.variant || "standard",
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

async function renderShareCard() {
  const snapshot = gameSnapshot();
  const canvas = document.createElement("canvas");
  const size = 960;
  const header = 120;
  const footer = 150;
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
  const accent = styles.getPropertyValue("--accent").trim() || "#85c789";
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const customTitle = $("shareImageTitle")?.value.trim().slice(0, 60);
  const layout = $("shareImageLayout")?.value || "game";
  const title = customTitle || (layout === "study" ? "FunChessEngine · Study Position" : layout === "position" ? "FunChessEngine · Position" : "FunChessEngine · Game");
  context.fillStyle = text;
  context.font = "700 34px system-ui";
  context.fillText(title, 28, 52);
  context.fillStyle = muted;
  context.font = "19px system-ui";
  const opening = state.opening?.name || state.opening?.eco || "Unclassified position";
  context.fillText(`${opening} · ${state.result || state.manual_result || "in progress"}`, 28, 86);
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
    const symbol = currentBoardView()?.board?.[square] || state.board[square];
    if (symbol) {
      context.fillStyle = symbol === symbol.toUpperCase() ? "#f8f8f0" : "#151515";
      context.strokeStyle = symbol === symbol.toUpperCase() ? "#191919" : "#f0f0e8";
      context.lineWidth = 1.5;
      context.font = `92px "Arial Unicode MS", "Segoe UI Symbol", sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      const x = col * squareSize + squareSize / 2;
      const y = header + row * squareSize + squareSize / 2 + 3;
      context.strokeText(PIECES[symbol], x, y);
      context.fillText(PIECES[symbol], x, y);
    }
  }
  if ($("shareAnnotationsToggle")?.checked) {
    const marks = currentAnnotations();
    for (const [square, color] of Object.entries(marks.squares || {})) {
      const visual = order.indexOf(square);
      if (visual < 0) continue;
      const row = Math.floor(visual / 8);
      const col = visual % 8;
      context.fillStyle = annotationColorValue(color, .36);
      context.fillRect(col * squareSize, header + row * squareSize, squareSize, squareSize);
    }
    const arrows = [...(marks.arrows || [])];
    if (multiPvArrowMove) arrows.push({ from: multiPvArrowMove.slice(0, 2), to: multiPvArrowMove.slice(2, 4), color: "cyan" });
    context.lineWidth = 12;
    context.lineCap = "round";
    arrows.slice(0, 24).forEach((arrow) => {
      const fromIndex = order.indexOf(arrow.from);
      const toIndex = order.indexOf(arrow.to);
      if (fromIndex < 0 || toIndex < 0) return;
      const fx = (fromIndex % 8 + .5) * squareSize;
      const fy = header + (Math.floor(fromIndex / 8) + .5) * squareSize;
      const tx = (toIndex % 8 + .5) * squareSize;
      const ty = header + (Math.floor(toIndex / 8) + .5) * squareSize;
      context.strokeStyle = annotationColorValue(arrow.color || "amber", .85);
      context.beginPath();
      context.moveTo(fx, fy);
      context.lineTo(tx, ty);
      context.stroke();
    });
  }
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.fillStyle = text;
  context.font = "700 22px ui-monospace, monospace";
  const detail = layout === "game"
    ? `White ${clock(snapshot.white_ms)}   Black ${clock(snapshot.black_ms)}   ${snapshot.moves.length} plies`
    : `FEN ${state.fen}`;
  context.fillText(detail.length > 105 ? `${detail.slice(0, 102)}…` : detail, 28, header + size + 48);
  context.fillStyle = muted;
  context.font = "18px system-ui";
  context.fillText("FunChessEngine · local analysis, studies, and training", 28, header + size + 88);
  context.fillStyle = accent;
  context.fillRect(28, header + size + 108, 160, 4);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not create the share image.");
  return blob;
}

async function saveShareImage() {
  try {
    const blob = await renderShareCard();
    await downloadBlob(blob, `funchess-share-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    setStatus("Share image exported.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function maskFeatures(mask, size = 32) {
  const rows = Array(8).fill(0);
  const cols = Array(8).fill(0);
  let ink = 0;
  let xSum = 0;
  let ySum = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!mask[y * size + x]) continue;
      ink += 1;
      xSum += x;
      ySum += y;
      rows[Math.min(7, Math.floor(y * 8 / size))] += 1;
      cols[Math.min(7, Math.floor(x * 8 / size))] += 1;
    }
  }
  const norm = Math.max(1, ink);
  return {
    occupancy: ink / (size * size),
    cx: ink ? xSum / ink / size : .5,
    cy: ink ? ySum / ink / size : .5,
    rows: rows.map((value) => value / norm),
    cols: cols.map((value) => value / norm),
  };
}

function glyphTemplateFeatures(symbol) {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, 32, 32);
  context.fillStyle = "#000";
  context.font = '27px "Arial Unicode MS", "Segoe UI Symbol", sans-serif';
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(PIECES[symbol], 16, 17);
  const pixels = context.getImageData(0, 0, 32, 32).data;
  const mask = new Uint8Array(32 * 32);
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4;
    const luminance = (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3;
    mask[index] = luminance < 220 ? 1 : 0;
  }
  return maskFeatures(mask);
}

function featureDistance(left, right) {
  let distance = Math.abs(left.occupancy - right.occupancy) * 3;
  distance += Math.abs(left.cx - right.cx) + Math.abs(left.cy - right.cy);
  for (let index = 0; index < 8; index += 1) {
    distance += Math.abs(left.rows[index] - right.rows[index]);
    distance += Math.abs(left.cols[index] - right.cols[index]);
  }
  return distance;
}

async function recognizeBoardImage(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    let sx = Math.round((bitmap.width - side) / 2);
    let sy = Math.round((bitmap.height - side) / 2);
    if (bitmap.height > bitmap.width * 1.12 && bitmap.height < bitmap.width * 1.35) {
      sx = 0;
      sy = Math.max(0, Math.round((bitmap.height - bitmap.width) * .44));
    }
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, sx, sy, side, side, 0, 0, 256, 256);
    const templates = Object.fromEntries(Object.keys(PIECES).map((symbol) => [symbol, glyphTemplateFeatures(symbol)]));
    const result = {};
    let uncertain = 0;
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const data = context.getImageData(col * 32, row * 32, 32, 32).data;
        const corners = [0, 31, 31 * 32, 32 * 32 - 1];
        const background = [0, 1, 2].map((channel) => corners.reduce((sum, pixel) => sum + data[pixel * 4 + channel], 0) / corners.length);
        const mask = new Uint8Array(32 * 32);
        for (let index = 0; index < mask.length; index += 1) {
          const offset = index * 4;
          const delta = Math.sqrt(
            (data[offset] - background[0]) ** 2
            + (data[offset + 1] - background[1]) ** 2
            + (data[offset + 2] - background[2]) ** 2,
          );
          mask[index] = delta > 55 ? 1 : 0;
        }
        const features = maskFeatures(mask);
        if (features.occupancy < .045) continue;
        const ranked = Object.entries(templates)
          .map(([symbol, template]) => [symbol, featureDistance(features, template)])
          .sort((left, right) => left[1] - right[1]);
        const [symbol, distance] = ranked[0];
        if (distance > 1.75) {
          uncertain += 1;
          continue;
        }
        const orientation = $("boardImageOrientation")?.value || "white";
        const fileIndex = orientation === "white" ? col : 7 - col;
        const rankIndex = orientation === "white" ? 7 - row : row;
        result[`${String.fromCharCode(97 + fileIndex)}${rankIndex + 1}`] = symbol;
      }
    }
    return { board: result, uncertain };
  } finally {
    bitmap.close?.();
  }
}

async function importBoardImage(file) {
  if (!file) return;
  assertBrowserFileSize(file, MAX_SAVE_BYTES, "Board image");
  if (file.type === "image/png") {
    try {
      extractPngSnapshot(new Uint8Array(await file.arrayBuffer()));
      await loadGamePng(file);
      return;
    } catch (_) {
      // Ordinary board image; continue to the local visual recognizer.
    }
  }
  $("boardImageStatus").textContent = "Recognizing the 8×8 board locally…";
  try {
    const recognized = await recognizeBoardImage(file);
    await enterSetupMode();
    setupBoard = recognized.board;
    $("setupTurn").value = "w";
    $("setupCastleK").checked = false;
    $("setupCastleQ").checked = false;
    $("setupCastlek").checked = false;
    $("setupCastleq").checked = false;
    $("setupEp").value = "";
    renderBoard();
    const pieces = Object.keys(recognized.board).length;
    $("boardImageStatus").textContent = `Recognized ${pieces} piece${pieces === 1 ? "" : "s"}${recognized.uncertain ? `; skipped ${recognized.uncertain} uncertain square${recognized.uncertain === 1 ? "" : "s"}` : ""}. Verify every square in Position Setup before applying.`;
    setStatus("Experimental board-image recognition loaded into Position Setup for verification.", "success");
  } catch (error) {
    $("boardImageStatus").textContent = error.message;
    setStatus(error.message, "error");
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
  if (handleCoordinateClick(square)) return;
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
  if (tournamentState?.active) return;
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
  if (!state.game_over && !state.paused) {
    const active = Number(state[state.turn === "white" ? "white_ms" : "black_ms"] || 0);
    const elapsed = Math.min(Math.max(0, active), Math.max(0, performance.now() - clockAnchorMs));
    if (state.turn === side) remaining -= elapsed;
    else if (state.clock_mode === "hourglass") remaining += elapsed;
  }
  return Math.max(0, remaining);
}

function recordedClockText(value) {
  return value != null && Number.isFinite(Number(value)) ? clock(Number(value)) : "—";
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
  const openingMoves = variationMode
    ? currentMovePrefix()
    : reviewMode
      ? (state.moves_uci || []).slice(0, reviewSnapshot?.ply || 0)
      : (state.moves_uci || []);
  const opening = pluginOpeningForMoves(openingMoves) || view.opening || state.opening;
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
  $("ttHits").textContent = Number(state.last_engine_tt_hits || 0).toLocaleString();
  $("betaCutoffs").textContent = Number(state.last_engine_beta_cutoffs || 0).toLocaleString();
  $("quiescenceNodes").textContent = Number(state.last_engine_quiescence_nodes || 0).toLocaleString();
  $("searchBudget").textContent = state.last_engine_budget_ms
    ? `${Number(state.last_engine_budget_ms)} ms`
    : "—";
  $("pvChanged").textContent = state.last_engine_pv?.length
    ? (state.last_engine_pv_changed ? "Yes" : "No")
    : "—";
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
  $("humanSide").disabled = busy || reviewMode || setupMode || trainerMode || variationMode || retryMode || Boolean(tournamentState?.active);
  $("humanSide").title = $("humanSide").disabled
    ? "Return to the live game before changing who controls each side."
    : "Changing control mode starts a new game when the current game has progress.";
  renderEngineStrength();
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
  renderOpeningPrepReport();
  renderPlayerProfile();
  renderOpeningDatabase();
  renderRepertoireGaps();
  renderStrategicInsights();
  renderTimeCoaching();
  renderPerformanceHistory();
  renderRepertoireTrainer();
  renderLessons();
  renderEnginePresets();
  renderPlugins();
  renderExternalEngines();
  renderAdvancedTournament();
  renderWorkstationHistory();
  renderExternalComparisonHistory();
  renderCalibrationEngines();
  renderSessionGoals();
  renderLanStatus();
  renderAnalysisQueue();
  renderTournament();
  renderEvaluationBreakdown();
  renderTrainerPanel();
  renderDeveloperHistory();
  if ($("engineTab").classList.contains("active") && evalBreakdownData?.fen !== view.fen && !evalBreakdownBusy) {
    setTimeout(refreshEvaluationBreakdown, 0);
  }
  if ($("engineTab").classList.contains("active") && positionInsightsData?.fen !== view.fen && !positionInsightsBusy) {
    setTimeout(refreshPositionInsights, 0);
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
  const previousTop = target.scrollTop;
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
  if (typeof wsFollow === "function") {
    const ply = reviewMode ? reviewSnapshot?.ply : state.pgn.length;
    wsFollow(target, `${state.fen}:${state.pgn.length}:${ply}`, `[data-ply="${ply}"]`, previousTop);
  }
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

function approximateThinkMsForPly(ply) {
  const after = state?.recorded_clock_history?.[ply - 1];
  const before = ply <= 2
    ? state?.recorded_initial_clocks
    : state?.recorded_clock_history?.[ply - 3];
  const sideIndex = ply % 2 === 1 ? 0 : 1;
  const beforeMs = Array.isArray(before) ? Number(before[sideIndex]) : NaN;
  const afterMs = Array.isArray(after) ? Number(after[sideIndex]) : NaN;
  if (!Number.isFinite(beforeMs) || !Number.isFinite(afterMs)) return null;
  const increment = state?.clock_mode === "increment" ? Number(state.increment_ms || 0) : 0;
  return Math.max(0, beforeMs + increment - afterMs);
}

function renderGameQualityTimeline() {
  const target = $("qualityTimeline");
  const meta = $("qualityTimelineMeta");
  if (!target || !meta) return;
  const rows = Array.isArray(gameAnalysis?.results) ? gameAnalysis.results : [];
  target.innerHTML = "";
  meta.textContent = rows.length ? `${rows.length} analyzed plies` : "Analyze a game";
  if (!rows.length) {
    target.innerHTML = '<p class="hint">Whole-game analysis will populate this timeline.</p>';
    return;
  }
  rows.forEach((row) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `quality-timeline-row grade-${String(row.classification || "").toLowerCase()}`;
    const think = approximateThinkMsForPly(Number(row.ply || 0));
    const motif = Array.isArray(row.motifs) && row.motifs.length ? row.motifs.slice(0, 2).join(", ") : "no motif";
    button.innerHTML = `<strong>${escapeHtml(row.ply)}. ${escapeHtml(row.played_san || row.played_uci || "Move")}</strong><span>${Number(row.cpl || 0)} CPL · ${escapeHtml(capitalize(row.phase || "middlegame"))} · ${escapeHtml(motif)}${think === null ? "" : ` · ~${(think / 1000).toFixed(1)}s`}</span><i style="--loss:${Math.min(100, Math.max(3, Number(row.cpl || 0) / 4))}%"></i>`;
    button.title = `Review ply ${row.ply}: ${row.classification || "Move"}`;
    button.addEventListener("click", () => enterReviewMode(Number(row.ply)));
    target.appendChild(button);
  });
}

async function refreshMoveAlternatives() {
  const target = $("moveAlternatives");
  if (!target || !state) return;
  target.innerHTML = '<p class="hint">Comparing candidate plans…</p>';
  try {
    const selectedPly = reviewMode ? Number(reviewSnapshot?.ply || 0) : Number(state.moves_uci?.length || 0);
    const insight = selectedPly > 0 ? analysisResultForPly(selectedPly) : null;
    const base = insight
      ? await api("/api/review", { ply: Math.max(0, selectedPly - 1) })
      : (currentBoardView() || state);
    const result = await api("/api/multipv", { fen: base.fen, lines: 4, budget_ms: 450 });
    const lines = Array.isArray(result.lines) ? result.lines.slice(0, 4) : [];
    target.innerHTML = "";
    if (insight) {
      const played = document.createElement("div");
      played.className = "prep-row alternatives-played";
      played.innerHTML = `<strong>Played · ${escapeHtml(insight.played_san || insight.played_uci)}</strong><span>${Number(insight.cpl || 0)} CPL · ${escapeHtml(richMoveExplanation(insight))}</span>`;
      target.appendChild(played);
    }
    for (const [index, line] of lines.entries()) {
      let motifText = "positional";
      let planText = "Compare the resulting activity and piece placement.";
      try {
        const [motifs, child] = await Promise.all([
          api("/api/tactical-motifs", { fen: base.fen, move: line.move }),
          api("/api/variation-move", { fen: base.fen, move: line.move }),
        ]);
        if (motifs.motifs?.length) motifText = motifs.motifs.slice(0, 2).join(", ");
        const plans = await api("/api/position-insights", { fen: child.fen });
        if (plans.plans?.length) planText = plans.plans[0];
      } catch (_) {
        // The candidate still has useful score/PV data if explanatory enrichment fails.
      }
      const row = document.createElement("div");
      row.className = "prep-row alternative-row";
      row.innerHTML = `<strong>${index === 0 ? "Best" : `Alternative ${index}`} · ${escapeHtml(line.san || line.move)}</strong><span>${scoreText(line.score || 0)} · ${escapeHtml(motifText)} · ${escapeHtml(planText)}</span>`;
      target.appendChild(row);
    }
    if (!lines.length) target.innerHTML = '<p class="hint">No candidate lines are available for this position.</p>';
  } catch (error) {
    target.innerHTML = `<p class="hint">${escapeHtml(error.message)}</p>`;
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
    $("moveInsightExplain").textContent = richMoveExplanation(insight);
    const pv = Array.isArray(insight.pv_san) ? insight.pv_san : [];
    $("moveInsightPv").textContent = pv.length ? `Best line: ${pv.join(" ")}` : "";
  }
  $("retryMoveBtn").hidden = retryMode || !insight;
  $("retryBackBtn").hidden = !retryMode;
  if (failed && gameAnalysis?.error) $("statusLine").textContent = gameAnalysis.error;
  renderGameQualityTimeline();
}

function richMoveExplanation(insight) {
  if (!insight) return "";
  const parts = [];
  if (insight.explanation) parts.push(String(insight.explanation));
  const phase = String(insight.phase || "middlegame");
  const cpl = Number(insight.cpl || 0);
  if (cpl === 0) {
    parts.push(`In the ${phase}, this preserves the engine's preferred evaluation.`);
  } else if (cpl < 40) {
    parts.push(`The ${phase} position remains close to the best line; the loss is mainly precision rather than a tactical collapse.`);
  } else if (cpl < 100) {
    parts.push(`This gives up a noticeable share of the ${phase} advantage. Compare the first two moves of the best line for the missed idea.`);
  } else if (cpl < 250) {
    parts.push(`This is a concrete ${phase} mistake: the engine's alternative changes the evaluation by about ${(cpl / 100).toFixed(1)} pawns.`);
  } else {
    parts.push(`This is a major turning point. Reconstruct the position before the move and calculate the engine line without moving the pieces.`);
  }
  const before = Number(insight.best_eval_white);
  const after = Number(insight.eval_after_white);
  if (Number.isFinite(before) && Number.isFinite(after) && Math.sign(before) !== 0 && Math.sign(after) !== 0 && Math.sign(before) !== Math.sign(after)) {
    parts.push("The move also flips which side the engine prefers, so treat it as a critical decision point.");
  }
  return parts.join(" ");
}

function applyAnalysisPreset(name, trigger = true) {
  const presets = {
    quick: { lines: "1", budget: "150", auto: false },
    balanced: { lines: "3", budget: "350", auto: true },
    deep: { lines: "3", budget: "750", auto: true },
    study: { lines: "5", budget: "1500", auto: true },
  };
  const selected = presets[name] ? name : "custom";
  applyingAnalysisPreset = true;
  if ($("analysisPresetSelect")) $("analysisPresetSelect").value = selected;
  if (presets[selected]) {
    $("multipvCount").value = presets[selected].lines;
    $("positionAnalysisQuality").value = presets[selected].budget;
    $("analysisAutoToggle").checked = presets[selected].auto;
  }
  applyingAnalysisPreset = false;
  display.analysisPreset = selected;
  if (trigger) {
    saveDisplaySettings();
    autoPositionAnalysisFen = null;
    scheduleAutoPositionAnalysis(true);
  }
}

function markAnalysisPresetCustom() {
  if (applyingAnalysisPreset) return;
  display.analysisPreset = "custom";
  if ($("analysisPresetSelect")) $("analysisPresetSelect").value = "custom";
  saveDisplaySettings();
}

function analysisCacheKey(fen, lines, budgetMs) {
  return `${fen}|${lines}|${budgetMs}`;
}

function rememberPositionAnalysis(key, value) {
  if (positionAnalysisCache.has(key)) positionAnalysisCache.delete(key);
  positionAnalysisCache.set(key, value);
  while (positionAnalysisCache.size > 30) positionAnalysisCache.delete(positionAnalysisCache.keys().next().value);
  savePositionAnalysisCache();
}

async function addMoveToStudy(move) {
  if (!move) return false;
  if (!variationMode) await startVariationWorkspace();
  if (!variationMode) return false;
  const succeeded = await playVariationMove(move);
  if (succeeded) setStatus("Candidate added to the active study.", "success");
  return succeeded;
}

function renderMultiPvPanel() {
  if (!$("multipvLines")) return;
  const target = $("multipvLines");
  const currentPly = reviewMode ? Number(reviewSnapshot?.ply || 0) : (state?.moves_uci?.length || 0);
  const currentFen = currentBoardView()?.fen || state?.fen || "";
  const relevant = multiPvData && String(multiPvData.fen || "") === String(currentFen);
  $("multipvBtn").disabled = gameAnalysis?.status === "running" || !state || state.game_over && !reviewMode;
  $("multipvBtn").textContent = multiPvBusy ? (manualPositionAnalysisQueued ? "Refresh queued" : "Queue refresh") : "Analyze position";
  $("multipvMeta").textContent = multiPvBusy
    ? "Searching"
    : relevant
    ? `Depth ${multiPvData.depth} · ${Number(multiPvData.nodes || 0).toLocaleString()} nodes · ${multiPvData.elapsed_ms} ms`
    : `Ply ${currentPly}`;
  $("analysisCacheMeta").textContent = `${positionAnalysisCache.size} cached position${positionAnalysisCache.size === 1 ? "" : "s"}${manualPositionAnalysisQueued ? " · refresh queued" : ""}`;
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
    const row = document.createElement("div");
    row.className = "multipv-line-row";
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
    const study = document.createElement("button");
    study.type = "button";
    study.className = "secondary compact multipv-study";
    study.textContent = "+ Study";
    study.title = "Add this candidate as a branch in the analysis workspace";
    study.addEventListener("click", () => addMoveToStudy(line.move));
    row.append(button, study);
    target.appendChild(row);
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
    const path = variationPath();
    const branch = path.slice(1).map((node, index) => variationEdge(path[index].id, node.id).move_uci).filter(Boolean);
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
    const study = document.createElement("button");
    study.type = "button";
    study.className = "secondary compact";
    study.textContent = "Study";
    const legal = (view.legal_moves || []).includes(row.move);
    study.disabled = !legal || setupMode || trainerMode || busy;
    study.title = legal ? "Add this repertoire move to the analysis workspace" : "Move is not legal in the current board view";
    study.addEventListener("click", () => addMoveToStudy(row.move));
    item.append(move, outcomes, count, study);
    target.appendChild(item);
  });
}

function personalGameScore(snapshot) {
  const result = snapshot.result || snapshot.manual_result;
  const side = snapshot.human_side;
  if (!['white', 'black'].includes(side) || !['1-0', '0-1', '1/2-1/2'].includes(result)) return null;
  if (result === '1/2-1/2') return 0.5;
  return (result === '1-0') === (side === 'white') ? 1 : 0;
}

function renderOpeningPrepReport() {
  const target = $("openingPrepReport");
  if (!target) return;
  target.innerHTML = "";
  const groups = new Map();
  for (const game of recentGames) {
    const name = game.opening?.name || game.pgn_headers?.Opening || game.opening?.eco || "Unclassified opening";
    const entry = groups.get(name) || { name, games: 0, scores: [], openingCpl: [], mistakes: 0 };
    entry.games += 1;
    const score = personalGameScore(game);
    if (score !== null) entry.scores.push(score);
    const openingCpl = Number(game.analysis?.summary?.phase_avg_cpl?.opening);
    if (Number.isFinite(openingCpl)) entry.openingCpl.push(openingCpl);
    entry.mistakes += (game.analysis?.results || []).filter((item) => item.phase === "opening" && Number(item.cpl || 0) >= 80).length;
    groups.set(name, entry);
  }
  const repertoires = studyEntries().filter(([, workspace]) => workspace.kind === "repertoire");
  const ranked = [...groups.values()].sort((left, right) => {
    const leftCpl = left.openingCpl.length ? left.openingCpl.reduce((a, b) => a + b, 0) / left.openingCpl.length : 0;
    const rightCpl = right.openingCpl.length ? right.openingCpl.reduce((a, b) => a + b, 0) / right.openingCpl.length : 0;
    return right.games - left.games || rightCpl - leftCpl;
  }).slice(0, 6);
  if (!ranked.length) {
    target.innerHTML = '<p class="hint">Save or import games to build a local preparation report.</p>';
    return;
  }
  const summary = document.createElement("div");
  summary.className = "prep-summary";
  summary.textContent = `${recentGames.length} library games · ${repertoires.length} saved repertoire${repertoires.length === 1 ? "" : "s"}`;
  target.appendChild(summary);
  for (const entry of ranked) {
    const row = document.createElement("div");
    row.className = "prep-row";
    const title = document.createElement("strong");
    title.textContent = entry.name;
    const detail = document.createElement("span");
    const avgCpl = entry.openingCpl.length
      ? entry.openingCpl.reduce((sum, value) => sum + value, 0) / entry.openingCpl.length
      : null;
    const score = entry.scores.length
      ? entry.scores.reduce((sum, value) => sum + value, 0) / entry.scores.length * 100
      : null;
    detail.textContent = `${entry.games} games${score === null ? "" : ` · ${score.toFixed(0)}% score`}${avgCpl === null ? "" : ` · ${avgCpl.toFixed(0)} opening CPL`}${entry.mistakes ? ` · ${entry.mistakes} opening errors` : ""}`;
    row.append(title, detail);
    target.appendChild(row);
  }
}

function renderPlayerProfile() {
  const target = $("playerProfile");
  const rating = $("profileRating");
  if (!target || !rating) return;
  target.innerHTML = "";
  const analyzed = recentGames.filter((game) => Number.isFinite(Number(game.analysis?.summary?.accuracy)));
  const accuracies = analyzed.map((game) => Number(game.analysis.summary.accuracy));
  const avgAccuracy = accuracies.length ? accuracies.reduce((sum, value) => sum + value, 0) / accuracies.length : null;
  const blunders = analyzed.reduce((sum, game) => sum + Number(game.analysis?.summary?.blunders || 0), 0);
  const scored = recentGames.map(personalGameScore).filter((value) => value !== null);
  const scorePct = scored.length ? scored.reduce((sum, value) => sum + value, 0) / scored.length * 100 : null;
  const estimated = avgAccuracy === null ? null : Math.round(Math.max(600, Math.min(2600, 650 + avgAccuracy * 21)) / 50) * 50;
  rating.textContent = estimated ? `~${estimated} training` : "Unrated";
  const values = [
    ["Games", recentGames.length],
    ["Analyzed", analyzed.length],
    ["Accuracy", avgAccuracy === null ? "—" : `${avgAccuracy.toFixed(1)}%`],
    ["Score", scorePct === null ? "—" : `${scorePct.toFixed(0)}%`],
    ["Blunders/game", analyzed.length ? (blunders / analyzed.length).toFixed(2) : "—"],
    ["Trainer solved", trainerItems.reduce((sum, item) => sum + Number(item.solved || 0), 0)],
  ];
  for (const [label, value] of values) {
    const cell = document.createElement("div");
    const caption = document.createElement("span");
    caption.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = String(value);
    cell.append(caption, strong);
    target.appendChild(cell);
  }
}

function estimatedLocalRating(game) {
  const accuracy = Number(game?.analysis?.summary?.accuracy);
  if (!Number.isFinite(accuracy) || accuracy <= 0) return null;
  return Math.round(Math.max(600, Math.min(2600, 650 + accuracy * 21)) / 50) * 50;
}

function renderOpeningDatabase() {
  const target = $("openingDatabaseCount");
  if (!target) return;
  const count = Number(indexedLibraryStatus.games || 0);
  target.textContent = `${count} database game${count === 1 ? "" : "s"}`;
}

async function refreshOpeningDatabaseStatus() {
  try {
    indexedLibraryStatus = await api("/api/library-db/status", {});
    renderOpeningDatabase();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function openingDatabaseFilters() {
  const filters = {};
  const player = $("openingDatabasePlayer")?.value.trim();
  const structure = $("openingDatabaseStructure")?.value;
  const yearFrom = Number($("openingDatabaseYearFrom")?.value);
  const yearTo = Number($("openingDatabaseYearTo")?.value);
  const minElo = Number($("openingDatabaseMinElo")?.value);
  if (player) filters.player = player;
  if (structure) filters.structure = structure;
  if (Number.isFinite(yearFrom) && yearFrom > 0) filters.year_from = yearFrom;
  if (Number.isFinite(yearTo) && yearTo > 0) filters.year_to = yearTo;
  if (Number.isFinite(minElo) && minElo > 0) filters.min_elo = minElo;
  return filters;
}

async function openIndexedGame(gameId) {
  const result = await api("/api/library-db/game", { id: Number(gameId) });
  const pgn = result.game?.pgn;
  if (!pgn) throw new Error("Indexed game PGN is unavailable.");
  await loadPgnText(pgn);
}

async function searchOpeningDatabase() {
  const target = $("openingDatabaseResults");
  const count = $("openingDatabaseSearchCount");
  if (!target || !count) return;
  target.innerHTML = '<p class="hint">Searching indexed reference games…</p>';
  try {
    const result = await api("/api/library-db/search", {
      query: $("openingDatabaseSearch")?.value.trim() || "",
      filters: openingDatabaseFilters(),
      limit: 50,
    });
    const games = Array.isArray(result.games) ? result.games : [];
    count.textContent = `${Number(result.total || 0)} match${Number(result.total || 0) === 1 ? "" : "es"}`;
    target.innerHTML = "";
    games.forEach((game) => {
      const button = document.createElement("button");
      button.className = "compact-list-row";
      const title = document.createElement("strong");
      title.textContent = `${game.white || "White"} – ${game.black || "Black"} · ${game.result || "*"}`;
      const meta = document.createElement("span");
      const ratings = [game.white_elo, game.black_elo].filter((value) => Number(value) > 0);
      const avg = ratings.length
        ? Math.round(ratings.reduce((sum, value) => sum + Number(value), 0) / ratings.length)
        : null;
      meta.textContent = `${game.eco || "—"} ${game.opening || "Unclassified"}${game.year ? ` · ${game.year}` : ""}${avg ? ` · avg ${avg}` : ""}`;
      button.append(title, meta);
      button.addEventListener("click", () => openIndexedGame(game.id).catch((error) => setStatus(error.message, "error")));
      target.appendChild(button);
    });
    if (!games.length) target.innerHTML = '<p class="hint">No indexed reference games match these filters.</p>';
  } catch (error) {
    target.innerHTML = `<p class="hint">${escapeHtml(error.message)}</p>`;
  }
}

async function exploreOpeningDatabase() {
  const target = $("openingDatabaseExplorer");
  const fen = currentBoardView()?.fen || state?.fen;
  if (!target || !fen) return;
  target.innerHTML = '<p class="hint">Looking up indexed moves from this position…</p>';
  try {
    const result = await api("/api/library-db/explorer", {
      fen,
      filters: openingDatabaseFilters(),
      limit: 20,
    });
    const moves = Array.isArray(result.moves) ? result.moves : [];
    target.innerHTML = "";
    moves.forEach((item) => {
      const row = document.createElement("div");
      row.className = "prep-row";
      const title = document.createElement("strong");
      title.textContent = item.move_san || item.move_uci;
      const meta = document.createElement("span");
      const total = Math.max(1, Number(item.games || 0));
      const score = (Number(item.wins || 0) + Number(item.draws || 0) * 0.5) / total * 100;
      meta.textContent = `${total} games · ${score.toFixed(0)}% mover score${item.avg_elo ? ` · avg Elo ${item.avg_elo}` : ""}`;
      row.append(title, meta);
      target.appendChild(row);
    });
    if (!moves.length) target.innerHTML = '<p class="hint">No indexed reference games contain this position.</p>';
  } catch (error) {
    target.innerHTML = `<p class="hint">${escapeHtml(error.message)}</p>`;
  }
}

function repertoirePreparedMoves() {
  const prepared = new Map();
  for (const [, workspace] of studyEntries().filter(([, item]) => item.kind === "repertoire")) {
    for (const node of Object.values(workspace.nodes || {})) {
      const key = fenPositionKey(node?.snapshot?.fen);
      if (!key) continue;
      const moves = prepared.get(key) || new Set();
      for (const childId of node.children || []) {
        const child = workspace.nodes?.[childId];
        if (child?.move_uci) moves.add(child.move_uci);
      }
      if (moves.size) prepared.set(key, moves);
    }
  }
  return prepared;
}

function learnRepertoireConfidence() {
  const games = recentGames.filter((game) => Array.isArray(game.analysis?.results));
  let changed = false;
  for (const [, workspace] of studyEntries().filter(([, item]) => item.kind === "repertoire")) {
    for (const node of Object.values(workspace.nodes || {})) {
      const key = fenPositionKey(node?.snapshot?.fen);
      if (!key) continue;
      for (const childId of node.children || []) {
        const child = workspace.nodes?.[childId];
        if (!child?.move_uci) continue;
        let played = 0;
        let scoreSum = 0;
        for (const game of games) {
          const score = personalGameScore(game);
          for (const result of game.analysis.results) {
            if (fenPositionKey(result.fen_before) !== key || result.played_uci !== child.move_uci) continue;
            played += 1;
            if (score !== null) scoreSum += score;
          }
        }
        const confidence = played ? Math.round((scoreSum / Math.max(1, played)) * 60 + Math.min(40, played * 8)) : 50;
        if (child.confidence !== confidence || child.practice_games !== played) {
          child.confidence = confidence;
          child.practice_games = played;
          changed = true;
        }
      }
    }
  }
  if (changed) persistVariationWorkspaces();
}

function renderRepertoireGaps() {
  const target = $("repertoireGapReport");
  if (!target) return;
  learnRepertoireConfidence();
  target.innerHTML = "";
  const prepared = repertoirePreparedMoves();
  const gaps = new Map();
  for (const game of recentGames) {
    for (const result of game.analysis?.results || []) {
      if (Number(result.ply || 0) > 24 || !result.fen_before || !result.played_uci) continue;
      const key = fenPositionKey(result.fen_before);
      const responses = prepared.get(key);
      if (!responses || responses.has(result.played_uci)) continue;
      const gapKey = `${key}|${result.played_uci}`;
      const entry = gaps.get(gapKey) || {
        played: result.played_san || result.played_uci,
        best: result.best_san || result.best_uci,
        count: 0,
        cpl: 0,
      };
      entry.count += 1;
      entry.cpl += Number(result.cpl || 0);
      gaps.set(gapKey, entry);
    }
  }
  const rows = [...gaps.values()].sort((a, b) => b.count - a.count || b.cpl - a.cpl).slice(0, 8);
  if (!rows.length) {
    target.innerHTML = '<p class="hint">No analyzed departures from saved repertoire lines were found.</p>';
    return;
  }
  rows.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "prep-row";
    row.innerHTML = `<strong>${escapeHtml(entry.played)}</strong><span>${entry.count} departure${entry.count === 1 ? "" : "s"} · avg ${Math.round(entry.cpl / entry.count)} CPL · prepare ${escapeHtml(entry.best)}</span>`;
    target.appendChild(row);
  });
}

function fenFeatures(fen) {
  const board = boardMapFromFen(fen);
  const counts = {};
  const pawnFiles = Array(8).fill(0);
  const kings = { K: "", k: "" };
  for (const [square, piece] of Object.entries(board)) {
    counts[piece] = (counts[piece] || 0) + 1;
    if (piece.toLowerCase() === "p") pawnFiles[square.charCodeAt(0) - 97] += piece === "P" ? 1 : -1;
    if (piece === "K" || piece === "k") kings[piece] = square;
  }
  return { counts, pawnFiles, kings };
}

function positionSimilarity(leftFen, rightFen) {
  const left = fenFeatures(leftFen);
  const right = fenFeatures(rightFen);
  const pieces = "PNBRQKpnbrqk";
  let penalty = 0;
  for (const piece of pieces) penalty += Math.abs((left.counts[piece] || 0) - (right.counts[piece] || 0)) * 0.035;
  for (let file = 0; file < 8; file += 1) penalty += Math.abs(left.pawnFiles[file] - right.pawnFiles[file]) * 0.035;
  for (const king of ["K", "k"]) {
    if (!left.kings[king] || !right.kings[king]) continue;
    const fileDelta = Math.abs(left.kings[king].charCodeAt(0) - right.kings[king].charCodeAt(0));
    const rankDelta = Math.abs(Number(left.kings[king][1]) - Number(right.kings[king][1]));
    penalty += (fileDelta + rankDelta) * 0.012;
  }
  return Math.max(0, Math.min(1, 1 - penalty));
}

function searchSimilarGames() {
  const target = $("similarGameResults");
  if (!target || !state) return;
  const currentFen = currentBoardView()?.fen || state.fen;
  const matches = [];
  recentGames.forEach((game, gameIndex) => {
    const positions = (game.analysis?.results || []).map((item) => ({ fen: item.fen_before, ply: item.ply }));
    if (game.initial_fen) positions.unshift({ fen: game.initial_fen, ply: 0 });
    let best = null;
    positions.forEach((position) => {
      if (!position.fen) return;
      const score = positionSimilarity(currentFen, position.fen);
      if (!best || score > best.score) best = { ...position, score };
    });
    if (best && best.score >= 0.68) matches.push({ game, gameIndex, ...best });
  });
  matches.sort((a, b) => b.score - a.score);
  target.innerHTML = "";
  $("similarGameCount").textContent = `${matches.length} match${matches.length === 1 ? "" : "es"}`;
  matches.slice(0, 10).forEach((match) => {
    const button = document.createElement("button");
    button.className = "compact-list-row";
    button.innerHTML = `<strong>${Math.round(match.score * 100)}% similar</strong><span>${escapeHtml(match.game.opening?.name || "Saved game")} · ply ${match.ply || 0}</span>`;
    button.addEventListener("click", async () => {
      await openRecentGame(match.gameIndex);
      await enterReviewMode(Number(match.ply || 0));
    });
    target.appendChild(button);
  });
  if (!matches.length) target.innerHTML = '<p class="hint">Analyze more library games to enable structural similarity search.</p>';
}

function renderStrategicInsights() {
  const plans = $("humanPlanList");
  const motifs = $("tacticalMotifs");
  const features = $("positionFeatureGrid");
  if (!plans || !motifs || !features) return;
  plans.innerHTML = "";
  const planList = positionInsightsData?.plans || state?.plans || [];
  if (!planList.length) plans.innerHTML = '<p class="hint">Refresh strategic intelligence for this position.</p>';
  else planList.forEach((plan) => {
    const row = document.createElement("div");
    row.className = "prep-row";
    row.textContent = plan;
    plans.appendChild(row);
  });
  features.innerHTML = "";
  const data = positionInsightsData;
  if (!data) {
    features.innerHTML = '<p class="hint">Refresh strategic intelligence to inspect structural features.</p>';
  } else {
    const appendFeature = (label, value) => {
      const cell = document.createElement("div");
      const caption = document.createElement("span");
      caption.textContent = label;
      const strong = document.createElement("strong");
      strong.textContent = value || "—";
      cell.append(caption, strong);
      features.appendChild(cell);
    };
    const material = Number(data.material?.balance || 0);
    appendFeature("Material", `${material >= 0 ? "+" : ""}${material} White`);
    const pawnSummary = (color) => {
      const structure = data.pawn_structure?.[color] || {};
      const pieces = [];
      if (structure.isolated?.length) pieces.push(`${structure.isolated.length} isolated`);
      if (structure.doubled_files?.length) pieces.push(`doubled ${structure.doubled_files.join(",")}`);
      if (structure.passed?.length) pieces.push(`${structure.passed.length} passed`);
      return pieces.join(" · ") || "healthy";
    };
    appendFeature("White pawns", pawnSummary("white"));
    appendFeature("Black pawns", pawnSummary("black"));
    const openFiles = data.files?.open || [];
    appendFeature("Open files", openFiles.length ? openFiles.join(", ") : "none");
    const semiWhite = data.files?.semi_open?.white || [];
    const semiBlack = data.files?.semi_open?.black || [];
    appendFeature(
      "Semi-open",
      `White ${semiWhite.join(",") || "—"} · Black ${semiBlack.join(",") || "—"}`,
    );
    appendFeature(
      "Weak squares",
      `W ${(data.weak_squares?.white || []).slice(0, 3).join(",") || "—"} · B ${(data.weak_squares?.black || []).slice(0, 3).join(",") || "—"}`,
    );
    appendFeature(
      "Outposts",
      `W ${(data.knight_outposts?.white || []).join(",") || "—"} · B ${(data.knight_outposts?.black || []).join(",") || "—"}`,
    );
    appendFeature(
      "King safety",
      `W ${data.king_safety?.white?.shield ?? 0}/${data.king_safety?.white?.enemy_pressure ?? 0} · B ${data.king_safety?.black?.shield ?? 0}/${data.king_safety?.black?.enemy_pressure ?? 0}`,
    );
    appendFeature(
      "Space",
      `White ${data.space?.white ?? 0} · Black ${data.space?.black ?? 0}`,
    );
    appendFeature(
      "Pawn breaks",
      [...(data.pawn_breaks?.white || []), ...(data.pawn_breaks?.black || [])].slice(0, 5).join(", ") || "none",
    );
    appendFeature(
      "Piece activity",
      `W best ${data.piece_activity?.white?.best || "—"}/worst ${data.piece_activity?.white?.worst || "—"} · B best ${data.piece_activity?.black?.best || "—"}/worst ${data.piece_activity?.black?.worst || "—"}`,
    );
    appendFeature("Heuristic structures", (data.structure_tags || []).join(" · ") || "none detected");
  }
  motifs.innerHTML = "";
  const ply = reviewMode ? Number(reviewSnapshot?.ply || 0) : Number(state?.moves_uci?.length || 0);
  const insight = ply > 0 ? analysisResultForPly(ply) : null;
  const labels = Array.isArray(insight?.motifs) ? insight.motifs : [];
  labels.forEach((label) => {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.textContent = label;
    chip.title = "Heuristic pattern label; verify the continuation before using it as a tactic.";
    motifs.appendChild(chip);
  });
  if (!labels.length) {
    const chip = document.createElement("span");
    chip.className = "hint";
    chip.textContent = insight ? "No forcing tactical motif detected on this move." : "Analyze a game to classify tactical motifs.";
    motifs.appendChild(chip);
  }
}

async function refreshPositionInsights() {
  const fen = currentBoardView()?.fen || state?.fen;
  if (!fen || positionInsightsBusy) return;
  positionInsightsBusy = true;
  try {
    positionInsightsData = await api("/api/position-insights", { fen });
    renderStrategicInsights();
    renderBoard();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    positionInsightsBusy = false;
  }
}

async function probeTablebase() {
  const fen = currentBoardView()?.fen || state?.fen;
  if (!fen) return;
  const target = $("tablebaseResult");
  target.innerHTML = '<p class="hint">Probing local tablebases…</p>';
  try {
    const result = await api("/api/tablebase", { fen, path: $("syzygyPathInput").value.trim() });
    if (!result.available) target.innerHTML = `<p class="hint">${escapeHtml(result.reason || "Tablebase directory unavailable.")}</p>`;
    else if (!result.eligible) target.innerHTML = `<p class="hint">${result.piece_count} pieces · exact Syzygy probing starts at seven pieces or fewer.</p>`;
    else if (result.missing) target.innerHTML = `<p class="hint">This position is not present in the selected tablebase set.</p>`;
    else {
      target.innerHTML = "";
      const summary = document.createElement("div");
      summary.className = "prep-row";
      const title = document.createElement("strong");
      title.textContent = capitalize(result.result || "unknown");
      const meta = document.createElement("span");
      meta.textContent = `WDL ${result.wdl}${result.dtz == null ? "" : ` · DTZ ${result.dtz}`}`;
      summary.append(title, meta);
      target.appendChild(summary);
      const policy = document.createElement("p");
      policy.className = "hint";
      policy.textContent = "Moves preserve WDL. DTZ and the remaining 50-move clock are not used to choose a perfect-play move.";
      target.appendChild(policy);
      if (result.only_winning_move) {
        const only = document.createElement("p");
        only.className = "tablebase-only-move";
        const row = (result.optimal_moves || []).find((item) => item.uci === result.only_winning_move);
        only.textContent = `Only winning move: ${row?.san || result.only_winning_move}`;
        target.appendChild(only);
      }
      (result.optimal_moves || []).slice(0, 5).forEach((item, index) => {
        const row = document.createElement("div");
        row.className = "prep-row";
        const name = document.createElement("strong");
        name.textContent = `${index + 1}. ${item.san || item.uci}`;
        const detail = document.createElement("span");
        detail.textContent = `WDL ${item.wdl}${item.dtz == null ? "" : ` · DTZ ${item.dtz}`}`;
        row.append(name, detail);
        target.appendChild(row);
      });
    }
  } catch (error) {
    target.innerHTML = `<p class="hint">${escapeHtml(error.message)}</p>`;
  }
}

async function chooseExternalEngine() {
  const desktop = desktopApi();
  if (desktop?.openEngine) {
    const path = await desktop.openEngine();
    if (path) $("externalEnginePath").value = path;
    return;
  }
  $("externalEnginePath").focus();
  setStatus("Enter the path to an installed UCI engine executable.");
}

function renderExternalEngines() {
  const select = $("externalEngineSelect");
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">Saved engines…</option>';
  externalEngines.forEach((engine, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = engine.name || engine.path.split(/[\\/]/).pop() || engine.path;
    select.appendChild(option);
  });
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function saveExternalEnginePath() {
  const path = $("externalEnginePath").value.trim();
  if (!path) {
    setStatus("Choose an external UCI engine first.", "error");
    return;
  }
  const name = path.split(/[\\/]/).pop() || `Engine ${externalEngines.length + 1}`;
  const existing = externalEngines.findIndex((engine) => engine.path === path);
  if (existing >= 0) externalEngines.splice(existing, 1);
  externalEngines.unshift({ name: name.slice(0, 80), path: path.slice(0, 1024) });
  saveExternalEngines();
  renderExternalEngines();
  setStatus(`Saved external engine “${name}”.`, "success");
}

function selectExternalEngine() {
  const index = Number($("externalEngineSelect").value);
  if (Number.isInteger(index) && externalEngines[index]) {
    $("externalEnginePath").value = externalEngines[index].path;
  }
}

function externalScoreText(line) {
      if (line?.mate != null && Number.isFinite(Number(line.mate))) return `M${line.mate}`;
      if (line?.score_cp != null && Number.isFinite(Number(line.score_cp))) {
        const value = Number(line.score_cp) / 100;
        return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
      }
      if (line?.score != null && Number.isFinite(Number(line.score))) {
        const value = Number(line.score) / 100;
        return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
      }
      return "—";
}

async function compareExternalEngine() {
  const executable = $("externalEnginePath").value.trim();
  if (!executable) {
    setStatus("Choose or enter a UCI engine executable first.", "error");
    return;
  }
  const fen = currentBoardView()?.fen || state?.fen;
  const budget = Math.max(100, Math.min(2000, Number($("externalEngineBudget").value) || 300));
  const lines = Math.max(1, Math.min(5, Number($("externalEngineLines").value) || 3));
  const target = $("externalEngineResult");
  target.innerHTML = '<p class="hint">Comparing engines…</p>';
  try {
    const result = await api("/api/external-uci", { executable, fen, budget_ms: budget, lines });
    target.innerHTML = "";
    const verdict = document.createElement("p");
    verdict.className = result.agree ? "hint" : "engine-disagreement";
    verdict.textContent = result.agree
      ? "Both engines chose the same top move."
      : `Disagreement: FunChessEngine chose ${result.funchess?.san || result.funchess?.move || "—"}; ${result.external?.name || "external UCI"} chose ${result.external?.san || result.external?.move || "—"}.`;
    target.appendChild(verdict);
    const addEngineLines = (name, rows, meta = "") => {
      const heading = document.createElement("div");
      heading.className = "setting-heading external-engine-heading";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = name;
      const detail = document.createElement("span");
      detail.className = "setting-value";
      detail.textContent = meta;
      heading.append(label, detail);
      target.appendChild(heading);
      (rows || []).slice(0, lines).forEach((line, index) => {
        const row = document.createElement("div");
        row.className = "prep-row external-engine-line";
        const title = document.createElement("strong");
        title.textContent = `${index + 1}. ${line.san || line.move || "—"}`;
        const text = document.createElement("span");
        const pv = (line.pv_san || line.pv || []).slice(0, 5).join(" ");
        text.textContent = `${externalScoreText(line)}${line.depth == null ? "" : ` · d${line.depth}`}${pv ? ` · ${pv}` : ""}`;
        row.append(title, text);
        target.appendChild(row);
      });
    };
    addEngineLines(
      "FunChessEngine",
      result.funchess?.lines,
      `${result.budget_ms} ms budget · ${result.funchess?.elapsed_ms ?? "—"} ms used · depth ${result.funchess?.depth ?? "—"}`,
    );
    addEngineLines(
      result.external?.name || "External UCI",
      result.external?.lines,
      `${result.external?.elapsed_ms ?? 0} ms`,
    );
    externalCompareHistory.unshift({...result, created_at:new Date().toISOString()});
    saveExternalCompareHistory();
    renderExternalComparisonHistory();
    const saved = externalEngines.find((engine) => engine.path === executable);
    if (saved && result.external?.name && saved.name !== result.external.name) {
      saved.name = String(result.external.name).slice(0, 80);
      saved.options = result.external.options || {};
      saveExternalEngines();
      renderExternalEngines();
    }
  } catch (error) {
    target.innerHTML = `<p class="hint">${escapeHtml(error.message)}</p>`;
  }
}

function renderTimeCoaching() {
  const target = $("timeCoachingReport");
  if (!target) return;
  const coaching = state?.time_coaching;
  target.innerHTML = "";
  if (!coaching) {
    target.innerHTML = '<p class="hint">Play moves with a clock to build time-management feedback.</p>';
    return;
  }
  const summary = document.createElement("div");
  summary.className = "prep-row";
  summary.innerHTML = `<strong>Average think</strong><span>White ${Math.round(Number(coaching.average_think_ms?.white || 0) / 100) / 10}s · Black ${Math.round(Number(coaching.average_think_ms?.black || 0) / 100) / 10}s</span>`;
  target.appendChild(summary);
  (coaching.advice || []).forEach((text) => {
    const row = document.createElement("p");
    row.className = "hint";
    row.textContent = text;
    target.appendChild(row);
  });
}

function reportGameRows() {
  return recentGames.slice(0, 500).map((game) => ({
    date: game.saved_at ? new Date(game.saved_at).toLocaleDateString() : "",
    opening: game.opening?.name || game.opening?.eco || game.pgn_headers?.Opening || "Unclassified",
    result: game.result || game.manual_result || "*",
    accuracy: Number.isFinite(Number(game.analysis?.summary?.accuracy)) ? `${Number(game.analysis.summary.accuracy).toFixed(1)}%` : "—",
  }));
}

async function exportAnnotatedPgn() {
  try {
    const result = await api("/api/export-annotated-pgn", {});
    const text = `${String(result.pgn || "").trim()}\n`;
    const desktop = desktopApi();
    if (desktop?.savePgn) await desktop.savePgn("funchess-annotated.pgn", text);
    else await downloadBlob(new Blob([text], { type: "application/x-chess-pgn;charset=utf-8" }), "funchess-annotated.pgn");
    setStatus("Annotated PGN exported.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function exportHtmlReport() {
  try {
    const analyzed = recentGames.filter((game) => Number.isFinite(Number(game.analysis?.summary?.accuracy)));
    const ratings = analyzed.map(estimatedLocalRating).filter((value) => value !== null);
    const result = await api("/api/export-html-report", {
      title: "FunChessEngine local performance report",
      games: reportGameRows(),
      profile: {
        Games: recentGames.length,
        Analyzed: analyzed.length,
        "Estimated rating": ratings.length ? ratings.at(-1) : "Unrated",
        "Training positions": trainerItems.length,
        Repertoires: studyEntries().filter(([, workspace]) => workspace.kind === "repertoire").length,
      },
    });
    await downloadBlob(new Blob([result.html], { type: "text/html;charset=utf-8" }), "funchess-report.html");
    setStatus("HTML performance report exported.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function timeControlBucket(game) {
  const base = Number(game.base_clock_ms || 0);
  if (base <= 120_000) return "Bullet";
  if (base <= 300_000) return "Blitz";
  if (base <= 900_000) return "Rapid";
  return "Classical";
}

function renderPerformanceHistory() {
  const target = $("timeControlPerformance");
  const rating = $("performanceRating");
  const canvas = $("ratingHistoryGraph");
  if (!target || !rating || !canvas) return;
  target.innerHTML = "";
  const buckets = new Map();
  for (const game of recentGames) {
    const name = timeControlBucket(game);
    const entry = buckets.get(name) || { games: 0, scores: [] };
    entry.games += 1;
    const score = personalGameScore(game);
    if (score !== null) entry.scores.push(score);
    buckets.set(name, entry);
  }
  for (const name of ["Bullet", "Blitz", "Rapid", "Classical"]) {
    const entry = buckets.get(name) || { games: 0, scores: [] };
    const cell = document.createElement("div");
    const score = entry.scores.length
      ? `${Math.round(entry.scores.reduce((sum, value) => sum + value, 0) / entry.scores.length * 100)}%`
      : "—";
    cell.innerHTML = `<span>${escapeHtml(name)}</span><strong>${escapeHtml(entry.games)} · ${escapeHtml(score)}</strong>`;
    target.appendChild(cell);
  }
  const points = recentGames
    .map((game) => ({ date: new Date(game.saved_at || 0).getTime(), rating: estimatedLocalRating(game) }))
    .filter((item) => item.rating && Number.isFinite(item.date))
    .sort((a, b) => a.date - b.date);
  rating.textContent = points.length ? `~${points.at(-1).rating}` : "Unrated";
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(240, Math.round(rect.width || 360));
  const height = 110;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.scale(dpr, dpr);
  context.clearRect(0, 0, width, height);
  if (!points.length) return;
  const min = Math.min(...points.map((item) => item.rating)) - 100;
  const max = Math.max(...points.map((item) => item.rating)) + 100;
  context.beginPath();
  points.forEach((item, index) => {
    const x = points.length === 1 ? width / 2 : 10 + index * (width - 20) / (points.length - 1);
    const y = 10 + (max - item.rating) * (height - 20) / Math.max(1, max - min);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "currentColor";
  context.lineWidth = 2;
  context.stroke();
}

function renderCalibrationEngines() {
  const select = $("calibrationEngineSelect");
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">External engine…</option>';
  externalEngines.forEach((engine, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = engine.name || engine.path.split(/[\\/]/).pop() || `Engine ${index + 1}`;
    select.appendChild(option);
  });
  if ([...select.options].some((option) => option.value === current)) select.value = current;
  const latest = calibrationHistory[0];
  if (latest && $("calibrationResult")) {
    $("calibrationResult").innerHTML = `<div class="prep-row"><strong>~${escapeHtml(latest.estimated_elo)}</strong><span>${escapeHtml(latest.games)} games vs ~${escapeHtml(latest.opponent_elo)} · ${(Number(latest.score || 0) * 100).toFixed(0)}% score · interval ~${escapeHtml(latest.elo_interval?.[0] ?? "—")}–${escapeHtml(latest.elo_interval?.[1] ?? "—")}</span></div>`;
  }
}

async function runMeasuredCalibration() {
  const selectedEngine = $("calibrationEngineSelect")?.value;
  const index = selectedEngine === "" ? NaN : Number(selectedEngine);
  const engine = Number.isInteger(index) ? externalEngines[index] : null;
  if (!engine?.path) {
    setStatus("Save and select an external UCI engine before running calibration.", "error");
    return;
  }
  const opponentElo = Math.max(400, Math.min(3500, Number($("calibrationOpponentElo")?.value) || 1600));
  const games = Math.max(2, Math.min(12, Number($("calibrationGames")?.value) || 4));
  setStatus(`Running ${games} measured calibration games against ${engine.name || "the selected UCI engine"}…`, "loading");
  try {
    const result = await runBackgroundJob("calibration", {
      executable: engine.path,
      opponent_elo: opponentElo,
      games,
      movetime_ms: 80,
    });
    const record = {
      ...result,
      engine_name: engine.name || engine.path,
      ...(result._workstationJobId ? { job_id: result._workstationJobId } : {}),
      created_at: new Date().toISOString(),
    };
    calibrationHistory.unshift(record);
    saveCalibrationHistory();
    renderCalibrationEngines();
    setStatus(`Measured local estimate ~${result.estimated_elo} from ${result.games} calibration games.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function renderSessionGoals() {
  if (!$("sessionGoalsProgress")) return;
  if (sessionGoals.date !== todayKey()) sessionGoals = loadSessionGoals();
  for (const [id, key] of [["goalTactics", "tactics"], ["goalRepertoire", "repertoire"], ["goalEndgames", "endgames"], ["goalLosses", "losses"]]) {
    if ($(id) && document.activeElement !== $(id)) $(id).value = String(sessionGoals.targets[key] || 0);
  }
  const target = $("sessionGoalsProgress");
  target.innerHTML = "";
  let completed = 0;
  let total = 0;
  for (const [key, label] of [["tactics", "Tactics"], ["repertoire", "Repertoire"], ["endgames", "Endgames"], ["losses", "Reviewed losses"]]) {
    const goal = Number(sessionGoals.targets[key] || 0);
    const progress = Number(sessionGoals.progress[key] || 0);
    if (goal > 0) {
      total += goal;
      completed += Math.min(goal, progress);
    }
    const row = document.createElement("div");
    row.className = "prep-row";
    row.innerHTML = `<strong>${label}</strong><span>${progress} / ${goal}${goal && progress >= goal ? " · ✓" : ""}</span>`;
    target.appendChild(row);
  }
  $("sessionGoalsStatus").textContent = total ? `${Math.round(completed * 100 / total)}%` : "No goals";
}

function saveSessionGoalTargets() {
  sessionGoals.date = todayKey();
  sessionGoals.targets = {
    tactics: Math.max(0, Math.min(200, Number($("goalTactics")?.value) || 0)),
    repertoire: Math.max(0, Math.min(200, Number($("goalRepertoire")?.value) || 0)),
    endgames: Math.max(0, Math.min(50, Number($("goalEndgames")?.value) || 0)),
    losses: Math.max(0, Math.min(50, Number($("goalLosses")?.value) || 0)),
  };
  saveSessionGoals();
  renderSessionGoals();
  setStatus("Today's training goals saved locally.", "success");
}

async function reviewNextLoss() {
  const candidate = recentGames
    .map((game, index) => ({ game, index }))
    .find(({ game }) => personalGameScore(game) === 0);
  if (!candidate) {
    setStatus("No personal loss is available in the saved game library.", "error");
    return;
  }
  await openRecentGame(candidate.index);
  const firstError = (candidate.game.analysis?.results || []).find((row) => Number(row.cpl || 0) >= 80);
  if (firstError?.ply) await enterReviewMode(Number(firstError.ply));
  recordSessionGoal("losses");
  setStatus("Opened a saved loss for review.", "success");
}

function repertoireEntries() {
  return studyEntries().filter(([, workspace]) => workspace.kind === "repertoire");
}

function renderRepertoireTrainer() {
  const select = $("repertoireTrainerSelect");
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">Choose repertoire…</option>';
  let lines = 0;
  repertoireEntries().forEach(([key, workspace]) => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = workspace.name || "Untitled repertoire";
    select.appendChild(option);
    lines += Object.values(workspace.nodes || {}).filter((node) => node?.children?.length).length;
  });
  if ([...select.options].some((option) => option.value === current)) select.value = current;
  $("repertoireTrainerCount").textContent = `${lines} line${lines === 1 ? "" : "s"}`;
  const workspace = savedVariationWorkspaces[select.value];
  const color = $("repertoireColorSelect")?.value || workspace?.repertoire_side || "white";
  const due = trainerItems.filter((item) => (
    String(item.source || "").startsWith(`repertoire:${select.value}:`)
    && item.repertoire_color === color
    && Number(item.due_at || 0) <= Date.now()
  )).length;
  if ($("repertoireDueMeta")) {
    $("repertoireDueMeta").textContent = workspace
      ? `${due} ${color} line${due === 1 ? "" : "s"} due now · shared transpositions are trained once.`
      : "Choose a repertoire to see scheduled review lines.";
  }
}

function startRepertoireTraining() {
  const key = $("repertoireTrainerSelect").value;
  const workspace = savedVariationWorkspaces[key];
  if (!workspace) {
    setStatus("Choose a saved repertoire first.", "error");
    return;
  }
  normalizeVariationWorkspace(workspace);
  const color = $("repertoireColorSelect")?.value || workspace.repertoire_side || "white";
  let added = 0;
  Object.values(workspace.nodes || {}).forEach((node) => {
    if (!node?.snapshot?.fen || node.snapshot.turn !== color || !node.children?.length) return;
    const childId = node.children[0];
    const child = workspace.nodes?.[childId];
    const edge = workspaceEdge(workspace, node.id, childId);
    if (!child || !edge?.move_uci) return;
    const itemKey = `repertoire:${key}:${node.id}:${edge.move_uci}`;
    const existing = trainerItems.find((item) => item.key === itemKey);
    if (existing) {
      existing.confidence = Math.max(0, Math.min(100, Number(existing.confidence ?? child.confidence ?? 50)));
      existing.repertoire_color = color;
      return;
    }
    trainerItems.unshift({
      key: itemKey,
      fen: node.snapshot.fen,
      best_uci: edge.move_uci,
      best_san: edge.move_san || edge.move_uci,
      classification: "Repertoire",
      cpl: Math.max(0, 100 - Number(child.confidence || 50)),
      phase: "opening",
      explanation: child.comment || `Recall the prepared move from ${workspace.name || "your repertoire"}.`,
      source: `repertoire:${key}:${workspace.name || "repertoire"}`,
      repertoire_key: key,
      repertoire_node: node.id,
      repertoire_color: color,
      confidence: Math.max(0, Math.min(100, Number(child.confidence ?? 50))),
      ease: 2.2,
      interval_days: 1,
      lapses: 0,
      created_at: new Date().toISOString(),
      attempts: 0,
      solved: 0,
      due_at: Date.now(),
    });
    added += 1;
  });
  saveTrainerItems();
  renderTrainerPanel();
  const due = trainerItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.repertoire_key === key && item.repertoire_color === color && Number(item.due_at || 0) <= Date.now());
  if (due.length) {
    trainerFocusMode = "opening";
    void startTrainer("opening", due.map(({ item }) => item.key));
  }
  renderRepertoireTrainer();
  setStatus(`Prepared ${due.length} due ${color} repertoire line${due.length === 1 ? "" : "s"}${added ? ` · ${added} newly added` : ""}.`, "success");
}

async function buildAutomaticRepertoire() {
  const side = $("autoRepertoireSide")?.value === "black" ? "black" : "white";
  const minimum = Math.max(1, Math.min(20, Number($("autoRepertoireFrequency")?.value) || 2));
  const analyzed = recentGames.filter((game) => (
    !game.reference_database
    && Array.isArray(game.analysis?.results)
    && game.analysis.results.length
    && (game.initial_fen || STARTING_FEN) === STARTING_FEN
  ));
  if (!analyzed.length) {
    setStatus("Analyze some personal games before building an automatic repertoire.", "error");
    return;
  }
  setStatus(`Building a ${side} repertoire from ${analyzed.length} analyzed games…`, "loading");
  const positions = new Map();
  analyzed.forEach((game) => {
    const gameScore = personalGameScore(game);
    for (const result of game.analysis.results || []) {
      if (!result.fen_before || !result.played_uci || Number(result.ply || 0) > 24) continue;
      const key = fenPositionKey(result.fen_before);
      const byMove = positions.get(key) || new Map();
      const entry = byMove.get(result.played_uci) || {
        move: result.played_uci,
        san: result.played_san || result.played_uci,
        mover: result.mover,
        count: 0,
        cpl: 0,
        score: 0,
        scored: 0,
      };
      entry.count += 1;
      entry.cpl += Number(result.cpl || 0);
      if (gameScore !== null) {
        entry.score += Number(gameScore);
        entry.scored += 1;
      }
      byMove.set(result.played_uci, entry);
      positions.set(key, byMove);
    }
  });
  const rootSnapshot = await api("/api/position", { fen: STARTING_FEN });
  const root = newVariationNode(rootSnapshot);
  const storageKey = `auto-repertoire:${globalThis.crypto?.randomUUID?.() || Date.now()}`;
  const workspace = {
    root: root.id,
    origin_ply: 0,
    storage_key: storageKey,
    name: `My ${capitalize(side)} repertoire · ${new Date().toLocaleDateString()}`.slice(0, 80),
    kind: "repertoire",
    repertoire_side: side,
    favorite: false,
    folder: "Auto repertoires",
    tags: [side, "generated", "personal games"],
    nodes: { [root.id]: root },
    edges: {},
    updated_at: new Date().toISOString(),
  };
  const canonical = new Map([[fenPositionKey(rootSnapshot.fen), root.id]]);
  const queue = [root.id];
  while (queue.length && Object.keys(workspace.nodes).length < 120) {
    const nodeId = queue.shift();
    const node = workspace.nodes[nodeId];
    const choices = [...(positions.get(fenPositionKey(node.snapshot.fen))?.values() || [])]
      .filter((entry) => entry.count >= minimum)
      .sort((left, right) => {
        const leftQuality = left.count * 50 - left.cpl / Math.max(1, left.count) + (left.score / Math.max(1, left.scored)) * 20;
        const rightQuality = right.count * 50 - right.cpl / Math.max(1, right.count) + (right.score / Math.max(1, right.scored)) * 20;
        return rightQuality - leftQuality;
      });
    if (!choices.length) continue;
    const selectedChoices = node.snapshot.turn === side ? choices.slice(0, 1) : choices.slice(0, 3);
    for (const choice of selectedChoices) {
      if (Object.keys(workspace.nodes).length >= 120) break;
      try {
        const childSnapshot = await api("/api/variation-move", { fen: node.snapshot.fen, move: choice.move });
        const childKey = fenPositionKey(childSnapshot.fen);
        let childId = canonical.get(childKey);
        let child = childId ? workspace.nodes[childId] : null;
        if (!child) {
          child = newVariationNode(childSnapshot, nodeId, choice.move, choice.san);
          child.confidence = Math.max(20, Math.min(95, Math.round(
            45 + Math.min(35, choice.count * 5) - choice.cpl / Math.max(1, choice.count) / 8,
          )));
          workspace.nodes[child.id] = child;
          canonical.set(childKey, child.id);
          childId = child.id;
          queue.push(child.id);
        } else {
          child.parents = Array.isArray(child.parents) ? child.parents : [];
          if (!child.parents.includes(nodeId)) child.parents.push(nodeId);
        }
        if (!node.children.includes(childId)) node.children.push(childId);
        workspace.edges[`${nodeId}>${childId}`] = { move_uci: choice.move, move_san: choice.san };
      } catch (_) {
        // Ignore an isolated stale analysis edge; the rest of the repertoire remains usable.
      }
    }
  }
  normalizeVariationWorkspace(workspace);
  savedVariationWorkspaces[storageKey] = workspace;
  persistVariationWorkspaces();
  renderStudyLibrary();
  renderRepertoireTrainer();
  $("repertoireTrainerSelect").value = storageKey;
  $("repertoireColorSelect").value = side;
  renderRepertoireTrainer();
  setStatus(`Created “${workspace.name}” with ${studyNodeCount(workspace)} shared positions.`, "success");
}

async function generateLibraryPuzzles() {
  const candidates = [];
  recentGames.forEach((game) => {
    if (game.reference_database) return;
    for (const result of game.analysis?.results || []) {
      if (
        Number(result.cpl || 0) >= 120
        && result.fen_before
        && result.best_uci
        && result.best_uci !== result.played_uci
      ) candidates.push({ game, result });
    }
  });
  if (!candidates.length) {
    setStatus("No analyzed tactical misses are available for puzzle generation yet.", "error");
    return;
  }
  const concrete = new Set([
    "fork", "skewer", "pin", "deflection", "attraction", "overload", "interference",
    "discovered attack", "clearance", "zwischenzug", "back-rank mate", "mating net",
    "trapped piece", "removal of defender", "mate",
  ]);
  let added = 0;
  for (const { game, result } of candidates.slice(0, 80)) {
    const key = `library-puzzle:${result.fen_before}|${result.best_uci}`;
    if (trainerItems.some((item) => item.key === key)) continue;
    try {
      const detected = await api("/api/tactical-motifs", {
        fen: result.fen_before,
        move: result.best_uci,
      });
      const motifs = (detected.motifs || []).filter((motif) => concrete.has(motif));
      if (!motifs.length) continue;
      trainerItems.unshift({
        key,
        fen: result.fen_before,
        best_uci: result.best_uci,
        best_san: result.best_san || detected.san || result.best_uci,
        played_san: result.played_san,
        classification: "Puzzle",
        cpl: Number(result.cpl || 0),
        phase: result.phase || "middlegame",
        motifs,
        explanation: `Find the ${motifs.slice(0, 2).join(" / ")} idea missed in this game.`,
        source: `library-puzzle:${game.recent_id || game.saved_at || "game"}`,
        created_at: new Date().toISOString(),
        attempts: 0,
        solved: 0,
        confidence: 40,
        ease: 2.3,
        interval_days: 1,
        lapses: 0,
        due_at: Date.now(),
      });
      added += 1;
    } catch (_) {
      // Skip a stale/corrupt analyzed position while continuing the bounded batch.
    }
  }
  trainerItems = trainerItems.slice(0, 250);
  saveTrainerItems();
  renderTrainerPanel();
  $("puzzleGenerationMeta").textContent = `${added} motif-backed puzzle${added === 1 ? "" : "s"} added from analyzed games.`;
  setStatus(`Generated ${added} tactical puzzle${added === 1 ? "" : "s"}.`, added ? "success" : "info");
}

let openingBookSequence=0;
async function refreshOpeningBook() {
  if (!$('openingBookMoves')) return;
  const fen=currentBoardView()?.fen || state?.fen || STARTING_FEN;
  const profile=state?.engine_profile || 'default',sequence=++openingBookSequence;
  try {
    const [stats,result]=await Promise.all([
      api('/api/opening-book',{action:'stats',profile}),
      api('/api/opening-book',{action:'query',fen,profile}),
    ]);
    if(sequence!==openingBookSequence)return;
    renderOpeningBook(fen,profile,stats,result);
  } catch(error) {
    if(sequence===openingBookSequence)$('openingBookMoves').innerHTML=`<p class="hint">${escapeHtml(error.message)}</p>`;
  }
}
function openingBookWeight(value) {
  const weight=Number(value);
  if(String(value).trim()==='' || !Number.isInteger(weight) || weight<0 || weight>65535)throw new Error('Book weight must be an integer from 0 to 65535.');
  return weight;
}
function renderOpeningBook(fen,profile,stats,result) {
  const fields=fen.split(' ');
  $('openingBookPosition').textContent=`${fields[1]==='w'?'White':'Black'} to move · move ${fields[5] || '1'}`;
  $('openingBookPosition').title=fen;
  $('openingBookCount').textContent=`${profile} · ${stats.moves || 0} moves`;
  const target=$('openingBookMoves');target.replaceChildren();
  for(const row of result.moves || []) {
    const line=document.createElement('div');line.className='compact-list-row static-row book-edit-row';
    const info=document.createElement('div');info.innerHTML=`<strong>${escapeHtml(row.san || row.move)}</strong><span>learn ${escapeHtml(row.learn)} · ${escapeHtml(row.source || 'local')}</span>`;
    const weight=document.createElement('input');weight.type='number';weight.min='0';weight.max='65535';weight.value=row.weight;
    weight.setAttribute('aria-label',`Weight for ${row.san || row.move}`);
    const save=document.createElement('button');save.type='button';save.className='secondary compact';save.textContent='Save weight';
    save.addEventListener('click',async()=>{
      save.disabled=true;
      try {
        const submitted=openingBookWeight(weight.value);
        await api('/api/opening-book',{action:'weight',fen,profile,move:row.move,weight:submitted,expected_weight:row.weight});
        row.weight=submitted;setStatus('Book weight saved; learning and source retained.','success');
      } catch(error) {setStatus(error.message,'error');} finally {save.disabled=false;}
    });
    const remove=document.createElement('button');remove.type='button';remove.className='text-button compact';remove.textContent='Remove';
    remove.addEventListener('click',async()=>{
      remove.disabled=true;
      try {await api('/api/opening-book',{action:'remove',fen,move:row.move,profile});await refreshOpeningBook();}
      catch(error) {setStatus(error.message,'error');remove.disabled=false;}
    });
    line.append(info,weight,save,remove);target.append(line);
  }
  if(!(result.moves || []).length)target.innerHTML='<p class="hint">No local book moves saved for this position.</p>';
}

async function addCurrentOpeningBookMove() {
  const fen = currentBoardView()?.fen || state?.fen;
  const move = String($("openingBookMove")?.value || "").trim().toLowerCase();
  if (!fen || !move) {
    setStatus("Enter a legal UCI move for the current position.", "error");
    return;
  }
  try {
    await api("/api/opening-book", {
      action: "add",
      fen,
      move,
      profile: state?.engine_profile || "default",
      weight: openingBookWeight($("openingBookWeight")?.value),
      variant: currentBoardView()?.variant || state?.variant || "standard",
    });
    if($("openingBookMove").value.trim().toLowerCase()===move)$("openingBookMove").value = "";
    await refreshOpeningBook();
    setStatus("Opening-book move saved locally.", "success");
  } catch (error) { setStatus(error.message, "error"); }
}

async function importPolyglotBook() {
  const path = String($("polyglotPathInput")?.value || "").trim();
  if (!path) {
    setStatus("Enter the path to a local Polyglot .bin book.", "error");
    return;
  }
  try {
    const result = await api("/api/opening-book", {
      action: "import_polyglot",
      path,
      profile: state?.engine_profile || "default",
      position_limit: 100000,
    });
    await refreshOpeningBook();
    setStatus(`Imported ${result.imported || 0} Polyglot move entries across ${result.positions || 0} indexed positions.`, "success");
  } catch (error) { setStatus(error.message, "error"); }
}

async function addCurrentFlashcard() {
  const fen = currentBoardView()?.fen || state?.fen;
  if (!fen) return;
  const wantChoices = Boolean($("lessonMultipleChoiceToggle")?.checked);
  const cachedLines = multiPvData?.fen === fen ? multiPvData.lines || [] : [];
  const result = cachedLines.length >= (wantChoices ? 3 : 1)
    ? { lines: cachedLines }
    : await api("/api/multipv", { fen, lines: wantChoices ? 3 : 1, budget_ms: 250 });
  const lines = Array.isArray(result.lines) ? result.lines : [];
  const move = lines[0]?.move;
  const san = lines[0]?.san;
  if (!move) throw new Error("Could not determine a solution move for this flashcard.");
  const choices = wantChoices ? lines.slice(0, 3).map((line, index) => ({
    move: line.move,
    san: line.san || line.move,
    score: Number(line.score || 0),
    feedback: index === 0
      ? "Best engine continuation."
      : `${line.san || line.move} is an alternative, evaluated ${scoreText(line.score || 0)}.`,
  })) : [];
  lessonDraftCards.push({
    fen,
    best_uci: move,
    best_san: san || move,
    note: $("lessonNoteInput").value.trim().slice(0, 240),
    choices,
    annotations: JSON.parse(JSON.stringify(currentAnnotations())),
    due_at: Date.now(),
    solved: 0,
  });
  $("lessonNoteInput").value = "";
  renderLessons();
  setStatus("Current position added to the lesson draft.", "success");
}

function saveLesson() {
  const title = $("lessonTitleInput").value.trim().slice(0, 60);
  if (!title || !lessonDraftCards.length) {
    setStatus("Give the lesson a title and add at least one flashcard.", "error");
    return;
  }
  lessons.unshift({ id: globalThis.crypto?.randomUUID?.() || `${Date.now()}`, title, cards: lessonDraftCards, updated_at: new Date().toISOString() });
  lessonDraftCards = [];
  $("lessonTitleInput").value = "";
  saveLessons();
  renderLessons();
  setStatus("Lesson saved locally.", "success");
}

function renderLessons() {
  const target = $("lessonList");
  if (!target) return;
  target.innerHTML = "";
  $("lessonCount").textContent = `${lessons.length} lesson${lessons.length === 1 ? "" : "s"}${lessonDraftCards.length ? ` · ${lessonDraftCards.length} draft cards` : ""}`;
  lessons.slice(0, 8).forEach((lesson) => {
    const row = document.createElement("div");
    row.className = "compact-list-row static-row";
    row.innerHTML = `<strong>${escapeHtml(lesson.title)}</strong><span>${lesson.cards?.length || 0} cards</span>`;
    target.appendChild(row);
  });
}

function studyDueFlashcards() {
  let added = 0;
  lessons.forEach((lesson) => {
    (lesson.cards || []).forEach((card, index) => {
      if (Number(card.due_at || 0) > Date.now()) return;
      const key = `lesson:${lesson.id}:${index}`;
      if (trainerItems.some((item) => item.key === key)) return;
      trainerItems.unshift({
        key,
        fen: card.fen,
        best_uci: card.best_uci,
        best_san: card.best_san,
        classification: "Lesson",
        cpl: 100,
        phase: "middlegame",
        explanation: card.note || `Recall this card from ${lesson.title}.`,
        source: `lesson:${lesson.title}`,
        choices: Array.isArray(card.choices) ? card.choices.slice(0, 4) : [],
        annotations: card.annotations && typeof card.annotations === "object"
          ? JSON.parse(JSON.stringify(card.annotations))
          : { squares: {}, arrows: [] },
        confidence: 50,
        ease: 2.3,
        interval_days: 1,
        lapses: 0,
        created_at: new Date().toISOString(),
        attempts: 0,
        solved: 0,
        due_at: Date.now(),
      });
      added += 1;
    });
  });
  saveTrainerItems();
  renderTrainerPanel();
  if (added || trainerItems.length) startTrainer("due");
  else setStatus("No lesson flashcards are due yet.");
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
    const result = await runBackgroundJob("benchmark", { clock_ms: clockMs, compare_path: comparePath });
    const summary = result.summary || {};
    const comparison = result.comparison || null;
    const detail = comparison
      ? `Mean depth ${Number(summary.mean_depth).toFixed(2)} · ${Number(summary.aggregate_nps).toLocaleString()} NPS · Δdepth ${Number(comparison.depth_delta) >= 0 ? "+" : ""}${Number(comparison.depth_delta).toFixed(2)} · ΔNPS ${Number(comparison.nps_delta) >= 0 ? "+" : ""}${Number(comparison.nps_delta).toLocaleString()} · ${comparison.changed_moves}/12 moves changed.`
      : `Mean depth ${Number(summary.mean_depth).toFixed(2)} · ${Number(summary.aggregate_nps).toLocaleString()} aggregate NPS · ${Number(summary.nodes).toLocaleString()} nodes.`;
    renderDevLabResult("Benchmark complete", detail);
    showDeveloperResult(result); saveWorkstationResult("benchmark", result);
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
    const result = await runBackgroundJob("arena", {
      opponent_path: opponentPath,
      games: Number($("devArenaGames").value || 6),
      base_ms: 5000,
      increment_ms: 100,
    });
    showDeveloperResult(result); saveWorkstationResult("arena", result);
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
  if (!state || gameAnalysis?.status === "running") return;
  const quiet = Boolean(options?.quiet);
  const ply = reviewMode ? Number(reviewSnapshot?.ply || 0) : (state.moves_uci?.length || 0);
  const fen = currentBoardView()?.fen || state.fen;
  const lines = Math.max(1, Math.min(5, Number($("multipvCount").value) || 3));
  const budgetMs = Math.max(100, Math.min(2000, Number($("positionAnalysisQuality")?.value || 350)));
  if (multiPvBusy) {
    manualPositionAnalysisQueued = true;
    renderMultiPvPanel();
    if (!quiet) setStatus("Position analysis refresh queued.");
    return;
  }
  const cacheKey = analysisCacheKey(fen, lines, budgetMs);
  const cached = positionAnalysisCache.get(cacheKey);
  if (cached && !options?.force) {
    multiPvData = cached;
    autoPositionAnalysisFen = fen;
    renderMultiPvPanel();
    renderBoard();
    if (!quiet) setStatus("Loaded candidate lines from the session cache.", "success");
    return;
  }
  multiPvBusy = true;
  multiPvArrowMove = null;
  renderMultiPvPanel();
  try {
    multiPvData = await api("/api/multipv", { ply, fen, lines, budget_ms: budgetMs });
    rememberPositionAnalysis(cacheKey, multiPvData);
    autoPositionAnalysisFen = fen;
    if (!quiet) setStatus(`Candidate lines searched to depth ${multiPvData.depth}.`, "success");
  } catch (error) {
    multiPvData = null;
    setStatus(error.message, "error");
  } finally {
    multiPvBusy = false;
    renderMultiPvPanel();
    renderBoard();
    if (manualPositionAnalysisQueued) {
      manualPositionAnalysisQueued = false;
      setTimeout(() => runMultiPv({ quiet: true }), 0);
      return;
    }
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

function renderTournament() {
  if (!$("tournamentScore")) return;
  if (!tournamentState) {
    const latest = tournamentHistory[0];
    $("tournamentScore").textContent = latest
      ? `${latest.white_wins}-${latest.draws}-${latest.black_wins}`
      : "Not running";
    $("tournamentProgress").innerHTML = latest
      ? `<p><strong>Last series:</strong> ${Number(latest.games)} games · White ${Number(latest.white_skill)} vs Black ${Number(latest.black_skill)} · ${Number(latest.white_wins)}W ${Number(latest.draws)}D ${Number(latest.black_wins)}B</p>`
      : '<p class="hint">No match series has been run.</p>';
    $("startTournamentBtn").disabled = busy;
    $("stopTournamentBtn").disabled = true;
    return;
  }
  const stateText = `${tournamentState.whiteWins}-${tournamentState.draws}-${tournamentState.blackWins}`;
  $("tournamentScore").textContent = tournamentState.active
    ? `Game ${Math.min(tournamentState.completed + 1, tournamentState.total)}/${tournamentState.total} · ${stateText}`
    : stateText;
  $("tournamentProgress").innerHTML = `<p><strong>White ${tournamentState.whiteSkill}</strong> vs <strong>Black ${tournamentState.blackSkill}</strong><br>${tournamentState.completed}/${tournamentState.total} complete · ${tournamentState.whiteWins} White wins · ${tournamentState.draws} draws · ${tournamentState.blackWins} Black wins</p>`;
  $("startTournamentBtn").disabled = Boolean(tournamentState.active);
  $("stopTournamentBtn").disabled = !tournamentState.active;
}

async function configureTournamentSide() {
  if (!tournamentState?.active || !state) return;
  const skill = state.turn === "white" ? tournamentState.whiteSkill : tournamentState.blackSkill;
  const config = await api("/api/engine-config", { profile: engineProfileForSkill(skill), skill });
  state.engine_profile = config.profile;
  state.engine_skill = config.skill;
  state.engine_move_time_cap_ms = config.move_time_cap_ms;
}

async function startTournament() {
  if (tournamentState?.active || busy || setupMode || trainerMode || variationMode || retryMode) return;
  const confirmed = await confirmRestartIfNeeded(
    "Starting an engine match series replaces the current game. Save or export a copy first if you want to keep it.",
  );
  if (!confirmed) return;
  if (reviewMode) await exitReviewMode(false);
  const total = Math.max(2, Math.min(20, Math.floor(Number($("tournamentGames").value) || 4)));
  const whiteSkill = nearestEngineSkill($("tournamentWhiteSkill").value);
  const blackSkill = nearestEngineSkill($("tournamentBlackSkill").value);
  tournamentState = {
    active: true,
    total,
    completed: 0,
    whiteSkill,
    blackSkill,
    whiteWins: 0,
    blackWins: 0,
    draws: 0,
    restoreHumanSide: $("humanSide").value,
    restoreProfile: state?.engine_profile || "maximum",
    restoreSkill: Number(state?.engine_skill || 100),
    restoreCap: Number(state?.engine_move_time_cap_ms || 2500),
    started_at: new Date().toISOString(),
  };
  $("humanSide").value = "none";
  previousHumanSide = "none";
  autoplay = true;
  selected = null;
  renderTournament();
  const succeeded = await act(
    () => api("/api/reset", resetPayloadFromControls()),
    `Engine match series started: ${whiteSkill} vs ${blackSkill}.`,
    clearTransientUiForReplacement,
  );
  if (!succeeded) {
    await stopTournament(false);
    return;
  }
  orientForHuman();
  scheduleComputerReply();
}

async function finishTournamentGame() {
  if (!tournamentState?.active || !state?.game_over) return;
  const result = state.result || "1/2-1/2";
  if (result === "1-0") tournamentState.whiteWins += 1;
  else if (result === "0-1") tournamentState.blackWins += 1;
  else tournamentState.draws += 1;
  tournamentState.completed += 1;
  archiveCompletedGame();
  renderTournament();
  if (tournamentState.completed >= tournamentState.total) {
    await stopTournament(true);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 180));
  if (!tournamentState?.active) return;
  const succeeded = await act(
    () => api("/api/reset", resetPayloadFromControls()),
    `Tournament game ${tournamentState.completed + 1}/${tournamentState.total} started.`,
    clearTransientUiForReplacement,
  );
  if (succeeded) scheduleComputerReply();
}

async function stopTournament(completed = false) {
  if (!tournamentState) return;
  const finished = { ...tournamentState };
  tournamentState.active = false;
  autoplay = false;
  clearTimeout(autoplayTimer);
  const restoreSide = ["white", "black", "both", "none"].includes(finished.restoreHumanSide)
    ? finished.restoreHumanSide
    : "white";
  $("humanSide").value = restoreSide;
  previousHumanSide = restoreSide;
  try {
    const config = await api("/api/engine-config", {
      profile: finished.restoreProfile,
      skill: finished.restoreSkill,
      move_time_cap_ms: finished.restoreCap,
    });
    if (state) {
      state.engine_profile = config.profile;
      state.engine_skill = config.skill;
      state.engine_move_time_cap_ms = config.move_time_cap_ms;
    }
  } catch (_) {}
  if (finished.completed > 0) {
    tournamentHistory.unshift({
      games: finished.completed,
      requested_games: finished.total,
      white_skill: finished.whiteSkill,
      black_skill: finished.blackSkill,
      white_wins: finished.whiteWins,
      black_wins: finished.blackWins,
      draws: finished.draws,
      completed_at: new Date().toISOString(),
    });
    saveTournamentHistory();
  }
  tournamentState = null;
  orientForHuman();
  render();
  setStatus(completed ? "Engine match series complete." : "Engine match series stopped.", completed ? "success" : "info");
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
    if (tournamentState?.active) {
      try {
        await configureTournamentSide();
      } catch (error) {
        setStatus(`Tournament engine configuration failed: ${error.message}`, "error");
        await stopTournament(false);
        return;
      }
    }
    const succeeded = await engineMove();
    if (succeeded && tournamentState?.active && state?.game_over) {
      await finishTournamentGame();
    } else if (succeeded && autoplay && $("humanSide").value === "none") {
      scheduleComputerReply();
    }
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
  autoplay = $("humanSide").value === "none";
  const succeeded = await act(
    () => api("/api/reset", resetPayloadFromControls({ fen: value, useChess960Position: false })),
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
  const builtins = [
    { label: "Open database browser", hint: "Reference games", action: openDatabaseWorkbench },
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
    { label: "Run engine benchmark", hint: "Tools", action: async () => { await revealWorkflow('developerLab', 'tools'); await runDeveloperBenchmark(); } },
    { label: "Open tournament manager", hint: "Tools", action: () => revealWorkflow('tournamentTools', 'tools') },
    { label: "Recent background work", hint: "Tools", action: async () => { await recoverWorkstationJobs(); await revealWorkflow('jobHistory', 'tools'); } },
    { label: "Flip board", hint: "F", action: () => $("flipBtn").click() },
    { label: "Undo live move", hint: "U", action: undoLiveMove },
    { label: "Pause / resume", hint: "Space", action: togglePause },
    { label: "Play engine move", hint: "E", action: engineMove },
    { label: "Appearance", hint: "Themes and pieces", action: () => document.querySelector('[data-tab="display"]')?.click() },
    { label: "Recent games", hint: "Local library", action: () => document.querySelector('[data-tab="position"]')?.click() },
    { label: "Find similar games", hint: "Library structure search", action: async () => { await activateTab(document.querySelector('[data-tab="position"]')); searchSimilarGames(); } },
    { label: "Find repertoire gaps", hint: "Opening preparation", action: async () => { await activateTab(document.querySelector('[data-tab="engine"]')); renderRepertoireGaps(); } },
    { label: "Refresh strategic plans", hint: "Threat map and plans", action: async () => { await activateTab(document.querySelector('[data-tab="engine"]')); await refreshPositionInsights(); } },
    { label: "Probe Syzygy tablebase", hint: "Exact endgame", action: async () => { await activateTab(document.querySelector('[data-tab="engine"]')); await probeTablebase(); } },
    { label: "Compare external UCI engine", hint: "Engine comparison", action: async () => { await activateTab(document.querySelector('[data-tab="engine"]')); await compareExternalEngine(); } },
    { label: "Export annotated PGN", hint: "Analysis report", action: exportAnnotatedPgn },
    { label: "Export HTML performance report", hint: "Library report", action: exportHtmlReport },
    { label: "Start repertoire trainer", hint: "Opening flashcards", action: startRepertoireTraining },
    { label: "Study lesson flashcards", hint: "Spaced repetition", action: studyDueFlashcards },
    { label: "Import board image", hint: "Experimental local vision", action: () => $("boardImageInput").click() },
    { label: "Export encrypted sync file", hint: "AES-GCM workspace", action: exportEncryptedSync },
    { label: lanInfo.running ? "Stop LAN multiplayer" : "Start LAN multiplayer", hint: "Private network", action: toggleLanSharing },
    { label: "Install data-only plugin", hint: "Local extension", action: () => $("pluginInput").click() },
  ];
  const pluginCommands = pluginManifests
    .filter((plugin) => plugin.enabled && plugin.kind === "commands")
    .flatMap((plugin) => (plugin.items || []).map((item) => ({
      label: item.label,
      hint: `Plugin · ${plugin.name}`,
      action: () => runSafePluginAction(item.action),
    })));
  return [...builtins, ...pluginCommands];
}

async function runSafePluginAction(action) {
  if (action === "open-analysis") await activateTab(document.querySelector('[data-tab="engine"]'));
  else if (action === "open-training") await activateTab(document.querySelector('[data-tab="train"]'));
  else if (action === "start-engine") await engineMove();
  else if (action === "start-repertoire-training") startRepertoireTraining();
  else if (action === "export-report") await exportHtmlReport();
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
  const previousPanel = previousTab ? $(`${previousTab}Tab`) : null;
  if (previousPanel) tabScrollPositions.set(previousTab, previousPanel.scrollTop);
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
  const nextPanel = nextTab ? $(`${nextTab}Tab`) : null;
  if (nextPanel) {
    requestAnimationFrame(() => {
      nextPanel.scrollTop = tabScrollPositions.get(nextTab) || 0;
    });
  }
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
  if (nextTab === "position") void refreshOpeningBook();
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
$("startToolsBtn").addEventListener("click", () => enterWorkbench("tools", false));
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
$("variationPromoteBtn").addEventListener("click", promoteVariationBranch);
$("variationDeleteBtn").addEventListener("click", deleteVariationBranch);
$("variationResetBtn").addEventListener("click", resetVariationWorkspace);
$("variationNag").addEventListener("change", () => { saveVariationMetadata(); renderVariationWorkspace(); });
$("variationComment").addEventListener("input", saveVariationMetadata);
$("studyNameInput").addEventListener("change", saveStudyIdentity);
$("studyKindSelect").addEventListener("change", saveStudyIdentity);
$("studyFolderInput").addEventListener("change", saveStudyIdentity);
$("studyTagsInput").addEventListener("change", saveStudyIdentity);
$("studyFavoriteBtn").addEventListener("click", toggleCurrentStudyFavorite);
$("exportStudyBtn").addEventListener("click", () => exportStudyWorkspace());
$("bookmarkPositionBtn").addEventListener("click", bookmarkCurrentPosition);
$("clearAnnotationsBtn").addEventListener("click", clearCurrentAnnotations);
$("trainerStartBtn").addEventListener("click", startTrainer);
$("trainerFocusBtn").addEventListener("click", () => startTrainer($("trainerFocusSelect").value));
$("trainerHintBtn").addEventListener("click", trainerHint);
$("trainerExitBtn").addEventListener("click", exitTrainer);
$("trainerNextBtn").addEventListener("click", nextTrainerItem);
$("clearTrainerBtn").addEventListener("click", clearTrainer);
$("startEndgameBtn").addEventListener("click", startEndgameDrill);
$("suggestPuzzleMoveBtn").addEventListener("click", suggestPuzzleMove);
$("savePuzzleBtn").addEventListener("click", saveCustomPuzzle);
$("coordinateDrillBtn").addEventListener("click", toggleCoordinateDrill);
$("visionModeSelect").addEventListener("change", (event) => updateDisplay({ visionMode: event.target.value }));
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
$("recentAnalyzedOnly").addEventListener("change", renderRecentGames);
$("recentResultFilter").addEventListener("change", renderRecentGames);
$("recentSort").addEventListener("change", renderRecentGames);
$("studyLibrarySearch").addEventListener("input", renderStudyLibrary);
$("studyKindFilter").addEventListener("change", renderStudyLibrary);
$("studySort").addEventListener("change", renderStudyLibrary);
$("importStudyBtn").addEventListener("click", () => $("importStudyInput").click());
$("importStudyInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    assertBrowserFileSize(file, MAX_STUDY_BYTES, "Study");
    await importStudyFile(file);
  } catch (error) {
    setStatus(error.message, "error");
  }
});
$("newStudyFromPositionBtn").addEventListener("click", async () => {
  if (launcherVisible()) await enterWorkbench("engine", false);
  else await activateTab(document.querySelector('[data-tab="engine"]'));
  await startVariationWorkspace();
});
$("bulkPgnBtn").addEventListener("click", () => $("bulkPgnInput").click());
$("bulkPgnInput").addEventListener("change", async (event) => {
  const files = event.target.files;
  event.target.value = "";
  try {
    await importPgnCollectionFiles(files);
  } catch (error) {
    setStatus(error.message, "error");
  }
});
$("analyzeLibraryBtn").addEventListener("click", runLibraryAnalysisQueue);
$("cancelQueueBtn").addEventListener("click", () => {
  analysisQueueCancel = true;
  for (const job of workstationJobs.values()) {
    if (job.kind === "analyze-pgn" && job.status === "running") void api("/api/jobs/cancel", {id:job.id}).catch(error=>setStatus(error.message,"error"));
  }
});
$("searchPositionBtn").addEventListener("click", renderPositionSearch);
$("searchSimilarGamesBtn").addEventListener("click", searchSimilarGames);
$("openingDatabaseImportBtn").addEventListener("click", () => $("openingDatabaseInput").click());
$("openingDatabaseInput").addEventListener("change", async (event) => {
  const files = event.target.files;
  event.target.value = "";
  try {
    await importOpeningDatabaseFiles(files);
  } catch (error) {
    setStatus(error.message, "error");
  }
});
$("openingDatabaseSearchBtn").addEventListener("click", searchOpeningDatabase);
$("openingDatabaseExplorerBtn").addEventListener("click", exploreOpeningDatabase);
$("openingDatabaseSearch").addEventListener("keydown", (event) => {
  if (event.key === "Enter") searchOpeningDatabase();
});
$("refreshRepertoireGapsBtn").addEventListener("click", renderRepertoireGaps);
$("refreshPrepBtn").addEventListener("click", () => { renderOpeningPrepReport(); renderPlayerProfile(); });
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
$("boardImageImportBtn").addEventListener("click", () => $("boardImageInput").click());
$("boardImageInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file) await importBoardImage(file);
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
    "Changing game mode starts a new game and replaces the current one. Save or export a copy first if you want to keep it.",
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
$("engineStrengthSelect").addEventListener("change", applyEngineStrength);
$("applyEngineConfigBtn").addEventListener("click", applyEngineConfig);
$("saveEnginePresetBtn").addEventListener("click", saveCurrentEnginePreset);
$("enginePresetSelect").addEventListener("change", applySavedEnginePreset);
$("startTournamentBtn").addEventListener("click", startTournament);
$("stopTournamentBtn").addEventListener("click", () => stopTournament(false));
$("variantSelect").addEventListener("change", () => {
  const chess960 = $("variantSelect").value === "chess960";
  $("chess960Controls").hidden = !chess960;
  $("variantValue").textContent = chess960 ? "Chess960" : "Standard";
});
$("randomChess960Btn").addEventListener("click", () => {
  $("chess960Position").value = String(Math.floor(Math.random() * 960));
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
  $("whiteBaseInput").value = String(Number((baseMs / 60_000).toFixed(2)));
  $("blackBaseInput").value = String(Number((baseMs / 60_000).toFixed(2)));
});
$("baseTimeInput").addEventListener("input", () => {
  const { baseMs, incrementMs } = selectedTimeControl();
  $("timeSummary").textContent = formatTimeControl(baseMs, incrementMs);
});
$("incrementInput").addEventListener("input", () => {
  const { baseMs, incrementMs } = selectedTimeControl();
  $("timeSummary").textContent = formatTimeControl(baseMs, incrementMs);
});
for (const id of ["clockModeSelect", "delayInput", "whiteBaseInput", "blackBaseInput", "stageMovesInput", "stageAddInput"]) {
  $(id).addEventListener("input", () => {
    const control = selectedTimeControl();
    const base = formatTimeControl(control.baseMs, control.incrementMs);
    const mode = control.clockMode === "increment" ? "" : ` · ${capitalize(control.clockMode)}`;
    const asymmetric = control.whiteMs !== control.blackMs ? " · asymmetric" : "";
    $("timeSummary").textContent = `${base}${mode}${asymmetric}`;
  });
}
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
$("sidebarWidthInput").addEventListener("input", (event) => updateDisplay({ sidebarWidth: Number(event.target.value) }));
$("coordsToggle").addEventListener("change", (event) => updateDisplay({ coords: event.target.checked }));
$("targetsToggle").addEventListener("change", (event) => updateDisplay({ targets: event.target.checked }));
$("lastMoveToggle").addEventListener("change", (event) => updateDisplay({ lastMove: event.target.checked }));
$("autoOrientToggle").addEventListener("change", (event) => {
  updateDisplay({ autoOrient: event.target.checked });
  orientForHuman();
  if (state) renderBoard();
});
$("soundToggle").addEventListener("change", (event) => updateDisplay({ sound: event.target.checked }));
$("zenToggle").addEventListener("change", (event) => updateDisplay({ zen: event.target.checked }));
$("highContrastToggle").addEventListener("change", (event) => updateDisplay({ highContrast: event.target.checked }));
$("largeTextToggle").addEventListener("change", (event) => updateDisplay({ largeText: event.target.checked }));
$("zenExitBtn").addEventListener("click", () => updateDisplay({ zen: false }));
$("analysisPresetSelect").addEventListener("change", (event) => applyAnalysisPreset(event.target.value));
$("clearAnalysisCacheBtn").addEventListener("click", () => {
  positionAnalysisCache.clear();
  savePositionAnalysisCache();
  multiPvData = null;
  renderMultiPvPanel();
  setStatus("Persistent position-analysis cache cleared.", "success");
});
$("refreshInsightsBtn").addEventListener("click", refreshPositionInsights);
$("threatMapToggle").addEventListener("change", () => { refreshPositionInsights(); renderBoard(); });
$("heatMapToggle").addEventListener("change", () => renderBoard());
$("probeTablebaseBtn").addEventListener("click", probeTablebase);
$("chooseExternalEngineBtn").addEventListener("click", chooseExternalEngine);
$("saveExternalEngineBtn").addEventListener("click", saveExternalEnginePath);
$("externalEngineSelect").addEventListener("change", selectExternalEngine);
$("compareExternalEngineBtn").addEventListener("click", compareExternalEngine);
$("exportAnnotatedPgnBtn").addEventListener("click", exportAnnotatedPgn);
$("exportHtmlReportBtn").addEventListener("click", exportHtmlReport);
$("startRepertoireTrainerBtn").addEventListener("click", startRepertoireTraining);
$("addFlashcardBtn").addEventListener("click", () => addCurrentFlashcard().catch((error) => setStatus(error.message, "error")));
$("saveLessonBtn").addEventListener("click", saveLesson);
$("studyFlashcardsBtn").addEventListener("click", studyDueFlashcards);
$("calibrateEngineBtn").addEventListener("click", runMeasuredCalibration);
$("buildRepertoireBtn").addEventListener("click", () => buildAutomaticRepertoire().catch((error) => setStatus(error.message, "error")));
$("generateLibraryPuzzlesBtn").addEventListener("click", () => generateLibraryPuzzles().catch((error) => setStatus(error.message, "error")));
$("saveSessionGoalsBtn").addEventListener("click", saveSessionGoalTargets);
$("reviewNextLossBtn").addEventListener("click", () => reviewNextLoss().catch((error) => setStatus(error.message, "error")));
$("refreshAlternativesBtn").addEventListener("click", () => refreshMoveAlternatives().catch((error) => setStatus(error.message, "error")));
$("refreshOpeningBookBtn").addEventListener("click", refreshOpeningBook);
$("addOpeningBookMoveBtn").addEventListener("click", () => addCurrentOpeningBookMove().catch((error) => setStatus(error.message, "error")));
$("importPolyglotBtn").addEventListener("click", () => importPolyglotBook().catch((error) => setStatus(error.message, "error")));
$("backupWorkspaceBtn").addEventListener("click", backupWorkspace);
$("restoreWorkspaceBtn").addEventListener("click", restoreWorkspace);
$("restoreWorkspaceInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    assertBrowserFileSize(file, /\.zip$/i.test(file.name) ? 1024 * 1024 * 1024 : MAX_BACKUP_BYTES, "Workspace backup");
    if (/\.zip$/i.test(file.name)) await restoreWorkspaceBundle(file);
    else await restoreWorkspaceText(await file.text());
  } catch (error) {
    setStatus(error.message, "error");
  }
});
$("copyShareBtn").addEventListener("click", copyShareText);
$("shareImageBtn").addEventListener("click", saveShareImage);
$("exportEncryptedSyncBtn").addEventListener("click", exportEncryptedSync);
$("importEncryptedSyncBtn").addEventListener("click", () => $("encryptedSyncInput").click());
$("encryptedSyncInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file) await importEncryptedSyncFile(file);
});
$("toggleLanBtn").addEventListener("click", toggleLanSharing);
$("copyLanLinkBtn").addEventListener("click", () => copyLanLink().catch((error) => setStatus(error.message, "error")));
$("installPluginBtn").addEventListener("click", () => $("pluginInput").click());
$("pluginInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file) await installPluginFile(file);
});
$("showOnboardingBtn").addEventListener("click", () => showOnboarding(true));
$("onboardingCloseBtn").addEventListener("click", closeOnboarding);
$("onboardingPrevBtn").addEventListener("click", () => {
  onboardingStep = Math.max(0, onboardingStep - 1);
  renderOnboarding();
});
$("onboardingNextBtn").addEventListener("click", () => {
  if (onboardingStep >= ONBOARDING_STEPS.length - 1) {
    closeOnboarding();
    return;
  }
  onboardingStep += 1;
  renderOnboarding();
});
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
  if (event.defaultPrevented || document.getElementById("databaseWorkbench")?.open) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (launcherVisible()) return;
    openCommandPalette();
    return;
  }
  if (launcherVisible()) return;
  if (event.altKey && /^[1-6]$/.test(event.key)) {
    event.preventDefault();
    const target = tabButtons[Number(event.key) - 1];
    if (target) activateTab(target, true);
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
  } else if (key === "z") {
    updateDisplay({ zen: !display.zen });
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
  desktop.onOpenDocument?.((payload) => {
    handleNativeDocument(payload).catch((error) => setStatus(error.message, "error"));
  });
}

async function handleNativeDocument(payload) {
  if (!payload || typeof payload.text !== "string") return;
  if (payload.kind === "bundle") {
    await restoreWorkspaceText(payload.text);
    return;
  }
  if (payload.kind === "fen") {
    $("fenInput").value = payload.text.trim();
    await loadFenValue(payload.text.trim());
    return;
  }
  if (payload.kind === "pgn") {
    try {
      const parsed = await api("/api/parse-pgn-batch", { pgn: payload.text, max_games: MAX_LIBRARY_GAMES });
      if (Number(parsed.count || 0) > 1) {
        const added = await importPgnCollectionText(payload.text, payload.name || "Native PGN");
        if (launcherVisible()) await enterWorkbench("position", false);
        setStatus(`Imported ${added} games from ${payload.name || "PGN collection"}.`, "success");
        return;
      }
    } catch (_) {
      // Let the ordinary PGN loader provide the detailed parse error below.
    }
    await loadPgnText(payload.text);
  }
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
  } else if (command === "zen") {
    updateDisplay({ zen: !display.zen });
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

bindWorkstationWorkflows();
applyDisplaySettings(false);
orientForHuman();
const storageReady = hydrateDesktopPreferences().then(hydrateDurableMetadata);
api("/api/state").then(async (value) => {
  await storageReady;
  setState(value);
  if (!state.game_over && !state.paused) {
    setState(await api("/api/pause", { paused: true }));
    homeAutoPaused = true;
  }
  previousHumanSide = $("humanSide").value;
  syncTimeControlsFromState();
  render();
  void refreshOpeningDatabaseStatus();
  void recoverWorkstationJobs();
  setLauncherVisible(true);
  setEngineStatus("Engine ready");
  setTimeout(() => showOnboarding(false), 250);
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
