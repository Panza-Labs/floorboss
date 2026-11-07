// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Lead time drives tone, follow-up spacing and how many touches fit.
import { addDays, daysBetween, todayKeyIn, parseDateKey, weekdayOf, MONTHS } from '../../../lib/tz.mjs';

export const MODES = Object.freeze({
  early: { min: 21, spacing: 7, label: '21+ days: calendars still open, low pressure' },
  standard: { min: 7, spacing: 4, label: '7–20 days: two specific times' },
  short: { min: 2, spacing: 2, label: '2–6 days: short, easy yes/no' },
  last: { min: -Infinity, spacing: null, label: '1 day or less: one line, remaining slots only' }
});

export function modeFor(daysUntil) {
  if (daysUntil >= 21) return 'early';
  if (daysUntil >= 7) return 'standard';
  if (daysUntil >= 2) return 'short';
  return 'last';
}

export function daysUntilEvent(event, now = new Date()) {
  return daysBetween(todayKeyIn(event.time_zone, now), event.start_date);
}

export function eventOver(event, now = new Date()) {
  return todayKeyIn(event.time_zone, now) > event.end_date;
}

// How many touches fit between the (expected) send date and the event's last day.
export function touchesThatFit(sentKey, event, mode, wanted) {
  const spacing = MODES[mode].spacing;
  if (!spacing) return 1;
  const room = daysBetween(sentKey, event.end_date);
  return Math.max(1, Math.min(wanted, 1 + Math.floor(room / spacing)));
}

// When the next touch is due after a send, or null if it would land after the event ends.
export function nextDue(sentKey, event, mode) {
  const spacing = MODES[mode].spacing;
  if (!spacing) return null;
  const due = addDays(sentKey, spacing);
  return due <= event.end_date ? due : null;
}

export function writtenDate(key) {
  const { m, d } = parseDateKey(key);
  return `${weekdayOf(key)} ${d} ${MONTHS[m - 1]}`;
}

export const RELATIVE_WORDS = [
  'tomorrow',
  'today',
  'tonight',
  'next week',
  'this week',
  'yesterday',
  'this morning',
  'this afternoon',
  'this evening',
  'later today',
  // German, Spanish, Portuguese, French
  'übermorgen',
  'heute',
  'nächste woche',
  'diese woche',
  'mañana',
  'pasado mañana',
  'hoy',
  'la próxima semana',
  'esta semana',
  'amanhã',
  'hoje',
  'próxima semana',
  'demain',
  "aujourd'hui",
  'la semaine prochaine',
  'cette semaine'
];

// "Today" meaning "these days" ("a merchant who signs up with Tillmoss today") isn't a date: it counts only in a
// sentence that asks to meet or names a day, a time or a meeting ("meet today", "today at 10", "free today?"); a
// question about their work ("how do merchants get paid out today?") is no ask.
const TODAY_AS_DATE =
  /\b(?:could|can|shall|would|will) (?:we|you|i)\b|\btoday work|\b(let'?s|are you|do you have|talk|speak|grab|free|available|meet|meeting|met|call|chat|coffee|lunch|breakfast|dinner|drinks|catch up|slot|see you|booth|session|keynote|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|morning|afternoon|evening|tonight|later)\b|\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|h)\b|\b\d{1,2}[:.]\d{2}\b|\b(?:at|by|until|before|after|from)\s+\d/i;
// "Today?", "How about today?", "Is today ok?", "Any time today.": a short sentence with today in it is about
// the day, and so is one that says it suits or ends on it. Only a longer sentence with no such word ("When a
// merchant signs up with Tillmoss today, where does payments come into it?") reads as "currently".
const TODAY_SUITS = /\b(?:suits?|works?|good|fine|ok|okay|great|better|would)\b|\bhow about\b|\bany ?time\b|\bis today\b|(?<![\p{L}])today\W*$/iu;
const todayIsDate = (text) =>
  String(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .some((s) => /(?<![\p{L}])today(?![\p{L}])/iu.test(s) && (TODAY_AS_DATE.test(s) || TODAY_SUITS.test(s.trim()) || s.trim().split(/\s+/).length <= 8));

// Word boundaries that work for accented letters.
export function relativeWordsIn(text) {
  const t = String(text).toLowerCase();
  // German "morgen" (tomorrow) is lowercase; "Morgen" (morning, as in "Guten Morgen") is a noun.
  const extra = /(?<![\p{L}])morgen(?![\p{L}])/u.test(String(text)) ? ['morgen'] : [];
  return [
    ...extra,
    ...RELATIVE_WORDS.filter(
      (w) => new RegExp(`(?<![\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'u').test(t) && (w !== 'today' || todayIsDate(text))
    )
  ];
}
