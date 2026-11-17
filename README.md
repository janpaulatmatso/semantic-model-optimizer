# Semantic Model Optimizer

Shows which measures and columns of a Power BI model are used in reports and which are not, plus the lineage of every measure and calculated column. Everything runs locally; nothing leaves your computer.

## Getting started

- **No install:** double-click `index.html` and choose *Open folder* (or drag a folder onto the page).
- **Paste a path:** run `node serve.js` and open http://127.0.0.1:5273. You can then paste the path to the folder.
- **Command line:** `node cli.js <folder> [--csv out.csv] [--json out.json] [--lineage "Measure name"]`

## What you can load

| Input | Model | Report |
|---|---|---|
| Power BI project (`.pbip` folder, TMDL or `model.bim`) | yes | yes (PBIR and legacy format) |
| `.pbit` | yes | yes |
| `.pbix` | no (binary) | yes |

Several reports on one model: open the folder that contains them all. You can switch each report on or off to decide whether it counts.

## Local repositories

Run `node serve.js`, choose **Repositories** and paste the path of a local Git repository (or any folder). The tool searches it for Power BI projects (`.pbip`) and report folders, reads from each report which semantic model it points to, and shows them grouped per model with the current branch.

- Tick one or more reports and choose *Load selected*. Reports must share a model; ticking a report on another model starts a new selection.
- Connected repositories and your selection are remembered in the browser. *Rescan* searches a repository again, *Remove* disconnects it (nothing is deleted).
- Reports with a live connection (model not in the repository) are listed but cannot be loaded.
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
