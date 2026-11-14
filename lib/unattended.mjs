// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// What runs with nobody there: one scheduled job, the morning brief (scripts/scheduled.mjs), which the user
// installs from their own terminal (scripts/unattended.mjs). This file holds what both share with the guard and
// the reminder hook: where the job's files live, its log, the off switch, and the launchd file's text.
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

export const unattendedDir = () => join(home(), 'unattended');
export const offFile = () => join(unattendedDir(), 'off');
export const logFile = () => join(unattendedDir(), 'log.jsonl');
// What the last brief run built, per event: the launcher's "one brief a day unless the records changed".
export const briefStateFile = () => join(unattendedDir(), 'brief-state.json');
export const briefInstalledFile = () => join(unattendedDir(), 'brief-installed.json');
export const todayPage = () => join(home(), 'today.html');
export const launchAgentsDir = () => join(homedir(), 'Library', 'LaunchAgents');
export const briefPlistPath = () => join(launchAgentsDir(), `${BRIEF_LABEL}.plist`);

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
// scripts/self-check.mjs holds these four functions to this exact text.
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

// The launchd file for the morning brief: Node, the launcher and the word "brief"; 07:00 on the machine's clock,
// every day; not at login or load. It holds no token, no password and no shell.
export function briefPlist({ node, launcher, floorbossHome = null }) {
  const n = checkedPath(node, "Node's path");
  const l = checkedPath(launcher, "The launcher's path");
  const h = floorbossHome == null ? null : checkedPath(floorbossHome, 'FLOORBOSS_HOME');
  const s = (v) => `<string>${xmlText(v)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${s(BRIEF_LABEL)}`,
    '  <key>ProgramArguments</key>',
    `  <array>${s(n)}${s(l)}${s('brief')}</array>`,
    '  <key>StartCalendarInterval</key>',
    `  <dict><key>Hour</key><integer>${BRIEF_HOUR}</integer><key>Minute</key><integer>0</integer></dict>`,
    '  <key>RunAtLoad</key><false/>',
    '  <key>ProcessType</key><string>Background</string>',
    ...(h ? ['  <key>EnvironmentVariables</key>', `  <dict><key>FLOORBOSS_HOME</key>${s(h)}</dict>`] : []),
    '</dict>',
    '</plist>',
    ''
  ].join('\n');
}
