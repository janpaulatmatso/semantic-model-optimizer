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

test('kimball: rules on the model and referential integrity from the data', async () => {
  const dir = makeProject();
  const { m, a } = await load(dir);
  const ids = r => Object.fromEntries(r.rules.filter(x => x.group === 'kimball').map(x => [x.id, x.items.map(i => i.label)]));
  const r = ids(SMO.checkRules(m.model, a, null));
  assert.ok(r['k-naming'].includes("'Sales'"));                         // fact table without Feit_
  assert.ok(r['k-naming'].includes('Sales[DateKey]'));                  // relationship key without DK_
  assert.deepEqual(r['k-key-nullable'].sort(), ['Sales[CustKey]', 'Sales[DateKey]']);
  assert.deepEqual(r['k-calculated'], ['Sales[Amount x2]']);
  assert.equal(r['k-grain-missing'], undefined);                        // "One row per order line."
  assert.equal(r['k-fact-no-date'], undefined);
  assert.deepEqual(r['ri-not-checked'], ['2 relationships']);
  // with the naming convention switched off and the data checked
  const q = SMO.riQueries(m.model);
  assert.equal(q.length, 2);
  assert.match(q[0].dax, /EXCEPT \( DISTINCT \( 'Sales'\[DateKey\] \), DISTINCT \( 'Date'\[Date\] \) \)/);
  const ri = { results: [
    Object.assign({}, q.find(x => x.dim === 'Customer'), { values: { orphanKeys: 2, orphanRows: 5, blankRows: 1, dimRows: 10, dimKeys: 9, unknownRow: 0 } }),
    Object.assign({}, q.find(x => x.dim === 'Date'), { error: 'source not reachable' }),
  ] };
  const r2 = ids(SMO.checkRules(m.model, a, { kimball: { naming: false } }, ri));
  assert.equal(r2['k-naming'], undefined);
  assert.deepEqual(r2['ri-orphans'], ['Sales[CustKey]']);
  assert.deepEqual(r2['ri-blank-keys'], ['Sales[CustKey]']);
  assert.deepEqual(r2['ri-dim-not-unique'], ['Customer[CustKey]']);
  assert.deepEqual(r2['ri-unknown-row'], ["'Customer'"]);
  assert.deepEqual(r2['ri-failed'], ['Sales[DateKey] → Date[Date]']);
  assert.equal(r2['ri-not-checked'], undefined);
});

test('kimball: fact tables related to each other and snowflakes', async () => {
  const dir = makeProject();
  const rel = path.join(dir, 'Demo.SemanticModel/definition/relationships.tmdl');
  // a second fact table related to Sales, and Customer snowflaked to a Region table
  fs.writeFileSync(path.join(dir, 'Demo.SemanticModel/definition/tables/Returns.tmdl'), "table Returns\n\tmeasure 'Return count' = COUNTROWS ( Returns )\n\n\tcolumn OrderKey\n\t\tdataType: int64\n\t\tsourceColumn: order_key\n\n\tcolumn DateKey\n\t\tdataType: dateTime\n\t\tsourceColumn: d\n");
  fs.writeFileSync(path.join(dir, 'Demo.SemanticModel/definition/tables/Region.tmdl'), "table Region\n\tcolumn Region\n\t\tdataType: string\n\t\tsourceColumn: region\n");
  fs.appendFileSync(rel, "\nrelationship r3\n\tfromColumn: Returns.OrderKey\n\ttoColumn: Sales.Qty\n\nrelationship r4\n\tfromColumn: Customer.Region\n\ttoColumn: Region.Region\n\nrelationship r5\n\tfromColumn: Returns.DateKey\n\ttoColumn: Date.Date\n");
  const { m, a } = await load(dir);
  const r = Object.fromEntries(SMO.checkRules(m.model, a, null).rules.map(x => [x.id, x.items.map(i => i.detail)]));
  assert.ok(r['k-fact-to-fact'].some(d => /Returns\[OrderKey\] → Sales\[Qty\]/.test(d)));
  assert.ok(r['k-snowflake'].some(d => /related to Region/.test(d)));
  assert.ok(r['k-natural-key'].some(d => /Customer\[Region\] → Region\[Region\]/.test(d)));
});

test('design: the model is compared with its YAML specification and bus matrix', async () => {
  const dir = makeProject();
  fs.mkdirSync(path.join(dir, 'modellen'));
  fs.writeFileSync(path.join(dir, 'modellen', 'sales.yaml'), [
    'model: Sales',
    'versie: 1.0',
    'status: ontwerp   # ontwerp | review | vastgesteld',
    'bedrijfsvraag: >',
    '  Revenue per customer',
    '  and month.',
    'bus_matrix_processen: [Sales]',
    'feittabellen:',
    '  - naam: Sales',
    '    type: transactie',
    '    grain: Eén rij per orderregel.',
    '    dimensies:',
    '      - {sleutel: DateKey, dimensie: Date, rol: Order date, actief: true}',
    '      - sleutel: CustKey',
    '        dimensie: Customer',
    '      - {sleutel: StoreKey, dimensie: Store}',
    '    degenerate:',
    '      - {naam: Order number, type: varchar(20)}',
    '    feiten:',
    "      - {naam: Amount, type: 'decimal(18,2)', additiviteit: additief,",
    "         aggregatie: som, definitie: 'Net amount, in euro.'}",
    '      - naam: Qty',
    '        type: varchar(10)',
    'dimensies:',
    '  - naam: Customer',
    '    natuurlijke_sleutel: CustKey',
    '    standaardrijen: [-1 Onbekend, -2 Niet van toepassing]',
    '    kolommen:',
    '      - {naam: Name, type: varchar(200), scd: 1}',
    '      - Region',
    '  - naam: Product',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'modellen', 'busmatrix.md'), '# Bus matrix\n\n| Proces | Feittabel | Datum | Customer | Store |\n|---|---|:-:|:-:|:-:|\n| Sales | Sales | X | | X |\n');
  const { p, m, a } = await load(dir);
  assert.equal(p.design.specs.length, 1);
  assert.equal(p.design.specs[0].bedrijfsvraag, 'Revenue per customer and month.');
  assert.equal(p.design.specs[0].feittabellen[0].feiten[0].definitie, 'Net amount, in euro.');
  assert.equal(p.design.busmatrices.length, 1);
  const r = Object.fromEntries(SMO.checkRules(m.model, a, null, null, p.design).rules.map(x => [x.id, x.items.map(i => (i.label + ' ' + i.detail).trim())]));
  assert.deepEqual(r['spec-missing-table'].sort(), ['Product (dimension in Sales)', 'Store (dimension of Sales)']);
  assert.ok(r['spec-missing-column'].some(s => /Order number \(degenerate dimension\)/.test(s)));
  assert.ok(r['spec-missing-column'].some(s => /StoreKey/.test(s)));
  assert.ok(r['spec-type'].some(s => /Sales\[Qty\] design: varchar\(10\), model: int64/.test(s)));
  assert.ok(r['spec-type'].some(s => /Sales\[DateKey\] design: int, model: dateTime/.test(s)));
  assert.ok(r['spec-grain'][0].includes('Eén rij per orderregel'));
  assert.ok(r['spec-extra'].includes('Customer[Phone] not in the design'));
  assert.ok(r['spec-busmatrix'].some(s => /Customer: related, but not in the bus matrix/.test(s)));
  assert.ok(r['spec-busmatrix'].some(s => /Store: in the bus matrix, but the model has no such dimension/.test(s)));
  assert.equal(r['spec-relationship'], undefined);
});

