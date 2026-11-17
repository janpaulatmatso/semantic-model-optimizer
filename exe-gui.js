/* Makes a copy of the executable that runs as a Windows application instead of a console program: no black window
 * appears when you start it. Only the "subsystem" field in the file header changes (3 = console, 2 = windows).
 * The copy has no console, so the command line ("cli") needs the console version. */
'use strict';
const fs = require('fs');

function guiCopy(src, dst) {
  const b = fs.readFileSync(src);
  if (b.readUInt16LE(0) !== 0x5A4D) throw new Error('Not a Windows executable: ' + src);
  const pe = b.readUInt32LE(0x3C);
  if (b.readUInt32LE(pe) !== 0x00004550) throw new Error('No PE header in ' + src);
  const optional = pe + 24, subsystem = optional + 68;
  const was = b.readUInt16LE(subsystem);
  if (was !== 2 && was !== 3) throw new Error('Unexpected subsystem ' + was + ' in ' + src);
  b.writeUInt16LE(2, subsystem);
  fs.writeFileSync(dst, b);
  return was;
}

module.exports = { guiCopy };
