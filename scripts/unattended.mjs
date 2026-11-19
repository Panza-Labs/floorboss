#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
//
// Installing and removing the two jobs floorboss can run with nobody there: the morning brief, and the follow-up
// drafts. Run it yourself, from your own terminal:
//
//   node scripts/unattended.mjs install-brief          install the 07:00 brief (asks first; --yes skips the question,
//                                                      but it still has to be run in a terminal)
//   node scripts/unattended.mjs uninstall-brief        unload it and remove its file
//   node scripts/unattended.mjs install-followups      install the follow-up drafts, run every hour (asks you to
//                                                      type a code it prints; no flag skips that)
//   node scripts/unattended.mjs uninstall-followups    unload it and remove its file
//   node scripts/unattended.mjs status                 what is installed, and the last runs
//   node scripts/unattended.mjs off                    stop every unattended run until "on" (nothing is removed)
//   node scripts/unattended.mjs on                     let them run again
//
// macOS only. This is the one floorboss file that starts launchctl, and only to install or remove a job.
// Installing, removing and on run only in a real terminal (the keyboard and the screen both), never from a pipe, a
// script or a Claude Code session; floorboss's guard refuses them from a session by name as well. off and status
// run anywhere.
// First import: floorboss's own process, which reads settings as Claude Code does (lib/harness.mjs).
import '../lib/own-process.mjs';
import { existsSync, lstatSync, mkdirSync, writeFileSync, renameSync, unlinkSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, isAbsolute, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { home } from '../lib/paths.mjs';
import { writeJson, readJson } from '../lib/jsonio.mjs';
import {
  JOBS,
  jobPlist,
  plistPathFor,
  installedFileFor,
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
import { liveOptins, authorisedLines, shortDay, DISCLAIMER } from '../lib/unattended-drafts.mjs';
import { nowMs } from '../lib/clock.mjs';

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

function asked(question, ok) {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answer = null;
    rl.question(question, (a) => {
      answer = a;
      rl.close();
    });
    // Closed with no answer (Ctrl-D, the terminal went away): that is a no.
    rl.on('close', () => done(ok(String(answer ?? '').trim())));
  });
}
const typedYes = () => asked('Install it? Type yes: ', (a) => a.toLowerCase() === 'yes');
// Six letters, no look-alikes. Under floorboss's own tests a test may name them.
const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const newCode = () => (process.env.FLOORBOSS_TEST === '1' && /^[A-Z]{6}$/.test(String(process.env.FLOORBOSS_CODE || '')) ? process.env.FLOORBOSS_CODE : Array.from({ length: 6 }, () => LETTERS[randomInt(LETTERS.length)]).join(''));

// Claude Code as the user's own shell finds it: the first "claude" on their PATH that is a program, by that path.
function claudeOnPath(pathVar = process.env.PATH || '') {
  for (const dir of String(pathVar).split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, 'claude');
    try {
      const st = statSync(p);
      if (st.isFile() && st.mode & 0o111) return { path: p, real: realpathSync(p) };
    } catch {
      /* not in this folder */
    }
  }
  return null;
}

