// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// What runs with nobody there: two scheduled jobs, the morning brief and the follow-up drafts (scripts/scheduled.mjs),
// which the user installs from their own terminal (scripts/unattended.mjs). This file holds what both share with the
// guard and the reminder hook: where the jobs' files live, the log, the off switch, the launchd file's text, and the
// one Claude Code run the follow-up drafts job may start.
import { homedir } from 'node:os';
import { join, isAbsolute, resolve, delimiter } from 'node:path';
import { lstatSync, chmodSync, mkdirSync, realpathSync, statSync, openSync, fstatSync, readSync, closeSync, constants as FS } from 'node:fs';
import { home } from './paths.mjs';
import { appendLine, readJson } from './jsonio.mjs';
import { nowMs } from './clock.mjs';

// Every floorboss job's launchd name starts with this; the guard refuses a shell command that names it.
export const LABEL_PREFIX = 'com.floorboss.';
export const BRIEF_LABEL = `${LABEL_PREFIX}brief`;
export const BRIEF_HOUR = 7;
export const FOLLOWUPS_LABEL = `${LABEL_PREFIX}followups`;
// Every hour of the day on the machine's clock, so an event in any time zone gets its hours. The launcher itself holds
// each follow-up to weekdays (Monday to Friday), 09:00 to 17:00 in its event's time zone.
export const FOLLOWUP_HOURS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
// The two jobs: what the launcher is started with, its name, and its hours.
export const JOBS = Object.freeze({
  brief: Object.freeze({ mode: 'brief', label: BRIEF_LABEL, hours: Object.freeze([BRIEF_HOUR]) }),
  followups: Object.freeze({ mode: 'followups', label: FOLLOWUPS_LABEL, hours: FOLLOWUP_HOURS })
});

export const unattendedDir = () => join(home(), 'unattended');
export const offFile = () => join(unattendedDir(), 'off');
export const logFile = () => join(unattendedDir(), 'log.jsonl');
// What the last brief run built, per event: the launcher's "one brief a day unless the records changed".
export const briefStateFile = () => join(unattendedDir(), 'brief-state.json');
export const installedFileFor = (job) => join(unattendedDir(), `${job.mode}-installed.json`);
export const briefInstalledFile = () => installedFileFor(JOBS.brief);
export const followupsInstalledFile = () => installedFileFor(JOBS.followups);
export const todayPage = () => join(home(), 'today.html');
export const launchAgentsDir = () => join(homedir(), 'Library', 'LaunchAgents');
export const plistPathFor = (job) => join(launchAgentsDir(), `${job.label}.plist`);
export const briefPlistPath = () => plistPathFor(JOBS.brief);
export const followupsPlistPath = () => plistPathFor(JOBS.followups);

// Anything at the off file's name counts (a file, a folder, a link): its presence stops every unattended run.
export function isOff() {
  try {
    lstatSync(offFile());
    return true;
  } catch {
    return false;
  }
}

// One short line of plain text: no control character, and none a reader can't see (a bidi override, a zero-width
// space). For what is logged, and for what `status` prints back from the log.
export const oneLine = (v, max = 200) =>
  String(v ?? '')
    .replace(/\p{Cf}+/gu, '')
    .replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')
    .slice(0, max);

// The stand-ins floorboss's own tests use. Each is read only when FLOORBOSS_TEST is "1": anywhere else these
// variables do nothing, so a session's environment can't point the job at another program.
// scripts/self-check.mjs holds these four functions, and the Claude Code program's choice below, to this exact text.
export function openerFor(env = process.env, platform = process.platform) {
  if (env.FLOORBOSS_TEST === '1') return env.FLOORBOSS_OPENER || null;
  return platform === 'darwin' ? '/usr/bin/open' : platform === 'win32' ? join(env.SystemRoot || 'C:\\Windows', 'explorer.exe') : '/usr/bin/xdg-open';
}
export function launchctlFor(env = process.env) {
  if (env.FLOORBOSS_TEST === '1') return env.FLOORBOSS_LAUNCHCTL || null;
  return '/bin/launchctl';
}
export function platformFor(env = process.env, platform = process.platform) {
  if (env.FLOORBOSS_TEST === '1' && env.FLOORBOSS_PLATFORM) return env.FLOORBOSS_PLATFORM;
  return platform;
}
// A real terminal on both ends: someone is at the keyboard and reads the screen.
export function terminalPresent(env = process.env, stdin = process.stdin, stdout = process.stdout) {
  if (env.FLOORBOSS_TEST === '1' && env.FLOORBOSS_TTY === '1') return true;
  return !!stdin.isTTY && !!stdout.isTTY;
}
// The Claude Code program the follow-up drafts job starts: the absolute path the install found on the user's own PATH
// (followups-installed.json, which only the install writes). Under floorboss's own tests, only a stand-in the test
// names; the real program is never started there.
export function claudeFor(env = process.env, installed = null) {
  if (env.FLOORBOSS_TEST === '1') return env.FLOORBOSS_CLAUDE || null;
  return typeof installed?.claude === 'string' && isAbsolute(installed.claude) ? installed.claude : null;
}

