// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The days between the messages of a sequence: the lead-time table, or the user's own gap (followup_gap), and
// the one rule for the day each follow-up is due (followupDay). todo, the summary, send-list, the outbox, the CRM
// task and the guard all call it, so a follow-up is never due sooner than its gap after the message before it
// actually went, never on a weekend in a sequence planned off weekends, and never after the event's last day.
import { addDays, daysBetween, todayKeyIn, parseDateKey, weekdayOf, MONTHS } from './tz.mjs';
import { GAP_MIN, GAP_MAX, GAP_STEPS } from './gap-words.mjs';
import { NO_SEND_DATE } from './ledger.mjs';

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
  return eventDayState(event, now.getTime()).state !== 'ok';
}

// Where an event stands today, the one answer the guard and every reader use (so they can't disagree):
//   'ok'         today in the event's zone is on or before its last day (end_date);
//   'over'       today is past that last day: nothing more goes for it;
//   'unreadable' its dates or zone can't be read (a missing, empty or odd date, a time stamp, a day that doesn't
//                exist, a start after the end, an unknown zone): nothing goes either, and it says so, never "over"
//                and never a thrown "Invalid time zone". floorboss's own setup always writes both dates, so an event
//                with no end date was edited by hand: it is unreadable too, rather than guessed.
export const UNREADABLE_DATES =
  "floorboss can't read this event's dates: in the event's event.json, start_date and end_date are days like 2026-11-12 (the end on or after the start) and time_zone is a zone like Europe/Amsterdam";
