// floorboss 0.1.7, the one-use record (lib/autosend/guard-record.mjs): in Claude Code an auto-send command that
// changes state runs only if floorboss's guard examined exactly that command a moment before. Each shell form below
// reaches the script in a way the guard's text rules don't follow (independent review of audit run 11): through the
// real guard, then the real shell and the real CLI in an isolated data folder, every one ends with nothing changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, symlinkSync, chmodSync } from 'node:fs';
import { world, addLines, ledgerLines, PEOPLE, NOW, EVENT, SLUG, ROOT, OWN, remoteFor, git } from './fixtures/autosend-world.mjs';
import { readback, approve, revoke } from '../lib/autosend/approval.mjs';
import { AUTO_PICK } from '../lib/autosend/pick.mjs';
import { ROUTINE_MODE } from '../lib/autosend/routine.mjs';
import { recordsDir, writeRecord, takeRecord, inRecords, NOT_SEEN, WORDS_CHANGED, RECORD_FRESH_MS, guardRunsHere, clearRecords, wordsSha } from '../lib/autosend/guard-record.mjs';

const CLI = join(ROOT, 'skills/autosend/scripts/cli.mjs');
const D = dirname(CLI);
const CODEX_KEYS = ['CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_TOOL_CALL_ID', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED'];
const baseEnv = (H, now) => {
  const env = { ...process.env, FLOORBOSS_TEST: '1', FLOORBOSS_HOME: H, CLAUDECODE: '1', CLAUDE_PLUGIN_ROOT: ROOT, ...(now ? { FLOORBOSS_NOW: now } : {}) };
  for (const k of CODEX_KEYS) delete env[k];
  return env;
};
const guard = (H, command, { subagent = false, now = NOW } = {}) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], {
    cwd: ROOT,
    input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-main', tool_use_id: `toolu_${Math.random().toString(36).slice(2)}`, tool_name: 'Bash', tool_input: { command }, ...(subagent ? { agent_id: 'agent-1', agent_type: 'general-purpose' } : {}) }),
    env: baseEnv(H, now),
    encoding: 'utf8'
  });
// The command as Claude Code's Bash tool runs it: a shell, with CLAUDECODE=1.
const shell = (H, command, now = NOW, env = {}) => spawnSync('bash', ['-c', command], { cwd: ROOT, env: { ...baseEnv(H, now), ...env }, encoding: 'utf8', timeout: 30000 });

// The forms: each takes the words after the script (plain tokens only) and gives one shell command.
const q = (a) => a.join(' ');
const py = (a) => `python3 -c "import os; os.execvp('node', ['node', '${CLI}', ${a.map((x) => `'${x}'`).join(', ')}])"`;
export const FORMS = [
  ['{ cd; }', (a) => `{ cd ${D}; node cli.mjs ${q(a)}; }`],
  ['if cd; then', (a) => `if cd ${D}; then node cli.mjs ${q(a)}; fi`],
  ['glob in cd', (a) => `cd ${ROOT}/skills/auto*/scripts && node cli.mjs ${q(a)}`],
  ['variable in cd', (a) => `X=${D}; cd "$X" && node cli.mjs ${q(a)}`],
  ['pushd', (a) => `pushd ${D} >/dev/null && node cli.mjs ${q(a)}`],
  ['env -C', (a) => `env -C ${D} node cli.mjs ${q(a)}`],
  ['find -exec', (a) => `find ${D} -maxdepth 1 -name cli.mjs -exec node {} ${q(a)} \\;`],
  ['xargs -I', (a) => `echo ${CLI} | xargs -I{} node {} ${q(a)}`],
  ['python', py],
  ['osascript', (a) => `osascript -e 'do shell script "cd ${D}; ${process.execPath} cli.mjs ${q(a)}"'`],
  ['(cd && node)', (a) => `(cd ${D} && node cli.mjs ${q(a)})`],
  ['bash -c', (a) => `bash -c 'cd ${D} && node ./cli.mjs ${q(a)}'`],
  ['sh -c exec', (a) => `sh -c "cd ${D}; exec node cli.mjs ${q(a)}"`],
  // The host test changed from the command line: a Codex mark added, CLAUDECODE emptied.
  ['a Codex mark in the command', (a) => `cd ${D} && CODEX_THREAD_ID=x node cli.mjs ${q(a)}`],
  ['CLAUDECODE emptied', (a) => `cd ${D} && CLAUDECODE= CODEX_SESSION_ID=y node cli.mjs ${q(a)}`]
];
const plain = (a) => `node ${CLI} ${q(a)}`;
const hasPython = spawnSync('python3', ['-c', '1']).status === 0;
const hasOsascript = process.platform === 'darwin' && existsSync('/usr/bin/osascript');
const runnable = (name) => (name === 'python' ? hasPython : name === 'osascript' ? hasOsascript : true);

