// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// `flow review`: the drafts for the user to review in the chat (hand-send), never on a page. A small but varied sample
// with full subject and body (different people and asks, a first message and a follow-up), the total the approval
// covers, and one plain read-only document with every message (all-messages.md: in the project folder in Codex, else
// the event's folder). With --readback, the same for auto-send's readback: the sample, every person's planned days,
// the total and the digest the approval takes (the readback's own, worked out by the same code).
import { join, basename } from 'node:path';
import { mkdirSync } from 'node:fs';
import { need } from '../../../lib/args.mjs';
import { readJson, writeText } from '../../../lib/jsonio.mjs';
import { projectFolder } from '../../../lib/paths.mjs';
import { readback } from '../../../lib/autosend/approval.mjs';
import { context } from './context.mjs';
import { plural } from '../../../lib/plural.mjs';
import { spawnSync } from 'node:child_process';
import { script } from './context.mjs';

const DOC = 'all-messages.md';
const draftAt = (dir, hash) => (/^[0-9a-f]{24}$/.test(String(hash || '')) ? readJson(join(dir, 'drafts', `${hash}.json`), null) : null);
// "2026-11-20" as "Fri 20 Nov".
const dayLabel = (d) =>
  d ? new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${d}T12:00:00Z`)) : null;

// Up to four messages, each picked for what it adds: another person, a follow-up beside the first messages, another
// group of people, another kind of ask (the draft's structure) or title. Two at least, when there are two.
export function pickSample(msgs, max = 4) {
  const left = [...msgs];
  const seen = { person: new Set(), follow: new Set(), segment: new Set(), ask: new Set(), title: new Set() };
  const keys = (m) => ({ person: m.id, follow: m.touch > 1 ? 'follow-up' : 'first', segment: m.segment || '-', ask: m.structure || m.subject || '-', title: m.title || '-' });
  const gain = (m) => {
    const k = keys(m);
    // A new person counts most; a follow-up when none is in yet next; then a new group, ask or title.
    return (seen.person.has(k.person) ? 0 : 8) + (seen.follow.has(k.follow) ? 0 : 4) + (seen.segment.has(k.segment) ? 0 : 2) + (seen.ask.has(k.ask) ? 0 : 1) + (seen.title.has(k.title) ? 0 : 1);
  };
  const out = [];
  while (left.length && out.length < max) {
    let best = 0;
    for (let i = 1; i < left.length; i++) if (gain(left[i]) > gain(left[best])) best = i;
    if (out.length >= 2 && gain(left[best]) < 8) break;
    const [m] = left.splice(best, 1);
    const k = keys(m);
    for (const f of Object.keys(seen)) seen[f].add(k[f]);
    out.push(m);
  }
  return out.sort((a, b) => (a.id === b.id ? a.touch - b.touch : 0));
}

// A body as Markdown that reads as the email: each line break kept, nothing read as a heading or a list.
const mdBody = (body) =>
  String(body || '')
    .split('\n')
    .map((l) => l.replace(/^(\s*)([#>*+-]|\d+[.)])/, '$1\\$2'))
    .map((l, i, a) => (l.trim() && a[i + 1]?.trim() ? `${l}  ` : l))
    .join('\n');

function writeDoc(c, title, people, intro) {
  const at = projectFolder() || c.event.paths.dir;
  mkdirSync(at, { recursive: true });
  const path = join(at, DOC);
  const lines = [`# ${title}`, '', intro, ''];
  for (const p of people) {
    lines.push(`## ${[p.name, p.title, p.company].filter(Boolean).join(', ')}`, '', `To: ${p.to || 'no address'}`, '');
    for (const m of p.messages) {
      lines.push(`### Message ${m.touch}${m.touch === 1 ? ' (first)' : ' (follow-up)'}${m.planned_day ? `, planned for ${dayLabel(m.planned_day)} (${m.planned_day})` : ''}`, '');
      lines.push(`**Subject:** ${m.subject || '(no subject)'}`, '', mdBody(m.body), '');
    }
  }
  writeText(path, `${lines.join('\n').trimEnd()}\n`);
  return path;
}

const byPerson = (msgs) => {
  const m = new Map();
  for (const x of msgs) {
    if (!m.has(x.id)) m.set(x.id, { id: x.id, name: x.name, title: x.title, company: x.company, to: x.to, messages: [] });
    m.get(x.id).messages.push(x);
  }
  for (const p of m.values()) p.messages.sort((a, b) => a.touch - b.touch);
  return [...m.values()];
};

