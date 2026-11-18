# Semantic Model Optimizer

Shows which measures and columns of a Power BI model are used in reports and which are not, plus the lineage of every measure and calculated column. Everything runs locally; nothing leaves your computer.

## Getting started

- **Web version, nothing to download:** https://janpaulatmatso.github.io/semantic-model-optimizer/ — choose *Open folder* or *Open file*. The files are read in your browser; the page is not allowed to make any connection (see [For IT administrators](#for-it-administrators)).
  - **As an app:** *Install as app* (or the install icon in the address bar of Edge or Chrome) gives it its own window and a Start menu entry, works offline, and offers it in *Open with* for `.pbix`, `.pbit`, `.vpax` and `.bim` files.
  - **Changes:** in Edge and Chrome, a Power BI project opened with *Open folder* (or dropped as a folder) can be changed as in the app: delete, rename, edit formulas and descriptions, fixes, display folders and *History*. The same code does it, with the same checks, and first copies every file it changes into `smo-backup`. The browser asks for permission before the first change. Firefox and Safari can only read.
  - **Needs the desktop app:** connecting to Analysis Services, a workspace or Power BI Desktop, sizes from Power BI Desktop, comparing with Git, and suggested descriptions.
- **No install, offline:** double-click `index.html` and choose *Open folder* (or drag a folder onto the page).
- **Paste a path:** run `node serve.js` and open http://127.0.0.1:5273. You can then paste the path to the folder.
- **Command line:** `node cli.js <folder> [--check] [--rules] [--csv out.csv] [--json out.json] [--export <folder>] [--lineage "Measure name"]`; `--export` adds the results to a [Power BI report](#a-power-bi-report-of-the-results)

### Other ways to start

- **Without cloning:** `npx github:janpaulatmatso/semantic-model-optimizer <folder> --check` runs the command line straight from GitHub. `npm start` in a clone starts the server and opens the browser.
- **Download:** every release on GitHub has three files: `SemanticModelOptimizer-Setup.exe` (installs it as a program with a Start menu shortcut and an uninstaller), `SemanticModelOptimizer.exe` (the same program without installing) and `SemanticModelOptimizer-cli.exe` (for the command line and pipelines). A new release is published automatically after every push to `main` that changes code and passes the tests (the patch number goes up; run the workflow by hand to raise the minor or major number). `SemanticModelOptimizer-cli.exe version` shows which one you have.
- **As a desktop app:** the program opens in its own window, without address bar or tabs: an app window of your default browser when that is Edge, Chrome, Brave or Vivaldi, otherwise of Edge (which every Windows computer has). No console window appears. The tool stops by itself about two and a half minutes after you close the window; `SemanticModelOptimizer-cli.exe stop` stops it straight away. Set `SMO_BROWSER=1` to open it in a normal browser tab instead.
- **Portable executable:** `node build-exe.js` builds `dist/SemanticModelOptimizer.exe` (about 90 MB, the console build), which contains Node and the tool, so it runs on a computer without Node. `node build-installer.js` then makes the windowed copy (`dist/app/`), `dist/SemanticModelOptimizer-cli.exe` and, with Inno Setup installed, the Setup. The console build is the command line (`SemanticModelOptimizer-cli.exe cli <folder> --check`) and can add the Power BI Desktop button (`SemanticModelOptimizer-cli.exe install-tool`, as administrator). The executables have no code-signing certificate, so Windows may ask for confirmation the first time; every release has a build provenance and checksums instead (see [For IT administrators](#for-it-administrators)). Suggested descriptions need the Anthropic SDK and are not available from the executable unless `node_modules` sits next to it.
- **From Power BI Desktop:** `node install-external-tool.js` (in a terminal started as administrator) adds a *Semantic Model Optimizer* button to the **External Tools** ribbon. The button opens the tool on the file you have open: a Power BI project (`.pbip`) is loaded as a whole, so reports count and everything can be edited; for a `.pbix` only the model is read. `--remove` takes the button away again.
- **Language:** the *Nederlands* / *English* button at the top right switches the interface. Labels, buttons, statuses and headings are translated; long explanations in dialogs stay in English.

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

### Report views from the activity log

*Read report views* reads the Power BI activity log of the last 30 days and shows per report how often it was opened. A report nobody opens is a candidate to retire, together with the measures only it uses. Needs the Fabric administrator role. Use `*` as workspace to read the reports of every workspace you can open.

### Reports from a workspace

In the same panel you can read every report in a Power BI workspace that uses the model, so reports you do not have as files count too. Fill in the workspace and, optionally, the model. It uses the Azure CLI sign-in (`az login`), lists the reports with the Power BI REST API and fetches each definition with the Fabric REST API. Read-only; you need permission to edit a report to read its definition.

Once a model is loaded from a server, *Sizes from server* reads rows and MB from that same server.

## Checks

The **Checks** tab lists what the tool finds against a set of best-practice rules, grouped per rule with an explanation. Click an object to open it.

| Severity | Rule |
|---|---|
| Error | Broken formulas · Broken references in reports |
| Warning | Many-to-many relationships · Relationships that filter both ways · Key columns that are not hidden · Calculated columns that could be measures · Measures with the same formula · Measures without a format · Auto date/time is on |
| Warning (more) | Dimensions joined on different keys · Columns with one value or no values (needs sizes) · Names that do not follow the convention (when `naming` is set in `smo.config.json`) |
| Note | No table is marked as date table · Names with stray spaces · Measures without a description · Measures defined in a report · Column references without a table name · Measure references with a table name · Inactive relationships · Floating-point columns |

The findings are also a sheet in the Excel export.

### Fixing findings

Three rules have a button that repairs every finding at once (project loaded by path, TMDL):

- **Key columns that are not hidden** → hides them.
- **Measures without a format** → sets a format: a percentage when the name says so, otherwise a whole or decimal number.
- **Measures with the same formula** → keeps the most used one and rewrites the others to refer to it.

For **Measures without a description** there is *Suggest descriptions*: the tool sends the names and DAX of those measures to the Claude API and shows a suggestion per measure, which you can edit and tick before anything is saved. This is optional: it needs `npm install @anthropic-ai/sdk` in the tool folder and API credentials in the environment (`ANTHROPIC_API_KEY`), and it costs tokens on that account. No data from your tables is sent.

### Choosing the rules per project

Put a `smo.config.json` in the project folder to switch a rule off or change how heavy it counts:

```json
{
  "rules": { "inactive-relationship": "off", "measure-no-description": "warning", "measure-no-format": "error" },
  "naming": { "measure": "^[A-Z#]", "column": "^[A-Z]" }
}
```

The rule ids are the ones `node cli.js <path> --rules` works with: `broken-formula`, `broken-reference`, `many-to-many`, `bidirectional`, `key-visible`, `calc-column-as-measure`, `duplicate-measure`, `measure-no-format`, `measure-no-description`, `report-only-measure`, `unqualified-column`, `qualified-measure`, `inactive-relationship`, `auto-date-time`, `double-data-type`.

## Values: what the measures return

**Values** calculates the grand total of every measure on the model that is open in Power BI Desktop. Take a snapshot before you change formulas or merge duplicate measures, then compare afterwards: you see which results changed and which measures Power BI cannot calculate at all. That last list is a real check of the DAX by the engine, where the *Checks* tab only looks at names. Read-only; on a DirectQuery model it queries the source.

When the model was loaded from an open Power BI Desktop file (and not from files), *Edit* on a measure changes the description and formula **in the open model**, without closing Power BI Desktop. Save the file there to keep it. Only measures, and not their names: that is what Power BI Desktop supports from external tools.

## History and compare

- **History** lists the backups the tool made before each change. *Restore* puts those files back; the current files are backed up first, so a restore can be undone as well.
- **Compare** shows what is added, removed, changed or newly broken in the files on disk compared with a Git branch, tag or commit of the same repository.

## Lineage to the source, security and display folders

- **Source:** the tool reads from the Power Query of each table where the data comes from (connector, server, database, schema and table, or the native query) and follows column renames. A column shows for example `dbo.FactSales.customer_id`. It recognises the common patterns; an unusual query gives the connector only.
- **Security:** for each role the documentation lists what it filters, which tables that reaches through the relationships and how many measures it touches. A table or measure shows the roles that affect it.
- **Display folders:** *Folder…* puts every measure in the current list in one display folder. Narrow the list first with the search box and the filters.

## Pages and performance

- **Pages** turns the usage around: per report page you see every visual and filter with the fields it uses.
- **Performance** reads an export of the Performance Analyzer (in Power BI Desktop: *Optimize › Performance analyzer*, record, refresh the visuals, *Export*). Put the file in the project folder or open it with *Open file*. Per visual you see the measures and columns it uses, the total time, the DAX query, how much of that is waiting for the source (DirectQuery) and the drawing. Click a visual for the full list, the columns its measures read underneath, and the query.

### Kimball dimensional modelling

The *Checks* tab can show only the **Kimball** rules (choose *Kimball dimensional modelling* at the top) and says how many of the guidelines the model meets. The rules follow *The Data Warehouse Toolkit* (Kimball and Ross) and the team conventions:

| Severity | Rule |
|---|---|
| Error | Fact tables related to each other · Keys without a dimension row · Dimension key not unique · BSN in the model |
| Warning | Blank keys in fact tables · Dimension without the row -1 Unknown · Snowflaked dimensions · Relationships on a text key · Fact key columns that allow blanks · Calculated columns and tables · Fact tables without a date · Ratios stored as a fact · Names that do not follow `Feit_` / `Dim_` / `DK_` |
| Note | Fact tables without a grain sentence ("One row per …" in the description) · Text columns in fact tables · True/false flags in dimensions · Codes without a description · Incomplete SCD type 2 columns · Role relationships no measure uses · Personal data |

Which tables are facts and which are dimensions follows from the relationships, as in the bus matrix.

**Data checks.** *Check data* runs read-only queries on the model open in Power BI Desktop (or loaded with *Server*). On a DirectQuery model the queries go to the source.

- **Referential integrity**, per relationship: every key in the fact table exists in the dimension, no fact key is blank, the dimension key is unique, and the rows -1 Unknown and -2 Not applicable exist.
- **Grain**, per fact table: no two rows share all their dimension keys and degenerate dimensions (taken from the design when there is one).
- **SCD type 2**, per dimension with validity columns: one current row per natural key and no overlapping periods.
- **Flags**: text columns in dimensions that only hold codes like 0/1 or Y/N.

On the command line: `--ri localhost:<port>` (or a server connection with `--database`), and `--kimball` to limit `--check` and `--rules` to these rules.

**Semi-additive facts.** A stock or balance in a periodic snapshot cannot be summed over time. A measure that sums such a column without taking the last value in the period (`LASTNONBLANK`, `LASTDATE`, a filter on `MAX` of the date, …) is reported. Which columns are semi-additive comes from the design (`additiviteit: semi-additief`) or, without one, from a fact table described or named as a snapshot.

**Compare with the design.** The tool reads the YAML specification and the bus matrix that the Kimball modelling skill produces (`modellen/<domain>/<model>.yaml`, `modellen/busmatrix.md`). They are picked up when they sit in a loaded folder, or load them with *Design…* in the Checks tab. The model is then compared with them: missing tables and columns, data types, relationships and which role is active, the grain sentence in the description of the fact table, columns the design does not mention, and the bus matrix against the relationships. Only designs that name a table of the loaded model are used.

The naming convention can be changed or switched off in `smo.config.json`:

```json
{ "kimball": { "naming": true, "fact": "Feit_", "dim": "Dim_", "key": "DK_" } }
```

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

More options for a pipeline:

| Option | What it does |
|---|---|
| `--format github` / `--format azure` | Prints each finding as an annotation, so it shows up in the pull request (GitHub) or the build summary (Azure DevOps). |
| `--summary <file>` | Writes a Markdown summary. Use `$GITHUB_STEP_SUMMARY`, or post the file as a pull-request comment. |
| `--compare-ref origin/main` | Lists what the branch adds, removes, changes and newly breaks compared with that Git version. `--compare <folder>` does the same against another folder. |
| `--server <connection> --database <name>` | Loads the model over XMLA instead of from files (Windows agent). For a service principal put the whole connection string in the environment variable `SMO_XMLA_CONN`, for example `Data Source=powerbi://…;User ID=app:<client id>@<tenant id>;Password=<secret>`, so the secret is not on the command line. |
| `--workspace <name> --dataset <name>` | Also reads every report in that Power BI workspace that uses the model. Tokens come from `SMO_POWERBI_TOKEN` and `SMO_FABRIC_TOKEN`, or from the Azure CLI when it is signed in. |

## Report measures and broken formulas

**Measures that only exist in a report.** A thin report can define its own measures. They are not part of the semantic model, so no other report can use them. The tool lists them as *report measure* with a *report only* tag; filter on *Measures only in a report* (or *Measures in the model*) or click the *Report measures* tile.

**Broken formulas.** For every measure, calculated column and calculated table the tool checks what the DAX refers to. A formula is broken when it refers to a table that does not exist, to a column or measure that is not in the named table, or to a bare `[Name]` that is neither a measure nor a column anywhere. A formula that depends on a broken one is marked as broken too. Filter on *Broken formulas* or click the tile; the detail panel lists each problem.

Names a formula creates itself (`ADDCOLUMNS ( …, "Name", … )`, `SELECTCOLUMNS`, `SUMMARIZE`) and the `[Value]` columns of a table constructor are not reported. The check is done on names only: it does not run the DAX, so it cannot find wrong argument types or syntax errors.

**Model on Analysis Services.** If the model is not in your project (live connection), the DAX formulas are not in the report: they live on the server. Load the thin report (a `.pbip` folder or a `.pbix`) and the tool reads from its connection where the model is, for example `asazure://westeurope.asazure.windows.net/myserver` with the model name, and loads that model straight away over XMLA (sign-in window, admin rights on the model needed). No second connection to set up: the report is checked against the model at once: formulas, lineage, and which measures and columns the report uses. While it loads, the bar at the top says where the model lives. Prefer to decide yourself? Click *Don't load automatically* in that bar; you then get a **Load that model** button (and *Always load automatically* to switch back). The order does not matter: you can also choose *Server* first and add the reports afterwards. The *External Tools* button does the same for a thin report open in Power BI Desktop, if the file is saved. Without a server connection you still see the measures the reports define and every field they use, but nothing can be checked against the model; you can also load the model next to the reports as `model.bim`, a Power BI project or a `.pbit`. A report connected to a semantic model in the Power BI service needs that model from its workspace (*Server* with `powerbi://…`). In the *Repositories* panel, reports with a live connection can be ticked and paired with any model found in the connected repositories.

## Export

The **Export…** dropdown above the list exports what you see, with the current filters and sort order:

- **Excel (.xlsx):** a workbook with the sheets *Objects* (including description and DAX), *Report usage* (one row per place a field is used), *Relationships* and, if there are any, *Broken references*. Header row frozen, filter buttons on.
- **CSV:** the object list, comma-separated, UTF-8.
- **Documentation (.html):** a readable description of the whole model. It starts with the **enterprise data warehouse bus matrix**: one row per business process (fact table), one column per dimension, conformed dimensions first. Marks: `X` related, `X×3` three relationships to the same dimension (role-playing), `○` only through an inactive relationship, `·` reached through another dimension. Then the **grain per business process** (what one row is, and its dimension keys), the **security** roles, the relationships and every table with its source, with its description, measures with their DAX and columns. Print it to PDF or open it in Word. The bus matrix is also a sheet in the Excel export, and the **Bus matrix** tab shows it in the tool: click a business process or a dimension to open that table.
- **PDF:** a printable A4 landscape list with a summary of the model, the active filters and the status in colour.

All three are generated in the browser; nothing is uploaded.

### A Power BI report of the results

In the app: **Export… › Power BI report…**, choose a folder (default *Documents\Semantic Model Optimizer*), then **Open in Power BI Desktop**. This works for every model you can load, also one open in Power BI Desktop or on a server, and uses the sizes the app has. Not in the web version, which cannot write files outside the browser. From the command line:

```
node cli.js <folder> --export C:\SMO
SemanticModelOptimizer-cli.exe cli <folder> --export C:\SMO
SemanticModelOptimizer-cli.exe cli --server localhost:51234 --export C:\SMO      (the model open in Power BI Desktop)
```

Every export adds a run to `C:\SMO\data\run-000001`, `run-000002`, … The first export also writes **`Semantic Model Optimizer.pbip`**, a ready-made report. Open it in Power BI Desktop and choose **Refresh**. Later exports leave the report alone (your changes stay), so just refresh it. Export several models to the same folder to see them side by side, and export on a schedule (for example in a pipeline) to see the trend.

The report has five pages:

- **Overview:** measures, columns, unused ones, broken formulas, errors and warnings; objects by status; the trend over time; findings per rule.
- **Objects:** every table, column and measure with its status, uses in reports, dependents and size.
- **Findings:** every finding of the checks, filtered by severity and group.
- **Report usage:** which fields every visual of every report uses.
- **Lineage:** what depends on what.

The model behind it is a star schema, so you can build your own pages:

| Table | One row per |
|---|---|
| `Fact_Object` | table, column, measure and function, per run (uses in reports, dependents, rows, size) |
| `Fact_Usage` | field in a visual or filter |
| `Fact_Dependency` | object an object refers to directly |
| `Fact_Finding` | finding of a rule |
| `Dim_Run`, `Dim_Date`, `Dim_Object`, `Dim_Dependency`, `Dim_Visual`, `Dim_Rule` | run, day, object, object in the role "depends on", visual, rule |

The counts (*Measures*, *Unused columns*, *Errors*, …) take the latest run of each model within the filters, so they never add up runs. Sizes are filled when the run had them: give a `.vpax` (DAX Studio › Advanced › Export Metrics) as an extra path. Moved the folder? Change the parameter *ExportFolder* (Transform data › Edit parameters). The report itself passes the checks of this tool, including the Kimball rules.

### Every model in your workspaces

```
SemanticModelOptimizer-cli.exe cli --scan "Sales, Finance" --export C:\SMO
SemanticModelOptimizer-cli.exe cli --scan * --export C:\SMO
```

`--scan` reads every semantic model in the workspaces you name (or `*`: every workspace you can open), each with the reports in those workspaces that use it, and adds one run per model. Read-only: it fetches the definitions with the Fabric REST API and changes nothing. Sign in with `az login`, or set `SMO_POWERBI_TOKEN` (and `SMO_FABRIC_TOKEN`) for a service principal in a pipeline. Models Power BI cannot export are listed and skipped, for example Direct Lake models outside a Fabric capacity and the default models of a Lakehouse.

## Semantic Model Optimizer in Fabric

The notebook [`fabric/SemanticModelOptimizer.ipynb`](fabric/SemanticModelOptimizer.ipynb) (also attached to every release) does the same in Microsoft Fabric, on a schedule, without anything on your computer:

1. In a Fabric workspace: **New item › Import notebook**, choose the file.
2. Add a Lakehouse to the notebook (*Lakehouse* in the explorer › *Add*).
3. Set `WORKSPACES` in the first cell (`"*"` for every workspace you can open), run all cells, and schedule the notebook (*Run › Schedule*).

Each run downloads Node.js (checked against the checksum nodejs.org publishes) and the tool from its GitHub release, runs `--scan` with your own Fabric sign-in, and writes the runs to *Files/SemanticModelOptimizer* in the Lakehouse. The last cell prints a table per model, and the command for the report.

**The report**, once: run the printed command on your computer (`SemanticModelOptimizer-cli.exe cli --export C:\SMO-Fabric --report-only --report-source https://onelake.dfs.fabric.microsoft.com/…`). The report then reads the Lakehouse through OneLake instead of a folder. Open it in Power BI Desktop, sign in with your organisational account, **Refresh**, and **Publish** it. In the service, set the data source credentials (OAuth2) of the semantic model and schedule its refresh after the notebook. No gateway is needed.

The notebook needs internet access to nodejs.org and github.com. Where a workspace blocks outbound traffic, run the scan in a pipeline instead and write the runs to OneLake.

## Lineage

The lineage of a measure or column runs from the source columns on the left, through every measure that builds on it, to the **visuals** that show it and the **report pages** they are on. A visual shows its type and, when a Performance Analyzer export is loaded, its time; hover it to see every field on it. Click a visual or page to open it under *Pages*.

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

A whole table can be deleted as well, as long as nothing uses it: switch the list to *Tables* and tick it. Its columns and measures go with it.

## Editing name, description and formula

Click a measure, column or table and choose *Edit*. You can change the name, the description and (for measures and calculated columns) the DAX formula.

- Works for a Power BI project in TMDL loaded through the path field (`node serve.js`). A copy of every changed file goes into `smo-backup` first.
- **Renaming** updates all references: in formulas, sort-by columns, hierarchies, relationships, perspectives, and in the visuals and filters of reports in PBIR format. If a report in the legacy format or a `.pbix` uses the field, the rename is refused.
- The tool only writes if the model still has exactly the same structure after the change (same objects, dependencies and report usage).
- The formula is not checked by Power BI; you only see a DAX error when you open the project. The tool does warn about names that do not exist in the model.
- Tables can be renamed too; every formula, relationship and report field that names the table is updated. Usage outside the loaded folder (other reports, Excel) breaks on a rename.

## Status

- **In report** — directly in a visual, filter, formatting rule, sort or bookmark.
- **Used indirectly** — needed by something that is in a report (for example a column under a used measure, or a sort-by column).
- **Model only** — in no report, but in a relationship, RLS rule or hierarchy.
- **Unused** — not needed anywhere. A measure that is only called by other unused measures falls under this too.

## Limitations

- Only the loaded reports count. The tool cannot see usage in other reports, Excel (Analyze in Excel), dashboards or external DAX queries.
- A column that another query reads in Power Query counts as *Model only*. The tool recognises this by name, so an unusual M pattern can be missed.
- The model inside a `.pbix` cannot be read; save as `.pbip` or `.pbit`.

## For IT administrators

Three ways to offer the tool, from least to most that runs on the computer:

| | What runs | What it can do |
|---|---|---|
| **Web version** (GitHub Pages, or your own web server) | Static HTML, CSS and JavaScript in the browser | Read Power BI projects, .pbit, .pbix (report part), .vpax and model.bim; every analysis, check, diagram and export; in Edge and Chrome also changes to a project folder the user opened |
| **From source** (`node serve.js`) | Node 18 or later, the code in this repository, no dependencies | Everything |
| **Desktop app** (Setup or portable exe) | Node and the same code, packed into one executable | Everything |
| **Microsoft Store** (MSIX, once published; see [Microsoft Store package](#microsoft-store-package)) | The same executable, signed by Microsoft; deployable with Intune as a Store app | Everything |

**Web version.** The page sets a Content Security Policy with `connect-src 'none'`: the browser itself refuses every request the page could make, so loaded files cannot leave the computer. It loads no fonts, scripts or anything else from elsewhere. Its service worker (`sw.js`, there for offline use) only keeps the tool's own files from the same site. It can only write to a folder the user picked, after the browser has asked for permission; it cannot see anything else on the computer. To host it yourself, run `node build-web.js <folder>` and put that folder on any web server or SharePoint site that serves static files; it needs no server code. Settings (language, chosen rules) are kept in the browser's local storage.

**Desktop app.**
- **Where it comes from:** GitHub Actions builds every release from the public source in this repository; nobody builds it by hand. Each release has a signed build provenance and a `SHA256SUMS.txt`. Check a file with `gh attestation verify SemanticModelOptimizer-Setup.exe --repo janpaulatmatso/semantic-model-optimizer`, or compare `Get-FileHash` with the checksum. The files have no code-signing certificate.
- **Network:** it listens on `127.0.0.1` only (port 5273, or `PORT`), never on the network. It connects outward only when a user asks for it:
  - Analysis Services, a Power BI workspace (XMLA) or Power BI Desktop: through ADOMD.NET with the user's own Microsoft sign-in.
  - Workspace scan and activity log: `api.powerbi.com` and `api.fabric.microsoft.com`, with the token of the Azure CLI (`az login`).
  - Suggested descriptions (optional): `api.anthropic.com`, only with an Anthropic API key set and the Anthropic SDK installed; never from the executable on its own.
  - There is no telemetry, no update check and no CDN.
- **Disk:** it reads the folders and files a user opens. It writes only when a user changes, deletes or fixes something in a Power BI project: first a copy of each file into `smo-backup` next to the model, then the change. A change to a model on a server or in Power BI Desktop goes to that model, with the user's own rights.
- **Needs:** for server connections, ADOMD.NET, which comes with DAX Studio, Tabular Editor or SQL Server Management Studio.
- **Install silently:** `SemanticModelOptimizer-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /ALLUSERS` (or `/CURRENTUSER`, which needs no administrator rights). It installs into `Program Files\Semantic Model Optimizer` (for one user: `%LOCALAPPDATA%\Programs\Semantic Model Optimizer`). Remove it with `unins000.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART` in that folder. For Intune: package the Setup as a Win32 app with these commands; detection rule: `SemanticModelOptimizer.exe` exists in the install folder.

## Microsoft Store package

`node build-msix.js` (after `build-exe.js` and `build-installer.js`, with the Windows SDK) packs the program and the command line into `dist/SemanticModelOptimizer.msix`. The Store signs it, so it needs no certificate of its own, and Windows installs it without a SmartScreen warning. Once installed, `SemanticModelOptimizer.exe` and `SemanticModelOptimizer-cli.exe` work from any terminal. The release workflow builds the package every time, installs a copy signed with a test certificate, runs the command line, the server and a PowerShell helper from it, and removes it again.

To publish it:

1. Register as a developer in [Partner Center](https://partner.microsoft.com/dashboard) (as a company or as an individual).
2. *Apps and games* › *New product* › *MSIX or PWA app*, and reserve the name *Semantic Model Optimizer*.
3. Under *Product management* › *Product identity*, copy the three values into the repository's Actions variables (*Settings* › *Secrets and variables* › *Actions* › *Variables*):
   - `MSIX_IDENTITY_NAME` ← *Package/Identity/Name*
   - `MSIX_PUBLISHER` ← *Package/Identity/Publisher*
   - `MSIX_PUBLISHER_DISPLAY_NAME` ← *Package/Properties/PublisherDisplayName*
4. From the next release on, the run in *Actions* has an artifact `store-package-v…` with the package for the Store. Upload it in the submission under *Packages*.
5. The package asks for two restricted capabilities; Partner Center asks why:
   - `runFullTrust`: "A desktop program (Node.js) that runs a local web server on 127.0.0.1, opens it in the user's browser and runs PowerShell to read Power BI models over XMLA."
   - `unvirtualizedResources`: "The program opens the user's default browser in app mode. With file system virtualization the browser would write its profile inside the package instead of the user's real profile."
6. As privacy policy, link to [For IT administrators](#for-it-administrators): the tool collects nothing and sends nothing.

The Power BI Desktop button is not added by the Store installation: run `SemanticModelOptimizer-cli.exe install-tool` once in a terminal started as administrator.

## Tests

`npm test` (or `node --test test/smo.test.js`) builds a small project in a temporary folder and checks the analysis and everything that writes: delete, rename, edit, fix, table operations, restore, compare, export and the command line. The same tests run on GitHub for every push, on Windows and Linux.

## License

MIT — see [LICENSE](LICENSE).
