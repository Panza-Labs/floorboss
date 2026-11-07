// The small things from the fourth first-time-user review: a JSON file given as a shortlist answer is named
// for what it is, critic reasons keep their brackets together, a colleague's insight is refused, Dutch and
// other European cities are known (and an unknown one gets a zone near the event), a setting answer shows
// what was saved, "reach anyway" names the coworker's account and company, and the README says which comes
// first and how long the run lock holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, setup, cli, triage, todoJobs, idOf } from './fixtures/harness.mjs';
import { parseVerdict } from '../skills/event-outreach/scripts/critic-input.mjs';
import { relativeWordsIn } from '../skills/event-outreach/scripts/leadtime.mjs';
import { zoneFrom } from '../lib/tz.mjs';
import { buildBrief } from '../skills/event-outreach/scripts/drafter.mjs';

const answer = (H, ask, value) => { mkdirSync(join(H.HOME, 'work'), { recursive: true }); const f = join(H.HOME, 'work', `${ask}.txt`); writeFileSync(f, typeof value === 'string' ? value : JSON.stringify(value)); return cli(H, 'flow', ['answer', '--event', H.slug, '--ask', ask, '--value-file', f]); };

test('a free-time file given as the shortlist answer: said for what it is, not "undefined"', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  triage(H);
  const r = answer(H, 'gate', { days: [{ date: '2026-11-10', from: '09:00', to: '12:00' }] });
  assert.match(r.ERROR, /That looks like a free-time file, not a shortlist answer/);
  assert.doesNotMatch(r.ERROR, /undefined/);
});

test('critic reasons split at ";" only outside brackets and quotes', () => {
  assert.deepEqual(parseVerdict('FAIL: names a number (98%; Q2 2026) the library lacks; no opt-out').reasons, ['names a number (98%; Q2 2026) the library lacks', 'no opt-out']);
  assert.deepEqual(parseVerdict('FAIL: quotes "close faster; cut costs" back at them; too long').reasons, ['quotes "close faster; cut costs" back at them', 'too long']);
});

// Round 6 narrowed this: "today" meaning "these days" passes (today-as-currently.test.mjs); next to a meeting
// ask it is still named. Round 7: only in a sentence of more than eight words with no ask in it ("how your
// close runs today" alone reads as the day).
test('"today" next to a meeting ask is still a relative word, and the check names it', () => {
  assert.deepEqual(relativeWordsIn('I keep wondering how your month-end close runs today, from ledger to report.'), []);
  assert.deepEqual(relativeWordsIn('how your close runs today'), ['today']);
  assert.deepEqual(relativeWordsIn('Could we go over how your close runs today?'), ['today']);
});

test('an insight a colleague at the same company already got is refused', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nFay Wu,VP Ops,Acme,fay@acme.test\n' });
  triage(H);
  const { t, jobs, insights } = todoJobs(H);
  const [a, b] = jobs.filter((j) => j.kind === 'message');
  const ins = insights.find((x) => a.insight_options.includes(x.id) && b.insight_options.includes(x.id));
  assert.ok(ins, JSON.stringify(insights).slice(0, 200));
  const body = (j) => `Hi ${j.contact.name.split(' ')[0]}, ${ins.insight} Could you do ${j.slot_labels.join(' or ')} at Test Expo?\n\nBest, Sam\n\n${t.optout_sentence}`;
  cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', a.id, '--touch', '1', '--json', JSON.stringify({ subject: 'Test Expo', body: body(a), brief: 'x', structure: 'insight-first', insight: ins.id, fact_source: 'list' })]);
  // Ana's message is approved (out of this run): the drafting list worked out again has Fay avoid her insight.
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', a.id, '--touch', '1', '--text', 'PASS']);
  assert.ok(!cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', `approve ${a.id}`]).ERROR);
  const again = todoJobs(H).jobs.find((j) => j.id === b.id && j.kind === 'message');
  assert.ok(again.avoid_insights.includes(ins.id), JSON.stringify(again.avoid_insights));
  const r = cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', b.id, '--touch', '1', '--json', JSON.stringify({ subject: 'Test Expo', body: body(b), brief: 'x', structure: 'insight-first', insight: ins.id, fact_source: 'list' })]);
  assert.ok(r.checks.some((x) => new RegExp(`insight ${ins.id} is one this person's colleagues already got`).test(x)), JSON.stringify(r.checks));
});

test('Dutch, Belgian, German, French, Spanish, Portuguese and UK cities are known; an unknown one gets a zone near the event', () => {
  for (const [city, zone] of Object.entries({ Haarlem: 'Europe/Amsterdam', Utrecht: 'Europe/Amsterdam', 'The Hague': 'Europe/Amsterdam', Ghent: 'Europe/Brussels', Düsseldorf: 'Europe/Berlin', Stuttgart: 'Europe/Berlin', Marseille: 'Europe/Paris', Seville: 'Europe/Madrid', Braga: 'Europe/Lisbon', Birmingham: 'Europe/London', Glasgow: 'Europe/London' })) assert.equal(zoneFrom(city), zone, city);
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  assert.match(answer(H, 'home_tz', 'Zandvoortje').ERROR, /a time zone like Europe\/Amsterdam/);
});

test('a setting answer shows what was saved, not the whole config', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const r = answer(H, 'home_tz', 'Haarlem');
  assert.ok(!r.ERROR, r.ERROR);
  assert.deepEqual(r.result, { saved_settings: { home_tz: 'Europe/Amsterdam' }, home_zone: 'Haarlem → Europe/Amsterdam' }, 'the zone the city was read as, said back');
});

test('"reach <name> anyway" for someone a coworker holds: the account note names the coworker and the company, and the brief carries it', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nHannah Wolfe,Director of Finance Operations,Bramble Card,hannah.wolfe@bramblecard.example\n', crm: 'Name,Email,Company,Owner,Status,Opted Out\nHannah Wolfe,hannah.wolfe@bramblecard.example,Bramble Card,Ben Hartley,Opportunity,no\n', settings: { crm_accounts: 'apply', coworker_contacts: 'leave' } });
  triage(H);
  const id = idOf(H, 'Hannah Wolfe');
  assert.ok(!cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'reach Hannah Wolfe anyway']).ERROR);
  const j = todoJobs(H).jobs.find((x) => x.id === id && x.kind === 'message');
  assert.equal(j.account_note, "at Ben Hartley's account Bramble Card (Opportunity)", 'with what their record there says');
  const ev = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  assert.match(buildBrief(j, { event: ev, settings: ev.settings, files: {} }), /at Ben Hartley's account Bramble Card/);
});

test('README: which event comes first, then the reuse question; the run lock lapses for other sessions after 30 minutes', () => {
  const md = readFileSync(join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(md, /Each run first asks which event it's for \(one already here, or a new one\).*A new event then asks one question, "same setup as last time\?"/);
  assert.match(md, /for any other session it lapses 30 minutes after floorboss last ran a script/);
});
