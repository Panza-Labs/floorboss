// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Turn free-time ranges into meeting slots in the event's time zone.
import { wallParts, dateKey, labelInZone, pad, toMin, instant } from '../../../lib/tz.mjs';

export function slotId(isoUtc, eventZone) {
  const w = wallParts(new Date(isoUtc), eventZone);
  return `s${w.y}${pad(w.m)}${pad(w.d)}T${pad(w.hh)}${pad(w.mm)}`;
}

// ranges: from parseFreeTimes, wall minutes in sourceZone. Returns slots (UTC) and what fell outside hours.
export function buildSlots(
  ranges,
  { eventZone, sourceZone = eventZone, hours = { start: '08:00', end: '18:00' }, meetingMinutes = 30, now = new Date(), keepOutside = false }
) {
  const plain = [],
    own = [];
  for (const r of ranges) {
    const span = { start: instant(r.date, r.start, sourceZone), end: instant(r.date, r.end, sourceZone) };
    if (r.minutes) own.push({ ...span, minutes: r.minutes, label: r.label });
    else plain.push(span);
  }
  // Merge overlapping plain ranges.
  plain.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const s of plain) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  // Clip to working hours per event-local day; keep what falls outside for the gate.
  const kept = [],
    outside = [];
  const hs = toMin(hours.start),
    he = toMin(hours.end);
  for (const s of merged) {
    let cur = s.start;
    while (cur < s.end) {
      const day = dateKey(wallParts(new Date(cur), eventZone));
      const dayStart = instant(day, hs, eventZone),
        dayEnd = instant(day, he, eventZone);
      const nextMidnight = instant(day, 24 * 60, eventZone);
      const segEnd = Math.min(s.end, nextMidnight);
      const inStart = Math.max(cur, dayStart),
        inEnd = Math.min(segEnd, dayEnd);
      if (inEnd > inStart) kept.push({ start: inStart, end: inEnd });
      if (cur < Math.min(dayStart, segEnd)) outside.push({ start: cur, end: Math.min(dayStart, segEnd) });
      if (segEnd > Math.max(dayEnd, cur)) outside.push({ start: Math.max(dayEnd, cur), end: segEnd });
      cur = segEnd;
    }
  }
  const usable = keepOutside ? [...kept, ...outside].sort((a, b) => a.start - b.start) : kept;
  const step = meetingMinutes * 60000;
  const slots = [];
  for (const s of usable) {
    for (let t = s.start; t + step <= s.end; t += step) slots.push({ start: t, end: t + step, minutes: meetingMinutes });
  }
  for (const o of own) {
    if (o.end - o.start >= o.minutes * 60000) slots.push({ start: o.start, end: o.start + o.minutes * 60000, minutes: o.minutes, label: o.label });
  }
  const nowMs = now.getTime();
  const out = slots
    .filter((s) => s.start > nowMs)
    .sort((a, b) => a.start - b.start)
    .map((s) => {
      const startIso = new Date(s.start).toISOString();
      return {
        id: slotId(startIso, eventZone),
        start: startIso,
        end: new Date(s.end).toISOString(),
        minutes: s.minutes,
        day: dateKey(wallParts(new Date(s.start), eventZone)),
        label: s.label || null
      };
    });
  const seen = new Set();
  const unique = out.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  return {
    slots: unique,
    outside: outside.map((o) => ({ start: new Date(o.start).toISOString(), end: new Date(o.end).toISOString() }))
  };
}

export function slotLabel(slot, eventZone, homeZone, eventCity) {
  const ev = labelInZone(slot.start, eventZone, { city: eventCity });
  if (!homeZone || homeZone === eventZone) return ev;
  // Another zone name with the same clock at that moment (Berlin and Amsterdam): the time is said once.
  const wall = (z) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: z,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(slot.start));
  if (wall(homeZone) === wall(eventZone)) return ev;
  const home = labelInZone(slot.start, homeZone);
  const sameDay = home.split(', ')[0] === ev.split(', ')[0];
  return `${ev} (${sameDay ? home.split(', ')[1] : home})`;
}

export function removeSlots(slots, ids) {
  const drop = new Set(ids);
  return slots.filter((s) => !drop.has(s.id));
}
