// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// What came back: status pasted by the user, replies read from the inbox or CRM, and the summary.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { allowedPath } from '../../../../lib/paths.mjs';
import { need } from '../../../../lib/args.mjs';
import { readJson, writeJson } from '../../../../lib/jsonio.mjs';
import { todayKeyIn, addDays } from '../../../../lib/tz.mjs';
import { stateOf } from '../../../../lib/spacing.mjs';
import { awayUntil } from '../../../../lib/ledger.mjs';
import { addressBusyToday, busyWhy, homeSends } from '../../../../lib/sendcheck.mjs';
import { parseStatus, planFromStatus, bookingConflicts } from '../status.mjs';
import { planRecord } from '../record.mjs';
import { planSync } from '../sync.mjs';
import { validateSync } from '../../../connectors/scripts/tasks.mjs';
import { loadConfig } from '../../../../lib/config.mjs';
import { sessionRun } from '../../../../lib/scope.mjs';
import { kindAt, routeOf } from './routes.mjs';
import { ctxOf, led, sinceOf, idList, crmIdOf, awayNote, isOut, colleagueTold, sendingOn } from './context.mjs';
import { readTodo, savedDraft, criticFails, followupDayOf } from './saved-drafts.mjs';

export function status(opts) {
  need(opts, 'event');
  const c = ctxOf(opts.event, opts);
  const outboxed = c.entries.some((e) => e.type === 'outboxed');
  const st = { last_at: c.folded.last.paste_at || null };
  if (opts.none || /^nothing changed$/i.test(String(opts.text || '').trim())) {
    // The user's word that nothing changed is a reply check for everyone, for the next few minutes: their
    // own words, never a bare flag. It names no inbox, so it never answers for LinkedIn or the app (lastReplyCheck).
    const said = opts.none ? String(opts.said || '').trim() : String(opts.text).trim();
    if (!said) throw new Error('status --none needs --said with the user\'s own words (e.g. "nobody replied"): it counts as a reply check.');
    led(c, { type: 'status_pasted', nothing_changed: true, said: said.slice(0, 200) });
    return {
      applied: false,
      note: outboxed ? "No changes recorded. Follow-ups are timed from sent dates you've already pasted." : 'Nothing has been sent yet.'
    };
  }
  need(opts, 'text');
  const parsed = parseStatus(opts.text, {
    slug: c.event.slug,
    lastAt: st.last_at,
    now: c.now,
    knownIds: new Set(Object.keys(c.byId)),
    knownSlots: new Set([...c.slots.map((s) => s.id), ...Object.values(c.short.assignments).flat()])
  });
  const conflicts = bookingConflicts(parsed, {
    state: c.state,
    assignments: c.short.assignments,
    freeSlots: new Set(c.slots.filter((s) => Date.parse(s.start) > c.now.getTime()).map((s) => s.id))
  });
  if (conflicts.length)
    throw new Error(
      `Nothing was applied. These bookings can't all be right: ${conflicts.join('; ')}. Fix the outbox ticks (only one person per time) and copy the status again.`
    );
  const plan = planFromStatus(parsed, { state: c.state, assignments: c.short.assignments });
  // A pasted line about someone with an unread outcome is the user's answer to it.
  for (const r of parsed.rows) if (c.state[r.id]?.unclear?.length) led(c, { type: 'unclear_resolved', id: r.id });
  for (const e of plan.logEntries) led(c, e);
  led(c, { type: 'status_pasted', paste_at: parsed.at, said: 'pasted from the outbox' });
  return { applied: true, sent: plan.newlySent, replied: plan.replied, booked_slots: plan.bookedSlots, stopped: plan.stops, need_new_times: plan.redraft };
}

