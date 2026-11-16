// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// What may be sent, worked out from the ledger rather than from any list a session wrote. Used by
// `outreach send-list` and, independently, by the guard hook on every send call: a send-list.json entry is
// only a pointer; the guard rebuilds the message from the approval in the ledger (which names the recipient)
// and the content-addressed draft, and lets it through only if they agree. A forged list, an edited contact,
// a changed text or an approval with no fingerprint never sends. What this does NOT do: stop a session that
// rewrites the ledger and the draft together (the hash has no secret, and every file is under the floorboss
// home). That is what Claude Code's prompt before each send is for; the guard never lets a send through
// without it.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { home, SLUG_RE } from './paths.mjs';
import { readLedger, readLedgerText, readableEntry, fold, legacyState, contactable } from './ledger.mjs';
import { SHARED_INBOX, normPersonName } from './normalize.mjs';
import { todayKeyIn } from './tz.mjs';
import { sentKind, touchBefore, plannedStep, personRoute } from './route.mjs';
import { followupDay, longDate, noDayWhy, eventDayState, UNREADABLE_DATES, isDateKey, zoneReadable } from './spacing.mjs';

// Who a message goes to on its channel: the email address, the chat number, or (event app, LinkedIn) the
// profile link or name and company. routeStep: a route step decides the channel, so a phone number doesn't.
export function recipientOf(ct, channel, settings, { routeStep = false } = {}) {
  if (!ct) return null;
  if (channel === 'email')
    return (
      String(ct.email || '')
        .trim()
        .toLowerCase() || null
    );
  const chat = !routeStep && (settings?.sending?.channels || []).includes('chat') && ct.phone;
  if (chat) return String(ct.phone).replace(/[^\d+]/g, '');
  return ct.profile_url || `${ct.name} (${ct.company})`;
}

// The approval fingerprint: the exact subject and body, the channel, and the recipient. Approving a message
// approves it for that person on that channel only. The same function names the content-addressed draft file.
export function approvalHash(d, recipient) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        d?.channel || '',
        String(recipient || '')
          .trim()
          .toLowerCase(),
        d?.subject || '',
        d?.body || ''
      ])
    )
    .digest('hex')
    .slice(0, 24);
}

// Sends the user has turned on, by the via they need.
export function channelOn(settings, via) {
  const ch = settings?.sending?.channels || [];
  return via === 'email.send'
    ? ch.includes('email')
    : via === 'chat.send'
      ? ch.includes('chat')
      : via === 'browser'
        ? ch.includes('app') || ch.includes('linkedin')
        : false;
}

// How fresh a reply check must be for a follow-up: per person, after their last message, and at most this
// many seconds before the send: check one person, then send to them, then the next. Checked again on the
// send call itself, so a long batch can't stretch it.
export const REPLY_CHECK_SECONDS = 90;
// A channel this person was written to earlier, other than the one this message goes on: checked in this long before
// the send, since reading one inbox after another (a browser page, then the mailbox) can outlast 90 seconds.
export const OTHER_CHANNEL_CHECK_SECONDS = 600;

// The latest reply check for this person that could see this channel. Email: their mailbox search,
// a CRM read that showed the CRM has seen their email since your last message (sees_email: a CRM with
// no record of them, or one that logs only outgoing mail, can't vouch that nobody replied), or the user's own
// word where that counts (userWordCounts); chat: CRM tasks, a CRM sync, or the user's own word.
// readers: which kinds of reply floorboss can read itself ({ email, crm, other }); where it can, only a real
// check of this person counts. sentAtMs: when the message before the follow-up went.
// A browser send (LinkedIn, the app) counts only a read of that inbox (kind) or the user's word about it: a CRM read
// shows nothing about whether someone answered there.
export function lastReplyCheck(entries, id, via, readers = {}, sentAtMs = 0, kind = null) {
  const email = via === 'email.send';
  const real = (e) =>
    (e.type === 'reply_checked' || e.type === 'checked') &&
    e.id === id &&
    (email
      ? e.source === 'mailbox' || (readers.crm && e.source === 'crm' && e.sees_email === true)
      : [...(via === 'browser' ? [] : ['crm', 'tasks']), ...(kind ? [kind] : ['linkedin', 'app'])].includes(e.source));
  const wordOk = userWordCounts(entries, id, via, readers, sentAtMs);
  // A word about one channel answers for that channel only, an older word with no channel for all. A status paste or
  // "nothing changed" names no inbox: it never answers for LinkedIn or the app, where the user is asked about that inbox.
  const about = email ? 'email' : kind;
  const word = (e) =>
    wordOk &&
    ['no_reply_said', 'user_says_no_reply', 'status_pasted'].includes(e.type) &&
    !(e.type === 'status_pasted' && (about === 'linkedin' || about === 'app')) &&
    (!e.ids || e.ids.includes(id)) &&
    (!e.channel || !about || e.channel === about);
  const hit = [...entries].reverse().find((e) => real(e) || word(e));
  return hit ? Date.parse(hit.at) : null;
}

// Whether the user's own word ("no reply") counts for this person: only where nothing floorboss can read could
// see their reply. With the CRM readable and no mailbox, it counts once a CRM read since the last message
// showed the CRM hasn't seen their email.
export function userWordCounts(entries, id, via, readers = {}, sentAtMs = 0) {
  if (via !== 'email.send') return !readers.other;
  if (readers.email) return false;
  if (!readers.crm) return true;
  return entries.some((e) => e.type === 'checked' && e.id === id && e.source === 'crm' && e.sees_email === false && Date.parse(e.at) >= sentAtMs);
}

// The readers, less any that failed and that the user chose to answer for instead ("ask me"): an answer about
// one reader covers that reader only (older answers, with no task, were about the mailbox).
export function withFallbacks(readers, folded) {
  const fb = folded?.answered?.reader_fallback;
  const gaveUp = (task) => {
    const f = folded?.tool_failed?.[task];
    return !!(f && fb && (fb.task ? fb.task === task : task === 'email.messages') && Date.parse(fb.at) >= Date.parse(f.at));
  };
  const crmOff = gaveUp('crm.activity');
  return { ...readers, ...(gaveUp('email.messages') ? { email: false } : {}), ...(crmOff ? { crm: false, other: !!readers.tasks } : {}) };
}

// Is this item (from a list) an approved, unsent message, exactly as approved? evDir: the event folder.
// Returns { ok: true, hash } or { ok: false, why }.
// The file name of the guard's mark for a CRM task it let through: the task's key (any characters) hashed.
export const taskMark = (key) => createHash('sha256').update(String(key)).digest('hex').slice(0, 32);

