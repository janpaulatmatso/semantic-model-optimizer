/* Changes the name, description or formula of a measure, column or table in a Power BI project (Node).
 * On rename, references in formulas and in the report (PBIR) are updated.
 * Only writes if the model still has exactly the same structure after the change. */
'use strict';
const fs = require('fs');
const path = require('path');
const SMO = require('./core.js');
const { loadPath, modelRootAbs } = require('./loader.js');

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Copies every file about to change into smo-backup first, then writes. changed: Map(absPath → text) */
function backupAndWrite(modelRootAbs, changed, relOf) {
  if (!changed.size) return '';
  let backup = path.join(path.dirname(modelRootAbs), 'smo-backup', stamp());
  for (let i = 2, base = backup; fs.existsSync(backup); i++) backup = base + '-' + i;
  for (const f of changed.keys()) {
    const dest = path.join(backup, relOf(f));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f, dest);
  }
  for (const [f, text] of changed) fs.writeFileSync(f, text);
  return backup;
}

/** Fingerprint of the model: objects, dependencies and report usage. */
function signature(analysis, mapId, skipDepsOf) {
  const m = id => (mapId && mapId[id]) || id;
  const out = new Set();
  for (const n of analysis.list) {
    out.add('object ' + m(n.id));
    out.add('report use ' + m(n.id) + ' ×' + n.reportUses.length);
    if (n.id !== skipDepsOf) for (const d of n.deps) out.add('reference ' + m(n.id) + ' → ' + m(d));
  }
  out.add('broken references ×' + analysis.broken.length);
  return out;
}

/**
 * target: the path loaded in the tool; modelRoot: relative path of the model;
 * sel: {type, table, name}; changes: {name?, description?, expression?}
 */
