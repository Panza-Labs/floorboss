// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Read busy times from a calendar export (.ics, RFC 5545): Google, Outlook or Apple.
// Covers the common cases: UTC, TZID and floating times, all-day events, DURATION,
// simple RRULEs (daily, weekly with BYDAY, monthly), EXDATE and RECURRENCE-ID overrides.
import { cleanText } from '../../connectors/scripts/tasks.mjs';
import { zonedToUtc, wallParts, isValidZone, dateKey, addDays, daysBetween, weekdayOf, parseDateKey } from '../../../lib/tz.mjs';

// Outlook writes Windows zone names. The common ones, mapped to IANA.
const WINDOWS_ZONES = {
  'UTC': 'UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'GTB Standard Time': 'Europe/Bucharest',
  'FLE Standard Time': 'Europe/Helsinki',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'Russian Standard Time': 'Europe/Moscow',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'Canada Central Standard Time': 'America/Regina',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'SA Pacific Standard Time': 'America/Bogota',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'E. South America Standard Time': 'America/Sao_Paulo'
};

const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const WEEKDAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const MAX_STEPS = 20000;

// Lines folded with CRLF/LF + space or tab are one logical line.
function unfold(text) {
  return String(text)
    .replace(/\r?\n[ \t]/g, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
}

// "DTSTART;TZID=Europe/Berlin:20261103T090000" → { name, params, value }
function parseLine(line) {
  let i = 0,
    quoted = false;
  for (; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) break;
  }
  const head = line.slice(0, i),
    value = line.slice(i + 1);
  const parts = head.match(/(?:[^;"]|"[^"]*")+/g) || [''];
  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: parts[0].toUpperCase(), params, value };
}

function unescapeText(s) {
  return s.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

// File text echoed in a warning: cleaned, short, quoted.
const echo = (v) => JSON.stringify(cleanText(v, 40));

function resolveZone(tzid, warn, label) {
  const z = tzid.replace(/^\/+/, '').trim();
  if (isValidZone(z)) return z;
  if (WINDOWS_ZONES[z]) return WINDOWS_ZONES[z];
  warn(`${label}: time zone ${echo(tzid)} not recognised; times read as floating.`);
  return null;
}

// One date or date-time value → { kind: 'date'|'utc'|'zoned'|'floating', parts, zone }.
function parseDateValue(value, params, ctx, label) {
  const mt = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!mt) throw new Error(`bad date "${value}"`);
  const parts = { y: +mt[1], m: +mt[2], d: +mt[3], hh: +(mt[4] || 0), mm: +(mt[5] || 0), ss: +(mt[6] || 0) };
  if (!mt[4] || params.VALUE === 'DATE') return { kind: 'date', parts: { ...parts, hh: 0, mm: 0, ss: 0 }, zone: ctx.assumeZone };
  if (mt[7]) return { kind: 'utc', parts, zone: 'UTC' };
  if (params.TZID) {
    const zone = resolveZone(params.TZID, ctx.warn, label);
    if (zone) return { kind: 'zoned', parts, zone };
  } else {
    ctx.warn(`${label}: time has no zone; read as ${ctx.assumeZone}.`);
  }
  return { kind: 'floating', parts, zone: ctx.assumeZone };
}

function toMs({ parts, zone }) {
  return zonedToUtc(parts, zone).getTime() + parts.ss * 1000;
}

function parseDuration(s) {
  const mt = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s.trim());
  if (!mt) return null;
  const days = +(mt[2] || 0) * 7 + +(mt[3] || 0);
  const ms = ((days * 24 + +(mt[4] || 0)) * 60 + +(mt[5] || 0)) * 60000 + +(mt[6] || 0) * 1000;
  return { days, ms: mt[1] === '-' ? -ms : ms, timeOnly: !mt[4] && !mt[5] && !mt[6] };
}

function parseRrule(value) {
  const rule = {};
  for (const kv of value.split(';')) {
    const eq = kv.indexOf('=');
    if (eq > 0) rule[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1).toUpperCase();
  }
  return rule;
}

// Why we can't expand this rule, or null if we can.
function unsupported(rule) {
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(rule.FREQ)) return `FREQ=${rule.FREQ || '?'}`;
  for (const k of Object.keys(rule)) {
    if (!['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST'].includes(k)) return k;
  }
  if (rule.BYDAY && (rule.FREQ !== 'WEEKLY' || rule.BYDAY.split(',').some((c) => !DAY_CODES.includes(c)))) return `BYDAY=${rule.BYDAY}`;
  if (rule.INTERVAL && !(+rule.INTERVAL >= 1)) return `INTERVAL=${rule.INTERVAL}`;
  return null;
}

