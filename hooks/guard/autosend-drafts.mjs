// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// create_draft and get_draft on the claude.ai Gmail connector in the session that ran floorboss (owner's approval
// 2026-11-22, rule a). The run lock holds that connector to reads, and a draft tool is no read. The one exception:
//   create_draft  only for the draft step an open run after the final approval is on (lib/autosend/approved-drafts.mjs),
//                 a message the user approved to send automatically (pick 1) or to put in their drafts (pick 2), with
//                 that yes still standing, and exactly as approved: one To (the approved address), its subject, its
//                 body (the saved text with that approval's hash), and its thread (a follow-up replies to message 1 as
//                 sent; message 1 itself replies to nothing), for that message (its touch). Once per message and yes.
//   get_draft     only for a draft floorboss's guard saw made that way (its own reading of create_draft's answer,
//                 recorded after the call ran), for a message whose yes still stands, or one stopped whose draft must
//                 be deleted (below), to see whether it is gone.
//   delete_draft  only { draftId }, only for a draft the guard saw made that way, of an event sending through a daily
//                 Claude routine, whose yes was revoked or stopped since (lib/autosend/routine.mjs routineDeletes): a
//                 stop recorded on the laptop reaches the routine only by that draft being gone from Gmail.
// Each with Claude Code's own permission prompt ("ask"), never "allow". A call that doesn't match falls to the run
// lock's rules, which refuse it.
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { openApprovedRuns, approvedDraftItem, CLAUDE_TOOLS } from '../../lib/autosend/approved-drafts.mjs';
import { readEvent, eventDirOf, autosendEvents, ROUTINE, oldRoutineDrafts } from '../../lib/autosend/common.mjs';
import { routineDeletes, dueAfterToday, draftNotFound } from '../../lib/autosend/routine.mjs';
import { append as appendLedger } from '../../lib/ledger.mjs';
import { callNote } from './lookups.mjs';
import { rawValue } from './witness.mjs';
import { promptPerson, promptLine } from './prompts.mjs';
import { fullText } from './sends.mjs';
import { touchBefore } from '../../lib/route.mjs';
import { eventRecord } from '../../lib/sendcheck.mjs';
// Wording only: a step whose earlier steps were all skipped is the person's first message (owner answer A1).
const firstContact = (home, slug, id, touch) => {
  try {
    return touch > 1 && touchBefore({ touches: eventRecord(eventDirOf(home, slug)).folded?.people?.[id]?.touches || {} }, touch) === 0;
  } catch {
    return false;
  }
};

export const SERVER = 'claude_ai_Gmail';
const callsDir = (home) => join(home, 'autosend', 'draft-calls');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const fold = (v) => String(v ?? '').trim().toLowerCase();
const ID = /^[\w-]{1,128}$/;

// The step's yes: its place in the ledger (a second yes gives the step a new place, so a new draft once).
function yesAt(entries, id, touch, kind) {
  const types = kind === 'auto' ? ['autosend_approved'] : ['drafts_approved'];
  let at = -1;
  entries.forEach((e, i) => {
    if (types.includes(e?.type) && e.id === id && (e.touch ?? 1) === touch) at = i;
  });
  return at;
}

