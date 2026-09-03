// Opening exploration is independent from the live game and the reference-game preview.
const wbTree={path:[],filters:{},result:null,sequence:0};
function wbTreeFilters() {
  const filters=wbFilters();delete filters.fen;delete filters.variant;
  return filters;
}
async function wbTreeLoad(path,filters=wbTreeFilters()) {
  if(path.length>256)throw new Error('Opening exploration is limited to 256 positions. Go back or start from a preview.');
  const sequence=++wbTree.sequence,position=path.at(-1);
  $('wbTreeStatus').textContent='Loading continuations…';
  let result;
  try {result=await wbApi('explorer',{fen:position.fen,variant:position.variant,filters});}
  catch(error) {
    if(sequence!==wbTree.sequence)return;
    $('wbTreeStatus').textContent=error.message;throw error;
  }
  if(sequence!==wbTree.sequence)return;
  wbTree.path=path;wbTree.filters={...filters};wbTree.result=result;
  wbTreeRender();
}
function wbTreeScore(move,perspective,fen) {
  if(move.white_score==null)return null;
  return perspective==='black' || (perspective==='turn' && fen.split(' ')[1]==='b')?1-move.white_score:move.white_score;
}
function wbTreeRows(result,sort='games',minimum=1,perspective='white') {
  const rows=result.moves.filter(move=>move.games>=Math.max(1,Number(minimum) || 1));
  const value=move=>sort==='score'?wbTreeScore(move,perspective,result.fen):sort==='rating'?move.average_elo:sort==='year'?move.latest_year:move.games;
  return rows.sort((a,b)=>{
    if(sort==='san')return a.san.localeCompare(b.san);
    const av=value(a),bv=value(b);
    return (av==null?bv==null?0:1:bv==null?-1:bv-av) || b.games-a.games || a.move_uci.localeCompare(b.move_uci);
  });
}
function wbTreeBreadcrumbs() {
  const target=$('wbTreePath');target.replaceChildren(wbElement('span',wbTree.result.variant==='chess960'?'Chess960':'Standard'));
  wbTree.path.forEach((position,index)=>{
    target.append(wbElement('span','›'));
    const button=wbButton(position.label,()=>wbTreeLoad(wbTree.path.slice(0,index+1),wbTree.filters),'text-button compact');
    button.setAttribute('aria-label',`Return to ${position.label}, step ${index}`);
    button.disabled=index===wbTree.path.length-1;target.append(button);
  });
}
async function wbTreeExportCsv() {
  if(!wbTree.result)throw new Error('Load an opening-tree position first.');
  const result=wbTree.result,perspective=$('wbTreePerspective').value;
  const moves=wbTreeRows(result,$('wbTreeSort').value,$('wbTreeMinimum').value,perspective);
  const rows=[['move','uci','games','frequency_percent','white_wins','draws','black_wins','unfinished','score_perspective','score_percent','average_elo','latest_year']];
  for(const move of moves) {
    const score=wbTreeScore(move,perspective,result.fen);
    rows.push([move.san,move.move_uci,move.games,(move.games/result.games*100).toFixed(2),move.white_wins,move.draws,move.black_wins,move.unfinished,perspective,score==null?'':(score*100).toFixed(2),move.average_elo ?? '',move.latest_year ?? '']);
  }
  await downloadBlob(new Blob(['\ufeff'+rows.map(row=>row.map(wbCsvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),'FunChessEngine-opening-tree.csv');
}
async function wbTreeExportPgn() {
  if(!wbTree.path.length)throw new Error('Load an opening-tree position first.');
  const root=wbTree.path[0];
  const result=await wbApi('export_line',{fen:root.fen,variant:root.variant,moves:wbTree.path.slice(1).map(position=>({uci:position.uci,comment:position.comment || ''}))});
  await downloadBlob(new Blob([result.pgn],{type:'application/x-chess-pgn'}),'FunChessEngine-preparation.pgn');
}
function wbTreeRender() {
  const result=wbTree.result,target=$('wbTreeMoves');target.replaceChildren();
  wbTreeBreadcrumbs();
  $('wbTreeStatus').textContent=`${result.games.toLocaleString()} matching games · ${result.ended.toLocaleString()} end at this position`;
  wbDisabled('wbTreeBack',wbTree.path.length<2);wbDisabled('wbTreeGames',false);wbDisabled('wbTreeCopy',false);
  const board=$('wbTreeBoard');board.replaceChildren();
  for(const square of wbBoardSquares(result.fen,typeof wsTreeFlipped!=='undefined' && wsTreeFlipped)) {
    const cell=wbElement('div',undefined,`wb-square ${square.dark?'dark':'light'}`);
    cell.append(wbElement('span',PIECES[square.piece] || '',`wb-piece ${square.piece===square.piece.toUpperCase()?'white-piece':'black-piece'}`));
    cell.dataset.square=square.square;
    if(typeof wsPaintPiece==='function')wsPaintPiece(cell.firstChild,square.piece);
    cell.title=square.square;board.append(cell);
  }
  board.setAttribute('aria-label',`Opening tree position. ${result.fen}`);
  const perspective=$('wbTreePerspective').value,shown=wbTreeRows(result,$('wbTreeSort').value,$('wbTreeMinimum').value,perspective);
  $('wbTreeStatus').textContent+=` · ${shown.length}/${result.moves.length} continuations shown`;
  for(const move of shown) {
    const row=wbElement('div',undefined,'wb-tree-row');row.dataset.san=move.san;
    const both=wbElement('small',move.white_score==null?'No finished-game score':`White ${(move.white_score*100).toFixed(1)}% · Black ${((1-move.white_score)*100).toFixed(1)}%`,'hint ws-both-scores');both.hidden=true;
    const next={fen:move.fen,variant:result.variant,label:move.san,uci:move.move_uci,comment:`Reference sample: ${move.games} games; White wins ${move.white_wins}, draws ${move.draws}, Black wins ${move.black_wins}, unfinished ${move.unfinished}.`};
    row.append(wbButton(move.san,()=>wbTreeLoad([...wbTree.path,next],wbTree.filters)));
    const percent=result.games?move.games/result.games*100:0;
    const rawScore=wbTreeScore(move,perspective,result.fen),score=rawScore==null?'—':`${(rawScore*100).toFixed(1)}%`;
    const side=perspective==='black' || (perspective==='turn' && result.fen.split(' ')[1]==='b')?'Black':'White';
    row.append(wbElement('span',`${move.games} games · ${percent.toFixed(1)}% · ${side} score ${score}`));
    const bar=wbElement('div',undefined,'wb-result-bar');bar.setAttribute('role','img');
    bar.setAttribute('aria-label',`${move.white_wins} White wins, ${move.draws} draws, ${move.black_wins} Black wins, ${move.unfinished} unfinished`);
    for(const [key,label] of [['white_wins','white'],['draws','draw'],['black_wins','black'],['unfinished','unfinished']]) {
      const segment=wbElement('span',undefined,`wb-result-${label}`);segment.style.width=`${move[key]/move.games*100}%`;bar.append(segment);
    }
    bar.title=bar.getAttribute('aria-label');row.append(bar);
    row.append(wbElement('small',`Average Elo ${move.average_elo==null?'—':Math.round(move.average_elo)} · Latest ${move.latest_year || 'unknown'}`,'hint'));
    if(result.variant==='standard') {
      const save=wbButton('Save to book',()=>wbTreeSaveBook(result.fen,move.move_uci));save.classList.add('wb-tree-book-save');row.append(save);
    }
    const example=wbButton('Preview example',()=>wbPreviewExample(move.example_id,result.fen,move.move_uci));example.classList.add('wb-tree-example');row.append(example);
    row.append(both);target.append(row);
  }
  if(typeof wsTreeTools==='function')wsTreeTools();
  if(typeof wsAnimateBoard==='function')wsAnimateBoard(board,result.fen,typeof wsTreeFlipped!=='undefined' && wsTreeFlipped);
  if(!shown.length)target.append(wbElement('p',result.moves.length?'No continuations meet the minimum-game count.':'No recorded continuations for these filters.','hint'));
}
async function wbTreeSaveBook(fen,move) {
  const profile=state?.engine_profile || 'default';
  const result=await api('/api/opening-book',{action:'ensure',fen,move,weight:10,profile,variant:'standard'});
  $('wbTreeStatus').textContent=result.saved?`Move saved to the ${profile} opening book.`:`Move already exists in the ${profile} opening book; its settings were retained.`;
}
function wbTreeStart() {
  return wbTreeLoad([{fen:STARTING_FEN,variant:'standard',label:'Start'}]);
}
function bindDatabaseExplorer() {
  const on=(id,callback)=>$(id).addEventListener('click',()=>wbAction(callback,$(id)));
  on('wbTreeStart',wbTreeStart);
  on('wbTreeCsv',wbTreeExportCsv);on('wbTreePgn',wbTreeExportPgn);
  for(const id of ['wbTreeSort','wbTreeMinimum','wbTreePerspective'])$(id).addEventListener('change',()=>{if(wbTree.result)wbTreeRender();});
  on('wbTreePreview',()=>{const preview=wbRequirePreview();return wbTreeLoad([{fen:preview.positions[wb.ply].fen,variant:preview.game.variant,label:`Preview ply ${wb.ply}`}]);});
  on('wbTreeBack',()=>wbTree.path.length>1 && wbTreeLoad(wbTree.path.slice(0,-1),wbTree.filters));
  on('wbTreeRefresh',()=>wbTree.path.length?wbTreeLoad(wbTree.path):wbTreeStart());
  on('wbTreeGames',()=>wbTree.result && wbChooseCollection({...wbTree.filters,fen:wbTree.result.fen,variant:wbTree.result.variant}));
  on('wbTreeCopy',async()=>{if(wbTree.result){await navigator.clipboard.writeText(wbTree.result.fen);$('wbTreeStatus').textContent='Opening tree FEN copied.';}});
  $('wbOpeningTree').addEventListener('toggle',()=>{if($('wbOpeningTree').open && !wbTree.result)wbAction(wbTreeStart);});
}
bindDatabaseExplorer();
