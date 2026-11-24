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
//
// A second mode: `followups`, started by launchd every hour of the day on the machine's clock
// (scripts/unattended.mjs install-followups); each follow-up still goes in only on a weekday from 09:00 to 17:00 in its
// event's time zone. With no model, it works out from floorboss's records which authorised
// follow-ups are due now (runFollowups below); with none, it ends there. Otherwise it writes a one-time ticket and
// starts one Claude Code run (lib/unattended.mjs claudeRun, a pure value the tests read) whose only job is to put
// those follow-ups in the user's drafts folder, each after the guard read the mailbox (and the CRM) for it. It never
// passes a flag that turns the guard off or answers a prompt for the user.
// First import: floorboss's own process, which reads settings as Claude Code does (lib/harness.mjs).
import '../lib/own-process.mjs';
import { readdirSync, existsSync, lstatSync, unlinkSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { home, readChecked } from '../lib/paths.mjs';
import { nowMs } from '../lib/clock.mjs';
import { todayKeyIn, addDays, wallParts, isValidZone } from '../lib/tz.mjs';
import { readJson, writeJson, writeText } from '../lib/jsonio.mjs';
import { readLedger, fold, contactable } from '../lib/ledger.mjs';
import { withLock, removeLock } from '../lib/lock.mjs';
import { isMain } from '../lib/main.mjs';
import { ranRecently, endSession, RUN_LOCK_MINUTES } from '../lib/runlock.mjs';
import { loadEvent } from '../lib/event.mjs';
import { loadConfig } from '../lib/config.mjs';
import { eventRecord, followupDueDay, eventDay, sentOrGoingToday, addressBusyToday, busyWhy, homeSends, stepBefore } from '../lib/sendcheck.mjs';
import { isOff, logLine, readBriefState, briefStateFile, todayPage, openerFor, privateDir, oneLine, followupsInstalledFile, claudeFor, claudeRun, unattendedDir } from '../lib/unattended.mjs';
import {
  liveOptins,
  authorisedLines,
  authorisationFor,
  recipeFp,
  emailBefore,
  earlierStepWhy,
  windowWhy,
  hoursWhy,
  weekendIn,
  crmUnreadableWhy,
  attendedDraftIn,
  attendedDraftOpen,
  attendedOpenWhy,
  olderDraftOf,
  olderDraftWhy,
  gmailReads,
  gmailSearchWhy,
  messageIdOf,
  shortDay,
  crmIdFor,
  readPrivate,
  readTicket,
  endedFile,
  present,
  createOnce,
  runFile,
  logEntries,
  unclearDrafts,
  writeSummary,
  dayOf,
  sha256,
  otherChannelPeople,
  DISCLAIMER,
  RUN_LIMIT_MS,
  gapChangedWhy,
  MAILBOX_ANCHOR_WHY
} from '../lib/unattended-drafts.mjs';
import { crossEventWhy, dayTakenForDraft } from '../hooks/guard/unattended.mjs';
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
// notices: people an unattended follow-up goes into the drafts for today who were also written to on LinkedIn or in
// the event app (lib/unattended-drafts.mjs otherChannelPeople), named with the disclaimer.
// day: the day it is for (YYYY-MM-DD, the machine's own day), said in the page's heading: a page left from an earlier
// day never reads as today's.
export function indexPage(items, notices = [], day = null) {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'";
  const where = (w) => (w || []).map((k) => (k === 'linkedin' ? 'LinkedIn' : 'the event app')).join(' and ');
  const dated = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? `${shortDay(day)} ${day.slice(0, 4)}` : null;
  const others = notices.length
    ? `<h2>Follow-ups going into your drafts on their own${dated ? ` on ${esc(dated)}` : ' today'}</h2><p>You also wrote to these people on LinkedIn or in the event app. Before you send their draft, check those inboxes for a reply.</p><ul>${notices
        .map((n) => `<li>${esc(shown(n.name, 120))} (${esc(where(n.where))})</li>`)
        .join('')}</ul><p>${esc(DISCLAIMER)}</p>`
    : '';
  const meetings = items.filter((x) => SLUG.test(String(x.slug)));
  const list = meetings.length || !notices.length;
  // The day itself, never "Today": a page left on disk from an earlier day still reads true.
  const title = list ? 'Your meetings' : dated ? esc(dated) : 'Today';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px}</style></head><body>
${list ? `<h1>Your meetings</h1><ul>${meetings.map((x) => `<li><a href="events/${esc(x.slug)}/agenda.html">${esc(shown(x.name, 200))}</a>: ${Number(x.meetings) || 0} on ${esc(shown(x.day, 10))}</li>`).join('')}</ul>` : `<h1>${title}</h1>`}${others}</body></html>`;
}
// The people the morning page names (see indexPage), for every event with unattended drafts on. A failure names nobody.
function followupNotices(now) {
  const out = [];
  // Only while drafts can go in on their own: the follow-up job installed, for this version of floorboss.
  const inst = readPrivate(followupsInstalledFile(), null);
  if (!inst || !PLUGIN_VERSION || inst.version !== PLUGIN_VERSION) return out;
  let config = {};
  try {
    config = loadConfig();
  } catch {
    return out;
  }
  // Only the people the launcher puts on a ticket today, by its own checks (followupsDue, at any hour of the day): the
  // page and the launcher never disagree about whose draft goes in.
  let going;
  try {
    going = new Set(followupsDue(now, null, { anyHour: true }).items.map((x) => `${x.event}:${x.id}:${x.touch}`));
  } catch {
    return out;
  }
  for (const { slug } of liveOptins(now))
    try {
      const settings = { ...loadEvent(slug).settings, connectors: config.connectors || {} };
      out.push(...otherChannelPeople(slug, { settings, nowMs: now, only: (a) => going.has(`${slug}:${a.id}:${a.touch}`) }));
    } catch {
      /* named nowhere */
    }
  return out.slice(0, 200);
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
  const notices = followupNotices(now);
  for (const r of failed.slice(0, MAX_FAILURE_LINES)) logLine('brief_failed', { event: r.slug, reason: r.failed });
  if (failed.length > MAX_FAILURE_LINES) logLine('brief_failed', { reason: `${failed.length - MAX_FAILURE_LINES} more events could not be read` });
  if (left) logLine('brief_skipped', { reason: `more than ${MAX_BRIEFS} events have meetings that day: ${left} left out` });
  if (!briefs.length && !notices.length) {
    const whys = results.filter((r) => r.skipped).map((r) => r.skipped);
    if (!failed.length) logLine('brief_skipped', { reason: whys.includes('nothing booked') || !whys.length ? 'nothing booked' : whys[0] });
    return { skipped: 'nothing booked', results };
  }
  // today.html, written here and only here, last: the one event's page as this run rendered it, or a list when
  // there is more than one (each link leads to a page this run rendered or checked byte for byte). Written again
  // whenever it differs, so nothing left at that name by an earlier day, an earlier run or anyone else is opened.
  // With people to name for the unattended drafts (LinkedIn or the event app), the list, with them under it.
  // The machine's own day (the brief runs at 07:00 on its clock): the day the page says it is for.
  const localDay = todayKeyIn(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', new Date(now));
  const page = briefs.length > 1 || notices.length ? indexPage(briefs, notices, localDay) : briefs[0].html;
  if (plainFile(todayPage()) !== page) writeText(todayPage(), page);
  if (!briefs.length) {
    // No meeting, only people to name: opened once a day, and again only if the names change.
    const key = { day: localDay, hash: sha256(page).slice(0, 24) };
    if (state._followups?.day === key.day && state._followups?.hash === key.hash) return { skipped: 'unchanged', results };
    privateDir();
    state._followups = key;
    writeJson(briefStateFile(), state);
    logLine('brief_built', { names: notices.length, page: todayPage() });
    return { built: [], page: todayPage(), results, notices: notices.length };
  }
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
    removeLock(lockDir);
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

// ---------- followups: the unattended email drafts ----------
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return null;
  }
})();
// The authorised follow-ups that may go into the drafts now, worked out from floorboss's records with no model and no
// network: each event with a live opt-in, each authorised step not yet in the drafts or sent, whose approval, address,
// thread and mail tools are the ones authorised, on its due day or the day after, before the event's end, on a weekday
// between 09:00 and 17:00 event time. held: the ones that can't go and won't by waiting (said once a day in the log).
// Pure: it reads and writes nothing else.
// anyHour: also outside the event's hours on a weekday (the morning page, written before they start, names who the
// launcher will put on a ticket today by these same checks).
export function followupsDue(now = nowMs(), log = null, { anyHour = false } = {}) {
  const items = [];
  const held = [];
  // Due, but blocked by something waiting can't fix on its own today: said once in the log, so the user hears why.
  const waiting = [];
  const config = loadConfig();
  const stageFp = recipeFp(config.connectors?.stage_draft);
  const readFp = recipeFp(config.connectors?.['email.messages']);
  const lines = authorisedLines();
  // Held by a run earlier today (the guard or the run's flow said why, in the log): not put on another ticket today, so
  // one person the guard keeps refusing never stops every run before the people after them, and a person held because
  // something came in doesn't start a model run every hour. A hold for timing only (retry: a read older than 90
  // seconds, outside the event's hours, a prompt that may be open with the user there) is tried again next hour.
  const today = dayOf(new Date(now).toISOString());
  const heldToday = new Set((log || logEntries()).filter((e) => e.type === 'held' && e.session && e.retry !== true && dayOf(e.at) === today).map((e) => `${e.event}:${e.id}:${e.touch}`));
  // Held for timing only by a run earlier today: put after everyone else on the ticket, the least recently tried of
  // them first (by each one's latest timing hold today), so a person whose draft keeps missing its 90 seconds never
  // stops every run before the people after them get theirs, even when they too were held once.
  const retriedToday = new Map();
  for (const e of (log || logEntries()).filter((x) => x.type === 'held' && x.session && x.retry === true && dayOf(x.at) === today)) {
    const k = `${e.event}:${e.id}:${e.touch}`;
    const at = Date.parse(e.at);
    if (Number.isFinite(at)) retriedToday.set(k, Math.max(retriedToday.get(k) ?? -Infinity, at));
  }
  // A CRM connected that floorboss can't read for itself (Salesforce, Close, or a CRM with no activity reader): every
  // draft waits for the user.
  const crmGap = crmUnreadableWhy(config);
  // A draft tool that threads by the message it replies to (Gmail's replyToMessageId): a follow-up with no message id
  // for the email it answers is held by the guard, so it is never put on a ticket.
  const repliesById = JSON.stringify(config.connectors?.stage_draft?.args || {}).includes('{reply_to_message_id}');
  const gmail = !!gmailReads(config);
  // Every event's sends, read once for all the follow-ups looked at here (lib/sendcheck.mjs addressBusyToday).
  let sends = null;
  for (const { slug } of liveOptins(now)) {
    let settings;
    let ev;
    try {
      const e = loadEvent(slug);
      ev = e.event;
      settings = { ...e.settings, connectors: config.connectors || {} };
    } catch {
      continue;
    }
    const evDir = join(home(), 'events', slug);
    const { entries, state, folded } = eventRecord(evDir);
    // The latest authorisation of each step: an older one for another text is no authorisation of this one.
    const steps = new Map();
    for (const a of lines.filter((x) => x.event === slug && /^c\d+$/.test(String(x.id)) && Number.isInteger(x.touch))) steps.set(`${a.id}:${a.touch}`, a);
    for (const a of steps.values()) {
      const p = folded.people?.[a.id];
      const x = p?.touches?.[a.touch];
      const name = p?.name || a.id;
      const hold = (why, extra = {}) => held.push({ event: slug, id: a.id, touch: a.touch, name, to: a.to, why, ...extra });
      const wait = (why) => waiting.push({ event: slug, id: a.id, touch: a.touch, name, to: a.to, why });
      if (!p || !x || x.sent || x.staged || x.stage_released) continue;
      if (p.stopped || p.dropped) continue;
      if (p.replied || p.booked) {
        // Over, not waiting on the user: said once, as over.
        hold('they replied or booked: nothing more goes on its own', { final: true });
        continue;
      }
      if (!x.approved?.hash || x.approved.hash !== x.hash || x.approved.hash !== a.hash) {
        hold('its text changed since you authorised it: it waits for you');
        continue;
      }
      // A LinkedIn step before it that hasn't gone is passed over (lib/sendcheck.mjs stepBefore, as the guard reads it).
      const before = stepBefore(evDir, entries, { touches: p.touches }, a.id, a.touch, settings);
      if (!p.touches?.[before]?.sent) {
        // The step before it is a draft in the user's drafts folder that floorboss hasn't seen sent yet; or one an
        // unattended run let through that floorboss never heard went in (no draft id came back): it may not be there.
        const b = p.touches?.[before];
        const step = before > 1 ? `follow-up ${before - 1}` : 'first message';
        if (b?.staged) wait(`it waits until floorboss sees your ${step} draft was sent: once you've sent it from your mail app, run floorboss (it reads your mailbox for it)`);
        else if (b?.stage_released)
          wait(`floorboss doesn't know whether your ${step} draft went into your drafts folder (the mail tool never said it did), so this one waits. Look there. If it's there, send it, then run floorboss (it reads your mailbox for it). If it isn't, tell floorboss it isn't there (outreach draft-missing) and that draft can go in again, on its own, but not on the day the first one was let through`);
        continue;
      }
      const due = followupDueDay(evDir, settings, entries, state[a.id] || {}, { id: a.id, touch: a.touch }, now);
      if (due.why || !due.day || due.today < due.day) continue;
      // The ledger's own rule for who may be written to (a stop, a skip or colleague decision, a duplicate, a damaged
      // line, a bounce): the guard refuses the draft, so no run is started for it.
      {
        const no = contactable(folded, a.id, 'message', eventDay(evDir, now));
        if (no) {
          hold(`${no}: nothing more goes on its own`);
          continue;
        }
      }
      // One message a day to a person, at this event and across all your events (the guard's rules: lib/sendcheck.mjs
      // sentOrGoingToday and addressBusyToday): someone another message went or is going to today waits for the user,
      // with no model run spent on them today (on a later day, that message holds them too: crossEventWhy below).
      if (sentOrGoingToday(entries, state[a.id] || {}, { id: a.id, touch: a.touch, to: a.to }, evDir, now) != null) {
        wait(`another message to ${name} already went or is going today: one message a day to a person, so it waits for you`);
        continue;
      }
      // A draft of this same step let through today (a run's, since said not to be in your drafts folder) holds the
      // day: the guard refuses this step again until a later day (hooks/guard/unattended.mjs dayTakenForDraft, the
      // guard's own rule), so no run is spent on it today.
      if (dayTakenForDraft({ evDir, slug, id: a.id, touch: a.touch, entries, nowMs: now })) {
        // The marker can belong to this step's own earlier draft or to another message to them: say neither for sure.
        // Tomorrow is only promised while the follow-up is still in its window (its due day or the day after).
        const later = !windowWhy({ due: due.day, today: addDays(due.today, 1), end: ev.end_date || ev.start_date });
        wait(
          `a message to ${name} was already let through today (a draft of this follow-up, or another message to them), so this can't go in on its own today` +
            (later ? ': it can still go in on its own tomorrow' : ", and tomorrow is too late for it to go on its own, so it waits for you"),
        );
        continue;
      }
      {
        sends ||= homeSends();
        const busy = addressBusyToday(evDir, a.to, now, a.id, sends);
        if (busy) {
          wait(`${busyWhy(busy, name, a.to)}. One message a day to one person, across all your events, so it waits for you`);
          continue;
        }
      }
      // The day the authorisation prompt showed binds: never earlier.
      if (a.due_day && due.day < a.due_day) {
        hold(`its day moved since you authorised it (you allowed it for ${shortDay(a.due_day)}, it's due ${shortDay(due.day)} now): it waits for you`);
        continue;
      }
      {
        const gw = gapChangedWhy(a, settings);
        if (gw) {
          hold(gw);
          continue;
        }
      }
      // Authorised with no day, after a send known only from your mailbox, with no Gmail thread read to date it.
      if (!a.due_day && !gmail) {
        const pe = emailBefore(p, a.touch, a.to)?.x;
        if (pe?.sent && !pe.send_result) {
          hold(`${MAILBOX_ANCHOR_WHY}: it waits for you`);
          continue;
        }
      }
      const ww = windowWhy({ due: due.day, today: due.today, end: ev.end_date || ev.start_date });
      if (ww) {
        // Too late to go on its own ("more than a day ago: it waits for you") is the user's to send: held for them. Only
        // an event that is over is the end of it.
        hold(ww, /is over/.test(ww) ? { final: true } : {});
        continue;
      }
      // An attended draft of this step, for any of its texts, that went in or failed with no receipt saved: never a
      // second one on its own.
      const went = attendedDraftIn(evDir, a.id, a.touch, entries);
      if (went) {
        hold(went.why);
        continue;
      }
      // A draft of an older text of this step that may still be in the drafts folder: never a second one (the guard's
      // rule too).
      const older = olderDraftOf(entries, a.id, a.touch, x.approved.hash);
      if (older) {
        hold(olderDraftWhy(older));
        continue;
      }
      if (crmGap) {
        hold(crmGap);
        continue;
      }
      // An attended draft of this step whose Claude Code prompt may still be open: its call still runs once allowed, so
      // nothing goes in on its own until it ran or 12 hours passed (lib/unattended-drafts.mjs attendedDraftOpen).
      const open = attendedDraftOpen(evDir, a.id, a.touch, now);
      if (open) {
        wait(attendedOpenWhy(open));
        continue;
      }
      if (gmail && gmailSearchWhy(a.to)) {
        hold(gmailSearchWhy(a.to));
        continue;
      }
      if (hoursWhy(ev.time_zone, now)) {
        // The job runs every hour, so only a weekend there keeps a follow-up in its window from going today: said, so
        // the day doesn't pass unseen.
        if (weekendIn(ev.time_zone, now)) {
          const place = String(ev.time_zone).split('/').pop().replace(/_/g, ' ');
          wait(`it's the weekend in ${place}, and drafts go in on their own on weekdays only (Monday to Friday, ${place} time), so it can't go in on its own today`);
          continue;
        }
        if (!anyHour) continue;
      }
      const thread = emailBefore(p, a.touch, a.to)?.thread || null;
      if (!authorisationFor({ event: slug, id: a.id, touch: a.touch, hash: a.hash, to: a.to }, { stageFp, readFp, thread })) {
        hold('it is not authorised as it is now (its address, thread or mail tool changed since you authorised it)');
        continue;
      }
      if (repliesById && !messageIdOf(emailBefore(p, a.touch, a.to)?.x)) {
        hold("floorboss has no message id for your last email to them (its send's answer didn't give one), so this draft couldn't go in reply to it");
        continue;
      }
      // The CRM record the run reads for them is the one bound at the authorisation.
      const crmId = crmIdFor(evDir, folded, a.id);
      if (Object.hasOwn(a, 'crm_id') && String(a.crm_id ?? '') !== String(crmId ?? '')) {
        hold('its CRM record changed since you authorised it: it waits for you');
        continue;
      }
      // The guard's own rules for the email it answers and for every event's ledger, checked here too: an item the
      // guard would refuse is never put on a ticket.
      const early = earlierStepWhy(evDir, entries, folded, { id: a.id, touch: a.touch, to: a.to, thread });
      if (early) {
        hold(early);
        continue;
      }
      const prevSent = Date.parse(emailBefore(p, a.touch, a.to)?.x?.sent_at);
      const since = Math.min(...[Date.parse(a.at), prevSent].filter(Number.isFinite), Infinity);
      const other = crossEventWhy({ slug, id: a.id, to: a.to, since: Number.isFinite(since) ? since : 0, nowMs: now });
      if (other) {
        hold(other);
        continue;
      }
      if (heldToday.has(`${slug}:${a.id}:${a.touch}`)) continue;
      items.push({ event: slug, id: a.id, touch: a.touch, hash: a.hash, to: a.to, name: String(name).slice(0, 80), thread_id: thread, crm_id: crmId });
    }
  }
  // (A stable sort: the rest keep their order.)
  const tried = (x) => retriedToday.get(`${x.event}:${x.id}:${x.touch}`) ?? -Infinity;
  items.sort((x, y) => (tried(x) === tried(y) ? 0 : tried(x) < tried(y) ? -1 : 1));
  return { items, held, waiting };
}
// A held or waiting follow-up is said in the log once for each reason, not every hour or every day: a summary that
// says the same lines daily teaches its reader to stop reading it. daily: once a day instead (a line about the whole
// job, such as an update to reinstall for).
function logHeldOnce(held, now, { type = 'held', daily = false } = {}) {
  const today = dayOf(new Date(now).toISOString());
  const seen = new Set(
    logEntries()
      .filter((e) => e.type === type && !e.session && (!daily || dayOf(e.at) === today))
      .map((e) => `${e.event}:${e.id}:${e.touch}:${e.why}`)
  );
  for (const h of held) if (!seen.has(`${h.event}:${h.id}:${h.touch}:${oneLine(h.why)}`)) logLine(type, h);
}

