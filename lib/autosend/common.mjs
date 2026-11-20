// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// What the auto-send units share: where an event's files are, which events have auto-send on, the approvals that are
// live, and the step marks (released, sent, unclear) as the ledger has them. Auto-send is for Codex only, Gmail only,
// from the user's own ChatGPT cloud task (2026-11-20 design). Nothing here sends or reaches the network.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { home as defaultHome, SLUG_RE } from '../paths.mjs';
import { readLedger, fold } from '../ledger.mjs';
import { harness } from '../harness.mjs';

// The sentence the second yes must be, as the user types it.
export const SENTENCE = 'auto-send these sequences';
// What Claude Code is told when an auto-send command is run there.
export const NOT_HERE = 'auto-send is for Codex; Claude Code has its own sending';
// Claude Code (CLAUDECODE=1 with no Codex marker) refuses every auto-send command. Codex and an unknown program (the
// cloud task's shell, whose markers aren't documented) may run them.
export const refusedHere = (env = process.env) => (harness(env) === 'claude-code' ? NOT_HERE : null);

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
// The user's words, as compared: case, runs of spaces and trailing punctuation aside; curly quotes and dashes plain.
export const normalised = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’“”"'`]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?,;:\s]+$/, '');

export const eventDirOf = (home, slug) => join(home, 'events', slug);
export const ledgerOf = (evDir) => join(evDir, 'ledger.jsonl');
export function eventJson(evDir) {
  try {
    return JSON.parse(readFileSync(join(evDir, 'event.json'), 'utf8'));
  } catch {
    return null;
  }
}

// The events in this data folder with auto-send on (event.json autosend: true), by slug, sorted.
export function autosendEvents(home = defaultHome()) {
  let slugs = [];
  try {
    slugs = readdirSync(join(home, 'events'));
  } catch {
    slugs = [];
  }
  return slugs
    .filter((s) => SLUG_RE.test(s) && existsSync(join(home, 'events', s, 'event.json')))
    .sort()
    .map((slug) => ({ slug, dir: eventDirOf(home, slug), event: eventJson(eventDirOf(home, slug)) }))
    .filter((x) => x.event?.autosend === true);
}

export function readEvent(evDir) {
  const { entries, damaged } = readLedger(ledgerOf(evDir));
  return { entries, damaged, folded: fold(entries, damaged) };
}

// The approved draft for a hash (drafts/<hash>.json), or null.
export function draftOf(evDir, hash) {
  if (!/^[0-9a-f]{24}$/.test(String(hash || ''))) return null;
  try {
    return JSON.parse(readFileSync(join(evDir, 'drafts', `${hash}.json`), 'utf8'));
  } catch {
    return null;
  }
}

const same = (e, id, touch) => e?.id === id && (e.touch ?? 1) === touch;

// The latest second yes for this step, live or not, with its place in the ledger: { a, at } or null.
export function lastApproval(entries, id, touch) {
  let at = -1;
  let a = null;
  entries.forEach((e, i) => {
    if (e?.type === 'autosend_approved' && same(e, id, touch)) {
      a = e;
      at = i;
    }
  });
  return a ? { a, at } : null;
}
// A message to them recorded sent by anything but auto-send (by hand, from the outbox, by the guard) after line at: the
// user took the sequence over, so auto-send ends there for the rest of it until a fresh yes. (A meeting confirmation
// is no step of the sequence.) Auto-send's own sends, and "it went" for one of them (settle), are source autosend.
export const handSentAfter = (entries, id, at) => entries.some((e, i) => i > at && e?.type === 'sent' && e.id === id && (e.touch ?? 1) !== 0 && e.source !== 'autosend');

// The second yes for this step that still stands, or null: the latest autosend_approved for it, with no
// autosend_revoked for the person after it, and no message to them sent another way after it.
export function liveApproval(entries, id, touch) {
  const l = lastApproval(entries, id, touch);
  if (!l) return null;
  if (entries.some((e, i) => i > l.at && e?.type === 'autosend_revoked' && e.id === id)) return null;
  if (handSentAfter(entries, id, l.at)) return null;
  return l.a;
}

