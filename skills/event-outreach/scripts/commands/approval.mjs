// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Approval (the gate): reads the user's answer about the drafts and records exactly what they approved.
import { join } from 'node:path';
import { need } from '../../../../lib/args.mjs';
import { readJson, writeJson, writeText } from '../../../../lib/jsonio.mjs';
import { parseGate, gatePeople, unnamedWords, friendlyAnswer } from '../../../../lib/gate.mjs';
import { namesToIds } from '../../../../lib/names.mjs';
import { directReading, interpretedReading, interpretHint, signature, sameReading, isYes, isAgreement, bareOk, rowsHash, savePending, dropPending, clearPending, peekPending, person, shown } from '../../../../lib/reading.mjs';
import { touchBefore } from '../../../../lib/route.mjs';
import { companyWords } from '../../../../lib/gate.mjs';
import { approvalHash } from '../../../../lib/sendcheck.mjs';
import { inOneGo } from '../../../../lib/ledger.mjs';
import { toOf, sendRoute, whereAt } from './routes.mjs';
import { ctxOf, sameSlots, sendingOn, isOut, led } from './context.mjs';
import { readTodo, savedDraft, ledgerTouch, staleFor, savedBeforeIt } from './saved-drafts.mjs';
import { rebuildOutbox } from './cards.mjs';

// A refusal ends with a hint for Claude (can_interpret, and the people by ID): it may work out what the user meant and
// send that back as an interpreted answer, which is always shown to the user for a yes.
export function gate(opts) {
  try {
    return gateAnswer(opts);
  } catch (e) {
    if (!opts.interpreted && typeof opts.answers === 'string' && opts.answers.trim()) {
      try {
        const c = ctxOf(opts.event, opts);
        const t = readTodo(c, null);
        if (t) e.message = `${e.message.replace(/\s+$/, '')}${interpretHint(t.jobs.map((j) => ({ id: j.id, name: c.byId[j.id]?.name || '' })), c.event.slug)}`;
      } catch {
        /* the refusal still goes */
      }
    }
    throw e;
  }
}

