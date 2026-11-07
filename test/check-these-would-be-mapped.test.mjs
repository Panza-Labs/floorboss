// On check-these, what an uncertain CRM match would mean is said with the meaning the user gave its status in the
// mapping: Kate Lindqvist's possible record (Katherine Lindqvist, "Prospect", which the simulated tester mapped to hold)
// reads "\"Prospect\" means hold", not a bare "that record says Prospect".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { idOf } from './fixtures/harness.mjs';
import { ftu6 } from './fixtures/ftu6.mjs';

test('would_be for a fuzzy CRM match uses the mapped meaning', () => {
  const H = ftu6();
  const r = JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'))[idOf(H, 'Kate Lindqvist')];
  assert.equal(r.group, 'check');
  const alt = r.alternatives.find((a) => a.rung === 'crm_match');
  assert.ok(alt, JSON.stringify(r.alternatives));
  assert.equal(alt.would_be, 'skip: "Prospect" means hold (leave alone) in your mapping, so they\'d be left alone');
});
