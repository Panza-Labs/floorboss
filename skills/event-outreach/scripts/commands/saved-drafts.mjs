// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Reading what is already saved for a touch: the draft file, its ledger record, the critic's verdict, the
// insight it used, the drafting job it belongs to.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../../../../lib/jsonio.mjs';
import { parseInsights } from '../../../event-context/scripts/context-check.mjs';
import { readDraft } from '../../../../lib/drafts.mjs';
import { touchBefore } from '../../../../lib/route.mjs';
import { followupDay, isDateKey, stateOf, backAfterAway } from '../../../../lib/spacing.mjs';
import { handSend } from '../../../../lib/harness.mjs';
import { planFor } from '../../../../lib/sendcheck.mjs';
import { hashOf } from './routes.mjs';
import { skillsOf, isOut } from './context.mjs';

// The working copy Claude writes and edits (attempts, verdict, notes for the outbox); the record is the
// fingerprinted text in drafts/<hash>.json and the ledger.
export const draftFile = (paths, id, t) => join(paths.work, 'drafts', `${id}-t${t}.json`);

// What the ledger says about one touch's draft. Only floorboss's scripts write the ledger and the fingerprinted
// drafts/<hash>.json; the working copy in work/drafts is Claude's to write, so its verdict, checks and text decide
// nothing (one Write there turned a critic FAIL into a PASS, cleared a missing opt-out line, or changed the text
// the outbox offered as approved).
//   hash, kind, checks, slot_ids, booked_slot, previous_hash, user_edited: the latest save (save-draft's entry)
//   verdict(h): the latest critic verdict on exactly the text h, else the user's skip of the review for it; none
//     after a revise or a fresh attempt until the draft is saved again (a save of the same text keeps it)
//   read: whether the critic read any version of it since then
// How many times the critic failed this touch since the user last sent it back (revise or a fresh attempt),
// counted in the ledger: the working copy's critic_rewrites is Claude's to write.
export function criticFails(c, id, touch) {
  // A fail counts once per save: a verdict saved again with no new save in between isn't another fail.
  // A rewrite saved back as the very text that failed is another fail: the critic won't change its mind.
  let n = 0,
    saved = true,
    lastFail = null;
  for (const e of c.entries || []) {
    if (e.id !== id || (e.touch ?? 1) !== touch) continue;
    if (e.type === 'revise' || e.type === 'fresh_attempt') {
      n = 0;
      saved = true;
      lastFail = null;
    } else if (e.type === 'drafted') {
      if (lastFail && e.hash === lastFail) n++;
      else saved = true;
    } else if (e.type === 'critic' && e.verdict === 'FAIL' && saved) {
      n++;
      saved = false;
      lastFail = e.hash || null;
    }
  }
  return n;
}
export function ledgerTouch(c, id, touch) {
  const key = `${id}:${touch}`;
  if (c._lt?.n !== c.entries.length) c._lt = { n: c.entries.length, m: new Map() };
  if (c._lt.m.has(key)) return c._lt.m.get(key);
  let drafted = null,
    at = -1,
    voidAt = -1,
    hashNow = null;
  const reads = [];
  c.entries.forEach((e, i) => {
    if (!e || e.id !== id || (e.touch ?? 1) !== touch) return;
    if (e.type === 'drafted') {
      drafted = e;
      at = i;
      hashNow = e.hash;
    } else if (e.type === 'revise' || e.type === 'fresh_attempt') voidAt = i;
    // An older skip without a hash was for the text saved at the time.
    else if (e.type === 'critic' || e.type === 'review_skipped') reads.push({ e, i, h: e.hash || hashNow });
  });
  const live = reads.filter((r) => at > voidAt || r.i > voidAt);
  const verdict = (h) => {
    if (!h) return null;
    const cr = live.filter((r) => r.e.type === 'critic' && r.h === h).pop()?.e;
    if (cr) return { verdict: cr.verdict, reasons: cr.reasons || [], hash: h, at: cr.at };
    const sk = live.filter((r) => r.e.type === 'review_skipped' && r.h === h).pop()?.e;
    return sk ? { verdict: 'SKIPPED', reasons: [], said: sk.said || null, ...(sk.because ? { because: sk.because } : {}), hash: h, at: sk.at } : null;
  };
  const has = (k) => !!drafted && Object.prototype.hasOwnProperty.call(drafted, k);
  const out = {
    hash: drafted?.hash || null,
    kind: drafted?.kind || null,
    checks: drafted?.checks || [],
    slot_ids: drafted?.slot_ids || [],
    user_edited: !!drafted?.user_edited,
    // Saved before the ledger kept these: undefined, and the reader falls back to the working copy.
    booked_slot: has('booked_slot') ? drafted.booked_slot : undefined,
    previous_hash: has('previous_hash') ? drafted.previous_hash : undefined,
    before_hashes: has('before_hashes') ? drafted.before_hashes : undefined,
    // What the draft says about itself, as it was when saved: the working copy is a file Claude can rewrite.
    // A draft saved before the ledger kept who wrote it counts as floorboss's (no leniency from a working copy's claim).
    own: drafted
      ? {
          ...(has('drafted_by') ? {} : { drafted_by: 'floorboss' }),
          ...Object.fromEntries(['structure', 'fact_source', 'brief', 'planned_due', 'planned_gap', 'planned_from', 'drafted_by', 'language'].filter(has).map((k) => [k, drafted[k]])),
          // A day moved since (the message before it was planned again): the replanned entry's plan.
          ...(() => {
            const p = planFor(c.entries, id, touch, drafted.hash);
            return p?.has_plan ? { planned_due: p.planned_due, planned_gap: p.planned_gap, planned_from: p.planned_from } : {};
          })()
        }
      : {},
    verdict,
    read: live.some((r) => r.e.type === 'critic')
  };
  c._lt.m.set(key, out);
  return out;
}

