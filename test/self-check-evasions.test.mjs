// `npm run self-check` says which processes floorboss can start. Each change below to a copy of the code would let
// the scheduled launcher or the install script start something else while every name still looked right; the
// check must fail on each. (--static: the check without its test run.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
function copy() {
  const dir = join(mkdtempSync(join(tmpdir(), 'fb-selfcheck-')), 'floorboss');
  cpSync(ROOT, dir, { recursive: true, filter: (src) => !['.git', 'test', 'node_modules', 'docs'].includes(relative(ROOT, src).split(sep)[0]) });
  mkdirSync(join(dir, 'test'));
  return dir;
}
const check = (dir) => {
  const r = spawnSync(process.execPath, [join(dir, 'scripts/self-check.mjs'), '--static'], { encoding: 'utf8', cwd: dir });
  return { code: r.status, failed: r.stdout.split('\n').filter((l) => l.startsWith('FAIL')), out: r.stdout + r.stderr };
};
// One exact replacement in one file of the copy.
function change(dir, file, from, to) {
  const p = join(dir, file);
  const s = readFileSync(p, 'utf8');
  assert.equal(s.split(from).length, 2, `${file} holds this once: ${from.slice(0, 60)}`);
  writeFileSync(p, s.replace(from, () => to));
}
const SPAWN = "    const child = spawn(cmd, [page], { stdio: 'ignore', detached: true });";
const RUN = "  return spawnSync(LAUNCHCTL, args, { encoding: 'utf8' });";
const CP = "import { spawn } from 'node:child_process';";

