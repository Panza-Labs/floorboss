// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// What an event's outbox page is built from, taken before each build and kept beside the page
// (derived/outbox-inputs.json, tied to the page by a build id in both), so a later check can tell, with no event load,
// whether anything the page reads has changed since. That is this event's files (its record, settings, lists, mappings,
// drafts and the drafting list), the files its event.json and the settings name (older list paths, contacts exports, the
// profile's skills), the user's settings, the day in the event's time zone, floorboss's version, and every other event's
// settings, lists, mappings and record. Files are recorded by size and time; this event's record also by a hash of all
// of it, so a record that only grew by lines the page never reads (a sync, a reply check) leaves the page current, and
// an edit anywhere in it does not. Another event's record is recorded by a digest of what it lends this one (who was sent
// or approved a message there, who said stop there, the match answers: lib/lent.mjs), so a line there that changes none
// of that (a group decision, a cut, a note) leaves this page current, and one that does (a send, an approval, a stop,
// an address change, an answer about a CRM match) never does. With it goes a digest of what that event sent or let
// through, by address (lib/sendcheck.mjs sendsDigest), and each event's guard marks for a message (released/<id>-<touch>-
// <clears>, with whether each is old enough to count), since a card says "Not today" for a person another event wrote
// to today (lib/sendcheck.mjs addressBusyToday). test/outbox-inputs.test.mjs holds the list to every file a build
// actually reads.
import { existsSync, readdirSync, statSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, writeJson } from '../../../../lib/jsonio.mjs';
import { todayKeyIn } from '../../../../lib/tz.mjs';
import { lentDigest } from '../../../../lib/lent.mjs';
import { sendsDigest, MARKER_LIVE_MS } from '../../../../lib/sendcheck.mjs';

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')).version || null;
  } catch {
    return null;
  }
})();

// Ledger entries that change nothing an outbox page shows. (A coworker's note leaves the page once its task is done, and a
// send floorboss let through is no longer offered to copy: task_created, task_done and send_released are not here.)
export const NO_PAGE_EFFECT = new Set([
  'sync_ran',
  'reply_checked',
  'tool_failed',
  'tool_back',
  'crm_logged',
  'crm_log_opened',
  'crm_log_result',
  'crm_created',
  'crm_filled',
  'crm_create_ok',
  'crm_create_declined',
  'crm_import_checked',
  'voice_sample',
  'copy_rating',
  'browser_send_opened',
  'status_pasted',
  'calendar_read',
  'batch_checked',
  'fresh_attempt',
  'no_reply_said'
]);
// The shape of what is recorded: a page recorded in another shape is out of date.
const FORMAT = 3;

