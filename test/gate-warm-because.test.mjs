// The shortlist gate's warm and reach take the user's reason: "warm c008 because we met at Tillcon in March"
// decides warm for c008 (the reason is never read as a name), and the reason is the person's note, so it reaches
// the drafter's job as user_note, as it does from check-these.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, cli, todoJobs, idOf } from './fixtures/harness.mjs';
import { parseGate } from '../lib/gate.mjs';

const LIST = 'Name,Title,Company,Email\nKate Lindqvist,Partnerships Manager,Tillmoss Labs,kate@tillmoss.example\nPia Holm,Head of Operations,Fjordvik,pia@fjordvik.example\n';

test('parseGate: "warm c008 because …" is warm for c008 with the reason; "anyway" and a name still read', () => {
  assert.deepEqual(parseGate('warm c008 because we met at Tillcon in March', { kind: 'triage' }).actions.map((a) => ({ ...a })), [{ verb: 'warm', ids: ['c008'], because: 'we met at Tillcon in March' }]);
  assert.deepEqual(parseGate('reach c004 anyway because she asked me herself', { kind: 'triage' }).actions.map((a) => ({ ...a })), [{ verb: 'reach', ids: ['c004'], anyway: true, because: 'she asked me herself' }]);
  assert.deepEqual(parseGate('reach c004', { kind: 'triage' }).actions.map((a) => ({ ...a })), [{ verb: 'reach', ids: ['c004'] }]);
});

test('gate: "warm <id> because …" and "reach <name> because …" record the decision and the note the job carries', () => {
  const H = setup({ attendees: LIST });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.ok(!load.ERROR, load.ERROR);
  const kate = idOf(H, 'Kate Lindqvist'), pia = idOf(H, 'Pia Holm');
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits', JSON.stringify([{ id: kate, segment: 'ops-leaders', reason: 'partnerships', score: 80 }, { id: pia, segment: 'ops-leaders', reason: 'head of operations', score: 70 }])]);
  const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', `warm ${kate} because we met at Tillcon in March\nreach Pia Holm because she asked for a demo herself`]);
  assert.ok(!g.ERROR, g.ERROR);
  assert.equal(g.refused, undefined, JSON.stringify(g.refused));
  assert.ok(!cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'ok']).ERROR);
  const { jobs } = todoJobs(H);
  const jk = jobs.find((x) => x.id === kate && x.kind === 'message'), jp = jobs.find((x) => x.id === pia && x.kind === 'message');
  assert.equal(jk.user_note, 'we met at Tillcon in March');
  assert.match(jk.warm_because || '', /you said: warm \(we met at Tillcon in March\)/);
  assert.equal(jp.user_note, 'she asked for a demo herself');
});
