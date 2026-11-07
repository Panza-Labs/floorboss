// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The run lock: while a floorboss run is under way, the guard hook limits what the connectors floorboss was
// given may do (read-only tools and floorboss's own recipes only), so an instruction hidden in an attendee
// note can't send or delete through them. Every floorboss script run refreshes the lock.
//
// Text a run read (an attendee note, a web page) stays in the Claude session that read it, so the lock is
// tied to that session: the guard hook names the session (Claude Code's session_id) when it sees a floorboss
// script start, and from then on the lock holds for that session until the session ends (the SessionEnd
// hook, or /clear), with SESSION_LOCK_HOURS after its last floorboss step (or file tool call) as a backstop. `run-end` doesn't lift
// it for that session: a session can run run-end on an injected instruction. For any other session (and when
// no session is known) the lock holds RUN_LOCK_MINUTES after the last refresh, or until run-end.
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { writeText } from './jsonio.mjs';
import { join } from 'node:path';
import { home, ensureDir } from './paths.mjs';

export const RUN_LOCK_MINUTES = 30;
export const SESSION_LOCK_HOURS = 12;
const TTL_MS = RUN_LOCK_MINUTES * 60 * 1000;
const SESSION_MS = SESSION_LOCK_HOURS * 3600 * 1000;

export const lockPath = () => join(home(), 'active.json');

const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
function readLock() {
  try {
    return existsSync(lockPath()) ? JSON.parse(readFileSync(lockPath(), 'utf8')) : null;
  } catch {
    return null;
  }
}
// Sessions still inside their backstop.
function liveSessions(stamp, nowMs) {
  const s = stamp && typeof stamp.sessions === 'object' && stamp.sessions ? stamp.sessions : {};
  return Object.fromEntries(Object.entries(s).filter(([id, at]) => SESSION_RE.test(id) && nowMs - Date.parse(at) < SESSION_MS));
}

// browser: true when this run reads a list in the user's browser, so the browser server is limited too.
// session: the Claude Code session running floorboss (from the guard hook), when known.
// Sessions that ran floorboss, kept 14 days after their last run: a session resumed later (claude --resume) holds
// the same lists, CRM text and pages in its transcript, so it gets the run's limits again when it starts
// (SessionStart, guard.mjs). Keyed by session id and by transcript file, whichever the resumed session keeps.
const RAN_MS = 14 * 864e5;
const ranPath = () => join(home(), 'ran-sessions.json');
function remember(keys, nowMs) {
  let v = {};
  try {
    v = JSON.parse(readFileSync(ranPath(), 'utf8'));
  } catch {
    v = {};
  }
  const kept = Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).filter(([, at]) => nowMs - Date.parse(at) < RAN_MS));
  for (const k of keys) if (k) kept[String(k).slice(0, 400)] = new Date(nowMs).toISOString();
  writeText(ranPath(), JSON.stringify(kept));
}
export function ranBefore(keys, nowMs = Date.now()) {
  let v = {};
  try {
    v = JSON.parse(readFileSync(ranPath(), 'utf8'));
  } catch {
    return false;
  }
  return keys.some((k) => k && v?.[String(k).slice(0, 400)] && nowMs - Date.parse(v[String(k).slice(0, 400)]) < RAN_MS);
}

export function stampRun({ browser, session, transcript } = {}) {
  ensureDir(home());
  const nowMs = Date.now();
  if (session && SESSION_RE.test(String(session))) remember([session, transcript], nowMs);
  const prev = readLock();
  const live = prev && nowMs - Date.parse(prev.at) < TTL_MS;
  const sessions = liveSessions(prev, nowMs);
  if (session && SESSION_RE.test(String(session))) sessions[session] = new Date(nowMs).toISOString();
  writeText(
    lockPath(),
    JSON.stringify({
      at: new Date(nowMs).toISOString(),
      browser: !!(browser || (live && prev.browser) || (Object.keys(sessions).length && prev?.browser)),
      sessions
    })
  );
}

