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

// What Claude Code is told when an auto-send command it doesn't run is run there.
export const NOT_HERE = 'this auto-send command is for Codex; in Claude Code, auto-send goes through a daily Claude routine';
// Claude Code (CLAUDECODE=1 with no Codex marker) runs the daily Claude routine's commands (lib/autosend/routine.mjs),
// which only Claude Code runs, and the laptop steps of an event set to send that way (CLAUDE_COMMANDS: each refuses
// any other event there). It refuses every other auto-send command. Codex and an unknown program (the cloud task's
// shell, whose markers aren't documented) may run the others. sub: the command.
export const ROUTINE_COMMANDS = Object.freeze(['routine-body', 'routine-saved', 'routine-status', 'routine-checked']);
export const CLAUDE_COMMANDS = Object.freeze(['on', 'readback', 'approve', 'revoke', 'drafts', 'draft-gone', 'remote']);
export const ROUTINE_ONLY_HERE = 'the daily Claude routine is for Claude Code';
export const refusedHere = (env = process.env, sub = null) => {
  const routine = ROUTINE_COMMANDS.includes(sub);
  if (harness(env) === 'claude-code') return routine || CLAUDE_COMMANDS.includes(sub) ? null : NOT_HERE;
  return routine ? ROUTINE_ONLY_HERE : null;
};
// An event set to auto-send through a daily Claude routine (Claude Code only; lib/autosend/routine.mjs ROUTINE_MODE).
export const ROUTINE = 'routine';
export const inClaudeCode = (env = process.env) => harness(env) === 'claude-code';
// In Claude Code an auto-send command is for a routine event only; in Codex never for one. A plain reason, or null.
export function hostWhy(ev, env = process.env) {
  const routine = ev?.autosend_mode === ROUTINE;
  if (inClaudeCode(env)) return routine ? null : NOT_HERE;
  return routine ? ROUTINE_ONLY_HERE : null;
}
// Auto-send is set up for this event in this host (pick 1 is offered): on, in the host's own mode.
export const autosendReady = (ev, env = process.env) => ev?.autosend === true && !hostWhy(ev, env);

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
// A Claude Code auto-send run lets message 1 go through Claude Code's own send (autosend_released, host claude-code,
// before the guard's send check and its prompt): the sent line that follows, with that text, is auto-send's own.
const claudeRelease = (entries, at, i, e) => entries.slice(at + 1, i).some((r) => r?.type === 'autosend_released' && r.host === 'claude-code' && same(r, e.id, e.touch ?? 1) && r.hash === e.hash);
export const handSentAfter = (entries, id, at) => entries.some((e, i) => i > at && e?.type === 'sent' && e.id === id && (e.touch ?? 1) !== 0 && e.source !== 'autosend' && !claudeRelease(entries, at, i, e));

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
// An event set to send through a daily Claude routine is Claude Code's own: its first emails go through Claude Code's
// send (and its guard) at the second yes, and Claude Code lists none of its other auto-send steps to send.
export function claudeSendsEmail(home, ev) {
  if (ev?.autosend_mode === ROUTINE) return null;
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  } catch {
    raw = {};
  }
  const chans = [raw?.sending?.channels, ev?.settings?.sending?.channels].flatMap((c) => (Array.isArray(c) ? c : []));
  return chans.includes('email') ? "Claude Code sends email for this data folder (its sending setting is on): auto-send holds every message until it is off again in Claude Code" : null;
}

