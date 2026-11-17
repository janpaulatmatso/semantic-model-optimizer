/* Entry point of the portable executable (see build-exe.js).
 *   SemanticModelOptimizer.exe                      → starts the tool and opens it in its own window (Edge or Chrome
 *                                                     app mode); set SMO_BROWSER=1 for the normal browser instead
 *   SemanticModelOptimizer.exe open <server> <db>   → the same, on a model open in Power BI Desktop
 *   SemanticModelOptimizer.exe cli <path> --check   → the command line (every option of cli.js)
 *   SemanticModelOptimizer.exe stop                 → stops the tool that runs in the background
 *   SemanticModelOptimizer.exe version              → prints the version
 *   SemanticModelOptimizer.exe install-tool         → adds the button to Power BI Desktop (run as administrator)
 * The files the tool serves and its PowerShell helpers are packed inside the executable and unpacked to a temp folder. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

/* global __SMO_BUILD, __SMO_VERSION, __SMO_ASSETS, __smoRequire */
const sea = require('node:sea');
const home = path.join(os.tmpdir(), 'semantic-model-optimizer-' + __SMO_BUILD);
function unpack() {
  if (fs.existsSync(path.join(home, '.ready'))) return;
  fs.mkdirSync(home, { recursive: true });
  for (const name of __SMO_ASSETS) fs.writeFileSync(path.join(home, name), Buffer.from(sea.getAsset(name)));
  fs.writeFileSync(path.join(home, '.ready'), '');
}

let args = process.argv.slice(1);
if (args[0] && path.resolve(args[0]).toLowerCase() === process.execPath.toLowerCase()) args = args.slice(1);
const cmd = (args[0] || '').toLowerCase();
const PORT = Number(process.env.PORT || 5273);
process.env.SMO_EXE = '1';

const request = (method, p, headers) => new Promise(resolve => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: 800, headers: headers || {} }, res => { res.resume(); resolve(res.statusCode); });
  req.on('error', () => resolve(0));
  req.on('timeout', () => { req.destroy(); resolve(0); });
  req.end();
});

(async () => {
  unpack();
  globalThis.__smoHome = home;
  process.env.SMO_VERSION = __SMO_VERSION;
  if (cmd === 'serve') { process.argv = [process.execPath, path.join(home, 'serve.js'), String(PORT)]; return __smoRequire('./serve.js'); }
  if (cmd === 'cli') { process.argv = [process.execPath, path.join(home, 'cli.js')].concat(args.slice(1)); return __smoRequire('./cli.js'); }
  if (cmd === 'install-tool') { process.argv = [process.execPath, 'install-external-tool.js'].concat(args.slice(1)); return __smoRequire('./install-external-tool.js'); }
  if (cmd === 'stop') { const s = await request('POST', '/api/quit', { 'x-smo-quit': '1' }); console.log(s === 200 ? 'Stopped.' : 'The tool was not running.'); return; }
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') { console.log('Semantic Model Optimizer ' + __SMO_VERSION); return; }
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(fs.readFileSync(__filename ? path.join(home, 'exe-help.txt') : '', 'utf8')); return; }

  // default: make sure the server runs, then open the browser
  if ((await request('GET', '/api/ping')) !== 200) {
    // the server stops by itself a while after its window is closed
    spawn(process.execPath, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true, env: Object.assign({}, process.env, { SMO_IDLE_EXIT: process.env.SMO_IDLE_EXIT || '150' }) }).unref();
    for (let i = 0; i < 60 && (await request('GET', '/api/ping')) !== 200; i++) await new Promise(r => setTimeout(r, 150));
  }
  const [server, database] = cmd === 'open' ? args.slice(1) : [];
  const url = `http://127.0.0.1:${PORT}/` + (server ? `?server=${encodeURIComponent(server)}&database=${encodeURIComponent(database || '')}` : '');
  const how = __smoRequire('./appwindow.js').openWindow(url);
  console.log('Semantic Model Optimizer is open ' + (how === 'app' ? 'in its own window' : 'in your browser') + ': ' + url + '\nIt stops by itself a few minutes after you close it, or with: ' + path.basename(process.execPath) + ' stop');
})().catch(e => { console.error(e.message); process.exit(2); });
