/* Web version: changes to a Power BI project in a folder the user picked (File System Access API).
 * The same modules the app uses (edit.js, remove.js, fix.js, loader.js) run here against a file system in memory,
 * filled from that folder. Afterwards only the files they wrote or removed go back to the folder, after the browser
 * has asked the user for permission. So the checks and the backups in smo-backup are exactly those of the app.
 * build-web.js bundles this file with those modules into local.js; it is not used by the app itself. */
'use strict';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.pbi', 'StaticResources', 'RegisteredResources']);
const ZIP = /\.(pbix|pbit|vpax)$/i;
const MAX_BYTES = 20e6;

// ------------------------------------------------------------ path (POSIX, absolute paths start with /)

function normalize(p) {
  const out = [];
  for (const part of String(p).replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return '/' + out.join('/');
}
const pathShim = {
  sep: '/',
  join: (...parts) => normalize(parts.filter(x => x !== '').join('/')),
  resolve: (...parts) => normalize(parts.join('/')),
  dirname: p => { const n = normalize(p); return n.slice(0, n.lastIndexOf('/')) || '/'; },
  basename: p => normalize(p).split('/').pop(),
  relative: (from, to) => {
    const a = normalize(from), b = normalize(to);
    if (b === a) return '';
    if (b.startsWith(a === '/' ? '/' : a + '/')) return b.slice(a === '/' ? 1 : a.length + 1);
    throw new Error('relative path outside the folder: ' + to);
  },
};

// ------------------------------------------------------------ fs (synchronous, in memory)

function memFs(initial) {
  const files = new Map(), dirs = new Set(['/']), touched = new Set();
  const addDirs = p => { for (let d = pathShim.dirname(p); !dirs.has(d); d = pathShim.dirname(d)) dirs.add(d); };
  for (const [p, bytes] of initial) { const n = normalize(p); files.set(n, bytes); addDirs(n); }
  const enoent = p => Object.assign(new Error('ENOENT: no such file or directory, ' + p), { code: 'ENOENT' });
  const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { ignoreBOM: true }); // like Node: a BOM stays in the text
  const fs = {
    existsSync: p => { const n = normalize(p); return files.has(n) || dirs.has(n); },
    statSync: p => {
      const n = normalize(p);
      if (files.has(n)) return { isFile: () => true, isDirectory: () => false, size: files.get(n).length };
      if (dirs.has(n)) return { isFile: () => false, isDirectory: () => true, size: 0 };
      throw enoent(p);
    },
    readdirSync: (p, opts) => {
      const n = normalize(p), pre = n === '/' ? '/' : n + '/';
      if (!dirs.has(n)) throw enoent(p);
      const kids = new Map();
      for (const f of files.keys()) if (f.startsWith(pre) && !f.slice(pre.length).includes('/')) kids.set(f.slice(pre.length), false);
      for (const d of dirs) if (d !== n && d.startsWith(pre) && !d.slice(pre.length).includes('/')) kids.set(d.slice(pre.length), true);
      const names = [...kids.keys()].sort();
      return opts && opts.withFileTypes ? names.map(name => ({ name, isDirectory: () => kids.get(name), isFile: () => !kids.get(name) })) : names;
    },
    readFileSync: (p, encoding) => {
      const n = normalize(p);
      if (!files.has(n)) throw enoent(p);
      const b = files.get(n);
      return encoding ? dec.decode(b) : b;
    },
    writeFileSync: (p, data) => {
      const n = normalize(p);
      if (!dirs.has(pathShim.dirname(n))) throw enoent(p);
      files.set(n, typeof data === 'string' ? enc.encode(data) : new Uint8Array(data));
      touched.add(n);
    },
    mkdirSync: p => { const n = normalize(p); dirs.add(n); addDirs(n); },
    copyFileSync: (a, b) => fs.writeFileSync(b, fs.readFileSync(a)),
    unlinkSync: p => { const n = normalize(p); if (!files.delete(n)) throw enoent(p); touched.add(n); },
  };
  for (const name of ['openSync', 'fstatSync', 'readSync', 'closeSync']) fs[name] = () => { throw new Error('Reading .pbix, .pbit or .vpax files is not needed for a change.'); };
  /** What changed: [{path, bytes}] to write and [path] to remove. */
  const changes = () => {
    const write = [], remove = [];
    for (const p of touched) { if (files.has(p)) write.push({ path: p, bytes: files.get(p) }); else remove.push(p); }
    return { write, remove };
  };
  return { fs, changes };
}

// ------------------------------------------------------------ the folder

let root = null; // FileSystemDirectoryHandle

