// Free time read into days, plain-words time zones, profile files written from answers, and the draft checks
// around event names, customer proof and sender claims.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, atListSource } from './fixtures/harness.mjs';
import { cli as simCli } from './sims/lib/driver.mjs';
import { zoneFrom } from '../lib/tz.mjs';
import { segmentsMd, bringMd, addNeverSay } from '../skills/flow/scripts/profile-write.mjs';
import { parseSegments } from '../skills/event-context/scripts/context-check.mjs';

test('free time: days read from the user\'s words are built as given, with exceptions and notes; a day off the event is refused', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const f = join(H.dir, 'days.json');
  writeFileSync(f, JSON.stringify({ days: [{ date: '2026-11-11', from: '09:00', to: '17:00', except: [{ from: '12:00', to: '13:00' }] }, { date: '2026-11-12', from: '09:00', to: '12:00' }], notes: ['booth shifts not known yet'] }));
  const r = cli(H, 'slot-finder', ['build', '--event', H.slug, '--days-file', f]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.deepEqual(r.notes, ['booth shifts not known yet']);
  const slots = JSON.parse(readFileSync(join(H.dir, 'slots.json'), 'utf8')).slots;
  assert.ok(slots.length > 0 && !slots.some((s) => s.start.startsWith('2026-11-10')), 'Tuesday was left out');
  assert.ok(!slots.some((s) => s.start === '2026-11-11T11:00:00Z'), 'the lunch hour (12:00 Amsterdam) is out');
  writeFileSync(f, JSON.stringify({ days: [{ date: '2026-11-20', from: '09:00', to: '17:00' }] }));
  assert.match(cli(H, 'slot-finder', ['build', '--event', H.slug, '--days-file', f]).ERROR || '', /isn't one of the event's days/);
});

test('time zones: a city in plain words is read as its zone', () => {
  assert.equal(zoneFrom('Berlin'), 'Europe/Berlin');
  assert.equal(zoneFrom('New York'), 'America/New_York');
  assert.equal(zoneFrom('San Francisco'), 'America/Los_Angeles');
  assert.equal(zoneFrom('Helsinki time'), 'Europe/Helsinki');
  assert.equal(zoneFrom('somewhere on Mars'), null);
});

