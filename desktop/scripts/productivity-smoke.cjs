'use strict';
module.exports=async function productivitySmoke(window,waitFor) {
  await window.webContents.executeJavaScript(`(async()=>{
    wbApplyFilters({event:'DatabaseSmoke'});await wbSearch();wb.selected.clear();wbRenderRows();
    document.getElementById('wbPageNumber').value='2';document.getElementById('wbGoPage').click();
  })()`,true);
  await waitFor(window,`!wb.searching && wb.offset===25 && wb.games.length===9 && !document.getElementById('wbGoPage').disabled`);
  await window.webContents.executeJavaScript(`document.getElementById('wbSelectMatching').click()`,true);
  await waitFor(window,`wb.selected.size===34 && !document.getElementById('wbSelectMatching').disabled`);
  // Hold the first-page response so readiness cannot accidentally depend on local speed.
  await window.webContents.executeJavaScript(`(()=>{
    window.productivityOriginalApi=wbApi;
    wbApi=async(action,payload)=>{
      const result=await window.productivityOriginalApi(action,payload);
      if(action==='search' && payload.offset===0)await new Promise(resolve=>window.productivityReleasePage=resolve);
      return result;
    };
    document.getElementById('wbInvertPage').click();document.getElementById('wbFirstPage').click();
  })()`,true);
  await waitFor(window,`typeof window.productivityReleasePage==='function'`);
  await window.webContents.executeJavaScript(`(()=>{
    try {
      if(!wb.searching || wb.offset!==0 || wb.games.length!==9)throw new Error('First-page delay did not retain the previous page');
      if(!document.getElementById('wbFirstPage').disabled || !document.getElementById('wbNextGame').disabled)throw new Error('Paging allowed navigation before results committed');
      const previewSequence=wb.previewSequence;document.getElementById('wbNextGame').click();
      if(wb.previewSequence!==previewSequence)throw new Error('Loading-page click changed preview');
    } finally {
      wbApi=window.productivityOriginalApi;delete window.productivityOriginalApi;
      window.productivityReleasePage();delete window.productivityReleasePage;
    }
  })()`,true);
  await waitFor(window,`!wb.searching && wb.selected.size===25 && wb.offset===0 && wb.games.length===25`);
  await window.webContents.executeJavaScript(`(async()=>{
    await wbPreview(wb.games[0].id);
    window.productivityNextGameId=wb.games[1].id;
    document.getElementById('wbNextGame').click();
  })()`,true);
  await waitFor(window,`wb.preview.game.id===window.productivityNextGameId`);
  await window.webContents.executeJavaScript(`document.getElementById('wbPreviousGame').click()`,true);
  await waitFor(window,`wb.preview.game.id===wb.games[0].id`);
  await window.webContents.executeJavaScript(`(async()=>{
    document.getElementById('wbNotationQuery').value='Model game';
    document.getElementById('wbNotationQuery').dispatchEvent(new Event('input'));
    document.getElementById('wbFindNotation').click();
    if(wb.ply!==1 || !document.querySelector('#wbMoves .notation-match'))throw new Error('Notation search failed');
    wb.ply=0;wbRenderPreview();document.getElementById('wbNextAnnotation').click();
    if(wb.ply!==1 || !document.getElementById('wbMaterial').textContent.includes('even'))throw new Error('Annotation/material tools failed');
    if(!document.getElementById('wbInspectorGrid').textContent.includes('Opening') || !document.getElementById('wbInspectorGrid').textContent.includes('Castling'))throw new Error('Position inspector facts missing');
    if(document.querySelectorAll('#wbGameMap .wb-map-ply').length!==wb.preview.positions.length || !document.getElementById('wbGameStats').textContent.includes('4 Moves'))throw new Error('Visual game map or summary missing');
    const record=wbPositionPayload(wb.preview,wb.ply);if(record.ply!==1 || record.uciLine[0]!=='e2e4' || !record.epd.includes('hmvc'))throw new Error('Portable position record failed');
    document.getElementById('wbForwardFive').click();if(wb.ply!==wb.preview.positions.length-1)throw new Error('Five-move forward navigation failed');document.getElementById('wbBackFive').click();if(wb.ply!==0)throw new Error('Five-move back navigation failed');
    document.getElementById('wbMoveNavigator').value='annotation';wbRenderPreviewTools();document.getElementById('wbNextFiltered').click();if(wb.ply!==1)throw new Error('Filtered move navigation failed');wb.ply=0;wbRenderPreview();
    document.getElementById('wbNextCritical').click();if(wb.ply!==1)throw new Error('Critical-position navigation failed');
    await wbLoadPositionReference();if(!document.getElementById('wbReferenceStatus').textContent.includes('34 games') || !document.getElementById('wbReferenceMoves').textContent.includes('e5') || document.getElementById('wbReferenceTree').disabled)throw new Error('Exact-position reference statistics failed');
    document.getElementById('wbViews').value='Smoke models';document.getElementById('wbViewName').value='Smoke models renamed';document.getElementById('wbRenameView').click();
  })()`,true);
  await waitFor(window,`wb.views.some(view=>view.name==='Smoke models renamed')`);
  await window.webContents.executeJavaScript(`document.querySelector('#wbFilterChips button').click()`,true);
  await waitFor(window,`!wb.filters.event && document.getElementById('wbFilterChips').children.length===0`);
  await window.webContents.executeJavaScript(`(async()=>{
    await wbTreeStart();
    document.getElementById('wbTreeMinimum').value='999';document.getElementById('wbTreeMinimum').dispatchEvent(new Event('change'));
    if(document.querySelector('#wbTreeMoves button'))throw new Error('Minimum-games filter failed');
    document.getElementById('wbTreeMinimum').value='1';document.getElementById('wbTreePerspective').value='black';document.getElementById('wbTreeSort').value='score';wbTreeRender();
    if(!document.getElementById('wbTreeMoves').textContent.includes('Black score 0.0%'))throw new Error('Score perspective failed');
    document.querySelector('#wbTreeMoves button').click();
  })()`,true);
  await waitFor(window,`wbTree.path.length===2 && wbTree.result.moves[0].san==='e5'`);
  await window.webContents.executeJavaScript(`(async()=>{
    const original=downloadBlob,downloads=[];
    downloadBlob=async(blob,name)=>downloads.push({name,text:await blob.text()});
    try {
      await wbTreeExportCsv();await wbTreeExportPgn();
      await downloadBlob(new Blob([wbDiagramSvg(wb.preview,wb.ply,wb.flipped)]),'diagram.svg');
    } finally {downloadBlob=original;}
    if(!downloads[0].text.includes('score_perspective') || !downloads[0].text.includes('black'))throw new Error('Tree CSV export failed');
    if(!downloads[1].text.includes('1. e4') || !downloads[1].text.includes('Reference sample'))throw new Error('Preparation PGN export failed');
    if(!downloads[2].text.includes('<svg') || (downloads[2].text.match(/<g>/g)||[]).length!==64)throw new Error('Board SVG export failed');
    window.productivityLiveBefore=JSON.stringify([state.fen,state.moves_uci]);
    document.querySelector('#wbTreeMoves .wb-tree-example').click();
  })()`,true);
  await waitFor(window,`wb.ply===2 && wb.preview.positions[2].uci==='e7e5'`);
  await window.webContents.executeJavaScript(`(async()=>{
    if(JSON.stringify([state.fen,state.moves_uci])!==window.productivityLiveBefore)throw new Error('Example preview changed live game');
    document.querySelector('#wbTreePath button').click();
  })()`,true);
  await waitFor(window,`wbTree.path.length===1`);
};
