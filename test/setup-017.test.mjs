// 0.1.7 setup problems from sim run 3 (design note of 2026-11-22, spec section 8), one test each:
// 1. "connect a mailbox first" leads somewhere: steps for this host, answers kept, check again or go on without;
// 2. a mailbox with no send tool is described as "floorboss can read replies, and you send";
// 3. Slack is not a mailbox and Notion is not a calendar; an unknown tool is nothing;
// 4. the names a person knows ("Gmail", "HubSpot"), never "claude_ai_Gmail";
// 5. Claude Code's follow-up text says what happens after approval, as the final choice (lib/autosend/pick.mjs) does;
// 6. Codex: turning auto-send on comes with the steps to create the ChatGPT task, and a check that it exists;
// 7. the CRM promise says what is true (reads; adds a contact or a task only with a yes each time), and the add offer
//    names its fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { summarize } from '../skills/event-context/scripts/scan.mjs';
import { NODES, levelOptions } from '../skills/event-context/scripts/onboarding-tree.mjs';
import { setup, cli } from './fixtures/harness.mjs';
import { makeHome, simplePersona, ROOT } from './sims/lib/driver.mjs';
import { untilStep } from './fixtures/flow-until.mjs';

const EV = { slug: 'ev', name: 'Expo', start_date: '2026-12-10', app_name: null, no_app: true };
const tools = (server, list) => list.map((t) => `mcp__${server}__${t}`);
const invOf = (toolList) => summarize([], { tools: toolList });
// The question with this id, if it applies and is still open at this state (whatever comes before it).
const q = (s0, id) => {
  const s = { ev: EV, cfg: {}, ...s0, ans: { setup_level: 'full', ...s0.ans } };
  const n = NODES.find((x) => x.id === id);
  return n && n.when(s) && !n.done(s) ? { id, ask: n.ask(s), ...(n.options ? { options: n.options(s) } : {}) } : null;
};
// The answers saved so far, as the tree reads them (setup's and this event's).
const saved = (H) => {
  const st = JSON.parse(readFileSync(join(H.HOME, 'onboarding.json'), 'utf8'));
  return { ...(st.answers || {}), ...(st.events?.[H.slug]?.answers || {}) };
};
const GMAIL_READ = tools('claude_ai_Gmail', ['search_threads', 'get_thread', 'list_labels', 'create_draft']);
const GMAIL_SEND = tools('claude_ai_Gmail', ['search_threads', 'get_thread', 'create_draft', 'send_email']);
const HUBSPOT = tools('claude_ai_HubSpot', ['search_crm_objects', 'get_crm_objects', 'search_owners', 'manage_crm_objects']);

test('1. "connect my mailbox first" asks next how to connect, keeps the answers, and offers check again or go on', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\n' });
  const f = join(H.dir, 'sending.json');
  writeFileSync(f, JSON.stringify("I'll connect my mailbox first"));
  const r = cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'sending', '--value-file', f]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.ok(q({ inv: invOf([]), ans: saved(H) }, 'mailbox_connect'), `the next question is how to connect: ${JSON.stringify(saved(H))}`);
  // The question itself (Claude Code): the connector steps, the answers kept, two numbered answers that say what follows.
  const m = q({ inv: invOf([]), ans: { sending_asked: true, sending_channels: [], connect_first: true } }, 'mailbox_connect');
  assert.ok(m, 'asked');
  assert.match(m.ask, /Gmail/);
  assert.match(m.ask, /claude\.ai/i);
  assert.match(m.ask, /saved/i);
  assert.equal(m.options.length, 2);
  // Shown numbered (Codex) or as buttons (Claude Code) by the flow: "label: what happens next".
  assert.match(m.options[0], /^check again: /i);
  assert.match(m.options[1], /^go on without a mailbox: /i);
  assert.match(m.options[1], /send .*yourself|you send/i);
  // Connectors only as the name of the page the user opens.
  for (const t of [m.ask, ...m.options]) assert.doesNotMatch(t.replace(/claude\.ai\/customize\/connectors|Customize, then Connectors/g, ''), /connector|MCP|session|slug|recipe/i, t);
  // Check again: the sending question comes back after a new look at what is connected.
  writeFileSync(f, JSON.stringify('1'));
  const r2 = cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'mailbox_connect', '--value-file', f]);
  assert.ok(!r2.ERROR, r2.ERROR);
  const a2 = saved(H);
  assert.ok(!q({ inv: invOf([]), ans: a2 }, 'mailbox_connect'), JSON.stringify(a2));
  assert.ok(q({ inv: invOf([]), ans: a2 }, 'sending'), 'the sending question is asked again');
  assert.ok(a2.rescan_at, 'and what is connected is looked at again first');
});

