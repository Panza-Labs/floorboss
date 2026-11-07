// How setup reads the CRM: a live partner label is a relationship (never a coworker's contact or a prospect), a
// deal's stage is read (lost: held as a lost status is; open: a live conversation; won: a customer), a note that logs a real
// conversation shows on the card and is never a cold first contact, and an export given with a connected CRM is
// read too (its notes, deals and stops count). Invented people at .example and .test domains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, idOf, fitAll } from './fixtures/harness.mjs';
import { propose, defaultStatusMeaning, dealStateOf } from '../skills/crm-triage/scripts/sources.mjs';
import { readMappingWords } from '../skills/crm-triage/scripts/mapping-words.mjs';
import { validateCrmRecords } from '../skills/connectors/scripts/tasks.mjs';

const fieldsOf = (csv) => {
  const [head, ...lines] = csv.trim().split('\n');
  const headers = head.split(',');
  const rows = lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [headers[i], v])));
  return Object.fromEntries(Object.entries(propose(headers, rows, 'crm').columns).map(([h, c]) => [h, c.field]));
};

const PIPEDRIVE = `Person - Name,Person - Email,Organization - Name,Person - Owner,Person - Label,Person - Marketing status,Deal - Title,Deal - Status,Person - Last activity date,Person - Notes
Nora Quist,nora@tallyfin.example,Tallyfin,Sam Rivera,Partner - active,Subscribed,Tallyfin - Referral,Won,2026-10-02,Live since Feb
Owen Hale,owen@brightlake.example,Brightlake,Sam Rivera,Partner - churned,Subscribed,Brightlake - Referral,Lost,2026-04-08,LEGAL: DO NOT CONTACT
Dina Roth,dina@maasbulk.example,Maasbulk,Sam Rivera,Prospect,Subscribed,Maasbulk - Scheduling,Lost,2026-07-02,Lost Jul 2: building in-house
Eli Varga,eli@anafreight.example,Anafreight,Sam Rivera,Prospect,Subscribed,,,2026-06-18,Met at Quayside Europe; interested in multi-site
Gia Lunn,gia@routemill.example,Routemill,Sam Rivera,Prospect,Subscribed,Routemill - Pilot,Open,2026-10-20,
Hal Berg,hal@parkly.example,Parkly,Sam Rivera,Prospect,Subscribed,,,2026-06-04,Downloaded the whitepaper
Ivo Kahn,ivo@clinico.example,Clinico,Jordan Lee,Partner - active,Subscribed,Clinico - Reseller,Won,2026-09-30,
`;
const LIST = `Name,Title,Company,Email
Nora Quist,Head of Partnerships,Tallyfin,nora@tallyfin.example
Owen Hale,VP Product,Brightlake,owen@brightlake.example
Dina Roth,Head of Warehousing,Maasbulk,dina@maasbulk.example
Eli Varga,Supply Chain Manager,Anafreight,eli@anafreight.example
Gia Lunn,COO,Routemill,gia@routemill.example
Hal Berg,COO,Parkly,hal@parkly.example
Ivo Kahn,Head of Partnerships,Clinico,ivo@clinico.example
`;
const resolvedOf = (H) => JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'));

test('a Pipedrive export: Label is the status, Marketing status the opt-out, Deal - Title the deal and Deal - Status its stage', () => {
  const f = fieldsOf(PIPEDRIVE);
  assert.equal(f['Person - Label'], 'status');
  assert.equal(f['Person - Marketing status'], 'opted_out');
  assert.equal(f['Deal - Title'], 'deal', 'a deal title is no job title');
  assert.equal(f['Deal - Status'], 'deal_stage');
  assert.equal(f['Person - Notes'], 'notes');
  assert.equal(f['Person - Last activity date'], 'last_contact');
});

