/* Changes that touch several files of a Power BI project (Node): fixing check findings in bulk,
 * deleting and renaming tables, and restoring a backup.
 * Every change is checked in memory first; files are only written when the model still fits together. */
'use strict';
const fs = require('fs');
const path = require('path');
const SMO = require('./core.js');
const { loadPath, modelRootAbs } = require('./loader.js');

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** A backup folder that does not exist yet: two changes within one second must not share one. */
function newBackupDir(parent) {
  const base = path.join(parent, 'smo-backup', stamp());
  let dir = base;
  for (let i = 2; fs.existsSync(dir); i++) dir = base + '-' + i;
  return dir;
}

/** Fingerprint of a model: objects, references between them and report usage. mapId renames ids on the "before" side. */
function signature(analysis, mapId, withRefs) {
  const m = id => (mapId ? mapId(id) : id);
  const out = new Set();
  for (const n of analysis.list) {
    out.add('object ' + m(n.id));
    out.add('report use ' + m(n.id) + ' ×' + n.reportUses.length);
    if (withRefs !== false) for (const d of n.deps) out.add('reference ' + m(n.id) + ' → ' + m(d));
  }
  out.add('broken references ×' + analysis.broken.length);
  return out;
}
function sameOrThrow(a, b, hint) {
  const diff = [...a].filter(x => !b.has(x)).concat([...b].filter(x => !a.has(x)));
  if (diff.length) throw new Error('Check failed, nothing was changed. After the change the model would be put together differently: ' + diff.slice(0, 3).join('; ') + (hint ? '. ' + hint : ''));
}

/** Loads the project, lets `mutate` change texts in memory, verifies, then writes with a backup. */
async function transact(target, modelRoot, mutate) {
  const loaded = await loadPath(target);
  const rootRel = String(modelRoot).replace(/\\/g, '/').replace(/\/$/, '');
  const absOf = new Map(loaded.files.filter(f => f.abs).map(f => [f.path, f.abs]));
  const texts = new Map();
  for (const [rel, abs] of absOf) texts.set(rel, fs.readFileSync(abs, 'utf8'));
  const project = t => SMO.loadProject(loaded.files.filter(f => !f.abs || t.has(f.path)).map(f => ({ path: f.path, text: t.has(f.path) ? t.get(f.path) : f.text })));
  const pick = p => p.models.find(m => m.root === rootRel);
  const pBefore = project(texts), mBefore = pick(pBefore);
  if (!mBefore || mBefore.format !== 'tmdl') throw new Error('No TMDL model found at ' + rootRel);
  const before = SMO.analyze(mBefore.model, pBefore.reports);
  const ctx = {
    loaded, rootRel, texts, after: new Map(texts), before, model: mBefore.model, project: pBefore,
    isModelFile: rel => rel.startsWith(rootRel + '/definition/') && /\.tmdl$/i.test(rel),
    isReportJson: rel => /\.json$/i.test(rel) && /\/definition\//.test('/' + rel) && !rel.startsWith(rootRel + '/'),
    renames: new Map(), // old rel → new rel
  };
  const verify = await mutate(ctx);
  // apply file renames and deletions to the in-memory set
  const final = new Map();
  for (const [rel, text] of ctx.after) { if (text != null) final.set(ctx.renames.get(rel) || rel, text); }
  const pAfter = SMO.loadProject(loaded.files.filter(f => !f.abs).map(f => ({ path: f.path, text: f.text })).concat([...final].map(([p, text]) => ({ path: p, text }))));
  const mAfter = pick(pAfter);
  if (!mAfter) throw new Error('Check failed: the model cannot be read after the change. Nothing was changed.');
  const an = SMO.analyze(mAfter.model, pAfter.reports);
  if (verify) verify(before, an, mAfter.model);

  // write: back up every file that changes or disappears
  const rootAbs = modelRootAbs(loaded, rootRel);
  const absFor = rel => absOf.get(rel) || path.join(path.dirname(absOf.get([...ctx.renames].find(([, n]) => n === rel)[0])), path.basename(rel));
  const writes = [], removes = [];
  for (const [rel, old] of texts) {
    const text = ctx.after.get(rel), moved = ctx.renames.get(rel);
    if (text == null || moved) removes.push(rel);
    if (text != null && (moved || text !== old)) writes.push([moved || rel, text]);
  }
  if (!writes.length && !removes.length) return { changed: false, files: 0, backup: '' };
  const backup = newBackupDir(path.dirname(rootAbs));
  const touched = new Set(removes.concat(writes.map(w => w[0]).filter(rel => texts.has(rel))));
  for (const rel of touched) {
    const dest = path.join(backup, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(absOf.get(rel), dest);
  }
  // files that are new (after a rename) are noted, so a restore can remove them again
  const created = writes.map(w => w[0]).filter(rel => !texts.has(rel));
  if (created.length) fs.writeFileSync(path.join(backup, 'smo-created.json'), JSON.stringify(created));
  for (const rel of removes) fs.unlinkSync(absOf.get(rel));
  for (const [rel, text] of writes) fs.writeFileSync(absFor(rel), text);
  return { changed: true, files: touched.size + created.length, backup, analysis: an };
}

const key = n => ({ type: n.type, table: n.table, name: n.name });
function editModelFiles(ctx, fn) {
  for (const rel of ctx.after.keys()) {
    if (!ctx.isModelFile(rel) || ctx.after.get(rel) == null) continue;
    const out = fn(ctx.after.get(rel), rel);
    if (out != null) ctx.after.set(rel, out);
  }
}

const FIXABLE = {
  'key-visible': 'Hide these columns',
  'measure-no-format': 'Set a number format',
  'duplicate-measure': 'Let duplicates refer to one measure',
};

function guessFormat(n) {
  if (/%|percent|pct/i.test(n.name)) return '0.0%;-0.0%;0.0%';
  return /\b(DIVIDE|AVERAGE|AVERAGEX)\b/i.test(n.expression || '') ? '#,0.00' : '#,0';
}

/** Applies the automatic fix of one rule to all its findings (or only the given object ids). */
async function fixRule(target, modelRoot, ruleId, ids) {
  if (!FIXABLE[ruleId]) throw new Error('This rule has no automatic fix.');
  let done = [];
  const r = await transact(target, modelRoot, ctx => {
    const rule = SMO.checkRules(ctx.model, ctx.before, ctx.project.config).rules.find(x => x.id === ruleId);
    const want = ids && ids.length ? new Set(ids) : null;
    const nodes = (rule ? rule.items : []).map(it => ctx.before.nodes.get(it.id)).filter(n => n && (!want || want.has(n.id)) && n.kind !== 'report measure');
    const uniq = [...new Map(nodes.map(n => [n.id, n])).values()];
    if (!uniq.length) return null;
    const apply = (n, fn) => {
      let hit = false;
      editModelFiles(ctx, text => { if (hit) return null; const o = fn(text); if (o.found) { hit = true; return o.text; } return null; });
      if (hit) done.push(n.id);
    };
    if (ruleId === 'key-visible') for (const n of uniq) apply(n, t => SMO.setTmdlProps(t, key(n), { isHidden: true }));
    if (ruleId === 'measure-no-format') for (const n of uniq) apply(n, t => SMO.setTmdlProps(t, key(n), { formatString: guessFormat(n) }));
    if (ruleId === 'duplicate-measure') {
      const groups = new Map();
      const rank = { direct: 3, indirect: 2, model: 1, unused: 0 };
      for (const n of [...ctx.before.nodes.values()].filter(x => x.kind === 'measure' && x.expression)) {
        const k = n.expression.replace(/\s+/g, '').toLowerCase();
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(n);
      }
      for (const g of groups.values()) {
        if (g.length < 2) continue;
        g.sort((a, b) => rank[b.status] - rank[a.status] || b.usedBy.size - a.usedBy.size || a.name.localeCompare(b.name));
        const keep = g[0];
        for (const n of g.slice(1)) if (!want || want.has(n.id)) apply(n, t => SMO.editTmdlObject(t, key(n), { expression: '[' + keep.name.replace(/\]/g, ']]') + ']' }));
      }
    }
    return (before, an) => {
      sameOrThrow(signature(before, null, ruleId !== 'duplicate-measure'), signature(an, null, ruleId !== 'duplicate-measure'));
      if (an.stats.brokenFormulas !== before.stats.brokenFormulas) throw new Error('Check failed: the fix would break a formula. Nothing was changed.');
    };
  });
  return { changed: r.changed, files: r.files, backup: r.backup, fixed: done.length };
}

