// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Lead time drives tone and how many touches fit; the days between follow-ups (the table, or the user's own gap)
// and each follow-up's day are worked out in lib/spacing.mjs, re-exported here for the commands that read them.
export { MODES, modeFor, daysUntilEvent, eventOver, touchesThatFit, nextDue, writtenDate } from '../../../lib/spacing.mjs';

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

// The relative-day check's words, naming each word and the sentence it is in ("today" in "Could we meet today?"),
// so the writer and the user can see what set it off. null when there is none.
export function relativeFlag(text) {
  const words = relativeWordsIn(text);
  if (!words.length) return null;
  const parts = String(text).split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const where = words
    .map((w) => parts.find((x) => new RegExp(`(?<![\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'iu').test(x)))
    .filter(Boolean)
    .map((x) => `"${x.length > 120 ? `${x.slice(0, 117)}...` : x}"`);
  return `uses relative time words (${words.join(', ')})${where.length ? ` in ${[...new Set(where)].join(' and ')}` : ''}; write the day and date`;
}