// create_draft: { ask, note } or null (not one of floorboss's drafts: the run lock's rules decide).
export function draftCall(input, home, nowMs) {
  const args = isObj(input?.tool_input) ? input.tool_input : null;
  if (!args) return null;
  const keys = Object.keys(args);
  if (keys.some((k) => !['to', 'subject', 'body', 'replyToMessageId'].includes(k))) return null;
  if (!Array.isArray(args.to) || args.to.length !== 1 || typeof args.to[0] !== 'string' || typeof args.subject !== 'string' || typeof args.body !== 'string') return null;
  if (args.replyToMessageId != null && typeof args.replyToMessageId !== 'string') return null;
  for (const r of openApprovedRuns(home, nowMs)) {
    const c = r.current;
    if (r.host !== 'claude-code' || c?.step !== 'draft' || !isObj(c.item)) continue;
    if (fold(args.to[0]) !== fold(c.item.to)) continue;
    // What it must be now, from the ledger (the run's own record of the step aside).
    const evDir = eventDirOf(home, r.slug);
    const got = approvedDraftItem(evDir, c.item.id, c.item.touch, r.kind, nowMs, 'claude-code');
    if (got.why) return null;
    const it = got.item;
    if (it.hash !== c.item.hash || fold(it.to) !== fold(args.to[0]) || it.subject !== args.subject || it.body !== args.body) return null;
    if ((args.replyToMessageId ?? null) !== (it.reply_to_message_id ?? null)) return null;
    const { entries } = readEvent(evDir);
    const at = yesAt(entries, it.id, it.touch, r.kind);
    if (at < 0) return null;
    if (entries.slice(at).some((e) => e?.type === 'call_result' && e.who === 'guard' && e.kind === 'draft' && e.id === it.id && (e.touch ?? 1) === it.touch)) return { refuse: `the draft of ${promptPerson(it.name, it.id)}'s message ${it.touch} was already made once for this yes: check Gmail's Drafts folder.` };
    if (typeof input.tool_use_id !== 'string' || !input.tool_use_id.trim()) return { refuse: "Claude Code didn't give this draft call an id (tool_use_id), and floorboss keeps track of each draft call by it." };
    // Once per message and yes: a second call (a retry, or two at once) is refused.
    mkdirSync(callsDir(home), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(join(callsDir(home), `once-${r.slug}-${it.id}-${it.touch}-${at}`), new Date(nowMs).toISOString(), { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      return { refuse: `a draft of ${promptPerson(it.name, it.id)}'s message ${it.touch} was already let through once for this yes (it may be in Gmail's Drafts): check there, then show the readback again if it isn't.` };
    }
    writeFileSync(join(callsDir(home), callNote(input.tool_use_id)), JSON.stringify({ event: r.slug, id: it.id, touch: it.touch, at: new Date(nowMs).toISOString() }), { mode: 0o600 });
    const where = it.touch > 1 && !firstContact(home, r.slug, it.id, it.touch) ? `in the thread of message 1 (${promptLine(it.thread_id)})` : 'as a new email';
    const why = r.kind === 'auto' ? 'The daily routine in your Claude account sends it on its day, unchanged, unless Gmail shows a reply from them or a bounce; a booking or a stop recorded in floorboss takes effect when floorboss has you delete the draft.' : 'Nothing is sent: it waits in Gmail Drafts for you.';
    return { ask: `floorboss: put ${it.touch > 1 && !firstContact(home, r.slug, it.id, it.touch) ? `follow-up ${it.touch - 1}` : 'the first message'} to ${promptPerson(it.name, it.id, args.to[0])} into your Gmail drafts, ${where}. ${why}\n\nThe text you approved, as it goes in:\n${fullText(args.subject, args.body)}\n\nAllow only if this is the approved message to the right person.` };
  }
  return null;
}

// get_draft: { ask } or null.
export function getDraftCall(input, home, nowMs) {
  const args = isObj(input?.tool_input) ? input.tool_input : null;
  if (!args || Object.keys(args).length !== 1 || typeof args.draftId !== 'string' || !ID.test(args.draftId)) return null;
  const evs = join(home, 'events');
  if (!existsSync(evs)) return null;
  for (const r of [...openApprovedRuns(home, nowMs).map((x) => ({ slug: x.slug, kind: x.kind })), ...routineEvents(home)]) {
    const evDir = eventDirOf(home, r.slug);
    const { entries } = readEvent(evDir);
    const seen = entries.find((e) => e?.type === 'call_result' && e.who === 'guard' && e.kind === 'draft' && e.draft_id === args.draftId);
    if (!seen) continue;
    for (const kind of r.kind ? [r.kind] : ['auto', 'drafts']) {
      // Its yes still stands (a draft already sent is past this: nothing is left to read).
      if (yesAt(entries, seen.id, seen.touch ?? 1, kind) < 0) continue;
      const got = approvedDraftItem(evDir, seen.id, seen.touch ?? 1, kind, nowMs, 'claude-code');
      if (got.why && !/already sent/.test(got.why)) continue;
      return { ask: `floorboss: read back the Gmail draft ${promptLine(args.draftId)} it made for ${promptPerson(got.item?.name || seen.id, seen.id)} (message ${seen.touch ?? 1}), to check it is exactly what you approved. Nothing changes.` };
    }
  }
  const st = stoppedDraft(home, args.draftId, nowMs);
  if (st) return { ask: `floorboss: look whether the Gmail draft ${promptLine(args.draftId)} to ${promptPerson(st.name, st.x.id, st.x.to)} (message ${st.x.touch}) is still in your drafts: auto-send was stopped for them, so it must be gone before the daily routine's day for it. Nothing changes.` };
  return null;
}

// A draft the guard saw made (its call_result), queued for a daily Claude routine, whose step was stopped and whose
// delete isn't confirmed yet: { slug, x, name } or null.
function stoppedDraft(home, draftId, nowMs) {
  // Also an event switched away from the routine, for the drafts the routine still has (audit run 11).
  const was = autosendEvents(home).filter((e) => e.event?.autosend_mode !== ROUTINE && oldRoutineDrafts(e.event, readEvent(e.dir).entries).length).map((e) => ({ slug: e.slug }));
  for (const r of [...routineEvents(home), ...was]) {
    const evDir = eventDirOf(home, r.slug);
    const { entries, folded } = readEvent(evDir);
    const seen = entries.find((e) => e?.type === 'call_result' && e.who === 'guard' && e.kind === 'draft' && e.draft_id === draftId);
    if (!seen) continue;
    const x = routineDeletes(evDir, nowMs).find((d) => d.draft_id === draftId && d.id === seen.id && d.touch === (seen.touch ?? 1));
    if (x) return { slug: r.slug, x, name: folded.people?.[x.id]?.name || x.id };
  }
  return null;
}

// delete_draft: { ask } or null (the run lock's rules then refuse it).
export function deleteDraftCall(input, home, nowMs) {
  const args = isObj(input?.tool_input) ? input.tool_input : null;
  if (!args || Object.keys(args).length !== 1 || typeof args.draftId !== 'string' || !ID.test(args.draftId)) return null;
  const st = stoppedDraft(home, args.draftId, nowMs);
  if (!st) return null;
  return { ask: `floorboss: delete the Gmail draft ${promptLine(args.draftId)}, message ${st.x.touch} to ${promptPerson(st.name, st.x.id, st.x.to)} (subject ${promptLine(st.x.subject)}), from your Gmail drafts, so the daily routine in your Claude account never sends it (${st.x.why}). Nothing is sent.\n\nAllow only if you want nothing more sent to them automatically.` };
}

// After a get_draft or delete_draft ran (PostToolUse) or failed (PostToolUseFailure), for a stopped routine draft:
// the guard's own reading of the answer, recorded gone (autosend_draft_deleted) so the step is the user's again when:
//   delete_draft answered with no error, empty or in a known success shape (anything else proves nothing); or
//   either tool answered with an error in which Gmail says this draft isn't there (routine.mjs draftNotFound: never a
//   missing server, tool, connector or account), for a draft due after today in the event's zone. A draft
//   due today or earlier may be gone because the routine sent it: nothing is recorded, and the laptop's
//   reconciliation (routine-status) reads Sent and records it sent, or gone unsent.
// A readable draft is never gone, whatever its text says. True if recorded.
const textOf = (resp) => (Array.isArray(resp?.content) ? resp.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join(' ') : typeof resp === 'string' ? resp : '');
const DELETED_WORDS = /^\s*(?:(?:the )?draft (?:was )?(?:successfully )?deleted(?: successfully)?|successfully deleted(?: the)? draft(?: [\w-]{1,128})?|deleted)\.?\s*$/i;
function deleteSaysDeleted(resp) {
  if (!isObj(resp)) return false;
  if (resp.isError === true || resp.is_error === true) return false;
  const blocks = Array.isArray(resp.content) ? resp.content : null;
  if (blocks && !blocks.length && resp.structuredContent == null) return true;
  if (!blocks && resp.structuredContent == null) {
    if (!Object.keys(resp).length) return true;
    return knownSuccess(resp);
  }
  const t = textOf(resp).trim();
  if (blocks && blocks.length === 1 && (t === '' || t === '{}')) return true;
  if (DELETED_WORDS.test(t)) return true;
  const v = rawValue(resp);
  return v.ok && isObj(v.value) && (Object.keys(v.value).length === 0 || knownSuccess(v.value));
}
const knownSuccess = (o) => {
  const ks = Object.keys(o);
  return (o.success === true || o.deleted === true) && ks.every((k) => ['success', 'deleted', 'id', 'draftId', 'message'].includes(k)) && o.success !== false && o.deleted !== false && (o.message == null || DELETED_WORDS.test(String(o.message)));
};
export function afterDraftGone(input, home, nowMs) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(input?.tool_name || ''));
  if (!m || m[1] !== SERVER || !['get_draft', 'delete_draft'].includes(m[2])) return false;
  const args = isObj(input?.tool_input) ? input.tool_input : null;
  if (!args || typeof args.draftId !== 'string' || !ID.test(args.draftId)) return false;
  const st = stoppedDraft(home, args.draftId, nowMs);
  if (!st) return false;
  const failed = input.hook_event_name === 'PostToolUseFailure';
  const resp = input.tool_response;
  const errText = failed ? String(input.error ?? '') : isObj(resp) && (resp.isError === true || resp.is_error === true) ? textOf(resp) : null;
  let how = null;
  if (errText != null) how = draftNotFound(errText, args.draftId) && dueAfterToday(eventDirOf(home, st.slug), st.x.due, nowMs) ? `${m[2]}: not found` : null;
  else if (m[2] === 'delete_draft' && deleteSaysDeleted(resp)) how = 'delete_draft';
  if (!how) return false;
  appendLedger(join(eventDirOf(home, st.slug), 'ledger.jsonl'), { type: 'autosend_draft_deleted', who: 'guard', id: st.x.id, touch: st.x.touch, draft_id: args.draftId, how, tool: input.tool_name }, new Date(nowMs));
  return true;
}
// The events sending through a daily Claude routine: their queued drafts are read back at a session's start.
const routineEvents = (home) => autosendEvents(home).filter((e) => e.event?.autosend_mode === ROUTINE).map((e) => ({ slug: e.slug, kind: 'auto' }));

