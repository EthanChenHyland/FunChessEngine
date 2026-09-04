// Database productivity controls; all board navigation stays inside the preview.
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
function wbPositionFacts(positions,ply) {
  const position=positions[ply],fields=position.fen.trim().split(/\s+/),board=fields[0] || '';
  const pieces=[...board].filter(piece=>/[prnbqk]/i.test(piece)),queens=pieces.filter(piece=>piece.toLowerCase()==='q').length,nonPawns=pieces.filter(piece=>!/[pk]/i.test(piece)).length;
  const phase=pieces.length<=10 || (!queens && nonPawns<=4)?'Endgame':ply<=20 && queens===2 && pieces.length>=24?'Opening':'Middlegame';
  const key=wbPositionKey(position.fen),occurrences=positions.flatMap((row,index)=>wbPositionKey(row.fen)===key?[index]:[]),seen=occurrences.filter(index=>index<=ply).length;
  const san=position.san || '',traits=[];if(san.includes('x'))traits.push('capture');if(/[+#]$/.test(san))traits.push(san.endsWith('#')?'mate':'check');if(san.includes('='))traits.push('promotion');if(/^O-O/.test(san))traits.push('castling');if(position.comment?.trim())traits.push('comment');if(position.nags?.length)traits.push('NAG');if(position.alternatives)traits.push('variations');
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
    $('wbInspectorHint').textContent=facts.traits.length?`This move is marked: ${facts.traits.join(', ')}.`:'Quiet position. Critical navigation finds captures, checks, promotions, castling, comments, NAGs, and variations.';
  } else {
    $('wbMaterial').textContent='';$('wbInspectorGrid').replaceChildren();$('wbInspectorHint').textContent='Select a game to inspect its positions.';
    for(const id of ['wbBackFive','wbForwardFive','wbPreviousCritical','wbNextCritical','wbPreviousOccurrence','wbNextOccurrence','wbCopyEpd','wbCopySanLine','wbCopyUciLine','wbCopyPositionJson'])wbDisabled(id,true);
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
  const plies=kind==='annotation'?wbAnnotatedPlies(preview.positions):kind==='critical'?wbCriticalPlies(preview.positions):kind==='occurrence'?wbPositionFacts(preview.positions,wb.ply).occurrences:wbNotationMatches(preview.positions,$('wbNotationQuery').value);
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
  on('wbFirstPage',async()=>{wb.offset=0;await wbSearch(false);});
  on('wbLastPage',async()=>{wb.offset=wbPageOffset(Math.max(1,Math.ceil(wb.total/wb.limit)),wb.total,wb.limit);await wbSearch(false);});
  const go=async()=>{wb.offset=wbPageOffset(Number($('wbPageNumber').value),wb.total,wb.limit);await wbSearch(false);};
  on('wbGoPage',go);$('wbPageNumber').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();wbAction(go);}});
  on('wbSelectMatching',wbSelectMatching);on('wbInvertPage',()=>{wb.selected=wbInvertSelection(wb.selected,wb.games.map(game=>game.id));wbRenderRows();});
  on('wbRenameView',async()=>{const name=$('wbViewName').value.trim();await wbApi('views',{view:{action:'rename',name:$('wbViews').value,new_name:name}});await wbLoadViews();$('wbViews').value=name;wbStatus('Saved search renamed.');});
  on('wbPreviousGame',()=>wbNextGame(-1));on('wbNextGame',()=>wbNextGame(1));
  on('wbPreviousAnnotation',()=>wbJumpMarked('annotation',-1));on('wbNextAnnotation',()=>wbJumpMarked('annotation'));
  on('wbBackFive',()=>{wbStop();wbStep(-10);});on('wbForwardFive',()=>{wbStop();wbStep(10);});on('wbPreviousCritical',()=>wbJumpMarked('critical',-1));on('wbNextCritical',()=>wbJumpMarked('critical'));on('wbPreviousOccurrence',()=>wbJumpMarked('occurrence',-1));on('wbNextOccurrence',()=>wbJumpMarked('occurrence'));
  on('wbCopyEpd',async()=>{const preview=wbRequirePreview();await navigator.clipboard.writeText(wbEpd(preview.positions[wb.ply].fen));wbStatus('Position EPD copied.');});
  on('wbCopySanLine',async()=>{const preview=wbRequirePreview();await navigator.clipboard.writeText(wbLineNotation(preview.positions,wb.ply));wbStatus('SAN line through this position copied.');});
  on('wbCopyUciLine',async()=>{const preview=wbRequirePreview();await navigator.clipboard.writeText(preview.positions.slice(1,wb.ply+1).map(row=>row.uci).filter(Boolean).join(' '));wbStatus('UCI line through this position copied.');});
  on('wbCopyPositionJson',async()=>{await navigator.clipboard.writeText(JSON.stringify(wbPositionPayload(wbRequirePreview(),wb.ply),null,2));wbStatus('Portable position record copied.');});
  on('wbFindNotation',()=>wbJumpMarked('search'));$('wbNotationQuery').addEventListener('input',wbRenderPreviewTools);
  $('wbNotationQuery').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();wbJumpMarked('search');}});
  on('wbDiagram',()=>downloadBlob(new Blob([wbDiagramSvg(wbRequirePreview(),wb.ply,wb.flipped)],{type:'image/svg+xml'}),'FunChessEngine-position.svg'));
  wbRenderProductivity();wbRenderPreviewTools();
}
bindDatabaseProductivity();
