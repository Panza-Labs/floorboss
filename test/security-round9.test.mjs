// Round 9 security fixes (2026-11-08), from the third audit: connector setup commands in the session that ran
// floorboss. Setup runs them mid-run, so they stay available; what they can reach is held. Invented servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_TASK } from '../skills/connectors/scripts/tasks.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const CLI = join(ROOT, 'skills/connectors/scripts/cli.mjs');
const SESSION = 'sess-run';
const env = (h) => ({ ...process.env, FLOORBOSS_HOME: h, FLOORBOSS_TEST: '1', CLAUDE_PLUGIN_ROOT: ROOT });
function home({ config = {}, found = false, lock = true } = {}) {
  const h = mkdtempSync(join(tmpdir(), 'fb-r9-'));
  writeFileSync(join(h, 'config.json'), JSON.stringify(config));
  const now = new Date().toISOString();
  if (lock) writeFileSync(join(h, 'active.json'), JSON.stringify({ at: now, browser: false, sessions: { [SESSION]: now } }));
  if (found) writeFileSync(join(h, 'inventory.json'), JSON.stringify({ setup_servers: ['hubspot', 'gcal', 'gmail'], found: { crm: ['mcp:hubspot'], calendar: ['mcp:gcal'], email: ['mcp:gmail'] } }));
  return h;
}
const guard = (h, input) => {
  const r = spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], {
    input: JSON.stringify({ session_id: SESSION, hook_event_name: 'PreToolUse', ...input }),
    env: env(h),
    encoding: 'utf8'
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
};
const bash = (h, command, extra = {}) => guard(h, { tool_name: 'Bash', tool_input: { command }, ...extra });
const run = (h, args) => {
  const r = spawnSync('node', [CLI, ...args], { env: env(h), encoding: 'utf8' });
  return r.stdout + r.stderr;
};
function files(h, server, tool = 'search_contacts') {
  const recipe = join(h, 'work-recipe.json');
  writeFileSync(recipe, JSON.stringify({ server, tool, args: { query: '{email}' }, reading: 'The answer lists contacts by email.', opt_out_source: 'hs_opt_out' }));
  return recipe;
}
const saveCmd = (recipe) => `node ${CLI} save-recipe --task crm.lookup --recipe-file ${recipe}`;

test('a recipe on a server setup did not find, saved in the run session, is the user\'s to allow', () => {
  const h = home({ found: true });
  const r = bash(h, saveCmd(files(h, 'notes')));
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, 'ask');
  assert.match(r.out, /notes.{1,6}search_contacts/);
});

test('a recipe on the server setup found saves without a prompt; moving a saved connection asks', () => {
  const h = home({ found: true });
  assert.equal(bash(h, saveCmd(files(h, 'hubspot'))).out, '');
  const moved = home({ found: true, config: { connectors: { 'crm.lookup': { server: 'salesforce', tool: 'find_person' } } } });
  assert.match(bash(moved, saveCmd(files(moved, 'hubspot'))).out, /replaces .{0,3}salesforce/);
});

test('a subagent never saves or forgets a connection; another session is not held', () => {
  const h = home({ found: true });
  assert.equal(bash(h, saveCmd(files(h, 'hubspot')), { agent_id: 'a1', agent_type: 'floorboss:attendee-researcher' }).code, 2);
  const other = home({ found: true, lock: false });
  assert.equal(bash(other, saveCmd(files(other, 'notes'))).out, '');
});

test('forget asks in the run session; a recipe file the guard cannot read is refused', () => {
  const h = home();
  assert.match(bash(h, `node ${CLI} forget --task crm.lookup --user-confirmed`).out, /forget your .{0,3}crm.lookup/);
  assert.equal(bash(h, `node ${CLI} save-recipe --task crm.lookup --recipe-file ${join(h, 'absent.json')}`).code, 2);
});

