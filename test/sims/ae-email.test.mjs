// The AE persona: Marcus Bell at Tallyline, a 300-row badge-scan export, a 40-record Salesforce CSV, three
// colleagues at the event, email sending on. Driven through `flow next` from an empty home to the first sends,
// then a week later through the follow-ups. The assertions go person by person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, drive, cli, ROOT } from './lib/driver.mjs';
import { persona, P, RECIPE } from './personas/ae-email/persona.mjs';
import { readLedger, fold } from '../../lib/ledger.mjs';

test('AE persona: who is who, the shortlist, first sends with the prompt, follow-ups in the thread', { timeout: 900000 }, () => {
  const H = makeHome({ now: '2026-10-10T12:00:00Z', context: { from: join(P, 'context'), name: 'fincrime' } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ shared_domains: ['gmail.test', 'outlook.test'], connectors: { 'email.send': RECIPE } }));
  const per = persona(H);
  const run1 = drive(H, per, { maxSteps: 800 });
  const slug = run1.slug;
  assert.equal(slug, 'midway-risk-summit-2027');
  const ev = join(H.HOME, 'events', slug);
  const res = JSON.parse(readFileSync(join(ev, 'derived', 'resolved.json'), 'utf8'));
  const people = JSON.parse(readFileSync(join(ev, 'derived', 'contacts.json'), 'utf8'));
  const g = (name) => { const p = people.find((x) => x.name === name); assert.ok(p, `${name} is on the list`); return res[p.id]; };

  // Duplicates merged: the five double scans, and Priya Sullivan's second scan with no email.
  for (const n of ['Hector Yamamoto', 'Sunil Rodriguez', 'Fatima Williams', 'Hannah Brooks', 'Christina Kaur', 'Priya Sullivan']) assert.equal(people.filter((x) => x.name === n).length, 1, `${n} is one person`);
  // Never contacted: own company, opted out, the opted-out match confirmed.
  for (const n of ['Priya Raman', 'Dan Whitfield', 'Kelsey Ortiz', 'Tom Adeyemi', 'Robert Nakamura', 'Jessica Tran']) assert.equal(g(n).group, 'skip', `${n}: ${g(n).says}`);
  // A colleague holds them: a note to the colleague, no message to them.
  for (const [n, holder] of [['Gregory Lindqvist', 'Dan Whitfield'], ['Angela Moretti', 'Priya Raman'], ['Nina Castellanos', 'Kelsey Ortiz'], ['Samuel Ortiz', 'Priya Raman']]) assert.deepEqual([g(n).group, g(n).holder], ['colleague', holder], `${n}: ${g(n).says}`);
  // Warm: two-way CRM status, or a customer (the persona said warm notes for customers).
  for (const n of ['Daniel Herrera', 'Priyanka Desai', 'Omar Haddad']) assert.equal(g(n).group, 'warm', `${n}: ${g(n).says}`);
  // Removed at the gate; lost or disqualified isn't warm; a different David Kim is a stranger.
  assert.equal(g('Teresa Wong').group, 'skip');
  assert.notEqual(g('Brandon Lee').group, 'warm', 'a disqualified record with a recent date is not warm');
  assert.equal(g('David Kim').group, 'reach');
  // Competitors, vendors, press, regulators and students: never reached.
  for (const n of ['Brett Calloway', 'Simone Achterberg', 'Hiro Matsuda', 'Carla Benedetti', 'Gwen Albright', 'Zara Haddad']) assert.ok(!['reach', 'warm'].includes(g(n).group), `${n} is not reached: ${g(n).group}`);
  // The shortlist: Merriton capped at 4 with Rachel (must-meet), Daniel and Priyanka in.
  const sl = JSON.parse(readFileSync(join(ev, 'derived', 'shortlist.json'), 'utf8'));
  const inList = (n) => sl.ranked.includes(people.find((x) => x.name === n).id);
  for (const n of ['Rachel Okafor', 'Daniel Herrera', 'Priyanka Desai']) assert.ok(inList(n), `${n} is shortlisted`);
  const merriton = sl.ranked.filter((id) => /merriton/i.test(people.find((x) => x.id === id).company));
  assert.ok(merriton.length <= 4, `Merriton at most 4: ${merriton.length}`);
  assert.ok(sl.ranked.length >= 30 && sl.ranked.length <= 90, `shortlist size ${sl.ranked.length}`);

  // Every first message went through the guard, each with the prompt, each once, to its approved address.
  const st = fold(readLedger(join(ev, 'ledger.jsonl')).entries);
  const calls = per.guardCalls || [];
  assert.ok(calls.length >= 20, `first sends: ${calls.length}`);
  assert.ok(calls.every((x) => x.status === 0 && /"permissionDecision":"ask"/.test(x.stdout)), 'every send asked');
  assert.equal(new Set(calls.map((x) => `${x.item.id}:${x.item.touch}`)).size, calls.length, 'each once');
  for (const x of calls) assert.equal(st.people[x.item.id].touches[x.item.touch].approved.to, x.item.to);
  for (const n of ['Jessica Tran', 'Robert Nakamura', 'Priya Raman', 'Teresa Wong', 'Gregory Lindqvist']) assert.ok(!calls.some((x) => x.item.id === people.find((p) => p.name === n).id), `nothing went to ${n}`);

  // A week later: one person replied; the follow-ups go to everyone else, in the thread of the first message.
  const first = calls[0].item, second = calls[1].item;
  H.replied = people.find((x) => x.id === first.id).name;
  H.now = '2026-10-15T13:00:00Z';
  const before = calls.length;
  drive(H, { ...per, slug }, { maxSteps: 800 });
  const follow = per.guardCalls.slice(before);
  assert.ok(follow.length >= 5, `follow-ups sent: ${follow.length}`);
  assert.ok(follow.every((x) => x.item.touch === 2 && /"permissionDecision":"ask"/.test(x.stdout)), 'only follow-ups, each asked');
  assert.ok(!follow.some((x) => x.item.id === first.id), 'no follow-up to the person who replied');
  const f2 = follow.find((x) => x.item.id === second.id);
  assert.ok(f2, 'the second person got a follow-up');
  assert.equal(f2.item.thread_id, `t-${second.id}`, 'in the thread of the first message');
});