test('2. a Gmail that can only read is not described as a way to send', () => {
  const inv = invOf(GMAIL_READ);
  assert.ok(inv.found.email.includes('mcp:claude_ai_Gmail'), 'still a mailbox to read');
  assert.deepEqual(inv.found.email_send || [], [], 'no send tool: nothing to send with');
  assert.deepEqual(invOf(GMAIL_SEND).found.email_send, ['mcp:claude_ai_Gmail']);
  const t = q({ inv, ans: {} }, 'tools');
  assert.match(t.ask, /floorboss can read replies in Gmail, and you send/);
  const full = levelOptions({ inv, ans: {} })[2];
  assert.doesNotMatch(full, /sends what you approve from Gmail/, full);
  assert.match(levelOptions({ inv: invOf(GMAIL_SEND), ans: {} })[2], /sends what you approve from Gmail/);
  // Email picked anyway: the send setup says plainly there is nothing to send with, instead of setting it up.
  const ss = q({ inv, ans: { sending_asked: true, sending_channels: ['email'] } }, 'send_setup');
  assert.match(ss.ask, /can read but not send: floorboss can still read replies, and you send/);
});

test('3. each connected tool is counted as what it is: Slack no mailbox, Notion no calendar, an unknown tool nothing', () => {
  const inv = invOf([
    ...tools('claude_ai_Slack', ['slack_read_thread', 'slack_search_messages', 'slack_send_message']),
    ...tools('claude_ai_Notion', ['notion-search', 'notion-fetch', 'notion-calendar-list-events']),
    ...tools('claude_ai_Linear', ['list_issues', 'get_issue', 'create_issue']),
    ...tools('acme_thing', ['frobnicate', 'list_widgets']),
    ...GMAIL_SEND,
    ...tools('claude_ai_Google_Calendar', ['list_events', 'get_freebusy'])
  ]);
  assert.deepEqual(inv.found.email, ['mcp:claude_ai_Gmail']);
  assert.deepEqual(inv.found.calendar, ['mcp:claude_ai_Google_Calendar']);
  assert.ok(!inv.found.crm.length, JSON.stringify(inv.found.crm));
  assert.deepEqual(inv.items.find((x) => x.name === 'acme_thing').kinds, []);
  assert.deepEqual(inv.items.find((x) => x.name === 'claude_ai_Linear').kinds, []);
});

test('4. the user reads "Gmail" and "HubSpot", never a raw id', async () => {
  const inv = invOf([...GMAIL_SEND, ...tools('gmail', ['search_emails', 'read_email', 'send_email']), ...HUBSPOT]);
  const t = q({ inv, ans: {} }, 'tools');
  assert.doesNotMatch(t.ask, /claude_ai_|\bgmail\b/, t.ask);
  assert.match(t.ask, /Gmail/);
  assert.match(t.ask, /HubSpot/);
  const { summaryLine } = await import('../skills/flow/scripts/steps/intake.mjs');
  const line = summaryLine({ ob: { ans: { crm_choice: 'connector', crm_server: 'claude_ai_HubSpot' }, inv }, event: { inputs: {} } }, ['crm'], []);
  assert.doesNotMatch(line, /claude_ai_/, line);
  assert.match(line, /HubSpot/);
});

test('5. Claude Code: the follow-up question says what happens after approval, as the final choice offers it', () => {
  const inv = invOf(GMAIL_SEND);
  const f = q({ inv, ans: { sending_asked: true, sending_channels: ['email'], send_setup_done: true } }, 'followups_mode');
  assert.ok(f, 'asked');
  const all = [f.ask, ...f.options].join(' ');
  // No promise that a follow-up goes by itself on its day; the picks are the final choice's (see setup-017-review R2).
  assert.doesNotMatch(all, /each goes on its day unless/);
  assert.match(all, /Gmail drafts/);
  assert.match(all, /myself/);
  assert.match(all, /Claude Code asks you before each/);
  assert.match(all, /laptop/);
});

