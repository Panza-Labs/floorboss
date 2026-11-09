// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Recording what happened, from the user's own words: "I sent Ana and Tomas", "Tomas moved it to Monday
// 3:40pm", "cut the agencies", "add the Northwind CEO". Claude writes the user's report as items
// in a file; this checks every name against the event's list and works out the log entries. All or nothing:
// one name that doesn't resolve, or matches two people, and nothing is recorded.
import { sameName, companyRelated, noteText } from '../../../lib/normalize.mjs';
import { zonedToUtc, todayKeyIn, labelInZone, weekdayOf } from '../../../lib/tz.mjs';

export const WHATS = [
  'sent',
  'booked',
  'moved',
  'cancelled',
  'replied',
  'met',
  'declined',
  'stop',
  'cut',
  'added',
  'bounced',
  'away',
  'note_passed',
  'skipped',
  'unsent',
  'undo'
];

// "c7150", or a name (with the company when the name is common). Returns { id } or { error }.
export function resolveWho(item, { byId, approved, state = {} }) {
  const who = String(item?.who || '').trim();
  if (!who) return { error: 'an item has no "who"' };
  if (/^c\d+$/.test(who)) return byId[who] ? { id: who } : { error: `${who} isn't on this event's list` };
  let hits = Object.values(byId).filter((c) => sameName(c.name, who));
  if (item.company) hits = hits.filter((c) => companyRelated(c.company, item.company));
  if (hits.length > 1) {
    // Several people share the name: one of them on the shortlist is the one the user means.
    const onList = hits.filter((c) => approved.has(c.id));
    if (onList.length === 1)
      return { id: onList[0].id, note: `"${who}" matched ${hits.length} people; used ${onList[0].name} (${onList[0].company}), who is on the shortlist` };
  }
  if (hits.length === 1) return { id: hits[0].id };
  // A first name alone ("ana"): the one person by that name floorboss is actually reaching (on the
  // shortlist, written to or booked), if there's exactly one.
  if (!hits.length && !/\s/.test(who)) {
    const first = (n) => String(n).trim().split(/\s+/)[0].toLowerCase();
    const active = Object.values(byId).filter(
      (c) =>
        first(c.name) === who.toLowerCase() &&
        (!item.company || companyRelated(c.company, item.company)) &&
        (approved.has(c.id) || (state?.[c.id]?.sent && Object.keys(state[c.id].sent).length) || state?.[c.id]?.booked)
    );
    if (active.length === 1) return { id: active[0].id, note: `"${who}" taken as ${active[0].name} (${active[0].company}), the only ${who} you're reaching` };
    if (active.length > 1)
      return {
        error: `"${who}" could be ${active
          .slice(0, 6)
          .map((c) => `${c.id} ${c.name} (${c.company})`)
          .join('; ')}. Say which.`
      };
  }
  if (!hits.length) return { error: `nobody called "${who}"${item.company ? ` at ${item.company}` : ''} is on this event's list` };
  return {
    error: `"${who}" matches ${hits.length} people: ${hits
      .slice(0, 6)
      .map((c) => `${c.id} ${c.name} (${c.company})`)
      .join('; ')}. Say which (by company or id).`
  };
}

// "2027-03-08 15:40" or "2027-03-08T15:40", in the event's time zone → ISO UTC. Impossible dates and times
// (30 Feb, 24:00) are refused, not rolled over.
export function parseLocal(s, zone) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d{1,2}):(\d\d)$/.exec(String(s || '').trim());
  if (!m) return null;
  const [y, mo, d, hh, mm] = m.slice(1).map(Number);
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || hh > 23 || mm > 59) return null;
  return zonedToUtc({ y, m: mo, d, hh, mm }, zone).toISOString();
}

const DAY = /^\d{4}-\d\d-\d\d$/;
const validDay = (x) => DAY.test(x) && !Number.isNaN(Date.parse(`${x}T00:00:00Z`)) && new Date(`${x}T00:00:00Z`).toISOString().slice(0, 10) === x;
const daysApart = (a, b) => Math.abs(Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 864e5;
// Free text from the user's report: one line, capped.
const text = (v, max) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, max);
// Which message a touch is, in the user's words.
const whichMessage = (t) => (t === 0 ? 'the meeting confirmation' : t === 1 ? 'the first message' : `follow-up ${t - 1}`);

