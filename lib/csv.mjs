// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// CSV reading that survives real exports: BOMs, UTF-16, Windows-1252, semicolons, quoted newlines.
import { readFileSync } from 'node:fs';

const CP1252 = {
  0x80: '\u20ac',
  0x82: '\u201a',
  0x83: '\u0192',
  0x84: '\u201e',
  0x85: '\u2026',
  0x86: '\u2020',
  0x87: '\u2021',
  0x88: '\u02c6',
  0x89: '\u2030',
  0x8a: '\u0160',
  0x8b: '\u2039',
  0x8c: '\u0152',
  0x8e: '\u017d',
  0x91: '\u2018',
  0x92: '\u2019',
  0x93: '\u201c',
  0x94: '\u201d',
  0x95: '\u2022',
  0x96: '\u2013',
  0x97: '\u2014',
  0x98: '\u02dc',
  0x99: '\u2122',
  0x9a: '\u0161',
  0x9b: '\u203a',
  0x9c: '\u0153',
  0x9e: '\u017e',
  0x9f: '\u0178'
};

function decodeCp1252(buf) {
  let out = '';
  for (const b of buf) out += b >= 0x80 && b <= 0x9f ? (CP1252[b] ?? '\ufffd') : String.fromCharCode(b);
  return out;
}

export function decode(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8-bom' };
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    return { text: decodeCp1252(buf), encoding: 'windows-1252' };
  }
}

// Pick the delimiter that appears most in the header line, counting only outside quotes.
export function sniffDelimiter(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false;
  for (const ch of text) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch === '\n') break;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
}

// RFC 4180 parse: quoted fields, doubled quotes, delimiters and newlines inside quotes, CRLF.
export function parse(text, delimiter = sniffDelimiter(text)) {
  const rows = [];
  let row = [],
    field = '',
    inQ = false,
    i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQ = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      inQ = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const BAD = /[\ufffd\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

// Read a file into { headers, records, encoding, delimiter, flagged } where records are objects.
export function readCsv(path) {
  return readCsvText(readFileSync(path));
}

export function readCsvText(input) {
  const { text, encoding } = typeof input === 'string' ? { text: input, encoding: 'utf-8' } : decode(input);
  const delimiter = sniffDelimiter(text);
  const rows = parse(text, delimiter);
  if (!rows.length) return { headers: [], records: [], encoding, delimiter, flagged: [] };
  const headers = rows[0].map((h) => h.trim());
  const flagged = [];
  const records = rows.slice(1).map((r, idx) => {
    const rec = {};
    headers.forEach((h, j) => {
      rec[h] = (r[j] ?? '').trim();
    });
    if (r.some((c) => BAD.test(c))) flagged.push(idx + 2);
    return rec;
  });
  return { headers, records, encoding, delimiter, flagged };
}

export function toCsv(headers, records) {
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    // A cell a spreadsheet would run as a formula (=HYPERLINK(…), @SUM, +, -, tab) is kept as text.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    // Quoted when it holds a separator any spreadsheet may split on (comma, semicolon, tab) or a line break, so
    // "Acme;=1+1" stays one cell that starts with a letter, never a second cell that starts with "=".
    return /[",;\t\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...records.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n') + '\n';
}
