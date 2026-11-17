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
      $('pfGrid').querySelector('thead').innerHTML = '<tr><th>Visual</th><th>Page</th><th class="num">Total ms</th><th class="num">DAX query</th><th class="num">of which source</th><th class="num">Render</th><th class="num">Rows</th></tr>';
      $('pfGrid').querySelector('tbody').innerHTML = list.map((v, i) => {
        const l = links.get(v.visualId);
        return `<tr data-i="${i}" class="${state.perfSel === i ? 'sel' : ''}"><td class="nm">${esc(v.title || v.type || v.visualId)}<div class="muted small" style="font-weight:400">${esc(v.type)}</div></td><td>${esc(l ? l.page : '')}</td>
          <td class="num"><span class="sbar" style="--w:${Math.max(2, Math.round(v.total / max * 100))}%"></span>${App.int(v.total)}</td><td class="num">${App.int(v.dax)}</td><td class="num">${App.int(v.directQuery)}</td><td class="num">${App.int(v.render)}</td><td class="num">${v.rows == null ? '' : App.int(v.rows)}</td></tr>`;
      }).join('');
      const v = list[state.perfSel];
      if (!v) { $('pfDetail').innerHTML = ''; return; }
      const l = links.get(v.visualId);
      const nodes = l ? [...l.nodes].map(id => state.analysis.nodes.get(id)).filter(Boolean) : [];
      $('pfDetail').innerHTML = `<h3>${esc(v.title || v.type)}</h3>` +
        (v.total ? `<p class="small">${Math.round(v.dax / v.total * 100)}% of the time is the DAX query${v.directQuery ? `, of which ${Math.round(v.directQuery / Math.max(1, v.dax) * 100)}% is waiting for the source (DirectQuery)` : ''}; ${Math.round(v.render / v.total * 100)}% is drawing.</p>` : '') +
        (nodes.length ? '<div class="links">' + nodes.map(n => `<span class="link" data-id="${esc(n.id)}"><span class="k-${n.type === 'measure' ? 'measure' : 'column'}">●</span> ${esc(App.label(n))}</span>`).join('') + '</div>'
          : '<p class="muted small">This visual is not in the loaded reports, so its fields are unknown.</p>') +
        (v.query ? `<h3>Query</h3><pre class="dax">${esc(v.query)}</pre>` : '');
    });
  $('pfGrid').onclick = e => { const tr = e.target.closest('tr[data-i]'); if (tr) { state.perfSel = +tr.dataset.i; App.views.perf(); } };
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
    const css = 'body{font:14px/1.5 "Segoe UI",system-ui,sans-serif;color:#1c2330;max-width:1000px;margin:32px auto;padding:0 20px}h1{font-size:26px;margin-bottom:4px}h2{font-size:19px;margin-top:36px;border-bottom:2px solid #dfe3ea;padding-bottom:4px}h3{font-size:15px;margin:22px 0 6px}table{border-collapse:collapse;width:100%;margin:6px 0 14px}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #dfe3ea;vertical-align:top}th{font-size:12px;color:#677084}pre{background:#f1f3f7;border-radius:6px;padding:8px 10px;white-space:pre-wrap;font:12.5px/1.45 Consolas,monospace;margin:2px 0}.m{color:#677084}.tag{font-size:12px;border:1px solid #c8cdd8;border-radius:4px;padding:0 5px;color:#677084}nav a{margin-right:10px;white-space:nowrap}@media print{h2{break-before:page}h2:first-of-type{break-before:auto}}';
    let h = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${e(m.name)} — model documentation</title><style>${css}</style></head><body>` +
      `<h1>${e(m.name)}</h1><p class="m">Model documentation · generated ${new Date().toISOString().slice(0, 10)} by Semantic Model Optimizer</p>` +
      `<p>${tables.length} tables · ${a.stats.modelMeasures} measures · ${a.stats.columns} columns · ${rels.length} relationships` +
      (state.project.reports.length ? ` · reports: ${e(state.project.reports.map(r => r.name).join(', '))}` : '') + '</p>' +
      `<nav>${tables.map(t => `<a href="#t-${encodeURIComponent(t.name)}">${e(t.name)}</a>`).join('')}</nav>`;
    h += '<h2>Relationships</h2><table><tr><th>From (many)</th><th>To (one)</th><th>Cardinality</th><th>Active</th><th>Filter</th></tr>' +
      rels.map(r => `<tr><td>${e(r.fromTable)}[${e(r.fromColumn)}]</td><td>${e(r.toTable)}[${e(r.toColumn)}]</td><td>${e(r.fromCardinality)} to ${e(r.toCardinality)}</td><td>${r.isActive ? 'yes' : 'no'}</td><td>${/both/i.test(r.crossFilter || '') ? 'both ways' : 'single'}</td></tr>`).join('') + '</table>';
    for (const t of tables) {
      const ms = of(t, 'measure'), cs = of(t, 'column');
      h += `<h2 id="t-${encodeURIComponent(t.name)}">${e(t.name)} <span class="tag">${e(t.kind)}</span>${t.hidden ? ' <span class="tag">hidden</span>' : ''}</h2>` +
        (t.description ? `<p>${e(t.description)}</p>` : '') +
        (t.rows != null ? `<p class="m">${App.int(t.rows)} rows${t.size ? ' · ' + App.mb(t.size) + ' MB' : ''}</p>` : '') +
        (t.expression ? `<pre>${e(t.expression)}</pre>` : '');
      if (ms.length) {
        h += '<h3>Measures</h3>';
        for (const n of ms) h += `<p><b>${e(n.name)}</b> <span class="tag">${e(S[n.status])}</span>${n.kind === 'report measure' ? ` <span class="tag">only in report ${e(n.report)}</span>` : ''}${n.broken ? ' <span class="tag">broken</span>' : ''}${n.formatString ? ` <span class="m">format ${e(n.formatString)}</span>` : ''}<br>${n.description ? e(n.description) : '<span class="m">No description.</span>'}</p><pre>${e(n.expression)}</pre>`;
      }
      if (cs.length) {
        h += '<h3>Columns</h3><table><tr><th>Column</th><th>Type</th><th>Description</th><th>Usage</th></tr>' +
          cs.map(n => `<tr><td>${e(n.name)}${n.hidden ? ' <span class="tag">hidden</span>' : ''}${n.kind === 'calculated column' ? ' <span class="tag">calculated</span>' : ''}</td><td>${e(n.dataType || '')}</td><td>${e(n.description || '')}${n.expression ? `<pre>${e(n.expression)}</pre>` : ''}</td><td>${e(S[n.status])}</td></tr>`).join('') + '</table>';
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

  App.el = el; App.busy = busy; App.model = model;
  window.dispatchEvent(new Event('smo-extras'));
})();
