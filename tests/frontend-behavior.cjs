const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../gui/static/app.js'), 'utf8');
function load(names, globals = {}) {
  const ctx = vm.createContext({console, ...globals});
  for (const name of names) {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(start >= 0, name);
    const end = source.indexOf('\n}', start) + 2;
    vm.runInContext(source.slice(start, end), ctx);
  }
  return ctx;
}
test('centipawns, zero, mate and missing data have distinct displays', () => {
  const c = load(['externalScoreText', 'recordedClockText'], {clock: n => String(n)});
  assert.equal(c.externalScoreText({score_cp:45, mate:null}), '+0.45');
  assert.equal(c.externalScoreText({score_cp:0, mate:null}), '+0.00');
  assert.equal(c.externalScoreText({score_cp:null, mate:-2}), 'M-2');
  assert.equal(c.externalScoreText({score_cp:null, mate:null}), '—');
  assert.equal(c.recordedClockText(null), '—');
  assert.equal(c.recordedClockText(0), '0');
});
test('hourglass projection transfers time and stops at flag', () => {
  const c = load(['liveClockMs'], {state:{white_ms:1000, black_ms:2000, turn:'white', clock_mode:'hourglass'}, clockAnchorMs:0, performance:{now:()=>700}});
  assert.equal(c.liveClockMs('white'),300); assert.equal(c.liveClockMs('black'),2700);
  c.performance.now=()=>3000;
  assert.equal(c.liveClockMs('black'),3000); assert.equal(c.liveClockMs('white'),0);
  c.state.paused=true; assert.equal(c.liveClockMs('black'),2000);
});
test('repertoire queue excludes other colors and repertoires', () => {
  const c = load(['trainerDueItems','trainerFocusedItems'], {trainerSessionKeys:new Set(['selected']), trainerItems:[{key:'other',phase:'opening',cpl:500,due_at:0},{key:'selected',phase:'opening',cpl:0,due_at:0}],trainerFocusMode:'opening'});
  assert.equal(c.trainerFocusedItems('opening').length,1);
  assert.equal(c.trainerFocusedItems('opening')[0].item.key,'selected');
  c.trainerItems[1].due_at=Date.now()+100000;
  assert.equal(c.trainerFocusedItems('opening').length,0);
});
test('history save is recovered from IndexedDB after fallback is removed', async () => {
  const local=new Map(), disk=new Map();
  const names=['CALIBRATION_HISTORY','EXTERNAL_COMPARE_HISTORY','REGRESSION_HISTORY','RECENTS','TRAINER','VARIATIONS','BOOKMARKS','ANNOTATIONS','BENCHMARK_HISTORY','ANALYSIS_QUEUE','TOURNAMENT_HISTORY','LESSONS','ENGINE_PRESETS','PLUGINS','EXTERNAL_ENGINES'];
  const globals=Object.fromEntries(names.map(n=>[n+'_KEY',n]));
  Object.assign(globals,{calibrationHistory:[{estimated_elo:1600}],externalCompareHistory:[],regressionHistory:[],durableMetadataDirty:new Set(),durableWriteChains:new Map(),localStorage:{setItem:(k,v)=>local.set(k,v),getItem:k=>local.get(k)??null,removeItem:k=>local.delete(k)},writeDurableValue:async(k,v)=>disk.set(k,v),reportPersistenceError:e=>{throw e}});
  const c=load(['persistDurableValue','saveCalibrationHistory','durableMetadataSpecs','loadCalibrationHistory'],globals);
  c.saveCalibrationHistory(); await Promise.all([...c.durableWriteChains.values()]);
  assert.equal(local.size,0); c.calibrationHistory=c.loadCalibrationHistory(); assert.equal(c.calibrationHistory.length,0);
  const spec=c.durableMetadataSpecs().find(s=>s.key==='CALIBRATION_HISTORY');
  spec.set(disk.get(spec.key)); assert.equal(c.calibrationHistory[0].estimated_elo,1600);
});
test('transposition move prefixes follow edges rather than first incoming node moves', () => {
  const path=[{id:'root'},{id:'B',move_uci:'b1c3'},{id:'C',move_uci:'g8f6'},{id:'shared',move_uci:'b1c3'}];
  const moves=['b1c3','g8f6','g1f3'];
  const c=load(['currentMovePrefix'], {state:{moves_uci:[]},variationMode:true,variationWorkspace:{origin_ply:0},variationPath:()=>path,variationEdge:(parent,child)=>({move_uci:moves[path.findIndex(n=>n.id===child)-1]})});
  assert.equal(c.currentMovePrefix().join(' '),moves.join(' '));
});

