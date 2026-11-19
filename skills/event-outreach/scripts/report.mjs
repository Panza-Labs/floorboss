// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The after-show report: every meeting booked at an event and what became of it (held, no-show, cancelled, moved,
// not marked yet), the walk-ups apart, and for each person how and when floorboss's outreach first reached them.
// Built from the event's ledger alone, on the user's machine; the page loads nothing and runs no script.
import { escapeHtml as e } from '../../../lib/escape.mjs';
import { labelInZone } from '../../../lib/tz.mjs';

export const OUTCOME_LABEL = Object.freeze({
  held: 'held',
  no_show: 'no-show',
  cancelled: 'cancelled',
  not_marked: 'not marked yet',
  upcoming: 'still to come'
});

// What a send's channel was: the user's own word when they gave one, else where it was approved to go.
function channelOf(sent, approved) {
  const c = String(sent?.channel || '').trim();
  if (c) return c.slice(0, 40);
  const to = String(approved?.to || '');
  if (/@/.test(to)) return 'email';
  if (/linkedin\.com/i.test(to)) return 'LinkedIn';
  if (approved?.where) return String(approved.where).slice(0, 40);
  return to ? 'event app' : 'email';
}

// From the ledger's entries, in order. A booking replaced by another in the same report (same time: "moved",
// "rescheduled", or the calendar moving it) is one meeting, moved; any other unbooking is a cancellation. An outcome
// counts for the booking it names (its start), and the latest word stands.
export function buildReport(entries, { byId = {}, zone = 'UTC', now = new Date(), minutes = 30 } = {}) {
  const meetings = [];
  const open = new Map(); // id → the meeting its current booking belongs to
  const pendingUnbook = new Map(); // id → { meeting, at } for an unbook that a booking at the same time may follow
  const firstSent = new Map(); // id → { date, touch, channel }
  const sentByTouch = new Map(); // `${id}:${touch}` → sent entry, for undo
  const approvedByTouch = new Map();
  const walkups = [];
  const settle = (id) => {
    const p = pendingUnbook.get(id);
    if (!p) return;
    p.meeting.status = 'cancelled';
    pendingUnbook.delete(id);
  };
  for (const x of entries) {
    if (!x || typeof x !== 'object') continue;
    const id = x.id;
    // An unbook with no booking for them in the same report (the same moment) was a cancellation: settled once
    // a later line about them comes, or at the end.
    if (id && pendingUnbook.has(id) && x.at !== pendingUnbook.get(id).at) settle(id);
    switch (x.type) {
      case 'approved':
        approvedByTouch.set(`${id}:${x.touch ?? 1}`, x);
        break;
      case 'sent':
        sentByTouch.set(`${id}:${x.touch ?? 1}`, x);
        break;
      case 'sent_undone':
        sentByTouch.delete(`${id}:${x.touch ?? 1}`);
        break;
      case 'booked': {
        const moved = pendingUnbook.get(id);
        if (moved && moved.at === x.at) {
          moved.meeting.moves.push(moved.meeting.start);
          moved.meeting.start = x.start || null;
          moved.meeting.slot = x.slot || null;
          moved.meeting.status = 'booked';
          pendingUnbook.delete(id);
          open.set(id, moved.meeting);
          break;
        }
        const cur = open.get(id);
        if (cur && cur.status === 'booked') {
          // Booked again with no unbook between (an older log): the same meeting, moved.
          if (cur.start !== (x.start || null)) cur.moves.push(cur.start);
          cur.start = x.start || null;
          cur.slot = x.slot || null;
          break;
        }
        const m = { id, start: x.start || null, slot: x.slot || null, moves: [], status: 'booked', outcome: null, via: x.via || x.source || null };
        meetings.push(m);
        open.set(id, m);
        break;
      }
      case 'unbooked': {
        const cur = open.get(id);
        if (cur && cur.status === 'booked') {
          cur.status = 'unbooked';
          pendingUnbook.set(id, { meeting: cur, at: x.at });
          open.delete(id);
        }
        break;
      }
      case 'meeting_outcome': {
        const cur = open.get(id);
        if (cur && cur.status === 'booked' && (!x.start || x.start === cur.start)) cur.outcome = x.outcome;
        break;
      }
      case 'walkup':
        walkups.push(
          id
            ? { id, name: byId[id]?.name || id, company: byId[id]?.company || null, date: x.date || null, on_list: true }
            : { id: null, name: String(x.name || '').slice(0, 120), company: x.company ? String(x.company).slice(0, 120) : null, date: x.date || null, on_list: false }
        );
        break;
      default:
        break;
    }
  }
  for (const id of [...pendingUnbook.keys()]) settle(id);
  // First contact: the earliest recorded send to each person that wasn't taken back.
  for (const [key, s] of sentByTouch) {
    const [id, touch] = key.split(':');
    const date = s.date || String(s.at || '').slice(0, 10) || null;
    const cur = firstSent.get(id);
    if (!cur || String(date) < String(cur.date) || (date === cur.date && Number(touch) < cur.touch))
      firstSent.set(id, { date, touch: Number(touch), channel: channelOf(s, approvedByTouch.get(key)) });
  }
  const end = (m) => Date.parse(m.start || '') + minutes * 60000;
  const rows = meetings.map((m) => {
    const status =
      m.status === 'cancelled' ? 'cancelled' : m.outcome ? m.outcome : Number.isFinite(end(m)) && end(m) <= now.getTime() ? 'not_marked' : 'upcoming';
    const ct = byId[m.id] || {};
    const fc = firstSent.get(m.id) || null;
    return {
      id: m.id,
      name: ct.name || m.id,
      company: ct.company || null,
      time: m.start ? labelInZone(m.start, zone) : null,
      start: m.start,
      moved_from: m.moves.filter(Boolean).map((s) => labelInZone(s, zone)),
      outcome: status,
      first_contact: fc ? { channel: fc.channel, date: fc.date } : null
    };
  });
  rows.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const count = (k) => rows.filter((r) => r.outcome === k).length;
  const counts = {
    booked: rows.length,
    held: count('held'),
    no_show: count('no_show'),
    cancelled: count('cancelled'),
    rescheduled: rows.filter((r) => r.moved_from.length).length,
    not_marked: count('not_marked'),
    upcoming: count('upcoming'),
    walkups: walkups.length
  };
  const walk = walkups.map((w) => ({ ...w, first_contact: w.id ? firstSent.get(w.id) || null : null }));
  return { counts, meetings: rows, walkups: walk };
}

