// A rewrite (after a rating note sent it back) that comes back word for word as a version the critic already
// passed: the flow counts that verdict and sends it to no critic, so the gate must take it too. It refused it as
// "the critic hasn't read it", and a seller's run looped at the approval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, todoJobs, idOf } from './fixtures/harness.mjs';

test('the same text as a passed version, saved again after another: the gate approves it', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const f = join(H.dir, 'fits.json');
  writeFileSync(f, JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment: 'ops-leaders', reason: `${r.title} at ${r.company}`, score: 80 }))));
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits-file', f]);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  const { jobs, t } = todoJobs(H);
  const j = jobs.find((x) => x.id === idOf(H, 'Ana Berg') && x.touch === 1);
  const times = j.slot_labels.join(' or ');
  const A = { subject: 'Test Expo', body: `Hi Ana,\n\nI run ops tooling at Lanecraft and would value 20 minutes at Test Expo. Could you do ${times}?\n\nBest, Sam${t.optout_sentence ? `\n\n${t.optout_sentence}` : ''}`, brief: 'x', structure: 'plain-request', fact_source: 'list' };
  const B = { ...A, body: A.body.replace('would value', 'would like') };
  const save = (d) => cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', '1', '--json', JSON.stringify(d)]);
  assert.ok(!save(A).ERROR);
  assert.ok(!cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--touch', '1', '--text', 'PASS']).ERROR);
  assert.ok(!save(B).ERROR);
  assert.ok(!save(A).ERROR);
  const g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all']);
  assert.ok(!g.ERROR, g.ERROR);
  assert.equal(g.approved, 1, JSON.stringify(g.not_ready));
});