// The launcher's own one-run-at-a-time file (O_EXCL). One left by a run that died is taken away once its process is
// gone, or once it is older than a run can last.
function takeRunFile(now) {
  const text = `${process.pid} ${new Date(now).toISOString()}\n`;
  for (let i = 0; i < 2; i++) {
    privateDir();
    try {
      writeFileSync(runFile(), text, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let left = null;
    try {
      left = lstatSync(runFile());
    } catch {
      continue;
    }
    const pid = Number(String((() => {
      try {
        return readChecked(runFile(), 200);
      } catch {
        return '';
      }
    })()).split(' ')[0]);
    let alive = false;
    try {
      if (Number.isInteger(pid) && pid > 1) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch {
      alive = false;
    }
    if (left.isFile() && alive && Date.now() - left.mtimeMs < RUN_LIMIT_MS + 5 * 60000) return false;
    try {
      rmSync(runFile(), { force: true });
    } catch {
      return false;
    }
  }
  return false;
}

// Drafts of this run the guard let through whose result never came back: each said in the log as unclear (they may or
// may not be in the drafts folder), for the summary, the reminder and the next attended run. Returns how many.
function noteUnclear(session, mine) {
  const open = unclearDrafts(mine);
  for (const e of open) logLine('draft_unclear', { session, event: e.event, id: e.id, touch: e.touch, name: e.name, to: e.to });
  return open.length;
}
// Tickets whose launcher is gone without having ended them: ended now, with their session's run lock, and anything
// they let through unclear is said.
function endDeadRuns() {
  let names = [];
  try {
    names = readdirSync(join(unattendedDir(), 'tickets')).filter((f) => /\.json$/.test(f));
  } catch {
    return;
  }
  for (const f of names) {
    const session = f.replace(/\.json$/, '');
    const t = readTicket(session);
    if (!t || present(endedFile(session)) || t.pid === process.pid) continue;
    let alive = false;
    try {
      if (Number.isInteger(t.pid) && t.pid > 1) {
        process.kill(t.pid, 0);
        alive = true;
      }
    } catch (e) {
      alive = e?.code === 'EPERM';
    }
    if (alive) continue;
    try {
      if (!createOnce(['tickets'], `${session}.ended`, { at: new Date().toISOString(), why: 'its launcher was gone' })) continue;
      try {
        endSession(session);
      } catch {
        /* no lock of its own was left */
      }
      const mine = logEntries().filter((e) => e.session === session);
      const unclear = noteUnclear(session, mine);
      if (mine.some((e) => e.type === 'run_started')) logLine('run_ended', { session, why: 'its launcher was stopped before the run ended (the Mac slept, logged out or was turned off): ended now', ...(unclear ? { unclear } : {}) });
    } catch {
      /* the next launch tries again */
    }
  }
}

// Starts the one Claude Code run and waits for it, stopping it at the run's limit. It runs in a process group of its
// own, so at the limit the whole group goes (the connectors it started with it).
function startRun(run, limit) {
  return new Promise((done) => {
    let tail = '';
    let over = false;
    const child = spawn(run.program, run.args, { stdio: ['ignore', 'ignore', 'pipe'], env: run.env, detached: true });
    const group = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* gone already */
      }
    };
    const stop = setTimeout(() => {
      group('SIGTERM');
      setTimeout(() => group('SIGKILL'), 10000).unref();
    }, limit);
    child.stderr.on('data', (b) => {
      tail = `${tail}${b}`.slice(-2000);
    });
    child.on('error', (e) => {
      clearTimeout(stop);
      if (!over) done({ code: null, error: String(e?.code || e?.message || 'could not start'), tail });
      over = true;
    });
    // Its own end, not its output's: a connector left holding the pipe doesn't keep the launcher waiting.
    child.on('exit', (code, signal) => {
      clearTimeout(stop);
      group('SIGTERM');
      child.stderr.destroy();
      if (!over) done({ code, signal, tail });
      over = true;
    });
  });
}

export async function runFollowups() {
  if (!existsSync(home())) return 0;
  // Never from a Claude Code session: macOS's scheduler starts this, from the job the user installed.
  if ('CLAUDECODE' in process.env) {
    logLine('followups_refused', { reason: 'started from a Claude Code session: only the job you install starts it' });
    return 1;
  }
  if (isOff()) return 0;
  const inst = readPrivate(followupsInstalledFile(), null);
  if (!inst) return 0;
  const now = nowMs();
  // The day's summary, written whenever something was said in the log (the reminder names this file).
  const summarise = () => {
    try {
      writeSummary(dayOf(new Date(nowMs()).toISOString()));
    } catch {
      /* the log still holds it */
    }
  };
  if (!PLUGIN_VERSION || inst.version !== PLUGIN_VERSION) {
    logHeldOnce([{ event: '-', id: '-', touch: 0, name: 'every follow-up', why: 'floorboss was updated since the schedule was installed: run install-followups again from your terminal' }], now, { daily: true });
    summarise();
    return 0;
  }
  // A run whose launcher was stopped before it could end it (the Mac slept, logged out or was turned off): ended now,
  // so its session's lock doesn't keep every later launch waiting for hours.
  endDeadRuns();
  const due = followupsDue(now);
  logHeldOnce(due.held, now);
  logHeldOnce(due.waiting, now, { type: 'waiting' });
  // Nothing due: no model, nothing started.
  if (!due.items.length) {
    if (due.held.length || due.waiting.length) summarise();
    return 0;
  }
  // floorboss ran something in the last 30 minutes (lib/runlock.mjs ranRecently: the run lock's own window, not the
  // 12-hour backstop a session that ran floorboss keeps): the user may be at work in it, so this hour waits. A session
  // merely left open doesn't hold the follow-ups.
  const recent = ranRecently(Date.now());
  if (recent.active) {
    // A run lock file it can't read counts as floorboss in use (fails closed): said as what it is, with the way out.
    const [reason, why] = recent.unreadable
      ? [
          "floorboss's run lock file (active.json in its data folder) can't be read, so the follow-ups wait: running any floorboss command once writes it again",
          `floorboss's run lock file (active.json in its data folder) can't be read, so its draft didn't go in: run any floorboss command once, and it can go at a later hour, once floorboss has had ${RUN_LOCK_MINUTES} quiet minutes`
        ]
      : [
          `floorboss ran something in the last ${RUN_LOCK_MINUTES} minutes: trying again at the next hour`,
          `floorboss was in use in the ${RUN_LOCK_MINUTES} minutes before this hour's run, so its draft didn't go in then: it can go at a later hour, once floorboss has had ${RUN_LOCK_MINUTES} quiet minutes`
        ];
    logLine('followups_skipped', { reason, due: due.items.length });
    // Said once a day for each follow-up it keeps from going in.
    logHeldOnce(
      due.items.map((x) => ({ event: x.event, id: x.id, touch: x.touch, name: x.name, to: x.to, why })),
      now,
      { type: 'waiting', daily: true }
    );
    summarise();
    return 0;
  }
  if (!takeRunFile(now)) {
    logLine('followups_skipped', { reason: 'another unattended run is under way' });
    return 0;
  }
  let exit = 0;
  try {
    const session = randomUUID();
    const token = randomBytes(32).toString('hex');
    if (!createOnce(['tickets'], `${session}.json`, { v: 1, session, token_sha256: sha256(token), pid: process.pid, at: new Date(now).toISOString(), items: due.items }))
      throw new Error('a ticket for this session id was there already');
    const test = process.env.FLOORBOSS_TEST === '1';
    const env = { ...process.env, ...(typeof inst.path === 'string' && inst.path ? { PATH: inst.path } : {}) };
    const run = claudeRun({
      program: claudeFor(process.env, inst),
      session,
      token,
      env,
      extra: test ? { pluginDir: process.env.FLOORBOSS_E2E_PLUGIN_DIR || null, mcpConfig: process.env.FLOORBOSS_E2E_MCP_CONFIG || null } : {}
    });
    logLine('run_launched', { session, items: due.items.length, events: [...new Set(due.items.map((x) => x.event))] });
    const limit = (test && Number(process.env.FLOORBOSS_FOLLOWUPS_LIMIT_MS)) || RUN_LIMIT_MS;
    const r = await startRun(run, limit);
    createOnce(['tickets'], `${session}.ended`, { at: new Date().toISOString() });
    try {
      endSession(session);
    } catch {
      /* no lock of its own was left */
    }
    const mine = logEntries().filter((e) => e.session === session);
    const unclear = noteUnclear(session, mine);
    logLine('run_ended', {
      session,
      exit: r.code,
      ...(r.signal ? { signal: r.signal } : {}),
      ...(r.error ? { error: r.error } : {}),
      drafts: mine.filter((e) => e.type === 'draft_result' && e.ok === true).length,
      held: mine.filter((e) => e.type === 'held').length,
      ...(unclear ? { unclear } : {}),
      ...(r.code !== 0 && r.tail ? { said: oneLine(r.tail, 300) } : {})
    });
    exit = r.code === 0 ? 0 : 1;
  } catch (e) {
    logLine('followups_failed', { reason: String(e?.message || e) });
    exit = 1;
  } finally {
    try {
      unlinkSync(runFile());
    } catch {
      /* gone */
    }
    try {
      writeSummary(dayOf(new Date(nowMs()).toISOString()));
    } catch {
      /* the log still holds it */
    }
  }
  return exit;
}

if (isMain(import.meta.url)) {
  const mode = process.argv[2];
  if (!['brief', 'followups'].includes(mode) || process.argv.length > 3) {
    process.stderr.write('floorboss: this is the launcher for scheduled runs. Its modes are "brief" and "followups".\n');
    process.exit(2);
  }
  if (mode === 'followups') {
    let code = 1;
    try {
      code = await runFollowups();
    } catch (e) {
      try {
        logLine('followups_failed', { reason: String(e?.message || e) });
      } catch {
        /* nowhere to say so */
      }
    }
    process.exit(code);
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
