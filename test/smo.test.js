/* Tests for the analysis and for everything that writes to a project. Run with: node --test test/ */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const SMO = require('../core.js');
const X = require('../export.js');
const { loadPath } = require('../loader.js');
const { removeObjects } = require('../remove.js');
const { editObject } = require('../edit.js');
const F = require('../fix.js');
const { makeProject } = require('./fixture.js');

const ROOT = 'Demo/Demo.SemanticModel';
async function load(dir) {
  const p = SMO.loadProject((await loadPath(dir)).files);
  const m = p.models[0];
  const a = SMO.analyze(m.model, p.reports);
  return { p, m, a, status: id => (a.nodes.get(id) || {}).status, read: rel => fs.readFileSync(path.join(dir, rel), 'utf8') };
}

test('usage: direct, indirect, model only and unused', async () => {
  const { p, a, status } = await load(makeProject());
  assert.equal(p.models.length, 1);
  assert.equal(p.reports.length, 1);
  assert.equal(status('M|Sales|Total'), 'direct');
  assert.equal(status('C|Sales|Amount'), 'indirect');       // through [Total]
  assert.equal(status('M|Sales|Twice'), 'unused');
  assert.equal(status('M|Sales|Per customer'), 'unused');
  assert.equal(status('C|Sales|Qty'), 'unused');
  assert.equal(status('C|Sales|DateKey'), 'model');          // relationship only
  assert.equal(status('C|Date|Month'), 'direct');
  assert.equal(status('C|Date|MonthNo'), 'indirect');        // sort-by column of a used column
  assert.equal(status('C|Customer|Region'), 'model');        // row-level security
  assert.equal(status('C|Customer|Phone'), 'unused');
  assert.equal(status('T|Spare'), 'unused');
  assert.equal(a.nodes.get('M|Sales|Report total').kind, 'report measure');
  assert.equal(a.broken.length, 0);
  assert.equal(a.stats.brokenFormulas, 0);
});

test('lineage, source and security', async () => {
  const { m, a } = await load(makeProject());
  assert.deepEqual([...a.nodes.get('M|Sales|Twice').deps], ['M|Sales|Total']);
  assert.deepEqual(SMO.layers(a, 'M|Sales|Twice', 'deps').map(l => l.sort()), [['M|Sales|Total'], ['C|Sales|Amount']]);
  assert.equal(a.nodes.get('T|Sales').sourceInfo.label, 'Sql › srv01 / DWH › dbo.FactSales');
  assert.equal(a.nodes.get('C|Sales|CustKey').sourceRef, 'dbo.FactSales.customer_id');
  const sec = SMO.securityOverview(m.model, a);
  assert.equal(sec.length, 1);
  assert.deepEqual(sec[0].filters.map(f => f.table), ['Customer']);
  assert.deepEqual(sec[0].reaches, ['Sales']);
  assert.ok(sec[0].measures.includes('M|Sales|Total'));
});

test('source parsing follows renames and resolves parameters', () => {
  const s = SMO.parseSource('let S = PostgreSQL.Database(Server, Db), N = S{[Schema = "star", Item = "fact_x"]}[Data], R = Table.RenameColumns(N,{{"amt", "Amount"}}) in R',
    [{ name: 'Server', expression: '"host:5432" meta [IsParameterQuery=true]' }, { name: 'Db', expression: '"dw"' }]);
  assert.equal(s.label, 'PostgreSQL › host:5432 / dw › star.fact_x');
  assert.deepEqual(s.renames, { Amount: 'amt' });
});

test('broken formulas are found, self-made columns are not', async () => {
  const dir = makeProject();
  const f = path.join(dir, 'Demo.SemanticModel/definition/tables/Sales.tmdl');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('\tcolumn Amount', "\tmeasure Bad = SUM ( Sales[Nope] ) + [Gone] + SUM ( 'No table'[x] )\n\n\tmeasure 'On bad' = [Bad] + 1\n\n\tmeasure Fine = SUMX ( ADDCOLUMNS ( Sales, \"Double\", [Amount] * 2 ), [Double] )\n\n\tcolumn Amount"));
  const { a } = await load(dir);
  assert.equal(a.nodes.get('M|Sales|Bad').problems.length, 3);
  assert.ok(a.nodes.get('M|Sales|On bad').broken);
  assert.equal(a.nodes.get('M|Sales|On bad').problems.length, 0);
  assert.equal(a.nodes.get('M|Sales|Fine').broken, false);
});