// Candidate occurrence dates (date keys in the event's zone), from the start date onward.
function* candidateDates(rule, startKey) {
  const step = Math.max(1, +(rule.INTERVAL || 1));
  if (rule.FREQ === 'DAILY') {
    for (let i = 0; ; i += step) yield addDays(startKey, i);
  }
  if (rule.FREQ === 'WEEKLY') {
    const startIdx = WEEKDAY_INDEX[weekdayOf(startKey)];
    const offsets = rule.BYDAY ? [...new Set(rule.BYDAY.split(',').map((c) => DAY_CODES.indexOf(c)))].sort((a, b) => a - b) : [startIdx];
    const monday = addDays(startKey, -startIdx);
    if (!offsets.includes(startIdx)) yield startKey; // DTSTART always counts
    for (let w = 0; ; w += step) {
      for (const off of offsets) {
        const key = addDays(monday, w * 7 + off);
        if (key >= startKey) yield key;
      }
    }
  }
  if (rule.FREQ === 'MONTHLY') {
    const { y, m, d } = parseDateKey(startKey);
    for (let i = 0; ; i += step) {
      const t = new Date(Date.UTC(y, m - 1 + i, 1));
      const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
      if (d <= last) yield dateKey({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d });
      else yield null; // month without that day: skipped, but keep stepping
    }
  }
}

// Occurrence start instants (ms) of an event, stopping at windowEnd.
function occurrences(ev, windowEnd, ctx) {
  const first = toMs(ev.start);
  if (!ev.rrule) return [first];
  const rule = parseRrule(ev.rrule);
  const why = unsupported(rule);
  if (why) {
    ctx.warn(`${ev.label}: repeat rule part ${echo(why)} not supported; only the first occurrence is counted.`);
    return [first];
  }
  let until = null;
  if (rule.UNTIL) {
    try {
      until = parseDateValue(rule.UNTIL, {}, { ...ctx, assumeZone: ev.start.zone, warn: () => {} }, ev.label);
    } catch {
      until = null;
    }
  }
  const untilMs = until && until.kind !== 'date' ? toMs(until) : null;
  const untilKey = until && until.kind === 'date' ? dateKey(until.parts) : null;
  const count = rule.COUNT ? +rule.COUNT : Infinity;
  const { hh, mm, ss } = ev.start.parts;
  const out = [];
  let n = 0,
    steps = 0;
  for (const key of candidateDates(rule, dateKey(ev.start.parts))) {
    if (++steps > MAX_STEPS) {
      ctx.warn(`${ev.label}: too many repeats to expand; stopped early.`);
      break;
    }
    if (key === null) continue;
    const t = toMs({ parts: { ...parseDateKey(key), hh, mm, ss }, zone: ev.start.zone });
    if (untilKey && key > untilKey) break;
    if (untilMs !== null && t > untilMs) break;
    if (n >= count || t >= windowEnd) break;
    n++;
    out.push(t);
  }
  return out;
}

function endOf(ev, startMs) {
  if (ev.allDay) {
    const key = addDays(dateKey(wallParts(new Date(startMs), ev.start.zone)), ev.days);
    return zonedToUtc(parseDateKey(key), ev.start.zone).getTime();
  }
  return startMs + ev.ms;
}

