#!/usr/bin/env node
/* Builds the Fabric notebook from the Python port (fabric/smo.py):
 *   fabric/SemanticModelOptimizer.ipynb   to import in Fabric
 *   fabric/SemanticModelOptimizer.py      the same code as one cell, to paste into a new notebook
 *   fabric/SemanticModelOptimizer-Tool.ipynb and -Run.ipynb   the same, split: the tool (replaced on an update,
 *                                         never edited) and your settings (scheduled; loads the tool with %run)
 * The notebook holds the whole tool: it downloads nothing and only calls the Power BI and Fabric REST APIs (and, when
 * asked to, Azure Analysis Services).
 * The list of rules in smo.py is written from core.js, so the texts are the same in both.
 *   node build-fabric.js            writes the files (version from SMO_VERSION, else "dev")
 *   node build-fabric.js --check    fails when the files in the repository are not what this script would write */
'use strict';
const fs = require('fs');
const path = require('path');
const SMO = require('./core.js');
const P = require('./powerbi.js');

const dir = path.join(__dirname, 'fabric');
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');

/** smo.py with the rules of core.js between its markers */
function library() {
  const src = read('smo.py');
  const rules = SMO.RULES.map(r => '    ' + JSON.stringify({ id: r.id, group: r.group || '', severity: r.severity, title: r.title, help: r.help }) + ',').join('\n');
  if (!/# RULES-BEGIN[^\n]*\n[\s\S]*?# RULES-END/.test(src)) throw new Error('No RULES block found in fabric/smo.py');
  if (!/# LAKEHOUSE-BEGIN[^\n]*\n[\s\S]*?# LAKEHOUSE-END/.test(src)) throw new Error('No LAKEHOUSE block found in fabric/smo.py');
  // the tables in the Lakehouse and the Direct Lake report, from powerbi.js; the notebook fills in the SQL endpoint
  const tables = P.lakehouseTables().map(t => '    ' + JSON.stringify(t) + ',').join('\n');
  const report = Object.fromEntries(P.directLakeFiles('{{SQL_SERVER}}', '{{SQL_DATABASE}}').map(f => [f.path, f.text]));
  return src.replace(/(# RULES-BEGIN[^\n]*\n)[\s\S]*?(# RULES-END)/, (m, a, b) => a + 'RULES = [\n' + rules + '\n]\n' + b)
    .replace(/(# LAKEHOUSE-BEGIN[^\n]*\n)[\s\S]*?(# LAKEHOUSE-END)/, (m, a, b) => a + 'LAKEHOUSE_TABLES = [\n' + tables.replace(/\bnull\b/g, 'None').replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False') + '\n]\n' +
      'DIRECT_LAKE_FILES = ' + JSON.stringify(report, null, 1) + '\n' + 'WARM_QUERIES = ' + JSON.stringify(P.warmQueries(), null, 1) + '\n' + b);
}

const PARAMS = `
# Which workspaces: a name, an id, several separated by commas, or "*" for every workspace you can open
WORKSPACES = "*"

# Folder under Files in the default Lakehouse
FOLDER = "SemanticModelOptimizer"

# Also write the results as tables (smo_...) in the Lakehouse, and create the report "Semantic Model Optimizer
# (Direct Lake)" on them in this workspace: no refresh to schedule and no sign-in to set up. False: only the files.
DIRECT_LAKE = True

# Azure Analysis Services (optional). Reports that are connected live to a model on Azure Analysis Services are
# checked with that model when you fill these in. A notebook cannot sign in to Analysis Services as you, so it needs
# an app registration (service principal) that is administrator of the server, with its client secret in a Key Vault
# that you can read.
AAS_TENANT = ""        # tenant id (Directory ID)
AAS_CLIENT_ID = ""     # application (client) id of the app registration
AAS_KEY_VAULT = ""     # address of the Key Vault, such as https://<name>.vault.azure.net/
AAS_SECRET_NAME = ""   # name of the secret in the Key Vault that holds the client secret
`;
const RUN = `
ctx = notebookutils.runtime.context
lakehouse_id = ctx.get("defaultLakehouseId")
if not lakehouse_id:
    raise Exception("This notebook has no default Lakehouse. Add one (Lakehouse in the explorer > Add) and run again.")
workspace_id = ctx.get("defaultLakehouseWorkspaceId") or ctx.get("currentWorkspaceId")

OUT = "/lakehouse/default/Files/" + FOLDER
# where the Power BI report reads the runs: the same folder, through OneLake
SOURCE = "https://onelake.dfs.fabric.microsoft.com/" + workspace_id + "/" + lakehouse_id + "/Files/" + FOLDER + "/data"

token = notebookutils.credentials.getToken("pbi")  # you, as you are signed in to Fabric
aas = None
if AAS_CLIENT_ID:  # the service principal for Azure Analysis Services; its secret stays in the Key Vault
    aas = aasToken(AAS_TENANT, AAS_CLIENT_ID, notebookutils.credentials.getSecret(AAS_KEY_VAULT, AAS_SECRET_NAME))
result = scan(WORKSPACES, OUT, token, aas_token=aas)
if not result["models"]:
    raise Exception("No model could be exported (see above).")

# the results as tables in the Lakehouse, and the Direct Lake report on them
if DIRECT_LAKE:
    writeLakehouseTables(spark, OUT)
    publishDirectLake(workspace_id, lakehouse_id, token)
`;
const SHOW = `
import pandas as pd
display(pd.DataFrame(result["models"]))
`;
const REPORT = `
print("SemanticModelOptimizer-cli.exe cli --export C:/SMO-Fabric --report-only --report-source " + SOURCE)
`;
const INTRO = `
# Semantic Model Optimizer in Fabric

Reads every semantic model in the workspaces you choose, each with the reports that use it, and checks them: unused measures and columns, broken formulas, lineage, best practices and the Kimball rules. Every run adds the results to the **default Lakehouse** of this notebook, under *Files/SemanticModelOptimizer*. The Power BI report *Semantic Model Optimizer* reads them from there, so it shows the trend and all models side by side.

**Before the first run:** add a Lakehouse to this notebook (*Lakehouse* in the explorer on the left › *Add*). Then run all cells, and schedule the notebook (*Run* › *Schedule*) to build up history.

The whole tool is in this notebook, in Python: it downloads nothing and installs nothing. It only calls the Power BI and Fabric REST APIs, as you: it reads what you can open and changes nothing in the workspaces. With the optional settings for Azure Analysis Services it also reads the models on those servers that your reports are connected to, as a service principal. More: https://github.com/janpaulatmatso/semantic-model-optimizer#semantic-model-optimizer-in-fabric
`;
const REPORT_MD = `
## The Power BI report

With \`DIRECT_LAKE = True\` the report *Semantic Model Optimizer (Direct Lake)* is in this workspace: open it, nothing to set up. It reads the \`smo_\` tables in the Lakehouse and shows each run as soon as the notebook is done.

Without it, or to have the report on your computer: the runs are also files in the Lakehouse. To see them in Power BI, do this once:

1. On your computer, with Semantic Model Optimizer (the setup or the portable exe from the releases), run the command the cell below prints. It writes the report, set up to read this Lakehouse.
2. Open *Semantic Model Optimizer.pbip* in Power BI Desktop, sign in with your organisational account when it asks for OneLake, and choose **Refresh**.
3. **Publish** it to a workspace. In the semantic model's settings, set the credentials of the data source (OAuth2) and schedule a refresh after the notebook's schedule.
`;

const TOOL = 'SemanticModelOptimizer-Tool';
const TOOL_MD = `
# Semantic Model Optimizer: the tool

The analysis itself, for the notebook **SemanticModelOptimizer-Run** (or a copy of it per set of workspaces), which loads it with \`%run ${TOOL}\`. Keep this notebook's name **${TOOL}** and keep it in the same workspace as those notebooks.

**Do not change this notebook.** To update, replace it with the newest \`${TOOL}.ipynb\` from the releases: your settings are in the other notebook and stay as they are.

The whole tool is in Python: it downloads nothing and installs nothing, and it only calls the Power BI and Fabric REST APIs (and Azure Analysis Services, when the settings ask for it). More: https://github.com/janpaulatmatso/semantic-model-optimizer#semantic-model-optimizer-in-fabric
`;
const RUN_MD = `
# Semantic Model Optimizer: run

Checks the semantic models in the workspaces you set below, each with the reports that use it, and adds the results to the default Lakehouse of this notebook. The tool itself is in the notebook **${TOOL}**, in the same workspace; this one only holds your settings, so an update of the tool does not touch them.

**Before the first run:** import both notebooks into the same workspace, add a Lakehouse to this one (*Lakehouse* in the explorer › *Add*) and set the settings below. Then run all cells, and schedule this notebook (*Run* › *Schedule*). For another set of workspaces with its own schedule, make a copy of this notebook.
`;

function outputs(version) {
  const lib = library().replace(/^VERSION = "dev".*$/m, 'VERSION = ' + JSON.stringify(version));
  const t = s => s.replace(/^\n/, '').replace(/\s+$/, '');
  const bar = '# ' + '='.repeat(100);
  const one = [
    '# Semantic Model Optimizer in Fabric: paste this whole file into one cell of a new notebook.',
    '# Before running: add a Lakehouse to the notebook (Lakehouse in the explorer > Add), set WORKSPACES below, then run the cell.',
    '# The whole tool is in this file, in Python: it downloads nothing and only calls the Power BI and Fabric REST APIs.',
    '# The same code as fabric/SemanticModelOptimizer.ipynb. More: https://github.com/janpaulatmatso/semantic-model-optimizer#semantic-model-optimizer-in-fabric',
    '', t(PARAMS), '', bar, '# The tool. Nothing to set below this line.', bar, '',
    t(lib), '', '', bar, '# Run', bar, '', t(RUN), '', t(SHOW), '',
    '# the command that writes the Power BI report for this Lakehouse; run it once on your computer', t(REPORT), '',
  ].join('\n');
  const lines = s => { const a = t(s).split('\n'); return a.map((l, i) => (i < a.length - 1 ? l + '\n' : l)); };
  const md = s => ({ cell_type: 'markdown', metadata: {}, source: lines(s) });
  const code = (s, tags) => ({ cell_type: 'code', execution_count: null, metadata: tags ? { tags } : {}, outputs: [], source: lines(s) });
  const notebook = cells => JSON.stringify({
    cells,
    metadata: { kernel_info: { name: 'synapse_pyspark' }, kernelspec: { display_name: 'Synapse PySpark', language: 'Python', name: 'synapse_pyspark' }, language_info: { name: 'python' } },
    nbformat: 4, nbformat_minor: 4,
  }, null, 1) + '\n';
  const nb = notebook([md(INTRO), code(PARAMS, ['parameters']), md('## The tool\n\nThe analysis itself. Nothing to set here.'), code(lib),
    md('## Check the models'), code(RUN), md('## What this run found'), code(SHOW), md(REPORT_MD), code(REPORT)]);
  // the same, split in two: the tool, which you replace on an update, and your settings, which you schedule
  const tool = notebook([md(TOOL_MD), code(lib)]);
  const run = notebook([md(RUN_MD), code(PARAMS, ['parameters']), md('## The tool\n\nLoads the notebook **' + TOOL + '** from this workspace.'), code('%run ' + TOOL),
    md('## Check the models'), code(RUN), md('## What this run found'), code(SHOW), md(REPORT_MD), code(REPORT)]);
  return { 'smo.py': library(), 'SemanticModelOptimizer.py': one, 'SemanticModelOptimizer.ipynb': nb, [TOOL + '.ipynb']: tool, 'SemanticModelOptimizer-Run.ipynb': run };
}

if (require.main === module) {
  const version = String(process.env.SMO_VERSION || 'dev').replace(/^v/, '');
  const out = outputs(version);
  if (process.argv.includes('--check')) {
    const stale = Object.keys(out).filter(f => read(f) !== out[f]);
    if (stale.length) { console.error('Not up to date: ' + stale.join(', ') + '. Run: node build-fabric.js'); process.exit(1); }
    console.log('The Fabric notebook is up to date.');
  } else {
    for (const f of Object.keys(out)) fs.writeFileSync(path.join(dir, f), out[f]);
    console.log('Written: ' + Object.keys(out).map(f => 'fabric/' + f).join(', ') + ' (version ' + version + ')');
  }
}
module.exports = { outputs, library };
