// The guard's rules for unattended drafts that need no event: Claude's file tools never write floorboss's unattended
// folder (the opt-in, the authorisations, the tickets, the witnesses, the log); a shell command that names the follow-up
// job, its install, its launcher mode, launchctl with a start word, the run's token or the unattended folder is refused
// in every session, a run going on or not, ticketed or not; turning unattended runs off is allowed in every session;
// and the Claude Code run the launcher starts never gets a flag that turns the guard off or answers a prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argsRefusal, claudeRun, NEVER_FLAGS, FOLLOWUPS_PROMPT, UNATTENDED_DISALLOWED } from '../lib/unattended.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const base = realpathSync(mkdtempSync(join(tmpdir(), 'fb-sud-')));
const HOME = join(base, 'home');
const FB = join(HOME, '.floorboss');
mkdirSync(join(FB, 'unattended', 'optin'), { recursive: true });
mkdirSync(join(HOME, 'Library', 'LaunchAgents'), { recursive: true });
const env = { PATH: process.env.PATH, HOME, USERPROFILE: HOME, FLOORBOSS_HOME: FB, CLAUDE_PLUGIN_ROOT: ROOT, FLOORBOSS_TEST: '1', CLAUDE_CONFIG_DIR: join(HOME, '.claude') };
const guard = (tool_name, tool_input, { session = 's1', extra = {} } = {}) =>
  spawnSync(process.execPath, [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input, session_id: session }), env: { ...env, ...extra }, encoding: 'utf8', cwd: base });
// A session that ran floorboss (its run lock), for "every session".
const held = () => writeFileSync(join(FB, 'active.json'), JSON.stringify({ at: new Date().toISOString(), sessions: { s1: new Date().toISOString() } }));
const free = () => writeFileSync(join(FB, 'active.json'), JSON.stringify({ at: '2020-01-01T00:00:00Z', sessions: {} }));

