# Semantic Model Optimizer for Microsoft Fabric: the analysis in Python.
#
# A port of the parts of the tool a Fabric notebook needs (core.js, powerbi.js and workspace.js): reading TMDL and
# report definitions, usage and lineage, the best-practice and Kimball checks, and the export as CSV files in a star
# schema. It uses only the Python standard library and talks to the Power BI and Fabric REST APIs, nothing else.
#
# The JavaScript is the original. A test runs both on the same models and compares the CSV files byte for byte, so a
# rule that changes there has to change here too. Names follow the JavaScript to keep the two easy to compare.

import base64
import csv
import datetime
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree

VERSION = "dev"  # set by build-fabric.js

# ---------------------------------------------------------------- JavaScript behaviour that matters for equal results

# what \s and trim() mean in JavaScript
WS = "\t\n\x0b\x0c\r \xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
WSC = r"\t\n\x0b\x0c\r \xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"  # inside a character class
S = "[" + WSC + "]"
W = "[A-Za-z0-9_]"  # \w
B = "(?:(?<![A-Za-z0-9_])(?=[A-Za-z0-9_])|(?<=[A-Za-z0-9_])(?![A-Za-z0-9_]))"  # \b
I = re.IGNORECASE


def trim(s):
    return s.strip(WS)


def lc(s):
    return "" if s is None else jstr(s).lower()


def jstr(v):
    """String(v) in JavaScript, for the values that occur in models and reports."""
    if isinstance(v, str):
        return v
    if v is None:
        return "undefined"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, float) and v == int(v):
        return str(int(v))
    return str(v)


def truthy(v):
    """What counts as true in JavaScript: an empty list or object does, an empty string and 0 do not."""
    if v is None or v is False:
        return False
    if isinstance(v, str):
        return v != ""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v != 0
    return True


def get(o, key):
    return o.get(key) if isinstance(o, dict) else None


def jkeys(d):
    """The keys of an object in JavaScript order: whole numbers first, ascending, then the rest as written."""
    ints = [k for k in d if re.fullmatch(r"0|[1-9][0-9]{0,9}", k) and int(k) < 4294967295]
    if not ints:
        return list(d)
    done = set(ints)
    return sorted(ints, key=int) + [k for k in d if k not in done]


def jslice(s, n):
    """s.slice(0, n): JavaScript counts UTF-16 units."""
    if len(s) <= n and all(ord(c) < 0x10000 for c in s):
        return s
    return s.encode("utf-16-le", "surrogatepass")[: 2 * n].decode("utf-16-le", "replace")


_PUNCT = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$"
_EXPAND = {"ß": "ss", "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE", "ĳ": "ij", "Ĳ": "IJ", "ø": "o\u0338", "Ø": "O\u0338", "đ": "d\u0335", "Đ": "D\u0335", "ł": "l\u0335", "Ł": "L\u0335"}


def loc_key(s):
    """A sort key that orders text the way localeCompare does: first letters and digits (punctuation before digits
    before letters), then accents, then lower case before upper case."""
    prim, sec, ter = [], [], []
    for ch0 in jstr(s):
        wide = 2 if ch0 in _EXPAND else 0  # one letter written as two (ß, æ) comes after the two letters
        for ch in unicodedata.normalize("NFD", _EXPAND.get(ch0, ch0)):
            if unicodedata.combining(ch):
                if sec:
                    sec[-1] = sec[-1] + (ord(ch),)
                continue
            p = _PUNCT.find(ch)
            if ch in WS:
                prim.append((0, 0))
            elif p >= 0:
                prim.append((1, p))
            elif ch.isdigit():
                prim.append((3, ord(ch)))
            elif ch.isalpha():
                prim.append((4, ord(ch.lower()[0])))
            else:
                prim.append((2, ord(ch)))
            sec.append(())
            ter.append(wide + (1 if ch.isupper() else 0))
    return (prim, sec, ter)


# ---------------------------------------------------------------- TMDL

def indentOf(raw):
    n = spaces = 0
    for ch in raw:
        if ch == "\t":
            n += 1
        elif ch == " ":
            spaces += 1
            if spaces == 4:
                n += 1
                spaces = 0
        else:
            break
    return n


_NAME = re.compile("[^" + WSC + "=:.]+")


def readName(s):
    """Reads a TMDL name ('with spaces' or without) at the start of s. → (name, rest)"""
    s = s.lstrip(WS)
    if s[:1] == "'":
        i, name = 1, []
        while i < len(s):
            if s[i] == "'":
                if s[i + 1:i + 2] == "'":
                    name.append("'")
                    i += 2
                    continue
                i += 1
                break
            name.append(s[i])
            i += 1
        return "".join(name), s[i:]
    m = _NAME.match(s)
    name = m.group(0) if m else ""
    return name, s[len(name):]


def readQualified(s):
    """'Table name'.'Column name' or Table.Column → (table, column)"""
    a, arest = readName(s)
    rest = re.sub("^" + S + r"*\." + S + "*", "", arest)
    if rest == arest:
        return a, ""
    return a, readName(rest)[0]


def unquoteValue(v):
    v = trim(v) if isinstance(v, str) else ""
    if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
        return v[1:-1].replace('""', '"')
    if len(v) >= 2 and v[0] == "'" and v[-1] == "'":
        return v[1:-1].replace("''", "'")
    return v


_PROP = re.compile("([A-Za-z_]" + W + "*)" + S + "*:" + S + r"?(.*)\Z")
_EXPR = re.compile("([A-Za-z_]" + W + "*)" + S + "*=" + S + r"*(.*)\Z")
_DECL = re.compile("([A-Za-z_]" + W + "*)" + S + r"+(.+)\Z")
_FENCE_END = re.compile("```" + S + r"*\Z")


def dedent(buf):
    least = None
    for l in buf:
        if not trim(l):
            continue
        ws = len(l) - len(l.lstrip("\t "))
        if least is None or ws < least:
            least = ws
    least = least or 0
    return [l[min(least, len(l)):].rstrip(WS) for l in buf]


def parseTmdlTree(text):
    """TMDL text → tree of {kw, name, expr, props, children, description}."""
    lines = re.split(r"\r?\n", text[1:] if text[:1] == "\ufeff" else text)
    root = {"indent": -1, "kw": "root", "children": [], "props": {}}
    stack = [root]
    desc = []
    i = 0
    while i < len(lines):
        raw = lines[i]
        line = trim(raw)
        if not line:
            i += 1
            continue
        indent = indentOf(raw)
        if line.startswith("///"):
            desc.append(trim(line[3:]))
            i += 1
            continue
        while stack[-1]["indent"] >= indent:
            stack.pop()
        parent = stack[-1]
        i += 1

        m = _PROP.match(line)
        if m:  # property: key: value
            parent["props"][m.group(1)] = m.group(2)
            desc = []
            continue
        node, exprStart, minIndent = None, None, indent + 1
        m = _EXPR.match(line)
        if m:
            # expression property without a name: source =, expression =, formatStringDefinition =
            node = {"kw": m.group(1), "name": "", "isProp": True}
            exprStart = m.group(2)
        else:
            m = _DECL.match(line)
            if m:
                kw = m.group(1)
                if kw == "ref":
                    desc = []
                    continue
                name, rest = readName(m.group(2))
                node = {"kw": kw, "name": name}
                rest = trim(rest)
                # relationship/level etc. have no '='; tablePermission/measure/column do
                if rest.startswith("="):
                    exprStart = trim(rest[1:])
                    minIndent = indent + 2
                elif rest.startswith("."):
                    node["name"] = m.group(2)  # qualified name (e.g. perspectiveTable); ignored from here on
            else:
                parent["props"][line] = True  # bare flag: isHidden, relyOnReferentialIntegrity
                desc = []
                continue

        if exprStart is not None:
            expr = exprStart
            if exprStart.startswith("```"):
                buf = []
                first = exprStart[3:]
                if trim(first).endswith("```"):
                    expr = trim(first)[:-3]
                else:
                    if trim(first):
                        buf.append(first)
                    while i < len(lines):
                        l = lines[i]
                        i += 1
                        if trim(l).endswith("```"):
                            t = _FENCE_END.sub("", l)
                            if trim(t):
                                buf.append(t)
                            break
                        buf.append(l)
                    expr = "\n".join(dedent(buf))
            elif exprStart == "":
                buf = []
                while i < len(lines):
                    l = lines[i]
                    if not trim(l):
                        buf.append("")
                        i += 1
                        continue
                    if indentOf(l) < minIndent:
                        break
                    buf.append(l)
                    i += 1
                while buf and not trim(buf[-1]):
                    buf.pop()
                expr = "\n".join(dedent(buf))
            node["expr"] = expr
        node["indent"] = indent
        node["children"] = []
        node["props"] = {}
        node["description"] = "\n".join(desc)
        desc = []
        if node.get("isProp"):
            parent["props"][node["kw"]] = node.get("expr")
        else:
            parent["children"].append(node)
            stack.append(node)
    return root


def emptyModel():
    return {"tables": [], "relationships": [], "roles": [], "functions": [], "expressions": []}


def _text(v):
    return v if isinstance(v, str) else ""


def addTmdlToModel(model, text):
    for n in parseTmdlTree(text)["children"]:
        p = n["props"]
        if n["kw"] == "table":
            model["tables"].append(tableFromTmdl(n))
        elif n["kw"] == "relationship":
            ft, fc = readQualified(_text(p.get("fromColumn")))
            tt, tc = readQualified(_text(p.get("toColumn")))
            model["relationships"].append({
                "name": n["name"], "fromTable": ft, "fromColumn": fc, "toTable": tt, "toColumn": tc,
                "isActive": p.get("isActive") != "false", "rely": truthy(p.get("relyOnReferentialIntegrity")),
                "crossFilter": p.get("crossFilteringBehavior") or "", "fromCardinality": p.get("fromCardinality") or "many", "toCardinality": p.get("toCardinality") or "one",
            })
        elif n["kw"] == "role":
            model["roles"].append({"name": n["name"], "permissions": [{"table": c["name"], "expression": c.get("expr") or ""} for c in n["children"] if c["kw"] == "tablePermission"]})
        elif n["kw"] == "function":
            model["functions"].append({"name": n["name"], "expression": n.get("expr") or "", "description": n["description"]})
        elif n["kw"] == "expression":
            model["expressions"].append({"name": n["name"], "expression": n.get("expr") or ""})


def tableFromTmdl(n):
    t = {
        "name": n["name"], "description": n["description"], "isHidden": truthy(n["props"].get("isHidden")), "dataCategory": n["props"].get("dataCategory") or "",
        "kind": "table", "expression": "", "sourceType": "", "mode": "", "source": None,
        "columns": [], "measures": [], "hierarchies": [], "calcItems": [],
    }
    for c in n["children"]:
        p = c["props"]
        if c["kw"] == "measure":
            t["measures"].append({
                "name": c["name"], "expression": c.get("expr") or "", "description": c["description"],
                "isHidden": truthy(p.get("isHidden")), "displayFolder": unquoteValue(p.get("displayFolder")),
                "formatString": p.get("formatString") or "",
                "extraExpressions": [x for x in (p.get("formatStringDefinition"), p.get("detailRowsDefinition")) if truthy(x)],
            })
        elif c["kw"] == "column":
            t["columns"].append({
                "name": c["name"], "expression": c.get("expr") or "", "isCalculated": c.get("expr") is not None and c.get("expr") != "",
                "description": c["description"], "isHidden": truthy(p.get("isHidden")),
                "dataType": p.get("dataType") or "", "displayFolder": unquoteValue(p.get("displayFolder")),
                "sortByColumn": readName(p["sortByColumn"])[0] if truthy(p.get("sortByColumn")) and isinstance(p.get("sortByColumn"), str) else "",
                "sourceColumn": p.get("sourceColumn") or "", "isNullable": p.get("isNullable") != "false",
                "isSystem": p.get("type") == "rowNumber",
            })
        elif c["kw"] == "hierarchy":
            t["hierarchies"].append({"name": c["name"], "levels": [
                {"name": l["name"], "column": readName(l["props"]["column"])[0] if isinstance(l["props"].get("column"), str) and l["props"]["column"] else l["name"]}
                for l in c["children"] if l["kw"] == "level"]})
        elif c["kw"] == "partition":
            kind = trim(c.get("expr") or "")
            t["sourceType"] = t["sourceType"] or kind
            t["mode"] = p.get("mode") or t["mode"]
            if kind == "calculated":
                t["kind"] = "calculated table"
                t["expression"] = p.get("source") or ""
            elif not t["source"]:
                t["source"] = p.get("source") or ""
        elif c["kw"] == "calculationGroup":
            t["kind"] = "calculation group"
            for it in c["children"]:
                if it["kw"] == "calculationItem":
                    t["calcItems"].append({"name": it["name"], "expression": it.get("expr") or "",
                                           "extraExpressions": [x for x in (it["props"].get("formatStringDefinition"),) if truthy(x)]})
    return t


# ---------------------------------------------------------------- DAX references

def _identStart(ch):
    return ch == "_" or ch.isalpha()


def _identPart(ch):
    return ch == "_" or ch == "." or ch.isalpha() or unicodedata.category(ch)[0] == "N"


def daxRefs(expr):
    """References in a DAX expression: {t:'q',table,name} | {t:'b',name} | {t:'t',table} | {t:'f',name}"""
    refs = []
    s = expr if isinstance(expr, str) else ""
    n = len(s)
    i = 0

    def skipWs(j):
        while j < n and s[j] in WS:
            j += 1
        return j

    def readBracket(j):  # s[j] == '['
        name = []
        j += 1
        ns, ne = j, n
        while j < n:
            if s[j] == "]":
                if s[j + 1:j + 2] == "]":
                    name.append("]")
                    j += 2
                    continue
                ne = j
                j += 1
                break
            name.append(s[j])
            j += 1
        return "".join(name), j, ns, ne

    while i < n:
        ch = s[i]
        nx = s[i + 1:i + 2]
        if ch == '"':
            i += 1
            while i < n:
                if s[i] == '"':
                    if s[i + 1:i + 2] == '"':
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
        elif (ch == "/" and nx == "/") or (ch == "-" and nx == "-"):
            while i < n and s[i] != "\n":
                i += 1
        elif ch == "/" and nx == "*":
            e = s.find("*/", i + 2)
            i = n if e < 0 else e + 2
        elif ch == "'":
            name = []
            ts = i
            i += 1
            while i < n:
                if s[i] == "'":
                    if s[i + 1:i + 2] == "'":
                        name.append("'")
                        i += 2
                        continue
                    i += 1
                    break
                name.append(s[i])
                i += 1
            j = skipWs(i)
            if s[j:j + 1] == "[":
                bn, be, ns, ne = readBracket(j)
                refs.append({"t": "q", "table": "".join(name), "name": bn, "ns": ns, "ne": ne, "ts": ts, "te": i})
                i = be
            else:
                refs.append({"t": "t", "table": "".join(name), "ts": ts, "te": i})
        elif ch == "[":
            bn, be, ns, ne = readBracket(i)
            refs.append({"t": "b", "name": bn, "ns": ns, "ne": ne})
            i = be
        elif _identStart(ch):
            j = i + 1
            while j < n and _identPart(s[j]):
                j += 1
            ident = s[i:j]
            k = skipWs(j)
            if s[k:k + 1] == "[":
                bn, be, ns, ne = readBracket(k)
                refs.append({"t": "q", "table": ident, "name": bn, "ns": ns, "ne": ne, "ts": i, "te": j})
                i = be
            elif s[k:k + 1] == "(":
                refs.append({"t": "f", "name": ident})
                i = j
            else:
                refs.append({"t": "t", "table": ident, "ts": i, "te": j})
                i = j
        elif "0" <= ch <= "9":
            while i < n and (("0" <= s[i] <= "9") or s[i] in ".eE"):
                i += 1
        else:
            i += 1
    return refs


# ---------------------------------------------------------------- Reports

def tryJson(text):
    if text is None:
        return None
    if not isinstance(text, str):
        return text
    try:
        return json.loads(text[1:] if text[:1] == "\ufeff" else text)
    except ValueError:
        return None


def joinExpr(e):
    if isinstance(e, list):
        return "\n".join("" if x is None else jstr(x) for x in e)
    return "" if e is None else jstr(e)


def entityOf(expr, aliases):
    sr = get(expr, "SourceRef")
    if not isinstance(sr, dict):
        return None
    if sr.get("Entity") is not None:
        return sr["Entity"]
    src = sr.get("Source")
    if src is not None and aliases.get(jstr(src)) is not None:
        return aliases[jstr(src)]
    return None


def walkRefs(n, aliases, emit):
    """Walks arbitrary report JSON and reports every field reference."""
    if isinstance(n, list):
        for x in n:
            walkRefs(x, aliases, emit)
        return
    if not isinstance(n, dict):
        return
    if isinstance(n.get("From"), list):
        aliases = dict(aliases)
        for f in n["From"]:
            if isinstance(f, dict) and f.get("Name") is not None and f.get("Entity") is not None:
                aliases[jstr(f["Name"])] = f["Entity"]
    for kind in ("Column", "Measure"):
        c = n.get(kind)
        if isinstance(c, dict) and isinstance(c.get("Property"), str) and truthy(c.get("Expression")):
            ent = entityOf(c["Expression"], aliases)
            if ent is not None:
                emit({"kind": "column" if kind == "Column" else "measure", "entity": ent, "property": c["Property"]})
    hl = n.get("HierarchyLevel")
    h = get(get(hl, "Expression"), "Hierarchy")
    if truthy(h):
        pvs = get(get(h, "Expression"), "PropertyVariationSource")
        if truthy(pvs):
            ent = entityOf(get(pvs, "Expression"), aliases)
            if ent is not None:
                emit({"kind": "column", "entity": ent, "property": get(pvs, "Property")})
        else:
            ent = entityOf(get(h, "Expression"), aliases)
            if ent is not None:
                emit({"kind": "hierarchy", "entity": ent, "hierarchy": get(h, "Hierarchy"), "level": get(hl, "Level")})
    for k in jkeys(n):
        v = n[k]
        if isinstance(v, (dict, list)):
            walkRefs(v, aliases, emit)


def literalText(objs, key):
    try:
        v = objs[key][0]["properties"]["text"]["expr"]["Literal"]["Value"]
    except (KeyError, IndexError, TypeError):
        return ""
    return re.sub(r"^'|'\Z", "", v).replace("''", "'") if isinstance(v, str) else ""


def extensionMeasures(ext, into):
    for e in get(ext, "entities") or []:
        for m in get(e, "measures") or []:
            into.append({"table": e.get("name"), "name": m.get("name"), "expression": joinExpr(m.get("expression")), "description": m.get("description") or ""})


_PAGE = re.compile(r"definition/pages/([^/]+)/page\.json\Z", I)
_VISUAL = re.compile(r"definition/pages/([^/]+)/visuals/([^/]+)/visual\.json\Z", I)
_REPORT = re.compile(r"definition/report\.json\Z", I)
_EXT = re.compile(r"definition/reportExtensions\.json\Z", I)
_BOOKMARK = re.compile(r"definition/bookmarks/.+\.bookmark\.json\Z", I)


def _adder(rep, ctx):
    def emit(r):
        u = dict(r)
        u.update(ctx)
        rep["uses"].append(u)
    return emit


def parsePbirReport(name, root, files):
    """PBIR (definition/ folder with separate files)"""
    rep = {"name": name, "root": root, "format": "PBIR", "pages": [], "uses": [], "measures": [], "visualCount": 0}
    rel = lambda p: p[len(root) + 1:]
    pageNames = {}
    pageJson = []
    for f in files:
        m = _PAGE.match(rel(f["path"]))
        if m:
            j = tryJson(f["text"])
            j = j if truthy(j) else {}
            pageNames[m.group(1)] = get(j, "displayName") or m.group(1)
            rep["pages"].append({"id": m.group(1), "name": pageNames[m.group(1)]})
            pageJson.append(j)
    for p, j in zip(rep["pages"], pageJson):
        walkRefs(j, {}, _adder(rep, {"page": p["name"], "visual": "", "visualType": "", "role": "page filter"}))
    for f in files:
        r = rel(f["path"])
        m = _VISUAL.match(r)
        if m:
            j = tryJson(f["text"])
            if not truthy(j):
                continue
            rep["visualCount"] += 1
            v = get(j, "visual")
            v = v if truthy(v) else {}
            ctx = {
                "page": pageNames.get(m.group(1)) or m.group(1), "visual": get(j, "name") or m.group(2),
                "visualType": get(v, "visualType") or ("group" if truthy(get(j, "visualGroup")) else ""),
                "visualTitle": literalText(get(v, "visualContainerObjects") or {}, "title"),
            }
            q = get(v, "query")
            q = q if truthy(q) else {}
            qs = get(q, "queryState")
            if isinstance(qs, dict):
                for role in jkeys(qs):
                    walkRefs(qs[role], {}, _adder(rep, dict(ctx, role=role)))
            if truthy(get(q, "sortDefinition")):
                walkRefs(q["sortDefinition"], {}, _adder(rep, dict(ctx, role="sort")))
            if truthy(get(j, "filterConfig")):
                walkRefs(j["filterConfig"], {}, _adder(rep, dict(ctx, role="filter")))
            if isinstance(j, dict):
                rest = dict(j)
                rest["visual"] = {k: x for k, x in v.items() if k != "query"} if isinstance(v, dict) else None
                rest["filterConfig"] = None
                walkRefs(rest, {}, _adder(rep, dict(ctx, role="formatting")))
            else:
                walkRefs(j, {}, _adder(rep, dict(ctx, role="formatting")))
        elif _REPORT.match(r):
            walkRefs(tryJson(f["text"]), {}, _adder(rep, {"page": "", "visual": "", "visualType": "", "role": "report filter"}))
        elif _EXT.match(r):
            extensionMeasures(tryJson(f["text"]), rep["measures"])
        elif _BOOKMARK.match(r):
            j = tryJson(f["text"])
            j = j if truthy(j) else {}
            walkRefs(j, {}, _adder(rep, {"page": "", "visual": get(j, "displayName") or "", "visualType": "bookmark", "role": "bookmark"}))
    return rep


def parseLegacyReport(name, root, layout):
    """Legacy format: a single Layout / report.json with sections[]"""
    rep = {"name": name, "root": root, "format": "Layout", "pages": [], "uses": [], "measures": [], "visualCount": 0}
    walkRefs(tryJson(layout.get("filters")), {}, _adder(rep, {"page": "", "visual": "", "visualType": "", "role": "report filter"}))
    cfg = tryJson(layout.get("config"))
    cfg = cfg if truthy(cfg) else {}
    for ext in get(cfg, "modelExtensions") or []:
        extensionMeasures(ext, rep["measures"])
    for b in get(cfg, "bookmarks") or []:
        walkRefs(b, {}, _adder(rep, {"page": "", "visual": get(b, "displayName") or "", "visualType": "bookmark", "role": "bookmark"}))
    for sec in layout.get("sections") or []:
        page = sec.get("displayName") or sec.get("name") or ""
        rep["pages"].append({"id": sec.get("name"), "name": page})
        walkRefs(tryJson(sec.get("filters")), {}, _adder(rep, {"page": page, "visual": "", "visualType": "", "role": "page filter"}))
        for vc in sec.get("visualContainers") or []:
            rep["visualCount"] += 1
            c = tryJson(vc.get("config"))
            c = c if truthy(c) else {}
            sv = get(c, "singleVisual")
            sv = sv if truthy(sv) else {}
            ctx = {
                "page": page, "visual": get(c, "name") or jstr(vc.get("id") or ""), "visualType": get(sv, "visualType") or ("group" if truthy(get(c, "singleVisualGroup")) else ""),
                "visualTitle": literalText(get(sv, "vcObjects") or {}, "title"),
            }
            pq = get(sv, "prototypeQuery")
            walkRefs(pq, {}, _adder(rep, dict(ctx, role="field")))
            aliases = {}
            for f in get(pq, "From") or []:
                if get(f, "Name") is not None:
                    aliases[jstr(f["Name"])] = f.get("Entity")
            walkRefs([get(sv, "objects"), get(sv, "vcObjects")], aliases, _adder(rep, dict(ctx, role="formatting")))
            walkRefs(tryJson(vc.get("filters")), {}, _adder(rep, dict(ctx, role="filter")))
            walkRefs([tryJson(vc.get("query")), tryJson(vc.get("dataTransforms"))], {}, _adder(rep, dict(ctx, role="field")))
    return rep


# ---------------------------------------------------------------- Files → project

def norm(p):
    return re.sub(r"^\.?/", "", p.replace("\\", "/"))


def baseName(p):
    return p[p.rfind("/") + 1:]


def dirName(p):
    return "" if p.rfind("/") < 0 else p[:p.rfind("/")]


def niceName(root):
    segs = [x for x in root.split("/") if x]
    last = segs[-1] if segs else "model"
    if re.fullmatch("Report|Model", last, I) and len(segs) > 1:
        last = segs[-2]
    return re.sub(r"\.(SemanticModel|Dataset|Report|pbix|pbit|pbip|vpax)\Z", "", last, flags=I)


