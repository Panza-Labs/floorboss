// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The days between follow-ups, said back when the user sets them: the gap is their setting for every event, so the
// answer names each approved follow-up whose day it moves (old day, new day) or drops, at this event and the others.
import { routeLength, touchBefore } from '../../../../lib/route.mjs';
import { gapWords, gapFor, modeOn, fitSummary, followupDay, eventOver, writtenDate, TABLE_WORDS } from '../../../../lib/spacing.mjs';
import { loadEvent } from '../../../../lib/event.mjs';
import { listEvents } from '../../../../lib/scope.mjs';
import { eventRecord, planFor } from '../../../../lib/sendcheck.mjs';
import { todayKeyIn } from '../../../../lib/tz.mjs';
import { latestSend, laterSent } from '../../../../skills/event-outreach/scripts/commands/saved-drafts.mjs';

// The events a gap reaches: on the mock, the mock alone (its settings are its own); else every real event not over.
const reached = (c) => (c.event?.event?.mock ? [c.slug] : listEvents(c.now.getTime()).map((x) => x.slug));

// Every approved follow-up not sent yet, with the day it goes under the settings saved now (the one rule,
// followupDay), by "event:id:touch". One whose message before it hasn't gone is projected from the day that one is due
// (no sooner than today; a first message approved and waiting counts as going today), so a chain that can no longer
// fit before the event shows as dropped now. A day before today counts as today, so two days already due never read
// as a move. Someone who replied, booked or said stop has none.
export function approvedDays(c) {
  const out = {};
  for (const slug of reached(c)) {
    let e;
    try {
      e = loadEvent(slug);
    } catch {
      continue;
    }
    if (eventOver(e.event, c.now)) continue;
    const rec = eventRecord(e.paths.dir);
    const today = todayKeyIn(e.event.time_zone, c.now);
    const asToday = (d) => (d && d < today ? today : d);
    for (const [id, st] of Object.entries(rec.state)) {
      if (st.replied || st.booked || st.stopped || st.removed || st.dropped) continue;
      // The day each message goes: sent, or projected (null: dropped; undefined: not approved, so nothing to say).
      const day = {};
      for (const t of Object.keys(st.touches || {}).map(Number).sort((x, y) => x - y)) {
        const x = st.touches[t];
        if (st.sent?.[t]) {
          day[t] = st.sent[t];
          continue;
        }
        if (x.status !== 'outboxed' || x.skipped) continue;
        if (t === 1) {
          day[t] = today;
          continue;
        }
        const b = touchBefore(st, t);
        const gone = !!st.sent?.[b];
        const from = gone ? st.sent[b] : asToday(day[b]);
        const plan = planFor(rec.entries, id, t, x.hash) || {};
        const prevPlan = (b > 1 && planFor(rec.entries, id, b, st.touches[b]?.hash)) || {};
        const r =
          from === undefined
            ? { day: null, waits: true }
            : from === null
              ? { day: null, waits: false }
              : followupDay(e.settings, e.event, {
                  prevSent: from,
                  touch: t,
                  planned_due: plan.planned_due,
                  planned_gap: plan.planned_gap,
                  planned_from: plan.planned_from,
                  prev_planned_due: prevPlan.planned_due,
                  prev_planned_gap: prevPlan.planned_gap,
                  lastSent: latestSend(st),
                  laterSent: laterSent(st, t)
                });
        day[t] = r.waits ? undefined : r.day;
        out[`${slug}:${id}:${t}`] = {
          slug,
          event: e.event.name,
          name: rec.folded.people[id]?.name || id,
          touch: t,
          before: b,
          gone,
          gap: from ? (gapFor(e.settings, modeOn(e.event, from), t) ?? gapFor(e.settings, 'short', t)) : null,
          day: asToday(r.day),
          waits: r.waits,
          why: r.why
        };
      }
    }
  }
  return out;
}

// A follow-up's day in words: the day itself only once the message before it has gone; before that, its gap after
// that message (the projected day moves with whenever that message really goes).
const dayWords = (x) =>
  !x.day ? (x.waits ? `its gap after message ${x.before} goes` : x.why === 'later' ? 'passed over (a later message already went)' : 'dropped (no room left before the event)') : x.gone ? writtenDate(x.day) : `${x.gap ?? 'its'} ${x.gap === 1 ? 'day' : 'days'} after message ${x.before} goes`;

// What the answer says back: what was saved, that it's the setting for every event, what a sequence starting today gets
// at this event, and every approved follow-up it moves or drops, so nothing moves without the user seeing it.
export function gapNote(c, gap, before, after) {
  const lead = gap ? `Saved: follow-ups go ${gapWords(gap)} apart.` : `Saved: the default. The gap between follow-ups is ${TABLE_WORDS}.`;
  if (!c.slug || !c.event) return `${lead} This is your setting for every event.`;
  const e = loadEvent(c.slug);
  const today = todayKeyIn(e.event.time_zone, c.now);
  const over = eventOver(e.event, c.now);
  const parts = [
    over
      ? `${lead} ${e.event.name} is over, so this changes nothing there; it applies to your other events and the next ones.`
      : `Saved: ${gap ? fitSummary(e.settings, e.event, today, routeLength(e.settings)).replace(/^F/, 'f') : `the default. ${fitSummary(e.settings, e.event, today, routeLength(e.settings))}`}`,
    c.event.event?.mock ? 'This is for the mock event only.' : `This is your setting for every event${over ? '' : `, not only ${e.event.name}`}.`
  ];
  const moved = Object.entries(after)
    .filter(([k, x]) => !before[k] || before[k].day !== x.day || before[k].waits !== x.waits)
    .map(([k, x]) => ({ ...x, was: before[k] }));
  const here = moved.filter((x) => x.slug === c.slug && (!x.was || dayWords(x.was) !== dayWords(x)));
  if (here.length) {
    parts.push(
      `Already approved at ${e.event.name} (same text, no new approval): ${here
        .slice(0, 20)
        .map((x) => `${x.name} follow-up ${x.touch - 1}: ${x.was ? dayWords(x.was) : 'no day'} → ${dayWords(x)}`)
        .join('; ')}${here.length > 20 ? `; and ${here.length - 20} more` : ''}.`
    );
    if (here.some((x) => !x.gone))
      parts.push('Where the message before has not gone yet, it is counted as going today (a first message) or on its own day; a later send moves the days after it by the same amount.');
  }
  const others = {};
  for (const x of moved.filter((y) => y.slug !== c.slug)) {
    const o = (others[x.event] ||= { moved: 0, dropped: 0 });
    if (!x.day && !x.waits) o.dropped++;
    else o.moved++;
  }
  for (const [name, o] of Object.entries(others))
    parts.push(
      `At ${name}: ${[
        o.moved ? `${o.moved} approved follow-up${o.moved === 1 ? '' : 's'} change${o.moved === 1 ? 's' : ''} day` : null,
        o.dropped ? `${o.dropped} ${o.dropped === 1 ? 'is' : 'are'} dropped (no room left before it)` : null
      ]
        .filter(Boolean)
        .join(' and ')}.`
    );
  if (!moved.length && Object.keys(after).length) parts.push('No approved follow-up changes day.');
  return parts.join(' ');
}