test("Claude's file tools never write floorboss's unattended records", () => {
  for (const f of ['optin/ev.json', 'authorised.jsonl', 'tickets/0b0b0b0b-0000-4000-8000-000000000000.json', 'witness/x/ev--c001.mail.json', 'log.jsonl', 'off', 'followups-installed.json', 'summary-2026-10-13.md', 'running.lock'])
    for (const [tool, input] of [
      ['Write', { file_path: join(FB, 'unattended', f), content: '{}' }],
      ['Edit', { file_path: join(FB, 'unattended', f), old_string: 'a', new_string: 'b' }],
      ['MultiEdit', { file_path: join(FB, 'unattended', f), edits: [{ old_string: 'a', new_string: 'b' }] }]
    ]) {
      const r = guard(tool, input);
      assert.equal(r.status, 2, `${tool} ${f}: ${r.stderr}`);
      assert.match(r.stderr, /floorboss's own records/);
    }
  // The follow-up job's launchd file, by name or by what it names.
  for (const input of [
    { file_path: join(HOME, 'Library', 'LaunchAgents', 'com.floorboss.followups.plist'), content: '<plist/>' },
    { file_path: join(HOME, 'Library', 'LaunchAgents', 'com.example.x.plist'), content: `<string>${ROOT}/scripts/scheduled.mjs</string><string>followups</string>` }
  ])
    assert.equal(guard('Write', input).status, 2, input.file_path);
});

const NAMED = [
  `node ${ROOT}/scripts/unattended.mjs install-followups`,
  `node "\${CLAUDE_PLUGIN_ROOT}/scripts/unattended.mjs" uninstall-followups`,
  `node ${ROOT}/scripts/unattended.mjs on`,
  'launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.floorboss.followups.plist',
  'launchctl kickstart -k gui/501/com.floorboss.followups',
  'plutil -replace StartCalendarInterval -json "[]" ~/Library/LaunchAgents/com.floorboss.followups.plist',
  `node ${ROOT}/scripts/scheduled.mjs followups`,
  `cd ${ROOT}/scripts && node scheduled.mjs followups`,
  'FLOORBOSS_UNATTENDED=abc claude -p "/floorboss:followups-due"',
  'echo $FLOORBOSS_UNATTENDED',
  'env | grep FLOORBOSS_UNATTENDED',
  `cat ${FB}/unattended/tickets/x.json > /tmp/t`,
  `rm -rf ${FB}/unattended/off`,
  `echo '{}' > ${FB}/unattended/optin/ev.json`
];
test('a shell command naming the job, its install, its launcher mode, the token or the folder is refused in every session', () => {
  const token = { FLOORBOSS_UNATTENDED: 'a'.repeat(64) };
  for (const [label, setup, extra] of [
    ['no run', free, {}],
    ['a floorboss run in this session', held, {}],
    ['a run with a token', free, token]
  ]) {
    setup();
    for (const cmd of NAMED) {
      const r = guard('Bash', { command: cmd }, { extra });
      assert.equal(r.status, 2, `${label}: ${cmd}\n${r.stdout}`);
    }
    for (const tool of ['PowerShell', 'Monitor']) assert.equal(guard(tool, { command: NAMED[0] }, { extra }).status, 2, `${label} ${tool}`);
  }
  // A connected tool that runs commands is held to the same names.
  free();
  assert.equal(guard('mcp__term__start_process', { command: 'FLOORBOSS_UNATTENDED=x claude -p hi' }).status, 2);
  assert.equal(guard('mcp__term__start_process', { command: `node ${ROOT}/scripts/scheduled.mjs followups` }).status, 2);
});

test('turning unattended runs off, or looking at them, is allowed in every session, a run going on or not', () => {
  for (const [label, setup] of [
    ['no run', free],
    ['a floorboss run in this session', held]
  ]) {
    setup();
    for (const cmd of [`node ${ROOT}/scripts/unattended.mjs off`, `node "\${CLAUDE_PLUGIN_ROOT}/scripts/unattended.mjs" status`])
      assert.equal(guard('Bash', { command: cmd }).status, 0, `${label}: ${cmd}`);
  }
  // And in a ticketed run.
  free();
  assert.equal(guard('Bash', { command: `node ${ROOT}/scripts/unattended.mjs off` }, { extra: { FLOORBOSS_UNATTENDED: 'a'.repeat(64) } }).status, 0, 'even with a token and no ticket');
  assert.equal(guard('Bash', { command: `node ${ROOT}/skills/flow/scripts/cli.mjs next --unattended` }, { extra: { FLOORBOSS_UNATTENDED: 'a'.repeat(64) } }).status, 2, 'anything else there is refused');
  // Outside a run, the plain looks at the new files are looks (cat, no write).
  for (const cmd of [`cat ${FB}/unattended/summary-2026-10-13.md`, `cat ${FB}/unattended/followups-installed.json`]) assert.equal(guard('Bash', { command: cmd }).status, 0, cmd);
});

test("the launcher's Claude Code run: a print run with no prompts, its session and token, and never a flag that turns the guard off", () => {
  const session = '0b0b0b0b-0000-4000-8000-000000000000';
  const token = 'c'.repeat(64);
  const r = claudeRun({ program: '/opt/claude/bin/claude', session, token, env: { PATH: '/usr/bin', CLAUDECODE: '1', HOME: '/h' } });
  assert.equal(r.program, '/opt/claude/bin/claude');
  assert.deepEqual(r.args, ['-p', FOLLOWUPS_PROMPT, '--session-id', session, '--permission-prompts', 'none', '--no-chrome', '--no-session-persistence', '--disallowed-tools', UNATTENDED_DISALLOWED.join(',')]);
  for (const t of ['Agent', 'WebFetch', 'WebSearch', 'mcp__claude-in-chrome', 'mcp__playwright']) assert.ok(UNATTENDED_DISALLOWED.includes(t), t);
  assert.equal(r.env.FLOORBOSS_UNATTENDED, token);
  assert.ok(!('CLAUDECODE' in r.env), "never inherits a Claude Code session's marker");
  for (const f of ['--bare', '--safe-mode', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']) assert.ok(NEVER_FLAGS.includes(f), f);
  // Each of these, added to a good list, is refused.
  for (const add of [['--bare'], ['--safe-mode'], ['--dangerously-skip-permissions'], ['--allow-dangerously-skip-permissions'], ['--permission-mode', 'bypassPermissions'], ['--permission-mode=auto'], ['--permission-mode', 'dontAsk'], ['--permission-mode', 'acceptEdits'], ['--settings', '{"disableAllHooks":true}'], ['--resume', session], ['--continue'], ['--permission-prompt-tool', 'mcp__x__y']])
    assert.ok(argsRefusal([...r.args, ...add]), add.join(' '));
  assert.ok(argsRefusal(r.args.map((a) => (a === 'none' ? 'host' : a))), 'prompts answered by a host');
  assert.ok(argsRefusal(r.args.filter((a) => a !== '-p')), 'not a print run');
  assert.equal(argsRefusal(r.args), null);
  // No program, a session that isn't a UUID, a token that isn't 32 bytes: nothing is built.
  assert.throws(() => claudeRun({ program: null, session, token }), /path isn't known/);
  assert.throws(() => claudeRun({ program: 'claude', session, token }), /path isn't known/);
  assert.throws(() => claudeRun({ program: '/x/claude', session: 'nope', token }), /UUID/);
  assert.throws(() => claudeRun({ program: '/x/claude', session, token: 'short' }), /32 random bytes/);
  // The end-to-end test's plugin folder and stand-in connectors: only under floorboss's own tests.
  assert.ok(!claudeRun({ program: '/x/claude', session, token, env: {}, extra: { pluginDir: '/p', mcpConfig: '/m' } }).args.includes('--plugin-dir'));
  const t = claudeRun({ program: '/x/claude', session, token, env: { FLOORBOSS_TEST: '1' }, extra: { pluginDir: '/p', mcpConfig: '/m' } });
  assert.deepEqual(t.args.slice(-5), ['--plugin-dir', '/p', '--strict-mcp-config', '--mcp-config', '/m']);
});
