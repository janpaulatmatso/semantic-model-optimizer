/* Export for Power BI: the results of a run as CSV files in a small star schema, plus a ready-made Power BI project
 * (PBIP) that reads them. Every export adds a run, so the report also shows how a model changes over time.
 *
 *   <folder>/Semantic Model Optimizer.pbip     the report: open it in Power BI Desktop (written once, then left alone)
 *   <folder>/data/run-000001/*.csv             one folder per run
 *
 * Tables: Fact_Object (one row per object per run), Fact_Usage (one row per field in a visual), Fact_Dependency
 * (one row per object an object depends on), Fact_Finding (one row per finding of a rule), and the dimensions
 * Dim_Run, Dim_Date, Dim_Object, Dim_Dependency (Dim_Object in the role "depends on"), Dim_Visual and Dim_Rule.
 * Counts show the latest run of each model in the filter context, so a date axis gives the trend.
 *
 * Works in Node (the command line and the server write the files) and in the browser (window.SMOPowerBI: the app
 * computes the tables of a run and sends them to the server). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'), require('./export.js'));
  else root.SMOPowerBI = factory(root.SMO, root.SMOExport);
})(typeof self !== 'undefined' ? self : this, function (SMO, X) {
'use strict';
const { toCsv } = X;

const NAME = 'Semantic Model Optimizer';
const STATUS = { direct: 'In report', indirect: 'Used indirectly', model: 'Model only', unused: 'Unused' };
const STATUS_ORDER = { 'In report': 1, 'Used indirectly': 2, 'Model only': 3, Unused: 4, 'Not in model': 5, 'Model not loaded': 6, '(none)': 9 };
const SEVERITY = { error: 'Error', warning: 'Warning', info: 'Note' };
const SEVERITY_ORDER = { Error: 1, Warning: 2, Note: 3 };
const STEP = 10000000; // keys: run number × STEP + row number

const yn = b => (b ? 'Yes' : 'No');
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** stable whole number for a rule id (FNV-1a), so a rule keeps its key across versions of the tool */
const ruleKey = id => { let h = 0x811c9dc5; for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h & 0x7fffffff; };
const label = n => (n.type === 'measure' ? '[' + n.name + ']' : n.type === 'table' ? n.name : n.type === 'function' ? n.name + '()' : n.table + '[' + n.name + ']');
const pad = (n, w) => String(n).padStart(w, '0');
const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)} ${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}`;
const dateKey = d => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();

// ---------------------------------------------------------------- the tables of one run

/**
 * The rows of one run.
 * info: {run, now: Date, model: name, source, version, reports: number, visuals: number}
 * → {name: {head, rows}} for runs, objects, usage, dependencies, findings and rules
 */
function runTables(analysis, checks, info) {
  const run = info.run, now = info.now || new Date(), dk = dateKey(now);
  const key = new Map();
  const objects = { head: ['Key_Run', 'Key_Date', 'Key_Object', 'Object id', 'Object type', 'Kind', 'Table', 'Name', 'Label', 'Status', 'Status order',
    'Hidden', 'Broken', 'Data type', 'Display folder', 'Description', 'Expression', 'Report', 'Report uses', 'Depends on', 'Used by', 'Rows', 'Distinct values', 'Size'], rows: [] };
  const list = analysis.list.filter(n => !n.system);
  for (const n of list) {
    const k = run * STEP + objects.rows.length + 1;
    key.set(n.id, k);
    const status = STATUS[n.status];
    objects.rows.push([run, dk, k, n.id, cap(n.type), n.kind, n.type === 'function' ? '' : n.table, n.name, label(n), status, STATUS_ORDER[status],
      yn(n.hidden), yn(n.broken), n.dataType || '', n.displayFolder || '', n.description || '', n.expression || '', n.report || '',
      n.reportUses.length, n.deps.size, n.usedBy.size, n.rows == null ? '' : n.rows, n.cardinality == null ? '' : n.cardinality, n.size == null ? '' : n.size]);
  }
  // fields that reports use but the model does not have; or, for reports whose model could not be read, every field
  const noModel = !!analysis.stats.noModel, gone = noModel ? 'Model not loaded' : 'Not in model';
  const missing = new Map();
  for (const u of analysis.broken || []) {
    const id = 'X|' + u.table + '|' + u.name;
    if (missing.has(id)) continue;
    const k = run * STEP + objects.rows.length + 1;
    missing.set(id, k);
    objects.rows.push([run, dk, k, id, 'Missing', noModel ? u.kind || 'field' : 'missing ' + (u.kind || 'field'), u.table, u.name, u.table + '[' + u.name + ']', gone, STATUS_ORDER[gone],
      'No', noModel ? 'No' : 'Yes', '', '', '', '', '', '', '', '', '', '', '']);
  }

  const visuals = { head: ['Key_Visual', 'Report', 'Page', 'Visual', 'Visual type', 'Visual id'], rows: [] }, vkey = new Map();
  const usage = { head: ['Key_Run', 'Key_Date', 'Key_Object', 'Key_Visual', 'Role'], rows: [] };
  const visualKey = u => {
    const id = u.report + '|' + u.page + '|' + u.visual;
    if (!vkey.has(id)) {
      const k = run * STEP + visuals.rows.length + 1;
      vkey.set(id, k);
      visuals.rows.push([k, u.report, u.page, u.visualTitle || u.visualType || u.visual, u.visualType || '', u.visual]);
    }
    return vkey.get(id);
  };
  for (const n of list) for (const u of n.reportUses) usage.rows.push([run, dk, key.get(n.id), visualKey(u), u.role || '']);
  for (const u of analysis.broken || []) usage.rows.push([run, dk, missing.get('X|' + u.table + '|' + u.name), visualKey(u), u.role || '']);

  const dependencies = { head: ['Key_Run', 'Key_Date', 'Key_Object', 'Key_Depends_on', 'Dependency kind'], rows: [] };
  for (const n of list) for (const d of n.deps) if (key.has(d)) dependencies.rows.push([run, dk, key.get(n.id), key.get(d), n.depKinds[d] || 'formula']);

  const rules = { head: ['Key_Rule', 'Rule id', 'Rule', 'Group', 'Severity', 'Severity order', 'Help'], rows: [] };
  const findings = { head: ['Key_Run', 'Key_Date', 'Key_Object', 'Key_Rule', 'Detail'], rows: [] };
  for (const r of (checks && checks.rules) || []) {
    const sev = SEVERITY[r.severity] || cap(r.severity);
    rules.rows.push([ruleKey(r.id), r.id, r.title, r.group === 'kimball' ? 'Kimball' : 'General', sev, SEVERITY_ORDER[sev] || 9, r.help || '']);
    for (const it of r.items) findings.rows.push([run, dk, (it.id && key.get(it.id)) || -1, ruleKey(r.id), [it.id ? '' : it.label, it.detail].filter(Boolean).join(' — ')]);
  }

  const runs = { head: ['Key_Run', 'Run at', 'Date', 'Model', 'Source', 'Tool version', 'Reports', 'Visuals', 'Has sizes'],
    rows: [[run, stamp(now), stamp(now).slice(0, 10), info.model, info.source || '', info.version || '', info.reports || 0, info.visuals || 0, yn(analysis.stats.hasStats)]] };
  return { runs, objects, visuals, usage, dependencies, findings, rules };
}

// ---------------------------------------------------------------- the Power BI project

const q = n => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : "'" + n.replace(/'/g, "''") + "'");
/** a fixed GUID for a name (FNV-1a with four seeds): the same model gets the same ids every time */
const hex8 = (s, seed) => { let h = seed >>> 0; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
const uuid = seed => { const h = [0x811c9dc5, 0x050c5d1f, 0x9e3779b9, 0x7f4a7c15].map(s => hex8(seed, s)).join(''); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const block = (text, tabs) => text.split('\n').map(l => '\t'.repeat(tabs) + l).join('\n');

const M_TYPE = { int64: 'Int64.Type', string: 'type text', dateTime: 'type datetime', date: 'type date' };
const C = (name, dataType, more) => Object.assign({ name, dataType }, more || {});
const key = name => C(name, 'int64', { hidden: true, key: true });

/** The latest run of each model in the filter context. */
const latest = expr =>
  'VAR _runs =\n    SELECTCOLUMNS (\n        ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), "@run", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n        "@run", [@run]\n    )\nRETURN\n    CALCULATE ( ' + expr + ', TREATAS ( _runs, Dim_Run[Key_Run] ) )';
/** 0 instead of blank, but only where there is a run (so a date axis does not fill the days between runs) */
const zero = expr => 'IF (\n    NOT ISBLANK ( [Objects] ),\n    (\n' + expr.split('\n').map(l => '        ' + l).join('\n') + '\n    ) + 0\n)';
const count = (table, ...filters) => (filters.length ? `CALCULATE ( COUNTROWS ( ${table} ), ${filters.join(', ')} )` : `COUNTROWS ( ${table} )`);
const isType = t => `Dim_Object[Object type] = "${t}"`, isStatus = s => `Dim_Object[Status] = "${s}"`;
const Ms = (name, expr, format, description) => ({ name, expr, format: format || '#,0', description });

const OBJECT_COLS = [
  key('Key_Object'), C('Object id', 'string', { hidden: true, description: 'Stable name of the object: type, table and name. The same in every run.' }),
  C('Object type', 'string', { description: 'Table, Column, Measure, Function, or Missing for a field a report uses that is not in the model.' }),
  C('Kind', 'string'), C('Table', 'string'), C('Name', 'string'), C('Label', 'string', { description: 'Table[Column], [Measure] or Table.' }),
  C('Status', 'string', { sortBy: 'Status order', description: 'In report, Used indirectly (needed by something in a report), Model only (relationship, RLS, hierarchy, query) or Unused.' }),
  C('Status order', 'int64', { hidden: true }), C('Hidden', 'string'), C('Broken', 'string'), C('Data type', 'string'), C('Display folder', 'string'),
  C('Description', 'string'), C('Expression', 'string'), C('Report', 'string', { description: 'For a measure made in a report: that report.' }),
];

function tableDefs() {
  const facts = (name, grain, file, cols, measures, filter) => ({
    name, description: grain, file, cols: [key('Key_Run'), key('Key_Date')].concat(cols), measures, filter,
  });
  return [
    facts('Fact_Object', 'One row per table, column, measure and function of the model, per run.', 'objects.csv',
      [key('Key_Object'), C('Report uses', 'int64', { hidden: true }), C('Depends on', 'int64', { hidden: true }), C('Used by', 'int64', { hidden: true }),
        C('Rows', 'int64', { hidden: true }), C('Distinct values', 'int64', { hidden: true }), C('Size', 'int64', { hidden: true, description: 'Bytes in memory, from a VertiPaq export (.vpax) or Power BI Desktop.' })], [
        Ms('Objects', latest(count('Fact_Object')), null, 'Tables, columns, measures and functions in the latest run of each model.'),
        Ms('Measures', zero(latest(count('Fact_Object', isType('Measure')))), null, 'Measures in the model and in reports.'),
        Ms('Unused measures', zero(latest(count('Fact_Object', isType('Measure'), isStatus('Unused')))), null, 'Measures that no report, measure or other part of the model uses.'),
        Ms('Columns', zero(latest(count('Fact_Object', isType('Column')))), null, 'Columns, including calculated columns.'),
        Ms('Unused columns', zero(latest(count('Fact_Object', isType('Column'), isStatus('Unused')))), null, 'Columns that no report, formula, relationship, hierarchy, role or query uses.'),
        Ms('Tables', zero(latest(count('Fact_Object', isType('Table')))), null, 'Tables, including calculated tables.'),
        Ms('Unused tables', zero(latest(count('Fact_Object', isType('Table'), isStatus('Unused')))), null, 'Tables of which nothing is used.'),
        Ms('Broken formulas', zero(latest(count('Fact_Object', 'Dim_Object[Broken] = "Yes"'))), null, 'Formulas that refer to something that does not exist, or depend on such a formula.'),
        Ms('Unused share', 'DIVIDE ( [Unused measures] + [Unused columns], [Measures] + [Columns] )', '0.0%', 'Unused measures and columns as a share of all measures and columns.'),
        Ms('Uses in reports', latest('SUM ( Fact_Object[Report uses] )'), null, 'How often the object is a field in a visual or filter.'),
        Ms('Used by objects', latest('SUM ( Fact_Object[Used by] )'), null, 'How many measures, columns and tables refer to the object directly.'),
        Ms('Size (MB)', latest('SUM ( Fact_Object[Size] )') + ' / 1000000', '#,0.0', 'Memory used, in megabytes. Only when the run had sizes.'),
        Ms('Model size (MB)', latest(`CALCULATE ( SUM ( Fact_Object[Size] ), ${isType('Table')} )`) + ' / 1000000', '#,0.0', 'Only when the run had sizes (a .vpax or the model in Power BI Desktop).'),
        Ms('Unused size (MB)', latest(`CALCULATE ( SUM ( Fact_Object[Size] ), ${isType('Column')}, ${isStatus('Unused')} )`) + ' / 1000000', '#,0.0', 'Memory used by columns nothing uses.'),
      ], { column: 'Object type', not: 'Missing' }),
    facts('Fact_Usage', 'One row per field in a visual or filter of a report, per run.', 'usage.csv',
      [key('Key_Object'), key('Key_Visual'), C('Role', 'string', { description: 'Where the field sits in the visual, for example Values, Category or Filters.' })], [
        Ms('Field uses', latest(count('Fact_Usage')), null, 'Fields in visuals and filters.'),
        Ms('Visuals', latest('DISTINCTCOUNT ( Fact_Usage[Key_Visual] )'), null, 'Visuals that use at least one field.'),
        Ms('Reports using it', latest('CALCULATE ( DISTINCTCOUNT ( Dim_Visual[Report] ), Fact_Usage )'), null, 'Reports in which the measure or column is used.'),
      ]),
    facts('Fact_Dependency', 'One row per object that an object refers to directly, per run.', 'dependencies.csv',
      [key('Key_Object'), key('Key_Depends_on'), C('Dependency kind', 'string')], [
        Ms('Dependencies', latest(count('Fact_Dependency')), null, 'Direct references from one object to another.'),
      ]),
    facts('Fact_Finding', 'One row per finding of a rule, per run.', 'findings.csv',
      [key('Key_Object'), key('Key_Rule'), C('Detail', 'string')], [
        Ms('Findings', latest(count('Fact_Finding')), null, 'Findings of the best-practice and Kimball checks.'),
        Ms('Errors', zero(latest(count('Fact_Finding', 'Dim_Rule[Severity] = "Error"'))), null, 'Findings that break the model or a report.'),
        Ms('Warnings', zero(latest(count('Fact_Finding', 'Dim_Rule[Severity] = "Warning"'))), null, 'Findings that are probably wrong or costly.'),
        Ms('Notes', zero(latest(count('Fact_Finding', 'Dim_Rule[Severity] = "Note"'))), null, 'Findings worth a look.'),
      ]),
    { name: 'Dim_Run', description: 'One row per export: when, which model, from where.', file: 'runs.csv',
      cols: [key('Key_Run'), C('Run at', 'dateTime', { format: 'yyyy-mm-dd hh:nn' }), C('Date', 'date', { hidden: true }), C('Model', 'string'), C('Source', 'string'),
        C('Tool version', 'string'), C('Reports', 'int64'), C('Visuals', 'int64', { hidden: true }), C('Has sizes', 'string')] },
    { name: 'Dim_Date', description: 'One row per day from the first to the last run.', dateTable: true,
      cols: [key('Key_Date'), C('Date', 'date'), C('Year', 'int64'), C('Month', 'string')] },
    { name: 'Dim_Object', description: 'One row per object per run, plus the row -1 (whole model) for findings about the model as a whole.', file: 'objects.csv', cols: OBJECT_COLS, unknown: true },
    { name: 'Dim_Dependency', description: 'Dim_Object in the role "depends on": the object the other one refers to.', role: 'Dim_Object',
      cols: [key('Key_Depends_on'), C('Depends on', 'string'), C('Depends on type', 'string'), C('Depends on kind', 'string'), C('Depends on table', 'string'),
        C('Depends on status', 'string', { sortBy: 'Depends on status order' }), C('Depends on status order', 'int64', { hidden: true })] },
    { name: 'Dim_Visual', description: 'One row per visual of a report, per run.', file: 'visuals.csv',
      cols: [key('Key_Visual'), C('Report', 'string'), C('Page', 'string'), C('Visual', 'string'), C('Visual type', 'string'), C('Visual id', 'string', { hidden: true })] },
    { name: 'Dim_Rule', description: 'One row per rule of the checks.', file: 'rules.csv', distinct: 'Key_Rule',
      cols: [key('Key_Rule'), C('Rule id', 'string', { hidden: true }), C('Rule', 'string'), C('Group', 'string'), C('Severity', 'string', { sortBy: 'Severity order' }),
        C('Severity order', 'int64', { hidden: true }), C('Help', 'string')] },
  ];
}

const RELATIONSHIPS = [
  ['Fact_Object', 'Key_Run', 'Dim_Run'], ['Fact_Object', 'Key_Date', 'Dim_Date'], ['Fact_Object', 'Key_Object', 'Dim_Object'],
  ['Fact_Usage', 'Key_Run', 'Dim_Run'], ['Fact_Usage', 'Key_Date', 'Dim_Date'], ['Fact_Usage', 'Key_Object', 'Dim_Object'], ['Fact_Usage', 'Key_Visual', 'Dim_Visual'],
  ['Fact_Dependency', 'Key_Run', 'Dim_Run'], ['Fact_Dependency', 'Key_Date', 'Dim_Date'], ['Fact_Dependency', 'Key_Object', 'Dim_Object'], ['Fact_Dependency', 'Key_Depends_on', 'Dim_Dependency'],
  ['Fact_Finding', 'Key_Run', 'Dim_Run'], ['Fact_Finding', 'Key_Date', 'Dim_Date'], ['Fact_Finding', 'Key_Object', 'Dim_Object'], ['Fact_Finding', 'Key_Rule', 'Dim_Rule'],
];

/** Power Query for a table */
/** Dim_Dependency is Dim_Object in the role "depends on": these columns, renamed */
const ROLE_PAIRS = [['Key_Object', 'Key_Depends_on'], ['Label', 'Depends on'], ['Object type', 'Depends on type'], ['Kind', 'Depends on kind'], ['Table', 'Depends on table'],
  ['Status', 'Depends on status'], ['Status order', 'Depends on status order']];
/** the row -1 of Dim_Object, for findings about the model as a whole; other columns are empty */
const NONE_ROW = { Key_Object: -1, 'Status order': 9, 'Object type': 'Model', Kind: 'model', Name: '(whole model)', Label: '(whole model)', Status: '(none)' };
/** a column name as a column of a Delta table in the Lakehouse: lower case, no spaces (Direct Lake reads these) */
const deltaColumn = name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
/** the name of a table in the Lakehouse */
const deltaTable = name => 'smo_' + deltaColumn(name);

function source(t) {
  const types = '{' + t.cols.map(c => `{"${c.name}", ${M_TYPE[c.dataType]}}`).join(', ') + '}';
  const pick = '{' + t.cols.map(c => '"' + c.name + '"').join(', ') + '}';
  if (t.dateTable) {
    return ['let', '    Runs = Dim_Run,', '    First = List.Min(Runs[Date]),', '    Last = List.Max(Runs[Date]),',
      '    Days = List.Dates(First, Duration.Days(Last - First) + 1, #duration(1, 0, 0, 0)),',
      '    Dates = Table.FromList(Days, Splitter.SplitByNothing(), type table [Date = date]),',
      '    WithKey = Table.AddColumn(Dates, "Key_Date", each Date.Year([Date]) * 10000 + Date.Month([Date]) * 100 + Date.Day([Date]), Int64.Type),',
      '    WithYear = Table.AddColumn(WithKey, "Year", each Date.Year([Date]), Int64.Type),',
      '    WithMonth = Table.AddColumn(WithYear, "Month", each Date.ToText([Date], "yyyy-MM"), type text)',
      'in', '    Table.SelectColumns(WithMonth, ' + pick + ')'].join('\n');
  }
  if (t.role) {
    const pairs = ROLE_PAIRS;
    return ['let', '    Source = ' + t.role + ',', '    Picked = Table.SelectColumns(Source, {' + pairs.map(p => '"' + p[0] + '"').join(', ') + '}),',
      '    Renamed = Table.RenameColumns(Picked, {' + pairs.map(p => `{"${p[0]}", "${p[1]}"}`).join(', ') + '})', 'in', '    Renamed'].join('\n');
  }
  const lines = ['let', `    Source = LoadCsv("${t.file}"),`];
  let last = 'Source';
  if (t.filter) { lines.push(`    Kept = Table.SelectRows(${last}, each [${t.filter.column}] <> ${JSON.stringify(t.filter.not)}),`); last = 'Kept'; }
  lines.push(`    Picked = Table.SelectColumns(${last}, ${pick}),`, `    Typed = Table.TransformColumnTypes(Picked, ${types}, "en-US")` + (t.unknown || t.distinct ? ',' : ''));
  last = 'Typed';
  if (t.distinct) { lines.push(`    Once = Table.Distinct(${last}, {"${t.distinct}"})`); last = 'Once'; }
  if (t.unknown) {
    // the row for findings about the model as a whole
    const rec = '[' + t.cols.map(c => `#"${c.name}" = ` + (c.name in NONE_ROW ? JSON.stringify(NONE_ROW[c.name]) : '""')).join(', ') + ']';
    lines.push(`    WithNone = Table.InsertRows(${last}, 0, {${rec}})`);
    last = 'WithNone';
  }
  lines.push('in', '    ' + last);
  return lines.join('\n');
}

