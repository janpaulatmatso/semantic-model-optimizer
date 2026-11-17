/* Semantic Model Optimizer — language switch (English / Nederlands).
 * The interface is written in English. This file translates what is on screen by looking up each piece of text;
 * names from your model, formulas and paths are left alone. Long explanations in dialogs stay in English. */
(function () {
  'use strict';
  const KEY = 'smo.lang';
  let lang = 'en';
  try { lang = localStorage.getItem(KEY) || 'en'; } catch (e) { /* storage unavailable */ }

  const NL = {
    // header and loading
    'Open folder': 'Map openen', 'Open file': 'Bestand openen', 'Load': 'Laden', 'Sizes from Power BI Desktop': 'Groottes uit Power BI Desktop', 'Sizes from server': 'Groottes van server',
    'Load a Power BI project': 'Laad een Power BI-project', 'Connect': 'Verbinden', 'Close': 'Sluiten', 'Cancel': 'Annuleren', 'Add': 'Toevoegen', 'Choose folder': 'Map kiezen', 'Choose file': 'Bestand kiezen',
    'Load selected': 'Selectie laden', 'Load model': 'Model laden', 'Rescan': 'Opnieuw zoeken', 'Remove': 'Verwijderen', 'Read reports': 'Rapporten lezen', 'Read report views': 'Rapportweergaven lezen',
    '+ Add report': '+ Rapport toevoegen', 'Reports:': 'Rapporten:', 'Model': 'Model',
    // tabs and actions
    'Objects': 'Objecten', 'Model diagram': 'Modeldiagram', 'Bus matrix': 'Busmatrix', 'Business process': 'Bedrijfsproces', 'Business processes': 'Bedrijfsprocessen', 'Dimensions': 'Dimensies', 'Checks': 'Controles', 'Pages': "Pagina's", 'Performance': 'Prestaties', 'History': 'Geschiedenis', 'Compare': 'Vergelijken', 'Values': 'Waarden',
    'Export…': 'Exporteren…', 'Documentation (.html)': 'Documentatie (.html)', 'Select all unused': 'Selecteer alle ongebruikte', 'Folder…': 'Map…', 'Edit': 'Wijzigen', 'Save': 'Opslaan', 'Restore': 'Terugzetten',
    'Delete…': 'Verwijderen…', 'Tabular Editor script': 'Tabular Editor-script', 'Clear selection': 'Selectie wissen', 'Fit': 'Passend',
    // tiles
    'Measures': 'Measures', 'Columns': 'Kolommen', 'Model only': 'Alleen model', 'Calculated columns': 'Berekende kolommen', 'Tables': 'Tabellen', 'Report': 'Rapport', 'Model size': 'Modelgrootte',
    'Report measures': 'Rapportmeasures', 'Broken formulas': 'Kapotte formules', 'Report (model not loaded)': 'Rapport (model niet geladen)',
    'columns in a relationship, RLS or hierarchy': 'kolommen in relatie, RLS of hiërarchie', 'defined in a report, not in the model': 'gemaakt in een rapport, niet in het model',
    'refer to something that does not exist': 'verwijzen naar iets dat niet bestaat',
    // filters
    'Measures and columns': 'Measures en kolommen', 'Measures in the model': 'Measures in het model', 'Measures only in a report': 'Measures alleen in een rapport',
    'Calculated columns and tables': 'Berekende kolommen en tabellen', 'Everything': 'Alles', 'Any status': 'Elke status', 'Unused': 'Niet gebruikt', 'Used indirectly': 'Indirect gebruikt', 'In report': 'In rapport',
    'Broken references': 'Kapotte verwijzingen', 'All tables': 'Alle tabellen', 'All reports': 'Alle rapporten', 'In no report': 'In geen rapport', 'Whole model': 'Hele model',
    // grid
    'Name': 'Naam', 'Table': 'Tabel', 'Type': 'Soort', 'Status': 'Status', 'Rows': 'Regels', 'Visuals': 'Visuals', 'Depends on': 'Hangt af van', 'Used by': 'Gebruikt door',
    'hidden': 'verborgen', 'distinct': 'uniek', 'report only': 'alleen rapport', 'broken': 'kapot',
    'measure': 'measure', 'column': 'kolom', 'calculated column': 'berekende kolom', 'table': 'tabel', 'calculated table': 'berekende tabel', 'report measure': 'rapportmeasure', 'calculation group': 'calculation group',
    // detail
    'Lineage': 'Herkomst', 'Depends directly on': 'Hangt direct af van', 'Used directly by': 'Wordt direct gebruikt door', 'Usage in reports': 'Gebruik in rapporten', 'Usage in the model': 'Gebruik in het model',
    'Problems': 'Problemen', 'Size': 'Grootte', 'Source': 'Bron', 'Security': 'Beveiliging', 'Query': 'Query', 'Page': 'Pagina', 'Visual': 'Visual', 'Role': 'Rol', 'Selected': 'Geselecteerd',
    'Report page': 'Rapportpagina', 'Visual': 'Visual', 'visual': 'visual', 'report page': 'rapportpagina', 'Measures and columns': 'Measures en kolommen', 'Memory': 'Geheugen', 'Share of model': 'Aandeel model', 'Distinct values': 'Unieke waarden', 'Rows in table': 'Regels in tabel', 'Dictionary': 'Woordenboek',
    'Data': 'Data', 'Hierarchy': 'Hiërarchie', 'In unused columns': 'In ongebruikte kolommen', 'Largest columns': 'Grootste kolommen', 'Description': 'Beschrijving', 'Formula (DAX)': 'Formule (DAX)',
    'Click a measure or column to see where it is used and what it depends on.': 'Klik op een measure of kolom om te zien waar die gebruikt wordt en waar die van afhangt.',
    'Not used in any loaded report or anywhere in the model.': 'Wordt in geen enkel geladen rapport en nergens in het model gebruikt.',
    'Something from this table is used in a report.': 'Uit deze tabel wordt iets gebruikt in een rapport.',
    'No dependencies and nothing that uses it.': 'Geen afhankelijkheden en geen afnemers.',
    // diagram
    'Centre on': 'Centreer op', 'Tables without relationships': 'Tabellen zonder relaties', 'fact': 'feit', 'dimension': 'dimensie', 'bridge': 'brug', 'not related': 'geen relatie',
    'dashed = inactive': 'stippellijn = inactief', '1 / * = cardinality': '1 / * = kardinaliteit', '×n = several relationships': '×n = meerdere relaties', '⇄ = filters both ways': '⇄ = filtert beide kanten op',
    'Click a table to select it, double-click to centre the star on it.': 'Klik op een tabel om hem te selecteren, dubbelklik om de ster erop te centreren.',
    // checks
    'Error': 'Fout', 'All rules': 'Alle regels', 'Kimball dimensional modelling': 'Kimball dimensioneel modelleren', 'General best practice': 'Algemene richtlijnen', 'Check data (referential integrity)': 'Data controleren (referentiële integriteit)', 'Check data': 'Data controleren', 'Design…': 'Ontwerp…', 'Design': 'Ontwerp', 'Check referential integrity': 'Referentiële integriteit controleren', 'Fact tables related to each other': 'Feittabellen onderling gekoppeld', 'Referential integrity: keys without a dimension row': 'Referentiële integriteit: sleutels zonder dimensierij', 'Referential integrity: dimension key is not unique': 'Referentiële integriteit: dimensiesleutel niet uniek', 'Citizen service number (BSN) in the model': 'BSN in het model', 'Referential integrity: blank keys in fact tables': 'Referentiële integriteit: lege sleutels in feittabellen', 'Dimensions without the row -1 Unknown': 'Dimensies zonder de rij -1 Onbekend', 'Snowflaked dimensions': 'Gesneeuwvlokte dimensies', 'Relationships on a text key': 'Relaties op een tekstsleutel', 'Fact key columns that allow blanks': 'Sleutelkolommen in feiten die leeg mogen zijn', 'Calculated columns and tables': 'Berekende kolommen en tabellen', 'Fact tables without a date': 'Feittabellen zonder datum', 'Ratios stored as a fact': 'Ratio’s opgeslagen als feit', 'Names that do not follow the conventions': 'Namen die de conventies niet volgen', 'Fact tables without a declared grain': 'Feittabellen zonder vastgelegde grain', 'Text columns in fact tables': 'Tekstkolommen in feittabellen', 'True/false flags in dimensions': 'Waar/onwaar-vlaggen in dimensies', 'Codes without a description': 'Codes zonder omschrijving', 'Incomplete history columns (SCD type 2)': 'Onvolledige historiekolommen (SCD type 2)', 'Role relationships no measure uses': 'Rolrelaties die geen measure gebruikt', 'Personal data': 'Persoonsgegevens', 'Referential integrity not checked against the data': 'Referentiële integriteit niet tegen de data gecontroleerd', 'Referential integrity could not be checked': 'Referentiële integriteit kon niet worden gecontroleerd', 'Warning': 'Waarschuwing', 'Note': 'Opmerking', 'Hide these columns': 'Verberg deze kolommen', 'Set a number format': 'Zet een getalopmaak', 'Point duplicates to one measure': 'Laat dubbele naar één verwijzen',
    'Suggest descriptions': 'Beschrijvingen voorstellen', 'Nothing found. The model passes every check.': 'Niets gevonden. Het model doorstaat elke controle.',
    'Broken references in reports': 'Kapotte verwijzingen in rapporten', 'Many-to-many relationships': 'Veel-op-veel-relaties', 'Relationships that filter both ways': 'Relaties die beide kanten op filteren',
    'Key columns that are not hidden': 'Sleutelkolommen die niet verborgen zijn', 'Calculated columns that could be measures': 'Berekende kolommen die een measure kunnen zijn',
    'Measures with the same formula': 'Measures met dezelfde formule', 'Measures without a format': 'Measures zonder opmaak', 'Measures without a description': 'Measures zonder beschrijving',
    'Measures defined in a report': 'Measures die in een rapport zijn gemaakt', 'Column references without a table name': 'Kolomverwijzingen zonder tabelnaam', 'Measure references with a table name': 'Measureverwijzingen met tabelnaam',
    'Inactive relationships': 'Inactieve relaties', 'Auto date/time is on': 'Automatische datum/tijd staat aan', 'Columns with a floating-point data type': 'Kolommen met een drijvende-kommatype',
    'Dimensions joined on different keys': 'Dimensies gekoppeld op verschillende sleutels', 'No table is marked as date table': 'Geen tabel is gemarkeerd als datumtabel',
    'Columns with one value or no values': 'Kolommen met één waarde of zonder waarden', 'Names with stray spaces': 'Namen met losse spaties', 'Names that do not follow the convention': 'Namen die de afspraak niet volgen',
    // performance and pages
    'Total ms': 'Totaal ms', 'DAX query': 'DAX-query', 'of which source': 'waarvan bron', 'Render': 'Tekenen',
    // language
    'Nederlands': 'English',
  };
  const RULES = [
    [/^(\d[\d.,]*) unused$/, '$1 niet gebruikt'], [/^(\d[\d.,]*) objects$/, '$1 objecten'], [/^(\d[\d.,]*) pages$/, "$1 pagina's"], [/^(\d[\d.,]*) visuals$/, '$1 visuals'],
    [/^(\d+) selected$/, '$1 geselecteerd'], [/^(\d+) more depend on a broken one$/, '$1 hangen af van een kapotte'], [/^([\d.,]+ MB) in unused columns$/, '$1 in ongebruikte kolommen'],
    [/^(.*) (▲|▼)$/, null], [/^Repositories( \(\d+\))? ▾$/, "Repo's$1 ▾"], [/^Server ▾$/, 'Server ▾'],
    [/^Used directly in a report: (\d+) times?, on (\d+) pages?\.$/, 'Staat direct in een rapport: $1 keer, op $2 pagina(’s).'],
    [/^(\d+) errors? · (\d+) warnings? · (\d+) notes?(.*)$/, '$1 fouten · $2 waarschuwingen · $3 opmerkingen$4'],
    [/^(\d+) fact tables? · (\d+) dimensions?(.*)$/, '$1 feitentabellen · $2 dimensies$3'],
    [/^(\d+) pages? · (\d+) visuals and filters with fields$/, "$1 pagina's · $2 visuals en filters met velden"],
    [/^(\d+) visuals timed · slowest ([\d.,]+) ms · together ([\d.,]+) ms\. Click a visual to see its fields and query\.$/, '$1 visuals gemeten · traagste $2 ms · samen $3 ms. Klik op een visual voor de velden en de query.'],
    [/^in (.+)$/, 'in $1'],
    [/^Meets (d+) of (d+) Kimball guidelines(.*)$/, 'Voldoet aan $1 van $2 Kimball-richtlijnen$3'], [/^Check (d+) relationships$/, 'Controleer $1 relaties'],
  ];
  const SKIP = '.nm, .link, pre, code, svg, textarea, input, #fTable, #fReport, #dCenter, #selModel, #valInst, #xmlaDb, #liveModel, .repo, .chip[data-root], .reps, #pgList summary, #pfGrid td, .uses td, script, style';

  function tr(text) {
    const t = text.trim();
    if (!t) return null;
    let out = Object.prototype.hasOwnProperty.call(NL, t) ? NL[t] : null;
    if (out == null) {
      for (const [re, to] of RULES) {
        const m = re.exec(t);
        if (!m) continue;
        if (to === null) { const inner = tr(m[1]); out = inner == null ? null : inner + ' ' + m[2]; }
        else out = t.replace(re, to);
        break;
      }
    }
    return out == null || out === t ? null : text.replace(t, out);
  }
  let busy = false;
  function apply(root) {
    if (lang !== 'nl' || !root) return;
    busy = true;
    try {
      const el = root.nodeType === 1 ? root : root.parentElement;
      if (!el || (el.closest && el.closest(SKIP))) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      for (let n = root.nodeType === 3 ? root : walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
      for (const n of nodes) {
        if (!n.parentElement || n.parentElement.closest(SKIP)) continue;
        const v = tr(n.nodeValue);
        if (v != null) n.nodeValue = v;
      }
      if (root.nodeType === 1) for (const e of [root, ...root.querySelectorAll('[placeholder]')]) {
        if (e.getAttribute && e.getAttribute('placeholder')) { const v = PH[e.getAttribute('placeholder')]; if (v) e.setAttribute('placeholder', v); }
      }
    } finally { busy = false; }
  }
  const PH = {
    'Search by name, table or DAX': 'Zoek op naam, tabel of DAX', 'Search a page, visual or field': 'Zoek een pagina, visual of veld',
    'Or paste a path: C:\\…\\MyReport': 'Of plak een pad: C:\\…\\MijnRapport',
  };

  // the switch itself
  const btn = document.createElement('button');
  btn.id = 'btnLang'; btn.type = 'button';
  btn.textContent = lang === 'nl' ? 'English' : 'Nederlands';
  btn.title = 'Switch language / Wissel van taal';
  btn.onclick = () => { try { localStorage.setItem(KEY, lang === 'nl' ? 'en' : 'nl'); } catch (e) { /* storage unavailable */ } location.reload(); };
  const host = document.querySelector('.top .load');
  if (host) host.appendChild(btn);

  if (lang === 'nl') {
    document.documentElement.lang = 'nl';
    apply(document.body);
    new MutationObserver(list => {
      if (busy) return;
      for (const m of list) {
        if (m.type === 'characterData') apply(m.target);
        for (const n of m.addedNodes) apply(n);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }
})();
