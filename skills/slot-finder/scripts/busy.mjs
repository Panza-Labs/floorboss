// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Busy blocks (from a calendar connector or an .ics export) into free ranges for buildSlots: for each event
// day, working hours minus whatever is busy, as wall minutes in the event's zone.
import { wallParts, dateKey, toMin, instant } from '../../../lib/tz.mjs';

// busy: [{start, end}] ISO. Returns { ranges, busyInHours } where ranges are {date, start, end} minutes.
export function freeFromBusy(busy, { eventDays, eventZone, hours = { start: '08:00', end: '18:00' }, minMinutes = 30 }) {
  const spans = busy
    .map((b) => [Date.parse(b.start), Date.parse(b.end)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const hs = toMin(hours.start),
    he = toMin(hours.end);
  const ranges = [];
  let busyInHours = 0;
  for (const day of eventDays) {
    const dayStart = instant(day, hs, eventZone),
      dayEnd = instant(day, he, eventZone);
    let cur = dayStart;
    const push = (from, to) => {
      if (to - from < minMinutes * 60000) return;
      const a = wallParts(new Date(from), eventZone),
        b = wallParts(new Date(to), eventZone);
      if (dateKey(a) !== day) return;
      const endMin = dateKey(b) === day ? b.hh * 60 + b.mm : 24 * 60;
      ranges.push({ date: day, start: a.hh * 60 + a.mm, end: endMin });
    };
    for (const [s, e] of spans) {
      if (e <= cur || s >= dayEnd) continue;
      if (s > cur) push(cur, Math.min(s, dayEnd));
      busyInHours += Math.min(e, dayEnd) - Math.max(s, cur);
      cur = Math.max(cur, e);
      if (cur >= dayEnd) break;
    }
    if (cur < dayEnd) push(cur, dayEnd);
  }
  return { ranges, busy_hours: Math.round(busyInHours / 360000) / 10 };
}

// Typed free times minus calendar busy blocks: ranges in sourceZone wall minutes in, event-zone ranges out.
export function subtractBusy(ranges, busy, { sourceZone, eventZone, minMinutes = 30 }) {
  const spans = busy
    .map((b) => [Date.parse(b.start), Date.parse(b.end)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const out = [],
    dropped = [];
  for (const r of ranges) {
    const s0 = instant(r.date, r.start, sourceZone),
      e0 = instant(r.date, r.end, sourceZone);
    if (r.minutes) {
      // A labelled slot (a dinner) is kept whole or dropped.
      if (spans.some(([s, e]) => s < e0 && e > s0)) {
        dropped.push(r);
        continue;
      }
      const a = wallParts(new Date(s0), eventZone),
        b = wallParts(new Date(e0), eventZone);
      out.push({ ...r, date: dateKey(a), start: a.hh * 60 + a.mm, end: dateKey(b) === dateKey(a) ? b.hh * 60 + b.mm : 24 * 60 });
      continue;
    }
    let cur = s0;
    const push = (from, to) => {
      if (to - from < minMinutes * 60000) return;
      const a = wallParts(new Date(from), eventZone),
        b = wallParts(new Date(to), eventZone);
      out.push({ date: dateKey(a), start: a.hh * 60 + a.mm, end: dateKey(b) === dateKey(a) ? b.hh * 60 + b.mm : 24 * 60 });
    };
    for (const [s, e] of spans) {
      if (e <= cur || s >= e0) continue;
      if (s > cur) push(cur, Math.min(s, e0));
      cur = Math.max(cur, e);
      if (cur >= e0) break;
    }
    if (cur < e0) push(cur, e0);
  }
  return { ranges: out, dropped };
}
