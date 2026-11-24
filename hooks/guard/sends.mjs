// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Sends and staged drafts: the messages floorboss listed to go now, each checked against the approved record,
// and what a send prompt shows.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { home } from '../../lib/paths.mjs';
import { verifySend, eventRecord, eventDay, approvalHash, eventStateAt, followupNotToday, addressBusyToday, busyWhy, homeSends, lentChanged, stepBefore, writtenAgainst } from '../../lib/sendcheck.mjs';
import { contactable } from '../../lib/ledger.mjs';
import { loadEvent, isMockSlug } from '../../lib/event.mjs';
import { createHash } from 'node:crypto';
import { nowMs as clockNow } from '../../lib/clock.mjs';
import { readJsonStrict, recent, fold, leaves } from './shared.mjs';
import { pickHold } from '../../lib/autosend/common.mjs';

export const refusedSends = [];
// Today's send lists across events, each item checked against the record (approval fingerprint, draft,
// contact, sending turned on, no stop or reply, not let through before). Items that fail are dropped: the
// list is only a pointer, never the authority.
// The mock event, or a folder that can't be shown to be a real one (no event.json, or a damaged one): its lists are
// never read, and a damaged file stops nothing else.
export const notRealEvent = (slug) => {
  if (isMockSlug(slug)) return true;
  try {
    const v = readJsonStrict(join(home(), 'events', slug, 'event.json'), null);
    return !v || typeof v !== 'object' || Array.isArray(v) || v.mock === true;
  } catch {
    return true;
  }
};
export function listedSends() {
  const dir = join(home(), 'events');
  if (!existsSync(dir)) return [];
  // Every event's sends, looked at once for all the listed messages (lib/sendcheck.mjs addressBusyToday), and only
  // when some event has messages listed.
  let sends = null;
  return readdirSync(dir).flatMap((slug) => {
    const v = readJsonStrict(join(dir, slug, 'derived', 'send-list.json'), []);
    if (!Array.isArray(v) || !v.length) return [];
    sends ||= homeSends(dir);
    let settings;
    let event;
    try {
      // The mock event's made-up people never reach a real connector.
      const loaded = loadEvent(slug);
      if (loaded.event.mock === true || isMockSlug(slug)) return [];
      settings = loaded.settings;
      event = loaded.event;
    } catch {
      return [];
    }
    const rec = eventRecord(join(dir, slug));
    const nowMs = clockNow();
    return v
      .map((x) => {
        const r0 = verifySend(x, { evDir: join(dir, slug), settings, ...rec, nowMs, sends });
        // The user's pick at the final approval stands against the list: a list written before pick 2 or 3 (or, at an
        // event sending through a daily Claude routine, before any pick) sends nothing of those messages.
        const held = r0.ok && x && typeof x === 'object' ? pickHold(event, rec.entries, x.id, Number(x.touch ?? 1), r0.hash, x.to) : null;
        const r = held ? { ok: false, why: held } : r0;
        // Kept to explain a refusal: "check their replies again" says more than "not listed".
        if (!r.ok && x && typeof x === 'object')
          refusedSends.push({ to: String(x.to || ''), body: String(x.body || ''), name: x.name || x.id, id: x.id, why: r.why });
        return r.ok ? { ...x, hash: r.hash, _event: slug } : null;
      })
      .filter(Boolean);
  });
}

// For the PostToolUse hook: the listed sends the guard let through (a send_released line for that step), as listed.
// listedSends() no longer lists them once released, so the call that just ran is matched against these instead.
export function releasedSends() {
  const dir = join(home(), 'events');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((slug) => {
    if (notRealEvent(slug)) return [];
    const v = readJsonStrict(join(dir, slug, 'derived', 'send-list.json'), []);
    if (!Array.isArray(v) || !v.length) return [];
    const released = eventRecord(join(dir, slug)).entries.filter((e) => e?.type === 'send_released');
    return v.filter((x) => x && typeof x === 'object' && released.some((e) => e.id === x.id && (e.touch ?? 1) === (x.touch ?? 1))).map((x) => ({ ...x, _event: slug }));
  });
}

export function listed(file, nowMs = Date.now()) {
  const dir = join(home(), 'events');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((slug) => {
    if (notRealEvent(slug)) return [];
    const v = readJsonStrict(join(dir, slug, file), []);
    if (!Array.isArray(v)) return [];
    if (file === 'contact-list.json' || file === 'task-list.json') return v.filter((x) => x && typeof x === 'object').map((x) => ({ ...x, _event: slug }));
    if (file !== 'stage-list.json') return v;
    // An approved draft is staged only while the record still lets floorboss write to that person.
    return v
      .filter((x) => approvedText(join(dir, slug), x))
      .map((x) => {
        const why = stageRefusal(join(dir, slug), x, nowMs);
        return why ? { ...x, _why: why, _event: slug } : { ...x, _event: slug };
      });
  });
}

