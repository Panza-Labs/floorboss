// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Do-not-contact entries: email, domain, company or name, each with an optional "until" date.
// Parsing fails closed: every address on a line counts, and a bare date is never read as an expiry.
import { normPersonName, companyKey, emailsIn } from '../../../lib/normalize.mjs';
import { parse, sniffDelimiter } from '../../../lib/csv.mjs';
import { parseDate } from './sources.mjs';

const HEADER_CELL =
  /^(value|email|e-?mail( address)?|entry|name|full name|contact|person|company|organi[sz]ation|who|dnc|exclude|exclusions?|block ?list|suppression( list)?|until|expires?|expiry( date)?|end( date)?|valid until|date( added)?|added|since|reason|notes?|source|owner)$/i;
const EXPIRY_HEAD = /^(until|expires?|expiry( date)?|ends?|end date|valid until|through|thru)$/i;
const DATE_ONLY = /^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.]\d{1,2}[/.]\d{4})$/;

function isHeader(cells) {
  const filled = cells.map((s) => s.trim()).filter(Boolean);
  return (
    filled.length > 0 &&
    !emailsIn(filled.join(' ')).length &&
    (filled.some((c) => HEADER_CELL.test(c) || /^(id|record id)$/i.test(c)) || /^do not\b/i.test(filled[0]))
  );
}

// One cell → an entry, or null for a date, a note, an ID or an empty cell.
function cellEntry(raw, until) {
  const value = String(raw ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!value || DATE_ONLY.test(value) || /^until\b/i.test(value) || /^\d+$/.test(value)) return null;
  // "*@globex.example" or "@globex.example" means the whole domain.
  const wild = /^\*?@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(value);
  if (wild) return { type: 'domain', value: wild[1].toLowerCase().replace(/^www\./, ''), until };
  const dom = value
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(dom) && !/\s/.test(value)) return { type: 'domain', value: dom, until };
  // "company: Acme" or a value with a legal form ("Acme GmbH") means everyone at that company.
  const co = /^company\s*[:=]\s*(.+)$/i.exec(value);
  if (co) return { type: 'company', value: companyKey(co[1]), label: co[1], until };
  if (companyKey(value) !== normPersonName(value).replace(/\s+/g, ' ') && companyKey(value).split(' ').length < normPersonName(value).split(' ').length)
    return { type: 'company', value: companyKey(value), label: value, until };
  if (!/\p{L}/u.test(value)) return null;
  return { type: 'name', value: normPersonName(value), label: value, until };
}

