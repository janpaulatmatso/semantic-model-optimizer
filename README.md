# Semantic Model Optimizer

Laat zien welke measures en kolommen van een Power BI-model in rapporten gebruikt worden, welke niet, en de lineage van elke measure en berekende kolom. Alles draait lokaal; er gaat niets naar buiten.

## Starten

- **Zonder installatie:** dubbelklik `index.html` en kies *Map openen* (of sleep een map op de pagina).
- **Met pad plakken:** `node serve.js` en open http://127.0.0.1:5273. Dan kun je een pad naar de map plakken.
- **Opdrachtregel:** `node cli.js <map> [--csv uit.csv] [--json uit.json] [--lineage "Naam measure"]`

## Wat je kunt laden

| Invoer | Model | Rapport |
|---|---|---|
| Power BI-project (`.pbip`-map, TMDL of `model.bim`) | ja | ja (PBIR en oud formaat) |
| `.pbit` | ja | ja |
| `.pbix` | nee (binair) | ja |

Meerdere rapporten op één model: open de map waar ze samen in staan. Per rapport kun je aan- en uitzetten of het meetelt.

## Aantal regels en MB per tabel

Groottes staan niet in een Power BI-project; die komen uit het geladen model. Laad eerst het model en daarna een van deze twee:

- **Een `.vpax`** uit DAX Studio (Advanced › Export Metrics). Openen of op de pagina slepen. Werkt ook zonder server.
- **Rechtstreeks uit Power BI Desktop:** start `node serve.js`, open het rapport in Power BI Desktop en klik *Groottes uit Power BI Desktop*. Alleen Windows, alleen lezen. Hiervoor is ADOMD.NET nodig; dat wordt meegeleverd met DAX Studio, Tabular Editor en SSMS.

Je ziet dan per tabel het aantal regels, de MB en het aandeel in het model, per kolom de MB en het aantal unieke waarden, en hoeveel MB er in ongebruikte kolommen zit. DirectQuery-tabellen hebben geen grootte.

## Selecteren en verwijderen

Vink ongebruikte measures en kolommen aan (het vakje in de kop pakt de hele gefilterde lijst, shift-klik een reeks, of gebruik *Selecteer alle ongebruikte*) en kies *Verwijderen…*.

- Alleen objecten met status **Niet gebruikt** zijn aan te vinken. Roept iets buiten je selectie een object nog aan, dan blijft het staan en zie je waardoor.
- **Rechtstreeks verwijderen** werkt bij een Power BI-project in TMDL dat via het padveld is geladen (`node serve.js`). De tool past de `.tmdl`-bestanden aan en zet van elk gewijzigd bestand eerst een kopie in `smo-backup` naast het model.
- Bij kolommen komt er een stap `Table.RemoveColumns` in de Power Query van de tabel, zodat de kolom ook niet meer geladen wordt.
- **Sluit het project eerst in Power BI Desktop.** Desktop leest de bestanden alleen bij openen; sla je daar daarna op, dan komt alles terug.
- In alle andere gevallen (pbit, `model.bim`, geladen via *Map openen*) kun je een **Tabular Editor-script** downloaden dat dezelfde objecten verwijdert.

Tabellen verwijderen kan nog niet.

## Naam, beschrijving en formule wijzigen

Klik op een measure, kolom of tabel en kies *Wijzigen*. Je kunt de naam, de beschrijving en (bij measures en berekende kolommen) de DAX-formule aanpassen.

- Werkt bij een Power BI-project in TMDL dat via het padveld is geladen (`node serve.js`). Van elk gewijzigd bestand komt eerst een kopie in `smo-backup`.
- **Hernoemen** werkt alle verwijzingen bij: in formules, sorteerkolommen, hiërarchieën, relaties, perspectieven en in de visuals en filters van rapporten in PBIR-formaat. Gebruikt een rapport in het oude formaat of een `.pbix` het veld, dan wordt hernoemen geweigerd.
- De tool schrijft alleen als het model na de wijziging nog precies hetzelfde in elkaar zit (zelfde objecten, afhankelijkheden en rapportgebruik).
- De formule wordt niet door Power BI gecontroleerd; een fout in de DAX zie je pas bij het openen. De tool waarschuwt wel voor namen die niet in het model voorkomen.
- Tabellen hernoemen kan nog niet. Gebruik buiten de geladen map (andere rapporten, Excel) breekt bij hernoemen.

## Status

- **In rapport** — staat direct in een visual, filter, opmaakregel, sortering of bladwijzer.
- **Indirect gebruikt** — nodig voor iets dat in een rapport staat (bijv. een kolom onder een gebruikte measure, of een sorteerkolom).
- **Alleen model** — in geen rapport, maar wel in een relatie, RLS-regel of hiërarchie.
- **Niet gebruikt** — nergens nodig. Een measure die alleen door andere ongebruikte measures wordt aangeroepen valt hier ook onder.

## Beperkingen

- Alleen de geladen rapporten tellen. Gebruik in andere rapporten, Excel (Analyseren in Excel), dashboards of externe DAX-query's ziet de tool niet.
- Kolommen die alleen in Power Query (M) gebruikt worden tellen niet als gebruikt.
- Het model in een `.pbix` is niet leesbaar; sla op als `.pbip` of `.pbit`.

## Licentie

MIT — zie [LICENSE](LICENSE).
