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
 * info: {run, now: Date, model: name, source, version, reports: number, visuals: number, bus: SMO.busMatrix(model, analysis)}
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

  // the enterprise data warehouse bus matrix: each business process (fact table) with the dimensions it reaches
  const bus = { head: ['Key_Run', 'Key_Date', 'Key_Object', 'Key_Dimension', 'Mark', 'Relationships', 'Active', 'Through', 'Conformed'], rows: [] };
  if (info.bus) for (const f of info.bus.facts) for (const d of info.bus.dims) {
    const c = info.bus.cell(f.name, d.name), kf = key.get('T|' + f.name), kd = key.get('T|' + d.name);
    if (c && kf && kd) bus.rows.push([run, dk, kf, kd, SMO.busMark(c), c.direct, yn(c.active), c.via || '', yn(d.conformed)]);
  }

  const runs = { head: ['Key_Run', 'Run at', 'Date', 'Model', 'Source', 'Tool version', 'Reports', 'Visuals', 'Has sizes'],
    rows: [[run, stamp(now), stamp(now).slice(0, 10), info.model, info.source || '', info.version || '', info.reports || 0, info.visuals || 0, yn(analysis.stats.hasStats)]] };
  return { runs, objects, visuals, usage, dependencies, findings, rules, bus };
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

