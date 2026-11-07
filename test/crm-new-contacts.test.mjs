// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// With a CRM connected, everyone about to get a first email who isn't in it is added first, so the CRM's mailbox
// sync files their replies on a record floorboss reads by id. The create tool only adds a person; the guard lets
// a create through only for someone floorboss listed, with their values as listed, and asks the user each time.
// The reply reader is chosen by where each CRM keeps logged email.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, idOf, ROOT, NOW } from './fixtures/harness.mjs';
import { screenTool, screenArgs, checkRecipe, crmReaderHint, validateCreated } from '../skills/connectors/scripts/tasks.mjs';
import { testArgProblems } from '../hooks/guard.mjs';
import { makeHome, drive, simplePersona, cli as flowCli } from './sims/lib/driver.mjs';
import { planSync } from '../skills/event-outreach/scripts/sync.mjs';
import { contactable } from '../lib/ledger.mjs';
import { defaultStatusMeaning, dealStateOf, noteHistory, CAUTION_WORDS } from '../skills/crm-triage/scripts/sources.mjs';

const CREATE = {
  server: 'crm',
  tool: 'create_contact',
  args: { properties: { email: '{email}', firstname: '{first_name}', lastname: '{last_name}', company: '{company}', jobtitle: '{title}' } },
  reading: 'the new contact id is "id"',
  tool_hash: 'c'.repeat(64),
  test_draft: { draft_id: '201', user_confirmed: true }
};
const LOOKUP = { server: 'crm', tool: 'search_contacts', args: { query: '{email}' }, reading: 'x', tool_hash: 'b'.repeat(64), probe: { ok: true }, opt_out_source: 'hs_email_optout' };
// The connected CRM's lookup answers, saved as the flow saves them.
const lookedUp = (H, records, notFound) => {
  const f = join(H.dir, 'crm-records.json');
  writeFileSync(f, JSON.stringify({ records, not_found: notFound }));
  const r = cli(H, 'crm-triage', ['inputs', '--event', H.slug, '--kind', 'crm-records', '--file', f]);
  assert.ok(!r.ERROR, r.ERROR);
};
const guard = (H, tool_name, tool_input) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name, tool_input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW }, encoding: 'utf8' });