// An event sending through a daily Claude routine, in Claude Code's send list: a step with a standing auto-send yes is
// the routine's, so Claude Code doesn't send it too; message 1 that a Claude Code auto-send run let go (its release,
// not settled since) is the one listed. A plain reason, or null.
// Once auto-send is stopped for a step (a revoke, a message sent another way), its Gmail draft may still be in the
// routine's queue, and the routine sends it on its day: until floorboss knows that draft is gone from Gmail
// (routineDraftsLeft), the step stays the routine's here too, so it can't go twice.
// hash: the step's text now; with it, the yes counts only while pick 1 is the pick that stands (routineYes).
export function routineHeld(ev, entries, id, touch, hash = undefined) {
  if (ev?.autosend_mode !== ROUTINE) return oldRoutineDrafts(ev, entries, id, touch).length ? ROUTINE_DRAFT_LEFT : null;
  const yes = hash === undefined ? liveApproval(entries, id, touch) : routineYes(entries, id, touch, hash);
  if (!yes) return routineDraftsLeft(entries, id, touch).length ? ROUTINE_DRAFT_LEFT : null;
  if (ev?.autosend !== true) return null;
  if (touch === 1 && stepMark(entries, id, 1) === 'released' && releasesOf(entries).some((e) => same(e, id, 1) && e.host === 'claude-code')) return null;
  return 'auto-send has it: the daily routine sends it on its day (stop auto-send for them to send it yourself)';
}

export const ROUTINE_DRAFT_LEFT =
  "its Gmail draft is still queued for the daily routine, which could send it: delete it first (the delete step floorboss gives at the stop, or at routine-status), or delete it by hand in Gmail Drafts and then run that delete step (if the delete says it isn't there and it was due today or earlier, routine-status checks Sent; if the user checked Gmail Sent and Drafts and it is in neither, autosend draft-gone with their words)";
// A Gmail draft recorded gone: deleted by a delete_draft the guard read the answer of, or found missing (the guard's
// reading of get_draft, or the laptop's reconciliation).
export const DRAFT_GONE_TYPES = Object.freeze(['autosend_draft_deleted', 'autosend_draft_bad']);
const DRAFT_ID = /^[\w-]{1,128}$/;
// The Gmail drafts the daily routine may still send: the latest autosend_drafted of each step (of this one when id and
// touch are given) with a draft id, its step not recorded sent and the draft not recorded gone. [entry]
export function routineDraftsLeft(entries, id = null, touch = null) {
  const latest = new Map();
  for (const e of entries) if (e?.type === 'autosend_drafted' && (id == null || same(e, id, touch))) latest.set(`${e.id}:${e.touch ?? 1}`, e);
  const gone = new Set(entries.filter((e) => DRAFT_GONE_TYPES.includes(e?.type) && e.draft_id).map((e) => e.draft_id));
  return [...latest.values()].filter((e) => DRAFT_ID.test(String(e.draft_id || '')) && !gone.has(e.draft_id) && !entries.some((s) => s?.type === 'sent' && same(s, e.id, e.touch ?? 1)));
}

// An event switched away from a daily Claude routine (autosend on --mode, audit run 11): the routine in the user's
// Claude account keeps its prompt, so the Gmail drafts it was given up to the switch (autosend_routine_until, set by
// on) may still go, whatever the mode says now. Those still left: [entry]. [] for an event that was never one.
export function oldRoutineDrafts(ev, entries, id = null, touch = null) {
  if (ev?.autosend_mode === ROUTINE) return [];
  const until = Date.parse(String(ev?.autosend_routine_until || ''));
  if (!Number.isFinite(until)) return [];
  return routineDraftsLeft(entries, id, touch).filter((e) => !(Date.parse(String(e.at || '')) > until));
}

// The other two approvals the choice records (pick.mjs): put in Gmail drafts (drafts_approved, one line per message),
// and "I'll send them myself" (send_choice). Neither is an auto-send yes: nothing sends from them.
export const DECISION_TYPES = Object.freeze(['drafts_approved', 'send_choice']);
// The latest of those for this step, standing: for this text, no stop for the person and no change of the list since.
export function decisionFor(entries, id, touch, hash) {
  let at = -1;
  entries.forEach((e, i) => {
    if (DECISION_TYPES.includes(e?.type) && e.id === id && (e.touch ?? 1) === touch) at = i;
  });
  const d = entries[at];
  if (!d || d.hash !== hash) return null;
  if (entries.some((e, i) => i > at && e?.type === 'autosend_revoked' && e.id === id)) return null;
  if (listChangedSince(entries, d, id)) return null;
  return d;
}

