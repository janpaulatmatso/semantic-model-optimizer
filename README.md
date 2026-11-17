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
