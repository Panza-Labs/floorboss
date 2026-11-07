// A rewrite carries what it answers to on the job the drafter gets: the critic's reasons on the failed version,
// the user's note on a draft they rated 3 or less, and both when both apply. Planned follow-ups too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, todoJobs } from './fixtures/harness.mjs';

const PEOPLE = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Ng,Head of Ops,Initech,cy@initech.test\n';
const body = (j) => `Hi ${j.contact.name.split(' ')[0]},\n\nShippers re-tendering in Q1 are asking carriers for proof of insurance earlier. Is that showing up in your bids? ${j.slot_labels?.length ? `Could you do ${j.slot_labels.join(' or ')}?` : 'Could we find 30 minutes at Test Expo?'}\n\nBest, Sam`;
function saveAll(H) {
  const { jobs } = todoJobs(H);
  for (const j of jobs.filter((x) => x.kind === 'message')) cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--json', JSON.stringify({ subject: 'Test Expo', body: body(j), brief: 'x', structure: 'question-first', fact_source: 'list' })]);
  return jobs;
}
const jobOf = (H, id, touch = 1) => todoJobs(H).jobs.find((j) => j.id === id && j.touch === touch);

test('redraft: the critic\'s reasons and the rating note reach the job the drafter gets', () => {
  const H = setup({ attendees: PEOPLE });
  triage(H);
  const jobs = saveAll(H);
  const [a, b, c] = jobs.map((j) => j.id);
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', a, '--text', 'FAIL: invents a pilot the sender never ran']);
  for (const id of [b, c]) cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', id, '--text', 'PASS']);
  const failed = jobOf(H, a);
  assert.match(failed.revise_feedback || '', /critic failed the last version: invents a pilot/);
  assert.ok(failed.revise_previous, 'the failed version goes with it');
  // A blind rating of 3 with a note: the note is on the job.
  const set = cli(H, 'event-outreach', ['rate-set', '--event', H.slug]);
  assert.ok(set.drafts >= 2, JSON.stringify(set));
  const key = JSON.parse(readFileSync(join(H.dir, 'derived', 'rate-key.json'), 'utf8'));
  const low = key[0];
  const r = cli(H, 'event-outreach', ['rate', '--event', H.slug, '--text', `${low.n}: 2 sounds like a template, name their lanes`]);
  assert.ok(!r.ERROR, r.ERROR);
  const rated = jobOf(H, low.id, low.touch);
  assert.match(rated.revise_feedback || '', /sounds like a template, name their lanes/);
  assert.ok(rated.revise_previous);
});

test('redraft: a draft the user sent back that then failed the critic carries both', () => {
  const H = setup({ attendees: PEOPLE });
  triage(H);
  const [j] = saveAll(H);
  const fb = join(H.HOME, 'fb.txt');
  writeFileSync(fb, 'shorter, and no question at the start');
  cli(H, 'event-outreach', ['revise', '--event', H.slug, '--ids', j.id, '--feedback-file', fb]);
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--text', 'FAIL: claims a customer the profile does not list']);
  const job = jobOf(H, j.id);
  assert.match(job.revise_feedback, /shorter, and no question at the start/);
  assert.match(job.revise_feedback, /claims a customer the profile does not list/);
});

test('redraft: a planned follow-up that failed the critic carries its reasons too', () => {
  const H = setup({ attendees: PEOPLE, settings: { sending: { channels: ['email'], followups: 'scheduled' } } });
  triage(H);
  for (const j of saveAll(H)) if (j.touch === 1) cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--text', 'PASS']);
  const f = todoJobs(H).jobs.find((j) => j.touch === 2 && j.kind === 'message');
  assert.ok(f, 'a planned follow-up');
  cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', f.id, '--touch', '2', '--json', JSON.stringify({ body: `Hi ${f.contact.name.split(' ')[0]}, following up on my note. Still around at Test Expo?\n\nBest, Sam`, brief: 'x', structure: 'plain-request', fact_source: 'list' })]);
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', f.id, '--touch', '2', '--text', 'FAIL: repeats the first message word for word']);
  assert.match(jobOf(H, f.id, 2)?.revise_feedback || '', /repeats the first message/);
});