// record --event <slug> --file <report.json> [--check]: what the user says happened, in their words, turned
// into log entries. Claude writes the report ({"items":[{who, what, …}]}); --check shows what would be
// recorded without writing. All or nothing.
export function record(opts) {
  need(opts, 'event', 'file');
  const c = ctxOf(opts.event, opts);
  const report = readJson(allowedPath(opts.file));
  const approved = new Set(c.short.approved || []);
  const slots = c.slots.map((x) => ({ id: x.id, start: x.start, end: x.end }));
  const eventDays = [];
  if (stateOf(c).state !== 'unreadable') for (let d = c.event.start_date; d && d <= (c.event.end_date || c.event.start_date); d = addDays(d, 1)) eventDays.push(d);
  // People a colleague holds, by holder: a "sent" about them is the note passed on, not a message to them.
  const coordinate = new Map((c.short.coordinate || []).map((id) => [id, c.triage.pre[id]?.holder || c.triage.pre[id]?.crm?.holder || null]));
  const plan = planRecord(report.items, {
    byId: c.byId,
    approved,
    state: c.state,
    slots,
    zone: c.event.time_zone,
    now: c.now,
    minutes: Number(c.settings.meeting_minutes) || 30,
    eventDays,
    coordinate,
    crmConnected: !!(loadConfig().connectors?.['crm.lookup'] || loadConfig().connectors?.['crm.activity'])
  });
  if (plan.errors.length) throw new Error(`Nothing was recorded. ${plan.errors.join(' ')}`);
  // planRecord already leaves out a send reported twice (it says so in notes).
  const entries = plan.entries;
  const repeats = plan.notes.filter((n) => /not recorded again/.test(n)).length;
  if (opts.check) return { applied: false, would_record: plan.lines, notes: plan.notes, ...(repeats ? { already_recorded: repeats } : {}) };
  for (const e of entries) led(c, e);
  // What the user just said about someone answers any open question about them (a meeting sync couldn't place).
  for (const id of new Set(entries.map((e) => e.id))) if (c.state[id]?.unclear?.length) led(c, { type: 'unclear_resolved', id });
  // The views (contacts, groups, shortlist) are rewritten so the next reader sees the new address or the cut.
  ctxOf(opts.event, opts);
  return { applied: true, recorded: plan.lines, notes: plan.notes, ...(repeats ? { already_recorded: repeats } : {}) };
}

// sync-list --event <slug>: who to check in the mailbox or CRM (email.messages, crm.activity), and from when.
export function syncList(opts) {
  need(opts, 'event');
  const c = ctxOf(opts.event, opts);
  const since = sinceOf(c);
  // --channel linkedin|app: only people written to there (an inbox read in the browser); --ids: just those.
  const only = opts.ids ? new Set(idList(opts.ids)) : null;
  const onChannel = (id) => !opts.channel || Object.entries(c.folded.people[id]?.touches || {}).some(([t, x]) => x.sent && kindAt(c, id, t, x) === opts.channel);
  const people = Object.keys(since)
    .filter((id) => {
      const s = c.state[id] || {};
      return !(s.stopped || s.removed || s.dropped) && (!only || only.has(id)) && onChannel(id);
    })
    .map((id) => ({
      id,
      name: c.byId[id]?.name,
      company: c.byId[id]?.company,
      email: c.byId[id]?.email || null,
      profile_url: c.byId[id]?.profile_url || null,
      crm_id: crmIdOf(c, id),
      since: since[id].slice(0, 10)
    }));
  writeJson(join(c.paths.dir, 'sync-list.json'), people);
  // Whether this list is everyone or just some (--ids): only a read of everyone moves the run's CRM state.
  writeJson(join(c.paths.dir, 'sync-list.meta.json'), { partial: !!only || !!opts.channel });
  return {
    file: join(c.paths.dir, 'sync-list.json'),
    people: people.length,
    with_email: people.filter((p) => p.email).length,
    with_crm_id: people.filter((p) => p.crm_id).length
  };
}

