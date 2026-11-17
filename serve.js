#!/usr/bin/env node
/* Runs the tool locally: node serve.js  →  http://127.0.0.1:5273
 * Only reachable from this computer. Through /api/load the page reads a folder from disk. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadPath, modelRootAbs } = require('./loader.js');
const { execFile } = require('child_process');
const { removeObjects } = require('./remove.js');
const { editObject } = require('./edit.js');
const { scanRepo } = require('./scan.js');

/** Rows and MB from a file open in Power BI Desktop (Windows only, read-only). */
function desktopStats(port) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ error: 'Reading from Power BI Desktop only works on Windows.' });
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'desktop-stats.ps1')].concat(port ? ['-Port', String(port)] : ['-List']);
    execFile('powershell.exe', args, { maxBuffer: 256 * 1024 * 1024, timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
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

const PORT = Number(process.env.PORT || process.argv[2] || 5273);
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/core.js': 'core.js', '/style.css': 'style.css', '/diagram.js': 'diagram.js', '/export.js': 'export.js' };
const TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css' };

http.createServer(async (req, res) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (host !== '127.0.0.1' && host !== 'localhost') { res.writeHead(403); return res.end('Local only'); }
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
  try {
    if (url.pathname === '/api/ping') return send(200, '{"ok":true}', 'application/json');
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
    if (url.pathname === '/api/scan') {
      try { return send(200, JSON.stringify(scanRepo(url.searchParams.get('path') || '')), 'application/json'); }
      catch (e) { return send(200, JSON.stringify({ error: e.message }), 'application/json'); }
    }
    if (url.pathname === '/api/desktop') {
      const port = parseInt(url.searchParams.get('port') || '0', 10) || 0;
      return send(200, JSON.stringify(await desktopStats(port)), 'application/json');
    }
    const file = STATIC[url.pathname];
    if (!file) return send(404, 'Not found', 'text/plain');
    send(200, fs.readFileSync(path.join(__dirname, file)), TYPES[file.split('.').pop()]);
  } catch (e) {
    send(500, JSON.stringify({ error: e.message }), 'application/json');
  }
}).listen(PORT, '127.0.0.1', () => console.log('Semantic Model Optimizer: http://127.0.0.1:' + PORT));