// Why an approved draft can't be put in the mailbox now: the same record checks a send has (a stop, a reply
// or booking, removed or dropped, a damaged ledger line), listed in the last 30 minutes, and what the other events lend
// about the person unchanged since the list. Null: it can.
export function stageRefusal(evDir, item, nowMs = Date.now()) {
  const { state, folded } = eventRecord(evDir);
  const touch = item.touch ?? 1;
  const kind = touch === 0 ? 'confirmation' : 'message';
  const held = contactable(folded, item.id, kind, eventDay(evDir, nowMs));
  if (held) return held;
  const st = state[item.id] || {};
  if (st.stopped || st.removed || st.dropped) return "they're stopped, removed or dropped";
  if (kind !== 'confirmation' && (st.replied || st.booked)) return 'they replied or booked';
  if (kind === 'confirmation' && !folded.people[item.id]?.booked) return 'their booking was taken back';
  if (!recent(item.listed_at, nowMs, 30 * 60 * 1000)) return 'it wasn\'t listed in the last 30 minutes: run "outreach stage-list" again';
  // A step recorded as sent gets no draft (stage-list never lists one either).
  if (st.sent?.[touch] || folded.people[item.id]?.touches?.[touch]?.sent) return 'it was already sent';
  // What the user's other events lend about this person, as the send check reads it (lib/sendcheck.mjs lentChanged): a
  // stop, a send or an approval recorded at another event since the list was made holds the draft.
  const elsewhere = lentChanged(evDir, item, folded.people[item.id]);
  if (elsewhere) return `${elsewhere}: run "outreach stage-list" again, which reads it in full`;
  // Nothing is put in the mailbox once the event is over, and a follow-up only on its day (the same rule as a send).
  const es = eventStateAt(evDir, nowMs);
  if (es.state !== 'ok') return es.why;
  if (kind === 'message' && Object.keys(st.sent || {}).some((k) => Number(k) > touch)) return 'a later message already went';
  // One message a day to a person across all your events, by address, as for a send (a confirmation aside): a draft
  // isn't put in while another event's message to that address went or is going today.
  if (touch !== 0) {
    const busy = addressBusyToday(evDir, item.to, nowMs, item.id);
    if (busy) return busyWhy(busy, folded.people[item.id]?.name || item.id, item.to);
  }
  // A follow-up goes in only after the message before it went, and each step's draft goes in once. A LinkedIn step the
  // user sends by hand that hasn't gone is passed over (owner, 0.1.7 section 12b): the spacing, one a day and every
  // other check here still hold, counted from the message that went (lib/sendcheck.mjs stepBefore).
  const before = kind === 'message' && touch > 1 ? stepBefore(evDir, eventRecord(evDir).entries, st, item.id, touch) : 0;
  if (before > 0 && !st.sent?.[before]) return "the message before it hasn't gone";
  // Nothing before it went (every step before it skipped, or LinkedIn steps that never went), and this text was written
  // as a follow-up to one of them: it never goes (owner answer A1), as at the send (lib/sendcheck.mjs verifySend).
  if (kind === 'message' && touch > 1 && before === 0 && writtenAgainst(eventRecord(evDir).entries, item.id, touch, st.touches?.[touch]?.approved?.hash))
    return 'it was written as a follow-up to a message that never went: it is written again as a first message, for your next approval';
  if (st.touches?.[touch]?.staged) return 'its draft is already in your drafts';
  // An unattended run let its draft in (the guard's own record of it, written before the call ran).
  if (st.touches?.[touch]?.stage_released) return 'its draft already went into your drafts on its own (an unattended run): check your drafts folder';
  if (kind === 'message' && touch > 1) {
    let settings = {};
    try {
      settings = loadEvent(basename(evDir)).settings;
    } catch {}
    const why = followupNotToday(evDir, settings, eventRecord(evDir).entries, st, { ...item, touch }, nowMs);
    if (why) return why;
  }
  return null;
}

// A staged draft must be one the user approved, word for word: an item written into stage-list.json by
// anything else (an injected Write) has no approved draft behind it.
// A staged draft is held to the same approval fingerprint as a send: the saved text, to the contact's own
// address, with the approved subject. A list entry with the approved body but another recipient or subject
// is not approved.
export function approvedText(evDir, item) {
  if (!item || typeof item !== 'object' || !/^c\d+$/.test(String(item.id))) return false;
  const touch = item.touch ?? 1;
  const { state } = eventRecord(evDir);
  const appr = state[item.id]?.touches?.[touch]?.approved;
  if (!appr?.hash || !appr.to) return false;
  const d = readJsonStrict(join(evDir, 'drafts', `${appr.hash}.json`), null);
  if (!d || approvalHash(d, appr.to) !== appr.hash) return false;
  const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
  return same(item.body, d.body) && same(item.subject || '', d.subject || '') && fold(item.to) === fold(appr.to);
}

// What a send prompt shows: the whole message (subject and body, up to 1,500 characters) and the recipient
// as the call carries it, so the user reads what actually goes, not a summary.
export function fullText(subject, body, cap = 1500) {
  const t = `${subject ? `Subject: ${subject}\n\n` : ''}${String(body ?? '')}`;
  return t.length > cap ? `${t.slice(0, cap)}… (${t.length - cap} more characters)` : t;
}

// The recipient a send prompt shows: the values the call carries where the recipe has its {to}
// placeholder (not any value with an @ in it, which a body or a subject can hold too).
export function recipientShown(args, recipe, fallback) {
  const template = new Map();
  for (const [p, v] of leaves(recipe?.args || {})) template.set(p, [...(template.get(p) || []), v]);
  const to = [
    ...new Set(
      leaves(args)
        .filter(([p]) => (template.get(p) || []).includes('{to}'))
        .map(([, v]) => String(v ?? '').trim())
        .filter(Boolean)
    )
  ];
  return to.length ? to.join(', ') : fallback;
}

// A stage batch: the stage-list.json floorboss wrote, by its bytes.
export const stageBatch = (evDir) =>
  createHash('sha256')
    .update(readFileSync(join(evDir, 'stage-list.json')))
    .digest('hex')
    .slice(0, 24);