/** What each column means; columns with the same name mean the same in every table. */
const DESCRIPTIONS = {
  Key_Run: 'The run: one number per export. Relates to Dim_Run.',
  Key_Date: 'The day of the run, as yyyymmdd. Relates to Dim_Date.',
  Key_Object: 'The object (table, column, measure or function) in this run. Relates to Dim_Object; -1 is the model as a whole.',
  Key_Visual: 'The visual in this run. Relates to Dim_Visual.',
  Key_Rule: 'The rule; the same number in every run. Relates to Dim_Rule.',
  Key_Depends_on: 'The object referred to, in this run. Relates to Dim_Dependency.',
  Key_Dimension: 'The dimension table, in this run. Relates to Dim_Dimension.',
  'Fact_Object[Key_Object]': 'The object (table, column, measure or function) in this run. Relates to Dim_Object.',
  'Fact_Object[Report uses]': 'How often the object is a field in a visual or filter. The measure Uses in reports adds these up for the latest run.',
  'Fact_Object[Depends on]': 'How many objects this object refers to directly.',
  'Fact_Object[Used by]': 'How many objects refer to this object directly. The measure Used by objects adds these up for the latest run.',
  'Fact_Object[Rows]': 'Rows of the table, or of the table the column is in. Only when the run had sizes.',
  'Fact_Object[Distinct values]': 'Distinct values in the column. Only when the run had sizes.',
  'Fact_Dependency[Dependency kind]': 'How the one refers to the other: formula, sort-by column, or the expression of a calculated table.',
  'Fact_Finding[Detail]': 'What the rule found, in words: the reference, relationship or value it is about.',
  'Fact_Bus[Key_Object]': 'The business process: a fact table, in this run. Relates to Dim_Object.',
  'Fact_Bus[Mark]': 'X related, X×3 three relationships to the same dimension (role-playing), ○ only through an inactive relationship, · reached through another dimension.',
  'Fact_Bus[Relationships]': 'How many relationships the fact table has to the dimension; 0 when it is reached through another dimension.',
  'Fact_Bus[Active]': 'Yes when at least one of those relationships is active.',
  'Fact_Bus[Through]': 'The dimension through which this one is reached (a snowflake); empty when related directly.',
  'Fact_Bus[Conformed]': 'Yes when the dimension is used by more than one business process of the model: a conformed dimension.',
  'Dim_Run[Run at]': 'When the run was made, in the time of the machine that made it.',
  'Dim_Run[Date]': 'The day of the run.',
  'Dim_Run[Model]': 'The model the run is about: workspace / model, or the name of the project.',
  'Dim_Run[Source]': 'Where the model was read from: a folder, a server or a workspace.',
  'Dim_Run[Tool version]': 'The version of Semantic Model Optimizer that made the run.',
  'Dim_Run[Reports]': 'How many reports were read with the model.',
  'Dim_Run[Visuals]': 'How many visuals those reports have.',
  'Dim_Run[Has sizes]': 'Yes when the run has rows and sizes in memory, from a .vpax or Power BI Desktop.',
  'Dim_Date[Date]': 'The day.',
  'Dim_Date[Year]': 'The year.',
  'Dim_Date[Month]': 'The month, as yyyy-mm.',
  'Dim_Object[Kind]': 'What the object is in more detail: table, calculated table, column, calculated column, measure, report measure, function, or missing.',
  'Dim_Object[Table]': 'The table the object is in; for a table its own name.',
  'Dim_Object[Name]': 'The name of the object.',
  'Dim_Object[Status order]': 'Sorts Status.',
  'Dim_Object[Hidden]': 'Yes when the object is hidden in the model.',
  'Dim_Object[Broken]': 'Yes when the formula refers to something that does not exist, or depends on such a formula.',
  'Dim_Object[Data type]': 'The data type of a column.',
  'Dim_Object[Display folder]': 'The display folder of a measure or column.',
  'Dim_Object[Description]': 'The description in the model.',
  'Dim_Object[Expression]': 'The DAX of a measure, calculated column or calculated table.',
  'Dim_Dependency[Depends on]': 'The object referred to: Table[Column], [Measure] or Table.',
  'Dim_Dependency[Depends on type]': 'Table, Column, Measure or Function.',
  'Dim_Dependency[Depends on kind]': 'What the object referred to is in more detail, such as calculated column or report measure.',
  'Dim_Dependency[Depends on table]': 'The table of the object referred to.',
  'Dim_Dependency[Depends on status]': 'Whether the object referred to is used: In report, Used indirectly, Model only or Unused.',
  'Dim_Dependency[Depends on status order]': 'Sorts Depends on status.',
  'Dim_Dimension[Dimension]': 'The name of the dimension table.',
  'Dim_Dimension[Dimension description]': 'The description of the dimension table in the model.',
  'Dim_Visual[Report]': 'The report.',
  'Dim_Visual[Page]': 'The page of the report.',
  'Dim_Visual[Visual]': 'The title of the visual, or its type when it has no title.',
  'Dim_Visual[Visual type]': 'The kind of visual, such as tableEx, barChart or slicer.',
  'Dim_Visual[Visual id]': 'The name of the visual in the report definition.',
  'Dim_Rule[Rule id]': 'The id of the rule, as used in smo.config.json.',
  'Dim_Rule[Rule]': 'The name of the rule.',
  'Dim_Rule[Group]': 'General (best practices) or Kimball (dimensional modelling).',
  'Dim_Rule[Severity]': 'Error, Warning or Note.',
  'Dim_Rule[Severity order]': 'Sorts Severity.',
  'Dim_Rule[Help]': 'Why the rule matters and what to do about it.',
};
const describe = (table, column) => DESCRIPTIONS[table + '[' + column + ']'] || DESCRIPTIONS[column] || '';

function tableDefs() {
  return tableList().map(t => Object.assign({}, t, { cols: t.cols.map(c => (c.description ? c : Object.assign({}, c, { description: describe(t.name, c.name) }))) }));
}