// A plain calendar date ("2026-11-12", a day that exists: never "2026-02-30", "2026-13-01" or "2026-11-00"), as
// event.json and the ledger keep them. Never throws: a month or day the clock can't make at all is no date.
export const isDateKey = (k) => {
  if (typeof k !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(k)) return false;
  const d = new Date(`${k}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === k;
};
const dateKey = isDateKey;
// The event's dates alone (no zone needed): both plain dates, the end on or after the start.
const datesReadable = (event) => !!event && typeof event === 'object' && dateKey(event.start_date) && dateKey(event.end_date) && event.start_date <= event.end_date;
// A zone name the clock can read ("Europe/Amsterdam"); an empty or unknown one isn't. (Kept per name: asking the
// clock costs a few milliseconds, and a home with many events asks once per event.)
const ZONES = new Map();
export function zoneReadable(z) {
  if (typeof z !== 'string' || !z.trim()) return false;
  if (ZONES.has(z)) return ZONES.get(z);
  let ok = true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
  } catch {
    ok = false;
  }
  if (ZONES.size < 1000) ZONES.set(z, ok);
  return ok;
}
function readable(event) {
  return datesReadable(event) && zoneReadable(event.time_zone);
}
// Where the event stands for a reader holding a context (ctxOf's dayState, read from event.json as it is), or from the
// event and today it holds.
export const stateOf = (c) => c.dayState || eventStateOn(c.event, c.today);
export function eventDayState(event, nowMs = Date.now()) {
  if (!readable(event)) return { state: 'unreadable', today: null, why: UNREADABLE_DATES };
  return eventStateOn(event, todayKeyIn(event.time_zone, new Date(nowMs)));
}
// The same, for a day already worked out in the event's zone (a reader that has today).
export function eventStateOn(event, today) {
  if (!readable(event) || !dateKey(today)) return { state: 'unreadable', today: null, why: UNREADABLE_DATES };
  return today > event.end_date ? { state: 'over', today, why: 'the event is over' } : { state: 'ok', today };
}

// The lead time on a day (a message sent then). That day is already the event's own date (sends are kept as event
// dates), so it's counted from there, in any zone. (It was read at midday UTC, the next day east of UTC+12.)
export const modeOn = (event, dayKey) => modeFor(daysBetween(dayKey, event.start_date));

export function writtenDate(key) {
  const { m, d } = parseDateKey(key);
  return `${weekdayOf(key)} ${d} ${MONTHS[m - 1]}`;
}
// "Thursday 15 October": a day in full, as the guard says it.
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function longDate(key) {
  const { y, m, d } = parseDateKey(key);
  return `${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS_FULL[m - 1]}`;
}
const weekend = (key) => [0, 6].includes(new Date(`${key}T12:00:00Z`).getUTCDay());
// The day itself, or the Monday after it when it falls on a weekend.
export function offWeekend(key) {
  let k = key;
  while (k && weekend(k)) k = addDays(k, 1);
  return k;
}

// Reading the user's words into gaps, and the gap's limits, live in lib/gap-words.mjs.
export { parseGap, GAP_MIN, GAP_MAX, GAP_STEPS } from './gap-words.mjs';

// The user's gaps in words: "3 days", "2 days, then 5 days".
export const gapWords = (gaps) => gaps.map((n) => `${n} ${n === 1 ? 'day' : 'days'}`).join(', then ');
// What a planned day was planned with: the user's gaps, or the table ('table' too for a plan saved before there
// was a choice). A plan made with other gaps than today's doesn't hold its day.
export const gapKey = (settings) => (Array.isArray(settings?.followup_gap) && settings.followup_gap.length ? settings.followup_gap.join(',') : 'table');
export const TABLE_WORDS =
  'set by how far off the event is: 7 days apart from 21 days before it, 4 from 7 to 20 days, 2 from 2 to 6 days, and no follow-ups in the last day';

// The days before follow-up `touch` (2 is the first follow-up), or null when there are no follow-ups this close
// to the event (the table's last day, kept whatever the user's gap).
export function gapFor(settings, mode, touch) {
  if (!MODES[mode].spacing) return null;
  const g = Array.isArray(settings?.followup_gap) && settings.followup_gap.length ? settings.followup_gap : null;
  return g ? g[Math.min(Math.max(touch - 2, 0), g.length - 1)] : MODES[mode].spacing;
}

// How many touches fit between the (expected) send date and the event's last day. gapOf(k): the days before
// the k-th message counted from the one sent on sentKey (k ≥ 2); the table's spacing by default.
export function touchesThatFit(sentKey, event, mode, wanted, gapOf = () => MODES[mode].spacing) {
  if (!MODES[mode].spacing) return 1;
  const room = daysBetween(sentKey, event.end_date);
  let n = 1,
    used = 0;
  for (let k = 2; k <= wanted; k++) {
    used += gapOf(k);
    if (used > room) break;
    n = k;
  }
  return n;
}

// When the next touch is due after a send, or null if it would land after the event ends.
export function nextDue(sentKey, event, mode, gap = MODES[mode].spacing) {
  if (!MODES[mode].spacing || !gap) return null;
  const due = addDays(sentKey, gap);
  return due <= event.end_date ? due : null;
}

// Follow-up `touch`, after the message before it went on sentKey: its day, or null when it would land after the
// event's last day (it's dropped, never moved closer). mode: the lead time at that send (as the summary reads it).
export function dueAfter(settings, event, sentKey, touch, mode = modeOn(event, sentKey)) {
  return nextDue(sentKey, event, mode, gapFor(settings, mode, touch));
}

// A whole sequence planned from today (sending on: it's approved up front): each follow-up's day, its gap after the
// day before it (today's lead time for the whole chain), a weekend moved to the Monday, until one would land after the
// event's last day. from: the day it counts from (the planned day of the message before it; today for the first
// follow-up), saved with the plan so a reader knows two planned days belong to one plan. Each day is checked with
// followupDay, as if every message went on its planned day, and the plan stops where that rule would stop.
export function plannedDays(settings, event, today, mode, wanted) {
  const fit = touchesThatFit(today, event, mode, wanted, (t) => gapFor(settings, mode, t));
  const key = gapKey(settings);
  const out = [];
  let due = today;
  for (let t = 2; t <= fit; t++) {
    const prev = due;
    due = offWeekend(nextDue(prev, event, mode, gapFor(settings, mode, t)));
    if (!due || due > event.end_date) break;
    const plan = { planned_due: due, planned_gap: key, planned_from: prev };
    const r = followupDay(settings, event, { prevSent: prev, touch: t, ...plan, ...(t > 2 ? { prev_planned_due: prev, prev_planned_gap: key } : {}) });
    if (r.day !== due) break;
    out.push({ touch: t, due, from: prev });
  }
  return out;
}

// The one rule for the day a follow-up goes, which every reader uses (todo, the summary, send-list, the outbox, the
// CRM task, the guard, the gap answer and the plan itself). Before the message before it went: the planned day while
// the gaps it was planned with still hold (waits: false), else nothing yet (waits: true). After it went, one of two
// branches gives a candidate, and every candidate goes through settle(), the single place a day is returned:
// - The planned day stands when the message before it went on its own planned day or earlier and both days come from
//   one plan made with today's gaps: planned_from is that planned day (a plan saved before planned_from was kept must
//   be at least its gap after it). So every message sent on its planned day keeps the plan it was approved with.
// - Otherwise: its gap after the real send, by the lead time on that day, moved to the Monday in a sequence planned
//   off weekends, and no sooner than a planned day that still holds.
// today: the event's date now (once it is past the event's last day, nothing goes). lastSent: the latest day any message
// to this person was recorded as sent, any step, any channel (a step recorded out of order counts from it too).
// laterSent: a later step of this person's sequence already went; this one, written to come before it, never goes.
export function followupDay(settings, event, o) {
  const { prevSent, touch, planned_gap, prev_planned_gap, today = null, lastSent = null, laterSent = false } = o;
  // An event whose dates can't be read gives no day (eventDayState says why), never a thrown error or "the event is over".
  if (!datesReadable(event)) return { day: null, waits: false, planned: null, why: 'unreadable' };
  // A planned day that isn't a plain date ("2026-10-17 ", a time stamp) is no plan.
  const [planned_due, planned_from, prev_planned_due] = [o.planned_due, o.planned_from, o.prev_planned_due].map((k) => (isDateKey(k) ? k : undefined));
  const key = gapKey(settings);
  const planned = planned_due && (planned_gap || 'table') === key ? planned_due : null;
  if (laterSent) return { day: null, waits: false, planned, why: 'later' };
  // A send date recorded for the message before it that isn't a plain date (hand-edited, damaged): no day can be
  // counted from it, so the step is skipped with a note naming it, never guessed and never a thrown error.
  if (prevSent && !isDateKey(prevSent)) return { day: null, waits: false, planned, why: 'baddate', bad: String(prevSent).slice(0, 40) };
  if (!prevSent) {
    // Not counted from a send yet: the planned day, and none once the event is over.
    if (today && today > event.end_date) return { day: null, waits: false, planned, why: 'over' };
    return { day: planned && planned <= event.end_date ? planned : null, waits: !planned, planned };
  }
  // Counted from the latest send to this person: the message before it, or a later step recorded since.
  const from = isDateKey(lastSent) && lastSent > prevSent ? lastSent : prevSent;
  // A sequence with a plan (a replanned entry with no day left included) keeps off weekends.
  const rule = ruleAfter(settings, event, from, touch, !!(planned_due || planned_gap));
  const samePlan =
    !!planned &&
    !!prev_planned_due &&
    (prev_planned_gap || 'table') === key &&
    prevSent <= prev_planned_due &&
    (planned_from ? planned_from === prev_planned_due : planned >= offWeekend(addDays(prev_planned_due, rule.floor)));
  const candidate = samePlan ? planned : rule.day && planned && planned > rule.day ? planned : rule.day;
  return { ...settle(event, from, rule, candidate, today), waits: false, planned };
}

// Its gap after the real send (prevSent): the day that gives, and the floor every returned day is held to (the gap at
// that send; a day or less before the event, where no new follow-up starts, the gap a plan made two days out uses).
export function ruleAfter(settings, event, prevSent, touch, weekdays) {
  const gap = gapFor(settings, modeOn(event, prevSent), touch);
  const floor = gap ?? gapFor(settings, 'short', touch);
  if (!gap) return { day: null, why: 'last', floor, weekdays };
  let day = addDays(prevSent, gap);
  if (weekdays) day = offWeekend(day);
  return day > event.end_date ? { day: null, why: 'end', floor, weekdays } : { day, floor, weekdays };
}

// The single return point. A day goes out only if it is:
//   1. strictly after the real send of the message before it,
//   2. at least its gap (rule.floor) after that send,
//   3. on a weekday when the sequence was planned off weekends,
//   4. on or before the event's last day as it is now,
// and only while today (the event's date now) isn't past that last day: once the event is over, nothing goes.
// A candidate that fails any of these, from any branch, is replaced by the gap after the real send (held to the same
// conditions), or by no day, with the reason.
export function settle(event, prevSent, rule, candidate, today = null) {
  if (today && today > event.end_date) return { day: null, why: 'over' };
  const holds = (d) => !!d && d > prevSent && d >= addDays(prevSent, rule.floor) && !(rule.weekdays && weekend(d)) && d <= event.end_date;
  if (holds(candidate)) return { day: candidate };
  if (holds(rule.day)) return { day: rule.day };
  return { day: null, why: rule.why || 'end' };
}

// NO_SEND_DATE: what the per-person view of the ledger (lib/ledger.mjs legacyState) keeps for a send recorded with no
// date at all. It still went (that step never goes again), and the step after it is skipped with the note below.
export { NO_SEND_DATE };
// Why a follow-up has no day, in words (send-list, the guard and the outbox card say it).
export const noDayWhy = (r) =>
  r?.why === 'over'
    ? 'the event is over'
    : r?.why === 'unreadable'
    ? UNREADABLE_DATES
    : r?.why === 'later'
    ? 'a later message already went'
    : r?.why === 'baddate' && r.bad === NO_SEND_DATE
    ? 'the message before it was recorded as sent with no date: record that send again with its date (outreach record)'
    : r?.why === 'baddate'
    ? `the send date recorded for the message before it (${JSON.stringify(r.bad ?? '')}) isn't a date floorboss can read: record that send again with its date (outreach record)`
    : r?.why === 'last'
    ? 'the message before it went a day or less before the event starts, or during it, and no follow-up starts that close to the event'
    : 'no room left before the event ends for this follow-up';

// A followup_gap as it is stored: a list of whole days from 1 to 14, at most one per follow-up. Anything else (a
// hand-edited config: [-5], 3, "x") isn't used; the table decides and the setting is said to be ignored.
export function storedGap(v) {
  if (v == null) return { gap: null };
  const ok = Array.isArray(v) && v.length >= 1 && v.length <= GAP_STEPS && v.every((n) => Number.isInteger(n) && n >= GAP_MIN && n <= GAP_MAX);
  return ok ? { gap: v } : { gap: null, ignored: `followup_gap in your config (${JSON.stringify(v).slice(0, 40)}) isn't a list of whole days from 1 to 14, so it's ignored and the event date decides. Say "3 days between follow-ups" (or "the default") to set it again.` };
}

// The spacing in one line, for the plan card: the user's gap, or what the table gives today.
export function spacingWords(settings, mode) {
  if (settings?.followup_gap_ignored) return `${MODES[mode].spacing ? `${MODES[mode].spacing} days apart for now, ` : ''}${TABLE_WORDS}. ${settings.followup_gap_ignored}`;
  if (Array.isArray(settings?.followup_gap) && settings.followup_gap.length)
    return `${gapWords(settings.followup_gap)} apart (your setting). Say "the default" to have it set by how far off the event is again.`;
  if (!MODES[mode].spacing) return 'no follow-ups: the event is a day or less away';
  return `${MODES[mode].spacing} days apart for now, ${TABLE_WORDS}. Say "3 days between follow-ups" to set your own.`;
}

// What a gap means for a sequence that starts today at this event, in a line or two: which follow-ups fit before its
// last day, on which days, and which are dropped (a gap is never shortened to fit). Sequences already under way are
// said separately, with the days they'll really use (the saver's note).
export function fitSummary(settings, event, today, wanted) {
  const mode = modeFor(daysBetween(today, event.start_date));
  const name = event.name || 'the event';
  const lead =
    Array.isArray(settings?.followup_gap) && settings.followup_gap.length ? `Follow-ups go ${gapWords(settings.followup_gap)} apart.` : `The gap between follow-ups is ${TABLE_WORDS}.`;
  if (wanted <= 1) return `${lead} Your sequence is one message, so there are no follow-ups to space.`;
  if (!MODES[mode].spacing) return `${lead} But ${name} is a day or less away: there are no follow-ups that close to it, whatever the gap.`;
  const of = wanted - 1;
  const days = plannedDays(settings, event, today, mode, wanted);
  const end = writtenDate(event.end_date);
  const when = days.map((d) => writtenDate(d.due)).join(', ');
  if (days.length === of) return `${lead} For a sequence that starts today, ${of === 1 ? 'the follow-up fits' : of === 2 ? 'both follow-ups fit' : `all ${of} follow-ups fit`} before ${name} ends on ${end} (${when}).`;
  if (!days.length)
    return `${lead} For a sequence that starts today, ${of === 1 ? "the follow-up doesn't fit" : `none of the ${of} follow-ups fits`} before ${name} ends on ${end}, so ${of === 1 ? "it's" : "they're"} dropped: a gap is never shortened to fit.`;
  const dropped = Array.from({ length: of - days.length }, (_, i) => days.length + 1 + i);
  const list = dropped.length === 1 ? `follow-up ${dropped[0]} is` : `follow-ups ${dropped.slice(0, -1).join(', ')} and ${dropped[dropped.length - 1]} are`;
  return `${lead} For a sequence that starts today, ${days.length} of the ${of} follow-ups ${days.length === 1 ? 'fits' : 'fit'} before ${name} ends on ${end} (${when}); ${list} dropped: a gap is never shortened to fit.`;
}