test('Deal Stage next to a lifecycle and a lead status is the deal stage; on its own it is still the status column', () => {
  const both = fieldsOf('Email,Name,Deal Stage,Lifecycle Stage,Lead Status,Associated Deal\na@x.test,Ana,Closed Lost,Other,Connected,Ana - Deal\n');
  assert.equal(both['Deal Stage'], 'deal_stage', 'never "not read"');
  assert.equal(both['Lifecycle Stage'], 'status');
  assert.equal(both['Lead Status'], 'status_2');
  assert.equal(fieldsOf('Email,Name,Deal Stage\na@x.test,Ana,Customer\n')['Deal Stage'], 'status');
});

test('a live partner label means a relationship; a churned one holds; deal stages read as won, lost or open', () => {
  assert.equal(defaultStatusMeaning('Partner - active'), 'customer');
  assert.equal(defaultStatusMeaning('Active partner'), 'customer');
  assert.equal(defaultStatusMeaning('Partner - churned'), 'hold');
  assert.equal(defaultStatusMeaning('Partner - inactive'), 'coordinate', '"inactive" is not active');
  assert.deepEqual(['Closed Lost', 'Lost', 'Won', 'Closed Won', 'Open', 'Contract Sent', '', '-'].map(dealStateOf), ['lost', 'lost', 'won', 'won', 'open', 'open', null, null]);
  // In the user's words too: "a live partner" is theirs, never a coworker's.
  const m = { kind: 'crm', headers: ['Label'], columns: { Label: { field: 'status' } } };
  const r = readMappingWords('Partner - active is a live partner. Partner - churned means hold', m, () => ['Partner - active', 'Partner - churned']);
  assert.deepEqual(r.status, { 'Partner - active': 'customer', 'Partner - churned': 'hold' }, JSON.stringify(r.unread));
});