const foldCaseAscii = (v) =>
  String(v ?? '')
    .trim()
    .replace(/[A-Z]/g, (ch) => ch.toLowerCase());

// Which inbox a listed message goes to: 'email', 'linkedin', 'app', or null (chat).
export const itemKind = (item) => (item.via === 'email.send' ? 'email' : item.via === 'browser' ? (item.where === 'LinkedIn' ? 'linkedin' : 'app') : null);

// What a touch sent with no label was meant for, from the contact's route (the contact list and event file are read
// only if some touch needs them). Empty when they can't be read: the send then counts as email, as it always has.
function routeSteps(evDir, settings, person, id) {
  let steps;
  return (t) => {
    if (steps === undefined) {
      steps = null;
      try {
        const ct = JSON.parse(readFileSync(join(evDir, 'derived', 'contacts.json'), 'utf8')).find((x) => x.id === id);
        steps = personRoute(ct, JSON.parse(readFileSync(join(evDir, 'event.json'), 'utf8')), settings, person?.channel) || null;
      } catch {
        steps = null;
      }
    }
    return steps?.[t - 1] || null;
  };
}

// The channels this person was written to before this message, other than its own, with no recent check of replies
// there. Someone who answered in the event app must not get the next email. Asked directly, the user's word counts
// for an inbox floorboss isn't reading (the app, LinkedIn); for email, only where the mailbox can't be read.
export function uncheckedChannels(item, person, entries, readers, nowMs, { stepAt = () => null, appName = null } = {}) {
  const own = itemKind(item);
  const latest = {};
  for (const [t, x] of Object.entries(person?.touches || {})) {
    if (Number(t) < 1 || Number(t) >= item.touch || !x.sent) continue;
    const kind = sentKind(x.sent, { step: plannedStep(x, stepAt(Number(t))), appName });
    if (kind && kind !== own) latest[kind] = Math.max(latest[kind] || 0, Date.parse(x.sent_at || 0) || 0);
  }
  return Object.keys(latest).filter((kind) => {
    const at = lastReplyCheck(entries, item.id, kind === 'email' ? 'email.send' : 'browser', kind === 'email' ? readers : { ...readers, other: false }, latest[kind], kind);
    return !at || at < latest[kind] || at - nowMs > 60000 || nowMs - at > OTHER_CHANNEL_CHECK_SECONDS * 1000;
  });
}

// The oldest of the reply checks a follow-up needs: its own inbox and every other inbox the person was written to
// (uncheckedChannels), for the send prompt to say. null when one of them has none.
export function oldestReplyCheck(item, { evDir, settings, entries, readers = readersOf(settings) }) {
  const fd = fold(entries);
  const person = fd.people[item.id];
  let appName = null;
  try {
    appName = JSON.parse(readFileSync(join(evDir, 'event.json'), 'utf8')).app_name || null;
  } catch {}
  const rd = withFallbacks(readers, fd);
  const stepAt = routeSteps(evDir, settings, person, item.id);
  const own = itemKind(item);
  const latest = {};
  for (const [t, x] of Object.entries(person?.touches || {})) {
    if (Number(t) < 1 || Number(t) >= item.touch || !x.sent) continue;
    const kind = sentKind(x.sent, { step: plannedStep(x, stepAt(Number(t))), appName });
    if (kind && kind !== own) latest[kind] = Math.max(latest[kind] || 0, Date.parse(x.sent_at || 0) || 0);
  }
  const times = [
    lastReplyCheck(entries, item.id, item.via, item.via === 'browser' ? { ...rd, other: false } : rd, 0, own),
    ...Object.keys(latest).map((k) => lastReplyCheck(entries, item.id, k === 'email' ? 'email.send' : 'browser', k === 'email' ? rd : { ...rd, other: false }, latest[k], k))
  ];
  return times.some((x) => !x) ? null : Math.min(...times);
}

