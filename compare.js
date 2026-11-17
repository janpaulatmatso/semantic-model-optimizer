/* Compares the project on disk with another version of itself: a Git branch, tag or commit,
 * or simply another folder (Node). Read-only. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const SMO = require('./core.js');
const { loadPath, splitPaths } = require('./loader.js');

function analyzeFiles(files, modelRoot) {
  const p = SMO.loadProject(files);
  const m = (modelRoot && p.models.find(x => x.root === modelRoot)) || p.models[0];
  if (!m) throw new Error('No model found.');
  return { project: p, model: m, analysis: SMO.analyze(m.model, p.reports, { noModel: !!m.missing }) };
}

/** The files of the given folders as they are in one Git revision, read straight from a Git archive. */
async function refFiles(paths, ref) {
  if (!/^[\w./@^~-]+$/.test(ref)) throw new Error('Not a valid branch, tag or commit: ' + ref);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smo-compare-'));
  const files = [];
  try {
    for (const [i, p] of paths.entries()) {
      let abs = path.resolve(p);
      if (fs.statSync(abs).isFile()) abs = path.dirname(abs);
      let top;
      try { top = execFileSync('git', ['-C', abs, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
      catch (e) { throw new Error('Not inside a Git repository: ' + abs); }
      const rel = path.relative(top, abs).replace(/\\/g, '/');
      const zip = path.join(tmp, i + '.zip');
      try { execFileSync('git', ['-C', top, 'archive', '--format=zip', '-o', zip, ref].concat(rel ? [rel] : []), { stdio: ['ignore', 'ignore', 'pipe'] }); }
      catch (e) { throw new Error('Git could not read ' + (rel || 'the repository') + ' at ' + ref + ': ' + String(e.stderr || e.message).trim().split('\n')[0]); }
      const fd = fs.openSync(zip, 'r');
      try {
        const reader = { size: fs.fstatSync(fd).size, read: async (off, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return new Uint8Array(b.buffer, b.byteOffset, len); } };
        const z = await SMO.readZipTexts(reader, async d => new Uint8Array(zlib.inflateRawSync(d)), n => !n.endsWith('/') && SMO.wantsFile(n));
        // same shape as loadPath: paths start with the name of the loaded folder
        const top2 = path.basename(abs) + (paths.length > 1 && files.some(f => f.path.split('/')[0] === path.basename(abs)) ? '~' + (i + 1) : '');
        for (const f of z.files) files.push({ path: top2 + f.path.slice(rel.length), text: f.text });
      } finally { fs.closeSync(fd); }
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return files;
}

/** target: path(s) loaded now; other: {ref} or {path}. → the differences, "before" being the other version. */
async function compare(target, other, modelRoot) {
  const now = analyzeFiles((await loadPath(target)).files, modelRoot);
  const otherFiles = other.ref ? await refFiles(splitPaths(target), other.ref) : (await loadPath(other.path)).files;
  const then = analyzeFiles(otherFiles, null);
  const diff = SMO.compareAnalyses(then.analysis, now.analysis);
  return Object.assign(diff, { against: other.ref || other.path, model: now.model.name });
}

const compareWithRef = (target, modelRoot, ref) => compare(target, { ref: ref || 'HEAD' }, modelRoot);

module.exports = { compare, compareWithRef };
