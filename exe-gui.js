/* Prepares the executables that are shipped (build-installer.js):
 * - guiCopy: a copy that runs as a Windows application instead of a console program, so no black window appears when
 *   you start it. The "subsystem" field in the file header changes (3 = console, 2 = windows). The copy has no console,
 *   so the command line ("cli") needs the console version.
 * - both copies lose the signature block of node.exe. Building the tool into node.exe breaks Node's own signature, but
 *   the header still points at it; Windows then sees a damaged signature ("Bad PE certificate"), and MSIX signing
 *   refuses the package. Without the block the file is simply unsigned. */
'use strict';
const fs = require('fs');

function peHeader(b, src) {
  if (b.readUInt16LE(0) !== 0x5A4D) throw new Error('Not a Windows executable: ' + src);
  const pe = b.readUInt32LE(0x3C);
  if (b.readUInt32LE(pe) !== 0x00004550) throw new Error('No PE header in ' + src);
  const optional = pe + 24, magic = b.readUInt16LE(optional);
  if (magic !== 0x10B && magic !== 0x20B) throw new Error('Unexpected optional header in ' + src);
  return { optional, certEntry: optional + (magic === 0x20B ? 112 : 96) + 4 * 8 };
}

/** Clears the pointer to the signature block (data directory 4) and the checksum. → true when there was one */
function stripSignature(b, src) {
  const h = peHeader(b, src);
  const had = b.readUInt32LE(h.certEntry) !== 0 || b.readUInt32LE(h.certEntry + 4) !== 0;
  b.writeUInt32LE(0, h.certEntry);
  b.writeUInt32LE(0, h.certEntry + 4);
  b.writeUInt32LE(0, h.optional + 64); // checksum: not checked for programs, and no longer right
  return had;
}

/** The console program, without the broken signature. */
function plainCopy(src, dst) {
  const b = fs.readFileSync(src);
  stripSignature(b, src);
  fs.writeFileSync(dst, b);
}

function guiCopy(src, dst) {
  const b = fs.readFileSync(src);
  const subsystem = peHeader(b, src).optional + 68;
  const was = b.readUInt16LE(subsystem);
  if (was !== 2 && was !== 3) throw new Error('Unexpected subsystem ' + was + ' in ' + src);
  b.writeUInt16LE(2, subsystem);
  stripSignature(b, src);
  fs.writeFileSync(dst, b);
  return was;
}

module.exports = { guiCopy, plainCopy, stripSignature };
