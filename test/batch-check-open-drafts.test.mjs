// The batch check weighs a touch's open drafts only: a message already sent, or one held for the user after two
// critic fails, neither counts towards the insight cap nor is named for a rewrite (a follow-up check reopened
// sent first messages and a held one: "I1 is in 4 drafts … rewrite c019").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, todoJobs } from './fixtures/harness.mjs';

const NAMES = ['Ana Berg', 'Bo Li', 'Cy Ng', 'Dee Ho', 'Eli Ruiz', 'Fay Odum', 'Gus Pell', 'Hal Moro'];
const TOPICS = ['insurance papers', 'lane openings', 'site audits', 'carrier vetting', 'tender scoring', 'cold chain checks', 'subcontractors', 'phone uploads'];
const LIST = `Name,Title,Company,Email\n${NAMES.map((n, i) => `${n},COO,Co${i},${n.split(' ')[0].toLowerCase()}@co${i}.test`).join('\n')}\n`;

test('batch check: sent and held drafts are not counted towards the cap or named for a rewrite', () => {
  const H = setup({ attendees: LIST });
  assert.ok(!triage(H).load.ERROR);
  const { t, jobs } = todoJobs(H);
  const msgs = jobs.filter((j) => j.kind === 'message' && j.touch === 1);
  assert.equal(msgs.length, 8);
  const body = (j, i, extra = '') => `Hi ${j.contact.name.split(' ')[0]}, a question about ${TOPICS[i]} at ${j.contact.company}${extra}: how do you handle it today? ${j.slot_labels.length ? `Could you do ${j.slot_labels.join(' or ')}` : 'Could we meet'} at Test Expo?\n\nBest, Sam\n\n${t.optout_sentence}`;
  const save = (j, i, extra) => cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', '1', '--json', JSON.stringify({ subject: `Test Expo: ${TOPICS[i]}`, body: body(j, i, extra), brief: 'x', structure: 'plain-request', fact_source: 'list', insight: i < 4 ? 'I1' : null })]);
  const verdict = (j, text) => cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--touch', '1', '--text', text]);
  msgs.forEach((j, i) => { save(j, i); verdict(j, i === 2 ? 'FAIL: too vague' : 'PASS'); });
  // The third one fails the critic twice: held for the user.
  save(msgs[2], 2, ' again'); verdict(msgs[2], 'FAIL: still too vague');
  const before = cli(H, 'event-outreach', ['batch-check', '--event', H.slug, '--touch', '1']);
  // The held draft is out already: I1 is in the three others.
  assert.ok(before.reasons.some((r) => new RegExp(`I1 is in 3 drafts \\(${msgs[0].id}, ${msgs[1].id}, ${msgs[3].id}\\)`).test(r)), JSON.stringify(before.reasons));
  assert.ok(!cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all']).ERROR);
  const f = join(H.dir, 'sent.json');
  writeFileSync(f, JSON.stringify({ items: [NAMES[0], NAMES[1]].map((who) => ({ who, what: 'sent', date: '2026-10-12' })) }));
  assert.ok(!cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', f]).ERROR);
  const after = cli(H, 'event-outreach', ['batch-check', '--event', H.slug, '--touch', '1']);
  assert.ok(!after.reasons.some((r) => /\bI1 is in/.test(r)), JSON.stringify(after.reasons));
  for (const j of msgs.slice(0, 3)) assert.ok(!after.reasons.some((r) => new RegExp(`\\b${j.id}\\b`).test(r)), `${j.id} named: ${JSON.stringify(after.reasons)}`);
  assert.equal(after.insight_cap, 1, 'the cap is the open batch\'s (5 drafts)');
});