// replyCheck: false leaves out the reply freshness checks (a browser note typed in a send window: see the guard).
// sends: homeSends(), for a caller checking many messages at once.
export function verifySend(item, { evDir, settings, state, entries, folded = null, nowMs = Date.now(), readers = readersOf(settings), replyCheck = true, sends = null }) {
  if (!item || typeof item !== 'object' || !/^c\d+$/.test(String(item.id)) || !Number.isInteger(item.touch))
    return { ok: false, why: 'not a floorboss message' };
  if (!channelOn(settings, item.via)) return { ok: false, why: `sending on ${item.via} isn't turned on for this event` };
  // floorboss's work for an event ends with it: once today, in the event's time, is past its last day, nothing goes
  // (first messages, follow-ups and confirmations alike).
  // An event whose dates can't be read is held the same way, with its own reason.
  if (evDir) {
    const es = eventStateAt(evDir, nowMs);
    if (es.state !== 'ok') return { ok: false, why: es.why };
  }
  const st = state[item.id] || {};
  // The ledger's own rule for who may be written to (a stop, a skip or colleague decision, a duplicate, a
  // damaged line anywhere, a bounce with no new address, a reply or booking), checked on every send.
  const fd = folded || fold(entries);
  const kind = item.touch === 0 ? 'confirmation' : 'message';
  const held = contactable(fd, item.id, kind, evDir ? eventDay(evDir, nowMs) : null);
  if (held) return { ok: false, why: held };
  const person = fd.people[item.id];
  // The event app said this person can't be written to there (gone from the event, or messages turned off).
  const ar = person.touches?.[item.touch]?.app_result;
  if (item.via === 'browser' && ar && ['not_found', 'messages_off'].includes(ar.result))
    return { ok: false, why: `the app says: ${ar.page_says || (ar.result === 'not_found' ? 'not found' : 'messages are turned off')}` };
  // A confirmation is for a booking that still stands.
  if (kind === 'confirmation' && !person.booked) return { ok: false, why: 'their booking was taken back: no confirmation to send' };
  if (st.log_damaged) return { ok: false, why: `line ${st.log_damaged} of the ledger, which names them, is damaged: check it first` };
  if (st.stopped || st.removed || st.dropped) return { ok: false, why: "they're stopped, removed or dropped" };
  const tc = person.touches?.[item.touch];
  if (tc?.dropped) return { ok: false, why: 'you dropped this message at the gate' };
  if (tc?.revising && tc.revise) return { ok: false, why: 'you sent this message back for a rewrite: approve the new text first' };
  if (item.touch > 1 && (st.replied || st.booked)) return { ok: false, why: 'they replied or booked' };
  // An email that bounced with no new address: nothing more goes to that address.
  if (item.via === 'email.send' && st.bounced === true) return { ok: false, why: 'their email bounced and there is no new address' };
  if (st.sent?.[item.touch]) return { ok: false, why: 'already sent' };
  // Let through once already, unless the user since said to send it again (resend, with their words). The guard's
  // marker for it with no release in the ledger is the same once no live guard can hold it (a guard stopped between
  // the two may have let it go); before that, a call for it may still be going through.
  const rel = entries.filter((e) => e.id === item.id && e.touch === item.touch && ['send_released', 'release_cleared', 'bounced'].includes(e.type)).pop();
  const mark = rel?.type === 'send_released' || !evDir ? null : markerOnly(evDir, entries, item.id, item.touch);
  if (rel?.type === 'send_released' || (mark && !mark.fresh))
    return { ok: false, why: "already let through once (it may have gone): check, then record it, or resend with the user's words" };
  if (mark) return { ok: false, why: IN_FLIGHT };
  if (tc?.skipped) return { ok: false, why: 'you skipped this step' };
  // At most one message to a person a day (in the event's time), whatever listed it: another step sent today, or
  // let through today and not cleared, holds this one to another day. hooks/guard.mjs takes a per-person, per-day
  // marker too, so two calls at the same moment can't both pass. A meeting confirmation is the one exception: it
  // answers the person's own booking (often the same day as the message they booked from), and someone who booked
  // gets no other message, so it can never make a second unasked-for message in a day.
  const other = item.touch === 0 ? null : sentOrGoingToday(entries, st, item, evDir, nowMs);
  if (other != null) return { ok: false, why: `another message to ${person.name || item.id} already went or is going today` };
  // And across this home's events, by address: one message a day to a person at all your events.
  const elsewhere = item.touch === 0 || !evDir ? null : addressBusyToday(evDir, item.to, nowMs, item.id, sends);
  if (elsewhere) return { ok: false, why: busyWhy(elsewhere, person.name || item.id, item.to) };
  // A later step already went (recorded by hand, or found in the mailbox): this one was written to come before it.
  if (item.touch > 0 && Object.keys(st.sent || {}).some((k) => Number(k) > item.touch)) return { ok: false, why: 'a later message already went' };
  const before = touchBefore(st, item.touch);
  if (item.touch > 1 && !st.sent?.[before]) return { ok: false, why: "the message before it hasn't gone" };
  if (item.touch > 1 && replyCheck) {
    let appName = null;
    try {
      appName = JSON.parse(readFileSync(join(evDir, 'event.json'), 'utf8')).app_name || null;
    } catch {}
    const unchecked = uncheckedChannels(item, person, entries, withFallbacks(readers, fd), nowMs, { stepAt: routeSteps(evDir, settings, person, item.id), appName });
    if (unchecked.length)
      return {
        ok: false,
        why: `their replies weren't checked on every channel they were written to (${unchecked.join(', ')}): check, then send`,
        check: unchecked
      };
    const sentAt = Date.parse(st.sent_at?.[before] || `${st.sent[before]}T00:00:00Z`);
    // A reply reader that failed (and hasn't worked since) can't see replies: the user's word counts again.
    const rd = withFallbacks(readers, fd);
    // A CRM can't vouch for a browser inbox, so there the user's answer about it counts with a CRM connected. The
    // send-list flag can't stand in for that answer: it is refused where a reader exists (userWordCounts).
    const at = lastReplyCheck(entries, item.id, item.via, item.via === 'browser' ? { ...rd, other: false } : rd, sentAt, itemKind(item));
    // A check dated ahead of the clock (more than a minute) is no check: it could otherwise stand for any time.
    if (at && at - nowMs > 60000) return { ok: false, why: 'their last reply check is dated in the future: check this person again, then send' };
    if (!at || at < sentAt || nowMs - at > REPLY_CHECK_SECONDS * 1000)
      return { ok: false, why: `their replies weren't checked in the ${REPLY_CHECK_SECONDS} seconds before this send: check this person, then send` };
  }
  const appr = st.touches?.[item.touch]?.approved;
  if (!appr?.hash) return { ok: false, why: 'no approval with a fingerprint: approve it again' };
  const f = join(evDir, 'drafts', `${appr.hash}.json`);
  if (!existsSync(f)) return { ok: false, why: 'no saved draft for the approved text' };
  const d = JSON.parse(readFileSync(f, 'utf8'));
  // The approval names the recipient: a contact whose address changed since (a bounce) needs approving again.
  const to = appr.to || null;
  if (!to || approvalHash(d, to) !== appr.hash) return { ok: false, why: 'the text, channel or recipient changed since it was approved: approve it again' };
  // A paste note's channel is "paste" on every platform: the approval also names where it was approved to go.
  if (item.via === 'browser' && appr.where && item.where !== appr.where)
    return { ok: false, why: `it was approved to go on ${appr.where}, and the route now sends it on ${item.where}: approve it again` };
  // What the CLI checks when it lists a message, checked again at the send: a confirmation is for the booking that
  // stands now (one moved since says the old time), and offered times are still free and still ahead.
  const dr = entries.filter((e) => e.type === 'drafted' && e.id === item.id && (e.touch ?? 1) === item.touch && e.hash === appr.hash).pop();
  if (kind === 'confirmation' && dr?.booked_slot && dr.booked_slot !== person.booked)
    return { ok: false, why: 'the booking this confirms changed since it was drafted: redraft it' };
  // A follow-up goes on its day, never before, worked out as send-list works it out (the plan the ledger saved,
  // or the approved draft's for a save older than that), so a list written by hand can't bring one forward.
  if (kind === 'message' && item.touch > 1) {
    const why = followupNotToday(evDir, settings, entries, st, item, nowMs, d);
    if (why) return { ok: false, why };
  }
  if (kind === 'message' && (dr?.slot_ids || []).length) {
    const takenBy = new Map(
      Object.entries(fd.people || {})
        .filter(([, p]) => p?.booked && !p.stopped)
        .map(([cid, p]) => [p.booked, cid])
    );
    let slots = [];
    try {
      slots = JSON.parse(readFileSync(join(evDir, 'slots.json'), 'utf8')).slots || [];
    } catch {}
    const start = Object.fromEntries(slots.map((x) => [x.id, Date.parse(x.start)]));
    const gone = dr.slot_ids.filter((x) => (takenBy.has(x) && takenBy.get(x) !== item.id) || (start[x] && start[x] <= nowMs));
    if (gone.length) return { ok: false, why: `it offers times that are gone (${gone.join(', ')}): redraft it with new times` };
  }
  // The approved address must still be theirs (a bounce with a new address needs approving again).
  const current = String(person.email_override || person.email || '').trim();
  if (item.via === 'email.send' && current && foldCaseAscii(current) !== foldCaseAscii(to))
    return { ok: false, why: `their address is now ${current}: approve the message to the new address` };
  // A message (not a confirmation) goes only once the ledger says it was read: the critic passed exactly this text,
  // the user skipped the review for it, or they approved it by name past the critic's fail; and floorboss's own
  // checks passed when it was saved. Never from a working copy's verdict, which Claude may write.
  if (kind === 'message') {
    const why = unreviewed(entries, item.id, item.touch, appr.hash);
    if (why) return { ok: false, why };
  }
  const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
  // The listed recipient must be the approved one, character for character (ASCII case aside): no quotes,
  // brackets or invisible characters around it, since the call sends the listed string as it is.
  const foldCase = (v) =>
    String(v ?? '')
      .trim()
      .replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  if (!same(item.body, d.body) || !same(item.subject || '', d.subject || '') || foldCase(item.to) !== foldCase(to))
    return { ok: false, why: 'the listed message differs from the approved one' };
  return { ok: true, hash: appr.hash };
}

