// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// U1. The auto-send approval: after the content approval, the user's second yes, bound to each message's exact text
// and address. readback() is what the user is shown, word for word; approve() writes one autosend_approved line per
// message only when the digest of what was shown still matches a fresh readback and the user typed the sentence.
import { inOneGo, append, contactable, legacyState } from '../ledger.mjs';
import { approvalHash, unreviewed, eventStateAt, followupDueDay } from '../sendcheck.mjs';
import { plannedDays, offWeekend, longDate, modeOn } from '../spacing.mjs';
import { plainAddress } from '../../skills/event-outreach/scripts/mailto.mjs';
import { loadConfig, effectiveSettings } from '../config.mjs';
import { wallParts, addDays } from '../tz.mjs';
import { basename, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeJson } from '../jsonio.mjs';
import { stepHeld } from './plan.mjs';
import { sendsAtApproval, MODE as DRAFTS_MODE } from './drafts.mjs';
import { sha256, ledgerOf, readEvent, eventJson, draftOf, liveApproval, lastApproval, listChangedSince, handSentCommand, autosendDueDay, ROUTINE } from './common.mjs';
import { pickFromSaid, digest12, offeredPicks, PICK_FRESH_MS } from './pick.mjs';

// The final approval's other picks and which pick stands for a step (common.mjs), here too for their callers.
export { DECISION_TYPES, decisionFor, standingPick } from './common.mjs';
import { DECISION_TYPES, decisionFor } from './common.mjs';

// Every email touch of a person's sequence, in order: [touch, fold's touch] for touches 1 and up.
const touchesOf = (p) =>
  Object.entries(p?.touches || {})
    .map(([t, x]) => [Number(t), x])
    .filter(([t]) => t >= 1)
    .sort((a, b) => a[0] - b[0]);

// Why this one message can't be auto-sent as it stands, or null.
function messageWhy(evDir, entries, id, t, x) {
  if (x.dropped) return `message ${t} was dropped`;
  if (x.revising) return `message ${t} was sent back for a rewrite`;
  if (!x.hash) return `message ${t} isn't written yet`;
  if (!x.approved) return `message ${t} isn't approved`;
  if (x.approved.hash !== x.hash) return `message ${t} changed since it was approved`;
  if (x.approved.where) return `message ${t} goes on ${x.approved.where}, not email`;
  const d = draftOf(evDir, x.hash);
  if (!d) return `message ${t} has no saved text`;
  if (d.channel && d.channel !== 'email') return `message ${t} isn't an email (a LinkedIn or event-app step)`;
  const to = x.approved.to;
  if (!plainAddress(to)) return `message ${t} has no plain email address`;
  if (approvalHash(d, to) !== x.hash) return `message ${t}'s text or address changed since it was approved`;
  const r = unreviewed(entries, id, t, x.hash);
  if (r) return `message ${t}: ${r}`;
  // Another way of sending had it already (the guard, an unclear send, an unattended draft): never auto-sent.
  const held = stepHeld(evDir, entries, x, id, t);
  if (held) return `message ${t}: ${held}`;
  return null;
}

// What the user is shown before the second yes.
// Items: every email touch of every person whose whole sequence is approved for its current text, read by the critic
// (or the review skipped, or approved past it by name), to one plain address, and not yet auto-send approved for that
// text. planned_day: touch 1 the first weekday on or after today in the event's zone (not past the event); follow-ups
// from plannedDays counted from that day.
// A name or subject in the readback on one line, as the user reads it: no line breaks or other control characters,
// and no bidi controls (a name with U+202E could show text reversed, or one with a newline a line of its own).
const oneLine = (v) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();

