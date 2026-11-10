// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The run and the session: which tools the hooks check, what a refusal says about the run lock, whether a
// call comes from a subagent, and whether a session's transcript shows a floorboss run it inherited.
import { existsSync, openSync, closeSync, statSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { home } from '../../lib/paths.mjs';
import { readRunAnySession, stampRun } from '../../lib/runlock.mjs';
import { writeText } from '../../lib/jsonio.mjs';
import { readJsonStrict } from './shared.mjs';
import { SCRIPT_CALL } from './shell.mjs';

// run: what readRun() returns: { active, browser, until, path }, plus session (this session ran floorboss) and
// unreadable (a lock it can't read counts as active). A subagent's comes from readRunAnySession(), with session
// and subagent set: it gets the limits of the session that ran floorboss. A plain true means active, no details.
// What the run-lock refusals say: to the user, who decides; never an instruction to Claude to lift it.
// hosts: the event sites the user let in (site_allowed), shown when a page was refused, so the user sees
// exactly which sites beyond the fixed ones the browser may open.
export function lockNote(run, hosts = null) {
  const at = run.until ? `${run.until.slice(11, 16)} UTC (${run.until})` : null;
  const when = run.subagent
    ? ` This call comes from a subagent, and a floorboss run is under way${at ? ` (until ${at} at the latest)` : ''}: floorboss holds subagents to the run's limits whichever session started it.`
    : run.session
      ? ` floorboss keeps this limit on this Claude session, which read the run's text, until the session ends: /clear or a new session lifts it, unless floorboss is running in another session too${at ? ` (it lifts by itself at ${at})` : ''}.`
      : at
        ? ` It ends when the run finishes, or at ${at} at the latest.`
        : run.unreadable
          ? ` floorboss's run lock (${run.path}) can't be read, so floorboss counts a run as under way.`
          : '';
  const sites =
    hosts == null
      ? ''
      : hosts.length
        ? ` Event sites you gave floorboss, which it may open too: ${hosts.join(', ')}.`
        : ' No event site of your own is allowed: floorboss lets one in only from the link you give when it asks where the attendee list is.';
  return `${when}${sites} If this is unexpected, it's for you, the user, to decide; Claude must not edit or delete floorboss's files to get past it.`;
}
// The tools the main PreToolUse hooks check, and the ones that only plan, ask or keep a list (the catch-all leaves
// both alone).
export const CHECKED_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'PowerShell',
  'Monitor',
  'Agent',
  'Task',
  'WebFetch',
  'WebSearch'
]);
export const QUIET_TOOLS = new Set([
  'TodoWrite',
  'TodoRead',
  'AskUserQuestion',
  'ToolSearch',
  'ExitPlanMode',
  'EnterPlanMode',
  'LS',
  'NotebookRead',
  'BashOutput',
  'KillShell',
  'KillBash',
  'TaskOutput',
  'TaskStop'
]);

// Whether a session's transcript (Claude Code's own file, under ~/.claude/projects) shows a floorboss script run:
// read up to its first and last 8 MB.
export function transcriptRanFloorboss(path) {
  try {
    const p = String(path || '');
    if (!/\.jsonl$/.test(p) || !existsSync(p)) return false;
    const size = statSync(p).size;
    const fd = openSync(p, 'r');
    try {
      const part = (start, len) => {
        const b = Buffer.alloc(len);
        readSync(fd, b, 0, len, start);
        return b.toString('utf8');
      };
      const cap = 8 * 1024 * 1024;
      const text = size <= 2 * cap ? part(0, size) : part(0, cap) + part(size - cap, cap);
      return SCRIPT_CALL.test(text);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

// A session whose transcript holds a floorboss run it didn't stamp itself: a fork (a new id, with the history
// copied in after the session starts). Read on each call, only the part written since the last read (kept in
// transcript-scan.json), so a long session costs nothing new. True when the run's limits now apply.
export function inheritedRun(session, path) {
  try {
    const p = String(path || '');
    if (!session || !/\.jsonl$/.test(p) || !existsSync(p)) return false;
    const statePath = join(home(), 'transcript-scan.json');
    const state = readJsonStrict(statePath, {}) || {};
    // Found once: the run's limits hold (the lock is stamped before this is written, so a guard reading it can rely on it).
    if (state[session]?.path === p && state[session].found) {
      stampRun({ session, transcript: p });
      return true;
    }
    const prev = state[session]?.path === p ? Number(state[session].offset) || 0 : 0;
    const size = statSync(p).size;
    if (size <= prev) return false;
    // The whole new part is read before this call is judged (in 32 MB windows that overlap a little), within a few
    // seconds: a call is never judged on half a transcript. One too big to read in time, while a run is live
    // anywhere, counts as having run floorboss (the limits hold rather than not).
    const t0 = Date.now();
    let start = Math.max(0, prev - 400);
    let found = false;
    const fd = openSync(p, 'r');
    try {
      while (start < size && !found && Date.now() - t0 < 4000) {
        const len = Math.min(size - start, 32 * 1024 * 1024);
        const b = Buffer.alloc(len);
        readSync(fd, b, 0, len, start);
        found = SCRIPT_CALL.test(b.toString('utf8'));
        start = start + len >= size ? size : start + len - 400;
      }
    } finally {
      closeSync(fd);
    }
    if (!found && start < size && readRunAnySession(Date.now()).active) found = true;
    const nowMs = Date.now();
    const kept = Object.fromEntries(Object.entries(state).filter(([, v]) => v && nowMs - Date.parse(v.at) < 14 * 864e5));
    // Stamped first, then recorded: two guards run for one call (the catch-all and the tool's own), and the one
    // that reads the record after the other wrote it must find the lock already there.
    if (found) stampRun({ session, transcript: p });
    kept[session] = { path: p, offset: start, at: new Date(nowMs).toISOString(), ...(found ? { found: true } : {}) };
    writeText(statePath, JSON.stringify(kept));
    return found;
  } catch {
    return false;
  }
}

// A hook input from inside a subagent: an agent_id that is there and not blank, of any type.
export const isSubagent = (input) => input?.agent_id != null && !!String(input.agent_id).trim();
