# Runs the Python port (fabric/smo.py) for the tests, so its results can be compared with the JavaScript.
#   python fabric_cli.py tables <files.json> <out folder> <now> <model> <source> <version>
#       files.json: [{path, text}] → the CSV files of one run (run 1) in the out folder
#   python fabric_cli.py scan <responses.json> <out folder> <workspaces>
#       responses.json: {"METHOD url": {status, headers, body}} instead of the Power BI API → a scan, as in Fabric
#   python fabric_cli.py sort <strings.json>   → the strings in the order of loc_key, as JSON
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fabric"))
import smo  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")
mode = sys.argv[1]
if mode == "tables":
    files = json.load(open(sys.argv[2], encoding="utf-8"))
    out, now, model, source, version = sys.argv[3:8]
    proj = smo.loadProject(files)
    analysis, checks = smo.analyzeProject(proj)
    t = smo.runTables(analysis, checks, 1, datetime.datetime.strptime(now, "%Y-%m-%d %H:%M:%S"), model, source, version, len(proj["reports"]), analysis["stats"]["visuals"])
    os.makedirs(out, exist_ok=True)
    for name in smo.TABLES:
        with open(os.path.join(out, name + ".csv"), "w", encoding="utf-8", errors="replace", newline="") as f:
            f.write(smo.toCsv(t[name]))
    print(json.dumps({"models": [m["name"] for m in proj["models"]], "reports": [r["name"] for r in proj["reports"]], "warnings": proj["warnings"], "counts": checks["counts"]}))
elif mode == "scan":
    responses = json.load(open(sys.argv[2], encoding="utf-8"))
    calls = []

    def fake(method, url, token):
        calls.append(method + " " + url)
        assert token == "test-token"
        r = responses.get(method + " " + url)
        if r is None:
            raise Exception("unexpected call " + method + " " + url)
        return r["status"], r.get("headers") or {}, r["body"] if isinstance(r["body"], str) else json.dumps(r["body"])

    smo.http = fake
    smo.sleep = lambda s: None
    lines = []
    result = smo.scan(sys.argv[4], sys.argv[3], "test-token", now=datetime.datetime(2026, 1, 2, 3, 4, 5), log=lines.append)
    print(json.dumps({"result": result, "log": lines, "calls": calls}))
elif mode == "sort":
    print(json.dumps(sorted(json.load(open(sys.argv[2], encoding="utf-8")), key=smo.loc_key)))
