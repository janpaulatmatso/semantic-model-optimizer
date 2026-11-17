/* Semantic Model Optimizer — user interface */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATUS = { direct: 'In report', indirect: 'Used indirectly', model: 'Model only', unused: 'Unused' };
  const STATUS_RANK = { unused: 0, model: 1, indirect: 2, direct: 3 };

  const state = {
    files: [], project: null, modelIdx: 0, off: new Set(), analysis: null,
    q: '', type: 'mc', status: '', table: '', sort: 'status', dir: 1, selected: null, expand: false,
    sel: new Set(), base: null, loadedPath: null, stats: null,
  };

  // ------------------------------------------------------------ loading

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
            warnings.push(file.name + ': the report was read, but the model inside a .pbix cannot be read. Save the file as a Power BI project (.pbip) or as a template (.pbit) and load that as well.');
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
    const noModel = project.models.every(m => m.missing);
    const adding = state.adding || (noModel && project.reports.length > 0);
    const completes = state.project && state.project.models.every(m => m.missing) && !noModel && !project.reports.length;
    if (state.project && (adding || completes) && !(src && src.keep)) { state.adding = false; return addFiles(files); }
    if (!project.models.length) {
      msg(project.reports.length
        ? 'Found a report, but no model. Also load the model as a Power BI project (.pbip folder) or .pbit.'
        : 'No Power BI model or report found in this selection.', true);
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

  /** Reloads a project and keeps the model choice, disabled reports and selection. */
  function reloadKeep(files, warnings, src) {
    const idx = state.modelIdx, off = state.off, sel = state.sel, selected = state.selected;
    setProject(files, warnings, Object.assign({ keep: true }, src));
    state.modelIdx = Math.min(idx, state.project.models.length - 1); state.off = off; state.sel = sel; state.selected = selected;
    run();
  }

  /** Adds files (reports) to the loaded project. */
  function addFiles(files) {
    const tops = new Set(state.files.map(f => f.path.replace(/\\/g, '/').split('/')[0].toLowerCase()));
    const renamed = new Map();
    const add = files.map(f => {
      const p = f.path.replace(/\\/g, '/'), top = p.split('/')[0];
      if (!renamed.has(top)) {
        let t = top;
        for (let k = 2; tops.has(t.toLowerCase()); k++) t = top + '~' + k;
        renamed.set(top, t); tops.add(t.toLowerCase());
      }
      return { path: renamed.get(top) + p.slice(top.length), text: f.text };
    });
    const before = state.project.reports.length, hadBase = !!state.base, hadModel = !state.project.models.every(m => m.missing);
    reloadKeep(state.files.concat(add), [], { base: null, path: null });
    if (!hadModel && !state.project.models.every(m => m.missing)) return msg('Model loaded: the reports are now checked against it.');
    const n = state.project.reports.length - before;
    if (n > 0) msg(n + ' report' + (n === 1 ? '' : 's') + ' added.' + (hadBase ? ' Editing and deleting are now turned off, because this report was not added through a path. Add it through the path field to keep them.' : ''));
    else msg('No report found in this selection.', true);
  }

  async function addPath(p) {
    document.body.style.cursor = 'progress';
    try {
      const joined = state.loadedPath ? state.loadedPath + ';' + p : p;
      const l = await fetch('api/load?path=' + encodeURIComponent(joined)).then(x => x.json());
      $('msgs').innerHTML = '';
      if (l.error) return msg(l.error, true);
      if (!state.loadedPath) return addFiles(l.files);
      const before = state.project.reports.length;
      if (SMO.loadProject(l.files).reports.length <= before) return msg('No new report found in ' + p, true);
      reloadKeep(l.files, l.warnings || [], { base: l.base, path: l.target });
      $('pathInput').value = l.target;
      const n = state.project.reports.length - before;
      msg(n + ' report' + (n === 1 ? '' : 's') + ' added.');
    } catch (e) { msg('Adding failed: ' + e.message, true); }
    finally { document.body.style.cursor = ''; }
  }

  async function loadList(list) {
    document.body.style.cursor = 'progress';
    try { const r = await readBrowserFiles(list); setProject(r.files, r.warnings); }
    catch (e) { msg('Loading failed: ' + e.message, true); }
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

  // via serve.js: paste a path and read sizes from Power BI Desktop
  if (location.protocol.startsWith('http')) {
    fetch('api/ping').then(r => r.ok && r.json()).then(j => { if (j && j.ok) {
      $('pathForm').hidden = false; $('btnDesktop').hidden = false; $('btnRepos').hidden = false;
      renderRepos();
      Promise.all(repos.paths.map(scanRepoPath)).then(renderRepos);
    } }).catch(() => {});
  }

  function setStats(stats) {
    state.stats = stats;
    state.type = 'table'; state.status = ''; state.sort = 'size'; state.dir = -1;
    $('fType').value = 'table'; $('fStatus').value = '';
    run();
    if (!state.analysis.stats.hasStats) msg('These sizes belong to a different model: not a single table name matches.', true);
  }

  async function loadDesktop(port) {
    document.body.style.cursor = 'progress';
    try {
      const r = await fetch('api/desktop' + (port ? '?port=' + port : '')).then(x => x.json());
      $('msgs').innerHTML = '';
      if (r.error) return msg(r.error, true);
      if (r.instances) {
        if (!r.instances.length) return msg('No open file found in Power BI Desktop. Open the report in Power BI Desktop and try again.', true);
        if (r.instances.length === 1) return loadDesktop(r.instances[0].port);
        const d = document.createElement('div');
        d.className = 'msg';
        d.innerHTML = 'Several files are open in Power BI Desktop. Pick one: ' +
          r.instances.map(i => `<span class="chip on" data-port="${i.port}">${esc(i.name)} <span class="muted">port ${i.port}</span></span>`).join(' ');
        d.onclick = e => { const c = e.target.closest('[data-port]'); if (c) loadDesktop(c.dataset.port); };
        $('msgs').appendChild(d);
        return;
      }
      if (!r.tables || !r.tables.length) return msg('This file in Power BI Desktop has no tables with data.', true);
      setStats(r);
    } catch (e) { msg('Reading failed: ' + e.message, true); }
    finally { document.body.style.cursor = ''; }
  }
  $('btnDesktop').onclick = () => {
    if (!state.project) return msg('Load the model first (Open folder), then the sizes.', true);
    loadDesktop();
  };
  $('pathForm').onsubmit = e => { e.preventDefault(); loadFromPath($('pathInput').value.trim()); };

  // ------------------------------------------------------------ repositories

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  const repos = { paths: store.get('smo.repos', []), scans: new Map(), pick: new Set(store.get('smo.pick', [])), liveModel: store.get('smo.liveModel', '') };

  async function scanRepoPath(p) {
    try {
      const r = await fetch('api/scan?path=' + encodeURIComponent(p)).then(x => x.json());
      repos.scans.set(p, r);
      return r;
    } catch (e) { const r = { error: e.message }; repos.scans.set(p, r); return r; }
  }

  const pickedItems = () => {
    const out = [];
    for (const p of repos.paths) for (const it of (repos.scans.get(p) || {}).items || []) if (repos.pick.has(it.report)) out.push(it);
    return out;
  };

  function renderRepos() {
    const picked = pickedItems();
    $('btnRepos').textContent = 'Repositories' + (repos.paths.length ? ' (' + repos.paths.length + ')' : '') + ' ▾';
    let h = '';
    if (!repos.paths.length) h = '<p class="muted">No repository connected yet. Paste the path of a local repository (or any folder) below; the tool searches it for Power BI projects (.pbip).</p>';
    for (const p of repos.paths) {
      const s = repos.scans.get(p);
      h += `<div class="repo"><div class="repohead"><b>${esc(s && s.name ? s.name : p.split(/[\\/]/).pop())}</b>${s && s.branch ? ` <span class="rep ind">${esc(s.branch)}</span>` : ''}
        <span class="muted small">${esc(p)}</span><span class="grow"></span>
        <button data-rescan="${esc(p)}" title="Search this repository again">Rescan</button><button data-drop="${esc(p)}" title="Disconnect this repository (nothing is deleted)">Remove</button></div>`;
      if (!s) h += '<div class="muted small">Scanning…</div>';
      else if (s.error) h += `<div class="warn small">${esc(s.error)}</div>`;
      else if (!s.items.length) h += '<div class="muted small">No Power BI projects (.pbip) found here.</div>';
      else {
        const groups = new Map();
        for (const it of s.items) {
          const k = it.model || (it.live ? 'live' : 'none');
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(it);
        }
        for (const [k, items] of groups) {
          const title = k === 'live' ? 'Live connection (model is not in this project, for example on Analysis Services)' : k === 'none' ? 'Model not found' : 'Model ' + items[0].modelName;
          h += `<div class="repogroup"><div class="small"><b>${esc(title)}</b>${items[0].modelRel ? ` <span class="muted">${esc(items[0].modelRel)}</span>` : ''}</div>` +
            items.map(it => `<label class="repitem${it.model || it.live ? '' : ' off'}"><input type="checkbox" data-report="${esc(it.report)}"${repos.pick.has(it.report) ? ' checked' : ''}${it.model || it.live ? '' : ' disabled'}> ${esc(it.name)} <span class="muted small">${esc(it.rel)}</span></label>`).join('') + '</div>';
        }
        if (s.truncated) h += '<div class="warn small">This folder is very large; the search stopped early.</div>';
      }
      h += '</div>';
    }
    $('repoList').innerHTML = h;
    const models = [];
    for (const p of repos.paths) for (const m of (repos.scans.get(p) || {}).models || []) models.push(m);
    const live = picked.length > 0 && !picked[0].model;
    if (repos.liveModel && !models.some(m => m.path === repos.liveModel)) repos.liveModel = '';
    $('liveModelWrap').hidden = !live;
    $('liveModel').innerHTML = '<option value="">No model: show report measures only</option>' + models.map(m => `<option value="${esc(m.path)}"${m.path === repos.liveModel ? ' selected' : ''}>${esc(m.name)} — ${esc(m.rel)}</option>`).join('');
    $('repoInfo').textContent = !picked.length ? 'Tick one or more reports that share a model.'
      : picked.length + ' report' + (picked.length === 1 ? '' : 's') + (live ? ' with a live connection' : ' on model ' + picked[0].modelName);
    $('repoLoad').disabled = !picked.length;
  }

  async function connectRepo(p) {
    p = p.trim().replace(/^"|"$/g, '');
    if (!p) return;
    if (!repos.paths.some(x => x.toLowerCase() === p.toLowerCase())) repos.paths.push(p);
    store.set('smo.repos', repos.paths);
    repos.scans.delete(p);
    renderRepos();
    const r = await scanRepoPath(p);
    if (r.repo && r.repo !== p) { // keep the normalised path
      repos.paths = repos.paths.map(x => (x === p ? r.repo : x)).filter((x, i, a) => a.findIndex(y => y.toLowerCase() === x.toLowerCase()) === i);
      repos.scans.delete(p); repos.scans.set(r.repo, r);
      store.set('smo.repos', repos.paths);
    }
    renderRepos();
  }

  $('btnRepos').onclick = () => {
    $('repoPanel').hidden = !$('repoPanel').hidden;
    if (!$('repoPanel').hidden) { renderRepos(); $('repoPath').focus(); }
  };
  $('repoForm').onsubmit = e => { e.preventDefault(); const p = $('repoPath').value; $('repoPath').value = ''; connectRepo(p); };
  $('repoPanel').onclick = e => {
    const d = e.target.dataset || {};
    if (d.rescan) return connectRepo(d.rescan);
    if (d.drop) {
      repos.paths = repos.paths.filter(x => x !== d.drop);
      repos.scans.delete(d.drop);
      store.set('smo.repos', repos.paths);
      return renderRepos();
    }
    if (e.target.id === 'repoClose') $('repoPanel').hidden = true;
  };
  $('repoPanel').onchange = e => {
    const rep = e.target.dataset && e.target.dataset.report;
    if (!rep) return;
    if (e.target.checked) {
      // reports must share one model: ticking a report on another model starts a new selection
      let model = null;
      for (const p of repos.paths) for (const it of (repos.scans.get(p) || {}).items || []) if (it.report === rep) model = it.model;
      for (const it of pickedItems()) if (it.model !== model) repos.pick.delete(it.report);
      repos.pick.add(rep);
    } else repos.pick.delete(rep);
    store.set('smo.pick', [...repos.pick]);
    renderRepos();
  };
  $('liveModel').onchange = e => { repos.liveModel = e.target.value; store.set('smo.liveModel', repos.liveModel); };
  $('repoLoad').onclick = () => {
    const picked = pickedItems();
    if (!picked.length) return;
    $('repoPanel').hidden = true;
    const p = [picked[0].model || repos.liveModel].filter(Boolean).concat(picked.map(it => it.report)).join(';');
    $('pathInput').value = p;
    loadFromPath(p);
  };

  async function loadFromPath(p) {
    if (!p) return;
    document.body.style.cursor = 'progress';
    try {
      const r = await fetch('api/load?path=' + encodeURIComponent(p)).then(x => x.json());
      if (r.error) { $('msgs').innerHTML = ''; return msg(r.error, true); }
      // a model loaded after model-less reports: load both together, so editing keeps working
      const np = SMO.loadProject(r.files);
      if (state.project && state.loadedPath && state.project.models.every(m => m.missing) && !np.models.every(m => m.missing) && !np.reports.length) {
        const joined = p + ';' + state.loadedPath;
        const r2 = await fetch('api/load?path=' + encodeURIComponent(joined)).then(x => x.json());
        if (!r2.error) { $('pathInput').value = r2.target; setProject(r2.files, r2.warnings || [], { base: r2.base, path: r2.target, keep: true }); return msg('Model loaded: the reports are now checked against it.'); }
      }
      setProject(r.files, r.warnings || [], { base: r.base, path: p });
    } catch (err) { msg('Loading failed: ' + err.message, true); }
    finally { document.body.style.cursor = ''; }
  };

  // ------------------------------------------------------------ selecting and deleting

  /** Only unused measures and columns that live in the model itself can be deleted. */
  const canSel = n => (n.type === 'measure' || n.type === 'column') && n.status === 'unused' && n.kind !== 'report measure' &&
    !(n.type === 'column' && n.tableKind && n.tableKind !== 'table');
  const canWrite = () => !!(state.base && state.project && state.project.models[state.modelIdx].format === 'tmdl');

  function renderSelBar() {
    const a = state.analysis, bar = $('selbar');
    const nodes = [...state.sel].map(id => a.nodes.get(id)).filter(Boolean);
    bar.hidden = !nodes.length;
    if (!nodes.length) return;
    const m = nodes.filter(n => n.type === 'measure').length, c = nodes.length - m;
    const size = nodes.reduce((s, n) => s + (n.size || 0), 0);
    bar.innerHTML = `<b>${nodes.length} selected</b> <span class="muted">${m} measures, ${c} columns${size ? ' · ' + mb(size) + ' MB' : ''}</span>
      <span class="grow"></span><button class="danger" data-act="del">Delete…</button><button data-act="script" title="Script that deletes the same objects in Tabular Editor">Tabular Editor script</button><button data-act="clear">Clear selection</button>`;
  }

  /** Splits the selection into what can go and what is still used by something outside the selection. */
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
    return '// Semantic Model Optimizer: deletes ' + nodes.length + ' unused objects.\n// Run in Tabular Editor (C# Script). Make a copy of the model first.\n' +
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
    let h = `<h2>Delete ${p.ok.length} objects</h2><p>${m} measures and ${c} columns${size ? ' (' + mb(size) + ' MB)' : ''} from model <b>${esc(model.name)}</b>.</p>`;
    if (p.blocked.length) {
      h += `<p class="warn">${p.blocked.length} selected objects will stay, because something outside your selection still calls them:</p><ul class="small">` +
        p.blocked.slice(0, 8).map(b => `<li>${esc(label(b.n))} ← ${esc(b.by.slice(0, 3).map(label).join(', '))}${b.by.length > 3 ? ' …' : ''}</li>`).join('') +
        (p.blocked.length > 8 ? `<li>… and ${p.blocked.length - 8} more</li>` : '') + '</ul>';
    }
    if (canWrite()) {
      h += `<ul class="small"><li>The TMDL files in <code>${esc(model.root)}</code> will be changed.</li>
        <li>Each changed file is first copied to the folder <code>smo-backup</code> next to the model.</li>
        ${c ? '<li>For deleted columns a <code>Table.RemoveColumns</code> step is added to the Power Query of the table, so they are no longer loaded either.</li>' : ''}
        <li><b>Close this project in Power BI Desktop first.</b> If it is still open and you save there, everything comes back.</li></ul>`;
    } else {
      h += `<p class="warn">Deleting directly only works for a Power BI project (TMDL) that you loaded through the path field, with <code>node serve.js</code>. You can still download a script for Tabular Editor.</p>`;
    }
    h += `<div class="dlgbtn"><button data-act="cancel">Cancel</button><button data-act="script">Tabular Editor script</button>${canWrite() && p.ok.length ? `<button class="danger" data-act="go">Delete ${p.ok.length}</button>` : ''}</div>`;
    dlg.innerHTML = h;
    dlg.onclick = async e => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      if (act === 'script') return download(model.name + '-delete.csx', teScript(p.ok));
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
        body: JSON.stringify({ path: state.loadedPath, modelRoot: model.root, items: nodes.map(n => ({ type: n.type, table: n.table, name: n.name })) }),
      }).then(x => x.json());
      $('msgs').innerHTML = '';
      if (r.error) return msg(r.error, true);
      msg(`${r.removed.length} objects deleted from ${r.files} files. Copy of the old files: ${r.backup}`);
      if (r.notFound.length) msg(r.notFound.length + ' objects not found in the files: ' + r.notFound.slice(0, 5).map(x => x.table + '[' + x.name + ']').join(', '), true);
      for (const w of r.warnings) msg(w);
      const keepIdx = state.modelIdx, off = state.off, base = state.base, path = state.loadedPath;
      const l = await fetch('api/load?path=' + encodeURIComponent(path)).then(x => x.json());
      if (l.error) return msg(l.error, true);
      setProject(l.files, [], { base: l.base || base, path, keep: true });
      state.modelIdx = Math.min(keepIdx, state.project.models.length - 1); state.off = off;
      run();
    } catch (e) { msg('Deleting failed: ' + e.message, true); }
    finally { document.body.style.cursor = ''; }
  }

  $('selbar').onclick = e => {
    const act = e.target.dataset && e.target.dataset.act;
    if (act === 'clear') { state.sel = new Set(); renderGrid(); }
    else if (act === 'script') download(state.project.models[state.modelIdx].name + '-delete.csx', teScript(plan().ok));
    else if (act === 'del') openDeleteDialog();
  };
  $('btnUnused').onclick = () => {
    for (const n of state.analysis.list) if (!n.system && canSel(n)) state.sel.add(n.id);
    state.type = 'mc'; state.status = 'unused'; $('fType').value = 'mc'; $('fStatus').value = 'unused';
    renderGrid();
  };

  // ------------------------------------------------------------ analysis + rendering

  function run() {
    const p = state.project;
    const reports = p.reports.filter(r => !state.off.has(r.root));
    const cur = p.models[state.modelIdx];
    state.analysis = SMO.applyStats(SMO.analyze(cur.model, reports, { noModel: !!cur.missing }), state.stats);
    $('noModel').hidden = !cur.missing;
    if (state.selected && !state.analysis.nodes.has(state.selected)) state.selected = null;
    for (const id of [...state.sel]) { const n = state.analysis.nodes.get(id); if (!n || !canSel(n)) state.sel.delete(id); }
    renderBar(); renderTiles(); renderTableFilter(); renderGrid(); renderDetail();
    if (state.view === 'model') renderDiagram();
  }

  // ------------------------------------------------------------ model diagram

  function setView(v) {
    state.view = v;
    for (const b of $('viewTabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.view === v);
    $('listView').hidden = v !== 'list';
    $('modelView').hidden = v !== 'model';
    $('split').classList.toggle('wide', v === 'model');
    if (v === 'model') { state.zoom = null; renderDiagram(); }
  }
  $('viewTabs').onclick = e => { const b = e.target.closest('[data-view]'); if (b && state.project) setView(b.dataset.view); };

  function renderDiagram() {
    const model = state.project.models[state.modelIdx].model;
    const d = SMODiagram.render({
      model, analysis: state.analysis, center: state.center || '', selected: state.selected,
      showOther: $('dOther').checked, fmt: { int, mb },
    });
    if (state.center && !d.center) state.center = '';
    const box = $('diagram');
    const fit = Math.min(1, Math.max(0.45, (box.clientWidth - 8) / d.width));
    if (state.zoom == null) state.zoom = fit;
    state.fit = fit;
    box.innerHTML = d.svg;
    const svg = box.querySelector('svg');
    svg.style.width = Math.round(d.width * state.zoom) + 'px';
    svg.style.height = Math.round(d.height * state.zoom) + 'px';
    $('dCenter').innerHTML = '<option value="">Whole model</option>' +
      d.centers.map(c => `<option value="${esc(c.name)}"${c.name === state.center ? ' selected' : ''}>${esc(c.name)} (${c.role})</option>`).join('');
    $('dOther').parentElement.hidden = !!state.center;
    const s = d.stats;
    $('dInfo').textContent = `${s.fact} fact table${s.fact === 1 ? '' : 's'} · ${s.dimension} dimension${s.dimension === 1 ? '' : 's'}` +
      (s.bridge ? ` · ${s.bridge} bridge table${s.bridge === 1 ? '' : 's'} (both a "many" and a "one" side)` : '') +
      (s.other ? ` · ${s.other} without relationships` : '') + ` · ${d.relationships} relationships`;
  }
  $('dCenter').onchange = e => { state.center = e.target.value; state.zoom = null; renderDiagram(); };
  $('dOther').onchange = () => { state.zoom = null; renderDiagram(); };
  $('dIn').onclick = () => { state.zoom = Math.min(2, (state.zoom || 1) * 1.2); renderDiagram(); };
  $('dOut').onclick = () => { state.zoom = Math.max(0.25, (state.zoom || 1) / 1.2); renderDiagram(); };
  $('dFit').onclick = () => { state.zoom = null; renderDiagram(); };
  $('diagram').onclick = e => {
    const c = e.target.closest('[data-table]');
    if (!c) return;
    const top = $('diagram').scrollTop, left = $('diagram').scrollLeft;
    select('T|' + c.dataset.table);
    $('diagram').scrollTop = top; $('diagram').scrollLeft = left;
  };
  $('diagram').ondblclick = e => {
    const c = e.target.closest('[data-table]');
    if (!c) return;
    state.center = state.center === c.dataset.table ? '' : c.dataset.table;
    state.zoom = null;
    renderDiagram();
  };

  function renderBar() {
    const p = state.project;
    $('modelPick').hidden = p.models.length < 2;
    $('selModel').innerHTML = p.models.map((m, i) => `<option value="${i}"${i === state.modelIdx ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
    $('reports').innerHTML = (p.reports.length ? '<span class="muted">Reports:</span>' : '<span class="muted">No report loaded — everything now counts as not used in a report.</span>') +
      p.reports.map(r => `<span class="chip ${state.off.has(r.root) ? 'off' : 'on'}" data-root="${esc(r.root)}" title="${esc(r.root)} · ${r.pages.length} pages, ${r.visualCount} visuals. Click to include or exclude it.">${esc(r.name)}</span>`).join('') +
      '<span class="chip add" data-add="1" title="Load another report on this model">+ Add report</span>';
    const multi = state.analysis.stats.reportCount >= 2;
    $('fReport').hidden = !multi;
    if (!multi) state.report = '';
    $('fReport').innerHTML = '<option value="">All reports</option>' +
      p.reports.filter(r => !state.off.has(r.root)).map(r => `<option${r.name === state.report ? ' selected' : ''}>${esc(r.name)}</option>`).join('') +
      `<option value="__none"${state.report === '__none' ? ' selected' : ''}>In no report</option>`;
  }
  $('fReport').onchange = e => { state.report = e.target.value; renderGrid(); };
  $('addRep').onsubmit = e => {
    e.preventDefault();
    const p = $('addPath').value.trim();
    if (!p) return;
    $('addRep').hidden = true; $('addPath').value = '';
    addPath(p);
  };
  $('addRep').onclick = e => {
    const act = e.target.dataset && e.target.dataset.pick;
    if (!act) return;
    $('addRep').hidden = true;
    if (act === 'cancel') return;
    state.adding = true;
    $(act === 'dir' ? 'inDir' : 'inFile').click();
  };
  $('selModel').onchange = e => { state.modelIdx = +e.target.value; state.selected = null; state.table = ''; run(); };
  $('reports').onclick = e => {
    const c = e.target.closest('.chip');
    if (!c) return;
    if (c.dataset.add) {
      $('addRep').hidden = !$('addRep').hidden;
      $('addPath').hidden = $('addPathBtn').hidden = $('pathForm').hidden;
      if (!$('addRep').hidden && !$('addPath').hidden) $('addPath').focus();
      return;
    }
    const root = c.dataset.root;
    if (state.off.has(root)) state.off.delete(root); else state.off.add(root);
    run();
  };

  function renderTiles() {
    const s = state.analysis.stats;
    const tile = (lbl, big, sub, type, status, ok) =>
      `<button class="tile" data-type="${type}" data-status="${status}"><div class="lbl">${lbl}</div><div class="big">${big}</div><div class="sub${ok ? ' ok' : ''}">${sub}</div></button>`;
    $('tiles').innerHTML =
      tile('Measures', s.measures, s.measuresUnused + ' unused', 'measure', 'unused', !s.measuresUnused) +
      tile('Columns', s.columns, s.columnsUnused + ' unused', 'column', 'unused', !s.columnsUnused) +
      tile('Model only', s.columnsModelOnly, 'columns in a relationship, RLS or hierarchy', 'column', 'model', true) +
      tile('Calculated columns', s.calcColumns, s.calcColumnsUnused + ' unused', 'calc', 'unused', !s.calcColumnsUnused) +
      tile('Tables', s.tables, s.tablesUnused + ' unused', 'table', 'unused', !s.tablesUnused) +
      (s.hasStats ? tile('Model size', mb(s.totalSize) + ' MB', mb(s.unusedSize) + ' MB in unused columns', 'column', 'unused', !s.unusedSize) : '') +
      (s.reportMeasures || s.noModel ? tile('Report measures', s.reportMeasures, 'defined in a report, not in the model', 'repm', '', true) : '') +
      (s.brokenFormulas || s.brokenAffected ? tile('Broken formulas', s.brokenFormulas, s.brokenAffected ? s.brokenAffected + ' more depend on a broken one' : 'refer to something that does not exist', 'all', 'brokenf', false) : '') +
      tile(s.noModel ? 'Report (model not loaded)' : 'Report', s.visuals + ' visuals', s.pages + ' pages' + (s.broken ? ' · ' + s.broken + (s.noModel ? ' fields used' : ' broken references') : ''), 'mc', s.broken ? 'broken' : '', !s.broken || s.noModel);
  }
  $('tiles').onclick = e => {
    const t = e.target.closest('.tile');
    if (!t) return;
    state.type = t.dataset.type; state.status = t.dataset.status; state.table = '';
    if (t.textContent.includes('Model size')) { state.sort = 'size'; state.dir = -1; }
    $('fType').value = state.type; $('fStatus').value = state.status; $('fTable').value = '';
    renderGrid();
  };

  function renderTableFilter() {
    const names = state.analysis.list.filter(n => n.type === 'table' && !n.system).map(n => n.name).sort((a, b) => a.localeCompare(b));
    $('fTable').innerHTML = '<option value="">All tables</option>' + names.map(n => `<option${n === state.table ? ' selected' : ''}>${esc(n)}</option>`).join('');
  }

  function kindClass(n) {
    if (n.type === 'measure') return 'measure';
    if (n.type === 'table') return n.kind === 'table' ? 'table' : 'calc';
    if (n.kind === 'calculated column') return 'calc';
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
      if (t === 'repm' && n.kind !== 'report measure') return false;
      if (t === 'modelm' && n.kind !== 'measure') return false;
      if (t === 'calc' && !(n.kind === 'calculated column' || n.kind === 'calculated table' || n.kind === 'calculation group')) return false;
      if (state.status === 'brokenf') { if (!n.broken) return false; }
      else if (state.status && n.status !== state.status) return false;
      if (state.table && n.table !== state.table) return false;
      if (state.report === '__none' && n.reports.length) return false;
      if (state.report && state.report !== '__none' && !n.reports.some(r => r.name === state.report)) return false;
      if (q && !(n.name.toLowerCase().includes(q) || n.table.toLowerCase().includes(q) || (n.expression || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }

  const COLS = [
    { key: 'name', label: 'Name' }, { key: 'table', label: 'Table' }, { key: 'kind', label: 'Type' },
    { key: 'status', label: 'Status' },
    { key: 'uses', label: 'Visuals', num: true, title: 'Number of places in reports where this is used directly' },
    { key: 'depCount', label: 'Depends on', num: true }, { key: 'usedByCount', label: 'Used by', num: true },
  ];
  const STAT_COLS = [
    { key: 'rows', label: 'Rows', num: true, title: 'Table: number of rows. Column: number of distinct values.' },
    { key: 'size', label: 'MB', num: true, title: 'Memory used in the model' },
    { key: 'share', label: '% model', num: true, title: 'Share of the total model size' },
  ];
  const nf = new Intl.NumberFormat('en-US');
  const int = v => (v == null ? '' : nf.format(v));
  const mb = v => (v == null ? '' : (v / 1048576).toLocaleString('en-US', { minimumFractionDigits: v < 104857600 ? 2 : 1, maximumFractionDigits: v < 104857600 ? 2 : 1 }));
  const pct = v => (v == null ? '' : (v * 100).toLocaleString('en-US', { maximumFractionDigits: 1 }) + '%');
  const rowsOf = n => (n.type === 'table' ? n.rows : n.type === 'column' ? n.cardinality : null);
  const sortVal = (n, k) => k === 'status' ? STATUS_RANK[n.status] : k === 'uses' ? n.reportUses.length
    : k === 'reports' ? n.reports.length + n.reports.filter(r => r.direct).length / 100
    : k === 'rows' ? (rowsOf(n) == null ? -1 : rowsOf(n)) : (k === 'size' || k === 'share') ? (n[k] == null ? -1 : n[k]) : n[k];

  function renderGrid() {
    const thead = $('grid').querySelector('thead'), tbody = $('grid').querySelector('tbody');
    renderSelBar();
    if (state.status === 'broken') {
      const b = state.analysis.broken;
      thead.innerHTML = '<tr><th>Field</th><th>Table</th><th>Report</th><th>Page</th><th>Visual</th><th>Role</th></tr>';
      tbody.innerHTML = b.map(u => `<tr><td class="nm">${esc(u.name)}</td><td>${esc(u.table)}</td><td>${esc(u.report)}</td><td>${esc(u.page)}</td><td>${esc(u.visualTitle || u.visualType || u.visual)}</td><td>${esc(u.role)}</td></tr>`).join('');
      $('count').textContent = state.analysis.stats.noModel ? b.length + ' fields the reports use from the model (the model is not loaded, so they cannot be checked)' : b.length + ' references in reports to fields that do not exist in the model';
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
    const multi = state.analysis.stats.reportCount >= 2;
    const cols = COLS.slice(0, 4).concat(
      multi ? [{ key: 'reports', label: 'Report', title: 'Which reports use this. Dimmed = only indirectly, through a measure or column that is in the report.' }] : [],
      has ? STAT_COLS : [], COLS.slice(4));
    const repCell = n => '<td class="reps">' + n.reports.map(r => `<span class="rep${r.direct ? '' : ' ind'}" title="${r.direct ? 'Used directly in this report' : 'Needed indirectly for this report'}">${esc(r.name)}</span>`).join('') + '</td>';
    const selectable = rows.filter(canSel);
    const allOn = selectable.length > 0 && selectable.every(n => state.sel.has(n.id));
    thead.innerHTML = `<tr><th class="chk"><input type="checkbox" id="chkAll" title="Select all unused objects in this list"${allOn ? ' checked' : ''}${selectable.length ? '' : ' disabled'}></th>` + cols.map(c => `<th data-k="${c.key}" class="${c.num ? 'num' : ''}" title="${esc(c.title || '')}">${c.label}${state.sort === c.key ? (d > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr>';
    const MAX = 3000;
    tbody.innerHTML = rows.slice(0, MAX).map(n => `<tr data-id="${esc(n.id)}" class="${n.id === state.selected ? 'sel' : ''}">
      <td class="chk">${canSel(n) ? `<input type="checkbox" data-sel="${esc(n.id)}"${state.sel.has(n.id) ? ' checked' : ''}>` : ''}</td>
      <td class="nm">${esc(n.name)}${n.hidden ? ' <span class="hid">hidden</span>' : ''}${n.kind === 'report measure' ? ` <span class="rep ind" title="Defined in report ${esc(n.report)}, not in the semantic model">report only</span>` : ''}${n.broken ? ` <span class="brk" title="${esc(n.problems.length ? n.problems.map(p => p.ref + ': ' + p.reason).join('; ') : 'Depends on a broken formula')}">broken</span>` : ''}</td>
      <td>${n.type === 'table' ? '' : esc(n.table)}</td>
      <td class="k k-${kindClass(n)}">${esc(n.kind)}</td>
      <td><span class="badge s-${n.status}">${STATUS[n.status]}</span></td>
      ${multi ? repCell(n) : ''}${has ? `<td class="num">${int(rowsOf(n))}${n.type === 'column' && n.cardinality != null ? ' <span class="hid">distinct</span>' : ''}</td><td class="num">${n.type === 'table' && n.mode === 'directQuery' && !n.size ? '<span class="hid">DirectQuery</span>' : mb(n.size)}</td><td class="num">${n.share ? `<span class="sbar" style="--w:${Math.max(2, Math.round(n.share * 100))}%"></span>` + pct(n.share) : ''}</td>` : ''}
      <td class="num">${n.reportUses.length || ''}</td><td class="num">${n.depCount || ''}</td><td class="num">${n.usedByCount || ''}</td></tr>`).join('');
    const sum = rows.reduce((a, n) => a + (n.size || 0), 0);
    $('count').textContent = rows.length + ' objects' + (has && sum ? ' · ' + mb(sum) + ' MB in total' + (state.type === 'table' ? ' · ' + int(rows.reduce((a, n) => a + (n.rows || 0), 0)) + ' rows' : '') + ' · source: ' + state.analysis.stats.statsSource : '') + (rows.length > MAX ? ' (first ' + MAX + ' shown — narrow the filter)' : '');
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

  // ------------------------------------------------------------ export

  /** The current list (with all filters applied) as tables for the three export formats. */
  function exportData() {
    const a = state.analysis, rows = filtered(), model = state.project.models[state.modelIdx];
    const direct = n => n.reports.filter(r => r.direct).map(r => r.name).join(', ');
    const indirect = n => n.reports.filter(r => !r.direct).map(r => r.name).join(', ');
    const objects = {
      name: 'Objects',
      head: ['Type', 'Table', 'Name', 'Status', 'Reports direct', 'Reports indirect', 'Hidden', 'Rows', 'Distinct values', 'Bytes', 'Visuals', 'Depends on', 'Used by', 'Model usage', 'Defined in', 'Problems', 'Description', 'Expression'],
      rows: rows.map(n => [n.kind, n.type === 'table' ? '' : n.table, n.name, STATUS[n.status], direct(n), indirect(n), n.hidden ? 'yes' : '', n.rows, n.cardinality, n.size,
        n.reportUses.length, n.depCount, n.usedByCount, [...new Set(n.modelUses.map(u => u.kind))].join(' + '), n.kind === 'report measure' ? 'report ' + n.report : 'model',
        n.problems.map(p => p.ref + ': ' + p.reason).concat(n.brokenVia.map(id => 'depends on broken ' + label(a.nodes.get(id)))).join('; '), n.description || '', n.expression || '']),
    };
    const usage = { name: 'Report usage', head: ['Type', 'Table', 'Name', 'Report', 'Page', 'Visual', 'Visual type', 'Role'], rows: [] };
    for (const n of rows) for (const u of n.reportUses) usage.rows.push([n.kind, n.table, n.name, u.report, u.page, u.visualTitle || u.visual, u.visualType, u.role]);
    const rels = {
      name: 'Relationships', head: ['From table', 'From column', 'From cardinality', 'To table', 'To column', 'To cardinality', 'Active', 'Cross filter'],
      rows: (model.model.relationships || []).map(r => [r.fromTable, r.fromColumn, r.fromCardinality, r.toTable, r.toColumn, r.toCardinality, r.isActive ? 'yes' : 'no', r.crossFilter || 'single']),
    };
    const broken = { name: 'Broken references', head: ['Field', 'Table', 'Report', 'Page', 'Visual', 'Role'],
      rows: a.broken.map(u => [u.name, u.table, u.report, u.page, u.visualTitle || u.visualType || u.visual, u.role]) };
    const sel = id => { const o = $(id).selectedOptions[0]; return o && $(id).value ? o.textContent : ''; };
    const filters = [$('fType').selectedOptions[0].textContent, sel('fStatus'), sel('fTable'), state.report ? sel('fReport') : '', state.q ? 'search "' + state.q + '"' : ''].filter(Boolean).join(' · ');
    return { a, rows, model, objects, usage, rels, broken, filters };
  }

  async function runExport(kind) {
    const d = exportData(), base = d.model.name + '-usage';
    const blobDown = (name, bytes, type) => {
      const el = document.createElement('a');
      el.href = URL.createObjectURL(new Blob([bytes], { type }));
      el.download = name;
      el.click();
      setTimeout(() => URL.revokeObjectURL(el.href), 1000);
    };
    if (kind === 'csv') return blobDown(base + '.csv', SMOExport.toCsv(state.status === 'broken' ? d.broken : d.objects), 'text/csv');
    if (kind === 'xlsx') {
      const sheets = [d.objects, d.usage, d.rels].concat(d.broken.rows.length ? [d.broken] : []);
      return blobDown(base + '.xlsx', await SMOExport.toXlsx(sheets), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }
    const s = d.a.stats, has = s.hasStats, multi = s.reportCount >= 2;
    const COLOR = { direct: [0.12, 0.56, 0.31], indirect: [0.1, 0.51, 0.65], model: [0.72, 0.47, 0.02], unused: [0.78, 0.22, 0.18] };
    const columns = [{ label: 'Name', weight: 3 }, { label: 'Table', weight: 2 }, { label: 'Type', weight: 1.5 }, { label: 'Status', weight: 1.4 }]
      .concat(multi ? [{ label: 'Reports', weight: 2 }] : [], has ? [{ label: 'Rows', weight: 1, align: 'right' }, { label: 'MB', weight: 0.8, align: 'right' }] : [],
        [{ label: 'Visuals', weight: 0.7, align: 'right' }, { label: 'Depends on', weight: 0.9, align: 'right' }, { label: 'Used by', weight: 0.8, align: 'right' }]);
    const pdf = await SMOExport.toPdf({
      title: 'Semantic Model Optimizer — ' + d.model.name,
      lines: [
        'Reports: ' + (state.project.reports.filter(r => !state.off.has(r.root)).map(r => r.name).join(', ') || 'none') + '   ·   ' + new Date().toISOString().slice(0, 10),
        `Model: ${s.measures} measures (${s.measuresUnused} unused), ${s.columns} columns (${s.columnsUnused} unused, ${s.columnsModelOnly} model only), ${s.tables} tables` + (has ? `, ${mb(s.totalSize)} MB (${mb(s.unusedSize)} MB in unused columns)` : ''),
        `This list: ${d.rows.length} objects · ${d.filters}`,
      ],
      columns, colorCol: 3, rowColors: d.rows.map(n => COLOR[n.status]),
      rows: d.rows.map(n => [n.name, n.type === 'table' ? '' : n.table, n.kind, STATUS[n.status]]
        .concat(multi ? [n.reports.map(r => r.name + (r.direct ? '' : ' (indirect)')).join(', ')] : [], has ? [int(rowsOf(n)), mb(n.size)] : [],
          [n.reportUses.length || '', n.depCount || '', n.usedByCount || ''])),
      footer: d.model.name,
    });
    blobDown(base + '.pdf', pdf, 'application/pdf');
  }
  $('selExport').onchange = async e => {
    const kind = e.target.value;
    e.target.value = '';
    if (!kind) return;
    document.body.style.cursor = 'progress';
    try { await runExport(kind); }
    catch (err) { msg('Export failed: ' + err.message, true); }
    finally { document.body.style.cursor = ''; }
  };


  // ------------------------------------------------------------ detail + lineage

  function select(id) {
    state.selected = id; state.expand = false; state.editing = null;
    for (const tr of $('grid').querySelectorAll('tr.sel')) tr.classList.remove('sel');
    const tr = $('grid').querySelector(`tr[data-id="${CSS.escape(id)}"]`);
    if (tr) tr.classList.add('sel');
    renderDetail();
    $('detail').scrollTop = 0;
    if (state.view === 'model') renderDiagram();
  }

  const label = n => n.type === 'measure' ? '[' + n.name + ']' : n.type === 'table' ? "'" + n.name + "'" : n.type === 'function' ? n.name + '()' : n.table + '[' + n.name + ']';

  /** Shortest path from this object to something that is used directly in a report. */
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
      return `Used directly in a report: ${n.reportUses.length} time${n.reportUses.length === 1 ? '' : 's'}, on ${pages.size} page${pages.size === 1 ? '' : 's'}.`;
    }
    if (n.status === 'indirect') {
      if (n.type === 'table') return 'Something from this table is used in a report.';
      const p = pathToReport(a, n);
      return 'Not in a report itself, but needed for something that is' + (p ? ': ' + p.map(label).join(' → ') + ' → report.' : '.');
    }
    if (n.status === 'model') {
      const kinds = [...new Set(n.modelUses.map(u => u.kind))];
      return 'Not used in any report, but the model needs it' + (kinds.length ? ' (' + kinds.join(', ') + ').' : ' through another part of the model.') + ' Deleting it can break relationships or security.';
    }
    if (n.usedBy.size) return `Not used in any loaded report. It is called by ${n.usedBy.size} other object${n.usedBy.size === 1 ? '' : 's'}, but ${n.usedBy.size === 1 ? 'that is' : 'those are'} unused as well.`;
    return 'Not used in any loaded report or anywhere in the model.';
  }

  function renderDetail() {
    const a = state.analysis, el = $('detail');
    const n = state.selected && a.nodes.get(state.selected);
    if (!n) {
      el.innerHTML = '<p class="muted">Click a measure or column to see where it is used and what it depends on.</p>';
      return;
    }
    const links = ids => ids.length ? '<div class="links">' + ids.map(id => a.nodes.get(id)).sort((x, y) => label(x).localeCompare(label(y)))
      .map(x => `<span class="link" data-id="${esc(x.id)}" title="${esc(x.kind)} · ${STATUS[x.status]}"><span class="k-${kindClass(x)}">●</span> ${esc(label(x))}</span>`).join('') + '</div>' : '<span class="muted">—</span>';
    if (state.editing === n.id) { el.innerHTML = editForm(a, n); wireEdit(a, n); return; }
    const editable = n.kind !== 'report measure' && ['measure', 'column', 'table'].includes(n.type) && !n.system;
    let h = (editable ? (canWrite()
      ? '<button class="editbtn" data-edit="1">Edit</button>'
      : '<button class="editbtn" disabled title="Editing works for a Power BI project (TMDL) that you loaded through the path field, with node serve.js">Edit</button>') : '') +
      `<h2>${esc(n.name)}</h2>
      <div class="meta"><span class="k k-${kindClass(n)}">${esc(n.kind)}</span>${n.type === 'table' ? '' : '<span class="muted">in ' + esc(n.table) + '</span>'}
        <span class="badge s-${n.status}">${STATUS[n.status]}</span>${n.hidden ? '<span class="hid">hidden</span>' : ''}
        ${n.dataType ? '<span class="muted">' + esc(n.dataType) + '</span>' : ''}${n.report ? '<span class="muted">created in report ' + esc(n.report) + '</span>' : ''}</div>`;
    if (n.description) h += `<div class="muted">${esc(n.description)}</div>`;
    h += `<p class="why">${esc(why(a, n))}</p>`;
    if (n.kind === 'report measure') h += `<p class="note">This measure exists only in report <b>${esc(n.report)}</b>. It is not part of the semantic model, so other reports on the same model cannot use it.</p>`;
    if (n.broken) {
      h += '<h3>Problems</h3><table class="uses">' + n.problems.map(p => `<tr><td class="s-unused"><code>${esc(p.ref)}</code></td><td>${esc(p.reason)}</td></tr>`).join('') +
        n.brokenVia.map(id => a.nodes.get(id)).filter(Boolean).map(x => `<tr><td><span class="link" data-id="${esc(x.id)}">${esc(label(x))}</span></td><td>is broken, and this formula depends on it</td></tr>`).join('') + '</table>';
    }
    if (a.stats.hasStats && (n.type === 'table' || n.type === 'column')) h += sizeBlock(a, n);
    h += '<h3>Lineage</h3>' + graph(a, n);
    if (n.expression) h += `<h3>${n.type === 'table' ? 'Table expression' : 'DAX'}</h3><pre class="dax">${esc(n.expression)}</pre>`;
    else if (n.type === 'column' && n.sourceColumn) h += `<h3>Source</h3><div>Source column <code>${esc(n.sourceColumn)}</code> of table ${esc(n.table)}</div>`;
    else if (n.type === 'table' && n.source) h += `<h3>Source query${n.mode ? ' (' + esc(n.mode) + ')' : ''}</h3><pre class="dax">${esc(n.source)}</pre>`;
    h += '<h3>Depends directly on</h3>' + links([...n.deps]);
    h += '<h3>Used directly by</h3>' + links([...n.usedBy]);
    if (n.modelUses.length) {
      h += '<h3>Usage in the model</h3><table class="uses">' + n.modelUses.map(u => `<tr><td>${esc(u.kind)}</td><td>${esc(u.detail)}</td></tr>`).join('') + '</table>';
    }
    if (n.reportUses.length) {
      h += '<h3>Usage in reports</h3><table class="uses"><tr><th>Report</th><th>Page</th><th>Visual</th><th>Role</th></tr>' +
        n.reportUses.map(u => `<tr><td>${esc(u.report)}</td><td>${esc(u.page || '—')}</td><td>${esc(u.visualTitle || u.visualType || u.visual || '—')}${u.visualTitle && u.visualType ? ' <span class="muted">' + esc(u.visualType) + '</span>' : ''}</td><td>${esc(u.role)}</td></tr>`).join('') + '</table>';
    }
    el.innerHTML = h;
  }
  // ------------------------------------------------------------ editing

  /** Can the name be changed safely? Only if every report that uses the field is stored on disk as PBIR. */
  function renameBlock(n) {
    if (n.type === 'table') return 'Renaming tables is not supported yet.';
    const bad = new Set();
    for (const u of n.reportUses) {
      const r = state.project.reports.find(x => x.name === u.report);
      if (r && (r.format !== 'PBIR' || /\.(pbix|pbit)(\/|$)/i.test(r.root))) bad.add(r.name);
    }
    return bad.size ? 'Renaming is not possible: report ' + [...bad].join(', ') + ' uses this field and is in the legacy format or inside a .pbix. The tool cannot update that.' : '';
  }

  function editForm(a, n) {
    const block = renameBlock(n);
    const hasExpr = n.type !== 'table' && !!n.expression;
    const rows = Math.min(24, Math.max(4, (n.expression || '').split('\n').length + 1));
    return `<form id="editForm" class="edit">
      <h2>Edit ${esc(n.kind)}</h2>
      <label>Name<input name="name" type="text" value="${esc(n.name)}" ${block ? 'disabled' : ''} spellcheck="false" autocomplete="off"></label>
      ${block ? `<div class="muted small">${esc(block)}</div>` : n.type === 'table' ? '' : `<div class="muted small" id="renameNote"></div>`}
      <label>Description<textarea name="description" rows="3">${esc(n.description || '')}</textarea></label>
      ${hasExpr ? `<label>Formula (DAX)<textarea name="expression" class="code" rows="${rows}" spellcheck="false">${esc(n.expression)}</textarea></label><div class="warn small" id="exprNote"></div>` : ''}
      <div class="muted small">The change is written to the TMDL files; each changed file is first copied to <code>smo-backup</code>. Close the project in Power BI Desktop first. The formula is not validated by Power BI: you only see an error when you open the project.</div>
      <div class="dlgbtn"><button type="button" data-cancel="1">Cancel</button><button class="primary">Save</button></div>
    </form>`;
  }

  function wireEdit(a, n) {
    const f = $('editForm');
    const nameNote = $('renameNote'), exprNote = $('exprNote');
    const update = () => {
      if (nameNote) {
        const v = f.elements.name.value.trim();
        nameNote.textContent = v && v !== n.name
          ? `Saving will update references: ${n.usedBy.size} formula${n.usedBy.size === 1 ? '' : 's'} and ${n.reportUses.length} place${n.reportUses.length === 1 ? '' : 's'} in reports. Usage outside this folder (other reports, Excel) will break.`
          : '';
      }
      if (exprNote) {
        const unknown = [];
        for (const r of SMO.daxRefs(f.elements.expression.value)) {
          if ((r.t === 'q' || r.t === 'b') && !a.resolve(r, n.table)) unknown.push(r.t === 'q' ? r.table + '[' + r.name + ']' : '[' + r.name + ']');
        }
        const u = [...new Set(unknown)];
        exprNote.textContent = u.length ? 'Not found in the model: ' + u.slice(0, 6).join(', ') + (u.length > 6 ? ' …' : '') + '. That can be fine for columns you create inside the formula itself.' : '';
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
        msg(`Saved in ${r.files} file${r.files === 1 ? '' : 's'}` + (r.renamed ? ` (${r.reportFields} fields in reports updated)` : '') + `. Copy of the old files: ${r.backup}`);
        const keepIdx = state.modelIdx, off = state.off, sel = state.sel, path = state.loadedPath;
        const l = await fetch('api/load?path=' + encodeURIComponent(path)).then(x => x.json());
        if (l.error) return msg(l.error, true);
        setProject(l.files, [], { base: l.base, path, keep: true });
        state.modelIdx = Math.min(keepIdx, state.project.models.length - 1); state.off = off; state.sel = sel; state.selected = r.id;
        run();
      } catch (err) { msg('Saving failed: ' + err.message, true); }
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
      if (n.size == null) return '<h3>Size</h3><p class="muted">No size data for this column.</p>';
      const p = n.sizeParts || {};
      return '<h3>Size</h3><div class="facts">' + fact('Memory', mb(n.size) + ' MB') + fact('Share of model', pct(n.share)) +
        fact('Distinct values', int(n.cardinality)) + fact('Rows in table', int(n.rows)) +
        fact('Dictionary', p.dictionary == null ? '' : mb(p.dictionary) + ' MB') + fact('Data', p.data == null ? '' : mb(p.data) + ' MB') +
        fact('Hierarchy', p.hierarchy == null ? '' : mb(p.hierarchy) + ' MB') + (p.encoding ? fact('Encoding', esc(p.encoding)) : '') + '</div>';
    }
    if (n.size == null && n.rows == null) return '<h3>Size</h3><p class="muted">No size data for this table.</p>';
    const cols = a.list.filter(c => c.type === 'column' && c.table === n.name && c.size).sort((x, y) => y.size - x.size);
    const unused = cols.filter(c => c.status === 'unused').reduce((s, c) => s + c.size, 0);
    const max = cols.length ? cols[0].size : 1;
    let h = '<h3>Size</h3><div class="facts">' + fact('Rows', int(n.rows)) + fact('Memory', n.mode === 'directQuery' && !n.size ? 'DirectQuery' : mb(n.size) + ' MB') +
      fact('Share of model', pct(n.share)) + fact('In unused columns', unused ? mb(unused) + ' MB' : '0 MB') + '</div>';
    if (cols.length) {
      h += '<table class="uses sizes"><tr><th>Largest columns</th><th class="num">MB</th><th class="num">Distinct</th><th>Status</th></tr>' +
        cols.slice(0, 12).map(c => `<tr><td><span class="link" data-id="${esc(c.id)}">${esc(c.name)}</span><span class="sbar wide" style="--w:${Math.max(1, Math.round(c.size / max * 100))}%"></span></td>
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
    up.slice().reverse().forEach((l, i) => cols.push({ title: up.length - i === 1 ? 'Depends on' : 'Level −' + (up.length - i), items: l.map(nodeItem).sort(byName) }));
    cols.push({ title: 'Selected', items: [Object.assign(nodeItem(n.id), { center: true })] });
    down.forEach((l, i) => cols.push({ title: i === 0 ? 'Used by' : 'Level +' + (i + 1), items: l.map(nodeItem).sort(byName) }));
    // report pages that show this object or something that depends on it
    const pages = new Map();
    for (const id of [n.id].concat(...down)) {
      for (const u of a.nodes.get(id).reportUses) {
        const key = 'P|' + u.report + '|' + u.page;
        if (!pages.has(key)) pages.set(key, { key, page: true, name: u.page || '(report level)', report: u.report, from: new Set(), visuals: new Set(), cls: 'page' });
        const p = pages.get(key);
        p.from.add(id); p.visuals.add(u.visual + '|' + u.role);
      }
    }
    if (pages.size) {
      const items = [...pages.values()].sort((x, y) => x.name.localeCompare(y.name));
      for (const p of items) p.sub = p.report + ' · ' + p.visuals.size + '×';
      cols.push({ title: 'Report page', items });
    }
    if (cols.length === 1) return '<p class="muted">No dependencies and nothing that uses this.</p>';

    let more = false;
    for (const c of cols) {
      if (c.items.length > CAP) { more = true; const rest = c.items.length - CAP; c.items = c.items.slice(0, CAP); c.items.push({ key: 'more', more: true, name: '+ ' + rest + ' more…', sub: 'click to show all', cls: 'table' }); }
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
    return `<div class="graphwrap"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Lineage of ${esc(n.name)}">${edges}${boxes}</svg></div>
      <div class="legend"><span><i style="background:var(--measure)"></i>measure</span><span><i style="background:var(--column)"></i>column</span>
      <span><i style="background:var(--calc)"></i>calculated</span><span><i style="background:var(--table)"></i>table</span><span><i style="background:var(--page)"></i>report page</span>
      <span>dot = status</span><span>left = source, right = consumer${more ? '' : ''}. Click a block to go there.</span></div>`;
  }

  // test hook: load a project from the address bar (?path=...) when serve.js is running
  const qp = new URLSearchParams(location.search).get('path');
  if (qp && location.protocol.startsWith('http')) { $('pathInput').value = qp; setTimeout(() => $('pathForm').requestSubmit(), 50); }
})();