// A session that ran floorboss and is still at work (a file tool the guard let through): its backstop starts
// again from now. Only that session's stamp moves; the run's own time (and so other sessions' limit) doesn't.
export function touchSession(session, nowMs = Date.now()) {
  const prev = readLock();
  if (!prev || !session || !SESSION_RE.test(String(session))) return false;
  const sessions = liveSessions(prev, nowMs);
  if (!(session in sessions)) return false;
  sessions[session] = new Date(nowMs).toISOString();
  writeText(lockPath(), JSON.stringify({ ...prev, sessions }));
  return true;
}

// run-end: the run is over for every other session. A session that ran floorboss keeps the lock until it ends.
export function clearRun() {
  const prev = readLock();
  const sessions = liveSessions(prev, Date.now());
  if (Object.keys(sessions).length) {
    writeText(lockPath(), JSON.stringify({ ...prev, sessions, ended: true }));
    return {
      run_lock: 'ended',
      path: lockPath(),
      note: "The run is over. This Claude session read the run's text, so floorboss keeps its limits on it until the session ends: tell the user that /clear or a new session lifts them."
    };
  }
  if (existsSync(lockPath())) unlinkSync(lockPath());
  return { run_lock: 'cleared', path: lockPath() };
}

// SessionEnd: a session that ran floorboss is over; the lock goes when no such session is left.
export function endSession(session) {
  const prev = readLock();
  if (!prev || !session) return { ended: false };
  const sessions = liveSessions(prev, Date.now());
  if (!(session in sessions)) return { ended: false };
  delete sessions[session];
  if (!Object.keys(sessions).length) {
    try {
      unlinkSync(lockPath());
    } catch {
      /* gone already */
    }
    return { ended: true, cleared: true };
  }
  writeText(lockPath(), JSON.stringify({ ...prev, sessions }));
  return { ended: true, cleared: false };
}

// A call from inside a subagent (the hook input has agent_id): Claude Code's docs don't say whether its
// session_id is the parent session's, so any live lock counts, whichever session it is for, and the call gets
// the limits the session that ran floorboss has (session: true).
export function readRunAnySession(nowMs = Date.now()) {
  if (!existsSync(lockPath())) return { active: false };
  let stamp = null;
  try {
    stamp = JSON.parse(readFileSync(lockPath(), 'utf8'));
  } catch {
    stamp = null;
  }
  const at = Date.parse(stamp?.at);
  if (!Number.isFinite(at)) return { active: true, browser: true, until: null, path: lockPath(), unreadable: true, session: true, subagent: true };
  const live = Object.values(liveSessions(stamp, nowMs)).map((x) => Date.parse(x) + SESSION_MS);
  if (!stamp.ended && nowMs < at + TTL_MS) live.push(at + TTL_MS);
  if (!live.length) return { active: false };
  return { active: true, browser: !!stamp.browser, until: new Date(Math.max(...live)).toISOString(), path: lockPath(), session: true, subagent: true };
}

// A lock that's missing or expired is no lock; an expired one is removed. One that can't be read counts as
// a run under way (floorboss's own connectors stay held to reads) until it's deleted; it never limits
// anything else. session: the session asking (the hook input's session_id), when known.
export function readRun(nowMs = Date.now(), session = null) {
  if (!existsSync(lockPath())) return { active: false };
  let stamp = null;
  try {
    stamp = JSON.parse(readFileSync(lockPath(), 'utf8'));
  } catch {
    stamp = null;
  }
  const at = Date.parse(stamp?.at);
  if (!Number.isFinite(at)) return { active: true, browser: true, until: null, path: lockPath(), unreadable: true };
  const sessions = liveSessions(stamp, nowMs);
  const mine = session && sessions[session];
  if (mine) return { active: true, browser: !!stamp.browser, until: new Date(Date.parse(mine) + SESSION_MS).toISOString(), path: lockPath(), session: true };
  const until = new Date(at + TTL_MS);
  if (!stamp.ended && nowMs < until.getTime()) return { active: true, browser: !!stamp.browser, until: until.toISOString(), path: lockPath() };
  if (!Object.keys(sessions).length) {
    try {
      unlinkSync(lockPath());
    } catch {
      /* gone already */
    }
  }
  return { active: false };
}
