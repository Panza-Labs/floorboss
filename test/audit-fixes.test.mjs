// The confirmed findings of the 6 Nov security audit (security-audit skill, run-1), each as the attack that worked
// then and must fail now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, todoJobs, idOf, ROOT, NOW } from './fixtures/harness.mjs';
import { namesToIds } from '../lib/names.mjs';
import { parseDncReport } from '../skills/crm-triage/scripts/dnc.mjs';
import { readEnriched, overlay } from '../skills/crm-triage/scripts/enrich.mjs';
import { foundServer } from '../hooks/guard.mjs';

const hook = (H, input, args = [], now = NOW) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs'), ...args], { input: JSON.stringify(input), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
const run = (H, skill, args, env = {}) =>
  spawnSync('node', [join(ROOT, 'skills', skill, 'scripts', 'cli.mjs'), ...args], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW, ...env }, encoding: 'utf8' });
const asks = (r) => /"permissionDecision":"ask"/.test(r.stdout || '');
const ledger = (H) => readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const TWO = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n';

test('C1: config --set cannot open the inbox gate; only the inbox_read answer can', () => {
  const H = setup({ attendees: TWO });
  const r = run(H, 'event-context', ['config', '--set', JSON.stringify({ inbox_read: { linkedin: true, app: true } })], { FLOORBOSS_SAVED_BY: '' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /user's answer/);
  assert.notEqual(run(H, 'event-context', ['config', '--set', JSON.stringify({ log_replies: true })], { FLOORBOSS_SAVED_BY: '' }).status, 0);
  assert.equal(run(H, 'event-context', ['config', '--set', JSON.stringify({ inbox_read: { linkedin: true, app: false } })], { FLOORBOSS_SAVED_BY: 'inbox_read' }).status, 0);
});

test('C2/C3: a later scan or an answer cannot add a server to the ones a run may read', () => {
  const H = setup({ attendees: TWO });
  const sess = (mcp) => { const f = join(H.HOME, 'work', `s${Math.random().toString(36).slice(2)}.json`); mkdirSync(join(H.HOME, 'work'), { recursive: true }); writeFileSync(f, JSON.stringify({ mcp })); return f; };
  assert.equal(run(H, 'event-context', ['scan', '--session-file', sess([{ name: 'hubspot', tools: ['search_contacts'] }])]).status, 0);
  const again = JSON.parse(run(H, 'event-context', ['scan', '--session-file', sess([{ name: 'hubspot', tools: ['search_contacts'] }, { name: 'evilsrv', tools: ['search_contacts'] }])]).stdout);
  assert.deepEqual(again.found_since_setup, ['evilsrv']);
  const prev = process.env.FLOORBOSS_HOME;
  process.env.FLOORBOSS_HOME = H.HOME;
  try {
    assert.equal(foundServer('hubspot'), true, 'seen at the first scan');
    assert.equal(foundServer('evilsrv'), false, 'a later scan adds nothing');
    const ob = join(H.HOME, 'onboarding.json');
    const o = existsSync(ob) ? JSON.parse(readFileSync(ob, 'utf8')) : {};
    writeFileSync(ob, JSON.stringify({ ...o, answers: { ...(o.answers || {}), crm_server: 'dummyrelay', enrich_server: 'evilsrv' } }));
    assert.equal(foundServer('dummyrelay'), false, 'a name in an answer counts only if setup saw it');
    assert.equal(foundServer('evilsrv'), false);
  } finally {
    process.env.FLOORBOSS_HOME = prev;
  }
  // A restart moves the inventory aside but keeps the first scan's set, so a scan after it can't decide it again.
  assert.equal(run(H, 'event-context', ['onboarding', '--reset']).status, 0);
  assert.equal(run(H, 'event-context', ['scan', '--session-file', sess([{ name: 'evilsrv', tools: ['search_contacts'] }])]).status, 0);
  process.env.FLOORBOSS_HOME = H.HOME;
  try {
    assert.equal(foundServer('evilsrv'), false, 'a restart then a scan adds nothing');
    const inv0 = JSON.parse(readFileSync(join(H.HOME, 'inventory.json'), 'utf8'));
    assert.ok(Object.values(inv0.found).flat().includes('mcp:evilsrv'), 'setup still sees what the scan found (it can offer it)');
    // A CRM answer naming a server setup saw, but not as a CRM, adds nothing either.
    const inv = JSON.parse(readFileSync(join(H.HOME, 'inventory.json'), 'utf8'));
    writeFileSync(join(H.HOME, 'inventory.json'), JSON.stringify({ ...inv, setup_servers: [...inv.setup_servers, 'claude_ai_Slack'], found: { ...inv.found, chat: ['mcp:claude_ai_Slack'] } }));
    const ob = join(H.HOME, 'onboarding.json');
    const o = existsSync(ob) ? JSON.parse(readFileSync(ob, 'utf8')) : {};
    writeFileSync(ob, JSON.stringify({ ...o, answers: { ...(o.answers || {}), enrich_server: 'claude_ai_Slack' } }));
    assert.equal(foundServer('claude_ai_Slack'), true, 'found at setup as chat: readable, as before');
    writeFileSync(join(H.HOME, 'inventory.json'), JSON.stringify({ ...inv, setup_servers: [...inv.setup_servers, 'claude_ai_Slack'] }));
    assert.equal(foundServer('claude_ai_Slack'), false, 'an answer alone never makes a non-people-data server readable');
  } finally {
    process.env.FLOORBOSS_HOME = prev;
  }
  // Scanning another folder is for tests only.
  const r = run(H, 'event-context', ['scan', '--cwd', H.HOME], { FLOORBOSS_TEST: '' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /--cwd is for tests only/);
});

test('C4: a browser window asks the user at its first call, and only then lets clicks through', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\n', event: { app_name: 'Grip' }, settings: { sending: { channels: ['app'], followups: 'scheduled' }, app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false } });
  triage(H); draftApprove(H);
  cli(H, 'event-outreach', ['send-list', '--event', H.slug]);
  writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at: NOW }));
  cli(H, 'event-outreach', ['browser-send', '--event', H.slug, '--said', 'go ahead, send them in Grip']);
  const click = { tool_name: 'mcp__playwright__browser_click', tool_input: { element: 'Delete contact', ref: 'e9' } };
  const first = hook(H, click);
  assert.equal(first.status, 0);
  assert.ok(asks(first), 'the first call in a new window asks');
  // A declined first call never reaches the PostToolUse hook: the next call asks again.
  assert.ok(asks(hook(H, click)));
  hook(H, { hook_event_name: 'PostToolUse', ...click, tool_response: {} }, ['post']);
  const after = hook(H, click);
  assert.equal(after.status, 0);
  assert.ok(!asks(after), 'once allowed, the window works as before');
});

