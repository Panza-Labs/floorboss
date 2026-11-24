// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The one-use record of floorboss 0.1.7 (owner's decision 2026-11-22): in Claude Code, an auto-send command that
// changes state runs only if floorboss's guard examined exactly that command a moment before.
//   The guard (hooks/guard.mjs) writes a record when it recognised the call and its rules let it go on (allow or
//   ask). The record holds the hash of the command's words after the script (the verb, the event, the ids, the touch,
//   every flag), and for draft-gone the hash of the user's words the guard showed in its question.
//   Records are removed when the guard judges another recognised auto-send call in the same session, after the call
//   ran (PostToolUse, by its tool_use_id), when stale, and at session start. Not on unrelated calls: a researcher's
//   read while the user's prompt is open must not undo their Allow. A Deny then a bypass form in the same session is
//   refused by the guard's held-session rule.
//   The command (skills/autosend/scripts/cli.mjs) takes the record (removes it, so it counts once), checks it is
//   fresh and that it is for these words, and otherwise changes nothing.
// What it does not stop: a model that writes a record file itself, through a shell form the guard does not follow.
// There is no secret here (a key the model could read would add nothing). SECURITY.md, "Limits we know about".
// Codex has no guard: nothing here applies there (needsRecordHere).
import { mkdirSync, readdirSync, readFileSync, unlinkSync, lstatSync, statSync, openSync, writeSync, closeSync, constants } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { harness } from '../harness.mjs';
import { bareUrl } from './sync.mjs';

// The verbs that change auto-send state in Claude Code (lib/autosend/common.mjs CLAUDE_COMMANDS and
// ROUTINE_COMMANDS). readback, routine-status and routine-body change nothing the guard decides on (see SECURITY.md).
// revoke is not one: a stop (revoke, in any host) never needs a record, so stopping always works. That is safe
// because a stop can only make less go out: it writes autosend_revoked lines and hands out delete steps, it never
// approves, releases or sends anything (SECURITY.md).
export const RECORD_VERBS = Object.freeze(['on', 'approve', 'draft-gone', 'drafts', 'routine-checked', 'routine-saved', 'remote']);
export const needsRecord = (sub) => RECORD_VERBS.includes(String(sub ?? ''));
// How long a record counts: 3 minutes, long enough for most answers to a prompt (a later Allow gets "did not see this
// command", and running it again works), and short, since a denied record can be used from another Claude Code
// session on the same computer, by a form the guard doesn't follow, until then (SECURITY.md).
export const RECORD_FRESH_MS = 3 * 60 * 1000;
// The folder's name is the one the guard refuses in a shell command (hooks/guard/shell.mjs recordsRefusal).
export const RECORDS_NAME = 'seen-by-guard';
export const recordsDir = (home) => join(home, 'autosend', RECORDS_NAME);

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
// The command's words after the script, as one hash: the same words in the same order, nothing else.
export const wordsSha = (argv) => sha(JSON.stringify((Array.isArray(argv) ? argv : []).map(String)));
export const saidSha = (said) => sha(String(said ?? '').trim());
const flagOf = (argv, k) => {
  const i = argv.lastIndexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};

// Where the guard runs: Claude Code, as refusedHere reads it (lib/harness.mjs; a Codex mark wins). The stricter
// reading is kept only for a state change on an event in routine mode (cli.mjs routineHere).
export const guardRunsHere = (env = process.env) => harness(env) === 'claude-code';