test('triage: live partners are warm partners, a lost deal is held as a lost status is, a logged meeting is known, a stop in the notes holds', () => {
  const H = setup({ attendees: LIST, crm: PIPEDRIVE, settings: { colleagues: ['Jordan Lee'] } });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.ok(!load.ERROR, load.ERROR);
  fitAll(H, load);
  const r = resolvedOf(H);
  const of = (n) => r[idOf(H, n)];
  assert.equal(of('Nora Quist').group, 'warm');
  assert.match(of('Nora Quist').says, /^a partner \(CRM status "Partner - active"\)/);
  assert.equal(of('Nora Quist').crm.status, 'Partner - active', 'the label, never "Subscribed"');
  assert.equal(of('Nora Quist').crm.relation, 'partner');
  assert.equal(of('Nora Quist').crm.deal_stage, 'Won');
  assert.equal(of('Owen Hale').group, 'skip', 'the do-not-contact note holds');
  // A lost deal from the deal's own stage reads like a lost status: left alone within the window, the deal named.
  assert.equal(of('Dina Roth').group, 'skip');
  assert.match(of('Dina Roth').says, /a lost deal "Maasbulk - Scheduling" \(Lost\).*a lost deal within 6 months|a lost deal "Maasbulk - Scheduling" \(Lost\) \(a lost deal, with no date/);
  assert.equal(of('Eli Varga').group, 'warm');
  assert.equal(of('Eli Varga').says, 'CRM history: "Met at Quayside Europe; interested in multi-site"');
  assert.equal(of('Gia Lunn').group, 'warm');
  assert.match(of('Gia Lunn').says, /an open deal "Routemill - Pilot" \(Open\)/);
  assert.equal(of('Hal Berg').group, 'reach', 'a whitepaper download is no conversation');
  assert.equal(of('Ivo Kahn').group, 'colleague', "a coworker's partner stays the coworker's");
  // The card shows what the CRM logged, so the user can check it.
  const card = cli(H, 'crm-triage', ['view', '--event', H.slug]);
  const row = (n) => card.top.find((x) => x.id === idOf(H, n));
  assert.match(row('Eli Varga').crm_history, /note: "Met at Quayside Europe; interested in multi-site"/);
  // Held, the lost deal is named where the user sees who's left out and why, so "warm <id> because …" brings them back.
  const out = card.left_out.find((g) => g.e_g.some((x) => x.startsWith(`${idOf(H, 'Dina Roth')} `)));
  assert.match(out?.why || '', /a lost deal "Maasbulk - Scheduling"/, JSON.stringify(card.left_out));
});

test('a live partner owned by the user is never held as their own coworker, even with a bare "Partner" status', () => {
  const H = setup({
    attendees: 'Name,Title,Company,Email\nNora Quist,Head of Partnerships,Tallyfin,nora@tallyfin.example\n',
    crm: 'Name,Email,Company,Owner,Status,Unsubscribed\nNora Quist,nora@tallyfin.example,Tallyfin,Sam Rivera,Partner,No\n'
  });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  fitAll(H, load);
  const nora = resolvedOf(H)[idOf(H, 'Nora Quist')];
  assert.equal(nora.group, 'warm');
  assert.equal(nora.says, 'CRM status "Partner" on your own record');
  assert.equal(nora.coworker_also, undefined);
});

test('crm.lookup keeps the deal and its stage, and a lost deal from the connected CRM is a known person', () => {
  const v = validateCrmRecords({ records: [{ name: 'Dina Roth', email: 'dina@maasbulk.example', opted_out: false, deal: 'Maasbulk - Scheduling', deal_stage: 'Closed Lost' }] });
  assert.deepEqual(v.errors, []);
  assert.equal(v.records[0].deal_stage, 'Closed Lost');
  assert.equal(v.records[0].deal, 'Maasbulk - Scheduling');
});

const RECIPE = { connectors: { 'crm.lookup': { server: 'crm', tool: 'find_person', args: { query: '{email}' }, reading: 'x', tool_hash: 'a'.repeat(64), opt_out_source: 'marketing_status', probe: { ok: true } } } };

test('a connected CRM and an export given too: both are read, the export fills notes and deals, and its stop holds', () => {
  const H = setup({ attendees: LIST, crm: PIPEDRIVE, settings: { colleagues: ['Jordan Lee'] } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify(RECIPE));
  // What a find_person tool returns: the label, no notes and no deals.
  const recs = join(H.dir, 'recs.json');
  const rec = (name, email, company, status) => ({ name, email, company, holder: 'Sam Rivera', status, opted_out: false, notes: null });
  writeFileSync(
    recs,
    JSON.stringify({
      records: [
        rec('Owen Hale', 'owen@brightlake.example', 'Brightlake', 'Partner - churned'),
        rec('Dina Roth', 'dina@maasbulk.example', 'Maasbulk', 'Prospect'),
        rec('Eli Varga', 'eli@anafreight.example', 'Anafreight', 'Prospect'),
        rec('Nora Quist', 'nora@tallyfin.example', 'Tallyfin', 'Partner - active')
      ],
      not_found: ['gia@routemill.example', 'hal@parkly.example', 'ivo@clinico.example']
    })
  );
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug, '--crm-records', recs]);
  assert.ok(!load.ERROR, load.ERROR);
  assert.match(load.crm.source, /^connector: crm · find_person, and the export /);
  assert.ok(
    load.warnings.some((w) => /^Read both the connected CRM \(4 looked up\) and your export \(7 rows\)/.test(w)),
    JSON.stringify(load.warnings)
  );
  fitAll(H, load);
  const r = resolvedOf(H);
  const of = (n) => r[idOf(H, n)];
  assert.equal(of('Owen Hale').group, 'skip');
  const owen = [of('Owen Hale').says, ...of('Owen Hale').alternatives.map((x) => x.says)];
  assert.ok(
    owen.some((x) => /^CRM note: ".*LEGAL: DO NOT CONTACT"$/.test(x)),
    `the export's stop note holds though the lookup had none: ${JSON.stringify(owen)}`
  );
  assert.match(of('Dina Roth').says, /a lost deal "Maasbulk - Scheduling"/);
  assert.equal(of('Eli Varga').crm.notes, 'Met at Quayside Europe; interested in multi-site');
  assert.equal(of('Nora Quist').crm.deal_stage, 'Won');
  // Someone the lookup didn't find is still read from the export: the coworker's partner stays the coworker's.
  assert.equal(of('Ivo Kahn').group, 'colleague');
});