function tableTmdl(t, directLake) {
  const out = [];
  if (t.description) out.push('/// ' + t.description);
  out.push('table ' + q(t.name));
  if (t.dateTable) out.push('\tdataCategory: Time');
  out.push('');
  for (const m of t.measures || []) {
    if (m.description) out.push('\t/// ' + m.description);
    out.push('\tmeasure ' + q(m.name) + ' =', block(m.expr, 3), '\t\tformatString: ' + m.format, '');
  }
  for (const c of t.cols) {
    if (c.description) out.push('\t/// ' + c.description);
    out.push('\tcolumn ' + q(c.name), '\t\tdataType: ' + (c.dataType === 'date' ? 'dateTime' : c.dataType));
    if (c.hidden) out.push('\t\tisHidden');
    if (c.key && t.name.startsWith('Fact_')) out.push('\t\tisNullable: false');
    if (c.dataType === 'date') out.push('\t\tformatString: yyyy-mm-dd');
    else if (c.format) out.push('\t\tformatString: ' + c.format);
    else if (c.dataType === 'int64') out.push('\t\tformatString: 0');
    out.push('\t\tsummarizeBy: none', '\t\tsourceColumn: ' + (directLake ? deltaColumn(c.name) : c.name));
    if (c.sortBy) out.push('\t\tsortByColumn: ' + q(c.sortBy));
    out.push('');
    if (c.dataType === 'date') out.push('\t\tannotation UnderlyingDateTimeDataType = Date', '');
  }
  if (directLake) out.push('\tpartition ' + q(t.name) + ' = entity', '\t\tmode: directLake', '\t\tsource', '\t\t\tentityName: ' + deltaTable(t.name), '\t\t\tschemaName: dbo', '\t\t\texpressionSource: DatabaseQuery', '');
  else out.push('\tpartition ' + q(t.name) + ' = m', '\t\tmode: import', '\t\tsource =', block(source(t), 4), '', '\tannotation PBI_ResultType = Table', '');
  return out.join('\n');
}