test('data checks: grain, SCD type 2, flags and the row -2', async () => {
  const dir = makeProject();
  const cust = path.join(dir, 'Demo.SemanticModel/definition/tables/Customer.tmdl');
  fs.writeFileSync(cust, fs.readFileSync(cust, 'utf8').replace('\tcolumn Name', "\tcolumn 'Customer id'\n\t\tdataType: string\n\t\tsourceColumn: cid\n\n\tcolumn 'Valid from'\n\t\tdataType: dateTime\n\t\tsourceColumn: vf\n\n\tcolumn 'Valid to'\n\t\tdataType: dateTime\n\t\tsourceColumn: vt\n\n\tcolumn 'Is current'\n\t\tdataType: boolean\n\t\tsourceColumn: cur\n\n\tcolumn Active\n\t\tdataType: string\n\t\tsourceColumn: act\n\n\tcolumn Name"));
  const { m, a } = await load(dir);
  const q = SMO.dataQueries(m.model, a, null);
  const kinds = q.reduce((o, x) => ((o[x.kind] = (o[x.kind] || 0) + 1), o), {});
  assert.deepEqual(kinds, { ri: 2, grain: 1, scd2: 1, flags: 2 });
  const g = q.find(x => x.kind === 'grain'), s = q.find(x => x.kind === 'scd2'), f = q.find(x => x.kind === 'flags' && x.table === 'Customer');
  assert.deepEqual(g.keys.sort(), ['CustKey', 'DateKey']);
  assert.match(s.dax, /'Customer'\[Is current\] = TRUE \(\)/);
  assert.equal(s.natural, 'Customer id');
  const ri = { results: [
    Object.assign({}, g, { values: { rows: 10, combos: 8 } }),
    Object.assign({}, s, { values: { multiCurrent: 2, overlaps: 1 } }),
    Object.assign({}, f, { values: Object.fromEntries(f.columns.flatMap((c, i) => [['n' + i, c === 'Active' ? 2 : 40], ['v' + i, c === 'Active' ? '0|1' : 'A|B|C']])) }),
  ] };
  const r = Object.fromEntries(SMO.checkRules(m.model, a, null, ri, null).rules.map(x => [x.id, x.items.map(i => i.label)]));
  assert.deepEqual(r['kd-grain-duplicates'], ["'Sales'"]);
  assert.deepEqual(r['kd-scd2-current'], ["'Customer'"]);
  assert.deepEqual(r['kd-scd2-overlap'], ["'Customer'"]);
  assert.deepEqual(r['kd-flag-codes'], ['Customer[Active]']);
});

test('semi-additive: a stock in a periodic snapshot summed over time', async () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, 'Demo.SemanticModel/definition/tables/Stock.tmdl'), [
    '/// One row per product per month (periodic snapshot).',
    'table Stock',
    "\tmeasure 'Stock sum' = SUM ( Stock[Units] )",
    '',
    "\tmeasure 'Stock last' = CALCULATE ( SUM ( Stock[Units] ), LASTDATE ( 'Date'[Date] ) )",
    '',
    '\tcolumn Units',
    '\t\tdataType: int64',
    '\t\tsourceColumn: units',
    '',
    '\tcolumn DateKey',
    '\t\tdataType: dateTime',
    '\t\tsourceColumn: d',
  ].join('\n') + '\n');
  fs.appendFileSync(path.join(dir, 'Demo.SemanticModel/definition/relationships.tmdl'), '\nrelationship r9\n\tfromColumn: Stock.DateKey\n\ttoColumn: Date.Date\n');
  const { m, a } = await load(dir);
  const r = Object.fromEntries(SMO.checkRules(m.model, a, null).rules.map(x => [x.id, x.items.map(i => i.label)]));
  assert.deepEqual(r['k-semi-additive'], ['[Stock sum]']);
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

