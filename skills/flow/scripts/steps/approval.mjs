// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Phase 7 of nextStep.
import { join } from 'node:path';
import { readJson } from '../../../../lib/jsonio.mjs';
import { plural } from '../../../../lib/plural.mjs';
import { routineStopWords } from '../../../../lib/autosend/routine.mjs';
import { readback } from '../../../../lib/autosend/approval.mjs';
import { step, node, pendingLine, pendingAsk, handSend, cli } from './shared.mjs';
import { sessionRun } from '../../../../lib/scope.mjs';
import { wholeSequence } from '../../../event-outreach/scripts/commands/context.mjs';
import { systemZone, zonedToUtc, wallParts, todayKeyIn, parseDateKey } from '../../../../lib/tz.mjs';

// The daily task's time in the show's zone, and in the user's own when that differs (the Codex skill says both).
export function taskTimeLine(time, zone, own, now = new Date()) {
  if (!own || own === zone) return `${time} (${zone} time)`;
  const [hh, mm] = String(time).split(':').map(Number);
  const at = zonedToUtc({ ...parseDateKey(todayKeyIn(zone, now)), hh, mm }, zone);
  const w = wallParts(at, own);
  return `${time} (${zone} time), which is ${w.hh}:${String(w.mm).padStart(2, '0')} your time (${own})`;
}

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