// ---------- the one Claude Code run the follow-up drafts job starts ----------
// What the run must never be given: each of these turns the guard off (no hooks, no plugins) or lets a call through
// that would have asked (a permission mode that answers for the user). A list that holds any of them is refused
// before anything starts.
export const NEVER_FLAGS = Object.freeze([
  '--bare',
  '--safe-mode',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--permission-mode',
  '--permission-prompt-tool',
  '--settings',
  '--setting-sources',
  '--plugin-url',
  '--restricted',
  '--resume',
  '-r',
  '--continue',
  '-c',
  '--fork-session',
  // Each of these moves the run or widens what it may do: a cloud session, tools allowed with no prompt, more folders.
  '--environment',
  '--allowedTools',
  '--allowed-tools',
  '--add-dir',
  // Never built into the run's list today; refused all the same, so one added later fails closed. Each moves the run
  // off this Mac, opens it to another program or a browser, runs it in the background, or replaces its agents, its
  // instructions or its tools.
  '--cloud',
  '--remote-control',
  '--teleport',
  '--bg',
  '--chrome',
  '--agents',
  '--system-prompt',
  '--system-prompt-file',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--tools',
  // The same, from claude --help (2.1.319): another agent for the session (its instructions), the Desktop app or an
  // IDE instead of this process, a session resumed from a pull request, files downloaded at startup, and a git
  // worktree or tmux session somewhere else.
  '--agent',
  '--desktop',
  '--ide',
  '--from-pr',
  '--file',
  '--worktree',
  '-w',
  '--tmux'
]);
// Only floorboss's own tests may hand the run a plugin folder and stand-in connectors (the end-to-end test).
export const TEST_ONLY_FLAGS = Object.freeze(['--plugin-dir', '--mcp-config', '--strict-mcp-config']);
const NEVER_MODES = /^(bypasspermissions|auto|dontask|acceptedits)$/i;
// Tools the run never uses: no agent, no web, no browser, no other shell, no scheduling or remote tool.
export const UNATTENDED_DISALLOWED = Object.freeze([
  'Agent',
  'Task',
  'WebFetch',
  'WebSearch',
  'PowerShell',
  'Monitor',
  'NotebookEdit',
  'CronCreate',
  'ScheduleWakeup',
  'RemoteTrigger',
  'mcp__claude-in-chrome',
  'mcp__Claude_Browser',
  'mcp__playwright',
  'mcp__puppeteer',
  'mcp__chrome-devtools',
  'mcp__browsermcp'
]);
export const FOLLOWUPS_PROMPT = '/floorboss:followups-due';
// Variables never passed to the run: each loads code into Claude Code, Node or the shell its Bash tool starts.
export const RUN_ENV_NEVER = /^(NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|ZDOTDIR|PROMPT_COMMAND|DYLD_.*|LD_PRELOAD|LD_LIBRARY_PATH|BUN_.*)$/;
// Why a list of arguments must not be handed to Claude Code, or null. test: under floorboss's own tests only.
// (scripts/self-check.mjs pins where claudeRun calls this, six of NEVER_FLAGS and NEVER_MODES, not this body:
// test/unattended-fixes.test.mjs holds the body to its cases.)
export function argsRefusal(args, { test = false } = {}) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) return 'the arguments are not a list of words';
  for (let i = 0; i < args.length; i++) {
    const [flag, value] = args[i].split('=', 2);
    if (NEVER_FLAGS.includes(flag)) return `${flag} is never passed to an unattended run`;
    if (TEST_ONLY_FLAGS.includes(flag) && !test) return `${flag} is passed to an unattended run only under floorboss's own tests`;
    if (/^--permission-mode$/i.test(flag) || NEVER_MODES.test(value ?? '') || (flag === '--permission-prompts' && (value ?? args[i + 1]) !== 'none'))
      return 'an unattended run answers no prompt: its permission prompts are always "none"';
  }
  if (!args.includes('-p') || args.indexOf('--permission-prompts') < 0 || args[args.indexOf('--permission-prompts') + 1] !== 'none')
    return 'an unattended run is a print run (-p) with --permission-prompts none';
  return null;
}
// The run, as a pure value: the program, its arguments and its environment. Nothing here starts anything.
// extra: only under floorboss's own tests, the throwaway plugin folder and stand-in connectors of the end-to-end test.
export function claudeRun({ program, session, token, env = {}, extra = {} }) {
  if (!program || !isAbsolute(program)) throw new Error("Claude Code's path isn't known: run install-followups again from your terminal.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(session))) throw new Error('the session id is not a UUID');
  if (!/^[0-9a-f]{64}$/.test(String(token))) throw new Error('the run token is not 32 random bytes');
  const args = ['-p', FOLLOWUPS_PROMPT, '--session-id', session, '--permission-prompts', 'none', '--no-chrome', '--no-session-persistence', '--disallowed-tools', UNATTENDED_DISALLOWED.join(',')];
  if (env.FLOORBOSS_TEST === '1') {
    if (extra.pluginDir) args.push('--plugin-dir', String(extra.pluginDir));
    if (extra.mcpConfig) args.push('--strict-mcp-config', '--mcp-config', String(extra.mcpConfig));
  }
  const why = argsRefusal(args, { test: env.FLOORBOSS_TEST === '1' });
  if (why) throw new Error(`nothing was started: ${why}`);
  const childEnv = { ...env, FLOORBOSS_UNATTENDED: token };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SAFE_MODE', 'CLAUDE_CODE_SIMPLE']) delete childEnv[k];
  // Nothing that loads code into the run or its shell (a value set with launchctl setenv reaches every job started
  // later), and none of floorboss's own test switches outside its tests.
  for (const k of Object.keys(childEnv)) if (RUN_ENV_NEVER.test(k) || (env.FLOORBOSS_TEST !== '1' && /^FLOORBOSS_/.test(k) && !['FLOORBOSS_HOME', 'FLOORBOSS_UNATTENDED'].includes(k))) delete childEnv[k];
  return { program, args, env: childEnv };
}

// The Node to name in the launchd file. The one running the install is exact but often a versioned path
// (Homebrew's Cellar), gone after the next update. If the first "node" on PATH is an absolute path to this same
// program, that name is used: it is the one the user's shell runs, and it outlives an update.
export function stableNodePath(execPath = process.execPath, pathVar = process.env.PATH || '') {
  let real;
  try {
    real = realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const dir of String(pathVar).split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'node');
    try {
      if (!statSync(candidate).isFile()) continue;
      return realpathSync(candidate) === real ? candidate : execPath;
    } catch {
      /* not in this folder */
    }
  }
  return execPath;
}