test('Power BI export: a star schema per run, and a report that passes its own checks', async () => {
  const os = require('os');
  const dir = makeProject();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'smo-pbi-'));
  const cli = path.join(__dirname, '..', 'cli.js');
  for (const run of [1, 2]) {
    const r = spawnSync(process.execPath, [cli, dir, '--export', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp('Run ' + run + ' exported for Power BI'));
  }
  const csv = rel => {
    const text = fs.readFileSync(path.join(out, 'data', rel), 'utf8').replace(/^﻿/, '');
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; }
      else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    row.push(cell); rows.push(row);
    const head = rows.shift();
    return rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  };
  const objects = csv('run-000002/objects.csv');
  assert.equal(objects.filter(o => o['Object type'] === 'Measure' && o.Status === 'Unused').length, 3);
  assert.ok(objects.every(o => o.Key_Run === '2' && Number(o.Key_Object) > 2 * 10000000));
  assert.equal(new Set(objects.map(o => o.Key_Object)).size, objects.length);
  const twice = objects.find(o => o.Label === '[Twice]');
  assert.match(twice.Expression, /\[Total\] \* 2/);
  const keys = new Set(objects.map(o => o.Key_Object));
  for (const d of csv('run-000002/dependencies.csv')) assert.ok(keys.has(d.Key_Object) && keys.has(d.Key_Depends_on));
  const usage = csv('run-000002/usage.csv'), visuals = new Set(csv('run-000002/visuals.csv').map(v => v.Key_Visual));
  assert.equal(usage.length, 4);
  assert.ok(usage.every(u => keys.has(u.Key_Object) && visuals.has(u.Key_Visual)));
  const rules = new Set(csv('run-000002/rules.csv').map(r => r.Key_Rule));
  assert.ok(csv('run-000002/findings.csv').every(f => rules.has(f.Key_Rule) && (f.Key_Object === '-1' || keys.has(f.Key_Object))));
  assert.equal(csv('run-000001/runs.csv')[0].Model, 'Demo');

  // the report: written once, and Semantic Model Optimizer finds nothing wrong with it
  const pbip = path.join(out, 'Semantic Model Optimizer.pbip');
  assert.ok(fs.existsSync(pbip));
  const { p, m, a } = await load(out);
  assert.equal(m.model.tables.length, 10);
  assert.equal(m.model.relationships.length, 15);
  assert.equal(a.stats.broken, 0);
  assert.equal(a.list.filter(n => n.broken).length, 0);
  const checks = SMO.checkRules(m.model, a, p.config, null, p.design);
  assert.deepEqual([checks.counts.error, checks.counts.warning], [0, 0], JSON.stringify(checks.rules.filter(r => r.severity !== 'info').map(r => r.title)));
  const expr = fs.readFileSync(path.join(out, 'Semantic Model Optimizer.SemanticModel/definition/expressions.tmdl'), 'utf8');
  assert.ok(expr.includes(JSON.stringify(path.join(out, 'data'))));

  // writing the report again replaces its pages, and takes away visuals of an earlier version
  const stale = path.join(out, 'Semantic Model Optimizer.Report/definition/pages/overview/visuals/old/visual.json');
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, '{}');
  const again = spawnSync(process.execPath, [cli, '--export', out, '--report-only'], { encoding: 'utf8' });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.ok(!fs.existsSync(stale));
  assert.ok(fs.existsSync(path.join(out, 'Semantic Model Optimizer.Report/definition/pages/usage/visuals/fields/visual.json')));
  assert.ok(fs.existsSync(path.join(out, 'data/run-000002/objects.csv')), 'the runs stay');
});

test('Power BI export from the app: the page makes the tables, the server writes them', async () => {
  const os = require('os');
  const P = require('../powerbi.js');
  const { p, m, a } = await load(makeProject());
  const checks = SMO.checkRules(m.model, a, p.config, null, p.design);
  const t = P.runTables(a, checks, { run: 1, model: 'Demo', reports: 1, visuals: 2 });
  const t7 = P.withRun(t, 7);
  assert.equal(t7.runs.rows[0][0], 7);
  assert.equal(t7.objects.rows[0][2], 7 * 10000000 + 1);
  assert.equal(t7.findings.rows[0][3], t.findings.rows[0][3]); // rule keys stay
  assert.ok(P.validTables(t) && !P.validTables({ runs: t.runs }));

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'smo-pbi-app-'));
  const port = 5390 + Math.floor(Math.random() * 50);
  const srv = require('child_process').spawn(process.execPath, [path.join(__dirname, '..', 'serve.js'), String(port)], { stdio: 'ignore' });
  try {
    const base = `http://127.0.0.1:${port}/api/powerbi`;
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/api/ping`); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
    const post = (body, origin) => fetch(base, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, origin ? { Origin: origin } : {}), body: JSON.stringify(body) });
    assert.equal((await post({ folder: out, tables: t })).status, 403); // another website cannot write
    const own = `http://127.0.0.1:${port}`;
    const r1 = await (await post({ folder: out, tables: t }, own)).json();
    assert.equal(r1.run, 1); assert.equal(r1.created, true);
    const r2 = await (await post({ folder: out, tables: t }, own)).json();
    assert.equal(r2.run, 2); assert.equal(r2.created, false);
    assert.match(fs.readFileSync(path.join(out, 'data/run-000002/objects.csv'), 'utf8'), /"2","\d+","20000001"/);
    assert.ok(fs.existsSync(path.join(out, 'Semantic Model Optimizer.pbip')));
    assert.match((await (await post({ open: path.join(out, 'other.pbip') }, own)).json()).error, /Only a report written here/);
    assert.match((await (await post({ folder: 'relative', tables: t }, own)).json()).error, /full path/);
  } finally { srv.kill(); }
});

test('Fabric: every model of a workspace with its reports, one run each, read from OneLake', async () => {
  const os = require('os');
  const W = require('../workspace.js'), P = require('../powerbi.js');
  const dir = makeProject();
  const parts = sub => {
    const out = [], walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push({ path: path.relative(path.join(dir, sub), f).replace(/\\/g, '/'), payload: fs.readFileSync(f).toString('base64'), payloadType: 'InlineBase64' }); } };
    walk(path.join(dir, sub));
    return out;
  };
  const json = (o, status, headers) => new Response(JSON.stringify(o), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) });
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push((init && init.method || 'GET') + ' ' + url);
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    if (url.endsWith('/groups?$top=5000')) return json({ value: [{ id: 'w1', name: 'Sales' }, { id: 'w2', name: 'Other' }] });
    if (url.endsWith('/groups/w1/datasets')) return json({ value: [{ id: 'd1', name: 'Demo' }, { id: 'd2', name: 'Broken' }] });
    if (url.endsWith('/groups/w1/reports')) return json({ value: [{ id: 'r1', name: 'Demo', datasetId: 'd1', reportType: 'PowerBIReport' }, { id: 'r2', name: 'Paper', datasetId: 'd1', reportType: 'PaginatedReport' }] });
    if (url.includes('/semanticModels/d1/getDefinition?format=TMDL')) return json({ definition: { parts: parts('Demo.SemanticModel') } });
    if (url.includes('/semanticModels/d2/getDefinition')) return json({ error: { message: 'Not supported' } }, 400);
    if (url.includes('/reports/r1/getDefinition')) return json({}, 202, { location: 'https://api.fabric.microsoft.com/v1/operations/op1', 'retry-after': '0' });
    if (url.endsWith('/operations/op1')) return json({ status: 'Succeeded' });
    if (url.endsWith('/operations/op1/result')) return json({ definition: { parts: parts('Demo.Report') } });
    throw new Error('unexpected call ' + url);
  };
  process.env.SMO_POWERBI_TOKEN = process.env.SMO_FABRIC_TOKEN = 'test-token';
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'smo-fabric-'));
  const source = 'https://onelake.dfs.fabric.microsoft.com/ws/lh/Files/SemanticModelOptimizer/data';
  try {
    const seen = [];
    const r = await W.workspaceModels({ workspace: 'sales', onModel: m => {
      const proj = SMO.loadProject(m.files);
      seen.push(P.exportProject(out, proj, m.workspace + ' / ' + m.name, '9.9.9', { modelName: m.workspace + ' / ' + m.name, dataSource: source }));
      assert.deepEqual(m.reports, ['Demo']);
    } });
    assert.equal(seen.length, 1);
    assert.equal(r.models[0].files, null); // let go once handled
    assert.match(r.warnings.join('\n'), /Sales \/ Broken: Power BI answered 400.*Not supported/);
    assert.ok(!calls.some(c => c.includes('/groups/w2/')), 'only the chosen workspace');
    assert.ok(!calls.some(c => c.includes('/reports/r2/')), 'paginated reports are skipped');
  } finally { global.fetch = realFetch; delete process.env.SMO_POWERBI_TOKEN; delete process.env.SMO_FABRIC_TOKEN; }

  const objects = fs.readFileSync(path.join(out, 'data/run-000001/objects.csv'), 'utf8');
  assert.match(objects, /"\[Twice\]","Unused"/);
  assert.match(fs.readFileSync(path.join(out, 'data/run-000001/runs.csv'), 'utf8'), /"Sales \/ Demo","Sales \/ Demo","9\.9\.9"/);
  assert.match(fs.readFileSync(path.join(out, 'data/run-000001/usage.csv'), 'utf8'), /Values/); // the report was read with the model
  const expr = fs.readFileSync(path.join(out, 'Semantic Model Optimizer.SemanticModel/definition/expressions.tmdl'), 'utf8');
  assert.ok(expr.includes(JSON.stringify(source)) && expr.includes('AzureStorage.DataLake(ExportFolder'));
  assert.ok(!expr.includes('Folder.Files'));
});

