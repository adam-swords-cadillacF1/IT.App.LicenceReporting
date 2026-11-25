'use strict';
// Minimal .xlsx writer using only Node's built-in zlib, so the app needs no spreadsheet package.
// Supports what the reports need: several sheets, a few title lines, a bold header row with a filter,
// frozen panes, column widths, and text or number cells. Text is written as inline strings, which Excel
// never evaluates, so a value such as "=cmd|..." from AD stays text (no formula injection).
const zlib = require('node:zlib');

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
// Characters XML 1.0 can't hold (control characters, lone surrogates, U+FFFE/FFFF) are dropped
const INVALID_XML = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const xml = v => String(v ?? '').replace(INVALID_XML, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const colName = i => { let s = ''; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
const ref = (r, c) => `${colName(c)}${r + 1}`;

// Sheet names: at most 31 characters, none of []:*?/\ , not starting or ending with ', unique (case-insensitive)
function sheetNames(names) {
  const used = new Set();
  return names.map(raw => {
    const base = (String(raw).replace(/[[\]:*?/\\]/g, '-').replace(/^'+|'+$/g, '').trim() || 'Sheet').slice(0, 31);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)}~${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

// Styles: 0 normal, 1 header (bold, shaded, border below), 2 title (bold, larger), 3 note (italic grey)
const STYLES = `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="14"/><name val="Calibri"/><family val="2"/></font><font><i/><sz val="10"/><color rgb="FF595959"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF8EA9DB"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function cell(r, c, value, style = 0) {
  const s = style ? ` s="${style}"` : '';
  if (value === null || value === undefined || value === '') return style ? `<c r="${ref(r, c)}"${s}/>` : '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref(r, c)}"${s}><v>${value}</v></c>`;
  return `<c r="${ref(r, c)}"${s} t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

// sheet: { name, title?, notes?: [string], columns: [{ header, key, width? }], rows: [object] }
function sheetXml(sheet) {
  const lines = [];
  let r = 0;
  if (sheet.title) lines.push(`<row r="${++r}">${cell(r - 1, 0, sheet.title, 2)}</row>`);
  for (const note of sheet.notes || []) lines.push(`<row r="${++r}">${cell(r - 1, 0, note, 3)}</row>`);
  if (r) r++;   // blank line between the notes and the table
  const headerRow = r;
  const cols = sheet.columns;
  lines.push(`<row r="${headerRow + 1}">${cols.map((c, i) => cell(headerRow, i, c.header, 1)).join('')}</row>`);
  sheet.rows.forEach((row, n) => {
    const rr = headerRow + 1 + n;
    lines.push(`<row r="${rr + 1}">${cols.map((c, i) => cell(rr, i, typeof c.key === 'function' ? c.key(row) : row[c.key])).join('')}</row>`);
  });
  const lastRow = headerRow + Math.max(sheet.rows.length, 1);
  const range = `${ref(headerRow, 0)}:${ref(lastRow, cols.length - 1)}`;
  const widths = cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 18}" customWidth="1"/>`).join('');
  const pane = `<pane ySplit="${headerRow + 1}" topLeftCell="${ref(headerRow + 1, 0)}" activePane="bottomLeft" state="frozen"/>`;
  return {
    filterRange: range,
    headerRow,
    body: `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0">${pane}<selection pane="bottomLeft" activeCell="${ref(headerRow + 1, 0)}" sqref="${ref(headerRow + 1, 0)}"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/><cols>${widths}</cols>
<sheetData>${lines.join('')}</sheetData>
<autoFilter ref="${range}"/>
<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`,
  };
}

// ── ZIP (stored with deflate; CRC-32 from zlib) ──────────────────────────────

function zip(files) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const raw = Buffer.from(data, 'utf8');
    const deflated = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, deflated);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// Builds the workbook and returns it as a Buffer
function workbook(sheets, { creator = 'Licence Reporting' } = {}) {
  if (!sheets.length) throw new Error('A workbook needs at least one sheet');
  const names = sheetNames(sheets.map(s => s.name));
  const built = sheets.map(sheetXml);
  const quoted = n => `'${n.replace(/'/g, "''")}'`;
  const absolute = range => range.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2');
  const files = [
    { name: '[Content_Types].xml', data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
</Types>` },
    { name: '_rels/.rels', data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>` },
    { name: 'docProps/core.xml', data: `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:creator>${xml(creator)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created>
</cp:coreProperties>` },
    { name: 'xl/workbook.xml', data: `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView/></bookViews>
<sheets>${names.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
<definedNames>${built.map((b, i) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xml(quoted(names[i]))}!${absolute(b.filterRange)}</definedName>`).join('')}</definedNames>
</workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
    { name: 'xl/styles.xml', data: STYLES },
    ...built.map((b, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: b.body })),
  ];
  return zip(files);
}

module.exports = { workbook, sheetNames, colName };
