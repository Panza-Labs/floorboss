// The user's reason on check-these ("c019 warm because we met at LogiFair in the spring") is a fact about that
// person: it reaches the drafter's job and the critic's batch as user_note, and a draft that uses it passes
// floorboss's checks with fact source "user". The card keeps its own line ("you said: warm (…)").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, cli, todoJobs, idOf } from './fixtures/harness.mjs';
import { factSources, FACT_SOURCES } from '../skills/event-outreach/scripts/structures.mjs';

const LIST = 'Name,Title,Company,Email\nSofia Lindqvist,Logistics Director,Nordkap Home,sofia@nordkap.example\nPia Holm,Head of Operations,Fjordvik,pia@fjordvik.example\n';

test('factSources: a user note is the "user" source', () => {
  assert.ok(FACT_SOURCES.includes('user'));
  assert.deepEqual(factSources({ contact: { title: 'COO', company: 'Acme' }, user_note: 'we met at LogiFair' }), ['user', 'list']);
});

test('check-these: "warm because we met at LogiFair" is the job\'s user_note and the critic\'s, and a draft quoting it passes the checks', () => {
  const H = setup({ attendees: LIST });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.ok(!load.ERROR, load.ERROR);
  const sofia = idOf(H, 'Sofia Lindqvist'), pia = idOf(H, 'Pia Holm');
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits', JSON.stringify([{ id: sofia, unsure: true, reason: 'logistics director at a home goods retailer', score: 80 }, { id: pia, segment: 'ops-leaders', reason: 'head of operations', score: 70 }])]);
  const b = cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `${sofia} warm because we met at LogiFair in the spring`]);
  assert.ok(!b.ERROR, b.ERROR);
  assert.ok(!cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'ok']).ERROR);
  const { t, jobs } = todoJobs(H);
  const j = jobs.find((x) => x.id === sofia && x.kind === 'message');
  assert.ok(j, JSON.stringify(jobs.map((x) => x.id)));
  assert.match(j.user_note || '', /we met at LogiFair in the spring/);
  assert.match(j.warm_because || '', /you said: warm \(we met at LogiFair in the spring\)/, 'the card keeps its line');
  assert.ok(j.fact_sources.includes('user'), j.fact_sources.join(','));
  const body = `Hi Sofia, since we met at LogiFair in the spring I've wanted to hear how the dock schedule is going at Nordkap. Could you do ${j.slot_labels.join(' or ')} at Test Expo?\n\nBest, Sam\n\n${t.optout_sentence}`;
  const saved = cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', sofia, '--touch', '1', '--json', JSON.stringify({ subject: 'Test Expo', body, brief: 'warm, from LogiFair', structure: 'plain-request', fact_source: 'user' })]);
  assert.equal(saved.checks, 'pass', JSON.stringify(saved));
  const batch = cli(H, 'event-outreach', ['critic-batch', '--event', H.slug, '--ids', `${sofia}:1`, '--compact']);
  assert.ok(!batch.ERROR, batch.ERROR);
  assert.match(batch.drafts[0].input.user_note || '', /we met at LogiFair in the spring/);
  assert.equal(batch.drafts[0].input.declared_fact_source, 'user');
});

test('check-these: a skip with a reason is no note, and a reason said twice is kept once', () => {
  const H = setup({ attendees: LIST });
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const sofia = idOf(H, 'Sofia Lindqvist'), pia = idOf(H, 'Pia Holm');
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits', JSON.stringify([{ id: sofia, unsure: true, reason: 'x', score: 80 }, { id: pia, unsure: true, reason: 'y', score: 70 }])]);
  cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `${sofia} reach because she runs the docks\n${pia} skip because not a buyer`]);
  cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `${sofia} reach because she runs the docks`]);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'ok']);
  const { jobs } = todoJobs(H);
  assert.equal(jobs.find((x) => x.id === sofia).user_note, 'she runs the docks');
  assert.ok(!jobs.some((x) => x.id === pia));
});