// sync --event <slug> --source mailbox|crm --file <answers>: sends, replies and calls floorboss didn't make
// itself, read from the user's mailbox (email.messages) or CRM (crm.activity), into the log.
export function sync(opts) {
  need(opts, 'event', 'source', 'file');
  if (!['mailbox', 'crm', 'linkedin', 'app'].includes(opts.source)) throw new Error('--source is mailbox, crm, linkedin or app.');
  const c = ctxOf(opts.event, opts);
  const wanted = new Set(readJson(join(c.paths.dir, 'sync-list.json'), []).map((p) => p.id));
  if (!wanted.size) {
    // Nobody left to check (all replied, stopped or dropped): the check ran, there's just nothing to read.
    // A one-person read with nobody left (they just replied or stopped) stays a one-person read.
    if (existsSync(join(c.paths.dir, 'sync-list.json'))) {
      const partial = readJson(join(c.paths.dir, 'sync-list.meta.json'), {})?.partial === true;
      led(c, {
        type: 'sync_ran',
        source: opts.source,
        people: 0,
        run: sessionRun(),
        ...(opts.source === 'crm' && partial ? { partial: true, blind: [], seen: [] } : {})
      });
      return { saved: true, checked: 0, recorded: [] };
    }
    throw new Error('Run "outreach sync-list" first: it says who to check.');
  }
  const r = validateSync(readJson(allowedPath(opts.file)), opts.source === 'crm' ? 'crm.activity' : 'email.messages', wanted);
  if (r.errors.length) return { saved: false, errors: r.errors };
  const plan = planSync(r.people, { state: c.state, since: sinceOf(c), source: opts.source, now: c.now, byId: c.byId, zone: c.event.time_zone });
  for (const e of plan.entries) led(c, e);
  // A CRM read vouches for someone's email replies only when it shows the CRM has seen their email since your
  // last message (an email or message either way, on or after that day). Nothing logged can mean the CRM doesn't
  // have them, logs only outgoing mail, or is behind: those people are asked about instead.
  // It also has to have shown, at least once for this event, that it logs incoming email at all: a CRM that logs
  // only the mail you send (BCC logging) shows your own message and never the reply.
  const lastSentDay = (id) =>
    Object.values(c.state[id]?.sent || {})
      .map(String)
      .sort()
      .pop() || null;
  // Email only: a CRM that logs incoming LinkedIn messages but only the email you send can't see an email reply.
  const inbound =
    opts.source === 'crm' && (c.folded.last?.crm_logs_inbound === true || r.people.some((p) => p.items.some((x) => x.email && x.direction === 'in')));
  const sees = (p) => {
    const d = lastSentDay(p.id);
    return inbound && p.items.some((x) => x.email && (!d || todayKeyIn(c.event.time_zone, new Date(x.at)) >= d));
  };
  const blind = opts.source === 'crm' ? r.people.filter((p) => !sees(p)).map((p) => p.id) : [];
  const partial = readJson(join(c.paths.dir, 'sync-list.meta.json'), {})?.partial === true;
  led(c, {
    type: 'sync_ran',
    source: opts.source,
    people: r.people.length,
    run: sessionRun(),
    ...(opts.source === 'crm'
      ? { blind: blind.slice(0, 200), seen: r.people.map((p) => p.id).slice(0, 500), logs_inbound: inbound, ...(partial ? { partial: true } : {}) }
      : {})
  });
  // Each person whose messages or activity were read: their replies were checked now (a follow-up may go).
  for (const p of r.people) led(c, { type: 'checked', id: p.id, source: opts.source, ...(opts.source === 'crm' ? { sees_email: !blind.includes(p.id) } : {}) });
  return {
    saved: true,
    checked: r.people.length,
    recorded: plan.lines,
    ask_user: plan.asks,
    ignored_older_or_notes: plan.ignored,
    ...(blind.length
      ? {
          crm_cant_see: blind.map((id) => c.byId[id]?.name || id),
          crm_cant_see_note: inbound
            ? "The CRM shows no email with these people since your last message, so it can't say whether they replied: you'll be asked about them."
            : "The CRM hasn't logged an incoming email from anyone at this event yet, so it can't say whether anyone replied: you'll be asked instead."
        }
      : {})
  };
}

