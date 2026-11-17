#!/usr/bin/env node
/* Usage: node cli.js <folder-or-file> [--csv out.csv] [--json out.json] [--lineage "Name"] */
'use strict';
const fs = require('fs');
const SMO = require('./core.js');
const { loadPath } = require('./loader.js');

const STATUS = { direct: 'In report', indirect: 'Used indirectly', model: 'Model only', unused: 'Unused' };

(async () => {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const csv = opt('--csv'), json = opt('--json'), lin = opt('--lineage');
  if (!args.length) { console.log('Usage: node cli.js <folder-or-file> [--csv out.csv] [--json out.json] [--lineage "Name"]'); process.exit(1); }

  const files = [], warnings = [];
  for (const a of args) { const r = await loadPath(a); files.push(...r.files); warnings.push(...r.warnings); }
  const proj = SMO.loadProject(files);
  warnings.push(...proj.warnings);
  if (!proj.models.length) { console.error('No model found.\n' + warnings.join('\n')); process.exit(2); }
  if (proj.models.length > 1) console.log('Several models found, using the first: ' + proj.models.map(m => m.name).join(', '));
  const a = SMO.analyze(proj.models[0].model, proj.reports);
  const s = a.stats;

  console.log(`Model: ${proj.models[0].name}   Reports: ${proj.reports.map(r => r.name).join(', ') || '(none)'}`);
  console.log(`Tables ${s.tables} (${s.tablesUnused} unused) · measures ${s.measures} (${s.measuresUnused} unused) · columns ${s.columns} (${s.columnsUnused} unused, ${s.columnsModelOnly} model only)`);
  console.log(`Pages ${s.pages} · visuals ${s.visuals} · broken references ${s.broken}`);
  for (const w of warnings) console.log('! ' + w);

  const label = n => (n.type === 'measure' ? '[' + n.name + ']' : n.type === 'table' ? "'" + n.name + "'" : n.table + '[' + n.name + ']');
  if (lin) {
    const hits = a.list.filter(n => n.name.toLowerCase() === lin.toLowerCase());
    for (const n of hits) {
      console.log(`\n${label(n)} — ${n.kind} — ${STATUS[n.status]}`);
      SMO.layers(a, n.id, 'deps').forEach((l, i) => console.log(`  depends on (${i + 1}): ` + l.map(id => label(a.nodes.get(id))).join(', ')));
      SMO.layers(a, n.id, 'usedBy').forEach((l, i) => console.log(`  used by (${i + 1}): ` + l.map(id => label(a.nodes.get(id))).join(', ')));
      for (const u of n.reportUses) console.log(`  report: ${u.report} › ${u.page} › ${u.visualTitle || u.visualType || u.visual} (${u.role})`);
    }
    if (!hits.length) console.log('Nothing found with the name ' + lin);
  } else {
    for (const type of ['measure', 'column']) {
      const un = a.list.filter(n => n.type === type && n.status === 'unused' && !n.system);
      console.log(`\nUnused ${type === 'measure' ? 'measures' : 'columns'} (${un.length}):`);
      for (const n of un) console.log('  ' + label(n) + (n.type === 'measure' ? '  (' + n.table + ')' : ''));
    }
  }
  const rows = a.list.filter(n => !n.system).map(n => ({
    type: n.kind, table: n.table, name: n.name, status: STATUS[n.status], hidden: n.hidden ? 'yes' : '',
    in_report: n.reportUses.length, depends_on: n.deps.size, used_by: n.usedBy.size,
    model_use: n.modelUses.map(u => u.kind).filter((v, i, x) => x.indexOf(v) === i).join(' + '),
  }));
  if (csv) {
    const q = v => '"' + String(v).replace(/"/g, '""') + '"';
    const keys = Object.keys(rows[0] || {});
    fs.writeFileSync(csv, '﻿' + [keys.join(',')].concat(rows.map(r => keys.map(k => q(r[k])).join(','))).join('\r\n'));
    console.log('\nCSV written: ' + csv);
  }
  if (json) {
    fs.writeFileSync(json, JSON.stringify(a.list.map(n => Object.assign({}, n, { deps: [...n.deps], usedBy: [...n.usedBy] })), null, 1));
    console.log('JSON written: ' + json);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
