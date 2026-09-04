"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {metadataStore} = require("../storage");
const {registerMetadataHandlers} = require("../metadata-ipc");

// Headless Linux runners do not provide a usable GPU shared-image context.
app.disableHardwareAcceleration();
const root = path.resolve(__dirname, "..", "..");
const smokeUserData = fs.mkdtempSync(path.join(os.tmpdir(), "funchess-ui-smoke-"));
app.setPath("userData", smokeUserData);
let backend = null;

function pythonCommand() {
  const venv = path.join(root, ".venv", ...(process.platform === "win32" ? ["Scripts","python.exe"] : ["bin","python"]));
  if (fs.existsSync(venv)) return { command: venv, args: [] };
  return { command: "uv", args: ["run", "python"] };
}

function startBackend() {
  return new Promise((resolve, reject) => {
    const python = pythonCommand();
    const child = spawn(
      python.command,
      [...python.args, "-m", "gui.server", "--no-open", "--port", "0"],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"], env:{...process.env,FUNCHESS_DATA_DIR:path.join(smokeUserData,"data")} },
    );
    backend = child;
    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`UI smoke backend timed out.\n${output}`));
    }, 15000);
    const inspect = (chunk) => {
      output = (output + chunk.toString()).slice(-64*1024);
      const match = output.match(/FunChessEngine GUI:\s+(http:\/\/127\.0\.0\.1:\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (!output.includes("FunChessEngine GUI:")) {
        clearTimeout(timeout);
        reject(new Error(`UI smoke backend exited early (${code ?? signal ?? "unknown"}).\n${output}`));
      }
    });
  });
}

