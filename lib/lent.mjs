// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// What one event's record lends the user's other events, read in one place: the people who were sent or approved a
// message there, or said stop there (crm-triage evidence.mjs earlierEvents holds them as in touch, or stopped), and the
// CRM match answers given there (crm-triage view.mjs earlierMatches carries them). The outbox page of another event
// records a digest of it (page-inputs.mjs), so a line there that changes none of it (a group decision, a cut, a sync)
// leaves that page current (an answer about a CRM match changes it); and the send and staging checks compare, for the
// person an item goes to, what is lent now with what was lent when the send or stage list was made (sendcheck.mjs
// lentChanged). The mock event lends nothing and is lent nothing.
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { home } from './paths.mjs';
import { createHash } from 'node:crypto';
import { readJson } from './jsonio.mjs';
import { readLedger, fold, lastSent } from './ledger.mjs';
import { emailBase, nameMatchKey } from './normalize.mjs';

const cache = new Map();
// What lentAbout says for someone the other events lend nothing about.
export const LENT_NOTHING = createHash('sha256').update('[]').digest('hex').slice(0, 24);
const statKey = (p) => {
  try {
    const s = statSync(p);
    return `${s.size}:${s.mtimeMs}:${s.ino}`;
  } catch {
    return 'none';
  }
};

// The event in folder dir: { name, time_zone, people, matches }, or null (no event, the mock, no record). Read once per
// process for the same files. Throws when the record can't be read (the caller says so).
export function lentBy(dir) {
  const evPath = join(dir, 'event.json');
  const led = join(dir, 'ledger.jsonl');
  const key = `${statKey(evPath)}|${statKey(led)}`;
  const hit = cache.get(dir);
  if (hit && hit.key === key) return hit.value;
  let value = null;
  const ev = readJson(evPath, null);
  if (ev && !ev.mock && existsSync(led)) {
    const { entries, damaged } = readLedger(led);
    const st = fold(entries, damaged);
    const people = [];
    const matches = [];
    for (const [id, p] of Object.entries(st.people)) {
      if (p.merged_into) continue;
      const sent = lastSent(p);
      const approvedTouch = Object.values(p.touches).find((t) => t.approved);
      const approved = Object.values(p.touches).some((t) => t.approved && !t.sent);
      if (sent || approved || p.stopped)
        people.push({
          id,
          name: p.name || null,
          email: p.email || null,
          company: p.company || null,
          // Messaged there: the last message sent (its day), else one approved and maybe sent (the day approved).
          messaged: !!(sent || approved),
          sent: sent ? String(p.touches[sent].sent.date ?? '') : null,
          approved: !sent && approved ? String(approvedTouch?.approved?.at || '').slice(0, 10) : null,
          stopped: !!p.stopped,
          booked: p.booked || null,
          booked_start: p.booked_start || null,
          replied: !!p.replied
        });
      const refs = (p.matches || []).filter((m) => /^crm:\d+$/.test(m.ref || ''));
      if (p.name && refs.length)
        matches.push({
          id,
          name: p.name,
          email: p.email || null,
          company: p.company || null,
          matches: refs.map((m) => ({ group: m.group, ref: m.ref, because: m.because ?? null, at: m.at ?? null }))
        });
    }
    value = { slug: basename(dir), name: ev.name || basename(dir), time_zone: ev.time_zone || null, people, matches };
  }
  cache.set(dir, { key, value });
  return value;
}

// A digest of what the event in dir lends: the same digest for the same lending, whatever else its record holds.
export function lentDigest(dir) {
  let v;
  try {
    v = lentBy(dir);
  } catch (e) {
    return `unreadable: ${String(e.message || e).slice(0, 80)}`;
  }
  return createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 24);
}

// The other events of the event in folder dir: every folder in floorboss's events folder with an event.json but this
// one, sorted (the folders crm-triage evidence.mjs earlierEvents reads; lentBy leaves out the mock).
function otherDirs(dir) {
  const root = join(home(), 'events');
  const self = resolve(dirname(dir)) === resolve(root) ? basename(dir) : null;
  let names = [];
  try {
    names = readdirSync(root);
  } catch {
    names = [];
  }
  return names.filter((s) => s !== self && existsSync(join(root, s, 'event.json'))).sort().map((s) => join(root, s));
}

// What the user's other events lend about one person (person: { name, email, emails }), matched broadly: the same
// address (its +tag and Gmail dots aside) or the same name as matching reads names (nicknames folded), whatever the
// company. A send list and a stage list record it for each item; at the send, or when the draft is staged, it is read
// again, and any difference (a stop, a send, an approval, a CRM match answer, an address change at another event since
// the list was made) means the list is made again first. An event
// that can't be read counts as it does for the triage view (left out, and said there), and as a change when it comes
// or goes. Returns a digest.
export function lentAbout(dir, person) {
  // The mock is lent nothing (crm-triage evidence.mjs earlierEvents).
  let mock = false;
  try {
    mock = readJson(join(dir, 'event.json'), null)?.mock === true;
  } catch {
    mock = false;
  }
  if (mock) return LENT_NOTHING;
  const mine = new Set([person?.email, person?.email_override, ...(person?.emails || [])].filter(Boolean).map((x) => emailBase(x)).filter(Boolean));
  const key = person?.name ? nameMatchKey(person.name) : '';
  const out = [];
  for (const d of otherDirs(dir)) {
    let v;
    try {
      v = lentBy(d);
    } catch {
      out.push(['unreadable', basename(d)]);
      continue;
    }
    if (!v) continue;
    const same = (r) => (r.email && mine.has(emailBase(r.email))) || (!!key && !!r.name && nameMatchKey(r.name) === key);
    for (const r of v.people) if (same(r)) out.push(['p', v.slug, v.name, r]);
    for (const r of v.matches) if (same(r)) out.push(['m', v.slug, v.name, r]);
  }
  return createHash('sha256').update(JSON.stringify(out)).digest('hex').slice(0, 24);
}
