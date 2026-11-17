/* Wijzigt naam, beschrijving of formule van een measure, kolom of tabel in een Power BI-project (Node).
 * Bij hernoemen worden verwijzingen in formules en in het rapport (PBIR) bijgewerkt.
 * Schrijft alleen als het model na de wijziging nog precies hetzelfde in elkaar zit. */
'use strict';
const fs = require('fs');
const path = require('path');
const SMO = require('./core.js');
const { loadPath, modelRootAbs } = require('./loader.js');

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Zet van elk te wijzigen bestand eerst een kopie in smo-backup en schrijft dan. changed: Map(absPad → tekst) */
function backupAndWrite(modelRootAbs, changed, relOf) {
  if (!changed.size) return '';
  const backup = path.join(path.dirname(modelRootAbs), 'smo-backup', stamp());
  for (const f of changed.keys()) {
    const dest = path.join(backup, relOf(f));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f, dest);
  }
  for (const [f, text] of changed) fs.writeFileSync(f, text);
  return backup;
}

/** Vingerafdruk van het model: objecten, afhankelijkheden en rapportgebruik. */
function signature(analysis, mapId, skipDepsOf) {
  const m = id => (mapId && mapId[id]) || id;
  const out = new Set();
  for (const n of analysis.list) {
    out.add('object ' + m(n.id));
    out.add('rapportgebruik ' + m(n.id) + ' ×' + n.reportUses.length);
    if (n.id !== skipDepsOf) for (const d of n.deps) out.add('verwijzing ' + m(n.id) + ' → ' + m(d));
  }
  out.add('kapotte verwijzingen ×' + analysis.broken.length);
  return out;
}

/**
 * target: het pad dat in de tool geladen is; modelRoot: relatief pad van het model;
 * sel: {type, table, name}; changes: {name?, description?, expression?}
 */
async function editObject(target, modelRoot, sel, changes) {
  if (!['measure', 'column', 'table'].includes(sel.type)) throw new Error('Dit soort object kan niet gewijzigd worden.');
  const loaded = await loadPath(target);
  const rootRel = String(modelRoot).replace(/\\/g, '/').replace(/\/$/, '');
  const absOf = new Map(loaded.files.filter(f => f.abs).map(f => [f.path, f.abs]));
  const abs = rel => absOf.get(rel);
  const onDisk = f => !!f.abs && !/\.(pbix|pbit|vpax)\//i.test(f.path);
  const isModelFile = f => f.path.replace(/\\/g, '/').startsWith(rootRel + '/definition/') && /\.tmdl$/i.test(f.path);

  // werk met de ruwe bestandsinhoud (BOM en regeleinden blijven zoals ze zijn)
  const texts = new Map();
  for (const f of loaded.files) if (onDisk(f)) texts.set(f.path, fs.readFileSync(abs(f.path), 'utf8'));
  const fileList = t => loaded.files.map(f => ({ path: f.path, text: t.has(f.path) ? t.get(f.path) : f.text }));

  const pick = proj => proj.models.find(m => m.root === rootRel);
  const projBefore = SMO.loadProject(fileList(texts));
  const mBefore = pick(projBefore);
  if (!mBefore || mBefore.format !== 'tmdl') throw new Error('Geen TMDL-model gevonden op ' + rootRel);
  const before = SMO.analyze(mBefore.model, projBefore.reports);
  const prefix = sel.type === 'measure' ? 'M|' : sel.type === 'column' ? 'C|' : 'T|';
  const node = [...before.nodes.values()].find(n => n.id.startsWith(prefix) && n.table.toLowerCase() === String(sel.table).toLowerCase() &&
    (sel.type === 'table' || n.name.toLowerCase() === String(sel.name).toLowerCase()));
  if (!node || node.kind === 'rapportmeasure') throw new Error('Object niet gevonden in het model.');

  const ch = {};
  if (changes.description !== undefined && String(changes.description).trim() !== String(node.description || '').trim()) ch.description = String(changes.description);
  if (changes.expression !== undefined && String(changes.expression).trim() !== String(node.expression || '').trim()) {
    if (sel.type === 'table' || !node.expression) throw new Error('Dit object heeft geen formule die hier te wijzigen is.');
    if (!String(changes.expression).trim()) throw new Error('De formule mag niet leeg zijn.');
    ch.expression = String(changes.expression);
  }
  let newName = null;
  if (changes.name !== undefined && String(changes.name).trim() !== node.name) {
    newName = String(changes.name).trim();
    if (sel.type === 'table') throw new Error('Tabellen hernoemen kan nog niet.');
    if (!newName || /[\r\n\t]/.test(newName)) throw new Error('Ongeldige naam.');
    const low = newName.toLowerCase();
    if (low !== node.name.toLowerCase()) {
      for (const n of before.list) {
        if (n.type !== 'measure' && n.type !== 'column') continue;
        const clash = n.name.toLowerCase() === low && (n.table.toLowerCase() === node.table.toLowerCase() || (n.type === 'measure' && sel.type === 'measure'));
        if (clash) throw new Error('Er bestaat al een ' + n.kind + ' met de naam ' + newName + (n.table ? ' in ' + n.table : '') + '.');
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
  if (!found) throw new Error('De declaratie van ' + node.name + ' is niet gevonden in de TMDL-bestanden.');

  // controle: hetzelfde model, alleen met de gevraagde wijziging
  const projAfter = SMO.loadProject(fileList(after));
  const mAfter = pick(projAfter);
  if (!mAfter) throw new Error('Controle mislukt: het model is na de wijziging niet meer leesbaar. Er is niets gewijzigd.');
  const an = SMO.analyze(mAfter.model, projAfter.reports);
  const newId = newName ? prefix + node.table + '|' + newName : node.id;
  const a = signature(before, newName ? { [node.id]: newId } : null, ch.expression !== undefined ? node.id : null);
  const b = signature(an, null, ch.expression !== undefined ? newId : null);
  const diff = [...a].filter(x => !b.has(x)).concat([...b].filter(x => !a.has(x)));
  if (diff.length) {
    throw new Error('Controle mislukt, er is niets gewijzigd. Na de wijziging zou het model anders in elkaar zitten: ' + diff.slice(0, 3).join('; ') +
      (newName ? '. Staat een rapport dat dit veld gebruikt in het oude formaat of in een .pbix? Dat kan de tool niet bijwerken.' : ''));
  }
  const got = an.nodes.get(newId);
  if (!got) throw new Error('Controle mislukt: het object is na de wijziging niet terug te vinden. Er is niets gewijzigd.');
  if (ch.description !== undefined && String(got.description || '').trim() !== ch.description.trim().split(/\r?\n/).map(l => l.trim()).join('\n')) {
    throw new Error('Controle mislukt: de beschrijving komt niet goed terug. Er is niets gewijzigd.');
  }
  if (ch.expression !== undefined && got.expression.replace(/\s+/g, '') !== ch.expression.replace(/\s+/g, '')) {
    throw new Error('Controle mislukt: de formule komt niet goed terug. Er is niets gewijzigd.');
  }

  const changed = new Map();
  for (const [rel, text] of after) if (text !== texts.get(rel)) changed.set(abs(rel), text);
  const relOf = new Map([...absOf].map(([rel, a]) => [a, rel]));
  const backup = backupAndWrite(modelRootAbs(loaded, rootRel), changed, f => relOf.get(f));
  return { changed: true, files: changed.size, backup, reportFields, id: newId, renamed: !!newName };
}

module.exports = { editObject, backupAndWrite };