/** Deletes whole tables that nothing uses. */
async function removeTables(target, modelRoot, tables) {
  const names = new Set(tables.map(t => String(t).toLowerCase()));
  const r = await transact(target, modelRoot, ctx => {
    const gone = new Set();
    for (const n of ctx.before.list) {
      if (!names.has(String(n.table).toLowerCase())) continue;
      if (n.kind === 'report measure') throw new Error('Table ' + n.table + ' holds measures defined in a report; remove those in the report first.');
      if (n.status !== 'unused') throw new Error(objName(n) + ' is still in use (' + n.status + '). Nothing was changed.');
      gone.add(n.id);
    }
    if (!gone.size) throw new Error('Table not found in the model.');
    for (const id of gone) for (const u of ctx.before.nodes.get(id).usedBy) if (!gone.has(u)) throw new Error(objName(ctx.before.nodes.get(u)) + ' still refers to ' + objName(ctx.before.nodes.get(id)) + '. Nothing was changed.');
    for (const t of tables) {
      editModelFiles(ctx, (text, rel) => {
        const o = SMO.removeTableTmdl(text, t);
        if (o.text === text) return null;
        if (o.empty) { ctx.after.set(rel, null); return null; }
        return o.text;
      });
    }
    return (before, an) => {
      const a = new Set([...signature(before)].filter(x => ![...gone].some(id => x.includes(' ' + id + ' ') || x.endsWith(' ' + id) || x.includes(' ' + id + ' ×'))));
      sameOrThrow(a, signature(an));
    };
  });
  return { changed: r.changed, files: r.files, backup: r.backup, removed: tables.length };
}
const objName = n => (!n ? '?' : n.type === 'measure' ? '[' + n.name + ']' : n.type === 'table' ? "table '" + n.name + "'" : n.table + '[' + n.name + ']');

