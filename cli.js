#!/usr/bin/env node
/* Usage: node cli.js <folder-or-file> [more paths] [--check] [--strict] [--rules] [--csv out.csv] [--json out.json] [--lineage "Name"]
 * --check   exit code 1 when there are broken formulas or broken references (for a pipeline)
 * --strict  with --check: also fail on warnings from the best-practice rules
 * --rules   print the best-practice findings */
'use strict';
const fs = require('fs');
const SMO = require('./core.js');
const { loadPath } = require('./loader.js');

const STATUS = { direct: 'In report', indirect: 'Used indirectly', model: 'Model only', unused: 'Unused' };

(async () => {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const csv = opt('--csv'), json = opt('--json'), lin = opt('--lineage');
  const flag = k => { const i = args.indexOf(k); if (i < 0) return false; args.splice(i, 1); return true; };
  const check = flag('--check'), strict = flag('--strict'), showRules = flag('--rules');
  if (!args.length) { console.log('Usage: node cli.js <folder-or-file> [more paths] [--check] [--strict] [--rules] [--csv out.csv] [--json out.json] [--lineage "Name"]'); process.exit(1); }

  const files = [], warnings = [];
  for (const a of args) { const r = await loadPath(a); files.push(...r.files); warnings.push(...r.warnings); }
  const proj = SMO.loadProject(files);
  warnings.push(...proj.warnings);
  if (!proj.models.length) { console.error('No model found.\n' + warnings.join('\n')); process.exit(2); }
  if (proj.models.length > 1) console.log('Several models found, using the first: ' + proj.models.map(m => m.name).join(', '));
  const a = SMO.analyze(proj.models[0].model, proj.reports, { noModel: !!proj.models[0].missing });
  const s = a.stats;

  console.log(`Model: ${proj.models[0].name}   Reports: ${proj.reports.map(r => r.name).join(', ') || '(none)'}`);
  console.log(`Tables ${s.tables} (${s.tablesUnused} unused) · measures ${s.measures} (${s.measuresUnused} unused) · columns ${s.columns} (${s.columnsUnused} unused, ${s.columnsModelOnly} model only)`);
  console.log(`Pages ${s.pages} · visuals ${s.visuals} · ${s.noModel ? 'fields used from the model' : 'broken references'} ${s.broken}`);
  for (const w of warnings) console.log('! ' + w);
  if (s.noModel) console.log('! Model not loaded: report measures and used fields are listed, but nothing can be checked against the model.');

  const label = n => (n.type === 'measure' ? '[' + n.name + ']' : n.type === 'table' ? "'" + n.name + "'" : n.table + '[' + n.name + ']');
  const quiet = check || showRules;
  if (lin) {
    const hits = a.list.filter(n => n.name.toLowerCase() === lin.toLowerCase());
    for (const n of hits) {
      console.log(`\n${label(n)} — ${n.kind} — ${STATUS[n.status]}`);
      SMO.layers(a, n.id, 'deps').forEach((l, i) => console.log(`  depends on (${i + 1}): ` + l.map(id => label(a.nodes.get(id))).join(', ')));
      SMO.layers(a, n.id, 'usedBy').forEach((l, i) => console.log(`  used by (${i + 1}): ` + l.map(id => label(a.nodes.get(id))).join(', ')));
      for (const u of n.reportUses) console.log(`  report: ${u.report} › ${u.page} › ${u.visualTitle || u.visualType || u.visual} (${u.role})`);
    }
    if (!hits.length) console.log('Nothing found with the name ' + lin);
  } else if (!quiet) {
    const rm = a.list.filter(n => n.kind === 'report measure');
    console.log(`\nMeasures only in a report (${rm.length}):`);
    for (const n of rm) console.log('  [' + n.name + ']  (report ' + n.report + ', table ' + n.table + ')');
    const br = a.list.filter(n => n.broken && !n.system);
    console.log(`\nBroken formulas (${br.length}):`);
    for (const n of br) console.log('  ' + label(n) + ': ' + n.problems.map(p => p.ref + ' — ' + p.reason).concat(n.brokenVia.map(id => 'depends on broken ' + label(a.nodes.get(id)))).join('; '));
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
  if (check || showRules) {
    const r = SMO.checkRules(proj.models[0].model, a);
    const shown = r.rules.filter(x => showRules || x.severity === 'error' || (strict && x.severity === 'warning'));
    for (const rule of shown) {
      console.log(`\n${rule.severity.toUpperCase()}  ${rule.title} (${rule.items.length})`);
      for (const it of rule.items.slice(0, showRules ? 1e9 : 50)) console.log('  ' + it.label + (it.detail ? '  —  ' + it.detail : ''));
      if (!showRules && rule.items.length > 50) console.log('  … and ' + (rule.items.length - 50) + ' more');
    }
    console.log(`\nChecks: ${r.counts.error} errors, ${r.counts.warning} warnings, ${r.counts.info} notes`);
    if (check) {
      if (s.noModel) console.log('Note: the model is not loaded, so formulas and references could not be checked.');
      const failed = r.counts.error > 0 || (strict && r.counts.warning > 0);
      console.log(failed ? 'CHECK FAILED' : 'CHECK PASSED');
      if (failed) process.exitCode = 1;
    }
  }
})().catch(e => { console.error(e.message); process.exit(2); });