// A routine event not yet set to auto-send: `on` turns it on.
function onWorld() {
  const w = world({ touches: 2, event: { ...EVENT, autosend: false, autosend_mode: ROUTINE_MODE } });
  const f = join(w.HOME, 'work', 'said-on.txt');
  writeFileSync(f, 'yes, send them on their own');
  return { ...w, args: ['on', '--event', SLUG, '--said-file', f, '--own', OWN] };
}
const autosendOn = (w) => JSON.parse(readFileSync(join(w.evDir, 'event.json'), 'utf8')).autosend === true;
const snapshot = (w) => readFileSync(join(w.evDir, 'event.json'), 'utf8') + readFileSync(join(w.evDir, 'ledger.jsonl'), 'utf8');

test('the plain form works for the main session, once per look of the guard', () => {
  const w = onWorld();
  const g = guard(w.HOME, plain(w.args));
  assert.equal(g.status, 0, g.stderr);
  assert.equal(readdirSync(recordsDir(w.HOME)).length, 1, 'the guard wrote one record');
  const r = shell(w.HOME, plain(w.args));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(autosendOn(w));
  assert.equal(readdirSync(recordsDir(w.HOME)).length, 0, 'taken');
  // The same command again with no new look: refused.
  const again = shell(w.HOME, plain(w.args));
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /safety check did not see this command/);
});

for (const [name, form] of FORMS) {
  test(`bypass form "${name}": the guard writes no record, and the CLI refuses with nothing changed`, { skip: !runnable(name) && `${name} is not on this computer` }, () => {
    const w = onWorld();
    const before = snapshot(w);
    const cmd = form(w.args);
    const g = guard(w.HOME, cmd);
    // A form the guard refuses never runs; one it lets go on must find no record.
    if (g.status !== 2) {
      const r = shell(w.HOME, cmd);
      // (find exits 0 whatever its -exec command did: the CLI's own words and the disk say it.)
      if (name !== 'find -exec') assert.notEqual(r.status, 0, `${name} ran: ${r.stdout}`);
      assert.match(r.stderr, /safety check did not see this command/, `${name}: ${r.stderr}`);
    }
    assert.equal(snapshot(w), before, `${name} changed something`);
    assert.ok(!autosendOn(w));
  });
  test(`bypass form "${name}" after a plain look: the plain command's record doesn't carry over to it`, { skip: !runnable(name) && `${name} is not on this computer` }, () => {
    const w = onWorld();
    const before = snapshot(w);
    // The guard looked at the plain form (a record), then the model ran a bypass form instead: that call's own guard
    // look clears the record first.
    assert.equal(guard(w.HOME, plain(w.args)).status, 0);
    const cmd = form(w.args);
    const g = guard(w.HOME, cmd);
    if (g.status !== 2) {
      const r = shell(w.HOME, cmd);
      assert.match(r.stderr, /safety check did not see this command/, `${name}: ${r.stderr}`);
    }
    assert.equal(snapshot(w), before);
  });
}

test('a subagent is refused in every form: the plain one by the guard, the others by the CLI', () => {
  const w = onWorld();
  const before = snapshot(w);
  const g = guard(w.HOME, plain(w.args), { subagent: true });
  assert.equal(g.status, 2);
  assert.match(g.stderr, /subagent/);
  assert.ok(!existsSync(recordsDir(w.HOME)) || readdirSync(recordsDir(w.HOME)).length === 0, 'no record for a refused call');
  for (const [name, form] of FORMS) {
    if (!runnable(name)) continue;
    const cmd = form(w.args);
    if (guard(w.HOME, cmd, { subagent: true }).status === 2) continue;
    const r = shell(w.HOME, cmd);
    assert.match(r.stderr, /safety check did not see this command/, `${name}: ${r.stderr}`);
  }
  assert.equal(snapshot(w), before);
});

