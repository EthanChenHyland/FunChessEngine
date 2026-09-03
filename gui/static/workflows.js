// Long-running workstation workflows. Game and board state remain in app.js.
const workstationJobs = new Map();
let advancedTournamentResult = null;
let developerResult = null;
const MAX_TOURNAMENT_PARTICIPANTS = 12;

function reportRow(title, detail) {
  const row = document.createElement('div');
  row.className = 'prep-row';
  const heading = document.createElement('strong'); heading.textContent = title;
  const text = document.createElement('span'); text.textContent = detail;
  row.append(heading, text);
  return row;
}

function renderJobStatus() {
  for (const targetId of ['backgroundJobs', 'jobHistory']) {
    const target = $(targetId);
    if (!target) continue;
    target.replaceChildren();
    const history = targetId === 'jobHistory';
    const jobs = [...workstationJobs.values()].reverse().filter(job => history || ['running', 'connection lost'].includes(job.status));
    if (history && !jobs.length) target.append(reportRow('No recent jobs', 'Run a tournament, import a reference PGN, or try an engine experiment.'));
    for (const job of jobs) {
      const progress = job.progress || {};
      const count = progress.total ? `${progress.completed || 0}/${progress.total}` : '';
      const started = job.started_at ? new Date(job.started_at * 1000).toLocaleString() : '';
      const detail = [job.status, count, history ? started : '', job.error || progress.message, job.persistence_error, job.history_note].filter(Boolean).join(' · ');
      const row = reportRow(job.kind, detail);
      row.classList.add('job-row');
      const actions = document.createElement('div'); actions.className = 'job-actions';
      row.append(actions);
      const button = (label, callback) => {
        const control = document.createElement('button');
        control.className = 'secondary compact'; control.textContent = label;
        control.addEventListener('click', async () => {
          control.disabled = true;
          try { await callback(); }
          catch (error) { setStatus(error.message, 'error'); }
          finally { control.disabled = false; }
        });
        actions.append(control);
      };
      if (job.status === 'running') {
        button('Cancel', async () => {
          if (job.cancel) job.cancel();
          else await api('/api/jobs/cancel', {id:job.id});
          setStatus('Cancellation requested. Completed batches and partial results are retained.');
        });
      }
      const local = job.id.startsWith('upload-');
      const available = job.result || job.has_result || progress.partial || job.has_partial;
      if (history && available && job.status !== 'running') {
        button(job.result || job.has_result ? 'Open result' : 'Open partial result', async () => {
          const current = await api('/api/jobs/status', {id:job.id});
          workstationJobs.set(job.id, current);
          await showRecoveredJob(current);
          renderJobStatus();
        });
        button('Export JSON…', async () => {
          const current = await api('/api/jobs/status', {id:job.id});
          await exportJson(current, `FunChessEngine-${job.kind}-${job.id.slice(0,8)}.json`);
        });
      }
      if (!local && ['running', 'connection lost'].includes(job.status)) {
        button('Check status', async () => {
          const current = await api('/api/jobs/status', {id:job.id});
          workstationJobs.set(job.id, current);
          renderJobStatus();
        });
      }
      if (history && job.status !== 'running') {
        button('Dismiss', async () => {
          if (!local) await api('/api/jobs/dismiss', {id:job.id});
          workstationJobs.delete(job.id); renderJobStatus();
        });
      }
      target.append(row);
    }
  }
}

function attachWorkstationJobId(result, jobId) {
  if (result && typeof result === 'object') {
    Object.defineProperty(result, '_workstationJobId', {value:jobId, enumerable:false, configurable:true});
  }
  return result;
}

async function revealWorkflow(id, tab) {
  if (launcherVisible()) await enterWorkbench(tab, false);
  else await activateTab(document.querySelector(`[data-tab="${tab}"]`));
  const target = $(id);
  for (let parent=target?.parentElement; parent; parent=parent.parentElement) {
    if (parent.tagName === 'DETAILS') parent.open = true;
  }
  target?.scrollIntoView({block:'nearest'});
}

