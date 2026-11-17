// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Unattended email drafts, the scripts' side. No command here records the thing it is about: floorboss's guard does,
// in its own hooks (draft-missing, below, included).
// - authorise-unattended --event <slug>: the guard asks the user, in one Claude Code prompt, about every approved
//   email follow-up of the event that could go into the drafts on its own (each person's quoted name, id, address,
//   due day and the full text), and its PostToolUse hook writes unattended/authorised.jsonl once this call ran. This
//   prints what was put to the user.
// - crm-judge --event <slug> --id <c…> --file <judgements>: in an unattended run only, the model's hold-or-go on each
//   CRM activity the guard listed that didn't come from the contact. The guard records it before this runs (bound to
//   the run's session and the CRM read it witnessed); this prints what is recorded.
import { join } from 'node:path';
import { home, assertSlug, allowedPath, readChecked } from '../../../../lib/paths.mjs';
import { need } from '../../../../lib/args.mjs';
import { loadEvent } from '../../../../lib/event.mjs';
import { loadConfig } from '../../../../lib/config.mjs';
import { nowMs } from '../../../../lib/clock.mjs';
import { authorisable, optinFor, ticketByToken, readWitness, shortDay, attendedDraftIn, olderDraftOf } from '../../../../lib/unattended-drafts.mjs';
import { ctxOf } from './context.mjs';

export function authoriseUnattended(opts) {
  need(opts, 'event');
  const slug = assertSlug(opts.event);
  const now = nowMs();
  const o = optinFor(slug, now);
  if (!o.ok) throw new Error(`${o.why}. Turn unattended drafts on for this event first: /floorboss:unattended on.`);
  const config = loadConfig();
  const settings = { ...loadEvent(slug).settings, connectors: config.connectors || {} };
  const { items, skipped, why } = authorisable(slug, { config, settings, nowMs: now });
  if (why) throw new Error(why);
  return {
    event: slug,
    ...(items.length ? { marker: `FLOORBOSS-AUTHORISE-OK:${slug}` } : {}),
    follow_ups: items.map((x) => ({ id: x.id, name: x.name, touch: x.touch, to: x.to, due: x.due_day ? shortDay(x.due_day) : null })),
    not_offered: skipped.length ? skipped : undefined,
    note: items.length
      ? "If you allowed Claude Code's prompt, these are authorised once this call finishes: each goes into your drafts on its own on its day, if nothing came in from that person. A change to a text, address or thread means it waits for you again."
      : 'Nothing to authorise: no approved email follow-up of this event can go on its own now.'
  };
}

// draft-missing --event <slug> --id <c…> --touch <n> --said "<the user's words>": the user looked, and an unattended
// draft the guard let through (its result never came back, or the call failed) isn't in their drafts folder. Its step
// may go in again: on its own from the next day (that day frees no day), if it is still in its window, or with them there. Only with them there,
// and only for a step let through unattended, or with a draft of it (any of its texts) tried with them there and no
// receipt for it, with no draft recorded, or one with a draft of an older text of it recorded (the user deleted it). This records nothing: floorboss's guard asks the
// user in a Claude Code prompt that names the person and the step, and its PostToolUse hook writes stage_cleared to the
// ledger once this call ran after they allowed it. This checks the step and prints the marker that hook looks for.
export function draftMissing(opts) {
  need(opts, 'event', 'id', 'touch', 'said');
  const slug = assertSlug(opts.event);
  if (process.env.FLOORBOSS_UNATTENDED) throw new Error("Only you, the user, say a draft isn't in your drafts folder: never an unattended run.");
  if (!/^c\d+$/.test(String(opts.id))) throw new Error('--id is a person id (c001).');
  const touch = Number(opts.touch);
  if (!Number.isInteger(touch) || touch < 2) throw new Error('--touch is the step of an unattended follow-up (2 or more).');
  const said = String(opts.said ?? '').trim();
  if (said.length < 3) throw new Error("--said needs the user's own words (they looked in their drafts folder).");
  const c = ctxOf(slug, opts);
  const x = c.folded.people?.[opts.id]?.touches?.[touch];
  // Or an attended draft of this step, for any of its texts, with no receipt (the guard's rule too).
  const failed = !x?.stage_released?.unattended && attendedDraftIn(c.paths.dir, opts.id, touch, c.entries);
  // Or a draft of an older text of this step held as in the drafts folder (lib/unattended-drafts.mjs olderDraftOf).
  const older = olderDraftOf(c.entries, opts.id, touch, x?.hash ?? null);
  if (!x?.stage_released?.unattended && !failed && !older)
    throw new Error(`${opts.id} follow-up ${touch - 1} wasn't let into your drafts by an unattended run: nothing to clear (and no draft of it tried in a session with you there is without a receipt, and no draft of an older text of it is recorded).`);
  if (x?.staged) throw new Error(`${opts.id} follow-up ${touch - 1}'s draft went in (your mail tool gave its id): if you deleted it, it stays done; approve a new message to write to them again.`);
  if (x?.sent) throw new Error(`${opts.id} follow-up ${touch - 1} is recorded as sent: nothing to clear.`);
  return {
    step: `${opts.id}:${touch}`,
    marker: `FLOORBOSS-DRAFT-MISSING-OK:${slug}:${opts.id}:${touch}`,
    note: "If you allowed Claude Code's prompt, this follow-up can go into your drafts again once this call finishes: on its own from the next day (if that is still its due day or the day after), or with you there. If you declined, nothing changed."
  };
}

export function crmJudge(opts) {
  need(opts, 'event', 'id', 'file');
  const slug = assertSlug(opts.event);
  if (!/^c\d+$/.test(String(opts.id))) throw new Error('--id is a person id (c001).');
  const ticket = ticketByToken(process.env.FLOORBOSS_UNATTENDED);
  if (!ticket) throw new Error("Only an unattended run records CRM judgements: in an attended run you decide, at Claude Code's prompt.");
  // The file is read here only to say what it held; the guard read it before this ran and recorded it.
  JSON.parse(readChecked(allowedPath(String(opts.file)), 256 * 1024));
  const j = readWitness(ticket.session, slug, opts.id, 'judged');
  const crm = readWitness(ticket.session, slug, opts.id, 'crm');
  const others = (crm?.activities || []).filter((a) => a.kind === 'other').map((a) => a.aid);
  const done = Object.keys(j?.judgements || {});
  return {
    recorded: done.length,
    still_to_judge: others.filter((a) => !done.includes(a)),
    holds: Object.entries(j?.judgements || {})
      .filter(([, v]) => v.decision !== 'go')
      .map(([aid, v]) => ({ activity_id: aid, reason: v.reason }))
  };
}
