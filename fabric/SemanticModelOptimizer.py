# Semantic Model Optimizer in Fabric: paste this whole file into one cell of a new notebook.
# Before running: add a Lakehouse to the notebook (Lakehouse in the explorer > Add), set WORKSPACES below, then run the cell.
# The same code as fabric/SemanticModelOptimizer.ipynb. More: https://github.com/janpaulatmatso/semantic-model-optimizer#semantic-model-optimizer-in-fabric

# Which workspaces: a name, an id, several separated by commas, or "*" for every workspace you can open
WORKSPACES = "*"

# Folder under Files in the default Lakehouse
FOLDER = "SemanticModelOptimizer"

# Version of the tool: "latest", or a release such as "v1.1.14"
TOOL_VERSION = "latest"

# Node.js, which runs the tool (downloaded from nodejs.org and checked against its published checksum)
NODE_VERSION = "22.12.0"

import hashlib, json, os, pathlib, shutil, subprocess, tarfile, urllib.request

WORK = pathlib.Path("/tmp/semantic-model-optimizer")
WORK.mkdir(parents=True, exist_ok=True)

def download(url, target):
    req = urllib.request.Request(url, headers={"User-Agent": "semantic-model-optimizer-notebook"})
    with urllib.request.urlopen(req, timeout=120) as r, open(target, "wb") as f:
        shutil.copyfileobj(r, f)
    return target

def extract(archive, target):
    with tarfile.open(archive) as t:
        try:
            t.extractall(target, filter="data")
        except TypeError:  # Python before 3.12
            t.extractall(target)

# Node.js
node_name = f"node-v{NODE_VERSION}-linux-x64"
NODE = WORK / node_name / "bin" / "node"
if not NODE.exists():
    base = f"https://nodejs.org/dist/v{NODE_VERSION}/"
    archive = download(base + node_name + ".tar.xz", WORK / (node_name + ".tar.xz"))
    sums = download(base + "SHASUMS256.txt", WORK / "SHASUMS256.txt").read_text()
    want = next(l.split()[0] for l in sums.splitlines() if l.endswith(" " + node_name + ".tar.xz"))
    got = hashlib.sha256(archive.read_bytes()).hexdigest()
    if got != want:
        raise Exception(f"The Node.js download does not match its checksum ({got} instead of {want}).")
    extract(archive, WORK)

# the tool: the source of a release on GitHub
tag = TOOL_VERSION
if tag == "latest":
    req = urllib.request.Request("https://api.github.com/repos/janpaulatmatso/semantic-model-optimizer/releases/latest", headers={"User-Agent": "semantic-model-optimizer-notebook"})
    tag = json.load(urllib.request.urlopen(req, timeout=60))["tag_name"]
TOOL = WORK / ("tool-" + tag)
if not (TOOL / "cli.js").exists():
    archive = download(f"https://github.com/janpaulatmatso/semantic-model-optimizer/archive/refs/tags/{tag}.tar.gz", WORK / "tool.tar.gz")
    unpacked = WORK / "unpacked"
    shutil.rmtree(unpacked, ignore_errors=True)
    extract(archive, unpacked)
    shutil.rmtree(TOOL, ignore_errors=True)
    shutil.move(str(next(unpacked.iterdir())), TOOL)

print(subprocess.run([str(NODE), "--version"], capture_output=True, text=True).stdout.strip(), "· Semantic Model Optimizer", tag)

ctx = notebookutils.runtime.context
lakehouse_id = ctx.get("defaultLakehouseId")
if not lakehouse_id:
    raise Exception("This notebook has no default Lakehouse. Add one (Lakehouse in the explorer › Add) and run again.")
workspace_id = ctx.get("defaultLakehouseWorkspaceId") or ctx.get("currentWorkspaceId")

OUT = f"/lakehouse/default/Files/{FOLDER}"
# where the Power BI report reads the runs: the same folder, through OneLake
SOURCE = f"https://onelake.dfs.fabric.microsoft.com/{workspace_id}/{lakehouse_id}/Files/{FOLDER}/data"

token = notebookutils.credentials.getToken("pbi")  # you, as you are signed in to Fabric
env = dict(os.environ, SMO_POWERBI_TOKEN=token, SMO_FABRIC_TOKEN=token, SMO_VERSION=tag.lstrip("v"))
run = subprocess.run([str(NODE), str(TOOL / "cli.js"), "--scan", WORKSPACES, "--export", OUT, "--report-source", SOURCE],
                     env=env, capture_output=True, text=True)
print(run.stdout)
if run.stderr.strip():
    print(run.stderr)
if run.returncode != 0:
    raise Exception("Semantic Model Optimizer could not export any model (see above).")

import pandas as pd

data = pathlib.Path(OUT) / "data"
runs = sorted(p for p in data.glob("run-*") if (p / "runs.csv").exists())
latest = {}
for p in runs:  # the newest run of every model
    r = pd.read_csv(p / "runs.csv")
    latest[r.loc[0, "Model"]] = p
rows = []
for model, p in sorted(latest.items()):
    o = pd.read_csv(p / "objects.csv")
    f = pd.read_csv(p / "findings.csv").merge(pd.read_csv(p / "rules.csv")[["Key_Rule", "Severity"]], on="Key_Rule", how="left")
    is_type = lambda t: o["Object type"] == t
    rows.append({
        "Model": model,
        "Measures": int(is_type("Measure").sum()),
        "Unused measures": int((is_type("Measure") & (o["Status"] == "Unused")).sum()),
        "Columns": int(is_type("Column").sum()),
        "Unused columns": int((is_type("Column") & (o["Status"] == "Unused")).sum()),
        "Broken formulas": int((o["Broken"] == "Yes").sum()),
        "Errors": int((f["Severity"] == "Error").sum()),
        "Warnings": int((f["Severity"] == "Warning").sum()),
    })
display(pd.DataFrame(rows))

print("SemanticModelOptimizer-cli.exe cli --export C:\\SMO-Fabric --report-only --report-source " + SOURCE)
