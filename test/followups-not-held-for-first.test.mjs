// With whole sequences, each follow-up is held for its own critic fails, never for the first message's: a first
// message that failed the critic twice holds that message (and so the person's sequence at the approval), but its
// follow-ups that passed are not "failed the critic twice". Before, the follow-up jobs were copied from the first
// message's job, critic_held and its held_for_user line included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, cli, triage, todoJobs } from './fixtures/harness.mjs';

test('a first message held after two critic fails does not mark its passing follow-ups as failed', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', settings: { sending: { channels: ['email'], followups: 'scheduled' }, touches: 3 } });
  triage(H);
  const save = (j, body) => cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--json', JSON.stringify({ subject: 'Test Expo', body, brief: 'x, no research profile' })]);
  const verdict = (j, text) => cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--text', text]);
  const { t, jobs } = todoJobs(H);
  const first = jobs.find((j) => j.kind === 'message' && j.touch === 1);
  const times = (j) => (j.slot_labels || []).map((l) => l.replace(/^(\w{3}) (\d+) \w{3}, (\d\d:\d\d).*/, (m, w, d, tt) => `${w} ${d}th at ${tt}`)).join(' or ');
  const bodyOf = (j, n) => `Hi Ana, we're both at Test Expo${n > 1 ? `, a note after my message about carrier onboarding ${n}` : ''}. Could you do ${times(j)}?\n\nBest, Sam\n\n${t.optout_sentence}`;
  assert.ok(!save(first, bodyOf(first, 1)).ERROR);
  verdict(first, 'PASS');
  // The follow-ups, written once the first message passed, and passing too.
  const fus = todoJobs(H).jobs.filter((j) => j.id === first.id && j.kind === 'message' && j.touch > 1);
  assert.ok(fus.length >= 1, 'follow-ups planned');
  for (const j of fus) {
    const r = save(j, bodyOf(j, j.touch).replace('Hi Ana, we', `Hi Ana, a longer note number ${j.touch} as we`));
    assert.ok(!r.ERROR, r.ERROR);
    verdict(j, 'PASS');
  }
  // The first message fails the critic, and comes back word for word the same: two fails, held for the user.
  verdict(first, 'FAIL: reads like a template');
  save(first, bodyOf(first, 1));
  const after = todoJobs(H).jobs.filter((j) => j.id === first.id && j.kind === 'message');
  assert.equal(after.find((j) => j.touch === 1)?.critic_held, true, 'the first message is held');
  for (const j of after.filter((x) => x.touch > 1)) {
    assert.equal(j.critic_held, undefined, `follow-up ${j.touch - 1} passed the critic: ${JSON.stringify(j.held_for_user)}`);
    assert.doesNotMatch(String(j.held_for_user || ''), /failed the critic/);
  }
  const todo = JSON.parse(readFileSync(todoJobs(H).t.todo_file, 'utf8'));
  assert.ok(!(todo.held_for_user || []).some((x) => x.id === first.id && x.touch > 1), JSON.stringify(todo.held_for_user));
});
