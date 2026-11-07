// Someone with only an account note (the user works with their company; no CRM history of their own) gets
// "account" as a fact source, never "crm": the checks refuse "crm" for them and take "account".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, cli, triage, todoJobs, idOf } from './fixtures/harness.mjs';
import { factSources, FACT_SOURCES } from '../skills/event-outreach/scripts/structures.mjs';

const CRM = 'First Name,Last Name,Email,Company,Deal Owner,Stage,Last Activity Date,Email Opt Out\nGrace,Liu,grace.liu@pebbleway.example,Pebbleway,Sam Rivera,Opportunity,09/28/2026,No\n';
const LIST = 'Name,Title,Company,Email\nGrace Liu,Head of Finance,Pebbleway,grace.liu@pebbleway.example\nNoah Schmidt,Treasury Manager,Pebbleway,noah.schmidt@pebbleway.example\n';

test('factSources: crm needs a CRM summary; an account note alone is "account"', () => {
  assert.ok(FACT_SOURCES.includes('account'));
  const base = { contact: { title: 'COO', company: 'Acme' } };
  assert.deepEqual(factSources({ ...base, account_note: 'at your account Acme (Opportunity)' }), ['account', 'list']);
  assert.deepEqual(factSources({ ...base, crm_summary: { status: 'Opportunity' }, account_note: 'at your account Acme' }), ['crm', 'account', 'list']);
});

test('a draft for someone at the user\'s account: "crm" is refused, "account" is taken', () => {
  const H = setup({ attendees: LIST, crm: CRM, settings: { crm_accounts: 'apply' } });
  assert.ok(!triage(H).load.ERROR);
  const noah = idOf(H, 'Noah Schmidt');
  const { t, jobs } = todoJobs(H);
  const j = jobs.find((x) => x.id === noah && x.kind === 'message');
  assert.ok(j.account_note, JSON.stringify(j).slice(0, 300));
  assert.deepEqual(j.fact_sources, ['account', 'list']);
  const body = `Hi Noah, we already work with the Pebbleway finance team. Could you do ${j.slot_labels.join(' or ')} at Test Expo?\n\nBest, Sam\n\n${t.optout_sentence}`;
  const save = (fs) => cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', noah, '--touch', '1', '--json', JSON.stringify({ subject: 'Test Expo', body, brief: 'x', structure: 'plain-request', fact_source: fs })]);
  assert.ok(save('crm').checks.some((x) => /fact_source "crm" isn't one this person has \(account, list\)/.test(x)), 'crm refused');
  const ok = save('account');
  assert.ok(ok.checks === 'pass' || !ok.checks.some((x) => /fact_source/.test(x)), JSON.stringify(ok.checks));
});