export function review(opts) {
  need(opts, 'event');
  const c = context(opts.event, opts);
  if (!c.event) throw new Error(`No event "${opts.event}".`);
  const e = c.event;
  const contacts = Object.fromEntries((readJson(join(e.paths.derived, 'contacts.json'), []) || []).map((x) => [x.id, x]));
  const who = (id) => ({ name: contacts[id]?.name || e.state.people[id]?.name || id, title: contacts[id]?.title || null, company: contacts[id]?.company || null, segment: e.state.fits[id]?.segment || null });
  const evName = e.event.name || e.event.slug;
  const show = (m) => ({ id: m.id, touch: m.touch, name: m.name, title: m.title, company: m.company, to: m.to, ...(m.planned_day ? { planned_day: m.planned_day, planned: dayLabel(m.planned_day) } : {}), subject: m.subject, body: m.body });

  if (opts.readback) {
    if (process.env.FLOORBOSS_AUTOSEND === 'cloud') throw new Error('The readback is for the laptop, never the cloud run.');
    const r = readback(e.paths.dir, c.now.getTime());
    const msgs = r.items.map((x) => ({ ...x, ...who(x.id), name: x.name || who(x.id).name, structure: draftAt(e.paths.dir, x.hash)?.structure || null }));
    const people = byPerson(msgs);
    const doc = writeDoc(
      c,
      `${evName}: every message auto-send would send (${msgs.length})`,
      people,
      `Read-only: floorboss writes this file again each time, and any change happens in the chat. ${plural(msgs.length, 'message')} to ${plural(people.length, 'person', 'people')}, each on the day shown.`
    );
    return {
      total: msgs.length,
      people: people.length,
      digest: r.digest,
      sample: pickSample(msgs).map(show),
      dates: people.map((p) => ({ id: p.id, name: p.name, to: p.to, days: p.messages.map((m) => `${dayLabel(m.planned_day)} (message ${m.touch})`) })),
      refused: r.refused,
      document: doc,
      approval_line: `Type "auto-send these sequences" to have all ${plural(msgs.length, 'message')} to ${plural(people.length, 'person', 'people')} sent on these days: the ${pickSample(msgs).length} above and the rest in ${basename(doc)}.`,
      show: `Show every message in sample whole (subject and body), then one line per person from dates, then approval_line, and offer document to read (it's ${doc}). The digest is what approve takes: never show it.`
    };
  }

  need(opts, 'ids');
  const ids = String(opts.ids)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const msgs = [];
  for (const k of ids) {
    const [id, t] = k.split(':');
    const touch = Number(t || 1);
    const x = e.state.people[id]?.touches?.[touch];
    const d = x?.hash ? draftAt(e.paths.dir, x.hash) : null;
    if (!d) continue;
    msgs.push({ id, touch, ...who(id), to: d.to || x.approved?.to || null, subject: d.subject || '', body: d.body || '', structure: d.structure || null, channel: d.channel || 'email' });
  }
  if (!msgs.length) throw new Error('None of those messages has a draft to review.');
  const people = byPerson(msgs);
  const sample = pickSample(msgs);
  const doc = writeDoc(
    c,
    `${evName}: every message waiting for your yes (${msgs.length})`,
    people,
    `Read-only: floorboss writes this file again each time, and any change happens in the chat. ${plural(msgs.length, 'message')} to ${plural(people.length, 'person', 'people')}.`
  );
  return {
    total: msgs.length,
    people: people.length,
    sample: sample.map(show),
    document: doc,
    approval_line: `Approve all ${plural(msgs.length, 'message')} (the ${sample.length} above and every one in ${basename(doc)}), all except some, by name, edit or drop?`,
    show: `Show every message in sample whole (subject and body). Then ask, plainly, for candid feedback on them overall or a rewrite of any line, and offer document to read every message (it's ${doc}). Then approval_line.`
  };
}

// Approved email messages not sent yet whose person now has another address (a list given again): each goes back
// through floorboss's redraft path (revise) with the new address, so it is checked, read by the critic and approved once
// more, to that address. Hand-send only (the flow's own step names them).
export function readdressed(e) {
  const out = [];
  for (const [id, p] of Object.entries(e.state.people || {})) {
    if (!p.email) continue;
    for (const [t, x] of Object.entries(p.touches || {})) {
      if (!x.approved || x.sent || x.revising || !x.hash) continue;
      const d = draftAt(e.paths.dir, x.hash);
      if (!d?.to || String(d.channel || 'email') !== 'email') continue;
      if (String(d.to).toLowerCase() !== String(p.email).toLowerCase()) out.push({ id, touch: Number(t), from: d.to, to: p.email });
    }
  }
  return out;
}
export function readdress(opts) {
  need(opts, 'event');
  const c = context(opts.event, opts);
  if (!c.event) throw new Error(`No event "${opts.event}".`);
  const todo = readdressed(c.event);
  if (!todo.length) return { readdressed: [] };
  const dir = join(c.home, 'work');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'readdress.txt');
  writeText(f, 'The list now has a new email address for this person. Keep the message as it was unless the new address calls for a change; it goes to the new address.');
  const r = spawnSync(process.execPath, [script('event-outreach'), 'revise', '--event', opts.event, '--ids', todo.map((x) => `${x.id}:${x.touch}`).join(','), '--feedback-file', f], { encoding: 'utf8', env: process.env });
  if (r.status !== 0) throw new Error(String(r.stderr || r.stdout).trim().slice(0, 400));
  return { readdressed: todo.map((x) => `${x.id}:${x.touch} ${x.from} -> ${x.to}`) };
}
