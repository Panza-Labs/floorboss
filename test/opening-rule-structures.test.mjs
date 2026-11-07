// A voice rule about how messages open ("Ask a real question in the first two lines") is kept as the voice
// file's Opening and the structures follow it: the batch gets only structures that meet the rule, the batch
// check doesn't cap them, and the critic is told the structure was chosen for the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setup, cli, triage, todoJobs, ROOT, NOW } from './fixtures/harness.mjs';
import { openingRule, openingOf, assignStructures, structureSpread } from '../skills/event-outreach/scripts/structures.mjs';

const PEOPLE = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Ng,Head of Ops,Initech,cy@initech.test\nDee Ho,COO,Hooli,dee@hooli.test\nEd Fox,COO,Umbrella,ed@umbrella.test\nFay Wu,VP Ops,Acme,fay@acme.test\n';
const answer = (H, ask, value) => {
  const f = join(H.dir, `${ask}.json`);
  writeFileSync(f, JSON.stringify(value));
  try { return JSON.parse(execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'answer', '--event', H.slug, '--ask', ask, '--value-file', f], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); } catch (e) { return { ERROR: String(e.stderr || e.message).slice(0, 800) }; }
};

test('opening rules read as a structure preference; greeting and length rules are not about the opening', () => {
  assert.equal(openingRule('Ask a real question in the first two lines'), 'question');
  assert.equal(openingRule('Never open with a question'), 'no-question');
  assert.equal(openingRule('Lead with an observation from our customers'), 'insight');
  assert.equal(openingRule('Say who I am first'), 'plain');
  assert.equal(openingRule('Start with a compliment on their talk'), 'plain', 'an opening rule no structure matches: the plain form');
  for (const r of ['Hi <first name>, always', 'No greeting', 'Keep it under 80 words', 'Start with their first name', 'Never start with I']) assert.equal(openingRule(r), null, r);
  assert.equal(openingOf('- **Opening:** question\n'), 'question');
  assert.equal(openingOf('## Rules from your feedback\n- shorter\n- Ask a real question in the first two lines\n'), 'question');
});

test('assignStructures with a question rule: only question-first, peer-note for a warm reader, uncapped; the spread check takes it', () => {
  const jobs = Array.from({ length: 8 }, (_, k) => ({ id: `c00${k + 1}`, touch: 1, kind: 'message', contact: { title: 'COO', company: `Co${k}` }, company_key: k < 2 ? 'same' : `co${k}`, group: k === 3 ? 'warm' : 'fit', insight_options: ['I1'] }));
  const out = assignStructures(jobs, {}, null, { only: ['question-first', 'peer-note'], proofs: 1 });
  const picks = Object.values(out);
  assert.ok(picks.every((s) => s === 'question-first' || s === 'peer-note'), picks.join());
  assert.ok(picks.filter((s) => s === 'question-first').length > 0.4 * picks.length, 'the rule is not held to the 40% share');
  assert.deepEqual(structureSpread(jobs.map((j) => ({ id: j.id, structure: out[`${j.id}:1`], company_key: j.company_key })), { uncapped: ['question-first', 'peer-note'] }), []);
  assert.ok(structureSpread(jobs.map((j) => ({ id: j.id, structure: out[`${j.id}:1`], company_key: j.company_key }))).length, 'without the rule the same batch fails the spread');
});

test('saved through the samples answer: the voice file gets "Opening: question", todo assigns only compatible structures, and the critic input says why', () => {
  const H = setup({ attendees: PEOPLE });
  const r = answer(H, 'samples', { closest: 'casual and plain', rules: ['Ask a real question in the first two lines', 'under 80 words'] });
  assert.ok(!r.ERROR, r.ERROR);
  assert.match(r.result.opening, /Opening: question/);
  const voice = readFileSync(join(H.HOME, 'context', 'buyers', 'voice', 'SKILL.md'), 'utf8');
  assert.match(voice, /^- \*\*Opening:\*\* question$/m);
  triage(H);
  const { jobs } = todoJobs(H);
  const msgs = jobs.filter((j) => j.kind === 'message');
  assert.ok(msgs.length >= 5, msgs.length);
  for (const j of msgs) {
    assert.ok(['question-first', 'peer-note'].includes(j.structure), `${j.id}: ${j.structure}`);
    assert.match(j.opening_rule, /a question in the first lines/);
  }
  const j = msgs[0];
  cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', '1', '--json', JSON.stringify({ subject: 'Test Expo', body: `Hi ${j.contact.name.split(' ')[0]}, how do you plan dock shifts for Test Expo week? Could you do ${j.slot_labels.join(' or ')}?\n\nBest, Sam`, brief: 'x', structure: 'question-first', fact_source: 'list' })]);
  const inp = cli(H, 'event-outreach', ['critic-input', '--event', H.slug, '--id', j.id, '--touch', '1']);
  assert.match(inp.opening_rule, /question-first/);
});

test('a "never open with a question" rule still keeps question-first out', () => {
  const H = setup({ attendees: PEOPLE });
  assert.ok(!answer(H, 'samples', { rules: ['Never open with a question'] }).ERROR);
  triage(H);
  const { jobs } = todoJobs(H);
  assert.ok(jobs.filter((j) => j.kind === 'message').every((j) => j.structure !== 'question-first'));
});
