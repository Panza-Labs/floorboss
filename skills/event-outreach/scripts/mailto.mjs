// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The outbox's two send buttons for an approved email: "Open in your mail app" (a mailto: link with the recipient,
// subject and body filled in) and "Download .eml" (an unsent message file Outlook and other mail apps open as a draft).
// Either way the user presses Send in their own mail app; floorboss sends nothing. Both carry the approved subject and
// body exactly as approved (opt-out line and sign-off included), with line breaks as CRLF.
import { createHash } from 'node:crypto';

// One plain address and nothing else: letters, digits, ".", "_", "+" and "-" before the @, a plain domain after it.
// So no name part, no comma (a second recipient), no space, no "?" or "&" (a second header), no percent sign, nothing
// outside ASCII. Anything else gets no send button; the card's Copy stays.
const LOCAL = /^[A-Za-z0-9_+-]+(\.[A-Za-z0-9_+-]+)*$/;
const DOMAIN = /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
export function plainAddress(a) {
  const s = typeof a === 'string' ? a : '';
  if (s.length > 254 || s !== s.trim()) return null;
  const at = s.lastIndexOf('@');
  if (at < 1 || s.indexOf('@') !== at) return null;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (local.length > 64 || !LOCAL.test(local) || !DOMAIN.test(domain)) return null;
  return s;
}

// A subject is one line: a line break in it would start another header in the .eml, so such a subject gets no button.
const oneLine = (s) => typeof s === 'string' && s.isWellFormed() && !/[\r\n\u0085\u2028\u2029]/.test(s);
// Every line break as CRLF (RFC 6068 §5 for mailto, RFC 5322 for the .eml).
export const crlf = (text) => String(text ?? '').replace(/\r\n|\r|\n|\u2028|\u2029|\u0085/g, '\r\n');

// The longest mailto: link offered. No limit is documented for Outlook; community reports put a working limit near
// 2,000 characters, so anything longer gets only the .eml (port-scope-2026-11-07.md, "Re-check 2026-11-19").
export const MAILTO_MAX = 1800;

// RFC 6068: each part percent-encoded as UTF-8. encodeURIComponent leaves only A-Z a-z 0-9 - _ . ! ~ * ' ( ) as
// they are, so "&", "?", "#", "%", "+", "=" and spaces in the text can never end the subject or body early.
// "'" too, so the link holds no quote of any kind, whatever page or attribute it is put in.
const enc = (s) => encodeURIComponent(s).replace(/'/g, '%27');

export function mailtoHref({ to, subject, body }) {
  const addr = plainAddress(to);
  if (!addr || !oneLine(subject ?? '')) return { href: null, why: addr ? 'subject' : 'address' };
  if (!String(body ?? '').isWellFormed()) return { href: null, why: 'text' };
  // The address is as it is: plainAddress lets through only characters RFC 6068 allows unencoded there.
  const href = `mailto:${addr}?subject=${enc(subject ?? '')}&body=${enc(crlf(body))}`;
  if (href.length > MAILTO_MAX) return { href: null, why: 'long', length: href.length };
  return { href };
}

// RFC 2047 encoded words, each under 75 characters, split on whole characters (never inside one).
function encodedSubject(subject) {
  if (/^[\x20-\x7e]*$/.test(subject) && subject.length <= 900) return subject;
  const words = [];
  let chunk = '';
  for (const ch of subject) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

// An unsent message: X-Unsent: 1 asks the mail app to open it as a draft to send. No From (the app uses the account
// it sends from), a Message-ID (one report says Outlook saves a draft only with one), and the body in base64 so no
// line of it can be read as a header or end the message.
export function emlText({ to, subject, body, id }) {
  const addr = plainAddress(to);
  if (!addr || !oneLine(subject ?? '')) return null;
  if (!String(body ?? '').isWellFormed()) return null;
  const text = crlf(body);
  const hash = createHash('sha256').update(`${addr}\n${subject}\n${text}`).digest('hex').slice(0, 24);
  const safeId = String(id || 'msg').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'msg';
  const b64 = Buffer.from(text, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return [
    `To: ${addr}`,
    `Subject: ${encodedSubject(subject ?? '')}`,
    'X-Unsent: 1',
    `Message-ID: <floorboss.${safeId}.${hash}@floorboss.invalid>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64
  ].join('\r\n');
}

// The .eml's file name for one card: its id and step, plain characters only.
export const emlName = (id, touch) => `${String(id).replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'msg'}-t${Number(touch) || 0}.eml`;