// One line in unattended/log.jsonl. Text fields are cut to one short line: a reason may quote an error.
export function logLine(type, fields = {}) {
  const dir = privateDir();
  const entry = { at: new Date(nowMs()).toISOString(), type };
  for (const [k, v] of Object.entries(fields)) entry[k] = typeof v === 'string' ? oneLine(v) : v;
  appendLine(logFile(), JSON.stringify(entry));
  return entry;
}

// floorboss's unattended folder, made private. Never through a link: a link planted at its name would carry the
// chmod, and everything written after it, somewhere else.
export function privateDir() {
  const dir = unattendedDir();
  let st = null;
  try {
    st = lstatSync(dir);
  } catch {
    st = null;
  }
  if (st && !st.isDirectory()) throw new Error(`${dir} isn't a plain folder (a link or a file is in its place), so nothing was written there.`);
  if (!st) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  return dir;
}

// The end of the log, for `status`: the last `bytes` of a plain file. A link at its name is not followed (it could
// lead to any file the user can read), a pipe is not waited on, and a folder in the way is not entered: each of
// those is said, never read.
export function logTail(bytes = 64 * 1024) {
  const path = logFile();
  let dir = null;
  try {
    dir = lstatSync(unattendedDir());
  } catch {
    return { lines: [] };
  }
  if (!dir.isDirectory()) return { lines: [], problem: `${unattendedDir()} isn't a plain folder` };
  let fd;
  try {
    fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
  } catch (e) {
    return e.code === 'ENOENT' ? { lines: [] } : { lines: [], problem: `${path} isn't a plain file (a link or something else is in its place), so it wasn't read` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { lines: [], problem: `${path} isn't a plain file (a pipe or something else is in its place), so it wasn't read` };
    const n = Math.min(st.size, bytes);
    const b = Buffer.alloc(n);
    let off = 0;
    while (off < n) {
      const got = readSync(fd, b, off, n - off, st.size - n + off);
      if (!got) break;
      off += got;
    }
    const text = b.subarray(0, off).toString('utf8');
    // The first line may be cut in half when the file is longer than what was read.
    const lines = text.split('\n').filter((l) => l.trim());
    return { lines: st.size > n ? lines.slice(1) : lines };
  } finally {
    closeSync(fd);
  }
}

export const readBriefState = () => {
  try {
    const s = readJson(briefStateFile(), {});
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
};

// A path that goes into the launchd file: absolute, no line break or other control character, and text XML can
// carry. launchd starts the program itself, with these exact arguments and no shell, so "$(…)", quotes and "&"
// in a path are only characters of a folder's name; they are escaped for XML below and nothing reads them again.
export function checkedPath(p, what) {
  if (typeof p !== 'string' || !p || !isAbsolute(p)) throw new Error(`${what} isn't an absolute path, so nothing was installed.`);
  if (p.length > 1024) throw new Error(`${what} is over 1,024 characters long, so nothing was installed.`);
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufffe\uffff]/.test(p) || !p.isWellFormed())
    throw new Error(`${what} has a line break or a control character in it, so nothing was installed. Move floorboss to a folder with a plain name.`);
  return resolve(p);
}
export const xmlText = (t) => String(t).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);

