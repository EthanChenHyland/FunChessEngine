"use strict";
// Origin-independent collections. Frequent recovery saves never rewrite large histories.
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const MAX_BYTES = 32 * 1024 * 1024;
const KEYS = new Set(['display','recovery','recents','trainer','annotations','benchmarks','variations','bookmarks','onboarding','analysisQueue','tournaments','positionCache','lessons','enginePresets','plugins','externalEngines','sessionGoals','calibrationHistory','externalCompareHistory','regressionHistory'].map(key=>`funChessEngine.${key}.v1`));

function atomicWrite(filename, text) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, text); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, filename);
  } finally { fs.rmSync(temporary, {force:true}); }
}

function metadataStore(profile) {
  const directory = path.join(profile, 'workspace-collections');
  const legacy = path.join(profile, 'workspace-metadata.json');
  const filename = key => path.join(directory, `${key}.json`);
  function encode(value) {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') throw new Error('Desktop metadata must be JSON data.');
    return text;
  }
  function read(file) {
    if (fs.statSync(file).size > MAX_BYTES) throw new Error('Desktop metadata exceeds 32 MB.');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  // A failed or interrupted migration is safe to retry: newer collection files win.
  if (fs.existsSync(legacy)) {
    const data = read(legacy);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Desktop metadata file is invalid.');
    fs.mkdirSync(directory, {recursive:true});
    for (const key of KEYS) {
      if (Object.hasOwn(data, key) && !fs.existsSync(filename(key))) atomicWrite(filename(key), encode(data[key]));
    }
    fs.renameSync(legacy, path.join(profile, `workspace-metadata.${randomUUID()}.legacy.json`));
  }
  return {
    get(key) {
      if (!KEYS.has(key)) throw new Error('Unknown metadata collection.');
      const file = filename(key);
      return fs.existsSync(file) ? {found:true, value:read(file)} : {found:false};
    },
    set(key, value) {
      if (!KEYS.has(key)) throw new Error('Unknown metadata collection.');
      const text = encode(value);
      let bytes = Buffer.byteLength(text, 'utf8');
      for (const other of KEYS) {
        if (other !== key && fs.existsSync(filename(other))) bytes += fs.statSync(filename(other)).size;
      }
      if (bytes > MAX_BYTES) throw new Error('Desktop metadata exceeds 32 MB. Export and remove older results.');
      fs.mkdirSync(directory, {recursive:true});
      atomicWrite(filename(key), text);
    },
  };
}
module.exports = {metadataStore};