export function readback(evDir, nowMs) {
  const ev = eventJson(evDir);
  const { entries, folded } = readEvent(evDir);
  const es = eventStateAt(evDir, nowMs);
  const items = [];
  const refused = [];
  const lines = [];
  if (!ev || es.state !== 'ok') return { text: '', digest: sha256(''), items, refused: [{ id: null, why: es.why || 'the event file can\'t be read' }] };
  // After 17:00 in the event's zone today's window is gone: the first message is planned for the next weekday.
  let late = false;
  try {
    late = wallParts(new Date(nowMs), ev.time_zone).hh >= 17;
  } catch {
    late = false;
  }
  const first = offWeekend(late ? addDays(es.today, 1) : es.today);
  const people = Object.keys(folded.people).sort();
  for (const id of people) {
    const p = folded.people[id];
    const ts = touchesOf(p).filter(([, x]) => !x.skipped);
    if (!ts.some(([, x]) => x.approved)) continue;
    const held = contactable(folded, id, 'message', es.today);
    if (held) {
      refused.push({ id, why: held });
      continue;
    }
    // A message already went (by auto-send, or another way: then auto-send ended for the rest until a fresh yes): what
    // is left of the sequence after the last one sent may be offered, its days counted from that send.
    const lastSentT = Math.max(0, ...ts.filter(([, x]) => x.sent).map(([t]) => t));
    const rest = ts.filter(([t, x]) => t > lastSentT && !x.sent);
    if (lastSentT && !rest.length) {
      refused.push({ id, why: 'their messages already went: nothing of their sequence is left for auto-send' });
      continue;
    }
    // The whole planned sequence (the event's number of messages that fit before its end, or the person's route as
    // the todo has it: messages = touches written) is written and approved: a first message never goes to the cloud
    // without its follow-ups.
    const settings = effectiveSettings(loadConfig(), ev);
    const count = Math.max(settings.touches, ts.length);
    const planned = [1, ...plannedDays(settings, ev, first, modeOn(ev, first), count).map((x) => x.touch)];
    const missingT = planned.find((t) => t > lastSentT && !p.touches?.[t]?.skipped && !p.touches?.[t]?.approved && !p.touches?.[t]?.dropped);
    if (missingT && !ts.some(([t, x]) => t === missingT && x.dropped)) {
      refused.push({ id, why: `message ${missingT} of their sequence isn't written and approved yet: run flow next (each planned follow-up is drafted, read by the critic and approved before this readback)` });
      continue;
    }
    const bad = rest.map(([t, x]) => messageWhy(evDir, entries, id, t, x)).find(Boolean);
    if (bad) {
      refused.push({ id, why: bad });
      continue;
    }
    const tos = new Set(rest.map(([, x]) => String(x.approved.to)));
    if (tos.size !== 1) {
      refused.push({ id, why: 'its messages are approved to different addresses' });
      continue;
    }
    if (first > ev.end_date) {
      refused.push({ id, why: 'no weekday is left before the event ends' });
      continue;
    }
    // Already approved for these exact texts: nothing new to say yes to, unless a change of the list since that yes
    // holds them (the planner waits for a fresh yes then: it is offered here), or the next message's day and the day
    // after went by unsent (missed: a run that stopped, setup that took days; it was the user's on the outbox since).
    const nextT = rest[0][0];
    const followDay = (t) => (lastSentT ? followupDueDay(evDir, settings, entries, legacyState(folded)[id] || {}, { id, touch: t }, nowMs) : null);
    // Missed: the next message, not recorded sent, whose day went by: its planned day (the latest auto-send yes for it,
    // standing or not) or, after a send, its day by the follow-up rule. With a standing yes, the cloud's window (that
    // day or the day after) went by unsent; with none (the user sent an earlier one by hand, or auto-send was stopped),
    // it was on the outbox with its buttons from that day on. Either way the user may have sent it themselves.
    const missed = (t) => {
      if (t !== nextT || p.touches?.[t]?.sent) return false;
      // The day as the planner works it out (common.mjs autosendDueDay), from the latest yes for it.
      const due = autosendDueDay(lastApproval(entries, id, t)?.a || {}, { first: !lastSentT, ruleDay: lastSentT ? followDay(t)?.day : null });
      if (!due) return false;
      return liveApproval(entries, id, t) ? es.today > addDays(due, 1) : es.today >= due;
    };
    const standing = ([t, x]) => {
      const a = liveApproval(entries, id, t);
      return a?.hash === x.hash && !listChangedSince(entries, a, id) && !missed(t) && typeof a.from === 'string' && a.from.toLowerCase() === String(ev.autosend_own || '').trim().toLowerCase();
    };
    if (rest.every(standing) || rest.every(([t, x]) => decisionFor(entries, id, t, x.hash) && !missed(t))) continue;
    // Days: the first message's from today; after a send, the next one's by the one follow-up rule (never before
    // today), and the rest of them from it.
    let startDay = first;
    if (lastSentT) {
      const f = followDay(nextT);
      if (!f?.day) {
        refused.push({ id, why: f?.why || 'no day is left for their next message before the event ends' });
        continue;
      }
      startDay = f.day > first ? f.day : first;
    }
    const days = { [nextT]: startDay };
    for (const { touch, due } of plannedDays(settings, ev, startDay, modeOn(ev, startDay), rest.length)) {
      const t = rest[touch - 1]?.[0];
      if (t != null) days[t] = due;
    }
    const mine = rest.map(([t, x]) => {
      const d = draftOf(evDir, x.hash);
      return { id, name: p.name || id, touch: t, to: x.approved.to, subject: d.subject || '', body: d.body || '', hash: x.hash, planned_day: days[t] || null, ...(missed(t) ? { missed: true } : {}) };
    });
    if (mine.some((m) => !m.planned_day)) {
      refused.push({ id, why: 'not every follow-up has a day before the event ends' });
      continue;
    }
    // Through Gmail drafts (drafts.mjs): whether the first email goes now (send_now, recorded on its yes), and so
    // whether its follow-ups go in its thread or as emails of their own, with "Re: <its subject>".
    const routine = ev.autosend_mode === ROUTINE;
    const sendNow = (ev.autosend_mode === DRAFTS_MODE || routine) && mine[0].touch === 1 ? sendsAtApproval(ev, mine[0].planned_day, es.today, nowMs) : null;
    // Through a daily Claude routine, a follow-up goes in the thread of message 1, sent from this session at the
    // approval: message 1 must be able to go now (a weekday, 09:00 to 17:00 in the event's zone).
    if (routine && sendNow === false) {
      refused.push({ id, why: "message 1 can only be sent now, from this session, and it is outside sending hours (weekdays, 09:00 to 17:00 in the event's time zone): run the readback again then" });
      continue;
    }
    if (sendNow !== null) mine[0].send_now = sendNow;
    items.push(...mine);
    lines.push(`${oneLine(p.name) || id} (${id}) <${mine[0].to}>`);
    if (!lastSentT && planned.length < settings.touches) {
      lines.push(`  (Only ${planned.length} of the ${settings.touches} requested messages ${planned.length === 1 ? 'fits' : 'fit'} before the event ends.)`);
    }
    if (routine && mine.length)
      lines.push(
        mine[0].touch === 1
          ? `  (If you approve sending automatically: message 1 is sent from this session as soon as you approve, with Claude Code asking you before it goes. ${mine.length > 1 ? 'Its follow-ups wait in Gmail as drafts in its thread, and a daily routine in your Claude account (a scheduled task that runs in the cloud, so your laptop can be off) sends each one on its day, unchanged, unless Gmail shows a reply from them or a bounce. A booking or a stop you record in floorboss takes effect when floorboss has you delete their drafts.' : 'Nothing else is planned for them.'})`
          : '  (If you approve sending automatically: these wait in Gmail as drafts in the thread of the message before, and a daily routine in your Claude account sends each one on its day, unchanged, unless Gmail shows a reply from them or a bounce. A booking or a stop you record in floorboss takes effect when floorboss has you delete their drafts.)'
      );
    else if (sendNow !== null)
      lines.push(
        sendNow
          ? '  (Message 1 is sent as soon as you approve. Its follow-ups wait in Gmail as drafts in its thread, each sent on its day.)'
          : `  (Message 1 waits in Gmail as a draft until its day.${mine.length > 1 ? ` Its follow-ups arrive as separate emails with the subject "Re: ${oneLine(mine[0].subject).replace(/^re:\s*/i, '')}", not in its thread.` : ''})`
      );
    for (const m of mine)
      lines.push(
        `  Message ${m.touch}, planned for ${longDate(m.planned_day)} (${m.planned_day})`,
        ...(m.missed ? ["  (Its day came while it was yours to send on the outbox. If you sent it, say 'sent' instead of approving.)"] : []),
        `  Subject: ${oneLine(m.subject)}`,
        ...String(m.body).split('\n').map((l) => `    ${l}`),
        ''
      );
  }
  const text = lines.join('\n');
  return { text, digest: sha256(text), items, refused };
}

