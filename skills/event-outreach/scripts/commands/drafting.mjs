// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Drafting: saving a draft with its checks, the batch check, briefs for the drafter, revising and redrafting.
import { optoutFor, optoutForReader } from '../../../../lib/config.mjs';
import { handSend } from '../../../../lib/harness.mjs';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { allowedPath, realPath, readChecked } from '../../../../lib/paths.mjs';
import { need } from '../../../../lib/args.mjs';
import { readJson, writeJson, writeText } from '../../../../lib/jsonio.mjs';
import { insightCap, parseProof } from '../../../event-context/scripts/context-check.mjs';
import { relativeFlag, modeFor, daysUntilEvent } from '../leadtime.mjs';
import { gapKey, gapFor, nextDue, offWeekend } from '../../../../lib/spacing.mjs';
import { planFor } from '../../../../lib/sendcheck.mjs';
import { checkDraft, draftWarnings, timeMentioned, controlProblems, wordCount, confirmationLinks } from '../checks.mjs';
import { saveDraft as saveDraftFile } from '../../../../lib/drafts.mjs';
import { buildBrief, instructionsPath } from '../drafter.mjs';
import { touchBefore } from '../../../../lib/route.mjs';
import { analyzeBatch, checkInsights } from '../sameness.mjs';
import { structureProblems, researchProblems, structureSpread, inferStructure, openingOf, OPENINGS, warmReader } from '../structures.mjs';
import { whereAt, linkedinNoteCap, hashOf, toOf } from './routes.mjs';
import { skillsOf, knownReader, ctxOf, otherAttendees, led, labelOf, signoffOf, idList, touchSpec } from './context.mjs';
import { jobFor, insightsOf, lastEmailSubject, insightField, staleFor, resolveInsight, insightProblems, readTodo, ledgerTouch, touchBatch, earlierDraft, draftFiles, draftFile } from './saved-drafts.mjs';

function checkCtx(c, job, id, channel, others, lang = null) {
  // A LinkedIn message has no meeting fields: the app-note settings are for event apps only.
  const app = channel === 'paste' && whereAt(c, id, job.touch ?? 1) !== 'LinkedIn';
  const skills = skillsOf(c);
  // A follow-up is shorter than the message before it, on the same channel (a short LinkedIn note before an email
  // doesn't set the email's length).
  const before = job.followup && !job.channel_changed ? job.previous_message || earlierDraft(c, id, touchBefore(c.state[id], job.touch))?.body || null : null;
  return {
    followup: !!job.followup,
    previousBody: before,
    // The sequence's last message: a short closing note (says it's the last, names the show's days, yes or no).
    lastTouch: !!(job.followup && job.last_touch),
    eventDays: daysOf(c.event),
    // The user's own voice rule says to open with who they are: theirs to keep.
    senderOpeningOk: openingOf(skills.voice || '') === 'plain' && /\b(?:who\s+(?:i|we)\s+(?:am|are)|my\s+name|our\s+name)\b/i.test(skills.voice || ''),
    contact: c.byId[id],
    slotLabels: app && c.settings.app_note_times === 'in_app' ? [] : job.slot_labels,
    eventName: app && c.settings.app_note_event_name === false ? null : c.event.name,
    eventCity: c.event.city || null,
    meetingPlace: c.settings.meeting_place || null,
    eventAliases: app && c.settings.app_note_event_name === false ? [] : c.event.aliases,
    optout: app && c.settings.app_note_optout === false ? null : optoutForReader(c.settings, lang, knownReader(c, id)),
    // The user chose to leave the line off emails to people they know: one that carries it anyway is refused.
    optoutLeftOff: knownReader(c, id) && c.settings.optout_known === false ? optoutFor(c.settings, lang) : null,
    language: lang,
    languages: c.settings.languages || [],
    // A first LinkedIn message to someone not connected goes as a connection note, which LinkedIn caps far
    // below a message (the limit is a setting: LinkedIn changes it, and it differs by account type).
    pasteLimit: channel === 'paste' && !app && (job.invite_note ?? !job.followup) ? linkedinNoteCap(c) : c.settings.paste_limit,
    otherNames: others,
    ownFacts: [skills.whatYouBring, skills.voice, c.settings.goal].filter(Boolean).join('\n'),
    // Everything else this message may quote a figure from: the research, the company brief, the CRM, the notes.
    factText: [
      job.profile ? JSON.stringify(job.profile) : null,
      job.company_brief,
      job.crm_summary ? JSON.stringify(job.crm_summary) : null,
      job.account_note,
      job.user_note,
      job.mailbox_note,
      job.previous_message
    ]
      .filter(Boolean)
      .join('\n')
  };
}

