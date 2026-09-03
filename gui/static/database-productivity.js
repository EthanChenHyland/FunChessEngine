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
  } else $('wbMaterial').textContent='';
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
  const plies=kind==='annotation'?wbAnnotatedPlies(preview.positions):wbNotationMatches(preview.positions,$('wbNotationQuery').value);
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
  on('wbFindNotation',()=>wbJumpMarked('search'));$('wbNotationQuery').addEventListener('input',wbRenderPreviewTools);
  $('wbNotationQuery').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();wbJumpMarked('search');}});
  on('wbDiagram',()=>downloadBlob(new Blob([wbDiagramSvg(wbRequirePreview(),wb.ply,wb.flipped)],{type:'image/svg+xml'}),'FunChessEngine-position.svg'));
  wbRenderProductivity();wbRenderPreviewTools();
}
bindDatabaseProductivity();