test('the create tool only adds a person: no update, upsert, merge, import or bulk tool', () => {
  for (const t of ['create_contact', 'add_person', 'hubspot-create-contact', 'createLead', 'crm_create_object']) assert.equal(screenTool('crm.create_contact', t).ok, true, t);
  for (const t of ['update_contact', 'upsert_contact', 'merge_persons', 'import_contacts', 'batch_create_contacts', 'create_contact_and_enroll', 'create_task', 'add_to_list', 'create_deal'])
    assert.equal(screenTool('crm.create_contact', t).ok, false, t);
  // Only the person's own fields: no owner, stage, list or subscription, one address.
  assert.deepEqual(screenArgs(CREATE.args, 'crm.create_contact'), []);
  assert.deepEqual(screenArgs({ name: '{name}', email: [{ value: '{email}', primary: true }] }, 'crm.create_contact'), []);
  for (const bad of [
    { properties: { email: '{email}', hubspot_owner_id: '9001' } },
    { properties: { email: '{email}', lifecyclestage: 'lead' } },
    { name: '{name}', email: [{ value: '{email}' }, { value: 'x@evil.example' }] },
    { properties: { email: 'someone@evil.example', firstname: '{first_name}' } }
  ])
    assert.ok(screenArgs(bad, 'crm.create_contact').length, JSON.stringify(bad));
  // A recipe needs the address and a name, the first record seen by the user, and a record kind on a generic tool.
  assert.deepEqual(checkRecipe('crm.create_contact', CREATE), []);
  assert.match(checkRecipe('crm.create_contact', { ...CREATE, test_draft: null }).join(' '), /first record's id/);
  assert.match(checkRecipe('crm.create_contact', { ...CREATE, args: { properties: { firstname: '{first_name}', lastname: '{last_name}' } } }).join(' '), /\{email\}/);
  assert.match(checkRecipe('crm.create_contact', { ...CREATE, tool: 'create_object' }).join(' '), /record kind/);
  assert.deepEqual(checkRecipe('crm.create_contact', { ...CREATE, tool: 'create_object', args: { ...CREATE.args, objectType: 'contacts' } }), []);
  // The guard reads a test call's values back as placeholders, the same screen.
  assert.equal(testArgProblems('crm.create_contact', { properties: { email: 'bo@globex.test', firstname: 'Bo', lastname: 'Li' } }).length, 0);
  assert.ok(testArgProblems('crm.create_contact', { properties: { email: 'bo@globex.test', hubspot_owner_id: '9001' } }).length);
  assert.match(validateCreated({ records: [{ id: 'c009', crm_id: '1' }] }, new Set(['c001'])).errors.join(' '), /isn't on the list/);
});

test('the reply reader is picked by where each CRM keeps logged email', () => {
  assert.match(crmReaderHint('hubspot'), /INCOMING_EMAIL/);
  assert.match(crmReaderHint(null, 'Pipedrive (an export)'), /mail messages/);
  assert.match(crmReaderHint('claude_ai_Salesforce'), /EmailMessage/);
  assert.match(crmReaderHint('crm-x'), /logged email \(both ways\)/);
});

test('people about to be emailed who are not in the CRM are listed, added one by one through the guard, and their record id is used to read replies', { timeout: 120000 }, () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Operations,Globex,bo@globex.test\n' });
  // The connected CRM was looked up: it has Ana, and nobody at Bo's address.
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'crm.lookup': LOOKUP, 'crm.create_contact': CREATE } }));
  lookedUp(H, [{ name: 'Ana Berg', email: 'ana@acme.test', company: 'Acme', holder: 'Sam Rivera', status: 'Lead', opted_out: false, crm_id: '101' }], ['bo@globex.test']);
  triage(H);
  draftApprove(H);
  const bo = idOf(H, 'Bo Li');
  const cl = cli(H, 'event-outreach', ['contact-list', '--event', H.slug]);
  assert.equal(cl.to_add, 1, JSON.stringify(cl));
  const [it] = JSON.parse(readFileSync(cl.file, 'utf8'));
  assert.equal(it.id, bo, 'Ana is in the CRM already; Bo is not');
  assert.deepEqual([it.first_name, it.last_name, it.email], ['Bo', 'Li', 'bo@globex.test']);
  assert.match(readFileSync(cl.csv, 'utf8'), /^first_name,last_name,email,company,title,source\nBo,Li,bo@globex.test,Globex,VP Operations,floorboss: Test Expo/);
  // The guard: the listed person, as listed, is let through with a prompt; anyone or anything else is refused.
  const BO = { properties: { email: 'bo@globex.test', firstname: 'Bo', lastname: 'Li', company: 'Globex', jobtitle: 'VP Operations' } };
  // A recipe that isn't one floorboss saved (an owner field written into config.json) is never honoured.
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'crm.lookup': LOOKUP, 'crm.create_contact': { ...CREATE, args: { properties: { ...CREATE.args.properties, hubspot_owner_id: '9001' } } } } }));
  assert.match(guard(H, 'mcp__crm__create_contact', { properties: { ...BO.properties, hubspot_owner_id: '9001' } }).stderr, /isn't one floorboss saved/);
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'crm.lookup': LOOKUP, 'crm.create_contact': CREATE } }));
  const ok = guard(H, 'mcp__crm__create_contact', BO);
  assert.equal(ok.status, 0, ok.stderr);
  const said = JSON.parse(ok.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(said, /add "Bo Li".*to your CRM as a new contact.*Email: "bo@globex.test"/s);
  assert.match(said, /The call, as it goes:\n(.|\n)*"properties.email: bo@globex.test"/, 'the prompt shows the call itself');
  // Once only: a second create for Bo is refused, and the flow looks him up instead of creating him again.
  assert.match(guard(H, 'mcp__crm__create_contact', BO).stderr, /already let through to your CRM once/);
  const again = JSON.parse(readFileSync(cli(H, 'event-outreach', ['contact-list', '--event', H.slug]).file, 'utf8'));
  assert.equal(again[0].released, true);
  // Not found when looked up (the user said no at the prompt): he can be added after all.
  const rf = join(H.dir, 'retry.json');
  writeFileSync(rf, JSON.stringify({ records: [], retry: [again[0].id] }));
  assert.match(cli(H, 'event-outreach', ['crm-records', '--event', H.slug, '--via', 'check', '--file', rf]).errors?.join(' ') || '', /Ask the user first/, 'a look-up alone never undoes a no');
  const yes = join(H.dir, 'add.json');
  writeFileSync(yes, JSON.stringify({ answer: 'add them now', ids: [again[0].id] }));
  const ans = cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'crm_contacts', '--value-file', yes], '2026-10-12T08:01:00Z');
  assert.ok(!ans.ERROR, ans.ERROR);
  const rr = cli(H, 'event-outreach', ['crm-records', '--event', H.slug, '--via', 'check', '--file', rf], '2026-10-12T08:02:00Z');
  assert.ok(!rr.ERROR && !rr.errors, JSON.stringify(rr));
  const cleared = guard(H, 'mcp__crm__create_contact', BO);
  assert.equal(cleared.status, 0, `cleared after a look-up found nobody: ${cleared.stderr}`);
  for (const props of [
    { email: 'mallory@evil.example', firstname: 'Bo', lastname: 'Li', company: 'Globex', jobtitle: 'VP Operations' },
    { email: 'bo@globex.test', firstname: 'Bo', lastname: 'Li', company: 'Globex', jobtitle: 'CEO' },
    { email: 'ana@acme.test', firstname: 'Ana', lastname: 'Berg', company: 'Acme', jobtitle: 'COO' }
  ]) {
    const g = guard(H, 'mcp__crm__create_contact', { properties: props });
    assert.equal(g.status, 2, `${JSON.stringify(props)}: ${g.stdout}`);
    assert.match(g.stderr, /isn't one floorboss listed to add to your CRM/);
  }
  // A list made over 30 minutes ago no longer lets anyone through.
  writeFileSync(cl.file, JSON.stringify([{ ...it, listed_at: '2026-10-12T07:00:00Z' }]));
  assert.equal(guard(H, 'mcp__crm__create_contact', { properties: { email: 'bo@globex.test', firstname: 'Bo', lastname: 'Li', company: 'Globex', jobtitle: 'VP Operations' } }).status, 2);
  // Bo's first email waits (Ana's doesn't): nothing is staged for him until he's in the CRM.
  const staged = () => JSON.parse(readFileSync(cli(H, 'event-outreach', ['stage-list', '--event', H.slug]).file, 'utf8')).map((x) => x.id);
  assert.ok(!staged().includes(bo) && staged().includes(idOf(H, 'Ana Berg')), JSON.stringify(staged()));
  // The record's id is saved: Bo leaves the list, and the reply read uses the id.
  cli(H, 'event-outreach', ['contact-list', '--event', H.slug]);
  const f = join(H.dir, 'receipt.json');
  writeFileSync(f, JSON.stringify({ records: [{ id: bo, crm_id: '202' }] }));
  const saved = cli(H, 'event-outreach', ['crm-records', '--event', H.slug, '--file', f]);
  assert.equal(saved.saved, 1, JSON.stringify(saved));
  assert.equal(cli(H, 'event-outreach', ['contact-list', '--event', H.slug]).to_add, 0, 'added once');
  cli(H, 'event-outreach', ['sync-list', '--event', H.slug]);
  const listed = JSON.parse(readFileSync(join(H.dir, 'sync-list.json'), 'utf8'));
  assert.equal(listed.find((p) => p.id === bo)?.crm_id, '202');
  assert.ok(staged().includes(bo), 'in the CRM now: his first email can go');
});