test('checks: findings, severity from the config, date table and keys', async () => {
  const dir = makeProject();
  const { m, a } = await load(dir);
  const ids = r => Object.fromEntries(r.rules.map(x => [x.id, x.items.length]));
  const r = SMO.checkRules(m.model, a, null);
  assert.equal(ids(r)['duplicate-measure'], 2);
  assert.equal(ids(r)['measure-no-format'], 1);
  assert.equal(ids(r)['key-visible'], 3);                     // Sales[CustKey], Customer[CustKey], Date[Date]
  assert.equal(ids(r)['report-only-measure'], 1);
  assert.equal(ids(r)['no-date-table'], undefined);           // Date has data category Time
  const cfg = SMO.checkRules(m.model, a, { rules: { 'duplicate-measure': 'off', 'measure-no-format': 'error' }, naming: { measure: '^[A-Z]' } });
  assert.equal(ids(cfg)['duplicate-measure'], undefined);
  assert.equal(cfg.rules.find(x => x.id === 'measure-no-format').severity, 'error');
  assert.equal(ids(cfg)['naming-convention'], undefined);     // every measure starts with a capital
});

test('bus matrix: one business process, its dimensions and its grain', async () => {
  const { m, a } = await load(makeProject());
  const b = SMO.busMatrix(m.model, a);
  assert.deepEqual(b.facts.map(f => f.name), ['Sales']);
  assert.deepEqual(b.dims.map(d => d.name).sort(), ['Customer', 'Date']);
  assert.equal(SMO.busMark(b.cell('Sales', 'Date')), 'X');
  assert.deepEqual(b.facts[0].keys.map(k => k.column).sort(), ['CustKey', 'DateKey']);
});

test('delete: measures and columns go, the source column is removed in Power Query', async () => {
  const dir = makeProject();
  const r = removeObjects(path.join(dir, 'Demo.SemanticModel'), [{ type: 'measure', table: 'Sales', name: 'Twice' }, { type: 'column', table: 'Sales', name: 'Qty' }, { type: 'column', table: 'Sales', name: 'Nope' }]);
  assert.equal(r.removed.length, 2);
  assert.equal(r.notFound.length, 1);
  assert.ok(fs.existsSync(r.backup));
  const { a, read } = await load(dir);
  assert.equal(a.nodes.has('M|Sales|Twice'), false);
  assert.equal(a.nodes.has('C|Sales|Qty'), false);
  assert.match(read('Demo.SemanticModel/definition/tables/Sales.tmdl'), /Table\.RemoveColumns\(__smo_source, \{"qty"\}, MissingField\.Ignore\)/);
});

test('edit: rename a measure everywhere, including the report and a measure defined in the report', async () => {
  const dir = makeProject();
  const r = await editObject(dir, ROOT, { type: 'measure', table: 'Sales', name: 'Total' }, { name: 'Net total', description: 'All order lines.\nSecond line.', expression: 'VAR x = SUM ( Sales[Amount] )\n\nRETURN x' });
  assert.equal(r.changed, true);
  assert.equal(r.reportFields, 2);
  const { a, read, status } = await load(dir);
  assert.equal(status('M|Sales|Net total'), 'direct');
  assert.equal(a.nodes.get('M|Sales|Net total').description, 'All order lines.\nSecond line.');
  assert.deepEqual([...a.nodes.get('M|Sales|Twice').deps], ['M|Sales|Net total']);
  assert.match(read('Demo.Report/definition/pages/p1/visuals/v1/visual.json'), /"Property": "Net total"/);
  assert.match(read('Demo.Report/definition/reportExtensions.json'), /\[Net total\] \+ 0/);
  assert.equal(a.stats.brokenFormulas, 0);
});

