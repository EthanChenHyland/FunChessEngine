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
  const c=loadWorkbench(['wbSearch'],{wb,wbSearchControls:()=>{},wbFilters:()=>({}),wbStatus:()=>{},$:()=>({value:'25'}),wbApi:()=>new Promise(resolve=>pending.push(resolve)),wbRenderRows:()=>rendered.push(wb.games)});
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
  const c=loadWorkbench(['wbSearch'],{wb,wbSearchControls:()=>{},wbFilters:()=>({}),wbStatus:s=>statuses.push(s),$:()=>({value:'25'}),wbApi:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),wbRenderRows:()=>{}});
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
test('book weights preserve zero and reject invalid priorities',()=>{
  const c=load(['openingBookWeight']);
  assert.equal(c.openingBookWeight('0'),0);assert.equal(c.openingBookWeight('65535'),65535);
  for(const value of ['','-1','1.5','Infinity','65536','x'])assert.throws(()=>c.openingBookWeight(value));
});
test('slow opening-book responses cannot replace a newer position',async()=>{
  const pending=[],rendered=[],requests=[];
  const c=load(['refreshOpeningBook'],{openingBookSequence:0,currentBoardView:()=>({fen:'position'}),state:{engine_profile:'default'},$:()=>({}),renderOpeningBook:(...args)=>rendered.push(args),api:(_url,payload)=>{requests.push(payload);return new Promise(resolve=>pending.push(resolve));}});
  const old=c.refreshOpeningBook(),fresh=c.refreshOpeningBook();
  pending[2]({moves:1});pending[3]({moves:['new']});await fresh;
  pending[0]({moves:2});pending[1]({moves:['old']});await old;
  assert.equal(rendered.length,1);assert.equal(rendered[0][3].moves[0],'new');
  assert.equal(requests[1].depth_limit,undefined,'The editor must also show stored late-game positions');
});
test('adding a zero-weight book move preserves a newer move draft',async()=>{
  let resolve,payload;
  const fields={openingBookMove:{value:'e2e4'},openingBookWeight:{value:'0'}};
  const c=load(['openingBookWeight','addCurrentOpeningBookMove'],{currentBoardView:()=>({fen:'position',variant:'standard'}),state:{engine_profile:'default'},$:id=>fields[id],setStatus:()=>{},refreshOpeningBook:async()=>{},api:(_url,request)=>{payload=request;return new Promise(r=>resolve=r);}});
  const saving=c.addCurrentOpeningBookMove();fields.openingBookMove.value='d2d4';resolve({});await saving;
  assert.equal(payload.weight,0);assert.equal(fields.openingBookMove.value,'d2d4');
});
const productivitySource=fs.readFileSync(require('node:path').join(__dirname,'../gui/static/database-productivity.js'),'utf8');
function loadProductivity(names,globals={}) {
  const ctx=vm.createContext({...globals});
  for(const name of names) {
    const start=productivitySource.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(start>=0,name);vm.runInContext(productivitySource.slice(start,productivitySource.indexOf('\n}',start)+2),ctx);
  }
  return ctx;
}
test('page jumps clamp to real pages and reject fractional input',()=>{
  const c=loadProductivity(['wbPageOffset']);
  assert.equal(c.wbPageOffset(999,34,25),25);assert.equal(c.wbPageOffset(1,0,25),0);
  assert.throws(()=>c.wbPageOffset(1.5,100,25));assert.throws(()=>c.wbPageOffset(0,100,25));
});
test('database table layouts whitelist columns and preserve visual preferences',()=>{
  const columns=['result','rating','game_date','eco','event','plies','folder'],defaults={columns:[...columns],density:'comfortable',stickyPlayers:false,zebra:true,wrap:false};
  const c=loadProductivity(['wbSanitizeTablePrefs'],{WB_TABLE_COLUMNS:columns,WB_TABLE_DEFAULTS:defaults});const prefs=c.wbSanitizeTablePrefs({columns:['eco','event','eco','<style>'],stickyPlayers:true,zebra:false,wrap:true});
  assert.deepEqual([...prefs.columns],['eco','event']);assert.equal(prefs.density,'comfortable');assert.equal(prefs.stickyPlayers,true);assert.equal(prefs.zebra,false);assert.equal(prefs.wrap,true);assert.deepEqual([...c.wbSanitizeTablePrefs(null).columns],columns);assert.equal(c.wbSanitizeTablePrefs({columns:'all'}).zebra,true);assert.equal(c.wbSanitizeTablePrefs({density:'spacious'}).density,'spacious');assert.equal(c.wbSanitizeTablePrefs({density:'giant'}).density,'comfortable');
});
test('recent database searches sanitize filters and produce readable labels',()=>{
  const keys=['player','eco','year_from','favorite','fen'];const c=loadProductivity(['wbSanitizeSearchFilters','wbSearchLabel'],{WB_SEARCH_KEYS:keys});const filters=c.wbSanitizeSearchFilters({player:'  Carlsen  ',eco:'B90',year_from:2020,favorite:false,fen:'x'.repeat(500),injected:'bad'});
  assert.equal(filters.player,'Carlsen');assert.equal(filters.year_from,'2020');assert.equal(filters.favorite,undefined);assert.equal(filters.fen.length,300);assert.equal(filters.injected,undefined);assert.equal(c.wbSearchLabel({player:'Carlsen',favorite:true}),'Player: Carlsen · Favorites');assert.equal(c.wbSearchLabel({}),'All games');
});
test('recent database searches deduplicate and stay bounded',()=>{
  const values=new Map(),localStorage={getItem:key=>values.get(key) ?? null,setItem:(key,value)=>values.set(key,value)};const keys=['player','eco'];let renders=0;
  const c=loadProductivity(['wbSanitizeSearchFilters','wbSearchHistory','wbRememberSearch'],{WB_SEARCH_KEYS:keys,WB_SEARCH_HISTORY_KEY:'history',localStorage,wbRenderSearchHistory:()=>renders++});
  for(let index=0;index<12;index++)c.wbRememberSearch({player:`Player ${index}`});c.wbRememberSearch({player:'Player 5'});const history=c.wbSearchHistory();assert.equal(history.length,10);assert.equal(history[0].filters.player,'Player 5');assert.equal(history.filter(row=>row.filters.player==='Player 5').length,1);assert.equal(renders,13);
});
test('database page snapshots calculate result, rating, year and ECO summaries',()=>{
  const keys=['event'];const c=loadProductivity(['wbSanitizeSearchFilters','wbPageSnapshot'],{WB_SEARCH_KEYS:keys});const snapshot=c.wbPageSnapshot([{result:'1-0',white_elo:2400,black_elo:2200,game_date:'2024.02.03',eco:'B90',plies:80,favorite:true},{result:'1/2-1/2',white_elo:null,black_elo:2000,game_date:'2022.??.??',eco:'B90',plies:60},{result:'abandoned',game_date:'????.??.??',eco:'C20',plies:0}],200,{event:'Open',bad:'x'});
  assert.equal(snapshot.pageGames,3);assert.equal(snapshot.total,200);assert.equal(snapshot.results['1-0'],1);assert.equal(snapshot.results['1/2-1/2'],1);assert.equal(snapshot.results['*'],1);assert.equal(snapshot.averageElo,2200);assert.equal(snapshot.averagePlies,140/3);assert.equal(snapshot.yearFrom,2022);assert.equal(snapshot.yearTo,2024);assert.equal(snapshot.favorites,1);assert.deepEqual([...snapshot.ecos[0]],['B90',2]);assert.deepEqual({...snapshot.filters},{event:'Open'});
});
test('database page snapshot text states scope and active filters',()=>{
  const c=loadProductivity(['wbSearchLabel','wbSnapshotText']);const text=c.wbSnapshotText({pageGames:25,total:80,results:{'1-0':10,'1/2-1/2':8,'0-1':6,'*':1},averageElo:2345.4,averagePlies:77.25,yearFrom:2019,yearTo:2025,favorites:4,filters:{eco:'C65'}});
  assert.match(text,/25 loaded of 80/);assert.match(text,/\+10 =8 -6/);assert.match(text,/Average Elo 2345/);assert.match(text,/2019–2025/);assert.match(text,/ECO: C65/);
});
test('inverting page selection retains other pages and rejects overflow atomically',()=>{
  const c=loadProductivity(['wbInvertSelection']);
  const selected=new Set([1,100]);const next=c.wbInvertSelection(selected,[1,2]);
  assert.deepEqual([...next],[100,2]);assert.deepEqual([...selected],[1,100]);
  const full=new Set(Array.from({length:500},(_,n)=>n));
  assert.throws(()=>c.wbInvertSelection(full,[999]));assert.equal(full.size,500);
});
test('select-all ignores results for a superseded search',async()=>{
  const wb={sequence:1,filters:{player:'Old'},selected:new Set([1])};let resolve;
  const c=loadProductivity(['wbSelectMatching'],{wb,wbApi:()=>new Promise(r=>resolve=r),wbStatus:()=>{},wbRenderRows:()=>assert.fail('Stale selection rendered')});
  const selecting=c.wbSelectMatching();wb.sequence++;resolve({ids:[2,3]});await selecting;
  assert.deepEqual([...wb.selected],[1]);
});
test('notation search and annotation navigation include comments and wrap both ways',()=>{
  const c=loadProductivity(['wbNotationMatches','wbAnnotatedPlies','wbNextMarked']);
  const positions=[{comment:'Root plan'},{san:'e4',label:'1. e4'},{san:'c5',comment:'Sicilian plan',nags:[1]},{san:'Nf3',alternatives:1}];
  assert.equal(JSON.stringify(c.wbNotationMatches(positions,'PLAN')),JSON.stringify([0,2]));
  assert.equal(JSON.stringify(c.wbAnnotatedPlies(positions)),JSON.stringify([0,2,3]));
  assert.equal(c.wbNextMarked([0,2,3],3),0);assert.equal(c.wbNextMarked([0,2,3],0,-1),3);
});
test('material balance counts promotions and does not score kings',()=>{
  const c=loadProductivity(['wbMaterialBalance']);
  const material=c.wbMaterialBalance('4k3/8/8/8/8/8/8/Q2QK2r w - - 0 1');
  assert.equal(material.balance,13);assert.equal(material.counts.white.q,2);
});
test('position inspector reports phase, FEN state, traits and repetition',()=>{
  const c=loadProductivity(['wbPositionKey','wbPositionPhase','wbMoveKinds','wbPositionFacts']);
  const positions=[{fen:'8/8/8/8/8/8/4K3/7k w - - 0 40'},{fen:'8/8/8/8/8/8/4K3/7k b - - 1 40',san:'Kf2+'},{fen:'8/8/8/8/8/8/4K3/7k w - - 2 41',san:'Kh2',comment:'repeat'}];
  const facts=c.wbPositionFacts(positions,2);assert.equal(facts.phase,'Endgame');assert.equal(facts.pieces,2);assert.equal(facts.side,'White');assert.equal(facts.castling,'None');assert.equal(facts.fullmove,41);assert.equal(facts.seen,2);assert.deepEqual([...facts.occurrences],[0,2]);assert.deepEqual([...facts.traits],['comment']);
});
test('critical-position navigation includes tactical and annotated plies',()=>{
  const c=loadProductivity(['wbCriticalPlies']);const positions=[{},{san:'e4'},{san:'Bxh7+',nags:[]},{san:'O-O'},{san:'a8=Q'},{san:'Kh8',alternatives:2}];
  assert.deepEqual([...c.wbCriticalPlies(positions)],[2,3,4,5]);
});
test('EPD and portable position records retain bounded current-line context',()=>{
  const c=loadProductivity(['wbPositionKey','wbPositionPhase','wbMoveKinds','wbPositionFacts','wbLineNotation','wbEpd','wbPositionPayload']);
  const preview={game:{id:7,white:'A',black:'B',result:'1-0',variant:'standard'},positions:[{fen:'8/8/8/8/8/8/4K3/7k w - - 0 40'},{fen:'8/8/8/8/8/8/5K2/7k b - - 1 40',san:'Kf3',label:'40. Kf3',uci:'e2f3'}]};
  assert.equal(c.wbEpd(preview.positions[1].fen),'8/8/8/8/8/8/5K2/7k b - - hmvc 1; fmvn 40;');const payload=c.wbPositionPayload(preview,1);assert.equal(payload.ply,1);assert.equal(payload.phase,'Endgame');assert.equal(payload.sanLine,'40. Kf3');assert.deepEqual([...payload.uciLine],['e2f3']);
});
test('game map filters classify moves and phase changes',()=>{
  const c=loadProductivity(['wbPositionKey','wbPositionPhase','wbMoveKinds','wbCriticalPlies','wbMoveFilterPlies','wbGameSummary']);
  const opening='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',middle='r3k2r/ppp3pp/2n5/3qp3/8/2N2N2/PPP2PPP/R2Q1RK1',end='8/8/8/8/8/8/4K3/7k';
  const positions=[{fen:`${opening} w KQkq - 0 1`},{fen:`${opening} b KQkq - 0 1`,san:'e4'},{fen:`${middle} w kq - 1 12`,san:'Bxh7+',comment:'idea'},{fen:`${end} b - - 0 40`,san:'a8=Q',alternatives:1}];
  assert.deepEqual([...c.wbMoveKinds(positions[2])],['capture','check','annotation']);assert.deepEqual([...c.wbMoveFilterPlies(positions,'capture')],[2]);assert.deepEqual([...c.wbMoveFilterPlies(positions,'phase')],[2,3]);const summary=c.wbGameSummary(positions);assert.equal(summary.moves,3);assert.equal(summary.captures,1);assert.equal(summary.checks,1);assert.equal(summary.promotions,1);assert.equal(summary.annotations,1);assert.equal(summary.variations,1);
});
test('position reference metrics exclude unfinished games from score',()=>{
  const c=loadProductivity(['wbReferenceMetrics']);const metrics=c.wbReferenceMetrics({games:8,ended:2,moves:[{white_wins:2,draws:1,black_wins:1},{white_wins:0,draws:2,black_wins:0}]});
  assert.equal(metrics.games,8);assert.equal(metrics.ended,2);assert.equal(metrics.finished,6);assert.equal(metrics.continuations,2);assert.equal(metrics.whiteScore,7/12);
});
test('stale position-reference responses cannot overwrite a newer preview ply',async()=>{
  let resolve;const wb={ply:0,filters:{tag:'study',fen:'old'},preview:{game:{id:3,variant:'standard'},positions:[{fen:'8/8/8/8/8/8/4K3/7k w - - 0 1'},{fen:'8/8/8/8/8/8/5K2/7k b - - 1 1'}]}};
  const fields={wbReferenceStatus:{textContent:''},wbReferenceMoves:{replaceChildren:()=>{}}};const c=loadProductivity(['wbLoadPositionReference'],{wb,$:id=>fields[id],wbRequirePreview:()=>wb.preview,wbApi:()=>new Promise(done=>resolve=done),wbRenderPositionReference:()=>assert.fail('Stale reference rendered')});
  const request=c.wbLoadPositionReference();wb.ply=1;resolve({games:1,moves:[]});await request;assert.equal(wb.positionReference,undefined);
});
test('opening sorting uses selected perspective and leaves unknown scores last',()=>{
  const c=loadExplorer(['wbTreeScore','wbTreeRows']);
  const result={fen:'position b - - 0 1',moves:[{move_uci:'a',san:'a',games:20,white_score:.8},{move_uci:'b',san:'b',games:3,white_score:.2},{move_uci:'c',san:'c',games:50,white_score:null}]};
  assert.equal(c.wbTreeRows(result,'score',1,'black')[0].move_uci,'b');
  assert.equal(c.wbTreeRows(result,'score',1,'turn').at(-1).move_uci,'c');
  assert.equal(c.wbTreeRows(result,'games',10).length,2);
  assert.equal(result.moves[0].move_uci,'a');
});
test('example preview cancellation leaves the current move alone',async()=>{
  const wb={ply:4,preview:{}};
  const c=loadProductivity(['wbPreviewExample'],{wb,wbPreview:async()=>false,wbRenderPreview:()=>assert.fail('Cancelled example moved preview')});
  await c.wbPreviewExample(1,'fen','e2e4');assert.equal(wb.ply,4);
});
test('SVG diagrams escape metadata and export the selected orientation',()=>{
  const board=loadWorkbench(['wbBoardSquares']);
  const c=loadProductivity(['wbDiagramSvg'],{wbBoardSquares:board.wbBoardSquares,escapeHtml:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')});
  const preview={game:{white:'<script>bad</script>',black:'B'},positions:[{fen:'4k3/8/8/8/8/8/8/4K3 w - - 0 1'}]};
  const svg=c.wbDiagramSvg(preview,0,true);
  assert.equal(svg.includes('<script>'),false);assert.equal((svg.match(/<g>/g)||[]).length,64);
  assert.ok(svg.includes('>h1</text>'));assert.ok(svg.includes('&lt;script&gt;'));
});
test('search stays busy until the newest page is committed, including out-of-order responses',async()=>{
  const wb={sequence:0,games:['previous'],offset:25},pending=[],controls=[];
  const c=loadWorkbench(['wbSearch'],{wb,wbFilters:()=>({}),wbStatus:()=>{},$:()=>({value:'25'}),wbSearchControls:()=>controls.push({busy:wb.searching,games:[...wb.games]}),wbRenderRows:()=>{},wbApi:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))});
  const old=c.wbSearch(),fresh=c.wbSearch();
  assert.equal(wb.searching,true);assert.equal(wb.games[0],'previous');
  pending[0].resolve({games:['obsolete'],total:1,offset:0,limit:25});await old;
  assert.equal(wb.searching,true);assert.equal(wb.games[0],'previous');
  pending[1].resolve({games:['fresh'],total:1,offset:0,limit:25});await fresh;
  assert.equal(wb.searching,false);assert.deepEqual(controls.at(-1),{busy:false,games:['fresh']});
  const failed=c.wbSearch();pending[2].reject(new Error('Network failed'));
  await assert.rejects(failed,/Network failed/);assert.equal(wb.searching,false);
});
test('next-game and matching-selection actions do nothing while a page is loading',async()=>{
  const wb={searching:true,games:[{id:1},{id:2}],preview:{game:{id:1}}};
  const c=loadProductivity(['wbNextGame','wbSelectMatching'],{wb,wbPreview:()=>assert.fail('Navigated old page'),wbApi:()=>assert.fail('Selected old page')});
  await c.wbNextGame(1);await c.wbSelectMatching();
});