test('C5: an attendee named like a contact id never redirects an id the user typed', () => {
  const P = [{ id: 'c001', name: 'Ana Berg' }, { id: 'c002', name: 'Bo Li' }, { id: 'c003', name: 'c001 Jones' }];
  assert.equal(namesToIds('approve all except c001', P), 'approve all except c001');
  assert.equal(namesToIds('skip c001 because she asked', P), 'skip c001 because she asked');
  assert.equal(namesToIds('skip ana', P), 'skip c001', 'real names still map');
  // Punctuation around the id-shaped name changes nothing.
  const Q = [{ id: 'c001', name: 'Ana Berg' }, { id: 'c002', name: 'Bo Li' }, { id: 'c003', name: 'C001, Jones' }, { id: 'c004', name: 'C001. Smith' }];
  assert.equal(namesToIds('skip c001, c002 because known', Q), 'skip c001, c002 because known');
  assert.equal(namesToIds('skip c001.', Q), 'skip c001.');
  const H = setup({ attendees: TWO + 'c001 Jones,COO,Initech,cj@initech.test\n' });
  triage(H);
  draftApprove(H);
  const g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all except c001']);
  assert.ok(g, 'gate ran');
});

test('C6: a message released before says so at the next prompt', () => {
  const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
  const H = setup({ attendees: TWO, settings: { sending: { channels: ['email'], followups: 'scheduled' }, touches: 1 } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H); draftApprove(H);
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug]);
  const [it] = JSON.parse(readFileSync(list.file, 'utf8'));
  const send = { tool_name: 'mcp__gmail__send_email', tool_input: { to: it.to, subject: it.subject, body: it.body } };
  const firstTime = hook(H, send);
  assert.ok(asks(firstTime));
  assert.doesNotMatch(firstTime.stdout, /already let this message through/);
  cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--resend', `${it.id}:${it.touch}`, '--said', 'send it again']);
  const again = hook(H, send);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already let this message through once/);
  assert.match(again.stdout, /send it again/);
});