// Why the ledger doesn't let this text go as reviewed, or null. The latest critic verdict on exactly this text
// decides; with none, the user's skip of the review for it; a FAIL goes only with the approval of this text that
// says the user named it past the fail (critic_override).
export function unreviewed(entries, id, touch, hash) {
  const mine = entries.filter((e) => e && e.id === id && (e.touch ?? 1) === touch && e.hash === hash);
  const saved = mine.filter((e) => e.type === 'drafted').pop();
  if (!saved) return 'no saved draft in the ledger for the approved text: save it, have it read, and approve it again';
  if ((saved.checks || []).length) return `floorboss's checks failed on the approved text (${saved.checks.join('; ')}): approve it again once they pass`;
  const critic = mine.filter((e) => e.type === 'critic').pop();
  if (critic?.verdict === 'PASS') return null;
  if (critic?.verdict === 'FAIL')
    return mine.some((e) => e.type === 'approved' && e.critic_override === true)
      ? null
      : "the critic failed this text and the user didn't approve it by name: approve it by name to send it anyway";
  if (mine.some((e) => e.type === 'review_skipped')) return null;
  return "the critic hasn't read the approved text: run the critic, then approve it again";
}

// Everything the guard needs for one event folder: the ledger, folded into the per-contact shape.
// The event's day now, in its own time zone (an out-of-office's "back on" day is one), or null without one.
export function eventDay(evDir, nowMs = Date.now()) {
  try {
    return eventStateAt(evDir, nowMs).today || null;
  } catch {
    return null;
  }
}

// Why a follow-up (item.touch > 1) can't go today, or null: its day by the one rule (lib/spacing.mjs followupDay),
// from the plan the ledger saved with its approved text (the draft file's for a save older than that), the plan of the
// message before it, today in the event's time and the latest send to the person. Sends and staging both use it.
export function followupNotToday(evDir, settings, entries, st, item, nowMs = Date.now(), draft = null) {
  let ev = null;
  try {
    ev = JSON.parse(readFileSync(join(evDir, 'event.json'), 'utf8'));
  } catch {}
  const es = eventDayState(ev, nowMs);
  if (es.state === 'unreadable') return es.why || UNREADABLE_DATES;
  const before = touchBefore(st, item.touch);
  const saved = planFor(entries, item.id, item.touch, st.touches?.[item.touch]?.approved?.hash);
  const plan = saved?.has_plan ? saved : draft || {};
  // The plan of the message before it (as saved with the text that went): sent on its planned day, the plan stands.
  const pdr = before > 1 ? planFor(entries, item.id, before, st.touches?.[before]?.hash) : null;
  const today = es.today;
  const r = followupDay(settings, ev, {
    prevSent: st.sent?.[before],
    touch: item.touch,
    planned_due: plan.planned_due,
    planned_gap: plan.planned_gap,
    planned_from: plan.planned_from,
    prev_planned_due: pdr?.planned_due,
    prev_planned_gap: pdr?.planned_gap,
    today,
    // The latest send to this person at any step (plain dates only): a step recorded out of order counts from it.
    lastSent: Object.values(st.sent || {}).filter(isDateKey).sort().pop() || null,
    laterSent: Object.keys(st.sent || {}).some((k) => Number(k) > item.touch)
  });
  if (!r.day) return noDayWhy(r);
  if (r.day > today) return `it isn't due until ${longDate(r.day)}, ${ev.city || ev.time_zone} time`;
  return null;
}

// Where the event in this folder stands today (lib/spacing.mjs eventDayState: 'ok', 'over' or 'unreadable', with the
// reason). A file that can't be read is 'unreadable': nothing goes, and it says why.
export function eventStateAt(evDir, nowMs = Date.now()) {
  try {
    return eventDayState(JSON.parse(readFileSync(join(evDir, 'event.json'), 'utf8')), nowMs);
  } catch {
    return eventDayState(null, nowMs);
  }
}
// The day a recorded time falls on in a zone, or null for a time that can't be read.
function dayAt(zone, iso) {
  try {
    return iso ? todayKeyIn(zone, new Date(iso)) : null;
  } catch {
    return null;
  }
}
// Whether nothing may go for this event today: it's over, or its dates can't be read.
export const eventEnded = (evDir, nowMs = Date.now()) => eventStateAt(evDir, nowMs).state !== 'ok';

// Another message to this person today, at any step and on any channel, the touch it names or null: one recorded as
// sent today, or one the guard let through today. A release made today counts whatever is recorded about that step
// later (a hand record dating it earlier, a send-outcome saying it didn't go): only that same step may go again
// today, never another. Today and the release time are read in the event's zone. A meeting confirmation (touch 0) is
// the one exception both ways: it holds nothing, and nothing holds it.
export function sentOrGoingToday(entries, st, item, evDir, nowMs = Date.now()) {
  const es = evDir ? eventStateAt(evDir, nowMs) : null;
  if (!es?.today) return null;
  let zone = 'UTC';
  try {
    zone = JSON.parse(readFileSync(join(evDir, 'event.json'), 'utf8')).time_zone;
  } catch {}
  for (const [t, d] of Object.entries(st.sent || {})) if (Number(t) !== item.touch && Number(t) !== 0 && d === es.today) return Number(t);
  for (const e of entries)
    if (e?.id === item.id && e.type === 'send_released' && (e.touch ?? 1) !== item.touch && (e.touch ?? 1) !== 0 && dayAt(zone, e.at) === es.today) return e.touch ?? 1;
  return null;
}

