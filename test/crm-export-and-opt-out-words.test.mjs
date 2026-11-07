// The CRM export question takes a path inside a sentence, as the list question does, and an error says
// "floorboss:" once. The mapping says which column covers opt-outs: a status that means never contact
// ("Unsubscribed" in Deal Stage) is enough, and "there's no opt-out column" in words is an answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, NOW, setup, cli } from './fixtures/harness.mjs';

const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n';
const WITH_STATUS = 'Contact Name,Email,Company,Deal Stage,Contact Owner\nAna Berg,ana@acme.test,Acme,Unsubscribed,Sam Rivera\nBo Li,bo@globex.test,Globex,Customer,Sam Rivera\n';
const NO_OPTOUT = 'Contact Name,Email,Company,Deal Stage,Contact Owner\nAna Berg,ana@acme.test,Acme,Customer,Sam Rivera\n';
const answer = (H, ask, text) => {
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', `${ask}.txt`); writeFileSync(f, text);
  try { return JSON.parse(execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'answer', '--event', H.slug, '--ask', ask, '--value-file', f], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); } catch (e) { return { ERROR: String(e.stderr || e.message) }; }
};

test('crm_export: a path inside a sentence is the file; a missing one says "floorboss:" once', () => {
  const H = setup({ attendees: LIST });
  const f = join(H.HOME, 'my-export.csv'); writeFileSync(f, WITH_STATUS);
  const r = answer(H, 'crm_export', `here: ${f}, exported from HubSpot this morning`);
  assert.ok(!r.ERROR, r.ERROR);
  assert.ok(existsSync(join(H.dir, 'inputs', 'crm.csv')));
  const bad = answer(H, 'crm_export', join(H.HOME, 'nowhere.csv'));
  assert.match(bad.ERROR, /floorboss: crm-triage inputs: /);
  assert.doesNotMatch(bad.ERROR, /floorboss: crm-triage inputs: floorboss:/);
});

test('mapping: a status meaning never contact covers opt-outs, and the answer says which column', () => {
  const H = setup({ attendees: LIST, crm: WITH_STATUS });
  assert.ok(!cli(H, 'crm-triage', ['propose-mapping', '--event', H.slug, '--kind', 'crm']).ERROR);
  const r = cli(H, 'crm-triage', ['confirm-mapping', '--event', H.slug, '--kind', 'crm', '--accept', '--said', 'looks right']);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.opt_out, 'Opt-outs: no opt-out column: "Deal Stage" covers it ("Unsubscribed" means never contact).');
});

test('mapping: "there\'s no opt-out column" in words is an answer; "looks right" alone is refused and says how', () => {
  const H = setup({ attendees: LIST, crm: NO_OPTOUT });
  cli(H, 'crm-triage', ['propose-mapping', '--event', H.slug, '--kind', 'crm']);
  const plain = cli(H, 'crm-triage', ['confirm-mapping', '--event', H.slug, '--kind', 'crm', '--accept']);
  assert.match(plain.ERROR, /say there is none \("there's no opt-out column"\)/);
  const r = answer(H, 'map_columns_crm', "looks right, there's no opt-out column in our export");
  assert.ok(!r.ERROR, r.ERROR);
  assert.match(r.result.opt_out, /you said there is none/);
});
