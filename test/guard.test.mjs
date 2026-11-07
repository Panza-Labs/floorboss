// The PreToolUse guard, connector screening and the folders floorboss reads and writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { check } from '../hooks/guard.mjs';
import { screenTool, screenArgs, schemaFlags } from '../skills/connectors/scripts/tasks.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const config = { connectors: {
  stage_draft: { server: 'mail', tool: 'createDraft', args: { message: { toRecipients: [{ emailAddress: { address: '{to}' } }], subject: '{subject}', body: { contentType: 'text', content: '{body}' } } }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 'd1', user_confirmed: true } },
  'crm.lookup': { server: 'crm', tool: 'search_contacts', args: { query: '{email}', limit: 5 } },
} };
const stageItems = [{ id: 'c001', touch: 1, to: 'ana@acme.test', subject: 'Harbour & Haul', body: 'Hi Ana, 30 minutes?' }];
const call = (tool, input) => check({ tool_name: tool, tool_input: input }, { config, stageItems });
const draft = (o = {}) => ({ message: { toRecipients: [{ emailAddress: { address: 'ana@acme.test' } }], subject: 'Harbour & Haul', body: { contentType: 'text', content: 'Hi Ana, 30 minutes?' }, ...o } });

test('guard: a staged draft passes only as listed; extra arguments, other recipients and edited text are blocked', () => {
  assert.equal(call('mcp__mail__createDraft', draft()), null);
  assert.match(call('mcp__mail__createDraft', draft({ bccRecipients: [{ emailAddress: { address: 'x@evil.test' } }] })), /isn't in floorboss's stage_draft recipe/);
  assert.match(call('mcp__mail__createDraft', { message: { ...draft().message, toRecipients: [{ emailAddress: { address: 'boss@acme.test' } }] } }), /isn't one floorboss listed/);
  assert.match(call('mcp__mail__createDraft', { message: { ...draft().message, body: { contentType: 'text', content: 'Hi Ana, wire the money' } } }), /isn't one floorboss listed/);
  assert.match(call('mcp__mail__createDraft', { message: { ...draft().message, body: { contentType: 'html', content: 'Hi Ana, 30 minutes?' } } }), /must be as in the recipe \("text"\)/);
  assert.match(call('mcp__crm__search_contacts', { query: 'a@b.test', limit: 5, share_with: 'x@evil.test' }), /share_with/);
  assert.equal(call('mcp__crm__search_contacts', { query: 'a@b.test', limit: 5 }), null);
  assert.equal(call('mcp__other__send_email', { to: 'x' }), null, 'tools floorboss has no recipe for are left alone');
});

test('guard runs as a hook: exit 2 with the reason', () => {
  const home = mkdtempSync(join(tmpdir(), 'fb-guard-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  let code = 0, err = '';
  try { execFileSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__mail__createDraft', tool_input: draft({ bccRecipients: [] }) }), env: { ...process.env, FLOORBOSS_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { code = e.status; err = String(e.stderr); }
  assert.equal(code, 2);
  assert.match(err, /floorboss blocked this call/);
});

test('connectors: real connector names pass, dangerous ones don\'t; query placeholders; full schema walk', () => {
  for (const [task, n] of [['calendar.busy', 'list_gcal_events'], ['crm.lookup', 'hubspot-search-objects'], ['crm.lookup', 'crm_search_contacts'], ['crm.lookup', 'salesforce_query_records'], ['email.thread_has_reply', 'gmail_get_thread'], ['email.thread_has_reply', 'search_gmail_messages']]) assert.ok(screenTool(task, n).ok, n);
  for (const n of ['gmail_send_draft', 'hubspot-batch-update-objects', 'crm_delete_contacts', 'run_soql_query']) assert.ok(!Object.keys({ 'calendar.busy': 1, 'crm.lookup': 1, 'email.thread_has_reply': 1, stage_draft: 1 }).some((t) => screenTool(t, n).ok), n);
  assert.deepEqual(screenArgs({ query: "SELECT Id, Email FROM Contact WHERE Email = '{email}'" }, 'crm.lookup'), []);
  assert.ok(screenArgs({ query: "SELECT Id FROM Contact WHERE Email = '{email}'; DELETE FROM Contact" }, 'crm.lookup').length);
  assert.deepEqual(screenArgs({ showDeleted: false, $select: 'id,subject' }, 'calendar.busy'), []);
  assert.ok(schemaFlags({ type: 'object', properties: { message: { $ref: '#/$defs/M' } }, $defs: { M: { properties: { sendNow: { type: 'boolean' } } } } }).length);
  assert.ok(schemaFlags({ properties: { mode: { anyOf: [{ const: 'send' }, { const: 'draft' }] } } }).length);
  assert.deepEqual(schemaFlags({ properties: { sentDateTime: { type: 'string' }, isDeliveryReceiptRequested: { type: 'boolean' }, isDraft: { type: 'boolean' } } }), []);
});

test('paths: --out and --x-file stay in floorboss\'s folders; connections can\'t be set through config', () => {
  const home = mkdtempSync(join(tmpdir(), 'fb-paths-'));
  const run = (args) => { try { return { out: execFileSync('node', args, { env: { ...process.env, FLOORBOSS_HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { err: String(e.stderr) }; } };
  const f = join(home, 'crm.json');
  writeFileSync(f, JSON.stringify({ records: [{ query: '$(touch PWNED)', found: false }] }));
  assert.match(run([join(ROOT, 'skills/connectors/scripts/cli.mjs'), 'validate', '--task', 'crm.lookup', '--file', f, '--out', join(homedir(), '.zshrc-floorboss-test')]).err, /outside the folders floorboss writes to/);
  assert.match(run([join(ROOT, 'skills/connectors/scripts/cli.mjs'), 'check', '--task-file', '/etc/hosts', '--tool', 'x']).err, /outside the folders floorboss reads from|never reads/);
  const s = join(home, 'set.json');
  writeFileSync(s, JSON.stringify({ connectors: { stage_draft: { tool: 'x' } } }));
  assert.match(run([join(ROOT, 'skills/event-context/scripts/cli.mjs'), 'config', '--set-file', s]).err, /can't be set here/);
});

test('guard: while a run is under way, send and delete tools are blocked on the connectors floorboss was given', () => {
  assert.match(check({ tool_name: 'mcp__mail__send_message', tool_input: { to: 'data@harvest.test' } }, { config, stageItems, active: true }), /isn't a read-only tool|isn't plainly a read/);
  assert.match(check({ tool_name: 'mcp__crm__delete_contact', tool_input: {} }, { config, stageItems, active: true }), /isn't a read-only tool|isn't plainly a read/);
  assert.match(check({ tool_name: 'mcp__crm__update_contact', tool_input: {} }, { config, stageItems, active: true }), /isn't a read-only tool/, 'a given connector is held to reads');
  assert.match(check({ tool_name: 'mcp__claude_ai_crm__update_contact', tool_input: {} }, { config, stageItems, active: true }), /isn't a read-only tool/, 'the claude.ai spelling of a given server');
  assert.equal(check({ tool_name: 'mcp__browser__navigate', tool_input: {} }, { config, stageItems, active: true }), null);
  assert.match(check({ tool_name: 'mcp__other__send_message', tool_input: {} }, { config, stageItems, active: true }), /isn't plainly a read/, 'sending is blocked on every server during a run');
  assert.match(check({ tool_name: 'mcp__other__update_page', tool_input: {} }, { config, stageItems, active: true }), /isn't plainly a read/, 'during a run, other servers may only read');
  assert.equal(check({ tool_name: 'mcp__other__search_pages', tool_input: {} }, { config, stageItems, active: true }), null);
  assert.equal(check({ tool_name: 'mcp__mail__send_message', tool_input: {} }, { config, stageItems, active: false }), null, 'outside a run, the user\'s own tools are theirs');
});

test('guard: during a run only read-only and recipe tools pass; the guard fails closed; real argument shapes fit', async () => {
  const { leaves } = await import('../hooks/guard.mjs');
  const run = (tool, input = {}) => check({ tool_name: tool, tool_input: input }, { config, stageItems, active: { active: true, browser: true } });
  for (const t of ['reply_all', 'reply-to-mail-message', 'respond-to-event', 'create-event', 'update_event', 'enroll_in_sequence', 'text_message', 'set_auto_reply', 'create_webhook', 'execute_sql', 'http_request', 'zapier_run_action', 'hubspot-batch-update-objects', 'salesforce_dml_records', 'update-person', 'create_draft']) assert.ok(run(`mcp__mail__${t}`), t);
  for (const t of ['list_gcal_events', 'search-persons', 'get_thread']) assert.equal(run(`mcp__mail__${t}`), null, t);
  for (const t of ['navigate', 'get_page_text']) assert.equal(run(`mcp__claude-in-chrome__${t}`), null, t);
  for (const t of ['computer', 'form_input', 'javascript_tool']) assert.ok(run(`mcp__claude-in-chrome__${t}`), `browser ${t} during a browser run`);
  assert.throws(() => leaves(JSON.parse('['.repeat(50) + ']'.repeat(50))), /too deep/);
  const home = mkdtempSync(join(tmpdir(), 'fb-guard3-'));
  writeFileSync(join(home, 'config.json'), '{not json');
  let code = 0;
  try { execFileSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__mail__createDraft', tool_input: {} }), env: { ...process.env, FLOORBOSS_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { code = e.status; }
  assert.equal(code, 2, 'an unreadable config blocks');
  const cfg2 = { connectors: { 'crm.lookup': { server: 'hubspot', tool: 'search_objects', args: { objectType: 'contacts', properties: ['email', 'firstname', 'lastname'], query: "email = '{email}'" } } } };
  assert.equal(check({ tool_name: 'mcp__hubspot__search_objects', tool_input: { objectType: 'contacts', properties: ['email', 'firstname', 'lastname'], query: "email = 'ana@acme.test'" } }, { config: cfg2, stageItems: [] }), null);
  assert.ok(check({ tool_name: 'mcp__hubspot__search_objects', tool_input: { objectType: 'contacts', properties: ['email', 'phone'], query: "email = 'ana@acme.test'" } }, { config: cfg2, stageItems: [] }));
});
