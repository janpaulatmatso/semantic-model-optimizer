/* Removes measures and columns from the TMDL files of a Power BI project (Node).
 * Makes a backup first and only writes if the result checks out. */
'use strict';
const fs = require('fs');
const path = require('path');
const SMO = require('./core.js');

function listTmdl(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listTmdl(full, out);
    else if (/\.tmdl$/i.test(e.name)) out.push(full);
  }
  return out;
}

function counts(texts) {
  const model = SMO.emptyModel();
  for (const t of texts) SMO.addTmdlToModel(model, t);
  const keys = new Set();
  for (const t of model.tables) {
    for (const m of t.measures) keys.add('measure|' + t.name.toLowerCase() + '|' + m.name.toLowerCase());
    for (const c of t.columns) keys.add('column|' + t.name.toLowerCase() + '|' + c.name.toLowerCase());
  }
  return keys;
}

/** modelRoot: folder of the model (…​.SemanticModel); items: [{type: 'measure'|'column', table, name}] */
function removeObjects(modelRoot, items) {
  const defDir = path.join(modelRoot, 'definition');
  if (!fs.existsSync(defDir)) throw new Error('No TMDL model found in ' + modelRoot);
  const files = listTmdl(defDir, []);
  const byTable = new Map();
  for (const it of items) {
    if (it.type !== 'measure' && it.type !== 'column') continue;
    const k = String(it.table);
    if (!byTable.has(k)) byTable.set(k, { measures: [], columns: [] });
    byTable.get(k)[it.type === 'measure' ? 'measures' : 'columns'].push(String(it.name));
  }
  const before = new Map(files.map(f => [f, fs.readFileSync(f, 'utf8')]));
  const after = new Map(before);
  const removed = [], warnings = [];
  for (const [table, names] of byTable) {
    for (const f of files) {
      const r = SMO.removeFromTmdl(after.get(f), table, names);
      if (!r.removed.length) continue;
      after.set(f, r.text);
      for (const x of r.removed) removed.push({ type: x.type, table, name: x.name });
      warnings.push(...r.warnings);
    }
  }
  const key = x => x.type + '|' + String(x.table).toLowerCase() + '|' + String(x.name).toLowerCase();
  const gone = new Set(removed.map(key));
  const notFound = items.filter(it => !gone.has(key(it)));

  // check: exactly the requested objects are gone, everything else is still there
  const a = counts([...before.values()]), b = counts([...after.values()]);
  for (const k of a) if (!b.has(k) && !gone.has(k)) throw new Error('Check failed: ' + k + ' would disappear unintentionally. Nothing was changed.');
  for (const k of gone) if (b.has(k)) throw new Error('Check failed: ' + k + ' is still there. Nothing was changed.');
  if (b.size !== a.size - gone.size) throw new Error('Check failed: the counts do not add up. Nothing was changed.');

  const changed = files.filter(f => before.get(f) !== after.get(f));
  let backup = '';
  if (changed.length) {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    backup = path.join(path.dirname(modelRoot), 'smo-backup', stamp);
    for (const f of changed) {
      const dest = path.join(backup, path.basename(modelRoot), path.relative(modelRoot, f));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f, dest);
    }
    for (const f of changed) fs.writeFileSync(f, after.get(f));
  }
  return { removed, notFound, warnings: [...new Set(warnings)], backup, files: changed.length };
}

module.exports = { removeObjects };
