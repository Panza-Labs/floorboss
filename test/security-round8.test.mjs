// Round 8 security fixes (2026-11-05), from an independent review of the CRM work since round 7: deal stages
// floorboss doesn't know are asked about (a lost deal by another name was read as open, so warm); the first new
// CRM contact is tied to the CRM floorboss reads and to the person as listed; a saved record must have been let
// through and be nobody else's; a cancellation from anyone but the person asks; a CRM note doesn't settle an
// unsure fit. Invented people at .test and .example domains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, idOf, ROOT, NOW } from './fixtures/harness.mjs';
import { resolve } from '../skills/crm-triage/scripts/resolve.mjs';
import { gatherEvidence, indexCrm } from '../skills/crm-triage/scripts/evidence.mjs';
import { applyMapping, propose, dealStateOf } from '../skills/crm-triage/scripts/sources.mjs';
import { readCsvText } from '../lib/csv.mjs';
import { planSync } from '../skills/event-outreach/scripts/sync.mjs';

const TODAY = '2026-10-12';
const ana = { id: 'c001', name: 'Ana Berg', title: 'COO', company: 'Acme', company_key: 'acme', email: 'ana@acme.test', emails: ['ana@acme.test'], profile_url: '', contact_opt_in: '' };
const resolveRow = (head, row, fit = { segment: 'ops', reason: 'COO', score: 80 }) => {
  const { headers, records } = readCsvText(head + row);
  const settings = { crm_user_name: 'Sam Rivera', own_domains: ['lanecraft.example'], rejected_months: 6 };
  return resolve(ana, gatherEvidence(ana, { today: TODAY, crmIndex: indexCrm(applyMapping(records, propose(headers, records, 'crm'))) }), { settings, today: TODAY, fit });
};

test('a lost deal by another name is held; a stage floorboss does not know is asked about, never read as open', () => {
  const HEAD = 'Name,Email,Company,Owner,Lifecycle Stage,Deal Stage,Last Contacted,Unsubscribed\n';
  const at = (stage) => resolveRow(HEAD, `Ana Berg,ana@acme.test,Acme,Sam Rivera,Lead,${stage},2026-07-01,false\n`);
  for (const s of ['Closed Lost', 'Closed - Not Interested', 'Not interested', 'No decision', 'Closed - No Budget', 'Unqualified', 'Withdrawn', 'Churned', 'Verloren', 'Perdu', 'Perdido', 'Closed (no deal)', 'Gone cold']) {
    assert.equal(dealStateOf(s), 'lost', s);
    assert.equal(at(s).group, 'skip', s);
  }
  for (const s of ['Qualification', 'Demo scheduled', 'Proposal sent', 'Negotiation', 'Contract sent', 'Pilot']) assert.equal(dealStateOf(s), 'open', s);
  assert.equal(dealStateOf('Closed Won'), 'won');
  assert.equal(dealStateOf('Parked by Ines'), 'unclear');
  const odd = at('Parked by Ines');
  assert.equal(odd.group, 'check', odd.says);
  assert.match(odd.says, /doesn't know that stage/);
});

test('a CRM note does not settle an unsure fit; the holds still come first', () => {
  const HEAD = 'Name,Email,Company,Owner,Status,Notes,Unsubscribed\n';
  const unsure = { unsure: true, reason: 'vague title' };
  const r = resolveRow(HEAD, 'Ana Berg,ana@acme.test,Acme,,Lead,Met at the demo day. Spoke about pricing,false\n', unsure);
  assert.equal(r.group, 'check', r.says);
  assert.match(r.says, /fit is unsure/);
  assert.equal(resolveRow(HEAD, 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Lead,Met at the demo day,true\n').group, 'skip', 'an opt-out still holds');
});

test('a cancellation from anyone but the person, or with no sender, frees nothing and is put to the user', () => {
  const state = { c001: { sent: { 1: '2026-11-03' }, booked: 's1', booked_blocks: ['s1'], booked_at: '2026-11-04T10:00:00Z', replied: true } };
  const byId = { c001: { name: 'Ana', company: 'Acme', email: 'ana@acme.test' } };
  for (const source of ['mailbox', 'crm'])
    for (const from of ['mallory@evil.example', undefined]) {
      const people = [{ id: 'c001', items: [{ ext: 'x1', kind: 'message', email: true, direction: 'in', at: '2026-11-06T09:00:00Z', intent: 'cancelled', from, auto: false }] }];
      const r = planSync(people, { state, since: { c001: '2026-11-01T00:00:00Z' }, source, now: new Date('2026-11-09T09:00:00Z'), byId });
      assert.ok(!r.entries.some((e) => e.type === 'unbooked'), `${source} ${from}`);
      assert.equal(r.asks.length, 1, `${source} ${from}`);
    }
  // From the person themselves, it frees the time as before.
  const own = [{ id: 'c001', items: [{ ext: 'x2', kind: 'message', email: true, direction: 'in', at: '2026-11-06T09:00:00Z', intent: 'cancelled', from: 'ana@acme.test', auto: false }] }];
  assert.ok(planSync(own, { state, since: { c001: '2026-11-01T00:00:00Z' }, source: 'mailbox', now: new Date('2026-11-09T09:00:00Z'), byId }).entries.some((e) => e.type === 'unbooked'));
});

// The CRM work: a lookup recipe, Bo not found and about to be emailed.
const LOOKUP = { server: 'crm', tool: 'search_contacts', args: { query: '{email}' }, reading: 'x', tool_hash: 'b'.repeat(64), probe: { ok: true }, opt_out_source: 'hs_email_optout' };
const CREATE = {
  server: 'crm', tool: 'create_contact',
  args: { properties: { email: '{email}', firstname: '{first_name}', lastname: '{last_name}', company: '{company}', jobtitle: '{title}' } },
  reading: 'id', tool_hash: 'c'.repeat(64), test_draft: { draft_id: '201', user_confirmed: true }
};
const BO = { properties: { email: 'bo@globex.test', firstname: 'Bo', lastname: 'Li', company: 'Globex', jobtitle: 'VP Operations' } };
const guard = (H, tool_name, tool_input) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name, tool_input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW }, encoding: 'utf8' });
function crmHome(connectors) {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Operations,Globex,bo@globex.test\n' });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors }));
  const f = join(H.dir, 'crm-records.json');
  writeFileSync(f, JSON.stringify({ records: [{ name: 'Ana Berg', email: 'ana@acme.test', company: 'Acme', holder: 'Sam Rivera', status: 'Lead', opted_out: false, crm_id: '101' }], not_found: ['bo@globex.test'] }));
  assert.ok(!cli(H, 'crm-triage', ['inputs', '--event', H.slug, '--kind', 'crm-records', '--file', f]).ERROR);
  triage(H);
  draftApprove(H);
  cli(H, 'event-outreach', ['contact-list', '--event', H.slug]);
  return H;
}
const testAllow = (H, server, tool = 'create_contact') =>
  cli(H, 'connectors', ['test-allow', '--task', 'crm.create_contact', '--server', server, '--tool', tool, '--event', H.slug, '--to', 'bo@globex.test']);

