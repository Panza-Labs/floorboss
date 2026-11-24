// 0.1.7 setup, after the independent review of v017-setup: each test reads the text the user reads (the step's
// question, from wording.mjs HAND_SEND_ASKS when an id has an entry there), not only the tree node's own ask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../skills/event-context/scripts/scan.mjs';
import { NODES } from '../skills/event-context/scripts/onboarding-tree.mjs';
import { HAND_SEND_ASKS, withWhy } from '../skills/flow/scripts/steps/wording.mjs';

const EV = { slug: 'ev', name: 'Expo', start_date: '2026-12-10', app_name: null, no_app: true };
const tools = (server, list) => list.map((t) => `mcp__${server}__${t}`);
const invOf = (toolList) => summarize([], { tools: toolList });
const st = (s0) => ({ ev: EV, cfg: {}, ...s0, ans: { setup_level: 'full', ...s0.ans } });
// What the user reads for this question, as steps/setup.mjs onboardingAsk builds it; null when it is not asked.
const userQ = (s0, id) => {
  const s = st(s0);
  const n = NODES.find((x) => x.id === id);
  if (!n || !n.when(s) || n.done(s)) return null;
  const hs = HAND_SEND_ASKS[id];
  return { question: withWhy(id, (hs && hs.question(s)) || n.ask(s)), options: n.options ? n.options(s) : null, for_agent: hs ? n.ask(s) : null };
};
const GMAIL_READ = tools('claude_ai_Gmail', ['search_threads', 'get_thread', 'list_labels']);
const GMAIL_SEND = tools('claude_ai_Gmail', ['search_threads', 'get_thread', 'create_draft', 'send_email']);
const HUBSPOT = tools('claude_ai_HubSpot', ['search_crm_objects', 'get_crm_objects', 'search_owners', 'manage_crm_objects']);

test('R1. the tools question the user reads: plain names, a read-only mailbox said as such, no "reading only"', () => {
  const t = userQ({ inv: invOf([...HUBSPOT, ...GMAIL_READ]), ans: {} }, 'tools');
  assert.ok(t);
  assert.doesNotMatch(t.question, /reading only|claude_ai_/i, t.question);
  assert.match(t.question, /HubSpot/);
  assert.match(t.question, /floorboss can read replies in Gmail, and you send/);
  assert.match(t.question, /floorboss reads HubSpot/);
});

const GMAIL_DRAFTS = tools('claude_ai_Gmail', ['search_threads', 'get_thread', 'create_draft', 'get_draft', 'send_email']);
test('R2. Claude Code with a Gmail that can draft: the follow-up question offers auto-send first, in plain words', () => {
  const f = userQ({ inv: invOf(GMAIL_DRAFTS), ans: { sending_asked: true, sending_channels: ['email'], send_setup_done: true } }, 'followups_mode');
  assert.ok(f);
  assert.equal(f.question, 'How should your follow-ups go? You make the final pick after you read every message.');
  assert.equal(f.options.length, 3);
  assert.match(f.options[0], /^Automatically, even with your laptop closed \(recommended\): floorboss sends each first email from here, and Claude Code asks you before each one\. Each follow-up waits in your Gmail drafts, and a daily routine in your Claude account sends it on its day, unless they reply or it bounces\./);
  assert.match(f.options[1], /^In my Gmail drafts: floorboss sends nothing\./);
  assert.match(f.options[2], /^I'll send them myself: floorboss sends nothing/);
});

test('R2. without auto-send (no Gmail drafts, or LinkedIn only): the question says nothing goes with the laptop closed', () => {
  for (const s of [
    { inv: invOf(tools('outlook', ['list_messages', 'send_message'])), ans: { sending_asked: true, sending_channels: ['email'], send_setup_done: true } },
    { inv: invOf([...GMAIL_DRAFTS, ...tools('browser', ['navigate', 'read_page'])]), ans: { sending_asked: true, sending_channels: ['linkedin'], linkedin_send_ack: true } }
  ]) {
    const f = userQ(s, 'followups_mode');
    assert.ok(f, JSON.stringify(s.ans));
    assert.match(f.question, /A follow-up goes only when you open floorboss on or after its day, and Claude Code asks you before each one\. If your laptop stays closed, nothing goes\./);
    assert.doesNotMatch(f.question, /Gmail drafts/);
    assert.match(f.options[0], /^scheduled: each follow-up goes the first time you open floorboss on or after its day \(Claude Code asks you first\), unless they reply, book or say stop/);
  }
});

test('R3. an inventory saved by 0.1.6 (no email_send): never "can\'t send"; the scan runs again', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  // The base code's scan (0b64fc8), as a 0.1.6 install saved it.
  const dir = mkdtempSync(join(tmpdir(), 'fb-base-scan-'));
  const root = new URL('..', import.meta.url).pathname;
  for (const f of ['skills/event-context/scripts/scan.mjs', 'lib/security.mjs']) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), execFileSync('git', ['show', `0b64fc8:${f}`], { cwd: root, encoding: 'utf8' }));
  }
  for (const f of execFileSync('git', ['ls-tree', '-r', '--name-only', '0b64fc8', 'lib'], { cwd: root, encoding: 'utf8' }).split('\n').filter((x) => x.endsWith('.mjs'))) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), execFileSync('git', ['show', `0b64fc8:${f}`], { cwd: root, encoding: 'utf8' }));
  }
  const B = await import(join(dir, 'skills/event-context/scripts/scan.mjs'));
  const inv = JSON.parse(JSON.stringify(B.summarize([], { tools: GMAIL_DRAFTS })));
  assert.equal(inv.found.email_send, undefined, 'the base inventory has no email_send');
  const s = { inv, ans: { sending_asked: true, sending_channels: ['email'] } };
  const ss = userQ(s, 'send_setup');
  assert.ok(ss);
  assert.doesNotMatch(ss.question, /No way to send/);
  const t = userQ({ inv, ans: {} }, 'tools');
  assert.doesNotMatch(t.question, /and you send/);
  // The flow scans again before it asks anything that reads it.
  const { setup, cli } = await import('./fixtures/harness.mjs');
  const H = setup({ attendees: 'Name,Title,Company,Email\n' });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  writeFileSync(join(H.HOME, 'inventory.json'), JSON.stringify({ ...inv, scanned_at: '2026-11-01T00:00:00Z' }));
  assert.equal(cli(H, 'flow', ['next', '--event', H.slug]).step, 'scan');
});