def loadProject(files):
    """files: [{path, text}] → {models: [{name, root, model}], reports: [...], warnings: []}
    Reads TMDL models and reports (PBIR and the older report.json). The other inputs of the desktop tool (.bim, .vpax,
    smo.config.json, designs in YAML) do not occur in definitions from the Fabric API and are left out."""
    warnings = []
    modelGroups, pbirGroups = {}, {}
    models, reports = [], []
    for f0 in files:
        f = {"path": norm(f0["path"]), "text": f0["text"]}
        p, b = f["path"], baseName(f["path"])
        low = p.lower()
        if low.endswith(".tmdl"):
            i = low.rfind("/definition/")
            modelGroups.setdefault(p[:i] if i >= 0 else dirName(p), []).append(f)
        elif low.endswith(".pbir") or b == "Connections":
            pass
        elif low.endswith(".json") and '"Visual Container Lifecycle"' in f["text"]:
            pass
        elif low.endswith((".yaml", ".yml", ".md")) or b in ("smo.config.json", "DaxVpaView.json"):
            pass
        elif low.endswith(".bim") or b == "DataModelSchema":
            warnings.append("Could not read " + p + ": only models in TMDL are read here.")
        elif re.search(r"/definition/(pages/|report\.json\Z|reportExtensions\.json\Z|bookmarks/)", "/" + p, I):
            i = ("/" + low).rfind("/definition/")
            pbirGroups.setdefault(re.sub(r"/\Z", "", p[:max(0, i)]), []).append(f)
        elif b in ("Layout", "report.json"):
            j = tryJson(f["text"])
            if isinstance(j, dict) and isinstance(j.get("sections"), list):
                reports.append(parseLegacyReport(niceName(dirName(p)), dirName(p), j))
    for rootDir, fs in modelGroups.items():
        model = emptyModel()
        for f in fs:
            try:
                addTmdlToModel(model, f["text"])
            except Exception as e:  # one unreadable file should not stop the rest
                warnings.append("Error in " + f["path"] + ": " + str(e))
        if model["tables"]:
            models.append({"name": niceName(rootDir), "root": rootDir, "model": model, "format": "tmdl"})
    for rootDir, fs in pbirGroups.items():
        reports.append(parsePbirReport(niceName(rootDir), rootDir, fs))
    models.sort(key=lambda m: loc_key(m["name"]))
    reports.sort(key=lambda r: (loc_key(r["name"]), loc_key(r["root"])))
    names = {}  # keep two reports with the same name apart
    for r in reports:
        k = lc(r["name"])
        names[k] = names.get(k, 0) + 1
        if names[k] > 1:
            r["name"] = r["name"] + " (" + str(names[k]) + ")"
    if not models and reports:
        models.append({"name": "(model not loaded)", "root": "", "model": emptyModel(), "format": "none", "missing": True})
    return {"models": models, "reports": reports, "warnings": warnings}


# ---------------------------------------------------------------- Analysis

_AUTO_DATE = re.compile("(LocalDateTable_|DateTableTemplate_)")
_VALUE_N = re.compile(r"value[0-9]*\Z")
_PLAIN_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
_M_STRING = re.compile(r'(#?)"(?:[^"]|"")*"')


def analyze(model, reports, noModel=False):
    """model + reports → nodes with dependencies, usage and status.
    Status: 'direct' (in a report), 'indirect' (via something that is in a report),
            'model' (only needed by the model: relationship, RLS, hierarchy), 'unused'."""
    nodes = {}
    tableIdx, colIdx, measIdx, measByName, fnIdx, hierIdx = {}, {}, {}, {}, {}, {}
    broken = []

    def mk(id_, o):
        n = {"id": id_, "deps": {}, "usedBy": {}, "depKinds": {}, "reportUses": [], "modelUses": [], "problems": [], "brokenVia": [],
             "expression": "", "description": "", "hidden": False, "status": "unused"}
        n.update(o)
        nodes[id_] = n
        return n

    def link(frm, to, kind=None):
        if frm is None or to is None or frm is to:
            return
        frm["deps"][to["id"]] = True
        to["usedBy"][frm["id"]] = True
        if kind:
            frm["depKinds"][to["id"]] = kind

    for t in model["tables"]:
        tn = mk("T|" + t["name"], {
            "type": "table", "kind": t["kind"], "name": t["name"], "table": t["name"], "expression": t["expression"],
            "description": t["description"], "hidden": t["isHidden"], "system": bool(_AUTO_DATE.match(t["name"])),
            "dataCategory": t["dataCategory"] or "",
        })
        tableIdx[lc(t["name"])] = tn
        for c in t["columns"]:
            if c["isSystem"]:
                continue
            cn = mk("C|" + t["name"] + "|" + c["name"], {
                "type": "column", "kind": "calculated column" if c["isCalculated"] else "column", "name": c["name"], "table": t["name"],
                "expression": c["expression"] if c["isCalculated"] else "", "description": c["description"], "hidden": c["isHidden"],
                "dataType": c["dataType"], "sourceColumn": c["sourceColumn"], "displayFolder": c["displayFolder"], "tableKind": t["kind"],
                "nullable": c["isNullable"] is not False, "system": tn["system"], "sortByColumn": c["sortByColumn"],
            })
            colIdx[lc(t["name"]) + "|" + lc(c["name"])] = cn
        for m in t["measures"]:
            mn = mk("M|" + t["name"] + "|" + m["name"], {
                "type": "measure", "kind": "measure", "name": m["name"], "table": t["name"], "expression": m["expression"],
                "extraExpressions": m["extraExpressions"] or [], "description": m["description"], "hidden": m["isHidden"],
                "displayFolder": m["displayFolder"], "formatString": m["formatString"],
            })
            measIdx[lc(t["name"]) + "|" + lc(m["name"])] = mn
            measByName[lc(m["name"])] = mn
        for h in t["hierarchies"]:
            hierIdx[lc(t["name"]) + "|" + lc(h["name"])] = h
    for f in model.get("functions") or []:
        fnIdx[lc(f["name"])] = mk("F|" + f["name"], {
            "type": "function", "kind": "function", "name": f["name"], "table": "", "expression": f["expression"], "description": f.get("description") or "",
        })
    # measures created inside a report itself
    for rep in reports:
        for m in rep["measures"]:
            key = lc(m["table"]) + "|" + lc(m["name"])
            if key in measIdx:
                continue
            mn = mk("M|" + jstr(m["table"]) + "|" + jstr(m["name"]), {
                "type": "measure", "kind": "report measure", "name": m["name"], "table": m["table"], "expression": m["expression"],
                "extraExpressions": [], "description": m["description"], "report": rep["name"],
            })
            measIdx[key] = mn
            if lc(m["name"]) not in measByName:
                measByName[lc(m["name"])] = mn

    def resolve(ref, homeTable):
        t = ref["t"]
        if t == "q":
            k = lc(ref["table"]) + "|" + lc(ref["name"])
            return colIdx.get(k) or measIdx.get(k) or measByName.get(lc(ref["name"]))
        if t == "b":
            return measByName.get(lc(ref["name"])) or (colIdx.get(lc(homeTable) + "|" + lc(ref["name"])) if homeTable else None)
        if t == "t":
            return tableIdx.get(lc(ref["table"]))
        if t == "f":
            return fnIdx.get(lc(ref["name"]))
        return None

    # column names across all tables, to tell a broken reference from a bare column of another table
    colNames = set(k[k.index("|") + 1:] for k in colIdx)

    def linkExpr(node, expr, homeTable):
        text = expr if isinstance(expr, str) else ""
        for r in daxRefs(text):
            hit = resolve(r, homeTable)
            if hit is not None:
                link(node, hit)
                continue
            if noModel or r["t"] not in ("q", "b"):
                continue
            # not found: decide whether this is really broken
            if r["t"] == "q":
                reason = "not found in table " + r["table"] if lc(r["table"]) in tableIdx else "table " + r["table"] + " does not exist"
            else:
                name = lc(r["name"])
                if r["ns"] >= 2 and text[r["ns"] - 2] == ".":
                    continue  # Table[Date].[Year]
                if _VALUE_N.match(name) or name.startswith("@"):
                    continue  # { … } table constructors
                if '"' + name + '"' in lc(text):
                    continue  # a column the formula creates itself
                if name in colNames:
                    continue  # bare column of another table
                reason = "no measure or column with this name"
            ref = r["table"] + "[" + r["name"] + "]" if r["t"] == "q" else "[" + r["name"] + "]"
            if not any(p["ref"] == ref for p in node["problems"]):
                node["problems"].append({"ref": ref, "reason": reason})

    for t in model["tables"]:
        tn = tableIdx.get(lc(t["name"]))
        if t["kind"] == "calculated table":
            linkExpr(tn, t["expression"], None)
        for it in t["calcItems"]:
            linkExpr(tn, it["expression"], None)
            for e in it.get("extraExpressions") or []:
                linkExpr(tn, e, None)
        for c in t["columns"]:
            cn = colIdx.get(lc(t["name"]) + "|" + lc(c["name"]))
            if cn is None:
                continue
            if c["isCalculated"]:
                linkExpr(cn, c["expression"], t["name"])
            if t["kind"] != "table":
                link(cn, tn, t["kind"])  # a column of a calculated table depends on the table expression
            if c["sortByColumn"]:
                link(cn, colIdx.get(lc(t["name"]) + "|" + lc(c["sortByColumn"])), "sort-by column")
        for h in t["hierarchies"]:
            for l in h["levels"]:
                cn = colIdx.get(lc(t["name"]) + "|" + lc(l["column"]))
                if cn is not None:
                    cn["modelUses"].append({"kind": "hierarchy", "detail": h["name"] + " › " + l["name"]})
    for n in list(nodes.values()):
        if n["type"] == "measure":
            linkExpr(n, n["expression"], n["table"])
            for e in n.get("extraExpressions") or []:
                linkExpr(n, e, n["table"])
        elif n["type"] == "function":
            linkExpr(n, n["expression"], None)
    for r in model["relationships"]:
        a = colIdx.get(lc(r["fromTable"]) + "|" + lc(r["fromColumn"]))
        b = colIdx.get(lc(r["toTable"]) + "|" + lc(r["toColumn"]))
        txt = r["fromTable"] + "[" + r["fromColumn"] + "] → " + r["toTable"] + "[" + r["toColumn"] + "]" + ("" if r["isActive"] else " (inactive)")
        if a is not None:
            a["modelUses"].append({"kind": "relationship", "detail": txt})
        if b is not None:
            b["modelUses"].append({"kind": "relationship", "detail": txt})

    queries = [{"name": t["name"], "text": t["source"]} for t in model["tables"] if t["source"] and t["kind"] == "table"] + \
              [{"name": e["name"], "text": e["expression"] or ""} for e in model.get("expressions") or []]
    for t in model["tables"]:
        tn = tableIdx.get(lc(t["name"]))
        if tn is None or tn["system"]:
            continue
        esc = re.escape(t["name"])
        refRe = re.compile('#"' + esc + '"' + ('|(?<![A-Za-z0-9_"#.])' + esc + '(?![A-Za-z0-9_"])' if _PLAIN_NAME.match(t["name"]) else ""))
        for q in queries:
            # ignore text inside ordinary strings
            if lc(q["name"]) == lc(t["name"]) or not refRe.search(_M_STRING.sub(lambda m: m.group(0) if m.group(1) else '""', q["text"])):
                continue
            tn["modelUses"].append({"kind": "Power Query", "detail": "read by the query of " + q["name"]})
            for c in t["columns"]:
                src = unquoteValue(c["sourceColumn"] or c["name"])
                cn = colIdx.get(lc(t["name"]) + "|" + lc(c["name"]))
                if cn is not None and src and '"' + src.replace('"', '""') + '"' in q["text"]:
                    cn["modelUses"].append({"kind": "Power Query", "detail": "used in the query of " + q["name"]})
    for role in model["roles"]:
        for p in role["permissions"]:
            for ref in daxRefs(p["expression"]):
                n = resolve(ref, p["table"])
                if n is not None:
                    n["modelUses"].append({"kind": "RLS", "detail": "role " + role["name"] + " on " + p["table"]})

    # usage in reports
    seen = set()
    for rep in reports:
        for u in rep["uses"]:
            n = None
            if u["kind"] == "hierarchy":
                h = hierIdx.get(lc(u["entity"]) + "|" + lc(u.get("hierarchy")))
                lvl = next((l for l in h["levels"] if lc(l["name"]) == lc(u.get("level"))), None) if h else None
                if lvl:
                    n = colIdx.get(lc(u["entity"]) + "|" + lc(lvl["column"]))
            else:
                k = lc(u["entity"]) + "|" + lc(u.get("property"))
                n = (measIdx.get(k) or colIdx.get(k)) if u["kind"] == "measure" else (colIdx.get(k) or measIdx.get(k))
            use = {"report": rep["name"], "page": u["page"], "visual": u["visual"], "visualType": u["visualType"],
                   "visualTitle": u.get("visualTitle") or "", "role": u["role"]}
            other = u.get("property") if truthy(u.get("property")) else jstr(u.get("hierarchy")) + "." + jstr(u.get("level"))
            key = (n["id"] if n is not None else "X|" + jstr(u["entity"]) + "|" + jstr(other)) + \
                "|" + rep["name"] + "|" + jstr(u["page"]) + "|" + jstr(u["visual"]) + "|" + jstr(u["role"])
            if key in seen:
                continue
            seen.add(key)
            if n is not None:
                n["reportUses"].append(use)
            else:
                b = {"table": u["entity"], "name": u.get("property") if truthy(u.get("property")) else jstr(u.get("hierarchy")) + " › " + jstr(u.get("level")), "kind": u["kind"]}
                b.update(use)
                broken.append(b)

    # status
    def closure(roots):
        out = {n["id"]: True for n in roots}
        todo = list(roots)
        while todo:
            n = todo.pop()
            for d in n["deps"]:
                if d not in out:
                    out[d] = True
                    todo.append(nodes[d])
        return out

    all_ = list(nodes.values())
    reachR = closure([n for n in all_ if n["reportUses"]])
    reachM = closure([n for n in all_ if n["modelUses"]])
    for n in all_:
        n["status"] = "direct" if n["reportUses"] else "indirect" if n["id"] in reachR else "model" if n["id"] in reachM else "unused"
    # a table counts as used as soon as anything in it is used
    rank = {"unused": 0, "model": 1, "indirect": 2, "direct": 3}
    for n in all_:
        if n["type"] == "table":
            continue
        tn = tableIdx.get(lc(n["table"]))
        if tn is None or n["status"] == "unused":
            continue
        s = "indirect" if n["status"] == "direct" else n["status"]
        if rank[s] > rank[tn["status"]]:
            tn["status"] = s

    # a formula is also broken when something it depends on is broken
    brokenState = {}
    limit = sys.getrecursionlimit()
    sys.setrecursionlimit(max(limit, len(all_) * 2 + 1000))

    def isBroken(n):
        if n["id"] in brokenState:
            return brokenState[n["id"]]
        brokenState[n["id"]] = len(n["problems"]) > 0  # guards against cycles
        b = len(n["problems"]) > 0
        if n["expression"]:
            for d in n["deps"]:
                x = nodes.get(d)
                if x is not None and x["expression"] and x["type"] != "table" and isBroken(x):
                    b = True
                    if d not in n["brokenVia"]:
                        n["brokenVia"].append(d)
        brokenState[n["id"]] = b
        return b

    try:
        for n in all_:
            n["broken"] = isBroken(n)
    finally:
        sys.setrecursionlimit(limit)
    stats = {"reportCount": len(reports), "visuals": sum(r["visualCount"] for r in reports), "noModel": noModel, "hasStats": False}
    return {"nodes": nodes, "list": all_, "broken": broken, "stats": stats, "resolve": resolve}


# ---------------------------------------------------------------- Bus matrix

def busMatrix(model, analysis):
    """Kimball bus matrix: the fact tables (business processes), the dimensions, and which fact reaches which dimension."""
    nodes = [n for n in analysis["list"] if n["type"] == "table" and not n["system"]]
    canon = {lc(n["name"]): n["name"] for n in nodes}
    one = {n["name"]: {} for n in nodes}  # table → (table on its "one" side → relationships)
    isOne, isMany = set(), set()
    for r in model.get("relationships") or []:
        a, b = canon.get(lc(r["fromTable"])), canon.get(lc(r["toTable"]))
        if not a or not b or a == b:
            continue
        ca, cb, ac, bc = r.get("fromCardinality") or "many", r.get("toCardinality") or "one", r["fromColumn"], r["toColumn"]
        if ca == "one" and cb == "many":
            a, b, ac, bc = b, a, bc, ac
        one[a].setdefault(b, []).append({"active": bool(r["isActive"]), "text": a + "[" + ac + "] → " + b + "[" + bc + "]"})
        isMany.add(a)
        isOne.add(b)
    measures = {n["name"]: 0 for n in nodes}
    for n in analysis["list"]:
        if n["kind"] == "measure" and n["table"] in measures:
            measures[n["table"]] += 1
    # business processes: tables that only sit on the "many" side, plus bridge tables that carry measures
    factNames = sorted((n["name"] for n in nodes if n["name"] in isMany and (n["name"] not in isOne or measures[n["name"]] > 0)), key=loc_key)
    cells, dimCount = {}, {}
    for f in factNames:
        row = {}
        for d, rels in one[f].items():
            row[d] = {"direct": len(rels), "active": any(r["active"] for r in rels), "via": None}
        # dimensions reached through another dimension (snowflake)
        frontier = list(row)
        seen = set([f] + frontier)
        depth = 0
        while frontier and depth < 6:
            nxt = []
            for d in frontier:
                for o in one.get(d) or {}:
                    if o in seen:
                        continue
                    seen.add(o)
                    nxt.append(o)
                    row[o] = {"direct": 0, "active": True, "via": d}
            frontier = nxt
            depth += 1
        cells[f] = row
        for d in row:
            dimCount[d] = dimCount.get(d, 0) + 1
    byName = {n["name"]: n for n in nodes}
    dims = [{"name": d, "description": byName[d]["description"] or ""} for d in sorted(dimCount, key=lambda d: (-dimCount[d], loc_key(d)))]
    facts = [{"name": f, "description": byName[f]["description"] or ""} for f in factNames]
    return {"facts": facts, "dims": dims, "cell": lambda f, d: (cells.get(f) or {}).get(d)}


# ---------------------------------------------------------------- Best-practice checks

# RULES-BEGIN (written by build-fabric.js from core.js)
RULES = [
    {"id":"broken-formula","group":"","severity":"error","title":"Broken formulas","help":"The DAX refers to a table, column or measure that does not exist, or depends on a formula that does. These fail when the model is used."},
    {"id":"broken-reference","group":"","severity":"error","title":"Broken references in reports","help":"A visual or filter uses a field that is not in the model. The visual shows an error."},
    {"id":"many-to-many","group":"","severity":"warning","title":"Many-to-many relationships","help":"Both sides are \"many\". Results are easy to misread and slow on large tables; a bridge table or a proper dimension is usually better."},
    {"id":"bidirectional","group":"","severity":"warning","title":"Relationships that filter both ways","help":"Bidirectional filtering can create ambiguous paths and hurts performance. Use it only where it is needed, or use CROSSFILTER inside a measure."},
    {"id":"key-visible","group":"","severity":"warning","title":"Key columns that are not hidden","help":"These columns are used in a relationship but are visible and not used in any report. Hide them so report builders pick the dimension attributes instead."},
    {"id":"calc-column-as-measure","group":"","severity":"warning","title":"Calculated columns that could be measures","help":"A numeric calculated column that is only used inside measures takes memory for every row. An iterator such as SUMX in the measure usually does the same without storing it."},
    {"id":"duplicate-measure","group":"","severity":"warning","title":"Measures with the same formula","help":"Two or more measures have identical DAX. Keep one and let the others refer to it, or remove the duplicates."},
    {"id":"measure-no-format","group":"","severity":"warning","title":"Measures without a format","help":"Visible measures without a format string show raw numbers. Set thousands separators, decimals or a percentage."},
    {"id":"measure-no-description","group":"","severity":"info","title":"Measures without a description","help":"A description tells report builders (and Copilot) what the measure means. Hidden helper measures are skipped."},
    {"id":"report-only-measure","group":"","severity":"info","title":"Measures defined in a report","help":"These measures live in one thin report. Other reports cannot use them and they are not maintained with the model. Consider moving them to the semantic model."},
    {"id":"unqualified-column","group":"","severity":"info","title":"Column references without a table name","help":"Write columns as Table[Column] and measures as [Measure]. It makes formulas readable and avoids ambiguity."},
    {"id":"qualified-measure","group":"","severity":"info","title":"Measure references with a table name","help":"Write measures as [Measure], without the table. A measure reference with a table name looks like a column."},
    {"id":"inactive-relationship","group":"","severity":"info","title":"Inactive relationships","help":"Only used through USERELATIONSHIP. Listed so you can check that each one is still needed."},
    {"id":"auto-date-time","group":"","severity":"warning","title":"Auto date/time is on","help":"Power BI created a hidden date table for every date column. That costs memory; use one shared date table and turn Auto date/time off."},
    {"id":"dimension-keys-differ","group":"","severity":"warning","title":"Dimensions joined on different keys","help":"A conformed dimension should be joined on the same key from every fact table. Here the same dimension is joined on more than one of its columns."},
    {"id":"no-date-table","group":"","severity":"info","title":"No table is marked as date table","help":"Mark the date dimension as date table (Table tools › Mark as date table). Time intelligence functions rely on it."},
    {"id":"constant-column","group":"","severity":"warning","title":"Columns with one value or no values","help":"These columns hold a single value (or only blanks) in every row, so they cannot slice anything. Needs sizes to be loaded."},
    {"id":"name-whitespace","group":"","severity":"info","title":"Names with stray spaces","help":"A leading, trailing or double space in a name is easy to miss and makes formulas fail on a typo."},
    {"id":"naming-convention","group":"","severity":"warning","title":"Names that do not follow the convention","help":"Checked against the patterns under \"naming\" in smo.config.json."},
    {"id":"double-data-type","group":"","severity":"info","title":"Columns with a floating-point data type","help":"Decimal number (double) can give rounding differences in totals. Fixed decimal number is exact for amounts with up to four decimals."},
    {"id":"k-fact-to-fact","group":"kimball","severity":"error","title":"Fact tables related to each other","help":"Kimball: fact tables are never joined directly. Combine them through the conformed dimensions they share (drill-across)."},
    {"id":"ri-orphans","group":"kimball","severity":"error","title":"Referential integrity: keys without a dimension row","help":"Fact rows whose key has no row in the dimension. They show up under (Blank), or disappear from every visual when the relationship assumes referential integrity. Add the dimension rows, or point the key to -1 Unknown during the load."},
    {"id":"ri-dim-not-unique","group":"kimball","severity":"error","title":"Referential integrity: dimension key is not unique","help":"The key on the \"one\" side of a relationship must be unique. Duplicates make refresh fail or double the facts."},
    {"id":"k-bsn","group":"kimball","severity":"error","title":"Citizen service number (BSN) in the model","help":"A BSN does not belong in a dimensional model."},
    {"id":"ri-blank-keys","group":"kimball","severity":"warning","title":"Referential integrity: blank keys in fact tables","help":"Kimball: never NULL in a key column. Point a missing value to the fixed row -1 Unknown, or -2 Not applicable."},
    {"id":"ri-unknown-row","group":"kimball","severity":"warning","title":"Dimensions without the row -1 Unknown","help":"Every dimension holds the fixed rows -1 Unknown and -2 Not applicable, so facts with a missing or late-arriving value still have a row to point to."},
    {"id":"k-snowflake","group":"kimball","severity":"warning","title":"Snowflaked dimensions","help":"A dimension that is related to another dimension. Kimball: denormalise into one dimension unless there is a hard reason, so the model stays readable."},
    {"id":"k-natural-key","group":"kimball","severity":"warning","title":"Relationships on a text key","help":"Relationships run over integer surrogate keys. A text key is usually a natural key: it can change and is not unique across sources."},
    {"id":"k-key-nullable","group":"kimball","severity":"warning","title":"Fact key columns that allow blanks","help":"A key column in a fact table should not allow blanks; a missing value points to -1 Unknown."},
    {"id":"k-calculated","group":"kimball","severity":"warning","title":"Calculated columns and tables","help":"Kimball: derived columns (bands, flags, durations) are materialised in the table during the load, not calculated in the semantic model."},
    {"id":"k-fact-no-date","group":"kimball","severity":"warning","title":"Fact tables without a date","help":"Every business process happens at a moment. Relate each fact table to the date dimension."},
    {"id":"k-ratio-fact","group":"kimball","severity":"warning","title":"Ratios stored as a fact","help":"Store numerator and denominator and calculate the ratio as a measure. A stored percentage gets summed."},
    {"id":"k-naming","group":"kimball","severity":"warning","title":"Names that do not follow the conventions","help":"Fact tables Feit_<process>, dimensions Dim_<subject>, DK_ only for keys that carry a relationship, no underscores in other column names. Change the prefixes or switch this off with \"kimball\": {\"naming\": false} in smo.config.json."},
    {"id":"k-grain-missing","group":"kimball","severity":"info","title":"Fact tables without a declared grain","help":"Declare the grain as one sentence in the description of the fact table: \"One row per …\" / \"Eén rij per …\"."},
    {"id":"k-text-in-fact","group":"kimball","severity":"info","title":"Text columns in fact tables","help":"Text belongs in a dimension. A number without attributes (order number, claim number) is fine in the fact table as a degenerate dimension."},
    {"id":"k-flag-values","group":"kimball","severity":"info","title":"True/false flags in dimensions","help":"Kimball: readable values (\"Yes\"/\"No\", \"Active\"/\"Ended\") instead of true/false or 1/0."},
    {"id":"k-code-without-label","group":"kimball","severity":"info","title":"Codes without a description","help":"Next to a code a dimension holds a readable description."},
    {"id":"k-scd2-incomplete","group":"kimball","severity":"info","title":"Incomplete history columns (SCD type 2)","help":"A type 2 dimension has Valid from, Valid to and a current-row flag."},
    {"id":"k-role-unused","group":"kimball","severity":"info","title":"Role relationships no measure uses","help":"A role (for example ship date) is an inactive relationship that a measure switches on with USERELATIONSHIP. No measure uses this one."},
    {"id":"k-personal-data","group":"kimball","severity":"info","title":"Personal data","help":"Only include personal data when the business question needs it; otherwise use bands (age group, four-digit postcode area)."},
    {"id":"ri-not-checked","group":"kimball","severity":"info","title":"Referential integrity not checked against the data","help":"The model only says how tables relate, not whether the data matches. Run \"Check data\" with the model open in Power BI Desktop or on a server."},
    {"id":"ri-failed","group":"kimball","severity":"info","title":"Data check could not run","help":"The query failed; the message says why."},
    {"id":"k-semi-additive","group":"kimball","severity":"warning","title":"Semi-additive facts summed over time","help":"A stock or balance (a periodic snapshot) cannot be added up over time: three monthly stands of 100 are not 300. Take the last value in the period, for example with LASTNONBLANK or a filter on the last date."},
    {"id":"kd-grain-duplicates","group":"kimball","severity":"warning","title":"Fact rows that are not unique on their keys","help":"Several rows share every dimension key and degenerate dimension. Either the grain is mixed, or a key that identifies the row is missing from the table."},
    {"id":"kd-scd2-current","group":"kimball","severity":"error","title":"SCD type 2: more than one current row","help":"Each natural key has exactly one current row in a type 2 dimension."},
    {"id":"kd-scd2-overlap","group":"kimball","severity":"error","title":"SCD type 2: overlapping validity periods","help":"The versions of one natural key follow each other without overlap; otherwise a fact matches two versions."},
    {"id":"kd-flag-codes","group":"kimball","severity":"info","title":"Flags stored as codes","help":"The column only holds values like 0/1, Y/N or True/False. Kimball: show readable values (\"Yes\"/\"No\")."},
    {"id":"ri-na-row","group":"kimball","severity":"warning","title":"Dimensions without the row -2 Not applicable","help":"The design asks for the fixed row -2 Not applicable, but the dimension does not have it."},
    {"id":"spec-missing-table","group":"kimball","severity":"error","title":"Design: tables missing from the model","help":"The design (YAML specification) names this table, but the model does not have it."},
    {"id":"spec-missing-column","group":"kimball","severity":"error","title":"Design: columns missing from the model","help":"The design names this column, but the table in the model does not have it."},
    {"id":"spec-relationship","group":"kimball","severity":"error","title":"Design: relationships missing from the model","help":"The design relates this key to a dimension, but the model has no such relationship."},
    {"id":"spec-role-active","group":"kimball","severity":"warning","title":"Design: role active or inactive the other way round","help":"The design says which role of a dimension is the active relationship; the model has it the other way round."},
    {"id":"spec-type","group":"kimball","severity":"warning","title":"Design: data type differs","help":"The column has another data type than the design. Kimball: amounts as decimal(18,2), keys as integers."},
    {"id":"spec-grain","group":"kimball","severity":"warning","title":"Design: grain not in the description","help":"The description of the fact table does not contain the grain sentence from the design. Copy it, so report builders see what one row is."},
    {"id":"spec-busmatrix","group":"kimball","severity":"warning","title":"Design: bus matrix and model differ","help":"The bus matrix says which dimensions a business process uses. The relationships in the model say otherwise."},
    {"id":"spec-extra","group":"kimball","severity":"info","title":"Design: columns not in the design","help":"The model has these columns, the design does not mention them. Add them to the design or remove them from the model."},
    {"id":"spec-not-matched","group":"kimball","severity":"info","title":"Design loaded, but not for this model","help":"None of the tables in these designs is in this model."},
]
# RULES-END