// A reply that names a time or a day ("Wednesday works, can we do 10:30?"): it may be a meeting to book. The
// time as YYYY-MM-DD HH:MM when the day is one event day and the time is clear; else just that it reads so.
const DAYS = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
export function timeInReply(said, eventDays = []) {
  const t = String(said || '');
  const day = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i.exec(t);
  const hm = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(am|pm)?\b/i.exec(t) || /\b(1[0-2]|0?[1-9])()\s*(am|pm)\b/i.exec(t);
  if (!day && !hm) return null;
  let at = null;
  if (day && hm) {
    const on = eventDays.filter((d) => weekdayOf(d) === DAYS[day[1].toLowerCase().slice(0, 3)]);
    let hh = Number(hm[1]);
    const mm = hm[2] || '00';
    const ap = (hm[3] || '').toLowerCase();
    if (ap === 'pm' && hh < 12) hh += 12;
    if (ap === 'am' && hh === 12) hh = 0;
    if (on.length === 1) at = `${on[0]} ${String(hh).padStart(2, '0')}:${mm}`;
  }
  return { at, words: [day?.[0], hm?.[0]].filter(Boolean).join(' ') };
}

// A booked meeting called off: its time is free again (unbooked). One they wrote to call off is a reply (no
// follow-ups chase it); asking for another time also puts it to the user to agree a new one (nothing new goes to
// someone who replied). Shared by a cancellation recorded by hand and one read from the mailbox or CRM.
// st: { booked, booked_blocks, replied } before it. base: the fields every entry carries (id, who it came from).
export function cancelEntries(st, base, { reply = false, anotherTime = false } = {}) {
  const out = [{ type: 'unbooked', ...base, slot: st.booked, blocks: st.booked_blocks || [st.booked] }];
  if ((reply || anotherTime) && !st.replied) out.push({ type: 'replied', ...base });
  if (anotherTime) out.push({ type: 'reply_action', ...base, action: 'book', why: 'cancelled' });
  return out;
}

