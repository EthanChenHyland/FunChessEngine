// Local workstation preferences and preview tools. No engine or live-game mutations.
const WS_DEFAULTS={pieceSet:'vector',whiteSet:'vector',blackSet:'vector',whiteScale:100,blackScale:100,autoContrast:false,outlineStyle:'solid',shadowColor:'#000000',fontSymbols:'solid',pieceFinish:'matte',white:'#fffdf4',black:'#182431',whiteOutline:'#263746',blackOutline:'#fffdf4',outline:2,pieceShadow:42,pieceOpacity:100,pieceY:0,pieceWidth:100,pieceGlow:false,customPalette:false,light:'#e7dfcc',dark:'#66847a',texture:'none',frame:1,frameColor:'#465046',radius:11,boardShadow:38,boardBrightness:100,boardSaturation:100,lastColor:'#b9d85a',selectColor:'#8fe06d',targetColor:'#24351f',checkColor:'#d95757',highlightOpacity:45,targetStyle:'dot',targetSize:22,lastStyle:'fill',coordsTone:'auto',coordsMode:'edges',coordSize:11,coordOpacity:80,textureScale:100,frameStyle:'solid',turnGlow:false,boardMax:720,boardAlign:'center',boardTilt:0,showCaptured:true,showRoles:true,showMaterial:true,playerStyle:'plain',clockStyle:'boxed',clockScale:100,clockActive:'#7bdc5c',clockLow:'#ff665f',clockThreshold:10,clockPulse:true,hideTenths:false,moveNumbers:true,uiDensity:'cozy',fontScale:100,panelRadius:12,glassPanels:false,scrollbar:'standard',hoverMotion:true,reduceTransparency:false,customAccent:false,accentColor:'#7bdc5c',customSurfaces:false,appBg:'#0d100e',panelBg:'#171b18',textColor:'#f3f5f1',mutedColor:'#9da69c',wallpaper:'none',buttonShape:'rounded',focusColor:'#7bdc5c',animationEasing:'smooth',motion:'system',duration:180,transitions:true,follow:true,scrollLock:false,smooth:true,wheel:false,notationHeight:220,previewWidth:360,layout:'split',sticky:true,practice:false,orient:false,treeHidden:false,treeScores:false};
const WS_ENUMS={pieceSet:['font','vector','neo','staunton','minimal','letters'],whiteSet:['font','vector','neo','staunton','minimal','letters'],blackSet:['font','vector','neo','staunton','minimal','letters'],fontSymbols:['solid','classic'],pieceFinish:['matte','flat','gloss','glass'],outlineStyle:['solid','dashed'],texture:['none','grain','linen','marble','carbon','dots'],frameStyle:['solid','double','glow'],targetStyle:['dot','ring','fill'],lastStyle:['fill','frame','corners'],coordsTone:['auto','dark','light'],coordsMode:['edges','all'],boardAlign:['left','center','right'],playerStyle:['plain','cards'],clockStyle:['boxed','minimal','digital'],uiDensity:['compact','cozy','airy'],scrollbar:['slim','standard','wide'],wallpaper:['none','grid','aurora','vignette'],buttonShape:['square','rounded','pill'],animationEasing:['smooth','snap','spring','linear'],motion:['system','reduced','full'],layout:['split','stack','preview']};
const WS_RANGES={outline:[0,4],whiteScale:[75,125],blackScale:[75,125],pieceShadow:[0,100],pieceOpacity:[50,100],pieceY:[-8,8],pieceWidth:[80,120],frame:[0,12],radius:[0,24],boardShadow:[0,100],boardBrightness:[70,130],boardSaturation:[0,160],highlightOpacity:[10,80],targetSize:[12,90],coordSize:[7,18],coordOpacity:[30,100],textureScale:[50,200],boardMax:[420,900],boardTilt:[-3,3],clockScale:[80,140],clockThreshold:[5,60],fontScale:[85,125],panelRadius:[0,24],duration:[80,500],notationHeight:[120,480],previewWidth:[280,520]};
const WS_BOARD_PRESETS=[
  ['Classic','#f0d9b5','#b58863'],['Tournament','#e8ebd2','#779455'],['Midnight','#9ca7b8','#364152'],['Ocean glass','#d9eef0','#4e8190'],['Rosewood','#efd6c1','#955f59'],['Amethyst','#e8dded','#806b91'],['High contrast','#f7f4dc','#3e6045'],['Monochrome','#dedede','#60656b'],['Sandstone','#eee0bd','#ad8057'],['Candy','#f4d8e4','#9c7498'],['Blueprint','#dbe7f5','#5876a3'],['Coffee','#e8d5bd','#785944']
];
const WS_PIECE_PRESETS=[
  ['Maximum clarity',{whiteSet:'vector',blackSet:'vector',white:'#ffffff',black:'#101820',whiteOutline:'#101820',blackOutline:'#ffffff',outline:2.6,pieceShadow:55,pieceFinish:'matte'}],
  ['Tournament',{whiteSet:'vector',blackSet:'vector',white:'#fff4d6',black:'#17212b',whiteOutline:'#29323b',blackOutline:'#ede3cc',outline:1.8,pieceShadow:35,pieceFinish:'gloss'}],
  ['Flat modern',{whiteSet:'vector',blackSet:'vector',white:'#f7f7f2',black:'#222831',whiteOutline:'#222831',blackOutline:'#f7f7f2',outline:1.2,pieceShadow:0,pieceFinish:'flat'}],
  ['Study letters',{whiteSet:'letters',blackSet:'letters',white:'#ffffff',black:'#15283b',whiteOutline:'#15283b',blackOutline:'#ffffff',outline:2,pieceShadow:25,pieceFinish:'matte'}],
  ['Classic solid',{whiteSet:'font',blackSet:'font',fontSymbols:'solid',white:'#fffdf4',black:'#15202b',whiteOutline:'#17222d',blackOutline:'#f4eddd',outline:2,pieceShadow:48,pieceFinish:'matte'}],
  ['Glass tokens',{whiteSet:'letters',blackSet:'letters',white:'#eaf8ff',black:'#17304a',whiteOutline:'#244158',blackOutline:'#dcefff',outline:1.4,pieceShadow:62,pieceFinish:'glass'}],
  ['Staunton club',{whiteSet:'staunton',blackSet:'staunton',white:'#fff8e7',black:'#20262c',whiteOutline:'#28333d',blackOutline:'#f2e7ce',outline:1.8,pieceShadow:48,pieceFinish:'gloss'}],
  ['Minimal analysis',{whiteSet:'minimal',blackSet:'minimal',white:'#ffffff',black:'#18242d',whiteOutline:'#18242d',blackOutline:'#ffffff',outline:2.2,pieceShadow:18,pieceFinish:'flat'}]
];
let wsReady=false,wsUndo=[],wsPiecePresetIndex=0;
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
  for(const key of ['whiteSet','blackSet'])if(!(key in raw) && WS_ENUMS.pieceSet.includes(raw.pieceSet))result[key]=raw.pieceSet;
  return result;
}
function wsBaseAppearance(raw=display) {
  const result={theme:'forest',accent:'green',appearance:'dark',pieceTheme:'classic',pieceScale:78,sidebarWidth:460};
  if(raw && typeof raw==='object') {
    if(['forest','walnut','ocean','slate'].includes(raw.theme))result.theme=raw.theme;
    if(['green','blue','purple','orange'].includes(raw.accent))result.accent=raw.accent;
    if(['dark','light'].includes(raw.appearance))result.appearance=raw.appearance;
    if(['classic','clean','bold','soft','outline','tournament'].includes(raw.pieceTheme))result.pieceTheme=raw.pieceTheme;
    if(Number.isFinite(raw.pieceScale))result.pieceScale=Math.max(66,Math.min(90,raw.pieceScale));
    if(Number.isFinite(raw.sidebarWidth))result.sidebarWidth=Math.max(330,Math.min(520,raw.sidebarWidth));
  }
  return result;
}
function wsPrefs() { return wsSanitize(display.workstation); }
function wsPresets() {
  const rows=display.workstation?.presets;
  return Array.isArray(rows)?rows.filter(row=>row && typeof row.name==='string' && row.name.trim()).slice(0,12).map(row=>({name:row.name.trim().slice(0,40),settings:wsSanitize(row.settings),base:wsBaseAppearance(row.base)})):[];
}
function wsReduced() {
  return wsPrefs().motion==='reduced' || (wsPrefs().motion==='system' && matchMedia('(prefers-reduced-motion: reduce)').matches);
}
function wsSet(patch,remember=true) {
  const previous=wsPrefs();
  if(WS_ENUMS.pieceSet.includes(patch.pieceSet)){patch={...patch,whiteSet:patch.whiteSet || patch.pieceSet,blackSet:patch.blackSet || patch.pieceSet};}
  const next=wsSanitize({...previous,...patch});
  if(remember && JSON.stringify(previous)!==JSON.stringify(next)){wsUndo.push(previous);if(wsUndo.length>20)wsUndo.shift();}
  display.workstation={...next,presets:wsPresets()};
  saveDisplaySettings();wsApply();
  if(state)render();
  wbRenderPreview();if(wbTree.result)wbTreeRender();
}
function wsApply() {
  if(!wsReady)return;
  const prefs=wsPrefs(),root=document.documentElement;
  for(const key of ['texture','layout','sticky','transitions','pieceFinish','pieceGlow','autoContrast','outlineStyle','targetStyle','lastStyle','coordsTone','coordsMode','frameStyle','boardAlign','playerStyle','clockStyle','showCaptured','showRoles','showMaterial','clockPulse','hideTenths','moveNumbers','uiDensity','glassPanels','scrollbar','hoverMotion','reduceTransparency','customAccent','customSurfaces','wallpaper','buttonShape','animationEasing'])root.dataset[`ws${key[0].toUpperCase()+key.slice(1)}`]=String(prefs[key]);
  root.dataset.wsReduced=String(wsReduced());
  if(wsReduced())for(const piece of document.querySelectorAll('[data-piece]'))for(const animation of piece.getAnimations())animation.cancel();
  for(const [key,unit] of [['outline',''],['whiteScale',''],['blackScale',''],['pieceShadow',''],['pieceOpacity','%'],['pieceY','px'],['pieceWidth',''],['frame','px'],['radius','px'],['boardShadow',''],['boardBrightness','%'],['boardSaturation','%'],['highlightOpacity',''],['targetSize','%'],['coordSize','px'],['coordOpacity','%'],['textureScale','%'],['boardMax','px'],['boardTilt','deg'],['clockScale',''],['clockThreshold',''],['fontScale',''],['panelRadius','px'],['duration','ms'],['notationHeight','px'],['previewWidth','px']])root.style.setProperty(`--ws-${key}`,`${prefs[key]}${unit}`);
  root.style.setProperty('--ws-white',prefs.white);root.style.setProperty('--ws-black',prefs.black);
  for(const [key,property] of [['frameColor','--ws-frame-color'],['lastColor','--ws-last'],['selectColor','--ws-select'],['targetColor','--ws-target'],['checkColor','--ws-check'],['clockActive','--ws-clock-active'],['clockLow','--ws-clock-low'],['shadowColor','--ws-shadow-color'],['accentColor','--ws-accent-choice'],['focusColor','--ws-focus'],['appBg','--ws-app-bg'],['panelBg','--ws-panel-bg'],['textColor','--ws-text-choice'],['mutedColor','--ws-muted-choice']])root.style.setProperty(property,prefs[key]);
  root.style.setProperty('--board-max',`${prefs.boardMax}px`);
  const easings={smooth:'cubic-bezier(.2,.7,.2,1)',snap:'cubic-bezier(.2,.9,.3,1)',spring:'cubic-bezier(.2,1.45,.4,1)',linear:'linear'};root.style.setProperty('--ws-easing',easings[prefs.animationEasing]);
  for(const [property,value] of [['--accent',prefs.customAccent?prefs.accentColor:null],['--bg',prefs.customSurfaces?prefs.appBg:null],['--panel',prefs.customSurfaces?prefs.panelBg:null],['--panel-2',prefs.customSurfaces?`color-mix(in srgb,${prefs.panelBg} 82%,${prefs.textColor})`:null],['--panel-3',prefs.customSurfaces?`color-mix(in srgb,${prefs.panelBg} 92%,${prefs.appBg})`:null],['--text',prefs.customSurfaces?prefs.textColor:null],['--muted',prefs.customSurfaces?prefs.mutedColor:null]]){if(value)root.style.setProperty(property,value);else root.style.removeProperty(property);}
  const outlines=prefs.autoContrast?{whiteOutline:wsBestOutline(prefs.white,prefs),blackOutline:wsBestOutline(prefs.black,prefs)}:prefs;root.style.setProperty('--ws-white-outline',outlines.whiteOutline);root.style.setProperty('--ws-black-outline',outlines.blackOutline);
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
  wsGallery();wsReadability();wsPreviewTools();
  if($('wsUndoCustomization'))$('wsUndoCustomization').disabled=!wsUndo.length;
  if($('wsSettingsSearch')?.value)wsFilterSettings($('wsSettingsSearch').value);
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
const WS_NEO_SHAPES={
 p:'M24 7 A7 7 0 1 1 24 21 A7 7 0 1 1 24 7 M19 22 L29 22 L31 33 L36 38 L12 38 L17 33 Z',
 r:'M12 8 L18 8 L18 14 L22 14 L22 8 L26 8 L26 14 L30 14 L30 8 L36 8 L33 23 L29 26 L31 35 L36 39 L12 39 L17 35 L19 26 L15 23 Z',
 b:'M24 5 L31 14 L27 23 L31 33 L36 38 L12 38 L17 33 L21 23 L17 15 Z M22 11 L28 17',
 n:'M13 39 L16 31 L22 25 L15 27 L11 20 L17 12 L24 10 L27 5 L33 13 L36 23 L31 34 L37 39 Z M20 17 A2 2 0 1 0 20 18',
 q:'M11 14 L18 25 L24 9 L30 25 L37 14 L32 34 L37 39 L11 39 L16 34 Z M8 11 A3 3 0 1 0 14 11 A3 3 0 1 0 8 11 M21 6 A3 3 0 1 0 27 6 A3 3 0 1 0 21 6 M34 11 A3 3 0 1 0 40 11 A3 3 0 1 0 34 11',
 k:'M22 4 L26 4 L26 9 L31 9 L31 13 L26 13 L26 17 C35 18 36 26 30 30 L31 35 L37 39 L11 39 L17 35 L18 30 C12 26 13 18 22 17 L22 13 L17 13 L17 9 L22 9 Z'
};
const WS_STAUNTON_SHAPES={
 p:'M24 6 A6 6 0 1 1 24 18 A6 6 0 1 1 24 6 M18 22 C17 26 19 30 20 32 L15 36 L14 40 L34 40 L33 36 L28 32 C29 30 31 26 30 22 Z',
 r:'M13 7 L19 7 L19 12 L22 12 L22 7 L26 7 L26 12 L29 12 L29 7 L35 7 L34 18 L30 22 L31 33 L35 37 L35 40 L13 40 L13 37 L17 33 L18 22 L14 18 Z',
 b:'M24 5 C18 9 16 14 18 19 C19 22 21 24 21 27 L18 33 L13 37 L13 40 L35 40 L35 37 L30 33 L27 27 C27 24 29 22 30 19 C32 14 30 9 24 5 Z M24 10 L21 19',
 n:'M13 40 L14 35 L19 30 C21 27 22 24 22 21 L16 25 L11 20 L15 12 L22 10 L25 5 C31 8 36 14 36 22 C36 27 33 31 30 34 L36 37 L36 40 Z M20 15 A1.5 1.5 0 1 0 20 18',
 q:'M12 15 L18 25 L24 10 L30 25 L36 15 L32 32 L36 37 L36 40 L12 40 L12 37 L16 32 Z M9 12 A3 3 0 1 0 15 12 A3 3 0 1 0 9 12 M21 7 A3 3 0 1 0 27 7 A3 3 0 1 0 21 7 M33 12 A3 3 0 1 0 39 12 A3 3 0 1 0 33 12',
 k:'M22 3 L26 3 L26 8 L31 8 L31 12 L26 12 L26 16 C33 17 35 22 32 27 C31 29 29 30 28 32 L35 37 L35 40 L13 40 L13 37 L20 32 C19 30 17 29 16 27 C13 22 15 17 22 16 L22 12 L17 12 L17 8 L22 8 Z'
};
const WS_MINIMAL_SHAPES={
 p:'M24 7 A7 7 0 1 1 24 21 A7 7 0 1 1 24 7 M18 23 L30 23 L32 35 L36 39 L12 39 L16 35 Z',
 r:'M13 8 H19 V14 H22 V8 H26 V14 H29 V8 H35 V20 L31 24 V34 L36 39 H12 L17 34 V24 L13 20 Z',
 b:'M24 5 L31 15 L27 25 L31 35 L36 39 H12 L17 35 L21 25 L17 15 Z M24 10 L21 19',
 n:'M12 39 L16 30 L23 24 L15 26 L12 19 L19 11 L25 10 L28 5 L35 16 L34 27 L29 34 L37 39 Z M20 16 H22',
 q:'M11 14 L18 26 L24 9 L30 26 L37 14 L32 34 L37 39 H11 L16 34 Z M9 10 H15 V16 H9 Z M21 5 H27 V11 H21 Z M33 10 H39 V16 H33 Z',
 k:'M22 4 H26 V9 H31 V13 H26 V17 L33 24 L28 32 L36 39 H12 L20 32 L15 24 L22 17 V13 H17 V9 H22 Z'
};
function wsPaintPiece(element,symbol,set=null) {
  const prefs=wsPrefs(),white=Boolean(symbol) && symbol===symbol.toUpperCase();set=set || (white?prefs.whiteSet:prefs.blackSet) || prefs.pieceSet;
  element.dataset.piece=symbol;
  element.classList.toggle('ws-art-piece',set!=='font');
  element.classList.toggle('white-piece',Boolean(symbol) && symbol===symbol.toUpperCase());
  element.classList.toggle('black-piece',Boolean(symbol) && symbol!==symbol.toUpperCase());
  if(!symbol){element.replaceChildren();return;}
  if(set==='font'){element.textContent=PIECES[prefs.fontSymbols==='solid'?symbol.toLowerCase():symbol] || '';return;}
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 48 48');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');
  const shape=document.createElementNS(svg.namespaceURI,set==='letters'?'circle':'path');
  if(set==='letters') {shape.setAttribute('cx','24');shape.setAttribute('cy','24');shape.setAttribute('r','18');}
  else shape.setAttribute('d',({neo:WS_NEO_SHAPES,staunton:WS_STAUNTON_SHAPES,minimal:WS_MINIMAL_SHAPES}[set] || WS_SHAPES)[symbol.toLowerCase()]);
  svg.append(shape);
  if(set==='letters') {
    const letter=document.createElementNS(svg.namespaceURI,'text');letter.setAttribute('x','24');letter.setAttribute('y','32');letter.setAttribute('text-anchor','middle');letter.textContent=symbol.toUpperCase();svg.append(letter);
  }
  element.replaceChildren(svg);
}
function wsGallery() {
  const target=$('wsPieceGallery'),focused=target.contains(document.activeElement)?document.activeElement.dataset.wsSet:null;target.replaceChildren();
  for(const [set,label] of [['font','Solid glyphs'],['vector','Sculpted'],['neo','Neo'],['staunton','Staunton'],['minimal','Minimal'],['letters','Letters']]) {
    const button=wbButton('',()=>wsSet({pieceSet:set,whiteSet:set,blackSet:set}),'ws-set-card');button.dataset.wsSet=set;button.setAttribute('aria-label',`Use ${label} pieces`);button.setAttribute('aria-pressed',String(wsPrefs().whiteSet===set && wsPrefs().blackSet===set));
    for(const symbol of ['K','Q','n']) {const piece=wbElement('span',undefined,'ws-gallery-piece');wsPaintPiece(piece,symbol,set);button.append(piece);}
    button.append(wbElement('small',label));target.append(button);if(focused===set)button.focus({preventScroll:true});
  }
}
function wsAnimateBoard(board,fen,orientation=false) {
  board.dataset.turn=fen?.split(' ')[1] || '';
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
    const animation=piece.animate([{transform:`translate(${old.x-now.rect.x}px,${old.y-now.rect.y}px)`},{transform:'translate(0,0)'}],{duration:wsPrefs().duration,easing:getComputedStyle(document.documentElement).getPropertyValue('--ws-easing').trim() || 'ease'});
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
function wsLinear(hex) {
  const values=[1,3,5].map(index=>parseInt(hex.slice(index,index+2),16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);
  return .2126*values[0]+.7152*values[1]+.0722*values[2];
}
function wsContrastRatio(a,b) {const x=wsLinear(a),y=wsLinear(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
function wsReadability() {
  if(!wsReady || !$('wsContrastGrid'))return;
  const prefs=wsPrefs(),light=prefs.customPalette?prefs.light:getComputedStyle(document.documentElement).getPropertyValue('--light-square').trim(),dark=prefs.customPalette?prefs.dark:getComputedStyle(document.documentElement).getPropertyValue('--dark-square').trim();
  const whiteOutline=prefs.autoContrast?wsBestOutline(prefs.white,prefs):prefs.whiteOutline,blackOutline=prefs.autoContrast?wsBestOutline(prefs.black,prefs):prefs.blackOutline;
  const rows=[['White / light',prefs.white,light,whiteOutline],['White / dark',prefs.white,dark,whiteOutline],['Black / light',prefs.black,light,blackOutline],['Black / dark',prefs.black,dark,blackOutline]];
  if(prefs.customSurfaces)rows.push(['App text',prefs.textColor,prefs.appBg,prefs.textColor],['Panel text',prefs.textColor,prefs.panelBg,prefs.textColor]);
  $('wsContrastGrid').replaceChildren(...rows.map(([label,fill,square,stroke])=>{const ratio=label.includes('text')?wsContrastRatio(fill,square):Math.max(wsContrastRatio(fill,square),prefs.outline?wsContrastRatio(stroke,square):1),quality=ratio>=7?'Excellent':ratio>=4.5?'Strong':ratio>=3?'Usable':'Low';const item=wbElement('div',undefined,`ws-contrast ${quality==='Low'?'low':''}`);item.append(wbElement('span',label),wbElement('strong',`${quality} · ${ratio.toFixed(1)}:1`));return item;}));
}
function wsApplyBoardPreset(index) {const preset=WS_BOARD_PRESETS[index];if(preset)wsSet({customPalette:true,light:preset[1],dark:preset[2]});}
function wsApplyPiecePreset(index) {const preset=WS_PIECE_PRESETS[index];if(preset){wsPiecePresetIndex=index;wsSet({...preset[1],pieceSet:preset[1].whiteSet});}}
function wsUndoCustomization() {const previous=wsUndo.pop();if(previous)wsSet(previous,false);else setStatus('No recent customization change to undo.');}
function wsSurprise() {
  const board=WS_BOARD_PRESETS[Math.floor(Math.random()*WS_BOARD_PRESETS.length)],piece=WS_PIECE_PRESETS[Math.floor(Math.random()*WS_PIECE_PRESETS.length)];
  wsSet({...piece[1],customPalette:true,light:board[1],dark:board[2],texture:['none','grain','linen','marble','carbon','dots'][Math.floor(Math.random()*6)],radius:[0,6,11,18,24][Math.floor(Math.random()*5)]});
}
function wsExportCustomization() {
  const payload={format:'FunChessEngine customization',version:1,appearance:wsBaseAppearance(),settings:wsPrefs()};
  return downloadBlob(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),'FunChessEngine-customization.json');
}
async function wsImportCustomization(file) {
  if(!file)return;if(file.size>65536)throw new Error('Customization files are limited to 64 KB.');
  const payload=JSON.parse(await file.text());if(payload?.format!=='FunChessEngine customization' || payload.version!==1 || !payload.settings || typeof payload.settings!=='object')throw new Error('This is not a supported FunChessEngine customization file.');
  if(payload.appearance)updateDisplay(wsBaseAppearance(payload.appearance));
  wsSet(payload.settings);setStatus('Customization imported.','success');
}
async function wsSavePreset() {
  const name=$('wsPresetName').value.trim().slice(0,40);
  if(!name)throw new Error('Name this look before saving it.');
  const presets=wsPresets(),existing=presets.findIndex(preset=>preset.name===name);
  if(existing<0 && presets.length===12)throw new Error('Twelve looks are saved. Delete one or reuse a name.');
  const preset={name,settings:wsPrefs(),base:wsBaseAppearance()};if(existing<0)presets.push(preset);else presets[existing]=preset;
  display.workstation={...wsPrefs(),presets};saveDisplaySettings();wsApply();$('wsPresetList').value=String(existing<0?presets.length-1:existing);
  setStatus(`Saved look: ${name}.`,'success');
}
function wsDecorateClocks(white,black) {
  if(!wsReady)return;const prefs=wsPrefs();
  for(const [side,value] of [['white',white],['black',black]]) {
    const clock=$(`${side}Clock`),low=Number.isFinite(value) && value>0 && value<=prefs.clockThreshold*1000;
    clock.dataset.low=String(low);
    if(prefs.hideTenths && clock.textContent.includes('.'))clock.textContent=clock.textContent.split('.')[0];
  }
}
function wsFilterSettings(query) {
  const needle=query.trim().toLocaleLowerCase(),details=[...$('wsSettings').querySelectorAll(':scope > details')];let matches=0;
  for(const detail of details) {
    const categoryMatch=Boolean(needle && detail.querySelector('summary').textContent.toLocaleLowerCase().includes(needle));
    const items=[...detail.querySelectorAll('label,.ws-preset-button,.ws-palette-button,button')].filter((item,index,array)=>array.indexOf(item)===index);
    for(const item of items){const show=!needle || categoryMatch || item.textContent.toLocaleLowerCase().includes(needle);item.classList.toggle('ws-search-hidden',!show);if(show && needle)matches++;}
    const showDetail=!needle || detail.querySelector('summary').textContent.toLocaleLowerCase().includes(needle) || items.some(item=>!item.classList.contains('ws-search-hidden'));
    detail.hidden=!showDetail;if(needle && showDetail)detail.open=true;
  }
  $('wsSearchCount').textContent=needle?`${matches} matching controls`:'';return matches;
}
function wsExpandSettings(open) {for(const detail of $('wsSettings').querySelectorAll(':scope > details'))if(!detail.hidden)detail.open=open;}
function wsBestOutline(fill,prefs) {
  const themes={forest:['#d9dccd','#65705d'],walnut:['#ead7b7','#9a6647'],ocean:['#d8e5e7','#527989'],slate:['#d3d5d7','#6c727a']},squares=prefs.customPalette?[prefs.light,prefs.dark]:(themes[display.theme] || themes.forest);
  const score=color=>Math.min(wsContrastRatio(color,fill),...squares.map(square=>wsContrastRatio(color,square)));return score('#fffdf4')>score('#101820')?'#fffdf4':'#101820';
}
function wsFixContrast() {
  const prefs=wsPrefs();
  wsSet({whiteOutline:wsBestOutline(prefs.white,prefs),blackOutline:wsBestOutline(prefs.black,prefs),outline:Math.max(2.4,prefs.outline),pieceOpacity:100});setStatus('Piece outlines strengthened for this board.','success');
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
  const toolbar=wbElement('div',undefined,'ws-studio-toolbar'),search=document.createElement('input');search.id='wsSettingsSearch';search.type='search';search.placeholder='Find a customization…';search.setAttribute('aria-label','Search customization controls');toolbar.append(search,wbButton('Expand all',()=>wsExpandSettings(true)),wbButton('Collapse all',()=>wsExpandSettings(false)));const searchCount=wbElement('span',undefined,'hint');searchCount.id='wsSearchCount';toolbar.append(searchCount);card.append(toolbar);search.addEventListener('input',()=>wsFilterSettings(search.value));
  const gallery=wbElement('div',undefined,'ws-piece-gallery');gallery.id='wsPieceGallery';card.append(gallery);
  const visibility=wsDetails('Visibility dashboard',card),appearance=wsDetails('Piece and board details',card),motion=wsDetails('Motion and scrolling',card),layout=wsDetails('Database layout',card);
  const contrast=wbElement('div',undefined,'ws-contrast-grid');contrast.id='wsContrastGrid';visibility.append(contrast,wbButton('Auto-fix piece contrast',wsFixContrast),wbElement('p','The score includes the piece fill and its outline against both square colors. Strong or Excellent is recommended.','hint'));
  const piecePresets=wbElement('div',undefined,'ws-preset-grid');piecePresets.id='wsPiecePresets';WS_PIECE_PRESETS.forEach((preset,index)=>piecePresets.append(wbButton(preset[0],()=>wsApplyPiecePreset(index),'ws-preset-button')));appearance.append(piecePresets);
  const boardPresets=wbElement('div',undefined,'ws-palette-grid');boardPresets.id='wsBoardPresets';WS_BOARD_PRESETS.forEach((preset,index)=>{const button=wbButton(preset[0],()=>wsApplyBoardPreset(index),'ws-palette-button');button.style.setProperty('--swatch-light',preset[1]);button.style.setProperty('--swatch-dark',preset[2]);boardPresets.append(button);});appearance.append(boardPresets);
  const controls=[
    [appearance,'whiteSet','White piece set','select',[['vector','Sculpted'],['neo','Neo'],['staunton','Staunton'],['minimal','Minimal'],['font','Solid glyphs'],['letters','Letters']]],[appearance,'blackSet','Black piece set','select',[['vector','Sculpted'],['neo','Neo'],['staunton','Staunton'],['minimal','Minimal'],['font','Solid glyphs'],['letters','Letters']]],[appearance,'whiteScale','White piece size','range'],[appearance,'blackScale','Black piece size','range'],[appearance,'autoContrast','Automatic outline contrast','checkbox'],[appearance,'outlineStyle','Outline style','select',[['solid','Solid'],['dashed','Engraved']]],[appearance,'shadowColor','Shadow color','color'],[appearance,'fontSymbols','Glyph style','select',[['solid','Filled for contrast'],['classic','Traditional white/black symbols']]],[appearance,'pieceFinish','Piece finish','select',[['matte','Matte'],['flat','Flat'],['gloss','Gloss'],['glass','Glass']]],[appearance,'white','White pieces','color'],[appearance,'black','Black pieces','color'],[appearance,'whiteOutline','White outline','color'],[appearance,'blackOutline','Black outline','color'],[appearance,'outline','Piece outline','range'],[appearance,'pieceShadow','Piece shadow','range'],[appearance,'pieceOpacity','Piece opacity','range'],[appearance,'pieceY','Vertical position','range'],[appearance,'pieceWidth','Piece width','range'],[appearance,'pieceGlow','Glow pieces','checkbox'],
    [appearance,'customPalette','Use custom square colors','checkbox'],[appearance,'light','Light squares','color'],[appearance,'dark','Dark squares','color'],
    [appearance,'texture','Board texture','select',[['none','Plain'],['grain','Wood grain'],['linen','Linen'],['marble','Marble'],['carbon','Carbon'],['dots','Dot grid']]],[appearance,'frame','Board frame (px)','range'],[appearance,'frameColor','Frame color','color'],[appearance,'radius','Board corners','range'],[appearance,'boardShadow','Board shadow','range'],[appearance,'boardBrightness','Board brightness','range'],[appearance,'boardSaturation','Board saturation','range'],[appearance,'lastColor','Last move','color'],[appearance,'selectColor','Selected square','color'],[appearance,'targetColor','Legal target','color'],[appearance,'checkColor','King in check','color'],[appearance,'highlightOpacity','Highlight opacity','range'],[appearance,'targetSize','Legal-target size','range'],[appearance,'targetStyle','Legal-move style','select',[['dot','Dots and rings'],['ring','Rings'],['fill','Filled squares']]],[appearance,'lastStyle','Last-move style','select',[['fill','Filled'],['frame','Frame'],['corners','Corners']]],[appearance,'coordsTone','Coordinate contrast','select',[['auto','Automatic'],['dark','Always dark'],['light','Always light']]],[appearance,'coordsMode','Coordinate labels','select',[['edges','Board edges'],['all','Every square']]],[appearance,'coordSize','Coordinate size','range'],[appearance,'coordOpacity','Coordinate opacity','range'],[appearance,'textureScale','Texture scale','range'],[appearance,'frameStyle','Frame style','select',[['solid','Solid'],['double','Double'],['glow','Glow']]],[appearance,'turnGlow','Glow for side to move','checkbox'],[appearance,'boardMax','Maximum board size','range'],[appearance,'boardAlign','Board alignment','select',[['left','Left'],['center','Center'],['right','Right']]],[appearance,'boardTilt','Board tilt','range'],
    [motion,'motion','Motion preference','select',[['system','Follow system'],['reduced','Reduced motion'],['full','Full motion']]],
    [motion,'duration','Move animation (ms)','range'],[motion,'transitions','Animate tab entry','checkbox'],[motion,'follow','Follow current move','checkbox'],[motion,'scrollLock','Lock notation scroll','checkbox'],[motion,'smooth','Smooth scrolling','checkbox'],[motion,'wheel','Scroll wheel steps preview moves','checkbox'],
    [layout,'notationHeight','Notation height (px)','range'],[layout,'previewWidth','Preview width (px)','range'],[layout,'layout','Database arrangement','select',[['split','Side by side'],['stack','Stacked'],['preview','Preview focus']]], [layout,'sticky','Sticky database table tools','checkbox']
  ];
  const interfaceControls=wsDetails('Interface surfaces',card);controls.push([interfaceControls,'customAccent','Use custom accent','checkbox'],[interfaceControls,'accentColor','Accent color','color'],[interfaceControls,'customSurfaces','Use custom app colors','checkbox'],[interfaceControls,'appBg','App background','color'],[interfaceControls,'panelBg','Panel background','color'],[interfaceControls,'textColor','Primary text','color'],[interfaceControls,'mutedColor','Secondary text','color'],[interfaceControls,'wallpaper','App background style','select',[['none','Plain'],['grid','Grid'],['aurora','Aurora'],['vignette','Vignette']]],[interfaceControls,'buttonShape','Button shape','select',[['square','Square'],['rounded','Rounded'],['pill','Pill']]],[interfaceControls,'focusColor','Keyboard focus color','color'],[interfaceControls,'animationEasing','Animation feel','select',[['smooth','Smooth'],['snap','Snappy'],['spring','Spring'],['linear','Linear']]],[interfaceControls,'showCaptured','Show captured pieces','checkbox'],[interfaceControls,'showRoles','Show player roles','checkbox'],[interfaceControls,'showMaterial','Show material advantage','checkbox'],[interfaceControls,'playerStyle','Player display','select',[['plain','Plain rows'],['cards','Player cards']]],[interfaceControls,'clockStyle','Clock style','select',[['boxed','Boxed'],['minimal','Minimal'],['digital','Digital']]],[interfaceControls,'clockScale','Clock size','range'],[interfaceControls,'clockActive','Active clock color','color'],[interfaceControls,'clockLow','Low-time color','color'],[interfaceControls,'clockThreshold','Low-time threshold (seconds)','range'],[interfaceControls,'clockPulse','Pulse in low time','checkbox'],[interfaceControls,'hideTenths','Hide clock tenths','checkbox'],[interfaceControls,'moveNumbers','Show move numbers','checkbox'],[interfaceControls,'uiDensity','Control spacing','select',[['compact','Compact'],['cozy','Cozy'],['airy','Airy']]],[interfaceControls,'fontScale','Interface text scale','range'],[interfaceControls,'panelRadius','Panel corners','range'],[interfaceControls,'glassPanels','Translucent panels','checkbox'],[interfaceControls,'scrollbar','Scrollbar width','select',[['slim','Slim'],['standard','Standard'],['wide','Wide']]],[interfaceControls,'hoverMotion','Hover motion','checkbox'],[interfaceControls,'reduceTransparency','Reduce transparency','checkbox']);
  controls.forEach(([parent,...args])=>parent.append(wsControl(...args)));
  const quick=wbElement('div',undefined,'ws-quick-actions');card.append(quick);const undoCustomization=wbButton('Undo customization',wsUndoCustomization);undoCustomization.id='wsUndoCustomization';
  quick.append(wbButton('Previous board',()=>{const p=wsPrefs(),index=WS_BOARD_PRESETS.findIndex(row=>row[1]===p.light&&row[2]===p.dark);wsApplyBoardPreset((index-1+WS_BOARD_PRESETS.length)%WS_BOARD_PRESETS.length);}),wbButton('Next board',()=>{const p=wsPrefs(),index=WS_BOARD_PRESETS.findIndex(row=>row[1]===p.light&&row[2]===p.dark);wsApplyBoardPreset((index+1)%WS_BOARD_PRESETS.length);}),wbButton('Previous pieces',()=>wsApplyPiecePreset((wsPiecePresetIndex-1+WS_PIECE_PRESETS.length)%WS_PIECE_PRESETS.length)),wbButton('Next pieces',()=>wsApplyPiecePreset((wsPiecePresetIndex+1)%WS_PIECE_PRESETS.length)),wbButton('Surprise me',wsSurprise),undoCustomization,wbButton('Reset customization',()=>wsSet(WS_DEFAULTS)));
  const exportButton=wbButton('Export customization…',wsExportCustomization),importButton=wbButton('Import customization…',()=>$('wsImportFile').click()),importFile=document.createElement('input');importFile.id='wsImportFile';importFile.type='file';importFile.accept='.json,application/json';importFile.hidden=true;importFile.addEventListener('change',()=>wbAction(()=>wsImportCustomization(importFile.files[0])).finally(()=>{importFile.value='';}));quick.append(exportButton,importButton,importFile);
  const looks=wsDetails('Saved looks (up to twelve)',card);
  const name=document.createElement('input');name.id='wsPresetName';name.maxLength=40;name.placeholder='Name this look';name.setAttribute('aria-label','Saved look name');
  const select=document.createElement('select');select.id='wsPresetList';select.setAttribute('aria-label','Saved look');
  looks.append(name,select,wbButton('Save look',wsSavePreset),wbButton('Apply look',()=>{const preset=wsPresets()[Number(select.value)];if(select.value!=='' && preset){updateDisplay(preset.base);wsSet(preset.settings);}}),wbButton('Delete look',()=>{if(select.value==='')return;const presets=wsPresets();presets.splice(Number(select.value),1);display.workstation={...wsPrefs(),presets};saveDisplaySettings();wsApply();}));
  const customize=wbButton('Customize board',async()=>{await activateTab(document.querySelector('[data-tab="display"]'));requestAnimationFrame(()=>{$('wsSettings').scrollIntoView({behavior:wsReduced()?'auto':'smooth',block:'start'});$('wsSettingsSearch').focus({preventScroll:true});});},'secondary');customize.id='wsCustomizeBoard';$('flipBtn').after(customize);document.querySelector('.board-actions').classList.add('ws-board-actions');
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
  document.addEventListener('keydown',event=>{if(event.key==='/' && $('displayTab').classList.contains('active') && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){event.preventDefault();search.focus();}});
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',wsApply);
  wsReady=true;wsApply();if(state)render();wbRenderPreview();
}
wsBind();
