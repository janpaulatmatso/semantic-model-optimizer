# Semantic Model Optimizer

Shows which measures and columns of a Power BI model are used in reports and which are not, plus the lineage of every measure and calculated column. Everything runs locally; nothing leaves your computer.

## Getting started

- **No install:** double-click `index.html` and choose *Open folder* (or drag a folder onto the page).
- **Paste a path:** run `node serve.js` and open http://127.0.0.1:5273. You can then paste the path to the folder.
- **Command line:** `node cli.js <folder> [--check] [--rules] [--csv out.csv] [--json out.json] [--lineage "Measure name"]`

## What you can load

| Input | Model | Report |
|---|---|---|
| Power BI project (`.pbip` folder, TMDL or `model.bim`) | yes | yes (PBIR and legacy format) |
| `.pbit` | yes | yes |
| `.pbix` | no (binary) | yes |

Several reports on one model: open the folder that contains them all. You can switch each report on or off to decide whether it counts.

## Model from a server (XMLA)

Run `node serve.js` and choose **Server** to load the model definition straight from where it lives, without having it as files:

- **Azure Analysis Services:** `asazure://westeurope.asazure.windows.net/myserver`
- **Power BI workspace** (Premium, PPU or Fabric, with the XMLA endpoint on): `powerbi://api.powerbi.com/v1.0/myorg/My Workspace`
- **SQL Server Analysis Services:** the server name
- **A file open in Power BI Desktop:** listed in the panel, one click

After connecting you pick a model and load it. Load your thin reports before or after (*+ Add report*, *Repositories* or the path field); the tool then checks them against the server model.

- Only the definition is read (tables, columns, measures, relationships, roles). Nothing is changed, and a model loaded this way cannot be edited from the tool.
- A cloud server opens a sign-in window. Reading the definition needs admin or write permission on the model; a viewer cannot query the schema.
- Windows only, and it needs ADOMD.NET, which ships with DAX Studio, Tabular Editor and SSMS.

## Checks

The **Checks** tab lists what the tool finds against a set of best-practice rules, grouped per rule with an explanation. Click an object to open it.

| Severity | Rule |
|---|---|
| Error | Broken formulas · Broken references in reports |
| Warning | Many-to-many relationships · Relationships that filter both ways · Key columns that are not hidden · Calculated columns that could be measures · Measures with the same formula · Measures without a format · Auto date/time is on |
| Note | Measures without a description · Measures defined in a report · Column references without a table name · Measure references with a table name · Inactive relationships · Floating-point columns |

The findings are also a sheet in the Excel export.

## Use in a pipeline

`node cli.js <paths> --check` exits with code 1 when there are broken formulas or broken references, so a build or pull request can be blocked. Add `--strict` to fail on warnings too, and `--rules` to print every finding. Exit code 2 means the tool itself could not run (for example a wrong path).

```yaml
# GitHub Actions
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with: { node-version: 20 }
- run: git clone --depth 1 https://github.com/janpaulatmatso/semantic-model-optimizer smo
- run: node smo/cli.js ./powerbi --check
```

The check works on files, so it needs no Power BI and runs on any agent with Node 18 or newer.

## Report measures and broken formulas

**Measures that only exist in a report.** A thin report can define its own measures. They are not part of the semantic model, so no other report can use them. The tool lists them as *report measure* with a *report only* tag; filter on *Measures only in a report* (or *Measures in the model*) or click the *Report measures* tile.

**Broken formulas.** For every measure, calculated column and calculated table the tool checks what the DAX refers to. A formula is broken when it refers to a table that does not exist, to a column or measure that is not in the named table, or to a bare `[Name]` that is neither a measure nor a column anywhere. A formula that depends on a broken one is marked as broken too. Filter on *Broken formulas* or click the tile; the detail panel lists each problem.

Names a formula creates itself (`ADDCOLUMNS ( …, "Name", … )`, `SELECTCOLUMNS`, `SUMMARIZE`) and the `[Value]` columns of a table constructor are not reported. The check is done on names only: it does not run the DAX, so it cannot find wrong argument types or syntax errors.

**Model on Analysis Services.** If the model is not in your project (live connection), you can still load the thin reports on their own. You then see the measures the reports define and every field they use from the model; nothing can be checked against the model. To check them, load the model next to the reports as `model.bim`, a Power BI project or a `.pbit`. In the *Repositories* panel, reports with a live connection can be ticked and paired with any model found in the connected repositories.

## Export

The **Export…** dropdown above the list exports what you see, with the current filters and sort order:

- **Excel (.xlsx):** a workbook with the sheets *Objects* (including description and DAX), *Report usage* (one row per place a field is used), *Relationships* and, if there are any, *Broken references*. Header row frozen, filter buttons on.
- **CSV:** the object list, comma-separated, UTF-8.
- **PDF:** a printable A4 landscape list with a summary of the model, the active filters and the status in colour.

