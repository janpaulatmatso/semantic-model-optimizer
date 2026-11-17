/* Semantic Model Optimizer — extra views and actions that build on app.js:
 * fixing check findings, restoring backups, the page view, performance and documentation. */
(function () {
  'use strict';
  const App = window.SMOApp;
  if (!App || !App.state) return;
  const { state, $, esc, msg } = App;
  const el = (tag, attrs, html) => { const e = document.createElement(tag); Object.assign(e, attrs || {}); if (html != null) e.innerHTML = html; return e; };
  const busy = async fn => { document.body.style.cursor = 'progress'; try { return await fn(); } finally { document.body.style.cursor = ''; } };
  const model = () => state.project.models[state.modelIdx];

  /** Adds a tab and its pane. render() is called whenever the tab is shown or the data changes. */
  function addView(id, title, html, render) {
    const b = el('button', { type: 'button' }, title);
    b.dataset.view = id; b.id = 'tab-' + id;
    $('viewTabs').appendChild(b);
    const pane = el('div', { className: 'left', hidden: true }, html);
    pane.dataset.view = id; pane.id = 'view-' + id;
    $('split').insertBefore(pane, $('detail'));
    App.views[id] = render;
    return pane;
  }
  App.addView = addView;

  // ------------------------------------------------------------ fix findings

  $('checksList').addEventListener('click', e => {
    const b = e.target.closest('[data-fix]');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const rule = state.checks.rules.find(r => r.id === b.dataset.fix);
    if (!rule) return;
    const dlg = $('dlg');
    const what = { 'key-visible': 'will be hidden', 'measure-no-format': 'get a number format (a percentage when the name says so, otherwise a whole or decimal number)', 'duplicate-measure': 'are rewritten to refer to one measure with that formula; the most used one is kept' }[rule.id];
    dlg.innerHTML = `<h2>${esc(b.textContent)}</h2><p>${rule.items.length} object${rule.items.length === 1 ? '' : 's'} ${what}.</p>
      <ul class="small"><li>The TMDL files are changed; each changed file is first copied to <code>smo-backup</code>.</li><li><b>Close this project in Power BI Desktop first.</b></li><li>You can undo it under <b>History</b>.</li></ul>
      <div class="dlgbtn"><button data-act="cancel">Cancel</button><button class="primary" data-act="go">Fix ${rule.items.length}</button></div>`;
    dlg.onclick = async ev => {
      const act = ev.target.dataset && ev.target.dataset.act;
      if (!act) return;
      dlg.close();
      if (act !== 'go') return;
      await busy(async () => {
        const r = await App.apiPost('api/fix', { path: state.loadedPath, modelRoot: model().root, rule: rule.id });
        $('msgs').innerHTML = '';
        if (r.error) return msg(r.error, true);
        msg(r.changed ? `${r.fixed} fixed in ${r.files} file${r.files === 1 ? '' : 's'}. Copy of the old files: ${r.backup}` : 'Nothing needed fixing.');
        await App.reloadFromDisk();
      });
    };
    dlg.showModal();
  }, true);

  // ------------------------------------------------------------ history: restore a backup

  const histBtn = el('button', { type: 'button', id: 'btnHistory', title: 'Backups the tool made before each change; restore one to undo' }, 'History');
  $('viewTabs').after(histBtn);
  App.onRun.push(() => { histBtn.hidden = !App.canWrite(); });
  histBtn.onclick = () => busy(async () => {
    const r = await App.apiPost('api/backups', { path: state.loadedPath, modelRoot: model().root });
    const dlg = $('dlg');
    const fmt = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}`;
    dlg.innerHTML = `<h2>History</h2>` + (r.error ? `<p class="warn">${esc(r.error)}</p>` : !r.backups.length ? '<p class="muted">No backups yet. The tool makes one before every change it writes.</p>' :
      `<p class="small">Each line is the state of the files just before a change. Restoring puts those files back; the current files are backed up first, so you can undo a restore too.</p>
       <table class="uses">${r.backups.slice(0, 40).map((b, i) => `<tr><td>${fmt(b.stamp)}</td><td class="muted">${b.files} file${b.files === 1 ? '' : 's'}</td><td>${i === 0 ? '<span class="muted small">latest change</span>' : ''}</td><td><button data-stamp="${b.stamp}">Restore</button></td></tr>`).join('')}</table>`) +
      `<p class="small warn">Close the project in Power BI Desktop before restoring.</p><div class="dlgbtn"><button data-act="cancel">Close</button></div>`;
    dlg.onclick = async ev => {
      const d = ev.target.dataset || {};
      if (d.act) return dlg.close();
      if (!d.stamp) return;
      dlg.close();
      await busy(async () => {
        const x = await App.apiPost('api/restore', { path: state.loadedPath, modelRoot: model().root, stamp: d.stamp });
        $('msgs').innerHTML = '';
        if (x.error) return msg(x.error, true);
        msg(`${x.restored} file${x.restored === 1 ? '' : 's'} restored from ${fmt(d.stamp)}.`);
        await App.reloadFromDisk();
      });
    };
    dlg.showModal();
  });

  // ------------------------------------------------------------ bus matrix: business processes against dimensions

  addView('bus', 'Bus matrix',
    '<div class="count" id="busInfo"></div><div class="tablewrap busw" id="busGrid"></div>' +
    '<div class="legend dlegend"><span><b>X</b> related</span><span><b>X×3</b> three relationships to the same dimension (role-playing)</span><span><b>○</b> only through an inactive relationship</span>' +
    '<span><b>·</b> reached through another dimension</span><span>Coloured columns are conformed dimensions. Click a name to open the table; hover a mark for the columns.</span></div>',
    function renderBus() {
      const a = state.analysis, bm = SMO.busMatrix(model().model, a);
      if (!bm.facts.length || !bm.dims.length) {
        $('busInfo').textContent = '';
        $('busGrid').innerHTML = '<p class="muted" style="padding:10px">No bus matrix to show: the model has no fact table with relationships to dimensions.</p>';
        return;
      }
      const conf = bm.dims.filter(d => d.conformed).length, sel = state.selected && state.selected.startsWith('T|') ? state.selected.slice(2) : '';
      $('busInfo').textContent = `${bm.facts.length} business process${bm.facts.length === 1 ? '' : 'es'} · ${bm.dims.length} dimensions, ${conf} of them conformed (used by more than one process)`;
      $('busGrid').innerHTML = '<table class="bm"><thead><tr><th class="corner">Business process</th>' +
        bm.dims.map(d => `<th class="v${d.conformed ? ' conf' : ''}${d.name === sel ? ' sel' : ''}" data-id="${esc('T|' + d.name)}" title="${esc(d.description || d.name)}"><span>${esc(d.name)}</span></th>`).join('') +
        '<th class="v tot"><span>Dimensions</span></th></tr></thead><tbody>' +
        bm.facts.map(f => `<tr class="${f.name === sel ? 'sel' : ''}"><th data-id="${esc('T|' + f.name)}" title="${esc(f.description)}">${esc(f.name)}<div class="muted small">${f.measures} measure${f.measures === 1 ? '' : 's'}${f.rows != null ? ' · ' + App.int(f.rows) + ' rows' : ''}</div></th>` +
          bm.dims.map(d => { const c = bm.cell(f.name, d.name); return `<td class="${!c ? '' : c.via ? 'via' : c.active ? 'x' : 'ina'}${d.name === sel ? ' sel' : ''}" title="${esc(!c ? '' : c.via ? 'through ' + c.via : c.columns.join('\n'))}">${SMO.busMark(c)}</td>`; }).join('') +
          `<td class="tot">${f.dims}</td></tr>`).join('') +
        '<tr class="totrow"><th>Business processes</th>' + bm.dims.map(d => `<td>${d.facts}</td>`).join('') + '<td></td></tr></tbody></table>';
    });
  $('busGrid').onclick = e => { const x = e.target.closest('[data-id]'); if (x && state.analysis.nodes.has(x.dataset.id)) { App.select(x.dataset.id); App.views.bus(); } };

  // ------------------------------------------------------------ pages: what is on each report page

  const visLabel = u => u.visualTitle || u.visualType || u.visual || '(page or report filter)';
  /** report → page → visual → fields, built from the usage of every object. */
  function pageTree() {
    const a = state.analysis, tree = new Map();
    const add = (u, item) => {
      if (!tree.has(u.report)) tree.set(u.report, new Map());
      const pages = tree.get(u.report), pk = u.page || '(report level)';
      if (!pages.has(pk)) pages.set(pk, new Map());
      const vis = pages.get(pk), vk = u.visual || u.role;
      if (!vis.has(vk)) vis.set(vk, { id: u.visual, label: visLabel(u), type: u.visualType || '', fields: [] });
      vis.get(vk).fields.push(Object.assign({ role: u.role }, item));
    };
    for (const n of a.list) for (const u of n.reportUses) add(u, { node: n });
    for (const u of a.broken) add(u, { missing: u.table + '[' + u.name + ']' });
    return tree;
  }
  addView('pages', 'Pages',
    '<div class="filters"><input id="pgQ" type="search" placeholder="Search a page, visual or field"></div><div class="count" id="pgInfo"></div><div class="tablewrap checks" id="pgList"></div>',
    function renderPages() {
      const q = ($('pgQ').value || '').toLowerCase(), tree = pageTree(), perf = perfByVisual();
      let h = '', nPages = 0, nVis = 0;
      for (const [report, pages] of [...tree].sort((x, y) => x[0].localeCompare(y[0]))) {
        for (const [page, vis] of [...pages].sort((x, y) => x[0].localeCompare(y[0]))) {
          const rows = [...vis.values()].filter(v => !q || (report + ' ' + page + ' ' + v.label + ' ' + v.fields.map(f => (f.node ? f.node.name + ' ' + f.node.table : f.missing)).join(' ')).toLowerCase().includes(q))
            .sort((x, y) => x.label.localeCompare(y.label));
          if (!rows.length) continue;
          nPages++; nVis += rows.length;
          h += `<details class="rule" open><summary><b>${esc(page)}</b><span class="muted small">${esc(report)}</span><span class="cnt">${rows.length}</span></summary><table class="uses">` +
            rows.map(v => { const p = perf.get(v.id); return `<tr><td style="width:30%"><b>${esc(v.label)}</b><div class="muted small">${esc(v.type)}${p ? ' · ' + App.int(p.total) + ' ms' : ''}</div></td><td>` +
              v.fields.map(f => f.node
                ? `<span class="link" data-id="${esc(f.node.id)}" title="${esc(f.role)}"><span class="k-${f.node.type === 'measure' ? 'measure' : 'column'}">●</span> ${esc(App.label(f.node))}${f.node.broken ? ' <span class="brk">broken</span>' : ''}</span>`
                : `<span class="link brk" title="${esc(f.role)}: not in the model">${esc(f.missing)}</span>`).join(' ') + '</td></tr>'; }).join('') + '</table></details>';
        }
      }
      $('pgInfo').textContent = nPages ? `${nPages} page${nPages === 1 ? '' : 's'} · ${nVis} visuals and filters with fields` : 'No report loaded, or nothing matches.';
      $('pgList').innerHTML = h;
    });
  $('pgQ').oninput = () => App.views.pages();
  /** Opens the Pages view on one visual or page (from the lineage). */
  App.openInPages = text => { App.setView('pages'); $('pgQ').value = text || ''; App.views.pages(); };
  $('pgList').onclick = e => { const x = e.target.closest('[data-id]'); if (x) App.select(x.dataset.id); };

  // ------------------------------------------------------------ performance: Performance Analyzer export

  function perfByVisual() {
    const m = new Map();
    for (const v of (state.project && state.project.performance) || []) if (v.visualId) m.set(v.visualId, v);
    return m;
  }
  /** Which objects each timed visual uses, and the slowest visual per object. */
  function perfLinks() {
    const a = state.analysis, byVis = new Map();
    for (const n of a.list) for (const u of n.reportUses) { if (!byVis.has(u.visual)) byVis.set(u.visual, { page: u.page, report: u.report, nodes: new Set() }); byVis.get(u.visual).nodes.add(n.id); }
    return byVis;
  }
  const perfPane = addView('perf', 'Performance',
    '<div class="count" id="pfInfo"></div><div class="tablewrap"><table id="pfGrid" class="pf"><thead></thead><tbody></tbody></table><div id="pfDetail" class="pfdetail"></div></div>',
    function renderPerf() {
      const list = (state.project && state.project.performance) || [], links = perfLinks();
      $('tab-perf').hidden = false;
      if (!list.length) {
        $('pfInfo').textContent = '';
        $('pfGrid').querySelector('thead').innerHTML = '';
        $('pfGrid').querySelector('tbody').innerHTML = '';
        $('pfDetail').innerHTML = '<p class="muted" style="padding:10px">No timings loaded. In Power BI Desktop choose <b>Optimize › Performance analyzer</b>, start recording, refresh the visuals and choose <b>Export</b>. Put that file in the project folder or open it with <b>Open file</b>.</p>';
        return;
      }
      const max = Math.max(...list.map(v => v.total), 1), sum = list.reduce((x, v) => x + v.total, 0);
      $('pfInfo').textContent = `${list.length} visuals timed · slowest ${App.int(max)} ms · together ${App.int(sum)} ms. Click a visual to see its fields and query.`;
      $('pfGrid').querySelector('thead').innerHTML = '<tr><th>Visual</th><th>Page</th><th>Measures and columns</th><th class="num">Total ms</th><th class="num">DAX query</th><th class="num">of which source</th><th class="num">Render</th><th class="num">Rows</th></tr>';
      $('pfGrid').querySelector('tbody').innerHTML = list.map((v, i) => {
        const l = links.get(v.visualId);
        const f = fieldsOf(l), shown = f.slice(0, 6);
        return `<tr data-i="${i}" class="${state.perfSel === i ? 'sel' : ''}"><td class="nm">${esc(v.title || v.type || v.visualId)}<div class="muted small" style="font-weight:400">${esc(v.type)}</div></td><td>${esc(l ? l.page : '')}</td>
          <td class="pffields">${l ? shown.map(chip).join('') + (f.length > shown.length ? `<span class="muted small"> +${f.length - shown.length} more</span>` : '') : '<span class="muted small">not in the loaded reports</span>'}</td>
          <td class="num"><span class="sbar" style="--w:${Math.max(2, Math.round(v.total / max * 100))}%"></span>${App.int(v.total)}</td><td class="num">${App.int(v.dax)}</td><td class="num">${App.int(v.directQuery)}</td><td class="num">${App.int(v.render)}</td><td class="num">${v.rows == null ? '' : App.int(v.rows)}</td></tr>`;
      }).join('');
      const v = list[state.perfSel];
      if (!v) { $('pfDetail').innerHTML = ''; return; }
      const l = links.get(v.visualId);
      const nodes = fieldsOf(l);
      const measures = nodes.filter(n => n.type === 'measure'), cols = nodes.filter(n => n.type !== 'measure');
      // the columns the measures on this visual read, directly or through other measures: these are what the query scans
      const read = new Map();
      for (const m of measures) for (const layer of SMO.layers(state.analysis, m.id, 'deps')) for (const id of layer) { const x = state.analysis.nodes.get(id); if (x && x.type === 'column') read.set(id, x); }
      for (const c of cols) read.delete(c.id);
      const sizeOf = x => (x.size ? ` <span class="muted small">${App.mb(x.size)} MB</span>` : '');
      $('pfDetail').innerHTML = `<h3>${esc(v.title || v.type)}</h3>` +
        (v.total ? `<p class="small">${Math.round(v.dax / v.total * 100)}% of the time is the DAX query${v.directQuery ? `, of which ${Math.round(v.directQuery / Math.max(1, v.dax) * 100)}% is waiting for the source (DirectQuery)` : ''}; ${Math.round(v.render / v.total * 100)}% is drawing.</p>` : '') +
        (!l ? '<p class="muted small">This visual is not in the loaded reports, so its fields are unknown.</p>' :
          (measures.length ? `<h3>Measures (${measures.length})</h3><div class="links">${measures.map(chip).join('')}</div>` : '') +
          (cols.length ? `<h3>Columns (${cols.length})</h3><div class="links">${cols.map(n => chip(n) + sizeOf(n)).join('')}</div>` : '') +
          (read.size ? `<h3>Columns the measures read (${read.size})</h3><p class="muted small">Not on the visual itself, but the measures above calculate with them, so the query reads them too.</p><div class="links">${[...read.values()].sort((x, y) => App.label(x).localeCompare(App.label(y))).map(n => chip(n) + sizeOf(n)).join('')}</div>` : '')) +
        (v.query ? `<h3>Query</h3><pre class="dax">${esc(v.query)}</pre>` : '');
    });
  /** The objects a visual uses, measures first. */
  function fieldsOf(l) {
    if (!l) return [];
    return [...l.nodes].map(id => state.analysis.nodes.get(id)).filter(Boolean)
      .sort((x, y) => (x.type === 'measure' ? 0 : 1) - (y.type === 'measure' ? 0 : 1) || App.label(x).localeCompare(App.label(y)));
  }
  const chip = n => `<span class="link" data-id="${esc(n.id)}" title="${esc(n.kind + ' · ' + App.STATUS[n.status])}"><span class="k-${n.type === 'measure' ? 'measure' : n.kind === 'calculated column' ? 'calc' : 'column'}">●</span> ${esc(App.label(n))}${n.broken ? ' <span class="brk">broken</span>' : ''}</span>`;
  $('pfGrid').onclick = e => {
    const x = e.target.closest('[data-id]');
    if (x) return App.select(x.dataset.id);
    const tr = e.target.closest('tr[data-i]');
    if (tr) { state.perfSel = +tr.dataset.i; App.views.perf(); }
  };
  $('pfDetail').onclick = e => { const x = e.target.closest('[data-id]'); if (x) App.select(x.dataset.id); };
  App.onRun.push(() => {
    const n = ((state.project && state.project.performance) || []).length;
    $('tab-perf').innerHTML = 'Performance' + (n ? ` <span class="cnt">${n}</span>` : '');
  });

  // ------------------------------------------------------------ documentation: a readable description of the model

  function documentationHtml() {
    const a = state.analysis, m = model(), S = App.STATUS, e = esc;
    const tables = a.list.filter(n => n.type === 'table' && !n.system).sort((x, y) => x.name.localeCompare(y.name));
    const of = (t, type) => a.list.filter(n => n.type === type && n.table === t.name && !n.system);
    const rels = m.model.relationships || [];
    const css = 'body{font:14px/1.5 "Segoe UI",system-ui,sans-serif;color:#1c2330;max-width:1000px;margin:32px auto;padding:0 20px}h1{font-size:26px;margin-bottom:4px}h2{font-size:19px;margin-top:36px;border-bottom:2px solid #dfe3ea;padding-bottom:4px}h3{font-size:15px;margin:22px 0 6px}table{border-collapse:collapse;width:100%;margin:6px 0 14px}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #dfe3ea;vertical-align:top}th{font-size:12px;color:#677084}pre{background:#f1f3f7;border-radius:6px;padding:8px 10px;white-space:pre-wrap;font:12.5px/1.45 Consolas,monospace;margin:2px 0}.m{color:#677084}.tag{font-size:12px;border:1px solid #c8cdd8;border-radius:4px;padding:0 5px;color:#677084}nav a{margin-right:10px;white-space:nowrap}.bmwrap{overflow-x:auto}.bm{width:auto}.bm th,.bm td{border:1px solid #dfe3ea}.bm td{text-align:center;min-width:26px;padding:3px 4px;font-weight:600}.bm tbody th{font-size:14px;color:#1c2330;white-space:nowrap}.bm th.v{vertical-align:bottom;padding:6px 2px;height:150px}.bm th.v span{writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap;font-size:13px;color:#1c2330}.bm th.conf{background:#eef2ff}.bm td.x{background:#e7f5ec;color:#1f8f4e}.bm td.ina{color:#b77705}.bm td.via{color:#677084;font-weight:400}.bm .tot,.bm .totrow td,.bm .totrow th{background:#f6f7f9;color:#677084;font-weight:400}.bm th.corner{vertical-align:bottom}@media print{h2{break-before:page}h2:first-of-type{break-before:auto}}';
    let h = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${e(m.name)} — model documentation</title><style>${css}</style></head><body>` +
      `<h1>${e(m.name)}</h1><p class="m">Model documentation · generated ${new Date().toISOString().slice(0, 10)} by Semantic Model Optimizer</p>` +
      `<p>${tables.length} tables · ${a.stats.modelMeasures} measures · ${a.stats.columns} columns · ${rels.length} relationships` +
      (state.project.reports.length ? ` · reports: ${e(state.project.reports.map(r => r.name).join(', '))}` : '') + '</p>' +
      `<nav><a href="#bus-matrix"><b>Bus matrix</b></a>${tables.map(t => `<a href="#t-${encodeURIComponent(t.name)}">${e(t.name)}</a>`).join('')}</nav>`;
    const bm = SMO.busMatrix(m.model, a);
    if (bm.facts.length && bm.dims.length) {
      h += '<h2 id="bus-matrix">Bus matrix</h2><p>The enterprise data warehouse bus matrix: one row per business process (fact table), one column per dimension. A dimension used by more than one business process is a conformed dimension; those are the columns on the left.</p>' +
        '<div class="bmwrap"><table class="bm"><thead><tr><th class="corner">Business process</th>' + bm.dims.map(d => `<th class="v${d.conformed ? ' conf' : ''}" title="${e(d.description)}"><span>${e(d.name)}</span></th>`).join('') + '<th class="v tot"><span>Dimensions</span></th></tr></thead><tbody>' +
        bm.facts.map(f => `<tr><th title="${e(f.description)}">${e(f.name)}<div class="m">${f.measures} measure${f.measures === 1 ? '' : 's'}${f.rows != null ? ' · ' + App.int(f.rows) + ' rows' : ''}</div></th>` +
          bm.dims.map(d => { const c = bm.cell(f.name, d.name); return `<td class="${!c ? '' : c.via ? 'via' : c.active ? 'x' : 'ina'}" title="${e(!c ? '' : c.via ? 'through ' + c.via : c.columns.join('\n'))}">${SMO.busMark(c)}</td>`; }).join('') + `<td class="tot">${f.dims}</td></tr>`).join('') +
        '<tr class="totrow"><th>Business processes</th>' + bm.dims.map(d => `<td>${d.facts}</td>`).join('') + '<td></td></tr></tbody></table></div>' +
        '<p class="m"><b>X</b> related · <b>X×3</b> three relationships to the same dimension (role-playing, for example order date and ship date) · <b>○</b> only through an inactive relationship · <b>·</b> reached through another dimension (snowflake). Hover a mark for the columns.</p>';
    }
    if (bm.facts.length) {
      h += '<h2 id="grain">Grain per business process</h2><p>What one row of each fact table stands for, and the dimension keys that identify it. Keys marked with * belong to an inactive relationship.</p><table><tr><th>Business process</th><th>One row is</th><th>Dimension keys</th></tr>' +
        bm.facts.map(f => `<tr><td><b>${e(f.name)}</b></td><td>${e(f.description) || '<span class="m">not described</span>'}</td><td>${f.keys.map(k => e(k.dim) + ' <span class="m">(' + e(k.column) + (k.active ? '' : ' *') + ')</span>').join(', ')}</td></tr>`).join('') + '</table>';
    }
    const sec = SMO.securityOverview(m.model, a);
    if (sec.length) {
      h += '<h2 id="security">Security</h2><p>Row-level security: what each role filters, which tables that reaches through the relationships, and how many measures it touches.</p><table><tr><th>Role</th><th>Filters</th><th>Also reaches</th><th>Measures affected</th></tr>' +
        sec.map(r => `<tr><td><b>${e(r.name)}</b></td><td>${r.filters.map(f => e(f.table) + '<pre>' + e(f.expression) + '</pre>').join('') || '<span class="m">nothing</span>'}</td><td>${e(r.reaches.join(', '))}</td><td>${r.measures.length}</td></tr>`).join('') + '</table>';
    }
    h += '<h2>Relationships</h2><table><tr><th>From (many)</th><th>To (one)</th><th>Cardinality</th><th>Active</th><th>Filter</th></tr>' +
      rels.map(r => `<tr><td>${e(r.fromTable)}[${e(r.fromColumn)}]</td><td>${e(r.toTable)}[${e(r.toColumn)}]</td><td>${e(r.fromCardinality)} to ${e(r.toCardinality)}</td><td>${r.isActive ? 'yes' : 'no'}</td><td>${/both/i.test(r.crossFilter || '') ? 'both ways' : 'single'}</td></tr>`).join('') + '</table>';
    for (const t of tables) {
      const ms = of(t, 'measure'), cs = of(t, 'column');
      h += `<h2 id="t-${encodeURIComponent(t.name)}">${e(t.name)} <span class="tag">${e(t.kind)}</span>${t.hidden ? ' <span class="tag">hidden</span>' : ''}</h2>` +
        (t.description ? `<p>${e(t.description)}</p>` : '') +
        (t.sourceInfo ? `<p class="m">Source: ${e(t.sourceInfo.label)}</p>` : '') +
        (t.rows != null ? `<p class="m">${App.int(t.rows)} rows${t.size ? ' · ' + App.mb(t.size) + ' MB' : ''}</p>` : '') +
        (t.expression ? `<pre>${e(t.expression)}</pre>` : '');
      if (ms.length) {
        h += '<h3>Measures</h3>';
        for (const n of ms) h += `<p><b>${e(n.name)}</b> <span class="tag">${e(S[n.status])}</span>${n.kind === 'report measure' ? ` <span class="tag">only in report ${e(n.report)}</span>` : ''}${n.broken ? ' <span class="tag">broken</span>' : ''}${n.formatString ? ` <span class="m">format ${e(n.formatString)}</span>` : ''}<br>${n.description ? e(n.description) : '<span class="m">No description.</span>'}</p><pre>${e(n.expression)}</pre>`;
      }
      if (cs.length) {
        h += '<h3>Columns</h3><table><tr><th>Column</th><th>Type</th><th>Description</th><th>Source</th><th>Usage</th></tr>' +
          cs.map(n => `<tr><td>${e(n.name)}${n.hidden ? ' <span class="tag">hidden</span>' : ''}${n.kind === 'calculated column' ? ' <span class="tag">calculated</span>' : ''}</td><td>${e(n.dataType || '')}</td><td>${e(n.description || '')}${n.expression ? `<pre>${e(n.expression)}</pre>` : ''}</td><td class="m">${e(n.sourceRef || '')}</td><td>${e(S[n.status])}</td></tr>`).join('') + '</table>';
      }
    }
    return h + '</body></html>';
  }
  const docOpt = el('option', { value: 'doc' }, 'Documentation (.html)');
  $('selExport').appendChild(docOpt);
  document.addEventListener('change', e => {
    if (e.target !== $('selExport') || e.target.value !== 'doc') return;
    e.stopImmediatePropagation();
    e.target.value = '';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([documentationHtml()], { type: 'text/html' }));
    a.download = model().name + '-documentation.html';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, true);
  App.documentationHtml = documentationHtml;

  // ------------------------------------------------------------ compare with a Git branch or commit (in History)

  const cmpBtn = el('button', { type: 'button', id: 'btnCompare', title: 'What changed compared with a Git branch, tag or commit' }, 'Compare');
  histBtn.after(cmpBtn);
  App.onRun.push(() => { cmpBtn.hidden = !state.loadedPath; });
  cmpBtn.onclick = () => {
    const dlg = $('dlg');
    const last = App.store.get('smo.compareRef', 'HEAD');
    dlg.innerHTML = `<h2>Compare with a Git version</h2><p class="small">Shows what is added, removed, changed or newly broken in the files on disk, compared with a branch, tag or commit of the same repository.</p>
      <form class="addrep" id="cmpForm"><input id="cmpRef" type="text" value="${esc(last)}" placeholder="HEAD, main, origin/main, a tag or a commit" spellcheck="false"><button class="primary">Compare</button></form>
      <div id="cmpOut" class="cmpout"></div><div class="dlgbtn"><button type="button" data-act="cancel">Close</button></div>`;
    dlg.onclick = e => { if (e.target.dataset && e.target.dataset.act) dlg.close(); const x = e.target.closest('[data-id]'); if (x && state.analysis.nodes.has(x.dataset.id)) { dlg.close(); App.select(x.dataset.id); } };
    dlg.querySelector('#cmpForm').onsubmit = e => {
      e.preventDefault();
      const ref = dlg.querySelector('#cmpRef').value.trim() || 'HEAD';
      App.store.set('smo.compareRef', ref);
      busy(async () => {
        const out = dlg.querySelector('#cmpOut');
        out.innerHTML = '<p class="muted">Comparing…</p>';
        const d = await App.apiPost('api/compare', { path: state.loadedPath, modelRoot: model().root, ref });
        if (d.error) { out.innerHTML = `<p class="warn">${esc(d.error)}</p>`; return; }
        const part = (title, list, fmt, cls) => (list.length ? `<h3 class="${cls || ''}">${title} (${list.length})</h3><table class="uses">${list.slice(0, 100).map(x => `<tr><td>${x.id ? `<span class="link" data-id="${esc(x.id)}">${esc(x.label)}</span>` : esc(x.label)}</td><td class="muted">${esc(fmt(x))}</td></tr>`).join('')}</table>` : '');
        out.innerHTML = `<p><b>${d.added.length}</b> added · <b>${d.removed.length}</b> removed · <b>${d.changed.length}</b> changed, compared with <code>${esc(d.against)}</code></p>` +
          part('Newly broken formulas', d.newlyBroken, x => x.detail, 's-unused') + part('New broken references in reports', d.newBrokenRefs, x => x.detail, 's-unused') +
          part('Removed', d.removed, x => x.kind + (x.wasUsed ? ' · was in use' : '')) + part('Added', d.added, x => x.kind) + part('Changed', d.changed, x => x.what.join(', ')) +
          part('No longer used', d.nowUnused, () => '') + part('Fixed', d.fixed, () => '') + (d.total || d.newlyBroken.length ? '' : '<p class="muted">No differences in the model.</p>');
      });
    };
    dlg.showModal();
  };

  // ------------------------------------------------------------ reports from a Power BI workspace

  const wsBox = el('div', { className: 'wsbox' }, `<p class="small" style="margin:10px 0 6px"><b>Reports from a workspace.</b> Reads every report in a Power BI workspace that uses the model, so reports you do not have as files count too. Needs the Azure CLI signed in (<code>az login</code>). Read-only.</p>
    <form id="wsForm" class="addrep"><input id="wsName" type="text" placeholder="Workspace name or id" spellcheck="false"><input id="wsDataset" type="text" placeholder="Model name or id (empty = every report)" spellcheck="false"><button>Read reports</button></form>`);
  $('xmlaDbWrap').after(wsBox);
  $('wsName').value = App.store.get('smo.workspace', '');
  $('wsDataset').value = App.store.get('smo.dataset', '');
  $('wsForm').onsubmit = e => {
    e.preventDefault();
    const workspace = $('wsName').value.trim(), dataset = $('wsDataset').value.trim();
    if (!workspace) return;
    App.store.set('smo.workspace', workspace); App.store.set('smo.dataset', dataset);
    busy(async () => {
      $('xmlaInfo').textContent = 'Reading reports from the workspace… this can take a minute.';
      const r = await App.apiPost('api/workspace', { workspace, dataset });
      if (r.error) { $('xmlaInfo').textContent = r.error; return; }
      if (!r.files.length) { $('xmlaInfo').textContent = (r.warnings && r.warnings[0]) || 'No reports found.'; return; }
      $('xmlaPanel').hidden = true;
      state.adding = !!state.project;
      App.setProject(r.files, r.warnings || []);
      msg(`${r.reports.length} report${r.reports.length === 1 ? '' : 's'} read from workspace ${r.workspace}.`);
    });
  };

  // ------------------------------------------------------------ descriptions suggested by Claude

  $('checksList').addEventListener('click', e => {
    const b = e.target.closest('[data-suggest]');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const rule = state.checks.rules.find(r => r.id === 'measure-no-description');
    if (!rule) return;
    const dlg = $('dlg');
    dlg.innerHTML = `<h2>Suggest descriptions</h2><p>${rule.items.length} measure${rule.items.length === 1 ? '' : 's'} without a description.</p>
      <ul class="small"><li>The names and DAX of these measures, and the descriptions already in the model as examples, are sent to the Claude API (Anthropic). No data from your tables is sent.</li>
      <li>It uses the API credentials of the computer the tool runs on, and costs tokens on that account.</li><li>Nothing is saved until you have read the suggestions and chosen which to keep.</li></ul>
      <div id="sgOut"></div><div class="dlgbtn"><button data-act="cancel">Cancel</button><button class="primary" data-act="ask">Send and suggest</button></div>`;
    dlg.onclick = async ev => {
      const act = ev.target.dataset && ev.target.dataset.act;
      if (!act) return;
      if (act === 'cancel') return dlg.close();
      if (act === 'ask') {
        await busy(async () => {
          dlg.querySelector('#sgOut').innerHTML = '<p class="muted">Asking… this can take a minute.</p>';
          const r = await App.apiPost('api/describe', { path: state.loadedPath, modelRoot: model().root, ids: rule.items.map(i => i.id) });
          if (r.error) { dlg.querySelector('#sgOut').innerHTML = `<p class="warn">${esc(r.error)}</p>`; return; }
          if (!r.suggestions.length) { dlg.querySelector('#sgOut').innerHTML = '<p class="muted">No suggestions came back.</p>'; return; }
          dlg.querySelector('#sgOut').innerHTML = `<p class="small muted">Suggested by ${esc(r.model)}. Edit where needed and untick what you do not want.</p>` +
            r.suggestions.map((s, i) => `<label class="sg"><input type="checkbox" data-i="${i}" checked> <b>${esc(s.name)}</b> <span class="muted small">${esc(s.table)}</span><textarea data-t="${i}" rows="2">${esc(s.description)}</textarea></label>`).join('');
          dlg._sg = r.suggestions;
          dlg.querySelector('.dlgbtn').innerHTML = '<button data-act="cancel">Cancel</button><button class="primary" data-act="save">Save selected</button>';
        });
      }
      if (act === 'save') {
        const picks = [...dlg.querySelectorAll('input[data-i]:checked')].map(c => ({ s: dlg._sg[+c.dataset.i], text: dlg.querySelector(`textarea[data-t="${c.dataset.i}"]`).value.trim() })).filter(x => x.text);
        dlg.close();
        await busy(async () => {
          let ok = 0, err = '';
          for (const x of picks) {
            const r = await App.apiPost('api/edit', { path: state.loadedPath, modelRoot: model().root, sel: { type: 'measure', table: x.s.table, name: x.s.name }, changes: { description: x.text } });
            if (r.error) err = r.error; else ok++;
          }
          $('msgs').innerHTML = '';
          msg(`${ok} description${ok === 1 ? '' : 's'} saved.` + (err ? ' Last error: ' + err : ''), !!err && !ok);
          await App.reloadFromDisk();
        });
      }
    };
    dlg.showModal();
  }, true);

  // ------------------------------------------------------------ detail: where the data comes from, and security

  const security = () => (state._sec && state._sec.a === state.analysis ? state._sec.v : (state._sec = { a: state.analysis, v: SMO.securityOverview(model().model, state.analysis) }).v);
  App.detailExtras = [
    (a, n) => {
      if (n.type === 'table' && n.sourceInfo) return `<h3>Source</h3><div>${esc(n.sourceInfo.label)}</div>` + (n.sourceInfo.query ? `<pre class="dax">${esc(n.sourceInfo.query)}</pre>` : '');
      if (n.type === 'column' && n.sourceRef) { const t = a.nodes.get('T|' + n.table); return `<h3>Source</h3><div><code>${esc(n.sourceRef)}</code>${t && t.sourceInfo ? ` <span class="muted">in ${esc([t.sourceInfo.connector, t.sourceInfo.server, t.sourceInfo.database].filter(Boolean).join(' › '))}</span>` : ''}</div>`; }
      return '';
    },
    (a, n) => {
      const roles = security().filter(r => (n.type === 'table' && (r.filters.some(f => f.table === n.name) || r.reaches.includes(n.name))) || (n.type === 'measure' && r.measures.includes(n.id)));
      if (!roles.length) return '';
      return '<h3>Security</h3><table class="uses">' + roles.map(r => { const f = r.filters.find(x => x.table === n.name); return `<tr><td>role ${esc(r.name)}</td><td class="muted">${f ? 'filters this table: ' + esc(f.expression) : n.type === 'measure' ? 'its result depends on who is looking' : 'filtered through a relationship'}</td></tr>`; }).join('') + '</table>';
    },
  ];

  // ------------------------------------------------------------ the model that is open in Power BI Desktop

  const isLocal = () => !!(state.xmla && /^(localhost|127\.0\.0\.1):\d+$/.test(state.xmla.server));
  App.canLive = n => isLocal() && n.kind === 'measure' && !App.canWrite();

  /** Reads the model again from the server it came from and swaps it into the loaded project. */
  async function reloadXmla(selectId) {
    const r = await App.apiPost('api/xmla', { server: state.xmla.server, database: state.xmla.database, name: model().name });
    if (r.error) return msg(r.error, true);
    const keep = state.xmla;
    const files = state.files.filter(f => !/^server\//.test(f.path)).concat(r.files);
    App.reloadKeep(files, [], { base: null, path: null });
    state.xmla = keep;
    if (selectId && state.analysis.nodes.has(selectId)) App.select(selectId);
  }
  App.liveEdit = async (n, changes) => {
    const op = { op: 'edit', table: n.table, name: n.name };
    if (changes.description !== undefined && changes.description.trim() !== String(n.description || '').trim()) op.description = changes.description.trim();
    if (changes.expression !== undefined && changes.expression.trim() !== String(n.expression || '').trim()) op.expression = changes.expression.trim();
    if (Object.keys(op).length === 3) return { changed: false };
    const r = await App.apiPost('api/live', { server: state.xmla.server, database: state.xmla.database, ops: [op] });
    if (r.error) return r;
    if (!r.changed) return { error: 'The measure was not found in the open model.' };
    state.editing = null;
    $('msgs').innerHTML = '';
    msg('Changed in the model that is open in Power BI Desktop. Save the file there to keep it.');
    await reloadXmla(n.id);
    return { changed: true, live: true };
  };

  /** Opened from the External Tools ribbon of Power BI Desktop: ?server=localhost:port&database=… */
  async function openFromDesktop(server, database) {
    const port = (/:(\d+)$/.exec(server) || [])[1];
    let inst = null;
    try { inst = ((await fetch('api/desktop').then(x => x.json())).instances || []).find(i => String(i.port) === port); } catch (e) { /* not available */ }
    if (inst && /\.pbip$/i.test(inst.file || '')) {
      // a Power BI project: load its folder, so reports count and everything can be edited
      $('pathInput').value = inst.file.replace(/[\\/][^\\/]+$/, '');
      await App.loadFromPath($('pathInput').value);
      state.xmla = { server, database };
      $('btnDesktop').textContent = 'Sizes from Power BI Desktop';
      return msg('Opened from Power BI Desktop: project ' + inst.name + '.');
    }
    const r = await App.apiPost('api/xmla', { server, database, name: inst ? inst.name : '' });
    if (r.error) return msg(r.error, true);
    App.setProject(r.files, []);
    state.xmla = { server, database };
    msg('Opened from Power BI Desktop: model ' + r.name + '. This file is a .pbix, so the report in it cannot be read here; add reports with "+ Add report", or save the file as a Power BI project (.pbip).');
  }
  App.openFromDesktop = openFromDesktop;

  // ------------------------------------------------------------ values: what the measures return, before and after

  const valBtn = el('button', { type: 'button', id: 'btnValues', title: 'Calculate the measures on the model open in Power BI Desktop, and compare with an earlier snapshot' }, 'Values');
  cmpBtn.after(valBtn);
  App.onRun.push(() => { valBtn.hidden = $('pathForm').hidden; });
  const snapKey = () => 'smo.values.' + model().name;
  const fmtVal = v => (v == null ? '(blank)' : typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : String(v));
  valBtn.onclick = () => busy(async () => {
    const dlg = $('dlg');
    let list = [];
    try { list = (await fetch('api/desktop').then(x => x.json())).instances || []; } catch (e) { /* none */ }
    const snap = App.store.get(snapKey(), null);
    const measures = state.analysis.list.filter(n => n.kind === 'measure');
    dlg.innerHTML = `<h2>Values of the measures</h2><p class="small">Calculates the grand total of all ${measures.length} measures on the model that is open in Power BI Desktop. Take a snapshot before you change formulas, then compare afterwards: you see which results changed and which measures Power BI cannot calculate. Read-only. On a DirectQuery model this queries the source and can take a while.</p>
      <label class="inline">Open file <select id="valInst">${list.map(i => `<option value="${i.port}"${i.name === model().name ? ' selected' : ''}>${esc(i.name)} (port ${i.port})</option>`).join('')}</select></label>
      ${list.length ? '' : '<p class="warn small">No file is open in Power BI Desktop.</p>'}
      <p class="small muted" id="valSnap">${snap ? 'Snapshot from ' + esc(snap.at) + ' with ' + snap.values.length + ' measures.' : 'No snapshot yet for this model.'}</p>
      <div id="valOut" class="cmpout"></div>
      <div class="dlgbtn"><button data-act="cancel">Close</button><button data-act="snap"${list.length ? '' : ' disabled'}>Take snapshot</button><button class="primary" data-act="cmp"${list.length && snap ? '' : ' disabled'}>Compare with snapshot</button></div>`;
    const calc = async () => {
      const server = 'localhost:' + dlg.querySelector('#valInst').value;
      dlg.querySelector('#valOut').innerHTML = '<p class="muted">Calculating…</p>';
      const cats = await App.apiPost('api/xmla', { server });
      if (cats.error) return cats;
      return App.apiPost('api/values', { server, database: (cats.catalogs || [])[0] || '', measures: measures.map(n => ({ table: n.table, name: n.name })) });
    };
    const errorsHtml = vals => { const bad = vals.filter(v => v.error); return bad.length ? `<h3 class="s-unused">Power BI cannot calculate ${bad.length} measure${bad.length === 1 ? '' : 's'}</h3><table class="uses">${bad.map(v => `<tr><td><span class="link" data-id="${esc('M|' + v.table + '|' + v.name)}">[${esc(v.name)}]</span></td><td class="muted">${esc(v.error)}</td></tr>`).join('')}</table>` : ''; };
    dlg.onclick = e => {
      const x = e.target.closest('[data-id]');
      if (x && state.analysis.nodes.has(x.dataset.id)) { dlg.close(); return App.select(x.dataset.id); }
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      if (act === 'cancel') return dlg.close();
      busy(async () => {
        const r = await calc(), out = dlg.querySelector('#valOut');
        if (r.error) { out.innerHTML = `<p class="warn">${esc(r.error)}</p>`; return; }
        if (act === 'snap') {
          const s = { at: new Date().toISOString().slice(0, 16).replace('T', ' '), values: r.values };
          App.store.set(snapKey(), s);
          dlg.querySelector('#valSnap').textContent = 'Snapshot from ' + s.at + ' with ' + s.values.length + ' measures.';
          dlg.querySelector('[data-act=cmp]').disabled = false;
          out.innerHTML = `<p>Snapshot taken: ${r.values.filter(v => !v.error).length} measures calculated.</p>` + errorsHtml(r.values);
          return;
        }
        const old = new Map(App.store.get(snapKey(), { values: [] }).values.map(v => [v.table + '|' + v.name, v]));
        const same = (p, q) => (typeof p === 'number' && typeof q === 'number' ? Math.abs(p - q) <= 1e-9 * Math.max(1, Math.abs(p), Math.abs(q)) : p === q);
        const changed = [], fresh = [], broke = [];
        for (const v of r.values) {
          const o = old.get(v.table + '|' + v.name);
          if (!o) fresh.push(v);
          else if (v.error && !o.error) broke.push(v);
          else if (!v.error && !o.error && !same(o.value, v.value)) changed.push({ v, o });
        }
        const gone = [...old.values()].filter(o => !r.values.some(v => v.table === o.table && v.name === o.name));
        const link = v => `<span class="link" data-id="${esc('M|' + v.table + '|' + v.name)}">[${esc(v.name)}]</span>`;
        out.innerHTML = `<p><b>${changed.length}</b> changed · <b>${broke.length}</b> broke · <b>${fresh.length}</b> new · <b>${gone.length}</b> gone · ${r.values.length - changed.length - broke.length - fresh.length} the same</p>` +
          (changed.length ? `<h3>Result changed</h3><table class="uses"><tr><th>Measure</th><th class="num">Before</th><th class="num">After</th></tr>${changed.map(c => `<tr><td>${link(c.v)}</td><td class="num">${esc(fmtVal(c.o.value))}</td><td class="num">${esc(fmtVal(c.v.value))}</td></tr>`).join('')}</table>` : '') +
          (broke.length ? `<h3 class="s-unused">Could be calculated before, not anymore</h3><table class="uses">${broke.map(v => `<tr><td>${link(v)}</td><td class="muted">${esc(v.error)}</td></tr>`).join('')}</table>` : '') +
          (gone.length ? `<h3>No longer in the model</h3><p class="small">${gone.map(v => esc('[' + v.name + ']')).join(', ')}</p>` : '') +
          (!changed.length && !broke.length ? '<p class="s-direct">Every measure returns the same result as in the snapshot.</p>' : '');
      });
    };
    dlg.showModal();
  });

  // ------------------------------------------------------------ display folders in bulk

  const folderBtn = el('button', { type: 'button', id: 'btnFolder', title: 'Put every measure in the current list in one display folder' }, 'Folder…');
  $('btnUnused').after(folderBtn);
  App.onRun.push(() => { folderBtn.hidden = !App.canWrite(); });
  folderBtn.onclick = () => {
    const nodes = App.filtered().filter(n => n.kind === 'measure');
    const dlg = $('dlg');
    const folders = [...new Set(state.analysis.list.filter(n => n.kind === 'measure' && n.displayFolder).map(n => n.displayFolder))].sort();
    dlg.innerHTML = `<h2>Display folder</h2><p>${nodes.length ? `Puts the <b>${nodes.length}</b> measure${nodes.length === 1 ? '' : 's'} in the current list in one display folder. Narrow the list first with the search box and the filters.` : 'There are no measures in the current list. Set the filters so the list shows the measures you want to move.'}</p>
      <form id="fdForm" class="addrep"><input id="fdName" type="text" list="fdList" placeholder="Folder, for example Sales\\KPIs (empty = no folder)" spellcheck="false"><datalist id="fdList">${folders.map(f => `<option value="${esc(f)}">`).join('')}</datalist><button class="primary"${nodes.length ? '' : ' disabled'}>Move ${nodes.length}</button></form>
      <p class="small muted">Use a backslash for a subfolder. Each changed file is first copied to smo-backup. Close the project in Power BI Desktop first.</p>
      <div class="dlgbtn"><button type="button" data-act="cancel">Cancel</button></div>`;
    dlg.onclick = e => { if (e.target.dataset && e.target.dataset.act) dlg.close(); };
    dlg.querySelector('#fdForm').onsubmit = e => {
      e.preventDefault();
      const folder = dlg.querySelector('#fdName').value;
      dlg.close();
      busy(async () => {
        const r = await App.apiPost('api/folder', { path: state.loadedPath, modelRoot: model().root, ids: nodes.map(n => n.id), folder });
        $('msgs').innerHTML = '';
        if (r.error) return msg(r.error, true);
        msg(`${r.moved} measure${r.moved === 1 ? '' : 's'} moved to ${folder.trim() ? 'folder ' + folder.trim() : 'the top level'}. Copy of the old files: ${r.backup}`);
        await App.reloadFromDisk();
      });
    };
    dlg.showModal();
  };

  // ------------------------------------------------------------ report views from the activity log

  const actBox = el('div', {}, `<p class="small" style="margin:10px 0 6px"><b>How often reports are opened.</b> Reads the Power BI activity log of the last 30 days. Needs the Fabric administrator role and the Azure CLI signed in. A report nobody opens is a candidate to retire, together with the measures only it uses.</p>
    <button type="button" id="actBtn">Read report views</button> <span class="muted small">Tip: use <code>*</code> as workspace above to read the reports of every workspace you can open.</span>`);
  wsBox.after(actBox);
  $('actBtn').onclick = () => busy(async () => {
    $('xmlaInfo').textContent = 'Reading the activity log… one request per day, this takes a moment.';
    const r = await App.apiPost('api/activity', { days: 30 });
    if (r.error) { $('xmlaInfo').textContent = r.error; return; }
    state.reportViews = r;
    $('xmlaInfo').textContent = Object.keys(r.views).length + ' reports were opened in the last ' + r.days + ' days.';
    showViews();
  });
  function showViews() {
    const r = state.reportViews;
    if (!r || !state.project) return;
    for (const c of $('reports').querySelectorAll('.chip[data-root]')) {
      const name = c.firstChild.textContent.trim(), n = r.views[name] || 0;
      if (!c.querySelector('.views')) c.appendChild(el('span', { className: 'views muted' }, ''));
      c.querySelector('.views').textContent = ' · ' + n + (n === 1 ? ' view' : ' views');
      c.classList.toggle('stale', !n);
    }
  }
  App.onRun.push(showViews);

  // opened from Power BI Desktop
  { const q = new URLSearchParams(location.search), srv = q.get('server'); if (srv) setTimeout(() => openFromDesktop(srv, q.get('database') || ''), 400); }

  // ------------------------------------------------------------ Kimball: rule filter and the referential integrity check

  $('chkGroup').value = App.store.get('smo.checkGroup', '');
  state.checkGroup = $('chkGroup').value;
  $('chkGroup').onchange = e => { state.checkGroup = e.target.value; App.store.set('smo.checkGroup', state.checkGroup); App.run(); };
  App.onRun.push(() => { $('btnRI').hidden = $('pathForm').hidden || !!state.analysis.stats.noModel; });

  $('btnRI').onclick = () => busy(async () => {
    const dlg = $('dlg');
    const queries = SMO.dataQueries(model().model, state.analysis, state.project.design);
    const count = k => queries.filter(q => q.kind === k).length;
    let list = [];
    try { list = (await fetch('api/desktop').then(x => x.json())).instances || []; } catch (e) { /* none */ }
    const opts = (state.xmla && !/^(localhost|127\.0\.0\.1):/.test(state.xmla.server) ? [`<option value="server">${esc(state.xmla.database || state.xmla.server)} on ${esc(state.xmla.server)}</option>`] : [])
      .concat(list.map(i => `<option value="${i.port}"${i.name === model().name ? ' selected' : ''}>${esc(i.name)} in Power BI Desktop (port ${i.port})</option>`));
    dlg.innerHTML = `<h2>Check data</h2>
      <p class="small">Runs ${queries.length} queries on the model. Read-only; on a DirectQuery model they go to the source and can take a while.</p>
      <ul class="small"><li><b>Referential integrity</b> (${count('ri')} relationships): every key in a fact table exists in the dimension, no key is blank, the dimension key is unique, the rows -1 and -2 exist.</li>
      <li><b>Grain</b> (${count('grain')} fact tables): no two rows share all their dimension keys and degenerate dimensions.</li>
      <li><b>SCD type 2</b> (${count('scd2')} dimensions): one current row per natural key, no overlapping validity periods.</li>
      <li><b>Flags</b> (${count('flags')} dimensions): text columns that only hold codes like 0/1 or Y/N.</li></ul>
      ${opts.length ? `<label class="inline">Model <select id="riWhere">${opts.join('')}</select></label>` : '<p class="warn small">Open the model in Power BI Desktop, or load it with Server, to check the data.</p>'}
      <div id="riOut" class="cmpout"></div>
      <div class="dlgbtn"><button data-act="cancel">Close</button><button class="primary" data-act="go"${opts.length && queries.length ? '' : ' disabled'}>Run ${queries.length} checks</button></div>`;
    dlg.onclick = e => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'cancel') return dlg.close();
      if (act !== 'go') return;
      busy(async () => {
        const out = dlg.querySelector('#riOut'), where = dlg.querySelector('#riWhere').value;
        e.target.disabled = true;
        out.innerHTML = `<p class="muted">Running ${queries.length} checks…</p>`;
        let server, database;
        if (where === 'server') ({ server, database } = state.xmla);
        else {
          server = 'localhost:' + where;
          const cats = await App.apiPost('api/xmla', { server });
          if (cats.error) { out.innerHTML = `<p class="warn">${esc(cats.error)}</p>`; e.target.disabled = false; return; }
          database = (cats.catalogs || [])[0] || '';
        }
        const r = await App.apiPost('api/query', { server, database, queries: queries.map(q => ({ key: q.key, dax: q.dax })) });
        if (r.error) { out.innerHTML = `<p class="warn">${esc(r.error)}</p>`; e.target.disabled = false; return; }
        const byKey = new Map((r.results || []).map(x => [x.key, x]));
        state.ri = { model: model().name, at: new Date().toISOString().slice(0, 16).replace('T', ' '), results: queries.map(q => Object.assign({}, q, byKey.get(q.key) || { error: 'no answer' })) };
        dlg.close();
        App.setView('checks');
        $('chkGroup').value = state.checkGroup = 'kimball';
        App.run();
        const failed = state.ri.results.filter(x => x.error).length;
        const bad = state.checks.rules.filter(x => /^(ri|kd)-/.test(x.id) && x.id !== 'ri-failed').reduce((t, x) => t + x.items.length, 0);
        $('msgs').innerHTML = '';
        msg(`Data checked with ${queries.length} queries: ${bad ? bad + ' finding' + (bad === 1 ? '' : 's') : 'no problems found'}` + (failed ? `, ${failed} could not run` : '') + '.', !!bad);
      });
    };
    dlg.showModal();
  });

  const designBtn = el('button', { type: 'button', id: 'btnDesign', title: 'Load the design of the model (YAML specification and bus matrix) to compare the model with it' }, 'Design…');
  $('btnRI').before(designBtn);
  App.onRun.push(() => { designBtn.hidden = $('pathForm').hidden || !!state.analysis.stats.noModel; });
  designBtn.onclick = () => {
    const dlg = $('dlg'), d = SMO.matchDesign(model().model, state.project.design);
    const loaded = state.project.design.specs.map(s => esc((s.model || 'model') + ' — ' + s.path)).concat(state.project.design.busmatrices.map(b => esc('bus matrix — ' + b.path)));
    dlg.innerHTML = `<h2>Design</h2><p class="small">The design from the Kimball modelling skill: a YAML specification per model and the bus matrix in Markdown. The tool compares the model with it: tables, columns, data types, relationships and active roles, the grain sentence, and the bus matrix. Paste the path of a YAML file, a bus matrix or a folder such as <code>modellen</code>.</p>` +
      (loaded.length ? `<p class="small">Loaded: ${loaded.join('<br>')}</p><p class="small ${d.specs.length || d.busmatrices.length ? 's-direct' : 'warn'}">${d.specs.length || d.busmatrices.length ? 'Matches this model.' : 'None of it names a table of this model.'}</p>` : '') +
      `<form id="dsForm" class="addrep"><input id="dsPath" type="text" placeholder="C:\\…\\modellen" spellcheck="false" value="${esc(App.store.get('smo.designPath', ''))}"><button class="primary">Load</button></form><div id="dsOut"></div><div class="dlgbtn"><button type="button" data-act="cancel">Close</button></div>`;
    dlg.onclick = e => { if (e.target.dataset && e.target.dataset.act) dlg.close(); };
    dlg.querySelector('#dsForm').onsubmit = ev => {
      ev.preventDefault();
      const p = dlg.querySelector('#dsPath').value.trim();
      if (!p) return;
      App.store.set('smo.designPath', p);
      busy(async () => {
        const joined = state.loadedPath ? state.loadedPath + ';' + p : p;
        const l = await fetch('api/load?path=' + encodeURIComponent(joined)).then(x => x.json());
        if (l.error) { dlg.querySelector('#dsOut').innerHTML = `<p class="warn">${esc(l.error)}</p>`; return; }
        const before = state.project.design.specs.length + state.project.design.busmatrices.length;
        App.reloadKeep(l.files, [], { base: l.base, path: l.target });
        $('pathInput').value = l.target;
        const got = state.project.design.specs.length + state.project.design.busmatrices.length - before;
        dlg.close();
        App.setView('checks'); $('chkGroup').value = state.checkGroup = 'kimball'; App.run();
        const m = SMO.matchDesign(model().model, state.project.design);
        msg(got ? `${got} design file${got === 1 ? '' : 's'} loaded` + (m.specs.length || m.busmatrices.length ? '; the model is compared with it under Checks.' : ', but none names a table of this model.') : 'No YAML specification or bus matrix found there.', !got);
      });
    };
    dlg.showModal();
  };

  App.el = el; App.busy = busy; App.model = model;
  window.dispatchEvent(new Event('smo-extras'));
})();