def objLabel(n):
    if n is None:
        return "?"
    if n["type"] == "measure":
        return "[" + n["name"] + "]"
    if n["type"] == "table":
        return "'" + n["name"] + "'"
    if n["type"] == "function":
        return n["name"] + "()"
    return n["table"] + "[" + n["name"] + "]"


def relSides(r):
    """One relationship as fact ("many") side and dimension ("one") side; None for many-to-many."""
    fc, tc = r.get("fromCardinality") or "many", r.get("toCardinality") or "one"
    if fc == "many" and tc == "many":
        return None
    if fc == "one" and tc == "many":
        return {"fact": r["toTable"], "fk": r["toColumn"], "dim": r["fromTable"], "pk": r["fromColumn"]}
    return {"fact": r["fromTable"], "fk": r["fromColumn"], "dim": r["toTable"], "pk": r["toColumn"]}


_NUMERIC = re.compile(r"(int64|double|decimal)\Z", I)
_SPACES = re.compile(S + "+")


def checkRules(model, analysis):
    """model + analysis → {rules: [{…rule, items: [{id, label, detail}]}], counts: {error, warning, info}}
    Without the parts that need more than the definitions: smo.config.json, a design in YAML, and checks on the data."""
    noModel = bool(analysis["stats"]["noModel"])
    found = {r["id"]: [] for r in RULES}
    nodes = analysis["nodes"]

    def add(rule, n, detail=""):
        found[rule].append({"id": n["id"] if n is not None else None, "label": objLabel(n) if n is not None else "", "detail": detail or ""})

    lst = [n for n in analysis["list"] if not n.get("system")]

    def col(t, c):
        hit = nodes.get("C|" + t + "|" + c)
        if hit is not None:
            return hit
        return next((n for n in lst if n["type"] == "column" and lc(n["table"]) == lc(t) and lc(n["name"]) == lc(c)), None)

    def rel_text(r):
        return r["fromTable"] + "[" + r["fromColumn"] + "] → " + r["toTable"] + "[" + r["toColumn"] + "]"

    for n in lst:
        if n["broken"]:
            add("broken-formula", n, "; ".join([p["ref"] + ": " + p["reason"] for p in n["problems"]] + ["depends on broken " + objLabel(nodes.get(i)) for i in n["brokenVia"]]))
        if n["kind"] == "report measure":
            add("report-only-measure", n, "in report " + n["report"])
    if not noModel:
        for u in analysis["broken"]:
            found["broken-reference"].append({"id": None, "label": jstr(u["table"]) + "[" + jstr(u["name"]) + "]",
                                              "detail": " › ".join(x for x in (u["report"], u["page"], u["visualTitle"] or u["visualType"] or u["visual"], u["role"]) if truthy(x))})

    if not noModel:
        rels = model.get("relationships") or []
        keyCols = set()
        for r in rels:
            frm, to = col(r["fromTable"], r["fromColumn"]), col(r["toTable"], r["toColumn"])
            text = rel_text(r)
            if (r.get("fromCardinality") or "many") == "many" and (r.get("toCardinality") or "one") == "many":
                add("many-to-many", frm, text)
            if re.search("both", r.get("crossFilter") or "", I):
                add("bidirectional", frm, text)
            if not r["isActive"]:
                add("inactive-relationship", frm, text)
            for c in (frm, to):
                if c is not None and c["id"] not in keyCols:
                    keyCols.add(c["id"])
                    if not c["hidden"] and c["status"] != "direct":
                        add("key-visible", c, "used in " + text)
        byExpr = {}
        for n in lst:
            if n["type"] == "measure":
                key = _SPACES.sub("", n["expression"] or "").lower()
                if key:
                    byExpr.setdefault(key, []).append(n)
            if n["kind"] == "measure" and not n["hidden"]:
                if not n["formatString"] and not (n.get("extraExpressions") or []):
                    add("measure-no-format", n, "")
                if not trim(n["description"] or ""):
                    add("measure-no-description", n, "")
            if n["kind"] == "calculated column" and _NUMERIC.match(n.get("dataType") or "") and not n["modelUses"] and not n["reportUses"] and n["usedBy"]:
                users = [nodes.get(i) for i in n["usedBy"]]
                if all(u is not None and u["type"] == "measure" for u in users):
                    add("calc-column-as-measure", n, "only used by " + ", ".join(objLabel(u) for u in users[:3]) + (" …" if len(users) > 3 else ""))
            if n["type"] == "column" and re.match(r"double\Z", n.get("dataType") or "", I):
                add("double-data-type", n, "")
            if n["type"] == "measure" and n["expression"]:
                bare, qual = {}, {}
                for r in daxRefs(n["expression"]):
                    hit = analysis["resolve"](r, n["table"])
                    if hit is None:
                        continue
                    if r["t"] == "b" and hit["type"] == "column":
                        bare["[" + r["name"] + "]"] = True
                    if r["t"] == "q" and hit["type"] == "measure":
                        qual[r["table"] + "[" + r["name"] + "]"] = True
                if bare:
                    add("unqualified-column", n, ", ".join(bare))
                if qual:
                    add("qualified-measure", n, ", ".join(qual))
        for group in byExpr.values():
            if len(group) < 2:
                continue
            for n in group:
                add("duplicate-measure", n, "same formula as " + ", ".join(objLabel(x) for x in group if x is not n))
        keysOf = {}
        for r in rels:
            many = (r.get("fromCardinality") or "many") == "one" and (r.get("toCardinality") or "one") == "many"
            t, c = (r["fromTable"], r["fromColumn"]) if many else (r["toTable"], r["toColumn"])
            keysOf.setdefault(lc(t), {})[lc(c)] = {"table": t, "column": c}
        for m in keysOf.values():
            if len(m) > 1:
                v = list(m.values())
                add("dimension-keys-differ", col(v[0]["table"], v[0]["column"]), "joined on " + " and ".join(x["table"] + "[" + x["column"] + "]" for x in v))
        if rels and not any(n["type"] == "table" and re.match(r"time\Z", n.get("dataCategory") or "", I) for n in lst):
            found["no-date-table"].append({"id": None, "label": str(len(model["tables"])) + " tables", "detail": "none has the data category Time"})
        for n in lst:
            if n["type"] in ("measure", "column", "table") and n["kind"] != "report measure":
                if n["name"] != trim(n["name"]) or re.search(S + "{2,}", n["name"]):
                    add("name-whitespace", n, '"' + n["name"] + '"')
        auto = [n for n in analysis["list"] if n["type"] == "table" and n.get("system")]
        if auto:
            found["auto-date-time"].append({"id": None, "label": str(len(auto)) + " hidden date tables", "detail": "File › Options › Data Load › Auto date/time"})
        kimballFindings(model, analysis, add, found, col, lst)
    rules = [dict(r, items=found[r["id"]]) for r in RULES if found[r["id"]]]
    counts = {"error": 0, "warning": 0, "info": 0}
    for r in rules:
        counts[r["severity"]] += len(r["items"])
    return {"rules": rules, "counts": counts, "total": counts["error"] + counts["warning"] + counts["info"]}


# ---------------------------------------------------------------- Kimball dimensional modelling

_K_DATE = re.compile("date|datum|calendar|kalender", I)
_K_GRAIN = re.compile("(één|eén|een|1|one)" + S + "+(rij|regel|row|record)" + S + "+(per|for)" + B, I)
_K_RATIO = re.compile("%|percent|pct|ratio|quote|quotum|" + B + "rate" + B, I)
_K_NUMBERLIKE = re.compile(r"(nummer|number|nr|no|id|code)\Z", I)
_K_CODE = re.compile("(.*?)[" + WSC + r"_-]*code\Z", I)
_K_LABEL = re.compile("omschrijving|description|naam|name")
_K_FROM = re.compile("geldig vanaf|valid from|effective from")
_K_TO = re.compile("geldig tot|valid to|valid until|effective to")
_K_CURRENT = re.compile("actueel|huidig|current")
_K_BSN = re.compile(B + "(bsn|burgerservicenummer|sofinummer|social security|ssn)" + B, I)
_K_PERSONAL = re.compile("e-?mail|telefoon|phone|mobiel|" + B + "adres" + B + "|address|geboortedatum|birth" + S + "?date|date of birth|" + B + "iban" + B + "|voornaam|achternaam|first name|last name", I)
_K_USEREL = re.compile("USERELATIONSHIP" + S + r"*\(([^)]*)\)", I)
_K_SNAP_DESC = re.compile("periodieke snapshot|periodic snapshot|" + B + "snapshot" + B + "|" + B + "stand(en)?" + B + "|" + B + "saldo", I)
_K_SNAP_NAME = re.compile("moment|snapshot|standen|" + B + "stand" + B + "|balans|positie|portefeuille|voorraad", I)
_K_KEYLIKE = re.compile(r"(sleutel|key|nummer|number|id)\Z", I)
_K_TIME = re.compile("LASTDATE|LASTNONBLANK|FIRSTNONBLANK|CLOSINGBALANCE|OPENINGBALANCE|ENDOF(MONTH|QUARTER|YEAR)|STARTOF(MONTH|QUARTER|YEAR)|" + B + "MAX" + S + r"*\(|" + B + "MIN" + S + r"*\(|" + B + "MAXX" + S + r"*\(|" + B + "TOPN" + S + r"*\(|" + B + "AVERAGEX" + S + r"*\(", I)
OUTSIDE = " (the model is in a workspace you did not choose: only the reports you chose count, so more can look unused)"
_K_SUM = re.compile(B + "SUMX?" + S + r"*\(", I)
K_FACT, K_DIM, K_KEY = "Feit_", "Dim_", "DK_"


def kimballFindings(model, analysis, add, found, col, lst):
    nodes = analysis["nodes"]
    bm = busMatrix(model, analysis)
    facts = {f["name"]: True for f in bm["facts"]}
    dims = {d["name"]: True for d in bm["dims"] if d["name"] not in facts}
    table = lambda name: nodes.get("T|" + name)
    colsOf = lambda name: [n for n in lst if n["type"] == "column" and n["table"] == name]
    rels_all = model.get("relationships") or []

    def isDate(t):
        n = table(t)
        return n is not None and bool(re.match(r"time\Z", n.get("dataCategory") or "", I) or _K_DATE.search(n["name"]))

    def rel_text(r):
        return r["fromTable"] + "[" + r["fromColumn"] + "] → " + r["toTable"] + "[" + r["toColumn"] + "]"

    relCols = set()
    # relationships: fact to fact, snowflakes, text keys, nullable fact keys
    for r in rels_all:
        s, text = relSides(r), rel_text(r)
        a, b = col(r["fromTable"], r["fromColumn"]), col(r["toTable"], r["toColumn"])
        if a is not None:
            relCols.add(a["id"])
        if b is not None:
            relCols.add(b["id"])
        if s is None:
            continue
        if s["fact"] in facts and s["dim"] in facts:
            add("k-fact-to-fact", table(s["fact"]), text)
        elif s["fact"] in dims and s["fact"] not in facts:
            add("k-snowflake", table(s["fact"]), "related to " + s["dim"] + " (" + text + ")")
        fk, pk = col(s["fact"], s["fk"]), col(s["dim"], s["pk"])
        if any(c is not None and re.match(r"string\Z", c.get("dataType") or "", I) for c in (fk, pk)):
            add("k-natural-key", fk if fk is not None else pk, text)
        if fk is not None and s["fact"] in facts and fk.get("nullable") is not False:
            add("k-key-nullable", fk, "allows blanks; used in " + text)
    # facts
    for f in bm["facts"]:
        t = table(f["name"])
        if not any(isDate(d["name"]) and bm["cell"](f["name"], d["name"]) and not bm["cell"](f["name"], d["name"])["via"] for d in bm["dims"]):
            add("k-fact-no-date", t, "no relationship to a date table")
        if not _K_GRAIN.search(f["description"] or ""):
            add("k-grain-missing", t, 'description: "' + jslice(f["description"], 80) + '"' if f["description"] else "no description")
        for c in colsOf(f["name"]):
            if c["id"] in relCols:
                continue
            if _NUMERIC.match(c.get("dataType") or "") and _K_RATIO.search(c["name"]):
                add("k-ratio-fact", c, c["dataType"])
            if re.match(r"string\Z", c.get("dataType") or "", I) and not _K_NUMBERLIKE.search(_SPACES.sub("", c["name"])):
                add("k-text-in-fact", c, "text column in fact table " + f["name"])
    # dimensions
    for d in dims:
        cs = colsOf(d)
        names = [lc(c["name"]) for c in cs]
        for c in cs:
            if re.match(r"boolean\Z", c.get("dataType") or "", I):
                add("k-flag-values", c, "true/false")
            m = _K_CODE.match(c["name"])
            if m and m.group(1) and not any(n != lc(c["name"]) and (lc(m.group(1)) in n or _K_LABEL.search(n)) for n in names):
                add("k-code-without-label", c, 'no column with "' + m.group(1) + '" or a description next to it')
        if any(_K_FROM.search(n) for n in names):
            miss = []
            if not any(_K_TO.search(n) for n in names):
                miss.append("valid to")
            if not any(_K_CURRENT.search(n) for n in names):
                miss.append("current-row flag")
            if miss:
                add("k-scd2-incomplete", table(d), "missing " + " and ".join(miss))
    # calculated columns and tables
    for n in lst:
        if n["kind"] in ("calculated column", "calculated table"):
            add("k-calculated", n, n["kind"])
        if n["type"] == "column":
            if _K_BSN.search(n["name"]):
                add("k-bsn", n, "")
            elif _K_PERSONAL.search(n["name"]):
                add("k-personal-data", n, "hidden" if n["hidden"] else "visible")
    # role relationships nobody activates
    used = set()
    for n in lst:
        if n["type"] != "measure" or not re.search("USERELATIONSHIP", n["expression"] or "", I):
            continue
        for m in _K_USEREL.finditer(n["expression"]):
            for ref in daxRefs(m.group(1)):
                hit = analysis["resolve"](ref, n["table"])
                if hit is not None:
                    used.add(hit["id"])
    for r in rels_all:
        if r["isActive"]:
            continue
        a, b = col(r["fromTable"], r["fromColumn"]), col(r["toTable"], r["toColumn"])
        if not (a is not None and a["id"] in used) and not (b is not None and b["id"] in used):
            add("k-role-unused", a if a is not None else b, rel_text(r))
    # naming conventions
    for f in facts:
        if not f.startswith(K_FACT):
            add("k-naming", table(f), "fact table: expected " + K_FACT + "…")
    for d in dims:
        if not d.startswith(K_DIM):
            add("k-naming", table(d), "dimension: expected " + K_DIM + "…")
    for n in lst:
        if n["type"] != "column" or not (n["table"] in facts or n["table"] in dims):
            continue
        isKey = n["id"] in relCols
        if isKey and not n["name"].startswith(K_KEY):
            add("k-naming", n, "key in a relationship: expected " + K_KEY + "…")
        elif not isKey and n["name"].startswith(K_KEY):
            add("k-naming", n, K_KEY + " is only for keys that carry a relationship")
        elif not n["name"].startswith(K_KEY) and "_" in n["name"]:
            add("k-naming", n, "underscore in a column name")
    # semi-additive facts: stocks and balances in a periodic snapshot may not be summed over time
    semi = {}  # column id → why
    for f in bm["facts"]:
        if _K_SNAP_DESC.search(f["description"] or "") or _K_SNAP_NAME.search(f["name"]):
            for c in colsOf(f["name"]):
                if c["id"] not in relCols and _NUMERIC.match(c.get("dataType") or "") and not _K_KEYLIKE.search(c["name"]):
                    semi[c["id"]] = "stock in periodic snapshot " + f["name"]
    if semi:
        for n in lst:
            if n["type"] != "measure" or not n["expression"] or _K_TIME.search(n["expression"]) or not _K_SUM.search(n["expression"]):
                continue
            hit = [i for i in n["deps"] if i in semi]
            if hit:
                add("k-semi-additive", n, "sums " + ", ".join(objLabel(nodes.get(i)) for i in hit) + " over time (" + semi[hit[0]] + ")")
    # the data itself is not read here: a reminder that referential integrity is unchecked
    rels = [r for r in rels_all if relSides(r) is not None]
    if rels:
        found["ri-not-checked"].append({"id": None, "label": str(len(rels)) + " relationships",
                                        "detail": str(len([r for r in rels if r["rely"]])) + " of them assume referential integrity, so violations silently drop rows"})


# ---------------------------------------------------------------- The tables of one run (powerbi.js)

STATUS = {"direct": "In report", "indirect": "Used indirectly", "model": "Model only", "unused": "Unused"}
STATUS_ORDER = {"In report": 1, "Used indirectly": 2, "Model only": 3, "Unused": 4, "Not in model": 5, "Model not loaded": 6, "(none)": 9}
SEVERITY = {"error": "Error", "warning": "Warning", "info": "Note"}
SEVERITY_ORDER = {"Error": 1, "Warning": 2, "Note": 3}
STEP = 10000000  # keys: run number × STEP + row number
TABLES = ["runs", "objects", "visuals", "usage", "dependencies", "findings", "rules"]


def yn(b):
    return "Yes" if b else "No"


def cap(s):
    return s[0].upper() + s[1:] if s else s


def ruleKey(id_):
    """A stable whole number for a rule id (FNV-1a), so a rule keeps its key across versions of the tool."""
    h = 0x811c9dc5
    for ch in id_:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h & 0x7FFFFFFF


def label(n):
    if n["type"] == "measure":
        return "[" + n["name"] + "]"
    if n["type"] == "table":
        return n["name"]
    if n["type"] == "function":
        return n["name"] + "()"
    return n["table"] + "[" + n["name"] + "]"


def stamp(d):
    return d.strftime("%Y-%m-%d %H:%M:%S")


def runTables(analysis, checks, run, now, model, source="", version="", reports=0, visuals=0):
    """The rows of one run → {name: {head, rows}} for runs, objects, visuals, usage, dependencies, findings and rules."""
    dk = now.year * 10000 + now.month * 100 + now.day
    key = {}
    objects = {"head": ["Key_Run", "Key_Date", "Key_Object", "Object id", "Object type", "Kind", "Table", "Name", "Label", "Status", "Status order",
                        "Hidden", "Broken", "Data type", "Display folder", "Description", "Expression", "Report", "Report uses", "Depends on", "Used by", "Rows", "Distinct values", "Size"], "rows": []}
    lst = [n for n in analysis["list"] if not n.get("system")]
    for n in lst:
        k = run * STEP + len(objects["rows"]) + 1
        key[n["id"]] = k
        status = STATUS[n["status"]]
        objects["rows"].append([run, dk, k, n["id"], cap(n["type"]), n["kind"], "" if n["type"] == "function" else n["table"], n["name"], label(n), status, STATUS_ORDER[status],
                                yn(n["hidden"]), yn(n["broken"]), n.get("dataType") or "", n.get("displayFolder") or "", n["description"] or "", n["expression"] or "", n.get("report") or "",
                                len(n["reportUses"]), len(n["deps"]), len(n["usedBy"]), "", "", ""])
    # fields that reports use but the model does not have; or, for reports whose model could not be read, every field
    noModel = analysis["stats"]["noModel"]
    gone = "Model not loaded" if noModel else "Not in model"
    missing = {}
    for u in analysis["broken"]:
        id_ = "X|" + jstr(u["table"]) + "|" + jstr(u["name"])
        if id_ in missing:
            continue
        k = run * STEP + len(objects["rows"]) + 1
        missing[id_] = k
        objects["rows"].append([run, dk, k, id_, "Missing", (u["kind"] or "field") if noModel else "missing " + (u["kind"] or "field"), u["table"], u["name"], jstr(u["table"]) + "[" + jstr(u["name"]) + "]", gone, STATUS_ORDER[gone],
                                "No", "No" if noModel else "Yes", "", "", "", "", "", "", "", "", "", "", ""])

    visuals_t = {"head": ["Key_Visual", "Report", "Page", "Visual", "Visual type", "Visual id"], "rows": []}
    vkey = {}
    usage = {"head": ["Key_Run", "Key_Date", "Key_Object", "Key_Visual", "Role"], "rows": []}

    def visualKey(u):
        id_ = jstr(u["report"]) + "|" + jstr(u["page"]) + "|" + jstr(u["visual"])
        if id_ not in vkey:
            k = run * STEP + len(visuals_t["rows"]) + 1
            vkey[id_] = k
            visuals_t["rows"].append([k, u["report"], u["page"], u["visualTitle"] or u["visualType"] or u["visual"], u["visualType"] or "", u["visual"]])
        return vkey[id_]

    for n in lst:
        for u in n["reportUses"]:
            usage["rows"].append([run, dk, key[n["id"]], visualKey(u), u["role"] or ""])
    for u in analysis["broken"]:
        usage["rows"].append([run, dk, missing["X|" + jstr(u["table"]) + "|" + jstr(u["name"])], visualKey(u), u["role"] or ""])

    dependencies = {"head": ["Key_Run", "Key_Date", "Key_Object", "Key_Depends_on", "Dependency kind"], "rows": []}
    for n in lst:
        for d in n["deps"]:
            if d in key:
                dependencies["rows"].append([run, dk, key[n["id"]], key[d], n["depKinds"].get(d) or "formula"])

    rules = {"head": ["Key_Rule", "Rule id", "Rule", "Group", "Severity", "Severity order", "Help"], "rows": []}
    findings = {"head": ["Key_Run", "Key_Date", "Key_Object", "Key_Rule", "Detail"], "rows": []}
    for r in (checks or {}).get("rules") or []:
        sev = SEVERITY.get(r["severity"]) or cap(r["severity"])
        rules["rows"].append([ruleKey(r["id"]), r["id"], r["title"], "Kimball" if r.get("group") == "kimball" else "General", sev, SEVERITY_ORDER.get(sev) or 9, r.get("help") or ""])
        for it in r["items"]:
            findings["rows"].append([run, dk, (key.get(it["id"]) if it["id"] else None) or -1, ruleKey(r["id"]),
                                     " — ".join(x for x in ("" if it["id"] else it["label"], it["detail"]) if x)])

    runs = {"head": ["Key_Run", "Run at", "Date", "Model", "Source", "Tool version", "Reports", "Visuals", "Has sizes"],
            "rows": [[run, stamp(now), stamp(now)[:10], model, source or "", version or "", reports or 0, visuals or 0, yn(analysis["stats"]["hasStats"])]]}
    return {"runs": runs, "objects": objects, "visuals": visuals_t, "usage": usage, "dependencies": dependencies, "findings": findings, "rules": rules}


def toCsv(table):
    """{head, rows} → text with a BOM, every value quoted, so Power Query and Excel read it as UTF-8."""
    q = lambda v: '"' + ("" if v is None else jstr(v)).replace('"', '""') + '"'
    return "\ufeff" + "\r\n".join(",".join(q(v) for v in r) for r in [table["head"]] + table["rows"])


def writeRun(folder, tables_for):
    """Adds a run to <folder>/data. tables_for(run) gives the tables for that run number. → (run, runFolder)"""
    data = os.path.join(folder, "data")
    os.makedirs(data, exist_ok=True)
    runs = [int(m.group(1)) for m in (re.fullmatch(r"run-([0-9]+)", n) for n in os.listdir(data)) if m]
    run = (max(runs) if runs else 0) + 1
    runFolder = os.path.join(data, "run-" + str(run).zfill(6))
    os.makedirs(runFolder)
    t = tables_for(run)
    for name in TABLES:
        with open(os.path.join(runFolder, name + ".csv"), "w", encoding="utf-8", errors="replace", newline="") as f:
            f.write(toCsv(t[name]))
    return run, runFolder


