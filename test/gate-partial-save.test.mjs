// A shortlist answer of several lines where one needs a choice ("reach" for someone at a coworker's account):
// the good lines are saved, the one line is refused with its choices, and the answer says what was saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, idOf } from './fixtures/harness.mjs';

const LIST = 'Name,Title,Company,Email\nDiane Woo,Chief Sustainability Officer,Meridian Office REIT,diane.woo@meridianreit.test\nPaul Fenwick,VP Engineering,Meridian Office REIT,paul.fenwick@meridianreit.test\nAna Berg,COO,Acme,ana@acme.test\nBo Li,COO,Globex,bo@globex.test\n';
const CRM = 'Name,Email,Company,Owner,Status,Opted Out\nDiane Woo,diane.woo@meridianreit.test,Meridian Office REIT,Jordan Fisk,Lead,no\n';

test('gate: two good lines saved, the coworker line refused with its choices, and said', () => {
  const H = setup({ attendees: LIST, crm: CRM, settings: { crm_accounts: 'apply', coworker_contacts: 'leave', colleagues: ['Jordan Fisk'] } });
  assert.ok(!triage(H).load.ERROR);
  const res = () => JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'));
  const [paul, ana] = [idOf(H, 'Paul Fenwick'), idOf(H, 'Ana Berg')];
  const r = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'remove Ana Berg\nreach Paul Fenwick\ncap 1']);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(res()[ana].group, 'skip', 'the remove line was saved');
  assert.equal(res()[paul].group, 'colleague', 'the refused line was not');
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0].why, /Paul Fenwick is at Jordan Fisk's account.*"reach Paul Fenwick anyway".*"Paul Fenwick is mine"/);
  assert.match(r.tell_user, /^Saved: "remove Ana Berg", "cap 1"\. Not saved: "reach Paul Fenwick": /);
  // Only that line in the answer: refused as before, nothing saved.
  assert.match(cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'reach Paul Fenwick']).ERROR, /Nothing was saved\./);
});
