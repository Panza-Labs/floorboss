// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The outbox page: one card per message, rendered for the user to read before approving.
import { spawn } from 'node:child_process';
import { need } from '../../../../lib/args.mjs';
import { readJson, writeText } from '../../../../lib/jsonio.mjs';
import { slotLabel } from '../../../slot-finder/scripts/slots.mjs';
import { holdersBySlot } from '../../../slot-finder/scripts/assign.mjs';
import { profileMeta } from '../../../attendee-research/scripts/profiles.mjs';
import { MODES } from '../leadtime.mjs';
import { INSTRUCTION_LIKE } from '../../../crm-triage/scripts/view.mjs';
import { touchBefore } from '../../../../lib/route.mjs';
import { renderOutbox } from '../outbox.mjs';
import { hashOf, pickAt, whereAt } from './routes.mjs';
import { isOut, labelOf, ctxOf, colleagueTold, takenTest } from './context.mjs';
import { savedDraft, readTodo, draftFiles, ledgerTouch } from './saved-drafts.mjs';

function cardsFrom(c, jobs, { pendingOnly }) {
  const cards = [];
  for (const j of jobs) {
    // The card's text and verdict are the ledger's: the fingerprinted text of the latest save, which for the
    // outbox is the approved one. A working copy changed since (by hand) has no card: what the outbox offers
    // as approved is only ever what was approved.
    const d = savedDraft(c, j.id, j.touch, readJson(j.draft_file, null));
    if (!d) continue;
    // Every card, the review page's included, is for someone who may still be contacted.
    if (c.blocked(j.id, d.kind === 'coordinate' ? 'coordinate' : 'message')) continue;
    const st = c.state[j.id]?.touches?.[j.touch]?.status;
    if (pendingOnly === false && (!isOut(st) || c.state[j.id]?.touches?.[j.touch]?.approved?.hash !== hashOf(c, d))) continue;
    // The review page is what's offered for a yes: a draft that failed the critic twice isn't on it (todo and
    // the gate list it as held for the user).
    if (pendingOnly && j.critic_held && !isOut(st)) continue;
    const ct = c.byId[j.id];
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
      profile_url: ct.profile_url,
      routed: pickAt(c, j.id, j.touch) || undefined,
      // Research couldn't confirm they're at this company: check their profile before sending.
      identity_unconfirmed: profileMeta(c.paths.dir, j.id)?.identity_confirmed === false || undefined,
      // Their list entry reads like an instruction to an AI (a planted note): flagged on the card too, not only at load.
      instruction_like: INSTRUCTION_LIKE.test(`${ct.notes || ''} ${ct.title || ''} ${ct.company || ''}`) || undefined,
      planned_due: d.planned_due || undefined,
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
      followup_note: j.followup_note || d.followup_note,
      slots: (j.slot_ids || d.slot_ids || []).map((id) => ({ id, label: labelOf(c, id) })),
      pending: !isOut(st),
      staged: c.state[j.id]?.touches?.[j.touch]?.staged ? true : undefined,
      // Still failing floorboss's own checks after three rewrites: said on the card, never passed on in silence.
      checks_stuck: j.kind === 'message' && d.checks?.length && (d.attempts || 0) >= 3 ? d.checks : undefined
    });
  }
  return cards;
}

export function renderFile(c, cards) {
  const offered = new Set(cards.filter((x) => x.kind === 'message').map((x) => x.id));
  const holders = holdersBySlot(Object.fromEntries(Object.entries(c.short.assignments).filter(([id]) => offered.has(id))));
  const nameOf = (id) => c.byId[id]?.name || id;
  const counts = {};
  for (const g of Object.values(c.triage.final || {})) counts[g.group] = (counts[g.group] || 0) + 1;
  const html = renderOutbox({
    event: c.event,
    generatedAt: `${c.now.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    counts: { coordinate: counts.coordinate || 0, suppressed: counts.suppressed || 0, not_drafted: (counts.not_drafted || 0) + (counts.check || 0) },
    cards,
    slots: c.slots
      .filter((s) => holders[s.id])
      .map((s) => ({ id: s.id, label: slotLabel(s, c.event.time_zone, null, c.event.city), holders: holders[s.id].map(nameOf) })),
    visit: c.store.visit
  });
  writeText(c.paths.outbox, html);
  return c.paths.outbox;
}

export function render(opts) {
  need(opts, 'event');
  const c = ctxOf(opts.event, opts);
  const t = readTodo(c, { jobs: [] });
  const review = !!opts.review;
  const cards = review ? cardsFrom(c, t.jobs, { pendingOnly: true }) : allOutboxCards(c);
  return { outbox: renderFile(c, cards), cards: cards.length, review };
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
  for (const [id, j] of latest) if (stale(j)) latest.delete(id);
  return cardsFrom(
    c,
    [...confirmations.filter((j) => !c.blocked(j.id)), ...[...latest.values()].filter((j) => !sentOrDone(j.id) && !c.blocked(j.id, j.kind))],
    { pendingOnly: false }
  );
}

// Opens this event's outbox in the browser. Only this file: the command needs no general "open" permission.
export function openOutbox(opts) {
  need(opts, 'event');
  // Rendered again right before opening: whatever sat at outbox.html is replaced by floorboss's own page.
  const c = ctxOf(opts.event, opts);
  const paths = c.paths;
  renderFile(c, opts.review ? cardsFrom(c, readTodo(c, { jobs: [] }).jobs, { pendingOnly: true }) : allOutboxCards(c));
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  if (!opts['dry-run'] && !opts['no-open']) spawn(cmd, [paths.outbox], { stdio: 'ignore', detached: true }).unref();
  return opts['dry-run'] || opts['no-open'] ? { written: paths.outbox, opened: false } : { opened: paths.outbox, with: cmd };
}