// A hash of the first size bytes of a file (all of it when size is its size), or 'unreadable'.
function headHash(path, size) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const h = createHash('sha256');
    const buf = Buffer.alloc(Math.min(1 << 20, Math.max(1, size)));
    for (let at = 0; at < size; ) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size - at), at);
      if (!n) return 'unreadable';
      h.update(buf.subarray(0, n));
      at += n;
    }
    return h.digest('hex').slice(0, 24);
  } catch {
    return 'unreadable';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
const statOf = (p) => {
  try {
    const s = statSync(p);
    return s.isFile() ? [s.size, s.mtimeMs] : ['not a file'];
  } catch {
    return null;
  }
};
const filesIn = (d, keep = () => true) => {
  try {
    return readdirSync(d, { withFileTypes: true })
      .filter((x) => x.isFile() && keep(x.name) && !/\.tmp-|^\./.test(x.name))
      .map((x) => join(d, x.name));
  } catch {
    return [];
  }
};
// An event's guard marks for a message (released/<id>-<touch>-<clears>, the ones lib/sendcheck.mjs counts), each with
// whether it is old enough to count (MARKER_LIVE_MS), so one that ages into counting makes the page out of date. Other
// marks in that folder (a day's mark, a staged draft's) are not read by the page.
const MARK = /^c\d+-\d+-\d+$/;
function marksIn(d) {
  let names;
  try {
    names = readdirSync(d);
  } catch (e) {
    return e?.code === 'ENOENT' ? ['marks'] : ['marks', 'unreadable'];
  }
  const out = ['marks'];
  for (const n of names.filter((x) => MARK.test(x)).sort()) {
    let at;
    try {
      at = statSync(join(d, n)).mtimeMs;
    } catch {
      continue;
    }
    out.push(`${n}:${Date.now() - at < MARKER_LIVE_MS ? 'fresh' : 'counts'}`);
  }
  return out;
}
// What another event's record is checked by: what it lends (lib/lent.mjs) and what it sent or let through
// (lib/sendcheck.mjs sendsDigest).
const othersDigest = (d) => `${lentDigest(d)}:${sendsDigest(d)}`;

// Keys sorted at every level, so the same settings always give the same digest.
const stable = (v) =>
  Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
// The user's settings as the page reads them. A connection's last check (connectors check, before each use: its time
// and result) is left out: it rewrites the file without changing anything a page shows.
function configDigest(path) {
  let cfg = null;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return e.code === 'ENOENT' ? 'none' : 'unreadable';
  }
  if (cfg && typeof cfg === 'object' && cfg.connectors && typeof cfg.connectors === 'object')
    cfg = {
      ...cfg,
      connectors: Object.fromEntries(
        Object.entries(cfg.connectors).map(([k, r]) => [k, r && typeof r === 'object' && 'verified' in r ? { ...r, verified: undefined } : r])
      )
    };
  return createHash('sha256').update(JSON.stringify(stable(cfg))).digest('hex').slice(0, 24);
}

// The folders whose every file the page records (a file added there, or taken away, is a change): this event's lists,
// mappings, drafts and research, and every other event's lists and mappings, and the events folder itself.
export function watchedFolders(dir) {
  const root = dirname(dir);
  const out = [root, ...['inputs', 'sources', 'drafts', 'profiles'].map((d) => join(dir, d)), join(dir, 'work', 'drafts')];
  let others = [];
  try {
    others = readdirSync(root).filter((s) => s !== basename(dir));
  } catch {
    others = [];
  }
  for (const s of others) out.push(join(root, s, 'inputs'), join(root, s, 'sources'));
  return out;
}