/** Renames a table everywhere: model files, DAX, relationships and the reports (PBIR). */
async function renameTable(target, modelRoot, oldName, newName) {
  newName = String(newName).trim();
  if (!newName || /[\r\n\t]/.test(newName)) throw new Error('Invalid name.');
  let reportFields = 0;
  const r = await transact(target, modelRoot, ctx => {
    const node = ctx.before.list.find(n => n.type === 'table' && n.name.toLowerCase() === String(oldName).toLowerCase());
    if (!node) throw new Error('Table not found in the model.');
    const old = node.name;
    if (newName === old) return null;
    if (newName.toLowerCase() !== old.toLowerCase() && ctx.before.list.some(n => n.type === 'table' && n.name.toLowerCase() === newName.toLowerCase())) throw new Error('A table named ' + newName + ' already exists.');
    for (const rel of [...ctx.after.keys()]) {
      const text = ctx.after.get(rel);
      if (ctx.isModelFile(rel)) {
        ctx.after.set(rel, SMO.renameTableTmdl(text, old, newName));
        if (path.basename(rel).toLowerCase() === (old + '.tmdl').toLowerCase() && /^[^\\/:*?"<>|]+$/.test(newName)) ctx.renames.set(rel, rel.slice(0, rel.length - path.basename(rel).length) + newName + '.tmdl');
      } else if (ctx.isReportJson(rel)) {
        let j;
        try { j = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { continue; }
        const c = SMO.renameTableInReport(j, old, newName);
        if (!c) continue;
        reportFields += c;
        const bom = text.charCodeAt(0) === 0xFEFF ? '﻿' : '';
        let out = JSON.stringify(j, null, 2);
        if (/\r\n/.test(text)) out = out.replace(/\n/g, '\r\n');
        ctx.after.set(rel, bom + out + (/\n$/.test(text) ? (/\r\n$/.test(text) ? '\r\n' : '\n') : ''));
      }
    }
    const map = id => {
      const p = id.split('|');
      if (p[1] && p[1].toLowerCase() === old.toLowerCase()) p[1] = newName;
      return p.join('|');
    };
    return (before, an) => sameOrThrow(signature(before, map), signature(an), 'Is a report that uses this table in the legacy format or in a .pbix? The tool cannot update those.');
  });
  return { changed: r.changed, files: r.files, backup: r.backup, reportFields, id: 'T|' + newName };
}

/** Backups next to the model, newest first. */
async function listBackups(target, modelRoot) {
  const loaded = await loadPath(target);
  const dir = path.join(path.dirname(modelRootAbs(loaded, modelRoot)), 'smo-backup');
  if (!fs.existsSync(dir)) return { backups: [] };
  const count = d => fs.readdirSync(d, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? count(path.join(d, e.name)) : e.name === 'smo-created.json' ? 0 : 1), 0);
  const backups = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && /^\d{8}-\d{6}(-\d+)?$/.test(e.name))
    .map(e => ({ stamp: e.name, files: count(path.join(dir, e.name)) })).sort((a, b) => b.stamp.localeCompare(a.stamp));
  return { backups };
}

/** Puts the files of one backup back. The current versions are backed up first, so a restore can be undone. */
async function restoreBackup(target, modelRoot, stampName) {
  if (!/^\d{8}-\d{6}(-\d+)?$/.test(String(stampName))) throw new Error('Unknown backup.');
  const loaded = await loadPath(target);
  const rootAbs = modelRootAbs(loaded, modelRoot);
  const parent = path.dirname(rootAbs), dir = path.join(parent, 'smo-backup', stampName);
  if (!fs.existsSync(dir)) throw new Error('Backup not found.');
  const absOf = new Map(loaded.files.filter(f => f.abs).map(f => [f.path, f.abs]));
  const files = [];
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else if (r !== 'smo-created.json') files.push(r); } };
  walk(dir, '');
  // older backups (made by Delete) are stored relative to the folder that holds the model
  const targetOf = rel => absOf.get(rel) || (rel.split('/')[0] === path.basename(rootAbs) ? path.join(parent, rel) : path.join(loaded.base, rel));
  let created = [];
  try { created = JSON.parse(fs.readFileSync(path.join(dir, 'smo-created.json'), 'utf8')); } catch (e) { /* none */ }
  const undo = newBackupDir(parent);
  const save = (abs, rel) => { if (!fs.existsSync(abs)) return; const dest = path.join(undo, rel); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(abs, dest); };
  for (const rel of files) save(targetOf(rel), rel);
  for (const rel of created) save(targetOf(rel), rel);
  for (const rel of files) { const abs = targetOf(rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.copyFileSync(path.join(dir, rel), abs); }
  for (const rel of created) { const abs = targetOf(rel); if (fs.existsSync(abs)) fs.unlinkSync(abs); }
  return { restored: files.length, removed: created.length, undo };
}

module.exports = { newBackupDir, fixRule, removeTables, renameTable, listBackups, restoreBackup, FIXABLE, transact, signature };