/** The folder with the runs: a path on disk, or the https address of a folder in OneLake (a Fabric Lakehouse) or Azure Data Lake. */
const isUrl = s => /^https:\/\//i.test(String(s));

/** directLake: {server, database} of the SQL analytics endpoint of the Lakehouse with the smo_ tables */
function modelFiles(dataFolder, directLake) {
  const defs = tableDefs(), sm = NAME + '.SemanticModel/';
  const files = [];
  const add = (p, text) => files.push({ path: p, text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) + '\n' });
  add(sm + '.platform', { $schema: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json', metadata: { type: 'SemanticModel', displayName: NAME }, config: { version: '2.0', logicalId: uuid('model') } });
  add(sm + 'definition.pbism', { $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json', version: '4.2', settings: {} });
  add(sm + 'definition/database.tmdl', 'database\n\tcompatibilityLevel: ' + (directLake ? 1604 : 1600) + '\n');
  const order = (directLake ? ['DatabaseQuery'] : ['ExportFolder', 'LoadCsv']).concat(defs.map(t => t.name));
  add(sm + 'definition/model.tmdl', ['model Model', '\tculture: en-US', '\tdefaultPowerBIDataSourceVersion: powerBI_V3', '\tsourceQueryCulture: en-US', '\tdiscourageImplicitMeasures',
    '\tdataAccessOptions', '\t\tlegacyRedirects', '\t\treturnErrorValuesAsNull', '', 'annotation __PBI_TimeIntelligenceEnabled = 0', '',
    'annotation PBI_QueryOrder = ' + JSON.stringify(order), '', ...defs.map(t => 'ref table ' + q(t.name)), ''].join('\n'));
  if (directLake) {
    add(sm + 'definition/expressions.tmdl', ['/// The SQL analytics endpoint of the Lakehouse that holds the smo_ tables the notebook writes.',
      'expression DatabaseQuery =', block(['let', '    database = Sql.Database(' + JSON.stringify(directLake.server) + ', ' + JSON.stringify(directLake.database) + ')', 'in', '    database'].join('\n'), 2), '',
      '\tannotation PBI_IncludeFutureArtifacts = False', ''].join('\n'));
    add(sm + 'definition/relationships.tmdl', RELATIONSHIPS.map(([f, k, d]) => ['relationship ' + uuid('rel|' + f + '|' + k), `\tfromColumn: ${f}.${k}`, `\ttoColumn: ${d}.${k}`, ''].join('\n')).join('\n'));
    for (const t of defs) add(sm + 'definition/tables/' + t.name + '.tmdl', tableTmdl(t, true));
    return files;
  }
  // where the runs are: a folder on disk, a folder in OneLake, or (the template in the repository) left to the user
  const kind = !dataFolder ? 'any' : isUrl(dataFolder) ? 'url' : 'folder';
  const EXAMPLE = 'such as C:\\SMO\\data, or a Lakehouse folder in OneLake, such as https://onelake.dfs.fabric.microsoft.com/<workspace>/<lakehouse>.Lakehouse/Files/SemanticModelOptimizer/data';
  const source = {
    url: ['    Source = AzureStorage.DataLake(ExportFolder, [HierarchicalNavigation = false]),'],
    folder: ['    Source = Folder.Files(ExportFolder),'],
    any: ['    Source =',
      '        if ExportFolder = "" then error "Fill in the parameter ExportFolder (Transform data > Edit parameters): the data folder of your exports, ' + EXAMPLE.replace(/\\/g, '\\') + '. Then choose Refresh."',
      '        else if Text.StartsWith(ExportFolder, "https://", Comparer.OrdinalIgnoreCase) then AzureStorage.DataLake(ExportFolder, [HierarchicalNavigation = false])',
      '        else Folder.Files(ExportFolder),'],
  }[kind];
  add(sm + 'definition/expressions.tmdl', [
    { url: '/// The folder with the exports in OneLake (a Fabric Lakehouse) or Azure Data Lake: https://onelake.dfs.fabric.microsoft.com/<workspace>/<lakehouse>.Lakehouse/Files/<folder>/data',
      folder: '/// The folder with the exports: the data folder next to this report. Change it when you move the files.',
      any: '/// The folder with the exports: a folder on disk or in OneLake, ' + EXAMPLE + '.' }[kind],
    'expression ExportFolder = ' + JSON.stringify(dataFolder || '') + ' meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=' + (kind === 'any' ? 'false' : 'true') + ']', '',
    '\tannotation PBI_ResultType = Text', '',
    '/// Reads one kind of CSV file from every run folder and puts the rows together.',
    'expression LoadCsv =', block([
      '(name as text) as table =>',
      'let',
      ...source,
      '    Files = Table.SelectRows(Source, each [Name] = name),',
      '    Tables = List.Transform(Files[Content], each Table.PromoteHeaders(Csv.Document(_, [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]), [PromoteAllScalars = true])),',
      '    Combined = Table.Combine(Tables)',
      'in',
      '    Table.TransformColumns(Combined, {}, each if _ = "" then null else _)'].join('\n'), 2), '',
    '\tannotation PBI_ResultType = Function', ''].join('\n'));
  add(sm + 'definition/relationships.tmdl', RELATIONSHIPS.map(([f, k, d]) => ['relationship ' + uuid('rel|' + f + '|' + k), `\tfromColumn: ${f}.${k}`, `\ttoColumn: ${d}.${k}`, ''].join('\n')).join('\n'));
  for (const t of defs) add(sm + 'definition/tables/' + t.name + '.tmdl', tableTmdl(t));
  return files;
}

// ---------------------------------------------------------------- the report (PBIR)

const SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/';
const lit = v => ({ expr: { Literal: { Value: v } } });
const fieldOf = f => {
  const kind = f.m ? 'Measure' : 'Column', entity = f.m || f.c;
  return { field: { [kind]: { Expression: { SourceRef: { Entity: entity } }, Property: f.p } }, queryRef: entity + '.' + f.p, nativeQueryRef: f.p };
};
const M = (table, p) => ({ m: table, p }), Cl = (table, p) => ({ c: table, p });

function visual(id, type, x, y, w, h, roles, title, extra) {
  const queryState = {};
  for (const [role, fields] of Object.entries(roles)) queryState[role] = { projections: fields.map(fieldOf) };
  const v = { visualType: type, query: { queryState } };
  if (extra) Object.assign(v, extra);
  // a card already shows the name of its measure
  v.visualContainerObjects = { title: [{ properties: type === 'card' ? { show: lit('false') } : { show: lit('true'), text: lit("'" + title.replace(/'/g, "''") + "'") } }] };
  v.drillFilterOtherVisuals = true;
  return { $schema: SCHEMA + 'visualContainer/2.4.0/schema.json', name: id, position: { x, y, z: 0, height: h, width: w, tabOrder: 0 }, visual: v };
}
// a slicer as a dropdown; its own header is off, the title of the visual names it
const dropdown = { objects: { data: [{ properties: { mode: lit("'Dropdown'") } }], header: [{ properties: { show: lit('false') } }] } };
const table = (id, x, y, w, h, fields, title) => visual(id, 'tableEx', x, y, w, h, { Values: fields }, title);

const PAGE_W = 1280, PAGE_H = 720, MARGIN = 20, GAP = 10, FILTER_H = 64, TOP = MARGIN + FILTER_H + GAP;
/** The filters of a page: dropdowns in one row across the top. filters: [[title, table, column]] */
function filterRow(filters) {
  const w = (PAGE_W - 2 * MARGIN - (filters.length - 1) * GAP) / filters.length;
  return filters.map(([title, t, c], i) => visual('filter' + (i + 1), 'slicer', Math.round(MARGIN + i * (w + GAP)), MARGIN, Math.round(w), FILTER_H, { Values: [Cl(t, c)] }, title, dropdown));
}

function pages() {
  const O = 'Dim_Object', F = 'Fact_Object', U = 'Fact_Usage', V = 'Dim_Visual', D = 'Dim_Dependency';
  const fMODEL = ['Model', 'Dim_Run', 'Model'], fTYPE = ['Object type', O, 'Object type'], fTABLE = ['Table', O, 'Table'], fFIELD = ['Measure or column', O, 'Label'];
  const full = PAGE_W - 2 * MARGIN, body = PAGE_H - TOP - MARGIN;
  const cardW = (full - 6 * GAP) / 7;
  const cards = [['Measures', F], ['Unused measures', F], ['Columns', F], ['Unused columns', F], ['Broken formulas', F], ['Errors', 'Fact_Finding'], ['Warnings', 'Fact_Finding']]
    .map(([p, t], i) => visual('card' + i, 'card', Math.round(MARGIN + i * (cardW + GAP)), TOP, Math.round(cardW), 100, { Values: [M(t, p)] }, p));
  const half = (full - GAP) / 2, chartY = TOP + 100 + GAP, chartH = 240, rulesY = chartY + chartH + GAP;
  return [
    { name: 'overview', displayName: 'Overview', visuals: [
      ...filterRow([fMODEL, fTYPE, fTABLE, ['Date', 'Dim_Date', 'Date']]),
      ...cards,
      visual('status', 'barChart', MARGIN, chartY, half, chartH, { Category: [Cl(O, 'Object type')], Series: [Cl(O, 'Status')], Y: [M(F, 'Objects')] }, 'Objects by status'),
      visual('trend', 'lineChart', MARGIN + half + GAP, chartY, half, chartH, { Category: [Cl('Dim_Date', 'Date')], Y: [M(F, 'Unused measures'), M(F, 'Unused columns'), M('Fact_Finding', 'Errors')] }, 'Over time'),
      visual('rules', 'clusteredBarChart', MARGIN, rulesY, full, PAGE_H - rulesY - MARGIN, { Category: [Cl('Dim_Rule', 'Rule')], Y: [M('Fact_Finding', 'Findings')] }, 'Findings by rule')] },
    { name: 'objects', displayName: 'Objects', visuals: [
      ...filterRow([fMODEL, fTYPE, ['Status', O, 'Status'], fTABLE, ['Hidden', O, 'Hidden'], ['Broken', O, 'Broken']]),
      table('list', MARGIN, TOP, full, body, [Cl(O, 'Table'), Cl(O, 'Name'), Cl(O, 'Kind'), Cl(O, 'Status'), Cl(O, 'Hidden'), M(U, 'Reports using it'), M(U, 'Visuals'), M(F, 'Used by objects'), M(F, 'Size (MB)')], 'Tables, columns and measures')] },
    // where a measure or column is used: pick it in the filters or click it on the left, the visuals are on the right
    { name: 'usage', displayName: 'Where used', visuals: [
      ...filterRow([fMODEL, fTYPE, fTABLE, fFIELD, ['Report', V, 'Report'], ['Page', V, 'Page']]),
      table('fields', MARGIN, TOP, 380, body, [Cl(O, 'Label'), M(U, 'Reports using it'), M(U, 'Visuals')], 'Measures and columns in reports'),
      table('list', MARGIN + 380 + GAP, TOP, full - 380 - GAP, body, [Cl('Dim_Run', 'Model'), Cl(V, 'Report'), Cl(V, 'Page'), Cl(V, 'Visual'), Cl(V, 'Visual type'), Cl(O, 'Label'), Cl(U, 'Role'), M(U, 'Field uses')], 'Reports and visuals that use them')] },
    { name: 'findings', displayName: 'Findings', visuals: [
      ...filterRow([fMODEL, ['Severity', 'Dim_Rule', 'Severity'], ['Group', 'Dim_Rule', 'Group'], ['Rule', 'Dim_Rule', 'Rule'], fTABLE]),
      table('list', MARGIN, TOP, full, body, [Cl('Dim_Rule', 'Severity'), Cl('Dim_Rule', 'Rule'), Cl(O, 'Label'), Cl('Fact_Finding', 'Detail'), M('Fact_Finding', 'Findings')], 'Findings')] },
    { name: 'lineage', displayName: 'Lineage', visuals: [
      ...filterRow([fMODEL, fTYPE, fTABLE, ['Object', O, 'Label'], ['Depends on', D, 'Depends on']]),
      table('list', MARGIN, TOP, full, body, [Cl(O, 'Label'), Cl(O, 'Kind'), Cl(O, 'Status'), Cl(D, 'Depends on'), Cl(D, 'Depends on kind'), Cl(D, 'Depends on status'), M('Fact_Dependency', 'Dependencies')], 'What depends on what')] },
  ];
}

const THEME = { name: NAME, dataColors: ['#2456D6', '#7A4FD6', '#E0802B', '#2E9E6A', '#D64C4C', '#7A8296', '#C9A227', '#1F9BB4'], background: '#FFFFFF', foreground: '#1C2330', tableAccent: '#2456D6' };

function reportFiles() {
  const rp = NAME + '.Report/', files = [];
  const add = (p, o) => files.push({ path: p, text: JSON.stringify(o, null, 2) + '\n' });
  add(rp + '.platform', { $schema: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json', metadata: { type: 'Report', displayName: NAME }, config: { version: '2.0', logicalId: uuid('report') } });
  add(rp + 'definition.pbir', { $schema: SCHEMA.replace('definition/', '') + 'definitionProperties/2.0.0/schema.json', version: '4.0', datasetReference: { byPath: { path: '../' + NAME + '.SemanticModel' } } });
  add(rp + 'definition/version.json', { $schema: SCHEMA + 'versionMetadata/1.0.0/schema.json', version: '2.0.0' });
  add(rp + 'definition/report.json', {
    $schema: SCHEMA + 'report/3.3.0/schema.json',
    themeCollection: { customTheme: { name: 'SemanticModelOptimizer.json', reportVersionAtImport: { visual: '2.4.0', report: '3.3.0', page: '2.1.0' }, type: 'RegisteredResources' } },
    resourcePackages: [{ name: 'RegisteredResources', type: 'RegisteredResources', items: [{ name: 'SemanticModelOptimizer.json', path: 'SemanticModelOptimizer.json', type: 'CustomTheme' }] }],
    settings: { useStylableVisualContainerHeader: true, exportDataMode: 'AllowSummarized', defaultDrillFilterOtherVisuals: true, allowChangeFilterTypes: true, useEnhancedTooltips: true, useDefaultAggregateDisplayName: true },
  });
  add(rp + 'StaticResources/RegisteredResources/SemanticModelOptimizer.json', THEME);
  const ps = pages();
  add(rp + 'definition/pages/pages.json', { $schema: SCHEMA + 'pagesMetadata/1.1.0/schema.json', pageOrder: ps.map(p => p.name), activePageName: ps[0].name });
  for (const p of ps) {
    add(rp + `definition/pages/${p.name}/page.json`, { $schema: SCHEMA + 'page/2.1.0/schema.json', name: p.name, displayName: p.displayName, displayOption: 'FitToPage', height: 720, width: 1280 });
    p.visuals.forEach((v, i) => { v.position.z = i * 1000; v.position.tabOrder = i * 1000; add(rp + `definition/pages/${p.name}/visuals/${v.name}/visual.json`, v); });
  }
  return files;
}

/** The star schema as tables in the Lakehouse, for the notebook: which file each table comes from, its columns and types,
 * and the few steps Power Query does in the import report (a filter, unique rows, the row -1, the role, the dates). */
function lakehouseTables() {
  return tableDefs().map(t => ({
    name: t.name, table: deltaTable(t.name), file: t.file || null, from: t.role || null, dates: !!t.dateTable,
    columns: t.cols.map(c => ({ name: c.name, column: deltaColumn(c.name), type: c.dataType })),
    exclude: t.filter || null, distinct: t.distinct || null, none: t.unknown ? NONE_ROW : null,
    rename: t.role ? ROLE_PAIRS : null,
  }));
}

/** The Direct Lake model and the report on it, for the notebook to create in Fabric (no .platform files: those are
 * for Git). The report refers to its model with definition.pbir, which the notebook writes once the model exists. */
function directLakeFiles(server, database) {
  return modelFiles('', { server, database }).concat(reportFiles()).filter(f => !/(^|\/)\.platform$/.test(f.path) && !/definition\.pbir$/.test(f.path));
}

/** Every file of the Power BI project, for a data folder (an absolute path, or an https address in OneLake). Without
 * one it is the template in the repository: the user fills in the parameter ExportFolder. */
function projectFiles(dataFolder) {
  return [
    { path: NAME + '.pbip', text: JSON.stringify({ $schema: 'https://developer.microsoft.com/json-schemas/fabric/pbip/pbipProperties/1.0.0/schema.json', version: '1.0', artifacts: [{ report: { path: NAME + '.Report' } }], settings: { enableAutoRecovery: true } }, null, 2) + '\n' },
    { path: '.gitignore', text: '**/.pbi/localSettings.json\n**/.pbi/cache.abf\n' },
    // so that Semantic Model Optimizer itself checks this model with its key prefix
    { path: 'smo.config.json', text: JSON.stringify({ kimball: { fact: 'Fact_', dim: 'Dim_', key: 'Key_' } }, null, 2) + '\n' },
  ].concat(modelFiles(dataFolder), reportFiles());
}

// ---------------------------------------------------------------- writing

const TABLES = ['runs', 'objects', 'visuals', 'usage', 'dependencies', 'findings', 'rules'];

/** The same tables with another run number: Key_Run, and the keys made from it. */
function withRun(t, run) {
  const from = Number(t.runs.rows[0][0]);
  const out = {};
  for (const name of TABLES) {
    const idx = t[name].head.map((h, i) => (/^Key_/.test(h) && h !== 'Key_Date' && h !== 'Key_Rule' ? i : -1)).filter(i => i >= 0);
    out[name] = { head: t[name].head, rows: t[name].rows.map(r => {
      const c = r.slice();
      for (const i of idx) {
        const v = Number(c[i]);
        if (t[name].head[i] === 'Key_Run') c[i] = run;
        else if (v > 0) c[i] = v - from * STEP + run * STEP;
      }
      return c;
    }) };
  }
  return out;
}

/** Checks tables that came from a page before they are written. */
function validTables(t) {
  if (!t || typeof t !== 'object') return false;
  return TABLES.every(n => t[n] && Array.isArray(t[n].head) && Array.isArray(t[n].rows) && t[n].rows.every(r => Array.isArray(r) && r.length === t[n].head.length)) &&
    t.runs.rows.length === 1 && Number.isInteger(Number(t.runs.rows[0][0]));
}

/**
 * Adds a run to the folder, and writes the Power BI project the first time (Node only).
 * tables: from runTables (any run number; it gets the next free one), version: written into the run when empty
 * opts.dataSource: where the report reads the runs (default: the data folder on disk; or an https address in OneLake)
 * → {run, runFolder, pbip, created}
 */
function writeRun(folder, tables, version, opts) {
  const fs = require('fs'), path = require('path');
  folder = path.resolve(folder);
  const data = path.join(folder, 'data');
  fs.mkdirSync(data, { recursive: true });
  const runs = fs.readdirSync(data).map(n => /^run-(\d+)$/.exec(n)).filter(Boolean).map(m => Number(m[1]));
  const run = (runs.length ? Math.max(...runs) : 0) + 1;
  const runFolder = path.join(data, 'run-' + pad(run, 6));
  fs.mkdirSync(runFolder);
  const t = withRun(tables, run);
  if (version && !t.runs.rows[0][5]) t.runs.rows[0][5] = version;
  for (const name of TABLES) fs.writeFileSync(path.join(runFolder, name + '.csv'), toCsv(t[name]));
  const r = writeReport(folder, (opts && opts.dataSource) || data);
  return { run, runFolder, pbip: r.pbip, created: r.created };
}

/** Writes the Power BI project into the folder, unless it is there already (or always, with force). Node only. */
function writeReport(folder, dataSource, force) {
  const fs = require('fs'), path = require('path');
  folder = path.resolve(folder);
  const pbip = path.join(folder, NAME + '.pbip');
  const created = force || !fs.existsSync(pbip);
  if (created) {
    // written again: visuals of an earlier version of the report would stay next to the new ones
    if (force) fs.rmSync(path.join(folder, NAME + '.Report', 'definition', 'pages'), { recursive: true, force: true });
    for (const f of projectFiles(dataSource || path.join(folder, 'data'))) {
      const target = path.join(folder, f.path);
      if (!force && f.path !== NAME + '.pbip' && fs.existsSync(target)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.text);
    }
  }
  return { pbip, created };
}

/** Analyses a loaded project the way the command line does, and exports it (Node only). opts: {modelName, dataSource} */
function exportProject(folder, proj, source, version, opts) {
  const model = proj.models[0];
  const analysis = SMO.applyStats(SMO.analyze(model.model, proj.reports, { noModel: !!model.missing }), proj.stats || null);
  const checks = SMO.checkRules(model.model, analysis, proj.config, null, proj.design);
  const tables = runTables(analysis, checks, { run: 1, model: (opts && opts.modelName) || model.name, source, version, reports: proj.reports.length, visuals: analysis.stats.visuals });
  return writeRun(folder, tables, version, opts);
}

return { runTables, withRun, validTables, projectFiles, writeRun, writeReport, exportProject, ruleKey, lakehouseTables, directLakeFiles, deltaColumn, NAME };
});
