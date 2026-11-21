// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Phase 7 of nextStep.
import { join } from 'node:path';
import { readJson } from '../../../../lib/jsonio.mjs';
import { plural } from '../../../../lib/plural.mjs';
import { step, node, pendingLine, pendingAsk, handSend } from './shared.mjs';

// What changed since a message's last yes, in one line with every message it touches: a new address (the draft goes to
// another address than the one approved), or a rewrite. Null when nothing was approved before.
export function changedSince(e, needApprove, touchOf) {
  const name = (j) => j.contact?.name || j.id;
  const newAddr = new Map(),
    rewritten = new Map(),
    added = new Map();
  for (const j of needApprove) {
    const x = touchOf(j);
    const last = e.entries.filter((y) => y.type === 'approved' && y.id === j.id && Number(y.touch) === Number(j.touch)).pop();
    const to = readJson(join(e.paths.dir, 'drafts', `${x?.hash}.json`), {})?.to || null;
    if (!last) added.set(j.id, name(j));
    else if (to && last.to && String(to).toLowerCase() !== String(last.to).toLowerCase()) newAddr.set(j.id, name(j));
    else if (last.hash !== x?.hash) rewritten.set(`${j.id}:${j.touch}`, `${name(j)} (message ${j.touch})`);
  }
  const and = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);
  const parts = [
    newAddr.size ? `a new address for ${and([...newAddr.values()])}` : null,
    rewritten.size ? `rewritten: ${and([...rewritten.values()])}` : null,
    added.size ? `new: ${and([...new Set(added.values())])}` : null
  ].filter(Boolean);
  if (!parts.length) return null;
  const per = new Map();
  for (const j of needApprove) per.set(name(j), [...(per.get(name(j)) || []), j.touch]);
  return `What changed since your last yes: ${parts.join('; ')}. One yes covers the ${plural(needApprove.length, 'message')} this affects: ${[...per].map(([n, ts]) => `${n} (${ts.sort((a, b) => a - b).join(', ')})`).join('; ')}.`;
}

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
  // Codex: the user said yes to sending from their Gmail at setup ("autosend_said"): auto-send in drafts mode is turned on
  // here, before the approval, so the one approval covers whole sequences. Their Gmail address is asked once.
  const sendSaid = c.ob?.ans?.autosend_said;
  if (handSend() && sendSaid && !e.event?.autosend && needApprove.length) {
    const own = e.event?.autosend_own || c.cfg?.own_email || null;
    if (!own)
      return step('autosend_own', 'You asked floorboss to send from your Gmail. It needs the address of that Gmail account.', {
        ask: {
          id: 'send_setup',
          question: 'Which Gmail address should floorboss send from? (The account you use with ChatGPT or Codex.)',
          answer_format: 'the address, e.g. "you@example.com"'
        }
      });
    return step('autosend_on', 'You asked floorboss to send your approved emails from your Gmail: turning auto-send on (Gmail drafts) before the approval.', {
      run: node('autosend', 'on', '--event', e.event.slug, '--said', String(sendSaid), '--own', own, '--mode', 'drafts'),
      help: '.agents/skills/floorboss/SKILL.md'
    });
  }
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
  // Hand-send: one change, one confirmation. What changed since the last yes (a new address, a rewrite) and every
  // message it touches, said once with the one question (the shortlist isn't shown again for a list reloaded with only
  // new addresses: triage.mjs).
  const changeLine = handSend() && approvedBefore ? changedSince(e, needApprove, touchOf) : null;
  const approveAgain = changeLine
    ? changeLine
    : approvedBefore
    ? `Asked again: ${plural(needApprove.length, 'message')} new or rewritten since your last approval.`
    : carried
      ? `Your ratings from ${carried} apply (your voice hasn't changed since), so the blind set isn't asked again.`
      : null;
  if (needApprove.length)
    return step(
      'approve',
      handSend()
        ? `${plural(needApprove.length, 'message')} ${needApprove.length === 1 ? 'is' : 'are'} ready for the user's yes. Each is shown in full; once approved, the user sends each one from their own mail app or copies it.`
        : `${plural(needApprove.length, 'message')} ${needApprove.length === 1 ? 'is' : 'are'} ready for the user's yes. With sending on, each person's whole sequence and its planned days are shown.`,
      {
        ...(() => {
          const full = lastHeldFail && !toldSince(lastHeldFail);
          const n0 = withHeld(stuckNote, full);
          const n1 = !full && heldCount ? { ...n0, tell_user: [n0.tell_user, heldCount].filter(Boolean).join(' ') } : n0;
          const n = mineLine ? { ...n1, tell_user: [mineLine, n1.tell_user].filter(Boolean).join(' ') } : n1;
          return approveAgain ? { ...n, tell_user: [approveAgain, n.tell_user].filter(Boolean).join(' ') } : n;
        })(),
        // Hand-send: the review is in the chat (a sample, the total, one read-only document), never a page.
        run_first: handSend()
          ? node('flow', 'review', '--event', e.event.slug, '--ids', needApprove.map((j) => `${j.id}:${j.touch}`).join(','))
          : node('event-outreach', 'open', '--event', e.event.slug, '--review', '--no-open'),
        ...(handSend()
          ? {
              accepts: ['review_feedback'],
              if_user_says: {
                feedback:
                  'Feedback on the drafts, or a rewrite of a line: save it with flow answer --ask review_feedback --value-file <file> as {"feedback":"<their words, whole>","ids":"all" or ["c004:1", …] (the messages it is about; "all" for feedback on the drafts overall)}. floorboss rewrites every message it covers, the critic reads them again, and this question comes back with them.'
              }
            }
          : {}),
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
          question: handSend()
            ? `${pendingLine(e, 'approval')}${warnLine}Show the review's sample in the chat, each message whole (subject and body), and ask for candid feedback overall or a rewrite of any line; offer its document (every message, to read). Never send the user to a page to review. Then: Approve all ${plural(needApprove.length, 'message')} (the ones shown and the rest in the document), all except some, by name, edit or drop? Once saved, show the answer's say_to_user line word for word: who each name was read as, and who was approved, held back or dropped.`
            : `${pendingLine(e, 'approval')}${warnLine}Show each message (or the review page). Approve all, approve all except some, approve by name, edit or drop? Once saved, show the answer's say_to_user line word for word: who each name was read as, and who was approved, held back or dropped.`,
          answer_format:
            '"approve all" | "approve all except <ids>" | "approve <ids>" | "edit <ids>" | "drop <ids>" | "skip review <ids|all>" (drafts the critic hasn\'t read go on unreviewed, and their cards say so)'
        }
      }
    );
  Object.assign(x, { heldMustNote });
}
