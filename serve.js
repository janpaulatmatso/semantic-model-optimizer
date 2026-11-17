#!/usr/bin/env node
/* Start de tool lokaal: node serve.js  →  http://127.0.0.1:5273
 * Alleen bereikbaar vanaf deze computer. Via /api/load leest de pagina een map van schijf. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadPath } = require('./loader.js');
const { execFile } = require('child_process');
const { removeObjects } = require('./remove.js');
const { editObject } = require('./edit.js');

/** Regels en MB uit een geopend Power BI Desktop-bestand (alleen Windows, alleen lezen). */
function desktopStats(port) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ error: 'Uitlezen uit Power BI Desktop werkt alleen op Windows.' });
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'desktop-stats.ps1')].concat(port ? ['-Port', String(port)] : ['-List']);
    execFile('powershell.exe', args, { maxBuffer: 256 * 1024 * 1024, timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
      try { resolve(JSON.parse(stdout.slice(stdout.indexOf('{')))); }
      catch (e) { resolve({ error: 'Uitlezen mislukt: ' + String((stderr || (err && err.message) || 'geen antwoord')).trim().split(String.fromCharCode(10))[0].trim() }); }
    });
  });
}

const PORT = Number(process.env.PORT || process.argv[2] || 5273);
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/core.js': 'core.js', '/style.css': 'style.css' };
const TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css' };

http.createServer(async (req, res) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (host !== '127.0.0.1' && host !== 'localhost') { res.writeHead(403); return res.end('Alleen lokaal'); }
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
  try {
    if (url.pathname === '/api/ping') return send(200, '{"ok":true}', 'application/json');
    if (url.pathname === '/api/load') {
      const target = (url.searchParams.get('path') || '').trim().replace(/^"|"$/g, '');
      if (!target) return send(400, JSON.stringify({ error: 'Geen pad opgegeven' }), 'application/json');
      const r = await loadPath(target);
      return send(200, JSON.stringify(r), 'application/json');
    }
    if (url.pathname === '/api/edit') {
      const origin = String(req.headers.origin || '');
      if (req.method !== 'POST' || !/^application\/json/.test(String(req.headers['content-type'] || '')) ||
        !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return send(403, JSON.stringify({ error: 'Niet toegestaan' }), 'application/json');
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 20e6) throw new Error('Te groot'); }
      const j = JSON.parse(body);
      if (!j.path || !j.modelRoot || !j.sel || !j.changes) return send(400, JSON.stringify({ error: 'Onvolledig verzoek' }), 'application/json');
      try { return send(200, JSON.stringify(await editObject(String(j.path), String(j.modelRoot), j.sel, j.changes)), 'application/json'); }
      catch (e) { return send(200, JSON.stringify({ error: e.message }), 'application/json'); }
    }
    if (url.pathname === '/api/delete') {
      // alleen vanaf deze pagina zelf: een andere website kan dit niet aanroepen
      const origin = String(req.headers.origin || '');
      if (req.method !== 'POST' || !/^application\/json/.test(String(req.headers['content-type'] || '')) ||
        !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return send(403, JSON.stringify({ error: 'Niet toegestaan' }), 'application/json');
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 20e6) throw new Error('Te groot'); }
      const j = JSON.parse(body);
      const root = path.resolve(String(j.base || ''), String(j.modelRoot || ''));
      if (!j.base || !j.modelRoot || !Array.isArray(j.items)) return send(400, JSON.stringify({ error: 'Onvolledig verzoek' }), 'application/json');
      return send(200, JSON.stringify(removeObjects(root, j.items)), 'application/json');
    }
    if (url.pathname === '/api/desktop') {
      const port = parseInt(url.searchParams.get('port') || '0', 10) || 0;
      return send(200, JSON.stringify(await desktopStats(port)), 'application/json');
    }
    const file = STATIC[url.pathname];
    if (!file) return send(404, 'Niet gevonden', 'text/plain');
    send(200, fs.readFileSync(path.join(__dirname, file)), TYPES[file.split('.').pop()]);
  } catch (e) {
    send(500, JSON.stringify({ error: e.message }), 'application/json');
  }
}).listen(PORT, '127.0.0.1', () => console.log('Semantic Model Optimizer: http://127.0.0.1:' + PORT));
