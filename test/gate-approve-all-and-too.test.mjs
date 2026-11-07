// "approve all, and c016 too as it is, the critic is being picky about the subject": approve all, c016 approved by
// name (a draft the critic failed), and the remark kept as a comment, not refused. What can't be read is refused
// on its own and said back; beside "approve all" it stops the approval, since it may have meant to hold someone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGate, GateError } from '../lib/gate.mjs';
import { setup, cli, todoJobs, idOf } from './fixtures/harness.mjs';
import { draftFor } from './sims/lib/driver.mjs';

const known = new Set(['c001', 'c016', 'c019', 'c027']);
const parse = (t, partial = true) => parseGate(t, { kind: 'draft', knownIds: known, partial });

test('approve all with "and <id> too / as is" and a trailing remark', () => {
  const g = parse('approve all, and c016 too as it is, the critic is being picky about the subject');
  assert.deepEqual(g.actions.map((a) => ({ ...a })), [{ verb: 'approve-all', except: [] }, { verb: 'approve', ids: ['c016'] }]);
  assert.deepEqual(g.comments, ['the critic is being picky about the subject']);
  assert.deepEqual(g.refused, []);
  assert.deepEqual(parse('approve all, c016 as is').actions.map((a) => a.verb), ['approve-all', 'approve']);
  assert.deepEqual(parse('approve all except c019, c027').actions[0].except, ['c019', 'c027']);
  assert.deepEqual(parse('approve all except c019 and c027, they look fine to me').actions[0].except, ['c019', 'c027']);
  assert.deepEqual(parse('approve all. looks good').comments, ['looks good']);
});

test('what can\'t be read beside approve all is refused, never guessed', () => {
  const g = parse('approve all, c016 maybe');
  assert.equal(g.actions.length, 0);
  assert.match(g.refused[0].why, /can't be read beside "approve all"/);
  assert.throws(() => parse('approve all, c016 maybe', false), GateError);
});

const ATT = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Ng,VP Ops,Initech,cy@initech.test\n';
function drafted() {
  const H = setup({ attendees: ATT });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const f = join(H.dir, 'fits.json');
  writeFileSync(f, JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment: 'ops-leaders', reason: `${r.title} at ${r.company}`, score: 80 }))));
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits-file', f]);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  const r = todoJobs(H);
  const bo = idOf(H, 'Bo Li');
  for (const j of r.jobs) {
    const d = (({ body, structure, fact_source, insight }) => ({ subject: 'Test Expo', body, brief: 'x', structure, fact_source, ...(insight ? { insight } : {}) }))(draftFor({ ...r.t, insights: r.insights }, { ...j, slot_labels: j.slot_labels || [] }));
    cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--json', JSON.stringify(d)]);
    cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--text', j.id === bo ? 'FAIL\n- the subject is vague' : 'PASS']);
  }
  return { H, bo, n: r.jobs.length };
}

test('the simulated tester\'s answer at the draft gate: everything approved, the failed draft by name, the remark said back', () => {
  const { H, bo, n } = drafted();
  const g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', `approve all, and ${bo} too as it is, the critic is being picky about the subject`]);
  assert.ok(!g.ERROR, g.ERROR);
  assert.equal(g.approved, n, JSON.stringify(g));
  assert.deepEqual(g.read_as_comment, ['the critic is being picky about the subject']);
});

test('at the draft gate, a line that can\'t be read beside "approve all" approves nothing; elsewhere the rest is applied', () => {
  const { H, bo } = drafted();
  const ana = idOf(H, 'Ana Berg');
  const g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all; frobnicate Cy']);
  assert.match(g.ERROR || '', /Nothing was approved/);
  const h = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', `approve ${ana}; frobnicate Cy`]);
  assert.ok(!h.ERROR, h.ERROR);
  assert.equal(h.approved, 1);
  assert.equal(h.refused.length, 1);
  // A refused line about someone another line approves: nothing is approved.
  const k = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', `approve ${bo}; frobnicate ${bo}`]);
  assert.match(k.ERROR || '', /frobnicate/);
});