// ---- draft-gone: the ask, a Deny, and the words ----
const [ANA, BO] = PEOPLE;
const GM = 'mcp__claude_ai_Gmail__';
function goneWorld() {
  const w = world({ touches: 3, people: [ANA, BO], event: { ...EVENT, autosend_mode: ROUTINE_MODE } });
  const nowMs = Date.parse(NOW);
  approve(w.evDir, { digest: readback(w.evDir, nowMs).digest, said: AUTO_PICK }, nowMs);
  const yes = ledgerLines(w.evDir).filter((e) => e.type === 'autosend_approved');
  const lines = [];
  [ANA, BO].forEach((p, i) => {
    const h = (t) => yes.find((e) => e.id === p.id && e.touch === t).hash;
    lines.push({ at: NOW, type: 'sent', who: 'floorboss', id: p.id, touch: 1, via: 'email.send', channel: 'email', date: '2026-10-09', message_id: `m${i}1`, thread_id: `t${i}`, hash: h(1), source: 'autosend' });
    for (let t = 2; t <= 3; t++) {
      const due = i === 0 && t === 2 ? '2026-10-12' : `2026-10-${20 + t}`;
      lines.push({ at: NOW, type: 'call_result', who: 'guard', id: p.id, touch: t, kind: 'draft', message_id: `m${i}${t}`, thread_id: `t${i}`, draft_id: `r${i}${t}`, tool: `${GM}create_draft` });
      lines.push({ at: NOW, type: 'autosend_drafted', who: 'floorboss', id: p.id, touch: t, hash: h(t), to: p.email, due, draft_id: `r${i}${t}`, message_id: `m${i}${t}`, thread_id: `t${i}`, threaded: true, run: 'run-1' });
    }
  });
  addLines(w.evDir, lines);
  revoke(w.evDir, { ids: ANA.id, said: 'stop auto-send for Ana' }, nowMs);
  const f = join(w.HOME, 'work', 'said-gone.txt');
  writeFileSync(f, "I looked: it's not in Sent and not in Drafts");
  return { ...w, file: f, args: ['draft-gone', '--event', SLUG, '--id', ANA.id, '--touch', '2', '--said-file', f] };
}
const LATER = new Date(Date.parse(NOW) + 6 * 3600e3).toISOString();
const gone = (w) => ledgerLines(w.evDir).some((e) => e.type === 'autosend_draft_deleted');

test('draft-gone: the guard asks, and with the record the plain command records the user\'s word', () => {
  const w = goneWorld();
  const g = guard(w.HOME, plain(w.args), { now: LATER });
  assert.equal(g.status, 0, g.stderr);
  assert.equal(JSON.parse(g.stdout).hookSpecificOutput.permissionDecision, 'ask');
  const r = shell(w.HOME, plain(w.args), LATER);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(gone(w));
});

test('draft-gone: after a denied ask, a later bypass spelling of the same command is refused by the CLI', () => {
  const w = goneWorld();
  const before = snapshot(w);
  // The ask: Claude Code shows it, the user clicks Deny, and the guard is never told.
  const g = guard(w.HOME, plain(w.args), { now: LATER });
  assert.equal(JSON.parse(g.stdout).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(readdirSync(recordsDir(w.HOME)).length, 1);
  for (const [name, form] of FORMS) {
    if (!runnable(name)) continue;
    const cmd = form(w.args);
    // In the session that ran floorboss, the guard refuses any shell command that isn't one of floorboss's scripts.
    const g2 = guard(w.HOME, cmd, { now: LATER });
    assert.equal(g2.status, 2, `${name}: the guard let a bypass form through in the held session`);
    if (g2.status === 2) continue;
    const r = shell(w.HOME, cmd, LATER);
    assert.match(r.stderr, /safety check did not see this command/, `${name}: ${r.stderr}`);
  }
  assert.equal(snapshot(w), before);
  assert.ok(!gone(w));
});

test('draft-gone: a words file changed after the guard showed it is refused', () => {
  const w = goneWorld();
  assert.equal(guard(w.HOME, plain(w.args), { now: LATER }).status, 0);
  writeFileSync(w.file, 'something else entirely, not what you were shown');
  const r = shell(w.HOME, plain(w.args), LATER);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not the ones floorboss showed you/);
  assert.ok(!gone(w));
});

