#!/usr/bin/env node
/* Start de tool lokaal: node serve.js  →  http://127.0.0.1:5273
 * Alleen bereikbaar vanaf deze computer. Via /api/load leest de pagina een map van schijf. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadPath } = require('./loader.js');

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
    const file = STATIC[url.pathname];
    if (!file) return send(404, 'Niet gevonden', 'text/plain');
    send(200, fs.readFileSync(path.join(__dirname, file)), TYPES[file.split('.').pop()]);
  } catch (e) {
    send(500, JSON.stringify({ error: e.message }), 'application/json');
  }
}).listen(PORT, '127.0.0.1', () => console.log('Semantic Model Optimizer: http://127.0.0.1:' + PORT));