test('R4. the menu names are the current ones, and Claude Code needs the Claude account sign-in', async () => {
  const m = userQ({ inv: invOf([]), ans: { sending_asked: true, sending_channels: [], connect_first: true } }, 'mailbox_connect');
  assert.match(m.question, /claude\.ai\/customize\/connectors/);
  assert.match(m.question, /Customize, then Connectors/);
  assert.match(m.question, /signed in to Claude Code with your Claude account/);
  const { connectSteps } = await import('../skills/event-context/scripts/onboarding-tree.mjs');
  assert.doesNotMatch(connectSteps(), /Settings, then "Connectors"/);
});

test('R5. chat apps are never mailboxes; Notion Mail is one', () => {
  const inv = invOf([
    ...tools('whatsapp', ['list_chats', 'list_messages', 'send_message']),
    ...tools('telegram', ['get_messages', 'send_message']),
    ...tools('claude_ai_Microsoft_Teams', ['list_messages', 'read_thread', 'send_message']),
    ...tools('notion_mail', ['search_threads', 'get_thread', 'send_email'])
  ]);
  assert.deepEqual(inv.found.email, ['mcp:notion_mail']);
  assert.deepEqual(inv.found.email_send, ['mcp:notion_mail']);
  assert.ok(inv.found.chat.includes('mcp:whatsapp') && inv.found.chat.includes('mcp:telegram'), JSON.stringify(inv.found.chat));
});

test('R7. the CRM promise lists every write; one field list; no "add them now" where the tool can\'t add', async () => {
  const T = await import('../skills/event-context/scripts/onboarding-tree.mjs');
  const t = userQ({ inv: invOf([...HUBSPOT, ...GMAIL_DRAFTS]), ans: {} }, 'tools');
  assert.match(t.question, /floorboss reads HubSpot\. It writes there only what you say yes to: a new contact \(name, email, company and job title; in your browser also the LinkedIn URL\), a task, a log of a message you sent, or an empty LinkedIn URL or job title filled in\./);
  // The same fields wherever they are named.
  const cc = userQ({ inv: invOf(HUBSPOT), cfg: { crm_log: 'browser' }, ans: {} }, 'crm_create_contacts');
  assert.ok(cc.question.includes(T.CRM_BROWSER_FIELDS), cc.question);
  // claude.ai HubSpot: its only write tool is refused for adding people, so the import is the way.
  const inv = invOf(HUBSPOT);
  assert.deepEqual(inv.found.crm_create, []);
  assert.deepEqual(invOf(tools('hubspot', ['search_contacts', 'get_owner', 'create_contact'])).found.crm_create, ['mcp:hubspot']);
  const { crmContactsQuestion } = await import('../skills/flow/scripts/steps/channels.mjs');
  const no = crmContactsQuestion({ names: 'Ana Berg', count: 1, crmName: 'HubSpot', csv: '/x/c.csv', again: false, canCreate: false });
  assert.ok(!no.options.some((o) => /^add them now/.test(o)), JSON.stringify(no.options));
  assert.match(no.question, /import \/x\/c\.csv/);
  assert.match(crmContactsQuestion({ names: 'Ana Berg', count: 1, crmName: 'HubSpot', csv: '/x/c.csv', again: false, canCreate: true }).options[0], /^add them now/);
});