async function showRecoveredJob(current) {
  const result = attachWorkstationJobId(current.result || current.progress?.partial, current.result ? current.id : `${current.id}-partial`);
  if (!result) return;
  if (current.kind === 'tournament') {
    showTournamentResult(result);
    saveWorkstationResult('tournament', result);
    await revealWorkflow("advancedTournamentStandings", "tools");
    return;
  }
  if (current.kind === 'calibration' && current.result) {
    if (!calibrationHistory.some(row => row.job_id === current.id)) {
      const engines = result.results?.[0]?.engines || [];
      const opponent = engines.find(engine => engine?.name && engine.name !== 'FunChessEngine');
      calibrationHistory.unshift({...result, engine_name:opponent?.name || 'External engine', job_id:current.id, created_at:new Date().toISOString()});
      saveCalibrationHistory();
    }
    renderCalibrationEngines();
    await revealWorkflow("calibrationResult", "train");
    return;
  }
  if (current.kind === 'reference-import') {
    if (typeof refreshOpeningDatabaseStatus === 'function') await refreshOpeningDatabaseStatus();
    setStatus(`${current.result ? 'Reference import' : 'Partial import'} recovered: ${result.imported ?? 0} games indexed.`, 'success');
    return;
  }
  showDeveloperResult(result);
  saveWorkstationResult(current.kind,result);
  await revealWorkflow("developerResults", "tools");
}

async function recoverWorkstationJobs(reportErrors = false) {
  try {
    const {jobs}=await api('/api/jobs/status',{});
    const retained = new Set((jobs || []).map(job => job.id));
    for (const id of workstationJobs.keys()) {
      if (!id.startsWith('upload-') && !retained.has(id)) workstationJobs.delete(id);
    }
    for (const job of jobs || []) workstationJobs.set(job.id, job);
    renderJobStatus();
  } catch (error) { if (reportErrors) throw error; }
}

async function runBackgroundJob(kind, payload, onProgress = null) {
  if ([...workstationJobs.values()].some(job => job.kind === kind && job.status === 'running')) {
    throw new Error(`A ${kind} job is already running.`);
  }
  for (const [id, old] of workstationJobs) {
    if (workstationJobs.size < 12) break;
    if (old.status !== 'running') workstationJobs.delete(id);
  }
  let job = await api('/api/jobs', {kind, payload});
  workstationJobs.set(job.id, job);
  while (job.status === 'running') {
    renderJobStatus();
    if (onProgress) onProgress(job.progress || {});
    await new Promise(resolve => setTimeout(resolve, 600));
    try { job = await api('/api/jobs/status', {id:job.id}); }
    catch (error) {
      job.status='connection lost'; job.error=error.message;
      renderJobStatus();
      throw error;
    }
    workstationJobs.set(job.id, job);
  }
  renderJobStatus();
  if (onProgress) onProgress(job.progress || {});
  if (job.status !== 'completed') throw new Error(job.error || `${kind} ${job.status}.`);
  return attachWorkstationJobId(job.result, job.id);
}

function renderAdvancedTournament() {
  const target = $('advancedTournamentPlayers');
  if (!target) return;
  const available = new Set(externalEngines.map(engine => engine.path));
  const selected = new Set(
    [...target.querySelectorAll('input:checked')]
      .map(el => el.value)
      .filter(value => available.has(value)),
  );
  target.replaceChildren();
  externalEngines.forEach(engine => {
    const label = document.createElement('label'); label.className = 'analysis-auto';
    const check = document.createElement('input'); check.type = 'checkbox';
    check.value = engine.path; check.checked = selected.has(engine.path);
    check.disabled = !check.checked && selected.size >= MAX_TOURNAMENT_PARTICIPANTS - 1;
    check.addEventListener('change', () => {
      const checked = target.querySelectorAll('input:checked').length;
      if (checked > MAX_TOURNAMENT_PARTICIPANTS - 1) {
        check.checked = false;
        setStatus(`A tournament supports at most ${MAX_TOURNAMENT_PARTICIPANTS} players including FunChessEngine.`, 'error');
      }
      renderAdvancedTournament();
    });
    const text = document.createElement('span'); text.textContent = engine.name || engine.path;
    label.append(check, text); target.append(label);
  });
  if (!externalEngines.length) target.append(reportRow('No opponents saved', 'Add an external engine in Analysis to include it here.'));
}

