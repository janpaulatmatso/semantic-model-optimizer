#!/usr/bin/env node
/* Usage: node cli.js <folder-or-file> [more paths] [options]
 *
 *   --check              exit code 1 when there are broken formulas or broken references (for a pipeline)
 *   --strict             with --check: also fail on warnings from the best-practice rules
 *   --rules              print every best-practice finding
 *   --format <f>         how findings are printed: text (default), github or azure (annotations in the pull request)
 *   --summary <file>     write a Markdown summary, for example to $GITHUB_STEP_SUMMARY or as a pull-request comment
 *   --compare <path>     list what changed compared with another folder holding the same project
 *   --compare-ref <ref>  the same, compared with a Git branch, tag or commit (for example origin/main)
 *   --server <conn>      load the model over XMLA instead of from files (Windows); with --database <name>
 *   --ri <conn>          check referential integrity on the data, on a model open in Power BI Desktop (localhost:port)
 *                        or on a server (with --database); Windows
 *   --kimball            only the Kimball dimensional modelling checks (with --check / --rules)
 *   --workspace <name>   also check every report in this Power BI workspace that uses the model (see README)
 *   --csv / --json <file>, --lineage "Name"
 *
 * Exit codes: 0 fine, 1 the check failed, 2 the tool itself could not run. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const SMO = require('./core.js');
const { loadPath } = require('./loader.js');

const STATUS = { direct: 'In report', indirect: 'Used indirectly', model: 'Model only', unused: 'Unused' };

function xmlaFiles(server, database) {
  if (process.platform !== 'win32') throw new Error('--server only works on Windows.');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'xmla-model.ps1')].concat(database ? ['-Database', database] : []);
  const out = execFileSync('powershell.exe', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: Object.assign({}, process.env, { SMO_XMLA_CONN: server }) });
  const j = JSON.parse(out.slice(out.indexOf('{')));
  if (j.error) throw new Error(j.error);
  if (j.catalogs) throw new Error('Give the model with --database. Found: ' + j.catalogs.join(', '));
  return [{ path: 'server/' + (database || 'model') + '/model.bim', text: JSON.stringify(j) }];
}

(async () => {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const flag = k => { const i = args.indexOf(k); if (i < 0) return false; args.splice(i, 1); return true; };
  const csv = opt('--csv'), json = opt('--json'), lin = opt('--lineage'), format = (opt('--format') || 'text').toLowerCase(), summary = opt('--summary');
  const cmpPath = opt('--compare'), cmpRef = opt('--compare-ref'), server = opt('--server'), database = opt('--database');
  const workspace = opt('--workspace'), dataset = opt('--dataset');
  const check = flag('--check'), strict = flag('--strict'), showRules = flag('--rules'), kimballOnly = flag('--kimball'), riConn = opt('--ri');
  if (!args.length && !server) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n\/\* ?/, '').replace(/^ \* ?/gm, '')); process.exit(2); }

  const files = [], warnings = [];
  for (const a of args) { const r = await loadPath(a); files.push(...r.files); warnings.push(...r.warnings); }
  if (server) files.push(...xmlaFiles(server, database));
  if (workspace) {
    const ws = await require('./workspace.js').workspaceReports({ workspace, dataset: dataset || database });
    files.push(...ws.files); warnings.push(...ws.warnings);
    console.log(`Workspace ${ws.workspace}: ${ws.reports.length} report${ws.reports.length === 1 ? '' : 's'} read` + (ws.reports.length ? ' (' + ws.reports.join(', ') + ')' : ''));
  }
  const proj = SMO.loadProject(files);
  warnings.push(...proj.warnings);
  if (!proj.models.length) { console.error('No model found.\n' + warnings.join('\n')); process.exit(2); }
  if (proj.models.length > 1) console.log('Several models found, using the first: ' + proj.models.map(m => m.name).join(', '));
  const model = proj.models[0];
  const a = SMO.analyze(model.model, proj.reports, { noModel: !!model.missing });
  const s = a.stats;

  console.log(`Model: ${model.name}   Reports: ${proj.reports.map(r => r.name).join(', ') || '(none)'}`);
  console.log(`Tables ${s.tables} (${s.tablesUnused} unused) · measures ${s.measures} (${s.measuresUnused} unused) · columns ${s.columns} (${s.columnsUnused} unused, ${s.columnsModelOnly} model only)`);
  console.log(`Pages ${s.pages} · visuals ${s.visuals} · ${s.noModel ? 'fields used from the model' : 'broken references'} ${s.broken}`);
  for (const w of warnings) console.log('! ' + w);
  if (s.noModel) console.log('! Model not loaded: report measures and used fields are listed, but nothing can be checked against the model.');

  const label = n => (n.type === 'measure' ? '[' + n.name + ']' : n.type === 'table' ? "'" + n.name + "'" : n.table + '[' + n.name + ']');
  const quiet = check || showRules || cmpPath || cmpRef;
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

  const md = ['## Semantic Model Optimizer: ' + model.name, '',
    `${s.measures} measures (${s.measuresUnused} unused) · ${s.columns} columns (${s.columnsUnused} unused) · ${s.tables} tables · ${s.visuals} visuals in ${proj.reports.length} report${proj.reports.length === 1 ? '' : 's'}`, ''];

  // what changed compared with another version
  if (cmpPath || cmpRef) {
    const d = await require('./compare.js').compare(args, cmpRef ? { ref: cmpRef } : { path: cmpPath }, null);
    const part = (title, list, fmt) => {
      if (!list.length) return;
      console.log(`\n${title} (${list.length})`);
      for (const x of list.slice(0, 200)) console.log('  ' + fmt(x));
      md.push(`**${title} (${list.length})**`, '', ...list.slice(0, 50).map(x => '- ' + fmt(x).replace(/\|/g, '\\|')), list.length > 50 ? `- … and ${list.length - 50} more` : '', '');
    };
    console.log(`\nCompared with ${d.against}: ${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed`);
    md.push(`### Compared with \`${d.against}\``, '', `${d.added.length} added · ${d.removed.length} removed · ${d.changed.length} changed`, '');
    part('Newly broken formulas', d.newlyBroken, x => x.label + '  —  ' + x.detail);
    part('New broken references in reports', d.newBrokenRefs, x => x.label + '  —  ' + x.detail);
    part('Removed', d.removed, x => x.label + ' (' + x.kind + ')' + (x.wasUsed ? '  —  was in use' : ''));
    part('Added', d.added, x => x.label + ' (' + x.kind + ')');
    part('Changed', d.changed, x => x.label + '  —  ' + x.what.join(', '));
    part('No longer used', d.nowUnused, x => x.label);
    part('Fixed', d.fixed, x => x.label);
  }

  if (check || showRules || summary || riConn) {
    let ri = null;
    if (riConn) {
      if (process.platform !== 'win32') throw new Error('--ri only works on Windows.');
      const queries = SMO.riQueries(model.model);
      const tmp = path.join(require('os').tmpdir(), 'smo-ri-' + process.pid + '.json');
      fs.writeFileSync(tmp, JSON.stringify(queries.map(q => ({ key: q.key, dax: q.dax }))));
      let out;
      try { out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'xmla-query.ps1'), '-InputFile', tmp].concat(database ? ['-Database', database] : []), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: Object.assign({}, process.env, { SMO_XMLA_CONN: riConn }) }); }
      finally { fs.unlinkSync(tmp); }
      const j = JSON.parse(out.slice(out.indexOf('{')));
      if (j.error) throw new Error(j.error);
      const byKey = new Map(j.results.map(x => [x.key, x]));
      ri = { results: queries.map(q => Object.assign({}, q, byKey.get(q.key) || { error: 'no answer' })) };
      console.log(`Referential integrity checked on ${queries.length} relationships.`);
    }
    const all = SMO.checkRules(model.model, a, proj.config, ri);
    const r = kimballOnly ? (() => { const rules = all.rules.filter(x => x.group === 'kimball'), counts = { error: 0, warning: 0, info: 0 }; for (const x of rules) counts[x.severity] += x.items.length; return { rules, counts }; })() : all;
    const shown = r.rules.filter(x => showRules || x.severity === 'error' || (strict && x.severity === 'warning'));
    const one = s2 => String(s2).replace(/\r?\n/g, ' ');
    for (const rule of shown) {
      if (format === 'github' || format === 'azure') {
        const level = rule.severity === 'error' ? 'error' : rule.severity === 'warning' ? 'warning' : format === 'github' ? 'notice' : 'warning';
        for (const it of rule.items.slice(0, 100)) {
          const text = one(it.label + (it.detail ? ' — ' + it.detail : ''));
          console.log(format === 'github' ? `::${level} title=${one(rule.title)}::${text}` : `##vso[task.logissue type=${level}]${one(rule.title)}: ${text}`);
        }
      } else if (check || showRules) {
        console.log(`\n${rule.severity.toUpperCase()}  ${rule.title} (${rule.items.length})`);
        for (const it of rule.items.slice(0, showRules ? 1e9 : 50)) console.log('  ' + it.label + (it.detail ? '  —  ' + it.detail : ''));
        if (!showRules && rule.items.length > 50) console.log('  … and ' + (rule.items.length - 50) + ' more');
      }
    }
    const failed = r.counts.error > 0 || (strict && r.counts.warning > 0);
    if (check || showRules) console.log(`\nChecks: ${r.counts.error} errors, ${r.counts.warning} warnings, ${r.counts.info} notes`);
    md.push(`### Checks: ${failed ? 'failed' : 'passed'}`, '', `${r.counts.error} errors · ${r.counts.warning} warnings · ${r.counts.info} notes`, '');
    if (r.rules.length) {
      md.push('| Severity | Rule | Count | First findings |', '|---|---|---:|---|');
      for (const rule of r.rules) md.push(`| ${rule.severity} | ${rule.title} | ${rule.items.length} | ${rule.items.slice(0, 3).map(it => one(it.label + (it.detail ? ' — ' + it.detail : '')).replace(/\|/g, '\\|')).join('<br>')}${rule.items.length > 3 ? '<br>…' : ''} |`);
      md.push('');
    }
    if (check) {
      if (s.noModel) console.log('Note: the model is not loaded, so formulas and references could not be checked.');
      console.log(failed ? 'CHECK FAILED' : 'CHECK PASSED');
      if (format === 'azure' && failed) console.log('##vso[task.complete result=Failed;]Semantic model check failed');
      if (failed) process.exitCode = 1;
    }
  }
  if (summary) { fs.appendFileSync(summary, md.join('\n') + '\n'); console.log('Summary written: ' + summary); }

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
})().catch(e => { console.error(e.message); process.exit(2); });
