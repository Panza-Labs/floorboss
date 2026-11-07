// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Tracking across channels. Email is read from the mailbox; meetings from the calendar; everything that has
// no connector (event-app messages, LinkedIn, colleague notes, decisions for the user) becomes a CRM task,
// and the task's completion and outcome come back into the contact log. One log, every channel.
import { createHash } from 'node:crypto';
import { escapeHtml } from '../../../lib/escape.mjs';
import { timeMentioned } from './checks.mjs';
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
  return /linkedin\.com\//i.test(contact?.profile_url || '') ? 'LinkedIn' : event.app_name || 'the event app';
}

const OUTCOME_HELP =
  'When it\'s sent, mark this task done. If they answer, write it in the task (outcome or note): "replied", "booked <day> <time>", or "stop".';

// The tasks floorboss wants in the CRM now. created: Set of keys already created (from the log).
// cards: outbox cards. review: [{id, reason}] decisions for the user. stops: contacts who said stop.
// selfSends(card): floorboss sends this message itself (sending on for its channel): no "send it" task, or it
// could go twice.
export function taskItems({ cards, review = [], stops = [], created, event, byId, crmOf, today, now = new Date().toISOString(), selfSends = () => false }) {
  const items = [];
  // The CRM's own record id, or nothing: an email isn't a record id, and a task on no record still shows.
  const ref = (id) => crmOf(id)?.crm_id || null;
  for (const card of cards) {
    // A follow-up planned for later gets its task on its day, not now.
    if (card.planned_due && card.planned_due > today) continue;
    if ((card.kind === 'message' || card.kind === 'confirmation') && card.channel === 'paste' && !selfSends(card)) {
      const key = `${card.id}:${card.touch}`;
      if (created.has(key)) continue;
      const where = whereTo(card, event);
      items.push({
        key,
        id: card.id,
        touch: card.touch,
        kind: 'send',
        contact_ref: ref(card.id),
        listed_at: now,
        title: `${card.kind === 'confirmation' ? 'Confirm the meeting with' : card.touch > 1 ? 'Follow up' : 'Message'} ${short(card.name)} (${short(card.company)}) in ${where}`,
        body: `${card.body}\n\n---\n${where === 'LinkedIn' && card.profile_url ? `Profile: ${card.profile_url}\n` : ''}${OUTCOME_HELP}`,
        // Due the day it should go out: floorboss lists a message when it's due, so that's today.
        due: today
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
      body: `${r.reason}\n\nAnswer it in floorboss (the next /floorboss:start run asks), then mark this task done.`,
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

// The tracker: one row per person, from the log. rows: [{name, company, channel, status, last, next, note, tone}].
export function trackerHtml({ event, rows, counts, at }) {
  const CSP = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${TRACKER_HASH}'; img-src 'none'; base-uri 'none'; form-action 'none'`;
  const tr = rows
    .map(
      (r) =>
        `<tr data-tone="${escapeHtml(r.tone)}"><td>${escapeHtml(r.name)}<div class="sub">${escapeHtml(r.company)}</div></td><td>${escapeHtml(r.channel)}</td><td class="st">${escapeHtml(r.status)}</td><td>${escapeHtml(r.last || '')}</td><td>${escapeHtml(r.next || '')}</td><td class="sub">${escapeHtml(r.note || '')}</td></tr>`
    )
    .join('\n');
  const chips = Object.entries(counts)
    .map(([k, v]) => `<button data-f="${escapeHtml(k)}">${escapeHtml(k)} <b>${v}</b></button>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${escapeHtml(event.name)} tracker</title>
<style>
:root{--bg:#fbfaf8;--fg:#1d1d1b;--mute:#6b6a66;--line:#e4e1db;--ok:#2f6f4f;--warn:#9a5b00;--stop:#8a2b2b;--chip:#efece6}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe7;--mute:#9a9893;--line:#2c2b29;--ok:#7cc4a0;--warn:#e0a85a;--stop:#e08a8a;--chip:#22211f}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--mute);font-size:12px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0}.chips button{background:var(--chip);border:1px solid var(--line);color:var(--fg);border-radius:999px;padding:4px 10px;cursor:pointer;font:inherit}
.chips button[aria-pressed=true]{border-color:var(--fg)}
input{width:100%;max-width:360px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:720px;margin-top:10px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--mute);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
tr[data-tone=ok] .st{color:var(--ok)}tr[data-tone=warn] .st{color:var(--warn)}tr[data-tone=stop] .st{color:var(--stop)}
</style></head><body>
<h1>${escapeHtml(event.name)}</h1><div class="sub">Who you're reaching and where each person stands, from floorboss's log. Updated ${escapeHtml(at)}. This page only shows; change things with /floorboss:start.</div>
<div class="chips">${chips}</div>
<input id="q" placeholder="Filter by name, company or status" aria-label="Filter">
<div class="wrap"><table><thead><tr><th>Person</th><th>Channel</th><th>Status</th><th>Last touch</th><th>Next</th><th>Why</th></tr></thead><tbody>
${tr}
</tbody></table></div>
<script>${TRACKER_SCRIPT}</script></body></html>`;
}
// The tracker's one script, fixed text: the page allows exactly this by its hash, so nothing put in the page
// from the log can run, even past the escaping.
const TRACKER_SCRIPT = `
const rows=[...document.querySelectorAll('tbody tr')];let f=null;
function apply(){const q=document.getElementById('q').value.toLowerCase();rows.forEach(r=>{const st=r.querySelector('.st').textContent;r.hidden=!(r.textContent.toLowerCase().includes(q)&&(!f||st.toLowerCase().startsWith(f.toLowerCase())))})}
document.getElementById('q').addEventListener('input',apply);
document.querySelectorAll('.chips button').forEach(b=>b.addEventListener('click',()=>{f=f===b.dataset.f?null:b.dataset.f;document.querySelectorAll('.chips button').forEach(x=>x.setAttribute('aria-pressed',String(x.dataset.f===f)));apply()}));
`;
const TRACKER_HASH = createHash('sha256').update(TRACKER_SCRIPT, 'utf8').digest('base64');
