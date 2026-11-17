#!/usr/bin/env node
/* Builds a portable executable: dist/SemanticModelOptimizer.exe. It contains Node itself, the tool and its
 * helper files, so it runs on a computer without Node. Uses Node's "single executable application" support.
 *
 *   node build-exe.js
 *
 * Needs Node 20 or newer and the package "postject" (the tool Node.js documents for this step); it is run with
 * npx, which downloads it the first time. The result is about as large as node.exe itself. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = __dirname;
const out = path.join(root, 'dist');
const work = path.join(out, 'build');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

// modules that run inside the executable (server side), and files that are unpacked next to them at run time
const MODULES = ['core.js', 'loader.js', 'remove.js', 'edit.js', 'fix.js', 'scan.js', 'compare.js', 'describe.js', 'workspace.js', 'serve.js', 'cli.js', 'install-external-tool.js', 'exe-main.js'];
const ASSETS = ['index.html', 'style.css', 'app.js', 'core.js', 'diagram.js', 'export.js', 'extras.js', 'i18n.js', 'cli.js', 'serve.js',
  'desktop-stats.ps1', 'xmla-model.ps1', 'xmla-query.ps1', 'xmla-values.ps1', 'xmla-write.ps1', 'README.md', 'LICENSE'];

// the version comes from SMO_VERSION (set by the release workflow) or from package.json
const version = String(process.env.SMO_VERSION || require('./package.json').version).replace(/^v/, '');
const build = version + '-' + Date.now();
const helpText = fs.readFileSync(path.join(root, 'exe-main.js'), 'utf8').split('*/')[0].replace(/^\/\* ?/, '').replace(/^ \* ?/gm, '');
fs.writeFileSync(path.join(work, 'exe-help.txt'), helpText);

// one script: every module wrapped in a function, with a small require() that knows the local ones
let bundle = "'use strict';\nconst __SMO_BUILD = " + JSON.stringify(build) + ";\nconst __SMO_VERSION = " + JSON.stringify(version) + ";\nconst __SMO_ASSETS = " + JSON.stringify(ASSETS.concat(['exe-help.txt'])) + ";\n" +
  "const __mods = {}, __cache = {};\n" +
  "const __outer = require;\n" +
  "const __disk = require('module').createRequire(process.execPath);\n" +
  "function __smoRequire(name) {\n" +
  "  const key = name.replace(/^\\.\\//, '');\n" +
  "  if (!__mods[key]) { try { return __outer(name); } catch (e) { return __disk(name); } }\n" +
  "  if (__cache[key]) return __cache[key].exports;\n" +
  "  const module = __cache[key] = { exports: {} };\n" +
  "  const dir = globalThis.__smoHome || require('path').dirname(process.execPath);\n" +
  "  __mods[key](module, module.exports, __smoRequire, require('path').join(dir, key), dir);\n" +
  "  return module.exports;\n" +
  "}\n";
for (const m of MODULES) {
  const src = fs.readFileSync(path.join(root, m), 'utf8').replace(/^#![^\n]*\n/, ''); // also with Windows line endings ("." does not match \r)
  bundle += `__mods[${JSON.stringify(m)}] = function (module, exports, require, __filename, __dirname) {\n${src}\n};\n`;
}
bundle += "__smoRequire('./exe-main.js');\n";
fs.writeFileSync(path.join(work, 'bundle.js'), bundle);

const assets = {};
for (const a of ASSETS) assets[a] = path.join(root, a);
assets['exe-help.txt'] = path.join(work, 'exe-help.txt');
// The path of the main script ends up inside the executable. On Windows, map the build folder to a drive letter
// for the duration of the build, so the path of this checkout (with the user name in it) is not published with it.
let drive = '';
if (process.platform === 'win32') {
  for (const l of 'STUVWXYZ') {
    if (fs.existsSync(l + ':/')) continue;
    try { execFileSync('subst', [l + ':', work]); drive = l + ':'; break; } catch (e) { /* try the next letter */ }
  }
}
const mainPath = drive ? drive + '/bundle.js' : path.join(work, 'bundle.js');
const config = { main: mainPath, output: path.join(work, 'sea.blob'), disableExperimentalSEAWarning: true, useCodeCache: false, assets };
fs.writeFileSync(path.join(work, 'sea-config.json'), JSON.stringify(config, null, 2));

const exe = path.join(out, 'SemanticModelOptimizer' + (process.platform === 'win32' ? '.exe' : ''));
console.log('Packing…');
try { execFileSync(process.execPath, ['--experimental-sea-config', path.join(work, 'sea-config.json')], { stdio: 'inherit' }); }
finally { if (drive) execFileSync('subst', [drive, '/d']); }
fs.copyFileSync(process.execPath, exe);
console.log('Injecting into a copy of ' + path.basename(process.execPath) + '…');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const q = p => (process.platform === 'win32' ? '"' + p + '"' : p); // the Windows shell needs quotes around paths with spaces
execFileSync(npx, ['--yes', 'postject', q(exe), 'NODE_SEA_BLOB', q(config.output), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'].concat(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
  { stdio: 'inherit', shell: process.platform === 'win32' });
fs.rmSync(work, { recursive: true, force: true });
console.log('\nBuilt ' + exe + ' version ' + version + ' (' + Math.round(fs.statSync(exe).size / 1048576) + ' MB), from Node ' + process.version + '.');
