// What is offered for approval when a draft failed the critic twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, cli, triage, todoJobs } from './fixtures/harness.mjs';

test('a draft that failed the critic twice is held for the user, not offered with the ones ready for a yes', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,COO,Globex,bo@globex.test\n' });
  triage(H);
  const { t, jobs } = todoJobs(H);
  const save = (j) => cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', '1', '--json', JSON.stringify({ subject: 'Test Expo', body: `Hi ${j.contact.name.split(' ')[0]}, we're both at Test Expo. Could you do ${j.slot_labels.map((l) => l.replace(/^(\w{3}) (\d+) \w{3}, (\d\d:\d\d).*/, (m, w, d, t) => `${w} ${d}th at ${t}`)).join(' or ')}?\n\nBest, Sam\n\n${t.optout_sentence}`, brief: 'x, no research profile' })]);
  const verdict = (j, text) => cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--touch', '1', '--text', text]);
  const [bad, good] = jobs;
  save(bad); verdict(bad, 'FAIL: could go to anyone'); save(bad); verdict(bad, 'FAIL: still could go to anyone');
  save(good); verdict(good, 'PASS');
  const t2 = todoJobs(H);
  assert.ok(t2.jobs.find((j) => j.id === bad.id).critic_held);
  const review = cli(H, 'event-outreach', ['render', '--event', H.slug, '--review']);
  assert.equal(review.cards, 1, 'only the passed draft is on the review page');
  assert.ok(!readFileSync(review.outbox, 'utf8').includes(bad.contact.name));
  const g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all']);
  assert.equal(g.approved, 1);
  assert.deepEqual(g.held_for_you.map((x) => x.id), [bad.id]);
  // Run 6, round 5: a failed draft approved by name is read back first, saying it didn't pass, and saved on yes.
  const named = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', `approve ${bad.id}`]);
  assert.match(named.say_to_user || '', /whose draft did not pass the checks/);
  assert.equal(cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'yes']).approved, 1, 'the user can still approve it by ID');
});