const hh = (n) => `${String(n).padStart(2, '0')}:00`;
// What each job says before it is installed, and after.
const TEXT = {
  brief: {
    installing: 'installing the scheduled brief',
    removing: 'removing the scheduled brief',
    warning: ({ plist }) => [
      'floorboss: the morning brief, on its own.',
      '',
      'Once installed, this happens with nobody starting it:',
      `- Every day at ${hh(JOBS.brief.hours[0])} on this Mac's clock, macOS starts a small floorboss script. If the Mac is asleep then, it runs when the Mac wakes.`,
      '- On a day with a booked meeting, it builds a brief from what floorboss already recorded and opens the page in your browser, in front of whatever is on screen.',
      '- On other days it does nothing, unless unattended drafts are on and someone you wrote to on LinkedIn or in the event app has a follow-up draft going in that day: then it opens a short page naming them.',
      '- Nothing is sent. Nothing leaves this machine. No Claude session starts and no network is used.',
      '',
      `It adds one file: ${plist}`,
      `To stop it for a while: ${cmdLine('off')}`,
      `To remove it: ${cmdLine('uninstall-brief')}`,
      ''
    ],
    notInstalled: `Nothing was installed. To install, type yes at the question, or run it in your terminal as: ${cmdLine('install-brief --yes')}`,
    schedule: `every day at ${hh(JOBS.brief.hours[0])}`,
    runs: 'brief'
  },
  followups: {
    installing: 'installing the scheduled follow-up drafts',
    removing: 'removing the scheduled follow-up drafts',
    warning: ({ plist, events, claude }) => [
      'floorboss: your follow-up drafts, on their own. Read this first.',
      '',
      'Once installed, this happens with nobody there:',
      `- Every hour, day and night, on this Mac's clock, macOS starts a small floorboss script. When a follow-up you authorised is due, it starts Claude Code (${claude}) on its own, with no prompts.`,
      '- For each one, floorboss reads your mailbox (and your CRM\'s logged activity, through its activity reader: a CRM connected with no activity reader, only a lookup, holds every draft until you connect one in /floorboss:event-setup) for anything from that person since your last message. If anything came in, or the read fails, that draft waits for you.',
      '- Otherwise it puts the exact text you approved into your mailbox\'s drafts folder, in your thread with them. Only on its day or the day after, on weekdays (Monday to Friday) from 09:00 to 17:00 in the event\'s time zone, and never after the event.',
      '- Nothing is sent. Each draft waits for you to read it and press Send.',
      '',
      'What can still go wrong:',
      "- A reply your mailbox or CRM doesn't show (another address, a call, a chat) won't stop the draft.",
      `- ${DISCLAIMER}`,
      '- If plans changed after you approved a message, the draft still says what you approved.',
      '- Claude Code runs with your login and your connectors while you are away. It can only read your mailbox and CRM and add drafts through floorboss\'s guard.',
      '- Each run is a Claude Code session on your account: it counts toward your plan\'s usage and limits, the same ones your own sessions use (a run can start every hour something is due, and lasts at most 40 minutes).',
      '- A follow-up after one that went into your drafts waits until floorboss sees that draft was sent: once you send it from your mail app, run floorboss (it reads your mailbox for it).',
      '',
      `Turned on for: ${events.map((e) => `${e.name} (until ${e.end ? `${shortDay(e.end)} ${e.end.slice(0, 4)}` : 'its last day'})`).join(', ')}`,
      `It adds one file: ${plist}`,
      `To stop it: /floorboss:unattended off in Claude Code, or ${cmdLine('off')}`,
      `To remove it: ${cmdLine('uninstall-followups')}`,
      ''
    ],
    notInstalled: `Nothing was installed. To install, run it again in your terminal and type the code it shows: ${cmdLine('install-followups')}`,
    schedule: 'every hour, day and night',
    runs: 'followups'
  }
};