// ---------------------------------------------------------------- the Python port for Fabric (fabric/smo.py)

const PY = (() => {
  for (const cmd of ['python', 'python3', 'py']) { const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info >= (3, 10))'], { encoding: 'utf8' }); if (r.status === 0 && /True/.test(r.stdout)) return cmd; }
  return null;
})();
/** Runs test/fabric_cli.py; skips the test where Python is missing (never in the pipeline). */
function py(t, args) {
  if (!PY) { if (process.env.CI) assert.fail('Python 3.10 or later is needed for the Fabric tests'); t.skip('Python not found'); return null; }
  const r = spawnSync(PY, [path.join(__dirname, 'fabric_cli.py')].concat(args), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('Fabric notebook: the Python port gives the same CSV files as the JavaScript', async t => {
  const os = require('os');
  const P = require('../powerbi.js');
  const { makeStress } = require('./fixture-stress.js');
  const stress = (await loadPath(makeStress())).files.map(f => ({ path: f.path, text: f.text }));
  const cases = {
    demo: (await loadPath(makeProject())).files.map(f => ({ path: f.path, text: f.text })),
    stress,
    'no date table': stress.map(f => ({ path: f.path, text: f.text.replace(/\tdataCategory: Time\r?\n/, '') })),
    'reports without their model': stress.filter(f => !/\.tmdl$/.test(f.path)),
  };
  const hit = new Set();
  for (const [name, files] of Object.entries(cases)) {
    const proj = SMO.loadProject(files), m = proj.models[0];
    const a = SMO.applyStats(SMO.analyze(m.model, proj.reports, { noModel: !!m.missing }), null);
    const checks = SMO.checkRules(m.model, a, null, null, null);
    for (const r of checks.rules) hit.add(r.id);
    const tables = P.runTables(a, checks, { run: 1, now: new Date(2026, 0, 2, 3, 4, 5), model: 'Model', source: 'Source', version: '9.9.9', reports: proj.reports.length, visuals: a.stats.visuals });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smo-py-'));
    fs.writeFileSync(path.join(tmp, 'files.json'), JSON.stringify(files));
    const out = py(t, ['tables', path.join(tmp, 'files.json'), path.join(tmp, 'out'), '2026-01-02 03:04:05', 'Model', 'Source', '9.9.9']);
    if (!out) return;
    assert.deepEqual(out.reports, proj.reports.map(r => r.name), name);
    assert.deepEqual(out.counts, checks.counts, name);
    for (const table of Object.keys(tables)) {
      const js = X.toCsv(tables[table]).split('\r\n'), python = fs.readFileSync(path.join(tmp, 'out', table + '.csv'), 'utf8').split('\r\n');
      for (let i = 0; i < Math.max(js.length, python.length); i++) assert.equal(python[i], js[i], `${name}: ${table}.csv line ${i + 1}`);
    }
  }
  // every rule that needs no more than the definitions is covered by these projects
  const needsMore = /^(constant-column|naming-convention|ri-(?!not-checked)|kd-|spec-)/;
  assert.deepEqual(SMO.RULES.map(r => r.id).filter(id => !needsMore.test(id) && !hit.has(id)), []);
});

test('Fabric notebook: Python sorts names the way JavaScript does', t => {
  const os = require('os');
  const names = ['Feit_Verkoop', 'feit_klein', 'Dim Product', 'Dim_Klant', 'Dim-Klant', 'Dim.Klant', 'DimKlant', 'dimklant', 'Éclair', 'éclair', 'eclair', 'Eclair', 'Zeta', 'alfa', 'Alfa 2', 'Alfa 10',
    'Sales (2)', 'Sales', 'sales', 'SALES', '2024 Budget', '10 Top', '_hidden', '#Measures', 'Straße', 'Strasse', 'Østfold', 'Ostfold', 'naïve', 'naive', 'Naive', 'a', 'A', 'b', 'ab', 'a b', 'a_b', 'résumé', 'resume', 'Resumé', '', ' x', 'x ', 'Über', 'Uber', 'ĳs', 'ijs', 'Çà', 'Ca', 'ñandú', 'nandu', 'Its', '100%', '100 %', 'Q&A', 'Q A'];
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smo-sort-')), 'names.json');
  fs.writeFileSync(f, JSON.stringify(names));
  const out = py(t, ['sort', f]);
  if (out) assert.deepEqual(out, names.slice().sort((a, b) => a.localeCompare(b)));
});

test('Fabric notebook: a scan in Python, with the Power BI API replaced', t => {
  const os = require('os');
  const dir = makeProject();
  const parts = sub => {
    const out = [], walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push({ path: path.relative(path.join(dir, sub), f).replace(/\\/g, '/'), payload: fs.readFileSync(f).toString('base64'), payloadType: 'InlineBase64' }); } };
    walk(path.join(dir, sub));
    return out;
  };
  const pbi = 'https://api.powerbi.com/v1.0/myorg', fab = 'https://api.fabric.microsoft.com/v1';
  const ok = body => ({ status: 200, body });
  const responses = {
    ['GET ' + pbi + '/groups?$top=5000']: ok({ value: [{ id: 'w1', name: 'Sales' }, { id: 'w2', name: 'Other' }] }),
    ['GET ' + pbi + '/groups/w1/datasets']: ok({ value: [{ id: 'd1', name: 'Demo' }, { id: 'd2', name: 'Broken' }, { id: 'd3', name: 'Usage Metrics Report' }] }),
    ['GET ' + pbi + '/groups/w1/reports']: ok({ value: [{ id: 'r1', name: 'Demo', datasetId: 'D1', reportType: 'PowerBIReport' }, { id: 'r2', name: 'Paper', datasetId: 'd1', reportType: 'PaginatedReport' }, { id: 'r3', name: 'Locked', datasetId: 'd1' }] }),
    ['POST ' + fab + '/workspaces/w1/semanticModels/d1/getDefinition?format=TMDL']: ok({ definition: { parts: parts('Demo.SemanticModel') } }),
    ['POST ' + fab + '/workspaces/w1/semanticModels/d2/getDefinition?format=TMDL']: { status: 400, body: { error: { message: 'Not supported' } } },
    ['POST ' + fab + '/workspaces/w1/reports/r1/getDefinition']: { status: 202, headers: { location: 'https://wabi-west-europe-redirect.analysis.windows.net/v1/operations/op1', 'retry-after': '5' }, body: '' },
    'GET https://wabi-west-europe-redirect.analysis.windows.net/v1/operations/op1': ok({ status: 'Succeeded' }),
    'GET https://wabi-west-europe-redirect.analysis.windows.net/v1/operations/op1/result': ok({ definition: { parts: parts('Demo.Report') } }),
    ['POST ' + fab + '/workspaces/w1/reports/r3/getDefinition']: { status: 403, body: { message: 'No access' } },
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smo-pyscan-'));
  fs.writeFileSync(path.join(tmp, 'responses.json'), JSON.stringify(responses));
  const out = py(t, ['scan', path.join(tmp, 'responses.json'), path.join(tmp, 'lake'), ' sales ']);
  if (!out) return;
  assert.deepEqual(out.result.models, [{ Model: 'Sales / Demo', Measures: 5, 'Unused measures': 3, Columns: 14, 'Unused columns': 4, 'Broken formulas': 0, Errors: 0, Warnings: out.result.models[0].Warnings }]);
  assert.match(out.log.join('\n'), /Sales \/ Demo: run 1, 1 report\n {2}! report Locked: Power BI answered 403 .*No access\. You need access/);
  assert.match(out.result.warnings.join('\n'), /Sales \/ Broken: Power BI answered 400 for \/v1\/workspaces\/w1\/semanticModels\/d2\/getDefinition\?format=TMDL: Not supported\./);
  assert.ok(!out.calls.some(c => /\/w2\/|\/r2\/|\/d3\//.test(c)), 'only the chosen workspace, no paginated reports, no usage metrics model');
  assert.match(fs.readFileSync(path.join(tmp, 'lake/data/run-000001/objects.csv'), 'utf8'), /"\[Twice\]","Unused"/);
  assert.match(fs.readFileSync(path.join(tmp, 'lake/data/run-000001/runs.csv'), 'utf8'), /"1","2026-01-02 03:04:05","2026-01-02","Sales \/ Demo","Sales \/ Demo","dev","1","2","No"/);
  assert.match(fs.readFileSync(path.join(tmp, 'lake/data/run-000001/usage.csv'), 'utf8'), /Values/); // the report was read with the model
});

test('Fabric notebook: a report on Azure Analysis Services is checked with the model on that server', t => {
  const os = require('os');
  const P = require('../powerbi.js');
  // recorded from a real server: the answers to the schema queries, and what xmla-model.ps1 made of the same model
  const xmla = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'aas-xmla.json'), 'utf8'));
  const bim = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'aas-model.json'), 'utf8'));
  const src = e => ({ Expression: { SourceRef: { Entity: e } } });
  const field = (kind, e, p) => ({ field: { [kind]: Object.assign(src(e), { Property: p }) }, queryRef: e + '.' + p });
  const report = {
    'definition/pages/p1/page.json': { name: 'p1', displayName: 'Klanten' },
    'definition/pages/p1/visuals/v1/visual.json': { name: 'v1', visual: { visualType: 'tableEx', query: { queryState: { Values: { projections: [
      field('Column', 'Dim_Klant', 'Naam'), field('Measure', 'Feit_Verkoop', 'Omzet'), field('Measure', 'Feit_Verkoop', 'Aantal klanten'), field('Column', 'Dim_Klant', 'Verdwenen'),
      { field: { HierarchyLevel: { Expression: { Hierarchy: Object.assign(src('Dim_Datum'), { Hierarchy: 'Kalender' }) }, Level: 'Maand' } } }] } } } } },
    'definition/reportExtensions.json': { name: 'extension', entities: [{ name: 'Feit_Verkoop', measures: [{ name: 'Aantal klanten', expression: 'COUNTROWS ( Dim_Klant ) + [Omzet (verzonden)]' }] }] },
  };
  const b64 = s => Buffer.from(s).toString('base64');
  const parts = Object.entries(report).map(([p, j]) => ({ path: p, payload: b64(JSON.stringify(j)), payloadType: 'InlineBase64' }));
  const pbi = 'https://api.powerbi.com/v1.0/myorg', fab = 'https://api.fabric.microsoft.com/v1', cluster = 'https://cluster1.asazure.windows.net/webapi/xmla';
  const ok = body => ({ status: 200, body });
  const workspace = {
    ['GET ' + pbi + '/groups?$top=5000']: ok({ value: [{ id: 'w1', name: 'Sales' }] }),
    ['GET ' + pbi + '/groups/w1/datasets']: ok({ value: [{ id: 'd1', name: 'Live report' }] }),
    ['GET ' + pbi + '/groups/w1/reports']: ok({ value: [{ id: 'r1', name: 'Klanten', datasetId: 'd1' }] }),
    ['POST ' + fab + '/workspaces/w1/semanticModels/d1/getDefinition?format=TMDL']: ok({ definition: { parts: [{ path: 'definition/model.tmdl', payload: b64('model Model\n\tculture: nl-NL\n') }] } }),
    ['POST ' + fab + '/workspaces/w1/reports/r1/getDefinition']: ok({ definition: { parts } }),
    ['GET ' + pbi + '/groups/w1/datasets/d1/datasources']: ok({ value: [{ datasourceType: 'AnalysisServices', connectionDetails: { server: 'asazure://westeurope.asazure.windows.net/testserver', database: 'smo test' } }] }),
  };
  const aas = {
    'POST https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token': ok({ token_type: 'Bearer', access_token: 'aas-token' }),
    'POST https://westeurope.asazure.windows.net/webapi/clusterResolve': ok({ clusterFQDN: 'cluster1.asazure.windows.net', coreServerName: 'testserver' }),
  };
  for (const [name, body] of Object.entries(xmla)) aas['POST ' + cluster + ' #' + name] = { status: 200, body };
  const run = (responses, folder) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smo-aas-'));
    fs.writeFileSync(path.join(tmp, 'responses.json'), JSON.stringify(responses));
    return { out: py(t, ['scan', path.join(tmp, 'responses.json'), path.join(tmp, folder), 'Sales']), dir: path.join(tmp, folder, 'data', 'run-000001') };
  };

  // with a service principal: the model comes from the server, and the report is checked against it
  const a = run(Object.assign({}, workspace, aas), 'with');
  if (!a.out) return;
  assert.match(a.out.log.join('\n'), /Sales \/ Live report: live connection to asazure:\/\/westeurope\.asazure\.windows\.net\/testserver \/ smo test, checked with that model\nAAS testserver \/ SMO Test: run 1, 1 report/);
  assert.ok(!JSON.stringify(a.out).includes('s3cret'), 'the secret is not printed');
  assert.equal(a.out.result.failed, 0);
  assert.equal(a.out.calls.filter(c => c.includes('#')).length, 13);
  // the same result as the desktop tool gets from the same model through xmla-model.ps1
  const files = [{ path: 'server/SMO Test/model.bim', text: JSON.stringify(bim) }]
    .concat(Object.entries(report).map(([p, j]) => ({ path: 'fabric/Sales/Live report/Klanten.Report/' + p, text: JSON.stringify(j) })));
  const proj = SMO.loadProject(files), m = proj.models[0];
  const an = SMO.applyStats(SMO.analyze(m.model, proj.reports), null);
  const checks = SMO.checkRules(m.model, an, null, null, null);
  const tables = P.runTables(an, checks, { run: 1, now: new Date(2026, 0, 2, 3, 4, 5), model: 'AAS testserver / SMO Test', source: 'asazure://westeurope.asazure.windows.net/testserver / SMO Test', version: 'dev', reports: 1, visuals: an.stats.visuals });
  assert.equal(an.nodes.get('M|Feit_Verkoop|Omzet').status, 'direct');
  assert.equal(an.nodes.get('C|Dim_Datum|Maand').status, 'direct');
  assert.equal(an.nodes.get('M|Feit_Verkoop|Omzet (verzonden)').status, 'indirect');
  assert.equal(an.broken.length, 1);
  assert.ok(!checks.rules.some(r => r.id === 'no-date-table'), 'the date table keeps its mark');
  for (const table of Object.keys(tables)) {
    const js = X.toCsv(tables[table]).split('\r\n'), python = fs.readFileSync(path.join(a.dir, table + '.csv'), 'utf8').split('\r\n');
    for (let i = 0; i < Math.max(js.length, python.length); i++) assert.equal(python[i], js[i], `${table}.csv line ${i + 1}`);
  }

  // without one: the report is still listed, and its fields say that the model was not read
  const b = run(workspace, 'without');
  assert.match(b.out.log.join('\n'), /Sales \/ Live report: live connection to asazure:[^\n]*; that model is not read \(fill in the AAS settings\)\nSales \/ Live report: run 1, 1 report/);
  assert.ok(!b.out.calls.some(c => /asazure|login\.microsoftonline/.test(c.split(' ')[1])));
  const objects = fs.readFileSync(path.join(b.dir, 'objects.csv'), 'utf8');
  assert.match(objects, /"Missing","column","Dim_Klant","Naam","Dim_Klant\[Naam\]","Model not loaded","6","No","No"/);
  assert.ok(!objects.includes('"Not in model"'));
});

