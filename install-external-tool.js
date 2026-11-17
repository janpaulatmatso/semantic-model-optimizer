#!/usr/bin/env node
/* Adds a "Semantic Model Optimizer" button to the External Tools ribbon of Power BI Desktop.
 *   node install-external-tool.js            → install
 *   node install-external-tool.js --remove   → remove
 * Power BI Desktop reads the buttons from a folder under Program Files, so run this from a terminal that
 * was started as administrator. Restart Power BI Desktop afterwards. */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const NAME = 'SemanticModelOptimizer.pbitool.json';
const base = process.env['CommonProgramFiles(x86)'] || process.env.CommonProgramFiles || 'C:\\Program Files (x86)\\Common Files';
const folder = path.join(base, 'Microsoft Shared', 'Power BI Desktop', 'External Tools');

/** A small PNG icon (a star schema: one centre, four points), built here so the repository needs no image file. */
function icon() {
  const S = 32, px = Buffer.alloc(S * S * 4);
  const dot = (cx, cy, r, c) => { for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) px.set(c, (y * S + x) * 4); };
  const line = (x0, y0, x1, y1, c) => { for (let i = 0; i <= 60; i++) { const x = Math.round(x0 + (x1 - x0) * i / 60), y = Math.round(y0 + (y1 - y0) * i / 60); px.set(c, (y * S + x) * 4); px.set(c, (y * S + x + 1) * 4); } };
  const blue = [36, 86, 214, 255], violet = [122, 79, 214, 255], grey = [120, 130, 150, 255];
  for (const [x, y] of [[6, 6], [25, 6], [6, 25], [25, 25]]) line(15, 15, x, y, grey);
  for (const [x, y] of [[6, 6], [25, 6], [6, 25], [25, 25]]) dot(x, y, 4, blue);
  dot(15.5, 15.5, 6, violet);
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xFFFFFFFF; for (const v of b) c = table[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const tool = {
  version: '1.0',
  name: 'Semantic Model Optimizer',
  description: 'Unused measures and columns, lineage, checks and a model diagram for the model you have open.',
  path: process.execPath,
  arguments: `"${path.join(__dirname, 'launch.js')}" "%server%" "%database%"`,
  iconData: 'data:image/png;base64,' + icon().toString('base64'),
};

const target = path.join(folder, NAME);
if (process.platform !== 'win32') { console.error('Power BI Desktop only runs on Windows.'); process.exit(2); }
try {
  if (process.argv.includes('--remove')) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    console.log('Removed. Restart Power BI Desktop.');
  } else {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(tool, null, 2));
    console.log('Installed: ' + target + '\nRestart Power BI Desktop; the button is under External Tools.');
  }
} catch (e) {
  const local = path.join(__dirname, NAME);
  if (!process.argv.includes('--remove')) fs.writeFileSync(local, JSON.stringify(tool, null, 2));
  console.error('Could not write to ' + folder + ' (' + e.code + ').\nStart a terminal as administrator and run this again' +
    (process.argv.includes('--remove') ? '.' : ', or copy this file there yourself:\n  ' + local));
  process.exit(1);
}
