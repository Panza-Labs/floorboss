// Column mapping: proposed from names and values, confirmed by the user, nothing dropped in silence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propose, applyMapping, validateMapping, fingerprint, defaultStatusMeaning, optedOut, parseDate } from '../skills/crm-triage/scripts/sources.mjs';
import { readCsvText } from '../lib/csv.mjs';

const CRM = 'First Name,Last Name,Email,Company Name,Contact owner,Lifecycle Stage,Lead Status,Last Contacted,Close Date,Associated Deal,Unsubscribed from all email,Misc Field 7,Hobby\n'
  + 'Ana,Berg,ana@acme.test,Acme,Sam Rivera,Customer,Open,25/08/2026,01/08/2026,Acme renewal,false,,chess\n'
  + 'Bo,Li,bo@globex.test,Globex,Dana Teammate,Lead,Attempted to contact,20/09/2026,,,false,Candidate asked never to be contacted again,golf\n'
  + 'Cy,Ng,cy@initech.test,Initech,Sam Rivera,Opportunity,Closed Lost,,15/01/2027,Initech rollout,true,,\n';

test('propose: fields from names and values, statuses with counts and a default meaning, stop cells in an unmapped column', () => {
  const { headers, records } = readCsvText(CRM);
  const p = propose(headers, records, 'crm');
  assert.equal(p.columns['Email'].field, 'email');
  assert.equal(p.columns['Contact owner'].field, 'owner');
  assert.equal(p.columns['Lifecycle Stage'].field, 'status');
  assert.equal(p.columns['Lead Status'].field, 'status_2');
  assert.equal(p.columns['Unsubscribed from all email'].field, 'opted_out');
  assert.equal(p.columns['Unsubscribed from all email'].sense, 'optout');
  assert.equal(p.columns['Hobby'].field, 'ignore');
  assert.deepEqual(p.columns['Hobby'].samples, ['chess', 'golf']);
  assert.equal(p.columns['Last Contacted'].date_order, 'dmy', 'a 25th fixes the order for every date column');
  assert.equal(p.columns['Close Date'].date_order, 'dmy');
  const st = Object.fromEntries(p.status_values.map((s) => [s.value, s.proposed]));
  assert.deepEqual(st, { Customer: 'customer', Open: 'ignore', Lead: 'ignore', 'Attempted to contact': 'ignore', Opportunity: 'warm', 'Closed Lost': 'lost' });
  assert.deepEqual(p.stop_like_cells.map((x) => [x.column, x.stop_rows]), [['Misc Field 7', 1]]);
  assert.equal(fingerprint(headers), fingerprint(headers.map((h) => h.toUpperCase())), 'the fingerprint ignores case and punctuation');
  assert.notEqual(fingerprint(headers), fingerprint(headers.slice(1)));
});

test('applyMapping: dates in the confirmed order, a won date only on customer rows, stop notes from any column, placeholders are not a deal', () => {
  const { headers, records } = readCsvText(CRM);
  const m = propose(headers, records, 'crm');
  const rows = applyMapping(records, m);
  assert.equal(rows[0].last_contact, '2026-08-25');
  assert.equal(rows[0].won_at, '2026-08-01');
  assert.equal(rows[0].on_won_deal, true);
  assert.equal(rows[1].stop_note, 'Candidate asked never to be contacted again');
  assert.deepEqual(rows[1].meanings, ['ignore', 'ignore']);
  assert.equal(rows[2].won_at, null, 'a lost deal has a close date but is not won');
  assert.equal(rows[2].opted_out, true);
  assert.equal(applyMapping([{ ...records[0], 'Associated Deal': '—' }], m)[0].on_won_deal, false);
});

test('validateMapping: refuses what would make floorboss guess later', () => {
  const { headers, records } = readCsvText(CRM);
  const m = propose(headers, records, 'crm');
  assert.deepEqual(validateMapping(m), []);
  const noOpt = { ...m, columns: { ...m.columns, 'Unsubscribed from all email': { field: 'ignore' } } };
  assert.match(validateMapping(noOpt).join(';'), /no opt-out column/);
  assert.deepEqual(validateMapping({ ...noOpt, opt_out_none: true }), []);
  assert.match(validateMapping({ ...m, values: { status: { ...m.values.status, Open: 'maybe' } } }).join(';'), /isn't one of/);
  assert.match(validateMapping({ ...m, columns: { ...m.columns, Hobby: { field: 'email' } } }).join(';'), /two columns are mapped to email/);
  assert.match(validateMapping({ kind: 'attendees', columns: { Name: { field: 'name' } } }).join(';'), /no company column/);
});

test('defaultStatusMeaning, optedOut and parseDate', () => {
  assert.equal(defaultStatusMeaning('Do not contact'), 'do_not_contact');
  assert.equal(defaultStatusMeaning('Compliance hold - tender'), 'hold');
  assert.equal(defaultStatusMeaning('No-poach partner'), 'hold');
  assert.equal(defaultStatusMeaning('Partner'), 'coordinate');
  assert.equal(defaultStatusMeaning('Closed Won'), 'customer');
  assert.equal(defaultStatusMeaning('Negotiation'), 'warm');
  assert.equal(defaultStatusMeaning('Attempted to contact'), 'ignore');
  assert.equal(defaultStatusMeaning('Zebra'), null);
  assert.equal(optedOut('false', 'optout'), false);
  assert.equal(optedOut('Unsubscribed (2024)', 'optout'), true);
  assert.equal(optedOut('', 'consent'), true, 'with a consent column, no answer is no consent');
  assert.equal(optedOut('yes', 'consent'), false);
  assert.equal(parseDate('01/08/2026', 'dmy'), '2026-08-01');
  assert.equal(parseDate('01/08/2026', 'mdy'), '2026-01-08');
  assert.equal(parseDate('25/08/26', null), '2026-08-25');
});
