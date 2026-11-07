// The structure rotation and the insight cap agree: insight-first goes to no more drafts than the cap lets each
// insight lead (one insight: at most its cap, whatever the batch size), a draft the batch check moves off an
// insight gets another structure, and a rewrite the batch check asked for uses up none of the draft's three tries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { assignStructures } from '../skills/event-outreach/scripts/structures.mjs';
import { insightCap } from '../skills/event-context/scripts/context-check.mjs';
import { setup, triage, todoJobs, cli } from './fixtures/harness.mjs';

const jobs = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${String(i + 1).padStart(3, '0')}`, touch: 1, kind: 'message', group: 'reach', insight_options: ['I1'], company_key: `co-${i}`, contact: { name: `P ${i}`, title: 'COO', company: `Co ${i}` }, crm_summary: { notes: 'asked about pilots' } }));
const count = (out, s) => Object.values(out).filter((x) => x === s).length;

test('assignStructures: one insight never leads more drafts than its room', () => {
  for (const n of [6, 10, 13]) {
    const cap = insightCap(n);
    const out = assignStructures(jobs(n), {}, null, { insightRoom: { 1: { I1: cap } } });
    assert.ok(count(out, 'insight-first') <= cap, `${n} jobs: ${count(out, 'insight-first')} insight-first, cap ${cap}`);
    assert.ok(count(out, 'insight-first') >= 1);
  }
  assert.ok(count(assignStructures(jobs(6), {}, null, { insightRoom: { 1: { I1: 2 } } }), 'insight-first') <= 3, 'six jobs: at most three');
  // An insight used up by drafts saved earlier, or one the job must avoid, leads none.
  assert.equal(count(assignStructures(jobs(10), {}, null, { insightRoom: { 1: { I1: 0 } } }), 'insight-first'), 0);
  assert.equal(count(assignStructures(jobs(10).map((j) => ({ ...j, avoid_insights: ['I1'] })), {}, null, { insightRoom: { 1: { I1: 3 } } }), 'insight-first'), 0);
});

// The mock profile with its "what you know" table cut to one insight.
function oneInsight(n) {
  const names = Array.from({ length: n }, (_, i) => `Person${String.fromCharCode(65 + i)} Test${i}`);
  const H = setup({ attendees: `Name,Title,Company,Email\n${names.map((x, i) => `${x},Head of Operations,Firm${i},p${i}@firm${i}.example`).join('\n')}\n` });
  const wyb = join(H.HOME, 'context', 'buyers', 'what-you-bring', 'SKILL.md');
  const lines = readFileSync(wyb, 'utf8').split('\n');
  const head = lines.findIndex((l) => /^\| insight \|/.test(l));
  writeFileSync(wyb, [...lines.slice(0, head + 3), ...lines.slice(head + 3).filter((l) => !/^\| /.test(l))].join('\n'));
  triage(H);
  return H;
}

test('todo: with one insight and ten people, insight-first goes to at most the cap', () => {
  const H = oneInsight(10);
  const { t, jobs: js } = todoJobs(H);
  assert.equal(t.insights, 1);
  const msgs = js.filter((j) => j.kind === 'message');
  assert.equal(msgs.length, 10);
  assert.ok(msgs.filter((j) => j.structure === 'insight-first').length <= t.insight_cap_by_touch[1], JSON.stringify(msgs.map((j) => j.structure)));
});

test('a draft the batch check moves off the insight gets another structure, and the rewrite uses no try', () => {
  const H = oneInsight(6);
  const { t, jobs: js } = todoJobs(H);
  const j = js.find((x) => x.kind === 'message' && x.structure === 'insight-first');
  assert.ok(j, JSON.stringify(js.map((x) => x.structure)));
  const body = (s) => `Hi ${j.contact.name.split(" ")[0]}, ${s}. Could you do ${j.slot_labels.join(' or ')} at Test Expo?\n\nBest, Sam\n\n${t.optout_sentence}`;
  const save = (b, extra) => cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', '1', '--json', JSON.stringify({ subject: 'Test Expo', body: b, brief: 'x', fact_source: 'list', ...extra })]);
  const first = save(body('most onboarding delay is waiting on insurance certificates, not vetting'), { structure: 'insight-first', insight: 'I1' });
  assert.equal(first.checks, 'pass', JSON.stringify(first));
  assert.equal(first.attempts, 1);
  // The batch check says the insight is in too many drafts and names this one.
  appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: '2026-10-12T08:01:00.000Z', type: 'batch_checked', who: 'floorboss', touch: 1, verdict: 'FAIL', reasons: [`I1 is in 4 drafts (c001, c002, ${j.id}, c009); the limit is 2. Move 2 of them to another insight that fits, or to a question: rewrite ${j.id}, c009`] })}\n`);
  const again = todoJobs(H).jobs.find((x) => x.id === j.id && x.touch === 1);
  assert.notEqual(again.structure, 'insight-first');
  assert.ok(again.avoid_insights.includes('I1'));
  const second = save(body('a plain ask about the onboarding work at your firm'), { structure: again.structure === 'question-first' ? 'question-first' : 'plain-request' });
  assert.equal(second.attempts, 1, 'a batch rewrite is no try');
});