function buildEvent(props, ctx) {
  const one = (k) => (props[k] ? props[k][0] : null);
  // Titles are untrusted calendar text: cleaned, cut to 60 characters, quoted and labelled wherever shown.
  const summary = one('SUMMARY') ? cleanText(unescapeText(one('SUMMARY').value), 60) : '(no title)';
  const label = `calendar item ${JSON.stringify(summary)} (untrusted calendar text)`;
  const status = (one('STATUS')?.value || '').toUpperCase();
  const transp = (one('TRANSP')?.value || '').toUpperCase();
  if (!one('DTSTART')) {
    ctx.warn(`${label}: no start time; skipped.`);
    return null;
  }
  let start;
  try {
    start = parseDateValue(one('DTSTART').value, one('DTSTART').params, ctx, label);
  } catch {
    ctx.warn(`${label}: start time ${echo(one('DTSTART').value)} not readable; skipped.`);
    return null;
  }
  const allDay = start.kind === 'date';
  // Outlook marks free items with its own property and may leave TRANSP out.
  const msBusy = (one('X-MICROSOFT-CDO-BUSYSTATUS')?.value || '').toUpperCase();
  const ev = {
    uid: one('UID')?.value || null,
    summary,
    label,
    start,
    allDay,
    busy: status !== 'CANCELLED' && transp !== 'TRANSPARENT' && msBusy !== 'FREE',
    rrule: one('RRULE')?.value || null
  };
  const startMs = toMs(start);
  if (one('DTEND')) {
    try {
      const end = parseDateValue(one('DTEND').value, one('DTEND').params, { ...ctx, warn: () => {} }, label);
      if (allDay) ev.days = Math.max(1, daysBetween(dateKey(start.parts), dateKey(end.parts)));
      else ev.ms = toMs(end) - startMs;
    } catch {
      ctx.warn(`${label}: end time not readable; skipped.`);
      return null;
    }
  } else if (one('DURATION')) {
    const dur = parseDuration(one('DURATION').value);
    if (!dur) {
      ctx.warn(`${label}: duration ${echo(one('DURATION').value)} not readable; skipped.`);
      return null;
    }
    if (allDay) ev.days = Math.max(1, dur.days);
    else ev.ms = dur.ms;
  } else if (allDay) {
    ev.days = 1;
  } else {
    ev.ms = 0;
  }
  // EXDATE: instants for timed values, date keys for date values.
  ev.exMs = new Set();
  ev.exKeys = new Set();
  for (const p of props.EXDATE || []) {
    for (const v of p.value.split(',')) {
      try {
        const x = parseDateValue(v, p.params, { ...ctx, assumeZone: start.zone, warn: () => {} }, label);
        if (x.kind === 'date') ev.exKeys.add(dateKey(x.parts));
        else ev.exMs.add(toMs(x));
      } catch {
        ctx.warn(`${label}: excluded date ${echo(v)} not readable; ignored.`);
      }
    }
  }
  if (one('RECURRENCE-ID')) {
    try {
      const r = parseDateValue(one('RECURRENCE-ID').value, one('RECURRENCE-ID').params, { ...ctx, assumeZone: start.zone, warn: () => {} }, label);
      ev.recurrenceId = r.kind === 'date' ? zonedToUtc(r.parts, start.zone).getTime() : toMs(r);
    } catch {
      ctx.warn(`${label}: RECURRENCE-ID not readable; treated as a one-off.`);
    }
  }
  return ev;
}

// text: the .ics file. from/to: ISO instants for the window [from, to).
// assumeZone: zone for floating times and all-day events (default UTC).
export function parseIcsBusy(text, { from, to, assumeZone = 'UTC' } = {}) {
  const fromMs = Date.parse(from),
    toMsW = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMsW)) throw new Error('parseIcsBusy needs from and to as ISO instants.');
  if (!isValidZone(assumeZone)) throw new Error(`"${assumeZone}" isn't a time zone like Europe/Lisbon.`);
  const warnings = new Set();
  const ctx = { assumeZone, warn: (w) => warnings.add(w) };

  // Collect top-level VEVENT property lists; nested VALARM and other components are ignored.
  const raw = [];
  const stack = [];
  let cur = null;
  for (const line of unfold(text)) {
    const { name, params, value } = parseLine(line);
    if (name === 'BEGIN') {
      const comp = value.trim().toUpperCase();
      if (comp === 'VEVENT' && !stack.includes('VEVENT')) raw.push((cur = {}));
      stack.push(comp);
    } else if (name === 'END') {
      const comp = stack.pop();
      if (comp === 'VEVENT' && !stack.includes('VEVENT')) cur = null;
    } else if (cur && stack[stack.length - 1] === 'VEVENT') {
      (cur[name] ||= []).push({ params, value });
    }
  }

  const events = raw.map((p) => buildEvent(p, ctx)).filter(Boolean);
  // Overrides (RECURRENCE-ID) replace that occurrence of their series.
  const overridden = new Map();
  for (const ev of events) {
    if (ev.recurrenceId !== undefined && ev.uid) {
      if (!overridden.has(ev.uid)) overridden.set(ev.uid, new Set());
      overridden.get(ev.uid).add(ev.recurrenceId);
    }
  }

  const busy = [];
  for (const ev of events) {
    if (!ev.busy) continue;
    const isOverride = ev.recurrenceId !== undefined;
    const skip = !isOverride && ev.uid ? overridden.get(ev.uid) : null;
    for (const s of occurrences(ev, toMsW, ctx)) {
      if (!isOverride) {
        if (ev.exMs.has(s) || ev.exKeys.has(dateKey(wallParts(new Date(s), ev.start.zone)))) continue;
        if (skip && skip.has(s)) continue;
      }
      const e = endOf(ev, s);
      if (e <= s || e <= fromMs || s >= toMsW) continue;
      busy.push({
        start: new Date(Math.max(s, fromMs)).toISOString(),
        end: new Date(Math.min(e, toMsW)).toISOString(),
        summary: ev.summary,
        all_day: ev.allDay
      });
    }
  }
  busy.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
  return { busy, warnings: [...warnings] };
}
