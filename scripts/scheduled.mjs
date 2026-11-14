#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
//
// The launcher for what runs with nobody there. One mode: `brief`, started by launchd at 07:00 on the machine's
// clock (scripts/unattended.mjs install-brief), or when the machine next wakes.
//
// For each event that has a booked meeting on the day in question, it builds the brief from floorboss's records
// (agenda-facts), writes today.html, and opens it with the system's opener. It starts no Claude session, uses no
// network and sends nothing. It reads floorboss's data folder and this plugin's own files. With nothing booked,
// with the off file there, or after the event, it writes one log line and ends. A second thread stops it after
// 60 seconds (lib/watchdog.mjs).
//
// It opens only a page it rendered in this run: the brief is rendered in memory every time, written where it
// differs from the file, and today.html is written from that same text, never copied from disk.
//
// Which day: meeting days are days in the event's time zone, so "today" is today there at the moment this runs,
// whatever the machine's own zone is. Today's brief is built while a meeting today is still to come or under way.
// Otherwise tomorrow's is built, once it is evening there (17:00 or later) or today's meetings are all over.
// "07:00" is the machine's clock, because launchd has no other, and it is the user's morning where they are.
//
// Running it twice does no harm: the same event, day and records on the same date build and open nothing again.
import { readdirSync, existsSync, lstatSync, unlinkSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { home, readChecked } from '../lib/paths.mjs';
import { nowMs } from '../lib/clock.mjs';
import { todayKeyIn, addDays, wallParts, isValidZone } from '../lib/tz.mjs';
import { readJson, writeJson, writeText } from '../lib/jsonio.mjs';
import { readLedger, fold } from '../lib/ledger.mjs';
import { withLock } from '../lib/lock.mjs';
import { isMain } from '../lib/main.mjs';
import { isOff, logLine, readBriefState, briefStateFile, todayPage, openerFor, privateDir } from '../lib/unattended.mjs';
import { buildFactsBrief } from '../skills/event-outreach/scripts/commands/calendar.mjs';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const EVENING_HOUR = 17;
// At most this many events get a brief in one run, and this many failures a log line each.
export const MAX_BRIEFS = 50;
const MAX_FAILURE_LINES = 5;
export const TIME_LIMIT_MS = 60000;

// The day to brief for one event, or why there is none. Pure: the event, its booked meetings' start times, the
// length of a meeting and the moment it is asked.
export function briefDay({ zone, endDate, starts, minutes = 30, now }) {
  const today = todayKeyIn(zone, new Date(now));
  if (endDate && today > endDate) return { day: null, today, why: 'the event is over' };
  const tomorrow = addDays(today, 1);
  const on = (day) => starts.filter((s) => todayKeyIn(zone, new Date(s)) === day);
  const todays = on(today);
  if (todays.some((s) => Date.parse(s) + minutes * 60e3 > now)) return { day: today, today };
  const evening = wallParts(new Date(now), zone).hh >= EVENING_HOUR;
  if (on(tomorrow).length && (evening || todays.length) && !(endDate && tomorrow > endDate)) return { day: tomorrow, today };
  return { day: null, today, why: 'nothing booked' };
}

// An event's booked meetings, read from its ledger and its offered times. Nothing is written.
function bookedStarts(dir) {
  const { entries, damaged } = readLedger(join(dir, 'ledger.jsonl'));
  const people = fold(entries, damaged).people || {};
  const slots = Object.fromEntries((readJson(join(dir, 'slots.json'), { slots: [] }).slots || []).map((s) => [s.id, s]));
  return Object.values(people)
    .filter((p) => p.booked && !p.stopped && !p.dropped)
    .map((p) => p.booked_start || slots[p.booked]?.start || null)
    .filter((s) => Number.isFinite(Date.parse(s)));
}

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const shown = (t, n) =>
  String(t ?? '')
    .replace(/\p{Cf}+/gu, '')
    .replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')
    .slice(0, n);
// Meetings at more than one event on the day: today.html lists each event's brief. Like the brief, it loads
// nothing and runs no script, and an event's name is shown as text.
export function indexPage(items) {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your meetings</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px}</style></head><body>
<h1>Your meetings</h1><ul>${items
    .filter((x) => SLUG.test(String(x.slug)))
    .map((x) => `<li><a href="events/${esc(x.slug)}/agenda.html">${esc(shown(x.name, 200))}</a>: ${Number(x.meetings) || 0} on ${esc(shown(x.day, 10))}</li>`)
    .join('')}</ul></body></html>`;
}

// A plain file's text, or null: never through a link, never from a pipe or a device (those can hold a read for ever).
function plainFile(p) {
  try {
    return readChecked(p);
  } catch {
    return null;
  }
}

// The system's opener, by its full path, as for the outbox page. Under floorboss's own tests nothing opens on
// screen: only a stand-in named in FLOORBOSS_OPENER is started. Resolves true once the opener has started, false if
// it could not be started (or there is none).
function openPage(page) {
  const cmd = openerFor();
  if (!cmd) return Promise.resolve(null);
  return new Promise((done) => {
    const child = spawn(cmd, [page], { stdio: 'ignore', detached: true });
    child.on('error', (e) => done(String(e?.code || e?.message || 'could not start')));
    child.on('spawn', () => {
      child.unref();
      done(true);
    });
  });
}

// Builds what is due and writes today.html. Returns what to open (or nothing).
export function runBrief() {
  // No data folder: floorboss was never set up here (or FLOORBOSS_HOME points nowhere). Nothing is created.
  if (!existsSync(home())) return { skipped: 'no data folder' };
  if (isOff()) {
    logLine('brief_skipped', { reason: 'off' });
    return { skipped: 'off' };
  }
  const now = nowMs();
  const eventsDir = join(home(), 'events');
  const slugs = existsSync(eventsDir)
    ? readdirSync(eventsDir)
        .filter((s) => SLUG.test(s))
        .sort()
    : [];
  const state = readBriefState();
  const results = [];
  let left = 0;
  // Every event is looked at; the ones that are over or have nothing booked cost one small read each. The cap is
  // on briefs built, not on folders.
  for (const slug of slugs) {
    try {
      const dir = join(eventsDir, slug);
      if (!existsSync(join(dir, 'event.json'))) continue;
      const ev = readJson(join(dir, 'event.json'), null);
      if (!ev || typeof ev !== 'object' || !isValidZone(ev.time_zone)) continue;
      const end = /^\d{4}-\d{2}-\d{2}$/.test(String(ev.end_date || ev.start_date || '')) ? ev.end_date || ev.start_date : null;
      // Over: nothing else of it is read.
      if (end && todayKeyIn(ev.time_zone, new Date(now)) > end) {
        results.push({ slug, skipped: 'the event is over' });
        continue;
      }
      const minutes = Number(ev.settings?.meeting_minutes) || 30;
      const d = briefDay({ zone: ev.time_zone, endDate: end, starts: bookedStarts(dir), minutes, now });
      if (!d.day) {
        results.push({ slug, skipped: d.why });
        continue;
      }
      if (results.filter((r) => r.day).length >= MAX_BRIEFS) {
        left++;
        continue;
      }
      const { result: r, html } = buildFactsBrief({ event: slug, day: d.day });
      if (!r.meetings || typeof html !== 'string') {
        results.push({ slug, skipped: 'nothing booked' });
        continue;
      }
      const was = state[slug];
      // One more try, once, on a day the opener could not be started: only after exactly one failure on record.
      const retry = was?.opened === false && was.open_tries === 1;
      const same = !!was && was.day === d.day && was.hash === r.hash && was.ran_on === d.today && !retry;
      results.push({
        slug,
        name: String(ev.name || slug),
        day: d.day,
        ran_on: d.today,
        meetings: r.meetings,
        hash: r.hash,
        page: r.page,
        html,
        fresh: !same,
        retry: retry && was.day === d.day && was.hash === r.hash && was.ran_on === d.today,
        tries: was?.open_tries || 0,
        kept: !!r.kept
      });
    } catch (e) {
      results.push({ slug, failed: String(e?.message || e) });
    }
  }
  const briefs = results.filter((r) => r.day);
  const fresh = briefs.filter((r) => r.fresh);
  const failed = results.filter((x) => x.failed);
  for (const r of failed.slice(0, MAX_FAILURE_LINES)) logLine('brief_failed', { event: r.slug, reason: r.failed });
  if (failed.length > MAX_FAILURE_LINES) logLine('brief_failed', { reason: `${failed.length - MAX_FAILURE_LINES} more events could not be read` });
  if (left) logLine('brief_skipped', { reason: `more than ${MAX_BRIEFS} events have meetings that day: ${left} left out` });
  if (!briefs.length) {
    const whys = results.filter((r) => r.skipped).map((r) => r.skipped);
    if (!failed.length) logLine('brief_skipped', { reason: whys.includes('nothing booked') || !whys.length ? 'nothing booked' : whys[0] });
    return { skipped: 'nothing booked', results };
  }
  // today.html, written here and only here, last: the one event's page as this run rendered it, or a list when
  // there is more than one (each link leads to a page this run rendered or checked byte for byte). Written again
  // whenever it differs, so nothing left at that name by an earlier day, an earlier run or anyone else is opened.
  const page = briefs.length > 1 ? indexPage(briefs) : briefs[0].html;
  if (plainFile(todayPage()) !== page) writeText(todayPage(), page);
  if (!fresh.length) {
    logLine('brief_skipped', { reason: 'already built, and the records are the same', events: briefs.map((r) => r.slug) });
    return { skipped: 'unchanged', results };
  }
  const builtAt = new Date(now).toISOString();
  privateDir();
  for (const r of fresh) {
    state[r.slug] = { day: r.day, hash: r.hash, ran_on: r.ran_on, built_at: builtAt, page: r.page, ...(r.retry ? { opened: false, open_tries: 1 } : {}) };
    if (!r.retry) logLine('brief_built', { event: r.slug, day: r.day, meetings: r.meetings, page: todayPage(), ...(r.kept ? { kept_talking_points: true } : {}) });
  }
  writeJson(briefStateFile(), state);
  return { built: fresh.map((r) => r.slug), page: todayPage(), results };
}

// A mark while a run is under way (unattended/brief-running). One still there at the start is from a run that never
// finished, stopped at the time limit: said in the log now, since the stopped run could not say it. Anything else
// found at that name (a link, a folder) is read the same way and taken away by its own name, never followed; and a
// mark that can't be written is no reason to go without the brief.
function marked(fn) {
  if (!existsSync(home()) || isOff()) return fn();
  const mark = join(privateDir(), 'brief-running');
  let left = null;
  try {
    left = lstatSync(mark);
  } catch {
    left = null;
  }
  if (left) {
    logLine('brief_failed', { reason: left.isFile() ? 'the run before this one did not finish: it was stopped at the time limit' : 'the mark of a run under way was not a plain file: replaced' });
    try {
      rmSync(mark, { recursive: true, force: true });
    } catch {
      /* written over below, or not at all */
    }
  }
  let wrote = false;
  try {
    writeText(mark, `${process.pid} ${new Date().toISOString()}\n`);
    wrote = true;
  } catch (e) {
    logLine('brief_failed', { reason: `the mark of a run under way could not be written (${String(e?.message || e)}); going on without it` });
  }
  try {
    return fn();
  } finally {
    if (wrote)
      try {
        unlinkSync(mark);
      } catch {
        /* gone */
      }
  }
}

// A run that was stopped at the limit left its lock behind. Its mark names its process: when that process is gone,
// the lock is nobody's, and is taken away now so this run doesn't wait for it to grow old. Only the lock that mark
// was written under: a lock made after the mark belongs to a run that has not written its own mark yet, and stays.
function clearDeadRun() {
  try {
    const markFile = join(home(), 'unattended', 'brief-running');
    const lockDir = join(home(), 'brief.lock');
    const mark = lstatSync(markFile);
    const lock = lstatSync(lockDir);
    if (!mark.isFile() || !lock.isDirectory() || lock.mtimeMs > mark.mtimeMs) return;
    const pid = Number(String(plainFile(markFile) ?? '').split(' ')[0]);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
    try {
      process.kill(pid, 0);
      return; // still running (or a process of that number is): the lock keeps its ordinary rules
    } catch (e) {
      if (e.code !== 'ESRCH') return;
    }
    rmdirSync(lockDir);
  } catch {
    /* no mark, no lock, or not ours to remove */
  }
}

// The opener could not be started: said in the log, and noted so the next run tries once more, and only once.
export function noteOpenFailure(slugs, why) {
  const state = readBriefState();
  // First failure: 1 (the next run tries once more). Anything else on record, a second failure included: 2, the end.
  for (const s of slugs) if (state[s]) state[s] = { ...state[s], opened: false, open_tries: state[s].opened === false ? 2 : 1 };
  writeJson(briefStateFile(), state);
  logLine('brief_open_failed', { reason: why, events: slugs });
}
export function noteOpened(slugs) {
  const state = readBriefState();
  if (!slugs.some((s) => state[s] && state[s].opened === false)) return;
  for (const s of slugs) if (state[s]) state[s] = { ...state[s], opened: true };
  writeJson(briefStateFile(), state);
}

if (isMain(import.meta.url)) {
  const mode = process.argv[2];
  if (mode !== 'brief' || process.argv.length > 3) {
    process.stderr.write('floorboss: this is the launcher for scheduled runs. Its one mode is "brief".\n');
    process.exit(2);
  }
  // The limit is shorter only under floorboss's own tests.
  const ms = (process.env.FLOORBOSS_TEST === '1' && Number(process.env.FLOORBOSS_BRIEF_LIMIT_MS)) || TIME_LIMIT_MS;
  // One launcher at a time: two started together (a catch-up after sleep) build and open one brief. A lock left
  // by a run that was stopped at the limit is older than the limit, and is broken at once.
  const lock = { waitMs: 8000, staleMs: ms + 2000 };
  try {
    if (existsSync(home())) new Worker(new URL('../lib/watchdog.mjs', import.meta.url), { workerData: { ms } }).unref();
    clearDeadRun();
    const out = existsSync(home()) ? withLock('brief', () => marked(runBrief), lock) : runBrief();
    if (out.built) {
      const opened = await openPage(out.page);
      if (opened === true) withLock('brief', () => noteOpened(out.built), lock);
      else if (opened !== null) withLock('brief', () => noteOpenFailure(out.built, opened), lock);
    }
  } catch (e) {
    try {
      logLine('brief_failed', { reason: String(e?.message || e) });
    } catch {
      /* nowhere to say so */
    }
    process.exitCode = 1;
  }
  // Nothing is left to wait for: the opener runs on its own.
  process.exit(process.exitCode || 0);
}