// The draft as floorboss saved it: the working copy only while its text is the one the ledger's latest save
// fingerprints, with the subject and body taken from that fingerprinted record. null: never saved, or changed
// since it was saved (by hand, or the recipient's address changed).
export function savedDraft(c, id, touch, d = readJson(draftFile(c.paths, id, touch), null)) {
  if (!d) return null;
  const L = ledgerTouch(c, id, touch);
  if (!L.hash || hashOf(c, d) !== L.hash) return null;
  let rec = null;
  try {
    rec = readDraft(c.paths.dir, L.hash);
  } catch {
    rec = null;
  }
  if (!rec) return null;
  return {
    ...d,
    ...L.own,
    ...(L.own.language === undefined && rec.language ? { language: rec.language } : {}),
    kind: L.kind || d.kind,
    subject: rec.subject || d.subject,
    body: rec.body,
    checks: L.checks,
    verdict: L.verdict(L.hash),
    slot_ids: L.slot_ids,
    ...(L.booked_slot !== undefined ? { booked_slot: L.booked_slot } : {}),
    ...(L.previous_hash !== undefined ? { previous_hash: L.previous_hash } : {})
  };
}
// An earlier message of the thread as the ledger has it: the text that went (or its fingerprinted record), else
// the saved draft. Never the working copy alone: the critic and the drafter read it as what the person got.
export function earlierDraft(c, id, t) {
  const x = c.folded.people[id]?.touches?.[t];
  const sentRec = x?.sent ? recordText(c, x.sent.hash) : null;
  const saved = savedDraft(c, id, t);
  if (x?.sent?.text) return { ...(saved || {}), ...(sentRec || {}), body: x.sent.text };
  return sentRec ? { ...(saved || {}), subject: sentRec.subject, body: sentRec.body } : saved;
}
// The fingerprinted text of an approval or a send (drafts/<hash>.json), or null.
export function recordText(c, hash) {
  if (!/^[0-9a-f]{24}$/.test(String(hash || ''))) return null;
  try {
    return readDraft(c.paths.dir, hash);
  } catch {
    return null;
  }
}

export const insightsOf = (c) => parseInsights(skillsOf(c).whatYouBring || '');

// A draft names the insight it leads with ("I3"), or none. It has to exist, fit the contact's segment,
// and differ from the one in the message before.
// avoid: the job's avoid_insights (what a colleague at their company got, or the message before): refused too.
export function insightProblems(insight, segment, insights, previous = null, avoid = []) {
  if (!insight) return [];
  const row = insights.find((x) => x.id === insight);
  if (!row) return [`insight ${insight} isn't in the "what you know" table`];
  if (!segment || !row.segments.includes(segment)) return [`insight ${insight} isn't tagged for this contact's segment`];
  if (previous && previous === insight) return [`insight ${insight} was in the message before; a follow-up adds something new`];
  if ((avoid || []).includes(insight))
    return [`insight ${insight} is one this person's colleagues already got (avoid ${avoid.join(', ')}): use another, or none`];
  return [];
}