// The launchd file for one of the two jobs: Node, the launcher and the job's word ("brief" or "followups"); at the
// job's hours on the machine's clock, every day; not at login or load. It holds no token, no password and no shell.
// The brief: 07:00. The follow-up drafts: every hour, day and night.
export function jobPlist({ job, node, launcher, floorbossHome = null }) {
  const j = Object.values(JOBS).find((x) => x.mode === job);
  if (!j) throw new Error(`"${String(job).slice(0, 20)}" isn't one of floorboss's jobs, so nothing was installed.`);
  const n = checkedPath(node, "Node's path");
  const l = checkedPath(launcher, "The launcher's path");
  const h = floorbossHome == null ? null : checkedPath(floorbossHome, 'FLOORBOSS_HOME');
  const s = (v) => `<string>${xmlText(v)}</string>`;
  const at = (hour) => `<dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>0</integer></dict>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${s(j.label)}`,
    '  <key>ProgramArguments</key>',
    `  <array>${s(n)}${s(l)}${s(j.mode)}</array>`,
    '  <key>StartCalendarInterval</key>',
    j.hours.length === 1 ? `  ${at(j.hours[0])}` : `  <array>${j.hours.map(at).join('')}</array>`,
    '  <key>RunAtLoad</key><false/>',
    '  <key>ProcessType</key><string>Background</string>',
    ...(h ? ['  <key>EnvironmentVariables</key>', `  <dict><key>FLOORBOSS_HOME</key>${s(h)}</dict>`] : []),
    '</dict>',
    '</plist>',
    ''
  ].join('\n');
}
export const briefPlist = (o) => jobPlist({ ...o, job: 'brief' });
export const followupsPlist = (o) => jobPlist({ ...o, job: 'followups' });

// A folder under floorboss's unattended folder, made private (0700) like it, never through a link.
export function privateSub(...names) {
  let dir = privateDir();
  for (const n of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(String(n))) throw new Error(`"${String(n).slice(0, 40)}" isn't a plain folder name.`);
    dir = join(dir, n);
    let st = null;
    try {
      st = lstatSync(dir);
    } catch {
      st = null;
    }
    if (st && !st.isDirectory()) throw new Error(`${dir} isn't a plain folder (a link or a file is in its place), so nothing was written there.`);
    if (!st) mkdirSync(dir, { mode: 0o700 });
    else if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  }
  return dir;
}