def analyzeProject(proj):
    """A loaded project → (analysis, checks) for its first model."""
    model = proj["models"][0]
    analysis = analyze(model["model"], proj["reports"], noModel=bool(model.get("missing")))
    return analysis, checkRules(model["model"], analysis)


def summary(name, analysis, checks):
    lst = [n for n in analysis["list"] if not n.get("system")]
    count = lambda f: len([n for n in lst if f(n)])
    return {"Model": name,
            "Measures": count(lambda n: n["type"] == "measure"), "Unused measures": count(lambda n: n["type"] == "measure" and n["status"] == "unused"),
            "Columns": count(lambda n: n["type"] == "column"), "Unused columns": count(lambda n: n["type"] == "column" and n["status"] == "unused"),
            "Broken formulas": count(lambda n: n["broken"]), "Errors": checks["counts"]["error"], "Warnings": checks["counts"]["warning"]}


# ---------------------------------------------------------------- Tables in the Lakehouse, and the Direct Lake report

# LAKEHOUSE-BEGIN (written by build-fabric.js from powerbi.js)
LAKEHOUSE_TABLES = [
    {"name":"Fact_Object","table":"smo_fact_object","file":"objects.csv","from":None,"dates":False,"columns":[{"name":"Key_Run","column":"key_run","type":"int64"},{"name":"Key_Date","column":"key_date","type":"int64"},{"name":"Key_Object","column":"key_object","type":"int64"},{"name":"Report uses","column":"report_uses","type":"int64"},{"name":"Depends on","column":"depends_on","type":"int64"},{"name":"Used by","column":"used_by","type":"int64"},{"name":"Rows","column":"rows","type":"int64"},{"name":"Distinct values","column":"distinct_values","type":"int64"},{"name":"Size","column":"size","type":"int64"}],"exclude":{"column":"Object type","not":"Missing"},"distinct":None,"none":None,"rename":None},
    {"name":"Fact_Usage","table":"smo_fact_usage","file":"usage.csv","from":None,"dates":False,"columns":[{"name":"Key_Run","column":"key_run","type":"int64"},{"name":"Key_Date","column":"key_date","type":"int64"},{"name":"Key_Object","column":"key_object","type":"int64"},{"name":"Key_Visual","column":"key_visual","type":"int64"},{"name":"Role","column":"role","type":"string"}],"exclude":None,"distinct":None,"none":None,"rename":None},
    {"name":"Fact_Dependency","table":"smo_fact_dependency","file":"dependencies.csv","from":None,"dates":False,"columns":[{"name":"Key_Run","column":"key_run","type":"int64"},{"name":"Key_Date","column":"key_date","type":"int64"},{"name":"Key_Object","column":"key_object","type":"int64"},{"name":"Key_Depends_on","column":"key_depends_on","type":"int64"},{"name":"Dependency kind","column":"dependency_kind","type":"string"}],"exclude":None,"distinct":None,"none":None,"rename":None},
    {"name":"Fact_Finding","table":"smo_fact_finding","file":"findings.csv","from":None,"dates":False,"columns":[{"name":"Key_Run","column":"key_run","type":"int64"},{"name":"Key_Date","column":"key_date","type":"int64"},{"name":"Key_Object","column":"key_object","type":"int64"},{"name":"Key_Rule","column":"key_rule","type":"int64"},{"name":"Detail","column":"detail","type":"string"}],"exclude":None,"distinct":None,"none":None,"rename":None},
    {"name":"Dim_Run","table":"smo_dim_run","file":"runs.csv","from":None,"dates":False,"columns":[{"name":"Key_Run","column":"key_run","type":"int64"},{"name":"Run at","column":"run_at","type":"dateTime"},{"name":"Date","column":"date","type":"date"},{"name":"Model","column":"model","type":"string"},{"name":"Source","column":"source","type":"string"},{"name":"Tool version","column":"tool_version","type":"string"},{"name":"Reports","column":"reports","type":"int64"},{"name":"Visuals","column":"visuals","type":"int64"},{"name":"Has sizes","column":"has_sizes","type":"string"}],"exclude":None,"distinct":None,"none":None,"rename":None},
    {"name":"Dim_Date","table":"smo_dim_date","file":None,"from":None,"dates":True,"columns":[{"name":"Key_Date","column":"key_date","type":"int64"},{"name":"Date","column":"date","type":"date"},{"name":"Year","column":"year","type":"int64"},{"name":"Month","column":"month","type":"string"}],"exclude":None,"distinct":None,"none":None,"rename":None},
    {"name":"Dim_Object","table":"smo_dim_object","file":"objects.csv","from":None,"dates":False,"columns":[{"name":"Key_Object","column":"key_object","type":"int64"},{"name":"Object id","column":"object_id","type":"string"},{"name":"Object type","column":"object_type","type":"string"},{"name":"Kind","column":"kind","type":"string"},{"name":"Table","column":"table","type":"string"},{"name":"Name","column":"name","type":"string"},{"name":"Label","column":"label","type":"string"},{"name":"Status","column":"status","type":"string"},{"name":"Status order","column":"status_order","type":"int64"},{"name":"Hidden","column":"hidden","type":"string"},{"name":"Broken","column":"broken","type":"string"},{"name":"Data type","column":"data_type","type":"string"},{"name":"Display folder","column":"display_folder","type":"string"},{"name":"Description","column":"description","type":"string"},{"name":"Expression","column":"expression","type":"string"},{"name":"Report","column":"report","type":"string"}],"exclude":None,"distinct":None,"none":{"Key_Object":-1,"Status order":9,"Object type":"Model","Kind":"model","Name":"(whole model)","Label":"(whole model)","Status":"(none)"},"rename":None},
    {"name":"Dim_Dependency","table":"smo_dim_dependency","file":None,"from":"Dim_Object","dates":False,"columns":[{"name":"Key_Depends_on","column":"key_depends_on","type":"int64"},{"name":"Depends on","column":"depends_on","type":"string"},{"name":"Depends on type","column":"depends_on_type","type":"string"},{"name":"Depends on kind","column":"depends_on_kind","type":"string"},{"name":"Depends on table","column":"depends_on_table","type":"string"},{"name":"Depends on status","column":"depends_on_status","type":"string"},{"name":"Depends on status order","column":"depends_on_status_order","type":"int64"}],"exclude":None,"distinct":None,"none":None,"rename":[["Key_Object","Key_Depends_on"],["Label","Depends on"],["Object type","Depends on type"],["Kind","Depends on kind"],["Table","Depends on table"],["Status","Depends on status"],["Status order","Depends on status order"]]},
    {"name":"Dim_Visual","table":"smo_dim_visual","file":"visuals.csv","from":None,"dates":False,"columns":[{"name":"Key_Visual","column":"key_visual","type":"int64"},{"name":"Report","column":"report","type":"string"},{"name":"Page","column":"page","type":"string"},{"name":"Visual","column":"visual","type":"string"},{"name":"Visual type","column":"visual_type","type":"string"},{"name":"Visual id","column":"visual_id","type":"string"}],"exclude":None,"distinct":None,"none":None,"rename":None},
    {"name":"Dim_Rule","table":"smo_dim_rule","file":"rules.csv","from":None,"dates":False,"columns":[{"name":"Key_Rule","column":"key_rule","type":"int64"},{"name":"Rule id","column":"rule_id","type":"string"},{"name":"Rule","column":"rule","type":"string"},{"name":"Group","column":"group","type":"string"},{"name":"Severity","column":"severity","type":"string"},{"name":"Severity order","column":"severity_order","type":"int64"},{"name":"Help","column":"help","type":"string"}],"exclude":None,"distinct":"Key_Rule","none":None,"rename":None},
]
DIRECT_LAKE_FILES = {
 "Semantic Model Optimizer.SemanticModel/definition.pbism": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json\",\n  \"version\": \"4.2\",\n  \"settings\": {}\n}\n",
 "Semantic Model Optimizer.SemanticModel/definition/database.tmdl": "database\n\tcompatibilityLevel: 1604\n",
 "Semantic Model Optimizer.SemanticModel/definition/model.tmdl": "model Model\n\tculture: en-US\n\tdefaultPowerBIDataSourceVersion: powerBI_V3\n\tsourceQueryCulture: en-US\n\tdiscourageImplicitMeasures\n\tdataAccessOptions\n\t\tlegacyRedirects\n\t\treturnErrorValuesAsNull\n\nannotation __PBI_TimeIntelligenceEnabled = 0\n\nannotation PBI_QueryOrder = [\"DatabaseQuery\",\"Fact_Object\",\"Fact_Usage\",\"Fact_Dependency\",\"Fact_Finding\",\"Dim_Run\",\"Dim_Date\",\"Dim_Object\",\"Dim_Dependency\",\"Dim_Visual\",\"Dim_Rule\"]\n\nref table Fact_Object\nref table Fact_Usage\nref table Fact_Dependency\nref table Fact_Finding\nref table Dim_Run\nref table Dim_Date\nref table Dim_Object\nref table Dim_Dependency\nref table Dim_Visual\nref table Dim_Rule\n",
 "Semantic Model Optimizer.SemanticModel/definition/expressions.tmdl": "/// The SQL analytics endpoint of the Lakehouse that holds the smo_ tables the notebook writes.\nexpression DatabaseQuery =\n\t\tlet\n\t\t    database = Sql.Database(\"{{SQL_SERVER}}\", \"{{SQL_DATABASE}}\")\n\t\tin\n\t\t    database\n\n\tannotation PBI_IncludeFutureArtifacts = False\n",
 "Semantic Model Optimizer.SemanticModel/definition/relationships.tmdl": "relationship 141027a1-0b57-4427-89bf-6b7d9a4002d1\n\tfromColumn: Fact_Object.Key_Run\n\ttoColumn: Dim_Run.Key_Run\n\nrelationship 0fdd5900-7e59-4f7a-8802-bb7c5acbcef0\n\tfromColumn: Fact_Object.Key_Date\n\ttoColumn: Dim_Date.Key_Date\n\nrelationship b92a1eb3-8e0c-4d2d-8381-b4bfc426b5a3\n\tfromColumn: Fact_Object.Key_Object\n\ttoColumn: Dim_Object.Key_Object\n\nrelationship 8b212233-bd1c-4985-8c65-3d478be102e3\n\tfromColumn: Fact_Usage.Key_Run\n\ttoColumn: Dim_Run.Key_Run\n\nrelationship 84be3e36-12ea-48e4-8b78-7a1a196c7466\n\tfromColumn: Fact_Usage.Key_Date\n\ttoColumn: Dim_Date.Key_Date\n\nrelationship 3cce7289-ba20-4ae7-8a09-61cda9d97539\n\tfromColumn: Fact_Usage.Key_Object\n\ttoColumn: Dim_Object.Key_Object\n\nrelationship 808d887e-94da-4e2c-8ba1-5c327e43e1ae\n\tfromColumn: Fact_Usage.Key_Visual\n\ttoColumn: Dim_Visual.Key_Visual\n\nrelationship f16d5b1f-651f-47f1-82d1-188baf6a3d6f\n\tfromColumn: Fact_Dependency.Key_Run\n\ttoColumn: Dim_Run.Key_Run\n\nrelationship 36f7e232-97f9-4b90-828b-fc8e52557c02\n\tfromColumn: Fact_Dependency.Key_Date\n\ttoColumn: Dim_Date.Key_Date\n\nrelationship 68bcbc85-eac4-4643-8a8a-4d61b735cfd5\n\tfromColumn: Fact_Dependency.Key_Object\n\ttoColumn: Dim_Object.Key_Object\n\nrelationship 5fd02463-af66-4ecd-825e-1cf7ca31afb3\n\tfromColumn: Fact_Dependency.Key_Depends_on\n\ttoColumn: Dim_Dependency.Key_Depends_on\n\nrelationship eb7c29c1-ce8c-46a3-86de-c235ff2199b1\n\tfromColumn: Fact_Finding.Key_Run\n\ttoColumn: Dim_Run.Key_Run\n\nrelationship 0ee5dfa0-3667-4626-8556-4f1463396b50\n\tfromColumn: Fact_Finding.Key_Date\n\ttoColumn: Dim_Date.Key_Date\n\nrelationship 5d462053-c32e-44f9-8a0e-2ad756485b03\n\tfromColumn: Fact_Finding.Key_Object\n\ttoColumn: Dim_Object.Key_Object\n\nrelationship 8c7161da-f90a-49c4-84a7-53de69e098aa\n\tfromColumn: Fact_Finding.Key_Rule\n\ttoColumn: Dim_Rule.Key_Rule\n",
 "Semantic Model Optimizer.SemanticModel/definition/tables/Fact_Object.tmdl": "/// One row per table, column, measure and function of the model, per run.\ntable Fact_Object\n\n\t/// Tables, columns, measures and functions in the latest run of each model.\n\tmeasure Objects =\n\t\t\tVAR _runs =\n\t\t\t    SELECTCOLUMNS (\n\t\t\t        ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t        \"@run\", [@run]\n\t\t\t    )\n\t\t\tRETURN\n\t\t\t    CALCULATE ( COUNTROWS ( Fact_Object ), TREATAS ( _runs, Dim_Run[Key_Run] ) )\n\t\tformatString: #,0\n\n\t/// Measures in the model and in reports.\n\tmeasure Measures =\n\t\t\tIF (\n\t\t\t    NOT ISBLANK ( [Objects] ),\n\t\t\t    (\n\t\t\t        VAR _runs =\n\t\t\t            SELECTCOLUMNS (\n\t\t\t                ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t                \"@run\", [@run]\n\t\t\t            )\n\t\t\t        RETURN\n\t\t\t            CALCULATE ( CALCULATE ( COUNTROWS ( Fact_Object ), Dim_Object[Object type] = \"Measure\" ), TREATAS ( _runs, Dim_Run[Key_Run] ) )\n\t\t\t    ) + 0\n\t\t\t)\n\t\tformatString: #,0\n\n\t/// Measures that no report, measure or other part of the model uses.\n\tmeasure 'Unused measures' =\n\t\t\tIF (\n\t\t\t    NOT ISBLANK ( [Objects] ),\n\t\t\t    (\n\t\t\t        VAR _runs =\n\t\t\t            SELECTCOLUMNS (\n\t\t\t                ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t                \"@run\", [@run]\n\t\t\t            )\n\t\t\t        RETURN\n\t\t\t            CALCULATE ( CALCULATE ( COUNTROWS ( Fact_Object ), Dim_Object[Object type] = \"Measure\", Dim_Object[Status] = \"Unused\" ), TREATAS ( _runs, Dim_Run[Key_Run] ) )\n\t\t\t    ) + 0\n\t\t\t)\n\t\tformatString: #,0\n\n\t/// Columns, including calculated columns.\n\tmeasure Columns =\n\t\t\tIF (\n\t\t\t    NOT ISBLANK ( [Objects] ),\n\t\t\t    (\n\t\t\t        VAR _runs =\n\t\t\t            SELECTCOLUMNS (\n\t\t\t                ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t                \"@run\", [@run]\n\t\t\t            )\n\t\t\t        RETURN\n\t\t\t            CALCULATE ( CALCULATE ( COUNTROWS ( Fact_Object ), Dim_Object[Object type] = \"Column\" ), TREATAS ( _runs, Dim_Run[Key_Run] ) )\n\t\t\t    ) + 0\n\t\t\t)\n\t\tformatString: #,0\n\n\t/// Columns that no report, formula, relationship, hierarchy, role or query uses.\n\tmeasure 'Unused columns' =\n\t\t\tIF (\n\t\t\t    NOT ISBLANK ( [Objects] ),\n\t\t\t    (\n\t\t\t        VAR _runs =\n\t\t\t            SELECTCOLUMNS (\n\t\t\t                ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t                \"@run\", [@run]\n\t\t\t            )\n\t\t\t        RETURN\n\t\t\t            CALCULATE ( CALCULATE ( COUNTROWS ( Fact_Object ), Dim_Object[Object type] = \"Column\", Dim_Object[Status] = \"Unused\" ), TREATAS ( _runs, Dim_Run[Key_Run] ) )\n\t\t\t    ) + 0\n\t\t\t)\n\t\tformatString: #,0\n\n\t/// Tables, including calculated tables.\n\tmeasure Tables =\n\t\t\tIF (\n\t\t\t    NOT ISBLANK ( [Objects] ),\n\t\t\t    (\n\t\t\t        VAR _runs =\n\t\t\t            SELECTCOLUMNS (\n\t\t\t                ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t                \"@run\", [@run]\n\t\t\t            )\n\t\t\t        RETURN\n\t\t\t            CALCULATE ( CALCULATE ( COUNTROWS ( Fact_Object ), Dim_Object[Object type] = \"Table\" ), TREATAS ( _runs, Dim_Run[Key_Run] ) )\n\t\t\t    ) + 0\n\t\t\t)\n\t\tformatString: #,0\n\n\t/// Tables of which nothing is used.\n\tmeasure 'Unused tables' =\n\t\t\tIF (\n\t\t\t    NOT ISBLANK ( [Objects] ),\n\t\t\t    (\n\t\t\t        VAR _runs =\n\t\t\t            SELECTCOLUMNS (\n\t\t\t                ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t                \"@run\", [@run]\n\t\t\t            )\n\t\t\t        RETURN\n\t\t\t            CALCULATE ( CALCULATE ( COUNTROWS ( Fact_Object ), Dim_Object[Object type] = \"Table\", Dim_Object[Status] = \"Unused\" ), TREATAS ( _runs, Dim_Run[Key_Run] ) )\n\t\t\t    ) + 0\n\t\t\t)\n\t\tformatString: #,0\n\n\t/// Formulas that refer to something that does not exist, or depend on such a formula.\n\tmeasure 'Broken formulas' =\n\t\t\tIF (\n\t\t\t    NOT ISBLANK ( [Objects] ),\n\t\t\t    (\n\t\t\t        VAR _runs =\n\t\t\t            SELECTCOLUMNS (\n\t\t\t                ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t                \"@run\", [@run]\n\t\t\t            )\n\t\t\t        RETURN\n\t\t\t            CALCULATE ( CALCULATE ( COUNTROWS ( Fact_Object ), Dim_Object[Broken] = \"Yes\" ), TREATAS ( _runs, Dim_Run[Key_Run] ) )\n\t\t\t    ) + 0\n\t\t\t)\n\t\tformatString: #,0\n\n\t/// Unused measures and columns as a share of all measures and columns.\n\tmeasure 'Unused share' =\n\t\t\tDIVIDE ( [Unused measures] + [Unused columns], [Measures] + [Columns] )\n\t\tformatString: 0.0%\n\n\t/// How often the object is a field in a visual or filter.\n\tmeasure 'Uses in reports' =\n\t\t\tVAR _runs =\n\t\t\t    SELECTCOLUMNS (\n\t\t\t        ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t        \"@run\", [@run]\n\t\t\t    )\n\t\t\tRETURN\n\t\t\t    CALCULATE ( SUM ( Fact_Object[Report uses] ), TREATAS ( _runs, Dim_Run[Key_Run] ) )\n\t\tformatString: #,0\n\n\t/// How many measures, columns and tables refer to the object directly.\n\tmeasure 'Used by objects' =\n\t\t\tVAR _runs =\n\t\t\t    SELECTCOLUMNS (\n\t\t\t        ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t        \"@run\", [@run]\n\t\t\t    )\n\t\t\tRETURN\n\t\t\t    CALCULATE ( SUM ( Fact_Object[Used by] ), TREATAS ( _runs, Dim_Run[Key_Run] ) )\n\t\tformatString: #,0\n\n\t/// Memory used, in megabytes. Only when the run had sizes.\n\tmeasure 'Size (MB)' =\n\t\t\tVAR _runs =\n\t\t\t    SELECTCOLUMNS (\n\t\t\t        ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t        \"@run\", [@run]\n\t\t\t    )\n\t\t\tRETURN\n\t\t\t    CALCULATE ( SUM ( Fact_Object[Size] ), TREATAS ( _runs, Dim_Run[Key_Run] ) ) / 1000000\n\t\tformatString: #,0.0\n\n\t/// Only when the run had sizes (a .vpax or the model in Power BI Desktop).\n\tmeasure 'Model size (MB)' =\n\t\t\tVAR _runs =\n\t\t\t    SELECTCOLUMNS (\n\t\t\t        ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t        \"@run\", [@run]\n\t\t\t    )\n\t\t\tRETURN\n\t\t\t    CALCULATE ( CALCULATE ( SUM ( Fact_Object[Size] ), Dim_Object[Object type] = \"Table\" ), TREATAS ( _runs, Dim_Run[Key_Run] ) ) / 1000000\n\t\tformatString: #,0.0\n\n\t/// Memory used by columns nothing uses.\n\tmeasure 'Unused size (MB)' =\n\t\t\tVAR _runs =\n\t\t\t    SELECTCOLUMNS (\n\t\t\t        ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t        \"@run\", [@run]\n\t\t\t    )\n\t\t\tRETURN\n\t\t\t    CALCULATE ( CALCULATE ( SUM ( Fact_Object[Size] ), Dim_Object[Object type] = \"Column\", Dim_Object[Status] = \"Unused\" ), TREATAS ( _runs, Dim_Run[Key_Run] ) ) / 1000000\n\t\tformatString: #,0.0\n\n\tcolumn Key_Run\n\t\tdataType: int64\n\t\tisHidden\n\t\tisNullable: false\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_run\n\n\tcolumn Key_Date\n\t\tdataType: int64\n\t\tisHidden\n\t\tisNullable: false\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_date\n\n\tcolumn Key_Object\n\t\tdataType: int64\n\t\tisHidden\n\t\tisNullable: false\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_object\n\n\tcolumn 'Report uses'\n\t\tdataType: int64\n\t\tisHidden\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: report_uses\n\n\tcolumn 'Depends on'\n\t\tdataType: int64\n\t\tisHidden\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: depends_on\n\n\tcolumn 'Used by'\n\t\tdataType: int64\n\t\tisHidden\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: used_by\n\n\tcolumn Rows\n\t\tdataType: int64\n\t\tisHidden\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: rows\n\n\tcolumn 'Distinct values'\n\t\tdataType: int64\n\t\tisHidden\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: distinct_values\n\n\t/// Bytes in memory, from a VertiPaq export (.vpax) or Power BI Desktop.\n\tcolumn Size\n\t\tdataType: int64\n\t\tisHidden\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: size\n\n\tpartition Fact_Object = entity\n\t\tmode: directLake\n\t\tsource\n\t\t\tentityName: smo_fact_object\n\t\t\tschemaName: dbo\n\t\t\texpressionSource: DatabaseQuery\n",
 "Semantic Model Optimizer.SemanticModel/definition/tables/Fact_Usage.tmdl": "/// One row per field in a visual or filter of a report, per run.\ntable Fact_Usage\n\n\t/// Fields in visuals and filters.\n\tmeasure 'Field uses' =\n\t\t\tVAR _runs =\n\t\t\t    SELECTCOLUMNS (\n\t\t\t        ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t        \"@run\", [@run]\n\t\t\t    )\n\t\t\tRETURN\n\t\t\t    CALCULATE ( COUNTROWS ( Fact_Usage ), TREATAS ( _runs, Dim_Run[Key_Run] ) )\n\t\tformatString: #,0\n\n\t/// Visuals that use at least one field.\n\tmeasure Visuals =\n\t\t\tVAR _runs =\n\t\t\t    SELECTCOLUMNS (\n\t\t\t        ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t        \"@run\", [@run]\n\t\t\t    )\n\t\t\tRETURN\n\t\t\t    CALCULATE ( DISTINCTCOUNT ( Fact_Usage[Key_Visual] ), TREATAS ( _runs, Dim_Run[Key_Run] ) )\n\t\tformatString: #,0\n\n\t/// Reports in which the measure or column is used.\n\tmeasure 'Reports using it' =\n\t\t\tVAR _runs =\n\t\t\t    SELECTCOLUMNS (\n\t\t\t        ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t        \"@run\", [@run]\n\t\t\t    )\n\t\t\tRETURN\n\t\t\t    CALCULATE ( COUNTROWS ( SUMMARIZE ( Fact_Usage, Dim_Visual[Report] ) ), TREATAS ( _runs, Dim_Run[Key_Run] ) )\n\t\tformatString: #,0\n\n\tcolumn Key_Run\n\t\tdataType: int64\n\t\tisHidden\n\t\tisNullable: false\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_run\n\n\tcolumn Key_Date\n\t\tdataType: int64\n\t\tisHidden\n\t\tisNullable: false\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_date\n\n\tcolumn Key_Object\n\t\tdataType: int64\n\t\tisHidden\n\t\tisNullable: false\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_object\n\n\tcolumn Key_Visual\n\t\tdataType: int64\n\t\tisHidden\n\t\tisNullable: false\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_visual\n\n\t/// Where the field sits in the visual, for example Values, Category or Filters.\n\tcolumn Role\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: role\n\n\tpartition Fact_Usage = entity\n\t\tmode: directLake\n\t\tsource\n\t\t\tentityName: smo_fact_usage\n\t\t\tschemaName: dbo\n\t\t\texpressionSource: DatabaseQuery\n",
 "Semantic Model Optimizer.SemanticModel/definition/tables/Fact_Dependency.tmdl": "/// One row per object that an object refers to directly, per run.\ntable Fact_Dependency\n\n\t/// Direct references from one object to another.\n\tmeasure Dependencies =\n\t\t\tVAR _runs =\n\t\t\t    SELECTCOLUMNS (\n\t\t\t        ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t        \"@run\", [@run]\n\t\t\t    )\n\t\t\tRETURN\n\t\t\t    CALCULATE ( COUNTROWS ( Fact_Dependency ), TREATAS ( _runs, Dim_Run[Key_Run] ) )\n\t\tformatString: #,0\n\n\tcolumn Key_Run\n\t\tdataType: int64\n\t\tisHidden\n\t\tisNullable: false\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_run\n\n\tcolumn Key_Date\n\t\tdataType: int64\n\t\tisHidden\n\t\tisNullable: false\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_date\n\n\tcolumn Key_Object\n\t\tdataType: int64\n\t\tisHidden\n\t\tisNullable: false\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_object\n\n\tcolumn Key_Depends_on\n\t\tdataType: int64\n\t\tisHidden\n\t\tisNullable: false\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_depends_on\n\n\tcolumn 'Dependency kind'\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: dependency_kind\n\n\tpartition Fact_Dependency = entity\n\t\tmode: directLake\n\t\tsource\n\t\t\tentityName: smo_fact_dependency\n\t\t\tschemaName: dbo\n\t\t\texpressionSource: DatabaseQuery\n",
 "Semantic Model Optimizer.SemanticModel/definition/tables/Fact_Finding.tmdl": "/// One row per finding of a rule, per run.\ntable Fact_Finding\n\n\t/// Findings of the best-practice and Kimball checks.\n\tmeasure Findings =\n\t\t\tVAR _runs =\n\t\t\t    SELECTCOLUMNS (\n\t\t\t        ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t        \"@run\", [@run]\n\t\t\t    )\n\t\t\tRETURN\n\t\t\t    CALCULATE ( COUNTROWS ( Fact_Finding ), TREATAS ( _runs, Dim_Run[Key_Run] ) )\n\t\tformatString: #,0\n\n\t/// Findings that break the model or a report.\n\tmeasure Errors =\n\t\t\tIF (\n\t\t\t    NOT ISBLANK ( [Objects] ),\n\t\t\t    (\n\t\t\t        VAR _runs =\n\t\t\t            SELECTCOLUMNS (\n\t\t\t                ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t                \"@run\", [@run]\n\t\t\t            )\n\t\t\t        RETURN\n\t\t\t            CALCULATE ( CALCULATE ( COUNTROWS ( Fact_Finding ), Dim_Rule[Severity] = \"Error\" ), TREATAS ( _runs, Dim_Run[Key_Run] ) )\n\t\t\t    ) + 0\n\t\t\t)\n\t\tformatString: #,0\n\n\t/// Findings that are probably wrong or costly.\n\tmeasure Warnings =\n\t\t\tIF (\n\t\t\t    NOT ISBLANK ( [Objects] ),\n\t\t\t    (\n\t\t\t        VAR _runs =\n\t\t\t            SELECTCOLUMNS (\n\t\t\t                ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t                \"@run\", [@run]\n\t\t\t            )\n\t\t\t        RETURN\n\t\t\t            CALCULATE ( CALCULATE ( COUNTROWS ( Fact_Finding ), Dim_Rule[Severity] = \"Warning\" ), TREATAS ( _runs, Dim_Run[Key_Run] ) )\n\t\t\t    ) + 0\n\t\t\t)\n\t\tformatString: #,0\n\n\t/// Findings worth a look.\n\tmeasure Notes =\n\t\t\tIF (\n\t\t\t    NOT ISBLANK ( [Objects] ),\n\t\t\t    (\n\t\t\t        VAR _runs =\n\t\t\t            SELECTCOLUMNS (\n\t\t\t                ADDCOLUMNS ( VALUES ( Dim_Run[Model] ), \"@run\", CALCULATE ( MAX ( Fact_Object[Key_Run] ), REMOVEFILTERS ( Dim_Object ) ) ),\n\t\t\t                \"@run\", [@run]\n\t\t\t            )\n\t\t\t        RETURN\n\t\t\t            CALCULATE ( CALCULATE ( COUNTROWS ( Fact_Finding ), Dim_Rule[Severity] = \"Note\" ), TREATAS ( _runs, Dim_Run[Key_Run] ) )\n\t\t\t    ) + 0\n\t\t\t)\n\t\tformatString: #,0\n\n\tcolumn Key_Run\n\t\tdataType: int64\n\t\tisHidden\n\t\tisNullable: false\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_run\n\n\tcolumn Key_Date\n\t\tdataType: int64\n\t\tisHidden\n\t\tisNullable: false\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_date\n\n\tcolumn Key_Object\n\t\tdataType: int64\n\t\tisHidden\n\t\tisNullable: false\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_object\n\n\tcolumn Key_Rule\n\t\tdataType: int64\n\t\tisHidden\n\t\tisNullable: false\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_rule\n\n\tcolumn Detail\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: detail\n\n\tpartition Fact_Finding = entity\n\t\tmode: directLake\n\t\tsource\n\t\t\tentityName: smo_fact_finding\n\t\t\tschemaName: dbo\n\t\t\texpressionSource: DatabaseQuery\n",
 "Semantic Model Optimizer.SemanticModel/definition/tables/Dim_Run.tmdl": "/// One row per export: when, which model, from where.\ntable Dim_Run\n\n\tcolumn Key_Run\n\t\tdataType: int64\n\t\tisHidden\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_run\n\n\tcolumn 'Run at'\n\t\tdataType: dateTime\n\t\tformatString: yyyy-mm-dd hh:nn\n\t\tsummarizeBy: none\n\t\tsourceColumn: run_at\n\n\tcolumn Date\n\t\tdataType: dateTime\n\t\tisHidden\n\t\tformatString: yyyy-mm-dd\n\t\tsummarizeBy: none\n\t\tsourceColumn: date\n\n\t\tannotation UnderlyingDateTimeDataType = Date\n\n\tcolumn Model\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: model\n\n\tcolumn Source\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: source\n\n\tcolumn 'Tool version'\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: tool_version\n\n\tcolumn Reports\n\t\tdataType: int64\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: reports\n\n\tcolumn Visuals\n\t\tdataType: int64\n\t\tisHidden\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: visuals\n\n\tcolumn 'Has sizes'\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: has_sizes\n\n\tpartition Dim_Run = entity\n\t\tmode: directLake\n\t\tsource\n\t\t\tentityName: smo_dim_run\n\t\t\tschemaName: dbo\n\t\t\texpressionSource: DatabaseQuery\n",
 "Semantic Model Optimizer.SemanticModel/definition/tables/Dim_Date.tmdl": "/// One row per day from the first to the last run.\ntable Dim_Date\n\tdataCategory: Time\n\n\tcolumn Key_Date\n\t\tdataType: int64\n\t\tisHidden\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_date\n\n\tcolumn Date\n\t\tdataType: dateTime\n\t\tformatString: yyyy-mm-dd\n\t\tsummarizeBy: none\n\t\tsourceColumn: date\n\n\t\tannotation UnderlyingDateTimeDataType = Date\n\n\tcolumn Year\n\t\tdataType: int64\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: year\n\n\tcolumn Month\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: month\n\n\tpartition Dim_Date = entity\n\t\tmode: directLake\n\t\tsource\n\t\t\tentityName: smo_dim_date\n\t\t\tschemaName: dbo\n\t\t\texpressionSource: DatabaseQuery\n",
 "Semantic Model Optimizer.SemanticModel/definition/tables/Dim_Object.tmdl": "/// One row per object per run, plus the row -1 (whole model) for findings about the model as a whole.\ntable Dim_Object\n\n\tcolumn Key_Object\n\t\tdataType: int64\n\t\tisHidden\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_object\n\n\t/// Stable name of the object: type, table and name. The same in every run.\n\tcolumn 'Object id'\n\t\tdataType: string\n\t\tisHidden\n\t\tsummarizeBy: none\n\t\tsourceColumn: object_id\n\n\t/// Table, Column, Measure, Function, or Missing for a field a report uses that is not in the model.\n\tcolumn 'Object type'\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: object_type\n\n\tcolumn Kind\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: kind\n\n\tcolumn Table\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: table\n\n\tcolumn Name\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: name\n\n\t/// Table[Column], [Measure] or Table.\n\tcolumn Label\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: label\n\n\t/// In report, Used indirectly (needed by something in a report), Model only (relationship, RLS, hierarchy, query) or Unused.\n\tcolumn Status\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: status\n\t\tsortByColumn: 'Status order'\n\n\tcolumn 'Status order'\n\t\tdataType: int64\n\t\tisHidden\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: status_order\n\n\tcolumn Hidden\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: hidden\n\n\tcolumn Broken\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: broken\n\n\tcolumn 'Data type'\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: data_type\n\n\tcolumn 'Display folder'\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: display_folder\n\n\tcolumn Description\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: description\n\n\tcolumn Expression\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: expression\n\n\t/// For a measure made in a report: that report.\n\tcolumn Report\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: report\n\n\tpartition Dim_Object = entity\n\t\tmode: directLake\n\t\tsource\n\t\t\tentityName: smo_dim_object\n\t\t\tschemaName: dbo\n\t\t\texpressionSource: DatabaseQuery\n",
 "Semantic Model Optimizer.SemanticModel/definition/tables/Dim_Dependency.tmdl": "/// Dim_Object in the role \"depends on\": the object the other one refers to.\ntable Dim_Dependency\n\n\tcolumn Key_Depends_on\n\t\tdataType: int64\n\t\tisHidden\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_depends_on\n\n\tcolumn 'Depends on'\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: depends_on\n\n\tcolumn 'Depends on type'\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: depends_on_type\n\n\tcolumn 'Depends on kind'\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: depends_on_kind\n\n\tcolumn 'Depends on table'\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: depends_on_table\n\n\tcolumn 'Depends on status'\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: depends_on_status\n\t\tsortByColumn: 'Depends on status order'\n\n\tcolumn 'Depends on status order'\n\t\tdataType: int64\n\t\tisHidden\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: depends_on_status_order\n\n\tpartition Dim_Dependency = entity\n\t\tmode: directLake\n\t\tsource\n\t\t\tentityName: smo_dim_dependency\n\t\t\tschemaName: dbo\n\t\t\texpressionSource: DatabaseQuery\n",
 "Semantic Model Optimizer.SemanticModel/definition/tables/Dim_Visual.tmdl": "/// One row per visual of a report, per run.\ntable Dim_Visual\n\n\tcolumn Key_Visual\n\t\tdataType: int64\n\t\tisHidden\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_visual\n\n\tcolumn Report\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: report\n\n\tcolumn Page\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: page\n\n\tcolumn Visual\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: visual\n\n\tcolumn 'Visual type'\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: visual_type\n\n\tcolumn 'Visual id'\n\t\tdataType: string\n\t\tisHidden\n\t\tsummarizeBy: none\n\t\tsourceColumn: visual_id\n\n\tpartition Dim_Visual = entity\n\t\tmode: directLake\n\t\tsource\n\t\t\tentityName: smo_dim_visual\n\t\t\tschemaName: dbo\n\t\t\texpressionSource: DatabaseQuery\n",
 "Semantic Model Optimizer.SemanticModel/definition/tables/Dim_Rule.tmdl": "/// One row per rule of the checks.\ntable Dim_Rule\n\n\tcolumn Key_Rule\n\t\tdataType: int64\n\t\tisHidden\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: key_rule\n\n\tcolumn 'Rule id'\n\t\tdataType: string\n\t\tisHidden\n\t\tsummarizeBy: none\n\t\tsourceColumn: rule_id\n\n\tcolumn Rule\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: rule\n\n\tcolumn Group\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: group\n\n\tcolumn Severity\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: severity\n\t\tsortByColumn: 'Severity order'\n\n\tcolumn 'Severity order'\n\t\tdataType: int64\n\t\tisHidden\n\t\tformatString: 0\n\t\tsummarizeBy: none\n\t\tsourceColumn: severity_order\n\n\tcolumn Help\n\t\tdataType: string\n\t\tsummarizeBy: none\n\t\tsourceColumn: help\n\n\tpartition Dim_Rule = entity\n\t\tmode: directLake\n\t\tsource\n\t\t\tentityName: smo_dim_rule\n\t\t\tschemaName: dbo\n\t\t\texpressionSource: DatabaseQuery\n",
 "Semantic Model Optimizer.Report/definition/version.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/versionMetadata/1.0.0/schema.json\",\n  \"version\": \"2.0.0\"\n}\n",
 "Semantic Model Optimizer.Report/definition/report.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/report/3.3.0/schema.json\",\n  \"themeCollection\": {\n    \"customTheme\": {\n      \"name\": \"SemanticModelOptimizer.json\",\n      \"reportVersionAtImport\": {\n        \"visual\": \"2.4.0\",\n        \"report\": \"3.3.0\",\n        \"page\": \"2.1.0\"\n      },\n      \"type\": \"RegisteredResources\"\n    }\n  },\n  \"resourcePackages\": [\n    {\n      \"name\": \"RegisteredResources\",\n      \"type\": \"RegisteredResources\",\n      \"items\": [\n        {\n          \"name\": \"SemanticModelOptimizer.json\",\n          \"path\": \"SemanticModelOptimizer.json\",\n          \"type\": \"CustomTheme\"\n        }\n      ]\n    }\n  ],\n  \"settings\": {\n    \"useStylableVisualContainerHeader\": true,\n    \"exportDataMode\": \"AllowSummarized\",\n    \"defaultDrillFilterOtherVisuals\": true,\n    \"allowChangeFilterTypes\": true,\n    \"useEnhancedTooltips\": true,\n    \"useDefaultAggregateDisplayName\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/StaticResources/RegisteredResources/SemanticModelOptimizer.json": "{\n  \"name\": \"Semantic Model Optimizer\",\n  \"dataColors\": [\n    \"#5DA5DA\",\n    \"#FAA43A\",\n    \"#60BD68\",\n    \"#F17CB0\",\n    \"#B2912F\",\n    \"#B276B2\",\n    \"#DECF3F\",\n    \"#F15854\",\n    \"#4D4D4D\"\n  ],\n  \"background\": \"#FFFFFF\",\n  \"foreground\": \"#333333\",\n  \"tableAccent\": \"#5DA5DA\",\n  \"textClasses\": {\n    \"title\": {\n      \"fontFace\": \"Segoe UI Semibold\",\n      \"fontSize\": 11,\n      \"color\": \"#333333\"\n    },\n    \"label\": {\n      \"fontFace\": \"Segoe UI\",\n      \"fontSize\": 9,\n      \"color\": \"#6B6B6B\"\n    },\n    \"callout\": {\n      \"fontFace\": \"Segoe UI Light\",\n      \"fontSize\": 24,\n      \"color\": \"#333333\"\n    }\n  },\n  \"visualStyles\": {\n    \"page\": {\n      \"*\": {\n        \"background\": [\n          {\n            \"color\": {\n              \"solid\": {\n                \"color\": \"#F2F2F2\"\n              }\n            },\n            \"transparency\": 0\n          }\n        ],\n        \"outspace\": [\n          {\n            \"color\": {\n              \"solid\": {\n                \"color\": \"#F2F2F2\"\n              }\n            },\n            \"transparency\": 0\n          }\n        ]\n      }\n    },\n    \"*\": {\n      \"*\": {\n        \"background\": [\n          {\n            \"show\": true,\n            \"color\": {\n              \"solid\": {\n                \"color\": \"#FFFFFF\"\n              }\n            },\n            \"transparency\": 0\n          }\n        ],\n        \"border\": [\n          {\n            \"show\": false\n          }\n        ],\n        \"dropShadow\": [\n          {\n            \"show\": false\n          }\n        ],\n        \"title\": [\n          {\n            \"show\": true,\n            \"fontFamily\": \"Segoe UI Semibold\",\n            \"fontSize\": 11,\n            \"fontColor\": {\n              \"solid\": {\n                \"color\": \"#333333\"\n              }\n            },\n            \"alignment\": \"left\"\n          }\n        ],\n        \"padding\": [\n          {\n            \"top\": 8,\n            \"bottom\": 8,\n            \"left\": 12,\n            \"right\": 12\n          }\n        ],\n        \"valueAxis\": [\n          {\n            \"gridlineShow\": false,\n            \"showAxisTitle\": false,\n            \"labelColor\": {\n              \"solid\": {\n                \"color\": \"#6B6B6B\"\n              }\n            },\n            \"fontSize\": 9\n          }\n        ],\n        \"categoryAxis\": [\n          {\n            \"gridlineShow\": false,\n            \"showAxisTitle\": false,\n            \"labelColor\": {\n              \"solid\": {\n                \"color\": \"#6B6B6B\"\n              }\n            },\n            \"fontSize\": 9\n          }\n        ],\n        \"legend\": [\n          {\n            \"position\": \"TopLeft\",\n            \"showTitle\": false,\n            \"labelColor\": {\n              \"solid\": {\n                \"color\": \"#6B6B6B\"\n              }\n            },\n            \"fontSize\": 9\n          }\n        ],\n        \"labels\": [\n          {\n            \"color\": {\n              \"solid\": {\n                \"color\": \"#6B6B6B\"\n              }\n            },\n            \"fontSize\": 9\n          }\n        ]\n      }\n    },\n    \"card\": {\n      \"*\": {\n        \"labels\": [\n          {\n            \"color\": {\n              \"solid\": {\n                \"color\": \"#333333\"\n              }\n            },\n            \"fontSize\": 24,\n            \"fontFamily\": \"Segoe UI Light\"\n          }\n        ],\n        \"categoryLabels\": [\n          {\n            \"show\": true,\n            \"color\": {\n              \"solid\": {\n                \"color\": \"#6B6B6B\"\n              }\n            },\n            \"fontSize\": 9\n          }\n        ]\n      }\n    },\n    \"lineChart\": {\n      \"*\": {\n        \"lineStyles\": [\n          {\n            \"strokeWidth\": 2,\n            \"showMarker\": false\n          }\n        ]\n      }\n    },\n    \"tableEx\": {\n      \"*\": {\n        \"grid\": [\n          {\n            \"gridVertical\": false,\n            \"gridHorizontal\": true,\n            \"gridHorizontalColor\": {\n              \"solid\": {\n                \"color\": \"#E3E3E3\"\n              }\n            },\n            \"gridHorizontalWeight\": 1,\n            \"outlineColor\": {\n              \"solid\": {\n                \"color\": \"#E3E3E3\"\n              }\n            },\n            \"rowPadding\": 3\n          }\n        ],\n        \"columnHeaders\": [\n          {\n            \"fontColor\": {\n              \"solid\": {\n                \"color\": \"#333333\"\n              }\n            },\n            \"backColor\": {\n              \"solid\": {\n                \"color\": \"#FFFFFF\"\n              }\n            },\n            \"fontSize\": 9,\n            \"fontFamily\": \"Segoe UI Semibold\",\n            \"outline\": \"BottomOnly\"\n          }\n        ],\n        \"values\": [\n          {\n            \"fontColorPrimary\": {\n              \"solid\": {\n                \"color\": \"#333333\"\n              }\n            },\n            \"fontColorSecondary\": {\n              \"solid\": {\n                \"color\": \"#333333\"\n              }\n            },\n            \"backColorPrimary\": {\n              \"solid\": {\n                \"color\": \"#FFFFFF\"\n              }\n            },\n            \"backColorSecondary\": {\n              \"solid\": {\n                \"color\": \"#FFFFFF\"\n              }\n            },\n            \"fontSize\": 9,\n            \"outline\": \"None\"\n          }\n        ],\n        \"total\": [\n          {\n            \"totals\": false\n          }\n        ]\n      }\n    },\n    \"slicer\": {\n      \"*\": {\n        \"items\": [\n          {\n            \"fontColor\": {\n              \"solid\": {\n                \"color\": \"#333333\"\n              }\n            },\n            \"fontSize\": 9\n          }\n        ],\n        \"padding\": [\n          {\n            \"top\": 4,\n            \"bottom\": 4,\n            \"left\": 12,\n            \"right\": 12\n          }\n        ]\n      }\n    },\n    \"textbox\": {\n      \"*\": {\n        \"background\": [\n          {\n            \"show\": false\n          }\n        ]\n      }\n    }\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/pages.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.1.0/schema.json\",\n  \"pageOrder\": [\n    \"overview\",\n    \"objects\",\n    \"usage\",\n    \"findings\",\n    \"lineage\"\n  ],\n  \"activePageName\": \"overview\"\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/overview/page.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.1.0/schema.json\",\n  \"name\": \"overview\",\n  \"displayName\": \"Overview\",\n  \"displayOption\": \"FitToPage\",\n  \"height\": 720,\n  \"width\": 1280,\n  \"objects\": {\n    \"background\": [\n      {\n        \"properties\": {\n          \"color\": {\n            \"solid\": {\n              \"color\": {\n                \"expr\": {\n                  \"Literal\": {\n                    \"Value\": \"'#F2F2F2'\"\n                  }\n                }\n              }\n            }\n          },\n          \"transparency\": {\n            \"expr\": {\n              \"Literal\": {\n                \"Value\": \"0D\"\n              }\n            }\n          }\n        }\n      }\n    ],\n    \"outspace\": [\n      {\n        \"properties\": {\n          \"color\": {\n            \"solid\": {\n              \"color\": {\n                \"expr\": {\n                  \"Literal\": {\n                    \"Value\": \"'#F2F2F2'\"\n                  }\n                }\n              }\n            }\n          }\n        }\n      }\n    ]\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/overview/visuals/header/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"header\",\n  \"position\": {\n    \"x\": 0,\n    \"y\": 0,\n    \"z\": 0,\n    \"height\": 48,\n    \"width\": 1280,\n    \"tabOrder\": 0\n  },\n  \"visual\": {\n    \"visualType\": \"textbox\",\n    \"objects\": {\n      \"general\": [\n        {\n          \"properties\": {\n            \"paragraphs\": [\n              {\n                \"textRuns\": [\n                  {\n                    \"value\": \"Semantic Model Optimizer\",\n                    \"textStyle\": {\n                      \"fontFamily\": \"Segoe UI\",\n                      \"fontSize\": \"14pt\",\n                      \"color\": \"#FFFFFF\",\n                      \"fontWeight\": \"bold\"\n                    }\n                  },\n                  {\n                    \"value\": \"   Overview\",\n                    \"textStyle\": {\n                      \"fontFamily\": \"Segoe UI\",\n                      \"fontSize\": \"14pt\",\n                      \"color\": \"#C5CCD6\"\n                    }\n                  }\n                ]\n              }\n            ]\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"background\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"color\": {\n              \"solid\": {\n                \"color\": {\n                  \"expr\": {\n                    \"Literal\": {\n                      \"Value\": \"'#2F3B4C'\"\n                    }\n                  }\n                }\n              }\n            },\n            \"transparency\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"0D\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"padding\": [\n        {\n          \"properties\": {\n            \"top\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"10D\"\n                }\n              }\n            },\n            \"left\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"20D\"\n                }\n              }\n            },\n            \"bottom\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"0D\"\n                }\n              }\n            },\n            \"right\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"20D\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"visualHeader\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    }\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/overview/visuals/filter1/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter1\",\n  \"position\": {\n    \"x\": 20,\n    \"y\": 62,\n    \"z\": 1000,\n    \"height\": 70,\n    \"width\": 301,\n    \"tabOrder\": 1000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Run\"\n                    }\n                  },\n                  \"Property\": \"Model\"\n                }\n              },\n              \"queryRef\": \"Dim_Run.Model\",\n              \"nativeQueryRef\": \"Model\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Model'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/overview/visuals/filter2/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter2\",\n  \"position\": {\n    \"x\": 333,\n    \"y\": 62,\n    \"z\": 2000,\n    \"height\": 70,\n    \"width\": 301,\n    \"tabOrder\": 2000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Object type\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Object type\",\n              \"nativeQueryRef\": \"Object type\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Object type'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/overview/visuals/filter3/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter3\",\n  \"position\": {\n    \"x\": 646,\n    \"y\": 62,\n    \"z\": 3000,\n    \"height\": 70,\n    \"width\": 301,\n    \"tabOrder\": 3000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Table\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Table\",\n              \"nativeQueryRef\": \"Table\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Table'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/overview/visuals/filter4/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter4\",\n  \"position\": {\n    \"x\": 959,\n    \"y\": 62,\n    \"z\": 4000,\n    \"height\": 70,\n    \"width\": 301,\n    \"tabOrder\": 4000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Date\"\n                    }\n                  },\n                  \"Property\": \"Date\"\n                }\n              },\n              \"queryRef\": \"Dim_Date.Date\",\n              \"nativeQueryRef\": \"Date\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Date'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/overview/visuals/card0/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"card0\",\n  \"position\": {\n    \"x\": 20,\n    \"y\": 144,\n    \"z\": 5000,\n    \"height\": 84,\n    \"width\": 167,\n    \"tabOrder\": 5000\n  },\n  \"visual\": {\n    \"visualType\": \"card\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Object\"\n                    }\n                  },\n                  \"Property\": \"Measures\"\n                }\n              },\n              \"queryRef\": \"Fact_Object.Measures\",\n              \"nativeQueryRef\": \"Measures\"\n            }\n          ]\n        }\n      }\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/overview/visuals/card1/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"card1\",\n  \"position\": {\n    \"x\": 199,\n    \"y\": 144,\n    \"z\": 6000,\n    \"height\": 84,\n    \"width\": 167,\n    \"tabOrder\": 6000\n  },\n  \"visual\": {\n    \"visualType\": \"card\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Object\"\n                    }\n                  },\n                  \"Property\": \"Unused measures\"\n                }\n              },\n              \"queryRef\": \"Fact_Object.Unused measures\",\n              \"nativeQueryRef\": \"Unused measures\"\n            }\n          ]\n        }\n      }\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/overview/visuals/card2/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"card2\",\n  \"position\": {\n    \"x\": 378,\n    \"y\": 144,\n    \"z\": 7000,\n    \"height\": 84,\n    \"width\": 167,\n    \"tabOrder\": 7000\n  },\n  \"visual\": {\n    \"visualType\": \"card\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Object\"\n                    }\n                  },\n                  \"Property\": \"Columns\"\n                }\n              },\n              \"queryRef\": \"Fact_Object.Columns\",\n              \"nativeQueryRef\": \"Columns\"\n            }\n          ]\n        }\n      }\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/overview/visuals/card3/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"card3\",\n  \"position\": {\n    \"x\": 557,\n    \"y\": 144,\n    \"z\": 8000,\n    \"height\": 84,\n    \"width\": 167,\n    \"tabOrder\": 8000\n  },\n  \"visual\": {\n    \"visualType\": \"card\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Object\"\n                    }\n                  },\n                  \"Property\": \"Unused columns\"\n                }\n              },\n              \"queryRef\": \"Fact_Object.Unused columns\",\n              \"nativeQueryRef\": \"Unused columns\"\n            }\n          ]\n        }\n      }\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/overview/visuals/card4/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"card4\",\n  \"position\": {\n    \"x\": 735,\n    \"y\": 144,\n    \"z\": 9000,\n    \"height\": 84,\n    \"width\": 167,\n    \"tabOrder\": 9000\n  },\n  \"visual\": {\n    \"visualType\": \"card\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Object\"\n                    }\n                  },\n                  \"Property\": \"Broken formulas\"\n                }\n              },\n              \"queryRef\": \"Fact_Object.Broken formulas\",\n              \"nativeQueryRef\": \"Broken formulas\"\n            }\n          ]\n        }\n      }\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/overview/visuals/card5/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"card5\",\n  \"position\": {\n    \"x\": 914,\n    \"y\": 144,\n    \"z\": 10000,\n    \"height\": 84,\n    \"width\": 167,\n    \"tabOrder\": 10000\n  },\n  \"visual\": {\n    \"visualType\": \"card\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Finding\"\n                    }\n                  },\n                  \"Property\": \"Errors\"\n                }\n              },\n              \"queryRef\": \"Fact_Finding.Errors\",\n              \"nativeQueryRef\": \"Errors\"\n            }\n          ]\n        }\n      }\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/overview/visuals/card6/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"card6\",\n  \"position\": {\n    \"x\": 1093,\n    \"y\": 144,\n    \"z\": 11000,\n    \"height\": 84,\n    \"width\": 167,\n    \"tabOrder\": 11000\n  },\n  \"visual\": {\n    \"visualType\": \"card\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Finding\"\n                    }\n                  },\n                  \"Property\": \"Warnings\"\n                }\n              },\n              \"queryRef\": \"Fact_Finding.Warnings\",\n              \"nativeQueryRef\": \"Warnings\"\n            }\n          ]\n        }\n      }\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/overview/visuals/status/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"status\",\n  \"position\": {\n    \"x\": 20,\n    \"y\": 240,\n    \"z\": 12000,\n    \"height\": 236,\n    \"width\": 614,\n    \"tabOrder\": 12000\n  },\n  \"visual\": {\n    \"visualType\": \"barChart\",\n    \"query\": {\n      \"queryState\": {\n        \"Category\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Object type\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Object type\",\n              \"nativeQueryRef\": \"Object type\"\n            }\n          ]\n        },\n        \"Series\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Status\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Status\",\n              \"nativeQueryRef\": \"Status\"\n            }\n          ]\n        },\n        \"Y\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Object\"\n                    }\n                  },\n                  \"Property\": \"Objects\"\n                }\n              },\n              \"queryRef\": \"Fact_Object.Objects\",\n              \"nativeQueryRef\": \"Objects\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"dataPoint\": [\n        {\n          \"properties\": {\n            \"fill\": {\n              \"solid\": {\n                \"color\": {\n                  \"expr\": {\n                    \"Literal\": {\n                      \"Value\": \"'#5DA5DA'\"\n                    }\n                  }\n                }\n              }\n            }\n          },\n          \"selector\": {\n            \"data\": [\n              {\n                \"scopeId\": {\n                  \"Comparison\": {\n                    \"ComparisonKind\": 0,\n                    \"Left\": {\n                      \"Column\": {\n                        \"Expression\": {\n                          \"SourceRef\": {\n                            \"Entity\": \"Dim_Object\"\n                          }\n                        },\n                        \"Property\": \"Status\"\n                      }\n                    },\n                    \"Right\": {\n                      \"Literal\": {\n                        \"Value\": \"'In report'\"\n                      }\n                    }\n                  }\n                }\n              }\n            ]\n          }\n        },\n        {\n          \"properties\": {\n            \"fill\": {\n              \"solid\": {\n                \"color\": {\n                  \"expr\": {\n                    \"Literal\": {\n                      \"Value\": \"'#88BDE6'\"\n                    }\n                  }\n                }\n              }\n            }\n          },\n          \"selector\": {\n            \"data\": [\n              {\n                \"scopeId\": {\n                  \"Comparison\": {\n                    \"ComparisonKind\": 0,\n                    \"Left\": {\n                      \"Column\": {\n                        \"Expression\": {\n                          \"SourceRef\": {\n                            \"Entity\": \"Dim_Object\"\n                          }\n                        },\n                        \"Property\": \"Status\"\n                      }\n                    },\n                    \"Right\": {\n                      \"Literal\": {\n                        \"Value\": \"'Used indirectly'\"\n                      }\n                    }\n                  }\n                }\n              }\n            ]\n          }\n        },\n        {\n          \"properties\": {\n            \"fill\": {\n              \"solid\": {\n                \"color\": {\n                  \"expr\": {\n                    \"Literal\": {\n                      \"Value\": \"'#B3B3B3'\"\n                    }\n                  }\n                }\n              }\n            }\n          },\n          \"selector\": {\n            \"data\": [\n              {\n                \"scopeId\": {\n                  \"Comparison\": {\n                    \"ComparisonKind\": 0,\n                    \"Left\": {\n                      \"Column\": {\n                        \"Expression\": {\n                          \"SourceRef\": {\n                            \"Entity\": \"Dim_Object\"\n                          }\n                        },\n                        \"Property\": \"Status\"\n                      }\n                    },\n                    \"Right\": {\n                      \"Literal\": {\n                        \"Value\": \"'Model only'\"\n                      }\n                    }\n                  }\n                }\n              }\n            ]\n          }\n        },\n        {\n          \"properties\": {\n            \"fill\": {\n              \"solid\": {\n                \"color\": {\n                  \"expr\": {\n                    \"Literal\": {\n                      \"Value\": \"'#FAA43A'\"\n                    }\n                  }\n                }\n              }\n            }\n          },\n          \"selector\": {\n            \"data\": [\n              {\n                \"scopeId\": {\n                  \"Comparison\": {\n                    \"ComparisonKind\": 0,\n                    \"Left\": {\n                      \"Column\": {\n                        \"Expression\": {\n                          \"SourceRef\": {\n                            \"Entity\": \"Dim_Object\"\n                          }\n                        },\n                        \"Property\": \"Status\"\n                      }\n                    },\n                    \"Right\": {\n                      \"Literal\": {\n                        \"Value\": \"'Unused'\"\n                      }\n                    }\n                  }\n                }\n              }\n            ]\n          }\n        },\n        {\n          \"properties\": {\n            \"fill\": {\n              \"solid\": {\n                \"color\": {\n                  \"expr\": {\n                    \"Literal\": {\n                      \"Value\": \"'#F15854'\"\n                    }\n                  }\n                }\n              }\n            }\n          },\n          \"selector\": {\n            \"data\": [\n              {\n                \"scopeId\": {\n                  \"Comparison\": {\n                    \"ComparisonKind\": 0,\n                    \"Left\": {\n                      \"Column\": {\n                        \"Expression\": {\n                          \"SourceRef\": {\n                            \"Entity\": \"Dim_Object\"\n                          }\n                        },\n                        \"Property\": \"Status\"\n                      }\n                    },\n                    \"Right\": {\n                      \"Literal\": {\n                        \"Value\": \"'Not in model'\"\n                      }\n                    }\n                  }\n                }\n              }\n            ]\n          }\n        },\n        {\n          \"properties\": {\n            \"fill\": {\n              \"solid\": {\n                \"color\": {\n                  \"expr\": {\n                    \"Literal\": {\n                      \"Value\": \"'#B3B3B3'\"\n                    }\n                  }\n                }\n              }\n            }\n          },\n          \"selector\": {\n            \"data\": [\n              {\n                \"scopeId\": {\n                  \"Comparison\": {\n                    \"ComparisonKind\": 0,\n                    \"Left\": {\n                      \"Column\": {\n                        \"Expression\": {\n                          \"SourceRef\": {\n                            \"Entity\": \"Dim_Object\"\n                          }\n                        },\n                        \"Property\": \"Status\"\n                      }\n                    },\n                    \"Right\": {\n                      \"Literal\": {\n                        \"Value\": \"'Model not loaded'\"\n                      }\n                    }\n                  }\n                }\n              }\n            ]\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Objects by status'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/overview/visuals/trend/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"trend\",\n  \"position\": {\n    \"x\": 646,\n    \"y\": 240,\n    \"z\": 13000,\n    \"height\": 236,\n    \"width\": 614,\n    \"tabOrder\": 13000\n  },\n  \"visual\": {\n    \"visualType\": \"lineChart\",\n    \"query\": {\n      \"queryState\": {\n        \"Category\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Date\"\n                    }\n                  },\n                  \"Property\": \"Date\"\n                }\n              },\n              \"queryRef\": \"Dim_Date.Date\",\n              \"nativeQueryRef\": \"Date\"\n            }\n          ]\n        },\n        \"Y\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Object\"\n                    }\n                  },\n                  \"Property\": \"Unused measures\"\n                }\n              },\n              \"queryRef\": \"Fact_Object.Unused measures\",\n              \"nativeQueryRef\": \"Unused measures\"\n            },\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Object\"\n                    }\n                  },\n                  \"Property\": \"Unused columns\"\n                }\n              },\n              \"queryRef\": \"Fact_Object.Unused columns\",\n              \"nativeQueryRef\": \"Unused columns\"\n            },\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Finding\"\n                    }\n                  },\n                  \"Property\": \"Errors\"\n                }\n              },\n              \"queryRef\": \"Fact_Finding.Errors\",\n              \"nativeQueryRef\": \"Errors\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"dataPoint\": [\n        {\n          \"properties\": {\n            \"fill\": {\n              \"solid\": {\n                \"color\": {\n                  \"expr\": {\n                    \"Literal\": {\n                      \"Value\": \"'#FAA43A'\"\n                    }\n                  }\n                }\n              }\n            }\n          },\n          \"selector\": {\n            \"metadata\": \"Fact_Object.Unused measures\"\n          }\n        },\n        {\n          \"properties\": {\n            \"fill\": {\n              \"solid\": {\n                \"color\": {\n                  \"expr\": {\n                    \"Literal\": {\n                      \"Value\": \"'#5DA5DA'\"\n                    }\n                  }\n                }\n              }\n            }\n          },\n          \"selector\": {\n            \"metadata\": \"Fact_Object.Unused columns\"\n          }\n        },\n        {\n          \"properties\": {\n            \"fill\": {\n              \"solid\": {\n                \"color\": {\n                  \"expr\": {\n                    \"Literal\": {\n                      \"Value\": \"'#F15854'\"\n                    }\n                  }\n                }\n              }\n            }\n          },\n          \"selector\": {\n            \"metadata\": \"Fact_Finding.Errors\"\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Over time'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/overview/visuals/rules/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"rules\",\n  \"position\": {\n    \"x\": 20,\n    \"y\": 488,\n    \"z\": 14000,\n    \"height\": 212,\n    \"width\": 1240,\n    \"tabOrder\": 14000\n  },\n  \"visual\": {\n    \"visualType\": \"clusteredBarChart\",\n    \"query\": {\n      \"queryState\": {\n        \"Category\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Rule\"\n                    }\n                  },\n                  \"Property\": \"Rule\"\n                }\n              },\n              \"queryRef\": \"Dim_Rule.Rule\",\n              \"nativeQueryRef\": \"Rule\"\n            }\n          ]\n        },\n        \"Y\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Finding\"\n                    }\n                  },\n                  \"Property\": \"Findings\"\n                }\n              },\n              \"queryRef\": \"Fact_Finding.Findings\",\n              \"nativeQueryRef\": \"Findings\"\n            }\n          ]\n        }\n      },\n      \"sortDefinition\": {\n        \"sort\": [\n          {\n            \"field\": {\n              \"Measure\": {\n                \"Expression\": {\n                  \"SourceRef\": {\n                    \"Entity\": \"Fact_Finding\"\n                  }\n                },\n                \"Property\": \"Findings\"\n              }\n            },\n            \"direction\": \"Descending\"\n          }\n        ],\n        \"isDefaultSort\": true\n      }\n    },\n    \"objects\": {\n      \"dataPoint\": [\n        {\n          \"properties\": {\n            \"fill\": {\n              \"solid\": {\n                \"color\": {\n                  \"expr\": {\n                    \"Literal\": {\n                      \"Value\": \"'#5DA5DA'\"\n                    }\n                  }\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"labels\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"valueAxis\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Findings by rule'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/objects/page.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.1.0/schema.json\",\n  \"name\": \"objects\",\n  \"displayName\": \"Objects\",\n  \"displayOption\": \"FitToPage\",\n  \"height\": 720,\n  \"width\": 1280,\n  \"objects\": {\n    \"background\": [\n      {\n        \"properties\": {\n          \"color\": {\n            \"solid\": {\n              \"color\": {\n                \"expr\": {\n                  \"Literal\": {\n                    \"Value\": \"'#F2F2F2'\"\n                  }\n                }\n              }\n            }\n          },\n          \"transparency\": {\n            \"expr\": {\n              \"Literal\": {\n                \"Value\": \"0D\"\n              }\n            }\n          }\n        }\n      }\n    ],\n    \"outspace\": [\n      {\n        \"properties\": {\n          \"color\": {\n            \"solid\": {\n              \"color\": {\n                \"expr\": {\n                  \"Literal\": {\n                    \"Value\": \"'#F2F2F2'\"\n                  }\n                }\n              }\n            }\n          }\n        }\n      }\n    ]\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/objects/visuals/header/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"header\",\n  \"position\": {\n    \"x\": 0,\n    \"y\": 0,\n    \"z\": 0,\n    \"height\": 48,\n    \"width\": 1280,\n    \"tabOrder\": 0\n  },\n  \"visual\": {\n    \"visualType\": \"textbox\",\n    \"objects\": {\n      \"general\": [\n        {\n          \"properties\": {\n            \"paragraphs\": [\n              {\n                \"textRuns\": [\n                  {\n                    \"value\": \"Semantic Model Optimizer\",\n                    \"textStyle\": {\n                      \"fontFamily\": \"Segoe UI\",\n                      \"fontSize\": \"14pt\",\n                      \"color\": \"#FFFFFF\",\n                      \"fontWeight\": \"bold\"\n                    }\n                  },\n                  {\n                    \"value\": \"   Objects\",\n                    \"textStyle\": {\n                      \"fontFamily\": \"Segoe UI\",\n                      \"fontSize\": \"14pt\",\n                      \"color\": \"#C5CCD6\"\n                    }\n                  }\n                ]\n              }\n            ]\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"background\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"color\": {\n              \"solid\": {\n                \"color\": {\n                  \"expr\": {\n                    \"Literal\": {\n                      \"Value\": \"'#2F3B4C'\"\n                    }\n                  }\n                }\n              }\n            },\n            \"transparency\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"0D\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"padding\": [\n        {\n          \"properties\": {\n            \"top\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"10D\"\n                }\n              }\n            },\n            \"left\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"20D\"\n                }\n              }\n            },\n            \"bottom\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"0D\"\n                }\n              }\n            },\n            \"right\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"20D\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"visualHeader\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    }\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/objects/visuals/filter1/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter1\",\n  \"position\": {\n    \"x\": 20,\n    \"y\": 62,\n    \"z\": 1000,\n    \"height\": 70,\n    \"width\": 197,\n    \"tabOrder\": 1000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Run\"\n                    }\n                  },\n                  \"Property\": \"Model\"\n                }\n              },\n              \"queryRef\": \"Dim_Run.Model\",\n              \"nativeQueryRef\": \"Model\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Model'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/objects/visuals/filter2/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter2\",\n  \"position\": {\n    \"x\": 229,\n    \"y\": 62,\n    \"z\": 2000,\n    \"height\": 70,\n    \"width\": 197,\n    \"tabOrder\": 2000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Object type\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Object type\",\n              \"nativeQueryRef\": \"Object type\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Object type'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/objects/visuals/filter3/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter3\",\n  \"position\": {\n    \"x\": 437,\n    \"y\": 62,\n    \"z\": 3000,\n    \"height\": 70,\n    \"width\": 197,\n    \"tabOrder\": 3000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Status\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Status\",\n              \"nativeQueryRef\": \"Status\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Status'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/objects/visuals/filter4/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter4\",\n  \"position\": {\n    \"x\": 646,\n    \"y\": 62,\n    \"z\": 4000,\n    \"height\": 70,\n    \"width\": 197,\n    \"tabOrder\": 4000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Table\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Table\",\n              \"nativeQueryRef\": \"Table\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Table'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/objects/visuals/filter5/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter5\",\n  \"position\": {\n    \"x\": 855,\n    \"y\": 62,\n    \"z\": 5000,\n    \"height\": 70,\n    \"width\": 197,\n    \"tabOrder\": 5000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Hidden\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Hidden\",\n              \"nativeQueryRef\": \"Hidden\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Hidden'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/objects/visuals/filter6/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter6\",\n  \"position\": {\n    \"x\": 1063,\n    \"y\": 62,\n    \"z\": 6000,\n    \"height\": 70,\n    \"width\": 197,\n    \"tabOrder\": 6000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Broken\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Broken\",\n              \"nativeQueryRef\": \"Broken\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Broken'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/objects/visuals/list/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"list\",\n  \"position\": {\n    \"x\": 20,\n    \"y\": 144,\n    \"z\": 7000,\n    \"height\": 556,\n    \"width\": 1240,\n    \"tabOrder\": 7000\n  },\n  \"visual\": {\n    \"visualType\": \"tableEx\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Table\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Table\",\n              \"nativeQueryRef\": \"Table\"\n            },\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Name\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Name\",\n              \"nativeQueryRef\": \"Name\"\n            },\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Kind\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Kind\",\n              \"nativeQueryRef\": \"Kind\"\n            },\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Status\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Status\",\n              \"nativeQueryRef\": \"Status\"\n            },\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Hidden\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Hidden\",\n              \"nativeQueryRef\": \"Hidden\"\n            },\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Usage\"\n                    }\n                  },\n                  \"Property\": \"Reports using it\"\n                }\n              },\n              \"queryRef\": \"Fact_Usage.Reports using it\",\n              \"nativeQueryRef\": \"Reports using it\"\n            },\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Usage\"\n                    }\n                  },\n                  \"Property\": \"Visuals\"\n                }\n              },\n              \"queryRef\": \"Fact_Usage.Visuals\",\n              \"nativeQueryRef\": \"Visuals\"\n            },\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Object\"\n                    }\n                  },\n                  \"Property\": \"Used by objects\"\n                }\n              },\n              \"queryRef\": \"Fact_Object.Used by objects\",\n              \"nativeQueryRef\": \"Used by objects\"\n            },\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Object\"\n                    }\n                  },\n                  \"Property\": \"Size (MB)\"\n                }\n              },\n              \"queryRef\": \"Fact_Object.Size (MB)\",\n              \"nativeQueryRef\": \"Size (MB)\"\n            }\n          ]\n        }\n      }\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Tables, columns and measures'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/usage/page.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.1.0/schema.json\",\n  \"name\": \"usage\",\n  \"displayName\": \"Where used\",\n  \"displayOption\": \"FitToPage\",\n  \"height\": 720,\n  \"width\": 1280,\n  \"objects\": {\n    \"background\": [\n      {\n        \"properties\": {\n          \"color\": {\n            \"solid\": {\n              \"color\": {\n                \"expr\": {\n                  \"Literal\": {\n                    \"Value\": \"'#F2F2F2'\"\n                  }\n                }\n              }\n            }\n          },\n          \"transparency\": {\n            \"expr\": {\n              \"Literal\": {\n                \"Value\": \"0D\"\n              }\n            }\n          }\n        }\n      }\n    ],\n    \"outspace\": [\n      {\n        \"properties\": {\n          \"color\": {\n            \"solid\": {\n              \"color\": {\n                \"expr\": {\n                  \"Literal\": {\n                    \"Value\": \"'#F2F2F2'\"\n                  }\n                }\n              }\n            }\n          }\n        }\n      }\n    ]\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/usage/visuals/header/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"header\",\n  \"position\": {\n    \"x\": 0,\n    \"y\": 0,\n    \"z\": 0,\n    \"height\": 48,\n    \"width\": 1280,\n    \"tabOrder\": 0\n  },\n  \"visual\": {\n    \"visualType\": \"textbox\",\n    \"objects\": {\n      \"general\": [\n        {\n          \"properties\": {\n            \"paragraphs\": [\n              {\n                \"textRuns\": [\n                  {\n                    \"value\": \"Semantic Model Optimizer\",\n                    \"textStyle\": {\n                      \"fontFamily\": \"Segoe UI\",\n                      \"fontSize\": \"14pt\",\n                      \"color\": \"#FFFFFF\",\n                      \"fontWeight\": \"bold\"\n                    }\n                  },\n                  {\n                    \"value\": \"   Where used\",\n                    \"textStyle\": {\n                      \"fontFamily\": \"Segoe UI\",\n                      \"fontSize\": \"14pt\",\n                      \"color\": \"#C5CCD6\"\n                    }\n                  }\n                ]\n              }\n            ]\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"background\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"color\": {\n              \"solid\": {\n                \"color\": {\n                  \"expr\": {\n                    \"Literal\": {\n                      \"Value\": \"'#2F3B4C'\"\n                    }\n                  }\n                }\n              }\n            },\n            \"transparency\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"0D\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"padding\": [\n        {\n          \"properties\": {\n            \"top\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"10D\"\n                }\n              }\n            },\n            \"left\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"20D\"\n                }\n              }\n            },\n            \"bottom\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"0D\"\n                }\n              }\n            },\n            \"right\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"20D\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"visualHeader\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    }\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/usage/visuals/filter1/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter1\",\n  \"position\": {\n    \"x\": 20,\n    \"y\": 62,\n    \"z\": 1000,\n    \"height\": 70,\n    \"width\": 197,\n    \"tabOrder\": 1000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Run\"\n                    }\n                  },\n                  \"Property\": \"Model\"\n                }\n              },\n              \"queryRef\": \"Dim_Run.Model\",\n              \"nativeQueryRef\": \"Model\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Model'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/usage/visuals/filter2/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter2\",\n  \"position\": {\n    \"x\": 229,\n    \"y\": 62,\n    \"z\": 2000,\n    \"height\": 70,\n    \"width\": 197,\n    \"tabOrder\": 2000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Object type\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Object type\",\n              \"nativeQueryRef\": \"Object type\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Object type'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/usage/visuals/filter3/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter3\",\n  \"position\": {\n    \"x\": 437,\n    \"y\": 62,\n    \"z\": 3000,\n    \"height\": 70,\n    \"width\": 197,\n    \"tabOrder\": 3000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Table\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Table\",\n              \"nativeQueryRef\": \"Table\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Table'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/usage/visuals/filter4/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter4\",\n  \"position\": {\n    \"x\": 646,\n    \"y\": 62,\n    \"z\": 4000,\n    \"height\": 70,\n    \"width\": 197,\n    \"tabOrder\": 4000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Label\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Label\",\n              \"nativeQueryRef\": \"Label\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Measure or column'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/usage/visuals/filter5/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter5\",\n  \"position\": {\n    \"x\": 855,\n    \"y\": 62,\n    \"z\": 5000,\n    \"height\": 70,\n    \"width\": 197,\n    \"tabOrder\": 5000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Visual\"\n                    }\n                  },\n                  \"Property\": \"Report\"\n                }\n              },\n              \"queryRef\": \"Dim_Visual.Report\",\n              \"nativeQueryRef\": \"Report\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Report'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/usage/visuals/filter6/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter6\",\n  \"position\": {\n    \"x\": 1063,\n    \"y\": 62,\n    \"z\": 6000,\n    \"height\": 70,\n    \"width\": 197,\n    \"tabOrder\": 6000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Visual\"\n                    }\n                  },\n                  \"Property\": \"Page\"\n                }\n              },\n              \"queryRef\": \"Dim_Visual.Page\",\n              \"nativeQueryRef\": \"Page\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Page'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/usage/visuals/fields/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"fields\",\n  \"position\": {\n    \"x\": 20,\n    \"y\": 144,\n    \"z\": 7000,\n    \"height\": 556,\n    \"width\": 440,\n    \"tabOrder\": 7000\n  },\n  \"visual\": {\n    \"visualType\": \"tableEx\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Label\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Label\",\n              \"nativeQueryRef\": \"Label\"\n            },\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Usage\"\n                    }\n                  },\n                  \"Property\": \"Reports using it\"\n                }\n              },\n              \"queryRef\": \"Fact_Usage.Reports using it\",\n              \"nativeQueryRef\": \"Reports using it\"\n            },\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Usage\"\n                    }\n                  },\n                  \"Property\": \"Visuals\"\n                }\n              },\n              \"queryRef\": \"Fact_Usage.Visuals\",\n              \"nativeQueryRef\": \"Visuals\"\n            }\n          ]\n        }\n      }\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Measures and columns in reports'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/usage/visuals/list/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"list\",\n  \"position\": {\n    \"x\": 472,\n    \"y\": 144,\n    \"z\": 8000,\n    \"height\": 556,\n    \"width\": 788,\n    \"tabOrder\": 8000\n  },\n  \"visual\": {\n    \"visualType\": \"tableEx\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Run\"\n                    }\n                  },\n                  \"Property\": \"Model\"\n                }\n              },\n              \"queryRef\": \"Dim_Run.Model\",\n              \"nativeQueryRef\": \"Model\"\n            },\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Visual\"\n                    }\n                  },\n                  \"Property\": \"Report\"\n                }\n              },\n              \"queryRef\": \"Dim_Visual.Report\",\n              \"nativeQueryRef\": \"Report\"\n            },\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Visual\"\n                    }\n                  },\n                  \"Property\": \"Page\"\n                }\n              },\n              \"queryRef\": \"Dim_Visual.Page\",\n              \"nativeQueryRef\": \"Page\"\n            },\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Visual\"\n                    }\n                  },\n                  \"Property\": \"Visual\"\n                }\n              },\n              \"queryRef\": \"Dim_Visual.Visual\",\n              \"nativeQueryRef\": \"Visual\"\n            },\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Visual\"\n                    }\n                  },\n                  \"Property\": \"Visual type\"\n                }\n              },\n              \"queryRef\": \"Dim_Visual.Visual type\",\n              \"nativeQueryRef\": \"Visual type\"\n            },\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Label\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Label\",\n              \"nativeQueryRef\": \"Label\"\n            },\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Usage\"\n                    }\n                  },\n                  \"Property\": \"Role\"\n                }\n              },\n              \"queryRef\": \"Fact_Usage.Role\",\n              \"nativeQueryRef\": \"Role\"\n            },\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Usage\"\n                    }\n                  },\n                  \"Property\": \"Field uses\"\n                }\n              },\n              \"queryRef\": \"Fact_Usage.Field uses\",\n              \"nativeQueryRef\": \"Field uses\"\n            }\n          ]\n        }\n      }\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Reports and visuals that use them'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/findings/page.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.1.0/schema.json\",\n  \"name\": \"findings\",\n  \"displayName\": \"Findings\",\n  \"displayOption\": \"FitToPage\",\n  \"height\": 720,\n  \"width\": 1280,\n  \"objects\": {\n    \"background\": [\n      {\n        \"properties\": {\n          \"color\": {\n            \"solid\": {\n              \"color\": {\n                \"expr\": {\n                  \"Literal\": {\n                    \"Value\": \"'#F2F2F2'\"\n                  }\n                }\n              }\n            }\n          },\n          \"transparency\": {\n            \"expr\": {\n              \"Literal\": {\n                \"Value\": \"0D\"\n              }\n            }\n          }\n        }\n      }\n    ],\n    \"outspace\": [\n      {\n        \"properties\": {\n          \"color\": {\n            \"solid\": {\n              \"color\": {\n                \"expr\": {\n                  \"Literal\": {\n                    \"Value\": \"'#F2F2F2'\"\n                  }\n                }\n              }\n            }\n          }\n        }\n      }\n    ]\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/findings/visuals/header/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"header\",\n  \"position\": {\n    \"x\": 0,\n    \"y\": 0,\n    \"z\": 0,\n    \"height\": 48,\n    \"width\": 1280,\n    \"tabOrder\": 0\n  },\n  \"visual\": {\n    \"visualType\": \"textbox\",\n    \"objects\": {\n      \"general\": [\n        {\n          \"properties\": {\n            \"paragraphs\": [\n              {\n                \"textRuns\": [\n                  {\n                    \"value\": \"Semantic Model Optimizer\",\n                    \"textStyle\": {\n                      \"fontFamily\": \"Segoe UI\",\n                      \"fontSize\": \"14pt\",\n                      \"color\": \"#FFFFFF\",\n                      \"fontWeight\": \"bold\"\n                    }\n                  },\n                  {\n                    \"value\": \"   Findings\",\n                    \"textStyle\": {\n                      \"fontFamily\": \"Segoe UI\",\n                      \"fontSize\": \"14pt\",\n                      \"color\": \"#C5CCD6\"\n                    }\n                  }\n                ]\n              }\n            ]\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"background\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"color\": {\n              \"solid\": {\n                \"color\": {\n                  \"expr\": {\n                    \"Literal\": {\n                      \"Value\": \"'#2F3B4C'\"\n                    }\n                  }\n                }\n              }\n            },\n            \"transparency\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"0D\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"padding\": [\n        {\n          \"properties\": {\n            \"top\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"10D\"\n                }\n              }\n            },\n            \"left\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"20D\"\n                }\n              }\n            },\n            \"bottom\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"0D\"\n                }\n              }\n            },\n            \"right\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"20D\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"visualHeader\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    }\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/findings/visuals/filter1/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter1\",\n  \"position\": {\n    \"x\": 20,\n    \"y\": 62,\n    \"z\": 1000,\n    \"height\": 70,\n    \"width\": 238,\n    \"tabOrder\": 1000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Run\"\n                    }\n                  },\n                  \"Property\": \"Model\"\n                }\n              },\n              \"queryRef\": \"Dim_Run.Model\",\n              \"nativeQueryRef\": \"Model\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Model'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/findings/visuals/filter2/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter2\",\n  \"position\": {\n    \"x\": 270,\n    \"y\": 62,\n    \"z\": 2000,\n    \"height\": 70,\n    \"width\": 238,\n    \"tabOrder\": 2000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Rule\"\n                    }\n                  },\n                  \"Property\": \"Severity\"\n                }\n              },\n              \"queryRef\": \"Dim_Rule.Severity\",\n              \"nativeQueryRef\": \"Severity\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Severity'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/findings/visuals/filter3/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter3\",\n  \"position\": {\n    \"x\": 521,\n    \"y\": 62,\n    \"z\": 3000,\n    \"height\": 70,\n    \"width\": 238,\n    \"tabOrder\": 3000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Rule\"\n                    }\n                  },\n                  \"Property\": \"Group\"\n                }\n              },\n              \"queryRef\": \"Dim_Rule.Group\",\n              \"nativeQueryRef\": \"Group\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Group'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/findings/visuals/filter4/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter4\",\n  \"position\": {\n    \"x\": 771,\n    \"y\": 62,\n    \"z\": 4000,\n    \"height\": 70,\n    \"width\": 238,\n    \"tabOrder\": 4000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Rule\"\n                    }\n                  },\n                  \"Property\": \"Rule\"\n                }\n              },\n              \"queryRef\": \"Dim_Rule.Rule\",\n              \"nativeQueryRef\": \"Rule\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Rule'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/findings/visuals/filter5/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter5\",\n  \"position\": {\n    \"x\": 1022,\n    \"y\": 62,\n    \"z\": 5000,\n    \"height\": 70,\n    \"width\": 238,\n    \"tabOrder\": 5000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Table\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Table\",\n              \"nativeQueryRef\": \"Table\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Table'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/findings/visuals/list/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"list\",\n  \"position\": {\n    \"x\": 20,\n    \"y\": 144,\n    \"z\": 6000,\n    \"height\": 556,\n    \"width\": 1240,\n    \"tabOrder\": 6000\n  },\n  \"visual\": {\n    \"visualType\": \"tableEx\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Rule\"\n                    }\n                  },\n                  \"Property\": \"Severity\"\n                }\n              },\n              \"queryRef\": \"Dim_Rule.Severity\",\n              \"nativeQueryRef\": \"Severity\"\n            },\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Rule\"\n                    }\n                  },\n                  \"Property\": \"Rule\"\n                }\n              },\n              \"queryRef\": \"Dim_Rule.Rule\",\n              \"nativeQueryRef\": \"Rule\"\n            },\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Label\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Label\",\n              \"nativeQueryRef\": \"Label\"\n            },\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Finding\"\n                    }\n                  },\n                  \"Property\": \"Detail\"\n                }\n              },\n              \"queryRef\": \"Fact_Finding.Detail\",\n              \"nativeQueryRef\": \"Detail\"\n            },\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Finding\"\n                    }\n                  },\n                  \"Property\": \"Findings\"\n                }\n              },\n              \"queryRef\": \"Fact_Finding.Findings\",\n              \"nativeQueryRef\": \"Findings\"\n            }\n          ]\n        }\n      }\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Findings'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/lineage/page.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.1.0/schema.json\",\n  \"name\": \"lineage\",\n  \"displayName\": \"Lineage\",\n  \"displayOption\": \"FitToPage\",\n  \"height\": 720,\n  \"width\": 1280,\n  \"objects\": {\n    \"background\": [\n      {\n        \"properties\": {\n          \"color\": {\n            \"solid\": {\n              \"color\": {\n                \"expr\": {\n                  \"Literal\": {\n                    \"Value\": \"'#F2F2F2'\"\n                  }\n                }\n              }\n            }\n          },\n          \"transparency\": {\n            \"expr\": {\n              \"Literal\": {\n                \"Value\": \"0D\"\n              }\n            }\n          }\n        }\n      }\n    ],\n    \"outspace\": [\n      {\n        \"properties\": {\n          \"color\": {\n            \"solid\": {\n              \"color\": {\n                \"expr\": {\n                  \"Literal\": {\n                    \"Value\": \"'#F2F2F2'\"\n                  }\n                }\n              }\n            }\n          }\n        }\n      }\n    ]\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/lineage/visuals/header/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"header\",\n  \"position\": {\n    \"x\": 0,\n    \"y\": 0,\n    \"z\": 0,\n    \"height\": 48,\n    \"width\": 1280,\n    \"tabOrder\": 0\n  },\n  \"visual\": {\n    \"visualType\": \"textbox\",\n    \"objects\": {\n      \"general\": [\n        {\n          \"properties\": {\n            \"paragraphs\": [\n              {\n                \"textRuns\": [\n                  {\n                    \"value\": \"Semantic Model Optimizer\",\n                    \"textStyle\": {\n                      \"fontFamily\": \"Segoe UI\",\n                      \"fontSize\": \"14pt\",\n                      \"color\": \"#FFFFFF\",\n                      \"fontWeight\": \"bold\"\n                    }\n                  },\n                  {\n                    \"value\": \"   Lineage\",\n                    \"textStyle\": {\n                      \"fontFamily\": \"Segoe UI\",\n                      \"fontSize\": \"14pt\",\n                      \"color\": \"#C5CCD6\"\n                    }\n                  }\n                ]\n              }\n            ]\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"background\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"color\": {\n              \"solid\": {\n                \"color\": {\n                  \"expr\": {\n                    \"Literal\": {\n                      \"Value\": \"'#2F3B4C'\"\n                    }\n                  }\n                }\n              }\n            },\n            \"transparency\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"0D\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"padding\": [\n        {\n          \"properties\": {\n            \"top\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"10D\"\n                }\n              }\n            },\n            \"left\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"20D\"\n                }\n              }\n            },\n            \"bottom\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"0D\"\n                }\n              }\n            },\n            \"right\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"20D\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"visualHeader\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    }\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/lineage/visuals/filter1/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter1\",\n  \"position\": {\n    \"x\": 20,\n    \"y\": 62,\n    \"z\": 1000,\n    \"height\": 70,\n    \"width\": 238,\n    \"tabOrder\": 1000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Run\"\n                    }\n                  },\n                  \"Property\": \"Model\"\n                }\n              },\n              \"queryRef\": \"Dim_Run.Model\",\n              \"nativeQueryRef\": \"Model\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Model'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/lineage/visuals/filter2/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter2\",\n  \"position\": {\n    \"x\": 270,\n    \"y\": 62,\n    \"z\": 2000,\n    \"height\": 70,\n    \"width\": 238,\n    \"tabOrder\": 2000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Object type\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Object type\",\n              \"nativeQueryRef\": \"Object type\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Object type'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/lineage/visuals/filter3/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter3\",\n  \"position\": {\n    \"x\": 521,\n    \"y\": 62,\n    \"z\": 3000,\n    \"height\": 70,\n    \"width\": 238,\n    \"tabOrder\": 3000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Table\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Table\",\n              \"nativeQueryRef\": \"Table\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Table'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/lineage/visuals/filter4/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter4\",\n  \"position\": {\n    \"x\": 771,\n    \"y\": 62,\n    \"z\": 4000,\n    \"height\": 70,\n    \"width\": 238,\n    \"tabOrder\": 4000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Label\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Label\",\n              \"nativeQueryRef\": \"Label\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Object'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/lineage/visuals/filter5/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"filter5\",\n  \"position\": {\n    \"x\": 1022,\n    \"y\": 62,\n    \"z\": 5000,\n    \"height\": 70,\n    \"width\": 238,\n    \"tabOrder\": 5000\n  },\n  \"visual\": {\n    \"visualType\": \"slicer\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Dependency\"\n                    }\n                  },\n                  \"Property\": \"Depends on\"\n                }\n              },\n              \"queryRef\": \"Dim_Dependency.Depends on\",\n              \"nativeQueryRef\": \"Depends on\"\n            }\n          ]\n        }\n      }\n    },\n    \"objects\": {\n      \"data\": [\n        {\n          \"properties\": {\n            \"mode\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Dropdown'\"\n                }\n              }\n            }\n          }\n        }\n      ],\n      \"header\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"false\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'Depends on'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n",
 "Semantic Model Optimizer.Report/definition/pages/lineage/visuals/list/visual.json": "{\n  \"$schema\": \"https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.4.0/schema.json\",\n  \"name\": \"list\",\n  \"position\": {\n    \"x\": 20,\n    \"y\": 144,\n    \"z\": 6000,\n    \"height\": 556,\n    \"width\": 1240,\n    \"tabOrder\": 6000\n  },\n  \"visual\": {\n    \"visualType\": \"tableEx\",\n    \"query\": {\n      \"queryState\": {\n        \"Values\": {\n          \"projections\": [\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Label\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Label\",\n              \"nativeQueryRef\": \"Label\"\n            },\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Kind\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Kind\",\n              \"nativeQueryRef\": \"Kind\"\n            },\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Object\"\n                    }\n                  },\n                  \"Property\": \"Status\"\n                }\n              },\n              \"queryRef\": \"Dim_Object.Status\",\n              \"nativeQueryRef\": \"Status\"\n            },\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Dependency\"\n                    }\n                  },\n                  \"Property\": \"Depends on\"\n                }\n              },\n              \"queryRef\": \"Dim_Dependency.Depends on\",\n              \"nativeQueryRef\": \"Depends on\"\n            },\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Dependency\"\n                    }\n                  },\n                  \"Property\": \"Depends on kind\"\n                }\n              },\n              \"queryRef\": \"Dim_Dependency.Depends on kind\",\n              \"nativeQueryRef\": \"Depends on kind\"\n            },\n            {\n              \"field\": {\n                \"Column\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Dim_Dependency\"\n                    }\n                  },\n                  \"Property\": \"Depends on status\"\n                }\n              },\n              \"queryRef\": \"Dim_Dependency.Depends on status\",\n              \"nativeQueryRef\": \"Depends on status\"\n            },\n            {\n              \"field\": {\n                \"Measure\": {\n                  \"Expression\": {\n                    \"SourceRef\": {\n                      \"Entity\": \"Fact_Dependency\"\n                    }\n                  },\n                  \"Property\": \"Dependencies\"\n                }\n              },\n              \"queryRef\": \"Fact_Dependency.Dependencies\",\n              \"nativeQueryRef\": \"Dependencies\"\n            }\n          ]\n        }\n      }\n    },\n    \"visualContainerObjects\": {\n      \"title\": [\n        {\n          \"properties\": {\n            \"show\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"true\"\n                }\n              }\n            },\n            \"text\": {\n              \"expr\": {\n                \"Literal\": {\n                  \"Value\": \"'What depends on what'\"\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"drillFilterOtherVisuals\": true\n  }\n}\n"
}
WARM_QUERIES = [
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Run'[Model] ) )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Object'[Object type] ) )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Object'[Table] ) )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Date'[Date] ) )",
 "EVALUATE ROW ( \"m0\", [Measures] )",
 "EVALUATE ROW ( \"m0\", [Unused measures] )",
 "EVALUATE ROW ( \"m0\", [Columns] )",
 "EVALUATE ROW ( \"m0\", [Unused columns] )",
 "EVALUATE ROW ( \"m0\", [Broken formulas] )",
 "EVALUATE ROW ( \"m0\", [Errors] )",
 "EVALUATE ROW ( \"m0\", [Warnings] )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Object'[Object type], 'Dim_Object'[Status], \"m0\", [Objects] ) )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Date'[Date], \"m0\", [Unused measures], \"m1\", [Unused columns], \"m2\", [Errors] ) )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Rule'[Rule], \"m0\", [Findings] ) )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Object'[Status] ) )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Object'[Hidden] ) )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Object'[Broken] ) )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Object'[Table], 'Dim_Object'[Name], 'Dim_Object'[Kind], 'Dim_Object'[Status], 'Dim_Object'[Hidden], \"m0\", [Reports using it], \"m1\", [Visuals], \"m2\", [Used by objects], \"m3\", [Size (MB)] ) )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Object'[Label] ) )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Visual'[Report] ) )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Visual'[Page] ) )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Object'[Label], \"m0\", [Reports using it], \"m1\", [Visuals] ) )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Run'[Model], 'Dim_Visual'[Report], 'Dim_Visual'[Page], 'Dim_Visual'[Visual], 'Dim_Visual'[Visual type], 'Dim_Object'[Label], 'Fact_Usage'[Role], \"m0\", [Field uses] ) )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Rule'[Severity] ) )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Rule'[Group] ) )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Rule'[Rule] ) )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Rule'[Severity], 'Dim_Rule'[Rule], 'Dim_Object'[Label], 'Fact_Finding'[Detail], \"m0\", [Findings] ) )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Dependency'[Depends on] ) )",
 "EVALUATE TOPN ( 501, SUMMARIZECOLUMNS ( 'Dim_Object'[Label], 'Dim_Object'[Kind], 'Dim_Object'[Status], 'Dim_Dependency'[Depends on], 'Dim_Dependency'[Depends on kind], 'Dim_Dependency'[Depends on status], \"m0\", [Dependencies] ) )"
]
# LAKEHOUSE-END

