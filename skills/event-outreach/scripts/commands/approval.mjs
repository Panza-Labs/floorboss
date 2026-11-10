// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Approval (the gate): reads the user's answer about the drafts and records exactly what they approved.
import { join } from 'node:path';
import { need } from '../../../../lib/args.mjs';
import { readJson, writeJson, writeText } from '../../../../lib/jsonio.mjs';
import { parseGate, gatePeople, unnamedWords } from '../../../../lib/gate.mjs';
import { namesToIds } from '../../../../lib/names.mjs';
import { touchBefore } from '../../../../lib/route.mjs';
import { companyWords } from '../../../../lib/gate.mjs';
import { approvalHash } from '../../../../lib/sendcheck.mjs';
import { toOf, sendRoute, whereAt } from './routes.mjs';
import { ctxOf, sameSlots, sendingOn, isOut, led } from './context.mjs';
import { readTodo, savedDraft, ledgerTouch, staleFor } from './saved-drafts.mjs';
import { renderFile, allOutboxCards } from './cards.mjs';

export function gate(opts) {
  need(opts, 'event');
  const c = ctxOf(opts.event, opts);
  const t = readTodo(c, null);
  if (!t) throw new Error('Run "todo" first.');
  const ids = new Set(t.jobs.map((j) => j.id));
  // The user's own answer, every time: an approval is recorded with the words they said, so there is no
  // default to fall back on (a missing --answers is never "approve all").
  if (typeof opts.answers !== 'string' || !opts.answers.trim())
    throw new Error('The gate needs the user\'s answer: --answers "<their words>" (approve all, approve c014, edit c017, drop c019 …). Nothing was approved.');
  // A line that can't be read is refused on its own and the rest applied (said back in "refused"), except beside
  // "approve all", or when the refused line names someone another line approves: it may have been meant to hold
  // them back, so nothing is approved.
  const everyone = t.jobs.map((j) => ({ id: j.id, name: c.byId[j.id]?.name || '', company: c.byId[j.id]?.company || '' }));
  const byName = gatePeople(everyone);
  // Every listed name and company counts as unnamed: a remark beside "approve all" holding any word of one ("all but
  // Lind", "all but the Acme person") may be holding that person back.
  const g = parseGate(namesToIds(opts.answers, byName), { kind: 'draft', knownIds: ids, partial: true, unnamed: [...unnamedWords(everyone, []), ...companyWords(everyone)] });
  const approvedNamed = new Set(g.actions.filter((a) => a.verb === 'approve').flatMap((a) => a.ids.map((x) => x.replace(/:\d+$/, ''))));
  const refusedNames = g.refused.flatMap((r) => r.line.toLowerCase().match(/\bc\d{3,}\b/g) || []);
  // A refused line may name them in words too: a name only resolves as a whole list item ("Bo Li not yet" stays words).
  const approvedWords = unnamedWords(everyone.filter((p) => approvedNamed.has(p.id)), []);
  const namesApproved = approvedWords.length && new RegExp(`(?<![\\p{L}\\d])(?:${approvedWords.join('|')})(?![\\p{L}\\d])`, 'iu');
  if (
    g.refused.length &&
    (g.defaults || g.actions.some((a) => a.verb === 'approve-all') || !g.actions.length || refusedNames.some((x) => approvedNamed.has(x)) || (namesApproved && g.refused.some((r) => namesApproved.test(r.line))))
  )
    throw new Error(
      `${g.refused.map((r) => `"${r.line}": ${r.why}`).join(' ')}${g.actions.length || g.defaults ? ' Nothing was approved: with "approve all", a line that can\'t be read might have meant to hold someone back. Ask the user about it.' : ''}`
    );
  let approve = new Set(),
    drop = new Set(),
    edit = [];
  const dropTouch = [];
  const editTouch = new Set();
  const named = new Set();
  if (g.defaults) t.jobs.forEach((j) => approve.add(j.id));
  for (const a of g.actions) {
    if (a.verb === 'approve-all')
      t.jobs.forEach((j) => {
        if (!a.except.includes(j.id)) approve.add(j.id);
      });
    // By name: approved even past a critic FAIL, unless it came as a bare "c016 too" beside "approve all".
    if (a.verb === 'approve')
      a.ids.forEach((id) => {
        approve.add(id);
        if (!a.pass_only) named.add(id);
      });
    // "drop c017:2" drops that follow-up only; "drop c017" drops the person. "edit c017:2" opens that message.
    if (a.verb === 'drop')
      a.ids.forEach((id) => {
        if (/:\d+$/.test(id)) dropTouch.push(id);
        else {
          drop.add(id);
          approve.delete(id);
        }
      });
    if (a.verb === 'edit')
      a.ids.forEach((id) => {
        edit.push(id);
        if (/:\d+$/.test(id)) editTouch.add(id);
        else approve.delete(id);
      });
  }
  const notReady = [];
  const done = [];
  const doneTouch = new Set();
  const heldForYou = [];
  // Why a job can't be approved now (null: it can), without the rule about the message before it.
  // The verdict, the checks and the text are the ledger's (savedDraft), never the working copy's: Claude may
  // write that file, and one Write there turned a critic FAIL into a PASS or cleared a failing check.
  const whyNot = (j, d0) => {
    if (!d0) return { reason: 'not written yet' };
    if (j.critic_held && !named.has(j.id))
      return { held: true, reason: `failed the critic twice: edit it, drop it, or approve ${j.id} by name to send it anyway` };
    const why = c.blocked(j.id, j.kind);
    if (why) return { reason: `can't be contacted now: ${why}` };
    const d = savedDraft(c, j.id, j.touch, d0);
    if (!d)
      return {
        reason: ledgerTouch(c, j.id, j.touch).read
          ? 'its text changed after the critic read it: save it again (save-draft) and send it to the critic again'
          : 'its text changed after it was saved: save it again (save-draft), then the critic reads it'
      };
    if (j.kind === 'message' && sameSlots(d.slot_ids, j.slot_ids) === false)
      return { reason: 'its offered times changed since it was written: it needs a new draft with the new times' };
    if (j.kind === 'confirmation' && d.checks?.length) return { reason: `confirmation checks failing: ${d.checks.join('; ')}` };
    if (j.kind === 'confirmation' && d.booked_slot && d.booked_slot !== c.state[j.id]?.booked)
      return { reason: 'the booking changed since this confirmation was written' };
    if (j.kind === 'message' && d.checks?.length) return { reason: `script checks failing: ${d.checks.join('; ')}` };
    if (j.kind === 'message' && !d.verdict)
      return {
        reason: ledgerTouch(c, j.id, j.touch).read ? 'its text changed after the critic read it: send it to the critic again' : "the critic hasn't read it"
      };
    if (j.kind === 'message' && staleFor(c, j.id, j.touch, d)) return { reason: 'the message before it was rewritten: it needs a new draft' };
    if (j.kind === 'message' && d.verdict.verdict === 'FAIL' && !named.has(j.id))
      return {
        reason: `failed the critic (${d.verdict.reasons.join('; ')}); edit it, drop it, approve ${j.id} by name to send it anyway, or ask for a fresh attempt`
      };
    return null;
  };
  // With sending on, a person's whole sequence is approved together or not at all: a first message never goes
  // while a follow-up of its sequence is unwritten, held or failing ("approve all" never sends first messages
  // alone).
  const seqOk = {};
  if (sendingOn(c.settings))
    for (const id of new Set(t.jobs.filter((j) => j.kind === 'message' && approve.has(j.id)).map((j) => j.id))) {
      // A follow-up dropped in this same answer is out of the sequence.
      const seq = t.jobs.filter((j) => j.id === id && j.kind === 'message' && !dropTouch.includes(`${j.id}:${j.touch}`)).sort((a, b) => a.touch - b.touch);
      if (seq.length < 2) continue;
      // An approved follow-up counts only while it's written for the message before it as that is now.
      const current = (j) => {
        return !staleFor(c, j.id, j.touch, savedDraft(c, j.id, j.touch) || readJson(j.draft_file, null));
      };
      const bad = seq
        .map((j) => ({
          j,
          w: whyNot(j, readJson(j.draft_file, null)) || (current(j) ? null : { reason: 'was written for an earlier version of the message before it' })
        }))
        .find((x) => x.w && !((c.state[id]?.touches?.[x.j.touch]?.status === 'outboxed' && current(x.j)) || c.state[id]?.sent?.[x.j.touch]));
      if (bad) seqOk[id] = `its sequence isn't ready: ${bad.j.touch === 1 ? 'the first message' : `follow-up ${bad.j.touch - 1}`} ${bad.w.reason}`;
    }
  for (const j of [...t.jobs].sort((a, b) => (a.touch || 0) - (b.touch || 0))) {
    if (!approve.has(j.id) || editTouch.has(`${j.id}:${j.touch}`) || dropTouch.includes(`${j.id}:${j.touch}`)) continue;
    const raw = readJson(j.draft_file, null);
    const w = whyNot(j, raw);
    if (w?.held) {
      heldForYou.push({ id: j.id, touch: j.touch, reason: w.reason });
      continue;
    }
    if (w) {
      notReady.push({ id: j.id, touch: j.touch, reason: w.reason });
      continue;
    }
    if (j.kind === 'message' && seqOk[j.id]) {
      notReady.push({ id: j.id, touch: j.touch, reason: seqOk[j.id] });
      continue;
    }
    // A follow-up is approved only with the very message before it (approved now, earlier, or already sent).
    if (j.kind === 'message' && j.touch > 1) {
      const beforeT = touchBefore(c.state[j.id], j.touch);
      const prevSt = c.state[j.id]?.touches?.[beforeT]?.status;
      if (!(doneTouch.has(`${j.id}:${beforeT}`) || isOut(prevSt) || c.state[j.id]?.sent?.[beforeT])) {
        notReady.push({ id: j.id, touch: j.touch, reason: `follow-up ${j.touch - 1} waits for message ${j.touch - 1} to be approved` });
        continue;
      }
    }
    const d = savedDraft(c, j.id, j.touch, raw);
    const to = toOf(c, { ...d, holder: j.holder || d.holder });
    // A message the critic failed, approved by the user by name: said so in the ledger, the only place a send
    // reads it from (verifySend).
    const failed = j.kind === 'message' && d.verdict?.verdict === 'FAIL';
    led(c, {
      type: 'approved',
      id: j.id,
      touch: j.touch,
      hash: approvalHash(d, to),
      to,
      via: j.kind === 'coordinate' ? 'note' : sendRoute(c, j.id, d.channel, j.touch)?.via || 'you',
      ...(d.channel === 'paste' ? { where: whereAt(c, j.id, j.touch) } : {}),
      said: String(opts.answers).slice(0, 200),
      ...(failed ? { critic_override: true } : {})
    });
    done.push(j.id);
    doneTouch.add(`${j.id}:${j.touch}`);
  }
  for (const id of drop) led(c, { type: 'dropped', id, said: String(opts.answers || 'drop').slice(0, 200) });
  for (const k of dropTouch) {
    const [id, tt] = k.split(':');
    led(c, { type: 'dropped', id, touch: Number(tt), said: String(opts.answers || 'drop').slice(0, 200) });
  }
  // Passed over by an approval ("approve all except c012", "approve c004"): those wait for the user's word. An
  // answer that only edits or drops passes over nobody (it left every other draft out, and the next approval
  // offered one message of ten).
  const approving = g.defaults || g.actions.some((a) => a.verb === 'approve' || a.verb === 'approve-all');
  const leftOut = approving
    ? t.jobs.filter((j) => j.kind === 'message' && !approve.has(j.id) && !drop.has(j.id) && !edit.includes(j.id)).map((j) => `${j.id}:${j.touch}`)
    : t.left_out || [];
  writeJson(join(c.paths.derived, 'todo.json'), { ...t, left_out: leftOut });
  const editFiles = edit.map((k) => {
    const [id, tt] = k.split(':');
    const j = t.jobs.find((x) => x.id === id && (!tt || x.touch === Number(tt))) || t.jobs.find((x) => x.id === id);
    const d = savedDraft(c, j.id, j.touch) || readJson(j.draft_file, {});
    const md = j.draft_file.replace(/\.json$/, '.md');
    writeText(md, `${d.subject ? `Subject: ${d.subject}\n\n` : ''}${d.body || ''}\n`);
    // Written down, so the next step is this edit (the file, then save-draft), not the approval without it.
    led(c, { type: 'answered', who: 'user', ask: 'edit', value: `${id}:${j.touch}`, said: String(opts.answers).slice(0, 200) });
    return {
      id,
      touch: j.touch,
      file: md,
      then: `save-draft --event ${c.event.slug} --id ${id} --touch ${j.touch} --md-file ${md} (saved as the user's own edit: floorboss never rewrites it), run the critic, then approve ${id}`
    };
  });
  const c2 = ctxOf(opts.event, opts);
  const outbox = renderFile(c2, allOutboxCards(c2));
  return {
    approved: done.length,
    dropped: drop.size + dropTouch.length,
    to_edit: editFiles,
    not_ready: notReady,
    held_for_you: heldForYou.length ? heldForYou : undefined,
    outbox,
    ...(g.refused.length
      ? { refused: g.refused, note_refused: 'These lines were not read, and nothing in them was done: ask the user about them. The rest was applied.' }
      : {}),
    ...(g.comments?.length ? { read_as_comment: g.comments } : {})
  };
}

// approve-round --event <slug> --touch <n> [--ids …]: with follow-ups set to each_round, the user's yes to the
// next round of follow-ups (all, or named people).
export function approveRound(opts) {
  need(opts, 'event', 'touch');
  const c = ctxOf(opts.event, opts);
  const touch = Number(opts.touch);
  if (!(Number.isInteger(touch) && touch >= 2 && touch <= 10)) throw new Error("--touch is the follow-up's message number (2 for the first follow-up).");
  const ids = opts.ids
    ? String(opts.ids)
        .split(/[\s,]+/)
        .filter((x) => /^c\d+$/.test(x))
    : null;
  if (!opts.said || String(opts.said).trim().length < 3) throw new Error("approve-round needs --said with the user's own words.");
  if (c.settings.sending?.followups === 'scheduled')
    return { approved_round: null, note: 'Follow-ups are scheduled for this event: they go on their day without a round approval. Nothing to do.' };
  led(c, { type: 'round_approved', touch, ...(ids ? { ids } : {}), said: opts.said ? String(opts.said).slice(0, 200) : undefined });
  return { approved_round: touch, for: ids || 'everyone due' };
}
