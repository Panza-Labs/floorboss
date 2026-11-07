// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Parse typed free times like "Tue 9–11, 14–17; Wed 9:30–12; Wed 19:30–22:00 dinner 150".
import { weekdayOf } from '../../../lib/tz.mjs';

const DAYS = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export class FreeTimeError extends Error {}

// "9", "9:30", "14h", "14h30", "2pm", "12am" → minutes after midnight, plus whether a meridiem was given.
function parseClock(s) {
  const mt = /^(\d{1,2})(?:[:.h](\d{2}))?\s*(h|am|pm)?$/i.exec(s.trim());
  if (!mt) return null;
  let h = +mt[1];
  const m = mt[2] ? +mt[2] : 0;
  const mer = mt[3]?.toLowerCase();
  if (mer === 'pm' && h < 12) h += 12;
  if (mer === 'am' && h === 12) h = 0;
  if (h > 24 || m > 59) return null;
  return { min: h * 60 + m, meridiem: mer === 'am' || mer === 'pm' ? mer : null };
}

// Bare 1–6 without am/pm means afternoon in a business day ("after 3", "1-3").
// With bareAfternoon off (times typed in another zone, where office hours don't apply), bare times are
// read as written: "5:30" is 05:30.
let bareAfternoon = true;
function business(c) {
  if (bareAfternoon && c && !c.meridiem && c.min >= 60 && c.min < 7 * 60) return { ...c, min: c.min + 720 };
  return c;
}

function parseRange(text, hours) {
  const t = text.trim();
  if (/^(mornings?|before lunch|am)$/i.test(t)) return { start: hours.startMin, end: 12 * 60 };
  if (/^(afternoons?|after lunch|pm)$/i.test(t)) return { start: 13 * 60, end: hours.endMin };
  let mt = /^after\s+(.+)$/i.exec(t);
  if (mt) {
    const a = business(parseClock(mt[1]));
    return a && a.min < hours.endMin ? { start: a.min, end: hours.endMin } : null;
  }
  mt = /^before\s+(.+)$/i.exec(t);
  if (mt) {
    const b = business(parseClock(mt[1]));
    return b && b.min > hours.startMin ? { start: hours.startMin, end: b.min } : null;
  }
  if (/^(all day|any ?time|whole day)$/i.test(t)) return { start: hours.startMin, end: hours.endMin };
  mt = /^(.+?)\s*(?:-|–|—|to|until)\s*(.+)$/i.exec(t);
  if (!mt) return null;
  let a = parseClock(mt[1]),
    b = parseClock(mt[2]);
  if (!a || !b) return null;
  if (bareAfternoon && !a.meridiem && !b.meridiem && a.min >= 60 && a.min < 7 * 60) {
    a = business(a);
    b = business(b);
  } else if (!b.meridiem) b = b.min < a.min ? business(b) : b;
  let start = a.min,
    end = b.min;
  if (!a.meridiem && b.meridiem === 'pm' && start + 720 < end) start += 720; // "2-4pm"
  if (!a.meridiem && !b.meridiem && end <= start && end + 720 > start && end < 720) end += 720; // "11-2" → 11:00-14:00
  if (end <= start) return null;
  return { start, end };
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

// Resolve a day word to one of the event's dates.
function resolveDays(dayText, eventDays) {
  const t = dayText
    .trim()
    .toLowerCase()
    .replace(/[,.:]$/, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  // "Tue 3 Nov", "mie 4", "Wednesday 4th": the weekday is extra when a date follows.
  // "18.11." or "18.11.2026" (day.month): that event day.
  const dmDot = /^(?:(?:mo|di|mi|do|fr|sa|so|mon|tue|wed|thu|fri|sat|sun|lun|mar|mie|jue|vie|sab|dom)[a-z]*\.?\s+)?(\d{1,2})\.(\d{1,2})\.?(?:\d{2,4})?$/.exec(
    t
  );
  if (dmDot) {
    const hit = eventDays.filter((k) => +k.slice(8, 10) === +dmDot[1] && +k.slice(5, 7) === +dmDot[2]);
    return hit.length ? hit : null;
  }
  const wd = /^(mon|tue|wed|thu|fri|sat|sun|lun|mar|mie|jue|vie|sab|dom)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(\s+[a-z]{3}[a-z]*)?$/.exec(t);
  if (wd) {
    if (wd[3]) return resolveDays(`${wd[2]}${wd[3]}`, eventDays);
    const hit = eventDays.filter((k) => +k.slice(8, 10) === +wd[2]);
    return hit.length === 1 ? hit : null;
  }
  if (/^(every ?day|all days|each day|daily|both days|any day|(the )?(whole|entire|full) (event|week|conference|show)|all (event|week))$/.test(t))
    return eventDays;
  const iso = /^(\d{4}-\d{2}-\d{2})$/.exec(t);
  if (iso) return eventDays.includes(iso[1]) ? [iso[1]] : null;
  const dm = /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3})[a-z]*$/.exec(t) || /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(t);
  if (dm) {
    const [d, mon] = /^\d/.test(dm[1]) ? [+dm[1], dm[2]] : [+dm[2], dm[1]];
    const mi = MONTHS.indexOf(mon);
    const hit = eventDays.filter((k) => +k.slice(5, 7) === mi + 1 && +k.slice(8, 10) === d);
    return hit.length ? hit : null;
  }
  const dayNum = /^day\s*(\d+)$/.exec(t);
  if (dayNum) return eventDays[+dayNum[1] - 1] ? [eventDays[+dayNum[1] - 1]] : null;
  const w = DAYS[t.slice(0, 3)];
  if (w && /^[a-z]+$/.test(t)) {
    const hit = eventDays.filter((k) => weekdayOf(k) === w);
    if (hit.length > 1) throw new FreeTimeError(`"${dayText}" matches more than one event day (${hit.join(', ')}). Use a date, like "14 Oct".`);
    return hit.length ? hit : null;
  }
  return null;
}