NAME = "Semantic Model Optimizer"
DIRECT_LAKE_NAME = NAME + " (Direct Lake)"


def _value(v, kind):
    """A value from a CSV file as the type of its column; an empty value is null, as in the import report."""
    if v is None or v == "":
        return None
    if kind == "int64":
        return int(v)
    if kind == "dateTime":
        return datetime.datetime.strptime(v, "%Y-%m-%d %H:%M:%S")
    if kind == "date":
        return datetime.date.fromisoformat(v[:10])
    return v


def starTables(folder):
    """The runs in <folder>/data as the tables of the star schema, with the steps Power Query does in the import report:
    Fact_Object without the fields that are missing from a model, Dim_Rule once per rule, the row -1 of Dim_Object,
    Dim_Dependency as Dim_Object in that role, and Dim_Date from the first to the last run.
    → {name: {"table": name in the Lakehouse, "columns": [(column, type)], "rows": [tuple]}}"""
    data = os.path.join(folder, "data")
    runs = sorted(n for n in os.listdir(data) if re.fullmatch("run-[0-9]+", n)) if os.path.isdir(data) else []

    def read(file):
        rows = []
        for r in runs:
            p = os.path.join(data, r, file)
            if os.path.exists(p):
                with open(p, encoding="utf-8-sig", newline="") as f:
                    rows += list(csv.DictReader(f))
        return rows

    out = {}
    for t in LAKEHOUSE_TABLES:
        cols = t["columns"]
        if t["dates"]:
            run = out["Dim_Run"]
            i = run["names"].index("Date")
            days = sorted(r[i] for r in run["rows"] if r[i] is not None)
            rows = []
            if days:
                d = days[0]
                while d <= days[-1]:
                    rows.append((d.year * 10000 + d.month * 100 + d.day, d, d.year, d.strftime("%Y-%m")))
                    d += datetime.timedelta(days=1)
        elif t["from"]:
            src = out[t["from"]]
            rows = [tuple(r[src["names"].index(a)] for a, _ in t["rename"]) for r in src["rows"]]
        else:
            raw = read(t["file"])
            if t["exclude"]:
                raw = [r for r in raw if (r.get(t["exclude"]["column"]) or None) != t["exclude"]["not"]]
            rows = [tuple(_value(r.get(c["name"]), c["type"]) for c in cols) for r in raw]
            if t["distinct"]:
                k, seen, once = [c["name"] for c in cols].index(t["distinct"]), set(), []
                for r in rows:
                    if r[k] not in seen:
                        seen.add(r[k])
                        once.append(r)
                rows = once
            if t["none"]:
                rows.insert(0, tuple(t["none"].get(c["name"], "" if c["type"] == "string" else None) for c in cols))
        out[t["name"]] = {"table": t["table"], "columns": [(c["column"], c["type"]) for c in cols], "names": [c["name"] for c in cols], "rows": rows}
    return out


