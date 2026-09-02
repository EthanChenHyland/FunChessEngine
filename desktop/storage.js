"use strict";
// Origin-independent desktop metadata, shared by every backend port in one profile.
const fs = require('node:fs');
const path = require('node:path');
const MAX_BYTES = 32 * 1024 * 1024;
const KEYS = new Set(['display','recovery','recents','trainer','annotations','benchmarks','variations','bookmarks','onboarding','analysisQueue','tournaments','positionCache','lessons','enginePresets','plugins','externalEngines','sessionGoals','calibrationHistory','externalCompareHistory','regressionHistory'].map(key=>`funChessEngine.${key}.v1`));
function metadataStore(profile) {
  const filename = path.join(profile, 'workspace-metadata.json');
  function read() {
    if (!fs.existsSync(filename)) return {};
    if (fs.statSync(filename).size > MAX_BYTES) throw new Error('Desktop metadata exceeds 32 MB.');
    const data=JSON.parse(fs.readFileSync(filename,'utf8'));
    if (!data || typeof data!=='object' || Array.isArray(data)) throw new Error('Desktop metadata file is invalid.');
    return data;
  }
  return {
    get(key) {
      if (!KEYS.has(key)) throw new Error('Unknown metadata collection.');
      const data=read();
      return {found:Object.hasOwn(data,key),value:data[key]};
    },
    set(key,value) {
      if (!KEYS.has(key)) throw new Error('Unknown metadata collection.');
      const data=read(); data[key]=value;
      const text=JSON.stringify(data);
      if (Buffer.byteLength(text,'utf8')>MAX_BYTES) throw new Error('Desktop metadata exceeds 32 MB. Export and remove older results.');
      fs.mkdirSync(profile,{recursive:true});
      const temporary=`${filename}.tmp`;
      const descriptor=fs.openSync(temporary,'w',0o600);
      try { fs.writeFileSync(descriptor,text); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary,filename);
    },
  };
}
module.exports={metadataStore};
