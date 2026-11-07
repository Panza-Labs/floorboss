// One person, one contact: duplicates on the list are merged before anything else looks at them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRows, assignIds, personKeys } from '../skills/crm-triage/scripts/merge.mjs';

const row = (line, name, company, email = '', extra = {}) => ({ line, name, company, email, title: '', profile_url: '', phone: '', notes: '', location: '', booth: '', attendee_type: '', contact_opt_in: '', ...extra });

test('merge: same address, same name at a related company, nickname, initial, typo; a shared inbox stays apart', () => {
  const { contacts, visit, skipped } = mergeRows([
    row(2, 'Jonathan Dalgaard', 'Acme', 'jon@acme.test'),
    row(3, 'Jon Dalgaard', 'Acme Freight', 'jonathan.dalgaard@gmail.test'),
    row(4, 'J. Dalgaard', 'Acme', ''),
    row(5, 'Wei Zhang', 'Globex', 'wei@globex.test', { title: 'COO' }),
    row(6, 'Wie Zhang', 'Globex', ''),
    row(7, 'Ana Berg', 'Initech', 'info@initech.test'),
    row(8, 'Bo Li', 'Initech', 'info@initech.test'),
    row(9, '', 'Umbrella'),
    row(10, 'Nobody', ''),
  ]);
  const names = contacts.map((c) => c.name).sort();
  assert.deepEqual(names, ['Ana Berg', 'Bo Li', 'Jonathan Dalgaard', 'Wei Zhang']);
  const jon = contacts.find((c) => c.name === 'Jonathan Dalgaard');
  assert.deepEqual(jon.lines, [2, 3, 4]);
  assert.equal(jon.email, 'jon@acme.test', 'the work address represents them');
  assert.deepEqual(jon.emails.sort(), ['jon@acme.test', 'jonathan.dalgaard@gmail.test']);
  assert.ok(jon.merge_why.length >= 2, JSON.stringify(jon.merge_why));
  const wei = contacts.find((c) => c.name === 'Wei Zhang');
  assert.deepEqual(wei.lines, [5, 6]);
  assert.equal(wei.title, 'COO');
  assert.deepEqual(visit.map((v) => v.company), ['Umbrella']);
  assert.deepEqual(skipped.map((s) => s.line), [10]);
});

test('merge: the same name at two unrelated companies stays two people; a "no" to contact wins', () => {
  const { contacts } = mergeRows([
    row(2, 'Sam Park', 'Acme', 'sam@acme.test', { contact_opt_in: 'yes' }),
    row(3, 'Sam Park', 'Zeta Bank', 'sam@zeta.test'),
    row(4, 'Sam Park', 'Acme', '', { contact_opt_in: 'no' }),
  ]);
  assert.equal(contacts.length, 2);
  assert.equal(contacts.find((c) => c.company === 'Acme').contact_opt_in, 'no');
});

test('assignIds: ids are stable across loads, new rows get new ids, two earlier ids that turn out to be one person merge', () => {
  const first = mergeRows([row(2, 'Ana Berg', 'Acme', 'ana@acme.test'), row(3, 'Bo Li', 'Globex', 'bo@globex.test')]);
  const a = assignIds(first.contacts, {});
  assert.deepEqual(a.contacts.map((c) => c.id), ['c001', 'c002']);
  assert.equal(a.entries.length, 2);
  const people = Object.fromEntries(a.entries.map((e) => [e.id, { keys: e.keys, name: e.name, email: e.email }]));
  // Next load: Ana under a new address, Bo gone, Cy new.
  const second = mergeRows([row(2, 'Ana Berg', 'Acme', 'ana.berg@acme.test'), row(3, 'Cy Ng', 'Initech', 'cy@initech.test')]);
  const b = assignIds(second.contacts, people);
  assert.deepEqual(b.contacts.map((c) => c.id), ['c001', 'c003'], 'Ana keeps her id by name+company; Cy is new');
  assert.ok(b.entries.some((e) => e.id === 'c001' && e.keys.includes('e:ana.berg@acme.test')), 'the new key is recorded');
  // A later list shows c001 and c002 were one person all along.
  const people2 = { c001: { keys: ['e:ana@acme.test', 'n:ana berg|acme'] }, c002: { keys: ['e:ana.b@acme.test', 'n:ana berg|acme freight'] } };
  const third = mergeRows([row(2, 'Ana Berg', 'Acme', 'ana@acme.test'), row(3, 'Ana Berg', 'Acme Freight', 'ana.b@acme.test')]);
  const c = assignIds(third.contacts, people2);
  assert.equal(c.contacts.length, 1);
  assert.equal(c.contacts[0].id, 'c001');
  assert.deepEqual(c.merges.map((m) => [m.id, m.into]), [['c002', 'c001']]);
  assert.ok(personKeys(c.contacts[0]).includes('n:ana berg|acme'));
});

test('a shared inbox never gives two people one id, on the first load or a reordered second one', () => {
  const rows = [{ line: 2, name: 'Ann Lee', company: 'Acme Freight', email: 'sales@acmefreight.test' }, { line: 3, name: 'Bob Kim', company: 'Acme Freight', email: 'sales@acmefreight.test' }];
  const a = assignIds(mergeRows(rows).contacts, {});
  assert.deepEqual(a.contacts.map((c) => c.id), ['c001', 'c002']);
  const people = Object.fromEntries(a.entries.map((e) => [e.id, { keys: e.keys, name: e.name, email: e.email }]));
  const b = assignIds(mergeRows([rows[1], rows[0]]).contacts, people);
  assert.deepEqual(b.contacts.map((c) => `${c.name}=${c.id}`), ['Bob Kim=c002', 'Ann Lee=c001']);
  assert.equal(b.merges.length, 0);
});