def writeLakehouseTables(spark, folder, log=print):
    """Writes the star schema as Delta tables (smo_...) into the default Lakehouse of the notebook, rebuilt from every
    run each time, so a run that is added or removed under Files is reflected."""
    from pyspark.sql.types import DateType, LongType, StringType, StructField, StructType, TimestampType
    kinds = {"int64": LongType(), "string": StringType(), "dateTime": TimestampType(), "date": DateType()}
    tables = starTables(folder)
    for t in tables.values():
        schema = StructType([StructField(c, kinds[k], True) for c, k in t["columns"]])
        spark.createDataFrame(t["rows"], schema).write.mode("overwrite").option("overwriteSchema", "true").format("delta").saveAsTable(t["table"])
    log("Tables in the Lakehouse: " + ", ".join(t["table"] + " (" + str(len(t["rows"])) + ")" for t in tables.values()))
    return tables


def _parts(files, prefix):
    return [{"path": p[len(prefix):], "payload": base64.b64encode(t.encode("utf-8")).decode("ascii"), "payloadType": "InlineBase64"} for p, t in files.items() if p.startswith(prefix)]


def _createReport(workspace_id, model_id, files, token):
    """The report on the Direct Lake model: its pages from the files, and a definition.pbir that points to the model."""
    pbir = {"version": "4.0", "datasetReference": {"byConnection": {"connectionString": None, "pbiServiceModelId": None, "pbiModelVirtualServerName": "sobe_wowvirtualserver",
                                                                    "pbiModelDatabaseName": model_id, "name": "EntityDataSource", "connectionType": "pbiServiceXmlaStyleLive"}}}
    parts = _parts(files, NAME + ".Report/") + [{"path": "definition.pbir", "payload": base64.b64encode(json.dumps(pbir).encode("utf-8")).decode("ascii"), "payloadType": "InlineBase64"}]
    body = {"displayName": DIRECT_LAKE_NAME, "definition": {"parts": parts}}
    waitFor(call(FABRIC + "/workspaces/" + workspace_id + "/reports", token, "POST", json.dumps(body).encode("utf-8")), token)


