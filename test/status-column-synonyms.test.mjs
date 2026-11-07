// A CRM export's status column under the names CRMs give it: HubSpot's "Lifecycle" (and "Lifecycle Stage",
// "Deal Stage", "Lead Status" and the rest) is proposed as the status column, its values read, never "not read".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propose } from '../skills/crm-triage/scripts/sources.mjs';

const rows = (h) => [
  { 'Contact Name': 'Lena Vogt', Email: 'lena@cartwise.example', Account: 'Cartwise', Owner: 'Ines Moreau', [h]: 'Open Deal' },
  { 'Contact Name': 'Mira Holt', Email: 'mira@basketry.example', Account: 'Basketry', Owner: 'Ines Moreau', [h]: 'Customer' },
  { 'Contact Name': 'Marco Bellini', Email: 'marco@pickpack.example', Account: 'Pickpack', Owner: 'Sam Okafor', [h]: 'Closed Lost' },
];

test('"Lifecycle" (HubSpot) is the status column, with its values proposed', () => {
  const m = propose(['Contact Name', 'Email', 'Account', 'Owner', 'Lifecycle'], rows('Lifecycle'), 'crm');
  assert.equal(m.columns.Lifecycle.field, 'status');
  assert.ok(m.columns.Lifecycle.confidence < 1);
  assert.deepEqual(m.values.status, { 'Open Deal': 'warm', Customer: 'customer', 'Closed Lost': 'lost' });
});

test('every usual name for a status column is read as one', () => {
  for (const h of ['Lifecycle', 'Lifecycle Stage', 'Life Cycle', 'Deal Stage', 'Dealstage', 'Pipeline Stage', 'Stage', 'Status', 'Lead Status', 'Lead Stage', 'Contact Stage']) {
    const m = propose(['Contact Name', 'Email', 'Account', 'Owner', h], rows(h), 'crm');
    assert.equal(m.columns[h].field, 'status', h);
  }
});