// The day auto-send sends a step, worked out one way for the planner (plan.mjs), the outbox card (cards.mjs) and the
// readback (approval.mjs): the first message of a sequence on its planned day; a follow-up never before the follow-up
// rule's day (ruleDay), and on the yes's planned day when that is later (a fresh yes after a missed day plans it
// again). null: no day (a follow-up whose rule gives none yet).
export function autosendDueDay(a, { first, ruleDay }) {
  if (!a) return null;
  if (first) return a.planned_due || null;
  if (!ruleDay) return null;
  return a.planned_due && a.planned_due > ruleDay ? a.planned_due : ruleDay;
}

// A live second yes that is for the text and address the step has now: what the outbox card reads (no buttons; it
// goes on its day).
export function autosendLive(entries, folded, id, touch) {
  const a = liveApproval(entries, id, touch);
  const x = folded?.people?.[id]?.touches?.[touch];
  if (!a || !x || x.sent) return null;
  // Let go once already (settled, or not): auto-send never sends it again, so the card isn't the cloud's.
  if (everReleased(entries, id, touch)) return null;
  if (a.hash !== x.hash || x.approved?.hash !== a.hash || String(x.approved?.to || '') !== String(a.to || '')) return null;
  return a;
}

// A release the run that made it took back before its send step was shown (autosend_withdrawn, same run, after it):
// it never went. Every other release counts, whatever is recorded about it later.
const withdrawnAfter = (entries, i, e) => entries.some((w, j) => j > i && w?.type === 'autosend_withdrawn' && same(w, e.id, e.touch ?? 1) && w.run === e.run);

// Where a step stands for auto-send, from its lines in order: 'released' (let go, nothing recorded since: it may
// have gone), 'unclear' (the send tool's answer didn't say it went, and the user hasn't settled it), or null.
// A sent, a bounce or a release_cleared (the user's "it didn't go") settles it, and so does a withdrawn release.
export function stepMark(entries, id, touch) {
  let mark = null;
  for (const e of entries) {
    if (!same(e, id, touch)) continue;
    if (e.type === 'autosend_released') mark = 'released';
    else if (e.type === 'autosend_withdrawn') mark = mark === 'released' ? null : mark;
    else if (e.type === 'send_unclear') mark = mark === 'released' || mark === 'unclear' ? 'unclear' : mark;
    else if (['sent', 'bounced', 'release_cleared'].includes(e.type)) mark = null;
  }
  return mark;
}

// Every step at this event that was let go by auto-send and not settled: [{ id, touch, mark }].
export function unsettled(entries) {
  const steps = new Set(entries.filter((e) => e?.type === 'autosend_released').map((e) => `${e.id}:${e.touch ?? 1}`));
  const out = [];
  for (const k of steps) {
    const [id, t] = k.split(':');
    const mark = stepMark(entries, id, Number(t));
    if (mark) out.push({ id, touch: Number(t), mark });
  }
  return out;
}

// The releases that count (a withdrawn one never went): [entry].
export const releasesOf = (entries) => entries.filter((e, i) => e?.type === 'autosend_released' && !withdrawnAfter(entries, i, e));
export const everReleased = (entries, id, touch) => releasesOf(entries).some((e) => same(e, id, touch));

// Claude Code sends email for this data folder (its sending setting, in config.json or in the event's own settings):
// auto-send can't be on as well, since Claude Code's guard doesn't read auto-send's marks and could send the same step.
// Read from the files as written (config.json raw), whatever Codex's effective settings blank. A plain reason, or null.
export function claudeSendsEmail(home, ev) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  } catch {
    raw = {};
  }
  const chans = [raw?.sending?.channels, ev?.settings?.sending?.channels].flatMap((c) => (Array.isArray(c) ? c : []));
  return chans.includes('email') ? "Claude Code sends email for this data folder (its sending setting is on): auto-send holds every message until it is off again in Claude Code" : null;
}