test('the first new contact: only before the recipe, only on the CRM floorboss reads, only the person as listed', { timeout: 120000 }, () => {
  assert.match(testAllow(crmHome({ 'crm.lookup': LOOKUP, 'crm.create_contact': CREATE }), 'crm').ERROR || '', /set up already/);
  const H = crmHome({ 'crm.lookup': LOOKUP });
  assert.match(testAllow(H, 'lemlist', 'add_lead').ERROR || '', /your CRM's own server/);
  assert.ok(!testAllow(H, 'crm').ERROR);
  assert.equal(guard(H, 'mcp__crm__create_contact', { properties: { ...BO.properties, company: 'Anything at all' } }).status, 2, 'a company the list never had');
  const ok = guard(H, 'mcp__crm__create_contact', BO);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(existsSync(join(H.dir, 'released', `crm-${idOf(H, 'Bo Li')}`)));
});

test('a test pass left over after the person is saved creates nothing', { timeout: 120000 }, () => {
  const H = crmHome({ 'crm.lookup': LOOKUP });
  assert.ok(!testAllow(H, 'crm').ERROR);
  // The user imported Bo instead; the look-up found him, so he is off the list.
  const f = join(H.dir, 'receipt.json');
  writeFileSync(f, JSON.stringify({ records: [{ id: idOf(H, 'Bo Li'), crm_id: '202' }] }));
  assert.equal(cli(H, 'event-outreach', ['crm-records', '--event', H.slug, '--file', f, '--via', 'check']).saved, 1);
  assert.equal(guard(H, 'mcp__crm__create_contact', BO).status, 2);
});

test('a created record must have been let through, and a CRM record belongs to one person', { timeout: 120000 }, () => {
  const H = crmHome({ 'crm.lookup': LOOKUP, 'crm.create_contact': CREATE });
  const bo = idOf(H, 'Bo Li');
  const f = join(H.dir, 'receipt.json');
  writeFileSync(f, JSON.stringify({ records: [{ id: bo, crm_id: '202' }] }));
  const never = cli(H, 'event-outreach', ['crm-records', '--event', H.slug, '--file', f]);
  assert.equal(never.saved, 0);
  assert.match(never.errors.join(' '), /never let through/);
  writeFileSync(f, JSON.stringify({ records: [{ id: bo, crm_id: '101' }] }));
  const anas = cli(H, 'event-outreach', ['crm-records', '--event', H.slug, '--file', f, '--via', 'check']);
  assert.equal(anas.saved, 0);
  assert.match(anas.errors.join(' '), /already/);
});
