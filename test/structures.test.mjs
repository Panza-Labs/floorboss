// Structures rotate across a batch, never repeat for a person or within a company, and the plain form is used
// when floorboss knows nothing about the reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignStructures, structureProblems, structureSpread, factSources } from '../skills/event-outreach/scripts/structures.mjs';

const job = (id, over = {}) => ({ id, touch: 1, kind: 'message', company_key: `co${id}`, contact: { title: 'COO', company: 'Acme' }, insight_options: ['I1'], group: 'cold', ...over });
// A reader with one true thing known beyond their title and company (here, an earlier email), so every
// structure is open to them and the rotation is what's tested.
const known = (id, over = {}) => job(id, { mailbox_note: 'emailed in May', ...over });

test('rotation: neighbours differ, colleagues differ, a person never gets their earlier structure', () => {
  const jobs = ['c001', 'c002', 'c003', 'c004'].map((id) => known(id));
  jobs[3].company_key = jobs[2].company_key;
  const s = assignStructures(jobs);
  assert.notEqual(s['c001:1'], s['c002:1']);
  assert.notEqual(s['c003:1'], s['c004:1'], 'colleagues');
  const f = assignStructures([known('c001', { touch: 2, followup: true })], { c001: ['question-first'] });
  assert.notEqual(f['c001:2'], 'question-first');
});

test('no reader fact means the plain form; the checks hold a draft to its structure', () => {
  const bare = job('c009', { contact: { title: '', company: '' } });
  assert.deepEqual(factSources(bare), ['none']);
  assert.equal(assignStructures([bare])['c009:1'], 'plain-request');
  assert.deepEqual(factSources(job('c1', { crm_summary: { status: 'Negotiation' }, mailbox_note: 'x' })), ['crm', 'mailbox', 'list']);
  assert.match(structureProblems({ body: 'Hi Ana,\n\nWe make dock software. Can we meet?' }, { structure: 'question-first' }).join(), /opens with a question/);
  assert.deepEqual(structureProblems({ body: 'Hi Ana,\n\nHow do your carriers see the queue? …' }, { structure: 'question-first' }), []);
  assert.match(structureProblems({ body: 'x' }, { structure: 'insight-first', factSource: 'none' }).join(), /plain form/);
  assert.match(structureProblems({ body: 'x' }, { structure: 'insight-first', insight: null }).join(), /names the insight/);
});

test('spread: one structure over 40% of a batch, or two colleagues with the same one, is flagged', () => {
  const ds = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, structure: i < 3 ? 'question-first' : 'peer-note', company_key: id }));
  assert.match(structureSpread(ds).join(), /3 of 5 drafts use the question-first/);
  assert.match(structureSpread([{ id: 'a', structure: 'peer-note', company_key: 'x' }, { id: 'b', structure: 'peer-note', company_key: 'x' }]).join(), /same company/);
});

test('redrafts never wear the colleague rule down; a drafted touch keeps its structure', () => {
  const jobs = ['c001', 'c002', 'c003'].map((id) => known(id, { company_key: 'same' }));
  // Each has been drafted many times under every structure for touch 1: that is not "used".
  const earlier = { c001: { 1: 'question-first' }, c002: { 1: 'question-first' }, c003: { 1: 'question-first' } };
  const s = assignStructures(jobs, earlier);
  assert.equal(new Set(Object.values(s)).size, 3, JSON.stringify(s));
  assert.equal(s['c001:1'], 'question-first', 'the first keeps what it was drafted with');
  // A follow-up never repeats the person's own first message.
  const f = assignStructures([known('c001', { touch: 2 })], { c001: { 1: 'insight-first', 2: 'insight-first' } });
  assert.notEqual(f['c001:2'], 'insight-first');
});

test('no reader fact beyond the list: question-first is never assigned (the checks would refuse it)', () => {
  // Only a title and a company (quick setup: no research, no CRM, no mailbox): question-first is not offered.
  const listOnly = ['c001', 'c002', 'c003', 'c004', 'c005', 'c006'].map((id) => job(id));
  assert.deepEqual(factSources(listOnly[0]), ['list']);
  const picks = Object.values(assignStructures(listOnly));
  assert.ok(!picks.includes('question-first'), JSON.stringify(picks));
  // With one true thing about the reader, it comes back into the rotation.
  assert.ok(Object.values(assignStructures(['c001', 'c002', 'c003', 'c004', 'c005', 'c006'].map((id) => known(id)))).includes('question-first'));
});
