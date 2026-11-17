/* Builds a small Power BI project in a temporary folder for the tests: a model in TMDL and a report in PBIR. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const T = '\t';
const lines = a => a.join('\n') + '\n';

const SALES = lines([
  '/// One row per order line.',
  'table Sales',
  '',
  T + '/// Net amount of all order lines.',
  T + 'measure Total = SUM ( Sales[Amount] )',
  T + T + 'formatString: #,0',
  '',
  T + "measure 'Total again' = SUM ( Sales[Amount] )",
  '',
  T + 'measure Twice = [Total] * 2',
  T + T + 'formatString: #,0',
  '',
  T + "measure 'Per customer' =",
  T + T + T + 'DIVIDE (',
  T + T + T + '    [Total],',
  T + T + T + '    DISTINCTCOUNT ( Sales[CustKey] )',
  T + T + T + ')',
  T + T + 'formatString: #,0.00',
  '',
  T + 'column Amount',
  T + T + 'dataType: decimal',
  T + T + 'sourceColumn: amount',
  '',
  T + 'column Qty',
  T + T + 'dataType: int64',
  T + T + 'sourceColumn: qty',
  '',
  T + 'column DateKey',
  T + T + 'dataType: dateTime',
  T + T + 'isHidden',
  T + T + 'sourceColumn: order_date',
  '',
  T + 'column CustKey',
  T + T + 'dataType: int64',
  T + T + 'sourceColumn: customer_id',
  '',
  T + "column 'Amount x2' = Sales[Amount] * 2",
  T + T + 'dataType: decimal',
  '',
  T + 'partition Sales = m',
  T + T + 'mode: import',
  T + T + 'source =',
  T + T + T + T + 'let',
  T + T + T + T + '  Source = Sql.Database("srv01", "DWH"),',
  T + T + T + T + '  Data = Source{[Schema="dbo",Item="FactSales"]}[Data]',
  T + T + T + T + 'in',
  T + T + T + T + '  Data',
]);
const DATE = lines([
  'table Date',
  T + 'dataCategory: Time',
  '',
  T + 'column Date',
  T + T + 'dataType: dateTime',
  T + T + 'sourceColumn: date',
  '',
  T + 'column Year',
  T + T + 'dataType: int64',
  T + T + 'sourceColumn: year',
  '',
  T + 'column Month',
  T + T + 'dataType: string',
  T + T + 'sourceColumn: month',
  T + T + 'sortByColumn: MonthNo',
  '',
  T + 'column MonthNo',
  T + T + 'dataType: int64',
  T + T + 'sourceColumn: month_no',
  '',
  T + 'hierarchy Calendar',
  T + T + 'level Year',
  T + T + T + 'column: Year',
  T + T + 'level Month',
  T + T + T + 'column: Month',
  '',
  T + 'partition Date = m',
  T + T + 'mode: import',
  T + T + 'source =',
  T + T + T + T + 'let Source = Sql.Database("srv01", "DWH"), Data = Source{[Schema="dbo",Item="DimDate"]}[Data] in Data',
]);
const CUSTOMER = lines([
  'table Customer',
  '',
  T + 'column CustKey',
  T + T + 'dataType: int64',
  T + T + 'sourceColumn: customer_id',
  '',
  T + 'column Name',
  T + T + 'dataType: string',
  T + T + 'sourceColumn: name',
  '',
  T + 'column Region',
  T + T + 'dataType: string',
  T + T + 'sourceColumn: region',
  '',
  T + 'column Phone',
  T + T + 'dataType: string',
  T + T + 'sourceColumn: phone',
  '',
  T + 'partition Customer = m',
  T + T + 'mode: import',
  T + T + 'source =',
  T + T + T + T + 'let Source = Sql.Database("srv01", "DWH"), Data = Source{[Schema="dbo",Item="DimCustomer"]}[Data] in Data',
]);
const SPARE = lines([
  'table Spare',
  '',
  T + 'column X',
  T + T + 'dataType: string',
  T + T + 'sourceColumn: x',
  '',
  T + 'partition Spare = m',
  T + T + 'mode: import',
  T + T + 'source =',
  T + T + T + T + 'let x = #table({"x"}, {{"1"}}) in x',
]);
const MODEL = lines([
  'model Model',
  T + 'culture: en-US',
  '',
  'annotation PBI_QueryOrder = ["Sales","Date","Customer","Spare"]',
  '',
  'ref table Sales',
  'ref table Date',
  'ref table Customer',
  'ref table Spare',
]);
const RELS = lines([
  'relationship r1',
  T + 'fromColumn: Sales.DateKey',
  T + 'toColumn: Date.Date',
  '',
  'relationship r2',
  T + 'fromColumn: Sales.CustKey',
  T + 'toColumn: Customer.CustKey',
]);
const ROLES = lines([
  "role 'NL only'",
  T + 'modelPermission: read',
  '',
  T + 'tablePermission Customer = [Region] = "NL"',
]);

const src = e => ({ Expression: { SourceRef: { Entity: e } } });
const field = (kind, e, p) => ({ field: { [kind]: Object.assign(src(e), { Property: p }) }, queryRef: e + '.' + p, nativeQueryRef: p });
const visual = (name, type, projections) => ({ name, visual: { visualType: type, query: { queryState: { Values: { projections } } } } });

/** Writes the project and returns its folder. */
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smo-test-'));
  const w = (rel, text) => { const f = path.join(root, 'Demo', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof text === 'string' ? text : JSON.stringify(text, null, 2)); };
  w('Demo.SemanticModel/definition/model.tmdl', MODEL);
  w('Demo.SemanticModel/definition/relationships.tmdl', RELS);
  w('Demo.SemanticModel/definition/roles/NL only.tmdl', ROLES);
  w('Demo.SemanticModel/definition/tables/Sales.tmdl', SALES);
  w('Demo.SemanticModel/definition/tables/Date.tmdl', DATE);
  w('Demo.SemanticModel/definition/tables/Customer.tmdl', CUSTOMER);
  w('Demo.SemanticModel/definition/tables/Spare.tmdl', SPARE);
  w('Demo.Report/definition.pbir', { version: '4.0', datasetReference: { byPath: { path: '../Demo.SemanticModel' } } });
  w('Demo.Report/definition/report.json', {});
  w('Demo.Report/definition/pages/p1/page.json', { name: 'p1', displayName: 'Overview' });
  w('Demo.Report/definition/pages/p1/visuals/v1/visual.json', visual('v1', 'barChart', [field('Measure', 'Sales', 'Total'), field('Column', 'Date', 'Month')]));
  w('Demo.Report/definition/pages/p1/visuals/v2/visual.json', visual('v2', 'tableEx', [field('Column', 'Customer', 'Name'), field('Measure', 'Sales', 'Report total')]));
  w('Demo.Report/definition/reportExtensions.json', { name: 'extension', entities: [{ name: 'Sales', measures: [{ name: 'Report total', dataType: 'Double', expression: '[Total] + 0' }] }] });
  return path.join(root, 'Demo');
}

module.exports = { makeProject };
