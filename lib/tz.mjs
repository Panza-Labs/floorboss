// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Time-zone maths with Intl only. All instants are stored as UTC ISO strings;
// "wall time" is a {y, m, d, hh, mm} in a named IANA zone.

const fmtCache = new Map();
function fmt(zone) {
  if (!fmtCache.has(zone)) {
    fmtCache.set(
      zone,
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short'
      })
    );
  }
  return fmtCache.get(zone);
}

export function isValidZone(zone) {
  if (typeof zone !== 'string' || !zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone === 'UTC' || zone.includes('/');
  } catch {
    return false;
  }
}

export function wallParts(date, zone) {
  const p = Object.fromEntries(
    fmt(zone)
      .formatToParts(date)
      .map((x) => [x.type, x.value])
  );
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second, weekday: p.weekday };
}

// Offset of zone from UTC at this instant, in minutes (Berlin summer = +120).
export function offsetMinutes(date, zone) {
  const w = wallParts(date, zone);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

// Wall time in zone → UTC Date. Iterates to settle across DST edges.
export function zonedToUtc({ y, m, d, hh = 0, mm = 0 }, zone) {
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  let t = naive - offsetMinutes(new Date(naive), zone) * 60000;
  t = naive - offsetMinutes(new Date(t), zone) * 60000;
  return new Date(t);
}

export function dateKey({ y, m, d }) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseDateKey(key) {
  const mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!mt) throw new Error(`"${key}" isn't a date like 2030-01-15.`);
  return { y: +mt[1], m: +mt[2], d: +mt[3] };
}

