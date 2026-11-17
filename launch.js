#!/usr/bin/env node
/* Starts the tool (if it is not running yet) and opens it in the browser.
 *   node launch.js                         → opens the tool
 *   node launch.js <server> <database>     → opens it on that model; this is what the External Tools
 *                                            button in Power BI Desktop calls (see install-external-tool.js) */
'use strict';
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 5273);
const [server, database] = process.argv.slice(2);
const url = `http://127.0.0.1:${PORT}/` + (server ? `?server=${encodeURIComponent(server)}&database=${encodeURIComponent(database || '')}` : '');

const ping = () => new Promise(resolve => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/ping', timeout: 800 }, res => { res.resume(); resolve(res.statusCode === 200); });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
});
const { openWindow } = require('./appwindow.js');
(async () => {
  if (!(await ping())) {
    spawn(process.execPath, [path.join(__dirname, 'serve.js'), String(PORT)], { detached: true, stdio: 'ignore', windowsHide: true, env: Object.assign({}, process.env, { SMO_IDLE_EXIT: process.env.SMO_IDLE_EXIT || '150' }) }).unref();
    for (let i = 0; i < 40 && !(await ping()); i++) await new Promise(r => setTimeout(r, 150));
  }
  openWindow(url);
})();