test('legacy transposition migration preserves secondary links for legal move recovery',()=>{
  const c=load(['normalizeVariationWorkspace'],{validateStudyGraph:()=>true});
  const fen='4k3/8/8/8/8/8/8/4K3 w - - 0 1';
  const node=(id,children=[],extra={})=>({id,children,snapshot:{fen},...extra});
  const graph={root:'r',edges:{},nodes:{
    r:node('r',['a','b']),
    a:node('a',['shared'],{parent:'r',parents:['r'],move_uci:'a2a3'}),
    b:node('b',['shared'],{parent:'r',parents:['r'],move_uci:'b2b3'}),
    shared:node('shared',[],{parent:'a',parents:['a','b'],move_uci:'c2c3',move_san:'c3'}),
  }};
  const migrated=c.normalizeVariationWorkspace(graph);
  assert.equal(migrated.edges['a>shared'].move_uci,'c2c3');
  assert.equal(migrated.edges['b>shared'],undefined);
  assert.equal(migrated.nodes.b.children.includes('shared'),true);
  assert.equal(migrated.needs_edge_migration,true);
  assert.deepEqual(Array.from(migrated.nodes.shared.parents),['a','b']);
});

test('plugin disable removes only its trainer contributions and opening labels are longest-prefix',()=>{
  const globals={
    trainerItems:[
      {key:'plugin:one:a',plugin_id:'one'},
      {key:'plugin:two:b',plugin_id:'two'},
      {key:'personal',source:'analysis'},
    ],
    saveTrainerItems:()=>{},renderTrainerPanel:()=>{},trainerItemIndex:-1,trainerMode:false,
    pluginManifests:[
      {id:'open',enabled:true,kind:'openings',items:[{name:'Short',moves:['e2e4']},{name:'Long',moves:['e2e4','e7e5']}]},
      {id:'off',enabled:false,kind:'openings',items:[{name:'Disabled',moves:['e2e4','e7e5','g1f3']}]},
    ],
  };
  const c=load(['removePluginContributions','pluginOpeningForMoves'],globals);
  c.removePluginContributions('one');
  assert.deepEqual(Array.from(c.trainerItems, item=>item.key),['plugin:two:b','personal']);
  assert.equal(c.pluginOpeningForMoves(['e2e4','e7e5','g1f3']).name,'Long');
});

test('desktop metadata is bounded, persists across store instances and rejects unknown keys',()=>{
  const {metadataStore}=require('../desktop/storage');
  const folder=fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'fce-metadata-'));
  try {
    const key='funChessEngine.calibrationHistory.v1';
    metadataStore(folder).set(key,[{estimated_elo:1700}]);
    assert.equal(metadataStore(folder).get(key).value[0].estimated_elo,1700);
    assert.throws(()=>metadataStore(folder).set('../outside',{}),/Unknown/);
    assert.throws(()=>metadataStore(folder).set(key,'x'.repeat(33*1024*1024)),/32 MB/);
    assert.equal(metadataStore(folder).get(key).value[0].estimated_elo,1700);
    metadataStore(folder).set('funChessEngine.recovery.v1','x'.repeat(16*1024*1024));
    assert.throws(()=>metadataStore(folder).set(key,'x'.repeat(16*1024*1024)),/32 MB/);
    assert.equal(metadataStore(folder).get(key).value[0].estimated_elo,1700);
  } finally {fs.rmSync(folder,{recursive:true,force:true});}
});
test('study validation accepts transpositions and rejects cycles, missing references and prototype keys',()=>{
  const ctx=vm.createContext({console});
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../gui/static/workflows.js'),'utf8'),ctx);
  const node=(id,children=[])=>({id,children,snapshot:{fen:'4k3/8/8/8/8/8/8/4K3 w - - 0 1'}});
  const graph={root:'r',nodes:{r:node('r',['a','b']),a:node('a',['c']),b:node('b',['c']),c:node('c')}};
  assert.equal(ctx.validateStudyGraph(graph),graph);
  graph.nodes.c.children=['r']; assert.throws(()=>ctx.validateStudyGraph(graph),/cycle/);
  graph.nodes.c.children=['missing']; assert.throws(()=>ctx.validateStudyGraph(graph),/missing/);
  assert.throws(()=>ctx.validateBackupCollections(JSON.parse('{"annotations":{"__proto__":{}}}')),/reserved/);
  assert.throws(()=>ctx.validateBackupCollections({lessons:[{title:'Bad',cards:'wrong'}]}),/lessons/);
  graph.nodes.c.children=[]; graph.nodes.c.snapshot.fen='8/8/8/8/8/8/8/8 w - - 0 1';
  assert.throws(()=>ctx.validateStudyGraph(graph),/invalid/);
});