// The inputs of the page of the event in folder dir (<home>/events/<slug>), as they are now. now: the command's clock.
// Every path is found from dir, so a check run from anywhere reads the same home.
export function pageInputs(dir, now = new Date()) {
  const root = dirname(dir);
  const slug = basename(dir);
  const base = dirname(root);
  const cfgPath = join(base, 'config.json');
  const files = {};
  const ledgers = {};
  const file = (p) => {
    if (typeof p === 'string' && p) files[p] = statOf(p);
  };
  // [size, time, 1 for another event's record]; sealed when the page is written (sealPageInputs).
  const ledger = (p, elsewhere) => {
    const s = statOf(p);
    ledgers[p] = s && typeof s[0] === 'number' ? [s[0], s[1], elsewhere ? 1 : 0] : null;
  };
  const ev = readJson(join(dir, 'event.json'), null);
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) || {};
  } catch {
    cfg = {};
  }
  const settings = { ...cfg, ...(ev?.settings || {}) };
  for (const n of ['event.json', 'slots.json', 'attendees.csv', 'enriched.json']) file(join(dir, n));
  ledger(join(dir, 'ledger.jsonl'), false);
  files[join(dir, 'released')] = marksIn(join(dir, 'released'));
  for (const d of ['inputs', 'sources', 'drafts']) for (const p of filesIn(join(dir, d))) file(p);
  for (const p of filesIn(join(dir, 'profiles'), (n) => n.endsWith('.json'))) file(p);
  for (const p of filesIn(join(dir, 'work', 'drafts'))) file(p);
  file(join(dir, 'derived', 'todo.json'));
  // Lists an older event.json names, and the contacts exports the settings name.
  if (ev) for (const p of [ev.attendees_path, ev.crm?.path, ev.dnc_path, ev.accounts_path]) file(p);
  for (const p of Array.isArray(settings.known_contacts_paths) ? settings.known_contacts_paths : []) file(typeof p === 'string' ? p : p?.path);
  // The profile's skills (lib/event.mjs contextFor).
  const profile = ev?.mock ? ev?.context_profile || settings.context_profile : [ev?.context_profile, settings.context_profile].find((p) => p && !/^mock-/.test(p)) || null;
  if (profile) {
    let cdir = null;
    try {
      cdir = ev?.context_dir || (/^[a-z0-9][a-z0-9-]{0,63}$/.test(profile) ? join(base, 'context', profile) : null);
    } catch {
      cdir = null;
    }
    if (cdir) for (const n of ['who-to-meet', 'what-you-bring', 'voice']) file(join(cdir, n, 'SKILL.md'));
  }
  // Every other event: its record, settings, lists and mappings.
  let others = [];
  try {
    others = readdirSync(root).filter((s) => s !== slug);
  } catch {
    others = [];
  }
  for (const s of others.sort()) {
    const d = join(root, s);
    const e = join(d, 'event.json');
    file(e);
    if (!existsSync(e)) continue;
    ledger(join(d, 'ledger.jsonl'), true);
    files[join(d, 'released')] = marksIn(join(d, 'released'));
    for (const x of ['inputs', 'sources']) for (const p of filesIn(join(d, x))) file(p);
    // A damaged event.json there is that event's problem (its own steps say so); its size and time are watched.
    try {
      file(readJson(e, null)?.crm?.path);
    } catch {
      /* watched as a file above */
    }
  }
  let today = null;
  try {
    today = ev?.time_zone ? todayKeyIn(ev.time_zone, now) : now.toISOString().slice(0, 10);
  } catch {
    today = 'unreadable';
  }
  return { format: FORMAT, version: VERSION, today, config: configDigest(cfgPath), files, ledgers };
}

// Whether another event's record changed, or an event came or went, since inputs (pageInputs of the event in folder
// dir) were taken: what a command read of them then may not be what they hold now.
export function othersMoved(dir, inputs) {
  const was = Object.entries(inputs?.ledgers || {}).filter(([, v]) => v && v[2] === 1);
  const now = pageInputs(dir, new Date()).ledgers;
  const keys = Object.keys(now).filter((k) => now[k]?.[2] === 1);
  if (keys.length !== was.length) return true;
  return was.some(([p, v]) => !now[p] || now[p][0] !== v[0] || now[p][1] !== v[1]);
}

// What a record is checked by, added when the page is written: this event's record, a hash of all of it; another
// event's, the digest of what it lends (lib/lent.mjs). Taken from the files as they are now, which is what the build
// read only if they are still as they were when the inputs were taken (before the build read anything): one that
// changed meanwhile is marked so, and the next check finds the page out of date.
export function sealPageInputs(inputs) {
  const ledgers = {};
  for (const [p, v] of Object.entries(inputs.ledgers || {})) {
    if (!v || v.length !== 3) {
      ledgers[p] = v;
      continue;
    }
    const now = statOf(p);
    const same = !!now && now[0] === v[0] && now[1] === v[1];
    ledgers[p] = [v[0], v[1], v[2], !same ? 'changed' : v[2] ? othersDigest(dirname(p)) : headHash(p, v[0])];
  }
  return { ...inputs, ledgers };
}

