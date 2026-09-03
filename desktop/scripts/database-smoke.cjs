"use strict";
const fs=require('node:fs');
module.exports=async function databaseSmoke(window,waitFor) {
  await window.webContents.executeJavaScript(String.raw`(async()=>{
    closeOnboarding();
    const collection=Array.from({length:34},(_,index)=>[
      '[Event "DatabaseSmoke '+index+'"]','[Site "Local"]','[Date "2025.01.01"]',
      '[White "Smoke Alpha"]','[Black "Smoke Beta"]','[WhiteElo "2400"]',
      '[BlackElo "2300"]','[Result "1-0"]','[ECO "C20"]','',
      '1. e4 {Model game [%clk 0:01:23]} (1. d4 d5) e5 2. Nf3 Nc6 1-0'
    ].join('\n')).join('\n\n');
    await api('/api/library-db/import',{pgn:collection,source:'database-smoke'});
    await openDatabaseWorkbench();
    wbApplyFilters({event:'DatabaseSmoke'});await wbSearch();
    if(wb.total!==34 || wb.games.length!==25)throw new Error('Database pagination failed');
    wb.offset+=wb.limit;await wbSearch(false);
    if(wb.games.length!==9 || !document.getElementById('wbNext').disabled)throw new Error('Database last page failed');
    const before=JSON.stringify([state.fen,state.moves_uci]);
    await wbPreview(wb.games[0].id);wbStep(1);
    if(document.querySelectorAll('#wbBoard .wb-square').length!==64)throw new Error('Preview board missing');
    if(!document.getElementById('wbComment').textContent.includes('Model game'))throw new Error('Preview lost comments');
    if(!document.getElementById('wbPositionMeta').textContent.includes('83.0s'))throw new Error('Preview lost recorded clock');
    if(JSON.stringify([state.fen,state.moves_uci])!==before)throw new Error('Preview altered live game');
    document.getElementById('wbNotes').value='Keep this unsaved note';wb.notesDirty=true;
    document.getElementById('wbHeader-White').value='Smoke Edited';wb.headersDirty=true;
    document.getElementById('wbSaveHeaders').click();
  })()`,true);
  await waitFor(window,`wb.preview?.headers.White==='Smoke Edited' && !document.getElementById('wbSaveHeaders').disabled`);
  await window.webContents.executeJavaScript(String.raw`(async()=>{
    if(!wb.notesDirty || document.getElementById('wbNotes').value!=='Keep this unsaved note')throw new Error('Header save discarded notes');
    document.getElementById('wbSaveNotes').click();
  })()`,true);
  await waitFor(window,`!wb.notesDirty && !document.getElementById('wbSaveNotes').disabled`);
  await window.webContents.executeJavaScript(String.raw`(async()=>{
    wb.selected=new Set(wb.games.slice(0,2).map(game=>game.id));
    await wbOrganize({favorite:true,tags:['model'],folder:'Study games'});
    await wbOrganize({tags:['endgame']},{tag_mode:'add'});
    let collections=await wbApi('collections');
    if(!collections.folders.some(row=>row.name==='Study games' && row.games===2))throw new Error('Collection counts failed');
    if((await wbApi('search',{filters:{tag:'model'}})).total!==2)throw new Error('Add tags removed existing tags');
    await wbOrganize({tags:['model']},{tag_mode:'remove'});
    if((await wbApi('search',{filters:{tag:'model'}})).total!==0)throw new Error('Remove tags failed');
    collections=await wbApi('collections');await wbUndo(collections.undo[0].id);
    if(!document.getElementById('wbCollections').textContent.includes('Study games · 2'))throw new Error('Collection navigator missing');
    if((await wbApi('search',{filters:{tag:'model'}})).total!==2)throw new Error('Undo tag removal failed');
    await wbChooseCollection({fen:wb.preview.positions[1].fen});
    if(wb.total!==34)throw new Error('Preview position search failed');
    wbApplyFilters({favorite:true,tag:'model'});await wbSearch();
    if(wb.total!==2)throw new Error('Organization filters failed');
    await wbCompareSelected();
    if(!document.getElementById('wbComparison').textContent.includes('Identical main lines'))throw new Error('Comparison failed');
    document.getElementById('wbDossierPlayer').value='Smoke Edited';await wbBuildReport();
    if(wb.report.dossier[0].wins!==1)throw new Error('Player dossier incorrect');
    document.getElementById('wbViewName').value='Smoke models';
    document.getElementById('wbSaveView').click();
  })()`,true);
  await waitFor(window,`wb.views.some(view=>view.name==='Smoke models')`);
  await window.webContents.executeJavaScript(String.raw`(async()=>{
    const liveBefore=JSON.stringify([state.fen,state.moves_uci]);
    const previewBefore=wb.preview.positions[wb.ply].fen;
    await wbTreeStart();document.getElementById('wbOpeningTree').open=true;
    if(wbTree.result.games!==2 || wbTree.result.moves[0].san!=='e4')throw new Error('Filtered opening tree failed');
    if(document.querySelectorAll('#wbTreeBoard .wb-square').length!==64)throw new Error('Opening tree board missing');
    if(JSON.stringify([state.fen,state.moves_uci])!==liveBefore || wb.preview.positions[wb.ply].fen!==previewBefore)throw new Error('Opening tree altered another board');
    document.querySelector('#wbTreeMoves button').click();
  })()`,true);
  await waitFor(window,`wbTree.path.length===2 && wbTree.result.moves[0]?.san==='e5'`);
  await window.webContents.executeJavaScript(String.raw`(async()=>{
    await wbChooseCollection({...wbTree.filters,fen:wbTree.result.fen,variant:wbTree.result.variant});
    if(wb.total!==2 || document.getElementById('wbVariant').value!=='standard')throw new Error('Opening tree game search failed');
    document.getElementById('wbTreeBack').click();
  })()`,true);
  await waitFor(window,`wbTree.path.length===1 && document.getElementById('wbTreeBack').disabled`);
  if(process.env.FUNCHESS_SMOKE_SCREENSHOT) {
    await window.webContents.executeJavaScript(`document.querySelector('.wb-collections').open=false;document.querySelector('.wb-filters').open=false;document.getElementById('wbReports').open=false;document.getElementById('wbComparison').hidden=true;document.querySelector('.wb-browser').scrollTop=0;document.querySelector('.wb-preview').scrollTop=0;`,true);
    window.setSize(1400,950);
    await new Promise(resolve=>setTimeout(resolve,150));
    fs.writeFileSync(process.env.FUNCHESS_SMOKE_SCREENSHOT.replace(/\.png$/,'-database.png'),(await window.webContents.capturePage()).toPNG());
    window.setSize(390,844);
    await new Promise(resolve=>setTimeout(resolve,150));
    const overflow=await window.webContents.executeJavaScript(`document.getElementById('databaseWorkbench').scrollWidth>document.getElementById('databaseWorkbench').clientWidth+1`,true);
    if(overflow)throw new Error('Database dialog overflows mobile width');
    fs.writeFileSync(process.env.FUNCHESS_SMOKE_SCREENSHOT.replace(/\.png$/,'-database-mobile.png'),(await window.webContents.capturePage()).toPNG());
  }
  await window.webContents.executeJavaScript(String.raw`(async()=>{
    const before=JSON.stringify([state.fen,state.moves_uci]);
    const previewFen=wb.preview.positions[wb.ply].fen;
    await wbStudyPosition();
    if(!variationMode || variationNode().snapshot.fen!==previewFen)throw new Error('Study did not use preview position');
    if(JSON.stringify([state.fen,state.moves_uci])!==before)throw new Error('Study changed live game');
    await exitVariationWorkspace();
  })()`,true);
};
