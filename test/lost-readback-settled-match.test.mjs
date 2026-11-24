// A lost-deal read-back for a person whose uncertain match is settled in the same answer names them: it is built from
// the person as the match makes them, not as they read before it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, fitAll, idOf } from './fixtures/harness.mjs';
import { ATTENDEES, CRM, MAPPING_SAID } from './fixtures/ftu6.mjs';
test('lost read-back names the person settled in the same answer', () => {
  const crm = CRM.replace('Katherine Lindqvist,k.lindqvist@tillmoss.example,Tillmoss,Ines Moreau,Prospect,', 'Katherine Lindqvist,k.lindqvist@tillmoss.example,Tillmoss,Ines Moreau,Closed Lost,');
  assert.notEqual(crm, CRM);
  const H = setup({ attendees: ATTENDEES, crm, accounts: 'Company,Status\nStockroom AI,do not contact this company\n', settings: { own_company: 'Paylark', own_domains: ['paylark.example'], colleagues: ['Sam Okafor', 'Sofia Marin'], crm_user_name: 'Ines Moreau', coworker_contacts: 'leave', crm_accounts: 'apply', colleague_notes: false, rejected_months: 6, customer_rule: { recent_months: 6, recent: 'warm', on_deal: 'warm', other: 'warm' } } });
  cli(H, 'crm-triage', ['propose-mapping', '--event', H.slug, '--kind', 'attendees']);
  cli(H, 'crm-triage', ['confirm-mapping', '--event', H.slug, '--kind', 'attendees', '--accept']);
  cli(H, 'crm-triage', ['propose-mapping', '--event', H.slug, '--kind', 'crm']);
  const words = join(H.HOME, 'mapping-words.txt'); writeFileSync(words, MAPPING_SAID);
  cli(H, 'crm-triage', ['confirm-mapping', '--event', H.slug, '--kind', 'crm', '--words-file', words]);
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]); fitAll(H, load);
  const kate = idOf(H, 'Kate Lindqvist');
  const r = cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `${kate} same-person crm:5\n${kate} warm because we met at Tillcon in March`]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.match(r.tell_user || '', /^Kate's deal was lost; your wait is 6 months\. Write to them anyway\? 1\. Yes\. 2\. No\./);
});
