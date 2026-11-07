// A CRM record at another company than the list's ("he moved from Hooli to Pied Piper"): the draft is told the
// record may be stale, the old company's account isn't claimed, and an address at the old company is flagged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, todoJobs, idOf } from './fixtures/harness.mjs';

test('same person, new company: crm_may_be_stale on the job, no old account note, the old address named', () => {
  const H = setup({
    attendees: 'Name,Title,Company,Email\nEd Fox,VP Operations,Pied Piper Freight,ed.fox@hoolilogistics.test\nAna Berg,COO,Acme,ana@acme.test\n',
    crm: 'Name,Email,Company,Owner,Status,Opted Out\nEd Fox,ed.fox@hoolilogistics.test,Hooli Logistics,Sam Rivera,Lead,no\n',
  });
  const t = triage(H);
  assert.ok(!t.load.ERROR, t.load.ERROR);
  const ed = idOf(H, 'Ed Fox');
  const resolved = () => JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'))[ed];
  if (resolved().group === 'check') {
    const row = (resolved().alternatives || []).find((a) => a.ref)?.ref || 'crm:1';
    const d = cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `${ed} same-person ${row} because he moved from Hooli to Pied Piper`]);
    assert.ok(!d.ERROR, d.ERROR);
    cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'ok']);
  }
  const r = resolved();
  assert.equal(r.crm_stale, true, JSON.stringify(r));
  assert.equal(r.email_old_company, 'Hooli Logistics');
  assert.doesNotMatch(String(r.account_note || ''), /Hooli/);
  const { jobs } = todoJobs(H);
  const job = jobs.find((j) => j.id === ed && j.kind === 'message');
  assert.ok(job, 'Ed is drafted for');
  assert.equal(job.crm_may_be_stale, true);
  // Ana's record (none) is not stale.
  assert.equal(jobs.find((j) => j.id === idOf(H, 'Ana Berg'))?.crm_may_be_stale, undefined);
});
