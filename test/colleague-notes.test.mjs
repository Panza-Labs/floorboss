// What happens to someone a coworker holds is said as it is: by default they're left to the coworker and no
// note is drafted (the card says so); with colleague_notes on, a note to the coworker is drafted, approved and
// put in the outbox. The outbox header says what "not drafted" covers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, todoJobs, draftApprove, idOf } from './fixtures/harness.mjs';

const PEOPLE = 'Name,Title,Company,Email\nOla Ops,COO,Acme,ola@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n';
const CRM = 'Name,Email,Company,Owner,Status,Opted Out\nOla Ops,ola@acme.test,Acme,Pat Teammate,Lead,no\n';

test('colleague notes off (the default): the card says no note is drafted, and none is', () => {
  const H = setup({ attendees: PEOPLE, crm: CRM, settings: { status_map: { Lead: 'ignore' } } });
  triage(H);
  const view = cli(H, 'crm-triage', ['view', '--event', H.slug]);
  assert.equal(view.colleague_notes, 0);
  assert.ok(view.left_out.some((x) => /Pat Teammate.*left to them, and no note is drafted/.test(x.why)), JSON.stringify(view.left_out));
  assert.ok(!todoJobs(H).jobs.some((j) => j.kind === 'coordinate'));
  draftApprove(H);
  const html = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
  assert.match(html, /1 held for a colleague/);
  assert.match(html, /not drafted \(they don't fit, have no address, or wait on your call\)/);
});

test('colleague notes on: a note to the coworker is drafted and lands in the outbox', () => {
  const H = setup({ attendees: PEOPLE, crm: CRM, settings: { status_map: { Lead: 'ignore' }, colleague_notes: true } });
  triage(H);
  const view = cli(H, 'crm-triage', ['view', '--event', H.slug]);
  assert.equal(view.colleague_notes, 1);
  const note = todoJobs(H).jobs.find((j) => j.kind === 'coordinate');
  assert.equal(note?.id, idOf(H, 'Ola Ops'));
  assert.equal(note.holder, 'Pat Teammate');
  draftApprove(H);
  const html = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
  assert.match(html, /note for Pat Teammate/);
});
