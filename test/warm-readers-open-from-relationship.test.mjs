// A reader who knows the sender (warm, a note from the user, CRM history) opens from the relationship, so the
// rotation never gives them question-first, and insight-first only when an insight fits them: they get peer-note
// or the plain form, and structure_how says to open from the relationship. A question-first label on a warm
// reader's draft isn't held to opening with a question. The simulated tester's Oliver Grant and Kate Lindqvist got
// question-first, and the critic failed the proof pitch the cap pushed them to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cli, idOf } from './fixtures/harness.mjs';
import { ftu6 } from './fixtures/ftu6.mjs';
import { assignStructures, structureProblems, warmReader } from '../skills/event-outreach/scripts/structures.mjs';

const job = (id, x = {}) => ({ id, touch: 1, kind: 'message', contact: { title: 'Head of Partnerships', company: `Co ${id}` }, company_key: `co-${id}`, ...x });

test('warm readers never get question-first; with one insight used up they get peer-note', () => {
  const jobs = [
    job('c001', { insight_options: ['I1'] }), job('c002'), job('c003'),
    job('c015', { group: 'warm', user_note: 'Lena introduced us at Tillcon Europe in June', insight_options: ['I1'] }),
    job('c008', { group: 'warm', user_note: 'we met at Tillcon in March', crm_summary: { status: 'Prospect' }, insight_options: ['I1'] }),
  ];
  const out = assignStructures(jobs, {}, null, { proofs: 1, insightRoom: { 1: { I1: 1 } } });
  for (const id of ['c015', 'c008']) {
    assert.notEqual(out[`${id}:1`], 'question-first', `${id}: ${JSON.stringify(out)}`);
    assert.ok(['peer-note', 'plain-request', 'insight-first'].includes(out[`${id}:1`]));
  }
  // Only one draft may lead with I1: the warm readers who don't get it get peer-note (or plain), never a question.
  assert.ok(Object.values(out).filter((s) => s === 'insight-first').length <= 1);
  // The user's "open with a question" rule leaves question-first and peer-note: a warm reader gets peer-note.
  const q = assignStructures(jobs, {}, null, { proofs: 1, only: ['question-first', 'peer-note'], insightRoom: { 1: { I1: 1 } } });
  assert.equal(q['c015:1'], 'peer-note');
  assert.equal(q['c008:1'], 'peer-note');
  assert.equal(q['c002:1'], 'question-first', 'a cold reader still follows the rule');
});

test('who counts as warm: the group, a user note, CRM history, known_by_user', () => {
  assert.equal(warmReader(job('c1')), false);
  assert.equal(warmReader(job('c1', { group: 'warm' })), true);
  assert.equal(warmReader(job('c1', { user_note: 'met at LogiFair' })), true);
  assert.equal(warmReader(job('c1', { crm_summary: { status: null, last_contact: '2026-05-01' } })), true);
  assert.equal(warmReader(job('c1', { known_by_user: true })), true);
});

test('a question-first label on a warm reader\'s draft isn\'t held to a question opening', () => {
  const draft = { body: 'Hi Kate,\n\nSince Tillcon in March I have thought about your refunds work. Could we take 20 minutes on Tue 10 Nov?' };
  assert.deepEqual(structureProblems(draft, { structure: 'question-first', warm: true }), []);
  assert.deepEqual(structureProblems(draft, { structure: 'question-first' }), ['a question-first draft opens with a question']);
});

test('the simulated tester\'s Oliver and Kate: not question-first, and told to open from the relationship', () => {
  const H = ftu6();
  const kate = idOf(H, 'Kate Lindqvist'), oliver = idOf(H, 'Oliver Grant');
  const d = cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `${kate} same-person crm:5 warm because we met at Tillcon in March`]);
  assert.ok(!d.ERROR, d.ERROR);
  const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'warm Oliver Grant because Lena introduced us at Tillcon Europe in June']);
  assert.ok(!g.ERROR, g.ERROR);
  const t = cli(H, 'event-outreach', ['todo', '--event', H.slug]);
  assert.ok(!t.ERROR, t.ERROR);
  const jobs = JSON.parse(readFileSync(t.todo_file, 'utf8')).jobs;
  for (const id of [kate, oliver]) {
    const j = jobs.find((x) => x.id === id && x.kind === 'message');
    assert.ok(j, `${id} has a job`);
    assert.notEqual(j.structure, 'question-first', `${j.contact.name}: ${j.structure}`);
    if (j.structure !== 'insight-first') assert.match(j.structure_how, /Open from the relationship/);
  }
});
