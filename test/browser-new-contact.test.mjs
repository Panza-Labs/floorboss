// Adding someone to the CRM in the browser so a message to them can be logged: asked per batch by default, and only
// a contact floorboss listed counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, idOf } from './fixtures/harness.mjs';
import { NODES } from '../skills/event-context/scripts/onboarding-tree.mjs';

const ONE = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n';
const ledger = (H) => readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

function report(H, item, row) {
  writeFileSync(join(H.dir, 'crm-log-list.json'), JSON.stringify([item]));
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', 'crm-log-results.json');
  writeFileSync(f, JSON.stringify([row]));
  cli(H, 'event-outreach', ['crm-log-results', '--event', H.slug, '--file', f]);
}

test('setup recommends being asked each batch, and only that', () => {
  const [first, ...rest] = NODES.find((n) => n.id === 'crm_create_contacts').options();
  assert.match(first, /^ask me each time.*\(recommended\)$/);
  assert.ok(!rest.some((o) => /recommended/.test(o)));
});

test('a contact floorboss did not list is recorded as failed, and no contact is recorded', () => {
  const H = setup({ attendees: ONE });
  triage(H);
  const id = idOf(H, 'Ana Berg');
  report(H, { key: `${id}:1`, id, touch: 1, name: 'Ana Berg', body: 'x' }, { key: `${id}:1`, result: 'created', page_says: 'Contact created' });
  assert.ok(!ledger(H).some((e) => e.type === 'crm_created'));
  assert.equal(ledger(H).filter((e) => e.type === 'crm_log_result').pop().result, 'failed');
});

test('a contact floorboss listed is recorded', () => {
  const H = setup({ attendees: ONE });
  triage(H);
  const id = idOf(H, 'Ana Berg');
  report(H, { key: `${id}:1`, id, touch: 1, name: 'Ana Berg', body: 'x', create: true }, { key: `${id}:1`, result: 'created', page_says: 'Contact created', ref: 'r1' });
  assert.equal(ledger(H).filter((e) => e.type === 'crm_created').pop().crm_ref, 'r1');
  assert.equal(ledger(H).filter((e) => e.type === 'crm_log_result').pop().result, 'created');
});