def warmUp(workspace_id, model_id, token, log=print):
    """Runs the queries of the report once, after the refresh, so Direct Lake has loaded the columns into memory before
    anyone opens the report: the first one to open it would otherwise wait for that."""
    for _ in range(30):  # a Direct Lake refresh only points the model at the newest version of the tables: seconds
        last = json.loads(call(PBI + "/groups/" + workspace_id + "/datasets/" + model_id + "/refreshes?$top=1", token)[2]).get("value") or []
        if not last or last[0].get("status") != "Unknown":
            break
        sleep(2)
    started, failed = time.time(), 0
    for q in WARM_QUERIES:
        try:
            call(PBI + "/groups/" + workspace_id + "/datasets/" + model_id + "/executeQueries", token, "POST", json.dumps({"queries": [{"query": q}]}).encode("utf-8"))
        except Exception as e:
            failed += 1
            if failed == 1:
                log("  (could not load the report ahead: " + str(e)[:160] + ")")
    if failed < len(WARM_QUERIES):
        log("  loaded into memory for the report in " + str(round(time.time() - started)) + " s")


def publishDirectLake(workspace_id, lakehouse_id, token, log=print, warm=True):
    """Creates the Direct Lake model and its report in the workspace of the Lakehouse, the first time; afterwards it
    only refreshes the model, so it reads the new rows. Your own changes to the report stay; a report you deleted is
    created again, in the look of this version of the tool."""
    lake = json.loads(call(FABRIC + "/workspaces/" + workspace_id + "/lakehouses/" + lakehouse_id, token)[2])
    sql = get(lake.get("properties"), "sqlEndpointProperties") or {}
    server, database = sql.get("connectionString"), sql.get("id")
    if not server or not database:
        raise Exception("The SQL analytics endpoint of the Lakehouse is not ready yet (" + jstr(sql.get("provisioningStatus") or "no address") + "). Run the notebook again in a few minutes.")
    # the SQL endpoint picks up new tables by itself within minutes; ask it to do so now
    try:
        waitFor(call(FABRIC + "/workspaces/" + workspace_id + "/sqlEndpoints/" + database + "/refreshMetadata", token, "POST", b"{}"), token)
    except Exception as e:
        log("  (the SQL endpoint will see the new tables by itself within a few minutes: " + str(e)[:160] + ")")
    models = json.loads(call(FABRIC + "/workspaces/" + workspace_id + "/semanticModels", token)[2]).get("value") or []
    model = next((m for m in models if m.get("displayName") == DIRECT_LAKE_NAME), None)
    files = {p: t.replace("{{SQL_SERVER}}", server).replace("{{SQL_DATABASE}}", database) for p, t in DIRECT_LAKE_FILES.items()}
    parts = _parts(files, NAME + ".SemanticModel/")
    # the model belongs to the tool: a newer version replaces its definition (measures, tables); the report is yours
    stamp = "Results of Semantic Model Optimizer, read from the smo_ tables in the Lakehouse. Version " + VERSION + "."
    if model is not None:
        out = {"model": model["id"], "created": False}
        done = "refreshed, it shows this run"
        if (model.get("description") or "") != stamp:
            waitFor(call(FABRIC + "/workspaces/" + workspace_id + "/semanticModels/" + model["id"] + "/updateDefinition", token, "POST", json.dumps({"definition": {"parts": parts}}).encode("utf-8")), token)
            call(FABRIC + "/workspaces/" + workspace_id + "/semanticModels/" + model["id"], token, "PATCH", json.dumps({"description": stamp}).encode("utf-8"))
            out["updated"] = True
            done = "the model is brought up to version " + VERSION + ", and refreshed"
        call(PBI + "/groups/" + workspace_id + "/datasets/" + model["id"] + "/refreshes", token, "POST", json.dumps({"notifyOption": "NoNotification"}).encode("utf-8"))
        # a deleted report comes back, in the look of this version of the tool; a report that is there is left alone
        reports = json.loads(call(FABRIC + "/workspaces/" + workspace_id + "/reports", token)[2]).get("value") or []
        if not any(r.get("displayName") == DIRECT_LAKE_NAME for r in reports):
            _createReport(workspace_id, model["id"], files, token)
            out["report"] = True
            done += "; the report created again"
        log(DIRECT_LAKE_NAME + ": " + done)
        if warm:
            warmUp(workspace_id, model["id"], token, log)
        return out
    body = {"displayName": DIRECT_LAKE_NAME, "description": stamp, "definition": {"parts": parts}}
    made = waitFor(call(FABRIC + "/workspaces/" + workspace_id + "/semanticModels", token, "POST", json.dumps(body).encode("utf-8")), token) or {}
    model_id = made.get("id")
    if not model_id:
        models = json.loads(call(FABRIC + "/workspaces/" + workspace_id + "/semanticModels", token)[2]).get("value") or []
        model_id = next((m["id"] for m in models if m.get("displayName") == DIRECT_LAKE_NAME), None)
    if not model_id:
        raise Exception("Power BI created the Direct Lake model but did not say where it is.")
    _createReport(workspace_id, model_id, files, token)
    log(DIRECT_LAKE_NAME + ": model and report created in this workspace")
    if warm:
        warmUp(workspace_id, model_id, token, log)
    return {"model": model_id, "created": True}


