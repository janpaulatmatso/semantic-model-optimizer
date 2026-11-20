#!/usr/bin/env node
/* Runs the tool locally: node serve.js  →  http://127.0.0.1:5273
 * Only reachable from this computer. Through /api/load the page reads a folder from disk. */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadPath, modelRootAbs } = require('./loader.js');
const { execFile } = require('child_process');
const { removeObjects } = require('./remove.js');
const { editObject } = require('./edit.js');
const { scanRepo } = require('./scan.js');
const { compareWithRef } = require('./compare.js');
const { workspaceReports, reportViews } = require('./workspace.js');
const { fixRule, removeTables, renameTable, listBackups, restoreBackup, setFolder } = require('./fix.js');

/** Rows and MB from a file open in Power BI Desktop (Windows only, read-only). */
function desktopStats(port, server, database) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ error: 'Reading from Power BI Desktop only works on Windows.' });
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'desktop-stats.ps1')].concat(server ? (database ? ['-Database', database] : []) : port ? ['-Port', String(port)] : ['-List']);
    const env = server ? Object.assign({}, process.env, { SMO_XMLA_CONN: server }) : process.env;
    execFile('powershell.exe', args, { maxBuffer: 256 * 1024 * 1024, timeout: server ? 600000 : 120000, windowsHide: !server || /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(server), env }, (err, stdout, stderr) => {
      try { resolve(JSON.parse(stdout.slice(stdout.indexOf('{')))); }
      catch (e) { resolve({ error: 'Reading failed: ' + String((stderr || (err && err.message) || 'no response')).trim().split(String.fromCharCode(10))[0].trim() }); }
    });
  });
}

/** Reads a model definition over XMLA: Analysis Services, a Power BI workspace, or an open Power BI Desktop file. */
function xmlaModel(server, database, name) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ error: 'Connecting over XMLA only works on Windows.' });
    if (!server) return resolve({ error: 'No server given.' });
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(server);
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'xmla-model.ps1')].concat(database ? ['-Database', database] : []);
    // the connection string goes through the environment, not the command line; a cloud server may show a sign-in window
    const env = Object.assign({}, process.env, { SMO_XMLA_CONN: server });
    execFile('powershell.exe', args, { maxBuffer: 512 * 1024 * 1024, timeout: local ? 120000 : 600000, windowsHide: local, env }, (err, stdout, stderr) => {
      let j;
      try { j = JSON.parse(stdout.slice(stdout.indexOf('{'))); }
      catch (e) { return resolve({ error: 'Connecting failed: ' + String((stderr || (err && err.message) || 'no answer')).trim().split(String.fromCharCode(10))[0].trim() }); }
      if (j.error || j.catalogs) return resolve(j);
      const label = (name || database || 'model').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'model';
      resolve({ files: [{ path: 'server/' + label + '/model.bim', text: JSON.stringify(j) }], warnings: [], name: label });
    });
  });
}

/** Runs one of the PowerShell helpers that take a JSON input file, with the server in the environment. */
function psWithInput(script, server, database, payload, timeout) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ error: 'This only works on Windows.' });
    const tmp = path.join(os.tmpdir(), 'smo-' + process.pid + '-' + Date.now() + '.json');
    fs.writeFileSync(tmp, JSON.stringify(payload));
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, script), '-InputFile', tmp].concat(database ? ['-Database', database] : []);
    execFile('powershell.exe', args, { maxBuffer: 256 * 1024 * 1024, timeout: timeout || 900000, windowsHide: true, env: Object.assign({}, process.env, { SMO_XMLA_CONN: server }) }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmp); } catch (e) { /* already gone */ }
      try { resolve(JSON.parse(stdout.slice(stdout.indexOf('{')))); }
      catch (e) { resolve({ error: String((stderr || (err && err.message) || 'no answer')).trim().split(String.fromCharCode(10))[0].trim() }); }
    });
  });
}

const PORT = Number(process.env.PORT || process.argv[2] || 5273);
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/core.js': 'core.js', '/style.css': 'style.css', '/diagram.js': 'diagram.js', '/export.js': 'export.js', '/powerbi.js': 'powerbi.js', '/extras.js': 'extras.js', '/i18n.js': 'i18n.js' };
const TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css' };

// started from the executable or launch.js: stop when the window has been closed for a while (the page pings every 20 s)
let lastSeen = Date.now(), active = 0;
const written = new Set(); // Power BI reports this server wrote, the only files it will open
const idle = Number(process.env.SMO_IDLE_EXIT || 0);
if (idle > 0) setInterval(() => { if (!active && Date.now() - lastSeen > idle * 1000) process.exit(0); }, 5000).unref();

