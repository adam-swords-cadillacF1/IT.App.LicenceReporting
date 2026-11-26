'use strict';
// CSV downloads, for Excel and other tools. UTF-8 with a byte-order mark (so Excel reads accented names correctly),
// CRLF line ends, and every field quoted where needed (RFC 4180).
//
// A spreadsheet treats a cell starting with = + - @ (or a tab or carriage return) as a formula, so a value such as
// "=HYPERLINK(...)" from a directory could run when the file is opened. Such values get a leading apostrophe, which
// spreadsheets show as text (OWASP's CSV injection advice). lib/xlsx.js avoids the same problem with inline strings.
const FORMULA_START = /^[=+\-@\t\r]/;

function field(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  // Numbers (such as a negative change) stay numbers; only text is guarded
  if (typeof value !== 'number' && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

// columns: [{ header, key }] where key is a property name or a function of the row (as in lib/xlsx.js)
function toCsv(columns, rows) {
  const lines = [columns.map(c => field(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map(c => field(typeof c.key === 'function' ? c.key(row) : row[c.key])).join(','));
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

module.exports = { toCsv, field };
