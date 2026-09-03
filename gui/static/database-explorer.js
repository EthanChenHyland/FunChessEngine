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
function wbTreeRender() {
  const result=wbTree.result,target=$('wbTreeMoves');target.replaceChildren();
  $('wbTreePath').textContent=`${result.variant==='chess960'?'Chess960':'Standard'} · ${wbTree.path.map(position=>position.label).join(' → ')}`;
  $('wbTreeStatus').textContent=`${result.games.toLocaleString()} matching games · ${result.ended.toLocaleString()} end at this position`;
  wbDisabled('wbTreeBack',wbTree.path.length<2);wbDisabled('wbTreeGames',false);wbDisabled('wbTreeCopy',false);
  const board=$('wbTreeBoard');board.replaceChildren();
  for(const square of wbBoardSquares(result.fen)) {
    const cell=wbElement('div',undefined,`wb-square ${square.dark?'dark':'light'}`);
    cell.append(wbElement('span',PIECES[square.piece] || '',`wb-piece ${square.piece===square.piece.toUpperCase()?'white-piece':'black-piece'}`));
    cell.title=square.square;board.append(cell);
  }
  board.setAttribute('aria-label',`Opening tree position. ${result.fen}`);
  for(const move of result.moves) {
    const row=wbElement('div',undefined,'wb-tree-row');
    const next={fen:move.fen,variant:result.variant,label:move.san};
    row.append(wbButton(move.san,()=>wbTreeLoad([...wbTree.path,next],wbTree.filters)));
    const percent=result.games?move.games/result.games*100:0;
    const score=move.white_score==null?'—':`${(move.white_score*100).toFixed(1)}%`;
    row.append(wbElement('span',`${move.games} games · ${percent.toFixed(1)}% · White score ${score}`));
    const bar=wbElement('div',undefined,'wb-result-bar');bar.setAttribute('role','img');
    bar.setAttribute('aria-label',`${move.white_wins} White wins, ${move.draws} draws, ${move.black_wins} Black wins, ${move.unfinished} unfinished`);
    for(const [key,label] of [['white_wins','white'],['draws','draw'],['black_wins','black'],['unfinished','unfinished']]) {
      const segment=wbElement('span',undefined,`wb-result-${label}`);segment.style.width=`${move[key]/move.games*100}%`;bar.append(segment);
    }
    bar.title=bar.getAttribute('aria-label');row.append(bar);
    row.append(wbElement('small',`Average Elo ${move.average_elo==null?'—':Math.round(move.average_elo)} · Latest ${move.latest_year || 'unknown'}`,'hint'));
    target.append(row);
  }
  if(!result.moves.length)target.append(wbElement('p','No recorded continuations for these filters.','hint'));
}
function wbTreeStart() {
  return wbTreeLoad([{fen:STARTING_FEN,variant:'standard',label:'Start'}]);
}
function bindDatabaseExplorer() {
  const on=(id,callback)=>$(id).addEventListener('click',()=>wbAction(callback,$(id)));
  on('wbTreeStart',wbTreeStart);
  on('wbTreePreview',()=>{const preview=wbRequirePreview();return wbTreeLoad([{fen:preview.positions[wb.ply].fen,variant:preview.game.variant,label:`Preview ply ${wb.ply}`}]);});
  on('wbTreeBack',()=>wbTree.path.length>1 && wbTreeLoad(wbTree.path.slice(0,-1),wbTree.filters));
  on('wbTreeRefresh',()=>wbTree.path.length?wbTreeLoad(wbTree.path):wbTreeStart());
  on('wbTreeGames',()=>wbTree.result && wbChooseCollection({...wbTree.filters,fen:wbTree.result.fen,variant:wbTree.result.variant}));
  on('wbTreeCopy',async()=>{if(wbTree.result){await navigator.clipboard.writeText(wbTree.result.fen);$('wbTreeStatus').textContent='Opening tree FEN copied.';}});
  $('wbOpeningTree').addEventListener('toggle',()=>{if($('wbOpeningTree').open && !wbTree.result)wbAction(wbTreeStart);});
}
bindDatabaseExplorer();
