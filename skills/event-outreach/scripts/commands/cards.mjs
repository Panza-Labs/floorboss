// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The outbox page: one card per message, rendered for the user to read before approving.
import { spawn } from 'node:child_process';
import { existsSync, statSync, readFileSync, lstatSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { files, nowFrom } from '../../../../lib/event.mjs';
import { withLock } from '../../../../lib/lock.mjs';
import { append } from '../../../../lib/ledger.mjs';
import { plainText } from '../../../../lib/reading.mjs';
import { pageCurrent, savePageInputs, sealPageInputs, buildIdOf, pageInputs } from './page-inputs.mjs';
import { need } from '../../../../lib/args.mjs';
import { readJson, writeText } from '../../../../lib/jsonio.mjs';
import { slotLabel } from '../../../slot-finder/scripts/slots.mjs';
import { holdersBySlot } from '../../../slot-finder/scripts/assign.mjs';
import { profileMeta } from '../../../attendee-research/scripts/profiles.mjs';
import { MODES } from '../leadtime.mjs';
import { gapFor, noDayWhy, stateOf } from '../../../../lib/spacing.mjs';
import { INSTRUCTION_LIKE } from '../../../crm-triage/scripts/view.mjs';
import { touchBefore } from '../../../../lib/route.mjs';
import { renderOutbox, renderOutOfDate, mailOf } from '../outbox.mjs';
import { hashOf, pickAt, whereAt } from './routes.mjs';
import { isOut, labelOf, ctxOf, colleagueTold, takenTest } from './context.mjs';
import { savedDraft, readTodo, draftFiles, ledgerTouch, followupDayOf, laterSent } from './saved-drafts.mjs';
import { addressBusyToday, busyWhy, homeSends } from '../../../../lib/sendcheck.mjs';
import { autosendLive, stepMark, autosendDueDay } from '../../../../lib/autosend/common.mjs';
import { sessionWhy } from '../../../../lib/autosend/sync.mjs';
import { addDays } from '../../../../lib/tz.mjs';

function cardsFrom(c, jobs, { pendingOnly }) {
  const cards = [];
  let sends = null; // every event's sends, read once, for the first card that needs them
  for (const j of jobs) {
    // The card's text and verdict are the ledger's: the fingerprinted text of the latest save, which for the
    // outbox is the approved one. A working copy changed since (by hand) has no card: what the outbox offers
    // as approved is only ever what was approved.
    const d = savedDraft(c, j.id, j.touch, readJson(j.draft_file, null));
    if (!d) continue;
    // Every card, the review page's included, is for someone who may still be contacted.
    if (c.blocked(j.id, d.kind === 'coordinate' ? 'coordinate' : 'message')) continue;
    const st = c.state[j.id]?.touches?.[j.touch]?.status;
    // Approved, for the text saved now: the only card the page offers to copy.
    const ready = isOut(st) && c.state[j.id]?.touches?.[j.touch]?.approved?.hash === hashOf(c, d);
    if (pendingOnly === false && !ready) continue;
    // The review page is what's offered for a yes: a draft that failed the critic twice isn't on it (todo and
    // the gate list it as held for the user). Nor is a message already sent, or one to someone who replied or booked
    // (a drafting list older than those).
    if (pendingOnly && j.critic_held && !isOut(st)) continue;
    const p = c.state[j.id] || {};
    if (pendingOnly && (p.sent?.[j.touch] || (j.kind !== 'confirmation' && j.kind !== 'coordinate' && (p.replied || p.booked)))) continue;
    // An email to someone whose address bounced, with no new one: nothing to send it to.
    if (j.kind !== 'coordinate' && j.channel === 'email' && c.folded?.people?.[j.id]?.bounced) continue;
    const ct = c.byId[j.id];
    const due = dueOf(c, j, d);
    // Can't go any more, and why: the event is over (any message), or this follow-up has no day left.
    const notGoing = stateOf(c).state !== 'ok' ? stateOf(c).why : due && !due.day && !due.waits ? noDayWhy(due) : undefined;
    // One message a day to a person across all your events (the guard's rule, lib/sendcheck.mjs addressBusyToday): an
    // approved message that is due today, to an address another event wrote to today, waits for another day, with the
    // reason and nothing to copy. (A meeting confirmation is the one exception.)
    let notToday;
    if (pendingOnly === false && !notGoing && j.kind === 'message' && j.touch > 0 && !(due && (due.waits || !due.day || due.day > c.today))) {
      const to = c.state[j.id]?.touches?.[j.touch]?.approved?.to || (j.channel === 'email' ? ct.email : ct.profile_url);
      if (to) {
        sends ||= homeSends();
        const busy = addressBusyToday(c.paths.dir, to, c.now.getTime(), j.id, sends);
        if (busy) notToday = busyWhy(busy, ct.name || j.id, to);
      }
    }
    // floorboss let this message through to send and no receipt says what happened (the call may have timed out,
    // failed, or the session ended): it may have gone, so it is never offered to copy (the send check refuses it too).
    const tc = c.state[j.id]?.touches?.[j.touch];
    // The same for a step the cloud's auto-send let go (lib/autosend/): released, or its send unclear, and not settled.
    const autoMark = j.kind !== 'coordinate' && !c.state[j.id]?.sent?.[j.touch] ? stepMark(c.entries, j.id, j.touch) : null;
    const mayHaveGone = j.kind !== 'coordinate' && tc?.released && !c.state[j.id]?.sent?.[j.touch] ? tc.released_at || true : autoMark ? true : null;
    // Auto-send's second yes stands for this exact text: the cloud sends it on its day (no buttons), unless that day
    // and the day after are gone (missed: it comes back to the user, with its buttons, and readback can plan it
    // again), or a time it offers was booked by someone else since (held, until it is written again).
    const { live, day: autoDue, missed: autoMissed } = autosendCard(c, j, due);
    cards.push({
      kind: j.kind,
      id: j.id,
      touch: j.touch,
      name: ct.name,
      title: ct.title,
      company: ct.company,
      holder: j.holder,
      channel: j.kind === 'coordinate' ? 'note' : j.channel,
      address: ct.email,
      // Where the send buttons address it (outbox.mjs mailOf): the address it was approved to go to, else the list's.
      send_to: j.kind !== 'coordinate' && j.channel === 'email' ? c.state[j.id]?.touches?.[j.touch]?.approved?.to || ct.email : undefined,
      // The user sends this email themselves (email isn't one of the channels floorboss sends on for this event, as in
      // Codex, or with sending off): only then does the page offer to open it in their mail app. With email sending
      // on, floorboss sends it after a prompt, and a button to send it by hand too could send it twice.
      you_send: j.kind !== 'coordinate' && j.channel === 'email' && !(c.settings.sending?.channels || []).includes('email') ? true : undefined,
      profile_url: ct.profile_url,
      routed: pickAt(c, j.id, j.touch) || undefined,
      // Where a paste message goes: where it was approved to go, else where the route sends it now.
      where: j.kind !== 'coordinate' && j.channel === 'paste' ? c.state[j.id]?.touches?.[j.touch]?.approved?.where || whereAt(c, j.id, j.touch) : undefined,
      // Research couldn't confirm they're at this company: check their profile before sending.
      identity_unconfirmed: profileMeta(c.paths.dir, j.id)?.identity_confirmed === false || undefined,
      // Their list entry reads like an instruction to an AI (a planted note): flagged on the card too, not only at load.
      instruction_like: INSTRUCTION_LIKE.test(`${ct.notes || ''} ${ct.title || ''} ${ct.company || ''}`) || undefined,
      planned_due: d.planned_due || undefined,
      // The day this follow-up goes, as send-list and the guard work it out (null: once the message before it goes).
      due_on: due?.day,
      due_waits: due?.waits || undefined,
      not_going: notGoing,
      // Not today, and why: another event wrote to that address today.
      not_today: notToday,
      may_have_gone: mayHaveGone ? (typeof mayHaveGone === 'string' ? mayHaveGone : 'yes') : undefined,
      // The user's second yes stands for this exact text and address: the cloud run sends it on its day (no buttons).
      autosend: live && !autoMissed && !j.time_taken ? true : undefined,
      autosend_missed: live && autoMissed && !j.time_taken ? autoDue : undefined,
      time_taken: j.time_taken ? true : undefined,
      // An event-app note whose times live in the app's request: the card says which time to pick.
      pick_in_app:
        (j.kind === 'message' || j.kind === 'confirmation') &&
        j.channel === 'paste' &&
        whereAt(c, j.id, j.touch) !== 'LinkedIn' &&
        c.settings.app_note_times === 'in_app'
          ? (j.slot_ids || d.slot_ids || []).map((x) => labelOf(c, x))
          : undefined,
      brief: d.brief || j.reason,
      verdict: j.kind === 'coordinate' ? null : d.verdict,
      mode: j.mode || d.mode ? MODES[j.mode || d.mode].label : null,
      subject: d.subject,
      body: d.body,
      earliest: j.earliest || d.earliest,
      followup_note: dueNote(j.followup_note || d.followup_note, due, c, j),
      slots: (j.slot_ids || d.slot_ids || []).map((id) => ({ id, label: labelOf(c, id) })),
      pending: !ready,
      staged: c.state[j.id]?.touches?.[j.touch]?.staged || c.state[j.id]?.touches?.[j.touch]?.stage_released ? true : undefined,
      // Put in the drafts by an unattended run (the guard's own record): the card says so.
      staged_unattended: c.state[j.id]?.touches?.[j.touch]?.stage_released?.unattended || c.state[j.id]?.touches?.[j.touch]?.staged?.unattended ? true : undefined,
      // Still failing floorboss's own checks after three rewrites: said on the card, never passed on in silence.
      checks_stuck: j.kind === 'message' && d.checks?.length && (d.attempts || 0) >= 3 ? d.checks : undefined
    });
  }
  return cards;
}

// A follow-up's day (the one rule, lib/spacing.mjs followupDay), for a message after the first; undefined for anything else.
// Where auto-send stands for a card: live (the second yes that stands for this text, or null), day (the day the cloud
// sends it, worked out as the planner does: lib/autosend/common.mjs autosendDueDay) and missed (that day and the day
// after went by: it is the user's again, with its buttons). due: the follow-up rule's day for the card (dueOf).
export function autosendCard(c, j, due) {
  const live = j.kind === 'message' ? autosendLive(c.entries, c.folded, j.id, j.touch) : null;
  const day = live ? (j.touch === 1 ? autosendDueDay(live, { first: true }) : autosendDueDay(live, { first: false, ruleDay: due?.day })) : null;
  return { live, day, missed: !!(live && day && c.today && c.today > addDays(day, 1)) };
}
function dueOf(c, j, d) {
  if (j.kind !== 'message' || !(j.touch > 1) || c.state[j.id]?.sent?.[j.touch]) return undefined;
  return followupDayOf(c, j.id, j.touch, d);
}
// The note's "planned for <day>" says the day worked out now: the gap may have changed since it was planned.
function dueNote(note, due, c, j) {
  if (!note || !due || !/planned for \d{4}-\d{2}-\d{2}/.test(note)) return note;
  const prev = touchBefore(c.state[j.id], j.touch);
  // The user's own gap for this step (any lead time but the last day gives it), else the table's for that day.
  const g = c.settings.followup_gap?.length ? gapFor(c.settings, 'early', j.touch) : null;
  const when = due.day
    ? `planned for ${due.day}`
    : due.waits
      ? `planned for ${g ? `${g} ${g === 1 ? 'day' : 'days'}` : 'its usual gap'} after message ${prev} goes`
      : `not going: ${noDayWhy(due)}`;
  return note.replace(/planned for \d{4}-\d{2}-\d{2}/, when);
}

// cards: what the page offers. A final page (no pending card on it) says how many drafts wait for the user's yes.
// Written with what it was built from (c.inputsAt, taken before ctxOf read anything): first that, then the page, both
// carrying one build id, so a later check (pageCurrent) knows whether the page is still current.
export function renderFile(c, cards) {
  const build = c.inputsAt ? buildIdOf(c.inputsAt) : null;
  const offered = new Set(cards.filter((x) => x.kind === 'message').map((x) => x.id));
  const holders = holdersBySlot(Object.fromEntries(Object.entries(c.short.assignments).filter(([id]) => offered.has(id))));
  const nameOf = (id) => c.byId[id]?.name || id;
  const counts = {};
  for (const g of Object.values(c.triage.final || {})) counts[g.group] = (counts[g.group] || 0) + 1;
  // The bar's "N of M sent": every message floorboss has a send recorded for at this event counts as sent, and stays
  // in the total. A recorded send's card leaves the page, so counting only the cards read "0 of 20" after two sends
  // where it had read "0 of 22".
  const recordedSent = Object.values(c.state).reduce((n, p) => n + Object.keys(p.sent || {}).length, 0);
  const html = renderOutbox({
    hand_send: c.settings.hand_send === true,
    recorded_sent: recordedSent,
    event: c.event,
    generatedAt: `${c.now.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    counts: { coordinate: counts.coordinate || 0, suppressed: counts.suppressed || 0, not_drafted: (counts.not_drafted || 0) + (counts.check || 0) },
    cards,
    slots: c.slots
      .filter((s) => holders[s.id])
      .map((s) => ({ id: s.id, label: slotLabel(s, c.event.time_zone, null, c.event.city), holders: holders[s.id].map(nameOf) })),
    visit: c.store.visit,
    waiting: cards.some((x) => x.pending) ? 0 : cardsFrom(c, readTodo(c, { jobs: [] }).jobs, { pendingOnly: true }).filter((x) => x.pending).length,
    ledgerAt: c.ledgerAt,
    build
  });
  if (c.inputsAt) savePageInputs(c.paths, sealPageInputs(c.inputsAt), build);
  writeMailFiles(c.paths.outbox, cards);
  writeText(c.paths.outbox, html);
  return c.paths.outbox;
}

// The .eml files the page's "Download .eml" buttons point at, in mail/ next to the page: emptied first, then one for
// each card whose page offers it (outbox.mjs mailOf), so a file is there only while its card offers it. A link or
// anything else at mail/ is removed, never followed.
export function clearMailFiles(outboxPath) {
  const dir = join(dirname(outboxPath), 'mail');
  let st = null;
  try {
    st = lstatSync(dir);
  } catch {
    return dir;
  }
  if (st.isDirectory() && !st.isSymbolicLink()) rmSync(dir, { recursive: true, force: true });
  else unlinkSync(dir);
  return dir;
}
function writeMailFiles(outboxPath, cards) {
  const dir = clearMailFiles(outboxPath);
  for (const card of cards) {
    const m = mailOf(card);
    if (m) writeText(join(dir, m.file), m.eml);
  }
}

// The review page (drafts waiting for a yes, nothing to copy) or the final one, written through the page's lock like
// every rebuild, so a page read before a change can never land after that change's rebuild.
// The outbox page on the laptop with auto-send on: only while this session holds the data folder (sync start).
function heldForAutosend() {
  const why = sessionWhy();
  if (why) throw new Error(why);
}

export function render(opts) {
  need(opts, 'event');
  heldForAutosend();
  const review = !!opts.review;
  const r = rebuildOutbox(opts.event, opts, { force: true, review });
  return { outbox: r.rebuilt, cards: r.cards, review };
}

// Final outbox: every approved or outboxed message across runs, newest touch per contact.
export function allOutboxCards(c) {
  const jobs = [];
  let todoJobs; // read once, on the first approved draft
  for (const { file, id, t } of draftFiles(c)) {
    const touch = +t;
    const d = readJson(file);
    const st = c.state[id]?.touches?.[touch]?.status;
    if (!isOut(st)) continue;
    const job = (todoJobs ||= readTodo(c, { jobs: [] }).jobs).find((j) => j.id === id && j.touch === touch);
    const pre = c.triage.pre[id] || {};
    jobs.push(
      job || {
        id,
        touch,
        kind: ledgerTouch(c, id, touch).kind || d.kind,
        channel: d.channel,
        holder: d.holder || pre.holder,
        slot_ids: d.slot_ids,
        earliest: d.earliest,
        mode: d.mode,
        followup_note: d.followup_note,
        draft_file: file
      }
    );
  }
  const latest = new Map();
  const confirmations = [];
  for (const j of jobs) {
    if (j.touch === 0) {
      if (!c.state[j.id]?.sent?.[0]) confirmations.push({ ...j, kind: 'confirmation' });
      continue;
    }
    // The next message to go for each person: the first approved touch not yet sent. (With a sequence
    // approved up front, the later follow-ups wait their turn instead of standing in for the first.)
    if (c.state[j.id]?.sent?.[j.touch]) continue;
    // A follow-up is next only once the message before it (a skipped step passed over) went: a step sent back or
    // dropped holds the ones after it, here as at the send.
    if (j.touch > 1 && !c.state[j.id]?.sent?.[touchBefore(c.state[j.id], j.touch)]) continue;
    // A later step already went (recorded by hand, or found in the mailbox): this earlier one is passed over.
    if (laterSent(c.state[j.id], j.touch)) continue;
    if (!latest.has(j.id) || latest.get(j.id).touch > j.touch) latest.set(j.id, j);
  }
  const sentOrDone = (id) => {
    const s = c.state[id];
    return s && (s.replied || s.booked || s.stopped || ((c.short.coordinate || []).includes(id) && colleagueTold(s)));
  };
  const bookedByOther = takenTest(c);
  // Sent already (only the browser remembered it): out, so it can't be sent twice. Offering a time someone
  // else booked: out until it's redrafted with new times.
  const stale = (j) =>
    c.state[j.id]?.sent?.[j.touch] || ((savedDraft(c, j.id, j.touch) || {}).slot_ids || j.slot_ids || []).some((x) => bookedByOther(x, j.id));
  for (let i = confirmations.length - 1; i >= 0; i--) {
    const d = savedDraft(c, confirmations[i].id, confirmations[i].touch) || {};
    if (d.booked_slot && d.booked_slot !== c.state[confirmations[i].id]?.booked) confirmations.splice(i, 1);
  }
  // An auto-send message offering a time someone else booked stays on the page, held (time_taken), so it isn't lost
  // from sight; the rest that offer a taken time are out until redrafted.
  for (const [id, j] of latest)
    if (stale(j)) {
      if (!c.state[j.id]?.sent?.[j.touch] && j.kind === 'message' && autosendLive(c.entries, c.folded, j.id, j.touch)) latest.set(id, { ...j, time_taken: true });
      else latest.delete(id);
    }
  return cardsFrom(
    c,
    [...confirmations.filter((j) => !c.blocked(j.id)), ...[...latest.values()].filter((j) => !sentOrDone(j.id) && !c.blocked(j.id, j.kind))],
    { pendingOnly: false }
  );
}

// Out of date: anything the page was built from has changed since (page-inputs.mjs), a send, an approval or a stop
// at another event included. Nothing is loaded. now: the command's clock (the page reads the day). retryFailed: a page
// that could not be built counts as out of date.
export function outboxStale(paths, { now = nowFrom({}), retryFailed = false } = {}) {
  if (!existsSync(paths.outbox)) return false;
  return !pageCurrent({ derived: join(dirname(paths.outbox), 'derived'), ...paths }, now, { retryFailed }).current;
}

// A read that failed because another command swapped the file at that moment: tried once more.
const passing = (e) => e?.code === 'ENOENT' || /changed while floorboss read it/.test(String(e?.message || ''));
// floorboss's own tests only (FLOORBOSS_TEST=1): the first n builds of this process meet a file swapped while it was
// read (FLOORBOSS_PAGE_SWAP=n), or fail outright (FLOORBOSS_FAIL_PAGE=n).
let builds = 0;
function testFault() {
  if (process.env.FLOORBOSS_TEST !== '1') return;
  builds++;
  if (builds <= Number(process.env.FLOORBOSS_PAGE_SWAP || 0)) throw new Error('(test) derived/todo.json changed while floorboss read it.');
  if (builds <= Number(process.env.FLOORBOSS_FAIL_PAGE || 0)) throw new Error('(test) the page could not be built.');
}
// floorboss's own tests only: a record line (FLOORBOSS_PAGE_APPEND, its JSON) written once, after the event was read
// for a build and before the page is written, as another command's write landing during the build.
function testWriteDuring(paths, opts) {
  if (process.env.FLOORBOSS_TEST !== '1' || !process.env.FLOORBOSS_PAGE_APPEND) return;
  const line = JSON.parse(process.env.FLOORBOSS_PAGE_APPEND);
  delete process.env.FLOORBOSS_PAGE_APPEND;
  append(paths.ledger, line, nowFrom(opts));
}

// The page's name for the user: the event's name, else its slug.
const nameOf = (paths, slug) => {
  try {
    return readJson(paths.event, {})?.name || slug;
  } catch {
    return slug;
  }
};

// Rebuilds an event's outbox page when it is out of date (or always, with force), from the ledger and inputs as they
// are now: the one way the page is written (the gate, staging, open and render go through it too). One process at a
// time per event, each checking after taking the lock, and again after it rendered (another command may have written
// meanwhile), so commands run at once leave the page in step. Throws when the page can't be built. Returns { rebuilt,
// cards } or null (current, or no page yet and not forced). review: the review page (drafts waiting for a yes, nothing to
// copy) instead of the final one. markFailed: a page that can't be built is replaced, under the same lock, by one that
// offers nothing to copy and says it is out of date; when the cause isn't a file another command was replacing at that
// moment, what it was built from is recorded with it, so it is tried again only once one of those changes (or at a
// step at its own event: retryFailed).
export function rebuildOutbox(slug, opts = {}, { force = false, review = false, markFailed = false, retryFailed = false } = {}) {
  const paths = files(slug);
  if (!force && !existsSync(paths.outbox)) return null;
  return withLock(
    `outbox-${slug}`,
    ({ beat } = {}) => {
      let out = null;
      for (let i = 0; i < 3; i++) {
        if (!force && pageCurrent(paths, nowFrom(opts), { advance: true, retryFailed: retryFailed && i === 0 }).current) break;
        // A build can take a while at a large event: the lock is kept young, so a waiter never takes it for stale.
        beat?.();
        let n;
        for (let tries = 0; ; tries++) {
          // What this attempt reads, taken first: recorded with a page that can't be built from it.
          const before = markFailed ? pageInputs(paths.dir, nowFrom(opts)) : null;
          try {
            testFault();
            const c = ctxOf(slug, opts);
            const cards = review ? cardsFrom(c, readTodo(c, { jobs: [] }).jobs, { pendingOnly: true }) : allOutboxCards(c);
            testWriteDuring(paths, opts);
            renderFile(c, cards);
            n = cards.length;
            break;
          } catch (e) {
            if (tries < 1 && passing(e)) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
              continue;
            }
            if (markFailed) markOutOfDate(paths, slug, e, passing(e) ? null : before);
            throw e;
          }
        }
        out = { rebuilt: paths.outbox, cards: n };
        force = false;
      }
      return out;
    },
    PAGE_LOCK
  );
}
// The page's lock: one whose holder is gone is broken at once, and one left with no holder's id (or an empty one) after
// 3 seconds (lib/lock.mjs); a live holder is waited for, longer than a lock takes to count as stale, and is never taken
// for stale while it keeps the lock young (only after 10 minutes without a beat).
export const PAGE_LOCK = Object.freeze({ waitMs: 75000, staleMs: 60000, orphanMs: 3000, liveMs: 600000 });

// The page replaced by one that offers nothing to copy and says it is out of date. inputs: what the failed build read
// (then the page and that record carry one build id, so the page counts as current until one of them changes); null: a
// passing cause, so the next check tries again.
function markOutOfDate(paths, slug, e, inputs) {
  try {
    if (!existsSync(paths.outbox) || !statSync(paths.outbox).isFile()) return false;
    const build = inputs ? buildIdOf({ ...inputs, failed: String(e.message) }) : null;
    if (inputs) savePageInputs(paths, sealPageInputs(inputs), build, { failed: e.message });
    clearMailFiles(paths.outbox);
    writeText(paths.outbox, renderOutOfDate({ name: nameOf(paths, slug), why: e.message, slug, build }));
    return true;
  } catch {
    return false;
  }
}

// The same, for after a command: never throws (the command did its work, so a page that can't be rebuilt is said, not
// an error), and a page that can't be rebuilt is replaced by one that offers nothing to copy and says it is out of
// date. Returns null (nothing to do), { rebuilt } or { not_rebuilt: <what to tell the user> }. retryFailed: a page that
// could not be built is tried again though nothing it reads changed (flow next at its own event).
export function refreshOutbox(slug, opts = {}, { force = false, retryFailed = false } = {}) {
  try {
    return rebuildOutbox(slug, opts, { force, markFailed: true, retryFailed });
  } catch (e) {
    const paths = files(slug);
    let marked = false;
    try {
      // Marked under the lock above; a lock that couldn't be taken leaves it to here.
      marked = existsSync(paths.outbox) && /This outbox page is out of date/.test(readFileSync(paths.outbox, 'utf8').slice(0, 2000));
      if (!marked) marked = markOutOfDate(paths, slug, e, null);
    } catch {
      /* best effort: the message below still goes */
    }
    return {
      not_rebuilt: `Saved, but the outbox page of ${plainText(nameOf(paths, slug), 60)} (${slug}) could not be rebuilt: ${String(e.message).replace(/[\s.]*$/, '.')} ${
        marked ? 'The page now says it is out of date and offers nothing to copy.' : "Don't copy from the page: it may still offer a message that was cut, dropped or sent back."
      } "event-outreach open --event ${slug} --no-open" rebuilds it.`
    };
  }
}

// Opens this event's outbox in the browser. Only this file: the command needs no general "open" permission.
export function openOutbox(opts) {
  need(opts, 'event');
  heldForAutosend();
  // Rendered again right before opening, through the page's lock: whatever sat at outbox.html is replaced by
  // floorboss's own page.
  const paths = files(opts.event);
  rebuildOutbox(opts.event, opts, { force: true, review: !!opts.review });
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  if (!opts['dry-run'] && !opts['no-open']) {
    const child = spawn(cmd, [paths.outbox], { stdio: 'ignore', detached: true });
    // No opener on this system (a Linux or WSL without xdg-open): the page is written all the same, so say where it is
    // rather than crash after the work is done.
    child.on('error', () => process.stderr.write(`floorboss: couldn't open the page with ${cmd}; open it yourself: ${paths.outbox}\n`));
    child.unref();
  }
  return opts['dry-run'] || opts['no-open'] ? { written: paths.outbox, opened: false } : { opened: paths.outbox, with: cmd };
}
