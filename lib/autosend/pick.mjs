// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The final approval as a choice (owner decision 2026-11-22), shown after the readback in both hosts: AskUserQuestion
// in Claude Code, numbered options in Codex. The options are fixed here, word for word.
// In Claude Code the user's pick is what the AskUserQuestion tool answered, recorded by floorboss's guard in its
// PostToolUse hook (hooks/guard.mjs) under the data folder, where Claude's own file tools can't write: the approve
// command reads that record, so the agent can't approve by itself. In Codex (no hooks) the pick is the user's own
// chat reply, a number or an option's words, as other choices are. Nothing here sends.
import { join } from 'node:path';
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { normalised } from './common.mjs';

export const PICKS = Object.freeze([
  Object.freeze({ n: 1, key: 'auto', label: 'Approve and send automatically (recommended)', description: 'First emails now, then each follow-up on its day, unless they reply, book, say stop or it bounces.' }),
  Object.freeze({ n: 2, key: 'drafts', label: 'Approve, and put them all in my Gmail drafts', description: 'Nothing is sent: each one waits in Gmail Drafts for you to press Send.' }),
  Object.freeze({ n: 3, key: 'self', label: "Approve; I'll send them myself", description: 'The outbox page with copy buttons, as now.' }),
  Object.freeze({ n: 4, key: 'changes', label: 'Not yet, I have changes', description: 'Say what to change: floorboss redrafts and shows you the changes.' })
]);
// What a Codex user replies to pick 1 (the tests' stand-in for the user's own reply).
export const AUTO_PICK = '1';
// How long a recorded pick counts for its approve.
export const PICK_FRESH_MS = 30 * 60 * 1000;
export const HEADER = 'Sending';

// The options shown: pick 1 only when auto-send is set up for this event in this host.
export const offeredPicks = (autosendReady) => PICKS.filter((p) => p.key !== 'auto' || autosendReady);

// The marker in the question that ties a pick to one readback: the event and the start of its digest.
const MARK_RE = /\(([a-z0-9][a-z0-9-]{0,63}), approval ([0-9a-f]{12})\)\s*$/;
export const digest12 = (digest) => String(digest || '').slice(0, 12);

// The choice for one readback. ask_user_question: the AskUserQuestion input, exactly (Claude Code). numbered: the
// same options as numbered lines (Codex).
// setupPick: the user's answer at setup (auto | drafts | self), named before the marker as their default.
export function choiceFor({ slug, digest, messages, people, autosendReady, setupPick = null }) {
  const opts = offeredPicks(autosendReady);
  const dflt = opts.find((p) => p.key === setupPick);
  const question = `${dflt ? `At setup you chose: ${dflt.label}. ` : ''}How should floorboss send these ${messages} message${messages === 1 ? '' : 's'} to ${people} ${people === 1 ? 'person' : 'people'}? (${slug}, approval ${digest12(digest)})`;
  return {
    ask_user_question: { questions: [{ question, header: HEADER, multiSelect: false, options: opts.map(({ label, description }) => ({ label, description })) }] },
    numbered: [question, ...opts.map((p) => `${p.n}. ${p.label}: ${p.description}`), 'Or say in your own words what you want (for example "approve all except Dana").'].join('\n'),
    offered: opts.map((p) => p.n)
  };
}

// A Codex reply ("1", "option 2", or an option's words) as its pick's key, among the offered ones; null otherwise.
export function pickFromSaid(said, autosendReady) {
  const s = normalised(said);
  const offered = offeredPicks(autosendReady);
  const m = /^(?:option\s*)?#?([1-4])$/.exec(s);
  if (m) return offered.find((p) => p.n === Number(m[1]))?.key || null;
  return offered.find((p) => normalised(p.label) === s)?.key || null;
}

// ---- The record (Claude Code): written only by the guard's PostToolUse hook ----
export const picksFile = (home) => join(home, 'autosend', 'picks.jsonl');
const answersOf = (resp) => {
  let v = resp;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  const a = v?.answers ?? v?.data?.answers ?? null;
  return a && typeof a === 'object' && !Array.isArray(a) ? a : null;
};

// What one AskUserQuestion call answered, if it is floorboss's approval question shown as floorboss wrote it: the
// options exactly floorboss's, in its order, one answer. { slug, digest12, pick, label, text } or null.
export function pickFromTool(input) {
  const qs = input?.tool_input?.questions;
  if (!Array.isArray(qs)) return null;
  const answers = answersOf(input?.tool_response);
  if (!answers) return null;
  for (const q of qs) {
    const m = MARK_RE.exec(String(q?.question || ''));
    if (!m || q.multiSelect === true || !Array.isArray(q.options)) continue;
    // The options as floorboss wrote them, word for word: one shown with other words isn't floorboss's question.
    const labels = q.options.map((o) => String(o?.label ?? ''));
    const want = PICKS.filter((p) => labels.includes(p.label));
    if (want.length !== q.options.length || want.length < 3) continue;
    if (q.options.some((o, i) => o.label !== want[i].label || o.description !== want[i].description || Object.keys(o).some((k) => !['label', 'description'].includes(k)))) continue;
    if (!['drafts', 'self', 'changes'].every((k) => want.some((p) => p.key === k))) continue;
    const a = answers[q.question];
    if (typeof a !== 'string' || !a.trim()) continue;
    const hit = want.find((p) => p.label === a.trim());
    return { slug: m[1], digest12: m[2], pick: hit ? hit.key : 'other', label: hit ? hit.label : null, text: hit ? null : a.trim().slice(0, 500) };
  }
  return null;
}

// The PostToolUse hook's record of a pick (hooks/guard.mjs): one line, appended. True if written.
export function recordPick(home, input, nowMs) {
  const p = pickFromTool(input);
  if (!p) return false;
  const call = typeof input?.tool_use_id === 'string' && input.tool_use_id.trim() ? input.tool_use_id.trim().slice(0, 200) : null;
  if (!call) return false;
  mkdirSync(join(home, 'autosend'), { recursive: true, mode: 0o700 });
  appendFileSync(picksFile(home), `${JSON.stringify({ at: new Date(nowMs).toISOString(), ...p, call, session: typeof input.session_id === 'string' ? input.session_id.slice(0, 100) : null })}\n`, { mode: 0o600 });
  return true;
}

// The latest pick recorded for this event, or null.
export function latestPick(home, slug) {
  const f = picksFile(home);
  if (!existsSync(f)) return null;
  let last = null;
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try {
      const v = JSON.parse(l);
      if (v?.slug === slug) last = v;
    } catch {
      /* a torn line counts for nothing */
    }
  }
  return last;
}
