// Local workstation preferences and preview tools. No engine or live-game mutations.
const WS_DEFAULTS={pieceSet:'font',white:'#fff8e7',black:'#202c38',outline:1.4,customPalette:false,light:'#e7dfcc',dark:'#66847a',texture:'none',frame:1,motion:'system',duration:180,transitions:true,follow:true,scrollLock:false,smooth:true,wheel:false,notationHeight:220,previewWidth:360,layout:'split',sticky:true,practice:false,orient:false,treeHidden:false,treeScores:false};
const WS_ENUMS={pieceSet:['font','vector','letters'],texture:['none','grain','linen'],motion:['system','reduced','full'],layout:['split','stack','preview']};
const WS_RANGES={outline:[0,3],frame:[0,12],duration:[80,500],notationHeight:[120,480],previewWidth:[280,520]};
let wsReady=false;
const wsScrollKeys=new WeakMap(),wsBoardFrames=new WeakMap();
let wsTreeFlipped=false,wsWheelTotal=0,wsWheelTime=0;
function wsSanitize(raw) {
  const result={...WS_DEFAULTS};
  if(!raw || typeof raw!=='object')return result;
  for(const [key,fallback] of Object.entries(WS_DEFAULTS)) {
    const value=raw[key];
    if(WS_ENUMS[key]) {if(WS_ENUMS[key].includes(value))result[key]=value;}
    else if(WS_RANGES[key]) {if(typeof value==='number' && Number.isFinite(value))result[key]=Math.max(WS_RANGES[key][0],Math.min(WS_RANGES[key][1],value));}
    else if(typeof fallback==='boolean') {if(typeof value==='boolean')result[key]=value;}
    else if(typeof value==='string' && /^#[0-9a-f]{6}$/i.test(value))result[key]=value;
  }
  return result;
}
function wsPrefs() { return wsSanitize(display.workstation); }
function wsPresets() {
  const rows=display.workstation?.presets;
  return Array.isArray(rows)?rows.filter(row=>row && typeof row.name==='string' && row.name.trim()).slice(0,6).map(row=>({name:row.name.trim().slice(0,40),settings:wsSanitize(row.settings)})):[];
}
function wsReduced() {
  return wsPrefs().motion==='reduced' || (wsPrefs().motion==='system' && matchMedia('(prefers-reduced-motion: reduce)').matches);
}
function wsSet(patch) {
  display.workstation={...wsSanitize({...wsPrefs(),...patch}),presets:wsPresets()};
  saveDisplaySettings();wsApply();
  if(state)render();
  wbRenderPreview();if(wbTree.result)wbTreeRender();
}
function wsApply() {
  if(!wsReady)return;
  const prefs=wsPrefs(),root=document.documentElement;
  for(const key of ['texture','layout','sticky','transitions'])root.dataset[`ws${key[0].toUpperCase()+key.slice(1)}`]=String(prefs[key]);
  root.dataset.wsReduced=String(wsReduced());
  if(wsReduced())for(const piece of document.querySelectorAll('[data-piece]'))for(const animation of piece.getAnimations())animation.cancel();
  for(const [key,unit] of [['outline',''],['frame','px'],['duration','ms'],['notationHeight','px'],['previewWidth','px']])root.style.setProperty(`--ws-${key}`,`${prefs[key]}${unit}`);
  root.style.setProperty('--ws-white',prefs.white);root.style.setProperty('--ws-black',prefs.black);
  for(const [key,property] of [['light','--light-square'],['dark','--dark-square']]) {
    if(prefs.customPalette)root.style.setProperty(property,prefs[key]);else root.style.removeProperty(property);
  }
  for(const input of document.querySelectorAll('[data-ws-pref]')) {
    const value=prefs[input.dataset.wsPref];
    if(input.type==='checkbox')input.checked=value;else input.value=value;
    const output=input.parentElement.querySelector('output');if(output)output.textContent=String(value);
  }
  $('wsPresetList').replaceChildren(new Option('Choose a saved look…',''));
  wsPresets().forEach((preset,index)=>$('wsPresetList').add(new Option(preset.name,String(index))));
  wsGallery();wsPreviewTools();
}
// Original silhouette paths. Fixed markup only; imported game text never enters SVG markup.
const WS_SHAPES={
 p:'M18 31 L20 22 C13 18 15 7 24 7 C33 7 35 18 28 22 L30 31 L34 35 L34 39 L14 39 L14 35 Z',
 r:'M14 8 L19 8 L19 14 L22 14 L22 8 L26 8 L26 14 L29 14 L29 8 L34 8 L34 20 L30 23 L31 33 L35 36 L35 40 L13 40 L13 36 L17 33 L18 23 L14 20 Z',
 b:'M24 5 C15 12 13 19 21 24 L18 33 L13 36 L13 40 L35 40 L35 36 L30 33 L27 24 C35 19 32 12 24 5 Z M25 10 L21 18',
 n:'M14 39 L14 34 L19 29 L22 20 L17 23 L10 20 L14 12 L21 9 L22 5 L28 9 C38 15 34 27 31 33 L36 36 L36 39 Z M18 15 L20 15',
 q:'M13 15 L18 24 L24 10 L30 24 L35 15 L31 32 L35 36 L35 40 L13 40 L13 36 L17 32 Z M10 12 A3 3 0 1 0 16 12 A3 3 0 1 0 10 12 M21 7 A3 3 0 1 0 27 7 A3 3 0 1 0 21 7 M32 12 A3 3 0 1 0 38 12 A3 3 0 1 0 32 12',
 k:'M22 3 L26 3 L26 7 L30 7 L30 11 L26 11 L26 15 C36 11 38 21 30 27 L30 32 L35 36 L35 40 L13 40 L13 36 L18 32 L18 27 C10 21 12 11 22 15 L22 11 L18 11 L18 7 L22 7 Z'
};
function wsPaintPiece(element,symbol,set=wsPrefs().pieceSet) {
  element.dataset.piece=symbol;
  element.classList.toggle('ws-art-piece',set!=='font');
  element.classList.toggle('white-piece',Boolean(symbol) && symbol===symbol.toUpperCase());
  element.classList.toggle('black-piece',Boolean(symbol) && symbol!==symbol.toUpperCase());
  if(!symbol){element.replaceChildren();return;}
  if(set==='font'){element.textContent=PIECES[symbol] || '';return;}
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 48 48');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');
  const shape=document.createElementNS(svg.namespaceURI,set==='letters'?'circle':'path');
  if(set==='letters') {shape.setAttribute('cx','24');shape.setAttribute('cy','24');shape.setAttribute('r','18');}
  else shape.setAttribute('d',WS_SHAPES[symbol.toLowerCase()]);
  svg.append(shape);
  if(set==='letters') {
    const letter=document.createElementNS(svg.namespaceURI,'text');letter.setAttribute('x','24');letter.setAttribute('y','32');letter.setAttribute('text-anchor','middle');letter.textContent=symbol.toUpperCase();svg.append(letter);
  }
  element.replaceChildren(svg);
}
function wsGallery() {
  const target=$('wsPieceGallery'),focused=target.contains(document.activeElement)?document.activeElement.dataset.wsSet:null;target.replaceChildren();
  for(const [set,label] of [['font','Font'],['vector','Sculpted'],['letters','Letters']]) {
    const button=wbButton('',()=>wsSet({pieceSet:set}),'ws-set-card');button.dataset.wsSet=set;button.setAttribute('aria-label',`Use ${label} pieces`);button.setAttribute('aria-pressed',String(wsPrefs().pieceSet===set));
    for(const symbol of ['K','Q','n']) {const piece=wbElement('span',undefined,'ws-gallery-piece');wsPaintPiece(piece,symbol,set);button.append(piece);}
    button.append(wbElement('small',label));target.append(button);if(focused===set)button.focus({preventScroll:true});
  }
}
function wsAnimateBoard(board,fen,orientation=false) {
  const cells=[...board.querySelectorAll('[data-square]')];
  const map=new Map(cells.map(cell=>[cell.dataset.square,{piece:cell.querySelector('[data-piece]')?.dataset.piece || '',rect:cell.getBoundingClientRect()}]));
  const previous=wsBoardFrames.get(board);wsBoardFrames.set(board,{fen,orientation,map});
  if(!previous || previous.fen===fen || previous.orientation!==orientation || wsReduced())return;
  // Animate only uniquely identifiable relocations; ambiguous jumps fade on the next tab transition.
  const removed=[...previous.map].filter(([square,old])=>old.piece && map.get(square)?.piece!==old.piece);
  const added=[...map].filter(([square,now])=>now.piece && previous.map.get(square)?.piece!==now.piece);
  for(const [square,now] of added) {
    const candidates=removed.filter(([,old])=>old.piece===now.piece);
    if(candidates.length!==1 || added.filter(([,item])=>item.piece===now.piece).length!==1)continue;
    const old=candidates[0][1].rect,piece=cells.find(cell=>cell.dataset.square===square).querySelector('[data-piece]');
    if(!now.rect.width || !old.width)continue;
    const cell=piece.parentElement;cell.style.overflow='visible';cell.style.zIndex='6';
    const animation=piece.animate([{transform:`translate(${old.x-now.rect.x}px,${old.y-now.rect.y}px)`},{transform:'translate(0,0)'}],{duration:wsPrefs().duration,easing:'cubic-bezier(.2,.7,.2,1)'});
    animation.finished.catch(()=>{}).then(()=>{cell.style.removeProperty('overflow');cell.style.removeProperty('z-index');});
  }
}
function wsScrollTo(target,top) {
  target.scrollTo({top,behavior:wsPrefs().smooth && !wsReduced()?'smooth':'instant'});
}
function wsBackToTop(panel) {
  let target=panel;
  while(target!==document.scrollingElement && !/(auto|scroll)/.test(getComputedStyle(target).overflowY))target=target.parentElement || document.scrollingElement;
  const top=target===panel?0:target.scrollTop+panel.getBoundingClientRect().top-(target===document.scrollingElement?0:target.getBoundingClientRect().top);
  wsScrollTo(target,top);
}
function wsCenterMove(target,selector) {
  const active=target.querySelector(selector);if(!active)return;
  const box=target.getBoundingClientRect(),row=active.getBoundingClientRect();
  wsScrollTo(target,target.scrollTop+row.top-box.top-(target.clientHeight-row.height)/2);
}
function wsFollow(target,key,selector,previousTop) {
  const changed=wsScrollKeys.get(target)!==key;wsScrollKeys.set(target,key);
  target.scrollTop=previousTop;
  if(changed && wsPrefs().follow && !wsPrefs().scrollLock)wsCenterMove(target,selector);
}
function wsSanLine(positions,ply) {
  const words=[];
  for(let i=1;i<=Math.min(ply,positions.length-1);i++) {
    const before=positions[i-1].fen.split(' '),move=Number(before[5]) || 1;
    if(before[1]==='w')words.push(`${move}.`);else if(i===1)words.push(`${move}...`);
    words.push(positions[i].san || positions[i].label || '');
  }
  return words.join(' ');
}
function wsJumpPly(value,total) {
  const ply=Number(value);
  if(String(value).trim()==='' || !Number.isInteger(ply) || ply<0 || ply>=total)throw new Error(`Enter a whole ply from 0 to ${Math.max(0,total-1)}.`);
  return ply;
}
function wsNoteStats(text) {
  return {characters:[...text].length,words:text.trim()?text.trim().split(/\s+/u).length:0};
}
function wsEditorBadges() {
  if(!wsReady)return;
  const notes=$('wbNotes').value,stats=wsNoteStats(notes);
  $('wsNoteCount').textContent=`${stats.words} words · ${stats.characters} characters · ${notes.length}/10,000 storage units`;
  const notesDirty=Boolean(wb.preview && notes!==(wb.preview.game.notes || ''));
  const headersDirty=Boolean(wb.preview && WB_HEADERS.some(key=>$(`wbHeader-${key}`).value!==(wb.preview.headers[key] || '')));
  wb.notesDirty=notesDirty;wb.headersDirty=headersDirty;
  $('wsNotesBadge').textContent=notesDirty?'Unsaved':'';$('wsHeadersBadge').textContent=headersDirty?'Unsaved':'';
}
function wsPreviewTools() {
  if(!wsReady)return;
  const preview=wb.preview,prefs=wsPrefs();
  $('wsPlyNumber').max=(preview?.positions.length || 1)-1;$('wsPlyNumber').value=wb.ply;
  for(const id of ['wsDownloadGame','wsCopyLine','wsJumpPly','wsWhiteGames','wsBlackGames'])$(id).disabled=!preview;
  for(const button of $('wbMoves').querySelectorAll('[data-wb-ply]'))button.hidden=prefs.practice && Number(button.dataset.wbPly)>wb.ply;
  $('wsPracticeHint').hidden=!prefs.practice;
  wsEditorBadges();
}
function wsTreeTools() {
  if(!wsReady)return;
  const prefs=wsPrefs();$('wbTreeBoard').hidden=prefs.treeHidden;
  $('wsTreeFlip').setAttribute('aria-pressed',String(wsTreeFlipped));
  const query=$('wsTreeQuery').value.trim().toLocaleLowerCase();let count=0;
  for(const row of $('wbTreeMoves').children) {
    if(!row.dataset.san)continue;
    row.hidden=!row.dataset.san.toLocaleLowerCase().includes(query);if(!row.hidden)count++;
    const score=row.querySelector('.ws-both-scores');if(score)score.hidden=!prefs.treeScores;
  }
  $('wsTreeQueryCount').textContent=query?`${count} matching continuations`:'';
}
function wsCollections(result) {
  if(!wsReady)return;
  for(const [id,rows] of [['wsFolders',result.folders],['wsTags',result.tags]]) {
    $(id).replaceChildren(...rows.map(row=>new Option(row.name,row.name)));
  }
}
async function wsRandomGame() {
  if(wb.searching || !wb.total)return;
  const sequence=wb.sequence,previewSequence=wb.previewSequence;
  const index=Math.floor(Math.random()*wb.total),total=wb.total;
  const result=await wbApi('search',{filters:{...wb.filters},sort:wb.sort,direction:wb.direction,limit:10,offset:Math.floor(index/10)*10});
  if(sequence!==wb.sequence || previewSequence!==wb.previewSequence)return;
  const game=result.games[index-result.offset];
  if(result.total===total && game)await wbPreview(game.id);else wbStatus('The matching games changed. Refresh your search.');
}
function wsCitations(games) {
  return games.map(game=>`${game.white || 'White'} — ${game.black || 'Black'} (${game.result || '*'}). ${[game.event,game.site,game.game_date,game.eco].filter(Boolean).join(' · ')}. Reference #${game.id}`).join('\n');
}
async function wsSavePreset() {
  const name=$('wsPresetName').value.trim().slice(0,40);
  if(!name)throw new Error('Name this look before saving it.');
  const presets=wsPresets(),existing=presets.findIndex(preset=>preset.name===name);
  if(existing<0 && presets.length===6)throw new Error('Six looks are saved. Delete one or reuse a name.');
  const preset={name,settings:wsPrefs()};if(existing<0)presets.push(preset);else presets[existing]=preset;
  display.workstation={...wsPrefs(),presets};saveDisplaySettings();wsApply();$('wsPresetList').value=String(existing<0?presets.length-1:existing);
  setStatus(`Saved look: ${name}.`,'success');
}
function wsControl(key,label,type,options) {
  const wrapper=wbElement('label',undefined,`ws-control ${type==='checkbox'?'ws-check':''}`);
  const input=document.createElement(type==='select'?'select':'input');input.id=`ws-${key}`;input.dataset.wsPref=key;
  if(type==='select')for(const [value,text] of options)input.add(new Option(text,value));
  else {input.type=type;if(type==='range'){input.min=WS_RANGES[key][0];input.max=WS_RANGES[key][1];input.step=key==='outline'?.2:1;}}
  wrapper.append(wbElement('span',label),input);if(type==='range')wrapper.append(document.createElement('output'));
  input.addEventListener('change',()=>wsSet({[key]:type==='checkbox'?input.checked:type==='range'?Number(input.value):input.value}));
  return wrapper;
}
function wsDetails(title,parent) {
  const details=wbElement('details',undefined,'ws-details');details.append(wbElement('summary',title));const content=wbElement('div',undefined,'ws-controls');details.append(content);parent.append(details);return content;
}
function wsBind() {
  const card=wbElement('section',undefined,'file-card ws-settings');card.id='wsSettings';card.append(wbElement('h3','Workstation appearance & navigation'),wbElement('p','Customize your boards, motion, and reading space. These settings apply to this profile.','hint'));
  $('displayTab').prepend(card);
  const gallery=wbElement('div',undefined,'ws-piece-gallery');gallery.id='wsPieceGallery';card.append(gallery);
  const appearance=wsDetails('Piece and board details',card),motion=wsDetails('Motion and scrolling',card),layout=wsDetails('Database layout',card);
  const controls=[
    [appearance,'white','White pieces','color'],[appearance,'black','Black pieces','color'],[appearance,'outline','Piece outline','range'],
    [appearance,'customPalette','Use custom square colors','checkbox'],[appearance,'light','Light squares','color'],[appearance,'dark','Dark squares','color'],
    [appearance,'texture','Board texture','select',[['none','Plain'],['grain','Wood grain'],['linen','Linen']]], [appearance,'frame','Board frame (px)','range'],
    [motion,'motion','Motion preference','select',[['system','Follow system'],['reduced','Reduced motion'],['full','Full motion']]],
    [motion,'duration','Move animation (ms)','range'],[motion,'transitions','Animate tab entry','checkbox'],[motion,'follow','Follow current move','checkbox'],[motion,'scrollLock','Lock notation scroll','checkbox'],[motion,'smooth','Smooth scrolling','checkbox'],[motion,'wheel','Scroll wheel steps preview moves','checkbox'],
    [layout,'notationHeight','Notation height (px)','range'],[layout,'previewWidth','Preview width (px)','range'],[layout,'layout','Database arrangement','select',[['split','Side by side'],['stack','Stacked'],['preview','Preview focus']]], [layout,'sticky','Sticky database table tools','checkbox']
  ];
  controls.forEach(([parent,...args])=>parent.append(wsControl(...args)));
  const looks=wsDetails('Saved looks (up to six)',card);
  const name=document.createElement('input');name.id='wsPresetName';name.maxLength=40;name.placeholder='Name this look';name.setAttribute('aria-label','Saved look name');
  const select=document.createElement('select');select.id='wsPresetList';select.setAttribute('aria-label','Saved look');
  looks.append(name,select,wbButton('Save look',wsSavePreset),wbButton('Apply look',()=>{const preset=wsPresets()[Number(select.value)];if(select.value!=='' && preset)wsSet(preset.settings);}),wbButton('Delete look',()=>{if(select.value==='')return;const presets=wsPresets();presets.splice(Number(select.value),1);display.workstation={...wsPrefs(),presets};saveDisplaySettings();wsApply();}));
  $('moves').before(wbButton('Show current move',()=>wsCenterMove($('moves'),reviewMode?`[data-ply="${reviewSnapshot?.ply}"]`:`[data-ply="${state?.pgn.length || 0}"]`),'text-button ws-current-move'));
  const preview=wsDetails('Preview tools',document.querySelector('.wb-preview'));preview.parentElement.id='wsPreviewTools';
  // Keep tools close to notation, ahead of the metadata editors.
  $('wbMoves').before(preview.parentElement);
  preview.append(wsControl('practice','Hide future notation','checkbox'),wsControl('orient','Orient preview to side to move','checkbox'));
  const hint=wbElement('p','Use Next move to reveal the line one move at a time.','hint');hint.id='wsPracticeHint';preview.append(hint);
  const ply=document.createElement('input');ply.id='wsPlyNumber';ply.type='number';ply.min=0;ply.setAttribute('aria-label','Go to preview ply');
  const button=(id,label,callback,parent=preview)=>{const element=wbButton(label,callback);element.id=id;parent.append(element);return element;};
  preview.append(ply);const jump=()=>{const game=wbRequirePreview();wbStop();wb.ply=wsJumpPly(ply.value,game.positions.length);wbRenderPreview();};button('wsJumpPly','Go to ply',jump);
  ply.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();wbAction(jump);}});
  button('wsCurrentMove','Show current move',()=>wsCenterMove($('wbMoves'),'.active'));
  button('wsCopyLine','Copy played SAN line',async()=>{await navigator.clipboard.writeText(wsSanLine(wbRequirePreview().positions,wb.ply));wbStatus('Played SAN line copied.');});
  button('wsDownloadGame','Download this PGN…',()=>downloadBlob(new Blob([wbRequirePreview().game.pgn],{type:'application/x-chess-pgn'}),'FunChessEngine-reference.pgn'));
  for(const [id,side] of [['wsWhiteGames','white'],['wsBlackGames','black']])button(id,`Find ${side} player’s games`,()=>wbChooseCollection({player:wbRequirePreview().game[side],exact_players:true}));
  const browserTools=wbElement('div',undefined,'wb-actions ws-browser-tools');document.querySelector('.wb-browser').prepend(browserTools);
  button('wsRandomGame','Random matching game',wsRandomGame,browserTools);
  button('wsCitations','Export page citations…',()=>downloadBlob(new Blob([wsCitations(wb.games)],{type:'text/plain;charset=utf-8'}),'FunChessEngine-citations.txt'),browserTools);
  button('wsLayoutReturn','Show game list',()=>wsSet({layout:'split'}),document.querySelector('.wb-preview'));
  const treeTools=wsDetails('Tree display & preparation', $('wbOpeningTree'));
  button('wsTreeFlip','Flip tree board',()=>{wsTreeFlipped=!wsTreeFlipped;if(wbTree.result)wbTreeRender();},treeTools);
  treeTools.append(wsControl('treeHidden','Hide tree board','checkbox'),wsControl('treeScores','Show scores for both colors','checkbox'));
  const query=document.createElement('input');query.type='search';query.id='wsTreeQuery';query.placeholder='Filter continuations by SAN';query.setAttribute('aria-label','Filter tree moves');query.addEventListener('input',wsTreeTools);treeTools.append(query);
  const count=wbElement('small',undefined,'hint');count.id='wsTreeQueryCount';treeTools.append(count);
  button('wsTreeLine','Copy explored SAN line',async()=>{if(!wbTree.path.length)throw new Error('Explore a position first.');await navigator.clipboard.writeText(wsSanLine(wbTree.path.map(position=>({...position,san:position.label})),wbTree.path.length-1));wbStatus('Explored SAN line copied.');},treeTools);
  button('wsTreeStudy','Study tree position',async()=>{if(!wbTree.result)throw new Error('Explore a position first.');await wbCreateStudy(wbTree.result.fen,wbTree.result.variant,`Opening preparation · ${wbTree.path.at(-1).label}`);},treeTools);
  for(const [inputId,badgeId] of [['wbNotes','wsNotesBadge'],['wbHeaderFields','wsHeadersBadge']]) {
    const badge=wbElement('span',undefined,'ws-dirty-badge');badge.id=badgeId;$(inputId).closest('details').querySelector('summary').append(badge);
    $(inputId).addEventListener('input',wsEditorBadges);
  }
  const noteCount=wbElement('p',undefined,'hint');noteCount.id='wsNoteCount';$('wbNotes').after(noteCount);
  for(const [id,target] of [['wsFolders','wbFolder'],['wsTags','wbTags']]) {const list=document.createElement('datalist');list.id=id;document.body.append(list);$(target).setAttribute('list',id);}
  $('wbFilter-folder').setAttribute('list','wsFolders');$('wbFilter-tag').setAttribute('list','wsTags');
  for(const panel of document.querySelectorAll('.tab-panel,.wb-browser,.wb-preview')) {
    const top=wbButton('↑ Back to top',()=>wsBackToTop(panel),'text-button ws-back-top');panel.append(top);
  }
  $('wbBoard').addEventListener('wheel',event=>{
    if(!wsPrefs().wheel || !wb.preview || event.ctrlKey || event.metaKey || event.shiftKey || Math.abs(event.deltaX)>Math.abs(event.deltaY))return;
    event.preventDefault();const now=performance.now();if(now-wsWheelTime>220)wsWheelTotal=0;wsWheelTime=now;
    wsWheelTotal+=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?200:1);
    if(Math.abs(wsWheelTotal)>=60){wbStop();wbStep(wsWheelTotal>0?1:-1);wsWheelTotal=0;}
  },{passive:false});
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',wsApply);
  wsReady=true;wsApply();if(state)render();wbRenderPreview();
}
wsBind();