All three are generated in the browser; nothing is uploaded.

## Model diagram

Switch from *Objects* to **Model diagram** for an overview of the semantic model as a star schema: tables as cards, relationships as lines.

- **Whole model:** fact tables in the middle, dimensions above and below, tables without relationships at the bottom.
- **Star around one table:** pick a table under *Centre on*, or double-click a card. The table sits in the middle with every related table around it; snowflaked tables sit one ring further out.
- Each card shows the role (fact, dimension, bridge), the number of measures and how many columns are unused, or rows and MB once sizes are loaded. The dot is the usage status.
- Lines show cardinality (`1` / `*`), are dashed when the relationship is inactive, and carry `×n` when two tables have several relationships and `⇄` when filtering goes both ways. Hover a line to see the columns.
- Click a card to select the table; its details appear on the right and its relationships light up.

## Local repositories

Run `node serve.js`, choose **Repositories** and paste the path of a local Git repository (or any folder). The tool searches it for Power BI projects (`.pbip`) and report folders, reads from each report which semantic model it points to, and shows them grouped per model with the current branch.

- Tick one or more reports and choose *Load selected*. Reports must share a model; ticking a report on another model starts a new selection.
- Connected repositories and your selection are remembered in the browser. *Rescan* searches a repository again, *Remove* disconnects it (nothing is deleted).
- Reports with a live connection (model not in the repository) can be loaded on their own, or checked against a model you choose.
- Everything loaded this way can be edited and deleted from, like any project loaded by path.

## Multiple reports

Reports in the same folder as the model are loaded together with it. Add reports from another folder with *+ Add report* (paste a path, or pick a folder or file). The path field also accepts several paths separated by a semicolon.

With two or more reports the list gets a **Report** column: for each measure or column you see which reports use it. Dimmed means indirect only, through a measure or column that is in that report. You can also filter by report, or on *In no report*. At the top you can switch each report on or off to decide whether it counts.

## Row counts and MB per table

Sizes are not part of a Power BI project; they come from the loaded model. Load the model first, then one of these:

- **A `.vpax`** from DAX Studio (Advanced › Export Metrics). Open it or drag it onto the page. Works without the server too.
- **Straight from Power BI Desktop:** run `node serve.js`, open the report in Power BI Desktop and click *Sizes from Power BI Desktop*. Windows only, read-only. This needs ADOMD.NET, which ships with DAX Studio, Tabular Editor and SSMS.

You then see the row count, MB and share of the model for each table, the MB and number of distinct values for each column, and how many MB sit in unused columns. DirectQuery tables have no size.

## Selecting and deleting

Tick unused measures and columns (the box in the header takes the whole filtered list, shift-click selects a range, or use *Select all unused*) and choose *Delete…*.

- Only objects with status **Unused** can be ticked. If something outside your selection still calls an object, it is left in place and you see what calls it.
- **Deleting directly** works for a Power BI project in TMDL loaded through the path field (`node serve.js`). The tool edits the `.tmdl` files and first puts a copy of every changed file in `smo-backup` next to the model.
- For columns, a `Table.RemoveColumns` step is added to the table's Power Query, so the column is no longer loaded either.
- **Close the project in Power BI Desktop first.** Desktop only reads the files when opening; if you save there afterwards, everything comes back.
- In all other cases (pbit, `model.bim`, loaded through *Open folder*) you can download a **Tabular Editor script** that deletes the same objects.

Deleting tables is not supported yet.

## Editing name, description and formula

Click a measure, column or table and choose *Edit*. You can change the name, the description and (for measures and calculated columns) the DAX formula.

- Works for a Power BI project in TMDL loaded through the path field (`node serve.js`). A copy of every changed file goes into `smo-backup` first.
- **Renaming** updates all references: in formulas, sort-by columns, hierarchies, relationships, perspectives, and in the visuals and filters of reports in PBIR format. If a report in the legacy format or a `.pbix` uses the field, the rename is refused.
- The tool only writes if the model still has exactly the same structure after the change (same objects, dependencies and report usage).
- The formula is not checked by Power BI; you only see a DAX error when you open the project. The tool does warn about names that do not exist in the model.
- Renaming tables is not supported yet. Usage outside the loaded folder (other reports, Excel) breaks on rename.

## Status

- **In report** — directly in a visual, filter, formatting rule, sort or bookmark.
- **Used indirectly** — needed by something that is in a report (for example a column under a used measure, or a sort-by column).
- **Model only** — in no report, but in a relationship, RLS rule or hierarchy.
- **Unused** — not needed anywhere. A measure that is only called by other unused measures falls under this too.

## Limitations

- Only the loaded reports count. The tool cannot see usage in other reports, Excel (Analyze in Excel), dashboards or external DAX queries.
- Columns that are only used in Power Query (M) do not count as used.
- The model inside a `.pbix` cannot be read; save as `.pbip` or `.pbit`.

## License

MIT — see [LICENSE](LICENSE).
