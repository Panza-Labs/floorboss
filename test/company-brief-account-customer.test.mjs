// A customer through an account-level CRM row only (Kassenwerk: no named record, status "Customer" on the account)
// is a customer in the company brief too, as the job's account note already says: the researcher's input carries
// known.customer, and the brief says "Relation to us: customer", not "prospect".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cli } from './fixtures/harness.mjs';
import { ftu6 } from './fixtures/ftu6.mjs';
import { readCompanyBrief } from '../skills/attendee-research/scripts/companies.mjs';

test('an account-only customer: known.customer from the account status, and the brief calls it a customer', () => {
  const H = ftu6();
  const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  assert.ok(!g.ERROR, g.ERROR);
  const plan = cli(H, 'attendee-research', ['company-plan', '--event', H.slug]);
  assert.ok(!plan.ERROR, plan.ERROR);
  const k = plan.companies.find((x) => x.company === 'Kassenwerk');
  assert.ok(k, JSON.stringify(plan.companies.map((x) => x.company)));
  assert.equal(k.known?.customer, 'the CRM says "Customer" on the account');
  // A named customer record still says its own status.
  const basketry = plan.companies.find((x) => x.company === 'Basketry');
  if (basketry) assert.equal(basketry.known?.customer, 'the CRM says "Customer"');
  const s = cli(H, 'attendee-research', ['skip-companies', '--event', H.slug]);
  assert.ok(!s.ERROR, s.ERROR);
  const brief = readCompanyBrief(join(H.HOME, 'events', H.slug), 'Kassenwerk');
  assert.match(brief, /\*\*Relation to us:\*\* customer/);
  assert.doesNotMatch(brief, /\*\*Relation to us:\*\* prospect/);
  assert.match(brief, /\*\*Your customer:\*\* the CRM says "Customer" on the account/);
});