test('recovered tournaments and calibrations reveal their actual result panels',async()=>{
  const revealed=[];
  const globals={console,calibrationHistory:[],regressionHistory:[],
    $:()=>({replaceChildren:()=>{}}),saveCalibrationHistory:()=>{},renderCalibrationEngines:()=>{},
  };
  const c=vm.createContext(globals);
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../gui/static/workflows.js'),'utf8'),c);
  c.showTournamentResult=()=>{}; c.saveWorkstationResult=()=>{};
  c.revealWorkflow=async(id,tab)=>revealed.push([id,tab]);
  await c.showRecoveredJob({id:'t1',kind:'tournament',result:{games:[]}});
  await c.showRecoveredJob({id:'c1',kind:'calibration',result:{results:[]}});
  await c.showRecoveredJob({id:'c1',kind:'calibration',result:{results:[]}});
  assert.deepEqual(revealed,[['advancedTournamentStandings','tools'],['calibrationResult','train'],['calibrationResult','train']]);
  assert.equal(c.calibrationHistory.length,1);
});

test('desktop migration preserves newer collections and recovery saves leave histories untouched',()=>{
  const path=require('node:path'), {metadataStore}=require('../desktop/storage');
  const folder=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'fce-migrate-'));
  const history='funChessEngine.calibrationHistory.v1', recovery='funChessEngine.recovery.v1';
  try {
    const collections=path.join(folder,'workspace-collections');
    fs.mkdirSync(collections);
    fs.writeFileSync(path.join(collections,`${history}.json`),JSON.stringify([{estimated_elo:1900}]));
    const original=JSON.stringify({[history]:[{estimated_elo:1400}],[recovery]:{fen:'old'}});
    fs.writeFileSync(path.join(folder,'workspace-metadata.json'),original);
    const store=metadataStore(folder);
    assert.equal(store.get(history).value[0].estimated_elo,1900);
    assert.equal(store.get(recovery).value.fen,'old');
    const backup=fs.readdirSync(folder).find(name=>name.endsWith('.legacy.json'));
    assert.equal(fs.readFileSync(path.join(folder,backup),'utf8'),original);
    const historyFile=path.join(collections,`${history}.json`);
    const before=fs.statSync(historyFile,{bigint:true});
    for(let i=0;i<10;i++) store.set(recovery,{clock:i});
    const after=fs.statSync(historyFile,{bigint:true});
    assert.equal(after.ino,before.ino); assert.equal(after.mtimeNs,before.mtimeNs);
    assert.equal(metadataStore(folder).get(recovery).value.clock,9);
  } finally {fs.rmSync(folder,{recursive:true,force:true});}
});

test('failed metadata replacement preserves original and removes temporary files',()=>{
  const path=require('node:path'), {metadataStore}=require('../desktop/storage');
  const folder=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'fce-write-'));
  const originalRename=fs.renameSync;
  try {
    const store=metadataStore(folder), key='funChessEngine.recovery.v1';
    store.set(key,{clock:100});
    fs.renameSync=()=>{throw new Error('Disk full')};
    assert.throws(()=>store.set(key,{clock:200}),/Disk full/);
    assert.equal(store.get(key).value.clock,100);
    assert.equal(fs.readdirSync(path.join(folder,'workspace-collections')).length,1);
  } finally {fs.renameSync=originalRename;fs.rmSync(folder,{recursive:true,force:true});}
});

