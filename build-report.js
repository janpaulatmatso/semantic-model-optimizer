#!/usr/bin/env node
/* Writes the Power BI report as a template into report/, the folder in the repository that people download:
 * the same report that --export writes, but without a data folder. Whoever opens it fills in the parameter
 * ExportFolder (a folder on disk or in OneLake) and signs in to their own source. No address, id or sign-in of anyone.
 *   node build-report.js              writes report/
 *   node build-report.js --check      fails when report/ is not what this script would write
 *   node build-report.js --zip <file> also writes the template as one zip file (attached to every release) */
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./powerbi.js');
const { zip } = require('./export.js');

const dir = path.join(__dirname, 'report');
const files = () => P.projectFiles('');
const list = d => {
  const out = [];
  const walk = (x, rel) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(x, e.name), r); else out.push(r); } };
  if (fs.existsSync(d)) walk(d, '');
  return out.sort();
};

if (require.main === module) {
  const want = files();
  if (process.argv.includes('--check')) {
    const have = list(dir), names = want.map(f => f.path).sort();
    const stale = want.filter(f => !fs.existsSync(path.join(dir, f.path)) || fs.readFileSync(path.join(dir, f.path), 'utf8').replace(/\r\n/g, '\n') !== f.text)
      .map(f => f.path).concat(have.filter(f => !names.includes(f)));
    if (stale.length) { console.error('report/ is not up to date (' + stale.slice(0, 5).join(', ') + '). Run: node build-report.js'); process.exit(1); }
    console.log('report/ is up to date.');
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const f of want) { const t = path.join(dir, f.path); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, f.text); }
    console.log('Written: report/ (' + want.length + ' files)');
    const i = process.argv.indexOf('--zip');
    if (i > 0) {
      const target = process.argv[i + 1];
      zip(want.map(f => ({ name: 'Semantic Model Optimizer/' + f.path, text: f.text }))).then(b => { fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true }); fs.writeFileSync(target, b); console.log('Written: ' + target); });
    }
  }
}
module.exports = { files };