async function installJob(job, args) {
  const t = TEXT[job.mode];
  if (PLATFORM !== 'darwin') {
    say(`floorboss: ${OTHER_SYSTEMS}\nNothing was installed.`);
    process.exitCode = 1;
    return;
  }
  if (notYours(t.installing)) return;
  // Only paths go into the file, each checked (lib/unattended.mjs): the Node that runs this, the launcher beside
  // this script, and floorboss's data folder (FLOORBOSS_HOME, or ~/.floorboss), always: what the job reads is fixed
  // by this install, never by a variable set later for every job (launchctl setenv).
  const node = checkedPath(stableNodePath(), "Node's path");
  const launcher = checkedPath(LAUNCHER, "The launcher's path");
  if (!statSync(launcher).isFile()) throw new Error(`${launcher} isn't there, so nothing was installed.`);
  // As set, never worked out from the folder this happens to run in: a relative FLOORBOSS_HOME is refused.
  const floorbossHome = checkedPath(process.env.FLOORBOSS_HOME || home(), 'FLOORBOSS_HOME');
  // The follow-up drafts: turned on for an event in Claude Code first (/floorboss:unattended on), and Claude Code on
  // this user's PATH, whose path the launcher will start.
  const extra = {};
  if (job.mode === 'followups') {
    const live = liveOptins(nowMs());
    const events = live.map((x) => ({ name: oneLine(x.optin?.name || x.slug, 80), end: oneLine(x.optin?.end_date || '', 10) }));
    if (!events.length) {
      say(`floorboss: unattended drafts aren't turned on for any event yet. In Claude Code, run /floorboss:unattended on first (it asks you to type a sentence, then Claude Code asks you to allow it). Nothing was installed.`);
      process.exitCode = 1;
      return;
    }
    const found = claudeOnPath();
    if (!found) {
      say('floorboss: Claude Code (claude) isn\'t on your PATH, so the job would have nothing to start. Nothing was installed.');
      process.exitCode = 1;
      return;
    }
    const path = String(process.env.PATH || '').slice(0, 4096);
    if (/[\u0000-\u001f\u007f]/.test(path)) throw new Error('PATH has a control character in it, so nothing was installed.');
    Object.assign(extra, { events, claude: checkedPath(found.path, "Claude Code's path"), path });
  }
  const text = jobPlist({ job: job.mode, node, launcher, floorbossHome });
  const plist = plistPathFor(job);
  say(t.warning({ plist, ...extra }).join('\n'));
  let yes;
  if (job.mode === 'brief') yes = args.includes('--yes') || (await typedYes());
  else {
    const code = newCode();
    yes = await asked(`To install it, type this code: ${code}\nCode: `, (a) => a.toUpperCase() === code);
  }
  if (!yes) {
    say(t.notInstalled);
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
  if (st) launchctl(['bootout', `${domain()}/${job.label}`]);
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
      unlinkSync(installedFileFor(job));
    } catch {
      /* there was none */
    }
    throw new Error(`launchctl couldn't load the job (${String(r.error?.message || r.stderr || `exit ${r.status}`).trim().slice(0, 300)}). The file was removed again; nothing is installed.`);
  }
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  writeJson(installedFileFor(job), {
    label: job.label,
    plist,
    node,
    launcher,
    floorboss_home: floorbossHome,
    version,
    at: new Date().toISOString(),
    ...(job.mode === 'followups' ? { claude: extra.claude, path: extra.path } : {})
  });
  logLine(`${job.mode}_installed`, { plist });
  say(
    [
      'Installed.',
      `- File: ${plist}`,
      `- Job: ${job.label}, ${t.schedule}, loaded for your login (${domain()})`,
      `- Runs: ${node} ${launcher} ${t.runs}`,
      ...(job.mode === 'followups' ? [`- Starts: ${extra.claude}, only when a follow-up you authorised is due`] : []),
      `- With FLOORBOSS_HOME=${floorbossHome}`,
      job.mode === 'brief' ? `- The page it opens: ${todayPage()}` : `- What it did, each day: ${join(home(), 'unattended')}/summary-<day>.md`,
      `- Its log: ${logFile()}`,
      '',
      `To stop it for a while: ${cmdLine('off')}`,
      `To remove it: ${cmdLine(`uninstall-${job.mode}`)}`,
      `If floorboss or Node.js moves or is updated to a new folder, run install-${job.mode} again: the job points at ${job.mode === 'brief' ? 'these two paths' : 'these paths'}.`,
      isOff() ? `\nUnattended runs are switched off right now (${offFile()}). Run "${cmdLine('on')}" to let the job work.` : ''
    ].join('\n')
  );
}

