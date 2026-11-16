// The follow-up drafts' launcher (scripts/scheduled.mjs followups) and its install (scripts/unattended.mjs
// install-followups), in throwaway homes. Claude Code is never started: FLOORBOSS_CLAUDE names a stand-in shell script
// that writes down what it was given and ends. launchctl is a stand-in too, and the launchd file is checked with
// plutil -lint in a temp folder only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, mkdirSync, chmodSync, symlinkSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { world, clone, logOf, ROOT, NOW, D13 } from './fixtures/unattended-world.mjs';
import { followupsDue } from '../scripts/scheduled.mjs';
import { followupsPlist, FOLLOWUP_HOURS, claudeRun, UNATTENDED_DISALLOWED } from '../lib/unattended.mjs';

const BASE = world();
const LAUNCHER = join(ROOT, 'scripts', 'scheduled.mjs');
const due = (H, now) => {
  const was = process.env.FLOORBOSS_HOME;
  process.env.FLOORBOSS_HOME = H.HOME;
  try {
    return followupsDue(Date.parse(now));
  } finally {
    process.env.FLOORBOSS_HOME = was;
  }
};
// A stand-in for Claude Code: it records its arguments and the token it was handed, then ends (or waits).
function fakeClaude({ sleep = 0, exit = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fb-fake-claude-'));
  const log = join(dir, 'calls.log');
  const p = join(dir, 'claude');
  writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "ARGS $*" >> '${log}'\nprintf '%s\\n' "TOKEN $FLOORBOSS_UNATTENDED" >> '${log}'\nprintf '%s\\n' "CC \${CLAUDECODE-unset}" >> '${log}'\n${sleep ? `sleep ${sleep}\n` : ''}exit ${exit}\n`);
  chmodSync(p, 0o755);
  return { path: p, dir, calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}
const launch = (H, now, extra = {}) => {
  const env = { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now, FLOORBOSS_TEST: '1', ...extra };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  if (extra.CLAUDECODE) env.CLAUDECODE = extra.CLAUDECODE;
  return spawnSync(process.execPath, [LAUNCHER, 'followups'], { env, encoding: 'utf8', timeout: 60000 });
};

test('what is due, with no model: nothing the day before, follow-up 1 on its day and the next, held when two days late or after the event', () => {
  assert.deepEqual(due(BASE, NOW).items, []);
  assert.deepEqual(due(BASE, D13).items.map((x) => [x.id, x.touch, x.thread_id]), [['c001', 2, 'T1']]);
  assert.equal(due(BASE, '2026-10-14T08:00:00Z').items.length, 1);
  const late = due(BASE, '2026-10-15T08:00:00Z');
  assert.deepEqual([late.items.length, late.held[0]?.why], [0, 'it was due Tue 13 Oct, more than a day ago: it waits for you']);
  assert.equal(due(BASE, '2026-10-13T16:00:00Z').items.length, 0, '18:00 in Amsterdam: not now');
  assert.equal(due(BASE, '2026-11-13T08:00:00Z').items.length, 0, 'after the event: the opt-in has ended');
});

test('nothing due: no Claude Code; something due: one run, with its ticket, token and flags, and the run ends cleanly', () => {
  const H = clone(BASE);
  const fake = fakeClaude();
  const none = launch(H, NOW, { FLOORBOSS_CLAUDE: fake.path });
  assert.equal(none.status, 0, none.stderr);
  assert.equal(fake.calls(), '', 'nothing due: nothing started');
  const r = launch(H, D13, { FLOORBOSS_CLAUDE: fake.path });
  assert.equal(r.status, 0, r.stderr);
  const lines = fake.calls().trim().split('\n');
  const args = lines.find((l) => l.startsWith('ARGS ')).slice(5).split(' ');
  const token = lines.find((l) => l.startsWith('TOKEN ')).slice(6);
  assert.equal(lines.find((l) => l.startsWith('CC ')), 'CC unset');
  const session = args[args.indexOf('--session-id') + 1];
  assert.deepEqual(args, claudeRun({ program: fake.path, session, token, env: {} }).args);
  for (const f of ['--bare', '--safe-mode', '--dangerously-skip-permissions', '--permission-mode']) assert.ok(!args.includes(f), f);
  assert.deepEqual([args[0], args[1], args[args.indexOf('--permission-prompts') + 1]], ['-p', '/floorboss:followups-due', 'none']);
  assert.ok(args.includes('--no-chrome') && args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--disallowed-tools') + 1], UNATTENDED_DISALLOWED.join(','));
  // The ticket: this session, the token's sha256 only, the items, written before the start; ended after.
  const tk = JSON.parse(readFileSync(join(H.HOME, 'unattended', 'tickets', `${session}.json`), 'utf8'));
  assert.equal(tk.token_sha256, createHash('sha256').update(token).digest('hex'));
  assert.ok(!JSON.stringify(tk).includes(token), 'the token itself is never written');
  assert.deepEqual(tk.items.map((x) => [x.id, x.touch]), [['c001', 2]]);
  assert.ok(existsSync(join(H.HOME, 'unattended', 'tickets', `${session}.ended`)));
  assert.ok(!existsSync(join(H.HOME, 'unattended', 'running.lock')));
  const log = logOf(H);
  assert.ok(log.some((e) => e.type === 'run_launched' && e.session === session));
  assert.ok(log.some((e) => e.type === 'run_ended' && e.session === session && e.exit === 0));
  assert.ok(existsSync(join(H.HOME, 'unattended', `summary-${new Date(Date.parse(D13)).toLocaleDateString('sv')}.md`)) || readdirSync(join(H.HOME, 'unattended')).some((f) => /^summary-/.test(f)));
});

test('the launcher never starts when floorboss ran something in the last 30 minutes, from a Claude Code shell, while switched off, or beside another run', () => {
  const fake = fakeClaude();
  {
    const H = clone(BASE);
    writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at: new Date().toISOString(), sessions: { open: new Date().toISOString() } }));
    assert.equal(launch(H, D13, { FLOORBOSS_CLAUDE: fake.path }).status, 0);
    assert.ok(logOf(H).some((e) => e.type === 'followups_skipped' && /floorboss ran something in the last 30 minutes/.test(e.reason)));
  }
  {
    const H = clone(BASE);
    assert.equal(launch(H, D13, { FLOORBOSS_CLAUDE: fake.path, CLAUDECODE: '1' }).status, 1);
    assert.ok(logOf(H).some((e) => e.type === 'followups_refused'));
  }
  {
    const H = clone(BASE);
    writeFileSync(join(H.HOME, 'unattended', 'off'), 'off\n');
    assert.equal(launch(H, D13, { FLOORBOSS_CLAUDE: fake.path }).status, 0);
  }
  {
    // Another launcher's run file, its process alive (this test's own): skipped. A dead one's: taken.
    const H = clone(BASE);
    writeFileSync(join(H.HOME, 'unattended', 'running.lock'), `${process.pid} ${new Date().toISOString()}\n`);
    assert.equal(launch(H, D13, { FLOORBOSS_CLAUDE: fake.path }).status, 0);
    assert.ok(logOf(H).some((e) => e.type === 'followups_skipped' && /another unattended run/.test(e.reason)));
    writeFileSync(join(H.HOME, 'unattended', 'running.lock'), `999999 ${new Date().toISOString()}\n`);
    assert.equal(launch(H, D13, { FLOORBOSS_CLAUDE: fake.path }).status, 0);
    assert.ok(logOf(H).some((e) => e.type === 'run_launched'));
  }
  assert.equal(fake.calls().split('\n').filter((l) => l.startsWith('ARGS')).length, 1, 'one run in all of that');
  // No stand-in named under the tests: never the real program, nothing starts.
  const H = clone(BASE);
  launch(H, D13, { FLOORBOSS_CLAUDE: '' });
  assert.ok(logOf(H).some((e) => e.type === 'followups_failed' && /path isn't known/.test(e.reason)));
});

test('a run that hangs is stopped at its limit, and says so', () => {
  const H = clone(BASE);
  const fake = fakeClaude({ sleep: 30 });
  const t0 = Date.now();
  const r = launch(H, D13, { FLOORBOSS_CLAUDE: fake.path, FLOORBOSS_FOLLOWUPS_LIMIT_MS: '800' });
  assert.ok(Date.now() - t0 < 20000, 'stopped well before the stand-in would end');
  assert.equal(r.status, 1);
  const end = logOf(H).find((e) => e.type === 'run_ended');
  assert.equal(end.signal, 'SIGTERM');
});

test('the launchd file: every hour of the day, Node and the launcher with "followups", never at load, no token, and plutil reads it', () => {
  const xml = followupsPlist({ node: '/usr/local/bin/node', launcher: LAUNCHER, floorbossHome: '/srv/x/.floorboss' });
  assert.match(xml, /<key>Label<\/key><string>com\.floorboss\.followups<\/string>/);
  assert.ok(xml.includes(`<array><string>/usr/local/bin/node</string><string>${LAUNCHER}</string><string>followups</string></array>`));
  assert.deepEqual([...xml.matchAll(/<key>Hour<\/key><integer>(\d+)<\/integer>/g)].map((m) => Number(m[1])), [...FOLLOWUP_HOURS]);
  assert.deepEqual([...FOLLOWUP_HOURS], Array.from({ length: 24 }, (_, h) => h), 'every hour, so an event in any zone gets its 09:00 to 17:00');
  assert.match(xml, /<key>RunAtLoad<\/key><false\/>/);
  assert.doesNotMatch(xml, /token|FLOORBOSS_UNATTENDED|KeepAlive|WatchPaths|\/bin\/(ba|z)?sh/i);
  if (process.platform === 'darwin' && existsSync('/usr/bin/plutil')) {
    const f = join(mkdtempSync(join(tmpdir(), 'fb-plist-')), 'com.floorboss.followups.plist');
    writeFileSync(f, xml);
    const r = spawnSync('/usr/bin/plutil', ['-lint', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /: OK/);
  }
});

// The install, in a throwaway home with a stand-in launchctl and a stand-in claude on PATH.
function installWorld(H) {
  const base = mkdtempSync(join(tmpdir(), 'fb-inst-f-'));
  const bin = join(base, 'bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  const fake = fakeClaude();
  symlinkSync(fake.path, join(bin, 'claude'));
  const calls = join(base, 'launchctl.log');
  const lc = join(base, 'launchctl');
  writeFileSync(lc, `#!/bin/sh\necho "$@" >> '${calls}'\nexit 0\n`);
  chmodSync(lc, 0o755);
  const HOME = join(base, 'home');
  mkdirSync(HOME);
  const env = { ...process.env, PATH: bin, HOME, FLOORBOSS_HOME: H.HOME, FLOORBOSS_TEST: '1', FLOORBOSS_PLATFORM: 'darwin', FLOORBOSS_LAUNCHCTL: lc, FLOORBOSS_TTY: '1', FLOORBOSS_CODE: 'KQRTVX', FLOORBOSS_NOW: NOW };
  delete env.CLAUDECODE;
  const run = (args, input = '', extra = {}) => spawnSync(process.execPath, [join(ROOT, 'scripts/unattended.mjs'), ...args], { env: { ...env, ...extra }, encoding: 'utf8', input });
  return { run, HOME, bin, plist: join(HOME, 'Library', 'LaunchAgents', 'com.floorboss.followups.plist'), calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []) };
}

