// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// One message as an .eml file (RFC 5322) that mail apps open as an editable draft.
// X-Unsent: 1 makes Outlook open it ready to send; Apple Mail and Thunderbird open it as a message to edit or resend.

import { MONTHS, pad } from '../../../lib/tz.mjs';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function noBreaks(name, value) {
  if (/[\r\n]/.test(value)) throw new Error(`${name} can't contain a line break.`);
  return value;
}

// "Wed, 10 Mar 2027 09:00:00 +0000"
export function rfc2822Date(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error(`"${date}" isn't a date.`);
  return (
    `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`
  );
}

// RFC 2047 encoded-words, split on whole characters so each word stays under 75 chars.
export function encodeHeaderWord(text) {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words = [];
  let chunk = '';
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

// Quoted-printable (RFC 2045): UTF-8 bytes, "=" escaped, soft breaks so no line passes 76.
export function quotedPrintable(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  return lines
    .map((line) => {
      const bytes = Buffer.from(line, 'utf8');
      const tokens = [];
      bytes.forEach((b, i) => {
        const last = i === bytes.length - 1;
        const plain = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last);
        tokens.push(plain ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`);
      });
      const out = [];
      let cur = '';
      for (const t of tokens) {
        if (cur.length + t.length > 75) {
          out.push(`${cur}=`);
          cur = '';
        }
        cur += t;
      }
      out.push(cur);
      return out.join('\r\n');
    })
    .join('\r\n');
}

export function buildEml({ from, to, subject, body, date = new Date() }) {
  if (!to) throw new Error('buildEml needs a "to" address.');
  noBreaks('To', String(to));
  noBreaks('Subject', String(subject ?? ''));
  if (from) noBreaks('From', String(from));
  const headers = [
    `To: ${to}`,
    ...(from ? [`From: ${from}`] : []),
    `Subject: ${encodeHeaderWord(String(subject ?? ''))}`,
    `Date: ${rfc2822Date(date)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    'X-Unsent: 1'
  ];
  return `${headers.join('\r\n')}\r\n\r\n${quotedPrintable(body ?? '')}\r\n`;
}

// "c001-t1.eml"
export function emlFileName(id, touch = 1) {
  const safe = String(id).replace(/[^A-Za-z0-9_-]/g, '_') || 'message';
  const t = touch === undefined || touch === null || touch === '' ? 1 : Number(touch); // 0 is a confirmation
  return `${safe}-${t === 0 ? 'confirmation' : `t${t}`}.eml`;
}
