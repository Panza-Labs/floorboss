// How long a lost deal or a rejection keeps someone out is the user's call, asked at setup with the people it
// covers named: 3, 6 or 12 months since the last contact, their own number, or no wait (0). Skipped, it is 6.
// Invented people at .example and .test domains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from '../skills/crm-triage/scripts/resolve.mjs';
import { gatherEvidence, indexCrm } from '../skills/crm-triage/scripts/evidence.mjs';
import { applyMapping, propose } from '../skills/crm-triage/scripts/sources.mjs';
import { readCsvText } from '../lib/csv.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { untilStep } from './fixtures/flow-until.mjs';
import { ftu6Flow, CRM } from './fixtures/ftu6.mjs';

const TODAY = '2026-10-12';
const HEAD = 'Name,Email,Company,Owner,Status,Last Contacted,Close Date,Associated Deal,Rejected Date,Notes,Unsubscribed\n';
const ana = { id: 'c001', name: 'Ana Berg', title: 'COO', company: 'Acme', company_key: 'acme', email: 'ana@acme.test', emails: ['ana@acme.test'], profile_url: '', contact_opt_in: '' };
const crmOf = (row) => { const { headers, records } = readCsvText(HEAD + row); return indexCrm(applyMapping(records, propose(headers, records, 'crm'))); };
const groupAt = (months, row) => {
  const settings = { crm_user_name: 'Sam Rivera', own_domains: ['lanecraft.example'], ...(months == null ? {} : { rejected_months: months }) };
  return resolve(ana, gatherEvidence(ana, { today: TODAY, crmIndex: crmOf(row) }), { settings, today: TODAY, fit: { segment: 'ops', reason: 'COO', score: 80 } });
};

test('a lost deal four months ago: held at 6 or 12 months, fair to approach at 3 or with no wait; 6 when never asked', () => {
  const lost = 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Closed Lost,2026-06-10,,,,,false\n';
  assert.equal(DEFAULTS.rejected_months, 6);
  assert.equal(groupAt(12, lost).group, 'skip');
  assert.equal(groupAt(6, lost).group, 'skip');
  assert.match(groupAt(null, lost).says, /within 6 months/);
  assert.equal(groupAt(3, lost).group, 'reach');
  assert.equal(groupAt(0, lost).group, 'reach');
  // No date on a lost deal holds at any wait but none; a dated rejection follows the same wait.
  const undated = 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Closed Lost,,,,,,false\n';
  assert.equal(groupAt(3, undated).group, 'skip');
  assert.equal(groupAt(0, undated).group, 'reach');
  const rejected = 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Prospect,,,,2026-08-01,,false\n';
  assert.equal(groupAt(6, rejected).group, 'skip');
  assert.equal(groupAt(0, rejected).group, 'reach');
});

test('the lost-deals question names who on the list it covers, and the answer is saved as months', async () => {
  const { H, persona } = ftu6Flow();
  // Marco's lost deal is at Pickpack but he isn't on the list; Henrik, who is, has one too.
  writeFileSync(join(H.HOME, 'work', 'crm.csv'), CRM + 'Henrik Stahl,henrik@pickpack.example,Pickpack,Ines Moreau,Closed Lost,Lost on price\n');
  const at = untilStep(H, persona, (s) => s.ask?.id === 'lost_deals');
  assert.match(at.last.ask.question, /The count: 1 person on the list: Henrik Stahl \(lost deal, no date\)\./);
  const { makeHome, cli } = await import('./sims/lib/driver.mjs');
  const home = makeHome({});
  const f = join(home.HOME, 'work', 'l.json');
  const said = (v) => { writeFileSync(f, JSON.stringify(v)); return cli(home, 'flow', ['answer', '--ask', 'lost_deals', '--value-file', f]); };
  const months = () => JSON.parse(readFileSync(join(home.HOME, 'config.json'), 'utf8')).rejected_months;
  for (const [v, want] of [['3 months', 3], ['6 months (recommended)', 6], ['12 months', 12], ['no wait: approach them like anyone else', 0], ['about 9 months', 9], ['2 years', 24]]) {
    said(v);
    assert.equal(months(), want, v);
  }
  assert.ok(said('whenever').ERROR, 'an answer with no length is asked again');
  assert.equal(months(), 24, 'and changes nothing');
});