/** Every file in the folder: [{handle, path}] with path starting at the folder's own name. */
async function walk(dir, rel, out, opts) {
  for await (const [name, h] of dir.entries()) {
    const r = rel + '/' + name;
    if (h.kind === 'directory') {
      if (SKIP_DIRS.has(name) || (name === 'smo-backup' && !opts.backups)) continue;
      await walk(h, r, out, opts);
    } else out.push({ handle: h, path: r });
  }
  return out;
}

async function dirFor(path, create) {
  const parts = path.split('/').filter(Boolean);
  if (parts.shift() !== root.name) throw new Error('Outside the folder: ' + path);
  let d = root;
  for (const p of parts) d = await d.getDirectoryHandle(p, { create });
  return d;
}

async function permission(mode) {
  const o = { mode };
  if ((await root.queryPermission(o)) === 'granted') return true;
  return (await root.requestPermission(o)) === 'granted';
}

/** The folder as files for the tool: {files, warnings, base, target}. readBrowserFiles is the app's own reader. */
async function load(readBrowserFiles) {
  if (!(await permission('read'))) throw new Error('The browser did not allow reading the folder.');
  const list = await walk(root, root.name, [], { backups: false });
  const picked = [];
  for (const f of list) picked.push({ file: await f.handle.getFile(), path: f.path });
  const r = await readBrowserFiles(picked);
  return { files: r.files, warnings: r.warnings, base: '/', target: '/' + root.name };
}

const SERVER_ONLY = {
  'api/describe': 'Suggesting descriptions needs the desktop app.',
  'api/compare': 'Comparing with Git needs the desktop app.',
};

/** A change, as the app's server would do it: same request, same answer. */
async function post(url, body) {
  const route = String(url).replace(/^\//, '');
  if (SERVER_ONLY[route]) return { error: SERVER_ONLY[route] };
  const writes = route !== 'api/backups';
  if (writes && !(await permission('readwrite'))) return { error: 'Nothing was changed: the browser did not get permission to save in the folder.' };
  if (!writes && !(await permission('read'))) return { error: 'The browser did not allow reading the folder.' };

  // fill the file system in memory from the folder as it is now (another program may have changed it)
  const list = await walk(root, root.name, [], { backups: true });
  const initial = [];
  for (const f of list) {
    if (ZIP.test(f.path)) continue;
    const file = await f.handle.getFile();
    if (file.size > MAX_BYTES) continue;
    initial.push(['/' + f.path, new Uint8Array(await file.arrayBuffer())]);
  }
  const mem = memFs(initial);
  current.fs = mem.fs;
  let r;
  try {
    const M = modules();
    const j = body || {};
    const target = String(j.path), modelRoot = String(j.modelRoot);
    if (route === 'api/edit') r = await M.edit.editObject(target, modelRoot, j.sel, j.changes);
    else if (route === 'api/delete') r = M.remove.removeObjects(M.loader.modelRootAbs(await M.loader.loadPath(target), modelRoot), j.items || []);
    else if (route === 'api/fix') r = await M.fix.fixRule(target, modelRoot, String(j.rule), j.ids);
    else if (route === 'api/folder') r = await M.fix.setFolder(target, modelRoot, j.ids, j.folder);
    else if (route === 'api/table') r = j.op === 'rename' ? await M.fix.renameTable(target, modelRoot, String(j.table), String(j.name)) : await M.fix.removeTables(target, modelRoot, (j.tables || []).map(String));
    else if (route === 'api/backups') r = await M.fix.listBackups(target, modelRoot);
    else if (route === 'api/restore') r = await M.fix.restoreBackup(target, modelRoot, String(j.stamp));
    else return { error: 'Not available in the web version: ' + route };
  } catch (e) {
    return { error: e.message };
  }
  // write back what changed: new and changed files first, then the removals
  const { write, remove } = mem.changes();
  for (const w of write) {
    const fh = await (await dirFor(pathShim.dirname(w.path), true)).getFileHandle(pathShim.basename(w.path), { create: true });
    const out = await fh.createWritable();
    await out.write(w.bytes);
    await out.close();
  }
  for (const p of remove) {
    try { await (await dirFor(pathShim.dirname(p), false)).removeEntry(pathShim.basename(p)); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
  }
  delete r.analysis;
  for (const k of ['backup', 'undo']) if (typeof r[k] === 'string' && r[k].startsWith('/')) r[k] = r[k].slice(1);
  return r;
}

const current = { fs: null };

module.exports = {
  pathShim, memFs, current,
  open: handle => { root = handle; },
  close: () => { root = null; },
  active: () => !!root,
  name: () => (root ? root.name : ''),
  load, post,
  handles: url => /^\/?api\/(edit|delete|fix|folder|table|backups|restore|describe|compare)$/.test(String(url)),
};
// set by the bundle: the modules of the app, loaded against current.fs
let modules = () => { throw new Error('local.js was not built with its modules'); };
module.exports.setModules = fn => { modules = fn; };