// An input without an "insight" key keeps the draft's earlier one (a light edit doesn't change the angle).
export function insightField(input, prev, insights) {
  if (!('insight' in input)) return { insight: prev?.insight || null, insight_text: prev?.insight_text || null };
  const id = input.insight && !/^none$/i.test(String(input.insight)) ? String(input.insight).trim().toUpperCase() : null;
  return { insight: id, insight_text: id ? insights.find((x) => x.id === id)?.insight || null : null };
}

const normText = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').trim();

// The table row a saved draft leads with. Matched by text, so adding or reordering rows after saving
// doesn't re-point the draft; drafts saved before the text was stored fall back to the ID.
export function resolveInsight(d, insights) {
  if (!d?.insight) return null;
  const row = d.insight_text ? insights.find((x) => normText(x.insight) === normText(d.insight_text)) : insights.find((x) => x.id === d.insight);
  return row || { id: d.insight, insight: d.insight_text || null, gone: true };
}

// One touch's batch: every saved message draft for it, except contacts dropped or removed. todo and
// batch-check both use it, so the drafter plans against the same cap and colleagues that get enforced.
// Read once per run and touch: todo calls it per job (colleagues' earlier insights), which re-read every
// draft file each time. Saving a draft clears the cache.
// The batch is the touch's open drafts: a message already sent, or one held for the user after two critic fails,
// is no longer the batch's to change, so it neither counts towards the cap nor is named for a rewrite (a
// follow-up check reopened sent first messages and a held one). all: every draft, sent and held too (what a
// colleague already got).
export function touchBatch(c, touch, insights, { all = false } = {}) {
  c._batches ||= new Map();
  const k = `${touch}`;
  if (!c._batches.has(k) || c._batches.get(k).insights !== insights) c._batches.set(k, { insights, list: touchBatchRead(c, touch, insights) });
  const list = c._batches.get(k).list;
  return all ? list : list.filter((d) => !d.sent && !d.held);
}
function touchBatchRead(c, touch, insights) {
  // The saved text and the ledger's verdict, never the working copy's (one changed by hand isn't in the batch).
  return draftFiles(c)
    .filter((x) => x.t === String(touch))
    .map((x) => savedDraft(c, x.id, touch, readJson(x.file)))
    .filter(Boolean)
    .filter((d) => d.kind === 'message' && !c.state[d.id]?.dropped && !c.state[d.id]?.removed && c.state[d.id]?.touches?.[touch]?.status !== 'dropped')
    .map((d) => ({
      ...d,
      resolved: resolveInsight(d, insights),
      sent: !!c.state[d.id]?.sent?.[touch],
      held: d.verdict?.verdict === 'FAIL' && criticFails(c, d.id, touch) >= 2 && !isOut(c.state[d.id]?.touches?.[touch]?.status)
    }));
}
// The working drafts (work/drafts/<id>-t<touch>.json), in directory order: each file, its contact and its touch
// as written in the name.
export const draftFiles = (c) => {
  const wd = join(c.paths.work, 'drafts');
  return (existsSync(wd) ? readdirSync(wd) : [])
    .map((f) => /^(c\d+)-t(\d+)\.json$/.exec(f))
    .filter(Boolean)
    .map((m) => ({ file: join(wd, m[0]), id: m[1], t: m[2] }));
};
// Was this follow-up written for an earlier version of the message actually before it (a skipped step passed over)?
// What that message was at the time is the ledger's save (before_hashes), never the working copy, which Claude may
// write. Older drafts kept only the message numbered just before this one (previous_hash), and with a skip in between
// that is the skipped step's text, not what this follow-up follows, so it says nothing.
// A save that recorded that message as having no text yet (saved before it) was written for no version of it: once it
// has text, the follow-up is stale too.
export function staleFor(c, id, t, d) {
  const b = touchBefore(c.state[id], t),
    L = ledgerTouch(c, id, t),
    now = c.state[id]?.touches?.[b]?.hash;
  if (t > 1 && now && savedBeforeIt(L, b, t)) return true;
  const then = L.before_hashes?.[b] ?? (b === t - 1 ? (L.previous_hash ?? d?.previous_hash) : null);
  return !!(t > 1 && then && now && then !== now);
}
// Did the ledger's save of this follow-up record message b as unsaved (null), rather than say nothing about it?
export const savedBeforeIt = (L, b, t) =>
  L?.before_hashes && typeof L.before_hashes === 'object' ? Object.prototype.hasOwnProperty.call(L.before_hashes, b) && L.before_hashes[b] == null : b === t - 1 && L?.previous_hash === null;