test('edit: rename a column updates DAX, the relationship and the report', async () => {
  const dir = makeProject();
  const r = await editObject(dir, ROOT, { type: 'column', table: 'Date', name: 'Month' }, { name: 'Month name' });
  assert.equal(r.reportFields, 1);
  await editObject(dir, ROOT, { type: 'column', table: 'Sales', name: 'CustKey' }, { name: 'Customer key' });
  await editObject(dir, ROOT, { type: 'measure', table: 'Sales', name: 'Twice' }, { description: 'Two times the total.', expression: '[Total] * 2 + 0' });
  const { a, read, status } = await load(dir);
  assert.equal(status('C|Date|Month name'), 'direct');
  assert.match(read('Demo.SemanticModel/definition/relationships.tmdl'), /fromColumn: Sales\.'Customer key'/);
  assert.match(read('Demo.SemanticModel/definition/tables/Sales.tmdl'), /DISTINCTCOUNT \( Sales\[Customer key\] \)/);
  assert.match(read('Demo.SemanticModel/definition/tables/Date.tmdl'), /level Month\n\t\t\tcolumn: 'Month name'/);
  assert.equal(a.nodes.get('M|Sales|Twice').description, 'Two times the total.');
  assert.equal(a.broken.length, 0);
  await assert.rejects(editObject(dir, ROOT, { type: 'column', table: 'Date', name: 'Year' }, { name: 'Month name' }), /already/);
});

test('fix: format, duplicates, hidden keys and display folders', async () => {
  const dir = makeProject();
  assert.equal((await F.fixRule(dir, ROOT, 'measure-no-format')).fixed, 1);
  assert.equal((await F.fixRule(dir, ROOT, 'duplicate-measure')).fixed, 1);
  assert.equal((await F.fixRule(dir, ROOT, 'key-visible')).fixed, 3);
  assert.equal((await F.setFolder(dir, ROOT, ['M|Sales|Total', 'M|Sales|Twice'], 'KPI/Sales')).moved, 2);
  const { m, a } = await load(dir);
  assert.equal(a.nodes.get('M|Sales|Total again').expression, '[Total]');
  assert.equal(a.nodes.get('M|Sales|Total').displayFolder, 'KPI\\Sales');
  assert.ok(a.nodes.get('C|Customer|CustKey').hidden);
  const left = SMO.checkRules(m.model, a, null).rules.map(x => x.id);
  for (const id of ['measure-no-format', 'duplicate-measure', 'key-visible']) assert.equal(left.includes(id), false, id);
});

test('tables: delete an unused one, refuse a used one, rename, and restore', async () => {
  const dir = makeProject();
  await assert.rejects(F.removeTables(dir, ROOT, ['Date']), /still in use/);
  assert.equal((await F.removeTables(dir, ROOT, ['Spare'])).removed, 1);
  assert.equal(fs.existsSync(path.join(dir, 'Demo.SemanticModel/definition/tables/Spare.tmdl')), false);
  const r = await F.renameTable(dir, ROOT, 'Customer', 'Client list');
  assert.equal(r.reportFields, 1);
  let x = await load(dir);
  assert.equal(x.a.nodes.has('T|Client list'), true);
  assert.equal(x.a.nodes.has('T|Spare'), false);
  assert.equal(x.a.broken.length, 0);
  assert.match(x.read('Demo.SemanticModel/definition/relationships.tmdl'), /toColumn: 'Client list'\.CustKey/);
  assert.match(x.read('Demo.SemanticModel/definition/roles/NL only.tmdl'), /tablePermission 'Client list'/);
  assert.match(x.read('Demo.SemanticModel/definition/model.tmdl'), /"Client list"/);
  assert.equal(/Spare/.test(x.read('Demo.SemanticModel/definition/model.tmdl')), false);
  const b = await F.listBackups(dir, ROOT);
  assert.equal(b.backups.length, 2);
  await F.restoreBackup(dir, ROOT, b.backups[0].stamp);           // undo the rename
  x = await load(dir);
  assert.equal(x.a.nodes.has('T|Customer'), true);
  assert.equal(x.a.nodes.has('T|Client list'), false);
  assert.equal(x.a.broken.length, 0);
});

