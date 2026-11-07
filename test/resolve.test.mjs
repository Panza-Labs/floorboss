// One ladder for who a person is to the sender. One fixture per rung, then the precedence table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, sameHolder } from '../skills/crm-triage/scripts/resolve.mjs';
import { gatherEvidence, indexCrm, accountOwner, accountsFromCrm, readAccounts } from '../skills/crm-triage/scripts/evidence.mjs';
import { shortlist, mustMeetReport } from '../skills/crm-triage/scripts/shortlist.mjs';
import { applyMapping, propose } from '../skills/crm-triage/scripts/sources.mjs';
import { readCsvText } from '../lib/csv.mjs';
import { parseDncReport } from '../skills/crm-triage/scripts/dnc.mjs';

const TODAY = '2026-10-12';
const contact = (over = {}) => ({ id: 'c001', name: 'Ana Berg', title: 'COO', company: 'Acme', company_key: 'acme', email: 'ana@acme.test', emails: ['ana@acme.test'], profile_url: '', contact_opt_in: '', ...over });
const crmRows = (csv) => { const { headers, records } = readCsvText(csv); return applyMapping(records, propose(headers, records, 'crm')); };
const settings = { crm_user_name: 'Sam Rivera', own_domains: ['lanecraft.example'], own_company: 'Lanecraft', rejected_months: 12, customer_rule: { recent_months: 6, recent: 'hold', on_deal: 'warm', other: 'ask' } };
const run = (c, inputs = {}, ctx = {}) => resolve(c, gatherEvidence(c, { today: TODAY, ...inputs }), { settings, today: TODAY, fit: { segment: 'ops', reason: 'COO', score: 80 }, ...ctx });
const HEAD = 'Name,Email,Company,Owner,Status,Last Contacted,Close Date,Associated Deal,Rejected Date,Notes,Unsubscribed\n';