async function waitFor(window, expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await window.webContents.executeJavaScript(`Boolean(${expression})`, true);
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function run() {
  const url = await startBackend();
  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload:path.join(root,"desktop","preload.js"),
    },
  });
  registerMetadataHandlers(ipcMain,metadataStore(smokeUserData),(event)=>{
    if(event.sender!==window.webContents || event.senderFrame!==window.webContents.mainFrame) throw new Error('Untrusted test sender');
  });
  await window.loadURL(url);
  await waitFor(window, `document.getElementById("startSessionSummary")?.textContent !== "Loading local board…"`);

  const initial = await window.webContents.executeJavaScript(`({
    launcherVisible: !document.getElementById("startScreen").hidden,
    workspaceHidden: document.getElementById("mainWorkspace").hidden,
    playLabel: document.getElementById("startPlayLabel").textContent,
  })`, true);
  if (!initial.launcherVisible || !initial.workspaceHidden || !initial.playLabel) {
    throw new Error(`Launcher contract failed: ${JSON.stringify(initial)}`);
  }

  await window.webContents.executeJavaScript(`document.getElementById("startPlayBtn").click()`, true);
  await waitFor(
    window,
    `document.getElementById("startScreen").hidden
      && !document.getElementById("mainWorkspace").hidden
      && !busy
      && state
      && !state.paused
      && !homeAutoPaused`,
  );

  const playSetupLayout = await window.webContents.executeJavaScript(`(() => {
    const setup = document.querySelector('.play-setup');
    const controls = [...setup.querySelectorAll(':scope > .section-card')];
    const selects = [...setup.querySelectorAll(':scope > .section-card > select')];
    return {
      label: document.getElementById('playSetupTitle')?.textContent,
      cards: controls.length,
      minSelectHeight: Math.min(...selects.map(element => element.getBoundingClientRect().height)),
      gaps: controls.slice(1).map((element,index) => element.getBoundingClientRect().top-controls[index].getBoundingClientRect().bottom),
    };
  })()`, true);
  if (playSetupLayout.label !== 'Choose how you play' || playSetupLayout.cards !== 3
    || playSetupLayout.minSelectHeight < 40 || playSetupLayout.gaps.some(gap => gap < 8)) {
    throw new Error(`Play setup controls are cramped: ${JSON.stringify(playSetupLayout)}`);
  }

  const stableLayout = await window.webContents.executeJavaScript(`(async () => {
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, width: box.width };
    };
    const baselineBoard = rect(document.querySelector(".board-frame"));
    const baselinePanel = rect(document.querySelector(".side-panel"));
    const tabs = ["positionTabButton", "engineTabButton", "trainTabButton", "displayTabButton", "toolsTabButton", "gameTabButton"];
    const readings = [];
    for (const id of tabs) {
      await activateTab(document.getElementById(id));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      readings.push({ id, board: rect(document.querySelector(".board-frame")), panel: rect(document.querySelector(".side-panel")) });
    }
    return { baselineBoard, baselinePanel, readings };
  })()`, true);
  for (const reading of stableLayout.readings) {
    const boardMoved = Math.abs(reading.board.left - stableLayout.baselineBoard.left) > 0.75
      || Math.abs(reading.board.width - stableLayout.baselineBoard.width) > 0.75;
    const panelMoved = Math.abs(reading.panel.left - stableLayout.baselinePanel.left) > 0.75
      || Math.abs(reading.panel.width - stableLayout.baselinePanel.width) > 0.75;
    if (boardMoved || panelMoved) {
      throw new Error(`Sidebar tab changed workspace geometry at ${reading.id}: ${JSON.stringify(stableLayout)}`);
    }
  }

  await window.webContents.executeJavaScript(`document.getElementById("humanSide").value = "both"`, true);
  const fenLoaded = await window.webContents.executeJavaScript(
    `(async () => loadFenValue("8/P7/8/8/8/8/7k/4K3 w - - 0 1"))()`,
    true,
  );
  if (!fenLoaded) throw new Error("FEN setup action did not complete successfully.");
  await waitFor(
    window,
    `!busy && state?.board?.a7 === "P" && document.querySelector('[data-square="a7"] .piece')?.dataset.piece === "P"`,
  );
  await window.webContents.executeJavaScript(`
    document.querySelector('[data-square="a7"]').click();
    document.querySelector('[data-square="a8"]').click();
  `, true);
  await waitFor(window, `document.getElementById("promotionDialog")?.open`);
  await window.webContents.executeJavaScript(`document.querySelector('[data-promotion="n"]').click()`, true);
  await waitFor(window, `!busy && state?.board?.a8 === "N"`);

  const liveFen = await window.webContents.executeJavaScript(
    `fetch("/api/state").then(r => r.json()).then(s => s.fen)`,
    true,
  );
  await window.webContents.executeJavaScript(`activateTab(document.getElementById("engineTabButton"))`, true);
  await waitFor(window, `document.getElementById("engineTab")?.classList.contains("active")`);
  await window.webContents.executeJavaScript(`jumpReview(0)`, true);
  const afterReviewFen = await window.webContents.executeJavaScript(
    `fetch("/api/state").then(r => r.json()).then(s => s.fen)`,
    true,
  );
  if (afterReviewFen !== liveFen) {
    throw new Error(`Review navigation mutated the live game: ${liveFen} -> ${afterReviewFen}`);
  }
  await window.webContents.executeJavaScript(`exitReviewMode(false)`, true);
  await window.webContents.executeJavaScript(`document.getElementById("gameTabButton").click()`, true);
  await window.webContents.executeJavaScript(`document.getElementById("undoBtn").click()`, true);
  await waitFor(window, `fetch("/api/state").then(r => r.json()).then(s => s.board.a7 === "P" && !s.board.a8)`);

  await window.webContents.executeJavaScript(`document.getElementById("homeBtn").click()`, true);
  await waitFor(window, `!document.getElementById("startScreen").hidden`);
  await waitFor(window, `fetch("/api/state").then(r => r.json()).then(s => s.paused)`);

  await window.webContents.executeJavaScript(`document.getElementById("startAnalysisBtn").click()`, true);
  await waitFor(window, `document.getElementById("engineTab")?.classList.contains("active")`);
  const analysis = await window.webContents.executeJavaScript(`({
    launcherHidden: document.getElementById("startScreen").hidden,
    workspaceVisible: !document.getElementById("mainWorkspace").hidden,
    analysisActive: document.getElementById("engineTab").classList.contains("active"),
    sliderDisabled: document.getElementById("reviewPlySlider").disabled,
  })`, true);
  if (!analysis.launcherHidden || !analysis.workspaceVisible || !analysis.analysisActive) {
    throw new Error(`Analysis launcher route failed: ${JSON.stringify(analysis)}`);
  }

  // Execute real renderer save functions, then hydrate through the real preload after reload.
  await window.webContents.executeJavaScript(`(async()=>{
    calibrationHistory=[{estimated_elo:1600,games:4,opponent_elo:1500,score:.5,elo_interval:[1400,1800]}];
    saveCalibrationHistory();
    pluginManifests=[{id:'smoke.safe',name:'<img id="injected-plugin">',version:'1',kind:'commands',items:[],enabled:false}];
    savePluginManifests(); renderPlugins();
    if(document.getElementById('injected-plugin')) throw new Error('Plugin HTML injection');
    await Promise.all([...durableWriteChains.values()]);
  })()`,true);
  window.webContents.reload();
  await new Promise(resolve=>window.webContents.once('did-finish-load',resolve));
  await waitFor(window, `durableMetadataHydrated && state && calibrationHistory.length===1`);
  const result=await window.webContents.executeJavaScript(`(async()=>{
    if(calibrationHistory[0].estimated_elo!==1600) throw new Error('Lost calibration after reload');
    if(!engineLabDesktop.readMetadata) throw new Error('Missing real preload bridge');
    const record=await engineLabDesktop.readMetadata(CALIBRATION_HISTORY_KEY);
    if(!record.found) throw new Error('Missing desktop mirror');
    await runDeveloperTool('regression');
    if(!developerResult.rows?.length) throw new Error('Developer regression did not finish');
    return developerResult.rows.length;
  })()`,true);
  if(!result) throw new Error('No developer result');
  // Simulate an occupied preferred port: a second backend produces a different browser origin.
  const oldBackend=backend;
  const secondUrl=await startBackend();
  oldBackend.kill('SIGTERM');
  await window.loadURL(secondUrl);
  await waitFor(window, `durableMetadataHydrated && state && calibrationHistory.length===1`);
  await window.webContents.executeJavaScript(`(async()=>{
    if(calibrationHistory[0].estimated_elo!==1600 || !regressionHistory.length) throw new Error('Lost desktop data on port change');
    await recoverWorkstationJobs(true);
    const jobs=await api('/api/jobs/status',{});
    const completed=jobs.jobs.find(job=>job.kind==='regression' && job.status==='completed');
    if(!completed?.has_result) throw new Error('Lost backend job result after restart');
    await showRecoveredJob(await api('/api/jobs/status',{id:completed.id}));
    if(!document.getElementById('toolsTab').classList.contains('active')) throw new Error('Job history opens wrong tab');
    if(!document.getElementById('jobHistory').textContent.includes('Open result')) throw new Error('Job history has no result action');
    await api('/api/jobs/dismiss',{id:completed.id});
    await recoverWorkstationJobs(true);
    if(workstationJobs.has(completed.id)) throw new Error('Dismissed job is still visible');
    const rootSnapshot=await api('/api/state');
    const childSnapshot=await api('/api/variation-move',{fen:rootSnapshot.fen,move:'e2e4'});
    savedVariationWorkspaces={audit:{root:'r',nodes:{
      r:{id:'r',children:['c'],snapshot:rootSnapshot},
      c:{id:'c',children:[],snapshot:childSnapshot},
    },edges:{'r>c':{move_uci:'e2e4'}}}};
    const bundle=await api('/api/workspace-data',{action:'backup',metadata:workspaceBackupPayload(),include_reference:true});
    const response=await fetch('/api/workspace-download?token='+bundle.token);
    const bytes=new Uint8Array(await response.arrayBuffer());
    if(bytes[0]!==80 || bytes[1]!==75) throw new Error('Backup was not a ZIP');
    const consumed=await fetch('/api/workspace-download?token='+bundle.token);
    if(consumed.status!==404) throw new Error('Completed backup download retained its transfer slot');
    const roundtrip=validateWorkspaceBackup(workspaceBackupPayload());
    if(!roundtrip.calibration_history.length) throw new Error('Backup omitted history');
    await showRecoveredJob({id:'smoke-tournament',kind:'tournament',result:{complete:true,games:[],standings:[],pgn:'*'}});
    if(!document.getElementById('startScreen').hidden || !document.getElementById('toolsTab').classList.contains('active')) throw new Error('Recovered tournament remains hidden');
    if(!document.getElementById('advancedTournamentStandings').closest('details').open) throw new Error('Recovered standings are collapsed');
    await showRecoveredJob({id:'smoke-calibration',kind:'calibration',result:{results:[],estimated_elo:1600,games:4,opponent_elo:1500,score:.5,elo_interval:[1400,1800]}});
    if(!document.getElementById('trainTab').classList.contains('active')) throw new Error('Recovered calibration opens wrong tab');
  })()`,true);
  if (process.env.FUNCHESS_SMOKE_SCREENSHOT) {
    await window.webContents.executeJavaScript(`(async()=>{closeOnboarding(); await revealWorkflow('jobHistory','tools'); window.scrollTo(0,0); document.getElementById('toolsTab').scrollTop=0;})()`,true);
    await new Promise(resolve=>setTimeout(resolve,100));
    fs.writeFileSync(process.env.FUNCHESS_SMOKE_SCREENSHOT,(await window.webContents.capturePage()).toPNG());
    window.setSize(390,844);
    await new Promise(resolve=>setTimeout(resolve,100));
    await window.webContents.executeJavaScript(`document.getElementById('toolsTabButton').scrollIntoView({block:'start'})`,true);
    await new Promise(resolve=>setTimeout(resolve,100));
    const overflow=await window.webContents.executeJavaScript(`document.documentElement.scrollWidth > window.innerWidth`);
    if(overflow) throw new Error('Tools workspace overflows mobile viewport');
    fs.writeFileSync(process.env.FUNCHESS_SMOKE_SCREENSHOT.replace(/\.png$/, '-mobile.png'),(await window.webContents.capturePage()).toPNG());
  }
  await require("./database-smoke.cjs")(window,waitFor);
  window.destroy();
  console.log("Electron UI smoke OK: preload, history reload, port migration, regression job, persistent job history, Tools, database browser, backup");
}

app.whenReady().then(async () => {
  try {
    await run();
    app.exit(0);
  } catch (error) {
    console.error(error?.stack || error);
    app.exit(1);
  } finally {
    if (backend && !backend.killed) backend.kill("SIGTERM");
    try {
      fs.rmSync(smokeUserData, { recursive: true, force: true });
    } catch (_) {
      // Temporary browser-profile cleanup is best effort.
    }
  }
});

app.on("window-all-closed", () => {});
