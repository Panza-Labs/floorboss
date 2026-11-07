// An uncertain match settled and decided in one answer: "c008 same-person crm:5" with "c008 warm because we met at
// Tillcon in March" on the next line, or both on one line, is saved (the match first, then the warm decision,
// checked against the person as the match makes them). A warm line alone on an uncertain match is refused with
// the one-line form to use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cli, idOf } from './fixtures/harness.mjs';
import { ftu6 } from './fixtures/ftu6.mjs';
import { fold, readLedger } from '../lib/ledger.mjs';

const person = (H, id) => fold(readLedger(join(H.dir, 'ledger.jsonl')).entries).people[id];
const resolved = (H) => JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'));

test('a warm line alone on an uncertain match is refused, and says the one-line form', () => {
  const H = ftu6();
  const kate = idOf(H, 'Kate Lindqvist');
  assert.equal(resolved(H)[kate].rung, 'fuzzy');
  const r = cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `${kate} warm because we met at Tillcon in March`]);
  assert.match(r.ERROR || '', new RegExp(`settle it in the same line, "${kate} same-person crm:5 warm because we met at Tillcon in March"`));
});

test('same-person on one line and warm on the next, in one answer: both saved, the reason kept as her note', () => {
  const H = ftu6();
  const kate = idOf(H, 'Kate Lindqvist');
  const r = cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `${kate} same-person crm:5\n${kate} warm because we met at Tillcon in March`]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.still_unsettled, undefined);
  assert.equal(r.not_in_check, undefined, 'she was asked about');
  const p = person(H, kate);
  assert.deepEqual(p.matches.map((m) => [m.group, m.ref]), [['same-person', 'crm:5']]);
  assert.equal(p.decision.group, 'warm');
  assert.ok(p.notes.some((n) => n.text === 'we met at Tillcon in March'));
  assert.equal(resolved(H)[kate].group, 'warm');
});

test('"<id> same-person crm:5 warm because …" on one line; a coworker\'s line beside it is refused on its own', () => {
  const H = ftu6();
  const kate = idOf(H, 'Kate Lindqvist'), petra = idOf(H, 'Petra Lind');
  const r = cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `${kate} same-person crm:5 warm because we met at Tillcon in March\n${petra} reach because Petra asked me for a demo herself`]);
  assert.ok(!r.ERROR, r.ERROR);
  const p = person(H, kate);
  assert.equal(p.matches[0].ref, 'crm:5');
  assert.equal(p.decision.group, 'warm');
  assert.ok(p.notes.some((n) => n.text === 'we met at Tillcon in March'));
  assert.match(r.tell_user, /Not saved: .*Petra Lind .* Sam Okafor/);
  assert.equal(person(H, petra).decision, null);
});