test('profile files: groups and the offer are written from the answer, never left as the template', () => {
  const md = segmentsMd('meet heads of loyalty', [{ name: 'Loyalty leads', who: 'Head of Loyalty at retailers with 20-500 stores', how: 'warm, plain' }]);
  assert.equal(parseSegments(md).length, 1);
  assert.match(md, /## Segment: loyalty-leads/);
  assert.throws(() => segmentsMd('x', [{ name: '<name>', who: '<roles>' }]), /placeholder/);
  const b = bringMd({ one_sentence: 'Northloop runs loyalty journeys for mid-size retailers', proof: [{ claim: 'Brightside Grocers lifted repeat purchase 14% in 6 months', source: 'Brightside', segments: ['loyalty-leads'], named: true }], never_say: ['AI-powered'] });
  assert.match(b, /\*\*Never say:\*\* AI-powered/);
  assert.match(addNeverSay(b, ['pricing']), /\*\*Never say:\*\* AI-powered; pricing/);
});

import { checkDraft } from '../skills/event-outreach/scripts/checks.mjs';
test('checks: a customer\'s own result quoted back to them, and patterns claimed for the sender\'s customers, are refused', () => {
  const ownFacts = '| claim | source | segments | named | date |\n|---|---|---|---|---|\n| Brightside Grocers lifted repeat purchase 14% in 6 months | Brightside | loyalty | yes | 2026-05 |\n';
  const ctx = { contact: { name: 'Ana Berg', company: 'Brightside Grocers' }, ownFacts, slotLabels: [], eventName: 'Retail Expo' };
  const p = checkDraft({ channel: 'email', subject: 'Repeat purchase', body: 'Hi Ana, Brightside Grocers lifted repeat purchase 14% with us. Could we meet at Retail Expo?' }, ctx);
  assert.ok(p.some((x) => /quotes Brightside Grocers's own result/.test(x)), p.join('; '));
  const q = checkDraft({ channel: 'email', subject: 'Loyalty', body: 'Hi Ana, in our work with retailers the loyalty tier is where churn hides. Could we meet at Retail Expo?' }, { ...ctx, contact: { name: 'Ana Berg', company: 'Other Co' } });
  assert.ok(q.some((x) => /in our work with/.test(x)), q.join('; '));
});

import { parseDecisionLines, matchGroups } from '../skills/crm-triage/scripts/decisions.mjs';
test('check-these: "all of Raj\'s: hold" answers everyone that coworker holds in one line', () => {
  const g = parseDecisionLines("all of Raj's: hold because his accounts\neveryone else: reach");
  const people = [{ id: 'c001', title: 'COO', holder: 'Raj Mehta' }, { id: 'c002', title: 'VP', holder: 'Di Park' }, { id: 'c003', title: 'CTO', holder: 'Raj Mehta' }];
  const m = matchGroups(g, people);
  assert.deepEqual(m[0].ids, ['c001', 'c003']);
  assert.equal(m[0].group, 'colleague');
  assert.deepEqual(m[1].ids, ['c002']);
  assert.equal(parseDecisionLines('c004 hold')[0].group, 'colleague');
});

test('checks: "RLX" names "RLX 2027: Retail Leaders Expo"', () => {
  const p = checkDraft({ channel: 'email', subject: 'x', body: 'Hi Ana, could we meet at RLX?' }, { contact: { name: 'Ana Berg', company: 'X' }, eventName: "RLX 2027: Retail Leaders Expo", slotLabels: [] });
  assert.ok(!p.some((x) => /doesn't name the event/.test(x)), p.join('; '));
});

import { assignSlots } from '../skills/slot-finder/scripts/assign.mjs';
test('times: eight people over four days get times on every day and at different hours, not Mon and Tue 30 minutes apart', () => {
  const days = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'];
  const slots = days.flatMap((day) => Array.from({ length: 18 }, (_, k) => { const h = 9 + Math.floor(k / 2), m = (k % 2) * 30; const start = `${day}T${String(h).padStart(2, '0')}:${m ? '30' : '00'}:00Z`; return { id: `s${day}${k}`, day, start, end: start }; }));
  const ranked = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}` }));
  const { assignments } = assignSlots(ranked, slots, {});
  const used = Object.values(assignments).flat().map((id) => slots.find((s) => s.id === id));
  assert.equal(new Set(used.map((s) => s.day)).size, 4, JSON.stringify(used.map((s) => s.start)));
  assert.ok(new Set(used.map((s) => s.start.slice(11, 13))).size >= 6, JSON.stringify(used.map((s) => s.start)));
});

test('checks: no false alarms from the customer-proof and sender-claim checks; distinctive proof numbers only', () => {
  const ownFacts = '**Proof library**\n\n| claim | source | segments | named | date |\n|---|---|---|---|---|\n| Helped Northwind lift new store teams 40% faster | Northwind | ops | yes | 2026-01 |\n| Brightside Grocers lifted repeat purchase 14% in 6 months | Brightside | loyalty | yes | 2026-05 |\n\n**Never say:** x\n';
  const base = { slotLabels: [], eventName: 'RLX', ownFacts };
  const p1 = checkDraft({ channel: 'email', subject: 'x', body: 'Hi Ana, saw Lift is at RLX. Could we meet at RLX?' }, { ...base, contact: { name: 'Ana Berg', company: 'Lift' } });
  assert.ok(!p1.some((x) => /quotes/.test(x)), p1.join('; '));
  const p2 = checkDraft({ channel: 'email', subject: 'x', body: 'Hi Ana, Brightside Grocers already runs our loyalty journeys. Could we meet at RLX?' }, { ...base, contact: { name: 'Ana Berg', company: 'Brightside Grocers' } });
  assert.ok(!p2.some((x) => /quotes/.test(x)), 'saying they work with you is fine');
  const p3 = checkDraft({ channel: 'email', subject: 'x', body: "Hi Ana, I'm trying to work out a time that suits you at RLX. We have found two slots that might work." }, { ...base, contact: { name: 'Ana Berg', company: 'Other' } });
  assert.ok(!p3.some((x) => /says something about you/.test(x)), p3.join('; '));
});

import { planQuestions, defaultsFor } from '../skills/event-context/scripts/onboarding-tree.mjs';
import { summarize } from '../skills/event-context/scripts/scan.mjs';
test('review: quick setup with nothing connected reaches the event question (it stalled re-saving an event answer)', () => {
  const s = { inv: summarize([]), cfg: {}, ev: null, ans: { setup_level: 'quick' }, slots: 0, list: null };
  for (let i = 0; i < 5; i++) { const d = defaultsFor(s); if (!d) break; Object.assign(s.cfg, d.config); Object.assign(s.ans, d.answers); }
  assert.equal(defaultsFor(s), null, 'defaults settle');
  assert.equal(planQuestions(s, { batch: 1 }).questions[0].id, 'event');
});

test('review: a claim about the sender next to a time word is still flagged; a scheduling line isn\'t', () => {
  const ctx = { contact: { name: 'Ana Berg', company: 'X' }, slotLabels: [], eventName: 'RLX', ownFacts: '' };
  const bad = checkDraft({ channel: 'email', subject: 'x', body: 'Hi Ana, in our work with retailers the loyalty tier is where churn hides most of the time. Could we meet at RLX?' }, ctx);
  assert.ok(bad.some((x) => /says something about you/.test(x)), bad.join('; '));
  const ok = checkDraft({ channel: 'email', subject: 'x', body: "Hi Ana, I'm trying to work out a time at RLX that suits you." }, ctx);
  assert.ok(!ok.some((x) => /says something about you/.test(x)), ok.join('; '));
});

import { check as guardCheck } from '../hooks/guard.mjs';
import { screenTool } from '../skills/connectors/scripts/tasks.mjs';
const PEOPLE = [{ id: 'c001', name: 'Ana Berg', company: 'Acme' }, { id: 'c002', name: 'Bo Li', company: 'Globex' }, { id: 'c003', name: 'Cy Park', company: 'Initech' }];
test('people-data lookups: only inside a window the user opened, never more than agreed; bulk tools never mapped', () => {
  const config = { connectors: { 'enrich.person': { server: 'apollo', tool: 'people_match', args: { name: '{name}', organization_name: '{company}' } } } };
  const call = { tool_name: 'mcp__apollo__people_match', tool_input: { name: 'Ana Berg', organization_name: 'Acme' } };
  const until = new Date(Date.now() + 600e3).toISOString();
  assert.match(guardCheck(call, { config, enrichWindow: null }) || '', /haven't agreed/);
  assert.equal(guardCheck(call, { config, enrichWindow: { people: PEOPLE, ids: ['c001', 'c002'], count: 2, used: 1, until } }), null);
  assert.match(guardCheck(call, { config, enrichWindow: { people: PEOPLE, ids: ['c001', 'c002'], count: 2, used: 2, until } }) || '', /used up/);
  assert.match(guardCheck({ ...call, tool_input: { name: 'x', email: 'y' } }, { config, enrichWindow: { count: 2, used: 0, until } }) || '', /isn't in floorboss's enrich.person recipe/);
  assert.equal(screenTool('enrich.person', 'apollo_people_match').ok, true);
  assert.equal(screenTool('enrich.person', 'bulk_people_enrichment').ok, false);
});

test('people-data lookups are never paid for twice: CRM and earlier events fill for free; not-found isn\'t retried', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\nBo Li,COO,Globex,\nCy Ng,COO,Initech,\nDi Ho,COO,Hooli,\n' });
  const old = join(H.HOME, 'events', 'old-expo');
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, 'event.json'), JSON.stringify({ slug: 'old-expo', name: 'Old Expo', start_date: '2026-01-10', end_date: '2026-01-11', time_zone: 'UTC' }));
  writeFileSync(join(old, 'enriched.json'), JSON.stringify({ 'ana berg|acme': { key: 'ana berg|acme', id: 'c001', email: 'ana@acme.test', source: 'apollo' }, 'bo li|globex': { key: 'bo li|globex', id: 'c002', not_found_at: '2026-10-05T10:00:00Z', source: 'apollo' } }));
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const r = cli(H, 'crm-triage', ['enrich-list', '--event', H.slug, '--ids', 'c001,c002,c003,c004']);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.filled_from_earlier_events, 1, JSON.stringify(r));
  assert.equal(r.not_found_before, 1);
  assert.equal(r.to_enrich, 2, 'only Cy and Di are looked up');
});

test('list source: a speaker-page link given as the list source is kept for reading the page', () => {
  // Asked at its moment in onboarding: the answer is saved only then.
  const H = atListSource();
  const f = join(H.dir, 'ls.json');
  writeFileSync(f, JSON.stringify('the speakers are at https://example.test/speakers.'));
  const r = simCli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'list_source', '--value-file', f]);
  assert.ok(!r.ERROR, r.ERROR);
  const st = JSON.parse(readFileSync(join(H.HOME, 'onboarding.json'), 'utf8'));
  assert.equal(st.events[H.slug].answers.list_source, 'app');
  assert.equal(st.events[H.slug].answers.list_url, 'https://example.test/speakers');
});

test('checks: "Growth Forum" names "Growth Forum Chicago"; "Pell Bros." doesn\'t end a sentence', async () => {
  const p = checkDraft({ channel: 'email', subject: 'x', body: 'Hi Ana, could we meet at Growth Forum?' }, { contact: { name: 'Ana Berg', company: 'X' }, eventName: 'Growth Forum Chicago', eventCity: 'Chicago', slotLabels: [] });
  assert.ok(!p.some((x) => /doesn't name the event/.test(x)), p.join('; '));
  const { structureProblems } = await import('../skills/event-outreach/scripts/structures.mjs');
  assert.ok(!structureProblems({ body: 'Hi Ana, what did Pell Bros. learn from the switch to ad tiers?' }, { structure: 'question-first', factSource: 'list' }).some((x) => /opens with a question/.test(x)));
});
