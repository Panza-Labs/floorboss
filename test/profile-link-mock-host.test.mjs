// The mock event's stand-in for LinkedIn (example.com/in/<name>, examples/mock-event/load.mjs) counts as a LinkedIn
// link on the mock event only; a real list with that host does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propose, applyMapping } from '../skills/crm-triage/scripts/sources.mjs';
import { readCsvText } from '../lib/csv.mjs';

const csv = 'Name,Company,LinkedIn\nTom Fischer,Acme,https://example.com/in/tom-fischer\nAna Berg,Globex,https://example.com/in/ana-berg\n';
test('example.com/in/<name> is a profile link on the mock event, and on no other', () => {
  const { headers, records } = readCsvText(csv);
  const mock = propose(headers, records, 'attendees', { mock: true });
  assert.equal(mock.columns.LinkedIn.field, 'profile_url');
  assert.equal(applyMapping(records, { kind: 'attendees', columns: mock.columns, values: {} })[0].profile_url, 'https://example.com/in/tom-fischer');
  assert.equal(propose(headers, records, 'attendees').columns.LinkedIn.field, 'ignore');
});