// The held lines of the approval, from the gate's own refusals (event-outreach approvable): one per person it holds
// (one per message without whole sequences, when another message of theirs is on the screen), with the advice that
// fits the reason. A contact that can't be written to is said once for everyone it holds, with what fixes it.
// refused: approvable's refused list; offered and candidates: "id:touch" keys; nameOf(id); whole: whole sequences.
export function heldLines({ refused, offered, candidates, nameOf, whole }) {
  const on = new Set(offered);
  const cand = new Set(candidates);
  const msgName = (k, kind) => {
    const t = Number(String(k).split(':')[1]);
    if (kind === 'coordinate') return 'the note to your colleague about them';
    if (kind === 'confirmation' || t === 0) return 'the confirmation';
    return t > 1 ? `follow-up ${t - 1}` : 'the first message';
  };
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  const trim = (x) => String(x || '').replace(/[.\s]+$/, '');
  const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);
  const lines = [];
  const blocked = new Map();
  const seen = new Set();
  for (const r of refused) {
    const k0 = `${r.id}:${r.touch}`;
    if (!cand.has(k0)) continue;
    const k = r.blocking || k0;
    const kind = r.blocking_kind || r.kind;
    if (r.cause === 'blocked') {
      const why = trim(String(r.why || r.reason).replace(/^can't be contacted now: /, ''));
      if (!blocked.has(why)) blocked.set(why, []);
      if (!blocked.get(why).includes(r.id)) blocked.get(why).push(r.id);
      continue;
    }
    // Without whole sequences, another message of theirs on the screen: this message is held, not the person.
    const own = !whole && offered.some((x) => x.startsWith(`${r.id}:`));
    const key = whole || !own ? (r.cause === 'waits' ? k0 : r.id) : k0;
    if (seen.has(key)) continue;
    seen.add(key);
    const who = `${nameOf(r.id)} (${r.id})`;
    const msg = msgName(k, kind);
    const why = trim(r.why || r.reason);
    if (r.cause === 'waits') {
      lines.push(
        `${cap(msgName(k0, r.kind))} to ${nameOf(r.id)} (${k0}) waits for ${msg} (${k}) to be approved.${r.blocking_absent ? ` That message isn't in this round's list: say "drop ${k0}" to leave this one out.` : ''}`
      );
      continue;
    }
    // Approving the person by name lifts only a critic hold: said beside what else holds them.
    const criticToo = r.cause !== 'critic' ? refused.find((x) => x.id === r.id && x.cause === 'critic') : null;
    const override = criticToo ? ` Approving ${r.id} by name overrides only the critic hold on ${msgName(`${criticToo.id}:${criticToo.touch}`, criticToo.kind)} (${criticToo.id}:${criticToo.touch}), not this.` : '';
    const before = lines.length;
    const lead = own ? `${cap(msg)} to ${nameOf(r.id)} (${k}) is not offered` : `${who} is held`;
    if (r.cause === 'unwritten') lines.push(`${lead} until ${own ? 'it' : `${msg} (${k})`} is written: it isn't written yet. Say "edit ${k}" to write it, or "drop ${k}".`);
    // The gate's advice to save it again (save-draft) is the agent's to follow; the user is given what they can say.
    else if (r.cause === 'edited') lines.push(`${lead} until ${own ? 'it' : `${msg} (${k})`} is rewritten or dropped: ${why.split(/: save it again/)[0]}. Say "edit ${k}" to fix it, or "drop ${k}".`);
    else if (r.cause === 'unread') lines.push(`${lead} until the critic has read ${own ? 'it' : `${msg} (${k})`}: floorboss sends it to the critic on its next run.`);
    else if (r.cause === 'critic') lines.push(`${lead}: ${own ? 'it' : `${msg} (${k})`} ${why}.`);
    else lines.push(`${lead} until ${own ? 'it' : `${msg} (${k})`} is rewritten or dropped: ${why}. Say "edit ${k}" or "drop ${k}".`);
    if (override && lines.length > before) lines[lines.length - 1] += override;
  }
  for (const [why, ids] of blocked) {
    const names = ids.map(nameOf);
    // Everyone it holds is named: by name up to four, and by name and ID beyond (no one is left as "and 2 more").
    if (ids.length > 4) {
      lines.push(`floorboss can't write to ${ids.length} people now, ${list(ids.map((id, i) => `${names[i]} (${id})`))}: ${why}.`);
      continue;
    }
    const who = ids.length === 1 ? `${names[0]} (${ids[0]}) now` : `${ids.length} people now (${list(names)})`;
    lines.push(`floorboss can't write to ${who}: ${why}.`);
  }
  return { lines, problem: lines.length > 0 };
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
  const approvedNow = (j) => !!(touchOf(j)?.approved && touchOf(j).approved.hash === touchOf(j).hash);
  const offerable = (j) =>
    !/^left out/.test(j.held_for_user || '') &&
    touchOf(j)?.hash &&
    !staleWhy(j) &&
    !approvedNow(j) &&
    !touchOf(j).dropped &&
    (j.kind !== 'message' || touchOf(j).critic?.verdict === 'PASS' || touchOf(j).review_skipped);
  // Offered only what the gate would approve on "approve all" now, by its own rule (event-outreach approvable, the same
  // planApproval the gate writes from): a draft it would refuse with nothing changed (a sequence with a stuck or held
  // message, a working copy edited by hand, a LinkedIn note over the limit as it stands now) would bring the same
  // question back forever. Each person it holds is named once, with the message and what to say.
  const candidates = jobs.filter(offerable);
  // What can't be checked is never offered: a check that fails or answers something unreadable stops the approval
  // here and says so (offering every draft would ask the same question again for any the gate refuses).
  let gateSays = null,
    checkFailed = null;
  if (candidates.length) {
    try {
      gateSays = cli('event-outreach', ['approvable', '--event', e.event.slug], c);
    } catch (err) {
      checkFailed = String(err?.message || err).slice(0, 200);
    }
    if (!checkFailed && !(gateSays && Array.isArray(gateSays.offer) && Array.isArray(gateSays.refused))) checkFailed = 'its answer could not be read';
  }
  if (checkFailed)
    return step('waiting', `Stopped for now: floorboss couldn't check which drafts can be approved (${checkFailed}).`, {
      done: false,
      // Only the user (or a fix) clears this: the agent stops and shows it, it doesn't run flow next again and again.
      stop: true,
      tell_user: `floorboss couldn't check which drafts can be approved, so it isn't asking you to approve anything now. Nothing was approved or sent. Say "try again" to have floorboss check again; if it fails again, the check itself is failing (${checkFailed.replace(/[()]/g, '')}).`,
      next_check: 'Run again. Nothing is offered for approval until the check works.'
    });
  const offer = new Set(gateSays?.offer || []);
  const needApprove = candidates.filter((j) => offer.has(`${j.id}:${j.touch}`));
  const nameOf = (id) => jobs.find((j) => j.id === id)?.contact?.name || id;
  const held = heldLines({
    refused: gateSays?.refused || [],
    offered: needApprove.map((j) => `${j.id}:${j.touch}`),
    candidates: candidates.map((j) => `${j.id}:${j.touch}`),
    nameOf,
    whole: wholeSequence({ settings: e.settings, event: e.event })
  });
  const waitLine = held.lines.length ? held.lines.join(' ') : null;
  // The held drafts are said with "approve by id": that answer is taken here too, after the approve step is past.
  const heldMustNote =
    mustLine || leftOutLine || heldEndLine || mineLine || waitLine
      ? {
          tell_user: [mineLine, mustLine, heldEndLine, leftOutLine, waitLine].filter(Boolean).join(' '),
          // Someone is held for something only the user can settle: the run isn't "done" while it stands.
          ...(held.lines.length ? { held_problem: true } : {}),
          // By name only (approve_held: "approve c004", "drop c007:2"), never "approve all" or a bare yes.
          ...(heldNow.length || mineFailed.length || leftOutLine || waitLine
            ? { accepts: ['approve_held'], answer_held: 'flow answer --ask approve_held with "approve <ids>", "drop <ids>" or "edit <id>"' }
            : {})
        }
      : {};
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
  // Claude Code: "Automatically" at the follow-up question (onboarding-tree followups_mode) turns auto-send on through a
  // daily Claude routine before the approval, from the address the send setup saved. Without one, the user is asked
  // for it at the final approval as before (skills/flow/SKILL.md "Turning it on").
  const ownCc = c.cfg?.own_email || null;
  const setupPick = ['auto', 'drafts', 'self'].includes(c.ob?.ans?.setup_pick) ? c.ob.ans.setup_pick : 'auto';
  if (!handSend() && sendSaid && !e.event?.autosend && needApprove.length) {
    // No address saved: asked here, never a silent fall back to sending from the session.
    if (!ownCc)
      return step('autosend_own', 'The final choice needs the Gmail address your follow-ups go from.', {
        ask: {
          id: 'send_setup',
          question: 'Which Gmail address do you send from? floorboss needs it before your final choice: the daily routine checks it sends from that account.',
          answer_format: 'the address, e.g. "you@example.com"'
        }
      });
    return step('autosend_on', 'Turning auto-send on (a daily routine in your Claude account) before the approval, so the final choice comes after it.', {
      run: node('autosend', 'on', '--event', e.event.slug, '--said', String(sendSaid), '--own', ownCc, '--setup-pick', setupPick),
      help: 'skills/flow/SKILL.md'
    });
  }
  // Codex auto-send sends through one daily ChatGPT task the user creates: right after auto-send is turned on, the steps
  // to create it, then the user's word that it exists ("not yet" is asked again another day).
  const dtAns = e.state.answered.daily_task;
  // "not yet" is asked again at every session start while the task isn't there, before the approval and after it.
  const dtYes = dtAns && /^yes/i.test(String(dtAns.value));
  // With no session run known (a script, not a session), "not yet" holds for the day.
  const dtDone = dtYes || (!!dtAns && (dtAns.run ? dtAns.run === (sessionRun() || null) : String(dtAns.at).slice(0, 10) === c.now.toISOString().slice(0, 10)));
  const dtApproved = e.entries.some((x) => x.type === 'autosend_approved');
  if (handSend() && e.event?.autosend && e.event?.autosend_mode === 'drafts' && (needApprove.length || dtApproved) && !dtDone) {
    let dt = null;
    try {
      dt = cli('autosend', ['daily-task'], c);
    } catch {
      /* no zone or two events in two zones: the approval says what is wrong */
    }
    if (dt?.link)
      return step('daily_task', 'Auto-send in Codex needs one daily task in ChatGPT: the user creates it once, now.', {
        ask: {
          id: 'daily_task',
          question: `${dtAns && !dtYes ? 'Nothing will be sent until you create the task. ' : ''}Auto-send needs one daily task in ChatGPT: it sends each email waiting in your Gmail drafts on its day, even with your laptop closed. Until it exists, nothing in your drafts is sent. 1. Open this link in the browser where you're signed in to ChatGPT: ${dt.link} It opens chatgpt.com with the setup already typed: press send. (If the box is empty, copy everything in ${dt.file} and paste it into a new chat at chatgpt.com.) 2. Check that ChatGPT confirms the task "${dt.task}" every day at ${taskTimeLine(dt.time, dt.zone, systemZone(), c.now)}. 3. Keep that chat: deleting or archiving it pauses the task. If it ever shows Paused (chatgpt.com, Scheduled), click Resume. 4. The first time it sends, ChatGPT asks to send an existing Gmail draft: click "Always allow". It must be a chat at chatgpt.com in the browser: a Codex chat makes a task that needs your laptop on. Is the task created?`,
          options: ["yes, it's created: floorboss goes on to your approval", 'not yet: floorboss goes on and asks again the next time you open it; until then nothing in your drafts is sent'],
          answer_format: '"yes, it\'s created" | "not yet"'
        }
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
  const { customerJobs, customerLine } = customerApproval(needApprove, resolvedNow);
  const approvedBefore = e.entries.some((x) => x.type === 'approved');
  // Hand-send: one change, one confirmation. What changed since the last yes (a new address, a rewrite) and every
  // message it touches, said once with the one question (the shortlist isn't shown again for a list reloaded with only
  // new addresses: triage.mjs).
  const changeLine = approvedBefore ? changedSince(e, needApprove, touchOf) : null;
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
        ? e.event?.autosend
          ? `${plural(needApprove.length, 'message')} ${needApprove.length === 1 ? 'is' : 'are'} ready for the user's yes. Each is shown in full. Once approved, floorboss asks one more yes (every person's days, read back), then sends the first emails and queues the rest as Gmail drafts.`
          : `${plural(needApprove.length, 'message')} ${needApprove.length === 1 ? 'is' : 'are'} ready for the user's yes. Each is shown in full; once approved, the user sends each one from their own mail app or copies it.`
        : e.event?.autosend && e.event.autosend_mode === 'routine'
          ? `${plural(needApprove.length, 'message')} ${needApprove.length === 1 ? 'is' : 'are'} ready for the user's yes. The review lists each person's planned day for every message it covers. Once approved, floorboss reads back every person's days and asks how they should go: sent automatically (first emails now, follow-ups by a daily routine in their Claude account), put in their Gmail drafts, or sent by them.`
          : `${plural(needApprove.length, 'message')} ${needApprove.length === 1 ? 'is' : 'are'} ready for the user's yes. The review lists each person's planned day for every message it covers.`,
      {
        ...(() => {
          const full = lastHeldFail && !toldSince(lastHeldFail);
          const n0 = withHeld(stuckNote, full);
          const n1 = !full && heldCount ? { ...n0, tell_user: [n0.tell_user, heldCount].filter(Boolean).join(' ') } : n0;
          const n = mineLine ? { ...n1, tell_user: [mineLine, n1.tell_user].filter(Boolean).join(' ') } : n1;
          const m = approveAgain ? { ...n, tell_user: [approveAgain, n.tell_user].filter(Boolean).join(' ') } : n;
          return customerLine || waitLine ? { ...m, tell_user: [m.tell_user, waitLine, customerLine].filter(Boolean).join(' ') } : m;
        })(),
        // The review is in the chat, in every host (a sample, the total, one read-only document), never a page.
        run_first: node('flow', 'review', '--event', e.event.slug, '--ids', needApprove.map((j) => `${j.id}:${j.touch}`).join(',')),
        accepts: ['review_feedback'],
        if_user_says: {
          ...(customerJobs.length
            ? {
                'show me the customer messages': `Run ${node('flow', 'review', '--event', e.event.slug, '--ids', customerJobs.map((j) => `${j.id}:${j.touch}`).join(','))} and show every message it lists whole, one by one, then ask this approval again.`
              }
            : {}),
          feedback:
            'Feedback on the drafts, or a rewrite of a line: save it with flow answer --ask review_feedback --value-file <file> as {"feedback":"<their words, whole>","ids":"all" or ["c004:1", …] (the messages it is about; "all" for feedback on the drafts overall)}. floorboss rewrites every message it covers, the critic reads them again, and this question comes back with them.'
        },
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
          question: `${pendingLine(e, 'approval')}${warnLine}Show the review's sample in the chat, each message whole (subject and body), and ask for candid feedback overall or a rewrite of any line; offer its document (every message, to read). Never send the user to a page to review. Then: Approve all ${plural(needApprove.length, 'message')} (the ones shown and the rest in the document), all except some, by name, edit or drop? Once saved, show the answer's say_to_user line word for word: who each name was read as, and who was approved, held back or dropped.`,
          answer_format:
            '"approve all" | "approve all except <ids>" | "approve <ids>" | "edit <ids>" | "drop <ids>" | "skip review <ids|all>" (drafts the critic hasn\'t read go on unreviewed, and their cards say so)'
        }
      }
    );
  // Auto-send on (Codex, or in Claude Code through a daily Claude routine): the content is approved, but nothing is sent
  // until the final approval. That is a step of its own, never "done": the readback is shown and the user picks.
  const routine = !handSend() && e.event?.autosend === true && e.event.autosend_mode === 'routine';
  if (routine) {
    let waiting = 0;
    let hours = [];
    try {
      const rb = readback(e.paths.dir, c.now.getTime());
      waiting = rb.items.length;
      hours = rb.refused.filter((x) => /outside sending hours/.test(x.why));
    } catch {
      waiting = 0;
    }
    // Gmail drafts the daily routine was given whose yes no longer stands (a newer pick, a change of the list): they
    // are deleted before anything else (the readback holds those messages until then).
    const stop = routineStopWords(e.paths.dir, e.event.slug, c.now.getTime());
    if (stop)
      return step('routine_drafts_delete', `${plural(stop.drafts_delete.length, 'Gmail draft')} queued for the daily routine no longer ${stop.drafts_delete.length === 1 ? 'has' : 'have'} the user's yes: deleted first, or the routine could still send ${stop.drafts_delete.length === 1 ? 'it' : 'them'}.`, {
        done: false,
        tell_user: stop.say,
        drafts_delete: stop.drafts_delete,
        how: 'Tell the user tell_user, then call each step in drafts_delete once: the Gmail tool it names with exactly its args (Claude Code asks the user first). Then run flow next again.',
        help: 'skills/flow/SKILL.md'
      });
    // Message 1 goes from this session at the final approval, so the choice is asked only in sending hours: until
    // then nothing of theirs is sent (send-list holds every email no pick stands for), and the flow says so.
    if (!waiting && hours.length) {
      const names = hours.map((x) => e.state.people?.[x.id]?.name || x.id);
      return step('waiting', `The final approval for ${plural(hours.length, 'person', 'people')} waits for sending hours: message 1 goes from this session as soon as the user chooses, and it is outside sending hours now.`, {
        done: false,
        tell_user: `Nothing is sent yet. The last choice (how your messages go) for ${names.join(', ')} comes in sending hours, weekdays 09:00 to 17:00 in the event's time zone: message 1 goes from this session the moment you choose. Run floorboss again then.`,
        next_check: "Run again in sending hours (weekdays 09:00 to 17:00 in the event's time zone).",
        show: hours
      });
    }
    if (waiting)
      return step('second_yes', `${plural(waiting, 'message')} ${waiting === 1 ? 'has' : 'have'} the user's yes for its text, and they haven't chosen yet how ${waiting === 1 ? 'it goes' : 'they go'}. Nothing goes until they choose.`, {
        done: false,
        run_first: node('flow', 'review', '--event', e.event.slug, '--readback'),
        tell_user: 'One more choice before anything is sent: here is every message with the day it goes, then how you want them sent.',
        how: `Show the readback as its show says (every message in sample whole, one line per person from dates, the approval_line, the document). Then ask with the AskUserQuestion tool, passing its choice.ask_user_question exactly as given: floorboss records the pick the user makes there itself. Then run \`node "\${CLAUDE_PLUGIN_ROOT}/skills/autosend/scripts/cli.mjs" approve --event ${e.event.slug} --digest <its digest>\` and do what its next says (skills/flow/SKILL.md, "Daily sending through a Claude routine"). Never choose for them. If they answer in their own words (Other), read it back in plain words and confirm, then do what it asks and show the readback again. If they have changes, ask what to change, redraft, and show what changed. Then run flow next again.`,
        help: 'skills/flow/SKILL.md'
      });
  }
  if (handSend() && e.event?.autosend) {
    let waiting = 0;
    try {
      waiting = readback(e.paths.dir, c.now.getTime()).items.length;
    } catch {
      waiting = 0;
    }
    if (waiting)
      return step('second_yes', `Auto-send is on and ${plural(waiting, 'message')} ${waiting === 1 ? 'has' : 'have'} the user's yes for its text but not yet for being sent on its day. Nothing goes until the second yes.`, {
        done: false,
        run_first: node('flow', 'review', '--event', e.event.slug, '--readback'),
        tell_user: 'One more choice before anything is sent: here is every message with the day it goes, then how you want them sent.',
        how: 'Show the readback as its show says (every message in sample whole, one line per person from dates, the approval_line, the document), then choice.numbered word for word, and ask for the number of their choice. Write their reply to a file and run `autosend approve --event <slug> --digest <its digest> --said-file <file>` (.agents/skills/floorboss/SKILL.md, "The final approval"). Never choose for them. If they answer in their own words, read them back and confirm first. Then do what approve says next, and run flow next again.',
        help: '.agents/skills/floorboss/SKILL.md'
      });
  }
  Object.assign(x, { heldMustNote });
}

// A customer rule from setup that lets customers through (warm, or treated as new): one line on the approval screen,
// and the user may ask to review those messages one by one before anything goes (spec 0.1.7 §7b). No new question.
export function customerApproval(needApprove, resolvedNow) {
  const isCustomer = (id) => {
    const r = resolvedNow[id];
    return !!r && r.rung === 'customer_rule' && !r.note_only && ['warm', 'reach'].includes(r.group);
  };
  const customerJobs = needApprove.filter((j) => j.kind === 'message' && isCustomer(j.id));
  const n = new Set(customerJobs.map((j) => j.id)).size;
  return {
    customerJobs,
    customerLine: n ? `${n} of these go to your customers. You can ask to review each of them before anything goes: say 'show me the customer messages'.` : null
  };
}