test('a CRM that was never asked (it failed, or the user went on without it) has nobody created in it', { timeout: 120000 }, () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nBo Li,VP Operations,Globex,bo@globex.test\n' });
  triage(H);
  draftApprove(H);
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'crm.lookup': LOOKUP, 'crm.create_contact': CREATE } }));
  assert.equal(cli(H, 'event-outreach', ['contact-list', '--event', H.slug]).to_add, 0, 'unknown is not "not in the CRM"');
});

test('the first record is a real listed person, and only on the user\'s yes; "go on without" takes them off the list', { timeout: 120000 }, () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nBo Li,VP Operations,Globex,bo@globex.test\n' });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'crm.lookup': LOOKUP } }));
  lookedUp(H, [], ['bo@globex.test']);
  triage(H);
  draftApprove(H);
  const cl = cli(H, 'event-outreach', ['contact-list', '--event', H.slug]);
  assert.equal(cl.to_add, 1);
  assert.match(cl.rule, /import/, 'no create tool: the import path');
  const allow = (to) => cli(H, 'connectors', ['test-allow', '--task', 'crm.create_contact', '--server', 'crm', '--tool', 'create_contact', '--event', H.slug, '--to', to]);
  assert.match(allow('mallory@evil.example').ERROR || '', /person on the list to add/);
  assert.ok(!allow('bo@globex.test').ERROR);
  const g = guard(H, 'mcp__crm__create_contact', { properties: { email: 'bo@globex.test', firstname: 'Bo', lastname: 'Li' } });
  assert.equal(g.status, 0, g.stderr);
  assert.match(JSON.parse(g.stdout).hookSpecificOutput.permissionDecisionReason, /first new contact in your CRM.*Allow only if this is a person you agreed to add/s);
  // Going on without them: off the list, and not asked again.
  const said = join(H.dir, 'without.txt');
  writeFileSync(said, 'go on without them');
  const r = cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'crm_contacts', '--value-file', said]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(cli(H, 'event-outreach', ['contact-list', '--event', H.slug]).to_add, 0);
});