test('interrupted tournament opens partial standings and keeps it distinct from completed result',async()=>{
  const revealed=[],saved=[];
  const c=vm.createContext({console});
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../gui/static/workflows.js'),'utf8'),c);
  c.showTournamentResult=result=>assert.equal(result.games.length,1);
  c.saveWorkstationResult=(kind,result)=>saved.push([kind,result._workstationJobId]);
  c.revealWorkflow=async(id,tab)=>revealed.push([id,tab]);
  await c.showRecoveredJob({id:'t1',kind:'tournament',status:'interrupted',progress:{partial:{games:[{}]}}});
  assert.deepEqual(saved,[['tournament','t1-partial']]);
  assert.deepEqual(revealed,[['advancedTournamentStandings','tools']]);
});

const workbenchSource=fs.readFileSync(require('node:path').join(__dirname,'../gui/static/workbench.js'),'utf8');
function loadWorkbench(names, globals={}) {
  const ctx=vm.createContext({console,...globals});
  for(const name of names) {
    const start=workbenchSource.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(start>=0,name);
    vm.runInContext(workbenchSource.slice(start,workbenchSource.indexOf('\n}',start)+2),ctx);
  }
  return ctx;
}
test('preview orientation keeps every piece on the correct square',()=>{
  const c=loadWorkbench(['wbBoardSquares']);
  const fen='r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  const white=c.wbBoardSquares(fen),black=c.wbBoardSquares(fen,true);
  assert.equal(white.length,64);assert.equal(black.length,64);
  assert.equal(white[0].square,'a8');assert.equal(black[0].square,'h1');
  assert.equal(white.find(s=>s.square==='e1').piece,'K');
  assert.equal(black.find(s=>s.square==='e1').piece,'K');
  assert.equal(white.find(s=>s.square==='a1').dark,true);
});
test('CSV export neutralizes formulas and preserves CSV quoting',()=>{
  const c=loadWorkbench(['wbCsvCell']);
  assert.equal(c.wbCsvCell('=1+1'),'"\'=1+1"');
  assert.equal(c.wbCsvCell('\t@SUM(1)'),'"\'\t@SUM(1)"');
  assert.equal(c.wbCsvCell('A,"B"'),'"A,""B"""');
});
test('scoresheets escape game metadata and comments',()=>{
  const c=loadWorkbench(['wbScoresheetHtml'],{escapeHtml:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')});
  const html=c.wbScoresheetHtml({headers:{Event:'<script>alert(1)</script>'},game:{white:'<img>',black:'B',result:'*'},positions:[{}, {label:'1. e4',comment:'<script>bad</script>'}]});
  assert.equal(html.includes('<script>'),false);assert.equal(html.includes('&lt;script&gt;'),true);
});
test('game comparison identifies divergence and different initial positions',()=>{
  const c=loadWorkbench(['wbCompareLines']);
  const game=(fen,moves)=>({positions:[{fen},...moves.map(uci=>({uci}))]});
  assert.equal(c.wbCompareLines(game('start',['e2e4','e7e5']),game('start',['e2e4','c7c5'])).common,1);
  assert.equal(c.wbCompareLines(game('start',[]),game('other',[])).sameStart,false);
});
test('slow database responses cannot overwrite newer search results',async()=>{
  const pending=[],wb={sequence:0,offset:0,sort:'date',direction:'desc'},rendered=[];
  const c=loadWorkbench(['wbSearch'],{wb,wbFilters:()=>({}),wbStatus:()=>{},$:()=>({value:'25'}),wbApi:()=>new Promise(resolve=>pending.push(resolve)),wbRenderRows:()=>rendered.push(wb.games)});
  const old=c.wbSearch(),fresh=c.wbSearch();
  pending[1]({games:['fresh'],total:1,offset:0,limit:25});await fresh;
  pending[0]({games:['old'],total:1,offset:0,limit:25});await old;
  assert.deepEqual(rendered,[['fresh']]);
});
test('removing a plugin keeps an active personal trainer card aligned with its board',()=>{
  const c=load(['removePluginContributions'],{trainerItems:[{key:'plugin:one:x',plugin_id:'one'},{key:'personal'}],trainerItemIndex:1,trainerMode:true,saveTrainerItems:()=>{},renderTrainerPanel:()=>{},exitTrainer:()=>{throw new Error('Personal card was removed')}});
  c.removePluginContributions('one');assert.equal(c.trainerItemIndex,0);assert.equal(c.trainerItems[0].key,'personal');
});
test('a notes save preserves text typed while the request is pending',async()=>{
  const preview={game:{id:1,notes:'old',white:'A',black:'B'}},wb={preview,notesDirty:true};
  const input={value:'submitted'};let resolve,request;
  const c=loadWorkbench(['wbSaveNotes'],{wb,$:()=>input,wbRequirePreview:()=>wb.preview,wbLoadCollections:async()=>{},wbStatus:()=>{},wbApi:(_action,payload)=>{request=payload;return new Promise(r=>resolve=r);}});
  const saving=c.wbSaveNotes();input.value='newer draft';resolve({});await saving;
  assert.equal(request.expected_notes,'old');assert.equal(request.changes.notes,'submitted');
  assert.equal(preview.game.notes,'submitted');assert.equal(input.value,'newer draft');assert.equal(wb.notesDirty,true);
});
test('a notes save cannot change another game opened during the request',async()=>{
  const first={game:{id:1,notes:'old'}},second={game:{id:2,notes:'other'}};
  const wb={preview:first,notesDirty:true},input={value:'submitted'};let resolve;
  const c=loadWorkbench(['wbSaveNotes'],{wb,$:()=>input,wbRequirePreview:()=>wb.preview,wbLoadCollections:async()=>{},wbStatus:()=>{},wbApi:()=>new Promise(r=>resolve=r)});
  const saving=c.wbSaveNotes();wb.preview=second;wb.notesDirty=false;input.value='other';resolve({});await saving;
  assert.equal(first.game.notes,'submitted');assert.equal(second.game.notes,'other');assert.equal(wb.notesDirty,false);
});
function headerSaveContext() {
  const preview={game:{id:1,pgn:'old'},headers:{White:'A',Event:'Old'},revision:'old'};
  const wb={preview,headersDirty:true,notesDirty:true};
  const fields={'wbHeader-White':{value:'Submitted'},'wbHeader-Event':{value:'Old'},wbNotes:{value:'unsaved notes'}};
  const pending=[];
  const c=loadWorkbench(['wbSaveHeaders'],{wb,$:id=>fields[id],WB_HEADERS:['White','Event'],wbRequirePreview:()=>wb.preview,wbPreviewHeading:()=>{},wbSearch:async()=>{},wbStatus:()=>{},wbApi:(action,payload)=>new Promise(resolve=>pending.push({action,payload,resolve}))});
  const result={headers:{White:'Submitted',Event:'Old'},revision:'new',pgn:'new pgn',metadata:{white:'Submitted'}};
  return {c,wb,fields,pending,preview,result};
}
test('header saves preserve newer header edits and unrelated unsaved notes',async()=>{
  const {c,wb,fields,pending,preview,result}=headerSaveContext();
  const saving=c.wbSaveHeaders();fields['wbHeader-White'].value='Newer draft';
  assert.equal(JSON.stringify(pending[0].payload.headers),JSON.stringify({White:'Submitted'}));
  pending[0].resolve(result);await saving;
  assert.equal(wb.headersDirty,true);assert.equal(fields['wbHeader-White'].value,'Newer draft');
  assert.equal(preview.headers.White,'Submitted');assert.equal(preview.revision,'new');
  assert.equal(wb.notesDirty,true);assert.equal(fields.wbNotes.value,'unsaved notes');
});
test('header save completion cannot pull the user back to the previous game',async()=>{
  const {c,wb,fields,pending,result}=headerSaveContext();
  const saving=c.wbSaveHeaders();const second={game:{id:2},headers:{White:'Other'}};
  wb.preview=second;wb.headersDirty=false;fields['wbHeader-White'].value='Other';
  pending[0].resolve(result);await saving;
  assert.equal(wb.preview,second);assert.equal(fields['wbHeader-White'].value,'Other');assert.equal(wb.headersDirty,false);
});
test('stale failed searches do not replace the latest successful status with an error',async()=>{
  const pending=[],wb={sequence:0},statuses=[];
  const c=loadWorkbench(['wbSearch'],{wb,wbFilters:()=>({}),wbStatus:s=>statuses.push(s),$:()=>({value:'25'}),wbApi:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),wbRenderRows:()=>{}});
  const old=c.wbSearch(),fresh=c.wbSearch();
  pending[1].resolve({games:['fresh'],total:1,offset:0,limit:25});await fresh;
  pending[0].reject(new Error('Old request failed'));await old;
  assert.equal(wb.games[0],'fresh');assert.ok(statuses.at(-1).includes('1 matching games'));
});
test('preview loading asks again before discarding edits typed during the request',async()=>{
  const first={game:{id:1}},wb={preview:first,previewSequence:0};let edited=false,resolve,calls=0;
  const c=loadWorkbench(['wbPreview'],{wb,wbDiscardEdits:async()=>++calls===1,wbStop:()=>{},wbEditorState:()=>edited?'new draft':'old',wbApi:()=>new Promise(r=>resolve=r),wbRenderPreview:()=>assert.fail('Should not render'),wbRenderRows:()=>{}});
  const loading=c.wbPreview(2);await new Promise(setImmediate);edited=true;resolve({game:{id:2}});
  assert.equal(await loading,false);assert.equal(wb.preview,first);assert.equal(calls,2);
});
test('closing a workspace invalidates a pending preview',async()=>{
  const wb={preview:null,previewSequence:0};let resolve;
  const c=loadWorkbench(['wbPreview','wbCloseWorkspace'],{wb,wbDiscardEdits:async()=>true,wbStop:()=>{},wbEditorState:()=>'',wbApi:()=>new Promise(r=>resolve=r),$:()=>({close:()=>{}})});
  const loading=c.wbPreview(2);await new Promise(setImmediate);c.wbCloseWorkspace();resolve({game:{id:2}});
  assert.equal(await loading,false);assert.equal(wb.preview,null);
});
test('older reports cannot overwrite the newest dossier or export',async()=>{
  const wb={},pending=[],rendered=[];
  const c=loadWorkbench(['wbBuildReport'],{wb,wbFilters:()=>({}),$:()=>({value:'A'}),wbApi:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),wbRenderReport:result=>rendered.push(result)});
  const old=c.wbBuildReport(),fresh=c.wbBuildReport();
  pending[1].resolve({player:'Fresh'});await fresh;
  pending[0].resolve({player:'Old'});await old;
  assert.equal(wb.report.player,'Fresh');assert.equal(rendered.length,1);
  const stale=c.wbBuildReport();wb.reportSequence++;pending[2].reject(new Error('Obsolete failure'));await stale;
  assert.equal(wb.report.player,'Fresh');
});
test('game comparison ignores move counters but distinguishes chess variants',()=>{
  const c=loadWorkbench(['wbCompareLines']);
  const game=(counter,variant)=>({game:{variant},positions:[{fen:`8/8/8/8/8/8/8/8 w - - ${counter}`} ]});
  assert.equal(c.wbCompareLines(game('0 1','standard'),game('40 25','standard')).sameStart,true);
  assert.equal(c.wbCompareLines(game('0 1','standard'),game('0 1','chess960')).sameStart,false);
});
const explorerSource=fs.readFileSync(require('node:path').join(__dirname,'../gui/static/database-explorer.js'),'utf8');
function loadExplorer(names,globals={}) {
  const ctx=vm.createContext({...globals});
  for(const name of names) {
    const start=explorerSource.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(start>=0,name);vm.runInContext(explorerSource.slice(start,explorerSource.indexOf('\n}',start)+2),ctx);
  }
  return ctx;
}
test('rapid opening-tree navigation retains only the latest path and ignores obsolete errors',async()=>{
  const wbTree={sequence:0},pending=[],rendered=[];
  const c=loadExplorer(['wbTreeLoad'],{wbTree,wbTreeFilters:()=>({tag:'model'}),$:()=>({}),wbApi:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),wbTreeRender:()=>rendered.push(wbTree.result)});
  const first=c.wbTreeLoad([{fen:'first'}]),second=c.wbTreeLoad([{fen:'second'}]);
  pending[1].resolve({fen:'second'});await second;pending[0].resolve({fen:'first'});await first;
  assert.equal(wbTree.path[0].fen,'second');assert.equal(rendered.length,1);
  const stale=c.wbTreeLoad([{fen:'stale'}]),newest=c.wbTreeLoad([{fen:'newest'}]);
  pending[3].resolve({fen:'newest'});await newest;pending[2].reject(new Error('Stale'));await stale;
  assert.equal(wbTree.result.fen,'newest');
});
test('opening tree uses its own position and variant without altering search filters',()=>{
  const filters={fen:'search position',variant:'chess960',tag:'model',favorite:true};
  const c=loadExplorer(['wbTreeFilters'],{wbFilters:()=>({...filters})});
  assert.equal(JSON.stringify(c.wbTreeFilters()),JSON.stringify({tag:'model',favorite:true}));
  assert.equal(filters.fen,'search position');
});
