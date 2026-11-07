// People per company by size: a size column wins, then Claude's guess; the user's scale or numbers decide
// how many; a cap the user names still wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandOf, parseScale, scaleOf, companySizes, SCALES } from '../skills/crm-triage/scripts/sizes.mjs';
import { capFor } from '../skills/crm-triage/scripts/shortlist.mjs';
import { propose } from '../skills/crm-triage/scripts/sources.mjs';

test('size cells as exports write them', () => {
  assert.equal(bandOf('1-10'), 'micro');
  assert.equal(bandOf('11-50'), 'small');
  assert.equal(bandOf('51-200'), 'mid');
  assert.equal(bandOf('1,001-5,000'), 'large');
  assert.equal(bandOf('10000+'), 'enterprise');
  assert.equal(bandOf('250k'), 'enterprise');
  assert.equal(bandOf('Enterprise'), 'enterprise');
  assert.equal(bandOf('KMU'), 'small');
  assert.equal(bandOf(''), null);
  assert.equal(propose(['Name', 'Company', 'Number of Employees'], [], 'crm').columns['Number of Employees'].field, 'company_size');
  assert.equal(propose(['Name', 'Firma', 'Anzahl Mitarbeiter'], [], 'attendees').columns['Anzahl Mitarbeiter'].field, 'company_size');
});

test('the scale: the user picks one, gives numbers, or caps flat; a named company cap wins', () => {
  assert.equal(capFor('acme', {}, {}, 'micro'), 1);
  assert.equal(capFor('acme', {}, {}, 'enterprise'), 5);
  assert.equal(capFor('acme', {}, {}, null), 2, 'unknown size');
  assert.equal(capFor('acme', { company_caps: { mode: 'one' } }, {}, 'enterprise'), 1);
  assert.equal(capFor('acme', { company_caps: { mode: 'teams' } }, {}, 'enterprise'), 8);
  assert.equal(capFor('acme', { company_caps: { mode: 'off' } }, {}, 'micro'), Infinity);
  assert.equal(capFor('acme', { company_caps: { scale: parseScale('small 1, mid 2, large 4, enterprise 6') } }, {}, 'large'), 4);
  assert.equal(capFor('acme', {}, { '*': 3 }, 'micro'), 3, 'the user\'s "cap 3" for every company');
  assert.equal(capFor('acme', {}, { '*': 3, acme: 7 }, 'micro'), 7, 'a cap for this company wins');
  assert.deepEqual(parseScale('2 per company'), Object.fromEntries(Object.keys(SCALES.scale).map((k) => [k, 2])));
  assert.equal(parseScale('whatever you think'), null);
  assert.equal(scaleOf({ company_caps: 'off' }), null);
});

test('company sizes: a column beats a guess; the most common guess among a company\'s people counts', () => {
  const contacts = [{ id: 'c1', company_key: 'big bank' }, { id: 'c2', company_key: 'big bank' }, { id: 'c3', company_key: 'shop', company_size: '4' }];
  const fits = { c1: { company_size: 'enterprise' }, c2: { company_size: 'enterprise' }, c3: { company_size: 'large' } };
  const s = companySizes({ contacts, fits, crmRows: [] });
  assert.deepEqual(s['big bank'], { band: 'enterprise', from: 'judged' });
  assert.deepEqual(s.shop, { band: 'micro', from: 'list' });
});