// items → { entries, bookSlots, unbookSlots, add, errors, lines, notes }.
// ctx: { byId, approved:Set, state (folded log), slots:[{id,start,end}], zone, now, minutes, coordinate:Map id→holder }.
// Each item sees what the items before it did (two sends, a move then another move), as the log will.
export function planRecord(items, ctx) {
  const errors = [],
    entries = [],
    lines = [],
    notes = [];
  const bookSlots = new Set(),
    unbookSlots = new Set(),
    add = new Set();
  const today = todayKeyIn(ctx.zone, ctx.now);
  const list = Array.isArray(items) ? items : [];
  if (!list.length) errors.push('nothing to record: expected {"items":[…]}');
  if (list.length > 200) errors.push('more than 200 items in one report: split it');
  const live = {}; // id → running copy of the person's state
  const undone = new Set(); // people with an "unsent" in this report
  const stateOf = (id) =>
    (live[id] ||= (() => {
      const s = ctx.state[id] || {};
      return {
        sent: { ...(s.sent || {}) },
        sent_at: { ...(s.sent_at || {}) },
        sent_via: { ...(s.sent_via || {}) },
        booked: s.booked || null,
        booked_start: s.booked_start || null,
        booked_blocks: s.booked_blocks || null,
        removed: !!s.removed
      };
    })());
  // Meetings already booked, by slot and by time, across the log and this report.
  const bookedAt = new Map();
  const meetings = []; // {id, s0, s1}
  const mins = Number(ctx.minutes) || 30;
  for (const [id, s] of Object.entries(ctx.state)) {
    if (!s.booked) continue;
    for (const b of s.booked_blocks || [s.booked]) bookedAt.set(b, id);
    if (s.booked_start) meetings.push({ id, s0: Date.parse(s.booked_start), s1: Date.parse(s.booked_start) + mins * 60000 });
  }
  // freed: the unbooked entry (cancelEntries' first); the rest of its entries are the caller's.
  const unbook = (id, st, freed) => {
    entries.push(freed);
    for (const b of freed.blocks) {
      unbookSlots.add(b);
      bookSlots.delete(b);
      if (bookedAt.get(b) === id) bookedAt.delete(b);
    }
    for (let k = meetings.length - 1; k >= 0; k--) if (meetings[k].id === id) meetings.splice(k, 1);
    st.booked = null;
    st.booked_start = null;
    st.booked_blocks = null;
  };
  list.forEach((given, i) => {
    let item = given;
    const where = `item ${i + 1}`;
    if (!WHATS.includes(item?.what)) {
      errors.push(`${where}: "what" must be one of ${WHATS.join(', ')}`);
      return;
    }
    const r = resolveWho(item, ctx);
    if (r.error) {
      errors.push(`${where}: ${r.error}`);
      return;
    }
    if (r.note) notes.push(r.note);
    const { id } = r;
    const ct = ctx.byId[id];
    const st = stateOf(id);
    const who = `${ct.name} (${ct.company})`;
    const base = { id, via: 'user', ...(item.said ? { said: text(item.said, 300) } : {}) };
    const onList = (ctx.approved.has(id) && !st.removed) || add.has(id);
    // A coordinate note goes to the colleague who holds them: "sent" with "to": "colleague" is that note passed
    // on, never a message to the person. A plain "sent" for someone a colleague holds is asked about.
    const holder = ctx.coordinate?.get(id);
    if (item.what === 'sent' && /^(colleague|coworker|holder)$/i.test(String(item.to || ''))) item = { ...item, what: 'note_passed' };
    if (item.what === 'undo') item = { ...item, what: 'unsent' };
    if (item.what === 'sent' && holder !== undefined && !/^(them|contact|person)$/i.test(String(item.to || ''))) {
      errors.push(
        `${where}: ${who} is held by ${holder || 'a colleague'}. If you passed the note on to ${holder || 'them'}, record {"who":"${id}","what":"note_passed"}; if you wrote to ${ct.name} yourself, add "to":"them"`
      );
      return;
    }
    switch (item.what) {
      case 'skipped': {
        let t = item.touch != null ? Number(item.touch) : Math.max(0, ...Object.keys(st.sent).map(Number)) + 1;
        if (item.touch == null) while (ctx.state[id]?.touches?.[t]?.skipped) t++;
        if (!Number.isInteger(t) || t < 2 || t > 10) {
          errors.push(`${where}: only a follow-up can be skipped (message 2 or later); to leave someone out, record "cut"`);
          return;
        }
        if (st.sent[t]) {
          errors.push(`${where}: message ${t} to ${who} already went`);
          return;
        }
        entries.push({ type: 'step_skipped', ...base, touch: t });
        lines.push(`message ${t} to ${who} skipped; the next step goes on its day`);
        break;
      }
      case 'note_passed': {
        if (holder === undefined) {
          errors.push(`${where}: ${who} has no note to a colleague: nobody holds them for you`);
          return;
        }
        if (ctx.state[id]?.note_passed) {
          notes.push(`${who}: the note to ${holder || 'the colleague'} is already recorded as passed on`);
          return;
        }
        entries.push({ type: 'note_passed', ...base, ...(item.channel ? { channel: text(item.channel, 40) } : {}) });
        lines.push(
          `note to ${holder || 'the colleague'} about ${who} passed on${item.channel ? ` via ${text(item.channel, 40)}` : ''}; nothing went to ${ct.name}`
        );
        break;
      }
      case 'sent': {
        const date = item.date || today;
        if (!validDay(date)) {
          errors.push(`${where}: date must be a real day, YYYY-MM-DD`);
          return;
        }
        if (date > today) {
          errors.push(`${where}: ${date} hasn't happened yet (today is ${today}): a send is recorded on or after its day`);
          return;
        }
        if (item.touch != null && !(Number.isInteger(Number(item.touch)) && Number(item.touch) >= 0 && Number(item.touch) <= 10)) {
          errors.push(`${where}: touch is a whole number from 0 (the meeting confirmation) to 10`);
          return;
        }
        // Touch 0 is the meeting confirmation. Someone booked whose confirmation is waiting to go: a plain "sent"
        // is that confirmation, not a follow-up (follow-ups stop at a booking).
        const t0 = ctx.state[id]?.touches?.[0];
        const waiting = !!t0 && !st.sent[0] && !!st.booked && ['drafted', 'outboxed'].includes(t0.status);
        const saysConfirmation = /^confirm/i.test(String(item.kind || ''));
        const given = saysConfirmation ? 0 : item.touch != null ? Number(item.touch) : waiting ? 0 : null;
        let next = Math.max(0, ...Object.keys(st.sent).map(Number)) + 1;
        while (ctx.state[id]?.touches?.[next]?.skipped) next++;
        // The same send reported again (same day, give or take one): recorded once.
        const dup = Object.entries(st.sent).find(([t, d]) => (given != null ? Number(t) === given : Number(t) > 0 && daysApart(d, date) <= 1));
        if (dup) {
          notes.push(
            `${who}: a send on ${dup[1]} is already recorded (${Number(dup[0]) === 0 ? 'the meeting confirmation' : `message ${dup[0]}`}); not recorded again`
          );
          return;
        }
        const touch = given ?? next;
        if (touch === 0 && item.touch == null && !saysConfirmation)
          notes.push(
            `${who}: taken as the meeting confirmation, which was waiting to go. If it was another message, undo it with {"who":"${id}","what":"unsent"} and record it again with "touch": ${next}`
          );
        // Before its approval is odd (the wrong date, or a send floorboss never saw): recorded, and said.
        const approvedOn = String(ctx.state[id]?.touches?.[touch]?.approved?.at || '').slice(0, 10);
        if (approvedOn && date < approvedOn) notes.push(`${who}: sent on ${date}, before it was approved on ${approvedOn}; recorded anyway (check the date)`);
        if (!onList) {
          add.add(id);
          entries.push({ type: 'added', ...base });
          st.removed = false;
        }
        entries.push({
          type: 'sent',
          ...base,
          touch,
          date,
          ...(item.channel ? { channel: text(item.channel, 40) } : {}),
          ...(item.text ? { text: String(item.text).slice(0, 4000) } : {})
        });
        st.sent[touch] = date;
        st.sent_via[touch] = 'user';
        st.sent_at[touch] = '￿'; // in this report: the latest
        lines.push(
          `sent to ${who} (${whichMessage(touch)}) on ${date}${item.channel ? ` via ${text(item.channel, 40)}` : ''}${item.text ? ', with the text as sent' : ''}${onList ? '' : '; added to the shortlist'}`
        );
        break;
      }
      // A send recorded by mistake: the person's last recorded send is taken back with a sent_undone line (the log
      // keeps both). Only a send the user recorded: a message floorboss sent, or one the mailbox shows, went and
      // stays sent.
      case 'unsent': {
        // One undo per person per report: a second would reach a send further back (one the mailbox may show).
        if (undone.has(id)) {
          errors.push(`${where}: ${who} already has an undo in this report; one send is taken back per report`);
          return;
        }
        undone.add(id);
        // The last one: a send recorded in this report first, then by when it was logged, then the highest touch.
        const at = (t) => String(st.sent_at[t] ?? '');
        const order = Object.keys(st.sent)
          .map(Number)
          .sort((a, b) => (at(b) > at(a) ? 1 : at(b) < at(a) ? -1 : b - a));
        const touch = item.touch != null ? Number(item.touch) : order[0];
        if (touch == null || !st.sent[touch]) {
          errors.push(`${where}: ${who} has no recorded send${item.touch != null ? ` for message ${item.touch}` : ''} to undo`);
          return;
        }
        // Only a send recorded from a report of the user's: one floorboss sent, one the mailbox shows (a sync, a
        // thread check) or one logged any other way went out, and taking it back would let it be sent again.
        if (st.sent_via[touch] === 'mailbox') {
          errors.push(`${where}: ${whichMessage(touch)} to ${who} (${st.sent[touch]}) shows in your mailbox as sent: it went, so it isn't undone here`);
          return;
        }
        if (st.sent_via[touch] !== 'user') {
          const how =
            st.sent_via[touch] === 'floorboss'
              ? 'as it went out through floorboss'
              : st.sent_via[touch]
                ? `from ${st.sent_via[touch]}`
                : 'from your mailbox or a status check';
          errors.push(`${where}: ${whichMessage(touch)} to ${who} (${st.sent[touch]}) was recorded ${how}, not from a report of yours: it isn't undone here`);
          return;
        }
        entries.push({ type: 'sent_undone', ...base, touch });
        lines.push(`undone: ${whichMessage(touch)} to ${who}, recorded as sent on ${st.sent[touch]}, is no longer recorded as sent`);
        delete st.sent[touch];
        delete st.sent_at[touch];
        delete st.sent_via[touch];
        break;
      }
      case 'booked':
      case 'moved': {
        const start = parseLocal(item.time, ctx.zone);
        if (!start) {
          errors.push(`${where}: "time" must be the meeting's real local time as YYYY-MM-DD HH:MM`);
          return;
        }
        const hh = Number(/[ T](\d{1,2}):/.exec(String(item.time))?.[1]);
        if ((hh < 6 || hh > 22) && item.night !== true) {
          errors.push(
            `${where}: ${item.time} is the middle of the night: did they mean ${hh < 12 ? `${hh + 12}:${String(item.time).slice(-2)}` : 'another time'}? Ask the user; if it really is then, add "night": true`
          );
          return;
        }
        if (ctx.eventDays && !ctx.eventDays.includes(String(item.time).slice(0, 10)) && !item.outside_event) {
          errors.push(
            `${where}: ${String(item.time).slice(0, 10)} isn't an event day (${ctx.eventDays[0]} to ${ctx.eventDays[ctx.eventDays.length - 1]}; times are read in the event's zone, ${ctx.zone}): check the date, or say it's a meeting outside the event (outside_event: true)`
          );
          return;
        }
        const len = item.minutes == null ? mins : Number(item.minutes);
        if (!(Number.isInteger(len) && len >= 5 && len <= 240)) {
          errors.push(`${where}: minutes is a whole number from 5 to 240`);
          return;
        }
        const s0 = Date.parse(start),
          s1 = s0 + len * 60000;
        const exact = ctx.slots.find((x) => Math.abs(Date.parse(x.start) - s0) <= 5 * 60000);
        const slot = exact ? exact.id : `x${start.replace(/[-:]/g, '').slice(0, 13)}`;
        // Every floorboss slot the meeting overlaps is taken, so nobody else is offered it.
        const blocks = ctx.slots.filter((x) => Date.parse(x.start) < s1 && Date.parse(x.end) > s0).map((x) => x.id);
        const clash =
          [...blocks, slot].map((b) => bookedAt.get(b)).find((other) => other && other !== id) ||
          meetings.find((x) => x.id !== id && x.s0 < s1 && x.s1 > s0)?.id;
        if (clash) {
          errors.push(`${where}: ${labelInZone(start, ctx.zone)} overlaps a meeting already booked with ${ctx.byId[clash]?.name || clash}`);
          return;
        }
        const moved = !!st.booked;
        if (st.booked && st.booked !== slot) unbook(id, st, cancelEntries(st, base)[0]);
        if (!onList) {
          add.add(id);
          entries.push({ type: 'added', ...base });
          st.removed = false;
        }
        entries.push({ type: 'booked', ...base, slot, start, blocks, ...(len !== mins ? { minutes: len } : {}) });
        for (const b of blocks) {
          bookSlots.add(b);
          unbookSlots.delete(b);
          bookedAt.set(b, id);
        }
        bookedAt.set(slot, id);
        meetings.push({ id, s0, s1 });
        st.booked = slot;
        st.booked_start = start;
        st.booked_blocks = blocks;
        lines.push(
          `${moved ? 'moved' : 'booked'}: ${who}, ${labelInZone(start, ctx.zone)}${exact ? '' : ' (not one of your slots; the slots it overlaps are now taken)'}`
        );
        break;
      }
      case 'cancelled': {
        if (!st.booked) {
          errors.push(`${where}: ${who} has no booked meeting to cancel`);
          return;
        }
        // A cancellation is them writing back: it counts as a reply, so no follow-up goes to someone who just
        // cancelled. With "another time" ("maybe Thursday morning?"), the user is asked to agree a new one.
        const [freed, ...after] = cancelEntries({ ...st, replied: !!ctx.state[id]?.replied }, base, { reply: true, anotherTime: item.another_time === true });
        unbook(id, st, freed);
        entries.push(...after);
        lines.push(
          `meeting cancelled: ${who}; their time is free again${item.another_time === true ? "; they asked for another time, so you'll be asked to agree a new one with them" : ''}`
        );
        break;
      }
      // An out-of-office reply: not a reply to the message. No follow-up before the day they're back; after it,
      // follow-ups go on as planned.
      case 'away': {
        const until = String(item.until || '').trim();
        if (!validDay(until) || until < today) {
          errors.push(`${where}: "away" needs "until", the day they're back (YYYY-MM-DD, today or later: ${today})`);
          return;
        }
        entries.push({ type: 'paused', ...base, until });
        lines.push(`${who} is away until ${until}: no follow-up before then`);
        break;
      }
      case 'replied': {
        const on = item.date || null;
        if (on && (!validDay(on) || on > today)) {
          errors.push(`${where}: the reply's date must be a real day, YYYY-MM-DD, on or before today (${today})`);
          return;
        }
        // What they wrote, where and when: the agenda's thread shows it as received.
        // What they wrote, one clean line: shown in the agenda and read with the thread.
        entries.push({
          type: 'replied',
          ...base,
          ...(on ? { date: on } : {}),
          ...(item.channel ? { channel: text(item.channel, 40) } : {}),
          ...(noteText(item.text, 4000) ? { text: noteText(item.text, 4000) } : {})
        });
        lines.push(`${who} replied: no more follow-ups`);
        // A time in the reply is a meeting to settle: said now, and asked next (book it, or not yet).
        const tm = timeInReply(`${item.said || ''} ${item.text || ''}`, ctx.eventDays || []);
        if (tm) {
          entries.push({ type: 'reply_action', ...base, action: 'book', time: tm.at });
          // A booking for them later in the same report answers it: nothing to say, nothing to ask.
          const bookedHere = list.slice(i + 1).some(
            (x) =>
              x?.what === 'booked' &&
              (() => {
                try {
                  return resolveWho(x, ctx).id === id;
                } catch {
                  return false;
                }
              })()
          );
          if (!bookedHere)
            notes.push(
              `${who}: that reads like a time (${tm.words}): record it as booked with {"who":"${id}","what":"booked","time":"${tm.at || 'YYYY-MM-DD HH:MM'}"} if it's confirmed`
            );
        }
        break;
      }
      // Met in person (at a booth, by chance): in touch now, so no cold message or follow-up goes to them.
      case 'met':
        entries.push({ type: 'replied', ...base, outcome: 'met in person' });
        lines.push(`${who}: met in person, so nothing more goes to them from floorboss`);
        break;
      // An email that bounced: that send didn't arrive. With a new address, the contact gets it, and anything
      // still to send to them needs approving again (the approval was for the old address).
      case 'bounced': {
        const t = Number(item.touch) || Math.max(0, ...Object.keys(st.sent).map(Number));
        const newEmail = item.new_email ? String(item.new_email).trim().toLowerCase() : null;
        if (newEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
          errors.push(`${where}: "${newEmail}" isn't an email address`);
          return;
        }
        const holder = newEmail && Object.values(ctx.byId || {}).find((o) => o && o.id !== id && String(o.email || '').toLowerCase() === newEmail);
        if (holder) {
          errors.push(`${where}: ${newEmail} is already ${holder.name}'s address on this list; check whose it is`);
          return;
        }
        entries.push({ type: 'bounced', ...base, touch: t || null, old_email: ct.email || null, ...(newEmail ? { new_email: newEmail } : {}) });
        if (t) delete st.sent[t];
        // The approvals were for the old address: every unsent approved message goes back through the gate
        // (todo offers it again; the text can stay as it is).
        if (newEmail)
          for (const [tt, x] of Object.entries(ctx.state[id]?.touches || {}))
            if (['approved', 'outboxed'].includes(x?.status) && !st.sent[tt])
              entries.push({ type: 'revise', ...base, touch: Number(tt), reason: `address changed to ${newEmail}; the text can stay` });
        lines.push(
          `${who}: the email${t ? ` (message ${t})` : ''} bounced${newEmail ? `; their address is now ${newEmail}, and their messages need approving again${ctx.crmConnected ? ". You'll be asked whether your CRM has them under the new address; if it has a record under the old one, add the new address there yourself (floorboss reads replies by record and changes no records)" : ''}` : '; no new address, so nothing more goes by email'}`
        );
        break;
      }
      case 'declined':
        entries.push({ type: 'replied', ...base, outcome: 'declined' }, { type: 'dropped', ...base, reason: 'declined' });
        lines.push(`${who} said no: dropped, no follow-ups`);
        break;
      case 'stop':
        entries.push({ type: 'stop', ...base });
        lines.push(`${who} asked not to be contacted: stopped here and at every later event`);
        break;
      case 'cut':
        if (Object.keys(st.sent).length) notes.push(`${who} was already sent a message; cutting stops follow-ups only`);
        entries.push({ type: 'removed', ...base, reason: text(item.reason || 'cut by the user', 200) });
        st.removed = true;
        add.delete(id);
        lines.push(`cut: ${who}`);
        break;
      case 'added':
        if (onList) {
          notes.push(`${who} is already on the shortlist`);
          return;
        }
        add.add(id);
        entries.push({ type: 'added', ...base });
        st.removed = false;
        lines.push(`${st.removed === false && ctx.state[id]?.removed ? 'added back' : 'added to the shortlist'}: ${who}`);
        break;
      default:
        break;
    }
  });
  return { errors, entries, bookSlots: [...bookSlots], unbookSlots: [...unbookSlots].filter((b) => !bookSlots.has(b)), add: [...add], lines, notes };
}