// The address a message goes to, as one person is known across events: an email lower-cased and trimmed; for other
// channels the profile link or the app's name for them, the same way.
export const addressKey = (to) => String(to ?? '').trim().toLowerCase();
// A profile link in its bare form (no "https://", "www.", query or trailing slash), as a person's list entry keeps it
// ("u:linkedin.com/in/ana"): one link written two ways is one address. null for anything that isn't a link.
const profileForm = (to) => {
  const k = addressKey(to);
  if (k.includes('@') || /\s/.test(k) || !/^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S/.test(k)) return null;
  return k.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '') || null;
};
// Every key an address is known by across events: the address as written, and a profile link's bare form too.
export const addressKeys = (to) => {
  const k = addressKey(to);
  if (!k) return [];
  const f = profileForm(to);
  return f ? [k, `u:${f}`] : [k];
};
// The one key a send to this address is locked under (hooks/guard/daymark.mjs sendLock): a profile link's bare form,
// so the same link written two ways at two events takes one lock.
export const lockKey = (to) => addressKeys(to).pop() || '';
// An inbox address (lib/normalize.mjs SHARED_INBOX: info@, hello@) as one person's at an event: kept with their name
// (lib/normalize.mjs normPersonName), so it matches the same name with the same address at another event and no one
// else there. '' for a name with no letters.
export const inboxKey = (name, address) => {
  const n = normPersonName(name);
  return n ? `n:${n}|${addressKey(address)}` : '';
};

// A message marker (released/<id>-<touch>-<clears>) younger than this may belong to a guard still checking that call:
// a guard answers within its deadline and Claude Code's hook timeout (30 seconds), so one older than this was stopped.
export const MARKER_LIVE_MS = 60 * 1000;

