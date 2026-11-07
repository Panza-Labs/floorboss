// Someone written to at the user's earlier event is held as in touch at the next one, before the customer rule
// and the warm rungs: Felix Braun (at the customer Kassenwerk, first message and follow-up sent in Berlin) is
// held like Lena Vogt (an open deal), not offered again as a warm note "at a customer". The mock stays apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, idOf } from './fixtures/harness.mjs';
import { ftu6, ATTENDEES } from './fixtures/ftu6.mjs';

function berlin({ mock = false } = {}) {
  const E0 = setup({ event: { slug: 'berlin', name: 'Retail Tech Forum Berlin', ...(mock ? { mock: true } : {}) }, attendees: ATTENDEES });
  cli(E0, 'crm-triage', ['load', '--event', 'berlin']);
  const sent = (name, touch, date) => appendFileSync(join(E0.dir, 'ledger.jsonl'), `${JSON.stringify({ at: `${date}T08:00:00Z`, type: 'sent', who: 'user', via: 'user', said: 'sent', id: idOf(E0, name), touch, date })}\n`);
  sent('Felix Braun', 1, '2026-10-01'); sent('Felix Braun', 2, '2026-10-05'); sent('Lena Vogt', 1, '2026-10-01');
  return E0;
}
const resolved = (H) => JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'));

test('written to at an earlier event: held as in touch before the customer rule, with the customer kept as the account note', () => {
  const E0 = berlin();
  const H = ftu6({ home: E0.HOME, event: { slug: 'paris', name: 'Paris Shopfront Week' } });
  const r = resolved(H);
  const felix = r[idOf(H, 'Felix Braun')], lena = r[idOf(H, 'Lena Vogt')], daniel = r[idOf(H, 'Daniel Kurz')];
  assert.equal(felix.group, 'in_touch', JSON.stringify(felix));
  assert.match(felix.says, /messaged at Retail Tech Forum Berlin on 2026-10-05/);
  assert.ok(felix.alternatives.some((a) => a.rung === 'customer_rule' && a.would_be === 'warm'), 'the customer rule is still there, as an alternative');
  assert.match(felix.account_note || '', /your customer Kassenwerk/);
  assert.equal(lena.group, 'in_touch');
  // Not written to in Berlin: the customer rule decides, as before.
  assert.equal(daniel.group === 'in_touch', false, JSON.stringify(daniel));
});

test('the mock event never holds anyone at a real event', () => {
  const E0 = berlin({ mock: true });
  const H = ftu6({ home: E0.HOME, event: { slug: 'paris', name: 'Paris Shopfront Week' } });
  const felix = resolved(H)[idOf(H, 'Felix Braun')];
  assert.notEqual(felix.group, 'in_touch', JSON.stringify(felix));
  assert.equal(felix.rung, 'customer_rule');
});