// At a held or stuck draft's own question only a yes to a reading waiting is read; anything else is by ID there.
const agreeOnly = (opts, stale) =>
  `${stale ? `The reading shown before can't be used: ${stale}. ` : 'Nothing is waiting for a yes here. '}${
    opts['agree-only'] === 'stuck'
      ? 'Stuck drafts are dropped or edited by id ("drop c004", "edit c007:2"), or "leave them for now".'
      : 'Here a held draft is approved, dropped or edited by its id only: "approve c004", "drop c007:2", "edit c009".'
  } Nothing was saved.`;

function gateAnswer(opts) {
  need(opts, 'event');
  let c;
  try {
    c = ctxOf(opts.event, opts);
  } catch (e) {
    // No list loaded: no reading can be waiting either.
    if (opts['agree-only']) throw new Error(agreeOnly(opts, null));
    throw e;
  }
  const t = readTodo(c, null);
  if (!t && opts['agree-only']) throw new Error(agreeOnly(opts, null));
  if (!t) throw new Error('Run "todo" first.');
  const ids = new Set(t.jobs.map((j) => j.id));
  // The user's own answer, every time: an approval is recorded with the words they said, so there is no
  // default to fall back on (a missing --answers is never "approve all").
  // --consumed: the flow already did part of the answer (its skip-review or edit lines); --answers is the rest, which
  // may be empty. The gate alone decides what that means for a waiting reading.
  const consumed = typeof opts.consumed === 'string' && opts.consumed.trim() ? opts.consumed.trim() : null;
  if (!consumed && (typeof opts.answers !== 'string' || !opts.answers.trim()))
    throw new Error('The gate needs the user\'s answer: --answers "<their words>" (approve all, approve c014, edit c017, drop c019 …). Nothing was approved.');
  // A line that can't be read is refused on its own and the rest applied (said back in "refused"), except beside
  // "approve all", or when the refused line names someone another line approves: it may have been meant to hold
  // them back, so nothing is approved.
  const everyone = t.jobs.map((j) => ({ id: j.id, name: c.byId[j.id]?.name || '', company: c.byId[j.id]?.company || '' }));
  const byName = gatePeople(everyone);
  // Every listed name and company counts as unnamed: a remark beside "approve all" holding any word of one ("all but
  // Lind", "all but the Acme person") may be holding that person back.
  // DIRECT or CONFIRM (lib/reading.mjs): a reading that isn't plainly what the user typed waits on disk for their yes;
  // "yes" applies exactly that reading, and any other answer drops it and is read afresh.
  // The hash covers each draft as it stands (its text, its status, its approval, the critic's verdict on it), so a draft
  // saved, approved, dropped or judged again since the reading was shown makes it stale: a reading shown while a draft
  // passed never approves it once the critic has failed it. It also covers whether the person can be written to at all
  // (on the shortlist, not skipped or held), so a shortlist answer given since makes the reading stale too.
  const verdictOf = (j) => {
    const v = savedDraft(c, j.id, j.touch, readJson(j.draft_file, null))?.verdict;
    return v ? [v.verdict || null, v.at || null] : null;
  };
  const hash = rowsHash(
    t.jobs.map((j) => {
      const x = c.state[j.id]?.touches?.[j.touch] || {};
      return { id: j.id, name: c.byId[j.id]?.name || '', touch: JSON.stringify([j.touch, x.hash || null, x.status || null, x.approved?.hash || null, !!c.state[j.id]?.dropped, verdictOf(j), c.blocked(j.id, j.kind) || null]) };
    })
  );
  const who = (id) => person(id, c.byId[id]?.name);
  // Drafts the critic failed: approving one by name sends it as it is, so that's said, and never saved at once.
  const failed = new Set(t.jobs.filter((j) => savedDraft(c, j.id, j.touch, readJson(j.draft_file, null))?.verdict?.verdict === 'FAIL').map((j) => j.id));
  const at = { event: c.event.slug, hash, nowMs: c.now.getTime() };
  const hint = () => interpretHint(t.jobs.map((j) => ({ id: j.id, name: c.byId[j.id]?.name || '' })), c.event.slug);
  // flow next asks whether a reading waits, judged as a yes would judge it.
  if (opts['pending-check']) {
    const w = peekPending(c.paths.derived, 'approval', at);
    return w.pending ? { pending: true, text: w.pending.text } : { pending: false, ...(w.stale ? { stale: w.stale } : {}) };
  }
  // Claude's reading of words the code couldn't read: IDs and the gate's own commands only, always shown back first,
  // quoting the user's words.
  if (opts.interpreted) {
    const words = typeof opts.said === 'string' ? opts.said.trim() : '';
    if (!words) throw new Error("An interpreted answer needs the user's exact words (--said-file). Nothing was saved.");
    if (!interpretedReading(opts.answers, { kind: 'draft', ids })) {
      const had = dropPending(c.paths.derived, 'approval');
      throw new Error(`${had ? 'The reading shown before was dropped. ' : ''}An interpreted answer is the gate's own commands with list IDs only, for example "approve all except c002" or "drop c003": no names or other words. Nothing was saved.`);
    }
    const g = parseGate(opts.answers, { kind: 'draft', knownIds: ids, partial: false, among: everyone });
    bothWays(g);
    const text = `You said: ${shown(words, 200, { keepIds: true })}. ${describe(g, [], 'interpreted')} Reply yes to save, or answer again.`;
    savePending(c.paths.derived, 'approval', { event: c.event.slug, rows_hash: hash, created_at: c.now.toISOString(), text, answer: `${words.slice(0, 200)} (read as: ${String(opts.answers).slice(0, 100)})`, read_as: [], reading: keepReading(g) });
    return { saved: false, pending: true, interpreted: true, approved: 0, confirm: text, say_to_user: text, next: "Show say_to_user to the user word for word and wait for their own reply. Never answer it for them." };
  }
  const waiting = peekPending(c.paths.derived, 'approval', at);
  const exists = !waiting.none;
  const answers = typeof opts.answers === 'string' ? opts.answers : '';
  const earlier = exists ? 'The earlier reading was dropped. ' : '';
  // A reading shown back, waiting on disk for the user's own yes; it replaces any earlier one.
  const readBack = (g, readAs, answer, lead = '') => {
    const text = `${lead}${describe(g, readAs, 'confirm')} Reply yes to save, or answer again.`;
    savePending(c.paths.derived, 'approval', { event: c.event.slug, rows_hash: hash, created_at: c.now.toISOString(), text, answer: String(answer).slice(0, 300), read_as: readAs, reading: keepReading(g) });
    return {
      saved: false,
      pending: true,
      approved: 0,
      confirm: text,
      say_to_user: text,
      ...(exists ? { dropped_reading: true } : {}),
      next: "Show say_to_user to the user word for word and wait for their own reply. Their yes goes through flow answer --ask approve like any answer; never answer it for them."
    };
  };
  // Saved: the reading on disk is spent, whatever it was.
  const saved = (r) => {
    clearPending(c.paths.derived, 'approval');
    return exists && r && typeof r === 'object' ? { ...r, dropped_reading: true, say_to_user: `${earlier}${r.say_to_user || ''}`.trim() } : r;
  };
  // A yes to the reading the user was shown: the whole answer is a word of agreement, and that reading is valid.
  if (waiting.pending && !consumed && isAgreement(answers)) {
    let out;
    try {
      out = apply(restoreReading(waiting.pending.reading), waiting.pending.read_as || [], `${waiting.pending.answer} (then ${answers.trim().slice(0, 20)})`);
    } catch (e) {
      if (e.written) clearPending(c.paths.derived, 'approval');
      else e.message = `${e.message} Nothing was saved; the reading shown before still waits for your yes.`;
      throw e;
    }
    clearPending(c.paths.derived, 'approval');
    return out;
  }
  // Where only a reading may be agreed to (a held draft's own question): nothing else is read here.
  if (opts['agree-only'])
    throw new Error(agreeOnly(opts, waiting.stale));
  // The flow did all of the answer (skip-review or edit lines only): any reading waiting was answered by something else.
  if (consumed && !answers.trim()) {
    const had = dropPending(c.paths.derived, 'approval');
    return { saved: false, approved: 0, ...(had ? { dropped_reading: true, say_to_user: 'The earlier reading was dropped.' } : {}) };
  }
  const parseOpts = (readAs) => [namesToIds(friendlyAnswer(answers), byName, everyone, { readAs }), { kind: 'draft', knownIds: ids, partial: true, among: everyone, unnamed: [...unnamedWords(everyone, []), ...companyWords(everyone)] }];
  // An answer that reads as nothing but the gate's own "ok" (ok, defaults, looks good, "ok gracias", however it is
  // dressed, or a word of agreement beside lines the flow did) is never saved at once, in any state: it is read back by
  // ID, approved and not approved, for the user's yes. Approving everyone at once takes the words "approve all".
  const okOnly = (() => {
    if (consumed && bareOk(answers)) return true;
    if (isYes(answers)) return false;
    try {
      const p = parseGate(...parseOpts([]));
      return !!p.defaults && !p.actions.length && !p.refused.length;
    } catch {
      return false;
    }
  })();
  if (okOnly) return readBack({ defaults: true, actions: [], comments: [], refused: [] }, [], answers, waiting.stale && waiting.stale !== 'it was dropped, since another answer came after it' ? `The reading shown before can't be used: ${waiting.stale}. ` : earlier);
  if (isYes(answers)) {
    if (waiting.stale) {
      clearPending(c.paths.derived, 'approval');
      throw new Error(`The reading shown before can't be used: ${waiting.stale}. Nothing was saved: answer again, for example "approve all" or "approve c001".`);
    }
    return {
      saved: false,
      approved: 0,
      can_interpret: true,
      say_to_user: `Nothing is waiting for a yes here, so nothing was saved. Say what to approve, for example "approve all", "approve all except c002" or "approve c001".${hint()}`
    };
  }
  // Any other answer replaces a waiting reading: a refusal leaves its trace, so a bare "ok" after it is read back.
  const told = (fn) => {
    try {
      return fn();
    } catch (e) {
      if (dropPending(c.paths.derived, 'approval')) e.message = `The reading shown before was dropped, since this is a new answer. ${e.message} To save that reading, say it again, then "yes".`;
      throw e;
    }
  };
  const readAs = [];
  const g = told(() => parseGate(...parseOpts(readAs)));
  const approvedNamed = new Set(g.actions.filter((a) => a.verb === 'approve').flatMap((a) => a.ids.map((x) => x.replace(/:\d+$/, ''))));
  const refusedNames = g.refused.flatMap((r) => r.line.toLowerCase().match(/\bc\d{3,}\b/g) || []);
  // A refused line may name them in words too: a name only resolves as a whole list item ("Bo Li not yet" stays words).
  const approvedWords = unnamedWords(everyone.filter((p) => approvedNamed.has(p.id)), []);
  const namesApproved = approvedWords.length && new RegExp(`(?<![\\p{L}\\p{M}\\d])(?:${approvedWords.join('|')})(?![\\p{L}\\p{M}\\d])`, 'iu');
  told(() => {
  if (
    g.refused.length &&
    (g.defaults || g.actions.some((a) => a.verb === 'approve-all') || !g.actions.length || refusedNames.some((x) => approvedNamed.has(x)) || (namesApproved && g.refused.some((r) => namesApproved.test(r.line))))
  )
    throw new Error(
      `${g.refused.map((r) => `"${r.line}": ${r.why}`).join(' ')} Nothing was approved.`
    );
  bothWays(g);
  });
  const direct = directReading(answers, { kind: 'draft', rows: everyone, ids });
  const namesFailed = g.actions.some((a) => a.verb === 'approve' && !a.pass_only && a.ids.some((x) => failed.has(x.replace(/:\d+$/, ''))));
  // "ok" is never DIRECT at this gate (okOnly above); anything else not plainly what was typed is read back.
  if (g.defaults || namesFailed || !sameReading(direct, g.comments?.length || g.refused.length ? null : signature(g))) return readBack(g, readAs, answers, earlier);
  let out;
  try {
    out = apply(g, readAs, answers);
  } catch (e) {
    if (e.written) clearPending(c.paths.derived, 'approval');
    throw e;
  }
  return saved(out);

  // One person both approved and held back or dropped in the same answer ("approve all; drop Cy") is two readings: asked.
  function bothWays(g) {
    const allOf = g.defaults || g.actions.some((a) => a.verb === 'approve-all');
    const yesIds = new Set([
      ...(allOf ? t.jobs.map((j) => j.id).filter((id) => !g.actions.some((a) => a.verb === 'approve-all' && a.except.includes(id))) : []),
      ...g.actions.filter((a) => a.verb === 'approve').flatMap((a) => a.ids.map((x) => x.replace(/:\d+$/, '')))
    ]);
    const both = g.actions.filter((a) => ['drop', 'hold', 'leave'].includes(a.verb)).flatMap((a) => a.ids.filter((x) => !/:\d+$/.test(x) && yesIds.has(x)));
    if (both.length) throw new Error(`${[...new Set(both)].map(who).join(', ')} would be both approved and held back by this answer: say which, for example "approve all except ${both[0]}". Nothing was approved.`);
  }

  // What a reading does, ID first and each name in quotes ("Approve c001 \"Ana Costa\"; hold back c002 \"Ana Berg\"").
  // Why a draft can't be approved now (null: it can). named: the people approved by name, past a critic that failed them.
  function whyNotNamed(j, d0, named) {
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
    if (j.kind === 'message' && staleFor(c, j.id, j.touch, d))
      return {
        reason: savedBeforeIt(ledgerTouch(c, j.id, j.touch), touchBefore(c.state[j.id], j.touch), j.touch)
          ? 'it was saved before the message ahead of it had any text: it needs a new draft, written for that message'
          : 'the message before it was rewritten: it needs a new draft'
      };
    if (j.kind === 'message' && d.verdict.verdict === 'FAIL' && !named.has(j.id))
      return {
        reason: `failed the critic (${d.verdict.reasons.join('; ')}); edit it, drop it, approve ${j.id} by name to send it anyway, or ask for a fresh attempt`
      };
    return null;
  }

  function describe(r, read, mode) {
    const list = (xs) => [...new Set(xs)].map(who).join(', ');
    const parts = [];
    const all = r.defaults ? [] : null;
    // "approve all" approves only the drafts ready now: one not ready (not written, failed the critic, changed since)
    // is said as not approved, never listed under approve. One named "as it is" is approved past a failed critic.
    const asIs = new Set(r.actions.filter((a) => a.verb === 'approve' && !a.pass_only).flatMap((a) => a.ids.map((x) => x.replace(/:\d+$/, ''))));
    // A person counts as ready when any of their messages is.
    const ready = new Set(t.jobs.filter((j) => !whyNotNamed(j, readJson(j.draft_file, null), asIs)).map((j) => j.id));
    const notReadyShown = new Set();
    const allOf = (ids) => {
      const yes = ids.filter((id) => ready.has(id));
      parts.push(`approve ${yes.length ? list(yes) : 'nobody'}`);
      const no = ids.filter((id) => !ready.has(id) && !asIs.has(id) && !notReadyShown.has(id));
      no.forEach((id) => notReadyShown.add(id));
      if (no.length) parts.push(`not approve ${list(no)}, not ready (the drafts list says why)`);
    };
    for (const a of r.actions.filter((x) => x.verb === 'approve-all')) {
      allOf(t.jobs.map((j) => j.id).filter((id) => !a.except.includes(id)));
      if (a.except.length) parts.push(`hold back ${list(a.except)}`);
    }
    if (all) allOf(t.jobs.map((j) => j.id));
    const by = (verb, f = () => true) => r.actions.filter((a) => a.verb === verb && f(a)).flatMap((a) => a.ids.map((x) => x.replace(/:\d+$/, '')));
    const withAll = r.defaults || r.actions.some((a) => a.verb === 'approve-all');
    // Beside "approve all", one named "as it is" is approved past a critic that failed it; one named "too" adds nothing.
    const named = by('approve', (a) => !a.pass_only);
    const flag = (id) => (failed.has(id) ? `${who(id)}, whose draft did not pass the checks: approving sends it as it is` : who(id));
    if (named.length) parts.push(`approve ${[...new Set(named)].map(flag).join(', ')}${withAll && !named.some((id) => failed.has(id)) ? ' even if the critic failed it' : ''}`);
    if (!withAll && by('approve', (a) => a.pass_only).length) parts.push(`approve ${list(by('approve', (a) => a.pass_only))}`);
    const drops = r.actions.filter((a) => a.verb === 'drop').flatMap((a) => a.ids);
    if (drops.some((x) => !/:\d+$/.test(x))) parts.push(`drop ${list(drops.filter((x) => !/:\d+$/.test(x)))}`);
    for (const x of drops.filter((y) => /:\d+$/.test(y))) parts.push(`drop message ${x.split(':')[1]} only, to ${who(x.split(':')[0])}`);
    const kept = r.actions.filter((a) => a.verb === 'hold' || a.verb === 'leave').flatMap((a) => a.ids);
    if (kept.length) parts.push(`leave ${list(kept)} unapproved`);
    if (by('edit').length) parts.push(`open ${list(by('edit'))} for editing`);
    const said = (r.comments || []).map((x) => shown(x, 120)).join(', ');
    const unread = (r.refused || []).map((x) => shown(x.line, 120, { keepIds: true })).join(', ');
    const lead = mode === 'confirm' ? `This answer reads as: ${parts.join('; ') || 'nothing to do'}.` : mode === 'interpreted' ? `That reads as: ${parts.join('; ') || 'nothing to do'}.` : '';
    const names = read.length ? ` Names read: ${read.map((x) => `${shown(x.said)} as ${x.ids.map(who).join(' and ')}`).join('; ')}.` : '';
    return `${lead}${names}${said ? ` Not taken as an instruction: ${said}.` : ''}${unread ? ` Not read, and not done: ${unread}.` : ''}`.trim();
  }

  function apply(g, readAs, answers) {
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
  const whyNot = (j, d0) => whyNotNamed(j, d0, named);
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
  // Saved whole or not at all: the entries go in as one append at the end; a failure part-way writes none.
  const editFiles = inOneGo(c.paths.ledger, () => {
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
      said: String(answers).slice(0, 200),
      ...(failed ? { critic_override: true } : {})
    });
    done.push(j.id);
    doneTouch.add(`${j.id}:${j.touch}`);
  }
  for (const id of drop) led(c, { type: 'dropped', id, said: String(answers || 'drop').slice(0, 200) });
  for (const k of dropTouch) {
    const [id, tt] = k.split(':');
    led(c, { type: 'dropped', id, touch: Number(tt), said: String(answers || 'drop').slice(0, 200) });
  }
  // Passed over by an approval ("approve all except c012", "approve c004"): those wait for the user's word. An
  // answer that only edits or drops passes over nobody (it left every other draft out, and the next approval
  // offered one message of ten).
  const approving = g.defaults || g.actions.some((a) => a.verb === 'approve' || a.verb === 'approve-all');
  const leftOut = approving
    ? t.jobs.filter((j) => j.kind === 'message' && !approve.has(j.id) && !drop.has(j.id) && !edit.includes(j.id)).map((j) => `${j.id}:${j.touch}`)
    : t.left_out || [];
  writeJson(join(c.paths.derived, 'todo.json'), { ...t, left_out: leftOut });
  return edit.map((k) => {
    const [id, tt] = k.split(':');
    const j = t.jobs.find((x) => x.id === id && (!tt || x.touch === Number(tt))) || t.jobs.find((x) => x.id === id);
    const d = savedDraft(c, j.id, j.touch) || readJson(j.draft_file, {});
    const md = j.draft_file.replace(/\.json$/, '.md');
    writeText(md, `${d.subject ? `Subject: ${d.subject}\n\n` : ''}${d.body || ''}\n`);
    // Written down, so the next step is this edit (the file, then save-draft), not the approval without it.
    led(c, { type: 'answered', who: 'user', ask: 'edit', value: `${id}:${j.touch}`, said: String(answers).slice(0, 200) });
    return {
      id,
      touch: j.touch,
      file: md,
      then: `save-draft --event ${c.event.slug} --id ${id} --touch ${j.touch} --md-file ${md} (saved as the user's own edit: floorboss never rewrites it), run the critic, then approve ${id}`
    };
  });
  });
  // The entries are written. A failure from here on is said as that: saved, but the page could not be rebuilt.
  let outbox;
  try {
    // Through the page's lock, from the ledger as it is now (the first page, or a rebuild).
    outbox = rebuildOutbox(opts.event, opts, { force: true }).rebuilt;
  } catch (e) {
    e.written = true;
    e.message = `The answer was saved, but the outbox page could not be rebuilt: ${e.message} The approvals stand; "event-outreach open --event ${c.event.slug} --no-open" rebuilds the page.`;
    throw e;
  }
  // What was saved, by ID and name, from what was written: said back to the user every time.
  const people = (ids) => [...new Set(ids)].map(who);
  const heldBack = [...new Set(g.actions.filter((a) => a.verb === 'approve-all').flatMap((a) => a.except))];
  const dropped = [...drop];
  const told = {
    ...(readAs.length ? { read_as: readAs.map((r) => `${shown(r.said)} read as ${r.ids.map(who).join(' and ')}`) } : {}),
    approved_people: people(done),
    ...(heldBack.length ? { held_back: people(heldBack) } : {}),
    ...(dropped.length ? { dropped_people: people(dropped) } : {}),
    ...(edit.length ? { editing: people(edit.map((k) => k.split(':')[0])) } : {})
  };
  const say = [
    done.length ? `Approved ${told.approved_people.join(', ')}.` : 'Nothing was approved.',
    ...(told.held_back ? [`Held back ${told.held_back.join(', ')}.`] : []),
    ...(told.dropped_people ? [`Dropped ${told.dropped_people.join(', ')}.`] : []),
    ...dropTouch.map((k) => `Dropped message ${k.split(':')[1]} only, to ${who(k.split(':')[0])}.`),
    ...(told.editing ? [`Opened for editing ${told.editing.join(', ')}.`] : []),
    ...(notReady.length ? [`Not ready, so not approved: ${people(notReady.map((x) => x.id)).join(', ')}.`] : []),
    ...(heldForYou.length ? [`Held for you: ${people(heldForYou.map((x) => x.id)).join(', ')}.`] : []),
    ...(told.read_as ? [`Names read: ${told.read_as.join('; ')}.`] : []),
    ...(g.comments?.length ? [`Not taken as an instruction: ${g.comments.map((x) => shown(x, 120)).join(', ')}.`] : [])
  ].join(' ');
  return {
    approved: done.length,
    ...told,
    say_to_user: say,
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
}

// A reading kept on disk for the user's yes, and read back as the parser gave it (each action with its own line).
const keepReading = (g) => ({ defaults: !!g.defaults, comments: g.comments || [], refused: g.refused || [], actions: g.actions.map((a) => ({ ...a, line: a.line })) });
function restoreReading(r) {
  return {
    defaults: !!r.defaults,
    comments: r.comments?.length ? r.comments : undefined,
    refused: r.refused || [],
    actions: (r.actions || []).map(({ line, ...a }) => Object.defineProperty(a, 'line', { value: line, enumerable: false }))
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