test('rung by rung', () => {
  // a stranger who fits
  assert.equal(run(contact()).group, 'reach');
  // 1 user decision beats the holds they saw when deciding; a hold that appears later holds again
  const dnc = parseDncReport('ana@acme.test').entries;
  const held = run(contact(), { dnc });
  assert.equal(run(contact(), { dnc }, { decision: { group: 'reach', because: 'she asked me to write', seen_holds: [held.says] } }).group, 'reach');
  const later = run(contact(), { dnc }, { decision: { group: 'reach', because: 'she asked me to write', seen_holds: [] } });
  assert.equal(later.group, 'skip');
  assert.match(later.says, /new since you said reach/);
  // a match answer never replaces a skip
  assert.equal(run(contact(), {}, { decision: { group: 'skip', because: 'never again' }, matches: [{ group: 'same-person', ref: 'crm:3' }] }).group, 'skip');
  // 2 do not contact
  assert.match(run(contact(), { dnc: parseDncReport('ana@acme.test').entries }).says, /do-not-contact/);
  assert.equal(run(contact({ email: 'ana@lanecraft.example', emails: ['ana@lanecraft.example'] })).says, 'your own company');
  assert.equal(run(contact({ contact_opt_in: 'No' })).group, 'skip');
  // 3 off-limits account covers everyone there
  const accounts = readAccounts(readCsvText('Company,Owner,Status\nAcme,Partnerships,no-poach partner\n'));
  assert.match(run(contact(), { accounts }).says, /off-limits/);
  // 4 opted out / stop note / do-not-contact status
  assert.equal(run(contact(), { crmIndex: indexCrm(crmRows(HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Customer,,,,,,true\n')) }).says, 'opted out in the CRM');
  assert.match(run(contact(), { crmIndex: indexCrm(crmRows(HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Lead,,,,,Candidate asked never to be contacted again,false\n')) }).says, /CRM note/);
  assert.equal(run(contact(), { crmIndex: indexCrm(crmRows(HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Lead,,,,,Added from a talk list; never contacted.,false\n')) }).group, 'reach', '"never contacted" is a fact, not a request');
  // 5 rejected within the window, not after
  assert.equal(run(contact(), { crmIndex: indexCrm(crmRows(HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Rejected,,,,2026-06-01,,false\n')) }).group, 'skip');
  assert.equal(run(contact(), { crmIndex: indexCrm(crmRows(HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Rejected,,,,2025-06-01,,false\n')) }).group, 'reach', 'an old rejection no longer holds');
  // 6 colleague holds the record; the user's own record does not
  const col = run(contact(), { crmIndex: indexCrm(crmRows(HEAD + 'Ana Berg,ana@acme.test,Acme,Dana Teammate,Lead,,,,,,false\n')) });
  assert.deepEqual([col.group, col.holder], ['colleague', 'Dana Teammate']);
  assert.equal(run(contact(), { crmIndex: indexCrm(crmRows(HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Lead,,,,,,false\n')) }).group, 'reach');
  // 7 customer rule
  assert.equal(run(contact(), { crmIndex: indexCrm(crmRows(HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Customer,,2026-08-01,Acme renewal,,,false\n')) }).group, 'skip', 'recent → hold');
  assert.equal(run(contact(), { crmIndex: indexCrm(crmRows(HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Customer,,2024-08-01,Acme renewal,,,false\n')) }).group, 'warm', 'on the deal → warm');
  assert.equal(run(contact(), { crmIndex: indexCrm(crmRows(HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Customer,,2024-08-01,—,,,false\n')) }).group, 'check', 'someone else there → ask');
  // 8 in touch
  assert.equal(run(contact(), { known: [{ name: 'Ana Berg', email: 'ana@acme.test', company: 'Acme', company_key: 'acme', source: 'your contacts' }] }).group, 'in_touch');
  // 9 warm by two-way status; not by a one-way status with a date
  assert.equal(run(contact(), { crmIndex: indexCrm(crmRows(HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Negotiation,2026-09-20,,,,,false\n')) }).group, 'warm');
  assert.equal(run(contact(), { crmIndex: indexCrm(crmRows(HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Attempted to contact,2026-09-20,,,,,false\n')) }).group, 'reach');
  // 10 fit
  assert.equal(run(contact(), {}, { fit: { segment: null, reason: 'a student' } }).group, 'unfit');
  assert.equal(run(contact(), {}, { fit: null }).group, 'unjudged');
  // 11 no email
  assert.equal(run(contact({ email: '', emails: [] }), {}).group, 'unreachable');
});

test('fuzzy evidence never decides: the answer is check with every alternative listed', () => {
  const idx = indexCrm(crmRows(HEAD + 'Anna Berg,anna@acme.test,Acme,Dana Teammate,Customer,,,,,,true\n'));
  const r = run(contact({ email: 'a.berg@acme.test', emails: ['a.berg@acme.test'] }), { crmIndex: idx });
  assert.equal(r.group, 'check');
  assert.ok(r.alternatives.some((a) => a.rung === 'crm_match' && /near name/.test(a.says)), JSON.stringify(r.alternatives));
  // the user settles it: same person → the record applies (opted out → skip); different → a stranger who fits
  assert.equal(run(contact({ email: 'a.berg@acme.test', emails: ['a.berg@acme.test'] }), { crmIndex: idx }, { decision: { group: 'same-person', ref: 'crm:0' } }).group, 'skip');
  assert.equal(run(contact({ email: 'a.berg@acme.test', emails: ['a.berg@acme.test'] }), { crmIndex: idx }, { decision: { group: 'different-person', ref: 'all' } }).group, 'reach');
  // the same LinkedIn link under another name is a question, not a match
  const idx2 = indexCrm(crmRows(HEAD.replace('Notes', 'LinkedIn URL') + 'Anna Keller,anna@k.test,Volt,,Rejected,,,,2026-06-01,https://www.linkedin.com/in/anna-keller-example,false\n'));
  const r2 = run(contact({ name: 'Matteo Rossi', profile_url: 'https://linkedin.com/in/anna-keller-example', email: 'm@v.test', emails: ['m@v.test'] }), { crmIndex: idx2 });
  assert.equal(r2.group, 'check');
  assert.match(r2.says, /same LinkedIn link as Anna Keller/);
  // an exact skip is not turned into a question by fuzzy evidence
  assert.equal(run(contact({ contact_opt_in: 'No' }), { crmIndex: idx }).group, 'skip');
});

test('a bare match answer settles: different-person dismisses every uncertain match, same-person takes the one there is', () => {
  const idx = indexCrm(crmRows(HEAD + 'Anna Berg,anna@acme.test,Acme,Dana Teammate,Customer,,,,,,true\n'));
  const ana = contact({ email: 'a.berg@acme.test', emails: ['a.berg@acme.test'] });
  assert.equal(run(ana, { crmIndex: idx }, { decision: { group: 'different-person', ref: null } }).group, 'reach');
  assert.equal(run(ana, { crmIndex: idx }, { matches: [{ group: 'different-person' }] }).group, 'reach');
  assert.equal(run(ana, { crmIndex: idx }, { decision: { group: 'same-person', ref: null } }).group, 'skip', 'the one record, which opted out');
});

test('a lost deal by its CRM status: left alone within rejected_months of the last contact, fair to approach after', () => {
  const at = (date) => indexCrm(crmRows(HEAD + `Ana Berg,ana@acme.test,Acme,Sam Rivera,Closed Lost,${date},,,,,false\n`));
  const recent = run(contact(), { crmIndex: at('2026-03-02') });
  assert.equal(recent.group, 'skip', recent.says);
  assert.match(recent.says, /Closed Lost.*within 12 months/);
  assert.equal(run(contact(), { crmIndex: at('2024-05-02') }).group, 'reach');
  assert.equal(run(contact(), { crmIndex: at('') }).group, 'skip', 'no date: it could be last week');
  assert.equal(run(contact(), { crmIndex: at('2026-10-01') }).group, 'check', 'in touch since: the user decides');
});

test('precedence: the first rung wins and the rest are alternatives', () => {
  const idx = indexCrm(crmRows(HEAD + 'Ana Berg,ana@acme.test,Acme,Dana Teammate,Customer,2026-09-01,2026-08-01,Acme renewal,,,true\n'));
  const r = run(contact(), { crmIndex: idx });
  assert.deepEqual([r.group, r.rung], ['skip', 'opted_out']);
  assert.deepEqual(r.alternatives.map((a) => a.rung), ['colleague', 'customer_rule', 'warm', 'fit']);
});

test('account owner is the majority of active records, tie broken by recency; never the last row', () => {
  const rows = crmRows(HEAD + 'A,a@x.test,Veldhuis,Dana Teammate,Negotiation,2026-01-01,,,,,false\nB,b@x.test,Veldhuis,Dana Teammate,Negotiation,2026-02-01,,,,,false\nC,c@x.test,Veldhuis,Tom Other,Negotiation,2026-09-01,,,,,false\n');
  assert.equal(accountOwner(rows).owner, 'Dana Teammate');
  const tie = crmRows(HEAD + 'A,a@x.test,Veldhuis,Dana Teammate,Negotiation,2026-01-01,,,,,false\nC,c@x.test,Veldhuis,Tom Other,Negotiation,2026-09-01,,,,,false\n');
  assert.equal(accountOwner(tie).owner, 'Tom Other');
  const acc = accountsFromCrm(rows, { ownerIsUser: (n) => sameHolder(n, 'Sam Rivera') });
  assert.deepEqual([acc[0].owner, acc[0].records, acc[0].of], ['Dana Teammate', 2, 3]);
  const nia = run(contact({ name: 'Nia Park', email: 'nia@veldhuis.test', emails: ['nia@veldhuis.test'], company: 'Veldhuis', company_key: 'veldhuis' }), { accounts: acc }, { settings: { ...settings, crm_accounts: 'apply' } });
  assert.deepEqual([nia.group, nia.holder], ['colleague', 'Dana Teammate']);
});

test('shortlist: keep N and caps never drop a must-meet or someone the user said to reach', () => {
  const NAMES = ['Ana Berg', 'Bo Li', 'Cy Ng', 'Di Fox', 'Ed Oak', 'Fay Wu'];
  const contacts = NAMES.map((name, i) => contact({ id: `c00${i + 1}`, name, email: `p${i + 1}@acme.test`, company: 'Acme', company_key: 'acme' }));
  const resolved = Object.fromEntries(contacts.map((c) => [c.id, { group: 'reach' }]));
  const fits = Object.fromEntries(contacts.map((c, i) => [c.id, { segment: 'ops', score: 90 - i }]));
  const mm = mustMeetReport([{ text: 'Fay Wu', segment: null }], contacts, resolved);
  assert.deepEqual([...mm.pinned], ['c006']);
  // Pinned people are never cut, and they take places under the company cap ("cap Acme at 3" is three in all).
  const s = shortlist({ contacts, resolved, fits, settings: { account_cap: 3 }, keep: { top: 3 }, caps: {}, pinned: mm.pinned, decisions: { c005: 'reach' } });
  assert.deepEqual(s.ranked, ['c005', 'c006', 'c001'], 'pinned first, then the best stranger the cap leaves room for');
  const tight = shortlist({ contacts, resolved, fits, settings: { account_cap: 1 }, keep: { top: 2 }, caps: {}, pinned: mm.pinned, decisions: { c005: 'reach' } });
  assert.deepEqual(tight.ranked, ['c005', 'c006'], 'a cap below the pinned count still keeps every pinned person');
  // "keep N" is N people in all: pinned people take places too, and only go over N when there are more of them.
  const loose = shortlist({ contacts, resolved, fits, settings: { account_cap: 10 }, keep: { top: 3 }, caps: {}, pinned: mm.pinned, decisions: { c005: 'reach' } });
  assert.deepEqual(loose.ranked, ['c005', 'c006', 'c001'], 'keep N is the total');
  assert.equal(loose.kept_line, '3 kept (keep 3)');
  const one = shortlist({ contacts, resolved, fits, settings: { account_cap: 10 }, keep: { top: 1 }, caps: {}, pinned: mm.pinned, decisions: { c005: 'reach' } });
  assert.deepEqual(one.ranked, ['c005', 'c006'], 'pinned people are never cut');
  assert.match(one.kept_line, /^1 kept \+ 1 must-meet or chosen by you/);
  assert.ok(s.held.some((h) => h.id === 'c003' && /cap|limit/.test(h.why)));
  const s2 = shortlist({ contacts, resolved: { ...resolved, c006: { group: 'skip', says: 'opted out' } }, fits, settings: {}, keep: null, caps: {}, pinned: mm.pinned });
  assert.deepEqual(s2.pinned_out.map((p) => [p.id, p.group]), [['c006', 'skip']], 'a pinned person who cannot be reached is said out loud');
});

test('an owner written as a first name only is the user, unless a colleague shares that first name', async () => {
  const { ownerIsUserFor } = await import('../skills/crm-triage/scripts/resolve.mjs');
  const me = ownerIsUserFor({ crm_user_name: 'Rosa Costa', colleagues: ['Theo Brennan'] });
  assert.equal(me('Rosa'), true);
  assert.equal(me('Rosa Costa'), true);
  assert.equal(me('Theo'), false);
  assert.equal(me('Rosa Lima'), false);
  assert.equal(ownerIsUserFor({ crm_user_name: 'Rosa Costa', colleagues: ['Rosa Lima'] })('Rosa'), false, 'two Rosas: a first name alone could be either');
});
