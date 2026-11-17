/* Semantic Model Optimizer — interface */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATUS = { direct: 'In rapport', indirect: 'Indirect gebruikt', model: 'Alleen model', unused: 'Niet gebruikt' };
  const STATUS_RANK = { unused: 0, model: 1, indirect: 2, direct: 3 };

  const state = {
    files: [], project: null, modelIdx: 0, off: new Set(), analysis: null,
    q: '', type: 'mc', status: '', table: '', sort: 'status', dir: 1, selected: null, expand: false,
    sel: new Set(), base: null, loadedPath: null, stats: null,
  };

  // ------------------------------------------------------------ laden

  function msg(text, err) {
    const d = document.createElement('div');
    d.className = 'msg' + (err ? ' err' : '');
    d.textContent = text;
    $('msgs').appendChild(d);
  }

  async function inflateRaw(data) {
    const ds = new DecompressionStream('deflate-raw');
    const buf = await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function readBrowserFiles(list) { // [{file, path}]
    const out = [], warnings = [];
    for (const { file, path } of list) {
      if (/\.(pbix|pbit|vpax)$/i.test(path)) {
        try {
          const reader = { size: file.size, read: async (o, l) => new Uint8Array(await file.slice(o, o + l).arrayBuffer()) };
          const want = SMO.zipWants;
          const z = await SMO.readZipTexts(reader, inflateRaw, want);
          for (const f of z.files) out.push({ path: path + '/' + f.path, text: f.text });
          if (/\.pbix$/i.test(path) && z.names.includes('DataModel') && !z.names.includes('DataModelSchema')) {
            warnings.push(file.name + ': het rapport is gelezen, maar het model in een .pbix is niet leesbaar. Sla het bestand op als Power BI-project (.pbip) of als sjabloon (.pbit) en laad dat erbij.');
          }
        } catch (e) { warnings.push(file.name + ': ' + e.message); }
      } else if (SMO.wantsFile(path)) {
        out.push({ path, text: SMO.decodeText(new Uint8Array(await file.arrayBuffer())) });
      }
    }
    return { files: out, warnings };
  }

  function entryFiles(entry, prefix, acc) {
    return new Promise(resolve => {
      if (entry.isFile) {
        entry.file(f => { acc.push({ file: f, path: prefix + entry.name }); resolve(); }, () => resolve());
      } else if (entry.isDirectory) {
        if (/^(\.git|node_modules|\.pbi|StaticResources|RegisteredResources|smo-backup)$/.test(entry.name)) return resolve();
        const rd = entry.createReader();
        const all = [];
        const more = () => rd.readEntries(async batch => {
          if (!batch.length) {
            for (const e of all) await entryFiles(e, prefix + entry.name + '/', acc);
            return resolve();
          }
          all.push(...batch); more();
        }, () => resolve());
        more();
      } else resolve();
    });
  }

  function setProject(files, warnings, src) {
    if (!(src && src.keep)) $('msgs').innerHTML = '';
    const project = SMO.loadProject(files);
    for (const w of warnings.concat(project.warnings)) msg(w, false);
    const onlyStats = project.stats && !project.reports.length && files.every(f => /\.vpax\//i.test(f.path));
    if (onlyStats && state.project) { setStats(project.stats); return; }
    if (!project.models.length) {
      msg(project.reports.length
        ? 'Wel een rapport gevonden, maar geen model. Laad het model erbij als Power BI-project (.pbip-map) of .pbit.'
        : 'Geen Power BI-model of -rapport gevonden in deze selectie.', true);
      if (!state.project) return;
      return;
    }
    state.files = files; state.project = project; state.modelIdx = 0; state.off = new Set();
    state.stats = project.stats || (src && src.keep ? state.stats : null);
    state.base = (src && src.base) || null; state.loadedPath = (src && src.path) || null;
    state.sel = new Set();
    if (src && src.keep) { state.project = project; $('empty').hidden = true; $('app').hidden = false; return run(); }
    state.selected = null; state.table = ''; state.q = ''; $('q').value = '';
    $('empty').hidden = true; $('app').hidden = false;
    run();
  }

  async function loadList(list) {
    document.body.style.cursor = 'progress';
    try { const r = await readBrowserFiles(list); setProject(r.files, r.warnings); }
    catch (e) { msg('Laden mislukt: ' + e.message, true); }
    finally { document.body.style.cursor = ''; }
  }

  $('btnDir').onclick = () => $('inDir').click();
  $('btnFile').onclick = () => $('inFile').click();
  $('inDir').onchange = e => { loadList(Array.from(e.target.files).map(f => ({ file: f, path: f.webkitRelativePath || f.name }))); e.target.value = ''; };
  $('inFile').onchange = e => { loadList(Array.from(e.target.files).map(f => ({ file: f, path: f.name }))); e.target.value = ''; };

  window.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  window.addEventListener('drop', async e => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    const entries = Array.from(e.dataTransfer.items || []).map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    const acc = [];
    for (const en of entries) await entryFiles(en, '', acc);
    if (acc.length) loadList(acc);
  });

  // via serve.js: pad plakken en groottes uit Power BI Desktop lezen
  if (location.protocol.startsWith('http')) {
    fetch('api/ping').then(r => r.ok && r.json()).then(j => { if (j && j.ok) { $('pathForm').hidden = false; $('btnDesktop').hidden = false; } }).catch(() => {});
  }

  function setStats(stats) {
    state.stats = stats;
    state.type = 'table'; state.status = ''; state.sort = 'size'; state.dir = -1;
    $('fType').value = 'table'; $('fStatus').value = '';
    run();
    if (!state.analysis.stats.hasStats) msg('De groottes horen bij een ander model: geen enkele tabelnaam komt overeen.', true);
  }

  async function loadDesktop(port) {
    document.body.style.cursor = 'progress';
    try {
      const r = await fetch('api/desktop' + (port ? '?port=' + port : '')).then(x => x.json());
      $('msgs').innerHTML = '';
      if (r.error) return msg(r.error, true);
      if (r.instances) {
        if (!r.instances.length) return msg('Geen geopend bestand in Power BI Desktop gevonden. Open het rapport in Power BI Desktop en probeer opnieuw.', true);
        if (r.instances.length === 1) return loadDesktop(r.instances[0].port);
        const d = document.createElement('div');
        d.className = 'msg';
        d.innerHTML = 'Er zijn meerdere bestanden open in Power BI Desktop. Kies er een: ' +
          r.instances.map(i => `<span class="chip on" data-port="${i.port}">${esc(i.name)} <span class="muted">poort ${i.port}</span></span>`).join(' ');
        d.onclick = e => { const c = e.target.closest('[data-port]'); if (c) loadDesktop(c.dataset.port); };
        $('msgs').appendChild(d);
        return;
      }
      if (!r.tables || !r.tables.length) return msg('Dit bestand in Power BI Desktop bevat geen tabellen met gegevens.', true);
      setStats(r);
    } catch (e) { msg('Uitlezen mislukt: ' + e.message, true); }
    finally { document.body.style.cursor = ''; }
  }
  $('btnDesktop').onclick = () => {
    if (!state.project) return msg('Laad eerst het model (Map openen), daarna de groottes.', true);
    loadDesktop();
  };
  $('pathForm').onsubmit = async e => {
    e.preventDefault();
    const p = $('pathInput').value.trim();
    if (!p) return;
    document.body.style.cursor = 'progress';
    try {
      const r = await fetch('api/load?path=' + encodeURIComponent(p)).then(x => x.json());
      if (r.error) { $('msgs').innerHTML = ''; msg(r.error, true); }
      else setProject(r.files, r.warnings || [], { base: r.base, path: p });
    } catch (err) { msg('Laden mislukt: ' + err.message, true); }
    finally { document.body.style.cursor = ''; }
  };

  // ------------------------------------------------------------ selecteren en verwijderen

  /** Alleen ongebruikte measures en kolommen uit het model zelf zijn te verwijderen. */
  const canSel = n => (n.type === 'measure' || n.type === 'column') && n.status === 'unused' && n.kind !== 'rapportmeasure' &&
    !(n.type === 'column' && n.tableKind && n.tableKind !== 'tabel');
  const canWrite = () => !!(state.base && state.project && state.project.models[state.modelIdx].format === 'tmdl');

  function renderSelBar() {
    const a = state.analysis, bar = $('selbar');
    const nodes = [...state.sel].map(id => a.nodes.get(id)).filter(Boolean);
    bar.hidden = !nodes.length;
    if (!nodes.length) return;
    const m = nodes.filter(n => n.type === 'measure').length, c = nodes.length - m;
    const size = nodes.reduce((s, n) => s + (n.size || 0), 0);
    bar.innerHTML = `<b>${nodes.length} geselecteerd</b> <span class="muted">${m} measures, ${c} kolommen${size ? ' · ' + mb(size) + ' MB' : ''}</span>
      <span class="grow"></span><button class="danger" data-act="del">Verwijderen…</button><button data-act="script" title="Script om dezelfde objecten in Tabular Editor te verwijderen">Tabular Editor-script</button><button data-act="clear">Selectie wissen</button>`;
  }

  /** Splitst de selectie in wat weg kan en wat nog gebruikt wordt door iets buiten de selectie. */
  function plan() {
    const a = state.analysis;
    const ok = new Set([...state.sel].filter(id => a.nodes.has(id) && canSel(a.nodes.get(id))));
    const blocked = [];
    for (let changed = true; changed;) {
      changed = false;
      for (const id of [...ok]) {
        const n = a.nodes.get(id);
        const by = [...n.usedBy].filter(u => !ok.has(u));
        if (by.length) { ok.delete(id); blocked.push({ n, by: by.map(u => a.nodes.get(u)) }); changed = true; }
      }
    }
    return { ok: [...ok].map(id => a.nodes.get(id)), blocked };
  }

  function teScript(nodes) {
    const s = v => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    const order = nodes.slice().sort((x, y) => (x.type === 'measure' ? 0 : 1) - (y.type === 'measure' ? 0 : 1));
    return '// Semantic Model Optimizer: verwijdert ' + nodes.length + ' ongebruikte objecten.\n// Uitvoeren in Tabular Editor (C# Script). Maak eerst een kopie van het model.\n' +
      order.map(n => `Model.Tables[${s(n.table)}].${n.type === 'measure' ? 'Measures' : 'Columns'}[${s(n.name)}].Delete();`).join('\n') + '\n';
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function openDeleteDialog() {
    const p = plan(), dlg = $('dlg');
    const m = p.ok.filter(n => n.type === 'measure').length, c = p.ok.length - m;
    const size = p.ok.reduce((s, n) => s + (n.size || 0), 0);
    const model = state.project.models[state.modelIdx];
    let h = `<h2>${p.ok.length} objecten verwijderen</h2><p>${m} measures en ${c} kolommen${size ? ' (' + mb(size) + ' MB)' : ''} uit model <b>${esc(model.name)}</b>.</p>`;
    if (p.blocked.length) {
      h += `<p class="warn">${p.blocked.length} geselecteerde objecten blijven staan, omdat iets buiten je selectie ze nog aanroept:</p><ul class="small">` +
        p.blocked.slice(0, 8).map(b => `<li>${esc(label(b.n))} ← ${esc(b.by.slice(0, 3).map(label).join(', '))}${b.by.length > 3 ? ' …' : ''}</li>`).join('') +
        (p.blocked.length > 8 ? `<li>… en ${p.blocked.length - 8} meer</li>` : '') + '</ul>';
    }
    if (canWrite()) {
      h += `<ul class="small"><li>De TMDL-bestanden in <code>${esc(model.root)}</code> worden aangepast.</li>
        <li>Van elk gewijzigd bestand komt eerst een kopie in de map <code>smo-backup</code> naast het model.</li>
        ${c ? '<li>Voor verwijderde kolommen komt er een stap <code>Table.RemoveColumns</code> in de Power Query van de tabel, zodat ze ook niet meer geladen worden.</li>' : ''}
        <li><b>Sluit dit project eerst in Power BI Desktop.</b> Staat het nog open en sla je daar op, dan komt alles terug.</li></ul>`;
    } else {
      h += `<p class="warn">Rechtstreeks verwijderen kan alleen bij een Power BI-project (TMDL) dat je via het padveld hebt geladen, met <code>node serve.js</code>. Je kunt wel een script voor Tabular Editor downloaden.</p>`;
    }
    h += `<div class="dlgbtn"><button data-act="cancel">Annuleren</button><button data-act="script">Tabular Editor-script</button>${canWrite() && p.ok.length ? `<button class="danger" data-act="go">${p.ok.length} verwijderen</button>` : ''}</div>`;
    dlg.innerHTML = h;
    dlg.onclick = async e => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      if (act === 'script') return download(model.name + '-verwijderen.csx', teScript(p.ok));
      dlg.close();
      if (act === 'go') doDelete(p.ok);
    };
    dlg.showModal();
  }

  async function doDelete(nodes) {
    const model = state.project.models[state.modelIdx];
    document.body.style.cursor = 'progress';
    try {
      const r = await fetch('api/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: state.base, modelRoot: model.root, items: nodes.map(n => ({ type: n.type, table: n.table, name: n.name })) }),
      }).then(x => x.json());
      $('msgs').innerHTML = '';
      if (r.error) return msg(r.error, true);
      msg(`${r.removed.length} objecten verwijderd uit ${r.files} bestanden. Kopie van de oude bestanden: ${r.backup}`);
      if (r.notFound.length) msg(r.notFound.length + ' objecten niet gevonden in de bestanden: ' + r.notFound.slice(0, 5).map(x => x.table + '[' + x.name + ']').join(', '), true);
      for (const w of r.warnings) msg(w);
      const keepIdx = state.modelIdx, off = state.off, base = state.base, path = state.loadedPath;
      const l = await fetch('api/load?path=' + encodeURIComponent(path)).then(x => x.json());
      if (l.error) return msg(l.error, true);
      setProject(l.files, [], { base: l.base || base, path, keep: true });
      state.modelIdx = Math.min(keepIdx, state.project.models.length - 1); state.off = off;
      run();
    } catch (e) { msg('Verwijderen mislukt: ' + e.message, true); }
    finally { document.body.style.cursor = ''; }
  }

  $('selbar').onclick = e => {
    const act = e.target.dataset && e.target.dataset.act;
    if (act === 'clear') { state.sel = new Set(); renderGrid(); }
    else if (act === 'script') download(state.project.models[state.modelIdx].name + '-verwijderen.csx', teScript(plan().ok));
    else if (act === 'del') openDeleteDialog();
  };
  $('btnUnused').onclick = () => {
    for (const n of state.analysis.list) if (!n.system && canSel(n)) state.sel.add(n.id);
    state.type = 'mc'; state.status = 'unused'; $('fType').value = 'mc'; $('fStatus').value = 'unused';
    renderGrid();
  };

  // ------------------------------------------------------------ analyse + weergave

  function run() {
    const p = state.project;
    const reports = p.reports.filter(r => !state.off.has(r.root));
    state.analysis = SMO.applyStats(SMO.analyze(p.models[state.modelIdx].model, reports), state.stats);
    if (state.selected && !state.analysis.nodes.has(state.selected)) state.selected = null;
    for (const id of [...state.sel]) { const n = state.analysis.nodes.get(id); if (!n || !canSel(n)) state.sel.delete(id); }
    renderBar(); renderTiles(); renderTableFilter(); renderGrid(); renderDetail();
  }

  function renderBar() {
    const p = state.project;
    $('modelPick').hidden = p.models.length < 2;
    $('selModel').innerHTML = p.models.map((m, i) => `<option value="${i}"${i === state.modelIdx ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
    $('reports').innerHTML = (p.reports.length ? '<span class="muted">Rapporten:</span>' : '<span class="muted">Geen rapport geladen — alles telt nu als niet gebruikt in een rapport.</span>') +
      p.reports.map(r => `<span class="chip ${state.off.has(r.root) ? 'off' : 'on'}" data-root="${esc(r.root)}" title="${esc(r.root)} · ${r.pages.length} pagina's, ${r.visualCount} visuals. Klik om mee te tellen of niet.">${esc(r.name)}</span>`).join('');
  }
  $('selModel').onchange = e => { state.modelIdx = +e.target.value; state.selected = null; state.table = ''; run(); };
  $('reports').onclick = e => {
    const c = e.target.closest('.chip');
    if (!c) return;
    const root = c.dataset.root;
    if (state.off.has(root)) state.off.delete(root); else state.off.add(root);
    run();
  };

  function renderTiles() {
    const s = state.analysis.stats;
    const tile = (lbl, big, sub, type, status, ok) =>
      `<button class="tile" data-type="${type}" data-status="${status}"><div class="lbl">${lbl}</div><div class="big">${big}</div><div class="sub${ok ? ' ok' : ''}">${sub}</div></button>`;
    $('tiles').innerHTML =
      tile('Measures', s.measures, s.measuresUnused + ' niet gebruikt', 'measure', 'unused', !s.measuresUnused) +
      tile('Kolommen', s.columns, s.columnsUnused + ' niet gebruikt', 'column', 'unused', !s.columnsUnused) +
      tile('Alleen voor het model', s.columnsModelOnly, 'kolommen in relatie, RLS of hiërarchie', 'column', 'model', true) +
      tile('Berekende kolommen', s.calcColumns, s.calcColumnsUnused + ' niet gebruikt', 'calc', 'unused', !s.calcColumnsUnused) +
      tile('Tabellen', s.tables, s.tablesUnused + ' niet gebruikt', 'table', 'unused', !s.tablesUnused) +
      (s.hasStats ? tile('Modelgrootte', mb(s.totalSize) + ' MB', mb(s.unusedSize) + ' MB in ongebruikte kolommen', 'column', 'unused', !s.unusedSize) : '') +
      tile('Rapport', s.visuals + ' visuals', s.pages + " pagina's" + (s.broken ? ' · ' + s.broken + ' kapotte verwijzingen' : ''), 'mc', s.broken ? 'broken' : '', !s.broken);
  }
  $('tiles').onclick = e => {
    const t = e.target.closest('.tile');
    if (!t) return;
    state.type = t.dataset.type; state.status = t.dataset.status; state.table = '';
    if (t.textContent.includes('Modelgrootte')) { state.sort = 'size'; state.dir = -1; }
    $('fType').value = state.type; $('fStatus').value = state.status; $('fTable').value = '';
    renderGrid();
  };

  function renderTableFilter() {
    const names = state.analysis.list.filter(n => n.type === 'table' && !n.system).map(n => n.name).sort((a, b) => a.localeCompare(b));
    $('fTable').innerHTML = '<option value="">Alle tabellen</option>' + names.map(n => `<option${n === state.table ? ' selected' : ''}>${esc(n)}</option>`).join('');
  }

  function kindClass(n) {
    if (n.type === 'measure') return 'measure';
    if (n.type === 'table') return n.kind === 'tabel' ? 'table' : 'calc';
    if (n.kind === 'berekende kolom') return 'calc';
    return n.type === 'function' ? 'calc' : 'column';
  }

  function filtered() {
    const q = state.q.toLowerCase();
    return state.analysis.list.filter(n => {
      if (n.system) return false;
      const t = state.type;
      if (t === 'mc' && n.type !== 'measure' && n.type !== 'column') return false;
      if (t === 'measure' && n.type !== 'measure') return false;
      if (t === 'column' && n.type !== 'column') return false;
      if (t === 'table' && n.type !== 'table') return false;
      if (t === 'calc' && !(n.kind === 'berekende kolom' || n.kind === 'berekende tabel' || n.kind === 'calculation group')) return false;
      if (state.status && n.status !== state.status) return false;
      if (state.table && n.table !== state.table) return false;
      if (q && !(n.name.toLowerCase().includes(q) || n.table.toLowerCase().includes(q) || (n.expression || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }

  const COLS = [
    { key: 'name', label: 'Naam' }, { key: 'table', label: 'Tabel' }, { key: 'kind', label: 'Soort' },
    { key: 'status', label: 'Status' },
    { key: 'uses', label: 'Visuals', num: true, title: 'Aantal plekken in rapporten waar dit direct gebruikt wordt' },
    { key: 'depCount', label: 'Hangt af van', num: true }, { key: 'usedByCount', label: 'Gebruikt door', num: true },
  ];
  const STAT_COLS = [
    { key: 'rows', label: 'Regels', num: true, title: 'Tabel: aantal regels. Kolom: aantal unieke waarden.' },
    { key: 'size', label: 'MB', num: true, title: 'Geheugengebruik in het model' },
    { key: 'share', label: '% model', num: true, title: 'Aandeel in de totale modelgrootte' },
  ];
  const nf = new Intl.NumberFormat('nl-NL');
  const int = v => (v == null ? '' : nf.format(v));
  const mb = v => (v == null ? '' : (v / 1048576).toLocaleString('nl-NL', { minimumFractionDigits: v < 104857600 ? 2 : 1, maximumFractionDigits: v < 104857600 ? 2 : 1 }));
  const pct = v => (v == null ? '' : (v * 100).toLocaleString('nl-NL', { maximumFractionDigits: 1 }) + '%');
  const rowsOf = n => (n.type === 'table' ? n.rows : n.type === 'column' ? n.cardinality : null);
  const sortVal = (n, k) => k === 'status' ? STATUS_RANK[n.status] : k === 'uses' ? n.reportUses.length
    : k === 'rows' ? (rowsOf(n) == null ? -1 : rowsOf(n)) : (k === 'size' || k === 'share') ? (n[k] == null ? -1 : n[k]) : n[k];

  function renderGrid() {
    const thead = $('grid').querySelector('thead'), tbody = $('grid').querySelector('tbody');
    renderSelBar();
    if (state.status === 'broken') {
      const b = state.analysis.broken;
      thead.innerHTML = '<tr><th>Veld</th><th>Tabel</th><th>Rapport</th><th>Pagina</th><th>Visual</th><th>Rol</th></tr>';
      tbody.innerHTML = b.map(u => `<tr><td class="nm">${esc(u.name)}</td><td>${esc(u.table)}</td><td>${esc(u.report)}</td><td>${esc(u.page)}</td><td>${esc(u.visualTitle || u.visualType || u.visual)}</td><td>${esc(u.role)}</td></tr>`).join('');
      $('count').textContent = b.length + ' verwijzingen in rapporten naar velden die niet in het model bestaan';
      return;
    }
    const rows = filtered();
    const k = state.sort, d = state.dir;
    rows.sort((a, b) => {
      const x = sortVal(a, k), y = sortVal(b, k);
      const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
      return c * d || a.table.localeCompare(b.table) || a.name.localeCompare(b.name);
    });
    const has = state.analysis.stats.hasStats;
    const cols = has ? COLS.slice(0, 4).concat(STAT_COLS, COLS.slice(4)) : COLS;
    const selectable = rows.filter(canSel);
    const allOn = selectable.length > 0 && selectable.every(n => state.sel.has(n.id));
    thead.innerHTML = `<tr><th class="chk"><input type="checkbox" id="chkAll" title="Alle ongebruikte in deze lijst selecteren"${allOn ? ' checked' : ''}${selectable.length ? '' : ' disabled'}></th>` + cols.map(c => `<th data-k="${c.key}" class="${c.num ? 'num' : ''}" title="${esc(c.title || '')}">${c.label}${state.sort === c.key ? (d > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr>';
    const MAX = 3000;
    tbody.innerHTML = rows.slice(0, MAX).map(n => `<tr data-id="${esc(n.id)}" class="${n.id === state.selected ? 'sel' : ''}">
      <td class="chk">${canSel(n) ? `<input type="checkbox" data-sel="${esc(n.id)}"${state.sel.has(n.id) ? ' checked' : ''}>` : ''}</td>
      <td class="nm">${esc(n.name)}${n.hidden ? ' <span class="hid">verborgen</span>' : ''}</td>
      <td>${n.type === 'table' ? '' : esc(n.table)}</td>
      <td class="k k-${kindClass(n)}">${esc(n.kind)}</td>
      <td><span class="badge s-${n.status}">${STATUS[n.status]}</span></td>
      ${has ? `<td class="num">${int(rowsOf(n))}${n.type === 'column' && n.cardinality != null ? ' <span class="hid">uniek</span>' : ''}</td><td class="num">${n.type === 'table' && n.mode === 'directQuery' && !n.size ? '<span class="hid">DirectQuery</span>' : mb(n.size)}</td><td class="num">${n.share ? `<span class="bar" style="--w:${Math.max(2, Math.round(n.share * 100))}%"></span>` + pct(n.share) : ''}</td>` : ''}
      <td class="num">${n.reportUses.length || ''}</td><td class="num">${n.depCount || ''}</td><td class="num">${n.usedByCount || ''}</td></tr>`).join('');
    const sum = rows.reduce((a, n) => a + (n.size || 0), 0);
    $('count').textContent = rows.length + ' objecten' + (has && sum ? ' · samen ' + mb(sum) + ' MB' + (state.type === 'table' ? ' · ' + int(rows.reduce((a, n) => a + (n.rows || 0), 0)) + ' regels' : '') + ' · bron: ' + state.analysis.stats.statsSource : '') + (rows.length > MAX ? ' (eerste ' + MAX + ' getoond — verfijn het filter)' : '');
  }
  let lastChk = null;
  $('grid').onclick = e => {
    if (e.target.id === 'chkAll') {
      for (const n of filtered()) if (canSel(n)) { if (e.target.checked) state.sel.add(n.id); else state.sel.delete(n.id); }
      return renderGrid();
    }
    if (e.target.dataset && e.target.dataset.sel) {
      const boxes = [...$('grid').querySelectorAll('input[data-sel]')];
      const i = boxes.indexOf(e.target), j = e.shiftKey && lastChk != null ? boxes.findIndex(b => b.dataset.sel === lastChk) : -1;
      const range = j >= 0 ? boxes.slice(Math.min(i, j), Math.max(i, j) + 1) : [e.target];
      for (const b of range) { b.checked = e.target.checked; if (b.checked) state.sel.add(b.dataset.sel); else state.sel.delete(b.dataset.sel); }
      lastChk = e.target.dataset.sel;
      const all = $('chkAll');
      if (all) all.checked = boxes.every(b => b.checked);
      return renderSelBar();
    }
    if (e.target.closest('td.chk')) return;
    const th = e.target.closest('th');
    if (th && th.dataset.k) {
      if (state.sort === th.dataset.k) state.dir = -state.dir; else { state.sort = th.dataset.k; state.dir = 1; }
      return renderGrid();
    }
    const tr = e.target.closest('tr[data-id]');
    if (tr) select(tr.dataset.id);
  };
  $('q').oninput = e => { state.q = e.target.value; renderGrid(); };
  $('fType').onchange = e => { state.type = e.target.value; renderGrid(); };
  $('fStatus').onchange = e => { state.status = e.target.value; renderGrid(); };
  $('fTable').onchange = e => { state.table = e.target.value; renderGrid(); };

  $('btnCsv').onclick = () => {
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const head = ['Soort', 'Tabel', 'Naam', 'Status', 'Verborgen', 'Regels', 'Unieke waarden', 'Bytes', 'Visuals', 'Hangt af van', 'Gebruikt door', 'Gebruik in model', 'Expressie'];
    const lines = filtered().map(n => [n.kind, n.table, n.name, STATUS[n.status], n.hidden ? 'ja' : '', n.rows, n.cardinality, n.size, n.reportUses.length, n.depCount, n.usedByCount,
      [...new Set(n.modelUses.map(u => u.kind))].join(' + '), n.expression].map(q).join(';'));
    const blob = new Blob(['﻿' + [head.map(q).join(';')].concat(lines).join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.project.models[state.modelIdx].name + '-gebruik.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  // ------------------------------------------------------------ detail + lineage

  function select(id) {
    state.selected = id; state.expand = false; state.editing = null;
    for (const tr of $('grid').querySelectorAll('tr.sel')) tr.classList.remove('sel');
    const tr = $('grid').querySelector(`tr[data-id="${CSS.escape(id)}"]`);
    if (tr) tr.classList.add('sel');
    renderDetail();
    $('detail').scrollTop = 0;
  }

  const label = n => n.type === 'measure' ? '[' + n.name + ']' : n.type === 'table' ? "'" + n.name + "'" : n.type === 'function' ? n.name + '()' : n.table + '[' + n.name + ']';

  /** Kortste weg van dit object naar iets dat direct in een rapport staat. */
  function pathToReport(a, n) {
    const prev = new Map([[n.id, null]]);
    const todo = [n.id];
    while (todo.length) {
      const id = todo.shift();
      const x = a.nodes.get(id);
      if (x.reportUses.length && id !== n.id) {
        const path = [];
        for (let c = id; c; c = prev.get(c)) path.unshift(a.nodes.get(c));
        return path;
      }
      for (const u of x.usedBy) if (!prev.has(u)) { prev.set(u, id); todo.push(u); }
    }
    return null;
  }

  function why(a, n) {
    if (n.status === 'direct') {
      const pages = new Set(n.reportUses.map(u => u.report + '|' + u.page));
      return `Staat direct in een rapport: ${n.reportUses.length} keer, op ${pages.size} pagina${pages.size === 1 ? '' : "'s"}.`;
    }
    if (n.status === 'indirect') {
      if (n.type === 'table') return 'Uit deze tabel wordt iets gebruikt in een rapport.';
      const p = pathToReport(a, n);
      return 'Staat niet zelf in een rapport, maar is nodig voor iets dat er wel in staat' + (p ? ': ' + p.map(label).join(' → ') + ' → rapport.' : '.');
    }
    if (n.status === 'model') {
      const kinds = [...new Set(n.modelUses.map(u => u.kind))];
      return 'Komt in geen enkel rapport voor, maar het model heeft het nodig' + (kinds.length ? ' (' + kinds.join(', ') + ').' : ' via een ander modelonderdeel.') + ' Verwijderen kan relaties of beveiliging breken.';
    }
    if (n.usedBy.size) return `Wordt in geen enkel geladen rapport gebruikt. Wordt wel aangeroepen door ${n.usedBy.size} ander${n.usedBy.size === 1 ? '' : 'e'} object${n.usedBy.size === 1 ? '' : 'en'}, maar die zijn zelf ook ongebruikt.`;
    return 'Wordt in geen enkel geladen rapport en nergens in het model gebruikt.';
  }

  function renderDetail() {
    const a = state.analysis, el = $('detail');
    const n = state.selected && a.nodes.get(state.selected);
    if (!n) {
      el.innerHTML = '<p class="muted">Klik op een measure of kolom om te zien waar die gebruikt wordt en waar die van afhangt.</p>';
      return;
    }
    const links = ids => ids.length ? '<div class="links">' + ids.map(id => a.nodes.get(id)).sort((x, y) => label(x).localeCompare(label(y)))
      .map(x => `<span class="link" data-id="${esc(x.id)}" title="${esc(x.kind)} · ${STATUS[x.status]}"><span class="k-${kindClass(x)}">●</span> ${esc(label(x))}</span>`).join('') + '</div>' : '<span class="muted">—</span>';
    if (state.editing === n.id) { el.innerHTML = editForm(a, n); wireEdit(a, n); return; }
    const editable = n.kind !== 'rapportmeasure' && ['measure', 'column', 'table'].includes(n.type) && !n.system;
    let h = (editable ? (canWrite()
      ? '<button class="editbtn" data-edit="1">Wijzigen</button>'
      : '<button class="editbtn" disabled title="Wijzigen kan bij een Power BI-project (TMDL) dat je via het padveld hebt geladen, met node serve.js">Wijzigen</button>') : '') +
      `<h2>${esc(n.name)}</h2>
      <div class="meta"><span class="k k-${kindClass(n)}">${esc(n.kind)}</span>${n.type === 'table' ? '' : '<span class="muted">in ' + esc(n.table) + '</span>'}
        <span class="badge s-${n.status}">${STATUS[n.status]}</span>${n.hidden ? '<span class="hid">verborgen</span>' : ''}
        ${n.dataType ? '<span class="muted">' + esc(n.dataType) + '</span>' : ''}${n.report ? '<span class="muted">gemaakt in rapport ' + esc(n.report) + '</span>' : ''}</div>`;
    if (n.description) h += `<div class="muted">${esc(n.description)}</div>`;
    h += `<p class="why">${esc(why(a, n))}</p>`;
    if (a.stats.hasStats && (n.type === 'table' || n.type === 'column')) h += sizeBlock(a, n);
    h += '<h3>Lineage</h3>' + graph(a, n);
    if (n.expression) h += `<h3>${n.type === 'table' ? 'Tabelexpressie' : 'DAX'}</h3><pre class="dax">${esc(n.expression)}</pre>`;
    else if (n.type === 'column' && n.sourceColumn) h += `<h3>Bron</h3><div>Bronkolom <code>${esc(n.sourceColumn)}</code> van tabel ${esc(n.table)}</div>`;
    else if (n.type === 'table' && n.source) h += `<h3>Bronquery${n.mode ? ' (' + esc(n.mode) + ')' : ''}</h3><pre class="dax">${esc(n.source)}</pre>`;
    h += '<h3>Hangt direct af van</h3>' + links([...n.deps]);
    h += '<h3>Wordt direct gebruikt door</h3>' + links([...n.usedBy]);
    if (n.modelUses.length) {
      h += '<h3>Gebruik in het model</h3><table class="uses">' + n.modelUses.map(u => `<tr><td>${esc(u.kind)}</td><td>${esc(u.detail)}</td></tr>`).join('') + '</table>';
    }
    if (n.reportUses.length) {
      h += '<h3>Gebruik in rapporten</h3><table class="uses"><tr><th>Rapport</th><th>Pagina</th><th>Visual</th><th>Rol</th></tr>' +
        n.reportUses.map(u => `<tr><td>${esc(u.report)}</td><td>${esc(u.page || '—')}</td><td>${esc(u.visualTitle || u.visualType || u.visual || '—')}${u.visualTitle && u.visualType ? ' <span class="muted">' + esc(u.visualType) + '</span>' : ''}</td><td>${esc(u.role)}</td></tr>`).join('') + '</table>';
    }
    el.innerHTML = h;
  }
  // ------------------------------------------------------------ wijzigen

  /** Kan de naam veilig gewijzigd worden? Alleen als elk rapport dat het veld gebruikt als PBIR op schijf staat. */
  function renameBlock(n) {
    if (n.type === 'table') return 'Tabellen hernoemen kan nog niet.';
    const bad = new Set();
    for (const u of n.reportUses) {
      const r = state.project.reports.find(x => x.name === u.report);
      if (r && (r.format !== 'PBIR' || /\.(pbix|pbit)(\/|$)/i.test(r.root))) bad.add(r.name);
    }
    return bad.size ? 'Hernoemen kan niet: rapport ' + [...bad].join(', ') + ' gebruikt dit veld en staat in het oude formaat of in een .pbix. Dat kan de tool niet bijwerken.' : '';
  }

  function editForm(a, n) {
    const block = renameBlock(n);
    const hasExpr = n.type !== 'table' && !!n.expression;
    const rows = Math.min(24, Math.max(4, (n.expression || '').split('\n').length + 1));
    return `<form id="editForm" class="edit">
      <h2>${esc(n.kind)} wijzigen</h2>
      <label>Naam<input name="name" type="text" value="${esc(n.name)}" ${block ? 'disabled' : ''} spellcheck="false" autocomplete="off"></label>
      ${block ? `<div class="muted small">${esc(block)}</div>` : n.type === 'table' ? '' : `<div class="muted small" id="renameNote"></div>`}
      <label>Beschrijving<textarea name="description" rows="3">${esc(n.description || '')}</textarea></label>
      ${hasExpr ? `<label>Formule (DAX)<textarea name="expression" class="code" rows="${rows}" spellcheck="false">${esc(n.expression)}</textarea></label><div class="warn small" id="exprNote"></div>` : ''}
      <div class="muted small">De wijziging gaat naar de TMDL-bestanden; van elk gewijzigd bestand komt eerst een kopie in <code>smo-backup</code>. Sluit het project eerst in Power BI Desktop. De formule wordt niet door Power BI gecontroleerd: een fout zie je pas bij het openen.</div>
      <div class="dlgbtn"><button type="button" data-cancel="1">Annuleren</button><button class="primary">Opslaan</button></div>
    </form>`;
  }

  function wireEdit(a, n) {
    const f = $('editForm');
    const nameNote = $('renameNote'), exprNote = $('exprNote');
    const update = () => {
      if (nameNote) {
        const v = f.elements.name.value.trim();
        nameNote.textContent = v && v !== n.name
          ? `Bij opslaan worden verwijzingen bijgewerkt: ${n.usedBy.size} formule${n.usedBy.size === 1 ? '' : 's'} en ${n.reportUses.length} plek${n.reportUses.length === 1 ? '' : 'ken'} in rapporten. Gebruik buiten deze map (andere rapporten, Excel) breekt.`
          : '';
      }
      if (exprNote) {
        const unknown = [];
        for (const r of SMO.daxRefs(f.elements.expression.value)) {
          if ((r.t === 'q' || r.t === 'b') && !a.resolve(r, n.table)) unknown.push(r.t === 'q' ? r.table + '[' + r.name + ']' : '[' + r.name + ']');
        }
        const u = [...new Set(unknown)];
        exprNote.textContent = u.length ? 'Niet gevonden in het model: ' + u.slice(0, 6).join(', ') + (u.length > 6 ? ' …' : '') + '. Dat kan kloppen bij kolommen die je in de formule zelf maakt.' : '';
      }
    };
    f.oninput = update;
    update();
    f.onsubmit = async e => {
      e.preventDefault();
      const changes = { description: f.elements.description.value };
      if (f.elements.name && !f.elements.name.disabled) changes.name = f.elements.name.value;
      if (f.elements.expression) changes.expression = f.elements.expression.value;
      document.body.style.cursor = 'progress';
      try {
        const r = await fetch('api/edit', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: state.loadedPath, modelRoot: state.project.models[state.modelIdx].root, sel: { type: n.type, table: n.table, name: n.name }, changes }),
        }).then(x => x.json());
        $('msgs').innerHTML = '';
        if (r.error) return msg(r.error, true);
        state.editing = null;
        if (!r.changed) return renderDetail();
        msg(`Opgeslagen in ${r.files} bestand${r.files === 1 ? '' : 'en'}` + (r.renamed ? ` (${r.reportFields} velden in rapporten bijgewerkt)` : '') + `. Kopie van de oude bestanden: ${r.backup}`);
        const keepIdx = state.modelIdx, off = state.off, sel = state.sel, path = state.loadedPath;
        const l = await fetch('api/load?path=' + encodeURIComponent(path)).then(x => x.json());
        if (l.error) return msg(l.error, true);
        setProject(l.files, [], { base: l.base, path, keep: true });
        state.modelIdx = Math.min(keepIdx, state.project.models.length - 1); state.off = off; state.sel = sel; state.selected = r.id;
        run();
      } catch (err) { msg('Opslaan mislukt: ' + err.message, true); }
      finally { document.body.style.cursor = ''; }
    };
  }

  $('detail').onclick = e => {
    if (e.target.dataset && e.target.dataset.edit) { state.editing = state.selected; return renderDetail(); }
    if (e.target.dataset && e.target.dataset.cancel) { state.editing = null; return renderDetail(); }
    if (state.editing) return;
    const x = e.target.closest('[data-id]');
    if (x) return select(x.dataset.id);
    if (e.target.closest('[data-more]')) { state.expand = true; renderDetail(); }
  };

  function sizeBlock(a, n) {
    const fact = (l, v) => `<div class="fact"><div class="lbl">${l}</div><div class="val">${v || '—'}</div></div>`;
    if (n.type === 'column') {
      if (n.size == null) return '<h3>Grootte</h3><p class="muted">Geen groottegegevens voor deze kolom.</p>';
      const p = n.sizeParts || {};
      return '<h3>Grootte</h3><div class="facts">' + fact('Geheugen', mb(n.size) + ' MB') + fact('Aandeel model', pct(n.share)) +
        fact('Unieke waarden', int(n.cardinality)) + fact('Regels in tabel', int(n.rows)) +
        fact('Woordenboek', p.dictionary == null ? '' : mb(p.dictionary) + ' MB') + fact('Data', p.data == null ? '' : mb(p.data) + ' MB') +
        fact('Hiërarchie', p.hierarchy == null ? '' : mb(p.hierarchy) + ' MB') + (p.encoding ? fact('Codering', esc(p.encoding)) : '') + '</div>';
    }
    if (n.size == null && n.rows == null) return '<h3>Grootte</h3><p class="muted">Geen groottegegevens voor deze tabel.</p>';
    const cols = a.list.filter(c => c.type === 'column' && c.table === n.name && c.size).sort((x, y) => y.size - x.size);
    const unused = cols.filter(c => c.status === 'unused').reduce((s, c) => s + c.size, 0);
    const max = cols.length ? cols[0].size : 1;
    let h = '<h3>Grootte</h3><div class="facts">' + fact('Regels', int(n.rows)) + fact('Geheugen', n.mode === 'directQuery' && !n.size ? 'DirectQuery' : mb(n.size) + ' MB') +
      fact('Aandeel model', pct(n.share)) + fact('In ongebruikte kolommen', unused ? mb(unused) + ' MB' : '0 MB') + '</div>';
    if (cols.length) {
      h += '<table class="uses sizes"><tr><th>Grootste kolommen</th><th class="num">MB</th><th class="num">Uniek</th><th>Status</th></tr>' +
        cols.slice(0, 12).map(c => `<tr><td><span class="link" data-id="${esc(c.id)}">${esc(c.name)}</span><span class="bar wide" style="--w:${Math.max(1, Math.round(c.size / max * 100))}%"></span></td>
          <td class="num">${mb(c.size)}</td><td class="num">${int(c.cardinality)}</td><td><span class="badge s-${c.status}">${STATUS[c.status]}</span></td></tr>`).join('') + '</table>';
    }
    return h;
  }

  function graph(a, n) {
    const W = 190, H = 38, GX = 70, GY = 10, PAD = 14, TOP = 26, CAP = state.expand ? 1e9 : 12;
    const up = SMO.layers(a, n.id, 'deps'), down = SMO.layers(a, n.id, 'usedBy');
    const cols = [];
    const nodeItem = id => { const x = a.nodes.get(id); return { key: id, node: x, name: label(x), sub: x.kind + (x.type === 'measure' || x.type === 'table' ? '' : ''), cls: kindClass(x), status: x.status }; };
    const byName = (x, y) => x.cls.localeCompare(y.cls) || x.name.localeCompare(y.name);
    up.slice().reverse().forEach((l, i) => cols.push({ title: up.length - i === 1 ? 'Hangt af van' : 'Niveau −' + (up.length - i), items: l.map(nodeItem).sort(byName) }));
    cols.push({ title: 'Geselecteerd', items: [Object.assign(nodeItem(n.id), { center: true })] });
    down.forEach((l, i) => cols.push({ title: i === 0 ? 'Gebruikt door' : 'Niveau +' + (i + 1), items: l.map(nodeItem).sort(byName) }));
    // rapportpagina's waar dit object of iets wat ervan afhangt op staat
    const pages = new Map();
    for (const id of [n.id].concat(...down)) {
      for (const u of a.nodes.get(id).reportUses) {
        const key = 'P|' + u.report + '|' + u.page;
        if (!pages.has(key)) pages.set(key, { key, page: true, name: u.page || '(rapportniveau)', report: u.report, from: new Set(), visuals: new Set(), cls: 'page' });
        const p = pages.get(key);
        p.from.add(id); p.visuals.add(u.visual + '|' + u.role);
      }
    }
    if (pages.size) {
      const items = [...pages.values()].sort((x, y) => x.name.localeCompare(y.name));
      for (const p of items) p.sub = p.report + ' · ' + p.visuals.size + '×';
      cols.push({ title: 'Rapportpagina', items });
    }
    if (cols.length === 1) return '<p class="muted">Geen afhankelijkheden en geen afnemers.</p>';

    let more = false;
    for (const c of cols) {
      if (c.items.length > CAP) { more = true; const rest = c.items.length - CAP; c.items = c.items.slice(0, CAP); c.items.push({ key: 'more', more: true, name: '+ ' + rest + ' meer…', sub: 'klik om alles te tonen', cls: 'table' }); }
    }
    const maxRows = Math.max(...cols.map(c => c.items.length));
    const height = TOP + PAD + maxRows * (H + GY);
    const width = PAD * 2 + cols.length * W + (cols.length - 1) * GX;
    const pos = new Map();
    cols.forEach((c, ci) => {
      const x = PAD + ci * (W + GX);
      const off = TOP + (maxRows - c.items.length) * (H + GY) / 2;
      c.x = x;
      c.items.forEach((it, i) => { it.x = x; it.y = off + i * (H + GY); if (!it.more) pos.set(it.key, it); });
    });
    const edge = (f, t, hot) => {
      const x1 = f.x + W, y1 = f.y + H / 2, x2 = t.x, y2 = t.y + H / 2, dx = Math.max(30, (x2 - x1) / 2);
      return `<path class="edge${hot ? ' hot' : ''}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}"/>`;
    };
    let edges = '';
    for (const it of pos.values()) {
      if (it.page) { for (const f of it.from) if (pos.has(f)) edges += edge(pos.get(f), it, f === n.id); continue; }
      for (const d of it.node.deps) if (pos.has(d)) edges += edge(pos.get(d), it, d === n.id || it.key === n.id);
    }
    const cut = (s, m) => s.length > m ? s.slice(0, m - 1) + '…' : s;
    let boxes = '';
    for (const c of cols) {
      boxes += `<text class="col" x="${c.x}" y="16">${esc(c.title)}</text>`;
      for (const it of c.items) {
        const attr = it.more ? 'data-more="1"' : it.page ? '' : `data-id="${esc(it.key)}"`;
        boxes += `<g class="node${it.center ? ' center' : ''}" ${attr} transform="translate(${it.x},${it.y})">
          <title>${esc(it.name + (it.sub ? ' — ' + it.sub : '') + (it.status ? ' — ' + STATUS[it.status] : ''))}</title>
          <rect class="box" width="${W}" height="${H}" rx="6"/>
          <rect width="4" height="${H - 8}" x="4" y="4" rx="2" fill="var(--${it.cls})"/>
          <text x="14" y="16">${esc(cut(it.name, 27))}</text><text class="sub" x="14" y="30">${esc(cut(it.sub || '', 32))}</text>
          ${it.status ? `<circle cx="${W - 10}" cy="10" r="4" fill="var(--${it.status})"/>` : ''}</g>`;
      }
    }
    return `<div class="graphwrap"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Lineage van ${esc(n.name)}">${edges}${boxes}</svg></div>
      <div class="legend"><span><i style="background:var(--measure)"></i>measure</span><span><i style="background:var(--column)"></i>kolom</span>
      <span><i style="background:var(--calc)"></i>berekend</span><span><i style="background:var(--table)"></i>tabel</span><span><i style="background:var(--page)"></i>rapportpagina</span>
      <span>stip = status</span><span>links = bron, rechts = afnemer${more ? '' : ''}. Klik op een blok om erheen te gaan.</span></div>`;
  }

  // testhaak: project laden vanuit de adresbalk (?path=...) als serve.js draait
  const qp = new URLSearchParams(location.search).get('path');
  if (qp && location.protocol.startsWith('http')) { $('pathInput').value = qp; setTimeout(() => $('pathForm').requestSubmit(), 50); }
})();
