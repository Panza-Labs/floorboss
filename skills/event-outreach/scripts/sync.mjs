// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// What the mailbox or the CRM shows happened with shortlisted people since floorboss planned them, turned
// into log entries. This catches what the user did outside floorboss: an email rewritten and sent from
// their own mail, a message their CRM logged, a call. When in doubt it errs towards "already contacted":
// one message too few beats writing twice to someone who already heard from you. What it can't read
// (a meeting it can't place, a message with no direction) is asked about, never guessed.

import { todayKeyIn } from '../../../lib/tz.mjs';
import { cancelEntries } from './record.mjs';

// A subject from a mailbox or CRM (anyone can send a calendar invite): one line, no markup, capped, quoted.
const subj = (v) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/[`#<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

// people: [{id, items}] from validateSync. state: the folded log. since: id → ISO (when floorboss planned
// them). source: 'mailbox' | 'crm'. zone: the event's time zone (days are its local days).
// Returns { entries, lines, asks, ignored }.
export function planSync(people, { state, since, source, now, byId, zone = 'UTC' }) {
  const entries = [],
    lines = [],
    asks = [];
  let ignored = 0;
  const nowMs = now.getTime();
  for (const p of people) {
    const st = state[p.id] || { sent: {} };
    const who = byId[p.id] ? `${byId[p.id].name} (${byId[p.id].company})` : p.id;
    const seen = new Set((st.ext || []).map((x) => x.replace(/#t\d+$/, '')));
    const from = Date.parse(since[p.id] || 0);
    const day = (iso) => todayKeyIn(zone, new Date(iso));
    const sentDays = Object.values(st.sent || {}).map((d) => Date.parse(`${d}T12:00:00Z`));
    // Sends the user reported without a source (told Claude, ticked in the outbox): the mailbox may show the
    // same send, possibly days earlier when the report came late. Each can be matched once.
    const reported = Object.entries(st.sent || {})
      .filter(([t]) => !(st.ext || []).some((x) => x.endsWith(`#t${t}`)))
      .map(([t, d]) => ({ t: Number(t), d }))
      .sort((a, b) => a.t - b.t);
    let touch = Object.keys(st.sent || {}).length;
    let replied = !!st.replied;
    // The meeting booked with them, as this read goes (a cancellation frees it).
    let booked = st.booked ? { booked: st.booked, booked_blocks: st.booked_blocks || null, booked_at: st.booked_at || null } : null;
    for (let x of [...p.items].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
      const ext = `${source}:${x.ext}`;
      if (seen.has(ext)) continue;
      seen.add(ext);
      const t = Date.parse(x.at);
      if (t < from) {
        ignored++;
        continue;
      }
      // A bounce: that address doesn't work, so nothing more goes there. An out-of-office: follow-ups wait until
      // they're back, and go on as planned when it gives no date. Neither is them writing back.
      // A bounce is a failure of the address floorboss emails, and stops everything to it. From any address of theirs it
      // isn't one; for someone
      // floorboss has no email for, there's nothing to fail. Either way it's an automatic message, not them writing.
      const theirs = new Set([byId[p.id]?.email, ...(byId[p.id]?.emails_seen || [])].filter(Boolean).map((e) => String(e).trim().toLowerCase()));
      if (x.direction === 'in' && x.intent === 'bounce' && ((x.from && theirs.has(x.from)) || !byId[p.id]?.email)) x = { ...x, intent: null, auto: true };
      if (x.direction === 'in' && x.intent === 'bounce') {
        if (!st.bounced) {
          entries.push({ type: 'bounced', id: p.id, touch: touch || null, old_email: byId[p.id]?.email || null, source, ext });
          lines.push(`${who}: the email bounced on ${day(x.at)}, so nothing more goes to that address`);
        } else entries.push({ type: 'synced', id: p.id, ext, source });
        continue;
      }
      if (x.direction === 'in' && x.intent === 'ooo') {
        if (x.until) {
          entries.push({ type: 'paused', id: p.id, until: x.until, source, ext });
          lines.push(`${who} is away until ${x.until} (an automatic reply): follow-ups wait until then`);
        } else {
          entries.push({ type: 'synced', id: p.id, ext, source });
          lines.push(`${who}: an out-of-office on ${day(x.at)}, no return date read from it, not a reply: follow-ups go on as planned`);
        }
        continue;
      }
      // Other automatic messages aren't them writing back: said, so nothing disappears silently (the user's own
      // out-of-office going out isn't a send either: ignored below). One that carries a
      // no, a stop, a referral or a booking ("I've left: write to Maria") goes on to be read as that.
      if (x.direction === 'in' && x.auto && x.kind === 'message' && (!x.intent || x.intent === 'reply')) {
        entries.push({ type: 'synced', id: p.id, ext, source });
        lines.push(`${who}: an automatic reply on ${day(x.at)}, not a reply: follow-ups go on as planned`);
        continue;
      }
      // Notes and other activity aren't contact.
      if (x.kind === 'note' || (x.auto && (x.kind !== 'message' || x.direction !== 'in')) || x.kind === 'other') {
        ignored++;
        continue;
      }
      if (x.kind === 'message' && x.direction === 'out') {
        // A send floorboss already has: the same day, or a send the user reported on or after this day (a late
        // report dated the day they told Claude). The mailbox's day is the real one, so that touch takes it.
        const sameDay = sentDays.some((d) => Math.abs(d - t) < 36 * 3600000);
        const late = reported.find((r) => Date.parse(`${r.d}T12:00:00Z`) >= t - 36 * 3600000);
        if (sameDay || late) {
          const fix = late && !sameDay && late.d !== day(x.at) ? { touch: late.t, date: day(x.at) } : null;
          if (late) reported.splice(reported.indexOf(late), 1);
          entries.push({ type: 'synced', id: p.id, ext: late ? `${ext}#t${late.t}` : ext, source, ...(fix || {}) });
          if (fix) lines.push(`${who}: message ${fix.touch} went on ${fix.date}, not ${late.d} (your ${source === 'crm' ? 'CRM' : 'mailbox'} shows it)`);
          continue;
        }
        touch += 1;
        entries.push({ type: 'sent', id: p.id, touch, date: day(x.at), source, ext: `${ext}#t${touch}`, ...(x.subject ? { subject: subj(x.subject) } : {}) });
        sentDays.push(t);
        lines.push(`sent to ${who} on ${day(x.at)}, found in your ${source === 'crm' ? 'CRM' : 'mailbox'}${touch > 1 ? ` (counted as message ${touch})` : ''}`);
      } else if (x.kind === 'message' && x.direction === 'in') {
        // Read in the browser (LinkedIn, the app): the words are kept, so the reply can be logged in the CRM.
        if (['linkedin', 'app'].includes(source) && x.text) entries.push({ type: 'reply_received', id: p.id, source, ext, text: x.text, at_msg: x.at });
        // Who answered: them, or someone for them (an assistant, a colleague) in the same thread.
        const forThem = x.from && byId[p.id]?.email && x.from !== String(byId[p.id].email).toLowerCase() ? ` (${x.from}, answering for them)` : '';
        const what = x.intent || 'reply';
        if (what === 'stop') {
          entries.push({ type: 'stop', id: p.id, source, ext });
          lines.push(`${who} asked not to be contacted${forThem}: stopped here and at every later event`);
          replied = true;
          continue;
        }
        if (what === 'decline') {
          entries.push({ type: 'declined', id: p.id, source, ext });
          lines.push(`${who} said no${forThem} on ${day(x.at)}: no more messages for this event`);
          replied = true;
          continue;
        }
        // A cancellation frees the booked time, as one recorded by hand does. One for a meeting floorboss doesn't
        // have booked frees nothing: said, never guessed at.
        // A cancellation sent before the booking floorboss has was recorded: about an earlier meeting (rebooked
        // since), or about this one, booked late. floorboss can't tell which, so the user is asked; nothing is freed.
        const stale = what === 'cancelled' && booked && booked.booked_at && Date.parse(x.at) < Date.parse(booked.booked_at);
        // A cancellation from anyone but the person (or with no sender) frees nothing on its own: anyone can write
        // into a thread or have an email logged on a CRM record.
        const notThem = what === 'cancelled' && booked && !stale && (!x.from || forThem);
        if (stale || notThem) {
          if (!replied) entries.push({ type: 'replied', id: p.id, source, ext });
          replied = true;
          const why = stale
            ? `they wrote on ${day(x.at)} to cancel, before the meeting booked with them now was recorded: is that meeting off (record "cancelled"), or still on (record "booked" at its time again)?`
            : `${x.from ? `${x.from}, not them,` : 'someone (no sender shown)'} wrote on ${day(x.at)} to cancel the meeting with them: is it off (record "cancelled"), or still on?`;
          entries.push({ type: 'outcome_unclear', id: p.id, key: ext, why, source, ext });
          asks.push({ id: p.id, who, why });
          continue;
        }
        if (what === 'cancelled' && booked) {
          entries.push(...cancelEntries({ ...booked, replied }, { id: p.id, source, ext }, { reply: true, anotherTime: x.another_time }));
          booked = null;
          replied = true;
          lines.push(
            `${who} cancelled the meeting${forThem} on ${day(x.at)}: their time is free again${x.another_time ? "; they asked for another time, so you'll be asked to agree a new one with them" : ''}`
          );
          if (x.another_time) asks.push({ id: p.id, who, why: 'they cancelled and asked for another time: agree a new one with them?' });
          continue;
        }
        if (what === 'cancelled')
          lines.push(`${who} wrote${forThem} on ${day(x.at)} to cancel a meeting, but there's no meeting booked with them here: nothing freed`);
        if (!replied) {
          entries.push({ type: 'replied', id: p.id, source, ext });
          replied = true;
          lines.push(
            `${who} wrote to you on ${day(x.at)}${forThem}: no more follow-ups. The answer is yours to write (Claude can help with the wording); record a time once it's agreed`
          );
        } else entries.push({ type: 'synced', id: p.id, ext, source });
        // A time they accepted or proposed, or someone they pointed to: the user decides (one question each).
        if (what === 'booked') {
          entries.push({ type: 'reply_action', id: p.id, action: 'book', time: x.time || null, ext });
          asks.push({ id: p.id, who, why: `they wrote back about a time${x.time ? ` (${x.time})` : ''}: book it?` });
        }
        if (what === 'referral' && x.referral) {
          entries.push({ type: 'reply_action', id: p.id, action: 'add_referral', referral: x.referral, ext });
          asks.push({
            id: p.id,
            who,
            why: `they pointed you to ${x.referral.name || x.referral.email}${x.referral.title ? `, ${x.referral.title}` : ''}: add them?`
          });
        }
      } else if ((x.kind === 'call' || x.kind === 'meeting') && t <= nowMs) {
        if (!replied) {
          entries.push({ type: 'replied', id: p.id, source, ext, outcome: `${x.kind} logged` });
          replied = true;
          lines.push(`your ${source === 'crm' ? 'CRM' : 'mailbox'} shows a ${x.kind} with ${who} on ${day(x.at)}: you're in touch, no more follow-ups`);
        } else entries.push({ type: 'synced', id: p.id, ext, source });
      } else {
        // A meeting still to come, or a message whose direction the CRM doesn't give: hold them and ask.
        const why =
          x.kind === 'meeting'
            ? `the CRM shows a meeting with them at ${x.at}${x.subject ? ` (subject "${subj(x.subject)}")` : ''}: is it booked? Record it with "booked" (and its time) or say it isn't`
            : `the CRM logged a ${x.kind} with them on ${day(x.at)} but not who sent it: did you write to them, or they to you?`;
        entries.push({ type: 'outcome_unclear', id: p.id, key: ext, why, source, ext });
        asks.push({ id: p.id, who, why });
      }
    }
  }
  return { entries, lines, asks, ignored };
}