test('a record is for its exact words, counts once, and goes stale', () => {
  const w = onWorld();
  const H = w.HOME;
  writeRecord(H, w.args);
  assert.equal(takeRecord(H, [...w.args.slice(0, -1), 'other@lanecraft.example']), NOT_SEEN, 'another address');
  assert.equal(takeRecord(H, w.args), null);
  assert.equal(takeRecord(H, w.args), NOT_SEEN, 'once');
  writeRecord(H, w.args, {}, Date.now() - RECORD_FRESH_MS - 1000);
  assert.equal(takeRecord(H, w.args), NOT_SEEN, 'stale');
  writeRecord(H, ['draft-gone', '--event', SLUG], { said: 'abc def' });
  assert.equal(takeRecord(H, ['draft-gone', '--event', SLUG], { said: 'abc deg' }), WORDS_CHANGED);
});

test('the host test is lib/harness.mjs: a Codex mark wins, so a Codex that inherited CLAUDECODE is Codex', () => {
  assert.equal(guardRunsHere({ CLAUDECODE: '1' }), true);
  assert.equal(guardRunsHere({ CLAUDECODE: '1', CODEX_THREAD_ID: 'x' }), false);
  assert.equal(guardRunsHere({ CODEX_THREAD_ID: 'x' }), false);
  assert.equal(guardRunsHere({}), false);
});

test('the records folder: the guard refuses a Write or Edit into it by any spelling, and a shell command that names it', () => {
  const w = onWorld();
  mkdirSync(recordsDir(w.HOME), { recursive: true });
  const fileCall = (tool, file_path) =>
    spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], {
      cwd: ROOT,
      input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-main', tool_name: tool, tool_input: tool === 'Write' ? { file_path, content: '{}' } : { file_path, old_string: 'a', new_string: 'b' } }),
      env: baseEnv(w.HOME),
      encoding: 'utf8'
    });
  const f = join(recordsDir(w.HOME), 'x.json');
  for (const p of [f, f.replace('/autosend/', '/autosend//'), join(w.HOME, 'work', '..', 'autosend', 'seen-by-guard', 'y.json')]) {
    for (const tool of ['Write', 'Edit']) assert.equal(fileCall(tool, p).status, 2, `${tool} ${p}`);
  }
  assert.ok(inRecords(f, w.HOME));
  assert.ok(!inRecords(join(w.HOME, 'work', 'x.json'), w.HOME));
  for (const cmd of [`ls ${recordsDir(w.HOME)}`, `echo '{}' > ~/.floorboss/autosend/seen-by-guard/a.json`, 'cat seen-by-guard/*']) {
    const g = guard(w.HOME, cmd);
    assert.equal(g.status, 2, cmd);
    assert.match(g.stderr, /safety check/);
  }
});

// ---- remote --confirm (0.1.6): the guard's ask, a Deny, a bypass form ----
const REPO = 'https://github.com/me/floorboss-data.git';
function remoteWorld() {
  const w = world({ touches: 1 });
  remoteFor(w.HOME);
  git(w.HOME, ['remote', 'set-url', 'origin', 'https://someone:tok123@' + 'github.com/me/floorboss-data.git']);
  return { ...w, args: ['remote', '--confirm', REPO] };
}
const remotesNow = () => {
  try {
    return readFileSync(join(process.env.HOME, '.config', 'floorboss', 'remotes.json'), 'utf8');
  } catch {
    return '';
  }
};
const confirmedFor = (w) => remotesNow().includes(w.HOME.split('/').pop());

test('remote --confirm: the guard asks, its record holds the address without the token, and the plain command records it', () => {
  const w = remoteWorld();
  const g = guard(w.HOME, plain(w.args));
  assert.equal(JSON.parse(g.stdout).hookSpecificOutput.permissionDecision, 'ask');
  const [f] = readdirSync(recordsDir(w.HOME));
  const rec = readFileSync(join(recordsDir(w.HOME), f), 'utf8');
  assert.equal(JSON.parse(rec).url, REPO);
  assert.ok(!rec.includes('tok123'));
  const r = shell(w.HOME, plain(w.args));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(confirmedFor(w));
});
test('remote --confirm: after a denied ask, every bypass form is refused by the CLI and nothing is recorded', () => {
  const w = remoteWorld();
  assert.equal(JSON.parse(guard(w.HOME, plain(w.args)).stdout).hookSpecificOutput.permissionDecision, 'ask');
  for (const [name, form] of FORMS) {
    if (!runnable(name)) continue;
    const cmd = form(w.args);
    const g2 = guard(w.HOME, cmd);
    assert.equal(g2.status, 2, `${name}: the guard let a bypass form through in the held session`);
    if (g2.status === 2) continue;
    const r = shell(w.HOME, cmd);
    assert.match(r.stderr, /safety check did not see this command/, `${name}: ${r.stderr}`);
  }
  assert.ok(!confirmedFor(w));
});