const CSV_HEADERS = ['kind', 'name', 'company', 'meeting_time', 'outcome', 'rescheduled_from', 'first_contact_channel', 'first_contact_date'];
export function reportCsvRows(r) {
  return [
    ...r.meetings.map((m) => ({
      kind: 'meeting',
      name: m.name,
      company: m.company || '',
      meeting_time: m.time || '',
      outcome: OUTCOME_LABEL[m.outcome] || m.outcome,
      rescheduled_from: m.moved_from.join('; '),
      first_contact_channel: m.first_contact?.channel || '',
      first_contact_date: m.first_contact?.date || ''
    })),
    ...r.walkups.map((w) => ({
      kind: 'walk-up',
      name: w.name,
      company: w.company || '',
      meeting_time: w.date || '',
      outcome: w.on_list ? 'walk-up (on your list)' : 'walk-up (not on your list)',
      rescheduled_from: '',
      first_contact_channel: w.first_contact?.channel || '',
      first_contact_date: w.first_contact?.date || ''
    }))
  ];
}
export { CSV_HEADERS };

export function renderReport(r, { event = {}, generatedAt = '' } = {}) {
  const c = r.counts;
  const row = (m) =>
    `<tr><td>${e(m.time || '')}</td><td>${e(m.name)}</td><td>${e(m.company || '')}</td><td>${e(OUTCOME_LABEL[m.outcome] || m.outcome)}</td><td>${e(m.moved_from.join('; '))}</td><td>${e(m.first_contact ? `${m.first_contact.channel}, ${m.first_contact.date}` : 'none recorded')}</td></tr>`;
  const wrow = (w) =>
    `<tr><td>${e(w.date || '')}</td><td>${e(w.name)}</td><td>${e(w.company || '')}</td><td>${w.on_list ? 'on your list' : 'not on your list'}</td><td>${e(w.first_contact ? `${w.first_contact.channel}, ${w.first_contact.date}` : 'none recorded')}</td></tr>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(event.name || '')} · after-show report</title>
<style>
:root{--bg:#f4f5f7;--card:#fff;--ink:#16202a;--muted:#5c6774;--line:#dde1e6;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#11161c;--card:#182029;--ink:#e6eaef;--muted:#9aa5b2;--line:#2a3441;color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:0 16px 48px}
.wrap{max-width:960px;margin:0 auto}h1{font-size:26px;margin:20px 0 2px}h2{font-size:18px;margin:28px 0 10px}.sub{color:var(--muted);margin:0 0 12px}
.counts{display:flex;flex-wrap:wrap;gap:10px}.counts div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 14px}.counts b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
.tbl{overflow-x:auto}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line)}td,th{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:top}th{color:var(--muted);font-weight:500}
</style></head>
<body><div class="wrap">
<h1>${e(event.name || '')}: after the show</h1>
<p class="sub">${e(event.city || '')}${event.start_date ? ` · ${e(event.start_date)} to ${e(event.end_date || '')}` : ''} · times in ${e(event.time_zone || '')} · built ${e(generatedAt)} from floorboss's record of this event</p>
<div class="counts"><div><b>${c.booked}</b>booked</div><div><b>${c.held}</b>held</div><div><b>${c.no_show}</b>no-show</div><div><b>${c.cancelled}</b>cancelled</div><div><b>${c.rescheduled}</b>rescheduled</div><div><b>${c.not_marked}</b>not marked yet</div>${c.upcoming ? `<div><b>${c.upcoming}</b>still to come</div>` : ''}<div><b>${c.walkups}</b>walk-ups</div></div>
<h2>Meetings (${r.meetings.length})</h2>
${r.meetings.length ? `<div class="tbl"><table><thead><tr><th>Time</th><th>Name</th><th>Company</th><th>Outcome</th><th>Rescheduled from</th><th>First contact</th></tr></thead><tbody>${r.meetings.map(row).join('')}</tbody></table></div>` : '<p class="sub">No meetings were booked.</p>'}
<h2>Walk-ups (${r.walkups.length})</h2>
${r.walkups.length ? `<div class="tbl"><table><thead><tr><th>Day</th><th>Name</th><th>Company</th><th>List</th><th>First contact</th></tr></thead><tbody>${r.walkups.map(wrow).join('')}</tbody></table></div>` : '<p class="sub">None recorded.</p>'}
${c.not_marked ? `<p class="sub">${c.not_marked} ${c.not_marked === 1 ? 'meeting has' : 'meetings have'} no outcome yet: tell floorboss how each went (held, no-show, cancelled or moved), then build the report again.</p>` : ''}
</div></body></html>
`;
}