// The event's days, first to last (YYYY-MM-DD).
function daysOf(event) {
  const out = [];
  if (!event?.start_date || !event?.end_date) return out;
  for (let d = new Date(`${event.start_date}T12:00:00Z`); out.length < 31 && d.toISOString().slice(0, 10) <= event.end_date; d.setUTCDate(d.getUTCDate() + 1))
    out.push(d.toISOString().slice(0, 10));
  return out;
}

// Whether the latest batch check of this touch, made after this draft was last saved, failed and asks for it to
// be rewritten: it names the draft, or names none (then every open draft is rewritten).
function batchAskedRewrite(c, id, touch) {
  let drafted = -1,
    check = null;
  c.entries.forEach((e, i) => {
    if (e.type === 'drafted' && e.id === id && (e.touch ?? 1) === touch) drafted = i;
    if (e.type === 'batch_checked' && (e.touch ?? 1) === touch) check = { e, i };
  });
  if (!check || check.i < drafted || check.e.verdict !== 'FAIL') return false;
  const named = new Set((check.e.reasons || []).flatMap((r) => (/\brewrite\b[^"]*$/.exec(r)?.[0] || r).match(/\bc\d{3,}\b/g) || []));
  return !named.size || named.has(id);
}

function parseDraftInput(opts) {
  if (opts.md) {
    const text = opts.md;
    const m = /^subject:\s*(.*)\n+/i.exec(text);
    return m ? { subject: m[1].trim(), body: text.slice(m[0].length).trim() } : { body: text.trim() };
  }
  need(opts, 'json');
  return JSON.parse(opts.json);
}

export function saveDraft(opts, given = null) {
  need(opts, 'event', 'id');
  const touch = Number(opts.touch ?? 1);
  // A batch builds the event's view once and passes it in.
  const c = given || ctxOf(opts.event, opts);
  const job = jobFor(c, opts.id, touch);
  // A sent message is what the person has: never overwritten, or the follow-up would quote text they
  // never got. (An approved one not yet sent may be edited; it goes back through the critic and the gate.)
  const was = c.state[job.id];
  if (was?.sent?.[touch]) throw new Error(`${job.id} touch ${touch} was sent on ${was.sent[touch]}; its saved text stays as it is.`);
  const input = parseDraftInput(opts);
  const prev = readJson(job.draft_file, null);
  // The user's own edit: saved from the file "edit <id>" opened (or with their words in --said). floorboss
  // never rewrites it; the critic still reads it, and a fail goes back to the user.
  const editFile = job.draft_file.replace(/\.json$/, '.md');
  const userEdited =
    !!opts.said ||
    opts['user-edited'] === true ||
    (typeof opts['md-file'] === 'string' &&
      (() => {
        try {
          return realPath(allowedPath(opts['md-file'])) === realPath(editFile);
        } catch {
          return false;
        }
      })());
  if (opts.insight !== undefined && !('insight' in input)) input.insight = opts.insight;
  const insights = insightsOf(c);
  // A follow-up or confirmation stays in its thread: "Re: <the message before it>", whatever was typed (a
  // rewritten first message changed its subject and its follow-up kept the old one). A follow-up planned with
  // its first message takes that draft's subject.
  const before = job.previous_subject || ((job.followup || job.kind === 'confirmation') && touch > 1 ? lastEmailSubject(c, job.id, touch) : null);
  const threadSubject = (job.kind === 'confirmation' || job.followup) && before ? `Re: ${String(before).replace(/^re:\s*/i, '')}` : null;
  const draft = {
    id: job.id,
    touch,
    kind: job.kind,
    channel: job.kind === 'coordinate' ? 'note' : job.channel,
    subject: job.kind === 'coordinate' || job.channel !== 'email' ? null : String(threadSubject || input.subject || '').trim(),
    // A file saved on Windows (CRLF) or with a byte-order mark is the same text: the checks refuse only what's left.
    body: String(input.body || '')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n')
      .trim(),
    brief: input.brief ? String(input.brief).trim() : prev?.brief || null,
    // Who wrote it is floorboss's to say, from the job's drafter: a claimed "drafted_by" doesn't buy the
    // leniency the user's own skill gets.
    drafted_by: job.drafter?.by === 'user' && input.drafted_by ? String(input.drafted_by).slice(0, 80) : 'floorboss',
    ...(job.planned_due ? { planned_due: job.planned_due, planned_gap: job.planned_gap || 'table', ...(job.planned_from ? { planned_from: job.planned_from } : {}) } : {}),
    // A user's edit (a pasted text or a .md file) names no language: it keeps the language of the draft it replaces.
    ...(input.language || prev?.language ? { language: String(input.language || prev.language).slice(0, 40) } : {}),
    ...(job.kind === 'message' ? insightField(input, prev, insights) : { insight: null, insight_text: null }),
    // Tries count per version of what it answers to: the user's feedback (a revise) or a rewritten message before
    // it starts the count again, or a follow-up stuck at three saves could never follow its new first message.
    attempts:
      c.state[job.id]?.touches?.[touch]?.status === 'revising' ||
      staleFor(c, job.id, touch, prev)
        ? 1
        : (prev?.attempts || 0) + 1,
    verdict: null,
    critic_runs: prev?.critic_runs || 0,
    critic_rewrites: (prev?.critic_rewrites || 0) + (prev?.verdict?.verdict === 'FAIL' ? 1 : 0),
    last_fail: prev?.verdict?.verdict === 'FAIL' ? prev.verdict : prev?.last_fail || null,
    saved_at: c.now.toISOString(),
    ...(userEdited ? { user_edited: true } : {}),
    // Keep what the outbox needs, so older cards still render fully after later runs.
    // The message before this one, as it was when this one was written: a rewrite of it makes this one stale.
    previous_hash: touch > 1 ? c.state[job.id]?.touches?.[touch - 1]?.hash || null : null,
    // Every earlier message as it is now, so a skip can't hide which message this one was written for (staleFor).
    before_hashes: touch > 1 ? Object.fromEntries(Array.from({ length: touch - 1 }, (_, i) => [i + 1, c.state[job.id]?.touches?.[i + 1]?.hash || null])) : null,
    slot_ids: job.slot_ids || [],
    booked_slot: job.booked_slot || null,
    earliest: job.earliest || null,
    mode: job.mode || null,
    followup_note: job.followup_note || null,
    holder: job.holder || null
  };
  // The same text saved again (a redraft that came out word for word the same) keeps the critic's verdict on
  // it: the ledger still counts that verdict, and the gate refused the draft as unread for ever.
  if (prev?.verdict?.hash && prev.verdict.hash === hashOf(c, draft)) {
    draft.verdict = prev.verdict;
    draft.critic_runs = prev.critic_runs || 0;
  }
  // The same text saved again (save-drafts run twice on an unchanged file) uses up no try.
  if (prev && prev.body === draft.body && (prev.subject || '') === (draft.subject || '') && (prev.attempts || 0) > 0) draft.attempts = prev.attempts;
  // A rewrite the batch check asked for (the draft passed its own checks; the batch reads too alike) uses up no
  // try either: the three tries are for the draft's own check fails, or a draft that passed got stuck.
  else if (prev && (prev.attempts || 0) > 0 && draft.attempts === prev.attempts + 1 && !(prev.checks || []).length && batchAskedRewrite(c, job.id, touch)) {
    draft.attempts = prev.attempts;
    draft.batch_rewrites = (prev.batch_rewrites || 0) + 1;
  }
  let problems = [];
  if (job.kind === 'message') {
    const others = otherAttendees(c, job.id);
    const ctx = checkCtx(c, job, job.id, draft.channel, others, draft.language || null);
    problems = checkDraft(draft, ctx);
    // What the checks warn about without failing: kept with the draft, read by the critic, said back to the drafter.
    draft.warnings = draftWarnings(draft, ctx);
    draft.structure = input.structure || inferStructure(draft);
    draft.structure_assigned = job.structure || null;
    draft.fact_source = input.fact_source || (job.fact_sources || [])[0] || null;
    if (draft.fact_source && job.fact_sources && !job.fact_sources.includes(draft.fact_source) && draft.fact_source !== 'none')
      problems.push(`fact_source "${draft.fact_source}" isn't one this person has (${job.fact_sources.join(', ')})`);
    problems.push(...structureProblems(draft, { structure: draft.structure, factSource: draft.fact_source, insight: draft.insight, warm: warmReader(job) }));
    problems.push(...researchProblems(draft, job));
    const current = resolveInsight(draft, insights);
    problems.push(
      ...(current?.gone && draft.insight_text
        ? [`its insight ("${draft.insight_text || draft.insight}") is no longer in the "what you know" table`]
        : insightProblems(current?.id, job.segment?.slug, insights, job.previous_insight, job.avoid_insights))
    );
  }
  if (job.kind === 'confirmation') {
    problems.push(...controlProblems(draft));
    // The critic doesn't read confirmations, so the checks keep them to what one says: thanks, the time, the place.
    const links = confirmationLinks(`${draft.subject || ''}\n${draft.body}`, c.settings);
    if (links.length)
      problems.push(
        `a confirmation carries no link or outside address (${links.slice(0, 3).join(', ')}): say the time and the place; your own email or a phone number is fine`
      );
    if (wordCount(draft.body) > 70) problems.push(`a confirmation is two or three lines (${wordCount(draft.body)} words; keep it under 70)`);
    for (const l of job.slot_labels || []) if (!timeMentioned(draft.body, l)) problems.push(`doesn't give the booked time (${l.replace(/ \(.*\)$/, '')})`);
    // The place's main words, not its exact text ("the North Lounge, table 4" matches "North Lounge table 4").
    const placeWords = (job.meeting_place || '').toLowerCase().match(/[\p{L}\d]{3,}/gu) || [];
    const bodyLow = draft.body.toLowerCase();
    if (placeWords.length && placeWords.filter((w) => bodyLow.includes(w)).length < Math.ceil(placeWords.length * 0.6))
      problems.push(`doesn't say where to meet (${job.meeting_place})`);
    if (relativeFlag(draft.body)) problems.push(relativeFlag(draft.body));
  }
  draft.checks = problems;
  // Log first: a crash between the two leaves a "drafted" entry with the old file, never new text in a card
  // that the log still calls approved.
  // The text is saved under its fingerprint (write-once), and the ledger points at it. The id-named file is
  // the working copy the drafting step reads; the guard never reads it.
  const to = toOf(c, { ...draft, holder: job.holder });
  draft.holder = job.holder || draft.holder || null;
  draft.hash = saveDraftFile(c.paths.dir, {
    channel: draft.channel,
    to,
    subject: draft.subject || '',
    body: draft.body,
    language: draft.language || null,
    insight: draft.insight ?? null,
    kind: draft.kind
  });
  led(c, {
    type: 'drafted',
    id: job.id,
    touch,
    kind: draft.kind,
    hash: draft.hash,
    structure: draft.structure || null,
    fact_source: draft.fact_source || null,
    brief: draft.brief,
    drafted_by: draft.drafted_by || 'floorboss',
    language: draft.language || null,
    slot_ids: draft.slot_ids,
    planned_due: draft.planned_due || null,
    planned_gap: draft.planned_gap || null,
    ...(draft.planned_from ? { planned_from: draft.planned_from } : {}),
    checks: problems,
    attempt: draft.attempts,
    booked_slot: draft.booked_slot || null,
    previous_hash: draft.previous_hash || null,
    before_hashes: draft.before_hashes || null,
    ...(userEdited ? { user_edited: true, ...(typeof opts.said === 'string' ? { said: opts.said.slice(0, 200) } : {}) } : {})
  });
  // A follow-up planned again (its message before it was rewritten, or a time it offered was taken): the follow-ups
  // after it are planned again from its day, so one sequence never holds days from two plans.
  if (draft.planned_due) replanAfter(c, job.id, touch, draft.planned_due);
  // A text the critic already read (a rewrite that came back word for word as an earlier version): the ledger
  // counts that verdict, so the flow sends it to no critic; the gate reads it from here, or refused it as unread
  // for ever.
  const read = c.folded.people[job.id]?.touches?.[touch]?.critic;
  if (!draft.verdict && read?.hash && read.hash === draft.hash)
    draft.verdict = { verdict: read.verdict, reasons: read.reasons || [], hash: draft.hash, at: read.at };
  writeJson(job.draft_file, draft);
  c._batches?.clear();
  return { id: job.id, touch, checks: problems.length ? problems : 'pass', ...(draft.warnings?.length ? { warnings: draft.warnings } : {}), attempts: draft.attempts };
}

// The follow-ups after `touch` in this person's sequence count from its planned day (day). One whose saved plan counts
// from another day, or was made with other gaps, is planned again from it: a replanned entry with the new day (same
// text, so its approval stands; the outbox and the send list say the new day). A day past the event's last day plans
// none (planned_due null): that follow-up then goes only on its gap after a real send, if that still fits.
function replanAfter(c, id, touch, day) {
  const mode = modeFor(daysUntilEvent(c.event, c.now));
  const key = gapKey(c.settings);
  const st = c.state[id] || {};
  let prev = day;
  for (const u of Object.keys(st.touches || {}).map(Number).filter((x) => x > touch).sort((a, b) => a - b)) {
    if (st.sent?.[u]) break;
    if (st.touches[u]?.skipped) continue;
    const p = planFor(c.entries, id, u);
    if (!p?.has_plan) break;
    if (p.planned_due && prev && p.planned_from === prev && (p.planned_gap || 'table') === key) {
      prev = p.planned_due;
      continue;
    }
    const next = prev ? offWeekend(nextDue(prev, c.event, mode, gapFor(c.settings, mode, u))) : null;
    const due = next && next <= c.event.end_date ? next : null;
    led(c, { type: 'replanned', id, touch: u, planned_due: due, planned_gap: key, planned_from: prev });
    prev = due;
  }
  c._lt?.m?.clear?.();
}

// Sameness across the batch: drafts that each pass but read as one mail merge. Checks each touch in the
// current todo (or --touch); only drafts in the current todo are named for rewriting.
export function batchCheck(opts) {
  need(opts, 'event');
  const c = ctxOf(opts.event, opts);
  const t = readTodo(c, { jobs: [] });
  const touches = opts.touch ? [Number(opts.touch)] : [...new Set(t.jobs.filter((j) => j.kind === 'message').map((j) => j.touch))];
  const results = (touches.length ? touches : [1]).map((touch) => checkTouch(c, touch, new Set(t.jobs.filter((j) => j.touch === touch).map((j) => j.id))));
  // The verdict is recorded, so the flow knows the batch was checked for the drafts as they are now.
  // A draft the user edited is never rewritten for sameness: a reason that names it says so.
  for (const r of results) {
    const mine = new Set(t.jobs.filter((j) => j.touch === r.touch && ledgerTouch(c, j.id, j.touch).user_edited).map((j) => j.id));
    r.reasons = r.reasons.map((x) => {
      const ids = [...new Set((x.match(/\bc\d{3,}\b/g) || []).filter((id) => mine.has(id)))];
      return ids.length ? `${x} (${ids.join(', ')} ${ids.length === 1 ? 'is' : 'are'} yours, left as is)` : x;
    });
  }
  for (const r of results) led(c, { type: 'batch_checked', touch: r.touch, verdict: r.verdict, reasons: r.reasons.slice(0, 20) });
  if (results.length === 1) return results[0];
  const reasons = results.flatMap((r) => r.reasons.map((x) => `touch ${r.touch}: ${x}`));
  return { verdict: reasons.length ? 'FAIL' : 'PASS', reasons, by_touch: Object.fromEntries(results.map((r) => [r.touch, r])) };
}

function checkTouch(c, touch, inRun) {
  const insights = insightsOf(c);
  const drafts = touchBatch(c, touch, insights).map((d) => {
    const previous = touch > 1 ? resolveInsight(earlierDraft(c, d.id, touchBefore(c.state[d.id], touch)), insights) : null;
    return {
      id: d.id,
      subject: d.subject || '',
      body: d.body,
      drafted_by: d.drafted_by || 'floorboss',
      insight: d.resolved?.gone ? null : d.resolved?.id || null,
      insight_gone: d.resolved?.gone ? d.insight_text || d.insight : null,
      previous_insight: previous?.gone ? null : previous?.id || null,
      fixed: !inRun.has(d.id),
      contact: c.byId[d.id],
      company_key: c.byId[d.id]?.company_key,
      slotLabels: (d.slot_ids || []).map((x) => labelOf(c, x, null)).filter(Boolean)
    };
  });
  const voice = skillsOf(c).voice || '';
  const signoff = signoffOf(voice);
  // Sentences from "Approved wording" in what-you-bring may repeat across drafts.
  const wyb = skillsOf(c).whatYouBring || '';
  const approvedBlock = (/approved wording[^\n]*\n([\s\S]*?)(?:\n\*\*|\n#|$)/i.exec(wyb) || [])[1] || '';
  const approved = [...approvedBlock.matchAll(/["“]([^"”]{8,})["”]/g)]
    .map((m) => m[1])
    .concat(((/approved wording[^:]*:\**\s*(.+)/i.exec(wyb) || [])[1] || '').match(/["“]([^"”]{8,})["”]/g)?.map((x) => x.slice(1, -1)) || []);
  // Proof claims are quoted faithfully, so the same claim may appear in several drafts.
  const proofClaims = parseProof(wyb)
    .map((p) => p.claim)
    .filter((x) => x && x.length > 12);
  const cap = insightCap(drafts.length);
  const out = analyzeBatch(drafts, {
    eventName: c.event.name,
    eventAliases: c.event.aliases,
    optout: c.settings.optout_sentence,
    signoff,
    meetingPlace: c.settings.meeting_place,
    sender: c.settings.own_company || null,
    approved: [...approved, ...proofClaims],
    insights: insights.map((x) => x.insight).filter(Boolean),
    insightCap: cap
  });
  const ins = checkInsights(drafts, { insights, cap });
  // One proof point in at most a third of a touch's drafts (SKILL.md "Variety"): a draft uses a claim when it
  // carries one of the claim's numbers. With a single proof point the rest go plain or ask a question.
  // Drafts the user's own skill wrote keep its proof: its style is theirs (floorboss's rules would otherwise
  // rewrite a proof-led skill's case studies away).
  const ours = drafts.filter((d) => d.drafted_by === 'floorboss');
  if (ours.length >= 6)
    for (const claim of proofClaims) {
      // Only numbers that mark the claim: a percentage, a currency amount, a multiple, or three digits or more.
      // "20" from "20 retailers" would match every "20 minutes".
      const nums = (claim.match(/[€$£]\s?\d[\d,.]*\s?[kmb]?|\d[\d,.]*\s?%|\d+(?:\.\d+)?x\b|\d{1,3}(?:,\d{3})+|\d{3,}/gi) || []).map((x) => x.trim());
      if (!nums.length) continue;
      const using = ours.filter((d) => nums.some((n) => d.body.includes(n)));
      const cap = Math.max(2, Math.floor(ours.length / 3));
      if (using.length > cap) {
        const move = using.filter((d) => !d.fixed).slice(cap - (using.length - using.filter((d) => !d.fixed).length));
        out.reasons.push(
          `${using.length} of ${ours.length} drafts use the proof point "${claim.slice(0, 60)}…" (limit ${cap}, a third): rewrite ${move.map((d) => d.id).join(', ')} without it (a plain request, or another proof that fits)`
        );
        out.verdict = 'FAIL';
      }
    }
  const spread = structureSpread(
    touchBatch(c, touch, insights)
      .filter((d) => (d.drafted_by || 'floorboss') === 'floorboss')
      .map((d) => ({ id: d.id, structure: d.structure, company_key: c.byId[d.id]?.company_key })),
    { uncapped: OPENINGS[openingOf(skillsOf(c).voice || '')]?.only || [] }
  );
  if (spread.length) {
    out.reasons.push(...spread);
    out.verdict = 'FAIL';
  }
  out.touch = touch;
  out.insight_cap = ins.cap;
  out.insight_use = ins.use;
  out.reasons.push(...ins.reasons);
  if (ins.reasons.length) out.verdict = 'FAIL';
  return out;
}

// Batch versions, so a run with dozens of drafts doesn't need hundreds of tool calls.
// The whole batch is read and checked before anything is written: one bad entry (an id not in todo, a sent
// message, no body, the same message twice) saves nothing, so a batch is never left half saved.
export function saveDrafts(opts) {
  need(opts, 'event', 'drafts');
  let parsed;
  try {
    parsed = JSON.parse(opts.drafts);
  } catch (err) {
    throw new Error(`The drafts file isn't JSON (${err.message}). Nothing was saved.`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.drafts;
  if (!Array.isArray(list) || !list.length) throw new Error('The drafts file is a list: [{"id","touch","subject","body",…}]. Nothing was saved.');
  const c = ctxOf(opts.event, opts);
  const problems = [],
    seen = new Set();
  list.forEach((d, i) => {
    const where = `entry ${i + 1}${d && typeof d === 'object' && d.id ? ` (${d.id}${d.touch != null ? `:${d.touch}` : ''})` : ''}`;
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      problems.push(`${where} isn't an object`);
      return;
    }
    const touch = Number(d.touch ?? 1);
    if (typeof d.id !== 'string' || !/^c\d+$/.test(d.id)) {
      problems.push(`${where} has no id like c014`);
      return;
    }
    if (!Number.isInteger(touch) || touch < 0) {
      problems.push(`${where}: touch is a whole number`);
      return;
    }
    if (seen.has(`${d.id}:${touch}`)) problems.push(`${where} is in the batch twice`);
    seen.add(`${d.id}:${touch}`);
    if (typeof d.body !== 'string' || !d.body.trim()) problems.push(`${where} has no body`);
    try {
      jobFor(c, d.id, touch);
    } catch (err) {
      problems.push(`${where}: ${err.message}`);
      return;
    }
    if (c.state[d.id]?.sent?.[touch]) problems.push(`${where} was sent on ${c.state[d.id].sent[touch]}; its saved text stays as it is`);
  });
  if (problems.length) throw new Error(`Nothing was saved: ${problems.join('; ')}. Fix the file and save the whole batch again.`);
  return list.map((d) => saveDraft({ ...opts, id: d.id, touch: d.touch ?? 1, json: JSON.stringify(d), md: undefined }, c));
}

// briefs --event <slug>: for jobs the user's own skill or agent drafts (delegate or blend), the brief it is
// given: who, why, which channel and times, the app-note rules, the user's feedback and floorboss's rules.
export function briefs(opts) {
  need(opts, 'event');
  const c = ctxOf(opts.event, opts);
  const t = readTodo(c, null);
  if (!t) throw new Error('Run "todo" first.');
  const skills = skillsOf(c);
  const files = { voice: skills.voice, whatYouBring: skills.whatYouBring };
  // The instructions file of the user's outbound agent (drafter type "instructions"), read here and put in
  // each brief: floorboss's writer (agents/outreach-writer.md) can't read files. Never a key or credential file.
  const instr = t.jobs.find((j) => j.drafter?.by === 'user' && j.drafter.instructions)?.drafter.instructions;
  if (instr) {
    try {
      // Only an agent or skill file (Markdown in a .claude/agents or .claude/skills folder, or a plugin's, by its
      // real name once links are followed), checked again here as it is read (drafter.mjs instructionsPath).
      const rp = instructionsPath(instr);
      if (!rp) throw new Error('not an agent or skill file');
      if (statSync(rp).size > 200 * 1024) throw new Error('over 200 KB');
      files.instructions = readFileSync(rp, 'utf8');
    } catch {
      files.instructions = null;
    }
  }
  const want = opts.ids ? new Set(String(opts.ids).split(/[\s,]+/)) : null;
  const out = [];
  for (const j of t.jobs) {
    if (j.drafter?.by !== 'user' || j.held_for_user) continue;
    if (want && !want.has(j.id) && !want.has(`${j.id}:${j.touch}`)) continue;
    const f = join(c.paths.dir, 'briefs', `${j.id}-t${j.touch}.md`);
    // A follow-up planned with its first message: the message before it, once that's written.
    const prev = j.planned && !j.previous_message ? earlierDraft(c, j.id, touchBefore(c.state[j.id], j.touch)) : null;
    writeText(f, buildBrief(prev?.body ? { ...j, previous_message: prev.body } : j, { event: c.event, settings: c.settings, files }));
    out.push({ id: j.id, touch: j.touch, drafter: j.drafter.invoke, type: j.drafter.type, brief_file: f });
  }
  return {
    briefs: out.length,
    by_drafter: out,
    next: out.length ? briefsNext() : "No jobs for the user's drafter in this run."
  };
}

// revise --event <slug> (--ids "c004,c007:2" | --all) --feedback-file <file> [--rule]: the user's feedback on
// drafts ("too formal", "shorter") sends them back through floorboss: drafted again
// to the feedback, checked, and read by the critic again. Drafts are never rewritten outside floorboss.
// --rule also saves the feedback as a standing rule in the voice file, so later drafts start from it.
export function revise(opts) {
  need(opts, 'event', 'feedback-file');
  const c = ctxOf(opts.event, opts);
  const feedback = readChecked(allowedPath(opts['feedback-file'])).trim();
  if (!feedback) throw new Error('The feedback file is empty.');
  let specs;
  if (opts.all) {
    specs = draftFiles(c)
      .map((x) => [x.id, Number(x.t)])
      .filter(([id, t]) => {
        const st = c.state[id] || {};
        return !st.sent?.[t] && !st.replied && !st.booked && !st.stopped && st.touches?.[t]?.status !== 'superseded' && !c.blocked(id);
      });
  } else {
    need(opts, 'ids');
    specs = idList(opts.ids)
      .map(touchSpec)
      .map(({ id, touch }) => [id, touch]);
  }
  const done = [],
    skipped = [];
  for (const [id, touch] of specs) {
    const f = draftFile(c.paths, id, touch);
    const d = readJson(f, null);
    if (!d) {
      skipped.push({ id, touch, reason: 'no draft' });
      continue;
    }
    if (c.state[id]?.sent?.[touch]) {
      skipped.push({ id, touch, reason: 'already sent' });
      continue;
    }
    writeJson(f, {
      ...d,
      verdict: null,
      critic_rewrites: 0,
      revise: { feedback, previous_body: d.body, at: c.now.toISOString() },
      revisions: (d.revisions || 0) + 1
    });
    led(c, { type: 'revise', id, touch, feedback: feedback.slice(0, 300), said: feedback.slice(0, 200) });
    done.push(`${id}:${touch}`);
  }
  if (!done.length) throw new Error(`Nothing to revise${skipped.length ? `: ${skipped.map((x) => `${x.id} ${x.reason}`).join('; ')}` : ''}.`);
  let rule = null;
  if (opts.rule) {
    const skills = skillsOf(c);
    if (!skills.dir) throw new Error('No context profile, so there is no voice file to save the rule in.');
    const p = join(skills.dir, 'voice', 'SKILL.md');
    const text = existsSync(p) ? readFileSync(p, 'utf8') : '# Voice\n';
    const head = '## Rules from your feedback';
    // One plain line, capped, with nothing that could start a heading, a fence or frontmatter.
    const clean = feedback
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/[`#<>]/g, '')
      .replace(/^-+/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    const line = `- ${clean} (${c.today})`;
    writeText(p, text.includes(head) ? text.replace(head, () => `${head}\n${line}`) : `${text.trimEnd()}\n\n${head}\n${line}\n`);
    rule = p;
  }
  return {
    revise: done,
    skipped,
    rule_saved_to: rule,
    next: 'Run flow next again: these are drafted again to the feedback, then checked and read by the critic.'
  };
}

export function redraft(opts) {
  need(opts, 'event', 'ids');
  const c = ctxOf(opts.event, opts);
  const done = [];
  for (const { id, touch } of idList(opts.ids).map(touchSpec)) {
    const f = draftFile(c.paths, id, touch);
    const d = readJson(f, null);
    if (!d) throw new Error(`${id} touch ${touch} has no draft.`);
    writeJson(f, { ...d, verdict: null, critic_rewrites: 0, last_fail: d.verdict || d.last_fail || null, fresh_attempt: (d.fresh_attempt || 0) + 1 });
    led(c, { type: 'fresh_attempt', id, touch, said: 'a fresh attempt, asked for by the user' });
    done.push(`${id}:${touch}`);
  }
  return { fresh_attempt: done, next: "Run flow next again: these are drafted again from scratch, with the critic's last reasons as a guide." };
}

// What to do with the user's own drafter's briefs. In hand-send, no Claude Code tool by name.
export const briefsNext = () =>
  handSend()
    ? 'Give each brief to its drafter (the user\'s own skill or agent), one brief at a time and nothing else, then save each answer with save-draft --json, adding "drafted_by": "<drafter>". The checks and the critic read it like any draft.'
    : 'Give each brief to its drafter (the Skill tool for a skill, the Agent tool for an agent), then save each answer with save-draft --json, adding "drafted_by": "<drafter>". The checks and the critic read it like any draft.';
