/* A project that touches every rule and every way a report can use a field: for comparing the JavaScript with the
 * Python port (fabric/smo.py). A model in TMDL, two reports in PBIR with the same name, and two in the older
 * report.json format. Not meant to be a good model. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// two spaces in this file are one tab in TMDL
const tm = text => text.replace(/^\n/, '').replace(/^( {2})+/gm, m => '\t'.repeat(m.length / 2));

const MODEL = {
  'model.tmdl': tm(`
model Model
  culture: nl-NL

ref table Feit_Verkoop
`),
  'expressions.tmdl': tm(`
expression Server = "srv01" meta [IsParameterQuery=true, Type="Text"]

/// Combines two tables.
expression Samen =
    let
      a = Dim_Segment,
      b = #"Dim Product",
      c = "Dim_Klant is only text here"
    in
      a
`),
  'functions.tmdl': tm(`
/// Doubles a value.
function Verdubbel = (x) => x * 2 + [Omzet]

function 'Zonder gebruik' = () => [Bestaat nergens]
`),
  'relationships.tmdl': tm(`
relationship r1
  fromColumn: Feit_Verkoop.DK_Datum
  toColumn: Dim_Datum.DK_Datum

relationship r2
  isActive: false
  fromColumn: Feit_Verkoop.DK_Verzenddatum
  toColumn: Dim_Datum.DK_Datum

relationship r3
  isActive: false
  fromColumn: Feit_Verkoop.DK_Leverdatum
  toColumn: Dim_Datum.Datum

relationship r4
  relyOnReferentialIntegrity
  fromColumn: Feit_Verkoop.DK_Klant
  toColumn: Dim_Klant.DK_Klant

relationship r5
  fromColumn: Feit_Verkoop.Productcode
  toColumn: 'Dim Product'.Productcode

relationship r6
  fromColumn: Dim_Klant.'Segment key'
  toColumn: Dim_Segment.'Segment key'

relationship r7
  crossFilteringBehavior: bothDirections
  toCardinality: many
  fromColumn: Brug.Klant
  toColumn: Dim_Klant.Naam

relationship r8
  fromColumn: Feit_Voorraadstand.Ordernummer
  toColumn: Feit_Verkoop.Ordernummer

relationship r9
  fromColumn: Feit_Voorraadstand.DK_Datum
  toColumn: Dim_Datum.DK_Datum

relationship r10
  fromCardinality: one
  toCardinality: many
  fromColumn: 'éclair'.Sleutel
  toColumn: feit_klein.Sleutel

relationship r11
  fromColumn: Feit_Verkoop.Bestaat_niet
  toColumn: Nergens.Sleutel

relationship r12
  fromColumn: Zeta.Sleutel
  toColumn: 'éclair'.Sleutel

relationship r13
  fromColumn: alfa.Sleutel
  toColumn: 'éclair'.Sleutel

relationship r14
  fromColumn: 'Alfa 2'.Sleutel
  toColumn: 'éclair'.Sleutel

relationship r15
  fromColumn: Feit_Verkoop.DK_Los
  toColumn: Dim_Klant.DK_Oud
`),
  'roles/Regio.tmdl': tm(`
role Regio
  modelPermission: read

  tablePermission Dim_Klant = [Regio] = USERPRINCIPALNAME() && Dim_Segment[Segment] <> "x"
`),
  'tables/Feit_Verkoop.tmdl': tm(`
/// Eén rij per orderregel.
table Feit_Verkoop

  /// Omzet exclusief btw.
  measure Omzet = SUM ( Feit_Verkoop[Bedrag] )
    formatString: #,0

  measure 'Omzet (verzonden)' =
      CALCULATE (
          [Omzet],
          USERELATIONSHIP ( Feit_Verkoop[DK_Verzenddatum], Dim_Datum[DK_Datum] )
      )
    formatString: #,0
    displayFolder: "Omzet\\Rollen"

  measure Dubbel = SUM(Feit_Verkoop[Bedrag])

  measure Kapot = [Bestaat niet] + Geen[Tabel] + Feit_Verkoop[Weg] + [Bestaat niet]
    isHidden

  measure 'Via kapot' = [Kapot] * 2 -- [ook niet]

  measure Slordig = SUMX ( Feit_Verkoop, [Bedrag] * Feit_Verkoop[Omzet] ) + Verdubbel ( 1 )
    formatString: 0.00

  measure 'Met tekst' = \`\`\`
      VAR t = { 1, 2 }
      VAR s = "tekst met [haken] en ""aanhalingstekens"""
      /* [commentaar] over
         twee regels */
      RETURN SUMX ( t, [Value] ) + MAXX ( ADDCOLUMNS ( Dim_Klant, "Eigen", 1 ), [Eigen] ) + YEAR ( MAX ( Dim_Datum[Datum].[Date] ) )
      \`\`\`
    formatString: 0

  measure Dynamisch = [Omzet]
    formatStringDefinition = IF ( [Omzet] > 1000, "#,0,K", "#,0" )

  measure 'Marge via kolom' = SUM ( Feit_Verkoop[Bedrag x2] ) / [Omzet]
    formatString: 0.0%

  column DK_Datum
    dataType: int64
    isHidden
    isNullable: false
    sourceColumn: date_key

  column DK_Verzenddatum
    dataType: int64
    isHidden
    sourceColumn: ship_key

  column DK_Leverdatum
    dataType: dateTime
    sourceColumn: delivery

  column DK_Klant
    dataType: int64
    sourceColumn: customer_key

  column DK_Los
    dataType: int64
    sourceColumn: loose

  column DK_Nergens
    dataType: int64
    sourceColumn: nowhere

  column Productcode
    dataType: string
    sourceColumn: product_code

  column Ordernummer
    dataType: string
    sourceColumn: order_no

  column Bedrag
    dataType: decimal
    sourceColumn: amount

  column 'Marge %'
    dataType: double
    sourceColumn: margin

  column Opmerking
    dataType: string
    sourceColumn: "note ""x"""

  column Bedrag_euro
    dataType: decimal
    sourceColumn: amount_eur

  column 'Bedrag x2' = Feit_Verkoop[Bedrag] * 2
    dataType: decimal

  column Kapotte_kolom = Feit_Verkoop[Bedrag] + [Kapot]
    dataType: double

  column RijNr
    dataType: int64
    type: rowNumber

  partition Feit_Verkoop = m
    mode: import
    source =
        let
          Source = Sql.Database(Server, "DWH"),
          Data = Source{[Schema="dbo",Item="FactSales"]}[Data],
          Keep = Table.SelectColumns(Data, {"amount", "note ""x""", "date_key"})
        in
          Keep
`),
  'tables/Feit_Voorraadstand.tmdl': tm(`
/// Stand van de voorraad per dag (periodieke snapshot).
table Feit_Voorraadstand

  measure 'Voorraad totaal' = SUM ( Feit_Voorraadstand[Aantal] )
    formatString: #,0

  measure 'Voorraad eind' = CALCULATE ( SUM ( Feit_Voorraadstand[Aantal] ), LASTDATE ( Dim_Datum[Datum] ) )
    formatString: #,0

  column DK_Datum
    dataType: int64
    sourceColumn: date_key

  column Ordernummer
    dataType: string
    sourceColumn: order_no

  column Aantal
    dataType: int64
    sourceColumn: qty

  column 'Magazijn id'
    dataType: int64
    sourceColumn: wh

  partition Feit_Voorraadstand = m
    mode: directQuery
    source = let Source = Sql.Database(Server, "DWH") in Source
`),
  'tables/kleine.tmdl': tm(`
table feit_klein

  column Sleutel
    dataType: int64
    sourceColumn: k

  column Waarde
    dataType: double
    sourceColumn: v

  partition feit_klein = m
    mode: import
    source = let x = #table({"k"}, {{1}}) in x

table Zeta

  column Sleutel
    dataType: int64
    sourceColumn: k

table alfa

  column Sleutel
    dataType: int64
    sourceColumn: k

table 'Alfa 2'

  column Sleutel
    dataType: int64
    sourceColumn: k

table 'éclair'

  column Sleutel
    dataType: int64
    sourceColumn: k

  column 'Soort code'
    dataType: string
    sourceColumn: c

  partition 'éclair' = m
    mode: import
    source = let x = #table({"k"}, {{1}}) in x
`),
  'tables/Dim_Datum.tmdl': tm(`
table Dim_Datum
  dataCategory: Time

  column DK_Datum
    dataType: int64
    isHidden
    sourceColumn: date_key

  column Datum
    dataType: dateTime
    sourceColumn: the_date

  column Jaar
    dataType: int64
    sourceColumn: year

  column Maand
    dataType: string
    sourceColumn: month
    sortByColumn: Maandnr

  column Maandnr
    dataType: int64
    sourceColumn: month_no

  hierarchy Kalender
    level Jaar
      column: Jaar
    level Maand
      column: Maand

  partition Dim_Datum = m
    mode: import
    source = let Source = Sql.Database(Server, "DWH") in Source
`),
  'tables/Dim_Klant.tmdl': tm(`
/// Klanten, met historie.
table Dim_Klant

  column DK_Klant
    dataType: int64
    sourceColumn: customer_key

  column Naam
    dataType: string
    sourceColumn: name

  column Regio
    dataType: string
    sourceColumn: region

  column 'E-mail'
    dataType: string
    isHidden
    sourceColumn: email

  column BSN
    dataType: string
    sourceColumn: bsn

  column 'Status code'
    dataType: string
    sourceColumn: status

  column 'Is actief'
    dataType: boolean
    sourceColumn: active

  column 'Geldig vanaf'
    dataType: dateTime
    sourceColumn: valid_from

  column 'Segment key'
    dataType: int64
    sourceColumn: segment

  column DK_Oud
    dataType: int64
    sourceColumn: old

  partition Dim_Klant = m
    mode: import
    source = let Source = Sql.Database(Server, "DWH") in Source
`),
  'tables/Dim_Segment.tmdl': tm(`
table Dim_Segment

  column 'Segment key'
    dataType: int64
    sourceColumn: segment

  column Segment
    dataType: string
    sourceColumn: name

  partition Dim_Segment = m
    mode: import
    source = let Source = Sql.Database(Server, "DWH") in Source
`),
  'tables/Dim Product.tmdl': tm(`
table 'Dim Product'

  column Productcode
    dataType: string
    sourceColumn: code

  column 'Product  naam'
    dataType: string
    sourceColumn: name

  column ' Kleur'
    dataType: string
    sourceColumn: colour

  column 'It''s'
    dataType: string
    sourceColumn: its

  partition 'Dim Product' = m
    mode: import
    source = let Source = Sql.Database(Server, "DWH") in Source
`),
  'tables/Brug.tmdl': tm(`
table Brug

  column Klant
    dataType: string
    sourceColumn: k

  partition Brug = m
    mode: import
    source = let Source = Sql.Database(Server, "DWH") in Source
`),
  'tables/Kalender kopie.tmdl': tm(`
table 'Kalender kopie'

  column Date
    dataType: dateTime
    sourceColumn: [Date]

  partition 'Kalender kopie' = calculated
    mode: import
    source = FILTER ( Dim_Datum, Dim_Datum[Jaar] > 2020 && [Omzet] > 0 )
`),
  'tables/Tijd.tmdl': tm(`
table Tijd

  calculationGroup

    calculationItem YTD = CALCULATE ( SELECTEDMEASURE (), DATESYTD ( Dim_Datum[Datum] ) )

    calculationItem Vorig =
        CALCULATE ( SELECTEDMEASURE (), DATEADD ( Dim_Datum[Datum], -1, YEAR ) )
      formatStringDefinition = "0.0 " & [Omzet]

  column Berekening
    dataType: string
    sourceColumn: Name

  partition Tijd = calculationGroup
`),
  'tables/LocalDateTable_1.tmdl': tm(`
table LocalDateTable_1
  isHidden

  column Date
    dataType: dateTime
    sourceColumn: [Date]

  partition LocalDateTable_1 = calculated
    mode: import
    source = Calendar(Date(2015,1,1), Date(2015,1,1))
`),
};