// A cut of the list (keep, a cap) or a new decision about this person after this second yes: the shortlist may have
// changed, so that yes no longer stands; a fresh readback and yes clear it.
export const listChangedSince = (entries, a, id) => {
  const at = entries.indexOf(a);
  return at >= 0 && entries.some((e, i) => i > at && (e?.type === 'keep' || e?.type === 'cap' || (e?.type === 'decide' && e.id === id)));
};

// How long after the search was given to the model its send may still be shown: the reply check is only as fresh as
// that search.
export const FRESH_MS = 3 * 60 * 1000;

// The data format auto-send writes (stamped in autosend/format.json by lib/autosend/sync.mjs): raised whenever a
// record a pinned older floorboss wouldn't read rightly is added (2: autosend_withdrawn). A repo stamped higher than
// this is refused.
export const DATA_FORMAT = 2;

// The times a saved draft offers: the slot_ids of the drafted ledger line for exactly that hash (the save step writes
// them there, [] for none; the draft file holds the text only), as the guard reads them (lib/sendcheck.mjs
// verifySend). null when they can't be read: no drafted line for that text, or one with no list of slot ids. Never
// read as "no times".
export function offeredTimes(entries, id, touch, hash) {
  const dr = (entries || []).filter((e) => e?.type === 'drafted' && e.id === id && (e.touch ?? 1) === touch && e.hash === hash).pop();
  if (!dr || !Array.isArray(dr.slot_ids) || dr.slot_ids.some((x) => typeof x !== 'string' || !x)) return null;
  return dr.slot_ids;
}
// The times an approved draft offers that someone else has booked since (their meeting's slot, and every slot it
// overlaps): [slot ids], empty when none (or when its times can't be read: pastTimes holds that). Read from the
// ledger as folded, as the outbox's own taken test does.
export function takenTimes(entries, folded, id, touch, hash) {
  const offered = offeredTimes(entries, id, touch, hash) || [];
  if (!offered.length) return [];
  const taken = new Set();
  for (const [pid, p] of Object.entries(folded?.people || {}))
    if (pid !== id && p.booked && !p.stopped) for (const s of [p.booked, ...(p.booked_blocks || [])]) taken.add(s);
  return offered.filter((s) => taken.has(s));
}
// The times an approved draft offers that are already past (the event's slots.json), or null when they can't be read:
// its offered times can't be found, slots.json can't be read, or a slot it offers isn't in it.
export function pastTimes(evDir, entries, id, touch, hash, nowMs) {
  const offered = offeredTimes(entries, id, touch, hash);
  if (offered === null) return null;
  if (!offered.length) return [];
  let slots;
  try {
    slots = JSON.parse(readFileSync(join(evDir, 'slots.json'), 'utf8')).slots;
  } catch {
    return null;
  }
  if (!Array.isArray(slots)) return null;
  const start = Object.fromEntries(slots.filter((x) => x && typeof x.id === 'string').map((x) => [x.id, Date.parse(x.start)]));
  if (offered.some((x) => !Number.isFinite(start[x]))) return null;
  return offered.filter((x) => start[x] <= nowMs);
}
export const TIMES_UNREAD = "floorboss can't read its offered times (the times it offers aren't on its saved draft's line, or aren't in slots.json): held until it is written again (flow next) and you approve it, then a fresh auto-send yes";
// The exact command that records a message the user sent themselves (event-outreach record, what sent): never settle,
// which is for a step auto-send let go. FLOORBOSS is the plugin folder, as the skill writes it.
export const handSentCommand = (slug, id, touch) =>
  `node "FLOORBOSS/skills/event-outreach/scripts/cli.mjs" record --event ${slug} --file <a file in ~/.floorboss/work/ holding {"items":[{"who":"${id}","what":"sent","touch":${touch},"date":"<the day they sent it, YYYY-MM-DD>"}]}>`;
export const TIME_TAKEN = 'a time it offers is now booked with someone else: held until floorboss writes it again with free times (flow next) and you approve it, then a fresh auto-send yes';