test('compare: what a change adds, removes and breaks', async () => {
  const dir = makeProject();
  const before = (await load(dir)).a;
  const f = path.join(dir, 'Demo.SemanticModel/definition/tables/Sales.tmdl');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('measure Twice = [Total] * 2', 'measure Twice = [Total] * [Gone]').replace('\tcolumn Qty', '\tmeasure New = 1\n\n\tcolumn Qty'));
  const d = SMO.compareAnalyses(before, (await load(dir)).a);
  assert.deepEqual(d.added.map(x => x.label), ['[New]']);
  assert.deepEqual(d.changed.map(x => x.label), ['[Twice]']);
  assert.deepEqual(d.newlyBroken.map(x => x.label), ['[Twice]']);
});

test('thin report without its model: report measures are listed, nothing is called broken', async () => {
  const dir = makeProject();
  const p = SMO.loadProject((await loadPath(path.join(dir, 'Demo.Report'))).files);
  assert.equal(p.models[0].missing, true);
  const a = SMO.analyze(p.models[0].model, p.reports, { noModel: true });
  assert.equal(a.stats.reportMeasures, 1);
  assert.equal(a.stats.brokenFormulas, 0);
  assert.equal(SMO.checkRules(p.models[0].model, a, null).counts.error, 0);
});

test('performance analyzer: time per visual', () => {
  const t = s => '2026-01-01T00:00:' + String(s).padStart(2, '0') + '.000Z';
  const v = SMO.parsePerformance({ events: [
    { name: 'Visual Container Lifecycle', id: 'L1', start: t(0), end: t(9), metrics: { visualId: 'v1', visualTitle: 'Sales', visualType: 'card' } },
    { name: 'Query', id: 'Q', parentId: 'L1', start: t(0), end: t(8) },
    { name: 'Execute DAX Query', id: 'D', parentId: 'Q', start: t(1), end: t(7), metrics: { QueryText: 'EVALUATE x', RowCount: 3 } },
    { name: 'Render', id: 'R', parentId: 'L1', start: t(8), end: t(9) },
  ] });
  assert.deepEqual([v[0].visualId, v[0].total, v[0].dax, v[0].render, v[0].rows], ['v1', 9000, 6000, 1000, 3]);
});

test('export: csv, a readable xlsx and a pdf', async () => {
  const table = { name: 'Objects', head: ['Name', 'Count'], rows: [['Café "x"', 3], ['Second', 4]] };
  assert.match(X.toCsv(table), /^﻿"Name","Count"\r\n"Café ""x""","3"/);
  const xlsx = await X.toXlsx([table]);
  assert.equal(Buffer.from(xlsx.subarray(0, 2)).toString(), 'PK');
  const reader = { size: xlsx.length, read: async (o, l) => xlsx.subarray(o, o + l) };
  const z = await SMO.readZipTexts(reader, async d => new Uint8Array(require('zlib').inflateRawSync(d)), n => n === 'xl/worksheets/sheet1.xml');
  assert.match(z.files[0].text, /Café &quot;x&quot;/);
  assert.match(z.files[0].text, /<v>3<\/v>/);
  const pdf = await X.toPdf({ title: 'Test', lines: ['one'], columns: [{ label: 'Name', weight: 2 }, { label: 'Count', weight: 1, align: 'right' }], rows: [['Café', 3]] });
  const s = Buffer.from(pdf).toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  assert.equal((s.match(/\/Type \/Page /g) || []).length, 1);
});

test('command line: --check passes on a sound model and fails on a broken one', () => {
  const dir = makeProject();
  const cli = path.join(__dirname, '..', 'cli.js');
  const ok = spawnSync(process.execPath, [cli, dir, '--check'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /CHECK PASSED/);
  const f = path.join(dir, 'Demo.SemanticModel/definition/tables/Sales.tmdl');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('measure Twice = [Total] * 2', 'measure Twice = [Total] * [Gone]'));
  const bad = spawnSync(process.execPath, [cli, dir, '--check', '--format', 'github'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /::error title=Broken formulas::\[Twice\]/);
  assert.equal(spawnSync(process.execPath, [cli, path.join(dir, 'nope'), '--check'], { encoding: 'utf8' }).status, 2);
});