test('R8. a plain name for any server, and none of the raw ones the review found', async () => {
  const { personName } = await import('../skills/event-context/scripts/scan.mjs');
  assert.equal(personName('mcp:google_workspace'), 'Google Workspace');
  assert.equal(personName('ms365'), 'Microsoft 365');
  assert.equal(personName('gmail-mcp'), 'Gmail');
  assert.equal(personName('plugin hubspot hubspot'), 'HubSpot');
  assert.equal(personName('plugin_hubspot_hubspot'), 'HubSpot');
  assert.equal(personName('mcp-acme-crm'), 'Acme Crm');
  const r = userQ({ inv: invOf([]), onboarding: { events: { older: {} } }, ans: { setup_level: 'standard', crm_choice: 'connector', crm_server: 'claude_ai_HubSpot' } }, 'reuse_setup');
  assert.ok(r, 'asked');
  assert.doesNotMatch(r.question, /claude_ai_/, r.question);
  assert.match(r.question, /your CRM \(HubSpot\)/);
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../skills/flow/scripts/savers/intake.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bpretty\(/, 'the CRM check names servers as a person knows them');
});

test('R9. the connect question promises only what happens, and has one host to speak to', async () => {
  const m = userQ({ inv: invOf([]), ans: { sending_asked: true, sending_channels: [], connect_first: true } }, 'mailbox_connect');
  assert.doesNotMatch(m.question, /nothing is asked twice|When you're back, which one/);
  assert.match(m.question, /Your answers so far are saved/);
  const { connectSteps } = await import('../skills/event-context/scripts/onboarding-tree.mjs');
  assert.doesNotMatch(connectSteps(), /Codex|ChatGPT/);
});

test('R10. send setup with no way to send gives the steps; its question has no note to the model; the task time in both zones', async () => {
  const ro = userQ({ inv: invOf(GMAIL_READ), ans: { sending_asked: true, sending_channels: ['email'] } }, 'send_setup');
  assert.match(ro.question, /can read but not send/);
  const ok = userQ({ inv: invOf(GMAIL_DRAFTS), ans: { sending_asked: true, sending_channels: ['email'] } }, 'send_setup');
  assert.doesNotMatch(ok.question, /Propose|ask only to confirm/i, ok.question);
  const t = userQ({ inv: invOf([...HUBSPOT, ...GMAIL_DRAFTS]), ans: {} }, 'tools');
  assert.doesNotMatch(t.question, /Say in one line each|ask once/);
  const { taskTimeLine } = await import('../skills/flow/scripts/steps/approval.mjs');
  assert.equal(taskTimeLine('9:00', 'Europe/Lisbon', 'America/New_York', new Date('2026-12-01T12:00:00Z')), '9:00 (Europe/Lisbon time), which is 4:00 your time (America/New_York)');
  assert.equal(taskTimeLine('9:00', 'Europe/Lisbon', 'Europe/Lisbon', new Date('2026-12-01T12:00:00Z')), '9:00 (Europe/Lisbon time)');
});

test('F6. the CRM promise and the log question say what really happens: each kind chosen in setup, one yes per batch', async () => {
  const t = userQ({ inv: invOf([...HUBSPOT, ...GMAIL_DRAFTS]), ans: {} }, 'tools');
  assert.match(t.question, /Each kind is your choice in setup; contacts, logs and filled fields then go after one yes per batch\./);
  assert.doesNotMatch(t.question, /Each of these is asked about before/);
  const { crmLogWindowQuestion } = await import('../skills/flow/scripts/steps/channels.mjs');
  const plain = crmLogWindowQuestion({ n: 2, crmName: 'HubSpot', fill: false, create: false });
  assert.match(plain, /never edits, merges or deletes anything/);
  const fill = crmLogWindowQuestion({ n: 2, crmName: 'HubSpot', fill: true, create: true });
  assert.doesNotMatch(fill, /never edits/);
  assert.match(fill, /fills an empty LinkedIn URL or job title/);
  assert.match(fill, /adds anyone not in HubSpot yet/);
});

