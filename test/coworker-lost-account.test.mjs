// A coworker's lost deal at a company still makes it their account: with the simulated tester's CRM, Sam Okafor's "Closed
// Lost" record at Pickpack ("Lost on price March 2026") holds Henrik Stahl for Sam, as Sam's open deal at Retailio
// holds Petra Lind, and both cards carry whose account it is and what the record says. The lost-deal rule itself
// holds only the person on that record; the card says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cli, idOf, todoJobs } from './fixtures/harness.mjs';
import { ftu6 } from './fixtures/ftu6.mjs';

const resolved = (H) => JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'));

test('Henrik Stahl at Pickpack is held for Sam Okafor, with the lost status and its note on his card', () => {
  const H = ftu6();
  cli(H, 'crm-triage', ['view', '--event', H.slug]);
  const r = resolved(H);
  const henrik = r[idOf(H, 'Henrik Stahl')], petra = r[idOf(H, 'Petra Lind')];
  assert.equal(henrik.group, 'colleague');
  assert.equal(henrik.holder, 'Sam Okafor');
  assert.match(henrik.says, /Sam Okafor owns the Pickpack account: their CRM record says "Closed Lost", a lost deal with no date on the record \(date in the note: March 2026\); the lost-deal rule holds only the person on that record/);
  assert.equal(henrik.account_note, 'at Sam Okafor\'s account Pickpack (Closed Lost, Lost on price March 2026)');
  assert.equal(petra.group, 'colleague');
  assert.equal(petra.account_note, 'at Sam Okafor\'s account Retailio (Open Deal)');
});

test('written to anyway, the draft job knows it is Sam\'s lost account', () => {
  const H = ftu6();
  const plain = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'reach Henrik Stahl']);
  assert.match(plain.ERROR || JSON.stringify(plain.refused || ''), /Henrik Stahl is at Sam Okafor's account/);
  const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'reach Henrik Stahl anyway']);
  assert.ok(!g.ERROR, g.ERROR);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'ok']);
  const j = todoJobs(H).jobs.find((x) => x.id === idOf(H, 'Henrik Stahl') && x.kind === 'message');
  assert.ok(j);
  assert.equal(j.account_note, 'at Sam Okafor\'s account Pickpack (Closed Lost, Lost on price March 2026)');
});
