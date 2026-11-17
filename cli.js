#!/usr/bin/env node
/* Gebruik: node cli.js <map-of-bestand> [--csv uit.csv] [--json uit.json] [--lineage "Naam"] */
'use strict';
const fs = require('fs');
const SMO = require('./core.js');
const { loadPath } = require('./loader.js');

const STATUS = { direct: 'In rapport', indirect: 'Indirect gebruikt', model: 'Alleen model', unused: 'Niet gebruikt' };

(async () => {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const csv = opt('--csv'), json = opt('--json'), lin = opt('--lineage');
  if (!args.length) { console.log('Gebruik: node cli.js <map-of-bestand> [--csv uit.csv] [--json uit.json] [--lineage "Naam"]'); process.exit(1); }

  const files = [], warnings = [];
  for (const a of args) { const r = await loadPath(a); files.push(...r.files); warnings.push(...r.warnings); }
  const proj = SMO.loadProject(files);
  warnings.push(...proj.warnings);
  if (!proj.models.length) { console.error('Geen model gevonden.\n' + warnings.join('\n')); process.exit(2); }
  if (proj.models.length > 1) console.log('Meerdere modellen gevonden, eerste gebruikt: ' + proj.models.map(m => m.name).join(', '));
  const a = SMO.analyze(proj.models[0].model, proj.reports);
  const s = a.stats;

  console.log(`Model: ${proj.models[0].name}   Rapporten: ${proj.reports.map(r => r.name).join(', ') || '(geen)'}`);
  console.log(`Tabellen ${s.tables} (${s.tablesUnused} ongebruikt) · measures ${s.measures} (${s.measuresUnused} ongebruikt) · kolommen ${s.columns} (${s.columnsUnused} ongebruikt, ${s.columnsModelOnly} alleen model)`);
  console.log(`Pagina's ${s.pages} · visuals ${s.visuals} · kapotte verwijzingen ${s.broken}`);
  for (const w of warnings) console.log('! ' + w);

  const label = n => (n.type === 'measure' ? '[' + n.name + ']' : n.type === 'table' ? "'" + n.name + "'" : n.table + '[' + n.name + ']');
  if (lin) {
    const hits = a.list.filter(n => n.name.toLowerCase() === lin.toLowerCase());
    for (const n of hits) {
      console.log(`\n${label(n)} — ${n.kind} — ${STATUS[n.status]}`);
      SMO.layers(a, n.id, 'deps').forEach((l, i) => console.log(`  hangt af van (${i + 1}): ` + l.map(id => label(a.nodes.get(id))).join(', ')));
      SMO.layers(a, n.id, 'usedBy').forEach((l, i) => console.log(`  gebruikt door (${i + 1}): ` + l.map(id => label(a.nodes.get(id))).join(', ')));
      for (const u of n.reportUses) console.log(`  rapport: ${u.report} › ${u.page} › ${u.visualTitle || u.visualType || u.visual} (${u.role})`);
    }
    if (!hits.length) console.log('Niets gevonden met de naam ' + lin);
  } else {
    for (const type of ['measure', 'column']) {
      const un = a.list.filter(n => n.type === type && n.status === 'unused' && !n.system);
      console.log(`\nOngebruikte ${type === 'measure' ? 'measures' : 'kolommen'} (${un.length}):`);
      for (const n of un) console.log('  ' + label(n) + (n.type === 'measure' ? '  (' + n.table + ')' : ''));
    }
  }
  const rows = a.list.filter(n => !n.system).map(n => ({
    type: n.kind, tabel: n.table, naam: n.name, status: STATUS[n.status], verborgen: n.hidden ? 'ja' : '',
    in_rapport: n.reportUses.length, hangt_af_van: n.deps.size, gebruikt_door: n.usedBy.size,
    model_gebruik: n.modelUses.map(u => u.kind).filter((v, i, x) => x.indexOf(v) === i).join(' + '),
  }));
  if (csv) {
    const q = v => '"' + String(v).replace(/"/g, '""') + '"';
    const keys = Object.keys(rows[0] || {});
    fs.writeFileSync(csv, '﻿' + [keys.join(';')].concat(rows.map(r => keys.map(k => q(r[k])).join(';'))).join('\r\n'));
    console.log('\nCSV geschreven: ' + csv);
  }
  if (json) {
    fs.writeFileSync(json, JSON.stringify(a.list.map(n => Object.assign({}, n, { deps: [...n.deps], usedBy: [...n.usedBy] })), null, 1));
    console.log('JSON geschreven: ' + json);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