test('Workspaces: a report whose model is in another workspace is followed to it (JavaScript and Python)', async t => {
  const os = require('os');
  const W = require('../workspace.js');
  const dir = makeProject();
  const parts = sub => {
    const out = [], walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push({ path: path.relative(path.join(dir, sub), f).replace(/\\/g, '/'), payload: fs.readFileSync(f).toString('base64'), payloadType: 'InlineBase64' }); } };
    walk(path.join(dir, sub));
    return out;
  };
  const pbi = 'https://api.powerbi.com/v1.0/myorg', fab = 'https://api.fabric.microsoft.com/v1';
  const ok = body => ({ status: 200, body });
  // Sales is chosen; Finance holds the model of one of its reports; the model of another is in a workspace you cannot open
  const responses = {
    ['GET ' + pbi + '/groups?$top=5000']: ok({ value: [{ id: 'w1', name: 'Sales' }, { id: 'W2', name: 'Finance' }] }),
    ['GET ' + pbi + '/groups/w1/datasets']: ok({ value: [{ id: 'd1', name: 'Demo' }] }),
    ['GET ' + pbi + '/groups/w1/reports']: ok({ value: [
      { id: 'r1', name: 'Demo', datasetId: 'd1', datasetWorkspaceId: 'w1' },
      { id: 'r2', name: 'Kosten', datasetId: 'D2', datasetWorkspaceId: 'w2' },
      { id: 'r3', name: 'Geheim', datasetId: 'd9', datasetWorkspaceId: 'w9' },
      { id: 'r4', name: 'Zonder model' }] }),
    ['GET ' + pbi + '/groups/W2/datasets/d2']: ok({ id: 'd2', name: 'Finance model' }),
    ['POST ' + fab + '/workspaces/w1/semanticModels/d1/getDefinition?format=TMDL']: ok({ definition: { parts: parts('Demo.SemanticModel') } }),
    ['POST ' + fab + '/workspaces/W2/semanticModels/d2/getDefinition?format=TMDL']: ok({ definition: { parts: parts('Demo.SemanticModel') } }),
    ['POST ' + fab + '/workspaces/w1/reports/r1/getDefinition']: ok({ definition: { parts: parts('Demo.Report') } }),
    ['POST ' + fab + '/workspaces/w1/reports/r2/getDefinition']: ok({ definition: { parts: parts('Demo.Report') } }),
  };
  const expectModels = [
    { workspace: 'Sales', name: 'Demo', outside: false, reports: ['Demo'] },
    { workspace: 'Finance', name: 'Finance model', outside: true, reports: ['Sales - Kosten'] },
  ];
  const unreachable = /Sales \/ Geheim: its model is in a workspace you cannot open/;

  // JavaScript (the command line)
  const calls = [], realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const key = ((init && init.method) || 'GET') + ' ' + url;
    calls.push(key);
    const r = responses[key];
    if (!r) throw new Error('unexpected call ' + key);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };
  process.env.SMO_POWERBI_TOKEN = process.env.SMO_FABRIC_TOKEN = 'test-token';
  const seen = [];
  let js;
  try {
    js = await W.workspaceModels({ workspace: 'Sales', onModel: m => {
      const proj = SMO.loadProject(m.files);
      seen.push({ workspace: m.workspace, name: m.name, outside: m.outside, reports: proj.reports.map(r => r.name) });
    } });
  } finally { global.fetch = realFetch; delete process.env.SMO_POWERBI_TOKEN; delete process.env.SMO_FABRIC_TOKEN; }
  assert.deepEqual(seen, expectModels);
  assert.match(js.warnings.join('\n'), unreachable);
  assert.ok(!calls.some(c => /groups\/W2\/(datasets|reports)$|groups\/w9/.test(c)), 'the other workspace is not scanned, only the one model is read');

  // Python (the notebook)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smo-follow-'));
  fs.writeFileSync(path.join(tmp, 'responses.json'), JSON.stringify(responses));
  const out = py(t, ['scan', path.join(tmp, 'responses.json'), path.join(tmp, 'lake'), 'Sales']);
  if (!out) return;
  assert.deepEqual(out.result.models.map(m => m.Model), ['Sales / Demo', 'Finance / Finance model']);
  assert.match(out.log.join('\n'), /Finance \/ Finance model: run 2, 1 report \(the model is in a workspace you did not choose/);
  assert.match(out.result.warnings.join('\n'), unreachable);
  assert.deepEqual(out.calls, calls, 'Python calls the same addresses in the same order');
  assert.match(fs.readFileSync(path.join(tmp, 'lake/data/run-000002/visuals.csv'), 'utf8'), /"Sales - Kosten"/);
});

