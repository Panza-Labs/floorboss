#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
//
// Installing and removing the one job floorboss can run with nobody there: the morning brief.
// Run it yourself, from your own terminal:
//
//   node scripts/unattended.mjs install-brief     install the 07:00 job (asks first; --yes skips the question,
//                                                 but it still has to be run in a terminal)
//   node scripts/unattended.mjs uninstall-brief   unload it and remove its file
//   node scripts/unattended.mjs status            what is installed, and the last runs
//   node scripts/unattended.mjs off               stop every unattended run until "on" (nothing is removed)
//   node scripts/unattended.mjs on                let them run again
//
// macOS only. This is the one floorboss file that starts launchctl, and only for install-brief and
// uninstall-brief. install-brief, uninstall-brief and on run only in a real terminal (the keyboard and the screen
// both), never from a pipe, a script or a Claude Code session; floorboss's guard refuses them from a session by
// name as well. off and status run anywhere.
import { existsSync, lstatSync, mkdirSync, writeFileSync, renameSync, unlinkSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { home } from '../lib/paths.mjs';
import { writeJson, readJson } from '../lib/jsonio.mjs';
import {
  BRIEF_LABEL,
  BRIEF_HOUR,
  briefPlist,
  briefPlistPath,
  briefInstalledFile,
  launchAgentsDir,
  offFile,
  isOff,
  logFile,
  logLine,
  todayPage,
  privateDir,
  logTail,
  checkedPath,
  launchctlFor,
  platformFor,
  terminalPresent,
  stableNodePath,
  oneLine
} from '../lib/unattended.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF = join(ROOT, 'scripts', 'unattended.mjs');
const LAUNCHER = join(ROOT, 'scripts', 'scheduled.mjs');
// Under floorboss's own tests the platform can be named and launchctl is a stand-in the test names; the real
// launchctl is never started there. Anywhere else those variables are ignored (lib/unattended.mjs).
const PLATFORM = platformFor();
const LAUNCHCTL = launchctlFor();
const say = (t = '') => process.stdout.write(`${t}\n`);
const quoted = (p) => `"${p}"`;
const cmdLine = (sub) => `node ${quoted(SELF)} ${sub}`;

export const OTHER_SYSTEMS =
  'Running on its own is macOS only for now. Linux (systemd timers) and Windows (Task Scheduler) are planned; everything else in floorboss works on all three.';

function launchctl(args) {
  if (!LAUNCHCTL) throw new Error('no stand-in launchctl was named for this test (FLOORBOSS_LAUNCHCTL), and the real one is never started under test');
  return spawnSync(LAUNCHCTL, args, { encoding: 'utf8' });
}
const domain = () => `gui/${process.getuid()}`;

// Installing, removing and switching back on are the user's own acts, at their own keyboard. Two checks, both
// before anything is read or written:
// - a real terminal on both ends (--yes skips the question, never this): a command run from a pipe, a script, a
//   scheduler or Claude Code's shell has none;
// - not a shell Claude Code started, which says so in its environment (the variable set at all, even to nothing).
// Neither is a lock against someone who can run any program as you (a terminal can be faked); the guard's rules on
// what a session may run are the other half, and SECURITY.md says what is left.
// (scripts/self-check.mjs holds this function to this exact text.)
function notYours(what) {
  const claude = 'CLAUDECODE' in process.env;
  if (!claude && terminalPresent()) return false;
  refused(what, claude);
  return true;
}
function refused(what, claude) {
  say(
    `floorboss: ${what} is done by you, in your own terminal window${claude ? ', not from a Claude Code session' : ', not from a script or a pipe (this command has no terminal)'}. Open a terminal and run:\n\n  ${cmdLine(process.argv[2])}\n\nNothing was changed.`
  );
  process.exitCode = 1;
}

function typedYes() {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answer = null;
    rl.question('Install it? Type yes: ', (a) => {
      answer = a;
      rl.close();
    });
    // Closed with no answer (Ctrl-D, the terminal went away): that is a no.
    rl.on('close', () => done(String(answer ?? '').trim().toLowerCase() === 'yes'));
  });
}

