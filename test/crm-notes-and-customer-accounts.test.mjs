// What the CRM says reaches the drafter and the critic. The simulated tester's export (invented, with .example addresses): someone
// at a customer account with no record of their own writes as to a customer from the account fact ("your
// customer Vandermolen Logistics"), not from their title alone; a record's note ("interested in carrier
// check-in") is in its crm_summary; the account row's note ("trialled our dock scheduler in 2025 at their
// Leeds DC") is in the account note of everyone there. Drafts quoting them pass floorboss's checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, cli, todoJobs, idOf, fitAll } from './fixtures/harness.mjs';

const CRM = `Contact Name,Email,Company,Job Title,Deal Stage,Contact Owner,Last Activity,Notes
Marco Bellini,m.bellini@castellafoods.example,Castella Foods,Director of Distribution,Customer,Jordan Lee,2026-09-18,Live on dock scheduling at 3 DCs since 2025; renewal March 2027
Hannah Brooks,hannah.brooks@vandermolen.example,Vandermolen Logistics,COO,Customer,Jordan Lee,2026-08-02,Went live on yard module in June; asked about carrier portal
,,Pellworth Grocers,,Prospect,Jordan Lee,2026-05-14,Account note: trialled our dock scheduler in 2025 at their Leeds DC; paused when the project lead left
Sofia Lindqvist,sofia.lindqvist@nordkaphome.example,Nordkap Home,Logistics Director,Lead,Jordan Lee,2026-07-01,Met at LogiFair; interested in carrier check-in
Lukas Weber,lukas.weber@alpenmarkt.example,Alpenmarkt,DC Manager,Unsubscribed,Jordan Lee,2025-11-20,Asked to stop emails
`;
const LIST = `Name,Title,Company,Email
Hannah Brooks,COO,Vandermolen Logistics,hannah.brooks@vandermolen.example
Ruben Vandermolen,IT Manager,Vandermolen Logistics,ruben@vandermolen.example
Amira Haddad,Director of Operations,Pellworth Grocers,amira.haddad@pellworth.example
Sofia Lindqvist,Logistics Director,Nordkap Home,sofia.lindqvist@nordkaphome.example
`;
const RULE = { recent_months: 6, recent: 'warm', on_deal: 'warm', other: 'warm' };

function ready() {
  const H = setup({ attendees: LIST, crm: CRM, settings: { crm_user_name: 'Jordan Lee', crm_accounts: 'apply', customer_rule: RULE } });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.ok(!load.ERROR, load.ERROR);
  fitAll(H, load);
  assert.ok(!cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'ok']).ERROR);
  const r = todoJobs(H);
  const job = (name) => r.jobs.find((x) => x.id === idOf(H, name) && x.kind === 'message');
  return { H, ...r, job };
}
const save = (H, j, body, fs, t) => cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', '1', '--json', JSON.stringify({ subject: 'Test Expo', body: `${body} Could you do ${j.slot_labels.join(' or ')} at Test Expo?\n\nBest, Sam\n\n${t.optout_sentence}`, brief: 'x', structure: 'plain-request', fact_source: fs })]);
const critic = (H, j) => cli(H, 'event-outreach', ['critic-batch', '--event', H.slug, '--ids', `${j.id}:1`, '--compact']).drafts[0].input;

test('a colleague at a customer account with no CRM row of their own gets the account fact, and a draft from it passes', () => {
  const { H, t, job } = ready();
  const ruben = job('Ruben Vandermolen');
  assert.ok(ruben, 'Ruben is drafted');
  assert.match(ruben.account_note || '', /^your customer Vandermolen Logistics \(CRM: "Customer"\)/);
  assert.ok(ruben.fact_sources.includes('account'), ruben.fact_sources.join(','));
  assert.equal(ruben.crm_summary, null, 'no record of his own');
  const saved = save(H, ruben, 'Hi Ruben, Vandermolen already runs on our dock scheduling, so I wanted to hear what your systems need from it next.', 'account', t);
  assert.equal(saved.checks, 'pass', JSON.stringify(saved));
  assert.match(critic(H, ruben).account_note, /your customer Vandermolen Logistics/);
});

test('a CRM record\'s note is in crm_summary.notes, for the drafter and the critic', () => {
  const { H, t, job } = ready();
  const sofia = job('Sofia Lindqvist'), hannah = job('Hannah Brooks');
  assert.equal(sofia.crm_summary.notes, 'Met at LogiFair; interested in carrier check-in');
  assert.equal(hannah.crm_summary.notes, 'Went live on yard module in June; asked about carrier portal');
  assert.match(hannah.account_note || '', /your customer Vandermolen Logistics/, 'her own record and the account both');
  const saved = save(H, sofia, 'Hi Sofia, you mentioned carrier check-in when we met at LogiFair, and it is what our gate tablets do.', 'crm', t);
  assert.equal(saved.checks, 'pass', JSON.stringify(saved));
  assert.equal(critic(H, sofia).crm_summary.notes, 'Met at LogiFair; interested in carrier check-in');
});

test('the account row\'s note is in the account note of someone there, and a draft quoting it passes', () => {
  const { H, t, job } = ready();
  const amira = job('Amira Haddad');
  assert.ok(amira, 'Amira is drafted');
  assert.match(amira.account_note, /^at your account Pellworth Grocers \(Prospect\); the CRM's note on the account: "trialled our dock scheduler in 2025 at their Leeds DC; paused when the project lead left"$/);
  const saved = save(H, amira, 'Hi Amira, Pellworth trialled our dock scheduler at your Leeds DC in 2025, and I would like to hear whether it is worth another look.', 'account', t);
  assert.equal(saved.checks, 'pass', JSON.stringify(saved));
  assert.match(critic(H, amira).account_note, /trialled our dock scheduler in 2025 at their Leeds DC/);
});