// ---- Two calls checked at once (parallel tool calls) ----
// B is a bypass form with the same words as A. Known limit (SECURITY.md): if Claude Code runs B's guard look before
// A's and then B's command while A's prompt is still open, B's command takes A's record: the record is bound to the
// words, not to the call (the command can't see the call's tool_use_id).
test.todo("parallel calls: B looked at before A, then B run while A waits for the user: B can use A's record (known limit, not closed)");
test('parallel calls: A looked at, then B (a shell call in the same session): B is refused and A\'s record is cleared, so A is run again', () => {
  const w = goneWorld();
  const B = FORMS.find(([n]) => n === '{ cd; }')[1](w.args);
  guard(w.HOME, plain(w.args), { now: LATER });
  assert.equal(guard(w.HOME, B, { now: LATER }).status, 2, 'B refused');
  assert.match(shell(w.HOME, plain(w.args), LATER).stderr, /did not see/);
  assert.ok(!gone(w));
});
test('after the call ran (PostToolUse), a record its command did not take is removed', () => {
  const w = onWorld();
  const id = 'toolu_post_1';
  const g = spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { cwd: ROOT, input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-main', tool_use_id: id, tool_name: 'Bash', tool_input: { command: plain(w.args) } }), env: baseEnv(w.HOME, NOW), encoding: 'utf8' });
  assert.equal(g.status, 0, g.stderr);
  assert.equal(readdirSync(recordsDir(w.HOME)).length, 1);
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs'), 'post'], { cwd: ROOT, input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'sess-main', tool_use_id: id, tool_name: 'Bash', tool_input: { command: plain(w.args) }, tool_response: {} }), env: baseEnv(w.HOME, NOW), encoding: 'utf8' });
  assert.equal(readdirSync(recordsDir(w.HOME)).length, 0);
});

// ---- CLAUDECODE removed in the command: a routine event's state through the Codex path ----
// The sequence the review found: in a form the guard doesn't follow, env -u CLAUDECODE makes the CLI read the host as
// unknown (Codex's rules), where `on --mode drafts` moves the routine event to Gmail drafts and `approve --said 1`
// approves it. A routine event is Claude Code's only, so its commands now need the record whatever the host says.
// The env -u sequence the review found: in a form the guard doesn't follow, env -u CLAUDECODE, then on --mode drafts
// (moving the routine event to Gmail drafts under Codex's rules). Closed: `on` on an event in routine mode needs the
// record in any host.
test('env -u CLAUDECODE: on --mode drafts on a routine event is refused without a record, nothing changed', () => {
  const w = goneWorld();
  const before = snapshot(w);
  const r = shell(w.HOME, `cd ${D} && env -u CLAUDECODE node cli.mjs on --event ${SLUG} --mode drafts --said-file ${w.file} --own ${OWN}`, LATER);
  assert.match(r.stderr, /safety check did not see this command/, r.stderr);
  assert.equal(snapshot(w), before);
});
test('env -u CLAUDECODE: a state change on an event in routine mode now (approve, draft-gone) is refused without a record', () => {
  const w = goneWorld();
  const before = snapshot(w);
  const r = shell(w.HOME, `cd ${D} && env -u CLAUDECODE node cli.mjs ${q(w.args)}`, LATER);
  assert.match(r.stderr, /safety check did not see this command/, r.stderr);
  const f = join(w.HOME, 'work', 'said-1.txt');
  writeFileSync(f, '1');
  const a = shell(w.HOME, `cd ${D} && env -u CLAUDECODE node cli.mjs approve --event ${SLUG} --digest x --said-file ${f}`, LATER);
  assert.match(a.stderr, /safety check did not see this command/, a.stderr);
  assert.equal(snapshot(w), before);
});

// ---- Review of v017-record (2026-11-22) ----
const CODEX_ENV = { CODEX_SESSION_ID: 'codex-sess', CODEX_THREAD_ID: 'codex-thread' };
const codexShell = (H, command) => {
  const env = { ...process.env, FLOORBOSS_TEST: '1', FLOORBOSS_HOME: H, FLOORBOSS_NOW: NOW, ...CODEX_ENV };
  delete env.CLAUDECODE;
  return spawnSync('bash', ['-c', command], { cwd: ROOT, env, encoding: 'utf8' });
};
test('1a. a stop never needs a record: revoke runs with none, in Claude Code and in Codex', () => {
  const w = goneWorld();
  const a = shell(w.HOME, plain(['revoke', '--event', SLUG, '--ids', BO.id, '--said-file', w.file]), LATER);
  assert.equal(a.status, 0, a.stderr);
  assert.ok(ledgerLines(w.evDir).some((e) => e.type === 'autosend_revoked' && e.id === BO.id));
  const v = world({ touches: 1, event: { ...EVENT, autosend_mode: 'drafts', autosend_routine_until: NOW } });
  const f = join(v.HOME, 'work', 's.txt');
  writeFileSync(f, 'stop them all');
  const c = codexShell(v.HOME, plain(['revoke', '--event', SLUG, '--ids', 'all', '--said-file', f]));
  assert.equal(c.status, 0, c.stderr);
});
test('1c. remote --confirm in Codex with a routine event elsewhere in the folder needs no record', () => {
  const w = remoteWorld();
  world({ touches: 1, event: { ...EVENT, slug: 'other-fair', autosend_mode: 'routine' }, home: w.HOME });
  const r = codexShell(w.HOME, plain(w.args));
  assert.equal(r.status, 0, r.stderr);
});
test('2. the prompt stays open while a subagent reads and a to-do list is written: Allow, and the plain command runs', () => {
  const w = goneWorld();
  assert.equal(JSON.parse(guard(w.HOME, plain(w.args), { now: LATER }).stdout).hookSpecificOutput.permissionDecision, 'ask');
  const other = (tool, tool_input, args = [], extra = {}) =>
    spawnSync('node', [join(ROOT, 'hooks/guard.mjs'), ...args], { cwd: ROOT, input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-main', tool_use_id: 'toolu_x' + Math.random(), tool_name: tool, tool_input, ...extra }), env: baseEnv(w.HOME, LATER), encoding: 'utf8' });
  other('Read', { file_path: join(w.HOME, 'config.json') }, [], { agent_id: 'agent-r', agent_type: 'researcher' });
  other('TodoWrite', { todos: [] }, ['other']);
  other('Read', { file_path: join(w.HOME, 'config.json') });
  assert.equal(readdirSync(recordsDir(w.HOME)).length, 1, 'the record is still there');
  const r = shell(w.HOME, plain(w.args), LATER);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(gone(w));
});
test('2. another recognised auto-send call in the same session clears the earlier record', () => {
  const w = goneWorld();
  guard(w.HOME, plain(w.args), { now: LATER });
  guard(w.HOME, plain(['readback', '--event', SLUG]), { now: LATER });
  assert.equal(readdirSync(recordsDir(w.HOME)).length, 0);
  assert.match(shell(w.HOME, plain(w.args), LATER).stderr, /did not see/);
});
test('3. a records folder that is a link: the guard refuses, names it, and empties nothing', () => {
  const w = onWorld();
  const victim = join(w.HOME, 'work', 'victim');
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, 'keep.json'), '{}');
  mkdirSync(join(victim, 'sub'));
  writeFileSync(join(victim, 'sub', 'x.txt'), 'x');
  mkdirSync(join(w.HOME, 'autosend'), { recursive: true });
  symlinkSync(victim, recordsDir(w.HOME));
  const g = guard(w.HOME, plain(w.args));
  assert.equal(g.status, 2);
  assert.ok(g.stderr.includes(recordsDir(w.HOME)), g.stderr);
  assert.match(g.stderr, /terminal/);
  assert.ok(existsSync(join(victim, 'keep.json')) && existsSync(join(victim, 'sub', 'x.txt')), 'nothing deleted');
  assert.throws(() => clearRecords(w.HOME), /link/);
});
test('3. only regular .json files directly in the folder are cleared', () => {
  const w = onWorld();
  const d = recordsDir(w.HOME);
  mkdirSync(join(d, 'sub'), { recursive: true });
  writeFileSync(join(d, 'sub', 'x.json'), '{}');
  writeFileSync(join(d, 'note.txt'), 'x');
  const out = join(w.HOME, 'work', 'outside.json');
  writeFileSync(out, '{}');
  symlinkSync(out, join(d, 'link.json'));
  writeRecord(w.HOME, w.args, {}, Date.now() - RECORD_FRESH_MS - 1000);
  clearRecords(w.HOME);
  assert.ok(existsSync(join(d, 'sub', 'x.json')) && existsSync(join(d, 'note.txt')) && existsSync(out));
  assert.equal(readdirSync(d).filter((f) => /^[0-9a-f]{64}\.json$/.test(f)).length, 0, 'the stale record went');
});
test('4. drafts next --run <a routine event\'s run> with no --event needs the record in any host', () => {
  const w = goneWorld();
  mkdirSync(join(w.HOME, 'autosend', 'drafts-runs'), { recursive: true });
  writeFileSync(join(w.HOME, 'autosend', 'drafts-runs', 'run-r1.json'), JSON.stringify({ run: 'run-r1', flow: 'approved-drafts', slug: SLUG, state: 'open' }));
  const r = codexShell(w.HOME, plain(['drafts', 'next', '--run', 'run-r1']));
  assert.match(r.stderr, /safety check did not see this command/);
});
test('5. CLAUDECODE with a Codex mark: read-only commands run; a routine event\'s state change needs the record', () => {
  const w = world({ touches: 1 });
  const env = { CLAUDECODE: '1', ...CODEX_ENV };
  const rb = shell(w.HOME, plain(['readback', '--event', SLUG]), NOW, env);
  assert.equal(rb.status, 0, rb.stderr);
  const v = onWorld();
  const on = shell(v.HOME, plain(v.args), NOW, env);
  assert.match(on.stderr, /safety check did not see this command/);
});

// Second review: routine-saved and routine-checked don't hold the session (as at 998b29f); a Deny is covered because
// every shell call the guard judges in a session clears that session's own records first.
for (const verb of ['routine-saved', 'draft-gone']) {
  test(`${verb}: a Deny, then a bypass form in the same session: the CLI refuses`, () => {
    const w = verb === 'draft-gone' ? goneWorld() : onWorld();
    const args = verb === 'draft-gone' ? w.args : ['routine-saved', '--event', SLUG, '--id', 'trig_01DENIED000000001'];
    const now = verb === 'draft-gone' ? LATER : NOW;
    assert.equal(guard(w.HOME, plain(args), { now }).status, 0);
    const before = snapshot(w);
    for (const [name, form] of FORMS) {
      if (!runnable(name)) continue;
      const cmd = form(args);
      if (guard(w.HOME, cmd, { now }).status === 2) continue;
      const r = shell(w.HOME, cmd, now);
      assert.match(r.stderr, /safety check did not see this command/, `${name}: ${r.stderr}`);
    }
    assert.equal(snapshot(w), before);
  });
}
test('session start: routine-status and routine-checked, then ls, git status, WebFetch, a Gmail read and a Read are all allowed', () => {
  const w = goneWorld();
  const call = (tool_name, tool_input, args = []) =>
    spawnSync('node', [join(ROOT, 'hooks/guard.mjs'), ...args], { cwd: ROOT, input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-start', tool_use_id: 'toolu_' + Math.random(), tool_name, tool_input }), env: baseEnv(w.HOME, LATER), encoding: 'utf8' });
  for (const [t, i] of [['Bash', { command: plain(['routine-status']) }], ['Bash', { command: plain(['routine-checked', '--run', 'rc-000000000000']) }], ['Bash', { command: 'ls' }], ['Bash', { command: 'git status' }], ['WebFetch', { url: 'https://example.com/', prompt: 'x' }], ['mcp__claude_ai_Gmail__search_threads', { query: 'from:me' }], ['Read', { file_path: join(ROOT, 'README.md') }]]) {
    const r = call(t, i);
    assert.equal(r.status, 0, `${t} ${JSON.stringify(i).slice(0, 80)}: ${r.stderr}`);
  }
});
test('a record is fresh for 3 minutes, by the clock the command reads', () => {
  const w = onWorld();
  const t0 = Date.parse('2026-11-22T10:00:00Z');
  writeRecord(w.HOME, w.args, {}, t0);
  assert.equal(takeRecord(w.HOME, w.args, {}, t0 + 3 * 60e3 + 1000), NOT_SEEN, 'past 3 minutes');
  writeRecord(w.HOME, w.args, {}, t0);
  assert.equal(takeRecord(w.HOME, w.args, {}, t0 + 2 * 60e3), null, 'within 3 minutes');
  assert.equal(RECORD_FRESH_MS, 3 * 60e3);
});
test('a records folder the guard can\'t read: a plain refusal with its path and the fix', () => {
  const w = onWorld();
  const d = recordsDir(w.HOME);
  mkdirSync(d, { recursive: true });
  chmodSync(d, 0o000);
  try {
    const g = guard(w.HOME, plain(w.args));
    assert.equal(g.status, 2);
    assert.ok(g.stderr.includes(d), g.stderr);
    assert.match(g.stderr, /terminal/);
    assert.doesNotMatch(g.stderr, /EACCES: permission denied, scandir/);
  } finally {
    chmodSync(d, 0o700);
  }
});
test('a link planted at a record\'s name is removed (the link, never its target), and the command can run', () => {
  const w = onWorld();
  const d = recordsDir(w.HOME);
  mkdirSync(d, { recursive: true });
  const target = join(w.HOME, 'work', 'target.json');
  writeFileSync(target, 'keep');
  symlinkSync(target, join(d, `${wordsSha(w.args)}.json`));
  assert.equal(guard(w.HOME, plain(w.args)).status, 0);
  assert.equal(readFileSync(target, 'utf8'), 'keep');
  const r = shell(w.HOME, plain(w.args));
  assert.equal(r.status, 0, r.stderr);
});

// ---- Third review: a subagent's shell call carries the parent's session_id ----
const subCall = (H, tool_name, command, now) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { cwd: ROOT, input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-main', agent_id: 'agent-r', agent_type: 'researcher', tool_use_id: 'toolu_' + Math.random(), tool_name, tool_input: { command } }), env: baseEnv(H, now), encoding: 'utf8' });
test('a subagent\'s shell calls wait while the user\'s prompt is open; then Allow, and the plain command runs', () => {
  const w = goneWorld();
  assert.equal(JSON.parse(guard(w.HOME, plain(w.args), { now: LATER }).stdout).hookSpecificOutput.permissionDecision, 'ask');
  for (const [tool, cmd] of [['Bash', 'ls'], ['Monitor', 'ls'], ['Bash', FORMS[0][1](w.args)]]) {
    const r = subCall(w.HOME, tool, cmd, LATER);
    assert.equal(r.status, 2, `${tool} ${cmd}`);
    assert.match(r.stderr, /waiting for the user's answer to a prompt/);
  }
  assert.equal(readdirSync(recordsDir(w.HOME)).length, 1, 'the record is untouched');
  const r = shell(w.HOME, plain(w.args), LATER);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(gone(w));
});
test('after a Deny, a subagent bypass form is refused', () => {
  const w = onWorld();
  const args = ['routine-saved', '--event', SLUG, '--id', 'trig_01DENIED000000002'];
  assert.equal(guard(w.HOME, plain(args)).status, 0);
  const r = subCall(w.HOME, 'Bash', FORMS[0][1](args), NOW);
  assert.equal(r.status, 2);
});
test('a subagent Bash call with no pending record is unaffected', () => {
  const w = onWorld();
  const r = subCall(w.HOME, 'Bash', 'ls', NOW);
  assert.equal(r.status, 0, r.stderr);
});
test('a broken records folder: a shell call that is not floorboss\'s goes on; an auto-send command still fails closed', () => {
  const w = onWorld();
  const d = recordsDir(w.HOME);
  mkdirSync(d, { recursive: true });
  chmodSync(d, 0o000);
  try {
    assert.equal(guard(w.HOME, 'ls').status, 0);
    const g = guard(w.HOME, plain(w.args));
    assert.equal(g.status, 2);
    assert.ok(g.stderr.includes(d));
  } finally {
    chmodSync(d, 0o700);
  }
});