// The final approval, as the user's pick (pick.mjs): refused unless digest is a fresh readback's (nothing changed
// since it was shown) and the pick is the user's own. In Claude Code that is the pick floorboss's guard recorded from
// the AskUserQuestion answer (recorded: { pick, digest12, at, call, label, text }), for this readback, in the last 30
// minutes, and used once. Elsewhere it is the user's reply (said: "1", "option 2", or an option's words).
//   auto    one autosend_approved line per message (the auto-send yes)
//   drafts  one drafts_approved line per message: put in Gmail drafts, nothing sent
//   self    one send_choice line per message: the user sends them from the outbox
// "changes" or words of their own approve nothing. Every line goes in at once, or none.
// A missed step (it was the user's on the outbox since its day went by) may have been sent by hand: an auto-send yes
// for it also needs notSentSaid, the user's word that they didn't send it.
export function approve(evDir, { digest, said = null, recorded = null, notSentSaid = null }, nowMs) {
  const ev = eventJson(evDir) || {};
  // Pick 1 is offered when auto-send is on for the event (the command refuses an event of the other host's first).
  const ready = ev.autosend === true;
  const r = readback(evDir, nowMs);
  if (!r.items.length) throw new Error('Nothing is waiting for the final approval.');
  if (String(digest || '') !== r.digest) throw new Error('Something changed since the readback was shown: show it again, word for word, and ask again. Nothing was approved.');
  let pick = null;
  let words = null;
  let call = null;
  if (recorded) {
    if (recorded.digest12 !== digest12(r.digest)) throw new Error("The pick floorboss recorded is for another readback: show this one and ask again. Nothing was approved.");
    if (!(nowMs - Date.parse(recorded.at) <= PICK_FRESH_MS) || Date.parse(recorded.at) > nowMs + 60000) throw new Error('The pick floorboss recorded is more than 30 minutes old: show the readback again and ask again. Nothing was approved.');
    call = String(recorded.call || '');
    if (!call || readEvent(evDir).entries.some((e) => (e?.type === 'autosend_approved' || DECISION_TYPES.includes(e?.type)) && e.pick_call === call)) throw new Error('That pick was already used: show the readback again and ask again. Nothing was approved.');
    pick = recorded.pick;
    words = recorded.label ? `picked: ${recorded.label}` : String(recorded.text || '');
    if (pick === 'auto' && !ready) pick = null;
  } else if (said != null) {
    pick = pickFromSaid(said, ready);
    words = String(said);
    if (!pick) throw new Error(`Nothing was approved: the user's answer is one of the numbered options (${offeredPicks(ready).map((p) => p.n).join(', ')}), or their own words, which you read back to them first. They said: "${String(said).slice(0, 120)}".`);
  } else throw new Error("Nothing was approved: no pick of the user's is recorded for this readback. Ask them with the choice the readback gave.");
  if (pick === 'other') throw new Error(`Nothing was approved: the user wrote "${String(recorded?.text || '').slice(0, 300)}". Read it back to them in your words and confirm it with them; then do what it asks (for example, take someone off the list) and show the readback again.`);
  if (pick === 'changes') throw new Error('Nothing was approved: the user has changes. Ask what to change, redraft those messages, show them what changed, and ask again.');
  if (!pick) throw new Error('Nothing was approved: sending automatically is not set up for this event here.');
  // The Gmail account the messages go from, recorded on every auto-send line: each run checks the connected account
  // against it before anything else.
  const from = String(ev.autosend_own || '').trim().toLowerCase();
  if (pick === 'auto' && !plainAddress(from)) throw new Error("No sending address is recorded for this event: ask the user which Gmail address it sends from (the account connected), then run on again with --own <that address>. Nothing was approved.");
  const missed = r.items.filter((x) => x.missed);
  if (pick === 'auto' && missed.length && String(notSentSaid || '').trim().length < 2)
    throw new Error(
      `${missed.map((x) => `${x.name}'s message ${x.touch}`).join(', ')} ${missed.length === 1 ? 'was' : 'were'} yours to send on the outbox since ${missed.length === 1 ? 'its' : 'their'} day went by. If you sent it yourself, tell me 'sent' (it is recorded, and its follow-ups are yours); otherwise, approve again with your word that it wasn't sent (--not-sent-said). Nothing was approved. To record a message the user sent themselves (never settle): ${missed.map((x) => handSentCommand(basename(evDir), x.id, x.touch)).join(' ; ')}`
    );
  const at = new Date(nowMs);
  const tag = { pick, ...(call ? { pick_call: call } : {}), digest: r.digest, said: String(words).slice(0, 200) };
  inOneGo(ledgerOf(evDir), () => {
    for (const it of r.items) {
      if (pick === 'auto') append(ledgerOf(evDir), { type: 'autosend_approved', who: 'user', id: it.id, touch: it.touch, hash: it.hash, to: it.to, from, planned_due: it.planned_day, ...(typeof it.send_now === 'boolean' ? { send_now: it.send_now } : {}), ...tag, ...(it.missed ? { not_sent_said: String(notSentSaid).slice(0, 200) } : {}) }, at);
      else append(ledgerOf(evDir), { type: pick === 'drafts' ? 'drafts_approved' : 'send_choice', who: 'user', id: it.id, touch: it.touch, hash: it.hash, to: it.to, planned_due: it.planned_day, ...tag }, at);
    }
  });
  // Pick 2 or 3: a send list written before it lists none of these messages any more (the guard holds them anyway).
  if (pick !== 'auto') dropListed(evDir, new Set(r.items.map((x) => `${x.id}:${x.touch}`)));
  return { approved: r.items.length, people: [...new Set(r.items.map((x) => x.id))], pick };
}
function dropListed(evDir, keys) {
  const f = join(evDir, 'derived', 'send-list.json');
  let v;
  try {
    v = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return;
  }
  if (!Array.isArray(v)) return;
  const kept = v.filter((x) => !(x && typeof x === 'object' && keys.has(`${x.id}:${Number(x.touch ?? 1)}`)));
  if (kept.length !== v.length) writeJson(f, kept);
}

// "stop auto-send": an autosend_revoked line per person. ids: a list, or 'all' (everyone with a live approval).
export function revoke(evDir, { ids, said }, nowMs) {
  if (String(said || '').trim().length < 2) throw new Error("Say the user's words (--said).");
  const { entries, folded } = readEvent(evDir);
  const live = Object.keys(folded.people).filter((id) => Object.keys(folded.people[id].touches || {}).some((t) => liveApproval(entries, id, Number(t))));
  const want = ids === 'all' ? live : (Array.isArray(ids) ? ids : String(ids || '').split(/[\s,]+/)).filter(Boolean);
  const bad = want.filter((id) => !/^c\d+$/.test(id) || !folded.people[id]);
  if (bad.length) throw new Error(`Not on this event's list: ${bad.join(', ')}.`);
  const at = new Date(nowMs);
  inOneGo(ledgerOf(evDir), () => {
    for (const id of want) append(ledgerOf(evDir), { type: 'autosend_revoked', who: 'user', id, said: String(said).slice(0, 200) }, at);
  });
  return { revoked: want };
}