const src = e => ({ Expression: { SourceRef: { Entity: e } } });
const ref = (kind, e, p) => ({ [kind]: Object.assign(src(e), { Property: p }) });
const field = (kind, e, p) => ({ field: ref(kind, e, p), queryRef: e + '.' + p, nativeQueryRef: p });
const lit = v => ({ expr: { Literal: { Value: v } } });
const level = (e, h, l) => ({ field: { HierarchyLevel: { Expression: { Hierarchy: Object.assign(src(e), { Hierarchy: h }) }, Level: l } }, queryRef: e + '.' + h + '.' + l });

const pbir = title => ({
  'definition.pbir': { version: '4.0', datasetReference: { byPath: { path: '../Model.SemanticModel' } } },
  'definition/report.json': { filterConfig: { filters: [{ name: 'f0', field: ref('Column', 'Dim_Klant', 'Regio') }] } },
  'definition/reportExtensions.json': { name: 'extension', entities: [{ name: 'Feit_Verkoop', measures: [
    { name: 'Alleen rapport', dataType: 'Double', expression: '[Omzet] + [Nog een]', description: 'In the report only.' },
    { name: 'Omzet', expression: '0' }, { name: 'Nog een', expression: ['1', '+ 1'] }] }] },
  'definition/pages/pages.json': { pageOrder: ['p1', 'p2'] },
  'definition/pages/p1/page.json': { name: 'p1', displayName: title + ' overzicht', filterConfig: { filters: [{ field: ref('Column', 'Dim_Datum', 'Jaar') }] } },
  'definition/pages/p2/page.json': { name: 'p2' },
  'definition/pages/p1/visuals/v1/visual.json': {
    name: 'v1',
    visual: {
      visualType: 'barChart',
      query: {
        queryState: {
          Y: { projections: [field('Measure', 'Feit_Verkoop', 'Omzet'), field('Measure', 'Feit_Verkoop', 'Alleen rapport'), field('Measure', 'Feit_Verkoop', 'Bestaat niet')] },
          Category: { projections: [level('Dim_Datum', 'Kalender', 'Maand'), level('Dim_Datum', 'Kalender', 'Kwartaal'), field('Column', 'Dim_Klant', 'Naam'), field('Column', 'Dim_Klant', 'Naam')] },
          10: { projections: [field('Column', 'Dim Product', ' Kleur')] },
          2: { projections: [field('Column', 'Dim_Klant', 'Regio')] },
        },
        sortDefinition: { sort: [{ field: ref('Measure', 'Feit_Verkoop', 'Omzet (verzonden)'), direction: 'Descending' }] },
      },
      objects: { dataPoint: [{ properties: { fill: { solid: { color: { expr: ref('Measure', 'Feit_Verkoop', 'Dynamisch') } } } } }] },
      visualContainerObjects: { title: [{ properties: { show: lit('true'), text: lit("'Omzet per ''maand'''") } }] },
    },
    filterConfig: { filters: [{ field: ref('Column', 'Onbekend', 'Kolom') }] },
  },
  'definition/pages/p1/visuals/v2/visual.json': {
    name: 'v2',
    visual: {
      visualType: 'tableEx',
      query: {
        queryState: { Values: { projections: [
          { field: { Column: { Expression: { SourceRef: { Source: 'k' } }, Property: 'BSN' } } },
          field('Column', 'Feit_Verkoop', 'Bedrag_euro'), field('Measure', 'Feit_Voorraadstand', 'Voorraad totaal'),
          { field: { HierarchyLevel: { Expression: { Hierarchy: { Expression: { PropertyVariationSource: Object.assign(src('Dim_Datum'), { Name: 'Variation', Property: 'Datum' }) }, Hierarchy: 'Date Hierarchy' } }, Level: 'Year' } } },
        ] } },
        From: [{ Name: 'k', Entity: 'Dim_Klant', Type: 0 }],
      },
    },
  },
  'definition/pages/p2/visuals/g1/visual.json': { name: 'g1', visualGroup: { displayName: 'Groep' } },
  'definition/pages/p2/visuals/v3/visual.json': { visual: { visualType: 'slicer', query: { queryState: { Values: { projections: [field('Column', 'Tijd', 'Berekening'), field('Column', 'éclair', 'Soort code')] } } } } },
  'definition/pages/p2/visuals/bad/visual.json': '{ not json',
  'definition/bookmarks/b1.bookmark.json': { name: 'b1', displayName: 'Bladwijzer', explorationState: { filters: [{ expression: ref('Column', 'Dim_Segment', 'Segment') }] } },
});