// Which of the final approval's picks stands for this step now: 'drafts' (pick 2: in Gmail Drafts, floorboss never
// sends it), 'self' (pick 3: the user sends it from the outbox), 'auto' (pick 1's live yes), or null. The latest of
// them wins: a pick 1 for a fresh readback after pick 2 or 3 is auto-send's again, and the other way round.
// A pick 1 counts only while its yes is live and the list hasn't changed since: an older pick 1 never comes back when a
// newer pick 2 or 3 lapses.
// textBound (the daily Claude routine): pick 1's yes counts only for the text it was given for (audit run 11), so an
// edit after it, or after a later pick 2 or 3, leaves no pick standing until a fresh choice.
export function standingPick(entries, id, touch, hash, { textBound = false } = {}) {
  const d = decisionFor(entries, id, touch, hash);
  const live = liveApproval(entries, id, touch);
  const auto = live && !listChangedSince(entries, live, id) && (!textBound || live.hash === hash);
  const autoAt = auto ? lastApproval(entries, id, touch).at : -1;
  if (d && entries.indexOf(d) > autoAt) return d.type === 'drafts_approved' ? 'drafts' : 'self';
  return auto ? 'auto' : null;
}

// The daily routine's yes for a step (an event sending through a daily Claude routine): pick 1's live yes, while it is
// the pick that stands (no newer pick 2 or 3, no change of the list since). null: the routine has no yes for it, and a
// Gmail draft of it still queued is to be deleted (routine.mjs routineDeletes).
// Text-bound: a yes for an earlier text of the step is no yes here.
export function routineYes(entries, id, touch, hash) {
  return standingPick(entries, id, touch, hash, { textBound: true }) === 'auto' ? liveApproval(entries, id, touch) : null;
}

// Why Claude Code's send list (and its guard) never sends a step now, from the final approval, or null: the user's pick 2
// or 3 stands for it, or, at an event sending through a daily Claude routine, no pick stands for this email at all (the
// final approval comes first: outside sending hours its readback waits for them). A pick 1 step is routineHeld's.
export const PICK_WHY = Object.freeze({
  drafts: 'you chose Gmail drafts at the final approval: floorboss never sends it; it waits in your Gmail Drafts for you to press Send',
  self: "you chose to send it yourself at the final approval: floorboss never sends it; it is on the outbox page with its copy buttons",
  none: "it waits for your choice at the final approval (how the messages go): flow next asks it, or says when it can (sending hours are weekdays 09:00 to 17:00 in the event's time zone)"
});
export function pickHold(ev, entries, id, touch, hash, to) {
  if (!(touch >= 1)) return null;
  const pick = standingPick(entries, id, touch, hash, { textBound: ev?.autosend_mode === ROUTINE });
  if (pick === 'drafts' || pick === 'self') return PICK_WHY[pick];
  if (pick === null && ev?.autosend === true && ev?.autosend_mode === ROUTINE && /@/.test(String(to || ''))) return PICK_WHY.none;
  return null;
}


// A cut of the list (keep, a cap) or a new decision about this person after this second yes: the shortlist may have
// changed, so that yes no longer stands; a fresh readback and yes clear it.
export const listChangedSince = (entries, a, id) => {
  const at = entries.indexOf(a);
  return (
    at >= 0 &&
    entries.some(
      (e, i) =>
        i > at &&
        (e?.type === 'keep' ||
          e?.type === 'cap' ||
          (e?.type === 'decide' && e.id === id) ||
          // A do-not-contact or opt-out hold seen on them since (spec 0.1.7 F2): contactable refuses them as well.
          (e?.type === 'hold_seen' && e.id === id && ['do_not_contact', 'opted_out'].includes(e.rung) && !/bounced/.test(e.says || '')))
    )
  );
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