test('the script saves only the recipe the guard looked at, and the note is used once', () => {
  const h = home({ found: true });
  const recipe = files(h, 'hubspot');
  const tool = join(h, 'tool.json');
  writeFileSync(tool, JSON.stringify({ name: 'search_contacts', description: 'Find contacts', inputSchema: { properties: {} } }));
  const probe = join(h, 'probe.json');
  writeFileSync(probe, JSON.stringify({ records: [], not_found: ['a@acme.test'] }));
  bash(h, saveCmd(recipe));
  assert.ok(existsSync(join(h, 'recipe-seen.json')));
  files(h, 'notes');
  const out = run(h, ['save-recipe', '--task', 'crm.lookup', '--recipe-file', recipe, '--tool-file', tool, '--probe-file', probe, '--contacts', 'a@acme.test']);
  assert.match(out, /hasn't checked this exact command/, out);
  assert.equal(JSON.parse(readFileSync(join(h, 'config.json'), 'utf8')).connectors?.['crm.lookup'], undefined);
  assert.ok(!existsSync(join(h, 'recipe-seen.json')));
});

test('a test task goes only to the CRM crm.lookup reads', () => {
  const h = home({ lock: false, config: { connectors: { 'crm.lookup': { server: 'hubspot', tool: 'search_contacts' } } } });
  assert.match(run(h, ['test-allow', '--task', 'crm.create_task', '--server', 'asana', '--tool', 'create_task']), /your CRM's own server/);
  assert.match(run(h, ['test-allow', '--task', 'crm.create_task', '--server', 'hubspot', '--tool', 'create_task']), /use_text/);
});

test('in the run session a pending test task on another server is not let past the run lock', () => {
  const pending = (server) => JSON.stringify({ task: 'crm.create_task', server, tool: 'create_task', to: null, at: new Date().toISOString() });
  const call = (h, server) => guard(h, { tool_name: `mcp__${server}__create_task`, tool_input: { title: TEST_TASK.title, body: TEST_TASK.body } });
  const h = home({ found: true });
  writeFileSync(join(h, 'test-pending.json'), pending('asana'));
  const r = call(h, 'asana');
  assert.equal(r.code, 2, r.out);
  assert.doesNotMatch(r.out, /TEST task/);
  const crm = home({ found: true });
  writeFileSync(join(crm, 'test-pending.json'), pending('hubspot'));
  assert.match(call(crm, 'hubspot').out, /TEST task/);
});

test('quoting the sub-command or flags changes nothing the guard sees', () => {
  for (const q of ['"save-recipe"', "'save-recipe'", 'sa""ve-recipe', "save'-'recipe"]) {
    const h = home({ found: true });
    const recipe = files(h, 'notes');
    const r = bash(h, `node ${CLI} ${q} --task crm.lookup --recipe-file ${recipe}`);
    assert.match(r.out, /notes.{1,6}search_contacts/, q);
    assert.ok(existsSync(join(h, 'recipe-seen.json')), q);
    assert.equal(bash(h, `node ${CLI} ${q} --task crm.lookup --recipe-file ${recipe}`, { agent_id: 'a1', agent_type: 'floorboss:attendee-researcher' }).code, 2, q);
  }
  const h = home({ config: { connectors: { 'calendar.busy': { server: 'gcal', tool: 'x' }, 'crm.lookup': { server: 'hubspot', tool: 'y' } } } });
  assert.match(bash(h, `node ${CLI} "forget" --task calendar.busy --ta'sk' crm.lookup --user-confirmed`).out, /forget your .{0,3}crm\.lookup/);
  assert.equal(bash(h, `node ${CLI} forget --task-file ${join(h, 'config.json')} --user-confirmed`).code, 2);
});

test('with a session held, the script changes nothing the guard did not note', () => {
  const h = home({ config: { connectors: { 'crm.lookup': { server: 'hubspot', tool: 'y' } } } });
  assert.match(run(h, ['forget', '--task', 'crm.lookup', '--user-confirmed']), /hasn't checked this exact command/);
  assert.ok(JSON.parse(readFileSync(join(h, 'config.json'), 'utf8')).connectors['crm.lookup']);
  const free = home({ lock: false, config: { connectors: { 'crm.lookup': { server: 'hubspot', tool: 'y' } } } });
  assert.match(run(free, ['forget', '--task', 'crm.lookup', '--user-confirmed']), /"forgotten": ?true/);
});

test('in the run session every pending test holds to its own server', () => {
  const call = (h, server, tool, args) => guard(h, { tool_name: `mcp__${server}__${tool}`, tool_input: args });
  const draft = { to: 'me@acme.test', subject: 'x', body: 'session text' };
  const h = home({ found: true, config: { own_email: 'me@acme.test' } });
  writeFileSync(join(h, 'test-pending.json'), JSON.stringify({ task: 'stage_draft', server: 'notes', tool: 'create_draft', to: 'me@acme.test', at: new Date().toISOString() }));
  const r = call(h, 'notes', 'create_draft', draft);
  assert.equal(r.code, 2, r.out);
  assert.doesNotMatch(r.out, /TEST draft/);
  const off = home({ found: true });
  writeFileSync(join(off, 'test-pending.json'), JSON.stringify({ task: 'crm.create_task', server: 'gcal', tool: 'create_task', to: null, at: new Date().toISOString() }));
  assert.doesNotMatch(call(off, 'gcal', 'create_task', { title: TEST_TASK.title, body: TEST_TASK.body }).out, /TEST task/);
});

test('a tool name with a further __ is not saved silently', () => {
  const h = home({ found: true });
  assert.match(bash(h, saveCmd(files(h, 'hubspot', 'search__contacts'))).out, /search__contacts/);
});

test('a declined prompt cannot be walked around: decoy script names, line continuations, a recipe that throws', () => {
  const h = home({ found: true });
  const recipe = files(h, 'notes');
  assert.match(bash(h, saveCmd(recipe)).out, /notes.{1,6}search_contacts/);
  const rest = `--task crm.lookup --recipe-file ${recipe}`;
  const decoy = `node ${CLI.replace('skills/connectors', 'skills/conn""ectors')} save-recipe ${rest} --z skills/flow/scripts/cli.mjs`;
  assert.match(bash(h, decoy).out, /notes.{1,6}search_contacts/, 'decoy');
  assert.match(bash(h, `node ${CLI} "save-\\\nrecipe" ${rest}`).out, /notes.{1,6}search_contacts/, 'continuation');
  const bomb = join(h, 'bomb.json');
  writeFileSync(bomb, JSON.stringify({ server: { toString: 1, valueOf: 1 }, tool: 'x' }));
  assert.equal(bash(h, `node ${CLI} save-recipe --task crm.lookup --recipe-file ${bomb}`).code, 2, 'not plain names');
  writeFileSync(join(h, 'inventory.json'), '{ not json');
  assert.equal(bash(h, saveCmd(recipe)).code, 2, 'a throw is a refusal');
});

test('the note covers the whole command; a leftover note blocks nobody outside a run; only real tasks save', () => {
  const h = home({ found: true });
  const recipe = files(h, 'hubspot');
  bash(h, saveCmd(recipe));
  assert.match(run(h, ['save-recipe', '--task', 'crm.lookup', '--recipe-file', recipe, '--z', 'extra']), /hasn't checked this exact command/);
  const free = home({ lock: false, config: { connectors: { 'crm.lookup': { server: 'hubspot', tool: 'y' } } } });
  writeFileSync(join(free, 'recipe-seen.json'), JSON.stringify({ argv: ['other'], at: new Date().toISOString() }));
  assert.match(run(free, ['forget', '--task', 'crm.lookup', '--user-confirmed']), /"forgotten": ?true/);
  assert.match(run(free, ['save-recipe', '--task', 'constructor', '--recipe-file', files(free, 'hubspot')]), /no task called/);
});

test('a prompt shows a server name on one line; an older inventory still counts for a test', () => {
  const h = home({ found: true });
  const r = join(h, 'nl.json');
  writeFileSync(r, JSON.stringify({ server: `${'\n'.repeat(40)}notes`, tool: 'search_contacts' }));
  assert.doesNotMatch(JSON.parse(bash(h, `node ${CLI} save-recipe --task crm.lookup --recipe-file ${r}`).out).hookSpecificOutput.permissionDecisionReason, /\n\n\n/);
  const old = home();
  writeFileSync(join(old, 'inventory.json'), JSON.stringify({ found: { crm: ['mcp:hubspot'] } }));
  writeFileSync(join(old, 'test-pending.json'), JSON.stringify({ task: 'crm.create_task', server: 'hubspot', tool: 'create_task', to: null, at: new Date().toISOString() }));
  assert.match(guard(old, { tool_name: 'mcp__hubspot__create_task', tool_input: { title: TEST_TASK.title, body: TEST_TASK.body } }).out, /TEST task/);
});

test('the plugin folder variable counts only as the start of the script path', () => {
  const h = home({ found: true });
  const recipe = files(h, 'notes');
  const rest = `--task crm.lookup --recipe-file ${recipe}`;
  for (const c of [`node ${CLI} $CLAUDE_PLUGIN_ROOT save-recipe ${rest}`, `node ${CLI} sa\${CLAUDE_PLUGIN_ROOT}ve-recipe ${rest}`, `node ${CLI} save-recipe ${rest} --x "$CLAUDE_PLUGIN_ROOT"`])
    assert.equal(bash(h, c).code, 2, c);
  const r = bash(h, `node "\${CLAUDE_PLUGIN_ROOT}/skills/connectors/scripts/cli.mjs" save-recipe ${rest}`);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /notes.{1,6}search_contacts/);
});

test('a full tool name that points at another server is not saved silently', () => {
  const h = home({ found: true });
  assert.match(bash(h, saveCmd(files(h, 'hubspot', 'mcp__notes__search_contacts'))).out, /mcp__notes__search_contacts/);
  assert.equal(bash(h, saveCmd(files(h, 'hubspot', 'mcp__hubspot__search_contacts'))).out, '');
});

test('a script name split by quotes is no script call: held to the run, and never run past the rules', () => {
  const h = home();
  for (const c of [`node x/skills/con""nectors/scripts/cli.mjs status; touch pwned`, `node x/skills/flow/scripts/c""li.mjs status > pwned`, `node x/skills/conn\\ectors/scripts/cli.mjs status`])
    assert.equal(bash(h, c).code, 2, c);
});

test('a literal $CLAUDE_PLUGIN_ROOT is a folder, not the plugin; =name after empty quotes is refused', () => {
  const h = home();
  assert.equal(bash(h, `node '$CLAUDE_PLUGIN_ROOT/skills/connectors/scripts/cli.mjs' status`).code, 2);
  assert.equal(bash(h, `node "\\$CLAUDE_PLUGIN_ROOT/skills/connectors/scripts/cli.mjs" status`).code, 2);
  assert.equal(bash(h, `node "\${CLAUDE_PLUGIN_ROOT}/skills/connectors/scripts/cli.mjs" status --v ''=ls`).code, 2);
  assert.equal(bash(h, `node "\${CLAUDE_PLUGIN_ROOT}/skills/connectors/scripts/cli.mjs" status`).code, 0);
});
