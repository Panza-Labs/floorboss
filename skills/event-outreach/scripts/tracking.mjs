// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Tracking across channels. Email is read from the mailbox; meetings from the calendar; everything that has
// no connector (event-app messages, LinkedIn, colleague notes, decisions for the user) becomes a CRM task,
// and the task's completion and outcome come back into the contact log. One log, every channel.
import { timeMentioned } from './checks.mjs';
import { dayWords } from '../../../lib/tz.mjs';
import { isLinkedInUrl } from '../../../lib/route.mjs';
// A name in a task title: one line, no longer than a name.
const short = (x) =>
  String(x ?? '')
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
    .trim()
    .slice(0, 60);

// Where a paste message goes: LinkedIn when the contact's link is a LinkedIn profile, else the event's app.
// pick: the user's routing for this person (triage channel). "app" means the event's app, whatever links
// they have.
export function whereTo(contact, event, pick = contact?.routed) {
  if (pick === 'app') return event.app_name || 'the event app';
  return isLinkedInUrl(contact?.profile_url) ? 'LinkedIn' : event.app_name || 'the event app';
}

const OUTCOME_HELP =
  'When it\'s sent, mark this task done. If they answer, write it in the task (outcome or note): "replied", "booked <day> <time>", or "stop".';

// The tasks floorboss wants in the CRM now. created: Set of keys already created (from the log).
// cards: outbox cards. review: [{id, reason}] decisions for the user. stops: contacts who said stop.
// selfSends(card): floorboss sends this message itself (sending on for its channel): no "send it" task, or it
// could go twice.
export function taskItems({ cards, review = [], stops = [], created, event, byId, crmOf, today, now = new Date().toISOString(), selfSends = () => false, dayState = null, taskOf = () => null }) {
  const items = [];
  // The CRM's own record id, or nothing: an email isn't a record id, and a task on no record still shows.
  const ref = (id) => crmOf(id)?.crm_id || null;
  for (const card of cards) {
    // The event is over (today in its time is past its last day), or its dates can't be read (dayState: the one answer,
    // lib/spacing.mjs eventDayState, that the guard uses too): no task to send anything for it. Reviews and opt-outs
    // below still come.
    if (dayState ? dayState.state !== 'ok' : event?.end_date && today > event.end_date) break;
    // A follow-up gets its task on its day, not before: due_on is the day send-list and the guard work out (the one
    // rule, lib/spacing.mjs followupDay). None while that day can't be known yet (due_waits), and none at all when
    // it has no room left before the event ends (due_on null): a dropped step is never a task for today.
    const day = card.due_on === undefined ? card.planned_due : card.due_on;
    // A LinkedIn message (always sent by hand) gets its task as soon as its day is known, due that day, so the user has
    // it in the CRM on the day itself, whether or not floorboss runs then.
    const linkedin = card.channel === 'paste' && (card.where || whereTo(card, event)) === 'LinkedIn';
    if (card.due_waits || card.due_on === null || (day && day > today && !linkedin)) continue;
    if ((card.kind === 'message' || card.kind === 'confirmation') && card.channel === 'paste' && !selfSends(card)) {
      // A task already made for this message: none again, unless its text or its day changed since (it was edited and
      // approved again, or its day moved). Then the user is asked to close the old task, and a new one follows.
      // (A task the user closed as not needed counts as none: the message gets a new one.)
      const p0 = taskOf(card.id, card.touch);
      // Asked whether it was sent: no new task until the user answers.
      if (p0?.ask_sent) continue;
      const prior = p0?.unneeded ? null : p0;
      const knownDay = day || null;
      const changed = prior && !prior.done && ((prior.hash && card.approved_hash && prior.hash !== card.approved_hash) || (prior.hash && (prior.day || null) !== knownDay));
      const key = changed || p0?.unneeded ? `${card.id}:${card.touch}:${String(card.approved_hash || '').slice(0, 8)}-${knownDay || 'now'}` : `${card.id}:${card.touch}`;
      if (prior && !changed) continue;
      if (created.has(key)) continue;
      if (changed) {
        const rkey = `${card.id}:review:changed-${prior.key}`;
        if (!created.has(rkey) && !items.some((x) => x.key === rkey))
          items.push({
            key: rkey,
            id: card.id,
            touch: card.touch,
            kind: 'review',
            contact_ref: ref(card.id),
            listed_at: now,
            title: `floorboss needs you: ${short(card.name)} (${short(card.company)})`,
            body: `The message in the open task for ${card.name} changed: close that task; a new one follows.`,
            due: today
          });
      }
      // Not today: another event wrote to that address today (the card says why). Its task comes on another day.
      if (card.not_today) continue;
      // One message a day to one person: one send task for them in a list, the earliest step first.
      if (items.some((x) => x.kind === 'send' && x.id === card.id)) continue;
      const where = card.where || whereTo(card, event);
      items.push({
        key,
        id: card.id,
        touch: card.touch,
        kind: 'send',
        contact_ref: ref(card.id),
        listed_at: now,
        title: `${card.kind === 'confirmation' ? 'Confirm the meeting with' : card.touch > 1 ? 'Follow up' : 'Message'} ${short(card.name)} (${short(card.company)}) in ${where}`,
        // A LinkedIn follow-up: floorboss can't read LinkedIn, so the task itself says to look for a reply first.
        body: `${where === 'LinkedIn' && card.touch > 1 && /^\d{4}-\d{2}-\d{2}$/.test(card.prev_sent_on || '') ? `Before you send: look in LinkedIn for a reply from ${card.name} since ${dayWords(card.prev_sent_on)}. If they replied, don't send this; close the task and tell floorboss.\n\n` : ''}${card.body}\n\n---\n${where === 'LinkedIn' && card.profile_url ? `Profile: ${card.profile_url}\n` : ''}${OUTCOME_HELP}`,
        // Due the day it should go out: a LinkedIn message's own day (listed ahead of it), else today, when it's listed.
        due: linkedin && day && day > today ? day : today,
        // What the task was made from: the approved text and its day, so a change to either is seen.
        hash: card.approved_hash || null,
        day: knownDay
      });
    }
    if (card.kind === 'coordinate') {
      const key = `${card.id}:coord`;
      if (created.has(key)) continue;
      items.push({
        key,
        id: card.id,
        touch: card.touch,
        kind: 'coordinate',
        contact_ref: ref(card.id),
        listed_at: now,
        title: `For ${short(card.holder) || 'the account owner'}: ${short(card.name)} (${short(card.company)}) is at ${event.name}`,
        body: card.body,
        due: today
      });
    }
  }
  for (const r of review) {
    const key = `${r.id}:review:${r.tag}`;
    if (created.has(key)) continue;
    const ct = byId[r.id] || {};
    items.push({
      key,
      id: r.id,
      touch: r.touch ?? null,
      kind: 'review',
      contact_ref: ref(r.id),
      listed_at: now,
      title: `floorboss needs you: ${short(ct.name)} (${short(ct.company)})`,
      // A task that only asks to close another (plain): nothing to answer in floorboss.
      body: r.plain ? `${r.reason}\n\nMark this task done once you have closed it.` : `${r.reason}\n\nAnswer it in floorboss (the next /floorboss:start run asks), then mark this task done.`,
      due: today
    });
  }
  for (const id of stops) {
    const key = `${id}:optout`;
    if (created.has(key)) continue;
    const ct = byId[id] || {};
    // Not in the CRM: still a task, so whoever adds them later knows not to contact them.
    items.push({
      key,
      id,
      touch: null,
      kind: 'opt_out',
      contact_ref: ref(id),
      listed_at: now,
      title: `Mark ${short(ct.name)} (${short(ct.company)}) as do-not-contact`,
      body: crmOf(id)
        ? `${ct.name} asked not to be contacted again (${event.name}). floorboss has stopped; please set the opt-out on their record so nobody else contacts them.`
        : `${ct.name} (${ct.company}${ct.email ? `, ${ct.email}` : ''}) asked not to be contacted again (${event.name}). They aren't in the CRM; if anyone adds them, mark them do-not-contact. floorboss has stopped and won't contact them at any event.`,
      due: today
    });
  }
  return items;
}

