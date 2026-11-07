// Round 6's small things: the coworker refusal has one pair of brackets, not two; no coworker hold is written for
// the user's own records before they've said which CRM owner is them; the fit step's count and the load's
// "unjudged" agree, said together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli } from './fixtures/harness.mjs';
import { ftu6, ftu6Flow, CRM } from './fixtures/ftu6.mjs';
import { untilStep } from './fixtures/flow-until.mjs';

test('reaching someone at a coworker\'s account: "(Sam Okafor owns the Retailio account: their CRM record says "Open Deal")"', () => {
  const H = ftu6();
  const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'reach Petra Lind']);
  const why = g.ERROR || JSON.stringify(g.refused);
  assert.match(why, /Petra Lind is at Sam Okafor's account \(Sam Okafor owns the Retailio account: their CRM record says \\?"Open Deal\\?"\)\./);
  assert.doesNotMatch(why, /\(crm,/);
});

test('no coworker hold is written for the user\'s own records before the CRM owner that is them is known', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nLena Vogt,Head of Payments,Cartwise,lena.vogt@cartwise.example\nPetra Lind,Head of eCommerce,Retailio,petra.lind@retailio.example\n', crm: CRM, settings: { crm_user_name: undefined, crm_accounts: 'apply', coworker_contacts: 'leave' } });
  cli(H, 'crm-triage', ['propose-mapping', '--event', H.slug, '--kind', 'crm']);
  const words = join(H.HOME, 'w.txt'); writeFileSync(words, "Lifecycle is the status column. There's no opt-out column.");
  assert.ok(!cli(H, 'crm-triage', ['confirm-mapping', '--event', H.slug, '--kind', 'crm', '--words-file', words]).ERROR);
  // A list given now (the do-not-contact answer, here) writes down the holds the files make before it's copied.
  const dnc = join(H.HOME, 'dnc.txt'); writeFileSync(dnc, 'nobody@nowhere.example\n');
  assert.ok(!cli(H, 'crm-triage', ['inputs', '--event', H.slug, '--kind', 'dnc', '--file', dnc]).ERROR);
  const seen = () => readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'hold_seen');
  assert.deepEqual(seen().filter((e) => e.rung === 'colleague'), []);
  // Once it's known, the coworker's holds are written, and the user's own records never are.
  const ev = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8')); ev.settings.crm_user_name = 'Ines Moreau'; writeFileSync(join(H.dir, 'event.json'), JSON.stringify(ev));
  assert.ok(!cli(H, 'crm-triage', ['load', '--event', H.slug]).ERROR);
  const col = seen().filter((e) => e.rung === 'colleague');
  assert.ok(col.length && col.every((e) => /Sam Okafor/.test(e.says)), JSON.stringify(col));
});

test('the fit step\'s count and the load\'s "unjudged" are said together and agree', () => {
  const { H, persona } = ftu6Flow();
  const at = untilStep(H, persona, 'fit');
  const counts = at.last.ran.find((r) => r.step === 'load').counts;
  const m = /^(\d+) people need a judgement: .* That is the (\d+) "unjudged" in the load's counts and (\d+) the CRM or the list already place/.exec(at.last.why);
  assert.ok(m, at.last.why);
  assert.equal(Number(m[2]), counts.unjudged);
  assert.equal(Number(m[1]), Number(m[2]) + Number(m[3]));
});