test('C7: a follow-up offering a time someone else booked is refused at the send', () => {
  const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
  const H = setup({ attendees: TWO, settings: { sending: { channels: ['email'], followups: 'scheduled' }, touches: 1 } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H); draftApprove(H);
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug]);
  const items = JSON.parse(readFileSync(list.file, 'utf8'));
  const it = items.find((x) => x.id === idOf(H, 'Ana Berg'));
  const drafted = ledger(H).filter((e) => e.type === 'drafted' && e.id === it.id && e.touch === it.touch).pop();
  assert.ok(drafted?.slot_ids?.length, 'the first message offers times');
  const other = idOf(H, 'Bo Li');
  const f = join(H.dir, 'work', 'rec.json');
  mkdirSync(join(H.dir, 'work'), { recursive: true });
  // A slot id names its local time (s20261110T1000 is 10:00 on 10 Nov in the event's zone).
  const [, y, mo, d, hh, mm] = /^s(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})$/.exec(drafted.slot_ids[0]);
  const local = `${y}-${mo}-${d} ${hh}:${mm}`;
  writeFileSync(f, JSON.stringify({ items: [{ who: other, what: 'booked', time: local, said: 'Bo booked it' }] }));
  const rec = run(H, 'event-outreach', ['record', '--event', H.slug, '--file', f]);
  assert.ok(ledger(H).some((e) => e.type === 'booked' && e.id === other && e.slot === drafted.slot_ids[0]), rec.stdout + rec.stderr);
  const r = hook(H, { tool_name: 'mcp__gmail__send_email', tool_input: { to: it.to, subject: it.subject, body: it.body } });
  assert.equal(r.status, 2, rec.stdout + r.stderr);
  assert.match(r.stderr, /offers times that are gone/);
});

test('C8: after the batch yes, the same draft goes into the drafts folder once', () => {
  const STAGE = { server: 'gmail', tool: 'create_draft', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'd'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
  const H = setup({ attendees: TWO });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { stage_draft: STAGE } }));
  triage(H); draftApprove(H);
  const sl = cli(H, 'event-outreach', ['stage-list', '--event', H.slug]);
  const items = JSON.parse(readFileSync(sl.file, 'utf8'));
  const call = (it) => ({ tool_name: 'mcp__gmail__create_draft', tool_input: { to: it.to, subject: it.subject, body: it.body }, session_id: 's1' });
  assert.ok(asks(hook(H, call(items[0]))));
  hook(H, { hook_event_name: 'PostToolUse', ...call(items[0]), tool_response: {} }, ['post']);
  const again = hook(H, call(items[0]));
  assert.equal(again.status, 2, 'the same draft a second time');
  assert.match(again.stderr, /already went into your drafts/);
  // A call that failed (no PostToolUse) marks nothing: the next item can be tried, retried, then refused once in.
  if (items[1]) {
    assert.equal(hook(H, call(items[1])).status, 0, 'first try');
    assert.equal(hook(H, call(items[1])).status, 0, 'a retry after a failed call');
    hook(H, { hook_event_name: 'PostToolUse', ...call(items[1]), tool_response: {} }, ['post']);
    assert.equal(hook(H, call(items[1])).status, 2, 'and once each, after it went in');
  }
});

test('C9: a webmail address from enrichment waits for the user when the company has a known domain', () => {
  const byId = { c001: { id: 'c001', name: 'Jane Doe', company: 'Acme Freight', company_key: 'acme freight', email: null } };
  const r = readEnriched([{ floorboss_id: 'c001', full_name: 'Jane Doe', email: 'jane.doe.acmefreight@gmail.test' }], { byId, source: 'clay', domainsOf: () => ['acmefreight.test'] });
  assert.equal(r.entries.filter((e) => e.email).length, 0);
  assert.equal(r.check.length, 1);
  assert.equal(r.check[0].email, 'jane.doe.acmefreight@gmail.test');
  const free = readEnriched([{ floorboss_id: 'c001', full_name: 'Jane Doe', email: 'jane@gmail.test' }], { byId, source: 'clay', domainsOf: () => [] });
  const mixed = readEnriched([{ floorboss_id: 'c001', full_name: 'Jane Doe', email: 'jane.x@gmail.test' }], { byId, source: 'clay', domainsOf: () => ['acmefreight.test', 'gmail.test'] });
  assert.equal(mixed.check.length, 1, "a colleague's gmail isn't the company's domain");
  assert.equal(free.check.length, 0, 'with no known domain nothing is held, as before');
  assert.equal(typeof overlay, 'function');
});

