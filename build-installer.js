#!/usr/bin/env node
/* Builds the Windows installer dist/SemanticModelOptimizer-Setup.exe from dist/SemanticModelOptimizer.exe.
 *   node build-exe.js && node build-installer.js
 * Needs Inno Setup 6 (ISCC.exe); the release workflow installs it on GitHub. Set ISCC to its path if it is elsewhere.
 * Also writes dist/smo.ico (the icon), dist/app/SemanticModelOptimizer.exe (the program without a console window, which
 * the installer installs) and dist/SemanticModelOptimizer-cli.exe (the console build, for the command line). */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const root = __dirname, dist = path.join(root, 'dist');
const exe = path.join(dist, 'SemanticModelOptimizer.exe');
if (!fs.existsSync(exe)) { console.error('Build the executable first: node build-exe.js'); process.exit(2); }
const version = String(process.env.SMO_VERSION || require('./package.json').version).replace(/^v/, '');

const { ico } = require('./icon.js');

fs.writeFileSync(path.join(dist, 'smo.ico'), ico([16, 24, 32, 48, 64, 256]));
// the program people start runs as a Windows application (no console window); the console build stays for the command line
fs.mkdirSync(path.join(dist, 'app'), { recursive: true });
require('./exe-gui.js').guiCopy(exe, path.join(dist, 'app', 'SemanticModelOptimizer.exe'));
fs.copyFileSync(exe, path.join(dist, 'SemanticModelOptimizer-cli.exe'));
const candidates = [process.env.ISCC, 'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe', 'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe')].filter(Boolean);
const iscc = candidates.find(p => fs.existsSync(p));
if (!iscc) { console.error('Inno Setup 6 (ISCC.exe) not found. Install it, or set ISCC to its path. The icon is written to dist/smo.ico.'); process.exit(2); }
execFileSync(iscc, ['/Q', '/DAppVersion=' + version, '/DSourceDir=' + dist, path.join(root, 'installer.iss')], { stdio: 'inherit', cwd: root });
const out = path.join(dist, 'SemanticModelOptimizer-Setup.exe');
console.log('Built ' + out + ' version ' + version + ' (' + Math.round(fs.statSync(out).size / 1048576) + ' MB).');