// What a user's outcome note means. labels: the contact's offered slots as [{id, label}].
// A stop is looked for first, in many phrasings, because missing one contacts someone who said no. Any
// negation ("no reply yet", "not booked") makes the rest unclear: floorboss asks rather than guesses.
const STOP =
  /\b(stop|unsubscrib\w*|opt(ed)?[ -]?out|remove (me|them|him|her)|removed from|take (me|them|him|her) off|do not (contact|message|email|write)|don'?t (contact|message|email|write)|never (contact|message|email|write)|leave (me|them|him|her) alone|not interested|no thanks|no thank you|go away|spam|harass\w*|block(ed)? (me|us))\b/i;
const NEGATED = /\b(no|not|never|nobody|nothing|yet|maybe|might|pending|waiting|unsure|unclear)\b|n['’]t\b|\?/i;
export function readOutcome(text, labels = []) {
  const t = String(text || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, '')
    .trim();
  if (!t) return { kind: 'none' };
  if (STOP.test(t)) return { kind: 'stop' };
  if (NEGATED.test(t)) return { kind: 'unclear', why: `floorboss can't tell what this outcome means: "${t.slice(0, 80)}"` };
  if (/\bbook(ed)?\b|\bmeeting (set|confirmed)\b|\bconfirmed\b/i.test(t)) {
    const hits = labels.filter((l) => timeMentioned(t, l.label));
    return hits.length === 1
      ? { kind: 'booked', slot: hits[0].id }
      : { kind: 'unclear', why: `the outcome says booked but ${hits.length ? 'more than one' : 'no'} offered time matches: "${t.slice(0, 80)}"` };
  }
  if (/\b(replied|answered|responded|got back|wrote back|is interested|interested)\b/i.test(t)) return { kind: 'replied' };
  return { kind: 'unclear', why: `floorboss can't tell what this outcome means: "${t.slice(0, 80)}"` };
}

// Calendar events → bookings. contacts: [{id, emails:[…]}]. slots: every floorboss slot [{id,start}].
// window: [fromIso, toIso] (the event's days). Only confirmed meetings inside the event count; a meeting at
// one of floorboss's times takes that time, offered to them or not. Returns [{id, slot, start}].
// mine(email): whether an address is the user's own. A meeting counts only when both sides accepted it (or one of
// them organised it and the other accepted): an invite anyone sends, listing a contact, books nothing. Those are
// returned in unclear instead.
export function bookingsFrom(events, contacts, { slots = [], window = null, mine = () => false, unclear = null } = {}) {
  const out = [];
  const seen = new Set();
  for (const ev of events) {
    if (ev.status !== 'confirmed') continue;
    const s = Date.parse(ev.start);
    if (window && (s < Date.parse(window[0]) || s >= Date.parse(window[1]))) continue;
    // The user's own answer decides when the calendar gives one: a colleague (an own_domains address) accepting an
    // invite the user declined books nothing. Without one, an own address that organised or accepted it counts.
    const userIn =
      ev.organizer_is_you === true ||
      (typeof ev.self_response === 'string' && ev.self_response
        ? ev.self_response === 'accepted'
        : (ev.organizer && mine(ev.organizer)) || Object.entries(ev.responses || {}).some(([e, r]) => mine(e) && r === 'accepted'));
    for (const who of contacts.filter((c) => c.emails.some((e) => ev.attendees.includes(e)))) {
      const theyIn = who.emails.some((e) => ev.organizer === e || ev.responses?.[e] === 'accepted');
      if (!userIn || !theyIn) {
        if (unclear) unclear.push({ id: who.id, start: ev.start, summary: ev.summary, why: !userIn ? "you haven't accepted it" : "they haven't accepted it" });
        continue;
      }
      const slot = slots.find((x) => Math.abs(Date.parse(x.start) - s) <= 5 * 60000);
      const id = slot ? slot.id : `x${ev.start.replace(/[-:]/g, '').slice(0, 13)}`;
      if (seen.has(`${who.id}:${id}`)) continue;
      seen.add(`${who.id}:${id}`);
      out.push({ id: who.id, slot: id, start: ev.start, summary: ev.summary });
    }
  }
  return out;
}
