/* Leest een map of bestand van schijf in als [{path, text}] voor core.js (Node). */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const SMO = require('./core.js');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.pbi', 'StaticResources', 'RegisteredResources']);
const MAX_FILES = 50000;

async function readZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const reader = {
      size,
      read: async (off, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return new Uint8Array(b.buffer, b.byteOffset, len); },
    };
    const want = n => n === 'Report/Layout' || n === 'DataModelSchema' || (/^Report\/definition\//.test(n) && /\.json$/i.test(n));
    return await SMO.readZipTexts(reader, async d => new Uint8Array(zlib.inflateRawSync(d)), want);
  } finally { fs.closeSync(fd); }
}

/** target: map, .pbip, .pbix of .pbit → {files, warnings} */
async function loadPath(target) {
  const files = [], warnings = [];
  let st;
  try { st = fs.statSync(target); } catch (e) { throw new Error('Pad niet gevonden: ' + target); }
  if (st.isFile() && /\.pbip$/i.test(target)) { target = path.dirname(target); st = fs.statSync(target); }

  const addZip = async (file, rel) => {
    try {
      const z = await readZip(file);
      for (const f of z.files) files.push({ path: rel + '/' + f.path, text: f.text });
      if (/\.pbix$/i.test(file) && z.names.includes('DataModel') && !z.names.includes('DataModelSchema')) {
        warnings.push(path.basename(file) + ': het rapport is gelezen, maar het model in een .pbix is niet leesbaar. Sla het bestand op als Power BI-project (.pbip) of als sjabloon (.pbit) en laad dat.');
      }
    } catch (e) { warnings.push(path.basename(file) + ': ' + e.message); }
  };

  if (st.isFile()) {
    if (/\.(pbix|pbit)$/i.test(target)) await addZip(target, path.basename(target));
    else files.push({ path: path.basename(target), text: SMO.decodeText(new Uint8Array(fs.readFileSync(target))) });
    return { files, warnings };
  }
  const walk = async (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (files.length > MAX_FILES) return;
      const full = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(full, r); }
      else if (/\.(pbix|pbit)$/i.test(e.name)) await addZip(full, r);
      else if (SMO.wantsFile(r)) files.push({ path: r, text: SMO.decodeText(new Uint8Array(fs.readFileSync(full))) });
    }
  };
  await walk(target, path.basename(path.resolve(target)));
  return { files, warnings };
}

module.exports = { loadPath };
