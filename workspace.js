/* Reads the definition of every report in a Power BI workspace that uses a given semantic model (Node 18+).
 * Read-only: it lists reports with the Power BI REST API and fetches each definition with the Fabric REST API.
 *
 * Sign-in: tokens come from the environment (SMO_POWERBI_TOKEN and SMO_FABRIC_TOKEN, for a pipeline with a
 * service principal) or from the Azure CLI when you are signed in there (az login). No secrets are stored. */
'use strict';
const { execSync } = require('child_process');

const PBI = 'https://api.powerbi.com/v1.0/myorg';
const FABRIC = 'https://api.fabric.microsoft.com/v1';

function token(resource, envName) {
  if (process.env[envName]) return process.env[envName];
  try {
    // resource is one of two fixed addresses in this file, so the command line is safe to build as text
    return execSync('az account get-access-token --resource ' + resource + ' --query accessToken -o tsv',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    throw new Error('No sign-in found for Power BI. Run "az login" first (Azure CLI), or set ' + envName + ' to an access token for ' + resource + '.');
  }
}

async function call(url, tok, init) {
  const res = await fetch(url, Object.assign({ headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' } }, init || {}));
  if (res.status === 202 || res.ok) return res;
  let detail = '';
  try { const j = await res.json(); detail = (j.error && (j.error.message || j.error.code)) || j.message || ''; } catch (e) { /* no body */ }
  const hint = res.status === 401 ? ' The sign-in has expired or is for another tenant.' : res.status === 403 ? ' You need access to the workspace (and for report definitions: permission to edit the report).' : '';
  throw new Error(`Power BI answered ${res.status} for ${url.replace(/^https:\/\/[^/]+/, '')}${detail ? ': ' + detail : ''}.${hint}`);
}

/** Fabric long-running operation: poll until it is done, then read the result. */
async function waitFor(res, tok) {
  if (res.status !== 202) return res.json();
  const loc = res.headers.get('location');
  if (!loc) throw new Error('Power BI started a long-running operation but gave no address to follow.');
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, Math.max(1, Number(res.headers.get('retry-after')) || 2) * 1000));
    const st = await (await call(loc, tok)).json();
    if (st.status === 'Succeeded') return (await call(loc.replace(/\/?$/, '/result'), tok)).json();
    if (st.status === 'Failed') throw new Error('Power BI could not export the definition' + (st.error && st.error.message ? ': ' + String(st.error.message).trim() : '.'));
  }
  throw new Error('Power BI took too long to export a definition.');
}

const safe = s => String(s).replace(/[\\/:*?"<>|]/g, ' ').trim() || 'report';

/**
 * opts: {workspace: name or id, dataset: name or id (optional: every report when left out)}
 * → {workspace, reports: [names], files: [{path, text}], warnings: []}
 */
async function workspaceReports(opts) {
  const pbi = token('https://analysis.windows.net/powerbi/api', 'SMO_POWERBI_TOKEN');
  const fab = token('https://api.fabric.microsoft.com', 'SMO_FABRIC_TOKEN');
  const want = String(opts.workspace || '').trim();
  if (!want) throw new Error('Give the name or id of the workspace.');
  const groups = (await (await call(PBI + '/groups?$top=5000', pbi)).json()).value || [];
  if (want === '*') {
    // every workspace you can open: the model is then matched by id or name per workspace
    const out = { workspace: groups.length + ' workspaces', reports: [], files: [], warnings: [], skipped: 0 };
    for (const g of groups.slice(0, 500)) {
      try { const r = await workspaceReports({ workspace: g.id, dataset: opts.dataset, quiet: true }); out.reports.push(...r.reports.map(n => g.name + ' / ' + n)); out.files.push(...r.files); out.warnings.push(...r.warnings); }
      catch (e) { out.warnings.push(g.name + ': ' + e.message); }
    }
    if (groups.length > 500) out.warnings.push('Only the first 500 workspaces were read.');
    return out;
  }
  const ws = groups.find(g => g.id.toLowerCase() === want.toLowerCase()) || groups.find(g => String(g.name).toLowerCase() === want.toLowerCase());
  if (!ws) throw new Error('Workspace "' + want + '" not found among the ' + groups.length + ' workspaces you can open.');

  let datasetIds = null;
  if (opts.dataset) {
    const d = String(opts.dataset).trim().toLowerCase();
    const sets = (await (await call(`${PBI}/groups/${ws.id}/datasets`, pbi)).json()).value || [];
    const hit = sets.filter(s => s.id.toLowerCase() === d || String(s.name).toLowerCase() === d);
    // the model may live in another workspace: then only the id can match
    datasetIds = new Set(hit.length ? hit.map(s => s.id.toLowerCase()) : [d]);
  }
  const all = (await (await call(`${PBI}/groups/${ws.id}/reports`, pbi)).json()).value || [];
  const reports = all.filter(r => r.reportType !== 'PaginatedReport' && (!datasetIds || datasetIds.has(String(r.datasetId || '').toLowerCase())));
  const files = [], warnings = [], names = [];
  for (const r of reports) {
    try {
      const def = await waitFor(await call(`${FABRIC}/workspaces/${ws.id}/reports/${r.id}/getDefinition`, fab, { method: 'POST' }), fab);
      const parts = (def.definition && def.definition.parts) || [];
      const root = `workspace/${safe(ws.name)}/${safe(r.name)}.Report`;
      for (const p of parts) {
        if (!/\.(json|pbir)$/i.test(p.path) || /^StaticResources\//i.test(p.path)) continue;
        files.push({ path: root + '/' + p.path, text: Buffer.from(p.payload, 'base64').toString('utf8') });
      }
      names.push(r.name);
    } catch (e) { warnings.push(r.name + ': ' + e.message); }
  }
  if (opts.dataset && !reports.length && !opts.quiet) warnings.push('No reports in ' + ws.name + ' use the model "' + opts.dataset + '".');
  return { workspace: ws.name, reports: names, files, warnings, skipped: all.length - reports.length };
}

/** The parts of an item definition as files under root; only text parts the tool reads. */
function partsToFiles(def, root) {
  const out = [];
  for (const p of (def.definition && def.definition.parts) || []) {
    if (!/\.(json|pbir|pbism|tmdl|bim)$/i.test(p.path) || /^StaticResources\//i.test(p.path) || /^\.pbi\//i.test(p.path)) continue;
    out.push({ path: root + '/' + p.path, text: Buffer.from(p.payload, 'base64').toString('utf8') });
  }
  return out;
}

/**
 * Every semantic model in one or more workspaces, each with the reports in those workspaces that use it. A report
 * whose model is in another workspace is followed there: that model is read too, with only the chosen reports.
 * opts: {workspace: name, id, several separated by commas, or "*" (every workspace you can open), onModel(model)
 * called as each one is ready}
 * → {models: [{workspace, workspaceId, name, id, files, reports: [names], warnings, outside}], warnings}
 */
async function workspaceModels(opts) {
  const pbi = token('https://analysis.windows.net/powerbi/api', 'SMO_POWERBI_TOKEN');
  const fab = token('https://api.fabric.microsoft.com', 'SMO_FABRIC_TOKEN');
  const want = String(opts.workspace || '').trim();
  if (!want) throw new Error('Give the name or id of the workspace, or * for every workspace.');
  const groups = (await (await call(PBI + '/groups?$top=5000', pbi)).json()).value || [];
  const names = want === '*' ? null : new Set(want.split(/\s*[;,]\s*/).map(s => s.toLowerCase()));
  const chosen = names ? groups.filter(g => names.has(g.id.toLowerCase()) || names.has(String(g.name).toLowerCase())) : groups;
  if (names && !chosen.length) throw new Error('Workspace "' + want + '" not found among the ' + groups.length + ' workspaces you can open.');
  const out = { models: [], warnings: [] };
  const lower = s => String(s || '').toLowerCase();
  // the reports of the chosen workspaces, by the model they use: workspace of the model | model
  const byModel = new Map(), todo = [];
  for (const ws of chosen) {
    let sets, reps;
    try {
      sets = (await (await call(`${PBI}/groups/${ws.id}/datasets`, pbi)).json()).value || [];
      reps = ((await (await call(`${PBI}/groups/${ws.id}/reports`, pbi)).json()).value || []).filter(r => r.reportType !== 'PaginatedReport');
    } catch (e) { out.warnings.push(ws.name + ': ' + e.message); continue; }
    for (const d of sets) todo.push({ ws, d });
    for (const r of reps) {
      if (!r.datasetId) continue;
      const k = lower(r.datasetWorkspaceId || ws.id) + '|' + lower(r.datasetId);
      if (!byModel.has(k)) byModel.set(k, []);
      byModel.get(k).push({ ws, r });
    }
  }
  // models in other workspaces that chosen reports use
  const have = new Set(todo.map(x => lower(x.ws.id) + '|' + lower(x.d.id)));
  for (const [k, list] of byModel) {
    if (have.has(k)) continue;
    const [wsId, dsId] = k.split('|');
    const which = list.map(x => x.ws.name + ' / ' + x.r.name).join(', ');
    const ws = groups.find(g => lower(g.id) === wsId);
    if (!ws) { out.warnings.push(which + ': its model is in a workspace you cannot open'); continue; }
    try { todo.push({ ws, d: await (await call(`${PBI}/groups/${ws.id}/datasets/${dsId}`, pbi)).json(), outside: true }); }
    catch (e) { out.warnings.push(which + ': ' + e.message); }
  }
  for (const { ws, d, outside } of todo) {
    if (/^(Report Usage Metrics Model|Usage Metrics Report)$/i.test(d.name)) continue;
    const m = { workspace: ws.name, workspaceId: ws.id, name: d.name, id: d.id, files: [], reports: [], warnings: [], outside: !!outside };
    const root = `fabric/${safe(ws.name)}/${safe(d.name)}`;
    try {
      const def = await waitFor(await call(`${FABRIC}/workspaces/${ws.id}/semanticModels/${d.id}/getDefinition?format=TMDL`, fab, { method: 'POST' }), fab);
      m.files.push(...partsToFiles(def, root + '/' + safe(d.name) + '.SemanticModel'));
    } catch (e) { out.warnings.push(ws.name + ' / ' + d.name + ': ' + e.message); continue; }
    for (const { ws: rws, r } of byModel.get(lower(ws.id) + '|' + lower(d.id)) || []) {
      // a report from another workspace than its model is named after its own workspace too
      const name = rws.id === ws.id ? r.name : rws.name + ' - ' + r.name;
      try {
        const def = await waitFor(await call(`${FABRIC}/workspaces/${rws.id}/reports/${r.id}/getDefinition`, fab, { method: 'POST' }), fab);
        m.files.push(...partsToFiles(def, root + '/' + safe(name) + '.Report'));
        m.reports.push(name);
      } catch (e) { m.warnings.push('report ' + name + ': ' + e.message); }
    }
    out.models.push(m);
    // handled one by one, so a whole tenant does not have to fit in memory at once
    if (opts.onModel) { await opts.onModel(m); m.files = null; }
  }
  return out;
}

/**
 * How often each report was opened, from the Power BI activity log. Needs the Fabric administrator role.
 * days: how far back (the log keeps about 30 days). → {days, views: {report name: count}, users: {report name: distinct users}}
 */
async function reportViews(days) {
  const pbi = token('https://analysis.windows.net/powerbi/api', 'SMO_POWERBI_TOKEN');
  days = Math.min(30, Math.max(1, Number(days) || 30));
  const views = {}, users = {};
  for (let d = 0; d < days; d++) {
    const day = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    let url = `${PBI}/admin/activityevents?startDateTime='${day}T00:00:00'&endDateTime='${day}T23:59:59'&$filter=Activity eq 'ViewReport'`;
    for (let page = 0; url && page < 200; page++) {
      const j = await (await call(url, pbi)).json();
      for (const e of j.activityEventEntities || []) {
        const name = e.ReportName || e.ArtifactName; if (!name) continue;
        views[name] = (views[name] || 0) + 1;
        (users[name] = users[name] || new Set()).add(e.UserId || '');
      }
      url = j.lastResultSet ? null : j.continuationUri;
    }
  }
  return { days, views, users: Object.fromEntries(Object.entries(users).map(([k, v]) => [k, v.size])) };
}

module.exports = { workspaceReports, workspaceModels, reportViews };
