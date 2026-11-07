// Opt-out values and CRM statuses fail closed, unknown statuses wait for the user, caps match the company as
// written, and German or hand-made headers map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optedOut, defaultStatusMeaning, propose } from '../skills/crm-triage/scripts/sources.mjs';
import { capFor } from '../skills/crm-triage/scripts/shortlist.mjs';
import { companyKey } from '../lib/normalize.mjs';

const NOT_REACHED = ['hold', 'do_not_contact', 'lost'];

test('opt-out values fail closed', () => {
  for (const v of ['opt-out', 'Opt Out', 'Yes - unsubscribed', 'checked', '✓', '1.0', 'do not email', 'Unsubscribed (2024-03-01)', '2024-03-01', 'No consent']) assert.equal(optedOut(v), true, v);
  for (const v of ['', 'false', 'No', '0', 'opted in', 'Subscribed']) assert.equal(optedOut(v), false, v);
});

test('statuses: stops and holds are never reached, unknown ones wait for the user', () => {
  for (const s of ['Unsubscribed', 'Opted out', 'Bounced', 'Litigation', 'Lost - asked not to be contacted', 'Former customer', 'Ex-client', 'Compliance hold - tender']) assert.ok(NOT_REACHED.includes(defaultStatusMeaning(s)), `${s}: ${defaultStatusMeaning(s)}`);
  for (const s of ['Unsubscribed', 'Opted out', 'Lost - asked not to be contacted']) assert.equal(defaultStatusMeaning(s), 'do_not_contact', s);
  for (const s of ['Rejected', 'Declined', 'Passed', 'Closed Lost']) assert.ok(!['warm', 'customer'].includes(defaultStatusMeaning(s)), s);
  assert.equal(defaultStatusMeaning('Weird Custom Thing'), null);
  assert.equal(defaultStatusMeaning('Lead'), 'ignore');
  assert.equal(defaultStatusMeaning('Customer'), 'customer');
});

test('caps by the company name as written', () => {
  assert.equal(capFor(companyKey('Merriton Bank PLC'), { account_cap: 2, account_caps: { 'Merriton Bank': 4 } }), 4);
  assert.equal(capFor('merriton bank', { account_cap: 2, account_caps: { 'merriton-bank': 'all' } }), Infinity);
});

test('German and hand-made headers map', () => {
  const fields = (headers) => Object.fromEntries(Object.entries(propose(headers, [], 'attendees').columns).map(([h, c]) => [h, c.field]));
  assert.deepEqual(fields(['Vorname', 'Nachname', 'Funktion', 'Firma', 'E-Mail-Adresse', 'Land']), { Vorname: 'first_name', Nachname: 'last_name', Funktion: 'title', Firma: 'company', 'E-Mail-Adresse': 'email', Land: 'location' });
  const hand = fields(['Who', 'Co.', 'Job Position', 'Biography']);
  assert.deepEqual([hand.Who, hand['Co.'], hand['Job Position'], hand.Biography], ['name', 'company', 'title', 'notes']);
});
