/* Semantic Model Optimizer — export to CSV, Excel (.xlsx) and PDF.
 * No dependencies: the xlsx is a hand-built zip of XML parts, the PDF uses the standard Helvetica fonts.
 * Works in the browser (window.SMOExport) and in Node 18+ (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SMOExport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const enc = new TextEncoder();

  async function deflate(bytes, format) {
    const cs = new CompressionStream(format);
    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
    return new Uint8Array(buf);
  }
  function concat(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // ---------------------------------------------------------------- CSV

  /** table: {head: [], rows: [[]]} → text with BOM so Excel reads UTF-8 */
  function toCsv(table) {
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    return '﻿' + [table.head].concat(table.rows).map(r => r.map(q).join(',')).join('\r\n');
  }

  // ---------------------------------------------------------------- ZIP writer

  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

  /** files: [{name, text}] → Uint8Array (zip, deflated) */
  async function zip(files) {
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = enc.encode(f.text), comp = await deflate(data, 'deflate-raw'), crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 8, true);
      lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, comp.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 8, true);
      ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, comp.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      parts.push(new Uint8Array(lh.buffer), name, comp);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + comp.length;
    }
    const cd = concat(central);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cd.length, true); end.setUint32(16, offset, true);
    return concat(parts.concat([cd, new Uint8Array(end.buffer)]));
  }

  // ---------------------------------------------------------------- Excel

  const xml = s => String(s).replace(/[^\x09\x0A\x0D\x20-퟿-�]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function colName(i) { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; }

  function sheetXml(sheet) {
    const rows = [sheet.head].concat(sheet.rows);
    const widths = sheet.head.map((h, c) => {
      let w = String(h).length + 2;
      for (let r = 0; r < Math.min(sheet.rows.length, 400); r++) { const v = sheet.rows[r][c]; if (v != null) w = Math.max(w, Math.min(60, String(v).split('\n')[0].length + 2)); }
      return w;
    });
    let out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols><sheetData>';
    rows.forEach((r, ri) => {
      out += `<row r="${ri + 1}">`;
      r.forEach((v, ci) => {
        if (v == null || v === '') return;
        const ref = colName(ci) + (ri + 1), style = ri === 0 ? ' s="1"' : '';
        if (typeof v === 'number' && isFinite(v)) out += `<c r="${ref}"${style}><v>${v}</v></c>`;
        else out += `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(String(v).slice(0, 32000))}</t></is></c>`;
      });
      out += '</row>';
    });
    out += '</sheetData>' + (sheet.rows.length ? `<autoFilter ref="A1:${colName(sheet.head.length - 1)}${rows.length}"/>` : '') + '</worksheet>';
    return out;
  }

  /** sheets: [{name, head: [], rows: [[]]}] → Uint8Array (.xlsx) */
  function toXlsx(sheets) {
    const safe = n => xml(String(n).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
    const files = [
      { name: '[Content_Types].xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>' },
      { name: '_rels/.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
          sheets.map((s, i) => `<sheet name="${safe(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
          `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { name: 'xl/styles.xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>' },
    ].concat(sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(s) })));
    return zip(files);
  }

  // ---------------------------------------------------------------- PDF

  // widths of Helvetica for characters 32..126 (units of 1/1000 em)
  const HW = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
  const WIN = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, '‰': 0x89, 'Š': 0x8A, '‹': 0x8B, 'Œ': 0x8C, 'Ž': 0x8E,
    '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99, 'š': 0x9A, '›': 0x9B, 'œ': 0x9C, 'ž': 0x9E, 'Ÿ': 0x9F };
  /** text → WinAnsi codes (what the standard PDF fonts understand) */
  function winAnsi(s) {
    const out = [];
    for (const ch of String(s).replace(/→/g, '->').replace(/←/g, '<-').replace(/[\r\n\t]+/g, ' ')) {
      const c = ch.codePointAt(0);
      if (c >= 0x20 && c <= 0x7E) out.push(c);
      else if (c >= 0xA0 && c <= 0xFF) out.push(c);
      else if (WIN[ch]) out.push(WIN[ch]);
      else out.push(0x3F);
    }
    return out;
  }
  const cw = (c, bold) => (c >= 32 && c <= 126 ? HW[c - 32] : c === 0x85 ? 1000 : 556) * (bold ? 1.06 : 1);
  const textW = (codes, size, bold) => codes.reduce((a, c) => a + cw(c, bold), 0) * size / 1000;
  function fit(text, width, size, bold) {
    let codes = winAnsi(text);
    if (textW(codes, size, bold) <= width) return codes;
    while (codes.length > 1 && textW(codes, size, bold) + size > width) codes.pop();
    codes.push(0x85);
    return codes;
  }
  const hex = codes => '<' + codes.map(c => c.toString(16).padStart(2, '0')).join('') + '>';

  /**
   * doc: {title, lines: [], columns: [{label, weight, align?}], rows: [[]], rowColors?: [[r,g,b]|null], colorCol?}
   * → Uint8Array (A4 landscape, table with repeated header and page numbers)
   */
  async function toPdf(doc) {
    const PW = 842, PH = 595, M = 30, SIZE = 8, RH = 13;
    const totalW = doc.columns.reduce((a, c) => a + c.weight, 0);
    let x = M;
    const cols = doc.columns.map(c => { const w = (PW - 2 * M) * c.weight / totalW; const o = { x, w, label: c.label, right: c.align === 'right' }; x += w; return o; });
    const pages = [];
    let ops = [], y = 0;
    const txt = (codes, px, py, size, bold, color) => ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color ? color.join(' ') : '0.11 0.14 0.19'} rg ${px.toFixed(2)} ${py.toFixed(2)} Td ${hex(codes)} Tj ET`);
    const cell = (v, c, py, bold, color) => {
      const codes = fit(v == null ? '' : v, c.w - 8, SIZE, bold);
      const px = c.right ? c.x + c.w - 4 - textW(codes, SIZE, bold) : c.x + 4;
      txt(codes, px, py, SIZE, bold, color);
    };
    const header = first => {
      ops = [];
      y = PH - M;
      if (first) {
        txt(winAnsi(doc.title), M, y - 12, 15, true);
        y -= 30;
        for (const l of doc.lines || []) { txt(fit(l, PW - 2 * M, 9, false), M, y, 9, false, [0.4, 0.44, 0.52]); y -= 13; }
        y -= 6;
      }
      ops.push(`0.93 0.94 0.96 rg ${M} ${(y - RH + 3).toFixed(2)} ${PW - 2 * M} ${RH} re f`);
      for (const c of cols) cell(c.label, c, y - 6, true);
      y -= RH;
    };
    header(true);
    doc.rows.forEach((r, i) => {
      if (y - RH < M + 14) { pages.push(ops); header(false); }
      if (i % 2) ops.push(`0.975 0.978 0.985 rg ${M} ${(y - RH + 3).toFixed(2)} ${PW - 2 * M} ${RH} re f`);
      r.forEach((v, ci) => cell(v, cols[ci], y - 6, false, doc.colorCol === ci && doc.rowColors ? doc.rowColors[i] : null));
      y -= RH;
    });
    pages.push(ops);
    pages.forEach((p, i) => {
      const codes = winAnsi('Page ' + (i + 1) + ' of ' + pages.length + (doc.footer ? '   ·   ' + doc.footer : ''));
      p.push(`BT /F1 7.5 Tf 0.4 0.44 0.52 rg ${M} ${(M - 8).toFixed(2)} Td ${hex(codes)} Tj ET`);
    });

    // assemble the file: 1 catalog, 2 pages, 3+4 fonts, then per page a content stream and a page object
    const chunks = [], offsets = [];
    let pos = 0;
    const push = b => { const u = typeof b === 'string' ? enc.encode(b) : b; chunks.push(u); pos += u.length; };
    const obj = (n, body) => { offsets[n] = pos; push(`${n} 0 obj\n`); push(body); push('\nendobj\n'); };
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const kids = pages.map((p, i) => `${6 + i * 2} 0 R`).join(' ');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    for (let i = 0; i < pages.length; i++) {
      const data = await deflate(enc.encode(pages[i].join('\n')), 'deflate');
      const n = 5 + i * 2;
      offsets[n] = pos;
      push(`${n} 0 obj\n<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`); push(data); push('\nendstream\nendobj\n');
      obj(n + 1, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${n} 0 R >>`);
    }
    const count = 5 + pages.length * 2, xref = pos;
    push(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let n = 1; n < count; n++) push(String(offsets[n]).padStart(10, '0') + ' 00000 n \n');
    push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return concat(chunks);
  }

  return { toCsv, toXlsx, toPdf, zip };
});
