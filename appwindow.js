/* Opens the tool in its own window, like a desktop app: Microsoft Edge (or Chrome) in app mode, without
 * address bar or tabs. Falls back to the default browser when neither is found, or when SMO_BROWSER=1. */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const APP_CAPABLE = /\\(msedge|chrome|brave|vivaldi|chromium)\.exe$/i;

/** The default browser of this user, when it can open an app window (Edge, Chrome, Brave, Vivaldi). */
function defaultAppBrowser() {
  try {
    const { execFileSync } = require('child_process');
    const q = args => execFileSync('reg', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const prog = (/ProgId\s+REG_SZ\s+(\S+)/.exec(q(['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice', '/v', 'ProgId'])) || [])[1];
    if (!prog) return null;
    const cmd = (/REG_(?:EXPAND_)?SZ\s+(.+)/.exec(q(['query', 'HKCR\\' + prog + '\\shell\\open\\command', '/ve'])) || [])[1] || '';
    const exe = (/^"([^"]+)"/.exec(cmd.trim()) || /^(\S+\.exe)/i.exec(cmd.trim()) || [])[1];
    return exe && APP_CAPABLE.test(exe) && fs.existsSync(exe) ? exe : null;
  } catch (e) { return null; }
}

function findAppBrowser() {
  if (process.platform !== 'win32') return null;
  const own = defaultAppBrowser();
  if (own) return own;
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const rel = [['Microsoft', 'Edge', 'Application', 'msedge.exe'], ['Google', 'Chrome', 'Application', 'chrome.exe']];
  for (const r of rel) for (const base of pf) { const p = path.join(base, ...r); if (fs.existsSync(p)) return p; }
  return null;
}

/** url: what to open. → 'app' when it opened in its own window, 'browser' otherwise. */
function openWindow(url) {
  const run = (cmd, args) => spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  const browser = process.env.SMO_BROWSER === '1' ? null : findAppBrowser();
  if (browser) {
    run(browser, ['--app=' + url, '--window-size=1500,950', '--no-first-run', '--no-default-browser-check']);
    return 'app';
  }
  if (process.platform === 'win32') run('rundll32', ['url.dll,FileProtocolHandler', url]);
  else if (process.platform === 'darwin') run('open', [url]);
  else run('xdg-open', [url]);
  return 'browser';
}

module.exports = { openWindow, findAppBrowser };
