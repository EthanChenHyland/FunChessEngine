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
    saveTrainerItems:()=>{},renderTrainerPanel:()=>{},
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
  assert.deepEqual(revealed,[['advancedTournamentStandings','game'],['calibrationResult','train'],['calibrationResult','train']]);
  assert.equal(c.calibrationHistory.length,1);
});
