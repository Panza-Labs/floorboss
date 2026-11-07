// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The outbox status line: what the user sent, booked, heard back from, or was told to stop.
// floorboss-status v1 event=<slug> at=<ISO UTC>
// c014 sent=2027-03-01 booked=s20270310T1030 | c019 sent=2027-03-01 replied | c022 stop

export class StatusError extends Error {}

const HEADER = /^floorboss-status v1 event=([a-z0-9-]+) at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)$/;

export function formatStatus(slug, at, rows) {
  const lines = [`floorboss-status v1 event=${slug} at=${at}`];
  for (const r of rows) {
    const toks = [r.touch !== undefined && r.touch !== 1 ? `${r.id}:${r.touch}` : r.id]; // :0 is a confirmation
    if (r.sent) toks.push(`sent=${r.sent}`);
    if (r.booked) toks.push(`booked=${r.booked}`);
    if (r.replied) toks.push('replied');
    if (r.stop) toks.push('stop');
    if (toks.length > 1) lines.push(toks.join(' '));
  }
  return lines.join('\n');
}

const realDay = (d) => {
  const t = Date.parse(`${d}T12:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
};

export function parseStatus(text, { slug, lastAt = null, knownIds = null, knownSlots = null, now = null }) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) throw new StatusError('The status is empty. Paste it from the outbox, or type "nothing changed".');
  const h = HEADER.exec(lines[0]);
  if (!h) throw new StatusError('The first line should start "floorboss-status v1". Use the outbox\'s Copy status button.');
  if (h[1] !== slug) throw new StatusError(`This status is for event "${h[1]}", not "${slug}".`);
  // A time from the future would lock out every real status after it.
  if (now && Date.parse(h[2]) > now.getTime() + 15 * 60000)
    throw new StatusError(`This status says it was copied at ${h[2]}, which is in the future. Copy a fresh one from the outbox.`);
  if (lastAt && Date.parse(h[2]) <= Date.parse(lastAt)) {
    throw new StatusError(`This status (${h[2]}) is older than the last one used (${lastAt}). Copy a fresh one from the outbox.`);
  }
  const rows = [];
  // Rows may also be run together on one line, separated by "|" (as in the example above).
  for (const line of lines
    .slice(1)
    .flatMap((l) => l.split(/\s*\|\s*/))
    .filter(Boolean)) {
    const [head, ...toks] = line.split(/\s+/);
    const hm = /^(c\d{3,})(?::(\d))?$/.exec(head);
    if (!hm) throw new StatusError(`"${line}" doesn't start with a contact ID.`);
    const id = hm[1];
    if (knownIds && !knownIds.has(id)) throw new StatusError(`${id} isn't in this event.`);
    const row = { id, touch: hm[2] === undefined ? 1 : Number(hm[2]) };
    for (const t of toks) {
      let m;
      if ((m = /^sent=(\d{4}-\d{2}-\d{2})$/.exec(t))) {
        if (!realDay(m[1])) throw new StatusError(`${id}: "${m[1]}" isn't a real date.`);
        if (now && m[1] > new Date(now.getTime() + 36 * 3600000).toISOString().slice(0, 10)) throw new StatusError(`${id}: sent=${m[1]} is in the future.`);
        row.sent = m[1];
      } else if ((m = /^booked=(s\d{8}T\d{4})$/.exec(t))) {
        if (knownSlots && !knownSlots.has(m[1])) throw new StatusError(`${id} is booked into ${m[1]}, which isn't a slot of this event.`);
        row.booked = m[1];
      } else if (t === 'replied') row.replied = true;
      else if (t === 'stop') row.stop = true;
      else throw new StatusError(`"${t}" in "${line}" isn't something the status understands.`);
    }
    rows.push(row);
  }
  return { at: h[2], rows };
}

// Bookings that can't all be true: two people in one slot (in this paste or already), or a time that
// was never offered and isn't free. Returns problems for the user to settle; nothing is applied.
export function bookingConflicts(parsed, { state, assignments, freeSlots = null }) {
  const problems = [];
  // Who holds each time now. A stopped person's booking frees it; so does a row in this paste that moves
  // someone to another time or says stop, so two people can swap times in one paste.
  const holder = new Map();
  for (const [id, s] of Object.entries(state)) if (s.booked && !s.stopped) holder.set(s.booked, id);
  for (const r of parsed.rows) {
    const old = state[r.id]?.booked;
    if (old && holder.get(old) === r.id && ((r.booked && r.booked !== old) || r.stop)) holder.delete(old);
  }
  const inPaste = new Map();
  for (const r of parsed.rows.filter((x) => x.booked)) {
    const other = holder.get(r.booked);
    if (other && other !== r.id && state[r.id]?.booked !== r.booked) problems.push(`${r.id} is booked into ${r.booked}, but ${other} already has that time`);
    if (inPaste.has(r.booked) && inPaste.get(r.booked) !== r.id) problems.push(`${inPaste.get(r.booked)} and ${r.id} are both booked into ${r.booked}`);
    inPaste.set(r.booked, r.id);
    const offered = (assignments[r.id] || []).includes(r.booked);
    if (!offered && freeSlots && !freeSlots.has(r.booked))
      problems.push(`${r.id} is booked into ${r.booked}, which wasn't offered to them and isn't a free time now`);
  }
  return problems;
}

// Turn a parsed status into actions. state: folded contact log. assignments: id -> slot ids.
export function planFromStatus(parsed, { state, assignments }) {
  const booked = new Set(),
    stops = [],
    newlySent = [],
    replied = [],
    logEntries = [];
  for (const r of parsed.rows) {
    const s = state[r.id] || { sent: {} };
    const touch = r.touch ?? 1;
    if (r.sent && s.sent?.[touch] !== r.sent) {
      logEntries.push({ type: 'sent', id: r.id, touch, date: r.sent });
      newlySent.push(r.id);
    }
    if (r.replied && !s.replied) {
      logEntries.push({ type: 'replied', id: r.id });
      replied.push(r.id);
    }
    if (r.booked && s.booked !== r.booked) {
      logEntries.push({ type: 'booked', id: r.id, slot: r.booked });
      booked.add(r.booked);
    }
    if (r.stop && !s.stopped) {
      logEntries.push({ type: 'stop', id: r.id });
      stops.push(r.id);
    }
  }
  // Anyone else holding a slot that's now booked needs new times.
  const redraft = Object.entries(assignments)
    .filter(([cid, ids]) => ids.some((x) => booked.has(x)) && !parsed.rows.find((r) => r.id === cid && (r.booked || r.replied || r.stop)))
    .map(([cid]) => cid);
  return { logEntries, bookedSlots: [...booked], stops, newlySent, replied, redraft };
}