// One row's cells → entries. cols: what each column holds when a header said so ({ email, name, company,
// domain, expiry, skip }). Without a header every cell that isn't a date counts: a name and a company on
// one line block both, which errs towards leaving people alone.
export function parseDncCells(cells, { expiryCol = -1, cols = null } = {}) {
  cells = cells.map((s) => String(s ?? '').trim());
  const filled = cells.filter(Boolean);
  if (!filled.length || filled[0].startsWith('#')) return { entries: [], undatedDates: 0, ambiguousDates: 0 };
  let until = null,
    undatedDates = 0,
    ambiguousDates = 0;
  cells.forEach((p, i) => {
    const mt = /^until[=:\s]*(.+)$/i.exec(p);
    if (mt || i === expiryCol) {
      const raw = (mt ? mt[1] : p).trim();
      // 01/12/2026 is 1 December in most of the world and 12 January in the US. A do-not-contact entry never ends
      // early on a guess: of the two readings, the later one counts (and the user is told).
      const md = DATE_ONLY.test(raw) ? parseDate(raw, 'mdy') : null;
      const dm = DATE_ONLY.test(raw) ? parseDate(raw, 'dmy') : null;
      const d = md && dm ? (md > dm ? md : dm) : md || dm;
      if (md && dm && md !== dm) ambiguousDates++;
      if (d) until = d;
    } else if (DATE_ONLY.test(p)) undatedDates++;
  });
  const WILD = /^\*?@[a-z0-9.-]+\.[a-z]{2,}$/i;
  const emails = emailsIn(cells.filter((c) => !WILD.test(c)).join(' '));
  const entries = emails.map((value) => ({ type: 'email', value, until }));
  const rest = cells
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => c && i !== expiryCol && !(cols?.skip || []).includes(i) && (WILD.test(c) || !emailsIn(c).length));
  for (const { c, i } of rest) {
    const e = cellEntry(c, until);
    if (!e) continue;
    // A header names what a column holds: a "Company" column is a company even without a legal form.
    if (cols?.company === i && e.type === 'name') entries.push({ type: 'company', value: companyKey(c), label: c, until });
    else if (cols?.name === i && e.type === 'company') entries.push({ type: 'name', value: normPersonName(c), label: c, until });
    else entries.push(e);
  }
  // "Fox, Di" on a line with no header: two one-word cells are also read as one name, surname first.
  const words = cells.filter(Boolean);
  if (!cols && !emails.length && words.length === 2 && words.every((w) => /^[\p{L}'-]+(\s*\([^)]*\))?$/u.test(w)))
    entries.push({ type: 'name', value: normPersonName(`${words[0]}, ${words[1]}`), label: `${words[0]}, ${words[1]}`, until });
  return { entries, undatedDates, ambiguousDates };
}

export function parseDncLine(line) {
  const rows = parse(String(line), sniffDelimiter(String(line)));
  if (!rows.length || isHeader(rows[0])) return null;
  return parseDncCells(rows[0]).entries[0] || null;
}

// The whole list, with notes for the user: dates that weren't read as expiries, entries already expired.
export function parseDncReport(text, { today = null } = {}) {
  const src = String(text ?? '')
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  const rows = parse(src, sniffDelimiter(src));
  let expiryCol = -1,
    start = 0;
  let cols = null;
  if (rows.length && isHeader(rows[0])) {
    const h = rows[0].map((x) => x.trim());
    expiryCol = h.findIndex((x) => EXPIRY_HEAD.test(x));
    const at = (re) => h.findIndex((x) => re.test(x));
    cols = {
      company: at(/^(company|organi[sz]ation|account|firm|employer)( name)?$/i),
      name: at(/^(name|full name|contact|person|who)$/i),
      skip: h.map((x, i) => (/^(id|record id|reason|notes?|source|owner|added|date( added)?|since|created( by| at)?)$/i.test(x) ? i : -1)).filter((i) => i >= 0)
    };
    start = 1;
  }
  const entries = [];
  let undated = 0,
    ambiguous = 0;
  for (const r of rows.slice(start)) {
    const out = parseDncCells(r, { expiryCol, cols });
    entries.push(...out.entries);
    undated += out.undatedDates;
    ambiguous += out.ambiguousDates;
  }
  const notes = [];
  if (ambiguous)
    notes.push(
      `${ambiguous} expiry date${ambiguous === 1 ? '' : 's'} on the do-not-contact list could be day/month or month/day (01/12/2026 is 1 December or 12 January). floorboss reads the later date, so nobody comes back early. Write dates as 2026-12-01 to be exact.`
    );
  if (undated)
    notes.push(
      `${undated} date${undated === 1 ? '' : 's'} on the do-not-contact list weren't read as expiry dates (a "date added" column looks the same). Those entries never expire. To set an expiry, write "until 2026-12-31" or name the column "until".`
    );
  const expired = today ? entries.filter((e) => e.until && e.until < today) : [];
  if (expired.length)
    notes.push(
      `${expired.length} do-not-contact entr${expired.length === 1 ? 'y has' : 'ies have'} expired and no longer block anyone: ${expired
        .slice(0, 5)
        .map((e) => e.label || e.value)
        .join(', ')}${expired.length > 5 ? ', …' : ''}.`
    );
  return { entries, notes };
}

export function isActive(entry, today) {
  return !entry.until || entry.until >= today;
}
