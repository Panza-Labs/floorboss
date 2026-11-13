// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Phase 7 of nextStep.
import { join } from 'node:path';
import { readJson } from '../../../../lib/jsonio.mjs';
import { plural } from '../../../../lib/plural.mjs';
import { step, node, pendingLine, pendingAsk } from './shared.mjs';

// Approval: drafts that are stuck, what the user should know before approving, and the approval itself.
export function approvalSteps(x) {
  const { c, e, jobs, touchOf, staleWhy, mine, stuck, stuckNote, heldNow, lastHeldFail, toldSince, withHeld, heldCount, carried } = x;
  // The must-meet people (from the shortlist): a held draft of theirs is named as such, never left in a list.
  const mustMeet = new Set(readJson(join(e.paths.derived, 'shortlist.json'), {}).must_meet || []);
  const heldMust = [
    ...new Map(
      jobs
        .filter((j) => j.critic_held && mustMeet.has(j.id) && !touchOf(j)?.dropped && !(touchOf(j)?.approved && touchOf(j).approved.hash === touchOf(j).hash))
        .map((j) => [j.id, j])
    ).values()
  ];
  // Left out at the last approval ("approve all except c012"): they wait for the user's word, they don't bring the
  // question back each time something is recorded. Said at the end instead.
  const leftOutNow = jobs.filter(
    (j) =>
      /^left out/.test(j.held_for_user || '') &&
      touchOf(j)?.hash &&
      !touchOf(j)?.dropped &&
      !(touchOf(j)?.approved && touchOf(j).approved.hash === touchOf(j).hash)
  );
  const leftOutLine = leftOutNow.length
    ? `Left out at your last approval, and waiting for your word: ${[...new Set(leftOutNow.map((j) => `${j.contact?.name || j.id} (${j.id})`))].join(', ')}. Say "approve <id>" to send one, or "drop <id>".`
    : null;
  const mustLine = heldMust.length
    ? `${heldMust.map((j) => `${j.contact?.name || j.id} (${j.id})`).join(', ')}: your must-meet${heldMust.length === 1 ? "'s draft" : "s' drafts"} failed the critic twice and ${heldMust.length === 1 ? 'is' : 'are'} held. Say "edit ${heldMust[0].id}", or "approve ${heldMust[0].id}" to send it as it is.`
    : null;
  // Every other held draft is said at the end too: it isn't in the outbox, and nothing else says so.
  const heldOther = heldNow.filter((j) => !mustMeet.has(j.id));
  const heldEndLine = heldOther.length
    ? `${heldOther.length === 1 ? (mustLine ? 'One more draft' : 'One draft') : `${heldOther.length}${mustLine ? ' more' : ''} drafts`} held after two critic fails and not in the outbox: ${[...new Set(heldOther.map((j) => `${j.contact?.name || j.id} (${j.id}${j.touch > 1 ? `:${j.touch}` : ''})`))].join(', ')} (edit, drop, or approve by id).`
    : null;
  // The user's own edit that the critic failed: back to them, never rewritten.
  const mineFailed = jobs.filter(
    (j) =>
      j.kind === 'message' &&
      mine(j) &&
      touchOf(j)?.critic?.verdict === 'FAIL' &&
      touchOf(j).critic.hash === touchOf(j).hash &&
      !touchOf(j)?.dropped &&
      !(touchOf(j)?.approved && touchOf(j).approved.hash === touchOf(j).hash)
  );
  const mineLine = mineFailed.length
    ? mineFailed
        .map(
          (j) =>
            `Your edit of ${j.contact?.name || j.id} (${j.id}${j.touch > 1 ? `:${j.touch}` : ''}) failed the critic (${(touchOf(j).critic.reasons || []).slice(0, 2).join('; ') || 'see the card'}): floorboss doesn't rewrite your text. Edit it again, drop it, or approve ${j.id} by id to send it as it is.`
        )
        .join(' ')
    : null;
  // The held drafts are said with "approve by id": that answer is taken here too, after the approve step is past.
  const heldMustNote =
    mustLine || leftOutLine || heldEndLine || mineLine
      ? {
          tell_user: [mineLine, mustLine, heldEndLine, leftOutLine].filter(Boolean).join(' '),
          // By name only (approve_held: "approve c004", "drop c007:2"), never "approve all" or a bare yes.
          ...(heldNow.length || mineFailed.length || leftOutLine
            ? { accepts: ['approve_held'], answer_held: 'flow answer --ask approve_held with "approve <ids>", "drop <ids>" or "edit <id>"' }
            : {})
        }
      : {};
  const needApprove = jobs.filter(
    (j) =>
      !/^left out/.test(j.held_for_user || '') &&
      touchOf(j)?.hash &&
      !staleWhy(j) &&
      !(touchOf(j).approved && touchOf(j).approved.hash === touchOf(j).hash) &&
      !touchOf(j).dropped &&
      (j.kind !== 'message' || touchOf(j).critic?.verdict === 'PASS' || touchOf(j).review_skipped)
  );
  // Drafts that stayed unapprovable after three tries (stuck, above): the user drops them or edits them, asked once a day.
  const stuckAsked = e.state.answered.stuck_drafts && String(e.state.answered.stuck_drafts.at).slice(0, 10) === c.now.toISOString().slice(0, 10);
  if (stuck.length && !stuckAsked)
    return step('stuck_drafts', `${stuck.length} ${stuck.length === 1 ? 'draft' : 'drafts'} still can't go after three rewrites.`, {
      ask: {
        id: 'stuck_drafts',
        question: `These can't be approved as written: ${stuck.map((j) => `${j.contact?.name || j.id} (${j.id}): ${staleWhy(j)}`).join('; ')}. Drop them, or edit them yourself ("edit <id>: <new text>")?`,
        options: [`drop ${[...new Set(stuck.map((j) => (j.touch > 1 ? `${j.id}:${j.touch}` : j.id)))].join(',')}`, 'edit <id>: …', 'leave them for now'],
        answer_format: '"drop <ids>" | "edit <id>: <text>" | "leave them for now"'
      }
    });
  // Coworkers' contacts the user chose to write to with a warning: listed by name and owner before the yes.
  const resolvedNow = readJson(join(e.paths.derived, 'resolved.json'), {});
  // One line per person, not per message (each person's whole sequence is approved together).
  const coworkerWarn = [
    ...new Map(
      needApprove.filter((j) => resolvedNow[j.id]?.coworker_warn).map((j) => [j.id, `${j.contact?.name || j.id} (${resolvedNow[j.id].coworker}'s)`])
    ).values()
  ];
  // Someone who moved since the CRM record (its company isn't the list's) whose address is at the old company.
  const oldAddress = [
    ...new Map(
      needApprove
        .filter((j) => j.kind === 'message' && resolvedNow[j.id]?.email_old_company)
        .map((j) => [
          j.id,
          `${j.contact?.name || j.id} (${j.id}) is at ${j.contact?.company || 'a new company'} now, but their address is at ${resolvedNow[j.id].email_old_company}`
        ])
    ).values()
  ];
  const warnLine = `${coworkerWarn.length ? `Before you approve: ${coworkerWarn.length} of these ${coworkerWarn.length === 1 ? 'goes' : 'go'} to people your coworkers own: ${[...new Set(coworkerWarn)].join(', ')}. Still send them? ` : ''}${oldAddress.length ? `${oldAddress.join('; ')}: check the address is still theirs before it goes. ` : ''}`;
  const approvedBefore = e.entries.some((x) => x.type === 'approved');
  const approveAgain = approvedBefore
    ? `Asked again: ${plural(needApprove.length, 'message')} new or rewritten since your last approval.`
    : carried
      ? `Your ratings from ${carried} apply (your voice hasn't changed since), so the blind set isn't asked again.`
      : null;
  if (needApprove.length)
    return step(
      'approve',
      `${plural(needApprove.length, 'message')} ${needApprove.length === 1 ? 'is' : 'are'} ready for the user's yes. With sending on, each person's whole sequence and its planned days are shown.`,
      {
        ...(() => {
          const full = lastHeldFail && !toldSince(lastHeldFail);
          const n0 = withHeld(stuckNote, full);
          const n1 = !full && heldCount ? { ...n0, tell_user: [n0.tell_user, heldCount].filter(Boolean).join(' ') } : n0;
          const n = mineLine ? { ...n1, tell_user: [mineLine, n1.tell_user].filter(Boolean).join(' ') } : n1;
          return approveAgain ? { ...n, tell_user: [approveAgain, n.tell_user].filter(Boolean).join(' ') } : n;
        })(),
        run_first: node('event-outreach', 'open', '--event', e.event.slug, '--review', '--no-open'),
        ...(coworkerWarn.length ? { warn: { coworkers: coworkerWarn } } : {}),
        ...(jobs.some((j) => j.critic_held)
          ? {
              held: jobs
                .filter((j) => j.critic_held)
                .map((j) => ({
                  id: j.id,
                  name: j.contact?.name,
                  ...(mustMeet.has(j.id) ? { must_meet: true } : {}),
                  why: `${mustMeet.has(j.id) ? 'your must-meet: ' : ''}failed the critic twice: edit, drop, or approve by id`
                }))
            }
          : {}),
        ask: {
          id: 'approve',
          ...pendingAsk(e, 'approval'),
          question: `${pendingLine(e, 'approval')}${warnLine}Show each message (or the review page). Approve all, approve all except some, approve by name, edit or drop? Once saved, show the answer's say_to_user line word for word: who each name was read as, and who was approved, held back or dropped.`,
          answer_format:
            '"approve all" | "approve all except <ids>" | "approve <ids>" | "edit <ids>" | "drop <ids>" | "skip review <ids|all>" (drafts the critic hasn\'t read go on unreviewed, and their cards say so)'
        }
      }
    );
  Object.assign(x, { heldMustNote });
}