// The subject to reply under: the last email of this sequence before this message.
export function lastEmailSubject(c, id, touch) {
  for (let t = touch - 1; t >= 1; t--) {
    const d = earlierDraft(c, id, t);
    if (d?.subject) return d.subject;
  }
  return null;
}

// todo.json, with each job's draft path worked out again from this event's folder: a folder that was
// moved or copied must never write drafts back into the old one.
export function readTodo(c, fallback) {
  const t = readJson(join(c.paths.derived, 'todo.json'), null);
  if (!t) return fallback;
  return { ...t, jobs: (t.jobs || []).map((j) => ({ ...j, draft_file: draftFile(c.paths, j.id, j.touch) })) };
}

export function jobFor(c, id, touch) {
  const t = readTodo(c, null);
  const job = t?.jobs.find((j) => j.id === id && j.touch === touch);
  if (!job) throw new Error(`${id} touch ${touch} isn't in the current drafting list. Run "todo" first.`);
  return job;
}

// A follow-up's day from this event's record (lib/spacing.mjs followupDay, the one rule every reader uses): the day the
// message before it went, the plan its saved draft holds (none yet: its gap after that send alone), and the plan of
// the message before it (sent on its own planned day, the plan stands). prevSent: a day to count from instead of a
// real send (the gap answer projects a follow-up from the day the one before it is due).
export function followupDayOf(c, id, t, d = savedDraft(c, id, t), prevSent = undefined) {
  // An event whose dates or zone can't be read has no day for anything (the guard's answer, said with its reason).
  if (stateOf(c).state === 'unreadable') return { day: null, waits: false, planned: null, why: 'unreadable' };
  const st = c.state[id] || {};
  const b = touchBefore(st, t);
  const p = b > 1 ? savedDraft(c, id, b) : null;
  const r = followupDay(c.settings, c.event, {
    prevSent: prevSent !== undefined ? prevSent : st.sent?.[b] || null,
    touch: t,
    planned_due: d?.planned_due,
    planned_gap: d?.planned_gap,
    planned_from: d?.planned_from,
    prev_planned_due: p?.planned_due,
    prev_planned_gap: p?.planned_gap,
    // Today in the event's time (past its last day, nothing goes), and the latest send to this person at any step.
    today: c.today,
    lastSent: latestSend(st),
    // A later step already went (recorded by hand or found in the mailbox): this one is passed over.
    laterSent: laterSent(st, t)
  });
  return handSend() ? awayHold(c, id, r) : r;
}
// Hand-send: someone who sent an out-of-office gets no follow-up on or before the day they're back (paused_until);
// one due by then waits for the first working day after it, or is dropped when that is past the event's last day.
// Claude Code keeps the follow-ups' days through an out-of-office (the CHANGELOG's choice): its mailbox read says
// when they write back.
function awayHold(c, id, r) {
  const until = c.folded?.people?.[id]?.paused_until;
  if (!r?.day || !isDateKey(until) || r.day > until) return r;
  const back = backAfterAway(until);
  return back && back <= c.event.end_date ? { ...r, day: back, away_until: until } : { ...r, day: null, why: 'away', until };
}
// The latest day any message to this person was recorded as sent (any step, any channel), or null. Only plain dates
// count: a malformed one is left out of the search (its own step still fails closed at the guard).
export const latestSend = (st) =>
  Object.values(st?.sent || {})
    .filter(isDateKey)
    .sort()
    .pop() || null;
// Whether a step after `t` was recorded as sent.
export const laterSent = (st, t) => Object.keys(st?.sent || {}).some((k) => Number(k) > t);
