// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// U2. The due-now planner: with no model, which approved messages may go now, and why every other one waits.
// Every rule is an existing floorboss check, called here, not copied: contactable (stop, reply, booking, bounce,
// decline, skip), eventStateAt (not over, dates readable), hoursWhy (weekdays 09:00 to 17:00 event time), windowWhy
// (its due day or the day after), followupDueDay (a follow-up's day from the recorded send), sentOrGoingToday and
// addressBusyToday (one message a day per person, across events), unreviewed and approvalHash (the text the critic
// read, the text and address the user approved).
import { join, resolve } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { home as defaultHome } from '../paths.mjs';
import { contactable, legacyState, readLedger, fold, awayUntil } from '../ledger.mjs';
import { approvalHash, unreviewed, eventStateAt, followupDueDay, sentOrGoingToday, addressBusyToday, busyWhy, homeSends, personAddressKeys, markerOnly } from '../sendcheck.mjs';
import { hoursWhy, windowWhy } from '../unattended-drafts.mjs';
import { loadConfig, effectiveSettings } from '../config.mjs';
import { emailBase } from '../normalize.mjs';
import { plainAddress } from '../../skills/event-outreach/scripts/mailto.mjs';
import { autosendEvents, readEvent, draftOf, liveApproval, unsettled, everReleased, releasesOf, claudeSendsEmail, listChangedSince, takenTimes, pastTimes, TIME_TAKEN, TIMES_UNREAD, lastApproval, handSentAfter, autosendDueDay } from './common.mjs';
import { wallParts, dateKey, zonedToUtc, parseDateKey } from '../tz.mjs';

// The day an instant falls on in a zone (UTC when the zone can't be read), or null for a time that can't be read.
function dayIn(zone, when) {
  const d = new Date(when);
  if (!Number.isFinite(d.getTime())) return null;
  try {
    return dateKey(wallParts(d, zone || 'UTC'));
  } catch {
    return dateKey(wallParts(d, 'UTC'));
  }
}

// When a recorded send went, for the reply check's window: the earlier of when it was recorded and the start of the day
// it says it went (in the event's zone; UTC when that can't be read). A send the user records days later says the day
// it went: replies since then count. NaN when neither can be read.
export function sentFrom(zone, x) {
  const at = Date.parse(x?.sent_at || '');
  const date = typeof x?.sent === 'object' ? x.sent?.date : x?.sent;
  let day = NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    try {
      day = zonedToUtc(parseDateKey(date), zone || 'UTC').getTime();
    } catch {
      day = zonedToUtc(parseDateKey(date), 'UTC').getTime();
    }
  }
  const both = [at, day].filter(Number.isFinite);
  return both.length ? Math.min(...both) : NaN;
}

// hoursWhy is written for the unattended drafts: the same rule, in words about messages.
const hoursWords = (why) => (why ? why.replace(/drafts go in/g, 'messages go') : null);

// A stop for this address at any other event in the data folder (matched as lib/lent.mjs matches addresses: +tags
// and Gmail dots aside), or an event there whose record can't be read (it might hold one): why, or null.
export function stoppedElsewhere(home, slug, evDir, id, to) {
  const mine = new Set(personAddressKeys(evDir, id, to).filter((k) => k.includes('@') && !k.startsWith('n:')).map(emailBase).filter(Boolean));
  let slugs = [];
  try {
    slugs = readdirSync(join(home, 'events'));
  } catch {
    slugs = [];
  }
  for (const s of slugs.sort()) {
    if (s === slug) continue;
    const { entries, damaged } = readLedger(join(home, 'events', s, 'ledger.jsonl'));
    const st = fold(entries, damaged);
    for (const p of Object.values(st.people)) {
      const theirs = [p.email, p.email_override, ...p.keys.filter((k) => typeof k === 'string' && k.startsWith('e:')).map((k) => k.slice(2)), ...Object.values(p.touches).map((x) => x.approved?.to)]
        .filter((a) => typeof a === 'string' && a.includes('@'))
        .map(emailBase);
      if (p.stopped && theirs.some((a) => mine.has(a))) return `they said stop at another of your events (${s})`;
      // A bounce with no new address there: this address doesn't take mail.
      if (p.bounced === true && [p.email, ...p.keys.filter((k) => typeof k === 'string' && k.startsWith('e:')).map((k) => k.slice(2))].filter((a) => typeof a === 'string' && a.includes('@')).map(emailBase).some((a) => mine.has(a)))
        return `their address bounced at another of your events (${s})`;
    }
    const raw = [...damaged.map((d) => d.text), ...st.unread.map((d) => d.text)].join('\n').toLowerCase();
    if (raw && [...mine].some((a) => raw.includes(a))) return `a damaged line at another of your events (${s}) names their address`;
  }
  return null;
}

