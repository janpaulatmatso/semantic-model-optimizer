/* Semantic Model Optimizer — analysis core.
 * Runs in the browser (window.SMO) and in Node (require).
 * Input: a list of files [{path, text}] from a PBIP folder, PBIX or PBIT.
 * Output: model, reports, and per measure/column where it is used and what it depends on.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SMO = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- TMDL

  function indentOf(raw) {
    let n = 0, spaces = 0;
    for (const ch of raw) {
      if (ch === '\t') n++;
      else if (ch === ' ') { spaces++; if (spaces === 4) { n++; spaces = 0; } }
      else break;
    }
    return n;
  }

  /** Reads a TMDL name ('with spaces' or without) at the start of s. */
  function readName(s) {
    s = s.replace(/^\s+/, '');
    if (s[0] === "'") {
      let i = 1, name = '';
      while (i < s.length) {
        if (s[i] === "'") {
          if (s[i + 1] === "'") { name += "'"; i += 2; continue; }
          i++; break;
        }
        name += s[i++];
      }
      return { name, rest: s.slice(i) };
    }
    const m = /^[^\s=:.]+/.exec(s);
    const name = m ? m[0] : '';
    return { name, rest: s.slice(name.length) };
  }

  /** 'Table name'.'Column name' or Table.Column → [table, column] */
  function readQualified(s) {
    const a = readName(s);
    const rest = a.rest.replace(/^\s*\.\s*/, '');
    if (rest === a.rest) return [a.name, ''];
    const b = readName(rest);
    return [a.name, b.name];
  }

  function unquoteValue(v) {
    v = (v || '').trim();
    if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') return v.slice(1, -1).replace(/""/g, '"');
    if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") return v.slice(1, -1).replace(/''/g, "'");
    return v;
  }

  /** TMDL text → tree of {kw, name, value, expr, props, children, description}. */
  function parseTmdlTree(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);
    const rootNode = { indent: -1, kw: 'root', children: [], props: {} };
    const stack = [rootNode];
    let desc = [];
    let i = 0;
    while (i < lines.length) {
      const raw = lines[i];
      const line = raw.trim();
      if (!line) { i++; continue; }
      const indent = indentOf(raw);
      if (line.startsWith('///')) { desc.push(line.slice(3).trim()); i++; continue; }
      while (stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack[stack.length - 1];
      i++;

      let m;
      // property: key: value
      if ((m = /^([A-Za-z_]\w*)\s*:\s?(.*)$/.exec(line))) {
        parent.props[m[1]] = m[2];
        desc = [];
        continue;
      }
      let node = null, exprStart = null, minIndent = indent + 1;
      if ((m = /^([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(line))) {
        // expression property without a name: source =, expression =, formatStringDefinition =
        node = { kw: m[1], name: '', isProp: true };
        exprStart = m[2];
      } else if ((m = /^([A-Za-z_]\w*)\s+(.+)$/.exec(line))) {
        const kw = m[1];
        let rest = m[2];
        if (kw === 'ref') { desc = []; continue; }
        const nm = readName(rest);
        node = { kw, name: nm.name };
        rest = nm.rest.trim();
        // relationship/level etc. have no '='; tablePermission/measure/column do
        if (rest.startsWith('=')) { exprStart = rest.slice(1).trim(); minIndent = indent + 2; }
        else if (rest.startsWith('.')) {
          // qualified name (e.g. perspectiveTable); ignored from here on
          node.name = m[2];
        }
      } else {
        // bare flag: isHidden, relyOnReferentialIntegrity
        parent.props[line] = true;
        desc = [];
        continue;
      }

      if (exprStart !== null) {
        let expr = exprStart;
        if (exprStart.startsWith('```')) {
          const buf = [];
          let first = exprStart.slice(3);
          if (first.trim().endsWith('```')) { expr = first.trim().slice(0, -3); }
          else {
            if (first.trim()) buf.push(first);
            while (i < lines.length) {
              const l = lines[i++];
              if (l.trim().endsWith('```')) { const t = l.replace(/```\s*$/, ''); if (t.trim()) buf.push(t); break; }
              buf.push(l);
            }
            expr = dedent(buf).join('\n');
          }
        } else if (exprStart === '') {
          const buf = [];
          while (i < lines.length) {
            const l = lines[i];
            if (!l.trim()) { buf.push(''); i++; continue; }
            if (indentOf(l) < minIndent) break;
            buf.push(l); i++;
          }
          while (buf.length && !buf[buf.length - 1].trim()) buf.pop();
          expr = dedent(buf).join('\n');
        }
        node.expr = expr;
      }
      node.indent = indent;
      node.children = [];
      node.props = {};
      node.description = desc.join('\n');
      desc = [];
      if (node.isProp) {
        parent.props[node.kw] = node.expr;
      } else {
        parent.children.push(node);
        stack.push(node);
      }
    }
    return rootNode;
  }

  function dedent(buf) {
    let min = Infinity;
    for (const l of buf) {
      if (!l.trim()) continue;
      const ws = /^[\t ]*/.exec(l)[0].length;
      if (ws < min) min = ws;
    }
    if (!isFinite(min)) min = 0;
    return buf.map(l => l.slice(Math.min(min, l.length)).replace(/\s+$/, ''));
  }

  function emptyModel() {
    return { tables: [], relationships: [], roles: [], functions: [], expressions: [] };
  }

  function addTmdlToModel(model, text) {
    const tree = parseTmdlTree(text);
    for (const n of tree.children) {
      if (n.kw === 'table') model.tables.push(tableFromTmdl(n));
      else if (n.kw === 'relationship') {
        const [ft, fc] = readQualified(n.props.fromColumn || '');
        const [tt, tc] = readQualified(n.props.toColumn || '');
        model.relationships.push({
          name: n.name, fromTable: ft, fromColumn: fc, toTable: tt, toColumn: tc,
          isActive: String(n.props.isActive) !== 'false',
          crossFilter: n.props.crossFilteringBehavior || '', fromCardinality: n.props.fromCardinality || 'many', toCardinality: n.props.toCardinality || 'one',
        });
      } else if (n.kw === 'role') {
        const role = { name: n.name, permissions: [] };
        for (const c of n.children) {
          if (c.kw === 'tablePermission') role.permissions.push({ table: c.name, expression: c.expr || '' });
        }
        model.roles.push(role);
      } else if (n.kw === 'function') {
        model.functions.push({ name: n.name, expression: n.expr || '', description: n.description });
      } else if (n.kw === 'expression') {
        model.expressions.push({ name: n.name, expression: n.expr || '' });
      }
    }
  }

  function tableFromTmdl(n) {
    const t = {
      name: n.name, description: n.description, isHidden: !!n.props.isHidden,
      kind: 'table', expression: '', sourceType: '', mode: '',
      columns: [], measures: [], hierarchies: [], calcItems: [],
    };
    for (const c of n.children) {
      if (c.kw === 'measure') {
        t.measures.push({
          name: c.name, expression: c.expr || '', description: c.description,
          isHidden: !!c.props.isHidden, displayFolder: unquoteValue(c.props.displayFolder),
          formatString: c.props.formatString || '',
          extraExpressions: [c.props.formatStringDefinition, c.props.detailRowsDefinition].filter(Boolean),
        });
      } else if (c.kw === 'column') {
        t.columns.push({
          name: c.name, expression: c.expr || '', isCalculated: c.expr != null && c.expr !== '',
          description: c.description, isHidden: !!c.props.isHidden,
          dataType: c.props.dataType || '', displayFolder: unquoteValue(c.props.displayFolder),
          sortByColumn: c.props.sortByColumn ? readName(c.props.sortByColumn).name : '',
          sourceColumn: c.props.sourceColumn || '',
          isSystem: c.props.type === 'rowNumber',
        });
      } else if (c.kw === 'hierarchy') {
        t.hierarchies.push({
          name: c.name,
          levels: c.children.filter(l => l.kw === 'level').map(l => ({
            name: l.name, column: l.props.column ? readName(l.props.column).name : l.name,
          })),
        });
      } else if (c.kw === 'partition') {
        const type = (c.expr || '').trim();
        t.sourceType = t.sourceType || type;
        t.mode = c.props.mode || t.mode;
        if (type === 'calculated') { t.kind = 'calculated table'; t.expression = c.props.source || ''; }
        else if (!t.source) t.source = c.props.source || '';
      } else if (c.kw === 'calculationGroup') {
        t.kind = 'calculation group';
        for (const it of c.children) {
          if (it.kw === 'calculationItem') {
            t.calcItems.push({
              name: it.name, expression: it.expr || '',
              extraExpressions: [it.props.formatStringDefinition].filter(Boolean),
            });
          }
        }
      }
    }
    return t;
  }

  // ---------------------------------------------------------------- BIM / DataModelSchema (TMSL JSON)

  function joinExpr(e) { return Array.isArray(e) ? e.join('\n') : (e == null ? '' : String(e)); }

  function modelFromBim(json) {
    const src = json.model || json;
    const model = emptyModel();
    for (const t of src.tables || []) {
      const out = {
        name: t.name, description: joinExpr(t.description), isHidden: !!t.isHidden,
        kind: 'table', expression: '', sourceType: '', mode: '', source: '',
        columns: [], measures: [], hierarchies: [], calcItems: [],
      };
      for (const p of t.partitions || []) {
        const s = p.source || {};
        out.sourceType = out.sourceType || s.type || '';
        out.mode = p.mode || out.mode;
        if (s.type === 'calculated') { out.kind = 'calculated table'; out.expression = joinExpr(s.expression); }
        else if (!out.source) out.source = joinExpr(s.expression || s.query);
      }
      if (t.calculationGroup) {
        out.kind = 'calculation group';
        for (const it of t.calculationGroup.calculationItems || []) {
          out.calcItems.push({
            name: it.name, expression: joinExpr(it.expression),
            extraExpressions: [it.formatStringDefinition && joinExpr(it.formatStringDefinition.expression)].filter(Boolean),
          });
        }
      }
      for (const c of t.columns || []) {
        out.columns.push({
          name: c.name, expression: joinExpr(c.expression), isCalculated: c.type === 'calculated',
          description: joinExpr(c.description), isHidden: !!c.isHidden, dataType: c.dataType || '',
          displayFolder: c.displayFolder || '', sortByColumn: c.sortByColumn || '',
          sourceColumn: c.sourceColumn || '', isSystem: c.type === 'rowNumber',
        });
      }
      for (const m of t.measures || []) {
        out.measures.push({
          name: m.name, expression: joinExpr(m.expression), description: joinExpr(m.description),
          isHidden: !!m.isHidden, displayFolder: m.displayFolder || '', formatString: m.formatString || '',
          extraExpressions: [
            m.formatStringDefinition && joinExpr(m.formatStringDefinition.expression),
            m.detailRowsDefinition && joinExpr(m.detailRowsDefinition.expression),
            m.kpi && joinExpr(m.kpi.targetExpression), m.kpi && joinExpr(m.kpi.statusExpression),
            m.kpi && joinExpr(m.kpi.trendExpression),
          ].filter(Boolean),
        });
      }
      for (const h of t.hierarchies || []) {
        out.hierarchies.push({ name: h.name, levels: (h.levels || []).map(l => ({ name: l.name, column: l.column })) });
      }
      model.tables.push(out);
    }
    for (const r of src.relationships || []) {
      model.relationships.push({
        name: r.name, fromTable: r.fromTable, fromColumn: r.fromColumn, toTable: r.toTable, toColumn: r.toColumn,
        isActive: r.isActive !== false, crossFilter: r.crossFilteringBehavior || '', fromCardinality: r.fromCardinality || 'many', toCardinality: r.toCardinality || 'one',
      });
    }
    for (const r of src.roles || []) {
      model.roles.push({
        name: r.name,
        permissions: (r.tablePermissions || []).map(p => ({ table: p.name, expression: joinExpr(p.filterExpression) })),
      });
    }
    for (const f of src.functions || []) model.functions.push({ name: f.name, expression: joinExpr(f.expression) });
    for (const e of src.expressions || []) model.expressions.push({ name: e.name, expression: joinExpr(e.expression) });
    return model;
  }

  // ---------------------------------------------------------------- DAX references

  const IDENT_START = /[\p{L}_]/u;
  const IDENT_PART = /[\p{L}\p{N}_.]/u;

  /** Extracts references from a DAX expression: [{t:'q',table,name} | {t:'b',name} | {t:'t',table} | {t:'f',name}] */
  function daxRefs(expr) {
    const refs = [];
    const s = expr || '';
    const n = s.length;
    let i = 0;
    const skipWs = j => { while (j < n && /\s/.test(s[j])) j++; return j; };
    const readBracket = j => { // s[j] === '['
      let name = '';
      j++;
      const ns = j;
      let ne = n;
      while (j < n) {
        if (s[j] === ']') { if (s[j + 1] === ']') { name += ']'; j += 2; continue; } ne = j; j++; break; }
        name += s[j++];
      }
      return { name, end: j, ns, ne };
    };
    while (i < n) {
      const ch = s[i];
      if (ch === '"') {
        i++;
        while (i < n) { if (s[i] === '"') { if (s[i + 1] === '"') { i += 2; continue; } i++; break; } i++; }
      } else if ((ch === '/' && s[i + 1] === '/') || (ch === '-' && s[i + 1] === '-')) {
        while (i < n && s[i] !== '\n') i++;
      } else if (ch === '/' && s[i + 1] === '*') {
        const e = s.indexOf('*/', i + 2);
        i = e < 0 ? n : e + 2;
      } else if (ch === "'") {
        let name = '';
        i++;
        while (i < n) {
          if (s[i] === "'") { if (s[i + 1] === "'") { name += "'"; i += 2; continue; } i++; break; }
          name += s[i++];
        }
        const j = skipWs(i);
        if (s[j] === '[') { const b = readBracket(j); refs.push({ t: 'q', table: name, name: b.name, ns: b.ns, ne: b.ne }); i = b.end; }
        else refs.push({ t: 't', table: name });
      } else if (ch === '[') {
        const b = readBracket(i);
        refs.push({ t: 'b', name: b.name, ns: b.ns, ne: b.ne });
        i = b.end;
      } else if (IDENT_START.test(ch)) {
        let j = i + 1;
        while (j < n && IDENT_PART.test(s[j])) j++;
        const ident = s.slice(i, j);
        const k = skipWs(j);
        if (s[k] === '[') { const b = readBracket(k); refs.push({ t: 'q', table: ident, name: b.name, ns: b.ns, ne: b.ne }); i = b.end; }
        else if (s[k] === '(') { refs.push({ t: 'f', name: ident }); i = j; }
        else { refs.push({ t: 't', table: ident }); i = j; }
      } else if (/[0-9]/.test(ch)) {
        while (i < n && /[0-9.eE]/.test(s[i])) i++;
      } else i++;
    }
    return refs;
  }

  // ---------------------------------------------------------------- Reports

  function tryJson(text) {
    if (text == null) return null;
    if (typeof text !== 'string') return text;
    try { return JSON.parse(text.replace(/^﻿/, '')); } catch (e) { return null; }
  }

  function entityOf(expr, aliases) {
    const sr = expr && expr.SourceRef;
    if (!sr) return null;
    if (sr.Entity != null) return sr.Entity;
    if (sr.Source != null && aliases[sr.Source] != null) return aliases[sr.Source];
    return null;
  }

  /** Walks arbitrary report JSON and reports every field reference. */
  function walkRefs(n, aliases, emit) {
    if (Array.isArray(n)) { for (const x of n) walkRefs(x, aliases, emit); return; }
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n.From)) {
      aliases = Object.assign({}, aliases);
      for (const f of n.From) if (f && f.Name != null && f.Entity != null) aliases[f.Name] = f.Entity;
    }
    for (const kind of ['Column', 'Measure']) {
      const c = n[kind];
      if (c && typeof c === 'object' && typeof c.Property === 'string' && c.Expression) {
        const ent = entityOf(c.Expression, aliases);
        if (ent != null) emit({ kind: kind === 'Column' ? 'column' : 'measure', entity: ent, property: c.Property });
      }
    }
    const hl = n.HierarchyLevel;
    if (hl && hl.Expression && hl.Expression.Hierarchy) {
      const h = hl.Expression.Hierarchy;
      const pvs = h.Expression && h.Expression.PropertyVariationSource;
      if (pvs) {
        const ent = entityOf(pvs.Expression, aliases);
        if (ent != null) emit({ kind: 'column', entity: ent, property: pvs.Property });
      } else {
        const ent = entityOf(h.Expression, aliases);
        if (ent != null) emit({ kind: 'hierarchy', entity: ent, hierarchy: h.Hierarchy, level: hl.Level });
      }
    }
    for (const k in n) {
      const v = n[k];
      if (v && typeof v === 'object') walkRefs(v, aliases, emit);
    }
  }

  function literalText(objs, key) {
    try {
      const v = objs[key][0].properties.text.expr.Literal.Value;
      return typeof v === 'string' ? v.replace(/^'|'$/g, '').replace(/''/g, "'") : '';
    } catch (e) { return ''; }
  }

  function extensionMeasures(ext, into) {
    for (const e of (ext && ext.entities) || []) {
      for (const m of e.measures || []) {
        into.push({ table: e.name, name: m.name, expression: joinExpr(m.expression), description: m.description || '' });
      }
    }
  }

  /** PBIR (definition/ folder with separate files) */
  function parsePbirReport(name, root, files) {
    const rep = { name, root, format: 'PBIR', pages: [], uses: [], measures: [], visualCount: 0 };
    const rel = p => p.slice(root.length + 1);
    const pageNames = {};
    for (const f of files) {
      const m = /^definition\/pages\/([^/]+)\/page\.json$/i.exec(rel(f.path));
      if (m) {
        const j = tryJson(f.text) || {};
        pageNames[m[1]] = j.displayName || m[1];
        rep.pages.push({ id: m[1], name: pageNames[m[1]], json: j });
      }
    }
    const add = (ctx) => (r) => rep.uses.push(Object.assign({}, r, ctx));
    for (const p of rep.pages) {
      walkRefs(p.json, {}, add({ page: p.name, visual: '', visualType: '', role: 'page filter' }));
      delete p.json;
    }
    for (const f of files) {
      const r = rel(f.path);
      let m;
      if ((m = /^definition\/pages\/([^/]+)\/visuals\/([^/]+)\/visual\.json$/i.exec(r))) {
        const j = tryJson(f.text);
        if (!j) continue;
        rep.visualCount++;
        const v = j.visual || {};
        const ctx = {
          page: pageNames[m[1]] || m[1], visual: j.name || m[2],
          visualType: v.visualType || (j.visualGroup ? 'group' : ''),
          visualTitle: literalText(v.visualContainerObjects || {}, 'title'),
        };
        const q = v.query || {};
        for (const role in q.queryState || {}) walkRefs(q.queryState[role], {}, add(Object.assign({ role }, ctx)));
        if (q.sortDefinition) walkRefs(q.sortDefinition, {}, add(Object.assign({ role: 'sort' }, ctx)));
        if (j.filterConfig) walkRefs(j.filterConfig, {}, add(Object.assign({ role: 'filter' }, ctx)));
        const rest = Object.assign({}, j, { visual: Object.assign({}, v, { query: undefined }), filterConfig: undefined });
        walkRefs(rest, {}, add(Object.assign({ role: 'formatting' }, ctx)));
      } else if (/^definition\/report\.json$/i.test(r)) {
        walkRefs(tryJson(f.text), {}, add({ page: '', visual: '', visualType: '', role: 'report filter' }));
      } else if (/^definition\/reportExtensions\.json$/i.test(r)) {
        extensionMeasures(tryJson(f.text), rep.measures);
      } else if (/^definition\/bookmarks\/.+\.bookmark\.json$/i.test(r)) {
        const j = tryJson(f.text) || {};
        walkRefs(j, {}, add({ page: '', visual: j.displayName || '', visualType: 'bookmark', role: 'bookmark' }));
      }
    }
    return rep;
  }

  /** Legacy format: a single Layout / report.json with sections[] */
  function parseLegacyReport(name, root, layout) {
    const rep = { name, root, format: 'Layout', pages: [], uses: [], measures: [], visualCount: 0 };
    const add = (ctx) => (r) => rep.uses.push(Object.assign({}, r, ctx));
    walkRefs(tryJson(layout.filters), {}, add({ page: '', visual: '', visualType: '', role: 'report filter' }));
    const cfg = tryJson(layout.config) || {};
    for (const ext of cfg.modelExtensions || []) extensionMeasures(ext, rep.measures);
    for (const b of cfg.bookmarks || []) {
      walkRefs(b, {}, add({ page: '', visual: b.displayName || '', visualType: 'bookmark', role: 'bookmark' }));
    }
    for (const sec of layout.sections || []) {
      const page = sec.displayName || sec.name || '';
      rep.pages.push({ id: sec.name, name: page });
      walkRefs(tryJson(sec.filters), {}, add({ page, visual: '', visualType: '', role: 'page filter' }));
      for (const vc of sec.visualContainers || []) {
        rep.visualCount++;
        const c = tryJson(vc.config) || {};
        const sv = c.singleVisual || {};
        const ctx = {
          page, visual: c.name || String(vc.id || ''), visualType: sv.visualType || (c.singleVisualGroup ? 'group' : ''),
          visualTitle: literalText(sv.vcObjects || {}, 'title'),
        };
        walkRefs(sv.prototypeQuery, {}, add(Object.assign({ role: 'field' }, ctx)));
        const aliases = {};
        for (const f of (sv.prototypeQuery && sv.prototypeQuery.From) || []) if (f.Name != null) aliases[f.Name] = f.Entity;
        walkRefs([sv.objects, sv.vcObjects], aliases, add(Object.assign({ role: 'formatting' }, ctx)));
        walkRefs(tryJson(vc.filters), {}, add(Object.assign({ role: 'filter' }, ctx)));
        walkRefs([tryJson(vc.query), tryJson(vc.dataTransforms)], {}, add(Object.assign({ role: 'field' }, ctx)));
      }
    }
    return rep;
  }

  // ---------------------------------------------------------------- Files → project

  const norm = p => p.replace(/\\/g, '/').replace(/^\.?\//, '');
  const baseName = p => p.slice(p.lastIndexOf('/') + 1);
  const dirName = p => (p.lastIndexOf('/') < 0 ? '' : p.slice(0, p.lastIndexOf('/')));
  function niceName(root) {
    const segs = root.split('/').filter(Boolean);
    let last = segs[segs.length - 1] || 'model';
    if (/^(Report|Model)$/i.test(last) && segs.length > 1) last = segs[segs.length - 2];
    return last.replace(/\.(SemanticModel|Dataset|Report|pbix|pbit|pbip|vpax)$/i, '');
  }

  /** Which files are worth reading? */
  function wantsFile(path) {
    const p = norm(path);
    if (/(^|\/)(\.pbi|StaticResources|RegisteredResources|\.git|node_modules|smo-backup)\//i.test(p)) return false;
    return /\.(tmdl|bim|json|pbir)$/i.test(p) || /(^|\/)(Layout|DataModelSchema)$/.test(p);
  }

  /** files: [{path, text}] → {models: [{name, root, model}], reports: [...], warnings: []} */
  function loadProject(files) {
    const warnings = [];
    const modelGroups = new Map(), pbirGroups = new Map();
    const models = [], reports = [];
    let stats = null;
    for (const f0 of files) {
      const f = { path: norm(f0.path), text: f0.text };
      const p = f.path, b = baseName(p);
      if (/\.tmdl$/i.test(p)) {
        const i = p.toLowerCase().lastIndexOf('/definition/');
        const rootDir = i >= 0 ? p.slice(0, i) : dirName(p);
        if (!modelGroups.has(rootDir)) modelGroups.set(rootDir, []);
        modelGroups.get(rootDir).push(f);
      } else if (b === 'DaxVpaView.json') {
        const j = tryJson(f.text);
        if (j) stats = statsFromVpax(j, 'VertiPaq export ' + niceName(dirName(p)).replace(/\.vpax$/i, ''));
      } else if (/\.bim$/i.test(p) || b === 'DataModelSchema') {
        const j = tryJson(f.text);
        if (j && (j.model || j.tables)) models.push({ name: niceName(dirName(p)), root: dirName(p), model: modelFromBim(j) });
        else warnings.push('Could not read ' + p + ' as a model.');
      } else if (/\/definition\/(pages\/|report\.json$|reportExtensions\.json$|bookmarks\/)/i.test('/' + p)) {
        const i = ('/' + p).toLowerCase().lastIndexOf('/definition/');
        const rootDir = p.slice(0, Math.max(0, i - 1 + 1)).replace(/\/$/, '');
        if (!pbirGroups.has(rootDir)) pbirGroups.set(rootDir, []);
        pbirGroups.get(rootDir).push(f);
      } else if (b === 'Layout' || b === 'report.json') {
        const j = tryJson(f.text);
        if (j && Array.isArray(j.sections)) reports.push(parseLegacyReport(niceName(dirName(p)), dirName(p), j));
      }
    }
    for (const [rootDir, fs] of modelGroups) {
      const model = emptyModel();
      for (const f of fs) {
        try { addTmdlToModel(model, f.text); } catch (e) { warnings.push('Error in ' + f.path + ': ' + e.message); }
      }
      if (model.tables.length) models.push({ name: niceName(rootDir), root: rootDir, model, format: 'tmdl' });
    }
    for (const [rootDir, fs] of pbirGroups) reports.push(parsePbirReport(niceName(rootDir), rootDir, fs));
    models.sort((a, b) => a.name.localeCompare(b.name));
    reports.sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
    // keep two reports with the same name apart
    const names = new Map();
    for (const r of reports) {
      const k = lc(r.name), c = (names.get(k) || 0) + 1;
      names.set(k, c);
      if (c > 1) r.name = r.name + ' (' + c + ')';
    }
    // a model from a .vpax is only a fallback when no real model is loaded
    const real = models.filter(m => !/\.vpax$/i.test(m.root));
    const out = real.length ? real : models;
    // thin reports whose model lives elsewhere (for example on Analysis Services): still show what the reports define and use
    if (!out.length && reports.length) out.push({ name: '(model not loaded)', root: '', model: emptyModel(), format: 'none', missing: true });
    return { models: out, reports, warnings, stats };
  }

  // ---------------------------------------------------------------- Analysis

  const lc = s => String(s == null ? '' : s).toLowerCase();
  const isAutoDate = name => /^(LocalDateTable_|DateTableTemplate_)/.test(name);

  /**
   * model + reports → nodes with dependencies, usage and status.
   * Status: 'direct' (in a report), 'indirect' (via something that is in a report),
   *         'model' (only needed by the model: relationship, RLS, hierarchy), 'unused'.
   */
  function analyze(model, reports, opts) {
    const noModel = !!(opts && opts.noModel); // reports loaded without their model: nothing can be checked against it
    const nodes = new Map();
    const tableIdx = new Map(), colIdx = new Map(), measIdx = new Map(), measByName = new Map(), fnIdx = new Map();
    const hierIdx = new Map();
    const broken = [];

    const mk = (id, o) => {
      const n = Object.assign({
        id, deps: new Set(), usedBy: new Set(), depKinds: {}, reportUses: [], modelUses: [], problems: [], brokenVia: [],
        expression: '', description: '', hidden: false, status: 'unused',
      }, o);
      nodes.set(id, n);
      return n;
    };
    const link = (from, to, kind) => {
      if (!from || !to || from === to) return;
      from.deps.add(to.id); to.usedBy.add(from.id);
      if (kind) from.depKinds[to.id] = kind;
    };

    for (const t of model.tables) {
      const tn = mk('T|' + t.name, {
        type: 'table', kind: t.kind, name: t.name, table: t.name, expression: t.expression,
        description: t.description, hidden: t.isHidden, system: isAutoDate(t.name),
        source: t.source || '', mode: t.mode || '',
      });
      tableIdx.set(lc(t.name), tn);
      for (const c of t.columns) {
        if (c.isSystem) continue;
        const cn = mk('C|' + t.name + '|' + c.name, {
          type: 'column', kind: c.isCalculated ? 'calculated column' : 'column', name: c.name, table: t.name,
          expression: c.isCalculated ? c.expression : '', description: c.description, hidden: c.isHidden,
          dataType: c.dataType, sourceColumn: c.sourceColumn, displayFolder: c.displayFolder, tableKind: t.kind,
          system: tn.system, sortByColumn: c.sortByColumn,
        });
        colIdx.set(lc(t.name) + '|' + lc(c.name), cn);
      }
      for (const m of t.measures) {
        const mn = mk('M|' + t.name + '|' + m.name, {
          type: 'measure', kind: 'measure', name: m.name, table: t.name, expression: m.expression,
          extraExpressions: m.extraExpressions || [], description: m.description, hidden: m.isHidden,
          displayFolder: m.displayFolder, formatString: m.formatString,
        });
        measIdx.set(lc(t.name) + '|' + lc(m.name), mn);
        measByName.set(lc(m.name), mn);
      }
      for (const h of t.hierarchies) hierIdx.set(lc(t.name) + '|' + lc(h.name), h);
    }
    for (const f of model.functions || []) {
      fnIdx.set(lc(f.name), mk('F|' + f.name, {
        type: 'function', kind: 'function', name: f.name, table: '', expression: f.expression, description: f.description || '',
      }));
    }
    // measures created inside a report itself
    for (const rep of reports) {
      for (const m of rep.measures) {
        const key = lc(m.table) + '|' + lc(m.name);
        if (measIdx.has(key)) continue;
        const mn = mk('M|' + m.table + '|' + m.name, {
          type: 'measure', kind: 'report measure', name: m.name, table: m.table, expression: m.expression,
          extraExpressions: [], description: m.description, report: rep.name,
        });
        measIdx.set(key, mn);
        if (!measByName.has(lc(m.name))) measByName.set(lc(m.name), mn);
      }
    }

    const resolve = (ref, homeTable) => {
      if (ref.t === 'q') {
        const k = lc(ref.table) + '|' + lc(ref.name);
        return colIdx.get(k) || measIdx.get(k) || measByName.get(lc(ref.name)) || null;
      }
      if (ref.t === 'b') {
        return measByName.get(lc(ref.name)) || (homeTable ? colIdx.get(lc(homeTable) + '|' + lc(ref.name)) : null) || null;
      }
      if (ref.t === 't') return tableIdx.get(lc(ref.table)) || null;
      if (ref.t === 'f') return fnIdx.get(lc(ref.name)) || null;
      return null;
    };
    // column names across all tables, to tell a broken reference from a bare column of another table
    const colNames = new Set();
    for (const k of colIdx.keys()) colNames.add(k.slice(k.indexOf('|') + 1));
    const linkExpr = (node, expr, homeTable) => {
      const text = String(expr || '');
      for (const r of daxRefs(text)) {
        const hit = resolve(r, homeTable);
        if (hit) { link(node, hit); continue; }
        if (noModel || (r.t !== 'q' && r.t !== 'b')) continue;
        // not found: decide whether this is really broken
        let reason = '';
        if (r.t === 'q') {
          reason = tableIdx.has(lc(r.table)) ? 'not found in table ' + r.table : 'table ' + r.table + ' does not exist';
        } else {
          const name = lc(r.name);
          if (text[r.ns - 2] === '.') continue;                       // Table[Date].[Year]
          if (/^value\d*$/.test(name) || name.startsWith('@')) continue; // { … } table constructors
          if (lc(text).includes('"' + name + '"')) continue;          // a column the formula creates itself
          if (colNames.has(name)) continue;                           // bare column of another table
          reason = 'no measure or column with this name';
        }
        const ref = r.t === 'q' ? r.table + '[' + r.name + ']' : '[' + r.name + ']';
        if (!node.problems.some(p => p.ref === ref)) node.problems.push({ ref, reason });
      }
    };

    for (const t of model.tables) {
      const tn = tableIdx.get(lc(t.name));
      if (t.kind === 'calculated table') linkExpr(tn, t.expression, null);
      for (const it of t.calcItems) {
        linkExpr(tn, it.expression, null);
        for (const e of it.extraExpressions || []) linkExpr(tn, e, null);
      }
      for (const c of t.columns) {
        const cn = colIdx.get(lc(t.name) + '|' + lc(c.name));
        if (!cn) continue;
        if (c.isCalculated) linkExpr(cn, c.expression, t.name);
        if (t.kind !== 'table') link(cn, tn, t.kind); // a column of a calculated table depends on the table expression
        if (c.sortByColumn) link(cn, colIdx.get(lc(t.name) + '|' + lc(c.sortByColumn)), 'sort-by column');
      }
      for (const h of t.hierarchies) {
        for (const l of h.levels) {
          const cn = colIdx.get(lc(t.name) + '|' + lc(l.column));
          if (cn) cn.modelUses.push({ kind: 'hierarchy', detail: h.name + ' › ' + l.name });
        }
      }
    }
    for (const n of nodes.values()) {
      if (n.type === 'measure') {
        linkExpr(n, n.expression, n.table);
        for (const e of n.extraExpressions || []) linkExpr(n, e, n.table);
      } else if (n.type === 'function') linkExpr(n, n.expression, null);
    }
    for (const r of model.relationships) {
      const a = colIdx.get(lc(r.fromTable) + '|' + lc(r.fromColumn));
      const b = colIdx.get(lc(r.toTable) + '|' + lc(r.toColumn));
      const txt = r.fromTable + '[' + r.fromColumn + '] → ' + r.toTable + '[' + r.toColumn + ']' + (r.isActive ? '' : ' (inactive)');
      if (a) a.modelUses.push({ kind: 'relationship', detail: txt });
      if (b) b.modelUses.push({ kind: 'relationship', detail: txt });
    }
    for (const role of model.roles) {
      for (const p of role.permissions) {
        for (const ref of daxRefs(p.expression)) {
          const n = resolve(ref, p.table);
          if (n) n.modelUses.push({ kind: 'RLS', detail: 'role ' + role.name + ' on ' + p.table });
        }
      }
    }

    // usage in reports
    const seen = new Set();
    for (const rep of reports) {
      for (const u of rep.uses) {
        let n = null;
        if (u.kind === 'hierarchy') {
          const h = hierIdx.get(lc(u.entity) + '|' + lc(u.hierarchy));
          const lvl = h && h.levels.find(l => lc(l.name) === lc(u.level));
          if (lvl) n = colIdx.get(lc(u.entity) + '|' + lc(lvl.column));
        } else {
          const k = lc(u.entity) + '|' + lc(u.property);
          n = u.kind === 'measure' ? (measIdx.get(k) || colIdx.get(k)) : (colIdx.get(k) || measIdx.get(k));
        }
        const use = {
          report: rep.name, page: u.page, visual: u.visual, visualType: u.visualType,
          visualTitle: u.visualTitle || '', role: u.role,
        };
        const key = (n ? n.id : 'X|' + u.entity + '|' + (u.property || u.hierarchy + '.' + u.level)) +
          '|' + rep.name + '|' + u.page + '|' + u.visual + '|' + u.role;
        if (seen.has(key)) continue;
        seen.add(key);
        if (n) n.reportUses.push(use);
        else broken.push(Object.assign({ table: u.entity, name: u.property || (u.hierarchy + ' › ' + u.level), kind: u.kind }, use));
      }
    }

    // status
    const closure = (roots) => {
      const out = new Set(roots.map(n => n.id));
      const todo = roots.slice();
      while (todo.length) {
        const n = todo.pop();
        for (const d of n.deps) if (!out.has(d)) { out.add(d); todo.push(nodes.get(d)); }
      }
      return out;
    };
    const all = Array.from(nodes.values());
    const reachR = closure(all.filter(n => n.reportUses.length));
    const reachM = closure(all.filter(n => n.modelUses.length));
    for (const n of all) {
      n.status = n.reportUses.length ? 'direct' : reachR.has(n.id) ? 'indirect' : reachM.has(n.id) ? 'model' : 'unused';
    }
    // per report: where it is used directly, and where it is needed indirectly
    for (const n of all) n.reports = [];
    for (const rep of reports) {
      const roots = all.filter(n => n.reportUses.some(u => u.report === rep.name));
      const direct = new Set(roots.map(n => n.id));
      for (const id of closure(roots)) nodes.get(id).reports.push({ name: rep.name, direct: direct.has(id) });
    }
    // a table counts as used as soon as anything in it is used
    const rank = { unused: 0, model: 1, indirect: 2, direct: 3 };
    for (const n of all) {
      if (n.type === 'table') continue;
      const tn = tableIdx.get(lc(n.table));
      if (tn) for (const r of n.reports) if (!tn.reports.some(x => x.name === r.name)) tn.reports.push({ name: r.name, direct: false });
      if (!tn || n.status === 'unused') continue;
      const s = n.status === 'direct' ? 'indirect' : n.status;
      if (rank[s] > rank[tn.status]) tn.status = s;
    }
    for (const n of all) {
      n.depCount = n.deps.size;
      n.usedByCount = n.usedBy.size;
    }

    // a formula is also broken when something it depends on is broken
    const brokenState = new Map();
    const isBroken = n => {
      if (brokenState.has(n.id)) return brokenState.get(n.id);
      brokenState.set(n.id, n.problems.length > 0); // guards against cycles
      let b = n.problems.length > 0;
      if (n.expression) {
        for (const d of n.deps) {
          const x = nodes.get(d);
          if (x && x.expression && x.type !== 'table' && isBroken(x)) { b = true; if (!n.brokenVia.includes(d)) n.brokenVia.push(d); }
        }
      }
      brokenState.set(n.id, b);
      return b;
    };
    for (const n of all) n.broken = isBroken(n);
    const count = (f) => all.filter(n => !n.system && f(n)).length;
    const stats = {
      measures: count(n => n.type === 'measure'),
      measuresUnused: count(n => n.type === 'measure' && n.status === 'unused'),
      columns: count(n => n.type === 'column'),
      columnsUnused: count(n => n.type === 'column' && n.status === 'unused'),
      columnsModelOnly: count(n => n.type === 'column' && n.status === 'model'),
      calcColumns: count(n => n.kind === 'calculated column'),
      calcColumnsUnused: count(n => n.kind === 'calculated column' && n.status === 'unused'),
      tables: count(n => n.type === 'table'),
      tablesUnused: count(n => n.type === 'table' && n.status === 'unused'),
      reportCount: reports.length,
      visuals: reports.reduce((a, r) => a + r.visualCount, 0),
      pages: reports.reduce((a, r) => a + r.pages.length, 0),
      broken: broken.length,
      noModel,
      reportMeasures: count(n => n.kind === 'report measure'),
      modelMeasures: count(n => n.kind === 'measure'),
      brokenFormulas: count(n => n.problems.length > 0),
      brokenAffected: count(n => n.broken && !n.problems.length),
    };
    return { nodes, list: all, broken, stats, resolve };
  }

  /** All direct and indirect dependencies (dir='deps') or dependents (dir='usedBy'), by distance. */
  function layers(analysis, id, dir, maxDepth) {
    const out = [];
    const seen = new Set([id]);
    let cur = [id];
    for (let d = 0; d < (maxDepth || 50) && cur.length; d++) {
      const next = [];
      for (const c of cur) {
        const n = analysis.nodes.get(c);
        if (!n) continue;
        for (const x of n[dir]) if (!seen.has(x)) { seen.add(x); next.push(x); }
      }
      if (next.length) out.push(next);
      cur = next;
    }
    return out;
  }

  // ---------------------------------------------------------------- ZIP (pbix/pbit)

  function decodeText(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes.length >= 2 && bytes[0] !== 0 && bytes[1] === 0) return new TextDecoder('utf-16le').decode(bytes);
    return new TextDecoder('utf-8').decode(bytes);
  }

  /**
   * Reads the wanted text files from a zip.
   * reader: {size, read(offset, length) → Promise<Uint8Array>}; inflateRaw(Uint8Array) → Promise<Uint8Array>
   */
  async function readZipTexts(reader, inflateRaw, want) {
    const tailLen = Math.min(reader.size, 66000);
    const tail = await reader.read(reader.size - tailLen, tailLen);
    const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('Not a valid zip file');
    const count = dv.getUint16(e + 10, true), cdSize = dv.getUint32(e + 12, true), cdOff = dv.getUint32(e + 16, true);
    const cd = await reader.read(cdOff, cdSize);
    const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const out = [], names = [];
    let p = 0;
    for (let k = 0; k < count && p + 46 <= cd.length; k++) {
      if (cv.getUint32(p, true) !== 0x02014b50) break;
      const method = cv.getUint16(p + 10, true), csize = cv.getUint32(p + 20, true);
      const nl = cv.getUint16(p + 28, true), el = cv.getUint16(p + 30, true), cl = cv.getUint16(p + 32, true);
      const off = cv.getUint32(p + 42, true);
      const name = new TextDecoder('utf-8').decode(cd.subarray(p + 46, p + 46 + nl));
      p += 46 + nl + el + cl;
      names.push(name);
      if (!want(name)) continue;
      const lh = await reader.read(off, 30);
      const lv = new DataView(lh.buffer, lh.byteOffset, lh.byteLength);
      const start = off + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
      let data = await reader.read(start, csize);
      if (method === 8) data = await inflateRaw(data);
      else if (method !== 0) continue;
      out.push({ path: name, text: decodeText(data) });
    }
    return { files: out, names };
  }

  // ---------------------------------------------------------------- Sizes (rows, MB)

  /** Which files from a pbix/pbit/vpax zip do we want to read? */
  function zipWants(n) {
    return n === 'Report/Layout' || n === 'DataModelSchema' || n === 'DaxVpaView.json' || /^model\.bim$/i.test(n) ||
      (/^Report\/definition\//.test(n) && /\.json$/i.test(n));
  }

  function pick(o, keys) {
    for (const k of keys) if (o[k] != null) return o[k];
    const low = {};
    for (const k in o) low[k.toLowerCase()] = o[k];
    for (const k of keys) if (low[k.toLowerCase()] != null) return low[k.toLowerCase()];
    return null;
  }
  const num = v => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));

  /** DaxVpaView.json from a .vpax (DAX Studio › Advanced › Export Metrics) → statistics */
  function statsFromVpax(json, source) {
    const out = { source: source || 'VertiPaq export', tables: [], columns: [] };
    for (const t of pick(json, ['Tables']) || []) {
      out.tables.push({ name: pick(t, ['TableName', 'Name']), rows: num(pick(t, ['RowsCount', 'RowCount'])), size: num(pick(t, ['TableSize', 'TotalSize'])) });
    }
    for (const c of pick(json, ['Columns']) || []) {
      let name = String(pick(c, ['ColumnName', 'Name']) || '');
      const m = /\[(.*)\]$/.exec(name);
      if (m) name = m[1].replace(/\]\]/g, ']');
      if (/^RowNumber-/.test(name)) continue;
      out.columns.push({
        table: pick(c, ['TableName']), name, size: num(pick(c, ['TotalSize'])),
        dictionary: num(pick(c, ['DictionarySize'])), data: num(pick(c, ['DataSize'])), hierarchy: num(pick(c, ['HierarchiesSize'])),
        cardinality: num(pick(c, ['ColumnCardinality', 'Cardinality'])), encoding: pick(c, ['Encoding']) || '',
      });
    }
    return out;
  }

  /** Attaches rows and bytes to the nodes and totals how much is unused. */
  function applyStats(analysis, stats) {
    const s = analysis.stats;
    for (const n of analysis.list) { n.rows = null; n.size = null; n.cardinality = null; n.sizeParts = null; n.share = null; }
    s.hasStats = false;
    if (!stats) return analysis;
    const tIdx = new Map(), cIdx = new Map();
    for (const n of analysis.list) {
      if (n.type === 'table') tIdx.set(lc(n.name), n);
      else if (n.type === 'column') cIdx.set(lc(n.table) + '|' + lc(n.name), n);
    }
    let total = 0, matched = 0;
    for (const t of stats.tables || []) {
      const n = tIdx.get(lc(t.name));
      if (!n) continue;
      matched++;
      n.rows = t.rows; n.size = t.size;
      if (!n.system) total += t.size || 0;
    }
    for (const c of stats.columns || []) {
      const n = cIdx.get(lc(c.table) + '|' + lc(c.name));
      if (!n) continue;
      n.size = c.size; n.cardinality = c.cardinality;
      n.sizeParts = { dictionary: c.dictionary, data: c.data, hierarchy: c.hierarchy, encoding: c.encoding || '' };
      const tn = tIdx.get(lc(c.table));
      if (tn) n.rows = tn.rows;
    }
    let unused = 0, modelOnly = 0;
    for (const n of analysis.list) {
      if (n.size != null && total) n.share = n.size / total;
      if (n.type === 'column' && !n.system && n.size) {
        if (n.status === 'unused') unused += n.size;
        else if (n.status === 'model') modelOnly += n.size;
      }
    }
    s.hasStats = matched > 0;
    s.statsSource = stats.source || '';
    s.totalSize = total; s.unusedSize = unused; s.modelOnlySize = modelOnly;
    s.totalRows = analysis.list.reduce((a, n) => a + (n.type === 'table' && !n.system && n.rows ? n.rows : 0), 0);
    return analysis;
  }

  // ---------------------------------------------------------------- Removing from TMDL

  const mStr = s => '"' + String(s).replace(/"/g, '""') + '"';
  const WRAP_RE = /__smo_trimmed = Table\.RemoveColumns\(__smo_source, \{(.*)\}, MissingField\.Ignore\)/;

  /**
   * Removes measures and columns of one table from TMDL text.
   * For removed source columns a Table.RemoveColumns step is added to the table's Power Query,
   * otherwise Power BI Desktop puts the column back on the next refresh.
   * names: {measures: [], columns: []} → {text, removed: [{type, name}], warnings: []}
   */
  function removeFromTmdl(text0, table, names) {
    const bomAt = text0.charCodeAt(0) === 0xFEFF ? '﻿' : '';
    const text = bomAt ? text0.slice(1) : text0;
    const eol = /\r\n/.test(text) ? '\r\n' : '\n';
    let lines = text.split(/\r?\n/);
    const want = { measure: new Set((names.measures || []).map(lc)), column: new Set((names.columns || []).map(lc)) };
    const drop = new Array(lines.length).fill(false);
    const removed = [], sourceCols = [], warnings = [];
    let inTable = false, i = 0;
    while (i < lines.length) {
      const raw = lines[i], line = raw.trim();
      if (!line) { i++; continue; }
      const ind = indentOf(raw);
      let m;
      if (ind === 0 && !line.startsWith('///')) {
        m = /^table\s+(.+)$/.exec(line);
        inTable = !!m && lc(readName(m[1]).name) === lc(table);
      }
      if (inTable && ind === 1 && (m = /^(measure|column)\s+(.+)$/.exec(line))) {
        const nm = readName(m[2]);
        const after = nm.rest.trim();
        let j = i + 1;
        const fence = /^=\s*```(.*)$/.exec(after);
        if (fence && !fence[1].trim().endsWith('```')) {
          while (j < lines.length && !lines[j].trim().endsWith('```')) j++;
          j++;
        }
        while (j < lines.length && (!lines[j].trim() || indentOf(lines[j]) > 1)) j++;
        if (want[m[1]].has(lc(nm.name))) {
          let s = i;
          while (s > 0 && lines[s - 1].trim().startsWith('///') && indentOf(lines[s - 1]) === 1) s--;
          for (let k = s; k < j; k++) drop[k] = true;
          removed.push({ type: m[1], name: nm.name });
          if (m[1] === 'column' && !after.startsWith('=')) {
            let src = nm.name;
            for (let k = i + 1; k < j; k++) {
              const sm = /^sourceColumn:\s*(.*)$/.exec(lines[k].trim());
              if (sm && indentOf(lines[k]) === 2) src = unquoteValue(sm[1]);
            }
            sourceCols.push(src);
          }
        }
        i = j;
        continue;
      }
      i++;
    }
    lines = lines.filter((l, k) => !drop[k]);

    if (sourceCols.length) {
      const out = [];
      let inT = false, inPart = false, wrapped = 0;
      for (let k = 0; k < lines.length; k++) {
        const raw = lines[k], line = raw.trim(), ind = line ? indentOf(raw) : -1;
        if (ind === 0 && !line.startsWith('///')) {
          const m = /^table\s+(.+)$/.exec(line);
          inT = !!m && lc(readName(m[1]).name) === lc(table);
          inPart = false;
        } else if (inT && ind === 1) {
          const m = /^partition\s+(.+)$/.exec(line);
          inPart = !!m && readName(m[1]).rest.trim().replace(/^=\s*/, '') === 'm';
        }
        const sm = inT && inPart && ind === 2 ? /^source\s*=\s*(.*)$/.exec(line) : null;
        if (!sm) { out.push(raw); continue; }
        if (sm[1].startsWith('```')) { warnings.push('The Power Query of ' + table + ' could not be changed; the columns will come back on refresh.'); out.push(raw); continue; }
        let body = [];
        if (sm[1]) body = [sm[1]];
        else {
          let j = k + 1;
          while (j < lines.length && (!lines[j].trim() || indentOf(lines[j]) >= 3)) j++;
          body = lines.slice(k + 1, j);
          k = j - 1;
        }
        let tail = 0;
        while (body.length && !body[body.length - 1].trim()) { body.pop(); tail++; }
        body = dedent(body);
        const T4 = '\t\t\t\t';
        const joined = body.join('\n');
        const prev = WRAP_RE.exec(joined);
        out.push('\t\tsource =');
        if (prev) {
          const list = prev[1] + ', ' + sourceCols.map(mStr).join(', ');
          for (const l of joined.replace(WRAP_RE, () => '__smo_trimmed = Table.RemoveColumns(__smo_source, {' + list + '}, MissingField.Ignore)').split('\n')) out.push(l ? T4 + l : '');
        } else {
          out.push(T4 + 'let', T4 + '    __smo_source =');
          for (const l of body) out.push(l ? T4 + '        ' + l : '');
          out.push(T4 + '    ,', T4 + '    __smo_trimmed = Table.RemoveColumns(__smo_source, {' + sourceCols.map(mStr).join(', ') + '}, MissingField.Ignore)', T4 + 'in', T4 + '    __smo_trimmed');
        }
        for (let t = 0; t < tail; t++) out.push('');
        wrapped++;
      }
      lines = out;
      if (!wrapped && !warnings.length) warnings.push(table + ' has no Power Query source; the columns were only removed from the model.');
    }
    return { text: bomAt + lines.join(eol), removed, warnings };
  }

  // ---------------------------------------------------------------- Editing TMDL

  const tmdlName = s => (/^[A-Za-z0-9_]+$/.test(s) ? s : "'" + String(s).replace(/'/g, "''") + "'");
  const splitBom = t => (t.charCodeAt(0) === 0xFEFF ? ['﻿', t.slice(1)] : ['', t]);

  /** TMDL text → objects with line positions, so we can make targeted edits. */
  function scanTmdl(text) {
    const lines = text.split(/\r?\n/);
    const n = lines.length;
    const rootNode = { kw: 'root', indent: -1, children: [], props: [], exprProps: [], parent: null };
    const all = [];
    const stack = [rootNode];
    let desc = null, i = 0;
    const readExpr = (at, rest, col, minIndent) => {
      let j = at + 1;
      if (rest.startsWith('```')) {
        if (!rest.slice(3).trim().endsWith('```')) { while (j < n && !lines[j].trim().endsWith('```')) j++; j++; }
        return { line: at, col, endLine: Math.min(j, n), fenced: true };
      }
      if (rest === '') {
        let last = at + 1;
        while (j < n) {
          if (!lines[j].trim()) { j++; continue; }
          if (indentOf(lines[j]) < minIndent) break;
          j++; last = j;
        }
        return { line: at, col, endLine: last };
      }
      return { line: at, col, endLine: at + 1 };
    };
    while (i < n) {
      const raw = lines[i], line = raw.trim();
      if (!line) { i++; continue; }
      const ind = indentOf(raw);
      if (line.startsWith('///')) { if (desc == null) desc = i; i++; continue; }
      const startsAt = desc == null ? i : desc;
      while (stack[stack.length - 1].indent >= ind) stack.pop().blockEnd = startsAt;
      const parent = stack[stack.length - 1];
      const lead = raw.length - raw.trimStart().length;
      let m;
      if ((m = /^([A-Za-z_]\w*)\s*:\s?(.*)$/.exec(line))) { parent.props.push({ key: m[1], line: i, value: m[2] }); desc = null; i++; continue; }
      if ((m = /^([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(line))) {
        const e = readExpr(i, m[2], lead + line.length - m[2].length, ind + 1);
        parent.exprProps.push({ key: m[1], expr: e });
        desc = null; i = e.endLine; continue;
      }
      if ((m = /^([A-Za-z_]\w*)\s+(.+)$/.exec(line))) {
        if (m[1] === 'ref') { desc = null; i++; continue; }
        const nm = readName(m[2]);
        const nameStart = lead + line.length - m[2].length;
        const o = {
          kw: m[1], name: nm.name, indent: ind, descStart: startsAt, declLine: i,
          nameCol: [nameStart, nameStart + m[2].length - nm.rest.length],
          props: [], exprProps: [], children: [], parent, blockEnd: n,
        };
        const t = nm.rest.trim();
        let next = i + 1;
        if (t.startsWith('=')) {
          const rest = t.slice(1).trim();
          o.expr = readExpr(i, rest, lead + line.length - rest.length, ind + 2);
          next = o.expr.endLine;
        }
        parent.children.push(o); all.push(o); stack.push(o);
        desc = null; i = next; continue;
      }
      parent.props.push({ key: line, line: i, flag: true });
      desc = null; i++;
    }
    return { lines, all, root: rootNode };
  }

  function findDecl(scan, sel) {
    const table = scan.root.children.find(o => o.kw === 'table' && lc(o.name) === lc(sel.table));
    if (!table) return null;
    if (sel.type === 'table') return table;
    return table.children.find(o => o.kw === sel.type && lc(o.name) === lc(sel.name)) || null;
  }

  /**
   * Changes the name, description and/or expression of one measure, column or table.
   * sel: {type: 'measure'|'column'|'table', table, name}; changes: {name?, description?, expression?}
   */
  function editTmdlObject(text0, sel, changes) {
    const [bom, text] = splitBom(text0);
    const eol = /\r\n/.test(text) ? '\r\n' : '\n';
    const scan = scanTmdl(text);
    const o = findDecl(scan, sel);
    if (!o) return { text: text0, found: false };
    const lines = scan.lines;
    const ind = '\t'.repeat(o.indent);
    const headEnd = o.expr ? o.expr.endLine : o.declLine + 1;
    let descLines = lines.slice(o.descStart, o.declLine);
    if (changes.description !== undefined) {
      const d = String(changes.description).trim();
      descLines = d ? d.split(/\r?\n/).map(l => ind + '/// ' + l.trim()) : [];
    }
    const name = changes.name !== undefined ? String(changes.name) : o.name;
    let decl = lines.slice(o.declLine, headEnd);
    if (changes.expression !== undefined && o.expr) {
      const head = ind + o.kw + ' ' + tmdlName(name) + ' =';
      const el = dedent(String(changes.expression).replace(/\r\n/g, '\n').replace(/\s+$/, '').replace(/^\n+/, '').split('\n'));
      if (el.length === 1) decl = [head + ' ' + el[0].trim()];
      else if (el.some(l => !l.trim())) decl = [head + ' ```'].concat(el.map(l => (l.trim() ? ind + '\t\t' + l : '')), [ind + '\t\t```']);
      else decl = [head].concat(el.map(l => ind + '\t\t' + l));
    } else if (changes.name !== undefined) {
      decl[0] = decl[0].slice(0, o.nameCol[0]) + tmdlName(name) + decl[0].slice(o.nameCol[1]);
    }
    lines.splice(o.descStart, headEnd - o.descStart, ...descLines, ...decl);
    return { text: bom + lines.join(eol), found: true };
  }

  function daxRename(seg, pred, newName) {
    const refs = daxRefs(seg).filter(r => (r.t === 'q' || r.t === 'b') && pred(r)).sort((a, b) => b.ns - a.ns);
    for (const r of refs) seg = seg.slice(0, r.ns) + String(newName).replace(/\]/g, ']]') + seg.slice(r.ne);
    return seg;
  }

  /**
   * Updates, in one TMDL file, all references to a renamed measure or column:
   * in DAX, sort-by columns, hierarchies, relationships, perspectives and translations.
   * The declaration itself is left alone; editTmdlObject handles that.
   */
  function renameRefsTmdl(text0, target, newName, resolve, targetId) {
    const [bom, text] = splitBom(text0);
    const eol = /\r\n/.test(text) ? '\r\n' : '\n';
    const scan = scanTmdl(text);
    const lines = scan.lines;
    const old = lc(target.name), T = lc(target.table);
    const up = (o, kws) => { for (let p = o; p; p = p.parent) if (kws.includes(p.kw)) return p; return null; };
    const rewrite = (e, home) => {
      const seg = [lines[e.line].slice(e.col)].concat(lines.slice(e.line + 1, e.endLine)).join('\n');
      const out = daxRename(seg, r => { const x = resolve(r, home); return !!x && x.id === targetId; }, newName);
      if (out === seg) return;
      const parts = out.split('\n');
      lines[e.line] = lines[e.line].slice(0, e.col) + parts[0];
      for (let k = 1; k < parts.length; k++) lines[e.line + k] = parts[k];
    };
    const setProp = (p, value) => { const c = lines[p.line].indexOf(':'); lines[p.line] = lines[p.line].slice(0, c + 1) + ' ' + value; };
    const DAX = ['measure', 'column', 'calculationItem', 'tablePermission', 'function'];
    for (const o of scan.all) {
      const realTable = up(o, ['table']);
      const inModel = !up(o, ['cultureInfo', 'perspective']) && (!realTable || realTable.parent === scan.root);
      if (inModel) {
        const home = o.kw === 'tablePermission' ? o.name : (realTable ? realTable.name : null);
        if (o.expr && DAX.includes(o.kw)) rewrite(o.expr, home);
        const calcPart = o.kw === 'partition' && o.expr && lines[o.expr.line].slice(o.expr.col).trim() === 'calculated';
        if (calcPart || ['measure', 'column', 'calculationItem'].includes(o.kw)) for (const ep of o.exprProps) rewrite(ep.expr, home);
        if (target.type === 'column') {
          const same = realTable && lc(realTable.name) === T;
          if (same && (o.kw === 'column' || o.kw === 'level')) {
            for (const p of o.props) {
              if ((p.key === 'sortByColumn' || (o.kw === 'level' && p.key === 'column')) && lc(readName(p.value).name) === old) setProp(p, tmdlName(newName));
            }
          }
          if (o.kw === 'relationship') {
            for (const p of o.props) {
              if (p.key !== 'fromColumn' && p.key !== 'toColumn') continue;
              const [t, c] = readQualified(p.value);
              if (lc(t) === T && lc(c) === old) setProp(p, tmdlName(t) + '.' + tmdlName(newName));
            }
          }
        }
      }
      // the same name in other places: perspectives, translations, column permissions
      const cap = target.type === 'measure' ? 'perspectiveMeasure' : 'perspectiveColumn';
      const isOther = o.kw === cap || (target.type === 'column' && o.kw === 'columnPermission') || (o.kw === target.type && !inModel);
      if (isOther && lc(o.name) === old) {
        const owner = up(o.parent, ['table', 'perspectiveTable', 'tablePermission']);
        if (owner && lc(owner.name) === T) {
          const l = lines[o.declLine];
          lines[o.declLine] = l.slice(0, o.nameCol[0]) + tmdlName(newName) + l.slice(o.nameCol[1]);
        }
      }
    }
    return bom + lines.join(eol);
  }

  /** Updates references in report JSON (PBIR); returns the number of fields changed. */
  function renameInReport(json, target, newName) {
    const key = target.type === 'measure' ? 'Measure' : 'Column';
    const old = lc(target.name), T = lc(target.table);
    let count = 0, entity = target.table;
    const hit = (c, aliases) => {
      if (!c || typeof c !== 'object' || typeof c.Property !== 'string' || lc(c.Property) !== old) return false;
      const ent = entityOf(c.Expression, aliases);
      if (ent == null || lc(ent) !== T) return false;
      entity = ent; c.Property = newName; count++;
      return true;
    };
    const walk = (n, aliases) => {
      if (Array.isArray(n)) { for (const x of n) walk(x, aliases); return; }
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n.From)) {
        aliases = Object.assign({}, aliases);
        for (const f of n.From) if (f && f.Name != null && f.Entity != null) aliases[f.Name] = f.Entity;
      }
      hit(n[key], aliases);
      if (target.type === 'column' && n.PropertyVariationSource) hit(n.PropertyVariationSource, aliases);
      const before = count;
      for (const k in n) if (n[k] && typeof n[k] === 'object') walk(n[k], aliases);
      if (n.field && count > before && typeof n.nativeQueryRef === 'string' && lc(n.nativeQueryRef) === old) n.nativeQueryRef = newName;
    };
    walk(json, {});
    if (count) {
      const from = entity + '.' + target.name, to = entity + '.' + newName;
      const strings = n => {
        if (!n || typeof n !== 'object') return;
        for (const k in n) {
          const v = n[k];
          if (typeof v === 'string') {
            if (v === from) n[k] = to;
            else if (v.includes('(' + from + ')')) n[k] = v.split('(' + from + ')').join('(' + to + ')');
          } else strings(v);
        }
      };
      strings(json);
    }
    return count;
  }

  // ---------------------------------------------------------------- Best-practice checks

  const RULES = [
    { id: 'broken-formula', severity: 'error', title: 'Broken formulas', help: 'The DAX refers to a table, column or measure that does not exist, or depends on a formula that does. These fail when the model is used.' },
    { id: 'broken-reference', severity: 'error', title: 'Broken references in reports', help: 'A visual or filter uses a field that is not in the model. The visual shows an error.' },
    { id: 'many-to-many', severity: 'warning', title: 'Many-to-many relationships', help: 'Both sides are "many". Results are easy to misread and slow on large tables; a bridge table or a proper dimension is usually better.' },
    { id: 'bidirectional', severity: 'warning', title: 'Relationships that filter both ways', help: 'Bidirectional filtering can create ambiguous paths and hurts performance. Use it only where it is needed, or use CROSSFILTER inside a measure.' },
    { id: 'key-visible', severity: 'warning', title: 'Key columns that are not hidden', help: 'These columns are used in a relationship but are visible and not used in any report. Hide them so report builders pick the dimension attributes instead.' },
    { id: 'calc-column-as-measure', severity: 'warning', title: 'Calculated columns that could be measures', help: 'A numeric calculated column that is only used inside measures takes memory for every row. An iterator such as SUMX in the measure usually does the same without storing it.' },
    { id: 'duplicate-measure', severity: 'warning', title: 'Measures with the same formula', help: 'Two or more measures have identical DAX. Keep one and let the others refer to it, or remove the duplicates.' },
    { id: 'measure-no-format', severity: 'warning', title: 'Measures without a format', help: 'Visible measures without a format string show raw numbers. Set thousands separators, decimals or a percentage.' },
    { id: 'measure-no-description', severity: 'info', title: 'Measures without a description', help: 'A description tells report builders (and Copilot) what the measure means. Hidden helper measures are skipped.' },
    { id: 'report-only-measure', severity: 'info', title: 'Measures defined in a report', help: 'These measures live in one thin report. Other reports cannot use them and they are not maintained with the model. Consider moving them to the semantic model.' },
    { id: 'unqualified-column', severity: 'info', title: 'Column references without a table name', help: 'Write columns as Table[Column] and measures as [Measure]. It makes formulas readable and avoids ambiguity.' },
    { id: 'qualified-measure', severity: 'info', title: 'Measure references with a table name', help: 'Write measures as [Measure], without the table. A measure reference with a table name looks like a column.' },
    { id: 'inactive-relationship', severity: 'info', title: 'Inactive relationships', help: 'Only used through USERELATIONSHIP. Listed so you can check that each one is still needed.' },
    { id: 'auto-date-time', severity: 'warning', title: 'Auto date/time is on', help: 'Power BI created a hidden date table for every date column. That costs memory; use one shared date table and turn Auto date/time off.' },
    { id: 'double-data-type', severity: 'info', title: 'Columns with a floating-point data type', help: 'Decimal number (double) can give rounding differences in totals. Fixed decimal number is exact for amounts with up to four decimals.' },
  ];

  /** model + analysis → {rules: [{…rule, items: [{id, label, detail}]}], counts: {error, warning, info}} */
  function checkRules(model, analysis) {
    const noModel = !!analysis.stats.noModel;
    const found = new Map(RULES.map(r => [r.id, []]));
    const add = (rule, n, detail) => found.get(rule).push({ id: n ? n.id : null, label: n ? objLabel(n) : '', detail: detail || '' });
    const list = analysis.list.filter(n => !n.system);
    const col = (t, c) => analysis.nodes.get('C|' + t + '|' + c) || list.find(n => n.type === 'column' && lc(n.table) === lc(t) && lc(n.name) === lc(c));

    for (const n of list) {
      if (n.broken) add('broken-formula', n, n.problems.map(p => p.ref + ': ' + p.reason).concat(n.brokenVia.map(id => 'depends on broken ' + objLabel(analysis.nodes.get(id)))).join('; '));
      if (n.kind === 'report measure') add('report-only-measure', n, 'in report ' + n.report);
    }
    if (!noModel) for (const u of analysis.broken) found.get('broken-reference').push({ id: null, label: u.table + '[' + u.name + ']', detail: [u.report, u.page, u.visualTitle || u.visualType || u.visual, u.role].filter(Boolean).join(' › ') });

    if (!noModel) {
      const keyCols = new Set();
      for (const r of model.relationships || []) {
        const from = col(r.fromTable, r.fromColumn), to = col(r.toTable, r.toColumn);
        const text = r.fromTable + '[' + r.fromColumn + '] → ' + r.toTable + '[' + r.toColumn + ']';
        if ((r.fromCardinality || 'many') === 'many' && (r.toCardinality || 'one') === 'many') add('many-to-many', from, text);
        if (/both/i.test(r.crossFilter || '')) add('bidirectional', from, text);
        if (!r.isActive) add('inactive-relationship', from, text);
        for (const c of [from, to]) if (c && !keyCols.has(c.id)) { keyCols.add(c.id); if (!c.hidden && c.status !== 'direct') add('key-visible', c, 'used in ' + text); }
      }
      const byExpr = new Map();
      for (const n of list) {
        if (n.type === 'measure') {
          const key = String(n.expression || '').replace(/\s+/g, '').toLowerCase();
          if (key) { if (!byExpr.has(key)) byExpr.set(key, []); byExpr.get(key).push(n); }
        }
        if (n.kind === 'measure' && !n.hidden) {
          if (!n.formatString && !(n.extraExpressions || []).length) add('measure-no-format', n, '');
          if (!String(n.description || '').trim()) add('measure-no-description', n, '');
        }
        if (n.kind === 'calculated column' && /^(int64|double|decimal)$/i.test(n.dataType || '') && !n.modelUses.length && !n.reportUses.length && n.usedBy.size) {
          const users = [...n.usedBy].map(id => analysis.nodes.get(id));
          if (users.every(u => u && u.type === 'measure')) add('calc-column-as-measure', n, 'only used by ' + users.slice(0, 3).map(objLabel).join(', ') + (users.length > 3 ? ' …' : ''));
        }
        if (n.type === 'column' && /^double$/i.test(n.dataType || '')) add('double-data-type', n, '');
        if (n.type === 'measure' && n.expression) {
          const bare = new Set(), qual = new Set();
          for (const r of daxRefs(n.expression)) {
            const hit = analysis.resolve(r, n.table);
            if (!hit) continue;
            if (r.t === 'b' && hit.type === 'column') bare.add('[' + r.name + ']');
            if (r.t === 'q' && hit.type === 'measure') qual.add(r.table + '[' + r.name + ']');
          }
          if (bare.size) add('unqualified-column', n, [...bare].join(', '));
          if (qual.size) add('qualified-measure', n, [...qual].join(', '));
        }
      }
      for (const group of byExpr.values()) {
        if (group.length < 2) continue;
        for (const n of group) add('duplicate-measure', n, 'same formula as ' + group.filter(x => x !== n).map(objLabel).join(', '));
      }
      const auto = analysis.list.filter(n => n.type === 'table' && n.system);
      if (auto.length) found.get('auto-date-time').push({ id: null, label: auto.length + ' hidden date tables', detail: 'File › Options › Data Load › Auto date/time' });
    }
    const rules = RULES.map(r => Object.assign({}, r, { items: found.get(r.id) })).filter(r => r.items.length);
    const counts = { error: 0, warning: 0, info: 0 };
    for (const r of rules) counts[r.severity] += r.items.length;
    return { rules, counts, total: counts.error + counts.warning + counts.info };
  }
  const objLabel = n => (!n ? '?' : n.type === 'measure' ? '[' + n.name + ']' : n.type === 'table' ? "'" + n.name + "'" : n.type === 'function' ? n.name + '()' : n.table + '[' + n.name + ']');

  return {
    checkRules, RULES,
    scanTmdl, editTmdlObject, renameRefsTmdl, renameInReport, tmdlName,
    zipWants, statsFromVpax, applyStats, removeFromTmdl,
    parseTmdlTree, addTmdlToModel, emptyModel, modelFromBim, daxRefs, walkRefs,
    loadProject, analyze, layers, readZipTexts, wantsFile, decodeText,
  };
});