test('Fabric notebook: built from the Python port, complete, and it calls nothing but Power BI', () => {
  const B = require('../build-fabric.js');
  const dir = path.join(__dirname, '..', 'fabric');
  const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');
  const out = B.outputs('dev');
  for (const f of Object.keys(out)) assert.ok(read(f) === out[f], 'fabric/' + f + ' is not up to date: run node build-fabric.js');
  // the notebook and the one-cell file hold the same code
  const nb = JSON.parse(out['SemanticModelOptimizer.ipynb']);
  const cells = nb.cells.filter(c => c.cell_type === 'code').map(c => c.source.join(''));
  const one = out['SemanticModelOptimizer.py'];
  let at = 0;
  for (const c of cells) { const i = one.indexOf(c, at); assert.ok(i >= at, 'a cell of the notebook is missing from the one-cell file'); at = i + c.length; }
  assert.equal(nb.cells[1].metadata.tags[0], 'parameters');
  // every rule of the tool is in it, with the same text
  for (const r of SMO.RULES) assert.ok(one.includes(JSON.stringify(r.title)) && one.includes(JSON.stringify(r.help)), r.id);
  // nothing is downloaded, installed or started: one place goes online, and only to Power BI and Fabric
  assert.equal((one.match(/urlopen\(/g) || []).length, 1);
  assert.match(one, /Refused to call/);
  for (const bad of ['subprocess', 'os.system', 'pip install', '%pip', 'nodejs.org', 'raw.githubusercontent', 'tarfile', 'exec(', 'eval(', '__import__', 'socket'])
    assert.ok(!one.includes(bad), 'the notebook should not use ' + bad);
  const hosts = [...one.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map(m => m[1]).filter((h, i, a) => a.indexOf(h) === i).sort();
  // github.com: the link to the manual; login.microsoftonline.com: the sign-in of the service principal for Analysis Services
  assert.deepEqual(hosts, ['api.fabric.microsoft.com', 'api.powerbi.com', 'github.com', 'login.microsoftonline.com', 'onelake.dfs.fabric.microsoft.com']);
});

test('thin report: the live connection tells where the model lives', () => {
  const pbir = conn => JSON.stringify({ version: '4.0', datasetReference: { byConnection: { connectionString: conn } } });
  const page = { path: 'Sales.Report/definition/pages/p1/page.json', text: JSON.stringify({ name: 'p1', displayName: 'Page 1' }) };
  const p = SMO.loadProject([{ path: 'Sales.Report/definition.pbir', text: pbir('Data Source=asazure://westeurope.asazure.windows.net/srv;Initial Catalog="Sales Model"') }, page]);
  assert.ok(p.models[0].missing);
  assert.deepEqual(p.reports[0].connection, { server: 'asazure://westeurope.asazure.windows.net/srv', database: 'Sales Model', kind: 'aas' });
  // a .pbix keeps it in the Connections file
  const pbix = SMO.loadProject([
    { path: 'Thin.pbix/Connections', text: JSON.stringify({ Version: 3, Connections: [{ ConnectionString: 'Provider=MSOLAP;Data Source=powerbi://api.powerbi.com/v1.0/myorg/Finance;Initial Catalog=Ledger', ConnectionType: 'analysisServicesDatabase' }] }) },
    { path: 'Thin.pbix/Report/Layout', text: JSON.stringify({ sections: [] }) },
  ]);
  assert.equal(pbix.reports[0].connection.kind, 'powerbi');
  assert.equal(pbix.reports[0].connection.database, 'Ledger');
  assert.equal(SMO.parseConnection(pbir('Data Source=pbiazure://api.powerbi.com;Initial Catalog=abc')).kind, 'service');
  assert.equal(SMO.parseConnection(JSON.stringify({ datasetReference: { byPath: { path: '../Sales.SemanticModel' } } })), null);
  assert.ok(SMO.zipWants('Connections'));
});

test('web version: every file the page needs, and a policy that forbids connections', () => {
  const W = require('../build-web.js');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const files = W.assets(html);
  for (const f of ['core.js', 'app.js', 'extras.js', 'i18n.js', 'style.css', 'favicon.ico']) assert.ok(files.includes(f), f);
  assert.ok(!files.some(f => /^(https?:|\/\/)/.test(f)), 'only local files');
  const page = W.webPage(html);
  assert.match(page, /Content-Security-Policy[^>]*connect-src 'none'/);
  const os = require('os');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'smo-web-'));
  try {
    W.build(out);
    for (const f of files) assert.ok(fs.existsSync(path.join(out, f)), f + ' built');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('web version: changes to a picked folder use the same modules, checks and backups', async () => {
  const vm = require('vm');
  const W = require('../build-web.js');
  const proj = makeProject();
  // a folder handle as the browser gives it (File System Access API), in memory
  const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });
  class FileH {
    constructor(name, bytes) { this.kind = 'file'; this.name = name; this.bytes = bytes; }
    async getFile() { const b = this.bytes; return { name: this.name, size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; }
    async createWritable() { const parts = []; return { write: async d => { parts.push(Buffer.from(d)); }, close: async () => { this.bytes = new Uint8Array(Buffer.concat(parts)); } }; }
  }
  class Dir {
    constructor(name) { this.kind = 'directory'; this.name = name; this.kids = new Map(); }
    async *entries() { for (const e of [...this.kids]) yield e; }
    async getDirectoryHandle(n, o) { let d = this.kids.get(n); if (!d) { if (!(o && o.create)) throw notFound(); d = new Dir(n); this.kids.set(n, d); } return d; }
    async getFileHandle(n, o) { let f = this.kids.get(n); if (!f) { if (!(o && o.create)) throw notFound(); f = new FileH(n, new Uint8Array()); this.kids.set(n, f); } return f; }
    async removeEntry(n) { if (!this.kids.delete(n)) throw notFound(); }
    async queryPermission() { return 'granted'; }
    async requestPermission() { return 'granted'; }
  }
  const root = new Dir(path.basename(proj));
  (function fill(dir, h) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { const d = new Dir(e.name); h.kids.set(e.name, d); fill(full, d); }
      else h.kids.set(e.name, new FileH(e.name, new Uint8Array(fs.readFileSync(full))));
    }
  })(proj, root);
  const fileAt = async rel => { let d = root; const parts = rel.split('/'); for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p); return d.kids.get(parts[parts.length - 1]); };
  const text = async rel => Buffer.from((await fileAt(rel)).bytes).toString('utf8');

  const ctx = vm.createContext({ SMO, TextEncoder, TextDecoder, Uint8Array, console });
  vm.runInContext(W.localBundle(), ctx);
  const L = ctx.SMOLocal;
  L.open(root);
  const read = async list => ({ files: await Promise.all(list.filter(f => SMO.wantsFile(f.path)).map(async f => ({ path: f.path, text: SMO.decodeText(new Uint8Array(await f.file.arrayBuffer())) }))), warnings: [] });
  const l = await L.load(read);
  assert.equal(l.target, '/' + root.name);
  const p = SMO.loadProject(l.files);
  const model = p.models[0];
  assert.equal(model.format, 'tmdl');

  // edit: a description, with a backup next to the model
  const e = await L.post('api/edit', { path: l.target, modelRoot: model.root, sel: { type: 'measure', table: 'Sales', name: 'Total' }, changes: { description: 'Net amount, checked in the web version.' } });
  assert.ok(!e.error, e.error);
  assert.equal(e.changed, true);
  assert.match(await text('Demo.SemanticModel/definition/tables/Sales.tmdl'), /\/\/\/ Net amount, checked in the web version\./);
  assert.ok(root.kids.get('smo-backup'), 'backup folder made');
  assert.ok(!e.backup.startsWith('/'));

  // delete an unused measure; a failing check changes nothing
  const d = await L.post('api/delete', { path: l.target, modelRoot: model.root, items: [{ type: 'measure', table: 'Sales', name: 'Total again' }] });
  assert.ok(!d.error, d.error);
  assert.equal(d.removed.length, 1);
  assert.doesNotMatch(await text('Demo.SemanticModel/definition/tables/Sales.tmdl'), /Total again/);
  const bad = await L.post('api/edit', { path: l.target, modelRoot: model.root, sel: { type: 'measure', table: 'Sales', name: 'Nope' }, changes: { description: 'x' } });
  assert.match(bad.error, /not found/i);

  // history: two backups; restoring the newest brings the measure back
  const b = await L.post('api/backups', { path: l.target, modelRoot: model.root });
  assert.equal(b.backups.length, 2);
  const r = await L.post('api/restore', { path: l.target, modelRoot: model.root, stamp: b.backups[0].stamp });
  assert.ok(!r.error, r.error);
  assert.match(await text('Demo.SemanticModel/definition/tables/Sales.tmdl'), /Total again/);
  assert.match((await L.post('api/compare', { path: l.target, modelRoot: model.root })).error, /desktop app/);
  fs.rmSync(proj, { recursive: true, force: true });
});

