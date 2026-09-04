// Database productivity controls; all board navigation stays inside the preview.
const WB_TABLE_COLUMNS=['result','rating','game_date','eco','event','plies','folder'];
const WB_TABLE_DEFAULTS={columns:[...WB_TABLE_COLUMNS],density:'comfortable',stickyPlayers:false,zebra:true,wrap:false};
const WB_TABLE_LAYOUT_KEY='funchess-workbench-table-v1';
const WB_SEARCH_HISTORY_KEY='funchess-workbench-search-history-v1';
const WB_SEARCH_KEYS=['player','white','black','event','site','eco','opening','source','folder','tag','notes','annotation','year_from','year_to','min_elo','max_elo','min_plies','max_plies','result','variant','missing','exact_players','unfiled','folder_exact','favorite','duplicates','fen'];
function wbSanitizeTablePrefs(raw) {
  const value=raw && typeof raw==='object'?raw:{},columns=Array.isArray(value.columns)?value.columns.filter((column,index,list)=>WB_TABLE_COLUMNS.includes(column) && list.indexOf(column)===index):[...WB_TABLE_DEFAULTS.columns];
  const density=['compact','comfortable','spacious'].includes(value.density)?value.density:WB_TABLE_DEFAULTS.density;
  return {columns,density,stickyPlayers:typeof value.stickyPlayers==='boolean'?value.stickyPlayers:WB_TABLE_DEFAULTS.stickyPlayers,zebra:typeof value.zebra==='boolean'?value.zebra:WB_TABLE_DEFAULTS.zebra,wrap:typeof value.wrap==='boolean'?value.wrap:WB_TABLE_DEFAULTS.wrap};
}
function wbTablePrefs() {try{return wbSanitizeTablePrefs(JSON.parse(localStorage.getItem(WB_TABLE_LAYOUT_KEY)));}catch{return wbSanitizeTablePrefs(null);}}
function wbSaveTablePrefs(prefs) {localStorage.setItem(WB_TABLE_LAYOUT_KEY,JSON.stringify(wbSanitizeTablePrefs(prefs)));wbApplyTablePrefs();}
function wbApplyTablePrefs() {
  const prefs=wbTablePrefs(),table=$('wbTable');table.dataset.wbStickyPlayers=String(prefs.stickyPlayers);table.dataset.wbZebra=String(prefs.zebra);table.dataset.wbWrap=String(prefs.wrap);table.dataset.wbDensity=prefs.density;
  for(const element of table.querySelectorAll('[data-wb-column]'))element.hidden=!prefs.columns.includes(element.dataset.wbColumn);
  for(const input of $('wbColumnChoices').querySelectorAll('[data-wb-table-column]'))input.checked=prefs.columns.includes(input.dataset.wbTableColumn);
  $('wbDensity').value=prefs.density;$('wbStickyPlayers').checked=prefs.stickyPlayers;$('wbZebraRows').checked=prefs.zebra;$('wbWrapCells').checked=prefs.wrap;
}
function wbSetTableColumns(columns) {wbSaveTablePrefs({...wbTablePrefs(),columns});}
function wbSanitizeSearchFilters(raw) {
  if(!raw || typeof raw!=='object' || Array.isArray(raw))return {};
  const result={};for(const key of WB_SEARCH_KEYS){const value=raw[key];if(typeof value==='boolean'){if(value)result[key]=true;}else if((typeof value==='string' || typeof value==='number') && String(value).trim())result[key]=String(value).trim().slice(0,300);}return result;
}
function wbSearchLabel(filters) {
  const names={player:'Player',white:'White',black:'Black',event:'Event',site:'Site',eco:'ECO',opening:'Opening',source:'Source',folder:'Folder',tag:'Tag',notes:'Notes',annotation:'PGN',year_from:'Since',year_to:'Through',min_elo:'Min Elo',max_elo:'Max Elo',min_plies:'Min plies',max_plies:'Max plies',result:'Result',variant:'Variant',missing:'Missing',exact_players:'Exact names',unfiled:'Unfiled',folder_exact:'Exact folder',favorite:'Favorites',duplicates:'Duplicates',fen:'Position'};
  const entries=Object.entries(filters);if(!entries.length)return 'All games';return entries.slice(0,4).map(([key,value])=>value===true?names[key] || key:key==='fen'?'Exact position':`${names[key] || key}: ${value}`).join(' · ')+(entries.length>4?` · +${entries.length-4}`:'');
}
function wbSearchHistory() {try{const rows=JSON.parse(localStorage.getItem(WB_SEARCH_HISTORY_KEY));return Array.isArray(rows)?rows.slice(0,10).map(row=>({filters:wbSanitizeSearchFilters(row?.filters),at:Number.isFinite(row?.at)?row.at:0})).filter(row=>Object.keys(row.filters).length):[];}catch{return [];}}
function wbRememberSearch(filters) {
  const clean=wbSanitizeSearchFilters(filters);if(!Object.keys(clean).length)return;const key=JSON.stringify(clean),rows=wbSearchHistory().filter(row=>JSON.stringify(row.filters)!==key);rows.unshift({filters:clean,at:Date.now()});localStorage.setItem(WB_SEARCH_HISTORY_KEY,JSON.stringify(rows.slice(0,10)));wbRenderSearchHistory();
}
function wbPageSnapshot(games,total,filters={}) {
  const results={'1-0':0,'1/2-1/2':0,'0-1':0,'*':0},ratings=[],years=[],ecos=new Map();let favorites=0;
  for(const game of games){results[game.result]===undefined?results['*']++:results[game.result]++;for(const rating of [game.white_elo,game.black_elo])if(Number.isFinite(Number(rating)) && Number(rating)>0)ratings.push(Number(rating));const year=Number(String(game.game_date || '').slice(0,4));if(Number.isInteger(year) && year>0)years.push(year);const eco=String(game.eco || 'Unclassified');ecos.set(eco,(ecos.get(eco) || 0)+1);if(game.favorite)favorites++;}
  const average=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
  return {pageGames:games.length,total,filters:wbSanitizeSearchFilters(filters),results,averageElo:average(ratings),averagePlies:average(games.map(game=>Number(game.plies) || 0)),yearFrom:years.length?Math.min(...years):null,yearTo:years.length?Math.max(...years):null,favorites,ecos:[...ecos].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,8)};
}
function wbSnapshotText(snapshot) {return `Database snapshot: ${snapshot.pageGames} loaded of ${snapshot.total} matches. Results +${snapshot.results['1-0']} =${snapshot.results['1/2-1/2']} -${snapshot.results['0-1']}; unfinished ${snapshot.results['*']}. Average Elo ${snapshot.averageElo==null?'—':Math.round(snapshot.averageElo)}; average ${snapshot.averagePlies==null?'—':snapshot.averagePlies.toFixed(1)} plies; years ${snapshot.yearFrom==null?'—':snapshot.yearFrom===snapshot.yearTo?snapshot.yearFrom:`${snapshot.yearFrom}–${snapshot.yearTo}`}; favorites ${snapshot.favorites}. Filters: ${wbSearchLabel(snapshot.filters)}.`;}
function wbRenderPageSnapshot() {
  const snapshot=wbPageSnapshot(wb.games,wb.total,wb.filters),grid=$('wbSnapshotGrid'),rows=[['Loaded',`${snapshot.pageGames} / ${snapshot.total}`],['Average Elo',snapshot.averageElo==null?'—':Math.round(snapshot.averageElo)],['Average plies',snapshot.averagePlies==null?'—':snapshot.averagePlies.toFixed(1)],['Years',snapshot.yearFrom==null?'—':snapshot.yearFrom===snapshot.yearTo?snapshot.yearFrom:`${snapshot.yearFrom}–${snapshot.yearTo}`],['Favorites',snapshot.favorites],['Top ECO',snapshot.ecos[0]?.[0] || '—']];grid.replaceChildren(...rows.map(([label,value])=>{const item=wbElement('div');item.append(wbElement('span',label),wbElement('strong',value));return item;}));
  const bar=$('wbSnapshotResults'),count=Math.max(1,snapshot.pageGames);bar.replaceChildren();for(const [key,label] of [['1-0','white'],['1/2-1/2','draw'],['0-1','black'],['*','unfinished']]){const segment=wbElement('span',undefined,`wb-result-${label}`);segment.style.width=`${snapshot.results[key]/count*100}%`;bar.append(segment);}bar.setAttribute('aria-label',`${snapshot.results['1-0']} White wins, ${snapshot.results['1/2-1/2']} draws, ${snapshot.results['0-1']} Black wins, ${snapshot.results['*']} unfinished`);
  const eco=$('wbSnapshotEco');eco.replaceChildren(...snapshot.ecos.map(([code,count])=>wbButton(`${code} · ${count}`,async()=>{const filters={...wb.filters,eco:code==='Unclassified'?'':code};delete filters.fen;wbApplyFilters(filters);await wbSearch();},'secondary compact')));$('wbExportSnapshot').disabled=!snapshot.pageGames;$('wbCopySnapshot').disabled=!snapshot.pageGames;wb.pageSnapshot=snapshot;
}
function wbRenderSearchHistory() {
  const target=$('wbSearchHistory'),rows=wbSearchHistory();target.replaceChildren();for(const [index,row] of rows.entries()){const item=wbElement('div',undefined,'wb-search-history-row'),apply=wbButton(wbSearchLabel(row.filters),async()=>{wbApplyFilters(row.filters);$('wbViews').value='';await wbSearch();},'text-button');apply.title=row.at?new Date(row.at).toLocaleString():'Saved search';item.append(apply,wbButton('Remove',()=>{const next=wbSearchHistory();next.splice(index,1);localStorage.setItem(WB_SEARCH_HISTORY_KEY,JSON.stringify(next));wbRenderSearchHistory();},'text-button compact'));target.append(item);}if(!rows.length)target.append(wbElement('p','Searches with active filters appear here.','hint'));
}
function wbPageOffset(page,total,limit) {
  if(!Number.isInteger(page) || page<1)throw new Error('Enter a whole page number starting at 1.');
  return (Math.min(page,Math.max(1,Math.ceil(total/limit)))-1)*limit;
}
function wbInvertSelection(selected,ids) {
  const next=new Set(selected);
  for(const id of ids) {if(next.has(id))next.delete(id);else next.add(id);}
  if(next.size>500)throw new Error('Selection is limited to 500 games. Clear some selections first.');
  return next;
}
async function wbSelectMatching() {
  if(wb.searching)return;
  const sequence=wb.sequence;
  const result=await wbApi('matching_ids',{filters:{...wb.filters}});
  if(sequence!==wb.sequence){wbStatus('Search changed while selecting. Select matches again.');return;}
  const next=new Set([...wb.selected,...result.ids]);
  if(next.size>500)throw new Error('These matches plus your selection exceed 500. Clear the selection first.');
  wb.selected=next;wbRenderRows();wbStatus(`Selected ${result.ids.length} matching games; ${next.size} selected in total.`);
}
function wbRenderProductivity() {
  const pages=Math.max(1,Math.ceil(wb.total/wb.limit));
  $('wbPageNumber').max=pages;$('wbPageNumber').value=Math.floor(wb.offset/wb.limit)+1;
  const loading=Boolean(wb.searching);
  wbDisabled('wbFirstPage',loading || wb.offset===0);wbDisabled('wbLastPage',loading || wb.offset+wb.limit>=wb.total);
  for(const id of ['wbGoPage','wbSelectMatching','wbInvertPage'])wbDisabled(id,loading);
  $('wbPageNumber').disabled=loading;
  const index=wb.games.findIndex(game=>game.id===wb.preview?.game.id);
  wbDisabled('wbPreviousGame',loading || index<=0);wbDisabled('wbNextGame',loading || !wb.games.length || index===wb.games.length-1);
  const target=$('wbFilterChips');target.replaceChildren();
  const names={player:'Player',favorite:'Favorites',duplicates:'Same main line',fen:'Matching position',folder_exact:'Exact folder',exact_players:'Exact player names',unfiled:'Unfiled',variant:'Variant',missing:'Missing metadata',...Object.fromEntries(WB_FILTERS.map(([key,label])=>[key,label]))};
  for(const [key,value] of Object.entries(wb.filters)) {
    if(value===false || value==null || value==='')continue;
    const label=value===true || key==='fen'?(names[key] || key):`${names[key] || key}: ${value}`;
    const button=wbButton(`${label} ×`,async()=>{const filters={...wb.filters};delete filters[key];wbApplyFilters(filters);$('wbViews').value='';await wbSearch();},'secondary compact');
    button.setAttribute('aria-label',`Remove ${label} filter`);target.append(button);
  }
  wbApplyTablePrefs();
  wbRenderPageSnapshot();
}
async function wbNextGame(delta) {
  if(wb.searching)return;
  const index=wb.games.findIndex(game=>game.id===wb.preview?.game.id),next=index+delta;
  if(next>=0 && next<wb.games.length)await wbPreview(wb.games[next].id);
}
function wbMaterialBalance(fen) {
  const values={p:1,n:3,b:3,r:5,q:9,k:0},counts={white:{},black:{}};let balance=0;
  for(const piece of fen.split(' ')[0]) {
    if(!(piece.toLowerCase() in values))continue;
    const white=piece===piece.toUpperCase(),side=white?'white':'black',kind=piece.toLowerCase();
    counts[side][kind]=(counts[side][kind] || 0)+1;balance+=(white?1:-1)*values[kind];
  }
  return {balance,counts};
}
function wbPositionKey(fen) {return String(fen || '').trim().split(/\s+/).slice(0,4).join(' ');}
function wbPositionPhase(fen,ply=0) {
  const pieces=[...String(fen).split(' ')[0]].filter(piece=>/[prnbqk]/i.test(piece)),queens=pieces.filter(piece=>piece.toLowerCase()==='q').length,nonPawns=pieces.filter(piece=>!/[pk]/i.test(piece)).length;
  return pieces.length<=10 || (!queens && nonPawns<=4)?'Endgame':ply<=20 && queens===2 && pieces.length>=24?'Opening':'Middlegame';
}
function wbMoveKinds(position) {
  const san=position?.san || '',kinds=[];if(san.includes('x'))kinds.push('capture');if(/[+#]$/.test(san))kinds.push('check');if(san.endsWith('#'))kinds.push('mate');if(san.includes('='))kinds.push('promotion');if(/^O-O/.test(san))kinds.push('castle');if(position?.comment?.trim() || position?.nags?.length)kinds.push('annotation');if(position?.alternatives)kinds.push('variation');return kinds;
}
function wbMoveFilterPlies(positions,kind) {
  if(kind==='critical')return wbCriticalPlies(positions);
  if(kind==='phase')return positions.flatMap((position,ply)=>ply && wbPositionPhase(position.fen,ply)!==wbPositionPhase(positions[ply-1].fen,ply-1)?[ply]:[]);
  return positions.flatMap((position,ply)=>ply && wbMoveKinds(position).includes(kind)?[ply]:[]);
}
function wbGameSummary(positions) {
  const all=positions.slice(1).flatMap(wbMoveKinds),counts=kind=>all.filter(value=>value===kind).length,keys=new Map();for(const position of positions)keys.set(wbPositionKey(position.fen),(keys.get(wbPositionKey(position.fen)) || 0)+1);
  return {moves:positions.length-1,captures:counts('capture'),checks:counts('check'),mates:counts('mate'),castles:counts('castle'),promotions:counts('promotion'),annotations:counts('annotation'),variations:counts('variation'),repetitions:[...keys.values()].reduce((total,count)=>total+Math.max(0,count-1),0)};
}
function wbPositionFacts(positions,ply) {
  const position=positions[ply],fields=position.fen.trim().split(/\s+/),board=fields[0] || '';
  const pieces=[...board].filter(piece=>/[prnbqk]/i.test(piece)),phase=wbPositionPhase(position.fen,ply);
  const key=wbPositionKey(position.fen),occurrences=positions.flatMap((row,index)=>wbPositionKey(row.fen)===key?[index]:[]),seen=occurrences.filter(index=>index<=ply).length;
  const traits=wbMoveKinds(position).map(kind=>({castle:'castling',annotation:position.comment?.trim()?'comment':'NAG',variation:'variations'}[kind] || kind));
  return {phase,pieces:pieces.length,side:fields[1]==='b'?'Black':'White',castling:fields[2]==='-'?'None':fields[2],enPassant:fields[3]==='-'?'None':fields[3],halfmove:Number(fields[4] || 0),fullmove:Number(fields[5] || 1),occurrences,seen,traits};
}
function wbCriticalPlies(positions) {return positions.flatMap((position,ply)=>ply && (/[x+#=]/.test(position.san || '') || /^O-O/.test(position.san || '') || position.comment?.trim() || position.nags?.length || position.alternatives)?[ply]:[]);}
function wbLineNotation(positions,ply) {
  if(typeof wsSanLine==='function')return wsSanLine(positions,ply);
  return positions.slice(1,ply+1).map(position=>position.label || position.san).filter(Boolean).join(' ');
}
function wbEpd(fen) {
  const fields=String(fen).trim().split(/\s+/);if(fields.length<4)throw new Error('This position does not contain a valid FEN.');
  return `${fields.slice(0,4).join(' ')} hmvc ${Number(fields[4] || 0)}; fmvn ${Number(fields[5] || 1)};`;
}
function wbPositionPayload(preview,ply) {
  const position=preview.positions[ply],facts=wbPositionFacts(preview.positions,ply);
  return {format:'FunChessEngine position',version:1,game:{id:preview.game.id,white:preview.game.white || '',black:preview.game.black || '',result:preview.game.result || '*',variant:preview.game.variant || 'standard'},ply,fen:position.fen,epd:wbEpd(position.fen),sanLine:wbLineNotation(preview.positions,ply),uciLine:preview.positions.slice(1,ply+1).map(row=>row.uci).filter(Boolean),phase:facts.phase,traits:facts.traits,repetitionCount:facts.seen};
}
function wbReferenceMetrics(result) {
  const finished=(result.moves || []).reduce((total,move)=>total+move.white_wins+move.draws+move.black_wins,0),white=(result.moves || []).reduce((total,move)=>total+move.white_wins,0),draws=(result.moves || []).reduce((total,move)=>total+move.draws,0),black=(result.moves || []).reduce((total,move)=>total+move.black_wins,0);
  return {games:result.games || 0,ended:result.ended || 0,continuations:(result.moves || []).length,finished,whiteScore:finished?(white+draws/2)/finished:null,white,draws,black};
}
async function wbLoadPositionReference() {
  const preview=wbRequirePreview(),position=preview.positions[wb.ply],sequence=wb.referenceSequence=(wb.referenceSequence || 0)+1,gameId=preview.game.id,ply=wb.ply,fen=position.fen,filters={...wb.filters};delete filters.fen;delete filters.variant;
  $('wbReferenceStatus').textContent='Loading exact-position statistics…';$('wbReferenceMoves').replaceChildren();
  const result=await wbApi('explorer',{fen,variant:preview.game.variant || 'standard',filters});
  if(sequence!==wb.referenceSequence || wb.preview?.game.id!==gameId || wb.ply!==ply || wb.preview.positions[ply].fen!==fen)return;
  wb.positionReference={fen,variant:preview.game.variant || 'standard',filters,result};wbRenderPositionReference();
}
function wbRenderPositionReference() {
  const target=$('wbReferenceMoves'),reference=wb.positionReference,current=wb.preview?.positions[wb.ply];target.replaceChildren();
  if(!reference || !current || wbPositionKey(reference.fen)!==wbPositionKey(current.fen)){$('wbReferenceStatus').textContent='Compare this exact position with the current database filters.';wbDisabled('wbReferenceTree',true);return;}
  const metrics=wbReferenceMetrics(reference.result),score=metrics.whiteScore==null?'—':`${(metrics.whiteScore*100).toFixed(1)}%`;$('wbReferenceStatus').textContent=`${metrics.games.toLocaleString()} games · ${metrics.ended.toLocaleString()} end here · White score ${score} · ${metrics.continuations} continuations`;wbDisabled('wbReferenceTree',false);
  for(const move of reference.result.moves.slice(0,8)) {
    const row=wbElement('div',undefined,'wb-reference-row'),percent=metrics.games?move.games/metrics.games*100:0,finished=move.white_wins+move.draws+move.black_wins,moveScore=finished?(move.white_wins+move.draws/2)/finished:null;
    const title=wbElement('div');title.append(wbElement('strong',move.san),wbElement('span',`${move.games} · ${percent.toFixed(1)}%`));row.append(title,wbElement('small',`White ${moveScore==null?'—':(moveScore*100).toFixed(1)+'%'} · Avg Elo ${move.average_elo==null?'—':Math.round(move.average_elo)} · Latest ${move.latest_year || '—'}`,'hint'));
    const actions=wbElement('div',undefined,'wb-actions');actions.append(wbButton('Example',()=>wbPreviewExample(move.example_id,reference.result.fen,move.move_uci),'text-button compact'));if(reference.variant==='standard' && typeof wbTreeSaveBook==='function')actions.append(wbButton('Save to book',()=>wbTreeSaveBook(reference.result.fen,move.move_uci),'text-button compact'));row.append(actions);target.append(row);
  }
  if(!reference.result.moves.length)target.append(wbElement('p','No continuations match these filters.','hint'));
}
function wbNotationMatches(positions,query) {
  const needle=query.trim().toLocaleLowerCase();
  if(!needle)return [];
  return positions.flatMap((position,ply)=>[position.label,position.san,position.comment].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle)?[ply]:[]);
}
function wbAnnotatedPlies(positions) {
  return positions.flatMap((position,ply)=>(position.comment?.trim() || position.nags?.length || position.alternatives)?[ply]:[]);
}
function wbNextMarked(plies,current,direction=1) {
  if(!plies.length)return null;
  return direction>0?(plies.find(ply=>ply>current) ?? plies[0]):(plies.findLast(ply=>ply<current) ?? plies.at(-1));
}
function wbRenderPreviewTools() {
  const preview=wb.preview,position=preview?.positions[wb.ply];
  if(position) {
    const {balance,counts}=wbMaterialBalance(position.fen);
    $('wbMaterial').textContent=balance===0?'Material: even':`Material: ${balance>0?'White':'Black'} +${Math.abs(balance)} points`;
    const inventory=side=>['q','r','b','n','p'].map(piece=>`${piece.toUpperCase()} ${counts[side][piece] || 0}`).join(' · ');
    $('wbMaterial').title=`White: ${inventory('white')}\nBlack: ${inventory('black')}\nPawn=1, knight/bishop=3, rook=5, queen=9; not an engine evaluation.`;
    const facts=wbPositionFacts(preview.positions,wb.ply),rows=[['Phase',facts.phase],['Pieces',facts.pieces],['To move',facts.side],['Castling',facts.castling],['En passant',facts.enPassant],['50-move clock',facts.halfmove],['Full move',facts.fullmove],['Occurrences',`${facts.occurrences.length} total · ${facts.seen} seen`],['Move traits',facts.traits.join(' · ') || 'Quiet']];
    $('wbInspectorGrid').replaceChildren(...rows.map(([label,value])=>{const item=wbElement('div');item.append(wbElement('span',label),wbElement('strong',value));return item;}));
    const critical=wbCriticalPlies(preview.positions),previousCritical=critical.some(ply=>ply<wb.ply),nextCritical=critical.some(ply=>ply>wb.ply),previousOccurrence=facts.occurrences.some(ply=>ply<wb.ply),nextOccurrence=facts.occurrences.some(ply=>ply>wb.ply);
    wbDisabled('wbBackFive',wb.ply===0);wbDisabled('wbForwardFive',wb.ply===preview.positions.length-1);wbDisabled('wbPreviousCritical',!previousCritical);wbDisabled('wbNextCritical',!nextCritical);wbDisabled('wbPreviousOccurrence',!previousOccurrence);wbDisabled('wbNextOccurrence',!nextOccurrence);
    for(const id of ['wbCopyEpd','wbCopySanLine','wbCopyUciLine','wbCopyPositionJson'])wbDisabled(id,false);
    const summary=wbGameSummary(preview.positions);$('wbGameStats').replaceChildren(...[['Moves',summary.moves],['Captures',summary.captures],['Checks',summary.checks],['Annotations',summary.annotations],['Variations',summary.variations],['Repetitions',summary.repetitions]].map(([label,value])=>{const item=wbElement('span');item.append(wbElement('b',value),document.createTextNode(` ${label}`));return item;}));
    const map=$('wbGameMap'),focused=map.contains(document.activeElement)?document.activeElement.dataset.ply:null;map.style.setProperty('--wb-map-count',Math.max(1,preview.positions.length));map.replaceChildren(...preview.positions.map((row,ply)=>{const kinds=wbMoveKinds(row),button=wbButton('',()=>{wbStop();wb.ply=ply;wbRenderPreview();},`wb-map-ply ${kinds.join(' ')}`);button.dataset.ply=ply;button.classList.toggle('active',ply===wb.ply);button.setAttribute('aria-label',`${row.label || 'Start'}${kinds.length?' · '+kinds.join(', '):' · quiet'}`);button.title=button.getAttribute('aria-label');return button;}));
    const active=map.querySelector('.active');active?.scrollIntoView({block:'nearest',inline:'nearest'});if(focused!=null)map.querySelector(`[data-ply="${focused}"]`)?.focus({preventScroll:true});
    const filtered=wbMoveFilterPlies(preview.positions,$('wbMoveNavigator').value);wbDisabled('wbPreviousFiltered',!filtered.some(ply=>ply<wb.ply));wbDisabled('wbNextFiltered',!filtered.some(ply=>ply>wb.ply));
    wbDisabled('wbReferenceHere',false);wbRenderPositionReference();
    $('wbInspectorHint').textContent=facts.traits.length?`This move is marked: ${facts.traits.join(', ')}.`:'Quiet position. Critical navigation finds captures, checks, promotions, castling, comments, NAGs, and variations.';
  } else {
    $('wbMaterial').textContent='';$('wbInspectorGrid').replaceChildren();$('wbGameStats').replaceChildren();$('wbGameMap').replaceChildren();$('wbInspectorHint').textContent='Select a game to inspect its positions.';
    $('wbReferenceMoves').replaceChildren();$('wbReferenceStatus').textContent='Select a game to load position statistics.';
    for(const id of ['wbBackFive','wbForwardFive','wbPreviousCritical','wbNextCritical','wbPreviousOccurrence','wbNextOccurrence','wbPreviousFiltered','wbNextFiltered','wbCopyEpd','wbCopySanLine','wbCopyUciLine','wbCopyPositionJson','wbReferenceHere','wbReferenceTree'])wbDisabled(id,true);
  }
  const matches=wbNotationMatches(preview?.positions || [],$('wbNotationQuery').value);
  $('wbNotationCount').textContent=$('wbNotationQuery').value?`${matches.length} matching positions`:'Search SAN moves or PGN comments. Matches wrap at the end.';
  const matched=new Set(matches);
  for(const button of $('wbMoves').querySelectorAll('[data-wb-ply]'))button.classList.toggle('notation-match',matched.has(Number(button.dataset.wbPly)));
  const annotations=wbAnnotatedPlies(preview?.positions || []);
  for(const id of ['wbPreviousAnnotation','wbNextAnnotation'])wbDisabled(id,!annotations.length);
  wbDisabled('wbFindNotation',!matches.length);wbDisabled('wbDiagram',!preview);
}
function wbJumpMarked(kind,direction=1) {
  const preview=wbRequirePreview();
  const plies=kind==='annotation'?wbAnnotatedPlies(preview.positions):kind==='critical'?wbCriticalPlies(preview.positions):kind==='occurrence'?wbPositionFacts(preview.positions,wb.ply).occurrences:kind==='filtered'?wbMoveFilterPlies(preview.positions,$('wbMoveNavigator').value):wbNotationMatches(preview.positions,$('wbNotationQuery').value);
  const ply=wbNextMarked(plies,wb.ply,direction);
  if(ply==null){wbStatus('No matching positions.');return;}
  wbStop();wb.ply=ply;wbRenderPreview();wbStatus(`Preview at ply ${ply}.`);
}
function wbDiagramSvg(preview,ply,flipped=false) {
  const fen=preview.positions[ply].fen,title=`${preview.game.white || 'White'} — ${preview.game.black || 'Black'}`;
  const pieces={k:'♚',q:'♛',r:'♜',b:'♝',n:'♞',p:'♟',K:'♔',Q:'♕',R:'♖',B:'♗',N:'♘',P:'♙'};
  const cells=wbBoardSquares(fen,flipped).map(square=>{
    const x=square.col*64,y=square.row*64,white=square.piece===square.piece.toUpperCase();
    return `<g><rect x="${x}" y="${y}" width="64" height="64" fill="${square.dark?'#65705d':'#d9dccd'}"/><text x="${x+32}" y="${y+49}" text-anchor="middle" font-size="52" fill="${white?'#fff':'#151b15'}" stroke="${white?'#151b15':'none'}" stroke-width="0.5">${pieces[square.piece] || ''}</text>${square.row===7 || square.col===0?`<text x="${x+3}" y="${y+61}" font-size="10" fill="${square.dark?'#fff':'#222'}">${square.square}</text>`:''}</g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="552" height="592" viewBox="0 0 552 592"><title>${escapeHtml(title)}</title><desc>${escapeHtml(fen)}</desc><rect width="552" height="592" fill="#fff"/><text x="20" y="28" font-size="16" font-family="sans-serif">${escapeHtml(title.length>52?title.slice(0,49)+'…':title)}</text><g transform="translate(20,48)" font-family="DejaVu Sans,Arial Unicode MS,serif">${cells}</g><text x="20" y="582" font-size="12" font-family="sans-serif">Ply ${ply} · ${fen.split(' ')[1]==='w'?'White':'Black'} to move</text></svg>`;
}
async function wbPreviewExample(id,fen,move) {
  if(!await wbPreview(id))return;
  const key=value=>value.split(' ').slice(0,4).join(' ');
  const ply=wb.preview.positions.findIndex((position,index)=>index>0 && position.uci===move && key(wb.preview.positions[index-1].fen)===key(fen));
  if(ply>=0){wb.ply=ply;wbRenderPreview();}
}
function bindDatabaseProductivity() {
  const on=(id,callback)=>$(id).addEventListener('click',()=>wbAction(callback,$(id)));
  const columnLabels={result:'Result',rating:'Elo',game_date:'Date',eco:'ECO',event:'Event',plies:'Plies',folder:'Folder and tags'};
  for(const column of WB_TABLE_COLUMNS){const label=wbElement('label'),input=document.createElement('input');input.type='checkbox';input.dataset.wbTableColumn=column;input.addEventListener('change',()=>{const columns=[...$('wbColumnChoices').querySelectorAll('[data-wb-table-column]:checked')].map(item=>item.dataset.wbTableColumn);wbSetTableColumns(columns);});label.append(input,document.createTextNode(columnLabels[column]));$('wbColumnChoices').append(label);}
  on('wbColumnsEssential',()=>wbSetTableColumns(['result','rating','game_date','eco']));on('wbColumnsResearch',()=>wbSetTableColumns(['result','rating','game_date','eco','event','plies']));on('wbColumnsAll',()=>wbSetTableColumns(WB_TABLE_COLUMNS));
  for(const [id,key] of [['wbStickyPlayers','stickyPlayers'],['wbZebraRows','zebra'],['wbWrapCells','wrap']])$(id).addEventListener('change',()=>wbSaveTablePrefs({...wbTablePrefs(),[key]:$(id).checked}));
  const searchPresets={masters:{min_elo:'2400'},recent:{year_from:String(new Date().getFullYear()-5)},long:{min_plies:'80'},commented:{annotation:'{'},chess960:{variant:'chess960'},unfiled:{unfiled:true}};
  for(const button of document.querySelectorAll('[data-wb-search-preset]'))button.addEventListener('click',()=>wbAction(async()=>{wbApplyFilters(searchPresets[button.dataset.wbSearchPreset]);$('wbViews').value='';await wbSearch();},button));
  on('wbClearSearchHistory',()=>{localStorage.removeItem(WB_SEARCH_HISTORY_KEY);wbRenderSearchHistory();});wbRenderSearchHistory();
  on('wbCopySnapshot',async()=>{await navigator.clipboard.writeText(wbSnapshotText(wb.pageSnapshot));wbStatus('Database snapshot copied.');});on('wbExportSnapshot',()=>exportJson(wb.pageSnapshot,'FunChessEngine-database-snapshot.json'));
  on('wbFirstPage',async()=>{wb.offset=0;await wbSearch(false);});
  on('wbLastPage',async()=>{wb.offset=wbPageOffset(Math.max(1,Math.ceil(wb.total/wb.limit)),wb.total,wb.limit);await wbSearch(false);});
  const go=async()=>{wb.offset=wbPageOffset(Number($('wbPageNumber').value),wb.total,wb.limit);await wbSearch(false);};
  on('wbGoPage',go);$('wbPageNumber').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();wbAction(go);}});
  on('wbSelectMatching',wbSelectMatching);on('wbInvertPage',()=>{wb.selected=wbInvertSelection(wb.selected,wb.games.map(game=>game.id));wbRenderRows();});
  on('wbRenameView',async()=>{const name=$('wbViewName').value.trim();await wbApi('views',{view:{action:'rename',name:$('wbViews').value,new_name:name}});await wbLoadViews();$('wbViews').value=name;wbStatus('Saved search renamed.');});
  on('wbPreviousGame',()=>wbNextGame(-1));on('wbNextGame',()=>wbNextGame(1));
  on('wbPreviousAnnotation',()=>wbJumpMarked('annotation',-1));on('wbNextAnnotation',()=>wbJumpMarked('annotation'));
  on('wbBackFive',()=>{wbStop();wbStep(-10);});on('wbForwardFive',()=>{wbStop();wbStep(10);});on('wbPreviousCritical',()=>wbJumpMarked('critical',-1));on('wbNextCritical',()=>wbJumpMarked('critical'));on('wbPreviousOccurrence',()=>wbJumpMarked('occurrence',-1));on('wbNextOccurrence',()=>wbJumpMarked('occurrence'));
  on('wbPreviousFiltered',()=>wbJumpMarked('filtered',-1));on('wbNextFiltered',()=>wbJumpMarked('filtered'));$('wbMoveNavigator').addEventListener('change',wbRenderPreviewTools);
  on('wbCopyEpd',async()=>{const preview=wbRequirePreview();await navigator.clipboard.writeText(wbEpd(preview.positions[wb.ply].fen));wbStatus('Position EPD copied.');});
  on('wbCopySanLine',async()=>{const preview=wbRequirePreview();await navigator.clipboard.writeText(wbLineNotation(preview.positions,wb.ply));wbStatus('SAN line through this position copied.');});
  on('wbCopyUciLine',async()=>{const preview=wbRequirePreview();await navigator.clipboard.writeText(preview.positions.slice(1,wb.ply+1).map(row=>row.uci).filter(Boolean).join(' '));wbStatus('UCI line through this position copied.');});
  on('wbCopyPositionJson',async()=>{await navigator.clipboard.writeText(JSON.stringify(wbPositionPayload(wbRequirePreview(),wb.ply),null,2));wbStatus('Portable position record copied.');});
  on('wbReferenceHere',wbLoadPositionReference);on('wbReferenceTree',()=>{const reference=wb.positionReference;if(reference)return wbTreeLoad([{fen:reference.fen,variant:reference.variant,label:`Preview ply ${wb.ply}`}],reference.filters);});
  on('wbFindNotation',()=>wbJumpMarked('search'));$('wbNotationQuery').addEventListener('input',wbRenderPreviewTools);
  $('wbNotationQuery').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();wbJumpMarked('search');}});
  on('wbDiagram',()=>downloadBlob(new Blob([wbDiagramSvg(wbRequirePreview(),wb.ply,wb.flipped)],{type:'image/svg+xml'}),'FunChessEngine-position.svg'));
  wbRenderProductivity();wbRenderPreviewTools();
}
bindDatabaseProductivity();