function loadWorkstation(globals={}) {
  const script=fs.readFileSync(require('node:path').join(__dirname,'../gui/static/workstation-ui.js'),'utf8').replace(/\nwsBind\(\);\s*$/,'');
  const context=vm.createContext({console,display:{},matchMedia:()=>({matches:false}),...globals});vm.runInContext(script,context);return context;
}
test('workstation preferences reject corrupt imports and clamp all dimensions',()=>{
  const c=loadWorkstation();const prefs=c.wsSanitize({pieceSet:'<script>',white:'red;url(x)',black:'#123abc',duration:Infinity,frame:90,outline:-10,notationHeight:900,previewWidth:0,motion:'reduced',wheel:'yes',practice:true,unknown:1});
  assert.equal(prefs.pieceSet,'vector');assert.equal(prefs.black,'#123abc');assert.equal(prefs.white,'#fffdf4');assert.equal(prefs.duration,180);assert.equal(prefs.frame,12);assert.equal(prefs.outline,0);assert.equal(prefs.notationHeight,480);assert.equal(prefs.previewWidth,280);assert.equal(prefs.wheel,false);assert.equal(prefs.practice,true);assert.equal(prefs.unknown,undefined);assert.equal(c.wsSanitize(null).motion,'system');
});
test('saved workstation looks stay bounded and cannot recursively persist presets',()=>{
  const c=loadWorkstation({display:{workstation:{presets:Array.from({length:20},(_,i)=>({name:'x'.repeat(90),settings:{pieceSet:'vector',presets:[{}]}}))}}});
  const presets=c.wsPresets();assert.equal(presets.length,12);assert.equal(presets[0].name.length,40);assert.equal(presets[0].settings.pieceSet,'vector');assert.equal(presets[0].settings.presets,undefined);
});
test('SAN copying respects black-to-move roots and excludes future moves',()=>{
  const c=loadWorkstation();const positions=[{fen:'8/8/8/8/8/8/8/8 b - - 0 17'},{fen:'8/8/8/8/8/8/8/8 w - - 1 18',san:'Nc6'},{fen:'8/8/8/8/8/8/8/8 b - - 2 18',san:'O-O'}];
  assert.equal(c.wsSanLine(positions,1),'17... Nc6');assert.equal(c.wsSanLine(positions,99),'17... Nc6 18. O-O');assert.equal(c.wsSanLine(positions,0),'');
});
test('notation redraws preserve manual scroll; only changed positions follow',()=>{
  const centers=[];const c=loadWorkstation();c.wsCenterMove=(target,selector)=>centers.push(selector);
  const target={scrollTop:0};c.wsFollow(target,'game:1','.active',80);assert.equal(centers.length,1);assert.equal(target.scrollTop,80);
  c.wsFollow(target,'game:1','.active',35);assert.equal(centers.length,1);assert.equal(target.scrollTop,35);
  c.display.workstation={scrollLock:true};c.wsFollow(target,'game:2','.active',35);assert.equal(centers.length,1);
  c.display.workstation={follow:false};c.wsFollow(target,'game:3','.active',35);assert.equal(centers.length,1);
});
test('system reduced motion controls scrolling and explicit preference overrides it',()=>{
  const calls=[];const c=loadWorkstation({matchMedia:()=>({matches:true})});const target={scrollTo:options=>calls.push(options)};
  c.wsScrollTo(target,60);assert.equal(calls[0].behavior,'instant');
  c.display.workstation={motion:'full'};c.wsScrollTo(target,70);assert.equal(calls[1].behavior,'smooth');
  c.display.workstation={motion:'reduced'};assert.equal(c.wsReduced(),true);
});
test('ply navigation rejects empty, fractional and out-of-range entries',()=>{
  const c=loadWorkstation();for(const value of ['',-1,1.5,5,'n/a'])assert.throws(()=>c.wsJumpPly(value,5));assert.equal(c.wsJumpPly('0',5),0);assert.equal(c.wsJumpPly('4',5),4);
  assert.equal(c.wsNoteStats('  King 👑\n pawn ').words,3);assert.equal(c.wsNoteStats('👑').characters,1);
});
test('random preview ignores superseded search and newer preview navigation',async()=>{
  let resolve;const calls=[];const wb={searching:false,total:30,sequence:1,previewSequence:2,filters:{player:'A'}};
  const c=loadWorkstation({wb,wbApi:()=>new Promise(done=>resolve=done),wbPreview:id=>calls.push(id),wbStatus:()=>{}});
  const request=c.wsRandomGame();wb.previewSequence++;resolve({games:[{id:1}],offset:0,total:30});await request;assert.equal(calls.length,0);
  const second=c.wsRandomGame();wb.sequence++;resolve({games:[{id:2}],offset:0,total:30});await second;assert.equal(calls.length,0);
});
test('creating a study preserves edits typed during its position request',async()=>{
  let resolve,started,editor='old',confirmations=0;const ready=new Promise(done=>started=done);
  const c=loadWorkbench(['wbCreateStudy'],{wb:{previewSequence:1},busy:false,setupMode:false,trainerMode:false,retryMode:false,wbDiscardEdits:async()=>++confirmations===1,wbEditorState:()=>editor,api:()=>new Promise(done=>{resolve=done;started();})});
  const request=c.wbCreateStudy('fen','standard','Study');await ready;editor='new draft';resolve({fen:'fen'});await request;assert.equal(confirmations,2);
});
test('random matching game samples the requested index on a partial last page',async()=>{
  const selected=[],requests=[];const math=Object.create(Math);math.random=()=>.99;
  const c=loadWorkstation({Math:math,wb:{searching:false,total:34,sequence:1,previewSequence:1,filters:{}},wbApi:async(action,payload)=>{requests.push(payload);return {total:34,offset:30,games:[{id:31},{id:32},{id:33},{id:34}]};},wbPreview:id=>selected.push(id),wbStatus:()=>{}});
  await c.wsRandomGame();assert.equal(requests[0].offset,30);assert.equal(requests[0].limit,10);assert.deepEqual(selected,[34]);
});
test('visibility defaults use filled sculpted pieces with independent side settings',()=>{
  const c=loadWorkstation(),prefs=c.wsSanitize(null);assert.equal(prefs.pieceSet,'vector');assert.equal(prefs.whiteSet,'vector');assert.equal(prefs.blackSet,'vector');assert.equal(prefs.fontSymbols,'solid');assert.ok(prefs.outline>=2);
  const migrated=c.wsSanitize({pieceSet:'font'});assert.equal(migrated.whiteSet,'font');assert.equal(migrated.blackSet,'font');assert.equal(migrated.fontSymbols,'solid');
});
test('contrast scores distinguish unreadable and high-contrast piece colors',()=>{
  const c=loadWorkstation();assert.ok(c.wsContrastRatio('#ffffff','#000000')>20);assert.equal(c.wsContrastRatio('#ffffff','#ffffff'),1);assert.ok(c.wsContrastRatio('#182431','#e7dfcc')>8);
});
test('built-in customization palettes and piece recipes remain valid',()=>{
  const c=loadWorkstation();const boards=vm.runInContext('WS_BOARD_PRESETS',c),pieces=vm.runInContext('WS_PIECE_PRESETS',c);assert.ok(boards.length>=12);assert.ok(pieces.length>=6);
  for(const preset of boards){assert.match(preset[1],/^#[0-9a-f]{6}$/i);assert.match(preset[2],/^#[0-9a-f]{6}$/i);}
  for(const preset of pieces)assert.equal(c.wsSanitize(preset[1]).whiteSet,preset[1].whiteSet);
});
test('customization sanitizer bounds visual effects and rejects CSS injection',()=>{
  const c=loadWorkstation();const prefs=c.wsSanitize({whiteOutline:'url(x)',frameColor:'#abcdef',pieceShadow:999,pieceOpacity:2,pieceY:-99,pieceWidth:500,radius:40,boardBrightness:0,boardSaturation:999,coordSize:40,fontScale:300,panelRadius:-2,targetStyle:'script'});
  assert.equal(prefs.whiteOutline,'#263746');assert.equal(prefs.frameColor,'#abcdef');assert.equal(prefs.pieceShadow,100);assert.equal(prefs.pieceOpacity,50);assert.equal(prefs.pieceY,-8);assert.equal(prefs.pieceWidth,120);assert.equal(prefs.radius,24);assert.equal(prefs.boardBrightness,70);assert.equal(prefs.boardSaturation,160);assert.equal(prefs.coordSize,18);assert.equal(prefs.fontScale,125);assert.equal(prefs.panelRadius,0);assert.equal(prefs.targetStyle,'dot');
});
test('advanced customization values are bounded and enum checked',()=>{
  const c=loadWorkstation();const prefs=c.wsSanitize({whiteSet:'neo',blackSet:'hacked',whiteScale:999,blackScale:1,highlightOpacity:0,targetSize:100,coordOpacity:1,textureScale:999,outlineStyle:'dots',lastStyle:'corners',coordsMode:'all',frameStyle:'glow',wallpaper:'aurora',buttonShape:'pill',animationEasing:'spring',appBg:'url(x)',panelBg:'#123456'});
  assert.equal(prefs.whiteSet,'neo');assert.equal(prefs.blackSet,'vector');assert.equal(prefs.whiteScale,125);assert.equal(prefs.blackScale,75);assert.equal(prefs.highlightOpacity,10);assert.equal(prefs.targetSize,90);assert.equal(prefs.coordOpacity,30);assert.equal(prefs.textureScale,200);assert.equal(prefs.outlineStyle,'solid');assert.equal(prefs.lastStyle,'corners');assert.equal(prefs.coordsMode,'all');assert.equal(prefs.frameStyle,'glow');assert.equal(prefs.wallpaper,'aurora');assert.equal(prefs.buttonShape,'pill');assert.equal(prefs.animationEasing,'spring');assert.equal(prefs.appBg,'#0d100e');assert.equal(prefs.panelBg,'#123456');
});
test('neo piece artwork defines every chessman with distinct fixed paths',()=>{
  const c=loadWorkstation(),classic=vm.runInContext('WS_SHAPES',c),neo=vm.runInContext('WS_NEO_SHAPES',c);
  assert.deepEqual(Object.keys(neo).sort(),['b','k','n','p','q','r']);for(const piece of Object.keys(neo)){assert.match(neo[piece],/^M/);assert.notEqual(neo[piece],classic[piece]);}
});
test('staunton and minimal artwork provide complete original piece families',()=>{
  const c=loadWorkstation(),classic=vm.runInContext('WS_SHAPES',c),staunton=vm.runInContext('WS_STAUNTON_SHAPES',c),minimal=vm.runInContext('WS_MINIMAL_SHAPES',c);
  for(const family of [staunton,minimal]){assert.deepEqual(Object.keys(family).sort(),['b','k','n','p','q','r']);for(const piece of Object.keys(family)){assert.match(family[piece],/^M/);assert.notEqual(family[piece],classic[piece]);}}
  assert.equal(c.wsSanitize({whiteSet:'staunton',blackSet:'minimal'}).whiteSet,'staunton');assert.equal(c.wsSanitize({whiteSet:'staunton',blackSet:'minimal'}).blackSet,'minimal');
});
test('automatic outlines maximize the weakest piece and square contrast',()=>{
  const c=loadWorkstation({display:{theme:'forest'}}),prefs=c.wsSanitize(null);
  assert.equal(c.wsBestOutline('#fffdf4',prefs),'#101820');assert.equal(c.wsBestOutline('#101820',prefs),'#fffdf4');
  const custom={...prefs,customPalette:true,light:'#ffffff',dark:'#eeeeee'};assert.equal(c.wsBestOutline('#fefefe',custom),'#101820');
});
test('saved looks whitelist complete base appearance without nested data',()=>{
  const c=loadWorkstation({display:{theme:'ocean',accent:'purple',appearance:'light',pieceTheme:'bold',pieceScale:88,sidebarWidth:500,workstation:{presets:[{name:'Portable',settings:{clockStyle:'digital'},base:{theme:'walnut',accent:'orange',appearance:'dark',pieceTheme:'clean',pieceScale:999,sidebarWidth:1,workstation:{bad:true}}}]}}});
  const preset=c.wsPresets()[0];assert.equal(preset.base.theme,'walnut');assert.equal(preset.base.accent,'orange');assert.equal(preset.base.pieceScale,90);assert.equal(preset.base.sidebarWidth,330);assert.equal(preset.base.workstation,undefined);assert.equal(preset.settings.clockStyle,'digital');
});
test('workspace customization values are clamped and enum checked',()=>{
  const c=loadWorkstation();const prefs=c.wsSanitize({boardMax:2000,boardTilt:-20,clockScale:1,clockThreshold:400,boardAlign:'outside',clockStyle:'alarm',showCaptured:false,hideTenths:true,moveNumbers:false});
  assert.equal(prefs.boardMax,900);assert.equal(prefs.boardTilt,-3);assert.equal(prefs.clockScale,80);assert.equal(prefs.clockThreshold,60);assert.equal(prefs.boardAlign,'center');assert.equal(prefs.clockStyle,'boxed');assert.equal(prefs.showCaptured,false);assert.equal(prefs.hideTenths,true);assert.equal(prefs.moveNumbers,false);
});