# ---------------------------------------------------------------- Reading workspaces (workspace.js)

sleep = time.sleep
PBI = "https://api.powerbi.com/v1.0/myorg"
FABRIC = "https://api.fabric.microsoft.com/v1"
_ALLOWED = re.compile(r"https://(api\.powerbi\.com|api\.fabric\.microsoft\.com|login\.microsoftonline\.com|[a-z0-9.-]+\.(fabric\.microsoft\.com|powerbi\.com|analysis\.windows\.net|asazure\.windows\.net))/")


def http(method, url, token=None, body=None, headers=None):
    """One call over HTTPS. → (status, headers, body as text). The only place that goes online, and only to the
    Power BI and Fabric REST APIs, Azure Analysis Services and the Microsoft sign-in for a service principal."""
    if not _ALLOWED.match(url):
        raise Exception("Refused to call " + url + ": not a Power BI, Fabric or Analysis Services address.")
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = "Bearer " + token
    h.update(headers or {})
    req = urllib.request.Request(url, method=method, data=body if body is not None else (b"" if method == "POST" else None), headers=h)
    try:
        with urllib.request.urlopen(req, timeout=300) as res:
            return res.status, {k.lower(): v for k, v in res.headers.items()}, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read().decode("utf-8", "replace")


def call(url, token, method="GET", body=None):
    status, headers, text = http(method, url, token, body)
    body = text
    if status == 202 or 200 <= status < 300:
        return status, headers, body
    detail = ""
    try:
        j = json.loads(body)
        detail = (get(j.get("error"), "message") or get(j.get("error"), "code")) or j.get("message") or ""
    except ValueError:
        pass
    hint = " The sign-in has expired or is for another tenant." if status == 401 else \
        " You need access to the workspace (and for report definitions: permission to edit the report)." if status == 403 else ""
    raise Exception("Power BI answered " + str(status) + " for " + re.sub(r"^https://[^/]+", "", url) + (": " + jstr(detail) if detail else "") + "." + hint)


def waitFor(res, token):
    """Fabric long-running operation: poll until it is done, then read the result."""
    status, headers, body = res
    if status != 202:
        return json.loads(body)
    loc = headers.get("location")
    if not loc:
        raise Exception("Power BI started a long-running operation but gave no address to follow.")
    for _ in range(120):
        try:
            wait = float(headers.get("retry-after") or 0)
        except ValueError:
            wait = 0
        sleep(max(1, wait or 2))
        st = json.loads(call(loc, token)[2])
        if st.get("status") == "Succeeded":
            return json.loads(call(re.sub(r"/?\Z", "/result", loc, count=1), token)[2])
        if st.get("status") == "Failed":
            msg = get(st.get("error"), "message")
            raise Exception("Power BI could not export the definition" + (": " + trim(jstr(msg)) if msg else "."))
    raise Exception("Power BI took too long to export a definition.")


def safe(s):
    return trim(re.sub(r'[\\/:*?"<>|]', " ", jstr(s))) or "report"


def partsToFiles(definition, root):
    """The parts of an item definition as files under root; only text parts the tool reads."""
    out = []
    for p in get(get(definition, "definition"), "parts") or []:
        path = p.get("path") or ""
        if not re.search(r"\.(json|pbir|pbism|tmdl|bim)\Z", path, I) or re.match("StaticResources/", path, I) or re.match(r"\.pbi/", path, I):
            continue
        out.append({"path": root + "/" + path, "text": base64.b64decode(p.get("payload") or "").decode("utf-8", "replace")})
    return out


# ---------------------------------------------------------------- Azure Analysis Services (xmla-model.ps1)

AAS_RESOURCE = "https://*.asazure.windows.net"
_AAS_SERVER = re.compile(r"asazure://([a-z0-9-]+)\.asazure\.windows\.net/([^:/?;]+)", I)
_XA = "urn:schemas-microsoft-com:xml-analysis"


def aasToken(tenant, clientId, secret):
    """A token for Azure Analysis Services for a service principal (an app registration with a client secret).
    A Fabric notebook cannot get this token as the signed-in user, so reading AAS needs an app of its own."""
    body = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": clientId, "client_secret": secret, "scope": AAS_RESOURCE + "/.default"}).encode("utf-8")
    status, _, text = http("POST", "https://login.microsoftonline.com/" + urllib.parse.quote(trim(tenant)) + "/oauth2/v2.0/token", None, body, {"Content-Type": "application/x-www-form-urlencoded"})
    try:
        j = json.loads(text)
    except ValueError:
        j = {}
    if status != 200 or not j.get("access_token"):
        why = jstr(j.get("error_description") or j.get("error") or "no answer").split("\n")[0]
        raise Exception("Could not sign in to Azure Analysis Services as the service principal (" + str(status) + "): " + trim(why))
    return j["access_token"]


def aasConnect(server, token):
    """asazure://<region>.asazure.windows.net/<server> → a connection: where its XMLA endpoint is, and the token."""
    m = _AAS_SERVER.match(trim(server))
    if not m:
        raise Exception("Not an Azure Analysis Services server: " + server)
    region, name = m.group(1).lower(), m.group(2)
    status, _, text = http("POST", "https://" + region + ".asazure.windows.net/webapi/clusterResolve", token, json.dumps({"serverName": name, "premiumPublicXmlaEndpoint": True}).encode("utf-8"))
    try:
        j = json.loads(text)
    except ValueError:
        j = {}
    if status != 200 or not j.get("clusterFQDN"):
        raise Exception("Azure Analysis Services answered " + str(status) + " for server " + name + (": " + jstr(j.get("message")) if j.get("message") else "."))
    return {"url": "https://" + j["clusterFQDN"] + "/webapi/xmla", "server": name, "token": token}


def _xmlText(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def aasRows(conn, kind, inner, catalog=""):
    """One XMLA request (Discover or Execute) → the rows of the answer, each a dict of column → text."""
    env = ('<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/"><Body><' + kind + ' xmlns="' + _XA + '">' + inner +
           "<Properties><PropertyList><Format>Tabular</Format>" + ("<Catalog>" + _xmlText(catalog) + "</Catalog>" if catalog else "") +
           "</PropertyList></Properties></" + kind + "></Body></Envelope>")
    status, _, text = http("POST", conn["url"], conn["token"], env.encode("utf-8"), {
        "Content-Type": "text/xml", "x-ms-xmlaserver": conn["server"], "x-ms-xmlacaps-negotiation-flags": "0,0,0,0,0",
        "SOAPAction": '"' + _XA + ":" + kind + '"', "User-Agent": "XmlaClient"})
    if status != 200:
        detail = text
        try:
            detail = jstr(json.loads(text).get("message") or text)
        except ValueError:
            pass
        raise Exception("Azure Analysis Services answered " + str(status) + ": " + trim(detail)[:300])
    root = xml.etree.ElementTree.fromstring(text)
    for e in root.iter():
        tag = e.tag.split("}")[-1]
        if tag == "Fault":
            raise Exception(trim(" ".join(x for x in e.itertext() if trim(x)))[:300])
        if tag == "Error" and e.get("Description"):
            raise Exception(e.get("Description")[:300])
    return [{c.tag.split("}")[-1]: (c.text or "") for c in r} for r in root.iter("{urn:schemas-microsoft-com:xml-analysis:rowset}row")]


def aasQuery(conn, sql, catalog):
    return aasRows(conn, "Execute", "<Command><Statement>" + _xmlText(sql) + "</Statement></Command>", catalog)


def aasCatalogs(conn):
    return [r.get("CATALOG_NAME") for r in aasRows(conn, "Discover", "<RequestType>DBSCHEMA_CATALOGS</RequestType><Restrictions><RestrictionList/></Restrictions>")]


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def _bool(v):
    return v == "true"


_DATA_TYPES = {2: "string", 6: "int64", 8: "double", 9: "dateTime", 10: "decimal", 11: "boolean", 17: "binary", 20: "variant"}
_PART_TYPES = {1: "query", 2: "calculated", 4: "m", 5: "entity", 6: "policyRange", 7: "calculationGroup"}
_MODES = {0: "import", 1: "directQuery", 2: "default", 3: "push", 4: "dual", 5: "directLake"}


def aasBim(conn, database):
    """The definition of a model on the server, in model.bim shape. Reads the schema tables of the model; that needs
    admin permission on the server or the database."""
    def query(name):
        return aasQuery(conn, "SELECT * FROM $SYSTEM.TMSCHEMA_" + name, database)

    def tryQuery(name):
        try:
            return query(name)
        except Exception:  # an older server does not have every schema table
            return []

    try:
        tRows = query("TABLES")
    except Exception as e:
        raise Exception("Could not read the model definition. Reading it needs admin permission on the server or the model. Server said: " + str(e))
    tables, colName = {}, {}
    for t in tRows:
        tables[t.get("ID")] = {"name": t.get("Name") or "", "description": t.get("Description") or "", "isHidden": _bool(t.get("IsHidden")), "dataCategory": t.get("DataCategory") or "",
                               "columns": [], "measures": [], "partitions": [], "hierarchies": []}
    sortBy = []
    for col in query("COLUMNS"):
        t = tables.get(col.get("TableID"))
        if t is None:
            continue
        name = col.get("ExplicitName") or col.get("InferredName") or ""
        colName[col.get("ID")] = name
        kind = {2: "calculated", 3: "rowNumber", 4: "calculatedTableColumn"}.get(_int(col.get("Type")), "data")
        c = {"name": name, "type": kind, "dataType": _DATA_TYPES.get(_int(col.get("ExplicitDataType"))) or _DATA_TYPES.get(_int(col.get("InferredDataType"))), "isHidden": _bool(col.get("IsHidden")),
             "description": col.get("Description") or "", "expression": col.get("Expression") or "", "sourceColumn": col.get("SourceColumn") or "", "isNullable": _bool(col.get("IsNullable")),
             "displayFolder": col.get("DisplayFolder") or ""}
        t["columns"].append(c)
        sortBy.append((c, col.get("SortByColumnID")))
    for c, by in sortBy:
        if by and colName.get(by):
            c["sortByColumn"] = colName[by]
    for m in tryQuery("MEASURES"):
        t = tables.get(m.get("TableID"))
        if t is not None:
            t["measures"].append({"name": m.get("Name") or "", "expression": m.get("Expression") or "", "description": m.get("Description") or "", "isHidden": _bool(m.get("IsHidden")),
                                  "formatString": m.get("FormatString") or "", "displayFolder": m.get("DisplayFolder") or ""})
    for p in tryQuery("PARTITIONS"):
        t = tables.get(p.get("TableID"))
        if t is not None:
            t["partitions"].append({"name": p.get("Name") or "", "mode": _MODES.get(_int(p.get("Mode"))), "source": {"type": _PART_TYPES.get(_int(p.get("Type")), "none"), "expression": p.get("QueryDefinition") or ""}})
    hier = {}
    for h in tryQuery("HIERARCHIES"):
        t = tables.get(h.get("TableID"))
        if t is not None:
            hier[h.get("ID")] = {"name": h.get("Name") or "", "levels": []}
            t["hierarchies"].append(hier[h.get("ID")])
    for l in sorted(tryQuery("LEVELS"), key=lambda l: _int(l.get("Ordinal"))):
        h = hier.get(l.get("HierarchyID"))
        if h is not None:
            h["levels"].append({"name": l.get("Name") or "", "column": colName.get(l.get("ColumnID"))})
    groups = {}
    for g in tryQuery("CALCULATION_GROUPS"):
        t = tables.get(g.get("TableID"))
        if t is not None:
            t["calculationGroup"] = {"calculationItems": []}
            groups[g.get("ID")] = t["calculationGroup"]
    for i in tryQuery("CALCULATION_ITEMS"):
        g = groups.get(i.get("CalculationGroupID"))
        if g is not None:
            g["calculationItems"].append({"name": i.get("Name") or "", "expression": i.get("Expression") or ""})
    rels = []
    for r in tryQuery("RELATIONSHIPS"):
        ft, tt = tables.get(r.get("FromTableID")), tables.get(r.get("ToTableID"))
        if ft is None or tt is None:
            continue
        rels.append({"name": r.get("Name") or "", "fromTable": ft["name"], "fromColumn": colName.get(r.get("FromColumnID")), "toTable": tt["name"], "toColumn": colName.get(r.get("ToColumnID")),
                     "isActive": _bool(r.get("IsActive")), "relyOnReferentialIntegrity": _bool(r.get("RelyOnReferentialIntegrity")),
                     "fromCardinality": "one" if _int(r.get("FromCardinality")) == 1 else "many", "toCardinality": "many" if _int(r.get("ToCardinality")) == 2 else "one",
                     "crossFilteringBehavior": "bothDirections" if _int(r.get("CrossFilteringBehavior")) == 2 else "oneDirection"})
    roles = {}
    for r in tryQuery("ROLES"):
        roles[r.get("ID")] = {"name": r.get("Name") or "", "tablePermissions": []}
    for p in tryQuery("TABLE_PERMISSIONS"):
        role, t = roles.get(p.get("RoleID")), tables.get(p.get("TableID"))
        if role is not None and t is not None:
            role["tablePermissions"].append({"name": t["name"], "filterExpression": p.get("FilterExpression") or ""})
    expressions = [{"name": e.get("Name") or "", "expression": e.get("Expression") or ""} for e in tryQuery("EXPRESSIONS")]
    return {"model": {"tables": list(tables.values()), "relationships": rels, "roles": list(roles.values()), "expressions": expressions}}


def modelFromBim(bim):
    """A model in model.bim shape (TMSL JSON) → the model the analysis works on."""
    src = bim.get("model") or bim
    model = emptyModel()
    for t in src.get("tables") or []:
        out = {"name": t.get("name"), "description": joinExpr(t.get("description")), "isHidden": truthy(t.get("isHidden")), "dataCategory": t.get("dataCategory") or "",
               "kind": "table", "expression": "", "sourceType": "", "mode": "", "source": "",
               "columns": [], "measures": [], "hierarchies": [], "calcItems": []}
        for p in t.get("partitions") or []:
            s = p.get("source") or {}
            out["sourceType"] = out["sourceType"] or s.get("type") or ""
            out["mode"] = p.get("mode") or out["mode"]
            if s.get("type") == "calculated":
                out["kind"] = "calculated table"
                out["expression"] = joinExpr(s.get("expression"))
            elif not out["source"]:
                out["source"] = joinExpr(s.get("expression") or s.get("query"))
        if truthy(t.get("calculationGroup")):
            out["kind"] = "calculation group"
            for it in t["calculationGroup"].get("calculationItems") or []:
                fsd = it.get("formatStringDefinition")
                out["calcItems"].append({"name": it.get("name"), "expression": joinExpr(it.get("expression")),
                                         "extraExpressions": [x for x in (joinExpr(fsd.get("expression")) if truthy(fsd) else None,) if truthy(x)]})
        for c in t.get("columns") or []:
            out["columns"].append({"name": c.get("name"), "expression": joinExpr(c.get("expression")), "isCalculated": c.get("type") == "calculated",
                                   "description": joinExpr(c.get("description")), "isHidden": truthy(c.get("isHidden")), "dataType": c.get("dataType") or "",
                                   "displayFolder": c.get("displayFolder") or "", "sortByColumn": c.get("sortByColumn") or "",
                                   "sourceColumn": c.get("sourceColumn") or "", "isSystem": c.get("type") == "rowNumber", "isNullable": c.get("isNullable") is not False})
        for m in t.get("measures") or []:
            extra = [m.get("formatStringDefinition") and joinExpr(m["formatStringDefinition"].get("expression")), m.get("detailRowsDefinition") and joinExpr(m["detailRowsDefinition"].get("expression"))]
            kpi = m.get("kpi")
            if truthy(kpi):
                extra += [joinExpr(kpi.get("targetExpression")), joinExpr(kpi.get("statusExpression")), joinExpr(kpi.get("trendExpression"))]
            out["measures"].append({"name": m.get("name"), "expression": joinExpr(m.get("expression")), "description": joinExpr(m.get("description")),
                                    "isHidden": truthy(m.get("isHidden")), "displayFolder": m.get("displayFolder") or "", "formatString": m.get("formatString") or "",
                                    "extraExpressions": [x for x in extra if truthy(x)]})
        for h in t.get("hierarchies") or []:
            out["hierarchies"].append({"name": h.get("name"), "levels": [{"name": l.get("name"), "column": l.get("column")} for l in h.get("levels") or []]})
        model["tables"].append(out)
    for r in src.get("relationships") or []:
        model["relationships"].append({"name": r.get("name"), "fromTable": r.get("fromTable"), "fromColumn": r.get("fromColumn"), "toTable": r.get("toTable"), "toColumn": r.get("toColumn"),
                                       "isActive": r.get("isActive") is not False, "rely": truthy(r.get("relyOnReferentialIntegrity")), "crossFilter": r.get("crossFilteringBehavior") or "",
                                       "fromCardinality": r.get("fromCardinality") or "many", "toCardinality": r.get("toCardinality") or "one"})
    for r in src.get("roles") or []:
        model["roles"].append({"name": r.get("name"), "permissions": [{"table": p.get("name"), "expression": joinExpr(p.get("filterExpression"))} for p in r.get("tablePermissions") or []]})
    for f in src.get("functions") or []:
        model["functions"].append({"name": f.get("name"), "expression": joinExpr(f.get("expression"))})
    for e in src.get("expressions") or []:
        model["expressions"].append({"name": e.get("name"), "expression": joinExpr(e.get("expression"))})
    return model


def aasModel(server, database, token):
    """Reads a model from Azure Analysis Services. → (the model, the name of the database as the server spells it)"""
    conn = aasConnect(server, token)
    names = aasCatalogs(conn)
    name = next((n for n in names if lc(n) == lc(database)), None)
    if name is None:
        raise Exception('Database "' + jstr(database) + '" not found on ' + server + " (it has: " + ", ".join(jstr(n) for n in names) + ").")
    return modelFromBim(aasBim(conn, name)), name


def liveSource(m, token):
    """Where a dataset without a model of its own gets its data: {server, database} for Analysis Services, else None."""
    try:
        sources = json.loads(call(PBI + "/groups/" + m["workspaceId"] + "/datasets/" + m["id"] + "/datasources", token)[2]).get("value") or []
    except Exception:
        return None
    for s in sources:
        d = s.get("connectionDetails") or {}
        if s.get("datasourceType") == "AnalysisServices" and d.get("server"):
            return {"server": d["server"], "database": d.get("database") or ""}
    return None


def workspaceModels(workspace, token, onModel):
    """Every semantic model in one or more workspaces, each with the reports in those workspaces that use it. A report
    whose model is in another workspace is followed there: that model is read too, with only the chosen reports.
    workspace: a name, an id, several separated by commas, or "*" for every workspace you can open.
    onModel(model) is called as each one is ready, with {workspace, name, files, reports, warnings, outside}. → warnings"""
    want = trim(workspace or "")
    if not want:
        raise Exception("Give the name or id of the workspace, or * for every workspace.")
    groups = json.loads(call(PBI + "/groups?$top=5000", token)[2]).get("value") or []
    if want == "*":
        chosen = groups
    else:
        names = set(x.lower() for x in re.split(S + "*[;,]" + S + "*", want))
        chosen = [g for g in groups if g["id"].lower() in names or jstr(g.get("name")).lower() in names]
        if not chosen:
            raise Exception('Workspace "' + want + '" not found among the ' + str(len(groups)) + " workspaces you can open.")
    warnings = []
    lower = lambda s: jstr(s or "").lower()
    byModel, todo = {}, []  # the reports of the chosen workspaces, by the model they use: workspace of the model | model
    for ws in chosen:
        try:
            sets = json.loads(call(PBI + "/groups/" + ws["id"] + "/datasets", token)[2]).get("value") or []
            reps = [r for r in json.loads(call(PBI + "/groups/" + ws["id"] + "/reports", token)[2]).get("value") or [] if r.get("reportType") != "PaginatedReport"]
        except Exception as e:
            warnings.append(jstr(ws.get("name")) + ": " + str(e))
            continue
        todo += [(ws, d, False) for d in sets]
        for r in reps:
            if r.get("datasetId"):
                byModel.setdefault(lower(r.get("datasetWorkspaceId") or ws["id"]) + "|" + lower(r["datasetId"]), []).append((ws, r))
    # models in other workspaces that chosen reports use
    have = set(lower(ws["id"]) + "|" + lower(d["id"]) for ws, d, _ in todo)
    for k, lst in byModel.items():
        if k in have:
            continue
        wsId, dsId = k.split("|")
        which = ", ".join(jstr(w.get("name")) + " / " + jstr(r.get("name")) for w, r in lst)
        ws = next((g for g in groups if lower(g["id"]) == wsId), None)
        if ws is None:
            warnings.append(which + ": its model is in a workspace you cannot open")
            continue
        try:
            todo.append((ws, json.loads(call(PBI + "/groups/" + ws["id"] + "/datasets/" + dsId, token)[2]), True))
        except Exception as e:
            warnings.append(which + ": " + str(e))
    for ws, d, outside in todo:
        if re.fullmatch("Report Usage Metrics Model|Usage Metrics Report", jstr(d.get("name")), I):
            continue
        m = {"workspace": ws.get("name"), "workspaceId": ws["id"], "name": d.get("name"), "id": d["id"], "files": [], "reports": [], "warnings": [], "outside": outside}
        root = "fabric/" + safe(ws.get("name")) + "/" + safe(d.get("name"))
        try:
            definition = waitFor(call(FABRIC + "/workspaces/" + ws["id"] + "/semanticModels/" + d["id"] + "/getDefinition?format=TMDL", token, "POST"), token)
            m["files"] += partsToFiles(definition, root + "/" + safe(d.get("name")) + ".SemanticModel")
        except Exception as e:
            warnings.append(jstr(ws.get("name")) + " / " + jstr(d.get("name")) + ": " + str(e))
            continue
        for rws, r in byModel.get(lower(ws["id"]) + "|" + lower(d["id"])) or []:
            # a report from another workspace than its model is named after its own workspace too
            name = r.get("name") if rws["id"] == ws["id"] else jstr(rws.get("name")) + " - " + jstr(r.get("name"))
            try:
                definition = waitFor(call(FABRIC + "/workspaces/" + rws["id"] + "/reports/" + r["id"] + "/getDefinition", token, "POST"), token)
                m["files"] += partsToFiles(definition, root + "/" + safe(name) + ".Report")
                m["reports"].append(name)
            except Exception as e:
                m["warnings"].append("report " + jstr(name) + ": " + str(e))
        onModel(m)
    return warnings


def scan(workspaces, folder, token, now=None, log=print, aas_token=None):
    """Checks every semantic model in the workspaces and adds one run per model to <folder>/data.
    aas_token: a token for Azure Analysis Services (see aasToken). With it, reports that are connected live to a
    model on Azure Analysis Services are checked against that model: one run per model on the server.
    → {"models": [a summary per model], "warnings": [...], "failed": number}"""
    done, failed = [], [0]
    live = {}  # models on Azure Analysis Services that reports connect to: (server, database) → what was found

    def export(name, source, proj):
        analysis, checks = analyzeProject(proj)
        when = now or datetime.datetime.now()
        run, _ = writeRun(folder, lambda run: runTables(analysis, checks, run, when, name, source, VERSION, len(proj["reports"]), analysis["stats"]["visuals"]))
        done.append(summary(name, analysis, checks))
        return run

    def reports(n):
        return str(n) + " report" + ("" if n == 1 else "s")

    def onModel(m):
        name = jstr(m["workspace"]) + " / " + jstr(m["name"])
        try:
            proj = loadProject(m["files"])
            if not proj["models"] or proj["models"][0].get("missing"):
                src = liveSource(m, token)
                if src and _AAS_SERVER.match(src["server"]):
                    where = src["server"] + " / " + src["database"]
                    if aas_token:
                        entry = live.setdefault((src["server"].lower(), src["database"].lower()), {"server": src["server"], "database": src["database"], "files": [], "reports": 0})
                        entry["files"] += [f for f in m["files"] if not f["path"].lower().endswith(".tmdl")]
                        entry["reports"] += len(m["reports"])
                        log(name + ": live connection to " + where + ", checked with that model")
                        return
                    log(name + ": live connection to " + where + "; that model is not read (fill in the AAS settings)")
            if not proj["models"]:
                raise Exception("no model in its definition")
            run = export(name, name, proj)
            log(name + ": run " + str(run) + ", " + reports(len(m["reports"])) + (OUTSIDE if m.get("outside") else ""))
            for w in m["warnings"]:
                log("  ! " + w)
        except Exception as e:
            failed[0] += 1
            log(name + ": " + str(e))

    warnings = workspaceModels(workspaces, token, onModel)
    for entry in live.values():
        where = entry["server"] + " / " + entry["database"]
        try:
            model, database = aasModel(entry["server"], entry["database"], aas_token)
            proj = loadProject(entry["files"])
            name = "AAS " + _AAS_SERVER.match(entry["server"]).group(2) + " / " + database
            proj["models"] = [{"name": name, "root": "", "model": model, "format": "aas"}]
            run = export(name, entry["server"] + " / " + database, proj)
            log(name + ": run " + str(run) + ", " + reports(entry["reports"]))
        except Exception as e:
            failed[0] += 1
            log(where + ": " + str(e))
    for w in warnings:
        log("! " + w)
    log("")
    log(str(len(done)) + " model" + ("" if len(done) == 1 else "s") + " exported to " + folder + (", " + str(failed[0]) + " could not be read" if failed[0] else ""))
    return {"models": done, "warnings": warnings, "failed": failed[0]}