test('C10: an ambiguous do-not-contact expiry is read as the later date, and said', () => {
  const r = parseDncReport('Email,Until\nana@acme.test,01/12/2026\nbo@x.test,13/12/2026\n', { today: '2026-10-12' });
  assert.deepEqual(r.entries.map((e) => e.until), ['2026-12-01', '2026-12-13']);
  assert.ok(r.notes.some((n) => /day\/month or month\/day/.test(n)));
  assert.ok(!r.notes.some((n) => /expired/.test(n)), 'nobody comes back early');
  const inline = parseDncReport('ana@acme.test, until 01/12/2026\n', { today: '2026-10-12' });
  assert.equal(inline.entries[0].until, '2026-12-01');
});

test('C11: only a plain yes opens the CRM log window or the app send window', () => {
  const H = setup({ attendees: TWO });
  triage(H);
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  writeFileSync(join(H.dir, 'crm-log-list.json'), JSON.stringify([{ key: 'c001:1', id: 'c001', touch: 1, name: 'Ana Berg', body: 'x', listed_at: NOW }]));
  for (const v of ['no', 'no thanks', 'later', 'skip it', 'not now']) {
    const f = join(H.HOME, 'work', 'a.json');
    writeFileSync(f, JSON.stringify(v));
    run(H, 'flow', ['answer', '--event', H.slug, '--ask', 'crm_log_window', '--value-file', f], { FLOORBOSS_OUT_OF_TURN: '1' });
    assert.ok(!existsSync(join(H.HOME, 'crm-log-window.json')), `"${v}" opens nothing`);
  }
  assert.ok(ledger(H).some((e) => e.type === 'answered' && e.ask === 'crm_log_window' && e.value === 'not now'), 'a no is recorded');
  const last = ledger(H).filter((e) => e.type === 'answered' && e.ask === 'crm_log_window').pop();
  assert.equal(last.value, 'not now', 'and it is the last word, so the question waits until tomorrow');
  for (const v of ['don\u2019t log them yet', "can't right now", "won't send them"]) {
    const f = join(H.HOME, 'work', 'a.json');
    writeFileSync(f, JSON.stringify(v));
    run(H, 'flow', ['answer', '--event', H.slug, '--ask', 'crm_log_window', '--value-file', f], { FLOORBOSS_OUT_OF_TURN: '1' });
    assert.ok(!existsSync(join(H.HOME, 'crm-log-window.json')), `"${v}" opens nothing`);
  }
  for (const v of ['send them later', 'yes but not now', 'ok, later']) {
    const f = join(H.HOME, 'work', 'a.json');
    writeFileSync(f, JSON.stringify(v));
    run(H, 'flow', ['answer', '--event', H.slug, '--ask', 'crm_log_window', '--value-file', f], { FLOORBOSS_OUT_OF_TURN: '1' });
    assert.ok(!existsSync(join(H.HOME, 'crm-log-window.json')), `"${v}" opens nothing`);
  }
  const unclear = join(H.HOME, 'work', 'u.json');
  writeFileSync(unclear, JSON.stringify('hmm'));
  const ur = run(H, 'flow', ['answer', '--event', H.slug, '--ask', 'crm_log_window', '--value-file', unclear], { FLOORBOSS_OUT_OF_TURN: '1' });
  assert.notEqual(ur.status, 0, 'an unclear answer is asked again');
  const y = join(H.HOME, 'work', 'y.json');
  writeFileSync(y, JSON.stringify('yes, log them now'));
  run(H, 'flow', ['answer', '--event', H.slug, '--ask', 'crm_log_window', '--value-file', y], { FLOORBOSS_OUT_OF_TURN: '1' });
  assert.ok(existsSync(join(H.HOME, 'crm-log-window.json')), 'a yes opens it');
});
