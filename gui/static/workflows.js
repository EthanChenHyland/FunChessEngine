// Long-running workstation workflows. Game and board state remain in app.js.
const workstationJobs = new Map();
let advancedTournamentResult = null;
let developerResult = null;

function reportRow(title, detail) {
  const row = document.createElement('div');
  row.className = 'prep-row';
  const heading = document.createElement('strong'); heading.textContent = title;
  const text = document.createElement('span'); text.textContent = detail;
  row.append(heading, text);
  return row;
}

function renderJobStatus() {
  const target = $('backgroundJobs');
  if (!target) return;
  target.replaceChildren();
  for (const job of workstationJobs.values()) {
    const progress = job.progress || {};
    const count = progress.total ? `${progress.completed || 0}/${progress.total}` : '';
    const row = reportRow(job.kind, `${job.status} ${count} ${job.error || progress.message || ''}`);
    if (job.status === 'running') {
      const cancel = document.createElement('button');
      cancel.className = 'secondary compact'; cancel.textContent = 'Cancel';
      cancel.addEventListener('click', async () => {
        cancel.disabled = true;
        try { if (job.cancel) job.cancel(); else await api('/api/jobs/cancel', {id:job.id}); }
        catch (error) { cancel.disabled = false; setStatus(error.message, 'error'); }
      });
      row.append(cancel);
    }
    if (job.recover) {
      const recover=document.createElement('button'); recover.className='secondary compact';
      recover.textContent='Check status / recover result';
      recover.addEventListener('click',async()=>{
        try {
          const current=await api('/api/jobs/status',{id:job.id});
          workstationJobs.set(job.id,{...current,recover:true});
          if (current.result) {
            showDeveloperResult(current.result);
            saveWorkstationResult(current.kind,current.result);
            workstationJobs.get(job.id).recover=false;
            await activateTab(document.querySelector('[data-tab="engine"]'));
          }
          renderJobStatus();
        } catch(error) { setStatus(error.message,'error'); }
      });
      row.append(recover);
    }
    target.append(row);
  }
}

async function recoverWorkstationJobs() {
  try {
    const {jobs}=await api('/api/jobs/status',{});
    for(const job of jobs || []) workstationJobs.set(job.id,{...job,recover:true});
    renderJobStatus();
  } catch (_) { /* Reconnecting the backend will retry this read-only discovery. */ }
}

async function runBackgroundJob(kind, payload, onProgress = null) {
  if ([...workstationJobs.values()].some(job => job.kind === kind && job.status === 'running')) {
    throw new Error(`A ${kind} job is already running.`);
  }
  for (const [id, old] of workstationJobs) { if (old.status !== 'running') workstationJobs.delete(id); }
  let job = await api('/api/jobs', {kind, payload});
  workstationJobs.set(job.id, job);
  while (job.status === 'running') {
    renderJobStatus();
    if (onProgress) onProgress(job.progress || {});
    await new Promise(resolve => setTimeout(resolve, 600));
    try { job = await api('/api/jobs/status', {id:job.id}); }
    catch (error) {
      job.status='connection lost'; job.error=error.message;
      job.recover=true; renderJobStatus();
      throw error;
    }
    workstationJobs.set(job.id, job);
  }
  renderJobStatus();
  if (onProgress) onProgress(job.progress || {});
  if (job.status !== 'completed') throw new Error(job.error || `${kind} ${job.status}.`);
  return job.result;
}

function renderAdvancedTournament() {
  const target = $('advancedTournamentPlayers');
  if (!target) return;
  const selected = new Set([...target.querySelectorAll('input:checked')].map(el => el.value));
  target.replaceChildren();
  externalEngines.forEach(engine => {
    const label = document.createElement('label'); label.className = 'analysis-auto';
    const check = document.createElement('input'); check.type = 'checkbox';
    check.value = engine.path; check.checked = selected.has(engine.path);
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
    target.append(reportRow(row.name, `${row.points} points · ${row.games} games · +${row.wins} =${row.draws} −${row.losses}${row.byes ? ` · ${row.byes} bye(s)` : ''}`));
  }
  $('exportAdvancedTournamentPgnBtn').disabled = !result.pgn;
}

async function runAdvancedTournament() {
  const selected = [...$('advancedTournamentPlayers').querySelectorAll('input:checked')].map(input => input.value);
  if (!selected.length) throw new Error('Select at least one saved external engine.');
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
  regressionHistory.unshift({kind, result, created_at:new Date().toISOString()});
  saveRegressionHistory(); renderWorkstationHistory();
}

function renderWorkstationHistory() {
  const target = $('workstationHistory'); if (!target) return;
  target.replaceChildren();
  for (const record of regressionHistory.slice(0, 20)) {
    const row = reportRow(record.kind || 'regression', record.created_at || 'Saved experiment');
    const view = document.createElement('button'); view.className='secondary compact'; view.textContent='View';
    view.addEventListener('click', async () => { showDeveloperResult(record.result); await activateTab(document.querySelector('[data-tab="engine"]')); });
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

function validateStudyGraph(workspace) {
  if (!workspace || !workspace.nodes || typeof workspace.nodes!=='object' || Array.isArray(workspace.nodes)) throw new Error('Study nodes are invalid.');
  const nodes=workspace.nodes;
  if (Object.keys(nodes).length>500 || !nodes[workspace.root]) throw new Error('Study root or size is invalid.');
  const complete=new Set(), visiting=new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Study contains a cycle.');
    if (complete.has(id)) return;
    const node=nodes[id];
    if (!node || node.id!==id || !Array.isArray(node.children) || !node.snapshot?.fen) throw new Error('Study node or reference is invalid.');
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
  const fen=value=>typeof value==='string' && value.length<=200 && value.trim().split(/\s+/).length===6;
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