test('connecting the CRM also sets up its email reader, by where that CRM keeps logged email; "doesn\'t log my email" ends it', { timeout: 300000 }, () => {
  const H = makeHome({ context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' }, attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  writeFileSync(join(H.HOME, 'scan-home', '.claude.json'), JSON.stringify({ mcpServers: { hubspot: { command: 'node', args: ['crm-a.mjs'] } } }));
  const persona = simplePersona({ asks: { attendee_list: join(H.HOME, 'inputs', 'attendees.csv'), tools: { crm: 'hubspot' } } });
  const STOP = new Error('reached connect');
  try {
    drive(H, persona, { onStep: (s) => { if (s.step === 'connect') throw STOP; } });
  } catch (e) {
    if (e !== STOP) throw e;
  }
  // The lookup saved: the next connect is the reply reader, with HubSpot's own place for logged email.
  const cfg = JSON.parse(readFileSync(join(H.HOME, 'config.json'), 'utf8'));
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ ...cfg, connectors: { 'crm.lookup': { ...LOOKUP, server: 'hubspot' } } }));
  const s = flowCli(H, 'flow', ['next']);
  assert.equal(s.step, 'connect', JSON.stringify(s).slice(0, 300));
  assert.match(s.judge.how, /crm\.activity.*INCOMING_EMAIL/s);
  const f = join(H.HOME, 'work', 'fallback.json');
  writeFileSync(f, JSON.stringify({ task: 'crm.activity', answer: "my CRM doesn't log my email" }));
  assert.ok(!flowCli(H, 'flow', ['answer', '--ask', 'connect_fallback', '--value-file', f]).ERROR);
  assert.notEqual(flowCli(H, 'flow', ['next']).step, 'connect', 'not asked again');
});

