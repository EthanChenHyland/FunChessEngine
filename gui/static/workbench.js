// Reference database workspace. Its preview never writes to the live session.
const wb = {games:[], selected:new Set(), offset:0, limit:25, total:0, sort:'date', direction:'desc', filters:{}, views:[], preview:null, ply:0, flipped:false, timer:null, sequence:0, previewSequence:0, report:null, notesDirty:false, headersDirty:false};
const WB_FILTERS = [
  ['white','White player'],['black','Black player'],['event','Event'],['site','Site'],
  ['eco','ECO prefix'],['opening','Opening name'],['source','Import source'],['folder','Collection folder'],
  ['tag','Tag'],['notes','Private note text'],['annotation','PGN text / annotations'],
  ['year_from','From year','number'],['year_to','Through year','number'],
  ['min_elo','Minimum rating','number'],['max_elo','Maximum rating','number'],
  ['min_plies','Minimum plies','number'],['max_plies','Maximum plies','number'],
];
const WB_HEADERS = ['Event','Site','Date','Round','White','Black','WhiteElo','BlackElo','Result','ECO','Opening'];
function wbElement(tag, text, className) {
  const element=document.createElement(tag);
  if(text !== undefined) element.textContent=String(text);
  if(className) element.className=className;
  return element;
}
function wbStatus(message, error=false) {
  $('wbStatus').textContent=message;
  $('wbStatus').classList.toggle('error',error);
  if(error && !$('databaseWorkbench').open)setStatus(message,'error');
}
async function wbApi(action,payload={}) { return api('/api/library-workbench',{...payload,action}); }
function wbButton(text,callback,className='secondary compact') {
  const button=wbElement('button',text,className);
  button.type='button';
  button.addEventListener('click',()=>wbAction(callback,button));
  return button;
}
async function wbAction(callback,button=null) {
  if(button) button.disabled=true;
  try { await callback(); }
  catch(error) { wbStatus(error.message,true); }
  finally { if(button) button.disabled=button.dataset.wbDisabled==='true'; }
}
async function openDatabaseWorkbench() {
  if(state && !state.paused && !state.game_over) {
    const paused=await act(()=>api('/api/pause',{paused:true}),'Live game paused for database browsing.');
    if(!paused) return;
  }
  if(!$('databaseWorkbench').open) $('databaseWorkbench').showModal();
  $('wbPlayer').focus();
  await wbAction(async()=>{await wbLoadViews(); await wbLoadCollections(); await wbSearch();});
}
function wbFilters() {
  const filters={};
  for(const [key] of WB_FILTERS) {
    const value=$(`wbFilter-${key}`).value.trim();
    if(value) filters[key]=value;
  }
  if($('wbPlayer').value.trim()) filters.player=$('wbPlayer').value.trim();
  if($('wbResult').value) filters.result=$('wbResult').value;
  if($('wbUnfiled').checked) filters.unfiled=true;
  if($('wbExactFolder').checked) {filters.folder_exact=true;filters.folder=$('wbFilter-folder').value.trim();}
  if($('wbFavorites').checked) filters.favorite=true;
  if($('wbDuplicates').checked) filters.duplicates=true;
  if($('wbPositionFilter').checked) filters.fen=wb.filters.fen || currentBoardView()?.fen || STARTING_FEN;
  return filters;
}
function wbApplyFilters(filters) {
  for(const [key] of WB_FILTERS) $(`wbFilter-${key}`).value=filters[key] ?? '';
  $('wbPlayer').value=filters.player || '';
  $('wbResult').value=filters.result || '';
  $('wbFavorites').checked=Boolean(filters.favorite);
  $('wbUnfiled').checked=Boolean(filters.unfiled);
  $('wbExactFolder').checked=Boolean(filters.folder_exact);
  $('wbDuplicates').checked=Boolean(filters.duplicates);
  $('wbPositionFilter').checked=Boolean(filters.fen);
  wb.filters={...filters};
  $('wbFilterFields').closest('details').open=Object.keys(filters).some(key=>key!=='player');
}
async function wbSearch(reset=true) {
  const sequence=++wb.sequence;
  wb.filters=wbFilters();
  if(reset) wb.offset=0;
  wbStatus('Searching reference games…');
  let result;
  try {result=await wbApi('search',{filters:wb.filters,sort:wb.sort,direction:wb.direction,limit:Number($('wbPageSize').value),offset:wb.offset});}
  catch(error) {if(sequence===wb.sequence)throw error;return;}
  if(sequence!==wb.sequence) return;
  Object.assign(wb,{games:result.games,total:result.total,offset:result.offset,limit:result.limit});
  wbRenderRows();
  wbStatus(result.total ? `${result.total.toLocaleString()} matching games. Select a White player name to preview a game.` : 'No matches. Import a reference PGN or reset the filters.');
}
function wbSetSelection(id,selected) {
  if(selected && !wb.selected.has(id) && wb.selected.size>=500) throw new Error('Selection is limited to 500 games. Export or clear the current selection first.');
  if(selected) wb.selected.add(id); else wb.selected.delete(id);
}
function wbDisabled(id,value) {$(id).disabled=value;$(id).dataset.wbDisabled=String(value);}
function wbRenderRows() {
  const target=$('wbRows'); target.replaceChildren();
  for(const game of wb.games) {
    const row=wbElement('tr'); row.classList.toggle('selected',wb.preview?.game.id===game.id);
    const select=wbElement('input'); select.type='checkbox'; select.checked=wb.selected.has(game.id);
    select.setAttribute('aria-label',`Select ${game.white} versus ${game.black}`);
    select.addEventListener('change',()=>{try{wbSetSelection(game.id,select.checked);}catch(error){select.checked=false;wbStatus(error.message,true);}wbSelectionStatus();});
    const cell=wbElement('td');cell.append(select);row.append(cell);
    const favorite=wbElement('td');
    favorite.append(wbButton(game.favorite?'★':'☆',async()=>{await wbApi('organize',{ids:[game.id],changes:{favorite:!game.favorite}});await wbLoadCollections();await wbSearch(false);},'wb-star'));
    favorite.firstChild.setAttribute('aria-label',game.favorite?'Remove favorite':'Favorite game');row.append(favorite);
    for(const key of ['white','black','result','rating','game_date','eco','event','plies','folder']) {
      const td=wbElement('td');
      if(key==='white') td.append(wbButton(game.white || 'White',()=>wbPreview(game.id),'wb-link'));
      else if(key==='black') td.textContent=game.black || 'Black';
      else if(key==='rating') td.textContent=[game.white_elo ?? '—',game.black_elo ?? '—'].join(' / ');
      else if(key==='folder') td.textContent=[game.folder,...game.tags].filter(Boolean).join(' · ');
      else td.textContent=game[key] ?? '—';
      td.title=td.textContent;row.append(td);
    }
    row.addEventListener('dblclick',()=>wbAction(()=>wbPreview(game.id)));
    target.append(row);
  }
  if(!wb.games.length) {const row=wbElement('tr'), cell=wbElement('td','No matching reference games.');cell.colSpan=11;row.append(cell);target.append(row);}
  $('wbCount').textContent=`${wb.total.toLocaleString()} games`;
  $('wbActiveFilters').textContent=Object.keys(wb.filters).length?` · ${Object.keys(wb.filters).length} active`:'';
  $('wbPageLabel').textContent=`Page ${Math.floor(wb.offset/wb.limit)+1} of ${Math.max(1,Math.ceil(wb.total/wb.limit))}`;
  wbDisabled('wbPrevious',wb.offset===0);wbDisabled('wbNext',wb.offset+wb.limit>=wb.total);
  document.querySelectorAll('[data-wb-sort]').forEach(button=>{button.parentElement.setAttribute('aria-sort',button.dataset.wbSort===wb.sort?(wb.direction==='asc'?'ascending':'descending'):'none');});
  wbSelectionStatus();
}
function wbSelectionStatus() {
  $('wbSelectedCount').textContent=`${wb.selected.size} selected`;
  const count=wb.games.filter(game=>wb.selected.has(game.id)).length;
  $('wbSelectPage').checked=Boolean(wb.games.length && count===wb.games.length);
  $('wbSelectPage').indeterminate=count>0 && count<wb.games.length;
}
async function wbDiscardEdits() {
  if(!wb.notesDirty && !wb.headersDirty) return true;
  if(!wb.discardPending)wb.discardPending=confirmAction('Discard unsaved edits?','There are unsaved game notes or header edits in this preview.','Discard edits',true);
  try {return await wb.discardPending;} finally {wb.discardPending=null;}
}
function wbCloseWorkspace() {
  ++wb.previewSequence;
  if(wb.preview) {
    $('wbNotes').value=wb.preview.game.notes || '';
    for(const header of WB_HEADERS) $(`wbHeader-${header}`).value=wb.preview.headers[header] || '';
  }
  wb.notesDirty=false;wb.headersDirty=false;
  $('databaseWorkbench').close();wbStop();
}
async function wbStudyPosition() {
  const preview=wbRequirePreview();
  if(busy || setupMode || trainerMode || retryMode) throw new Error('Exit the current board workspace before creating a study.');
  if(!await wbDiscardEdits()) return;
  const fen=preview.positions[wb.ply].fen;
  const snapshot=await api('/api/position',{fen,chess960:preview.game.variant==='chess960'});
  if(variationMode) saveCurrentVariationWorkspace();
  wbCloseWorkspace();
  if(launcherVisible()) await enterWorkbench('engine',false);
  else await activateTab(document.querySelector('[data-tab="engine"]'));
  if(reviewMode) await exitReviewMode(false);
  const root=newVariationNode(snapshot),key=`database-study:${preview.game.id}:${wb.ply}:${Date.now()}`;
  variationWorkspace={root:root.id,origin_ply:0,storage_key:key,kind:'study',name:`${preview.game.white} – ${preview.game.black} · ply ${wb.ply}`.slice(0,80),nodes:{[root.id]:root},edges:{}};
  variationNodeId=root.id;variationMode=true;selected=null;
  saveCurrentVariationWorkspace();render();scheduleAutoPositionAnalysis(true);
  setStatus('Created a study from the preview position.','success');
}
function wbStop() {clearInterval(wb.timer);wb.timer=null;$('wbAutoplay').textContent='Play';}
function wbEditorState() {
  return JSON.stringify([wb.preview?.game.id,$('wbNotes').value,...WB_HEADERS.map(header=>$(`wbHeader-${header}`).value)]);
}
function wbPreviewHeading() {
  const game=wb.preview.game;
  $('wbGameTitle').textContent=`${game.white || 'White'} — ${game.black || 'Black'}`;
  $('wbGameMeta').textContent=[game.event,game.game_date,game.result,game.opening].filter(Boolean).join(' · ');
}
async function wbPreview(id) {
  const sequence=++wb.previewSequence;
  if(!await wbDiscardEdits() || sequence!==wb.previewSequence) return false;
  wbStop();const editorState=wbEditorState();
  let result;
  try {result=await wbApi('preview',{id});}
  catch(error) {if(sequence===wb.previewSequence)throw error;return false;}
  if(sequence!==wb.previewSequence) return false;
  if(editorState!==wbEditorState() && !await wbDiscardEdits()) return false;
  if(sequence!==wb.previewSequence) return false;
  wb.preview=result;wb.ply=0;
  wb.notesDirty=false;wb.headersDirty=false;
  wbPreviewHeading();
  $('wbNotes').value=result.game.notes || '';
  for(const header of WB_HEADERS) $(`wbHeader-${header}`).value=result.headers[header] || '';
  $('wbDossierPlayer').value=result.game.white || '';
  wbRenderPreview();wbRenderRows();
  return true;
}
async function wbSaveNotes() {
  const preview=wbRequirePreview(),notes=$('wbNotes').value;
  await wbApi('organize',{ids:[preview.game.id],changes:{notes},expected_notes:preview.game.notes || ''});
  preview.game.notes=notes;
  if(wb.preview===preview) wb.notesDirty=$('wbNotes').value!==notes;
  await wbLoadCollections();
  wbStatus(`Notes saved for ${preview.game.white || 'White'} — ${preview.game.black || 'Black'}.`);
}
async function wbSaveHeaders() {
  const preview=wbRequirePreview();
  const submitted=Object.fromEntries(WB_HEADERS.map(header=>[header,$(`wbHeader-${header}`).value]));
  const headers=Object.fromEntries(Object.entries(submitted).filter(([key,value])=>value!==(preview.headers[key] || '')));
  if(!Object.keys(headers).length){wb.headersDirty=false;wbStatus('Headers are already saved.');return;}
  const result=await wbApi('headers',{id:preview.game.id,revision:preview.revision,headers});
  preview.headers=result.headers;preview.revision=result.revision;
  Object.assign(preview.game,result.metadata,{pgn:result.pgn});
  if(wb.preview===preview) {
    for(const header of WB_HEADERS) {
      const input=$(`wbHeader-${header}`);
      if(input.value===submitted[header])input.value=result.headers[header] || '';
    }
    wb.headersDirty=WB_HEADERS.some(header=>$(`wbHeader-${header}`).value!==(result.headers[header] || ''));
    wbPreviewHeading();
  }
  await wbSearch(false);
  wbStatus('Headers saved; PGN comments and variations retained.');
}
function wbBoardSquares(fen,flipped=false) {
  const map={};
  fen.split(' ')[0].split('/').forEach((rank,row)=>{let file=0;for(const piece of rank){if(/[1-8]/.test(piece)) file+=Number(piece);else {map[`${'abcdefgh'[file]}${8-row}`]=piece;file++;}}});
  const squares=[];
  for(let row=0;row<8;row++) for(let col=0;col<8;col++) {
    const file=flipped?7-col:col,rank=flipped?row+1:8-row;
    const square=`${'abcdefgh'[file]}${rank}`;
    squares.push({square,piece:map[square] || '',dark:(file+rank)%2===1,row,col});
  }
  return squares;
}
function wbRenderPreview() {
  const target=$('wbBoard');target.replaceChildren();
  const current=wb.preview?.positions[wb.ply];
  for(const square of wbBoardSquares(current?.fen || STARTING_FEN,wb.flipped)) {
    const cell=wbElement('div',undefined,`wb-square ${square.dark?'dark':'light'}`);
    const piece=wbElement('span',PIECES[square.piece] || '',`wb-piece ${square.piece===square.piece.toUpperCase()?'white-piece':'black-piece'}`);
    cell.append(piece);
    if(current?.uci?.slice(0,2)===square.square || current?.uci?.slice(2,4)===square.square) cell.classList.add('last-move');
    if($('wbCoordinates').checked && (square.row===7 || square.col===0)) cell.append(wbElement('small',square.square));
    cell.title=square.square+(square.piece?` ${pieceName(square.piece)}`:' empty');target.append(cell);
  }
  target.setAttribute('aria-label',current?`Preview position after ${current.label || 'start'}. ${current.fen}`:'Starting chess position');
  const last=(wb.preview?.positions.length || 1)-1;
  $('wbPly').max=last;$('wbPly').value=wb.ply;
  for(const id of ['wbFirst','wbBack'])wbDisabled(id,wb.ply===0);
  for(const id of ['wbLast','wbForward'])wbDisabled(id,wb.ply===last);
  wbDisabled('wbAutoplay',!last);
  $('wbPositionMeta').textContent=current?`${wb.ply}/${last} plies · ${current.fen.split(' ')[1]==='w'?'White':'Black'} to move${current.check?' · Check':''}${current.clock!=null?` · Recorded clock ${current.clock.toFixed(1)}s`:''}`:'Choose a game from the table.';
  $('wbComment').textContent=current?[current.comment,(current.nags || []).map(n=>({1:'!',2:'?',3:'!!',4:'??',5:'!?',6:'?!'}[n] || `$${n}`)).join(' '),current.alternatives?`${current.alternatives} alternative variation(s) preserved in PGN`:''].filter(Boolean).join('\n'):'';
  const moves=$('wbMoves');moves.replaceChildren();
  wb.preview?.positions.forEach((position,ply)=>{
    const button=wbButton(position.label || 'Start',()=>{wbStop();wb.ply=ply;wbRenderPreview();},'wb-move');
    button.classList.toggle('active',ply===wb.ply);button.setAttribute('aria-current',ply===wb.ply?'step':'false');moves.append(button);
  });
  const active=moves.querySelector('.active');
  if(active) moves.scrollTop=active.offsetTop-moves.offsetTop-moves.clientHeight/2;
}
function wbStep(delta) {if(!wb.preview)return;wb.ply=Math.max(0,Math.min(wb.preview.positions.length-1,wb.ply+delta));wbRenderPreview();}
function wbPlay() {
  if(wb.timer){wbStop();return;}
  if(!wb.preview || wb.preview.positions.length<2) return;
  if(wb.ply===wb.preview.positions.length-1) wb.ply=0;
  $('wbAutoplay').textContent='Pause';
  wb.timer=setInterval(()=>{wbStep(1);if(wb.ply===wb.preview.positions.length-1)wbStop();},Number($('wbSpeed').value));
}
function wbRequirePreview() {if(!wb.preview) throw new Error('Select a game to preview first.');return wb.preview;}
async function wbOrganize(changes,options={}) {
  const result=await wbApi('organize',{ids:[...wb.selected],changes,...options});
  await wbLoadCollections();await wbSearch(false);wbStatus(`Updated ${result.updated} selected games.`);
}
async function wbChooseCollection(filters) {
  wbApplyFilters(filters);$('wbViews').value='';await wbSearch();
}
async function wbLoadCollections() {
  const sequence=wb.collectionsSequence=(wb.collectionsSequence || 0)+1;
  const result=await wbApi('collections');
  if(sequence!==wb.collectionsSequence)return;
  const target=$('wbCollections');target.replaceChildren();
  for(const [label,count,filters] of [['All games',result.games,{}],['Favorites',result.favorites,{favorite:true}],['Unfiled',result.unfiled,{unfiled:true}]]) {
    target.append(wbButton(`${label} · ${count}`,()=>wbChooseCollection(filters)));
  }
  for(const [label,rows,key] of [['Folders',result.folders,'folder'],['Tags',result.tags,'tag']]) {
    const group=wbElement('div',undefined,'wb-collection-group');group.append(wbElement('strong',label));
    for(const row of rows)group.append(wbButton(`${row.name} · ${row.games}`,()=>wbChooseCollection({[key]:row.name,...(key==='folder'?{folder_exact:true}:{})})));
    if(!rows.length)group.append(wbElement('span',`No ${label.toLowerCase()} yet. Use Selected games to organize your library.`,'hint'));
    target.append(group);
  }
  const history=$('wbUndoHistory');history.replaceChildren();
  for(const edit of result.undo) {
    const row=wbElement('div',undefined,'wb-undo-row');
    row.append(wbElement('span',edit.label),wbButton('Undo',()=>wbUndo(edit.id)));
    row.title=new Date(edit.created_at*1000).toLocaleString();history.append(row);
  }
  if(!result.undo.length)history.append(wbElement('p','No recent organization edits.','hint'));
}
async function wbUndo(id) {
  const result=await wbApi('undo',{id});
  const preview=wb.preview;
  if(preview && result.ids.includes(preview.game.id)) {
    const fresh=await wbApi('preview',{id:preview.game.id});
    if(wb.preview===preview) {
      for(const key of ['favorite','folder','tags','notes'])preview.game[key]=fresh.game[key];
      if(!wb.notesDirty)$('wbNotes').value=preview.game.notes || '';
      wb.notesDirty=$('wbNotes').value!==(preview.game.notes || '');
    }
  }
  await wbLoadCollections();await wbSearch(false);wbStatus(`Undid organization changes for ${result.restored} game(s).`);
}
async function wbLoadViews() {
  const result=await wbApi('views');wb.views=result.views;
  const select=$('wbViews');select.replaceChildren(new Option('Choose a saved search…',''));
  wb.views.forEach(view=>select.add(new Option(view.name,view.name)));
}
function wbCsvCell(value) {
  let text=String(value ?? '');
  if(/^[\s]*[=+\-@]/.test(text))text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
}
async function wbExportCsv() {
  const columns=['white','black','white_elo','black_elo','result','game_date','event','site','eco','opening','plies','folder','tags'];
  const rows=[columns,...wb.games.map(game=>columns.map(column=>Array.isArray(game[column])?game[column].join('; '):game[column]))];
  await downloadBlob(new Blob(['\ufeff'+rows.map(row=>row.map(wbCsvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),'FunChessEngine-database-page.csv');
}
function wbScoresheetHtml(preview) {
  const header=Object.entries(preview.headers).map(([key,value])=>`<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('');
  const moves=preview.positions.slice(1).map(position=>`<span><b>${escapeHtml(position.label)}</b> ${escapeHtml(position.comment || '')}</span>`).join(' ');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Game scoresheet</title><style>body{font:16px Georgia,serif;max-width:850px;margin:40px auto;padding:20px;color:#111}dl{display:grid;grid-template-columns:100px 1fr;gap:5px}dd{margin:0}article{line-height:2}article span{display:inline-block;margin-right:8px}footer{margin-top:30px}@media print{body{margin:0}}</style><h1>${escapeHtml(preview.game.white)} — ${escapeHtml(preview.game.black)}</h1><dl>${header}</dl><article>${moves}</article><footer>${escapeHtml(preview.game.result)} · Exported from FunChessEngine</footer></html>`;
}
async function wbBuildReport() {
  const result=await wbApi('report',{filters:wbFilters(),player:$('wbDossierPlayer').value,opponent:$('wbOpponent').value});
  wb.report=result;$('wbExportReport').disabled=false;
  const target=$('wbReportResults');target.replaceChildren();
  const total=result.overall;
  target.append(reportRow('Filtered database',`${total.games} games · White wins ${total.white_wins || 0} · Draws ${total.draws || 0} · Black wins ${total.black_wins || 0} · Unfinished ${total.unfinished || 0}`));
  for(const row of result.dossier) {
    const finished=(row.wins || 0)+(row.draws || 0)+(row.losses || 0);
    const score=finished?`${(((row.wins || 0)+(row.draws || 0)/2)/finished*100).toFixed(1)}%`:'—';
    target.append(reportRow(`${result.player} as ${row.side}${result.opponent?' vs '+result.opponent:''}`,`${row.games} games · +${row.wins || 0} =${row.draws || 0} −${row.losses || 0} · Score ${score} · Peak recorded Elo ${row.peak_rating || '—'}`));
  }
  target.append(wbElement('h4','Opening distribution'));
  for(const row of result.openings) {
    const count=row.white_wins+row.black_wins+row.draws;
    const score=count?((row.white_wins+row.draws/2)/count*100).toFixed(1)+'%':'—';
    const line=reportRow(row.eco,`${row.games} games · White score ${score}`);
    if(row.eco!=='Unclassified')line.append(wbButton('Filter opening',async()=>{$('wbFilter-eco').value=row.eco;await wbSearch();}));
    target.append(line);
  }
  target.append(wbElement('h4','Games by year'));
  const years=wbElement('div',undefined,'wb-year-bars'),maximum=Math.max(1,...result.years.map(row=>row.games));
  for(const row of result.years) {
    const line=wbElement('div');line.append(wbElement('span',`${row.year || 'Unknown'} · ${row.games}`));
    const meter=wbElement('meter');meter.max=maximum;meter.value=row.games;meter.setAttribute('aria-label',`${row.year || 'Unknown year'}: ${row.games} games`);line.append(meter);years.append(line);
  }
  target.append(years);wbStatus('Report uses the current filters. Scores exclude unfinished games; player names are exact matches.');
}
function wbCompareLines(a,b) {
  if(a.positions[0].fen!==b.positions[0].fen) return {common:0,sameStart:false};
  let common=0;
  for(let ply=1;ply<Math.min(a.positions.length,b.positions.length);ply++) {
    if(a.positions[ply].uci!==b.positions[ply].uci)break;
    common=ply;
  }
  return {common,sameStart:true};
}
async function wbCompareSelected() {
  if(wb.selected.size!==2)throw new Error('Select exactly two games to compare.');
  const [a,b]=await Promise.all([...wb.selected].map(id=>wbApi('preview',{id})));
  const comparison=wbCompareLines(a,b),target=$('wbComparison');target.replaceChildren();target.hidden=false;
  target.append(wbElement('h3','Main-line comparison'));
  target.append(wbElement('p',comparison.sameStart?`${comparison.common} shared opening plies. ${comparison.common===a.positions.length-1 && comparison.common===b.positions.length-1?'Identical main lines.':'First divergence follows the shared moves.'}`:'These games start from different positions.'));
  for(const game of [a,b]) {
    const row=reportRow(`${game.game.white} — ${game.game.black}`,game.positions.slice(Math.max(1,comparison.common-2),comparison.common+9).map(p=>p.label).join(' '));
    row.append(wbButton('Preview divergence',async()=>{if(!await wbPreview(game.game.id))return;wb.ply=Math.min(comparison.common+1,wb.preview.positions.length-1);wbRenderPreview();}));target.append(row);
  }
}
function bindDatabaseWorkbench() {
  const filters=$('wbFilterFields');
  for(const [key,label,type='text'] of WB_FILTERS) {
    const wrapper=wbElement('label',label),input=wbElement('input');input.id=`wbFilter-${key}`;input.type=type;
    if(type==='number'){input.min='0';input.max='10000';}else input.maxLength=300;
    wrapper.append(input);filters.append(wrapper);
  }
  const resultLabel=wbElement('label','Result'),result=wbElement('select');result.id='wbResult';
  for(const [value,label] of [['','Any result'],['1-0','White wins'],['0-1','Black wins'],['1/2-1/2','Draw'],['*','Unfinished']])result.add(new Option(label,value));
  resultLabel.append(result);filters.append(resultLabel);
  for(const header of WB_HEADERS) {
    const label=wbElement('label',header),input=wbElement('input');input.id=`wbHeader-${header}`;input.maxLength=300;input.addEventListener('input',()=>wb.headersDirty=true);label.append(input);$('wbHeaderFields').append(label);
  }
  const on=(id,callback)=>$(id).addEventListener('click',()=>wbAction(callback,$(id)));
  on('openDatabaseBtn',openDatabaseWorkbench);on('databaseOpenBtn',openDatabaseWorkbench);
  on('wbClose',async()=>{if(await wbDiscardEdits())wbCloseWorkspace();});
  $('databaseWorkbench').addEventListener('cancel',event=>{event.preventDefault();$('wbClose').click();});
  $('databaseWorkbench').addEventListener('close',wbStop);
  on('wbImport',async()=>{if(!await wbDiscardEdits())return;wbCloseWorkspace();$('openingDatabaseInput').click();});
  $('wbSearchForm').addEventListener('submit',event=>{event.preventDefault();wbAction(()=>wbSearch());});
  on('wbReset',async()=>{wbApplyFilters({});$('wbViews').value='';await wbSearch();});
  $('wbPositionFilter').addEventListener('change',()=>{delete wb.filters.fen;});
  for(const button of document.querySelectorAll('[data-wb-sort]'))button.addEventListener('click',()=>wbAction(async()=>{wb.direction=wb.sort===button.dataset.wbSort && wb.direction==='asc'?'desc':'asc';wb.sort=button.dataset.wbSort;await wbSearch();}));
  on('wbPrevious',async()=>{wb.offset=Math.max(0,wb.offset-wb.limit);await wbSearch(false);});
  on('wbNext',async()=>{wb.offset+=wb.limit;await wbSearch(false);});
  $('wbPageSize').addEventListener('change',()=>wbAction(()=>wbSearch()));
  $('wbDensity').addEventListener('change',()=>{$('wbTable').classList.toggle('compact',$('wbDensity').value==='compact');});
  $('wbSelectPage').addEventListener('change',()=>{try{for(const game of wb.games)wbSetSelection(game.id,$('wbSelectPage').checked);}catch(error){wbStatus(error.message,true);}wbRenderRows();});
  on('wbClearSelection',()=>{wb.selected.clear();wbRenderRows();});
  on('wbFavoriteBatch',()=>wbOrganize({favorite:true}));on('wbUnfavoriteBatch',()=>wbOrganize({favorite:false}));
  on('wbMoveFolder',()=>wbOrganize({folder:$('wbFolder').value.trim()}));
  on('wbSetTags',()=>wbOrganize({tags:$('wbTags').value.split(',').map(s=>s.trim()).filter(Boolean)},{tag_mode:$('wbTagMode').value}));
  on('wbExport',async()=>{const result=await wbApi('export',{ids:[...wb.selected]});await downloadBlob(new Blob([result.pgn],{type:'application/x-chess-pgn'}),'FunChessEngine-selected-games.pgn');});
  on('wbCsv',wbExportCsv);on('wbCompare',wbCompareSelected);
  on('wbSaveView',async()=>{await wbApi('views',{view:{action:'save',name:$('wbViewName').value,filters:wbFilters()}});await wbLoadViews();wbStatus('Saved search stored with your reference database.');});
  on('wbDeleteView',async()=>{await wbApi('views',{view:{action:'delete',name:$('wbViews').value}});await wbLoadViews();});
  $('wbViews').addEventListener('change',()=>wbAction(async()=>{const view=wb.views.find(row=>row.name===$('wbViews').value);if(view){wbApplyFilters(view.filters);$('wbViewName').value=view.name;await wbSearch();}}));
  for(const [id,delta] of [['wbFirst',-10000],['wbBack',-1],['wbForward',1],['wbLast',10000]]) on(id,()=>{wbStop();wbStep(delta);});
  on('wbAutoplay',wbPlay);$('wbSpeed').addEventListener('change',()=>{if(wb.timer){wbStop();wbPlay();}});
  on('wbFlip',()=>{wb.flipped=!wb.flipped;wbRenderPreview();});$('wbCoordinates').addEventListener('change',wbRenderPreview);
  $('wbPly').addEventListener('input',()=>{wbStop();wb.ply=Number($('wbPly').value);wbRenderPreview();});
  on('wbCopyFen',async()=>{const preview=wbRequirePreview();await navigator.clipboard.writeText(preview.positions[wb.ply].fen);wbStatus('Preview FEN copied.');});
  on('wbCopyPgn',async()=>{await navigator.clipboard.writeText(wbRequirePreview().game.pgn);wbStatus('PGN copied with its annotations and variations.');});
  on('wbScoresheet',async()=>{await downloadBlob(new Blob([wbScoresheetHtml(wbRequirePreview())],{type:'text/html'}),'FunChessEngine-scoresheet.html');wbStatus('Open the exported scoresheet in your browser to print it.');});
  on('wbOpenAnalysis',async()=>{const preview=wbRequirePreview();if(!await wbDiscardEdits())return;wbCloseWorkspace();await loadPgnText(preview.game.pgn);});
  on('wbStudy',wbStudyPosition);
  $('wbNotes').addEventListener('input',()=>wb.notesDirty=true);
  on('wbSaveNotes',wbSaveNotes);on('wbSaveHeaders',wbSaveHeaders);
  on('wbGamesFromHere',()=>wbChooseCollection({fen:wbRequirePreview().positions[wb.ply].fen}));
  on('wbReport',wbBuildReport);on('wbExportReport',()=>exportJson(wb.report,'FunChessEngine-database-report.json'));
  $('databaseWorkbench').addEventListener('keydown',event=>{
    if(['INPUT','SELECT','TEXTAREA'].includes(event.target.tagName))return;
    const keys={ArrowLeft:-1,ArrowRight:1,Home:-10000,End:10000};
    if(event.key in keys){event.preventDefault();wbStop();wbStep(keys[event.key]);}
  });
  wbRenderPreview();
}
bindDatabaseWorkbench();