// One message a day to a person across all your events, by address. What each event in the home sent or let through,
// by address, is read once per process and kept while that event's ledger, event file and markers stay the same (the
// same file, size and times changed): a hook call or a send list reads each other ledger once, not once per listed
// message, and folds one only when one of the addresses asked about is in it.
const SENDS_SEEN = new Map();
// How many event folders this process has read for it, and how many ledgers it has folded (a test holds them to once).
const SENDS_READ = { read: 0, folded: 0 };
export const homeSendsReads = () => ({ ...SENDS_READ });
const statSig = (p) => {
  try {
    const s = statSync(p);
    return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch (e) {
    return e?.code === 'ENOENT' ? 'none' : `error:${e?.code}`;
  }
};
function eventSends(dir) {
  const sig = `${statSig(join(dir, 'ledger.jsonl'))}|${statSig(join(dir, 'event.json'))}|${statSig(join(dir, 'released'))}`;
  const seen = SENDS_SEEN.get(dir);
  if (seen?.sig === sig) return seen.sends;
  const sends = readEventSends(dir);
  SENDS_SEEN.set(dir, { sig, sends });
  return sends;
}
const pushTo = (map, k, v) => {
  if (!map.has(k)) map.set(k, []);
  map.get(k).push(v);
};
// Why an event's ledger can't be read, or null (no ledger at all is an event that sent nothing). A folder that can't be
// opened, or a ledger that is a link to a file that is gone, is not "nothing sent": floorboss can't tell.
function ledgerUnreadable(ledger) {
  try {
    statSync(ledger);
    return null;
  } catch (e) {
    if (e?.code !== 'ENOENT') return String(e?.code || 'unreadable').slice(0, 40);
    try {
      lstatSync(ledger);
      return 'a link to a file that is gone';
    } catch (e2) {
      return e2?.code === 'ENOENT' ? null : String(e2?.code || 'unreadable').slice(0, 40);
    }
  }
}
// One event's sends: { zone (null when its event file or zone can't be read), mock, unreadable (why its ledger can't be
// read), released: address -> [{ id, at }], known: the addresses its people have, addrById: id -> the addresses that
// are that person's alone there, damaged: the lines that could be a release and can't be read, text: the ledger }. A
// release (send_released) counts whatever is recorded about it later, and so does a guard's marker with no release
// once it is older than any live guard (MARKER_LIVE_MS: a guard stopped there may have let the message go), at the time
// the marker was made. Each counts under the address it went to and every address that event has for the person
// alone (their email, other emails, profile link, each approved address, a new address after a bounce), as a recorded
// send does (sentMarks). An address two people there have is no one's alone: it counts only for a message that went to
// it. Who has an address is read from the person lines (and merges): an approval or a new address after a bounce names
// where one message goes, so it never takes an address from the person whose line has it. An address on the inbox
// list (lib/normalize.mjs SHARED_INBOX: info@, hello@, sales@) says who someone is only with their name: it is kept as
// inboxKey(name, address), which matches the same name with the same address at another event, and the address alone
// counts only for a message that went to it. A coordinate note's approval names the colleague it goes to, not the
// person, and is left out. A meeting confirmation (touch 0) counts for nothing. Only the lines that can be a release,
// a clear, a person, a merge, an approval or a bounce are read here; sentMarks reads the rest.
function readEventSends(dir) {
  let zone = null,
    mock = false;
  try {
    const ev = JSON.parse(readFileSync(join(dir, 'event.json'), 'utf8'));
    zone = zoneReadable(ev?.time_zone) ? ev.time_zone : null;
    mock = ev?.mock === true;
  } catch {}
  SENDS_READ.read++;
  const out = { zone, mock, unreadable: null, released: new Map(), known: new Set(), addrById: new Map(), damaged: [], text: '', sent: undefined };
  const ledger = join(dir, 'ledger.jsonl');
  out.unreadable = ledgerUnreadable(ledger);
  if (out.unreadable || !existsSync(ledger)) return out;
  try {
    out.text = readFileSync(ledger, 'utf8');
  } catch (e) {
    out.unreadable = String(e?.code || 'unreadable').slice(0, 40);
    return out;
  }
  const releases = [],
    steps = new Map(),
    approvedTo = new Map(),
    into = new Map(),
    // address -> the id whose person line has it (the ids, once two lines do); id -> the latest name its lines give.
    lineIds = new Map(),
    names = new Map();
  const addTo = (id, k, line = false) => {
    out.known.add(k);
    if (id == null) return;
    const i = String(id);
    if (!out.addrById.has(i)) out.addrById.set(i, new Set());
    out.addrById.get(i).add(k);
    if (!line) return;
    const was = lineIds.get(k);
    if (was === undefined) lineIds.set(k, i);
    else if (Array.isArray(was)) {
      if (!was.includes(i)) was.push(i);
    } else if (was !== i) lineIds.set(k, [was, i]);
  };
  const known = (id, to, line = false) => {
    for (const k of addressKeys(to)) addTo(id, k, line);
  };
  for (const line of out.text.split('\n')) {
    // ('"person' finds a person line and a merge, "person_merged".)
    if (!line.includes('send_released') && !line.includes('"person') && !line.includes('"approved"') && !line.includes('release_cleared') && !line.includes('bounced')) continue;
    // An approval to an address its person is already known by here adds no address, and isn't parsed (on a large home
    // most are). The address that step goes to is still kept, for a stopped guard's marker and a release line with
    // none (below).
    if (line.includes('"type":"approved"')) {
      const id = /"id":"(c\d+)"/.exec(line)?.[1],
        to = /"to":"([^"\\]*)"/.exec(line)?.[1];
      const have = id && out.addrById.get(id);
      if (have && to && addressKeys(to).some((k) => have.has(k))) {
        approvedTo.set(`${id}:${Number(/"touch":(\d+)/.exec(line)?.[1] ?? 1)}`, to);
        continue;
      }
    }
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      // A damaged line that could be a release: kept, so one naming an address asked about holds it (fail closed).
      out.damaged.push(line.toLowerCase());
      continue;
    }
    // A line that reads as JSON but not as a ledger entry (a name every object has as its id) is damaged there too.
    if (!readableEntry(e)) {
      out.damaged.push(line.toLowerCase());
      continue;
    }
    const step = `${e.id}:${e.touch ?? 1}`;
    if (e.type === 'send_released') {
      steps.set(step, [...(steps.get(step) || []), 'released']);
      if ((e.touch ?? 1) !== 0) releases.push({ id: e.id, at: Date.parse(e.at), to: e.to, step });
    } else if (e.type === 'release_cleared') steps.set(step, [...(steps.get(step) || []), 'cleared']);
    else if (e.type === 'person_merged') {
      if (e.into != null) into.set(String(e.id), String(e.into));
    } else if (e.type === 'bounced') {
      if (e.touch != null) steps.set(step, [...(steps.get(step) || []), 'cleared']);
      if (e.new_email) known(e.id, e.new_email);
    } else if (e.type === 'person') {
      if (e.email) known(e.id, e.email, true);
      if (typeof e.name === 'string' && e.name.trim() && e.id != null) names.set(String(e.id), e.name);
      // The person's other addresses, as their list entry keeps them: another email (e:), a profile link (u:).
      for (const k of Array.isArray(e.keys) ? e.keys : [])
        if (typeof k === 'string' && k.startsWith('e:')) known(e.id, k.slice(2), true);
        else if (typeof k === 'string' && k.startsWith('u:') && k.length > 2) addTo(e.id, k, true);
    } else if (e.type === 'approved' && e.to && e.via !== 'note') {
      // The address a step was approved to go to (an email, a profile link, a chat number). A coordinate note's goes
      // to the colleague who holds the person: it is no address of theirs.
      known(e.id, e.to);
      approvedTo.set(step, e.to);
    }
  }
  // An address two people here have (an id merged into another counts as that one) says nothing about who someone is:
  // it leaves each person's own addresses, and counts only as the address a message went to. Who has it is read from
  // the person lines; only an address no person line has is counted from the approvals and bounces that name it.
  const rootOf = (id) => {
    let x = id;
    for (let n = 0; n < 64 && into.has(x); n++) x = into.get(x);
    return x;
  };
  // address -> the one person who has it, or null once a second one does: from every line, and (holderOf) from the
  // person lines when one has it.
  const anyHolder = new Map();
  for (const [id, ks] of out.addrById) {
    const r = rootOf(id);
    for (const k of ks) anyHolder.set(k, anyHolder.has(k) && anyHolder.get(k) !== r ? null : r);
  }
  const holderOf = (k) => {
    const ids = lineIds.get(k);
    if (ids === undefined) return anyHolder.get(k);
    if (!Array.isArray(ids)) return rootOf(ids);
    const r = rootOf(ids[0]);
    return ids.every((x) => rootOf(x) === r) ? r : null;
  };
  for (const [id, ks] of out.addrById) {
    const r = rootOf(id);
    let named;
    for (const k of ks) {
      // An inbox address is kept only with the person's name (none known: not at all).
      if (SHARED_INBOX.test(k)) {
        ks.delete(k);
        const n = names.get(id);
        if (n) (named ||= []).push(inboxKey(n, k));
      } else if (holderOf(k) !== r) ks.delete(k);
    }
    for (const k of named || [])
      if (k) {
        ks.add(k);
        out.known.add(k);
      }
  }
  // Under the address it went to (a release line with none: the one its step was approved to) and every address this
  // event has for the person alone.
  const allOf = (id, to) => {
    const own = out.addrById.get(String(id)) || new Set();
    return [...(to ? addressKeys(to).filter((k) => !own.has(k)) : []), ...own];
  };
  for (const r of releases) for (const k of allOf(r.id, r.to || approvedTo.get(r.step))) pushTo(out.released, k, { id: r.id, at: r.at });
  // A guard's marker with no release since the step's last clear, older than any live guard: it may have gone.
  let marks = [];
  try {
    marks = readdirSync(join(dir, 'released'));
  } catch {}
  for (const f of marks) {
    const m = /^(c\d+)-(\d+)-(\d+)$/.exec(f);
    if (!m || Number(m[2]) === 0) continue;
    const seq = steps.get(`${m[1]}:${Number(m[2])}`) || [];
    if (seq[seq.length - 1] === 'released' || seq.filter((x) => x === 'cleared').length !== Number(m[3])) continue;
    let at;
    try {
      at = statSync(join(dir, 'released', f)).mtimeMs;
    } catch {
      continue;
    }
    if (Date.now() - at < MARKER_LIVE_MS) continue;
    for (const k of allOf(m[1], approvedTo.get(`${m[1]}:${Number(m[2])}`))) pushTo(out.released, k, { id: m[1], at });
  }
  return out;
}
// The sends recorded at that event, by address, from its ledger as folded (each send's date, an undo respected):
// address -> [{ id, at (when its line was written), date }], under every address that event has for the person alone,
// and an email also under the address it went to (their email, or the one its step was approved to), shared or not.
// Folded once, the first time an address of its is asked about; null when it can't be folded (held as damaged).
const mailKeys = (a) => (String(a ?? '').includes('@') ? addressKeys(a) : []);
function sentMarks(ev) {
  if (ev.sent === undefined) {
    SENDS_READ.folded++;
    let marks = null;
    try {
      const { entries, damaged } = readLedgerText(ev.text);
      marks = new Map();
      const fd = fold(entries, damaged);
      // A line fold couldn't take there (a field of the wrong kind) holds an address it names, as a damaged line does.
      ev.foldDamaged = (fd.unread || []).map((d) => d.text.toLowerCase());
      for (const [id, p] of Object.entries(fd.people || {})) {
        const own = ev.addrById.get(id) || new Set();
        // Their email when it isn't theirs alone here (a shared inbox): it counts for an email only.
        const notOwn = (a) => a != null && a !== '' && !own.has(addressKey(a));
        const mailShared = notOwn(p.email) || notOwn(p.email_override);
        for (const [t, x] of Object.entries(p.touches || {})) {
          if (Number(t) === 0 || !x?.sent) continue;
          // (A coordinate note's approval names the colleague, not where a message to the person went.)
          const to = x.approved?.via === 'note' ? null : x.approved?.to;
          // A send whose channel isn't said counts as email, as it always has (lib/route.mjs sentKind).
          const keys =
            (mailShared || (String(to ?? '').includes('@') && notOwn(to))) && sentKind(x.sent) === 'email'
              ? new Set([...own, ...addressKeys(p.email_override), ...addressKeys(p.email), ...mailKeys(to)])
              : own;
          for (const k of keys) pushTo(marks, k, { id, at: Date.parse(x.sent_at), date: isDateKey(x.sent.date) ? x.sent.date : null });
        }
      }
    } catch {
      marks = null;
    }
    // Set only once the whole ledger is read: a fold that failed is never kept as "nothing sent".
    ev.sent = marks;
  }
  return ev.sent;
}
// What an entry in the events folder is, looked at without following it first: 'event' (a folder, or a link to one),
// null (a stray file, a link to a file, or an entry gone since the folder was listed: no event), or { why } for an
// event floorboss can't open: a link to a folder that is gone, or that can't be followed. That one holds sends, as a
// ledger that can't be read does: what went there can't be told.
function entryKind(p) {
  let l;
  try {
    l = lstatSync(p);
  } catch (e) {
    return e?.code === 'ENOENT' ? null : { why: `it can't be looked at (${String(e?.code || 'unreadable').slice(0, 40)})` };
  }
  if (l.isDirectory()) return 'event';
  if (!l.isSymbolicLink()) return null;
  try {
    return statSync(p).isDirectory() ? 'event' : null;
  } catch (e) {
    return { why: e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? 'it is a link to a folder that is gone' : `it is a link floorboss can't follow (${String(e?.code || 'unreadable').slice(0, 40)})` };
  }
}
// The sends of an event whose folder can't be opened: nothing known, and why.
const closedFolder = (why) => ({ zone: null, mock: false, unreadable: why, folder: true, released: new Map(), known: new Set(), addrById: new Map(), damaged: [], text: '', sent: null });
// Every event folder in the home with what it sent (one look at each folder's files): addressBusyToday reads it, and a
// caller checking many messages at once (a send list, the guard's listed sends) passes one in so the folders are looked
// at once for all of them. Inside the guard's lock it is always read again.
export function homeSends(root = join(home(), 'events')) {
  let slugs = [];
  try {
    slugs = readdirSync(root);
  } catch {}
  const events = [];
  for (const slug of slugs) {
    const kind = entryKind(join(root, slug));
    if (kind === 'event') events.push({ slug, dir: join(root, slug), sends: eventSends(join(root, slug)) });
    else if (kind) events.push({ slug, dir: join(root, slug), sends: closedFolder(kind.why) });
  }
  return { root: resolve(root), events };
}
// Every address a person has at an event, with the one a message goes to: the address as written (and a profile link's
// bare form), and their email, other emails, profile link, approved addresses and a new address after a bounce as that
// event's ledger has them, less any that is no one's alone there (one another person's line there has too), with an
// inbox address kept only with their name (readEventSends). ev: that event's sends (eventSends), or null when they
// can't be read.
const keysFor = (address, id, ev) => [...new Set([...addressKeys(address), ...(id != null && ev && !ev.unreadable ? ev.addrById.get(String(id)) || [] : [])])];
export const personAddressKeys = (evDir, id, address) => keysFor(address, id, entryKind(evDir) === 'event' ? eventSends(evDir) : null);