function tableList() {
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
        Ms('Reports using it', latest('COUNTROWS ( SUMMARIZE ( Fact_Usage, Dim_Visual[Report] ) )'), null, 'Reports in which the measure or column is used.'),
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
    facts('Fact_Bus', 'One row per business process (fact table) and dimension it reaches, per run: the enterprise data warehouse bus matrix.', 'bus.csv',
      [key('Key_Object'), key('Key_Dimension'), C('Mark', 'string'), C('Relationships', 'int64', { hidden: true }), C('Active', 'string', { hidden: true }),
        C('Through', 'string'), C('Conformed', 'string')], [
        Ms('Bus mark', latest('MAX ( Fact_Bus[Mark] )'), null, 'The mark in the bus matrix: X related, X×3 role-playing, ○ only inactive, · reached through another dimension.'),
        Ms('Business processes', zero(latest('DISTINCTCOUNT ( Fact_Bus[Key_Object] )')), null, 'Fact tables: tables that only sit on the many side of relationships, plus bridge tables with measures.'),
        Ms('Bus dimensions', zero(latest('DISTINCTCOUNT ( Fact_Bus[Key_Dimension] )')), null, 'Dimensions that business processes reach, directly or through another dimension.'),
        Ms('Conformed dimensions', zero(latest('CALCULATE ( DISTINCTCOUNT ( Fact_Bus[Key_Dimension] ), Fact_Bus[Conformed] = "Yes" )')), null, 'Dimensions shared by more than one business process of the same model.'),
      ]),
    { name: 'Dim_Run', description: 'One row per export: when, which model, from where.', file: 'runs.csv',
      cols: [key('Key_Run'), C('Run at', 'dateTime', { format: 'yyyy-mm-dd hh:nn' }), C('Date', 'date', { hidden: true }), C('Model', 'string'), C('Source', 'string'),
        C('Tool version', 'string'), C('Reports', 'int64'), C('Visuals', 'int64', { hidden: true }), C('Has sizes', 'string')] },
    { name: 'Dim_Date', description: 'One row per day from the first to the last run.', dateTable: true,
      cols: [key('Key_Date'), C('Date', 'date'), C('Year', 'int64'), C('Month', 'string')] },
    { name: 'Dim_Object', description: 'One row per object per run, plus the row -1 (whole model) for findings about the model as a whole.', file: 'objects.csv', cols: OBJECT_COLS, unknown: true },
    { name: 'Dim_Dimension', description: 'Dim_Object in the role "dimension": the dimension tables of the bus matrix.', role: 'Dim_Object', rename: DIMENSION_PAIRS,
      cols: [key('Key_Dimension'), C('Dimension', 'string'), C('Dimension description', 'string')] },
    { name: 'Dim_Dependency', description: 'Dim_Object in the role "depends on": the object the other one refers to.', role: 'Dim_Object', rename: ROLE_PAIRS,
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
  ['Fact_Bus', 'Key_Run', 'Dim_Run'], ['Fact_Bus', 'Key_Date', 'Dim_Date'], ['Fact_Bus', 'Key_Object', 'Dim_Object'], ['Fact_Bus', 'Key_Dimension', 'Dim_Dimension'],
];

/** Power Query for a table */
/** Dim_Dependency is Dim_Object in the role "depends on": these columns, renamed */
const ROLE_PAIRS = [['Key_Object', 'Key_Depends_on'], ['Label', 'Depends on'], ['Object type', 'Depends on type'], ['Kind', 'Depends on kind'], ['Table', 'Depends on table'],
  ['Status', 'Depends on status'], ['Status order', 'Depends on status order']];
/** Dim_Dimension is Dim_Object in the role "dimension" of the bus matrix */
const DIMENSION_PAIRS = [['Key_Object', 'Key_Dimension'], ['Name', 'Dimension'], ['Description', 'Dimension description']];
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
    const pairs = t.rename;
    return ['let', '    Source = ' + t.role + ',', '    Picked = Table.SelectColumns(Source, {' + pairs.map(p => '"' + p[0] + '"').join(', ') + '}),',
      '    Renamed = Table.RenameColumns(Picked, {' + pairs.map(p => `{"${p[0]}", "${p[1]}"}`).join(', ') + '})', 'in', '    Renamed'].join('\n');
  }
  const lines = ['let', `    Source = LoadCsv("${t.file}", ${pick}),`];
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
      '(name as text, columns as list) as table =>',
      'let',
      ...source,
      '    Files = Table.SelectRows(Source, each [Name] = name),',
      '    Tables = List.Transform(Files[Content], each Table.PromoteHeaders(Csv.Document(_, [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]), [PromoteAllScalars = true])),',
      '    Combined = if List.IsEmpty(Tables) then #table(columns, {}) else Table.Combine(Tables)',
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