function showTournamentResult(result) {
  advancedTournamentResult = result;
  const target = $('advancedTournamentStandings'); target.replaceChildren();
  target.append(reportRow(result.complete ? 'Completed' : 'Partial results', `${(result.games || []).length} games`));
  for (const row of result.standings || []) {
    const performance = row.performance_elo == null ? '' : ` · perf ~${row.performance_elo}`;
    const interval = Array.isArray(row.score_interval)
      ? ` · 95% score ${(Number(row.score_interval[0]) * 100).toFixed(0)}–${(Number(row.score_interval[1]) * 100).toFixed(0)}%`
      : '';
    target.append(reportRow(row.name, `${row.points} points · ${row.games} games · +${row.wins} =${row.draws} −${row.losses}${row.byes ? ` · ${row.byes} bye(s)` : ''}${performance}${interval}`));
  }
  if (result.rating_note) target.append(reportRow('Rating note', result.rating_note));
  $('exportAdvancedTournamentPgnBtn').disabled = !result.pgn;
}

async function runAdvancedTournament() {
  const selected = [...$('advancedTournamentPlayers').querySelectorAll('input:checked')].map(input => input.value);
  if (!selected.length) throw new Error('Select at least one saved external engine.');
  if (selected.length > MAX_TOURNAMENT_PARTICIPANTS - 1) throw new Error(`Select at most ${MAX_TOURNAMENT_PARTICIPANTS - 1} external engines.`);
  const participants = [{name:'FunChessEngine',kind:'funchess'}, ...externalEngines.filter(e=>selected.includes(e.path)).map(e=>({name:e.name || e.path,kind:'external',executable:e.path}))];
  const payload = {participants, format:$('advancedTournamentFormat').value,
    rounds:Number($('advancedTournamentRounds').value), movetime_ms:Number($('advancedTournamentMoveTime').value),
    color_reversal:$('advancedTournamentColorReverse').checked,
    openings:$('tournamentOpeningSuite').value.split('\n').map(s=>s.trim()).filter(Boolean)};
  let partial = null;
  try {
    const result = await runBackgroundJob('tournament', payload, progress => {
      if (progress.partial) { partial = progress.partial; showTournamentResult(partial); }
    });
    showTournamentResult(result);
    saveWorkstationResult('tournament', result);
    setStatus('Tournament completed. Results and PGN saved locally.', 'success');
  } catch (error) {
    if (partial) saveWorkstationResult('tournament', {...partial, error:error.message});
    throw error;
  }
}

function saveWorkstationResult(kind, result) {
  const jobId = result?._workstationJobId || null;
  if (jobId && regressionHistory.some(record => record.job_id === jobId)) return;
  regressionHistory.unshift({kind, result, ...(jobId ? {job_id:jobId} : {}), created_at:new Date().toISOString()});
  saveRegressionHistory(); renderWorkstationHistory();
}

function renderWorkstationHistory() {
  const target = $('workstationHistory'); if (!target) return;
  target.replaceChildren();
  for (const record of regressionHistory.slice(0, 20)) {
    const row = reportRow(record.kind || 'regression', record.created_at || 'Saved experiment');
    const view = document.createElement('button'); view.className='secondary compact'; view.textContent='View';
    view.addEventListener('click', async () => {
      if (record.kind === 'tournament') {
        showTournamentResult(record.result);
        await revealWorkflow('advancedTournamentStandings','tools');
      } else {
        showDeveloperResult(record.result);
        await revealWorkflow('developerResults','tools');
      }
    });
    const download = document.createElement('button'); download.className='text-button'; download.textContent='Export';
    download.addEventListener('click', () => exportJson(record, `FunChessEngine-${record.kind || 'experiment'}.json`));
    row.append(view, download); target.append(row);
  }
}

function showDeveloperResult(result) {
  developerResult = result;
  $('developerResults').textContent = JSON.stringify(result, null, 2).slice(0, 40000);
  $('exportDeveloperResultBtn').disabled = false;
}

async function runDeveloperTool(kind) {
  let payload = {};
  if (kind === 'regression') {
    const baseline = regressionHistory.find(row=>row.kind==='regression');
    payload = {clock_scale:Number($('regressionClockScale').value), baseline:baseline?.result?.rows};
  } else if (kind === 'selfplay') {
    payload = {games:Number($('selfplayGames').value),clock_ms:Number($('selfplayClock').value)};
  } else if (kind === 'tuner') {
    payload = {parameters:[...$('tunerParameters').querySelectorAll('input:checked')].map(el=>el.value)};
    if (!payload.parameters.length) throw new Error('Select a parameter to explore.');
  }
  const result = await runBackgroundJob(kind,payload);
  showDeveloperResult(result); saveWorkstationResult(kind,result);
  setStatus(`${kind} completed. Results saved locally.`, 'success');
}