// Another message to this address today at any event in this home (another person at this event too), or null: one
// recorded as sent, or one the guard let through. "Today" is today's date in either event's own zone: a send at another
// event counts when it falls on today's date where this event is, or where that event is (either day containing a
// release ends within a day of it, so a message the guard let through holds nobody for more than a day). A send
// recorded by date alone counts on that date in its event's zone, and at the time its line was written when that was
// the same day (a hand record written late that day can hold a little longer: its time is all floorboss knows). A send
// at another event counts when the two events share an address for the person: a send recorded there, one the guard
// let through there and a stopped guard's marker there each count under the address it went to and every address that
// event has for the person alone (their email, other emails, profile link, each approved address, a new address after
// a bounce), and this message is checked under the address it goes to and every address this event has for its
// person (id) alone. An address two people's lines at one event have never makes two messages one person's: it counts
// only where a message goes to it. An address on the inbox list (info@, hello@, sales@) makes two messages one
// person's only when both events give that person the same name; otherwise it too counts only where a message goes to
// it. A person each event knows only by addresses the other doesn't have is not recognised. An event whose zone can't
// be read counts what it
// let through in the last 24 hours, and a send recorded there today. An event whose folder can't be opened, or whose
// ledger can't be read, or can't be read whole, holds every send (fail closed): floorboss can't tell what went there;
// so does a damaged line there that names one of the addresses. id: this message's person at this event
// (sentOrGoingToday covers them).
// { slug } of the event that holds it, with unreadable (and folder, for a folder that can't be opened) or damaged set
// when that's why. sends: homeSends(), when the caller has one.
const DAY_MS = 864e5;
export function addressBusyToday(evDir, address, nowMs = Date.now(), id = null, sends = null) {
  const es = eventStateAt(evDir, nowMs);
  if (!es.today || !addressKeys(address).length) return null;
  let zone = 'UTC';
  try {
    zone = JSON.parse(readFileSync(join(evDir, 'event.json'), 'utf8')).time_zone;
  } catch {}
  // Only the events in floorboss's home folder are one person's events (an event folder elsewhere has no neighbours).
  const root = resolve(dirname(evDir));
  if (root !== resolve(join(home(), 'events'))) return null;
  const all = sends?.root === root ? sends : homeSends(root);
  const now = new Date(nowMs);
  const mine = resolve(evDir);
  const keys = keysFor(address, id, all.events.find((e) => resolve(e.dir) === mine)?.sends);
  // As a damaged line could name them: a profile link without "u:", an inbox address without the name it is kept with.
  const bare = keys.map((k) => k.replace(/^u:/, '').replace(/^n:[^|]*\|/, ''));
  for (const { slug, dir, sends: ev } of all.events) {
    const own = resolve(dir) === mine;
    if (ev.mock) continue;
    if (ev.unreadable) {
      if (own) continue;
      return { slug, unreadable: ev.unreadable, ...(ev.folder ? { folder: true } : {}) };
    }
    if (!own && ev.damaged.some((t) => bare.some((k) => t.includes(k)))) return { slug, damaged: 'line' };
    const released = keys.flatMap((k) => ev.released.get(k) || []);
    let sent = [];
    if (keys.some((k) => ev.known.has(k))) {
      const marks = sentMarks(ev);
      // (This event's own record that can't be read whole holds everyone there already: contactable says so.)
      if (!marks && !own) return { slug, damaged: 'record' };
      if (!own && ev.foldDamaged?.some((t) => bare.some((k) => t.includes(k)))) return { slug, damaged: 'line' };
      sent = marks ? keys.flatMap((k) => marks.get(k) || []) : [];
    }
    if (!released.length && !sent.length) continue;
    const theirToday = ev.zone ? todayKeyIn(ev.zone, now) : null;
    const onToday = (ms) =>
      Number.isFinite(ms) && (dayAt(zone, ms) === es.today || (ev.zone ? dayAt(ev.zone, ms) === theirToday : nowMs - ms < DAY_MS && ms - nowMs < DAY_MS));
    if (released.some((m) => !(own && m.id === id) && onToday(m.at))) return { slug };
    // A dated send counts on its date in that event's zone; with that zone unreadable, when its line was written today.
    if (sent.some((m) => !(own && m.id === id) && ((m.date && m.date === theirToday) || ((!m.date || !ev.zone || dayAt(ev.zone, m.at) === m.date) && onToday(m.at)))))
      return { slug };
  }
  return null;
}
// An event as a reason names it: by its folder name when that is a name floorboss gives an event (lib/paths.mjs
// SLUG_RE); any other entry in the events folder (a link named by hand, say) is "one of your events", never its name.
const eventNamed = (slug) => (SLUG_RE.test(String(slug)) ? `your event "${slug}"` : 'one of your events');
// What a send held by addressBusyToday is told.
export const busyWhy = (busy, name, to) =>
  busy.folder
    ? `floorboss can't open the folder of ${eventNamed(busy.slug)} (${busy.unreadable}), so it can't tell whether a message went to ${name} (${to}) there today. Messages wait until that folder can be opened again`
    : busy.unreadable
      ? `floorboss can't read the record of ${eventNamed(busy.slug)} (its ledger.jsonl: ${busy.unreadable}), so it can't tell whether a message went to ${name} (${to}) there today. Messages wait until that file can be read again`
      : busy.damaged === 'record'
        ? `a damaged line in the record of ${eventNamed(busy.slug)} (its ledger.jsonl) stops floorboss reading it whole, so it can't tell whether a message went to ${name} (${to}) there today. It waits until that line is fixed`
        : busy.damaged
          ? `a damaged line in the record of ${eventNamed(busy.slug)} names ${to}, so floorboss can't tell whether a message went to ${name} there today. It waits until that line is fixed`
          : `another message to ${name} (${to}) already went or is going today, for ${SLUG_RE.test(String(busy.slug)) ? busy.slug : 'another of your events'}`;