async function editObject(target, modelRoot, sel, changes) {
  if (!['measure', 'column', 'table'].includes(sel.type)) throw new Error('This kind of object cannot be edited.');
  const loaded = await loadPath(target);
  const rootRel = String(modelRoot).replace(/\\/g, '/').replace(/\/$/, '');
  const absOf = new Map(loaded.files.filter(f => f.abs).map(f => [f.path, f.abs]));
  const abs = rel => absOf.get(rel);
  const onDisk = f => !!f.abs && !/\.(pbix|pbit|vpax)\//i.test(f.path);
  const isModelFile = f => f.path.replace(/\\/g, '/').startsWith(rootRel + '/definition/') && /\.tmdl$/i.test(f.path);

  // work with the raw file contents (BOM and line endings stay as they are)
  const texts = new Map();
  for (const f of loaded.files) if (onDisk(f)) texts.set(f.path, fs.readFileSync(abs(f.path), 'utf8'));
  const fileList = t => loaded.files.map(f => ({ path: f.path, text: t.has(f.path) ? t.get(f.path) : f.text }));

  const pick = proj => proj.models.find(m => m.root === rootRel);
  const projBefore = SMO.loadProject(fileList(texts));
  const mBefore = pick(projBefore);
  if (!mBefore || mBefore.format !== 'tmdl') throw new Error('No TMDL model found at ' + rootRel);
  const before = SMO.analyze(mBefore.model, projBefore.reports);
  const prefix = sel.type === 'measure' ? 'M|' : sel.type === 'column' ? 'C|' : 'T|';
  const node = [...before.nodes.values()].find(n => n.id.startsWith(prefix) && n.table.toLowerCase() === String(sel.table).toLowerCase() &&
    (sel.type === 'table' || n.name.toLowerCase() === String(sel.name).toLowerCase()));
  if (!node || node.kind === 'report measure') throw new Error('Object not found in the model.');

  const ch = {};
  if (changes.description !== undefined && String(changes.description).trim() !== String(node.description || '').trim()) ch.description = String(changes.description);
  if (changes.expression !== undefined && String(changes.expression).trim() !== String(node.expression || '').trim()) {
    if (sel.type === 'table' || !node.expression) throw new Error('This object has no formula that can be edited here.');
    if (!String(changes.expression).trim()) throw new Error('The formula cannot be empty.');
    ch.expression = String(changes.expression);
  }
  let newName = null;
  if (changes.name !== undefined && String(changes.name).trim() !== node.name) {
    newName = String(changes.name).trim();
    if (sel.type === 'table') throw new Error('Renaming tables is not supported yet.');
    if (!newName || /[\r\n\t]/.test(newName)) throw new Error('Invalid name.');
    const low = newName.toLowerCase();
    if (low !== node.name.toLowerCase()) {
      for (const n of before.list) {
        if (n.type !== 'measure' && n.type !== 'column') continue;
        const clash = n.name.toLowerCase() === low && (n.table.toLowerCase() === node.table.toLowerCase() || (n.type === 'measure' && sel.type === 'measure'));
        if (clash) throw new Error('A ' + n.kind + ' named ' + newName + ' already exists' + (n.table ? ' in ' + n.table : '') + '.');
      }
    }
    ch.name = newName;
  }
  if (!Object.keys(ch).length) return { changed: false, files: 0, backup: '', reportFields: 0 };

  const after = new Map(texts);
  let reportFields = 0;
  const tgt = { type: sel.type, table: node.table, name: node.name };
  if (newName) {
    for (const f of loaded.files) {
      if (!onDisk(f)) continue;
      if (isModelFile(f)) after.set(f.path, SMO.renameRefsTmdl(after.get(f.path), tgt, newName, before.resolve, node.id));
      else if (/\.json$/i.test(f.path) && /\/definition\//.test('/' + f.path)) {
        const raw = after.get(f.path);
        let j;
        try { j = JSON.parse(raw.replace(/^﻿/, '')); } catch (e) { continue; }
        const c = SMO.renameInReport(j, tgt, newName);
        if (!c) continue;
        reportFields += c;
        const bom = raw.charCodeAt(0) === 0xFEFF ? '﻿' : '';
        let out = JSON.stringify(j, null, 2);
        if (/\r\n/.test(raw)) out = out.replace(/\n/g, '\r\n');
        after.set(f.path, bom + out + (/\n$/.test(raw) ? (/\r\n$/.test(raw) ? '\r\n' : '\n') : ''));
      }
    }
  }
  let found = false;
  for (const f of loaded.files) {
    if (!onDisk(f) || !isModelFile(f)) continue;
    const r = SMO.editTmdlObject(after.get(f.path), tgt, ch);
    if (r.found) { after.set(f.path, r.text); found = true; break; }
  }
  if (!found) throw new Error('The declaration of ' + node.name + ' was not found in the TMDL files.');

  // check: same model, with only the requested change
  const projAfter = SMO.loadProject(fileList(after));
  const mAfter = pick(projAfter);
  if (!mAfter) throw new Error('Check failed: the model can no longer be read after the change. Nothing was changed.');
  const an = SMO.analyze(mAfter.model, projAfter.reports);
  const newId = newName ? prefix + node.table + '|' + newName : node.id;
  const a = signature(before, newName ? { [node.id]: newId } : null, ch.expression !== undefined ? node.id : null);
  const b = signature(an, null, ch.expression !== undefined ? newId : null);
  const diff = [...a].filter(x => !b.has(x)).concat([...b].filter(x => !a.has(x)));
  if (diff.length) {
    throw new Error('Check failed, nothing was changed. After the change the model would have a different structure: ' + diff.slice(0, 3).join('; ') +
      (newName ? '. Is a report that uses this field in the legacy format or in a .pbix? The tool cannot update those.' : ''));
  }
  const got = an.nodes.get(newId);
  if (!got) throw new Error('Check failed: the object cannot be found after the change. Nothing was changed.');
  if (ch.description !== undefined && String(got.description || '').trim() !== ch.description.trim().split(/\r?\n/).map(l => l.trim()).join('\n')) {
    throw new Error('Check failed: the description does not read back correctly. Nothing was changed.');
  }
  if (ch.expression !== undefined && got.expression.replace(/\s+/g, '') !== ch.expression.replace(/\s+/g, '')) {
    throw new Error('Check failed: the formula does not read back correctly. Nothing was changed.');
  }

  const changed = new Map();
  for (const [rel, text] of after) if (text !== texts.get(rel)) changed.set(abs(rel), text);
  const relOf = new Map([...absOf].map(([rel, a]) => [a, rel]));
  const backup = backupAndWrite(modelRootAbs(loaded, rootRel), changed, f => relOf.get(f));
  return { changed: true, files: changed.size, backup, reportFields, id: newId, renamed: !!newName };
}

module.exports = { editObject, backupAndWrite };
