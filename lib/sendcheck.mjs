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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLedger, fold, legacyState, contactable } from './ledger.mjs';
import { todayKeyIn } from './tz.mjs';

// Who a message goes to on its channel: the email address, the chat number, or (event app, LinkedIn) the
// profile link or name and company.
export function recipientOf(ct, channel, settings) {
  if (!ct) return null;
  if (channel === 'email')
    return (
      String(ct.email || '')
        .trim()
        .toLowerCase() || null
    );
  const chat = (settings?.sending?.channels || []).includes('chat') && ct.phone;
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

// The latest reply check for this person that could see this channel. Email: their mailbox search or thread
// check, a CRM read that showed the CRM has seen their email since your last message (sees_email: a CRM with
// no record of them, or one that logs only outgoing mail, can't vouch that nobody replied), or the user's own
// word where that counts (userWordCounts); the app and chat: CRM tasks, a CRM sync, or the user's own word.
// readers: which kinds of reply floorboss can read itself ({ email, crm, other }); where it can, only a real
// check of this person counts. sentAtMs: when the message before the follow-up went.
// A browser send (LinkedIn, the app) counts a read of that inbox in the browser (inbox_read) as a check too.
export function lastReplyCheck(entries, id, via, readers = {}, sentAtMs = 0) {
  const email = via === 'email.send';
  const real = (e) =>
    (e.type === 'reply_checked' || e.type === 'checked') &&
    e.id === id &&
    (email
      ? ['mailbox', 'thread'].includes(e.source) || (readers.crm && e.source === 'crm' && e.sees_email === true)
      : ['crm', 'tasks', 'linkedin', 'app'].includes(e.source));
  const wordOk = userWordCounts(entries, id, via, readers, sentAtMs);
  const word = (e) => wordOk && ['no_reply_said', 'user_says_no_reply', 'status_pasted'].includes(e.type) && (!e.ids || e.ids.includes(id));
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

export function verifySend(item, { evDir, settings, state, entries, folded = null, nowMs = Date.now(), readers = readersOf(settings) }) {
  if (!item || typeof item !== 'object' || !/^c\d+$/.test(String(item.id)) || !Number.isInteger(item.touch))
    return { ok: false, why: 'not a floorboss message' };
  if (!channelOn(settings, item.via)) return { ok: false, why: `sending on ${item.via} isn't turned on for this event` };
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
  // Let through once already, unless the user since said to send it again (resend, with their words).
  const rel = entries.filter((e) => e.id === item.id && e.touch === item.touch && ['send_released', 'release_cleared', 'bounced'].includes(e.type)).pop();
  if (rel?.type === 'send_released')
    return { ok: false, why: "already let through once (it may have gone): check, then record it, or resend with the user's words" };
  if (item.touch > 1 && !st.sent?.[item.touch - 1]) return { ok: false, why: "the message before it hasn't gone" };
  if (item.touch > 1) {
    const sentAt = Date.parse(st.sent_at?.[item.touch - 1] || `${st.sent[item.touch - 1]}T00:00:00Z`);
    // A reply reader that failed (and hasn't worked since) can't see replies: the user's word counts again.
    const rd = withFallbacks(readers, fd);
    const at = lastReplyCheck(entries, item.id, item.via, rd, sentAt);
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
  // What the CLI checks when it lists a message, checked again at the send: a confirmation is for the booking that
  // stands now (one moved since says the old time), and offered times are still free and still ahead.
  const dr = entries.filter((e) => e.type === 'drafted' && e.id === item.id && (e.touch ?? 1) === item.touch && e.hash === appr.hash).pop();
  if (kind === 'confirmation' && dr?.booked_slot && dr.booked_slot !== person.booked)
    return { ok: false, why: 'the booking this confirms changed since it was drafted: redraft it' };
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
    const zone = JSON.parse(readFileSync(join(evDir, 'event.json'), 'utf8')).time_zone;
    return zone ? todayKeyIn(zone, new Date(nowMs)) : null;
  } catch {
    return null;
  }
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
    email: ['email.messages', 'email.thread_has_reply'].some((x) => k[x]),
    crm: !!k['crm.activity'],
    tasks: !!k['crm.read_tasks'],
    other: ['crm.read_tasks', 'crm.activity'].some((x) => k[x])
  };
}
