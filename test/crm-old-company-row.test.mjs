// A CRM row from the person's old company (Isabel Costa at Fennick Money in the CRM, Harborline Bank on the
// list): she is linked to it, marked as possibly out of date, and her old Lead row no longer makes Fennick
// Money "your account" for the people still there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, triage, todoJobs, idOf } from './fixtures/harness.mjs';

const CRM = 'First Name,Last Name,Email,Company,Deal Owner,Stage,Last Activity Date,Email Opt Out\n'
  + 'Sofia,Marques,sofia.marques@crestpay.example,Crestpay,Maya Okafor,Customer,09/12/2026,No\n'
  + 'Isabel,Costa,isabel.costa@fennick.example,Fennick Money,Maya Okafor,Lead,03/05/2025,No\n'
  + 'Grace,Liu,grace.liu@pebbleway.example,Pebbleway,Maya Okafor,Opportunity,09/28/2026,No\n';
const LIST = 'Full Name,Job Title,Organisation,Email\n'
  + 'Sofia Marques,Chief Operating Officer,Crestpay,sofia.marques@crestpay.example\n'
  + "James O'Neill,Head of Reconciliation,Fennick Money,james.oneill@fennick.example\n"
  + 'Yuki Tanaka,Product Manager Payments,Fennick Money,yuki.tanaka@fennick.example\n'
  + 'Isabel Costa,Director of Accounting,Harborline Bank,isabel.costa@harborline.example\n'
  + 'Noah Schmidt,Treasury Manager,Pebbleway,noah.schmidt@pebbleway.example\n';

test('the old company\'s row: linked as possibly stale; no "your account" at Fennick from a lead who left; Pebbleway, where the holder still is, keeps its note', () => {
  const H = setup({ attendees: LIST, crm: CRM, settings: { crm_user_name: 'Maya Okafor', crm_accounts: 'apply', coworker_contacts: 'leave' } });
  assert.ok(!triage(H).load.ERROR);
  const res = JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'));
  const isabel = res[idOf(H, 'Isabel Costa')];
  assert.equal(isabel.crm?.company, 'Fennick Money', JSON.stringify(isabel));
  assert.equal(isabel.crm_stale, true);
  assert.equal(isabel.account_note, null);
  for (const n of ["James O'Neill", 'Yuki Tanaka']) assert.equal(res[idOf(H, n)].account_note, null, `${n}: ${res[idOf(H, n)].account_note}`);
  assert.match(res[idOf(H, 'Noah Schmidt')].account_note, /at your account Pebbleway/);
  const { jobs } = todoJobs(H);
  const job = jobs.find((j) => j.id === idOf(H, 'Isabel Costa') && j.kind === 'message');
  assert.equal(job.crm_may_be_stale, true);
});