test('Store package: manifest, version and identity', () => {
  const M = require('../build-msix.js');
  assert.equal(M.msixVersion('v1.1.12'), '1.1.12.0');
  assert.equal(M.msixVersion('2.0'), '2.0.0.0');
  const id = { name: 'Matso.Smo', publisher: 'CN=AB & CD', publisherName: 'Matso <test>' };
  const xml = M.manifest(id, '1.2.3.0');
  assert.match(xml, /<Identity Name="Matso\.Smo" Publisher="CN=AB &amp; CD" Version="1\.2\.3\.0"/);
  assert.match(xml, /<PublisherDisplayName>Matso &lt;test&gt;<\/PublisherDisplayName>/);
  assert.ok(xml.includes('Executable="app\\SemanticModelOptimizer.exe"'));
  assert.match(xml, /Alias="SemanticModelOptimizer-cli\.exe"/);
  assert.match(xml, /runFullTrust/);
  assert.match(xml, /FileSystemWriteVirtualization>disabled/);
  // every logo the manifest names exists after logos()
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smo-msix-'));
  try {
    M.logos(dir);
    const named = [...xml.matchAll(/Assets[\\/]([\w.-]+\.png)/g)].map(m => m[1]);
    assert.ok(named.length >= 3);
    for (const f of named) assert.ok(fs.existsSync(path.join(dir, f)), f);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const saved = { ...process.env };
  delete process.env.SMO_MSIX_NAME; delete process.env.SMO_MSIX_PUBLISHER;
  assert.equal(M.identity().store, false);
  process.env.SMO_MSIX_NAME = 'X.Y'; process.env.SMO_MSIX_PUBLISHER = 'CN=Z';
  assert.equal(M.identity().store, true);
  process.env = saved;
});