// After a create_draft the guard let through ran (PostToolUse): its own reading of the answer, as call_result, so
// the run and get_draft use the ids the tool gave, never only the answer file the session writes. True if recorded.
export function afterDraft(input, home, nowMs) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(input?.tool_name || ''));
  if (!m || m[1] !== SERVER || m[2] !== 'create_draft' || typeof input?.tool_use_id !== 'string') return false;
  const f = join(callsDir(home), callNote(input.tool_use_id));
  if (!existsSync(f)) return false;
  let note;
  try {
    note = JSON.parse(readFileSync(f, 'utf8'));
  } finally {
    try {
      unlinkSync(f);
    } catch {
      /* gone */
    }
  }
  const v = rawValue(input.tool_response);
  if (!v.ok || !isObj(v.value)) return false;
  const pick = (...xs) => xs.find((x) => typeof x === 'string' && ID.test(x)) || null;
  const draft_id = pick(v.value.id, v.value.draftId);
  if (!draft_id) return false;
  appendLedger(
    join(eventDirOf(home, note.event), 'ledger.jsonl'),
    { type: 'call_result', who: 'guard', id: note.id, touch: note.touch, kind: 'draft', message_id: pick(v.value.messageId, v.value.message?.id), thread_id: pick(v.value.threadId, v.value.message?.threadId), draft_id, tool: CLAUDE_TOOLS.draft[0] },
    new Date(nowMs)
  );
  return true;
}