test('install-followups: the warning first, then only the typed code installs; it records the Claude Code it will start', () => {
  const H = clone(BASE);
  rmSync(join(H.HOME, 'unattended', 'followups-installed.json'));
  const W = installWorld(H);
  for (const input of ['', 'yes\n', 'KQRTV\n', 'kqrtvy\n']) {
    const r = W.run(['install-followups'], input);
    assert.equal(r.status, 1, input);
    assert.match(r.stdout, /Read this first/);
    assert.match(r.stdout, /Nothing is sent\. Each draft waits for you to read it and press Send\./);
    assert.match(r.stdout, /floorboss can't see replies on LinkedIn or in the event app in an unattended run\. Check those inboxes regularly/);
    assert.match(r.stdout, /Turned on for: Test Expo \(until Thu 12 Nov 2026\)/);
    assert.match(r.stdout, /type this code: KQRTVX/);
    assert.ok(!existsSync(W.plist));
    assert.deepEqual(W.calls(), []);
  }
  const ok = W.run(['install-followups'], 'kqrtvx\n');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.ok(existsSync(W.plist));
  assert.deepEqual(W.calls(), [`bootstrap gui/${process.getuid()} ${W.plist}`]);
  const info = JSON.parse(readFileSync(join(H.HOME, 'unattended', 'followups-installed.json'), 'utf8'));
  assert.deepEqual([info.label, info.claude, info.path], ['com.floorboss.followups', join(W.bin, 'claude'), W.bin]);
  // --yes skips nothing here.
  assert.equal(W.run(['install-followups', '--yes']).status, 2);
  assert.match(W.run(['status']).stdout, /Follow-up drafts: installed .*every hour, day and night/);
  assert.match(W.run(['status']).stdout, /Unattended drafts turned on for: Test Expo until 2026-11-12 \(2 follow-ups authorised\)/);
  const u = W.run(['uninstall-followups']);
  assert.equal(u.status, 0, u.stderr);
  assert.ok(!existsSync(W.plist));
  assert.equal(W.calls().pop(), `bootout gui/${process.getuid()}/com.floorboss.followups`);
});

test('install-followups is refused with no opt-in, with no claude on PATH, from Claude Code, and with no terminal', () => {
  {
    const H = clone(BASE);
    rmSync(join(H.HOME, 'unattended', 'optin'), { recursive: true });
    const W = installWorld(H);
    const r = W.run(['install-followups'], 'KQRTVX\n');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /aren't turned on for any event yet/);
  }
  {
    const H = clone(BASE);
    const W = installWorld(H);
    rmSync(join(W.bin, 'claude'));
    assert.match(W.run(['install-followups'], 'KQRTVX\n').stdout, /isn't on your PATH/);
  }
  {
    const H = clone(BASE);
    const W = installWorld(H);
    assert.match(W.run(['install-followups'], 'KQRTVX\n', { CLAUDECODE: '1' }).stdout, /not from a Claude Code session/);
    assert.match(W.run(['install-followups'], 'KQRTVX\n', { FLOORBOSS_TTY: '' }).stdout, /no terminal/);
    assert.match(W.run(['install-followups'], 'KQRTVX\n', { FLOORBOSS_PLATFORM: 'linux' }).stdout, /macOS only for now/);
    assert.deepEqual(W.calls(), []);
  }
});