http.createServer(async (req, res) => {
  lastSeen = Date.now(); active++;
  res.on('close', () => { active--; lastSeen = Date.now(); });
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (host !== '127.0.0.1' && host !== 'localhost') { res.writeHead(403); return res.end('Local only'); }
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
  try {
    if (url.pathname === '/api/ping') return send(200, JSON.stringify({ ok: true, version: process.env.SMO_VERSION || require('./package.json').version }), 'application/json');
    // lets the portable executable stop the server it started in the background; a web page cannot send this header to us
    if (url.pathname === '/api/quit' && req.method === 'POST' && req.headers['x-smo-quit'] === '1' && !req.headers.origin) { send(200, '{"ok":true}', 'application/json'); return setTimeout(() => process.exit(0), 100); }
    if (url.pathname === '/api/load') {
      const target = (url.searchParams.get('path') || '').trim();
      if (!target) return send(400, JSON.stringify({ error: 'No path given' }), 'application/json');
      const r = await loadPath(target);
      return send(200, JSON.stringify(r), 'application/json');
    }
    if (url.pathname === '/api/edit') {
      const origin = String(req.headers.origin || '');
      if (req.method !== 'POST' || !/^application\/json/.test(String(req.headers['content-type'] || '')) ||
        !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return send(403, JSON.stringify({ error: 'Not allowed' }), 'application/json');
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 20e6) throw new Error('Too large'); }
      const j = JSON.parse(body);
      if (!j.path || !j.modelRoot || !j.sel || !j.changes) return send(400, JSON.stringify({ error: 'Incomplete request' }), 'application/json');
      try { return send(200, JSON.stringify(await editObject(String(j.path), String(j.modelRoot), j.sel, j.changes)), 'application/json'); }
      catch (e) { return send(200, JSON.stringify({ error: e.message }), 'application/json'); }
    }
    if (url.pathname === '/api/delete') {
      // only from this page itself: another website cannot call this
      const origin = String(req.headers.origin || '');
      if (req.method !== 'POST' || !/^application\/json/.test(String(req.headers['content-type'] || '')) ||
        !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return send(403, JSON.stringify({ error: 'Not allowed' }), 'application/json');
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 20e6) throw new Error('Too large'); }
      const j = JSON.parse(body);
      if (!j.path || !j.modelRoot || !Array.isArray(j.items)) return send(400, JSON.stringify({ error: 'Incomplete request' }), 'application/json');
      try { return send(200, JSON.stringify(removeObjects(modelRootAbs(await loadPath(String(j.path)), j.modelRoot), j.items)), 'application/json'); }
      catch (e) { return send(200, JSON.stringify({ error: e.message }), 'application/json'); }
    }
    if (url.pathname === '/api/powerbi') {
      // writes a run for the Power BI report, or opens a report this server wrote; only from this page itself
      const origin = String(req.headers.origin || '');
      if (req.method !== 'POST' || !/^application\/json/.test(String(req.headers['content-type'] || '')) ||
        !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return send(403, JSON.stringify({ error: 'Not allowed' }), 'application/json');
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 200e6) throw new Error('Too large'); }
      const j = JSON.parse(body);
      const P = require('./powerbi.js');
      if (j.open) {
        if (!written.has(String(j.open))) return send(200, JSON.stringify({ error: 'Only a report written here can be opened.' }), 'application/json');
        execFile('explorer.exe', [String(j.open)], () => {});
        return send(200, JSON.stringify({ ok: true }), 'application/json');
      }
      const folder = String(j.folder || '').trim() || path.join(os.homedir(), 'Documents', P.NAME);
      if (!path.isAbsolute(folder)) return send(200, JSON.stringify({ error: 'Give the full path of a folder, for example C:\\SMO.' }), 'application/json');
      if (!P.validTables(j.tables)) return send(400, JSON.stringify({ error: 'Incomplete request' }), 'application/json');
      try {
        const r = P.writeRun(folder, j.tables, process.env.SMO_VERSION || require('./package.json').version);
        written.add(r.pbip);
        return send(200, JSON.stringify(Object.assign({ folder }, r)), 'application/json');
      } catch (e) { return send(200, JSON.stringify({ error: e.message }), 'application/json'); }
    }
    if (url.pathname === '/api/xmla') {
      // starts a sign-in window for cloud servers, so only this page itself may call it
      const origin = String(req.headers.origin || '');
      if (req.method !== 'POST' || !/^application\/json/.test(String(req.headers['content-type'] || '')) ||
        !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return send(403, JSON.stringify({ error: 'Not allowed' }), 'application/json');
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 1e6) throw new Error('Too large'); }
      const j = JSON.parse(body);
      return send(200, JSON.stringify(await xmlaModel(String(j.server || '').trim(), String(j.database || '').trim(), String(j.name || '').trim())), 'application/json');
    }
    // changes to files: only from this page itself, as JSON
    const post = async () => {
      const origin = String(req.headers.origin || '');
      if (req.method !== 'POST' || !/^application\/json/.test(String(req.headers['content-type'] || '')) || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return null;
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 20e6) throw new Error('Too large'); }
      return JSON.parse(body);
    };
    const routes = {
      '/api/fix': j => fixRule(String(j.path), String(j.modelRoot), String(j.rule), j.ids),
      '/api/table': j => (j.op === 'rename' ? renameTable(String(j.path), String(j.modelRoot), String(j.table), String(j.name)) : removeTables(String(j.path), String(j.modelRoot), (j.tables || []).map(String))),
      '/api/compare': j => compareWithRef(String(j.path), String(j.modelRoot), String(j.ref || '')),
      '/api/folder': j => setFolder(String(j.path), String(j.modelRoot), j.ids, j.folder),
      '/api/backups': j => listBackups(String(j.path), String(j.modelRoot)),
      '/api/restore': j => restoreBackup(String(j.path), String(j.modelRoot), String(j.stamp)),
    };
    if (routes[url.pathname]) {
      const j = await post();
      if (!j) return send(403, JSON.stringify({ error: 'Not allowed' }), 'application/json');
      if (!j.path || !j.modelRoot) return send(400, JSON.stringify({ error: 'Incomplete request' }), 'application/json');
      try { const r = await routes[url.pathname](j); delete r.analysis; return send(200, JSON.stringify(r), 'application/json'); }
      catch (e) { return send(200, JSON.stringify({ error: e.message }), 'application/json'); }
    }
    if (url.pathname === '/api/activity') {
      const j = await post();
      if (!j) return send(403, JSON.stringify({ error: 'Not allowed' }), 'application/json');
      try { return send(200, JSON.stringify(await reportViews(j.days)), 'application/json'); }
      catch (e) { return send(200, JSON.stringify({ error: e.message }), 'application/json'); }
    }
    if (url.pathname === '/api/workspace') {
      const j = await post();
      if (!j) return send(403, JSON.stringify({ error: 'Not allowed' }), 'application/json');
      try { return send(200, JSON.stringify(await workspaceReports({ workspace: j.workspace, dataset: j.dataset })), 'application/json'); }
      catch (e) { return send(200, JSON.stringify({ error: e.message }), 'application/json'); }
    }
    if (url.pathname === '/api/query') {
      const j = await post();
      if (!j || !j.server) return send(403, JSON.stringify({ error: 'Not allowed' }), 'application/json');
      return send(200, JSON.stringify(await psWithInput('xmla-query.ps1', String(j.server), String(j.database || ''), j.queries || [], 3600000)), 'application/json');
    }
    if (url.pathname === '/api/values' || url.pathname === '/api/live') {
      const j = await post();
      if (!j || !j.server) return send(403, JSON.stringify({ error: 'Not allowed' }), 'application/json');
      const live = url.pathname === '/api/live';
      return send(200, JSON.stringify(await psWithInput(live ? 'xmla-write.ps1' : 'xmla-values.ps1', String(j.server), String(j.database || ''), live ? (j.ops || []) : (j.measures || []), live ? 120000 : 1800000)), 'application/json');
    }
    if (url.pathname === '/api/stats') {
      const j = await post();
      if (!j || !j.server) return send(403, JSON.stringify({ error: 'Not allowed' }), 'application/json');
      return send(200, JSON.stringify(await desktopStats(0, String(j.server), String(j.database || ''))), 'application/json');
    }
    if (url.pathname === '/api/scan') {
      try { return send(200, JSON.stringify(scanRepo(url.searchParams.get('path') || '')), 'application/json'); }
      catch (e) { return send(200, JSON.stringify({ error: e.message }), 'application/json'); }
    }
    if (url.pathname === '/api/desktop') {
      const port = parseInt(url.searchParams.get('port') || '0', 10) || 0;
      return send(200, JSON.stringify(await desktopStats(port)), 'application/json');
    }
    if (url.pathname === '/icon.png' || url.pathname === '/favicon.ico') {
      const icon = require('./icon.js');
      const body = url.pathname === '/icon.png' ? icon.png(256) : icon.ico([16, 32, 48, 256]);
      res.writeHead(200, { 'Content-Type': url.pathname === '/icon.png' ? 'image/png' : 'image/x-icon', 'Cache-Control': 'max-age=86400' });
      return res.end(body);
    }
    const file = STATIC[url.pathname];
    if (!file) return send(404, 'Not found', 'text/plain');
    send(200, fs.readFileSync(path.join(__dirname, file)), TYPES[file.split('.').pop()]);
  } catch (e) {
    send(500, JSON.stringify({ error: e.message }), 'application/json');
  }
}).listen(PORT, '127.0.0.1', () => console.log('Semantic Model Optimizer: http://127.0.0.1:' + PORT));