// Returns { ranges: [{date, start, end, minutes?, label?}], unparsed: [text] }. Times are wall minutes.
export function parseFreeTimes(text, { eventDays, hours = { start: '08:00', end: '18:00' }, bareAsAfternoon = true }) {
  bareAfternoon = bareAsAfternoon;
  try {
    return parseFreeTimesInner(text, { eventDays, hours });
  } finally {
    bareAfternoon = true;
  }
}

// A time taken out of the free time ("except 12-13", "except opening night"): {dates|null, start, end}. null
// dates means the days of the part it was said in. Evenings start at 18:00; a night runs to midnight.
function cutOf(text, eventDays, hrs) {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/^(the|on)\s+/, '');
  const night = /^(opening|first|closing|last|final)\s+(night|evening)$/.exec(t);
  if (night) return { dates: [/^(opening|first)$/.test(night[1]) ? eventDays[0] : eventDays[eventDays.length - 1]], start: 18 * 60, end: 24 * 60 };
  if (/^(evenings?|nights?)$/.test(t)) return { dates: null, start: 18 * 60, end: 24 * 60 };
  const r = parseRange(t, hrs);
  return r ? { dates: null, ...r } : null;
}

// Free ranges minus the cuts on their day. A range with its own length ("dinner 150") is kept whole or not at all.
function applyCuts(ranges, cuts) {
  let out = ranges;
  for (const c of cuts) {
    out = out.flatMap((r) => {
      if (!c.dates.includes(r.date) || c.end <= r.start || c.start >= r.end) return [r];
      if (r.minutes) return [];
      return [...(c.start > r.start ? [{ ...r, end: c.start }] : []), ...(c.end < r.end ? [{ ...r, start: c.end }] : [])];
    });
  }
  return out;
}

const EACH_DAY = /\s+(?:each|every|per|a)\s+day$|\s+every ?day$|\s+daily$/i;