// Another way of sending already had this step, so auto-send never sends it: the Claude Code guard let it through
// (send_released, not cleared, or a guard marker with no release), its send is unclear, or an unattended run put its
// draft in the user's drafts folder. Why, or null. The readback refuses the same steps (lib/autosend/approval.mjs).
export function stepHeld(evDir, entries, x, id, t) {
  if (x?.released) return 'the Claude Code guard let this message through once already (it may have gone): settle it there, never by auto-send';
  if (x?.unclear_send) return 'a send of this message is unclear (it may have gone): settle it first';
  if (x?.staged || x?.stage_released) return 'its draft is already in your drafts folder: send it from there, never by auto-send';
  // The guard's markers (events/<slug>/released/) live on the laptop only (not in the data repo): this part holds the
  // laptop's readback; in the cloud the ledger's lines above are what it reads.
  let mark = null;
  try {
    mark = markerOnly(evDir, entries, id, t);
  } catch {
    mark = { fresh: false };
  }
  if (mark) return 'the Claude Code guard has a mark for this message (it may have gone): settle it there, never by auto-send';
  return null;
}

// The latest time the data folder records (any line of an auto-send event's ledger, the lock): a clock behind it
// (more than CLOCK_SLACK_MS) can't be trusted with the day or the hours, so nothing goes.
export const CLOCK_SLACK_MS = 5 * 60 * 1000;
function latestRecorded(home, events) {
  let latest = -Infinity;
  for (const e of events) for (const x of e.entries) {
    const t = Date.parse(x?.at || '');
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  try {
    const t = Date.parse(JSON.parse(readFileSync(join(home, 'autosend', 'lock.json'), 'utf8')).at || '');
    if (Number.isFinite(t) && t > latest) latest = t;
  } catch {
    /* no lock */
  }
  return latest;
}

// The touches of a person's sequence, in order, without skipped steps.
const sequenceOf = (p) =>
  Object.entries(p?.touches || {})
    .map(([t, x]) => [Number(t), x])
    .filter(([t, x]) => t >= 1 && !x.skipped)
    .sort((a, b) => a[0] - b[0]);

// Why this step can't go now (one reason, the first that holds), or null. ctx: the event as read for this run.
function waitWhy(ctx, id, t, x, a) {
  const { slug, dir, entries, folded, legacy, es, ev, settings, nowMs, home, sends } = ctx;
  const p = folded.people[id];
  // Claude Code sending email from this folder too: one or the other, never both.
  const cc = claudeSendsEmail(home, ev);
  if (cc) return cc;
  // 1. The second yes stands, for the text and address the step has now.
  if (!a) {
    const l = lastApproval(entries, id, t);
    if (l && handSentAfter(entries, id, l.at))
      return 'a message to them went another way (you sent it yourself), so the rest of their sequence is yours to send: or give auto-send a fresh yes for it (readback)';
    return entries.some((e) => e?.type === 'autosend_revoked' && e.id === id) ? 'auto-send was stopped for them' : 'this message has no auto-send yes';
  }
  if (a.hash !== x.hash || x.approved?.hash !== a.hash || String(x.approved?.to || '') !== String(a.to || ''))
    return sequenceOf(p).some(([, y]) => y.sent)
      ? 'its text or address changed since the auto-send yes, after their first message went: send it by hand (stop auto-send for them)'
      : 'its text or address changed since the auto-send yes: read it back and approve it again';
  const d = draftOf(dir, a.hash);
  if (!d || approvalHash(d, a.to) !== a.hash || plainAddress(a.to) !== a.to) return 'its saved text no longer matches the approved one';
  const rev = unreviewed(entries, id, t, a.hash);
  if (rev) return rev;
  // A time it offers was booked by someone else since: never sent offering it.
  if (takenTimes(entries, folded, id, t, a.hash).length) return TIME_TAKEN;
  // A time it offers is already past, or its times can't be read (never taken as "no times"): never sent offering it.
  const past = pastTimes(dir, entries, id, t, a.hash, nowMs);
  if (past === null) return TIMES_UNREAD;
  if (past.length) return 'a time it offers is already past: held until floorboss writes it again with new times (flow next) and you approve it, then a fresh auto-send yes';
  // A cut of the list (keep, a cap) or a new decision about them since the yes: the shortlist may have changed.
  const yesAt = entries.indexOf(a);
  if (listChangedSince(entries, a, id)) return 'the list changed since the auto-send yes: read it back and approve it again';
  // The user said since how to reach them (another channel, or not at all), or their address changed: what was
  // approved for this address no longer stands.
  if (entries.some((e, i) => i > yesAt && e?.type === 'channel' && e.id === id)) return `you changed how to reach them (channel ${entries.filter((e) => e?.type === 'channel' && e.id === id).pop().to}) since the auto-send yes`;
  const current = String(p.email_override || p.email || '').trim().toLowerCase();
  if (current && current !== String(a.to).trim().toLowerCase()) return `their address is now ${current}, not the approved ${a.to}: approve it again`;
  // 2. The ledger's own rule for who may be written to.
  const held = contactable(folded, id, 'message', es.today);
  if (held) return held;
  // Away (an out-of-office recorded): nothing goes on or before the day they're back, as in hand-send.
  const away = awayUntil(p, es.today);
  if (away) return `they're away until ${away}`;
  // 3. A stop for that address at any other event.
  const elsewhere = stoppedElsewhere(home, slug, dir, id, a.to);
  if (elsewhere) return elsewhere;
  // 4. The event: not over, dates readable.
  if (es.state !== 'ok') return es.why;
  // 9. Never twice, never retried: by auto-send, nor after any other way of sending had it (stepHeld).
  if (everReleased(entries, id, t)) return 'auto-send let this message go once already: it is never sent again by auto-send (send it by hand if it should go)';
  const other = stepHeld(dir, entries, x, id, t);
  if (other) return other;
  // 7. Never ahead of the message before it (the first unsent step is the one asked about), nor after a later one.
  if (sequenceOf(p).some(([u, y]) => u > t && y.sent)) return 'a later message already went';
  // 5. Weekdays, 09:00 to 17:00 in the event's zone.
  const hours = hoursWords(hoursWhy(ev.time_zone, nowMs));
  if (hours) return hours;
  // 6. Its day or the day after: the planned day for the first message, the one rule from the recorded send after.
  const first = !sequenceOf(p).some(([, y]) => y.sent);
  let ruleDay = null;
  if (!first) {
    const r = followupDueDay(dir, settings, entries, legacy[id] || {}, { id, touch: t }, nowMs);
    if (r.why) return r.why;
    ruleDay = r.day;
  }
  // Never before the follow-up rule's day; a fresh yes may plan it later (readback after a missed day).
  const due = autosendDueDay(a, { first, ruleDay });
  const w = windowWhy({ due, today: es.today, end: ev.end_date });
  if (w) return w;
  // 8. One message a day to a person: at this event, and to this address at any event.
  const today = sentOrGoingToday(entries, legacy[id] || {}, { id, touch: t }, dir, nowMs);
  if (today != null) return `another message to ${p.name || id} already went or is going today`;
  const busy = addressBusyToday(dir, a.to, nowMs, id, sends);
  if (busy) return busyWhy(busy, p.name || id, a.to);
  // An auto-send release today counts as that day's message, whatever is recorded about it later (as a guard's
  // send_released does in sentOrGoingToday, which lib/sendcheck.mjs reads only for its own type): another step of this
  // person here, or this address at another auto-send event.
  if (ctx.releasedToday(slug, id, t, a.to)) return `another message to ${p.name || id} already went or is going today`;
  return null;
}

// What may go now: { blocked: why | null, due: [Item], waits: [{ slug, id, touch, why }] }.
// Item: { slug, id, name, touch, to, subject, body, hash, since_ms, thread_id, reply_to_message_id }.
export function dueNow(home = defaultHome(), nowMs = Date.now()) {
  // The checks across events (one a day, opt-outs) read floorboss's own data folder: planning another would read the
  // wrong one, so it is refused.
  if (resolve(home) !== resolve(defaultHome())) throw new Error('dueNow plans the data folder floorboss reads (FLOORBOSS_HOME) only.');
  const events = autosendEvents(home).map((e) => ({ ...e, ...readEvent(e.dir) }));
  // Nothing goes anywhere while any step may have gone unrecorded, or a line can't be read.
  const blocked = [];
  for (const e of events) {
    if (e.damaged.length || e.folded.unread.length) blocked.push(`a line in ${e.slug}'s ledger can't be read (line ${(e.damaged[0] || e.folded.unread[0]).line})`);
    for (const u of unsettled(e.entries))
      blocked.push(`${e.slug} ${u.id} message ${u.touch}: ${u.mark === 'unclear' ? "the send tool's answer was unclear" : 'auto-send let it go and nothing says what happened'}; it may have gone. Check Sent mail, then settle it on the laptop`);
    for (const [id, p] of Object.entries(e.folded.people))
      for (const [t, x] of Object.entries(p.touches || {}))
        if (x.unclear_send && !x.sent && !blocked.some((b) => b.includes(`${e.slug} ${id} message ${t}:`))) blocked.push(`${e.slug} ${id} message ${t}: a send is unclear (it may have gone)`);
  }
  const latest = latestRecorded(home, events);
  if (latest - nowMs > CLOCK_SLACK_MS)
    blocked.push(`the clock (${new Date(nowMs).toISOString().slice(0, 16)} UTC) is behind what your data repo records (${new Date(latest).toISOString().slice(0, 16)} UTC): nothing goes until it is right`);
  if (blocked.length) return { blocked: blocked.join('; '), due: [], waits: [] };
  const config = loadConfig();
  const sends = homeSends(join(home, 'events'));
  const due = [];
  const waits = [];
  // Every auto-send release that counts, across the auto-send events, with the event day it was made on.
  const releases = events.flatMap((e) => {
    const today = dayIn(e.event.time_zone, nowMs);
    return releasesOf(e.entries).map((r) => ({ slug: e.slug, id: r.id, touch: r.touch ?? 1, to: emailBase(String(r.to || '')), today: today !== null && dayIn(e.event.time_zone, r.at) === today }));
  });
  const releasedToday = (slug, id, touch, to) =>
    releases.some((r) => r.today && !(r.slug === slug && r.id === id && r.touch === touch) && ((r.slug === slug && r.id === id) || (!!r.to && r.to === emailBase(String(to || '')))));
  for (const e of events) {
    const ctx = {
      slug: e.slug,
      dir: e.dir,
      entries: e.entries,
      folded: e.folded,
      legacy: legacyState(e.folded),
      es: eventStateAt(e.dir, nowMs),
      ev: e.event,
      settings: effectiveSettings(config, e.event),
      nowMs,
      home,
      sends,
      releasedToday
    };
    const ids = [...new Set(e.entries.filter((x) => x?.type === 'autosend_approved').map((x) => x.id))].sort();
    for (const id of ids) {
      const p = e.folded.people[id];
      const step = sequenceOf(p).find(([, x]) => !x.sent);
      if (!step) continue;
      const [t, x] = step;
      const a = liveApproval(e.entries, id, t);
      const why = waitWhy(ctx, id, t, x, a);
      if (why) {
        waits.push({ slug: e.slug, id, touch: t, why });
        continue;
      }
      const d = draftOf(e.dir, a.hash);
      const sentAts = sequenceOf(p)
        .filter(([, y]) => y.sent)
        .map(([, y]) => sentFrom(e.event.time_zone, y))
        .filter(Number.isFinite);
      // The search window starts a day before the first yes for their first message (an earlier yes, revoked or
      // replaced since, included), so a reply in between is never missed.
      const yes1 = e.entries.find((y) => y?.type === 'autosend_approved' && y.id === id && (y.touch ?? 1) === sequenceOf(p)[0][0]) || a;
      // The first message's ids, from auto-send's own sent line for it (fold keeps only the guard's call_result ids).
      const t1 = [...e.entries].reverse().find((y) => y?.type === 'sent' && y.id === id && (y.touch ?? 1) === sequenceOf(p)[0][0] && y.source === 'autosend' && p.touches[sequenceOf(p)[0][0]]?.sent);
      due.push({
        slug: e.slug,
        id,
        name: p.name || id,
        touch: t,
        to: a.to,
        subject: d.subject || '',
        body: d.body || '',
        hash: a.hash,
        since_ms: sentAts.length ? Math.min(...sentAts) : Date.parse(yes1.at),
        thread_id: t1?.thread_id || null,
        reply_to_message_id: t1?.message_id || null
      });
    }
  }
  return { blocked: null, due, waits };
}