export function summary(opts) {
  need(opts, 'event');
  const c = ctxOf(opts.event, opts);
  const due = [],
    waiting = [],
    away = [];
  const awayOf = (id) => awayUntil(c.folded.people[id], c.today);
  const listAway = (id) => {
    if (!away.some((a) => a.id === id)) away.push({ id, name: c.byId[id]?.name, until: awayOf(id), note: awayNote(awayOf(id)) });
  };
  // Once the event is over (today in its time past its last day), or while its dates can't be read, nothing is due or
  // waiting to go (lib/spacing.mjs stateOf: the guard's answer too).
  const dayState = stateOf(c);
  const over = dayState.state !== 'ok';
  for (const [id, st] of Object.entries(over ? {} : c.state)) {
    const sent = Object.keys(st.sent || {})
      .map(Number)
      .sort((a, b) => a - b);
    if (!sent.length || st.replied || st.booked || st.unclear?.length || c.blocked(id)) continue;
    // Coordinate notes go to a colleague once; they have no follow-ups.
    if ((c.short.coordinate || []).includes(id)) continue;
    const last = sent[sent.length - 1];
    let upcoming = last + 1;
    while (st.touches?.[upcoming]?.skipped) upcoming++;
    const steps = routeOf(c, id);
    const already = isOut(st.touches?.[upcoming]?.status);
    // Its day by the one rule todo, send-list and the guard use (lib/spacing.mjs followupDay), within the sequence.
    const d = upcoming <= (steps ? steps.length : c.settings.touches) ? followupDayOf(c, id, upcoming).day : null;
    const fits = d && !already;
    if ((fits || already) && awayOf(id)) listAway(id);
    if (fits) due.push({ id, name: c.byId[id]?.name, next_touch: upcoming, due: d });
    else if (already) waiting.push({ id, name: c.byId[id]?.name, touch: upcoming });
  }
  // Anything approved or in the outbox and not yet sent is waiting to be sent, first messages included; once the
  // event is over (today in its time past its last day) nothing is (follow-ups have no day then either).
  const blockedNow = [];
  for (const [id, st] of Object.entries(over ? {} : c.state)) {
    for (const [t, tt] of Object.entries(st.touches || {})) {
      if (!isOut(tt.status) || st.sent?.[t]) continue;
      // Passed over: a later step already went, so this one never goes (the guard and send-list refuse it too).
      if (Number(t) > 0 && Object.keys(st.sent || {}).some((k) => Number(k) > Number(t))) continue;
      // What the message is comes from its own draft, not from today's lists: a cold email to someone now
      // on the coordinate list is still a cold email, and must not be sent.
      const kind = tt.kind || 'message';
      if (kind === 'coordinate' && colleagueTold(st)) continue; // the colleague has it
      const why = c.blocked(id, kind === 'coordinate' ? 'coordinate' : 'message');
      if (why) {
        if (!st.stopped && !st.removed && !st.dropped && !blockedNow.some((b) => b.id === id)) blockedNow.push({ id, name: c.byId[id]?.name, reason: why });
        continue;
      }
      if ((st.replied || st.booked) && Number(t) !== 0) continue; // after a yes, only the confirmation is left
      if (Number(t) !== 0 && awayOf(id)) listAway(id);
      if (!waiting.some((w) => w.id === id && w.touch === Number(t)))
        waiting.push({ id, name: c.byId[id]?.name, touch: Number(t), coordinate_note: kind === 'coordinate' || undefined });
    }
  }
  // One message a day to a person across all your events: a message whose address another event wrote to today says
  // so (the outbox card shows it with nothing to copy, and the guard holds it).
  if (waiting.length) {
    const sends = homeSends();
    for (const w of waiting) {
      if (w.touch === 0 || w.coordinate_note) continue;
      const to = c.state[w.id]?.touches?.[w.touch]?.approved?.to;
      const busy = to ? addressBusyToday(c.paths.dir, to, c.now.getTime(), w.id, sends) : null;
      if (busy) w.not_today = busyWhy(busy, w.name || w.id, to);
    }
  }
  due.sort((a, b) => a.due.localeCompare(b.due));
  const todayK = c.today;
  for (const d of due) if (d.due < todayK) d.due = todayK;
  // A follow-up whose draft failed the critic twice waits for the user: listed as held, not as due.
  const heldNow = new Set((readTodo(c, { jobs: [] }).jobs || []).filter((j) => j.held_for_user).map((j) => j.id));
  const held = [];
  for (let i = due.length - 1; i >= 0; i--) {
    const d = savedDraft(c, due[i].id, due[i].next_touch);
    if (heldNow.has(due[i].id) || (d?.verdict?.verdict === 'FAIL' && criticFails(c, due[i].id, due[i].next_touch) >= 2)) {
      held.push({ id: due[i].id, name: due[i].name, touch: due[i].next_touch, note: 'failed the critic twice: approve, edit or drop it by ID' });
      due.splice(i, 1);
    }
  }
  return {
    outbox: c.paths.outbox,
    follow_ups_due: due,
    held_for_you: held.length ? held : undefined,
    in_outbox_to_send: waiting.length ? waiting : undefined,
    away: away.length ? away : undefined,
    do_not_send: blockedNow.length
      ? { note: "Approved earlier, but now blocked: don't send these. They're out of the outbox; delete any copy already in your mailbox.", people: blockedNow }
      : undefined,
    dates_unreadable: dayState.state === 'unreadable' || undefined,
    note: over
      ? dayState.state === 'unreadable'
        ? `${c.event.name}: ${dayState.why}. Nothing is sent for it until then.`
        : `${c.event.name} is over: nothing more is sent for it, and no follow-up is due.`
      : due.length
      ? `Run /floorboss:start again on or after ${due[0].due}.`
      : sendingOn(c.settings)
        ? 'floorboss sends the approved messages on the channels you turned on (step 6c); anything on another channel is in the outbox for you to send and tick.'
        : 'Tick Sent in the outbox as you send; follow-ups are timed from those dates.'
  };
}