async function installBrief(args) {
  if (PLATFORM !== 'darwin') {
    say(`floorboss: ${OTHER_SYSTEMS}\nNothing was installed.`);
    process.exitCode = 1;
    return;
  }
  if (notYours('installing the scheduled brief')) return;
  // Only paths go into the file, each checked (lib/unattended.mjs): the Node that runs this, the launcher beside
  // this script, and FLOORBOSS_HOME when it is set.
  const node = checkedPath(stableNodePath(), "Node's path");
  const launcher = checkedPath(LAUNCHER, "The launcher's path");
  if (!statSync(launcher).isFile()) throw new Error(`${launcher} isn't there, so nothing was installed.`);
  // As set, never worked out from the folder this happens to run in: a relative FLOORBOSS_HOME is refused.
  const floorbossHome = process.env.FLOORBOSS_HOME ? checkedPath(process.env.FLOORBOSS_HOME, 'FLOORBOSS_HOME') : null;
  const text = briefPlist({ node, launcher, floorbossHome });
  const plist = briefPlistPath();
  const hh = String(BRIEF_HOUR).padStart(2, '0');
  say(
    [
      'floorboss: the morning brief, on its own.',
      '',
      'Once installed, this happens with nobody starting it:',
      `- Every day at ${hh}:00 on this Mac's clock, macOS starts a small floorboss script. If the Mac is asleep then, it runs when the Mac wakes.`,
      '- On a day with a booked meeting, it builds a brief from what floorboss already recorded and opens the page in your browser, in front of whatever is on screen.',
      '- On other days it does nothing.',
      '- Nothing is sent. Nothing leaves this machine. No Claude session starts and no network is used.',
      '',
      `It adds one file: ${plist}`,
      `To stop it for a while: ${cmdLine('off')}`,
      `To remove it: ${cmdLine('uninstall-brief')}`,
      ''
    ].join('\n')
  );
  const yes = args.includes('--yes') || (await typedYes());
  if (!yes) {
    say(`Nothing was installed. To install, type yes at the question, or run it in your terminal as: ${cmdLine('install-brief --yes')}`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(launchAgentsDir(), { recursive: true });
  // Never through a link at the file's own name.
  let st = null;
  try {
    st = lstatSync(plist);
  } catch {
    st = null;
  }
  if (st && !st.isFile()) throw new Error(`${plist} is there already and isn't a plain file, so nothing was installed. Remove it and run this again.`);
  // Installed before: unloaded first, so the new file is the one loaded. (Not loaded is fine.)
  if (st) launchctl(['bootout', `${domain()}/${BRIEF_LABEL}`]);
  const tmp = `${plist}.tmp-${process.pid}`;
  try {
    unlinkSync(tmp);
  } catch {
    /* none left over */
  }
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, plist);
  const r = launchctl(['bootstrap', domain(), plist]);
  if (r.error || r.status !== 0) {
    unlinkSync(plist);
    // Nothing is installed now, whatever was before: the note of an earlier install goes too.
    try {
      unlinkSync(briefInstalledFile());
    } catch {
      /* there was none */
    }
    throw new Error(`launchctl couldn't load the job (${String(r.error?.message || r.stderr || `exit ${r.status}`).trim().slice(0, 300)}). The file was removed again; nothing is installed.`);
  }
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  writeJson(briefInstalledFile(), { label: BRIEF_LABEL, plist, node, launcher, floorboss_home: floorbossHome, version, at: new Date().toISOString() });
  logLine('brief_installed', { plist });
  say(
    [
      'Installed.',
      `- File: ${plist}`,
      `- Job: ${BRIEF_LABEL}, every day at ${hh}:00, loaded for your login (${domain()})`,
      `- Runs: ${node} ${launcher} brief`,
      ...(floorbossHome ? [`- With FLOORBOSS_HOME=${floorbossHome}`] : []),
      `- The page it opens: ${todayPage()}`,
      `- Its log: ${logFile()}`,
      '',
      `To stop it for a while: ${cmdLine('off')}`,
      `To remove it: ${cmdLine('uninstall-brief')}`,
      'If floorboss or Node.js moves or is updated to a new folder, run install-brief again: the job points at these two paths.',
      isOff() ? `\nUnattended runs are switched off right now (${offFile()}). Run "${cmdLine('on')}" to let the job work.` : ''
    ].join('\n')
  );
}

function uninstallBrief() {
  if (PLATFORM !== 'darwin') {
    say(`floorboss: ${OTHER_SYSTEMS}\nNothing is installed here, so there is nothing to remove.`);
    return;
  }
  if (notYours('removing the scheduled brief')) return;
  const plist = briefPlistPath();
  let there = false;
  try {
    lstatSync(plist);
    there = true;
  } catch {
    there = false;
  }
  const r = launchctl(['bootout', `${domain()}/${BRIEF_LABEL}`]);
  if (there) unlinkSync(plist);
  try {
    unlinkSync(briefInstalledFile());
  } catch {
    /* not there */
  }
  if (existsSync(home())) logLine('brief_uninstalled', { plist });
  say(
    [
      there ? `Removed ${plist}.` : `${plist} wasn't there.`,
      r.status === 0 ? `Unloaded the job ${BRIEF_LABEL}.` : `The job ${BRIEF_LABEL} wasn't loaded.`,
      'Nothing runs on its own now. Your briefs and floorboss\'s records are untouched.'
    ].join('\n')
  );
}

function off() {
  if (!isOff()) {
    privateDir();
    writeFileSync(offFile(), `off since ${new Date().toISOString()}\n`, { mode: 0o600, flag: 'wx' });
    // Off is off whether or not it could be written down in the log.
    try {
      logLine('unattended_off');
    } catch (e) {
      say(`(It couldn't be noted in the log: ${oneLine(e.message, 200)})`);
    }
  }
  say(`Unattended runs are off: nothing floorboss scheduled does anything until you turn it on again.\nTo turn it on again, from your own terminal: ${cmdLine('on')}`);
}

function on() {
  if (notYours('turning unattended runs back on')) return;
  if (isOff()) {
    unlinkSync(offFile());
    logLine('unattended_on');
  }
  say(`Unattended runs are on. ${existsSync(briefPlistPath()) ? 'The morning brief runs at its next time.' : `Nothing is installed yet: ${cmdLine('install-brief')}`}`);
}

function status() {
  const plist = briefPlistPath();
  const installed = existsSync(plist);
  const info = (() => {
    try {
      return readJson(briefInstalledFile(), null);
    } catch {
      return null;
    }
  })();
  const lines = [
    PLATFORM === 'darwin' ? null : OTHER_SYSTEMS,
    installed ? `Morning brief: installed (${plist}), every day at ${String(BRIEF_HOUR).padStart(2, '0')}:00 on this machine's clock.` : 'Morning brief: not installed.',
    installed && info?.launcher && !existsSync(String(info.launcher)) ? `Its launcher is gone (${oneLine(info.launcher, 300)}): floorboss moved or was updated. Run install-brief again from your terminal.` : null,
    installed && info?.node && !existsSync(String(info.node)) ? `The Node.js it runs is gone (${oneLine(info.node, 300)}): Node.js moved or was updated. Run install-brief again from your terminal.` : null,
    isOff() ? `Switched off (${offFile()}): nothing runs until you run "on" from your own terminal.` : 'Not switched off.',
    `Data folder: ${home()}`
  ].filter(Boolean);
  const tail = logTail();
  const last = tail.lines.slice(-5);
  if (tail.problem) lines.push(`The log can't be shown: ${oneLine(tail.problem, 300)}.`);
  else lines.push(last.length ? 'Last runs:' : 'No runs logged yet.');
  for (const l of last) {
    try {
      const e = JSON.parse(l);
      const { at, type, ...rest } = e;
      // What was logged may quote an error or a file's text: shown as one clean, short line.
      lines.push(`  ${oneLine(at, 16).replace('T', ' ')}Z  ${oneLine(type, 40)}  ${oneLine(JSON.stringify(rest, (k, v) => (typeof v === 'string' ? oneLine(v, 200) : v)), 200)}`);
    } catch {
      /* a damaged line is skipped */
    }
  }
  say(lines.join('\n'));
}

const [sub, ...args] = process.argv.slice(2);
const cmds = { 'install-brief': installBrief, 'uninstall-brief': uninstallBrief, status, off, on };
if (!cmds[sub] || args.some((a) => a !== '--yes') || (args.length && sub !== 'install-brief')) {
  process.stderr.write(`floorboss: use one of: ${Object.keys(cmds).join(', ')} (install-brief takes --yes)\n`);
  process.exit(2);
}
try {
  await cmds[sub](args);
} catch (e) {
  process.stderr.write(`floorboss: ${e.message}\n`);
  process.exit(1);
}