// This event's record grew by lines the page never reads, and the part read is as it was (all of it): true.
function grewQuietly(path, was, now) {
  if (!was || !now || now[0] <= was[0] || was[3] === 'changed' || headHash(path, was[0]) !== was[3]) return false;
  let text;
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(now[0] - was[0]);
      readSync(fd, buf, 0, buf.length, was[0]);
      text = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  return text
    .split('\n')
    .filter((l) => l.trim())
    .every((l) => {
      try {
        const e = JSON.parse(l);
        return !!e && typeof e === 'object' && NO_PAGE_EFFECT.has(e.type);
      } catch {
        return false;
      }
    });
}
// Another event's record changed in a way that lends this page nothing new: what it lends is as it was.
const lendsTheSame = (path, was) => !!was && was[3] !== 'changed' && othersDigest(dirname(path)) === was[3];

const sidecar = (paths) => join(paths.derived, 'outbox-inputs.json');
export const buildIdOf = (inputs) => createHash('sha256').update(JSON.stringify(inputs)).digest('hex').slice(0, 20);
// Written by renderFile before the page itself, with the page's build id: a page whose id isn't the sidecar's (two
// writers crossed, or a write was cut short) is out of date. failed: the page could not be built from these inputs (it
// says it is out of date): it is tried again when one of them changes, or at a step at its own event.
export function savePageInputs(paths, inputs, build, { failed = null } = {}) {
  writeJson(sidecar(paths), { build, ...inputs, ...(failed ? { failed: String(failed).slice(0, 300) } : {}) });
}
const BUILD_META = /<meta name="floorboss-build" content="([0-9a-f]{20})">/;
const pageBuild = (p) => {
  try {
    return (BUILD_META.exec(readFileSync(p, 'utf8').slice(0, 4000)) || [])[1] || null;
  } catch {
    return null;
  }
};

// Is the page as current as its inputs? { current: true } or { current: false, why }. advance: when a record only grew
// quietly, or another event's record lends the same, the sidecar is moved on to it (the caller holds the page's lock),
// so the next check reads nothing again. retryFailed: a page that could not be built from these inputs counts as out of
// date (a step at its own event tries it again; a write at another event leaves it be).
export function pageCurrent(paths, now = new Date(), { advance = false, retryFailed = false } = {}) {
  if (!existsSync(paths.outbox)) return { current: false, why: 'no page' };
  const build = pageBuild(paths.outbox);
  const saved = readJson(sidecar(paths), null);
  if (!build || !saved || saved.build !== build) return { current: false, why: 'the page and what it was built from do not match' };
  if (saved.format !== FORMAT) return { current: false, why: 'recorded in an older shape' };
  if (saved.failed && retryFailed) return { current: false, why: 'it could not be built last time' };
  const nowIn = pageInputs(dirname(paths.outbox), now);
  for (const k of ['version', 'today', 'config']) if (saved[k] !== nowIn[k]) return { current: false, why: k };
  const a = saved.files || {};
  const b = nowIn.files;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return { current: false, why: 'files added or removed' };
  for (const k of ka) if (!(k in b) || JSON.stringify(a[k]) !== JSON.stringify(b[k])) return { current: false, why: k };
  const la = saved.ledgers || {};
  const lb = nowIn.ledgers;
  if (Object.keys(la).length !== Object.keys(lb).length) return { current: false, why: 'events added or removed' };
  const moved = {};
  for (const k of Object.keys(la)) {
    if (!(k in lb)) return { current: false, why: k };
    const was = la[k];
    const is = lb[k];
    if (!was || !is) {
      if (JSON.stringify(was) === JSON.stringify(is)) continue;
      return { current: false, why: k };
    }
    if (was[0] === is[0] && was[1] === is[1]) continue;
    if (was[2] ? !lendsTheSame(k, was) : !grewQuietly(k, was, is)) return { current: false, why: k };
    moved[k] = [is[0], is[1], was[2], was[2] ? was[3] : headHash(k, is[0])];
  }
  if (Object.keys(moved).length && advance) savePageInputs(paths, { ...saved, ledgers: { ...la, ...moved } }, build, { failed: saved.failed || null });
  return { current: true, ...(saved.failed ? { failed: saved.failed } : {}) };
}