function parseFreeTimesInner(text, { eventDays, hours }) {
  const hrs = { startMin: toMinutes(hours.start), endMin: toMinutes(hours.end) };
  // "all day every day", "every day all day", "all day": the working hours, on every event day. "Uhr" is a word.
  // "normal hours" (office, working, business hours) is 9:00 to 18:00 at the event, whatever the clip setting.
  text = String(text)
    .replace(/\buhr\b/gi, '')
    .replace(/\b(all|whole|full) day\b/gi, `${hours.start}-${hours.end}`)
    .replace(/\b(?:(?:my|the)\s+)?(normal|usual|regular|office|working|work|business)\s+hours\b/gi, '09:00-18:00');
  // "free all week", "the whole event": every event day, normal hours, unless a time follows. Filler words go.
  text = text.replace(/^\s*(?:i'?m\s+|i am\s+)?(?:free|available)\s+/i, '').replace(/\b(roughly|about|around|approx(?:imately)?|ish)\b\.?/gi, '');
  // With no time said anywhere, "all week" means normal hours every day; with one, the phrase only names the days.
  if (!/\d|morning|afternoon|evening|lunch/i.test(text))
    text = text.replace(/\b(?:all|the whole|whole|entire)\s+(?:week|event|conference|summit|show)\b/gi, '09:00-18:00 every day');
  const everyFirst = /^\s*(\d{1,2}(?::\d\d)?-\d{1,2}(?::\d\d)?)\s+(every ?day|each day|daily|both days|any day)\s*$/i.exec(text);
  if (everyFirst) text = `${everyFirst[2]} ${everyFirst[1]}`;
  const ranges = [],
    unparsed = [],
    cuts = [],
    notes = [];
  let lastDays = null; // the days of the last range read, for an "except …" said after a comma
  let currentDays = null;
  let pending = null; // "thursday and friday mornings": days named with no time yet, joined to the next part's
  let lastMonth = null; // "Jan 10, 11 and 12": a bare 11 is in the month named last
  const segments = String(text)
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const seg of segments) {
    // Ranges are separated by commas, or by "and" / "y" / "&" ("10-12 and 14-17", "10:00-13:00 y 15:00-18:00").
    const parts = seg.split(/,\s*|\s*\+\s*|\s+(?:and|y|&|und|et)\s+/i);
    for (let raw of parts) {
      let part = raw.trim().replace(/^(?:and|y|&|und|et)\s+/i, '');
      if (!part) continue;
      // Something they can't know yet ("except booth shifts", "don't know those yet"): kept as a note, not a cut.
      if (
        /^(?:(?:except|but not|apart from|other than|minus)\s+)?(?:my\s+|the\s+)?(?:booth|stand)\s+(?:shifts?|duty|time)\b|^(?:i\s+)?(?:don'?t|do not) know|^(?:tbd|tbc|not sure)/i.test(
          part
        )
      ) {
        notes.push(`not taken out yet: "${raw.trim()}" (tell floorboss when you know)`);
        continue;
      }
      // "…, except 12 to 13": an exception said after a comma applies to the days just read (or the day it names).
      const lead = /^(?:except|but not|apart from|other than|minus)\s+(.+)$/i.exec(part);
      if (lead && lastDays) {
        const w = lead[1].split(/\s+/);
        let days = null,
          rest = lead[1];
        for (let n = Math.min(3, w.length - 1); n >= 1; n--) {
          const d = resolveDays(w.slice(0, n).join(' '), eventDays);
          if (d) {
            days = d;
            rest = w.slice(n).join(' ');
            break;
          }
        }
        const ct = cutOf(rest, eventDays, hrs);
        if (!ct) {
          unparsed.push(raw.trim());
          continue;
        }
        cuts.push({ ...ct, dates: ct.dates || days || lastDays });
        continue;
      }
      // A day range: "Tuesday 10th to Thursday 12th", "Jan 10 - 12".
      const span = /^(.+?)\s+(?:to|through|thru|until|-|–)\s+(.+)$/i.exec(part);
      if (span) {
        const a = resolveDays(span[1], eventDays),
          b = resolveDays(span[2], eventDays);
        if (a?.length === 1 && b?.length === 1) {
          pending = [...(pending || []), ...eventDays.filter((d) => d >= a[0] && d <= b[0])];
          continue;
        }
      }
      const bare = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(part);
      if (bare && lastMonth) {
        const hit = eventDays.filter((k) => +k.slice(5, 7) === lastMonth && +k.slice(8, 10) === +bare[1]);
        if (!hit.length) {
          unparsed.push(raw.trim());
          continue;
        }
        pending = [...(pending || []), ...hit];
        continue;
      }
      // Only days, no time ("thursday" in "thursday and friday mornings"): they wait for the time that follows.
      const onlyDays = resolveDays(part.replace(/:$/, ''), eventDays);
      if (onlyDays) {
        pending = [...(pending || []), ...onlyDays];
        lastMonth = onlyDays.length === 1 ? +onlyDays[0].slice(5, 7) : null;
        continue;
      }
      // "mornings except wednesday": the range on every event day but those. "9-18 except 12-13", "except
      // opening night": a time taken out. An exception that can't be read refuses the whole part, never drops.
      let except = null;
      const partCuts = [];
      const ex = /^(.+?)\s+(?:except|but not|apart from|other than|minus)\s+(.+)$/i.exec(part);
      if (ex) {
        const items = ex[2]
          .split(/\s*,\s*|\s+(?:and|y|&)\s+/i)
          .map((d) => d.trim())
          .filter(Boolean);
        const days = [],
          bad = [];
        for (const d of items) {
          const rd = resolveDays(d, eventDays);
          if (rd) {
            days.push(...rd);
            continue;
          }
          const ct = cutOf(d, eventDays, hrs);
          if (ct) partCuts.push(ct);
          else bad.push(d);
        }
        if (bad.length) {
          unparsed.push(raw.trim());
          continue;
        }
        except = days.length ? days : null;
        part = ex[1].trim();
        if (except) currentDays = eventDays.filter((d) => !except.includes(d));
        const only = resolveDays(part.replace(/:$/, ''), eventDays);
        if (only) {
          const ds = except ? only.filter((d) => !except.includes(d)) : only;
          pending = [...(pending || []), ...ds];
          cuts.push(...partCuts.map((ct) => ({ ...ct, dates: ct.dates || ds })));
          continue;
        }
      }
      // "8am to 6pm each day": the days named before it, else every event day.
      if (EACH_DAY.test(part)) {
        part = part.replace(EACH_DAY, '').trim();
        if (!pending) currentDays = eventDays;
      }
      // Leading day word(s): try longest prefix of up to 3 words that resolves to days.
      const words = part.split(/\s+/);
      for (let n = Math.min(3, words.length - 1); n >= 1; n--) {
        const days = resolveDays(words.slice(0, n).join(' ').replace(/:$/, ''), eventDays);
        if (days) {
          currentDays = except ? days.filter((d) => !except.includes(d)) : days;
          part = words.slice(n).join(' ');
          break;
        }
      }
      if (pending && currentDays) {
        currentDays = [...new Set([...pending, ...currentDays])];
        pending = null;
      }
      // Days named, then a time on its own ("Jan 10, 11 and 12, 8am to 6pm"): the time is for those days.
      else if (pending) {
        currentDays = [...new Set(pending)];
        pending = null;
      }
      lastMonth = null;
      // A part of the day with no day named ("mornings", "after lunch", "all day") means every event day.
      if (!currentDays && (/^(mornings?|afternoons?|before lunch|after lunch|all day|any ?time|whole day)$/i.test(part) || parseRange(part, hrs)))
        currentDays = eventDays;
      // Optional trailing "<label> <minutes>" e.g. "dinner 150".
      let label = null,
        minutes = null;
      const own = /^(.*\S)\s+([a-z][a-z ]*?)\s+(\d{2,3})$/i.exec(part);
      if (own && parseRange(own[1], hrs)) {
        part = own[1];
        label = own[2].trim();
        minutes = +own[3];
      }
      const r = parseRange(part, hrs);
      if (!r || !currentDays) {
        unparsed.push(raw.trim());
        continue;
      }
      lastDays = currentDays;
      for (const date of currentDays) ranges.push({ date, start: r.start, end: r.end, ...(minutes ? { minutes, label } : {}) });
      cuts.push(...partCuts.map((ct) => ({ ...ct, dates: ct.dates || currentDays })));
    }
  }
  // Days named with no time after them ("Tue and Wed"): said, so not dropped in silence.
  if (pending?.length) unparsed.push(`${[...new Set(pending)].join(', ')} (a day with no time)`);
  return { ranges: applyCuts(ranges, cuts), unparsed, notes, except: cuts.map((c) => ({ dates: c.dates, start: c.start, end: c.end })) };
}
