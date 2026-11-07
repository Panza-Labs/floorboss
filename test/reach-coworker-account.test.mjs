// "reach <name>" for someone at a coworker's account is never a silent override: the user is asked to choose,
// and "reach <name> anyway" gives the draft the account (so it isn't cold) and tells the coworker in their note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, todoJobs, idOf } from './fixtures/harness.mjs';

const LIST = 'Name,Title,Company,Email\nDiane Woo,Chief Sustainability Officer,Meridian Office REIT,diane.woo@meridianreit.test\nPaul Fenwick,VP Engineering,Meridian Office REIT,paul.fenwick@meridianreit.test\nAna Berg,COO,Acme,ana@acme.test\n';
const CRM = 'Name,Email,Company,Owner,Status,Opted Out\nDiane Woo,diane.woo@meridianreit.test,Meridian Office REIT,Jordan Fisk,Lead,no\n';

test('reach at a coworker\'s account: refused with the choice; "anyway" writes to them with the account, and the coworker\'s note says so', () => {
  const H = setup({ attendees: LIST, crm: CRM, settings: { crm_accounts: 'apply', coworker_contacts: 'leave', colleagues: ['Jordan Fisk'], colleague_notes: true } });
  const t = triage(H);
  assert.ok(!t.load.ERROR, t.load.ERROR);
  const paul = idOf(H, 'Paul Fenwick');
  const diane = idOf(H, 'Diane Woo');
  const res = () => JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'));
  assert.equal(res()[paul].group, 'colleague', JSON.stringify(res()[paul]));
  const no = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'reach Paul Fenwick']);
  assert.match(no.ERROR || '', /Paul Fenwick is at Jordan Fisk's account/);
  assert.match(no.ERROR, /"reach Paul Fenwick anyway"/);
  assert.match(no.ERROR, /"Paul Fenwick is mine"/);
  assert.match(no.ERROR, /"leave Paul Fenwick with Jordan Fisk"\. Nothing was saved\./);
  assert.equal(res()[paul].group, 'colleague', 'nothing was saved');
  const yes = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'reach Paul Fenwick anyway']);
  assert.ok(!yes.ERROR, yes.ERROR);
  assert.equal(res()[paul].group, 'reach');
  assert.equal(res()[paul].account_note, "at Jordan Fisk's account Meridian Office REIT");
  const { jobs } = todoJobs(H);
  const msg = jobs.find((j) => j.id === paul && j.kind === 'message');
  assert.equal(msg.account_note, "at Jordan Fisk's account Meridian Office REIT", 'the draft is not written cold');
  const note = jobs.find((j) => j.id === diane && j.kind === 'coordinate');
  assert.ok(note, 'a note to Jordan about Diane');
  assert.deepEqual(note.also_writing, ['Paul Fenwick']);
});