test('a cancellation sent before the current booking was recorded frees nothing and is put to the user', () => {
  const state = { c001: { sent: { 1: '2026-11-03' }, booked: 's1', booked_blocks: ['s1'], booked_at: '2026-11-08T10:00:00Z', replied: true } };
  const people = [{ id: 'c001', items: [{ ext: 'm1', kind: 'message', email: true, direction: 'in', at: '2026-11-06T09:00:00Z', intent: 'cancelled', from: 'ana@acme.test', auto: false }] }];
  const r = planSync(people, { state, since: { c001: '2026-11-01T00:00:00Z' }, source: 'mailbox', now: new Date('2026-11-09T09:00:00Z'), byId: { c001: { name: 'Ana', company: 'Acme', email: 'ana@acme.test' } } });
  assert.ok(!r.entries.some((e) => e.type === 'unbooked'), JSON.stringify(r.entries));
  // floorboss can't tell a rebooking from a booking recorded late: the user is asked, nothing is freed.
  assert.match(r.asks.map((a) => a.why).join(' '), /is that meeting off/);
  assert.ok(r.entries.some((e) => e.type === 'outcome_unclear'));
  // Sent after it: the booking is freed.
  people[0].items[0] = { ...people[0].items[0], ext: 'm2', at: '2026-11-08T12:00:00Z' };
  assert.ok(planSync(people, { state, since: { c001: '2026-11-01T00:00:00Z' }, source: 'mailbox', now: new Date('2026-11-09T09:00:00Z'), byId: { c001: { name: 'Ana', company: 'Acme', email: 'ana@acme.test' } } }).entries.some((e) => e.type === 'unbooked'));
});

test('CRM words read carefully: a negated partner or signature, and a note that undoes or warns off, change nothing', () => {
  assert.equal(defaultStatusMeaning('Partner - active'), 'customer');
  for (const v of ['Partner - not active', 'Former partner, active until 2025', 'Prospective partner - live soon']) assert.notEqual(defaultStatusMeaning(v), 'customer', v);
  assert.equal(dealStateOf('Closed Won'), 'won');
  for (const v of ['Not signed', 'Contract pending signature', 'Go-live planned']) assert.equal(dealStateOf(v), 'open', v);
  for (const v of ['Live', 'Signed - pending onboarding']) assert.equal(dealStateOf(v), 'won', v);
  assert.equal(defaultStatusMeaning('Active partner (non-exclusive)'), 'customer');
  for (const n of ['Never met, no reply to two emails', 'Lost to competitor, do not re-engage', 'didn’t meet them']) assert.equal(noteHistory(n), false, n);
  assert.equal(CAUTION_WORDS.test('Demo booked, then said not interested'), true);
  for (const n of ['Met at Quayside Europe, interested in multi-site', 'Met at SaaSCon; no call booked yet', 'Wants to re-engage in Q1, met in May']) assert.equal(noteHistory(n), true, n);
});

test('a colleague status holds on a record the user owns; only a bare "Partner" label there is their own', { timeout: 120000 }, () => {
  const H = setup({
    attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Operations,Globex,bo@globex.test\n',
    crm: 'Name,Email,Company,Owner,Status,Opted Out\nAna Berg,ana@acme.test,Acme,Sam Rivera,Channel partner,no\nBo Li,bo@globex.test,Globex,Sam Rivera,Partner,no\n'
  });
  const t = triage(H);
  assert.ok(!t.load.ERROR, t.load.ERROR);
  const pre = JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'triage.json'), 'utf8')).pre;
  assert.equal(pre[idOf(H, 'Ana Berg')].group, 'coordinate', 'a colleague status holds even on the user\'s own record');
  assert.notEqual(pre[idOf(H, 'Bo Li')].group, 'coordinate', 'a bare Partner label on their own record is their partner');
});

test('no confirmation goes while a question about the booking is open', () => {
  const state = { people: { c001: { booked: 's1', unclear: [{ key: 'm1', why: 'they wrote to cancel before this booking was recorded' }] } } };
  assert.match(contactable(state, 'c001', 'confirmation') || '', /needs your answer first/);
  assert.equal(contactable({ people: { c001: { booked: 's1', unclear: [] } } }, 'c001', 'confirmation'), null);
});