// The guard's marker for a message (released/<id>-<touch>-<clears>) with no release in the ledger since its last clear,
// or null: { at (when it was made), fresh }. A fresh one (under MARKER_LIVE_MS old, by the real clock) may belong to a
// guard still checking that call. An older one is an unclear send: a guard stopped between taking it and writing the
// release (killed, or out of time) may have let that message go, and only the user's words settle it (send-list
// --resend, or send-outcome).
export function markerOnly(evDir, entries, id, touch) {
  const mine = entries.filter((e) => e?.id === id && e.touch === touch && ['send_released', 'release_cleared', 'bounced'].includes(e.type));
  if (mine[mine.length - 1]?.type === 'send_released') return null;
  const resets = mine.filter((e) => e.type !== 'send_released').length;
  try {
    const at = statSync(join(evDir, 'released', `${id}-${touch}-${resets}`)).mtimeMs;
    return { at, fresh: Date.now() - at < MARKER_LIVE_MS };
  } catch {
    return null;
  }
}
// What a step whose marker is fresh is told (a second call for it, a resend or an outcome asked for meanwhile).
export const IN_FLIGHT = "a call to send it started less than a minute ago and may still be going through: look again in a minute";

// A message's saved plan (planned_due, planned_gap, planned_from): from its drafted entry with this hash (the latest
// one when no hash is given), then any replanned entry after it. null: nothing drafted.
export function planFor(entries, id, touch, hash = null) {
  let at = -1,
    plan = null;
  entries.forEach((e, i) => {
    if (e?.type === 'drafted' && e.id === id && (e.touch ?? 1) === touch && (!hash || e.hash === hash)) {
      at = i;
      plan = { planned_due: e.planned_due, planned_gap: e.planned_gap, planned_from: e.planned_from, has_plan: Object.hasOwn(e, 'planned_due') };
    }
  });
  if (!plan) return null;
  entries.forEach((e, i) => {
    if (i > at && e?.type === 'replanned' && e.id === id && (e.touch ?? 1) === touch)
      plan = { planned_due: e.planned_due, planned_gap: e.planned_gap, planned_from: e.planned_from, has_plan: true };
  });
  return plan;
}

export function eventRecord(evDir) {
  const { entries, damaged } = readLedger(join(evDir, 'ledger.jsonl'));
  const st = fold(entries, damaged);
  const contacts = Object.entries(st.people)
    .filter(([, p]) => !p.merged_into)
    .map(([id, p]) => ({ id, name: p.name, email: p.email, company: p.company }));
  return { entries, state: legacyState(st), contacts, damaged, folded: st };
}

// What can read replies, from the saved connections (settings carry config.connectors for the guard).
export function readersOf(settings) {
  const k = settings?.connectors || {};
  // email.history is a one-off search before the event (has anyone written to them?); it can't check this
  // person's replies right before a send, so it doesn't count as a reader.
  // crm: the CRM's activity, which logs the user's emails, so it reads email replies too.
  return {
    email: !!k['email.messages'],
    crm: !!k['crm.activity'],
    tasks: !!k['crm.read_tasks'],
    other: ['crm.read_tasks', 'crm.activity'].some((x) => k[x])
  };
}
