#!/usr/bin/env node
/* Builds the Windows installer dist/SemanticModelOptimizer-Setup.exe from dist/SemanticModelOptimizer.exe.
 *   node build-exe.js && node build-installer.js
 * Needs Inno Setup 6 (ISCC.exe); the release workflow installs it on GitHub. Set ISCC to its path if it is elsewhere.
 * Also writes dist/smo.ico, the icon used by the installer and the shortcuts. */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const root = __dirname, dist = path.join(root, 'dist');
const exe = path.join(dist, 'SemanticModelOptimizer.exe');
if (!fs.existsSync(exe)) { console.error('Build the executable first: node build-exe.js'); process.exit(2); }
const version = String(process.env.SMO_VERSION || require('./package.json').version).replace(/^v/, '');

/** The star-schema icon (one centre, four points): RGBA pixels of the given size. */
function draw(S) {
  const px = Buffer.alloc(S * S * 4), k = S / 32;
  const plot = (x, y, c, a) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (Math.floor(y) * S + Math.floor(x)) * 4, al = (a == null ? 1 : a) * (c[3] / 255), inv = 1 - al;
    px[i] = c[0] * al + px[i] * inv; px[i + 1] = c[1] * al + px[i + 1] * inv; px[i + 2] = c[2] * al + px[i + 2] * inv; px[i + 3] = Math.min(255, 255 * al + px[i + 3] * inv);
  };
  const dot = (cx, cy, r, c) => { for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy); if (d <= r + 0.5) plot(x, y, c, Math.min(1, r + 0.5 - d)); } };
  const line = (x0, y0, x1, y1, w, c) => { const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2); for (let i = 0; i <= n; i++) dot(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, w / 2, c); };
  const blue = [36, 86, 214, 255], violet = [122, 79, 214, 255], grey = [120, 130, 150, 255];
  const pts = [[6, 6], [26, 6], [6, 26], [26, 26]].map(([x, y]) => [x * k, y * k]);
  for (const [x, y] of pts) line(16 * k, 16 * k, x, y, Math.max(1.2, 2 * k), grey);
  for (const [x, y] of pts) dot(x, y, 4.2 * k, blue);
  dot(16 * k, 16 * k, 6.2 * k, violet);
  return px;
}

/** PNG of the pixels. */
function png(S) {
  const px = draw(S);
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xFFFFFFFF; for (const v of b) c = table[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Classic icon image: 32-bit BGRA bitmap, bottom-up, followed by the AND mask. */
function dib(S) {
  const px = draw(S), head = Buffer.alloc(40), mask = Math.ceil(S / 32) * 4 * S;
  head.writeUInt32LE(40, 0); head.writeInt32LE(S, 4); head.writeInt32LE(S * 2, 8); head.writeUInt16LE(1, 12); head.writeUInt16LE(32, 14); head.writeUInt32LE(S * S * 4 + mask, 20);
  const body = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const i = (y * S + x) * 4, o = ((S - 1 - y) * S + x) * 4; body[o] = px[i + 2]; body[o + 1] = px[i + 1]; body[o + 2] = px[i]; body[o + 3] = px[i + 3]; }
  return Buffer.concat([head, body, Buffer.alloc(mask)]);
}

/** An .ico: bitmaps for the small sizes, PNG for 256 (as Windows itself does). */
function ico(sizes) {
  const imgs = sizes.map(s => (s >= 256 ? png(s) : dib(s)));
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(imgs.length, 4);
  let offset = 6 + 16 * imgs.length;
  const dir = imgs.map((img, i) => {
    const e = Buffer.alloc(16), s = sizes[i] >= 256 ? 0 : sizes[i];
    e[0] = s; e[1] = s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(img.length, 8); e.writeUInt32LE(offset, 12);
    offset += img.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...imgs]);
}

fs.writeFileSync(path.join(dist, 'smo.ico'), ico([16, 24, 32, 48, 64, 256]));
const candidates = [process.env.ISCC, 'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe', 'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe')].filter(Boolean);
const iscc = candidates.find(p => fs.existsSync(p));
if (!iscc) { console.error('Inno Setup 6 (ISCC.exe) not found. Install it, or set ISCC to its path. The icon is written to dist/smo.ico.'); process.exit(2); }
execFileSync(iscc, ['/Q', '/DAppVersion=' + version, '/DSourceDir=' + dist, path.join(root, 'installer.iss')], { stdio: 'inherit', cwd: root });
const out = path.join(dist, 'SemanticModelOptimizer-Setup.exe');
console.log('Built ' + out + ' version ' + version + ' (' + Math.round(fs.statSync(out).size / 1048576) + ' MB).');
