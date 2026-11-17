/* Reads a folder or file from disk as [{path, text, abs}] for core.js (Node).
 * Several paths can be loaded at once, separated by a semicolon. */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const SMO = require('./core.js');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.pbi', 'StaticResources', 'RegisteredResources', 'smo-backup']);
const MAX_FILES = 50000;

async function readZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const reader = {
      size,
      read: async (off, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return new Uint8Array(b.buffer, b.byteOffset, len); },
    };
    return await SMO.readZipTexts(reader, async d => new Uint8Array(zlib.inflateRawSync(d)), SMO.zipWants);
  } finally { fs.closeSync(fd); }
}

/** One folder, .pbip, .pbix, .pbit or .vpax. Files on disk get 'abs'; files from a zip do not. */
async function loadOne(target) {
  const files = [], warnings = [];
  let st;
  try { st = fs.statSync(target); } catch (e) { throw new Error('Path not found: ' + target); }
  if (st.isFile() && /\.pbip$/i.test(target)) { target = path.dirname(target); st = fs.statSync(target); }
  const base = path.dirname(path.resolve(target));

  const addZip = async (file, rel) => {
    try {
      const z = await readZip(file);
      for (const f of z.files) files.push({ path: rel + '/' + f.path, text: f.text });
      if (/\.pbix$/i.test(file) && z.names.includes('DataModel') && !z.names.includes('DataModelSchema')) {
        warnings.push(path.basename(file) + ': the report was read, but the model inside a .pbix cannot be read. Save the file as a Power BI project (.pbip) or as a template (.pbit) and load that.');
      }
    } catch (e) { warnings.push(path.basename(file) + ': ' + e.message); }
  };
  const addFile = (full, rel) => files.push({ path: rel, text: SMO.decodeText(new Uint8Array(fs.readFileSync(full))), abs: path.resolve(full) });

  if (st.isFile()) {
    if (/\.(pbix|pbit|vpax)$/i.test(target)) await addZip(target, path.basename(target));
    else addFile(target, path.basename(target));
    return { files, warnings, base, top: path.basename(target) };
  }
  const walk = async (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (files.length > MAX_FILES) return;
      const full = path.join(dir, e.name), r = rel + '/' + e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(full, r); }
      else if (/\.(pbix|pbit|vpax)$/i.test(e.name)) await addZip(full, r);
      else if (SMO.wantsFile(r)) addFile(full, r);
    }
  };
  const top = path.basename(path.resolve(target));
  await walk(target, top);
  return { files, warnings, base, top };
}

const splitPaths = t => (Array.isArray(t) ? t : String(t).split(';')).map(s => String(s).trim().replace(/^"|"$/g, '')).filter(Boolean);

/** targets: one path, several separated by ';', or a list → {files, warnings, base, target} */
async function loadPath(targets) {
  const list = splitPaths(targets);
  const seen = new Set(list.map(p => path.resolve(p).toLowerCase()));
  const uniq = list.filter(p => { const k = path.resolve(p).toLowerCase(); if (!seen.has(k)) return false; seen.delete(k); return true; });
  const out = { files: [], warnings: [], base: null, target: uniq.join(';') };
  const tops = new Set();
  for (const t of uniq) {
    const r = await loadOne(t);
    let top = r.top;
    for (let k = 2; tops.has(top.toLowerCase()); k++) top = r.top + '~' + k;
    tops.add(top.toLowerCase());
    for (const f of r.files) out.files.push(Object.assign(f, { path: top + f.path.slice(r.top.length) }));
    out.warnings.push(...r.warnings);
    if (!out.base) out.base = r.base;
  }
  return out;
}

/** Absolute folder of a model (relative path from the project), derived from the loaded files. */
function modelRootAbs(loaded, modelRoot) {
  const rootRel = String(modelRoot).replace(/\\/g, '/').replace(/\/$/, '');
  const f = loaded.files.find(x => x.abs && x.path.startsWith(rootRel + '/'));
  if (!f) throw new Error('Model not found on disk: ' + rootRel);
  return f.abs.slice(0, f.abs.length - (f.path.length - rootRel.length));
}

module.exports = { loadPath, modelRootAbs, splitPaths };