const EVASIONS = {
  'the opener\'s name shadowed just before it is started': (d) => change(d, 'scripts/scheduled.mjs', SPAWN, `    const cmd = '/usr/bin/osascript';\n${SPAWN}`),
  'the opener\'s name taken from somewhere else': (d) => change(d, 'scripts/scheduled.mjs', '  const cmd = openerFor();', "  const cmd = process.env.OPENER || openerFor();"),
  'launchctl\'s name shadowed inside the one function that starts it': (d) => change(d, 'scripts/unattended.mjs', RUN, `  const LAUNCHCTL = '/usr/bin/osascript';\n${RUN}`),
  'launchctl\'s name taken from somewhere else': (d) => change(d, 'scripts/unattended.mjs', 'const LAUNCHCTL = launchctlFor();', 'const LAUNCHCTL = process.env.FLOORBOSS_LAUNCHCTL || launchctlFor();'),
  'a process started through a namespace import (cp.spawn)': (d) => change(d, 'scripts/scheduled.mjs', CP, "import * as cp from 'node:child_process';\nconst { spawn } = cp;\ncp.spawn('/usr/bin/true', []);"),
  'a process started through an alias of spawn': (d) => change(d, 'scripts/scheduled.mjs', SPAWN, `    const go = spawn;\n    go('/usr/bin/true', []);\n${SPAWN}`),
  'a process started through import()': (d) => change(d, 'lib/unattended.mjs', 'export const BRIEF_HOUR = 7;', "export const BRIEF_HOUR = 7;\nexport const cp = await import('node:child_process');"),
  'a second process in the launcher, written as a Node call': (d) => change(d, 'scripts/scheduled.mjs', CP, "import { spawn, spawnSync } from 'node:child_process';\nspawnSync(process.execPath, ['-e', '0']);"),
  'a second process in the install script, written as a Node call': (d) => change(d, 'scripts/unattended.mjs', RUN, `  spawnSync(process.execPath, ['-e', '0']);\n${RUN}`),
  'the tests\' stand-ins switched on for everyone (the choice edited)': (d) => change(d, 'lib/unattended.mjs', "  if (env.FLOORBOSS_TEST === '1') return env.FLOORBOSS_LAUNCHCTL || null;", '  if (true) return env.FLOORBOSS_LAUNCHCTL || null;'),
  'the tests\' stand-ins switched on for everyone (the opener\'s choice edited)': (d) => change(d, 'lib/unattended.mjs', "  if (env.FLOORBOSS_TEST === '1') return env.FLOORBOSS_OPENER || null;", "  if (env.FLOORBOSS_TEST !== '0') return env.FLOORBOSS_OPENER || null;"),
  'the test switch set by the launcher itself': (d) => change(d, 'scripts/scheduled.mjs', CP, `${CP}\nprocess.env.FLOORBOSS_TEST = '1';`),
  'the test switch set by the install script, another spelling': (d) => change(d, 'scripts/unattended.mjs', 'const PLATFORM = platformFor();', "process.env['FLOORBOSS_TEST'] = '1';\nconst PLATFORM = platformFor();"),
  'a choice defined a second time': (d) => change(d, 'scripts/unattended.mjs', 'const LAUNCHCTL = launchctlFor();', "const launchctlFor = () => '/usr/bin/osascript';\nconst LAUNCHCTL = launchctlFor();"),
  'the terminal test taken off switching back on': (d) => change(d, 'scripts/unattended.mjs', "  if (notYours('turning unattended runs back on')) return;\n", ''),
  'the terminal test made to pass': (d) => change(d, 'scripts/unattended.mjs', '  if (!claude && terminalPresent()) return false;', '  if (!claude) return false;'),
  'a terminal that is always there': (d) => change(d, 'lib/unattended.mjs', '  return !!stdin.isTTY && !!stdout.isTTY;', '  return true;'),
  'another opener than /usr/bin/open': (d) => change(d, 'lib/unattended.mjs', "platform === 'darwin' ? '/usr/bin/open'", "platform === 'darwin' ? '/usr/bin/osascript'"),
  'launchctl named in another script': (d) => writeFileSync(join(d, 'lib', 'extra.mjs'), "export const run = ['launchctl', 'load'];\n"),
  'a worker thread somewhere else': (d) => writeFileSync(join(d, 'lib', 'extra.mjs'), "import { Worker } from 'node:worker_threads';\nexport const w = () => new Worker('x');\n"),
  // From the second review: each of these got past the check as it then was.
  'another module reached through a name built at run time (createRequire), in a file far from the launcher': (d) =>
    change(d, 'lib/clock.mjs', 'export const nowMs', "import { createRequire } from 'node:module';\nexport const cp = createRequire(import.meta.url)('child_' + 'process');\nexport const nowMs"),
  'process.getBuiltinModule with a built name, in the launcher': (d) => change(d, 'scripts/scheduled.mjs', CP, `${CP}\nconst other = process.getBuiltinModule('node:child_' + 'process');`),
  'the network through a built name, import("node:ht" + "tps")': (d) => change(d, 'scripts/scheduled.mjs', CP, `${CP}\nconst net = await import('node:ht' + 'tps');`),
  'the opener handed another file than the page': (d) => change(d, 'scripts/scheduled.mjs', '      const opened = await openPage(out.page);', "      const opened = await openPage('/tmp/x.command');"),
  'the page runBrief returns made another file': (d) => change(d, 'scripts/scheduled.mjs', '  return { built: fresh.map((r) => r.slug), page: todayPage(), results };', "  return { built: fresh.map((r) => r.slug), page: '/tmp/x.command', results };"),
  'the gate made to answer "yours" always (its body, not its call sites)': (d) => change(d, 'scripts/unattended.mjs', '  if (!claude && terminalPresent()) return false;\n  refused(what, claude);\n  return true;', '  if (!claude && terminalPresent()) return false;\n  return false;'),
  'the Claude Code half of the gate removed (const claude = false)': (d) => change(d, 'scripts/unattended.mjs', "  const claude = 'CLAUDECODE' in process.env;", '  const claude = false;'),
  'the watchdog made to do nothing': (d) => change(d, 'lib/watchdog.mjs', "setTimeout(() => process.kill(process.pid, 'SIGKILL'), workerData.ms);", 'setTimeout(() => {}, workerData.ms);'),
  'the watchdog made to write something before it stops the run': (d) => change(d, 'lib/watchdog.mjs', "setTimeout(() => process.kill(process.pid, 'SIGKILL'), workerData.ms);", "setTimeout(() => { console.log('late'); process.kill(process.pid, 'SIGKILL'); }, workerData.ms);"),
  'launchctl handed another file to load': (d) => change(d, 'scripts/unattended.mjs', "  const r = launchctl(['bootstrap', domain(), plist]);", "  const r = launchctl(['bootstrap', domain(), '/tmp/evil.plist']);"),
  'launchctl given a fourth thing to do': (d) => change(d, 'scripts/unattended.mjs', "  const r = launchctl(['bootstrap', domain(), plist]);", "  launchctl(['kickstart', '-k', 'system/com.apple.x']);\n  const r = launchctl(['bootstrap', domain(), plist]);"),
  'the launchd file given RunAtLoad true': (d) => change(d, 'lib/unattended.mjs', "    '  <key>RunAtLoad</key><false/>',", "    '  <key>RunAtLoad</key><true/>',"),
  'the launchd file given a shell to run': (d) => change(d, 'lib/unattended.mjs', "    `  <array>${s(n)}${s(l)}${s('brief')}</array>`,", "    `  <array>${s('/bin/sh')}${s('-c')}${s(l)}</array>`,"),
  'the launchd file given KeepAlive': (d) => change(d, 'lib/unattended.mjs', "    '  <key>RunAtLoad</key><false/>',", "    '  <key>RunAtLoad</key><false/>',\n    '  <key>KeepAlive</key><true/>',"),
  'the file written to the launchd folder made another text': (d) => change(d, 'scripts/unattended.mjs', "  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });", "  writeFileSync(tmp, process.env.PLIST || text, { mode: 0o600, flag: 'wx' });"),
  // From the third review.
  'the launcher\'s time limit raised to a day': (d) => change(d, 'scripts/scheduled.mjs', 'export const TIME_LIMIT_MS = 60000;', 'export const TIME_LIMIT_MS = 86400000;'),
  'the launcher\'s time limit taken from the environment outside the tests': (d) =>
    change(d, 'scripts/scheduled.mjs', "  const ms = (process.env.FLOORBOSS_TEST === '1' && Number(process.env.FLOORBOSS_BRIEF_LIMIT_MS)) || TIME_LIMIT_MS;", '  const ms = Number(process.env.FLOORBOSS_BRIEF_LIMIT_MS) || TIME_LIMIT_MS;'),
  'the watchdog handed another limit than the one read': (d) => change(d, 'scripts/scheduled.mjs', '{ workerData: { ms } })', '{ workerData: { ms: ms * 1000 } })'),
  // From the fourth review.
  'the watchdog started only on some condition': (d) =>
    change(d, 'scripts/scheduled.mjs', "    if (existsSync(home())) new Worker(new URL('../lib/watchdog.mjs', import.meta.url), { workerData: { ms } }).unref();", "    if (existsSync(home()) && process.env.WATCH) new Worker(new URL('../lib/watchdog.mjs', import.meta.url), { workerData: { ms } }).unref();"),
  'the watchdog built and never started as a thread of its own': (d) =>
    change(d, 'scripts/scheduled.mjs', "    if (existsSync(home())) new Worker(new URL('../lib/watchdog.mjs', import.meta.url), { workerData: { ms } }).unref();", "    const W = false && Worker;\n    if (existsSync(home()) && W) new Worker(new URL('../lib/watchdog.mjs', import.meta.url), { workerData: { ms } }).unref();"),
  'the launcher\'s worker pointed at other code': (d) => change(d, 'scripts/scheduled.mjs', "new Worker(new URL('../lib/watchdog.mjs', import.meta.url), { workerData: { ms } })", "new Worker(new URL('../lib/other.mjs', import.meta.url), { workerData: { ms } })")
};

test('self-check holds on the code as it is (a copy)', () => {
  const r = check(copy());
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.failed, []);
});

for (const [name, apply] of Object.entries(EVASIONS))
  test(`self-check fails on: ${name}`, () => {
    const dir = copy();
    apply(dir);
    const r = check(dir);
    assert.equal(r.code, 1, `the check still held:\n${r.out}`);
    assert.ok(r.failed.length >= 1);
    // A failed line made of several conditions names the ones that failed.
    for (const line of r.failed.filter((l) => /the scheduled launcher starts one process|the install script starts one process|the launchd file runs Node|watchdog ends the process/.test(l)))
      assert.match(r.out.slice(r.out.indexOf(line)).split('\n')[1] || '', /^ {6}not so: \S/, line);
  });