function uninstallJob(job) {
  const t = TEXT[job.mode];
  if (PLATFORM !== 'darwin') {
    say(`floorboss: ${OTHER_SYSTEMS}\nNothing is installed here, so there is nothing to remove.`);
    return;
  }
  if (notYours(t.removing)) return;
  const plist = plistPathFor(job);
  let there = false;
  try {
    lstatSync(plist);
    there = true;
  } catch {
    there = false;
  }
  const r = launchctl(['bootout', `${domain()}/${job.label}`]);
  if (there) unlinkSync(plist);
  try {
    unlinkSync(installedFileFor(job));
  } catch {
    /* not there */
  }
  if (existsSync(home())) logLine(`${job.mode}_uninstalled`, { plist });
  say(
    [
      there ? `Removed ${plist}.` : `${plist} wasn't there.`,
      r.status === 0 ? `Unloaded the job ${job.label}.` : `The job ${job.label} wasn't loaded.`,
      job.mode === 'brief' ? "Nothing runs on its own now. Your briefs and floorboss's records are untouched." : "No follow-up goes into your drafts on its own now. Your drafts and floorboss's records are untouched."
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
  const any = existsSync(plistPathFor(JOBS.brief)) || existsSync(plistPathFor(JOBS.followups));
  say(`Unattended runs are on. ${any ? 'What is installed runs at its next time.' : `Nothing is installed yet: ${cmdLine('install-brief')}`}`);
}

function status() {
  const info = (job) => {
    try {
      return readJson(installedFileFor(job), null);
    } catch {
      return null;
    }
  };
  const lines = [PLATFORM === 'darwin' ? null : OTHER_SYSTEMS];
  for (const job of [JOBS.brief, JOBS.followups]) {
    const plist = plistPathFor(job);
    const installed = existsSync(plist);
    const i = info(job);
    const what = job.mode === 'brief' ? 'Morning brief' : 'Follow-up drafts';
    lines.push(installed ? `${what}: installed (${plist}), ${TEXT[job.mode].schedule} on this machine's clock.` : `${what}: not installed.`);
    if (installed && i?.launcher && !existsSync(String(i.launcher))) lines.push(`Its launcher is gone (${oneLine(i.launcher, 300)}): floorboss moved or was updated. Run install-${job.mode} again from your terminal.`);
    if (installed && i?.node && !existsSync(String(i.node))) lines.push(`The Node.js it runs is gone (${oneLine(i.node, 300)}): Node.js moved or was updated. Run install-${job.mode} again from your terminal.`);
    if (installed && job.mode === 'followups' && i?.claude && !existsSync(String(i.claude))) lines.push(`The Claude Code it starts is gone (${oneLine(i.claude, 300)}). Run install-followups again from your terminal.`);
  }
  const optins = liveOptins(nowMs());
  if (optins.length) {
    const auth = authorisedLines();
    // The latest authorisation of each step only (an older one for another text authorises nothing now).
    const steps = (slug) => new Set(auth.filter((a) => a.event === slug).map((a) => `${a.id}:${a.touch}`)).size;
    lines.push(`Unattended drafts turned on for: ${optins.map((x) => `${oneLine(x.optin?.name || x.slug, 80)} until ${oneLine(x.optin?.end_date || '', 10)} (${steps(x.slug)} follow-up${steps(x.slug) === 1 ? '' : 's'} authorised)`).join('; ')}.`);
  }
  lines.push(isOff() ? `Switched off (${offFile()}): nothing runs until you run "on" from your own terminal.` : 'Not switched off.', `Data folder: ${home()}`);
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
  say(lines.filter(Boolean).join('\n'));
}

const [sub, ...args] = process.argv.slice(2);
const cmds = {
  'install-brief': (a) => installJob(JOBS.brief, a),
  'uninstall-brief': () => uninstallJob(JOBS.brief),
  'install-followups': (a) => installJob(JOBS.followups, a),
  'uninstall-followups': () => uninstallJob(JOBS.followups),
  status,
  off,
  on
};
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