async function exportJson(value, filename) {
  await downloadBlob(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}),filename);
}

function renderExternalComparisonHistory() {
  const target=$('externalComparisonHistory'); if (!target) return;
  target.replaceChildren();
  for (const result of externalCompareHistory.slice(0,10)) {
    target.append(reportRow(result.external?.name || 'External engine', `${result.created_at || ''} · ${result.agree ? 'Agreed' : 'Different moves'} · FCE ${result.funchess?.san || '—'} / UCI ${result.external?.san || '—'}`));
  }
}

function bindWorkstationWorkflows() {
  const action = (id, callback) => $(id).addEventListener('click', async () => {
    $(id).disabled=true;
    try { await callback(); } catch(error) { setStatus(error.message,'error'); }
    finally { $(id).disabled=false; }
  });
  action('refreshJobsBtn',()=>recoverWorkstationJobs(true));
  action('runAdvancedTournamentBtn',runAdvancedTournament);
  action('exportAdvancedTournamentPgnBtn',()=>downloadBlob(new Blob([advancedTournamentResult.pgn],{type:'application/x-chess-pgn'}),'FunChessEngine-tournament.pgn'));
  action('runRegressionBtn',()=>runDeveloperTool('regression'));
  action('runSelfplayBtn',()=>runDeveloperTool('selfplay'));
  action('runTunerBtn',()=>runDeveloperTool('tuner'));
  action('exportDeveloperResultBtn',()=>exportJson(developerResult,'FunChessEngine-experiment.json'));
  $('advancedTournamentFormat').addEventListener('change',()=>{
    $('advancedTournamentRounds').disabled=$('advancedTournamentFormat').value!=='swiss';
    $('advancedTournamentColorReverse').disabled=$('advancedTournamentFormat').value==='swiss';
  });
  $('advancedTournamentRounds').disabled=true;
}

async function uploadLocalFile(file) {
  if (!file || !file.size || file.size > 1024 * 1024 * 1024) throw new Error('Choose a file between 1 byte and 1 GB.');
  const {token} = await api('/api/library-upload',{action:'start',name:file.name,size:file.size});
  let cancelled=false;
  const job={id:`upload-${token}`,kind:`Upload ${file.name}`,status:'running',progress:{completed:0,total:file.size},cancel:()=>{cancelled=true;}};
  workstationJobs.set(job.id,job);
  try {
    for (let offset=0;offset<file.size;offset+=1024*1024) {
      if (cancelled) throw new Error('Upload cancelled.');
      const bytes=new Uint8Array(await file.slice(offset,offset+1024*1024).arrayBuffer());
      let binary='';
      for(let i=0;i<bytes.length;i+=32768) binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
      await api('/api/library-upload',{action:'chunk',token,offset,data:btoa(binary)});
      job.progress.completed=offset+bytes.length; renderJobStatus();
    }
    if (cancelled) throw new Error('Upload cancelled.');
    await api('/api/library-upload',{action:'finish',token});
    job.status='completed'; renderJobStatus();
    return token;
  } catch(error) {
    job.status='cancelled'; job.error=error.message; renderJobStatus();
    await api('/api/library-upload',{action:'cancel',token}).catch(()=>{});
    throw error;
  }
}

async function restoreWorkspaceBundle(file) {
  const token=await uploadLocalFile(file);
  try {
    const inspected=await api('/api/workspace-data',{action:'inspect',token});
    validateWorkspaceBackup(inspected.metadata);
    await restoreWorkspaceText(JSON.stringify(inspected.metadata), async()=>{
      const restored=await api('/api/workspace-data',{action:'restore',token});
      if(restored.restored_state) setState(restored.restored_state);
    });
  } finally {
    await api('/api/library-upload',{action:'cancel',token}).catch(()=>{});
  }
}