const alias = (kind, a, p) => ({ [kind]: { Expression: { SourceRef: { Source: a } }, Property: p } });
const legacy = {
  config: JSON.stringify({
    modelExtensions: [{ name: 'extension', entities: [{ name: 'Dim_Klant', measures: [{ name: 'Oude maat', expression: 'COUNTROWS ( Dim_Klant ) + [Slordig]' }] }] }],
    bookmarks: [{ displayName: 'Oud', explorationState: { x: ref('Measure', 'Feit_Verkoop', 'Dubbel') } }],
  }),
  filters: JSON.stringify([{ expression: ref('Column', 'Dim_Datum', 'Maand') }]),
  sections: [
    { name: 's1', displayName: 'Oude pagina', filters: '[]', visualContainers: [
      {
        id: 12,
        config: JSON.stringify({ name: 'oud1', singleVisual: {
          visualType: 'card',
          prototypeQuery: { From: [{ Name: 'f', Entity: 'Feit_Verkoop' }, { Name: 'd', Entity: 'Dim_Datum' }], Select: [alias('Measure', 'f', 'Oude maat'), alias('Measure', 'f', 'Marge via kolom'), alias('Column', 'd', 'Jaar')] },
          objects: { labels: [{ properties: { color: { expr: alias('Column', 'd', 'Verdwenen') } } }] },
          vcObjects: { title: [{ properties: { text: lit("'Kaart'") } }] },
        } }),
        filters: JSON.stringify([{ expression: ref('Column', 'Dim_Klant', 'Status code') }]), query: '{"x":1}', dataTransforms: 'niet json',
      },
      { id: 13, config: JSON.stringify({ singleVisualGroup: {} }) },
    ] },
    { name: 's2', visualContainers: [] },
  ],
};

/** Writes the project and returns its folder. */
function makeStress() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smo-stress-'));
  const w = (rel, text) => { const f = path.join(root, 'Stress', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof text === 'string' ? text : JSON.stringify(text, null, 2)); };
  for (const [rel, text] of Object.entries(MODEL)) w('Model.SemanticModel/definition/' + rel, text);
  for (const [rel, text] of Object.entries(pbir('Verkoop'))) w('Verkoop.Report/' + rel, text);
  for (const [rel, text] of Object.entries(pbir('Kopie'))) w('kopie/Verkoop.Report/' + rel, text);
  w('Oud.Report/report.json', legacy);
  w('Élan.Report/report.json', Object.assign({}, legacy, { config: '{}' }));
  return path.join(root, 'Stress');
}

module.exports = { makeStress };