export function addDays(key, n) {
  const { y, m, d } = parseDateKey(key);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return dateKey({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
}

export function daysBetween(fromKey, toKey) {
  const a = parseDateKey(fromKey),
    b = parseDateKey(toKey);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
}

export function weekdayOf(key) {
  const { y, m, d } = parseDateKey(key);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const pad = (n) => String(n).padStart(2, '0');
// "09:30" as minutes after midnight.
export const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
};
// A day key and wall minutes in a zone, as a UTC timestamp (ms).
export function instant(date, minutes, zone) {
  const { y, m, d } = parseDateKey(date);
  return zonedToUtc({ y, m, d, hh: Math.floor(minutes / 60), mm: minutes % 60 }, zone).getTime();
}

export function cityOfZone(zone) {
  return zone === 'UTC' ? 'UTC' : zone.split('/').pop().replace(/_/g, ' ');
}

// "Tue 15 Jan, 10:30 Berlin time"
export function labelInZone(isoUtc, zone, { city } = {}) {
  const w = wallParts(new Date(isoUtc), zone);
  const hm = `${String(w.hh).padStart(2, '0')}:${String(w.mm).padStart(2, '0')}`;
  return `${w.weekday} ${w.d} ${MONTHS[w.m - 1]}, ${hm} ${city || cityOfZone(zone)} time`;
}

export function todayKeyIn(zone, now = new Date()) {
  return dateKey(wallParts(now, zone));
}

// A zone from what the user typed: an IANA name, a city that is one ("Berlin", "new york"), or a common city
// that isn't ("San Francisco", "Munich"). null when nothing fits; the caller asks again.
const CITY_ALIAS = {
  'san francisco': 'America/Los_Angeles',
  sf: 'America/Los_Angeles',
  'bay area': 'America/Los_Angeles',
  seattle: 'America/Los_Angeles',
  'las vegas': 'America/Los_Angeles',
  'san diego': 'America/Los_Angeles',
  portland: 'America/Los_Angeles',
  boston: 'America/New_York',
  nyc: 'America/New_York',
  miami: 'America/New_York',
  washington: 'America/New_York',
  'washington dc': 'America/New_York',
  atlanta: 'America/New_York',
  philadelphia: 'America/New_York',
  austin: 'America/Chicago',
  dallas: 'America/Chicago',
  houston: 'America/Chicago',
  'salt lake city': 'America/Denver',
  milwaukee: 'America/Chicago',
  minneapolis: 'America/Chicago',
  'st louis': 'America/Chicago',
  'saint louis': 'America/Chicago',
  'kansas city': 'America/Chicago',
  nashville: 'America/Chicago',
  'san antonio': 'America/Chicago',
  charlotte: 'America/New_York',
  pittsburgh: 'America/New_York',
  cleveland: 'America/New_York',
  cincinnati: 'America/New_York',
  columbus: 'America/New_York',
  baltimore: 'America/New_York',
  tampa: 'America/New_York',
  orlando: 'America/New_York',
  raleigh: 'America/New_York',
  indianapolis: 'America/Indiana/Indianapolis',
  sacramento: 'America/Los_Angeles',
  munich: 'Europe/Berlin',
  frankfurt: 'Europe/Berlin',
  hamburg: 'Europe/Berlin',
  cologne: 'Europe/Berlin',
  barcelona: 'Europe/Madrid',
  valencia: 'Europe/Madrid',
  milan: 'Europe/Rome',
  geneva: 'Europe/Zurich',
  manchester: 'Europe/London',
  edinburgh: 'Europe/London',
  porto: 'Europe/Lisbon',
  lyon: 'Europe/Paris',
  rotterdam: 'Europe/Amsterdam',
  antwerp: 'Europe/Brussels',
  espoo: 'Europe/Helsinki',
  haarlem: 'Europe/Amsterdam',
  utrecht: 'Europe/Amsterdam',
  'the hague': 'Europe/Amsterdam',
  'den haag': 'Europe/Amsterdam',
  eindhoven: 'Europe/Amsterdam',
  leiden: 'Europe/Amsterdam',
  delft: 'Europe/Amsterdam',
  groningen: 'Europe/Amsterdam',
  'amstelveen': 'Europe/Amsterdam',
  ghent: 'Europe/Brussels',
  gent: 'Europe/Brussels',
  bruges: 'Europe/Brussels',
  leuven: 'Europe/Brussels',
  liege: 'Europe/Brussels',
  'liège': 'Europe/Brussels',
  dusseldorf: 'Europe/Berlin',
  'düsseldorf': 'Europe/Berlin',
  stuttgart: 'Europe/Berlin',
  leipzig: 'Europe/Berlin',
  dresden: 'Europe/Berlin',
  hanover: 'Europe/Berlin',
  hannover: 'Europe/Berlin',
  nuremberg: 'Europe/Berlin',
  'nürnberg': 'Europe/Berlin',
  bonn: 'Europe/Berlin',
  essen: 'Europe/Berlin',
  dortmund: 'Europe/Berlin',
  marseille: 'Europe/Paris',
  toulouse: 'Europe/Paris',
  nice: 'Europe/Paris',
  bordeaux: 'Europe/Paris',
  lille: 'Europe/Paris',
  nantes: 'Europe/Paris',
  strasbourg: 'Europe/Paris',
  seville: 'Europe/Madrid',
  sevilla: 'Europe/Madrid',
  bilbao: 'Europe/Madrid',
  malaga: 'Europe/Madrid',
  'málaga': 'Europe/Madrid',
  zaragoza: 'Europe/Madrid',
  'palma': 'Europe/Madrid',
  braga: 'Europe/Lisbon',
  coimbra: 'Europe/Lisbon',
  faro: 'Europe/Lisbon',
  birmingham: 'Europe/London',
  leeds: 'Europe/London',
  glasgow: 'Europe/London',
  bristol: 'Europe/London',
  liverpool: 'Europe/London',
  cambridge: 'Europe/London',
  oxford: 'Europe/London',
  cardiff: 'Europe/London',
  belfast: 'Europe/London',
  newcastle: 'Europe/London',
  bangalore: 'Asia/Kolkata',
  bengaluru: 'Asia/Kolkata',
  mumbai: 'Asia/Kolkata',
  delhi: 'Asia/Kolkata',
  'tel aviv': 'Asia/Jerusalem',
  beijing: 'Asia/Shanghai',
  'abu dhabi': 'Asia/Dubai',
  'sao paulo': 'America/Sao_Paulo',
  'são paulo': 'America/Sao_Paulo',
  'rio de janeiro': 'America/Sao_Paulo',
  'cape town': 'Africa/Johannesburg'
};
export function zoneFrom(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (isValidZone(t)) return t;
  const paren = /\(([A-Za-z_]+\/[A-Za-z_/]+)\)/.exec(t);
  if (paren && isValidZone(paren[1])) return paren[1];
  // "St. Louis" keeps its name: the full stop of an abbreviation isn't the end of the answer.
  const low = t
    .toLowerCase()
    .replace(/\b(st|ft|mt)\.\s*/g, '$1 ')
    .replace(/\b(time|based in|i'?m in|i live in|in|near|area)\b/g, ' ')
    .replace(/[.,;:!].*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (CITY_ALIAS[low]) return CITY_ALIAS[low];
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const key = low.replace(/\s+/g, '_');
  return zones.find((z) => z.toLowerCase().split('/').pop() === key) || null;
}
