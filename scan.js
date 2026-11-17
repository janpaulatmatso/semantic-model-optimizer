/* Scans a local repository (or any folder) for Power BI projects (.pbip) and
 * reports which report belongs to which semantic model (Node). Read-only. */
'use strict';
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['.git', 'node_modules', 'smo-backup', '.pbi', '.vs', '.vscode', 'bin', 'obj']);
const MAX_DEPTH = 12, MAX_DIRS = 30000;

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const strip = n => n.replace(/\.(Report|SemanticModel|Dataset|pbip)$/i, '');

function gitBranch(root) {
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : head.slice(0, 8);
  } catch (e) { return ''; }
}

/** root: folder to scan → {repo, name, branch, items: [{name, report, model, modelName, live, missing, rel}]} */
function scanRepo(root) {
  root = path.resolve(String(root).trim().replace(/^"|"$/g, ''));
  let st;
  try { st = fs.statSync(root); } catch (e) { throw new Error('Folder not found: ' + root); }
  if (!st.isDirectory()) throw new Error('Not a folder: ' + root);

  const pbips = [];
  let dirs = 0;
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || ++dirs > MAX_DIRS) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.isFile()) { if (/\.pbip$/i.test(e.name)) pbips.push(path.join(dir, e.name)); }
      else if (e.isDirectory() && /\.Report$/i.test(e.name)) reportDirs.push(path.join(dir, e.name));
      else if (e.isDirectory() && !SKIP.has(e.name) && !/\.(SemanticModel|Dataset)$/i.test(e.name)) walk(path.join(dir, e.name), depth + 1);
    }
  };
  const reportDirs = [];
  walk(root, 0);

  // reports named in a .pbip first, then report folders that have no .pbip of their own
  const candidates = [];
  for (const pbip of pbips.sort()) {
    let j;
    try { j = readJson(pbip); } catch (e) { continue; }
    for (const a of j.artifacts || []) {
      const rel = a && a.report && a.report.path;
      if (rel) candidates.push(path.resolve(path.dirname(pbip), rel));
    }
  }
  for (const d of reportDirs.sort()) if (fs.existsSync(path.join(d, 'definition.pbir'))) candidates.push(d);

  const items = [], seen = new Set();
  {
    for (const report of candidates) {
      if (seen.has(report.toLowerCase()) || !fs.existsSync(report)) continue;
      seen.add(report.toLowerCase());
      let model = null, live = false, missing = false;
      try {
        const ref = readJson(path.join(report, 'definition.pbir')).datasetReference || {};
        if (ref.byPath && ref.byPath.path) {
          model = path.resolve(report, ref.byPath.path);
          if (!fs.existsSync(model)) { model = null; missing = true; }
        } else if (ref.byConnection) live = true;
      } catch (e) { missing = true; }
      items.push({
        name: strip(path.basename(report)), report, model, modelName: model ? strip(path.basename(model)) : '',
        live, missing, rel: path.relative(root, report).replace(/\\/g, '/'),
        modelRel: model ? path.relative(root, model).replace(/\\/g, '/') : '',
      });
    }
  }
  return { repo: root, name: path.basename(root), branch: gitBranch(root), items, truncated: dirs > MAX_DIRS };
}

module.exports = { scanRepo };