// The look follows Stephen Few: as little ink as possible that is not data. No borders, shadows, gridlines, axis
// titles or totals; muted colours, and one bright colour (orange) only for what needs attention; bars sorted and
// labelled directly instead of read off an axis. A light grey page, white panels, and a header bar per page.
const INK = '#333333', SOFT = '#6B6B6B', LINE = '#E3E3E3', PAGE = '#F2F2F2', BAR = '#2F3B4C';
const COLOR = { blue: '#5DA5DA', lightBlue: '#88BDE6', grey: '#B3B3B3', orange: '#FAA43A', red: '#F15854' };
const STATUS_COLORS = [['In report', COLOR.blue], ['Used indirectly', COLOR.lightBlue], ['Model only', COLOR.grey], ['Unused', COLOR.orange], ['Not in model', COLOR.red], ['Model not loaded', COLOR.grey]];

function visual(id, type, x, y, w, h, roles, title, extra) {
  const queryState = {};
  for (const [role, fields] of Object.entries(roles)) queryState[role] = { projections: fields.map(fieldOf) };
  const v = { visualType: type, query: { queryState } };
  if (extra) {
    if (extra.sort) { v.query.sortDefinition = { sort: extra.sort.map(([f, direction]) => ({ field: fieldOf(f).field, direction })), isDefaultSort: true }; }
    if (extra.objects) v.objects = extra.objects;
  }
  // a card already shows the name of its measure
  v.visualContainerObjects = { title: [{ properties: type === 'card' ? { show: lit('false') } : { show: lit('true'), text: lit("'" + title.replace(/'/g, "''") + "'") } }] };
  v.drillFilterOtherVisuals = true;
  return { $schema: SCHEMA + 'visualContainer/2.4.0/schema.json', name: id, position: { x, y, z: 0, height: h, width: w, tabOrder: 0 }, visual: v };
}
const fill = color => ({ fill: { solid: { color: lit("'" + color + "'") } } });
/** colours for the values of a column (a series), such as each status */
const colorsFor = (entity, column, pairs) => pairs.map(([value, color]) => ({
  properties: fill(color),
  selector: { data: [{ scopeId: { Comparison: { ComparisonKind: 0, Left: { Column: { Expression: { SourceRef: { Entity: entity } }, Property: column } }, Right: { Literal: { Value: "'" + value.replace(/'/g, "''") + "'" } } } } }] },
}));
/** colours for measures (a line or bar per measure) */
const colorsOf = pairs => pairs.map(([f, color]) => ({ properties: fill(color), selector: { metadata: fieldOf(f).queryRef } }));
// a slicer as a dropdown; its own header is off, the title of the visual names it
const dropdown = { objects: { data: [{ properties: { mode: lit("'Dropdown'") } }], header: [{ properties: { show: lit('false') } }] } };
const slicer = (id, x, y, w, h, f, title) => visual(id, 'slicer', x, y, w, h, { Values: [f] }, title, dropdown);
const table = (id, x, y, w, h, fields, title) => visual(id, 'tableEx', x, y, w, h, { Values: fields }, title);
/** a matrix, opened to its lowest level of rows, without totals */
function matrix(id, x, y, w, h, rows, columns, values, title) {
  const v = visual(id, 'pivotTable', x, y, w, h, { Rows: rows, Columns: columns, Values: values }, title, { objects: {
    subTotals: [{ properties: { rowSubtotals: lit('false'), columnSubtotals: lit('false') } }],
    columnFormatting: values.map(f => ({ properties: { alignment: lit("'Center'") }, selector: { metadata: fieldOf(f).queryRef } })),
  } });
  // every level of the rows and columns is shown (drilled down), not only the first
  for (const role of ['Rows', 'Columns']) for (const pr of v.visual.query.queryState[role].projections) pr.active = true;
  v.visual.expansionStates = [{ roles: ['Rows'], levels: rows.map((f, i) => Object.assign({ queryRefs: [fieldOf(f).queryRef] }, i === rows.length - 1 ? { isCollapsed: true } : {}, { isPinned: true })), root: { isToggled: true } }];
  return v;
}
/** a few lines of text, such as a legend */
function note(id, x, y, w, h, lines) {
  const run = (value, style) => ({ value, textStyle: Object.assign({ fontFamily: 'Segoe UI', fontSize: '9pt', color: SOFT }, style || {}) });
  return {
    $schema: SCHEMA + 'visualContainer/2.4.0/schema.json', name: id, position: { x, y, z: 0, height: h, width: w, tabOrder: 0 },
    visual: {
      visualType: 'textbox',
      objects: { general: [{ properties: { paragraphs: lines.map(l => ({ textRuns: l.map(([value, bold]) => run(value, bold ? { fontWeight: 'bold', color: INK } : null)) })) } }] },
      visualContainerObjects: { title: [{ properties: { show: lit('false') } }], visualHeader: [{ properties: { show: lit('false') } }] },
    },
  };
}

/** The header bar of a page: the name of the tool, and the page. */
function header(page) {
  const run = (value, style) => ({ value, textStyle: Object.assign({ fontFamily: 'Segoe UI', fontSize: '14pt', color: '#FFFFFF' }, style || {}) });
  return {
    $schema: SCHEMA + 'visualContainer/2.4.0/schema.json', name: 'header', position: { x: 0, y: 0, z: 0, height: HEADER_H, width: PAGE_W, tabOrder: 0 },
    visual: {
      visualType: 'textbox',
      objects: { general: [{ properties: { paragraphs: [{ textRuns: [run('Semantic Model Optimizer', { fontWeight: 'bold' }), run('   ' + page, { color: '#C5CCD6' })] }] } }] },
      visualContainerObjects: {
        background: [{ properties: { show: lit('true'), color: { solid: { color: lit("'" + BAR + "'") } }, transparency: lit('0D') } }],
        padding: [{ properties: { top: lit('10D'), left: lit('20D'), bottom: lit('0D'), right: lit('20D') } }],
        title: [{ properties: { show: lit('false') } }],
        visualHeader: [{ properties: { show: lit('false') } }],
      },
    },
  };
}

const PAGE_W = 1280, PAGE_H = 720, HEADER_H = 48, MARGIN = 20, GAP = 12, FILTER_H = 70;
const FILTER_Y = HEADER_H + 14, TOP = FILTER_Y + FILTER_H + GAP;
/** The filters of a page: dropdowns in one row under the header. filters: [[title, table, column]] */
function filterRow(filters) {
  const w = (PAGE_W - 2 * MARGIN - (filters.length - 1) * GAP) / filters.length;
  return filters.map(([title, t, c], i) => slicer('filter' + (i + 1), Math.round(MARGIN + i * (w + GAP)), FILTER_Y, Math.round(w), FILTER_H, Cl(t, c), title));
}

function pages() {
  const O = 'Dim_Object', F = 'Fact_Object', U = 'Fact_Usage', V = 'Dim_Visual', D = 'Dim_Dependency';
  const fMODEL = ['Model', 'Dim_Run', 'Model'], fTYPE = ['Object type', O, 'Object type'], fTABLE = ['Table', O, 'Table'], fFIELD = ['Measure or column', O, 'Label'];
  const full = PAGE_W - 2 * MARGIN, body = PAGE_H - TOP - MARGIN;
  const cardW = (full - 6 * GAP) / 7, cardH = 84;
  const cards = [['Measures', F], ['Unused measures', F], ['Columns', F], ['Unused columns', F], ['Broken formulas', F], ['Errors', 'Fact_Finding'], ['Warnings', 'Fact_Finding']]
    .map(([p, t], i) => visual('card' + i, 'card', Math.round(MARGIN + i * (cardW + GAP)), TOP, Math.round(cardW), cardH, { Values: [M(t, p)] }, p));
  const half = (full - GAP) / 2, chartY = TOP + cardH + GAP, chartH = 236, rulesY = chartY + chartH + GAP;
  const unused = M(F, 'Unused measures'), unusedCols = M(F, 'Unused columns'), errors = M('Fact_Finding', 'Errors'), findings = M('Fact_Finding', 'Findings');
  const page = (name, displayName, visuals) => ({ name, displayName, visuals: [header(displayName)].concat(visuals) });
  return [
    page('overview', 'Overview', [
      ...filterRow([fMODEL, fTYPE, fTABLE, ['Date', 'Dim_Date', 'Date']]),
      ...cards,
      visual('status', 'barChart', MARGIN, chartY, half, chartH, { Category: [Cl(O, 'Object type')], Series: [Cl(O, 'Status')], Y: [M(F, 'Objects')] }, 'Objects by status',
        { objects: { dataPoint: colorsFor(O, 'Status', STATUS_COLORS) } }),
      visual('trend', 'lineChart', MARGIN + half + GAP, chartY, half, chartH, { Category: [Cl('Dim_Date', 'Date')], Y: [unused, unusedCols, errors] }, 'Over time',
        { objects: { dataPoint: colorsOf([[unused, COLOR.orange], [unusedCols, COLOR.blue], [errors, COLOR.red]]) } }),
      // one colour, longest bar first, the number at the bar instead of an axis to read it from
      visual('rules', 'clusteredBarChart', MARGIN, rulesY, full, PAGE_H - rulesY - MARGIN, { Category: [Cl('Dim_Rule', 'Rule')], Y: [findings] }, 'Findings by rule',
        { sort: [[findings, 'Descending']], objects: { dataPoint: [{ properties: fill(COLOR.blue) }], labels: [{ properties: { show: lit('true') } }], valueAxis: [{ properties: { show: lit('false') } }] } })]),
    page('objects', 'Objects', [
      ...filterRow([fMODEL, fTYPE, ['Status', O, 'Status'], fTABLE, ['Hidden', O, 'Hidden'], ['Broken', O, 'Broken']]),
      table('list', MARGIN, TOP, full, body, [Cl(O, 'Table'), Cl(O, 'Name'), Cl(O, 'Kind'), Cl(O, 'Status'), Cl(O, 'Hidden'), M(U, 'Reports using it'), M(U, 'Visuals'), M(F, 'Used by objects'), M(F, 'Size (MB)')], 'Tables, columns and measures')]),
    // where a measure or column is used: pick it in the filters or click it on the left, the visuals are on the right
    page('usage', 'Where used', [
      ...filterRow([fMODEL, fTYPE, fTABLE, fFIELD, ['Report', V, 'Report'], ['Page', V, 'Page']]),
      table('fields', MARGIN, TOP, 440, body, [Cl(O, 'Label'), M(U, 'Reports using it'), M(U, 'Visuals')], 'Measures and columns in reports'),
      table('list', MARGIN + 440 + GAP, TOP, full - 440 - GAP, body, [Cl('Dim_Run', 'Model'), Cl(V, 'Report'), Cl(V, 'Page'), Cl(V, 'Visual'), Cl(V, 'Visual type'), Cl(O, 'Label'), Cl(U, 'Role'), M(U, 'Field uses')], 'Reports and visuals that use them')]),
    page('findings', 'Findings', [
      ...filterRow([fMODEL, ['Severity', 'Dim_Rule', 'Severity'], ['Group', 'Dim_Rule', 'Group'], ['Rule', 'Dim_Rule', 'Rule'], fTABLE]),
      table('list', MARGIN, TOP, full, body, [Cl('Dim_Rule', 'Severity'), Cl('Dim_Rule', 'Rule'), Cl(O, 'Label'), Cl('Fact_Finding', 'Detail'), M('Fact_Finding', 'Findings')], 'Findings')]),
    // the enterprise data warehouse bus matrix (Kimball): business processes down, the dimensions they reach across
    page('bus', 'Bus matrix', [
      ...filterRow([fMODEL, ['Business process', O, 'Name'], ['Dimension', 'Dim_Dimension', 'Dimension'], ['Conformed', 'Fact_Bus', 'Conformed']]),
      ...['Business processes', 'Bus dimensions', 'Conformed dimensions'].map((p, i) => visual('card' + i, 'card', Math.round(MARGIN + i * (cardW + GAP)), TOP, Math.round(cardW), cardH, { Values: [M('Fact_Bus', p)] }, p)),
      note('legend', Math.round(MARGIN + 3 * (cardW + GAP)), TOP, Math.round(full - 3 * (cardW + GAP)), cardH, [
        [['X', true], [' related    '], ['X×2', true], [' twice (role-playing)    '], ['○', true], [' only inactive    '], ['·', true], [' through another dimension']],
        [['Business process: a fact table. Conformed: used by more than one business process.']],
      ]),
      matrix('matrix', MARGIN, TOP + cardH + GAP, full, PAGE_H - TOP - cardH - GAP - MARGIN, [Cl('Dim_Run', 'Model'), Cl(O, 'Name')], [Cl('Dim_Dimension', 'Dimension')], [M('Fact_Bus', 'Bus mark')], 'Business processes and their dimensions')]),
    page('lineage', 'Lineage', [
      ...filterRow([fMODEL, fTYPE, fTABLE, ['Object', O, 'Label'], ['Depends on', D, 'Depends on']]),
      table('list', MARGIN, TOP, full, body, [Cl(O, 'Label'), Cl(O, 'Kind'), Cl(O, 'Status'), Cl(D, 'Depends on'), Cl(D, 'Depends on kind'), Cl(D, 'Depends on status'), M('Fact_Dependency', 'Dependencies')], 'What depends on what')]),
  ];
}

const solid = color => ({ solid: { color } });
const text = { fontFamily: 'Segoe UI', fontSize: 9, color: solid(SOFT) };
const THEME = {
  name: NAME,
  dataColors: [COLOR.blue, COLOR.orange, '#60BD68', '#F17CB0', '#B2912F', '#B276B2', '#DECF3F', COLOR.red, '#4D4D4D'],
  background: '#FFFFFF', foreground: INK, tableAccent: COLOR.blue,
  textClasses: {
    title: { fontFace: 'Segoe UI Semibold', fontSize: 11, color: INK },
    label: { fontFace: 'Segoe UI', fontSize: 9, color: SOFT },
    callout: { fontFace: 'Segoe UI Light', fontSize: 24, color: INK },
  },
  visualStyles: {
    page: { '*': {
      background: [{ color: solid(PAGE), transparency: 0 }],
      outspace: [{ color: solid(PAGE), transparency: 0 }],
    } },
    '*': { '*': {
      background: [{ show: true, color: solid('#FFFFFF'), transparency: 0 }],
      border: [{ show: false }],
      dropShadow: [{ show: false }],
      title: [{ show: true, fontFamily: 'Segoe UI Semibold', fontSize: 11, fontColor: solid(INK), alignment: 'left' }],
      padding: [{ top: 8, bottom: 8, left: 12, right: 12 }],
      valueAxis: [{ gridlineShow: false, showAxisTitle: false, labelColor: solid(SOFT), fontSize: 9 }],
      categoryAxis: [{ gridlineShow: false, showAxisTitle: false, labelColor: solid(SOFT), fontSize: 9 }],
      legend: [{ position: 'TopLeft', showTitle: false, labelColor: solid(SOFT), fontSize: 9 }],
      labels: [{ color: solid(SOFT), fontSize: 9 }],
    } },
    card: { '*': {
      labels: [{ color: solid(INK), fontSize: 24, fontFamily: 'Segoe UI Light' }],
      categoryLabels: [{ show: true, color: solid(SOFT), fontSize: 9 }],
    } },
    lineChart: { '*': { lineStyles: [{ strokeWidth: 2, showMarker: false }] } },
    tableEx: { '*': {
      grid: [{ gridVertical: false, gridHorizontal: true, gridHorizontalColor: solid(LINE), gridHorizontalWeight: 1, outlineColor: solid(LINE), rowPadding: 3 }],
      columnHeaders: [{ fontColor: solid(INK), backColor: solid('#FFFFFF'), fontSize: 9, fontFamily: 'Segoe UI Semibold', outline: 'BottomOnly' }],
      values: [{ fontColorPrimary: solid(INK), fontColorSecondary: solid(INK), backColorPrimary: solid('#FFFFFF'), backColorSecondary: solid('#FFFFFF'), fontSize: 9, outline: 'None' }],
      total: [{ totals: false }],
    } },
    slicer: { '*': {
      items: [{ fontColor: solid(INK), fontSize: 9 }],
      padding: [{ top: 4, bottom: 4, left: 12, right: 12 }],
    } },
    textbox: { '*': { background: [{ show: false }] } },
    pivotTable: { '*': {
      grid: [{ gridVertical: true, gridVerticalColor: solid(LINE), gridVerticalWeight: 1, gridHorizontal: true, gridHorizontalColor: solid(LINE), gridHorizontalWeight: 1, outlineColor: solid(LINE), rowPadding: 3 }],
      columnHeaders: [{ fontColor: solid(INK), backColor: solid('#FFFFFF'), fontSize: 9, fontFamily: 'Segoe UI Semibold', outline: 'BottomOnly', alignment: 'Center', wordWrap: true }],
      rowHeaders: [{ fontColor: solid(INK), backColor: solid('#FFFFFF'), fontSize: 9, outline: 'None', stepped: false }],
      values: [{ fontColorPrimary: solid(INK), fontColorSecondary: solid(INK), backColorPrimary: solid('#FFFFFF'), backColorSecondary: solid('#FFFFFF'), fontSize: 10, outline: 'None' }],
    } },
  },
};

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
    add(rp + `definition/pages/${p.name}/page.json`, { $schema: SCHEMA + 'page/2.1.0/schema.json', name: p.name, displayName: p.displayName, displayOption: 'FitToPage', height: PAGE_H, width: PAGE_W,
      objects: { background: [{ properties: { color: { solid: { color: lit("'" + PAGE + "'") } }, transparency: lit('0D') } }], outspace: [{ properties: { color: { solid: { color: lit("'" + PAGE + "'") } } } }] } });
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
    rename: t.rename || null,
  }));
}

/** A DAX query per visual of the report, with its columns and measures: the notebook runs them after each run, so
 * Direct Lake has loaded what the report needs before anyone opens it. */
function warmQueries() {
  const out = new Set();
  for (const p of pages()) for (const v of p.visuals) {
    const fields = [];
    for (const role of Object.values((v.visual.query && v.visual.query.queryState) || {})) for (const pr of role.projections) fields.push(pr.field);
    const cols = fields.filter(f => f.Column).map(f => "'" + f.Column.Expression.SourceRef.Entity + "'[" + f.Column.Property + ']');
    const meas = fields.filter(f => f.Measure).map((f, i) => '"m' + i + '", [' + f.Measure.Property + ']');
    if (!cols.length && !meas.length) continue;
    out.add(cols.length ? 'EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( ' + cols.concat(meas).join(', ') + ' ) )' : 'EVALUATE ROW ( ' + meas.join(', ') + ' )');
  }
  return [...out];
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

const TABLES = ['runs', 'objects', 'visuals', 'usage', 'dependencies', 'findings', 'rules', 'bus'];

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
  const tables = runTables(analysis, checks, { run: 1, model: (opts && opts.modelName) || model.name, source, version, reports: proj.reports.length, visuals: analysis.stats.visuals, bus: SMO.busMatrix(model.model, analysis) });
  return writeRun(folder, tables, version, opts);
}

return { runTables, withRun, validTables, projectFiles, writeRun, writeReport, exportProject, ruleKey, lakehouseTables, directLakeFiles, warmQueries, deltaColumn, NAME };
});