test('6. Codex: turning auto-send on comes with the steps to create the ChatGPT task, and a check that it is created', { timeout: 300000 }, () => {
  const H = makeHome({
    context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' },
    attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.example\nBo Li,VP Ops,Globex,bo@globex.example\nCy Ng,Head of Ops,Initech,cy@initech.example\n'
  });
  Object.assign(H.env, { CODEX_SESSION_ID: 'codex-sess', CODEX_THREAD_ID: 'codex-thread' });
  delete H.env.CLAUDECODE;
  const persona = simplePersona({
    asks: { setup_level: 'quick', attendee_list: join(H.HOME, 'inputs', 'attendees.csv'), sending: 'yes, send them from my Gmail', send_setup: 'sam@gmail.example', touches: '4', voice_samples: 'skip' },
    judge: { research: (x) => ({ identity_confirmed: true, role_seen: x.title, person_claims: 0, complete: true, claims: [{ text: `${x.company} runs regional warehouses.`, url: `https://${String(x.company).toLowerCase()}.example/about` }] }) }
  });
  const hit = untilStep(H, persona, (s) => s.step === 'approve' || s.step === 'autosend_on', { maxSteps: 250 });
  assert.equal(hit.step, 'autosend_on', hit.trail.join(' '));
  execFileSync(hit.last.run[0], hit.last.run.slice(1), { env: H.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const flow = (args) => JSON.parse(execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), ...args], { env: H.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  // The follow-ups are drafted first; then, before the approval, the task.
  const h2 = untilStep(H, persona, (s) => s.step === 'daily_task' || s.step === 'approve', { maxSteps: 120 });
  const n = h2.last;
  assert.equal(n.step, 'daily_task', JSON.stringify(n).slice(0, 400));
  const qt = n.ask.question;
  for (const k of ['1. ', '2. ', '3. ', '4. ']) assert.ok(qt.includes(k), `numbered step ${k}: ${qt}`);
  assert.match(qt, /chatgpt\.com/);
  assert.match(qt, /floorboss daily sending/);
  assert.match(qt, /Always allow/);
  assert.match(qt, /created\?/);
  assert.equal(n.ask.options.length, 2);
  assert.match(n.ask.options[0], /^yes, it's created: /);
  assert.match(n.ask.options[1], /^not yet: /);
  // "not yet": not asked again in this session; the next session asks again, saying nothing is sent until then.
  const sess = join(H.HOME, 'work', 'session-event.json');
  const cur = JSON.parse(readFileSync(sess, 'utf8'));
  writeFileSync(sess, JSON.stringify({ ...cur, run: 'r-this-session' }));
  const ny = join(H.HOME, 'ny.json');
  writeFileSync(ny, JSON.stringify('not yet'));
  flow(['answer', '--ask', 'daily_task', '--value-file', ny]);
  assert.notEqual(flow(['next']).step, 'daily_task');
  writeFileSync(sess, JSON.stringify({ ...cur, run: 'r-next-session' }));
  const again = flow(['next']);
  assert.equal(again.step, 'daily_task', JSON.stringify(again).slice(0, 300));
  assert.match(again.ask.question, /^Nothing will be sent until you create the task\./);
  // The yes is the user's: then the flow goes on (to the approval, after anything still open) and does not ask again.
  const f = join(H.HOME, 'dt.json');
  writeFileSync(f, JSON.stringify('1'));
  flow(['answer', '--ask', 'daily_task', '--value-file', f]);
  assert.notEqual(flow(['next']).step, 'daily_task');
});

test('7. the CRM promise is what is true, and the add offer names the fields it adds', async () => {
  const inv = invOf([...HUBSPOT, ...GMAIL_SEND]);
  const t = q({ inv, ans: {} }, 'tools');
  assert.doesNotMatch(t.ask, /reading only/i, t.ask);
  assert.match(t.ask, /floorboss reads HubSpot\. It writes there only what you say yes to/);
  const { summaryLine } = await import('../skills/flow/scripts/steps/intake.mjs');
  const line = summaryLine({ ob: { ans: { crm_choice: 'connector', crm_server: 'claude_ai_HubSpot' }, inv }, event: { inputs: {} } }, ['crm'], []);
  assert.doesNotMatch(line, /reading only/, line);
  const { crmContactsQuestion } = await import('../skills/flow/scripts/steps/channels.mjs');
  const cq = crmContactsQuestion({ names: 'Ana Berg, Bo Li', count: 2, crmName: 'HubSpot', csv: '/x/contacts.csv', again: false });
  assert.match(cq.question, /name, email, company and job title/);
  assert.match(cq.question, /nothing else/);
  assert.match(cq.question, /asks you before each one/);
  assert.match(cq.options[0], /^add them now/);
});