function validFenText(value) {
  if (typeof value !== 'string' || value.length > 200) return false;
  const fields=value.trim().split(/\s+/);
  if (fields.length!==6) return false;
  const ranks=fields[0].split('/');
  if (ranks.length!==8) return false;
  let whiteKings=0, blackKings=0;
  for (const rank of ranks) {
    let squares=0;
    for (const char of rank) {
      if (/^[1-8]$/.test(char)) squares+=Number(char);
      else if (/^[prnbqkPRNBQK]$/.test(char)) {
        squares+=1;
        if (char==='K') whiteKings+=1;
        if (char==='k') blackKings+=1;
      } else return false;
    }
    if (squares!==8) return false;
  }
  if (whiteKings!==1 || blackKings!==1 || !/^[wb]$/.test(fields[1])) return false;
  if (!/^(?:-|[KQABCDEFGHkqabcdefgh]+)$/.test(fields[2])) return false;
  if (!/^(?:-|[a-h][36])$/.test(fields[3])) return false;
  if (!/^\d+$/.test(fields[4]) || !/^[1-9]\d*$/.test(fields[5])) return false;
  return true;
}

function validateStudyGraph(workspace) {
  if (!workspace || !workspace.nodes || typeof workspace.nodes!=='object' || Array.isArray(workspace.nodes)) throw new Error('Study nodes are invalid.');
  const nodes=workspace.nodes;
  if (Object.keys(nodes).length>500 || !nodes[workspace.root]) throw new Error('Study root or size is invalid.');
  const complete=new Set(), visiting=new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Study contains a cycle.');
    if (complete.has(id)) return;
    const node=nodes[id];
    if (!node || node.id!==id || !Array.isArray(node.children) || !validFenText(node.snapshot?.fen)) throw new Error('Study node or reference is invalid.');
    visiting.add(id);
    for(const child of node.children) {
      if (!Object.hasOwn(nodes,child)) throw new Error('Study has a missing child.');
      const edge=workspace.edges?.[`${id}>${child}`];
      if (edge && !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(edge.move_uci)) throw new Error('Study edge move is invalid.');
      visit(child);
    }
    visiting.delete(id); complete.add(id);
  }
  for(const id of Object.keys(nodes)) visit(id);
  return workspace;
}

function validateBackupCollections(payload) {
  const object=value=>value && typeof value==='object' && !Array.isArray(value);
  const move=value=>typeof value==='string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value);
  const fen=validFenText;
  const array=(key,limit,valid)=>{
    if (payload[key]==null) return;
    if (!Array.isArray(payload[key]) || payload[key].length>limit || payload[key].some(item=>!object(item) || !valid(item))) throw new Error(`Invalid backup collection: ${key}.`);
  };
  let count=0;
  function safeTree(value,depth=0) {
    if (++count>500000 || depth>64) throw new Error('Backup structure is too large or deeply nested.');
    if (value && typeof value==='object') for (const [key,child] of Object.entries(value)) {
      if (['__proto__','prototype','constructor'].includes(key)) throw new Error('Backup contains a reserved object key.');
      safeTree(child,depth+1);
    }
  }
  safeTree(payload);
  array('recent_games',500,item=>Array.isArray(item.moves) && item.moves.length<=1000 && item.moves.every(move));
  array('bookmarks',100,item=>fen(item.fen));
  array('trainer',250,item=>fen(item.fen) && move(item.best_uci));
  array('lessons',100,item=>typeof item.title==='string' && Array.isArray(item.cards) && item.cards.length<=250 && item.cards.every(card=>object(card)&&fen(card.fen)&&move(card.best_uci)));
  array('engine_presets',30,item=>typeof item.name==='string');
  array('external_engines',12,item=>typeof item.path==='string' && (!item.name || typeof item.name==='string'));
  array('regression_history',30,item=>!item.kind || object(item.result));
  if (payload.display!=null && !object(payload.display)) throw new Error('Invalid display settings.');
  if (payload.annotations!=null && !object(payload.annotations)) throw new Error('Invalid annotations.');
  if (payload.studies!=null && !object(payload.studies)) throw new Error('Invalid studies.');
  if (payload.position_cache!=null && (!Array.isArray(payload.position_cache) || payload.position_cache.length>30 || payload.position_cache.some(entry=>!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string'||!object(entry[1])))) throw new Error('Invalid analysis cache.');
  if (payload.current_game!=null && (!object(payload.current_game)||!Array.isArray(payload.current_game.moves)||!payload.current_game.moves.every(move)||!fen(payload.current_game.initial_fen))) throw new Error('Invalid saved live game.');
}
