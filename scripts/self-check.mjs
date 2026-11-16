#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
//
// `npm run self-check`: checks, on your own copy, the claims SECURITY.md makes about what floorboss is and what
// it can reach. It reads the repository and runs the security tests in a throwaway home; it changes nothing,
// installs nothing and makes no network call. Each line says what was checked and whether it held.
//
// What it is: a reading of the code's text. It finds the usual ways a script reaches the network or starts a
// process, and it holds the few lines that matter most (which program the scheduled launcher and the install
// script start, on which file, behind which gate) to their exact reviewed wording, so a change there shows up as
// a failed line that names what changed. What it is not: a proof. Code written to hide what it does can get past
// a text search, and an ordinary edit to one of the pinned lines fails the check until the pin is updated with
// it. It tells you the code still says what was reviewed; reading the code is still the review.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
let failed = 0;
const say = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `\n      ${detail.split('\n').join('\n      ')}` : ''}`);
};
const files = (dir) =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return ['node_modules', '.git', 'test'].includes(d.name) ? [] : files(p);
    return [p];
  });
// This script names the patterns it looks for, so it isn't one of the files it checks.
const code = files('.').filter((f) => /\.(mjs|cjs|js|html)$/.test(f) && f !== 'scripts/self-check.mjs');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

// 1. No third-party code.
const pkg = JSON.parse(read('package.json'));
const deps = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies'].flatMap((k) => Object.keys(pkg[k] || {}));
say(!deps.length, 'package.json lists no dependencies', deps.join(', '));
const install = Object.keys(pkg.scripts || {}).filter((k) => /^(pre|post)?install$|^prepare$|^prepublish/.test(k));
say(!install.length, 'no install scripts', install.join(', '));
const locks = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'].filter((f) => existsSync(join(ROOT, f)));
say(!locks.length, 'no lockfile (nothing to install)', locks.join(', '));
say(!existsSync(join(ROOT, 'node_modules')), 'no node_modules folder');
const bare = code.flatMap((f) =>
  [...read(f).matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((m) => m[1] || m[2])
    .filter((s) => !s.startsWith('.') && !s.startsWith('node:'))
    .map((s) => `${f}: ${s}`)
);
say(!bare.length, "every import is a Node.js built-in (node:) or one of floorboss's own files", bare.join('\n'));

// 2. No network of its own.
const NET = /from\s+['"]node:(http|https|http2|net|tls|dgram|dns)['"]|\bfetch\s*\(|new\s+WebSocket|XMLHttpRequest|import\(\s*['"]https?:/;
const net = code.filter((f) => NET.test(read(f)));
say(!net.length, 'no network modules, fetch or remote imports in any script', net.join('\n'));
// The tests it runs in step 7 too. Tests hold attack text with fetch( in it, and some define their own fetch()
// helper (it asks the guard about a WebFetch call; nothing is fetched). So imports are checked as written, and
// calls only outside strings, with fetch( skipped in a file that defines its own.
const testCode = (function walkTests(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walkTests(join(dir, d.name)) : [join(dir, d.name)]));
})('test').filter((f) => /\.(mjs|cjs|js)$/.test(f));
const NET_IMPORT = /from\s+['"]node:(http|https|http2|net|tls|dgram|dns)['"]|import\(\s*['"](https?:|node:(http|https|http2|net|tls|dgram|dns)['"])|require\(\s*['"](node:)?(http|https|http2|net|tls|dgram|dns)['"]/;
const strip = (t) => t.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, "''");
const testNet = testCode.filter((f) => {
  const t = read(f);
  const calls = strip(t);
  const fetchCall = !/(?:const|let|function)\s+fetch\b/.test(t) && /\bfetch\s*\(/.test(calls);
  return NET_IMPORT.test(t) || fetchCall || /new\s+WebSocket|XMLHttpRequest/.test(calls);
});
say(!testNet.length, 'no network modules, fetch or remote imports in the tests', testNet.join('\n'));

// 3. The only processes it starts: Node.js running floorboss's own scripts, and your system's opener for the
// outbox page and for the morning brief's page. Two more, each in one file only: Claude Code, started by the follow-up
// drafts launcher (scripts/scheduled.mjs followups) when an authorised follow-up is due; and launchctl, started by the
// install script you run from your own terminal (scripts/unattended.mjs), to load or unload a job you installed.
const spawns = code.flatMap((f) =>
  read(f)
    .split('\n')
    .map((l, i) => [l, i + 1])
    .filter(([l]) => /(?<![.\w])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/.test(l) && !/^\s*\/\//.test(l))
    .map(([l, n]) => `${f}:${n}: ${l.trim().slice(0, 140)}`)
);
const unexpected = spawns.filter(
  (s) =>
    !/process\.execPath|spawn\(cmd, \[paths\.outbox\]/.test(s) &&
    !/^scripts\/scheduled\.mjs:\d+: const child = spawn\(cmd, \[page\], /.test(s) &&
    !/^scripts\/scheduled\.mjs:\d+: const child = spawn\(run\.program, run\.args, \{ stdio: \['ignore', 'ignore', 'pipe'\], env: run\.env, detached: true \}\);$/.test(s) &&
    !/^scripts\/unattended\.mjs:\d+: return spawnSync\(LAUNCHCTL, args, /.test(s)
);
say(
  !unexpected.length,
  'processes started are Node.js (floorboss scripts), the opener (outbox page, morning brief), Claude Code in the follow-up drafts launcher, and launchctl in scripts/unattended.mjs only',
  (unexpected.length ? unexpected : spawns).join('\n')
);
// The search above reads names; these hold the names to what they are.
// Every mention of Node's process module is a plain import of spawn or spawnSync by name (no alias, no namespace,
// no import() or require), so a call written as x.spawn(…) has nothing to stand on.
const noComments = (t) => t.replace(/^\s*\/\/.*$/gm, '');
const count = (t, re) => (t.match(re) || []).length;
const cpLines = code.flatMap((f) =>
  noComments(read(f))
    .split('\n')
    .filter((l) => /child_process/.test(l))
    .map((l) => [f, l])
);
const cpOdd = cpLines.filter(([, l]) => !/^import \{ (spawn|spawnSync) \} from 'node:child_process';$/.test(l)).map(([f, l]) => `${f}: ${l.trim().slice(0, 120)}`);
say(!cpOdd.length, "Node's process module is imported only as spawn or spawnSync, by name", cpOdd.join('\n'));
const cpHere = [...new Set(cpLines.map(([f]) => f))].filter((f) => /^(scripts|lib)\//.test(f)).sort();
const cpHereOk = cpHere.join() === 'scripts/scheduled.mjs,scripts/unattended.mjs';
say(cpHereOk, 'under scripts/ and lib/, only the scheduled launcher and the install script can start a process (besides this check)', cpHereOk ? '' : cpHere.join('\n'));
// Nothing sets the switch that turns the tests' stand-ins on.
const setsTest = code.filter((f) => /\.FLOORBOSS_TEST\s*=(?!=)|\[\s*['"`]FLOORBOSS_TEST['"`]\s*\]\s*=(?!=)|FLOORBOSS_TEST['"`]?\s*:|Object\.assign\(\s*process\.env/.test(noComments(read(f))));
say(!setsTest.length, 'no script sets FLOORBOSS_TEST (the stand-ins for the opener and launchctl exist only under the tests)', setsTest.join('\n'));
// The four choices (which opener, which launchctl, which platform, which Claude Code) and the terminal test, word for
// word; and the one Claude Code run: its arguments and the flags it is never given.
const lib = read('lib/unattended.mjs');
const PINNED = [
  `export function openerFor(env = process.env, platform = process.platform) {
  if (env.FLOORBOSS_TEST === '1') return env.FLOORBOSS_OPENER || null;
  return platform === 'darwin' ? '/usr/bin/open' : platform === 'win32' ? join(env.SystemRoot || 'C:\\\\Windows', 'explorer.exe') : '/usr/bin/xdg-open';
}`,
  `export function launchctlFor(env = process.env) {
  if (env.FLOORBOSS_TEST === '1') return env.FLOORBOSS_LAUNCHCTL || null;
  return '/bin/launchctl';
}`,
  `export function platformFor(env = process.env, platform = process.platform) {
  if (env.FLOORBOSS_TEST === '1' && env.FLOORBOSS_PLATFORM) return env.FLOORBOSS_PLATFORM;
  return platform;
}`,
  `export function terminalPresent(env = process.env, stdin = process.stdin, stdout = process.stdout) {
  if (env.FLOORBOSS_TEST === '1' && env.FLOORBOSS_TTY === '1') return true;
  return !!stdin.isTTY && !!stdout.isTTY;
}`,
  `export function claudeFor(env = process.env, installed = null) {
  if (env.FLOORBOSS_TEST === '1') return env.FLOORBOSS_CLAUDE || null;
  return typeof installed?.claude === 'string' && isAbsolute(installed.claude) ? installed.claude : null;
}`
];
const CHOICES = ['openerFor', 'launchctlFor', 'platformFor', 'terminalPresent', 'claudeFor'];
say(
  PINNED.every((t) => lib.includes(t)) && CHOICES.every((n) => count(lib, new RegExp(`\\b${n}\\b`, 'g')) === 1),
  'outside the tests the opener is /usr/bin/open (macOS), launchctl is /bin/launchctl, the platform is the real one, a terminal is a real one, and Claude Code is the path the install recorded'
);
const RUN_PINS = {
  'the run is a print run of the follow-ups command, its own session, no prompts, no browser, no saved session, and those tools refused':
    lib.includes(
      "  const args = ['-p', FOLLOWUPS_PROMPT, '--session-id', session, '--permission-prompts', 'none', '--no-chrome', '--no-session-persistence', '--disallowed-tools', UNATTENDED_DISALLOWED.join(',')];"
    ) && lib.includes("export const FOLLOWUPS_PROMPT = '/floorboss:followups-due';"),
  'only under the tests does it get a plugin folder and stand-in connectors':
    lib.includes("  if (env.FLOORBOSS_TEST === '1') {\n    if (extra.pluginDir) args.push('--plugin-dir', String(extra.pluginDir));\n    if (extra.mcpConfig) args.push('--strict-mcp-config', '--mcp-config', String(extra.mcpConfig));\n  }") &&
    count(lib, /args\.push\(/g) === 2,
  'the list is checked before anything starts, and refused with any flag that turns the guard off or answers a prompt':
    lib.includes("  const why = argsRefusal(args, { test: env.FLOORBOSS_TEST === '1' });\n  if (why) throw new Error(`nothing was started: ${why}`);") &&
    ['--bare', '--safe-mode', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode', '--settings'].every((f) => lib.includes(`  '${f}',`)) &&
    lib.includes("const NEVER_MODES = /^(bypasspermissions|auto|dontask|acceptedits)$/i;"),
  "its environment is the launcher's, with the run's token, without a Claude Code session's marker, a variable that loads code, or a test switch outside the tests":
    lib.includes('  const childEnv = { ...env, FLOORBOSS_UNATTENDED: token };') &&
    lib.includes("  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SAFE_MODE', 'CLAUDE_CODE_SIMPLE']) delete childEnv[k];") &&
    lib.includes("  for (const k of Object.keys(childEnv)) if (RUN_ENV_NEVER.test(k) || (env.FLOORBOSS_TEST !== '1' && /^FLOORBOSS_/.test(k) && !['FLOORBOSS_HOME', 'FLOORBOSS_UNATTENDED'].includes(k))) delete childEnv[k];")
};

// A check made of several conditions: when it fails, the ones that failed are named.
const sayAll = (what, conds) => {
  const failedOnes = Object.entries(conds)
    .filter(([, ok]) => !ok)
    .map(([name]) => `not so: ${name}`);
  say(!failedOnes.length, what, failedOnes.join('\n'));
};
sayAll("the one Claude Code run the follow-up drafts launcher starts: its arguments, its checks and its environment", RUN_PINS);
// The launcher: two process starts. The opener, by the name the choice above gave it, on the page it wrote; and, in
// the follow-up drafts mode, Claude Code by the path the install recorded, with the run claudeRun built.
const launcher = noComments(read('scripts/scheduled.mjs'));
const STARTS = /(?<![.\w])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/g;
sayAll("the scheduled launcher starts two processes: the system's opener on today.html, and the one Claude Code run claudeRun built; no launchctl", {
  'exactly two calls that start a process': count(launcher, STARTS) === 2,
  'the first is spawn(cmd, [page], …), detached': launcher.includes("    const child = spawn(cmd, [page], { stdio: 'ignore', detached: true });"),
  'cmd is openerFor() and nothing else (declared once, used twice)': launcher.includes('  const cmd = openerFor();') && count(launcher, /\bcmd\b/g) === 3,
  'the second is spawn(run.program, run.args, …) with run.env, in a group of its own':
    launcher.includes("    const child = spawn(run.program, run.args, { stdio: ['ignore', 'ignore', 'pipe'], env: run.env, detached: true });") && count(launcher, /\brun\.program\b/g) === 1,
  'that run is claudeRun(…) with the program claudeFor(…) chose, started once':
    count(launcher, /\bclaudeRun\b/g) === 2 &&
    count(launcher, /\bclaudeFor\b/g) === 2 &&
    launcher.includes('      program: claudeFor(process.env, inst),') &&
    launcher.includes('    const run = claudeRun({') &&
    count(launcher, /\bstartRun\(/g) === 2 &&
    launcher.includes('    const r = await startRun(run, limit);'),
  'never from a Claude Code shell': launcher.includes("  if ('CLAUDECODE' in process.env) {"),
  'its time limit is the run limit, shorter only under the tests': launcher.includes("    const limit = (test && Number(process.env.FLOORBOSS_FOLLOWUPS_LIMIT_MS)) || RUN_LIMIT_MS;") && read('lib/unattended-drafts.mjs').includes('export const RUN_LIMIT_MS = 40 * 60 * 1000;'),
  'spawn is named three times (its import and those calls)': count(launcher, /(?<!['.\w])spawn\b/g) === 3,
  'openerFor is named twice (its import and that call)': count(launcher, /\bopenerFor\b/g) === 2,
  'the page opened is the one runBrief returned, which is todayPage()':
    count(launcher, /\bopenPage\(/g) === 2 && launcher.includes('      const opened = await openPage(out.page);') && launcher.includes('  return { built: fresh.map((r) => r.slug), page: todayPage(), results };'),
  'one worker thread, the watchdog, started whenever there is a data folder':
    count(launcher, /new Worker\(/g) === 1 &&
    count(launcher, /\bWorker\b/g) === 2 &&
    launcher.includes("\n    if (existsSync(home())) new Worker(new URL('../lib/watchdog.mjs', import.meta.url), { workerData: { ms } }).unref();\n"),
  'its time limit is 60 seconds, shorter only under the tests':
    launcher.includes('export const TIME_LIMIT_MS = 60000;') &&
    launcher.includes("  const ms = (process.env.FLOORBOSS_TEST === '1' && Number(process.env.FLOORBOSS_BRIEF_LIMIT_MS)) || TIME_LIMIT_MS;") &&
    count(launcher, /\bTIME_LIMIT_MS\b/g) === 2 &&
    count(launcher, /\bms\b/g) === 3,
  '"launchctl" does not appear in its code, and "claude" only in those names': !/launchctl/i.test(launcher) && !/claude/i.test(launcher.replace(/claudeFor|claudeRun|CLAUDECODE|Claude Code/g, ''))
});
const watchdog = noComments(read('lib/watchdog.mjs'));
sayAll("the launcher's watchdog ends the process at the limit and does nothing else", {
  'its one statement is the timer that kills the process': watchdog.includes("if (!isMainThread && Number.isFinite(workerData?.ms)) setTimeout(() => process.kill(process.pid, 'SIGKILL'), workerData.ms);"),
  'it imports only worker_threads': count(watchdog, /^import /gm) === 1 && watchdog.includes("import { workerData, isMainThread } from 'node:worker_threads';")
});
// The install script: one process start, launchctl, by the name the choice above gave it, on the file it wrote,
// and only after the gate (a terminal, and not Claude Code's shell).
const inst = noComments(read('scripts/unattended.mjs'));
const GATE = `function notYours(what) {
  const claude = 'CLAUDECODE' in process.env;
  if (!claude && terminalPresent()) return false;
  refused(what, claude);
  return true;
}`;
sayAll('the install script starts one process, /bin/launchctl, on its own launchd file, and installs, removes or switches on only in a terminal', {
  'exactly one call that starts a process': count(inst, STARTS) === 1,
  'that call is spawnSync(LAUNCHCTL, args, …)': inst.includes("  return spawnSync(LAUNCHCTL, args, { encoding: 'utf8' });"),
  'LAUNCHCTL is launchctlFor() and nothing else (declared once, used twice)': inst.includes('const LAUNCHCTL = launchctlFor();') && count(inst, /\bLAUNCHCTL\b/g) === 3,
  'spawnSync and launchctlFor are each named twice (import and use)': count(inst, /\bspawnSync\b/g) === 2 && count(inst, /\blaunchctlFor\b/g) === 2,
  'PLATFORM is platformFor() and nothing else': inst.includes('const PLATFORM = platformFor();') && count(inst, /\bplatformFor\b/g) === 2 && count(inst, /\bPLATFORM\b/g) === 4,
  'the gate (notYours) reads word for word as reviewed': inst.includes(GATE) && count(inst, /function notYours\b/g) === 1 && count(inst, /\bnotYours\b/g) === 4,
  'the gate is the first thing installing, removing and on do after the platform test':
    inst.includes('  if (notYours(t.installing)) return;') && inst.includes('  if (notYours(t.removing)) return;') && inst.includes("  if (notYours('turning unattended runs back on')) return;"),
  'terminalPresent is named twice (its import and the gate)': count(inst, /\bterminalPresent\b/g) === 2,
  'launchctl is called three ways only: bootout of its own job (twice) and bootstrap of its own file':
    count(inst, /\blaunchctl\(\[/g) === 3 &&
    count(inst, /launchctl\(\['bootout', `\$\{domain\(\)\}\/\$\{job\.label\}`\]\)/g) === 2 &&
    inst.includes("  const r = launchctl(['bootstrap', domain(), plist]);") &&
    inst.includes('const domain = () => `gui/${process.getuid()}`;'),
  'the file it loads is plistPathFor(job), holding jobPlist(…) of checked paths':
    inst.includes('  const plist = plistPathFor(job);') && inst.includes('  const text = jobPlist({ job: job.mode, node, launcher, floorbossHome });') && inst.includes("  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });") && inst.includes('  renameSync(tmp, plist);'),
  'the jobs it installs are the two in JOBS': count(inst, /installJob\(JOBS\.(brief|followups), a\)/g) === 2 && count(inst, /\binstallJob\(/g) === 3
});
sayAll('the launchd files run Node on the launcher with the word "brief" or "followups", at their hours, never at load, with no shell', {
  'RunAtLoad is false': lib.includes("    '  <key>RunAtLoad</key><false/>',") && count(lib, /RunAtLoad/g) === 1,
  "the program is Node, the launcher and the job's word": lib.includes("    `  <array>${s(n)}${s(l)}${s(j.mode)}</array>`,") && count(lib, /ProgramArguments/g) === 1 && lib.includes('  const j = Object.values(JOBS).find((x) => x.mode === job);'),
  'the jobs are the brief, at 07:00, and the follow-up drafts, every hour of the day':
    lib.includes("  brief: Object.freeze({ mode: 'brief', label: BRIEF_LABEL, hours: Object.freeze([BRIEF_HOUR]) }),") &&
    lib.includes("  followups: Object.freeze({ mode: 'followups', label: FOLLOWUPS_LABEL, hours: FOLLOWUP_HOURS })") &&
    lib.includes('export const FOLLOWUP_HOURS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);') &&
    lib.includes('export const BRIEF_HOUR = 7;'),
  'the label is its job': lib.includes('    `  <key>Label</key>${s(j.label)}`,') && lib.includes('export const BRIEF_LABEL = `${LABEL_PREFIX}brief`;') && lib.includes('export const FOLLOWUPS_LABEL = `${LABEL_PREFIX}followups`;') && lib.includes("export const LABEL_PREFIX = 'com.floorboss.';"),
  'no KeepAlive, WatchPaths, StartInterval or shell': !/KeepAlive|WatchPaths|StartInterval|QueueDirectories|\/bin\/(ba|z)?sh/.test(noComments(lib)),
  'every value goes through the XML escape': lib.includes('  const s = (v) => `<string>${xmlText(v)}</string>`;')
});
// A module can't be reached by a name put together at run time: no import() of anything but a quoted name, and
// none of the calls that load a module by a computed name.
const computed = code.filter((f) => {
  const t = noComments(read(f));
  // Every import(…) is import('one quoted name') and nothing more inside the brackets.
  const anyImport = count(t, /\bimport\s*\(/g);
  const quoted = count(t, /\bimport\s*\(\s*(?:'[^'"`+$]+'|"[^'"`+$]+")\s*\)/g);
  return anyImport !== quoted || /createRequire|getBuiltinModule|(?<![.\w])require\s*\(|process\.binding|\bnew Function\b|(?<![.\w])eval\s*\(/.test(t);
});
say(!computed.length, 'no module is loaded by a name built at run time (import() of a quoted name only; no createRequire, getBuiltinModule, require, eval)', computed.join('\n'));
// No other file's code names launchctl, apart from the guard's rule that refuses it and the choice above.
const namesLaunchctl = code.filter((f) => /launchctl/i.test(noComments(read(f)))).filter((f) => !['scripts/unattended.mjs', 'hooks/guard/shell.mjs', 'lib/unattended.mjs'].includes(f));
say(!namesLaunchctl.length, 'launchctl is started by scripts/unattended.mjs only (the guard names it to refuse it)', namesLaunchctl.join('\n'));
// A second thread is started in one place, for the launcher's time limit.
const workers = code.filter((f) => /worker_threads/.test(noComments(read(f)))).sort();
const workersOk = workers.join() === 'lib/watchdog.mjs,scripts/scheduled.mjs';
say(workersOk, "a worker thread is used only for the scheduled launcher's time limit", workersOk ? '' : workers.join('\n'));

// 4. What runs on its own: the hooks.
const hooks = JSON.parse(read('hooks/hooks.json'));
const cmds = [];
const walk = (v) =>
  Array.isArray(v)
    ? v.forEach(walk)
    : v && typeof v === 'object'
      ? Object.entries(v).forEach(([k, x]) => (k === 'command' ? cmds.push(String(x)) : walk(x)))
      : null;
walk(hooks.hooks);
say(
  cmds.length > 0 && cmds.every((c) => /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/(guard|remind)\.mjs"( post| end| [a-z-]+)?( \|\| exit 2)?$/.test(c)),
  'hooks run only hooks/guard.mjs and hooks/remind.mjs',
  cmds.join('\n')
);

// 5. CI: actions pinned to a commit, no write access to the code.
const wf = existsSync(join(ROOT, '.github/workflows')) ? readdirSync(join(ROOT, '.github/workflows')).map((f) => `.github/workflows/${f}`) : [];
const loose = wf.flatMap((f) =>
  [...read(f).matchAll(/uses:\s*(\S+)/g)]
    .map((m) => m[1])
    .filter((u) => !/@[0-9a-f]{40}$/.test(u))
    .map((u) => `${f}: ${u}`)
);
say(!loose.length, 'every GitHub Action is pinned to a full commit', loose.join('\n'));
const writes = wf.filter((f) => /contents:\s*write|write-all/.test(read(f)));
say(!writes.length, 'no workflow can write to the code', writes.join('\n'));

// 6. Data folder permissions in the code: private files and folders. This reads lib/paths.mjs, not ~/.floorboss.
const perms = read('lib/paths.mjs');
say(/0o700/.test(perms) && /0o600/.test(perms), "floorboss's code creates the data folder private (0700 folders, 0600 files); this reads the code, not your folder");

// 7. The security tests, in a throwaway home.
// (--static leaves them out: floorboss's own tests use it to try this check on changed copies of the code.)
if (!process.argv.includes('--static')) {
  const tests = readdirSync(join(ROOT, 'test'))
    .filter((f) => /^(security-|workflows|fail-closed|prompt|injection)/.test(f) && f.endsWith('.test.mjs'))
    .map((f) => `test/${f}`);
  const r = spawnSync(process.execPath, ['--test', '--import', './test/fixtures/isolated-home.mjs', ...tests], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, FLOORBOSS_TEST: '1' }
  });
  const count = (k) => Number((new RegExp(`ℹ ${k} (\\d+)`).exec(r.stdout) || [])[1] || 0);
  say(
    r.status === 0 && count('fail') === 0,
    `security tests: ${count('pass')} passed, ${count('fail')} failed (${tests.length} files)`,
    r.status === 0
      ? ''
      : r.stdout
          .split('\n')
          .filter((l) => /^✖/.test(l))
          .join('\n')
  );
}

console.log(failed ? `\n${failed} check(s) failed.` : '\nEvery check held.');
process.exit(failed ? 1 : 0);