// ---- The guard's side ----
// The records folder, checked: a real folder (never a link, never anything else), or absent. Throws with a plain
// message naming it (the guard then blocks the call, fail closed); nothing under a link is ever touched.
export class RecordsFolderError extends Error {}
export function checkedDir(home) {
  const d = recordsDir(home);
  let st;
  try {
    st = lstatSync(d);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new RecordsFolderError(`floorboss's safety check can't read its notes folder ${d} (${e.code || 'error'}). In your own terminal, check that your user can read it, then try again`);
  }
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new RecordsFolderError(`floorboss's safety check found ${d} is ${st.isSymbolicLink() ? 'a link' : 'not a folder'}, so it won't use it. In your own terminal, remove it (rm "${d}"), then try again: floorboss makes a new one`);
  return d;
}
const RECORD_FILE = /^[0-9a-f]{64}\.json$/;
// The regular record files directly in the folder (no link, no folder, nothing else), with what each holds.
function records(home) {
  const d = checkedDir(home);
  if (!d) return [];
  let names;
  try {
    names = readdirSync(d);
  } catch (e) {
    throw new RecordsFolderError(`floorboss's safety check can't read its notes folder ${d} (${e.code || 'error'}). In your own terminal, run chmod 700 "${d}" (or remove it: floorboss makes a new one), then try again`);
  }
  const out = [];
  for (const f of names) {
    if (!RECORD_FILE.test(f)) continue;
    const p = join(d, f);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    // A link planted at a record's name: the link itself goes (never its target), so the next write can make the file.
    if (st.isSymbolicLink()) {
      try {
        unlinkSync(p);
      } catch {
        /* the write below says what to do */
      }
      continue;
    }
    if (!st.isFile()) continue;
    let rec = null;
    try {
      rec = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      rec = null;
    }
    out.push({ p, rec });
  }
  return out;
}
// Records removed: every one whose session is this one (session: a string), and every one past its freshness (or
// unreadable). Only regular *.json files directly in the folder, never recursively, never through a link.
export function clearRecords(home, { session = null, nowMs = Date.now() } = {}) {
  let n = 0;
  for (const { p, rec } of records(home)) {
    const age = nowMs - Date.parse(String(rec?.at ?? ''));
    const stale = !(age >= -5000 && age <= RECORD_FRESH_MS);
    if (stale || (session != null && rec?.session === session)) {
      unlinkSync(p);
      n++;
    }
  }
  return n;
}
// The record for one command the guard let go on. argv: the words after the script; said: draft-gone's words shown.
export function writeRecord(home, argv, { said = null, session = null, toolUseId = null } = {}, nowMs = Date.now()) {
  const words = (Array.isArray(argv) ? argv : []).map(String);
  mkdirSync(join(home, 'autosend'), { recursive: true, mode: 0o700 });
  const d = checkedDir(home) || (mkdirSync(recordsDir(home), { mode: 0o700 }), checkedDir(home));
  const w = wordsSha(words);
  const rec = {
    v: 1,
    sub: words[0] ?? null,
    event: flagOf(words, '--event') ?? null,
    words_sha: w,
    said_sha: said == null ? null : saidSha(said),
    // remote --confirm: the address the user was asked about, with no token (lib/autosend/sync.mjs bareUrl).
    url: words[0] === 'remote' && flagOf(words, '--confirm') != null ? bareUrl(flagOf(words, '--confirm')) : null,
    tool_use_id: typeof toolUseId === 'string' ? toolUseId.slice(0, 200) : null,
    at: new Date(nowMs).toISOString(),
    session: typeof session === 'string' ? session.slice(0, 100) : null
  };
  // A link planted at the name is never followed (O_NOFOLLOW): the write fails, and the guard blocks the call.
  const f = join(d, `${w}.json`);
  try {
    const st = lstatSync(f);
    if (st.isFile() || st.isSymbolicLink()) unlinkSync(f);
  } catch {
    /* none there */
  }
  let fd;
  try {
    fd = openSync(f, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  } catch (e) {
    throw new RecordsFolderError(`floorboss's safety check can't write its note ${f} (${e.code || 'error'}): something else is at that name. In your own terminal, remove it (rm "${f}"), then try again`);
  }
  try {
    writeSync(fd, JSON.stringify(rec));
  } finally {
    closeSync(fd);
  }
  return rec;
}

// ---- The command's side ----
export const NOT_SEEN = "floorboss's safety check did not see this command, so nothing was changed. Run it in the usual form: node and the path to floorboss's cli.mjs, then the command, on its own";
export const WORDS_CHANGED = 'the words in the file are not the ones floorboss showed you, so nothing was changed. Run the command again, and answer its question';
// Takes the record for these words (removes it first: it counts once). null when it stands, else what to say.
export function takeRecord(home, argv, { said = null } = {}, nowMs = Date.now()) {
  const words = (Array.isArray(argv) ? argv : []).map(String);
  const w = wordsSha(words);
  try {
    if (!checkedDir(home)) return NOT_SEEN;
  } catch (e) {
    return e.message;
  }
  const f = join(recordsDir(home), `${w}.json`);
  let st;
  try {
    st = lstatSync(f);
  } catch {
    return NOT_SEEN;
  }
  if (!st.isFile() || st.size > 4096) return NOT_SEEN;
  let rec;
  try {
    rec = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return NOT_SEEN;
  }
  try {
    unlinkSync(f);
  } catch {
    // Taken by another run of the same command a moment ago: once only.
    return NOT_SEEN;
  }
  const age = nowMs - Date.parse(String(rec?.at ?? ''));
  if (!(age >= -5000 && age <= RECORD_FRESH_MS)) return NOT_SEEN;
  if (rec.v !== 1 || rec.words_sha !== w || rec.sub !== (words[0] ?? null) || rec.event !== (flagOf(words, '--event') ?? null)) return NOT_SEEN;
  if (words[0] === 'remote' && (rec.url == null || rec.url !== bareUrl(flagOf(words, '--confirm') ?? ''))) return NOT_SEEN;
  if (words[0] === 'draft-gone' && (rec.said_sha ?? null) !== (said == null ? null : saidSha(said))) return WORDS_CHANGED;
  return null;
}

// ---- Protecting the folder (the guard's file rules) ----
const idOf = (p) => {
  try {
    const s = statSync(p);
    return `${s.dev}:${s.ino}`;
  } catch {
    return null;
  }
};
// A path that lands in the records folder: the folder, or anything under it, by what each folder on the way is on
// disk (device and inode), so another spelling, a firmlink or a symlinked parent counts too. While the folder isn't
// there, by its text.
export function inRecords(path, home) {
  const d = recordsDir(home);
  const want = idOf(d);
  const p = resolve(String(path));
  if (want) {
    for (let x = p; ; x = dirname(x)) {
      if (idOf(x) === want) return true;
      if (x === dirname(x)) break;
    }
    return false;
  }
  // By text, both sides with the system's separator (backslashes on Windows) and in one case.
  const norm = (x) => resolve(x).split(/[\\/]+/).join(sep).toLowerCase();
  const t = norm(p);
  const r = norm(d);
  return t === r || t.startsWith(r + sep);
}

// After the call ran (PostToolUse): its record, if still there, removed.
export function dropRecordOf(home, toolUseId) {
  if (!toolUseId) return 0;
  let n = 0;
  for (const { p, rec } of records(home)) {
    if (rec?.tool_use_id === toolUseId) {
      unlinkSync(p);
      n++;
    }
  }
  return n;
}

// ---- An event sent through a daily Claude routine now ----
// Such an event exists only in Claude Code (Codex never makes one), so its commands need the record whatever the
// environment says (a command can remove CLAUDECODE through a shell form the guard doesn't follow). An event that left
// the routine (autosend_routine_until) follows the host's own rules again, as at 998b29f.
export const routineEvent = (ev) => !!ev && ev.autosend_mode === 'routine';

// ---- A shell call (Bash, PowerShell, Monitor), before the guard decides anything ----
// Main thread: that session's own records and the stale ones are cleared (every bypass form is a shell call, so a
// Deny then one finds no record). A subagent's call carries the parent's session_id: it clears nothing, and while a
// fresh record of that session waits (the user's prompt is open) it is refused, so neither a researcher's `ls` nor a
// subagent's bypass form can touch it. floorboss: the call is one of floorboss's own scripts; for any other shell
// call a folder that can't be read is skipped (the next floorboss command fails closed with what to do).
// { refuse } or null. Throws RecordsFolderError for a floorboss call when the folder is broken.
export const WAITING = "floorboss is waiting for the user's answer to a prompt; try again in a moment";
export function shellCallRecords({ home, session, subagent, floorboss, nowMs = Date.now() }) {
  try {
    if (subagent) {
      // A subagent's call to floorboss's own script in its plain form is judged by the guard's own rules (a state
      // change refused to a subagent; a record of its own for the rest), so it doesn't wait.
      if (floorboss) return null;
      const waiting = session != null && records(home).some(({ rec }) => {
        const age = nowMs - Date.parse(String(rec?.at ?? ''));
        return rec?.session === session && age >= -5000 && age <= RECORD_FRESH_MS;
      });
      return waiting ? { refuse: WAITING } : null;
    }
    clearRecords(home, { session, nowMs });
    return null;
  } catch (e) {
    if (floorboss || !(e instanceof RecordsFolderError)) throw e;
    return null;
  }
}
