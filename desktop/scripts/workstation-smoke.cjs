'use strict';
module.exports=async function workstationSmoke(window,waitFor) {
  await window.webContents.executeJavaScript(String.raw`(async()=>{
    window.wsSmokeSaved=JSON.parse(JSON.stringify(display));
    window.wsSmokeLive=JSON.stringify([state.fen,state.moves_uci]);
    const check=(value,message)=>{if(!value)throw new Error(message);};
    const change=(key,value)=>{const input=document.querySelector('[data-ws-pref="'+key+'"]');if(input.type==='checkbox')input.checked=value;else input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}));};
    check(document.getElementById('wsSettings'),'Workstation settings missing');
    document.querySelector('[aria-label="Use Sculpted pieces"]').click();
    check(wsPrefs().pieceSet==='vector','Piece gallery does not select vectors');
    check(document.querySelectorAll('#wbBoard .ws-art-piece svg').length===32,'Preview vector pieces missing');
    check(document.querySelectorAll('#board .ws-art-piece svg').length>0,'Live vector pieces missing');
    if(wbTree.result)check(document.querySelectorAll('#wbTreeBoard svg').length>0,'Tree vector pieces missing');
    wsSet({pieceSet:'letters'});check(document.querySelector('#wbBoard svg text').textContent==='R','Lettered piece set missing');
    change('white','#ffeedd');change('black','#203040');change('outline',2);change('customPalette',true);change('light','#ddd5c0');change('dark','#507868');change('texture','linen');change('frame',4);
    check(document.documentElement.style.getPropertyValue('--light-square')==='#ddd5c0','Custom board colors missing');
    check(getComputedStyle(document.querySelector('#wbBoard .white-piece')).color==='rgb(255, 238, 221)','Piece colors missing');
    wsSet({motion:'full',duration:500});wb.ply=0;wbRenderPreview();wbStep(1);
    check([...document.querySelectorAll('#wbBoard [data-piece]')].some(piece=>piece.getAnimations().length),'Piece move animation missing');
    change('motion','reduced');check(wsReduced(),'Reduced motion ignored');change('duration',240);change('transitions',false);change('smooth',false);
    change('notationHeight',160);change('previewWidth',390);change('layout','preview');check(getComputedStyle(document.querySelector('.wb-browser')).display==='none','Preview focus does not hide list');
    document.getElementById('wsLayoutReturn').click();check(wsPrefs().layout==='split','Cannot exit preview focus');change('layout','stack');change('sticky',false);change('layout','split');
    document.getElementById('wsPresetName').value='Smoke look';await wsSavePreset();wsSet({white:'#ffffff'});document.getElementById('wsPresetList').value='0';
    const preset=wsPresets()[0];wsSet(preset.settings);check(wsPrefs().white==='#ffeedd','Saved look did not restore colors');
    check(JSON.parse(localStorage.getItem(DISPLAY_KEY)).workstation.presets.length===1,'Saved look was not persisted');
    check(document.getElementById('wsFolders').options.length>0,'Folder autocomplete missing');
    const original=wb.preview.positions;const originalPly=wb.ply;
    wb.preview.positions=Array.from({length:160},(_,i)=>({...original[i%original.length],label:'Move '+i}));wb.ply=90;wbRenderPreview();
    const moves=document.getElementById('wbMoves');moves.scrollTop=80;wbRenderPreview();check(moves.scrollTop===80,'Preview redraw stole manual scroll');
    change('scrollLock',true);moves.scrollTop=60;wbStep(1);check(moves.scrollTop===60,'Scroll lock was ignored');
    change('scrollLock',false);change('follow',true);wbStep(1);check(moves.scrollTop>60,'Move follow did not scroll');
    change('practice',true);check([...moves.querySelectorAll('[data-wb-ply]')].filter(button=>!button.hidden).length===wb.ply+1,'Future moves not hidden');change('practice',false);
    document.getElementById('wsPlyNumber').value='3';document.getElementById('wsJumpPly').click();check(wb.ply===3,'Jump-to-ply failed');
    change('orient',true);wb.ply=1;wbRenderPreview();check(wb.flipped===(wb.preview.positions[1].fen.split(' ')[1]==='b'),'Preview auto orientation failed');change('orient',false);
    change('wheel',true);const before=wb.ply;document.getElementById('wbBoard').dispatchEvent(new WheelEvent('wheel',{deltaY:100,cancelable:true}));check(wb.ply===before+1,'Wheel move stepping failed');change('wheel',false);
    wb.preview.positions=original;wb.ply=originalPly;wbRenderPreview();
    const notes=document.getElementById('wbNotes'),savedNotes=notes.value;notes.value='New private note';notes.dispatchEvent(new Event('input',{bubbles:true}));
    check(document.getElementById('wsNotesBadge').textContent==='Unsaved','Missing unsaved note badge');check(document.getElementById('wsNoteCount').textContent.includes('3 words'),'Note counter wrong');notes.value=savedNotes;wb.notesDirty=false;wsEditorBadges();
    const white=document.getElementById('wbHeader-White'),savedWhite=white.value;white.value='Draft';white.dispatchEvent(new Event('input',{bubbles:true}));check(document.getElementById('wsHeadersBadge').textContent==='Unsaved','Missing header badge');white.value=savedWhite;wb.headersDirty=false;wsEditorBadges();
    await wbTreeStart();const firstSquare=document.querySelector('#wbTreeBoard [data-square]').dataset.square;document.getElementById('wsTreeFlip').click();check(document.querySelector('#wbTreeBoard [data-square]').dataset.square!==firstSquare,'Tree flip failed');
    change('treeHidden',true);check(document.getElementById('wbTreeBoard').hidden,'Tree visibility ignored');change('treeHidden',false);change('treeScores',true);check(!document.querySelector('.ws-both-scores').hidden,'Both scores missing');
    document.getElementById('wsTreeQuery').value='impossible';document.getElementById('wsTreeQuery').dispatchEvent(new Event('input'));check([...document.querySelectorAll('#wbTreeMoves [data-san]')].every(row=>row.hidden),'SAN filter failed');document.getElementById('wsTreeQuery').value='';wsTreeTools();
    const exports=[],originalDownload=downloadBlob;downloadBlob=async(blob,name)=>exports.push({name,text:await blob.text()});
    try {document.getElementById('wsDownloadGame').click();document.getElementById('wsCitations').click();await new Promise(resolve=>setTimeout(resolve,20));}finally{downloadBlob=originalDownload;}
    check(exports.some(item=>item.name.endsWith('.pgn') && item.text.includes('[White')),'Single game PGN export missing');check(exports.some(item=>item.name.endsWith('.txt') && item.text.includes('Reference #')),'Citations export missing');
    const oldFilters={...wb.filters};document.getElementById('wsWhiteGames').click();window.wsSmokeFilters=oldFilters;
  })()`,true);
  await waitFor(window,`!wb.searching && wb.filters.exact_players===true`);
  await window.webContents.executeJavaScript(String.raw`(async()=>{
    if(wb.filters.player!==wb.preview.game.white)throw new Error('Player quick search failed');
    await wbChooseCollection(window.wsSmokeFilters);await wsRandomGame();
    if(!wb.preview)throw new Error('Random matching preview missing');
    if(JSON.stringify([state.fen,state.moves_uci])!==window.wsSmokeLive)throw new Error('Workstation tools changed the live game');
    const treeFen=wbTree.result.fen;await wbCreateStudy(treeFen,wbTree.result.variant,'Smoke tree study');
    if(!variationMode || variationNode().snapshot.fen!==treeFen)throw new Error('Tree study did not use tree position');
    if(JSON.stringify([state.fen,state.moves_uci])!==window.wsSmokeLive)throw new Error('Tree study changed live game');
    await exitVariationWorkspace();await activateTab(document.querySelector('[data-tab="display"]'));
    document.querySelector('#wsSettings details').open=true;document.getElementById('displayTab').scrollTop=0;
    display=window.wsSmokeSaved;saveDisplaySettings();applyDisplaySettings();
    wsSet({pieceSet:'vector',motion:'reduced'});wbRenderPreview();if(wbTree.result)wbTreeRender();
  })()`,true);
  if(process.env.FUNCHESS_SMOKE_SCREENSHOT) {
    window.setSize(1400,950);await new Promise(resolve=>setTimeout(resolve,150));
    require('node:fs').writeFileSync(process.env.FUNCHESS_SMOKE_SCREENSHOT.replace(/\.png$/,'-settings.png'),(await window.webContents.capturePage()).toPNG());
  }
  await window.webContents.executeJavaScript(`openDatabaseWorkbench()`,true);
};
