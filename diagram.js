/* Semantic Model Optimizer — model diagram (star schema view).
 * Draws tables as cards and relationships as lines, either the whole model in layers
 * (dimensions around the fact tables) or a star around one chosen table. */
(function (root) {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lc = s => String(s == null ? '' : s).toLowerCase();
  const W = 184, H = 66, GX = 26, GY = 96, PAD = 30, MAX_ROW = 6;

  /** Merges the relationships between each pair of tables and works out which side is "many". */
  function buildGraph(model, names) {
    const has = new Set(names.map(lc));
    const canon = new Map(names.map(n => [lc(n), n]));
    const pairs = new Map();
    const info = new Map(names.map(n => [n, { many: new Set(), one: new Set() }]));
    for (const r of model.relationships || []) {
      if (!has.has(lc(r.fromTable)) || !has.has(lc(r.toTable))) continue;
      // normalise so that 'a' is the many side and 'b' the one side
      let a = canon.get(lc(r.fromTable)), b = canon.get(lc(r.toTable));
      let ca = r.fromCardinality || 'many', cb = r.toCardinality || 'one';
      if (ca === 'one' && cb === 'many') { [a, b] = [b, a]; [ca, cb] = [cb, ca]; }
      if (a === b) continue;
      const key = a + '\u0001' + b;
      if (!pairs.has(key)) pairs.set(key, { a, b, ca, cb, rels: [], active: false, both: false });
      const p = pairs.get(key);
      p.rels.push(r);
      if (r.isActive) p.active = true;
      if (/both/i.test(r.crossFilter || '')) p.both = true;
      info.get(a).many.add(b);
      info.get(b).one.add(a);
    }
    for (const [n, i] of info) {
      i.role = i.many.size && !i.one.size ? 'fact' : i.one.size && !i.many.size ? 'dimension' : i.many.size ? 'bridge' : 'other';
      i.name = n;
    }
    return { pairs: [...pairs.values()], info };
  }

  /** Whole model: facts in the middle row, dimensions above and below, snowflaked tables further out. */
  function layoutOverview(names, g, showOther) {
    const info = g.info;
    const level = new Map();
    let facts = names.filter(n => info.get(n).role === 'fact');
    if (!facts.length) facts = names.filter(n => info.get(n).many.size).sort((x, y) => info.get(y).many.size - info.get(x).many.size).slice(0, 1);
    for (const f of facts) level.set(f, 0);
    let cur = facts.slice();
    for (let d = 1; cur.length && d < 6; d++) {
      const next = [];
      for (const n of cur) for (const m of [...info.get(n).many, ...info.get(n).one]) if (!level.has(m)) { level.set(m, d); next.push(m); }
      cur = next;
    }
    const neigh = n => [...info.get(n).many, ...info.get(n).one];
    const pos = new Map();
    const order = new Map();
    facts.sort((x, y) => x.localeCompare(y)).forEach((n, i) => order.set(n, i));
    const lvl1 = names.filter(n => level.get(n) === 1);
    const bary = (n, among) => { const xs = neigh(n).filter(m => among.has(m)).map(m => order.get(m)); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; };
    for (let it = 0; it < 3; it++) {
      const fs = new Set(facts);
      lvl1.sort((x, y) => bary(x, fs) - bary(y, fs) || x.localeCompare(y)).forEach((n, i) => order.set(n, i * facts.length / Math.max(1, lvl1.length)));
      const ds = new Set(lvl1);
      facts.sort((x, y) => bary(x, ds) - bary(y, ds) || x.localeCompare(y)).forEach((n, i) => order.set(n, i));
    }
    const rows = new Map(); // row index → names
    const put = (row, n) => { if (!rows.has(row)) rows.set(row, []); rows.get(row).push(n); };
    for (const f of facts) put(0, f);
    const side = new Map();
    lvl1.forEach((n, i) => { const s = i % 2 ? 1 : -1; side.set(n, s); put(s, n); });
    for (const n of names) {
      const l = level.get(n);
      if (l == null || l < 2) continue;
      const parent = neigh(n).find(m => level.get(m) === l - 1);
      const s = side.get(parent) || 1;
      side.set(n, s);
      put(s * l, n);
    }
    const others = names.filter(n => !level.has(n));
    // long rows are split in two or more, so the cards stay readable
    const rowList = [];
    for (const k of [...rows.keys()].sort((x, y) => x - y)) {
      const r = rows.get(k), parts = Math.ceil(r.length / MAX_ROW), per = Math.ceil(r.length / parts);
      for (let i = 0; i < parts; i++) rowList.push(r.slice(i * per, (i + 1) * per));
    }
    const maxLen = Math.max(1, ...rowList.map(r => r.length));
    const keys = rowList.map((r, i) => i);
    const width = maxLen * (W + GX) - GX;
    keys.forEach((k, ri) => {
      const r = rowList[k];
      const step = r.length > 1 ? Math.max(W + GX, (width - W) / (r.length - 1)) : 0;
      const total = r.length > 1 ? step * (r.length - 1) + W : W;
      const x0 = (width - Math.min(width, total)) / 2;
      r.forEach((n, i) => pos.set(n, { x: PAD + x0 + i * (r.length > 1 ? Math.min(step, (width - W) / (r.length - 1)) : 0), y: PAD + ri * (H + GY) }));
    });
    let bottom = PAD + keys.length * (H + GY) - GY;
    if (showOther && others.length) {
      const per = Math.max(1, Math.floor((width + GX) / (W + GX)));
      others.sort((x, y) => x.localeCompare(y)).forEach((n, i) => pos.set(n, { x: PAD + (i % per) * (W + GX), y: bottom + 70 + Math.floor(i / per) * (H + 16) }));
      bottom = bottom + 70 + Math.ceil(others.length / per) * (H + 16) - 16;
    }
    return { pos, width: width + PAD * 2, height: bottom + PAD, othersY: showOther && others.length ? bottom - Math.ceil(others.length / Math.max(1, Math.floor((width + GX) / (W + GX)))) * (H + 16) + 16 - 14 : null };
  }

  /** Star: the chosen table in the middle, every related table around it, snowflaked tables one ring further. */
  function layoutStar(center, g) {
    const info = g.info;
    const c = info.get(center);
    const ring1 = [...new Set([...c.many, ...c.one])].sort((x, y) => (c.one.has(x) ? 1 : 0) - (c.one.has(y) ? 1 : 0) || x.localeCompare(y));
    const n = ring1.length;
    const rx = Math.max(330, n * (W + 18) / (2 * Math.PI) * 1.12), ry = Math.max(210, rx * 0.6);
    const raw = new Map([[center, { x: 0, y: 0 }]]);
    const angle = new Map();
    ring1.forEach((t, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / Math.max(1, n); angle.set(t, a); raw.set(t, { x: Math.cos(a) * rx, y: Math.sin(a) * ry }); });
    for (const t of ring1) {
      const outer = [...info.get(t).many].filter(m => !raw.has(m));
      outer.forEach((m, i) => {
        const a = angle.get(t) + (i - (outer.length - 1) / 2) * 0.22;
        raw.set(m, { x: Math.cos(a) * rx * 1.62, y: Math.sin(a) * ry * 1.75 });
      });
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of raw.values()) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    const pos = new Map();
    for (const [k, p] of raw) pos.set(k, { x: p.x - minX + PAD, y: p.y - minY + PAD });
    return { pos, width: maxX - minX + W + PAD * 2, height: maxY - minY + H + PAD * 2 };
  }

  const cut = (s, m) => (s.length > m ? s.slice(0, m - 1) + '…' : s);
  const ROLE = { fact: 'fact', dimension: 'dimension', bridge: 'bridge', other: 'not related' };

  /**
   * opts: {model, analysis, center (table name or ''), selected (node id), showOther, fmt: {int, mb}}
   * → {svg, width, height, centers: [{name, role}]}
   */
  function render(opts) {
    const a = opts.analysis;
    const tables = a.list.filter(n => n.type === 'table' && !n.system);
    const names = tables.map(t => t.name);
    const node = new Map(tables.map(t => [t.name, t]));
    const g = buildGraph(opts.model, names);
    const counts = new Map(names.map(n => [n, { cols: 0, unused: 0, measures: 0 }]));
    for (const n of a.list) {
      const c = counts.get(n.table);
      if (!c || n.system) continue;
      if (n.type === 'column') { c.cols++; if (n.status === 'unused') c.unused++; }
      else if (n.type === 'measure' && n.kind === 'measure') c.measures++;
    }
    const center = opts.center && g.info.has(opts.center) ? opts.center : '';
    const lay = center ? layoutStar(center, g) : layoutOverview(names, g, opts.showOther);
    const pos = lay.pos;
    const selName = opts.selected && opts.selected.startsWith('T|') ? opts.selected.slice(2) : '';
    const focus = selName && pos.has(selName) ? selName : center;

    const mid = n => ({ x: pos.get(n).x + W / 2, y: pos.get(n).y + H / 2 });
    const clip = (p, q, extra) => {
      const dx = q.x - p.x, dy = q.y - p.y;
      if (!dx && !dy) return { x: p.x, y: p.y };
      const s = Math.min(dx ? (W / 2) / Math.abs(dx) : Infinity, dy ? (H / 2) / Math.abs(dy) : Infinity);
      const len = Math.hypot(dx, dy), k = s + (extra || 0) / len;
      return { x: p.x + dx * k, y: p.y + dy * k };
    };
    let edges = '';
    for (const p of g.pairs) {
      if (!pos.has(p.a) || !pos.has(p.b)) continue;
      const A = mid(p.a), B = mid(p.b);
      const s = clip(A, B), e = clip(B, A), la = clip(A, B, 12), lb = clip(B, A, 12);
      const hot = focus && (p.a === focus || p.b === focus);
      const cls = 'rel' + (p.active ? '' : ' inactive') + (hot ? ' hot' : focus ? ' dim' : '');
      const title = p.rels.map(r => `${r.fromTable}[${r.fromColumn}] → ${r.toTable}[${r.toColumn}]` + (r.isActive ? '' : ' (inactive)') + (/both/i.test(r.crossFilter || '') ? ' (both directions)' : '')).join('\n');
      const mx = (s.x + e.x) / 2, my = (s.y + e.y) / 2;
      const badge = (p.rels.length > 1 ? '×' + p.rels.length : '') + (p.both ? ' ⇄' : '');
      edges += `<g class="${cls}"><title>${esc(title)}</title><line x1="${s.x.toFixed(1)}" y1="${s.y.toFixed(1)}" x2="${e.x.toFixed(1)}" y2="${e.y.toFixed(1)}"/>
        <text class="card" x="${la.x.toFixed(1)}" y="${(la.y + 4).toFixed(1)}" text-anchor="middle">${p.ca === 'one' ? '1' : '*'}</text>
        <text class="card" x="${lb.x.toFixed(1)}" y="${(lb.y + 4).toFixed(1)}" text-anchor="middle">${p.cb === 'many' ? '*' : '1'}</text>
        ${badge.trim() ? `<rect class="badgebg" x="${(mx - 14).toFixed(1)}" y="${(my - 8).toFixed(1)}" width="28" height="16" rx="8"/><text class="card" x="${mx.toFixed(1)}" y="${(my + 4).toFixed(1)}" text-anchor="middle">${esc(badge.trim())}</text>` : ''}</g>`;
    }
    let cards = '';
    for (const [name, p] of pos) {
      const t = node.get(name), i = g.info.get(name), c = counts.get(name);
      const related = focus && (name === focus || i.many.has(focus) || i.one.has(focus));
      const cls = 'tcard r-' + i.role + (name === selName ? ' sel' : '') + (name === center ? ' center' : '') + (focus && !related ? ' dim' : '');
      let third = c.unused ? `${c.unused} of ${c.cols} columns unused` : `${c.cols} columns`;
      if (a.stats.hasStats && (t.rows != null || t.size != null)) third = (t.rows != null ? opts.fmt.int(t.rows) + ' rows' : '') + (t.size ? ' · ' + opts.fmt.mb(t.size) + ' MB' : t.mode === 'directQuery' ? ' · DirectQuery' : '');
      const kind = t.kind !== 'table' ? t.kind : ROLE[i.role];
      cards += `<g class="${cls}" data-table="${esc(name)}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">
        <title>${esc(name + ' — ' + kind + '\n' + c.cols + ' columns (' + c.unused + ' unused), ' + c.measures + ' measures' + (t.description ? '\n' + t.description : '') + '\nClick to select, double-click to centre the star on this table.')}</title>
        <rect class="box" width="${W}" height="${H}" rx="7"/><rect class="stripe" width="${W}" height="5" rx="2.5"/>
        <text class="tname" x="10" y="24">${esc(cut(name, 24))}</text>
        <text class="sub" x="10" y="40">${esc(kind + (c.measures ? ' · ' + c.measures + ' measures' : '') + (t.hidden ? ' · hidden' : ''))}</text>
        <text class="sub${c.unused && !a.stats.hasStats ? ' bad' : ''}" x="10" y="55">${esc(cut(third, 34))}</text>
        <circle cx="${W - 11}" cy="17" r="4" fill="var(--${t.status})"/></g>`;
    }
    const label = lay.othersY != null ? `<text class="col" x="${PAD}" y="${lay.othersY}">Tables without relationships</text>` : '';
    const centers = names.filter(n => g.info.get(n).role !== 'other').map(n => ({ name: n, role: g.info.get(n).role }))
      .sort((x, y) => (x.role === 'fact' ? 0 : 1) - (y.role === 'fact' ? 0 : 1) || x.name.localeCompare(y.name));
    const stats = { fact: 0, dimension: 0, bridge: 0, other: 0 };
    for (const i of g.info.values()) stats[i.role]++;
    return {
      svg: `<svg viewBox="0 0 ${Math.ceil(lay.width)} ${Math.ceil(lay.height)}" role="img" aria-label="Model diagram">${edges}${label}${cards}</svg>`,
      width: Math.ceil(lay.width), height: Math.ceil(lay.height), centers, stats, relationships: (opts.model.relationships || []).length, center,
    };
  }

  root.SMODiagram = { render };
})(typeof self !== 'undefined' ? self : this);
