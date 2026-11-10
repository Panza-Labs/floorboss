// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Phase 6 of nextStep.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../../../../lib/jsonio.mjs';
import { asRule } from '../../../event-outreach/scripts/sameness.mjs';
import { plural } from '../../../../lib/plural.mjs';
import { sessionRun } from '../../../../lib/scope.mjs';
import { mtime, step, node, cli, SKIP_REVIEW_HINT } from './shared.mjs';
import { rewrittenSince, countFails, failCounts, draftFormat, ratingsCarry } from './counts.mjs';

// Drafting: the list of drafting jobs, the drafts, the batch check, the critic, and the ratings.
export function draftSteps(x) {
  const { c, e } = x;
  // Drafting, the critic, approval.
  const todoFile = join(e.paths.derived, 'todo.json');
  const lastLedgerAt = Math.max(0, ...e.entries.map((x) => Date.parse(x.at)));
  // Stale when the ledger has grown since todo read it (by line count: clock times can repeat), on a new day in
  // the event's time (a follow-up falls due by time passing alone, with nothing new in the ledger), and in a new
  // run (--new-run).
  const todoNow = existsSync(todoFile) ? readJson(todoFile, {}) : {};
  const todoLines = todoNow.ledger_lines ?? null;
  const runNow = sessionRun();
  const todoOld = todoNow.built_for_day !== e.today || (runNow && todoNow.run !== runNow);
  if (!existsSync(todoFile) || todoOld || (todoLines == null ? mtime(todoFile) < lastLedgerAt : todoLines < e.entries.length))
    return step('todo', 'Work out what needs drafting now: first messages, planned follow-ups, confirmations and notes to colleagues.', {
      run: node('event-outreach', 'todo', '--event', e.event.slug)
    });
  const todo = readJson(todoFile, { jobs: [] });
  const jobs = todo.jobs || [];
  const touchOf = (j) => e.state.people[j.id]?.touches?.[j.touch];
  // A saved draft that can't be approved as it is (its times moved, or a script check fails, e.g. a LinkedIn
  // invitation note over the cap) goes back to drafting, three tries at most; then it waits for the user.
  // The times and the checks are the ledger's (the working copy is Claude's to write).
  const staleWhy = (j) => {
    const x = touchOf(j);
    if (j.kind !== 'message' || !x?.hash) return null;
    const d = readJson(j.draft_file, null);
    if (!d) return null;
    // The same times in another order are the same times.
    if ([...(x.slot_ids || [])].sort().join() !== [...(j.slot_ids || [])].sort().join()) return 'times moved';
    if (rewrittenSince(x, d, j)) return 'the message before it was rewritten';
    if (x.checks?.length) return x.checks.join('; ');
    return null;
  };
  // The user's own edit (saved after "edit <id>") is never rewritten by floorboss: a check or critic fail on it
  // goes back to the user.
  const mine = (j) => !!touchOf(j)?.user_edited;
  const stale = (j) => !!staleWhy(j) && !mine(j) && (readJson(j.draft_file, {}).attempts || 0) < 3;
  // A follow-up waits until the message before it has passed the critic (todo marks it), then it's written.
  const needDraft = jobs.filter(
    (j) =>
      !j.held_for_user &&
      !j.waits_for_previous &&
      (!touchOf(j)?.hash ||
        touchOf(j)?.revising ||
        stale(j) ||
        (touchOf(j)?.critic?.verdict === 'FAIL' &&
          touchOf(j)?.critic?.hash === touchOf(j)?.hash &&
          !mine(j) &&
          !e.state.people[j.id]?.touches?.[j.touch]?.fresh_attempt &&
          countFails(e, j) < 2))
  );
  // The user's own skill or agent writes the jobs it covers (delegate or blend): each gets its brief, and the
  // answer is saved like any draft. The step names the drafter, so it isn't found only by opening todo.json.
  const byUser = needDraft.filter((j) => j.drafter?.by === 'user');
  if (byUser.length) {
    const d = byUser[0].drafter;
    return step(
      'draft_user',
      `${plural(byUser.length, 'message')} for ${d.name} (the user's own ${d.type === 'agent' ? 'agent' : 'skill'}) to write, from floorboss's briefs.`,
      {
        run_first: node('event-outreach', 'briefs', '--event', e.event.slug, '--ids', byUser.map((j) => `${j.id}:${j.touch}`).join(',')),
        judge: {
          read: join(e.paths.dir, 'briefs'),
          how: `For each brief listed by the briefs command (by_drafter), give its whole text to ${d.invoke}: ${d.type === 'agent' ? `the Agent tool with subagent_type "${d.invoke}"` : `the Skill tool with skill "${d.invoke}"`}, one brief per call, nothing else from this conversation. Take each message exactly as it wrote it, and write them all to the file.`,
          ids: byUser.map((j) => `${j.id}:${j.touch}`),
          write: join(e.paths.work, 'drafts-batch.json'),
          format:
            '[{"id","touch","subject","body","brief","drafted_by":"' +
            (d.name || d.invoke) +
            '","insight":null,"structure":"<the structure it reads as>","fact_source":"research|crm|mailbox|list|none"}]',
          then: node('event-outreach', 'save-drafts', '--event', e.event.slug, '--drafts-file', join(e.paths.work, 'drafts-batch.json'))
        },
        help: 'skills/event-outreach/SKILL.md'
      }
    );
  }
  // Drafts that still fail the checks after three tries aren't rewritten again or sent to the critic: the user
  // hears about them now, in this step and on the card, instead of the run moving on in silence.
  const stuck = jobs.filter((j) => staleWhy(j) && !stale(j) && !touchOf(j)?.dropped && !(touchOf(j)?.approved && touchOf(j).approved.hash === touchOf(j).hash));
  const failsOf = (j) => failCounts(e.entries, j.id, j.touch);
  const stuckNote = stuck.length
    ? {
        tell_user: `${stuck.length === 1 ? 'One draft still fails' : `${stuck.length} drafts still fail`} floorboss's checks${stuck.every(mine) ? '' : ' after its rewrites'}, so ${stuck.length === 1 ? "it isn't" : "they aren't"} rewritten again or read by the critic: ${stuck.map((j) => `${j.contact?.name || j.id} (${j.id}${j.touch > 1 ? `:${j.touch}` : ''}${!mine(j) && failsOf(j) ? `, ${failsOf(j)}` : ''}): ${staleWhy(j)}${mine(j) ? ' (your own edit: floorboss leaves it to you)' : ''}`).join('; ')}. You'll be asked to edit or drop ${stuck.length === 1 ? 'it' : 'them'}.`
      }
    : {};
  // "edit <id>" at the approval or for a stuck draft: the user's edit comes next (the file, then save-draft),
  // before anything is approved without it. Settled by the edit being saved, or by "never mind".
  const editAsk = (() => {
    for (let k = e.entries.length - 1; k >= 0; k--) {
      const x = e.entries[k];
      if (x.type === 'answered' && x.ask === 'edit') {
        const [id, t] = String(x.value).split(':');
        const after = e.entries.slice(k + 1);
        const j = jobs.find((y) => y.id === id && y.touch === Number(t));
        if (
          j &&
          !touchOf(j)?.dropped &&
          !after.some((y) => (y.type === 'drafted' && y.id === id && (y.touch ?? 1) === Number(t)) || (y.type === 'answered' && y.ask === 'edit_draft'))
        )
          return j;
        return null;
      }
    }
    return null;
  })();
  if (editAsk) {
    const md = editAsk.draft_file.replace(/\.json$/, '.md');
    return step(
      'edit_draft',
      `You asked to edit ${editAsk.contact?.name || editAsk.id}'s ${editAsk.touch > 1 ? `follow-up ${editAsk.touch - 1}` : 'message'}: your edit comes before the approval.`,
      {
        ask: {
          id: 'edit_draft',
          person: { id: editAsk.id, touch: editAsk.touch, name: editAsk.contact?.name },
          file: md,
          question: `Edit ${editAsk.contact?.name || editAsk.id}'s draft in ${md} (keep the "Subject:" line), save it, then say "done". Or paste the new text here, or say "never mind" to leave it as it is.`,
          options: ['done', 'never mind'],
          answer_format: '"done" | the new text | "never mind"',
          then: node('event-outreach', 'save-draft', '--event', e.event.slug, '--id', editAsk.id, '--touch', String(editAsk.touch), '--md-file', md)
        }
      }
    );
  }
  if (needDraft.length)
    return step(
      'draft',
      `${plural(needDraft.length, 'message')} to write, following the event-outreach skill (one version each, an insight or a question, the times offered).`,
      {
        ...stuckNote,
        judge: {
          read: todoFile,
          ids: needDraft.map((j) => `${j.id}:${j.touch}`),
          write: join(e.paths.work, 'drafts-batch.json'),
          format: draftFormat(needDraft),
          then: node('event-outreach', 'save-drafts', '--event', e.event.slug, '--drafts-file', join(e.paths.work, 'drafts-batch.json'))
        },
        help: 'skills/event-outreach/SKILL.md'
      }
    );
  // Order in the ledger, not clock time: two entries can carry the same time (a fixed clock, a fast run).
  const lastIndex = (type) => {
    for (let k = e.entries.length - 1; k >= 0; k--) if (e.entries[k].type === type) return k + 1;
    return 0;
  };
  const batchAt = lastIndex('batch_checked');
  const lastDraftAt = lastIndex('drafted');
  const lastBatch = e.state.batch_checks ? Object.values(e.state.batch_checks).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] : null;
  // Two failed batch checks in a row: stop rewriting (a third pass rarely helps, and a loop never ends); the
  // critic still reads every draft and the user sees the reasons when approving.
  // Counted per message number: a passing follow-up batch between two failed first-message batches reset the
  // count, and a rule the drafter couldn't meet looped forever.
  const batchRuns = e.entries.filter((x) => x.type === 'batch_checked' && (lastBatch?.touch == null || x.touch === lastBatch.touch));
  let failsInRow = 0;
  for (let k = batchRuns.length - 1; k >= 0 && batchRuns[k].verdict === 'FAIL'; k--) failsInRow++;
  const userOnly =
    lastBatch?.verdict === 'FAIL' &&
    (() => {
      const named = new Set((lastBatch.reasons || []).join(' ').match(/\bc\d{3,}\b/g) || []);
      return named.size > 0 && jobs.filter((j) => named.has(j.id)).every((j) => j.drafter?.by === 'user' || mine(j));
    })();
  // A sameness fail that names only the user's own skill's drafts isn't rewritten by floorboss: the critic reads them.
  if (lastBatch?.verdict === 'FAIL' && batchAt >= lastDraftAt && failsInRow < 2 && !userOnly) {
    // Never a sent message, nor one held for the user after two critic fails: those aren't the batch's to rewrite.
    const open = jobs.filter(
      (j) => j.kind === 'message' && !j.held_for_user && touchOf(j)?.hash && !touchOf(j).sent && !(touchOf(j).approved?.hash === touchOf(j).hash)
    );
    // Only the drafts the reasons name, when they name any: a reason that says which to rewrite ("rewrite c004,
    // c007") names only those, not every draft it lists.
    const named = new Set((lastBatch.reasons || []).flatMap((r) => (/\brewrite\b[^"]*$/.exec(r)?.[0] || r).match(/\bc\d{3,}\b/g) || []));
    // The user's own skill's drafts are never rewritten by floorboss's writer for sameness.
    // Nor the user's own edits: "yours, left as is".
    const again = (named.size ? open.filter((j) => named.has(j.id)) : open).filter((j) => j.drafter?.by !== 'user' && !mine(j));
    if (!again.length) {
      /* nothing floorboss may rewrite: go on to the critic */
    } else
      return step(
        'draft',
        `The batch reads too much alike (${lastBatch.reasons.slice(0, 3).join('; ')}). Rewrite the drafts it names: vary the opening, the angle or the proof.`,
        {
          ...stuckNote,
          judge: {
            read: todoFile,
            ids: again.map((j) => `${j.id}:${j.touch}`),
            batch_reasons: lastBatch.reasons,
            write: join(e.paths.work, 'drafts-batch.json'),
            format: draftFormat(again),
            then: node('event-outreach', 'save-drafts', '--event', e.event.slug, '--drafts-file', join(e.paths.work, 'drafts-batch.json'))
          },
          help: 'skills/event-outreach/SKILL.md'
        }
      );
  }
  if (lastDraftAt && batchAt < lastDraftAt)
    return step('batch_check', 'Do the drafts read as one mail merge? Sameness across the batch is checked before the critic.', {
      run: node('event-outreach', 'batch-check', '--event', e.event.slug)
    });
  const stuckIds = new Set(stuck.map((j) => `${j.id}:${j.touch}`));
  const needCritic = jobs.filter(
    (j) =>
      j.kind === 'message' &&
      touchOf(j)?.hash &&
      (!touchOf(j).critic || touchOf(j).critic.hash !== touchOf(j).hash) &&
      !touchOf(j).review_skipped &&
      !stuckIds.has(`${j.id}:${j.touch}`)
  );
  if (needCritic.length) {
    // Every batch of five at once: floorboss writes each batch file now; Claude runs one critic per batch in
    // parallel (one message), pasting each file whole, then records each verdict.
    const batches = [];
    for (let k = 0; k < needCritic.length; k += 5) batches.push(needCritic.slice(k, k + 5).map((j) => `${j.id}:${j.touch}`));
    const agents = batches.map((b, k) => {
      // In the event's work folder: a script's --out writes nowhere else.
      const file = join(e.paths.work, `critic-batch-${k + 1}.json`);
      cli('event-outreach', ['critic-batch', '--event', e.event.slug, '--ids', b.join(','), '--compact', '--out', file], c);
      return {
        name: 'floorboss:outreach-critic',
        input_file: file,
        paste: true,
        write: join(e.paths.work, `critic-reply-${k + 1}.txt`),
        then: node('event-outreach', 'verdicts', '--event', e.event.slug, '--ids', b.join(','), '--text-file', join(e.paths.work, `critic-reply-${k + 1}.txt`))
      };
    });
    return step(
      'critic',
      `${plural(needCritic.length, 'draft')} for the separate critic: ${agents.length} ${agents.length === 1 ? 'critic' : 'critics'} at once (in parallel, one message). Paste each critic its whole batch file, exactly as written; never summarise it.`,
      { ...stuckNote, agents, if_user_says: SKIP_REVIEW_HINT, accepts: ['skip_review'] }
    );
  }
  // Drafts that failed the critic twice are held for the user: said out loud at the first step after (the
  // ratings or the approval), like the stuck drafts, not left for the user to find in a list.
  const heldNow = [
    ...new Map(
      jobs
        .filter((j) => j.critic_held && !touchOf(j)?.dropped && !(touchOf(j)?.approved && touchOf(j).approved.hash === touchOf(j).hash))
        .map((j) => [`${j.id}:${j.touch}`, j])
    ).values()
  ];
  const lastHeldFail = Math.max(
    0,
    ...e.entries.map((x, k) => (x.type === 'critic' && x.verdict === 'FAIL' && heldNow.some((j) => j.id === x.id && j.touch === (x.touch ?? 1)) ? k + 1 : 0))
  );
  // Said once: at the ratings, or at the first approval after the fail (an approval answered since means the user
  // saw it); after that the approval carries a short count instead of the whole paragraph again.
  const toldSince = (k) =>
    e.entries.slice(k).some((x) => x.type === 'copy_rating' || x.type === 'approved' || (x.type === 'answered' && ['rate', 'approve'].includes(x.ask)));
  const heldLine = heldNow.length
    ? `${heldNow.length === 1 ? 'One draft failed' : `${heldNow.length} drafts failed`} the critic twice, so ${heldNow.length === 1 ? 'it is' : 'they are'} held for you: ${heldNow.map((j) => `${j.contact?.name || j.id} (${j.id}${j.touch > 1 ? `:${j.touch}` : ''}): ${(touchOf(j)?.critic?.reasons || []).slice(0, 2).join('; ') || 'see the card'}${failsOf(j) ? ` (${failsOf(j)} in all)` : ''}`).join('; ')}. At approval you can edit ${heldNow.length === 1 ? 'it' : 'them'}, drop ${heldNow.length === 1 ? 'it' : 'them'}, or approve one by id to send it as it is.`
    : null;
  const withHeld = (note, show) => (show && heldLine ? { ...note, tell_user: [note.tell_user, heldLine].filter(Boolean).join(' ') } : note);
  const heldCount = heldNow.length
    ? `${heldNow.length === 1 ? 'One draft is' : `${heldNow.length} drafts are`} still held after two critic fails (${heldNow.map((j) => `${j.id}${j.touch > 1 ? `:${j.touch}` : ''}`).join(', ')}).`
    : null;
  const ratedAny = Object.values(e.state.people).some((p) => p.ratings.length) || e.state.answered.rate;
  const passed = jobs.filter((j) => j.kind === 'message' && touchOf(j)?.critic?.verdict === 'PASS' && touchOf(j).critic.hash === touchOf(j).hash);
  const carried = !ratedAny && passed.length >= 3 ? ratingsCarry(e) : null;
  if (!ratedAny && !carried && passed.length >= 3 && !Object.values(e.state.people).some((p) => Object.values(p.touches).some((t) => t.approved)))
    return step(
      'rate',
      "Before the first approval: rate a blind set of the drafts as their readers would. Your ratings, not the critic's, are the measure of the copy; anything you rate 3 or less is written again.",
      {
        ...withHeld({}, true),
        run_first: node('event-outreach', 'rate-set', '--event', e.event.slug),
        ask: {
          id: 'rate',
          question: `Show ${join(e.paths.derived, 'rate-set.md')}. For each, how likely is that reader to reply, 1 to 10? A few words if something stands out. Or skip.`,
          answer_format: 'lines like "1: 6 too salesy", or the word skip'
        }
      }
    );
  // Notes on the blind ratings are about the whole set, not only the drafts rated: asked once whether every
  // draft not yet approved is written again to them, or only the rated drafts with a note (each to its own note;
  // those rated 3 or less went back when rated). Asked even when every draft was rated: "every draft" also makes
  // the notes rules in the voice file.
  // Only notes that ask for something: praise ("fine", "plain, fine for a customer") is a rating, not feedback
  // for every draft. Nor a pointer to another draft ("same as 1", "see 3", "ditto", "2"); one word ("generic") is
  // a note. A note about sameness was already acted on when it was rated (rate sends those drafts back).
  const rateNotes = [...new Set(e.entries.filter((x) => x.type === 'copy_rating' && x.note && asRule(x.note)).map((x) => x.note))];
  if (rateNotes.length && !e.state.answered.rate_notes && !Object.values(e.state.people).some((p) => Object.values(p.touches).some((t) => t.approved)))
    return step('rate_notes', 'The user left notes on the rated drafts: they may apply to all of them.', {
      ask: {
        id: 'rate_notes',
        notes: rateNotes,
        question: `Your notes: ${rateNotes.map((n) => `"${n}"`).join('; ')}. Apply them to every draft, so each is written again to them (and they become rules in your voice file)? Or only the ones you rated: each draft with a note is written again to its own note (anything rated 3 or less already is), and the rest stay as they are?`,
        options: ['yes, every draft', 'only the ones I rated (those with a note, or rated 3 or less)'],
        answer_format: 'yes | only'
      }
    });
  Object.assign(x, { jobs, touchOf, staleWhy, mine, stuck, stuckNote, heldNow, lastHeldFail, toldSince, withHeld, heldCount, carried });
}
