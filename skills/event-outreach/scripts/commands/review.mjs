// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The critic's review: its input, saving its verdicts, and the user's choice to skip it.
import { optoutForReader } from '../../../../lib/config.mjs';
import { allowedPath } from '../../../../lib/paths.mjs';
import { noteText, voiceRulesOf } from '../../../../lib/normalize.mjs';
import { need } from '../../../../lib/args.mjs';
import { readJson, writeJson } from '../../../../lib/jsonio.mjs';
import { buildCriticInput, parseVerdict } from '../critic-input.mjs';
import { touchBefore } from '../../../../lib/route.mjs';
import { openingOf, OPENINGS } from '../structures.mjs';
import { hashOf } from './routes.mjs';
import { ctxOf, skillsOf, signoffOf, segmentInfo, knownReader, led, idList, touchSpec } from './context.mjs';
import { jobFor, savedDraft, resolveInsight, insightsOf, earlierDraft, criticFails, readTodo } from './saved-drafts.mjs';

export function criticInput(opts, given = null) {
  need(opts, 'event', 'id');
  const touch = Number(opts.touch ?? 1);
  const c = given || ctxOf(opts.event, opts);
  const job = jobFor(c, opts.id, touch);
  const raw = readJson(job.draft_file, null);
  if (!raw) throw new Error(`No draft saved for ${job.id} touch ${touch}.`);
  if (job.kind !== 'message')
    throw new Error(
      job.kind === 'confirmation'
        ? "Confirmations don't go to the critic: the script checks hold them to the booked time and place, with no link."
        : "Coordinate notes are internal and don't go to the critic."
    );
  // The critic reads the text the ledger fingerprints, never a working copy changed after it was saved.
  const draft = savedDraft(c, job.id, touch, raw);
  if (!draft) throw new Error(`${job.id} touch ${touch} changed after it was saved: save it again (save-draft), then the critic reads it.`);
  const skills = skillsOf(c);
  const voice = skills.voice || '';
  const signoff = signoffOf(voice);
  const senderLine = (/^-?[ \t]*\**sender(?: name)?:?\**:?[ \t]*(.+)$/im.exec(voice) || [])[1] || null;
  const sender = senderLine && !/<[^>]*>/.test(senderLine) ? senderLine : null;
  // Drafts saved before insights were declared have no "insight" key, so the critic isn't told one.
  const insight = 'insight' in draft ? resolveInsight(draft, insightsOf(c))?.insight || null : undefined;
  return buildCriticInput({
    draft,
    insight,
    fitReason: job.reason,
    userNote: c.triage.user_notes?.[job.id] ?? job.user_note,
    accountNote: job.account_note,
    previousMessage: job.followup ? job.previous_message || earlierDraft(c, job.id, touchBefore(c.state[job.id], touch))?.body || null : null,
    mailboxNote: job.mailbox_note || null,
    timesChanged: job.followup ? job.times_changed : null,
    contact: c.byId[job.id],
    profile: job.profile,
    companyBrief: job.company_brief,
    segment: (job.segment?.slug && segmentInfo(skillsOf(c), job.segment.slug)) || job.segment,
    event: c.event,
    goal: c.settings.goal,
    slotLabels: job.slot_labels,
    meetingPlace: c.settings.meeting_place,
    crmSummary: job.crm_summary,
    whatYouBring: skills.whatYouBring,
    voiceSignoff: [signoff, sender].filter(Boolean).join(' / ') || null,
    optout: optoutForReader(c.settings, draft.language, knownReader(c, job.id)),
    appNote: job.app_note,
    languages: c.settings.languages || [],
    structure: draft.structure || null,
    factSource: draft.fact_source || null,
    openingRule: OPENINGS[openingOf(voice)]?.says || null,
    lastTouch: !!job.last_touch,
    checkWarnings: draft.warnings || raw.warnings || [],
    voiceRules: voiceRulesOf(voice) || null
  });
}

export function verdict(opts, given = null) {
  need(opts, 'event', 'id', 'text');
  const touch = Number(opts.touch ?? 1);
  const c = given || ctxOf(opts.event, opts);
  const job = jobFor(c, opts.id, touch);
  const draft = readJson(job.draft_file, null);
  if (!draft) throw new Error(`No draft saved for ${job.id} touch ${touch}.`);
  // A verdict is for the text the ledger fingerprints: a working copy changed after it was saved isn't it.
  if (!savedDraft(c, job.id, touch, draft))
    throw new Error(
      `${job.id} touch ${touch} changed after it was saved, so this verdict can't be for it: save it again (save-draft), then run the critic on it.`
    );
  // --hash: the fingerprint of the text the critic was shown. A verdict for text rewritten since isn't for this text.
  if (typeof opts.hash === 'string' && opts.hash !== hashOf(c, draft))
    throw new Error(`${job.id} touch ${touch} changed since the critic read it, so this verdict isn't for it: run the critic on the text as it is now (flow next).`);
  const v = parseVerdict(opts.text);
  // The verdict is for this exact text: an edit afterwards sends it back to the critic.
  draft.verdict = { ...v, hash: hashOf(c, draft) };
  // A verdict saved again for the same version of the draft replaces the earlier one; it isn't another run.
  if (draft.verdict_attempt !== draft.attempts) draft.critic_runs = (draft.critic_runs || 0) + 1;
  draft.verdict_attempt = draft.attempts;
  writeJson(job.draft_file, draft);
  led(c, { type: 'critic', id: job.id, touch, hash: draft.verdict.hash, verdict: v.verdict, reasons: v.reasons });
  const rewrite = v.verdict === 'FAIL' && criticFails(c, job.id, touch) < 2;
  return {
    id: job.id,
    touch,
    verdict: v.verdict,
    reasons: v.reasons,
    next: rewrite ? 'rewrite once, save-draft, then run the critic again' : v.verdict === 'FAIL' ? 'show the user marked failed' : 'ready for the gate'
  };
}

export function criticBatch(opts) {
  need(opts, 'event', 'ids');
  const c = ctxOf(opts.event, opts);
  const list = idList(opts.ids)
    .map(touchSpec)
    .map(({ id, touch }) => ({ id, touch, input: criticInput({ ...opts, id, touch }, c) }));
  // --out <file>: the batch is written there too, so the flow can hand the critic one file to paste.
  const done = (out) => {
    if (opts.out) writeJson(allowedPath(opts.out, { write: true }), out);
    return out;
  };
  if (!opts.compact) return done(list);
  // --compact: fields every draft shares (what-you-bring is often several KB) are given once, so a batch
  // stays small enough to paste whole.
  const shared = {};
  for (const k of ['what_you_bring', 'event', 'goal', 'sign_off', 'optout_sentence', 'meeting_place']) {
    const vals = list.map((x) => JSON.stringify(x.input[k]));
    if (list.length && vals.every((v) => v === vals[0])) {
      shared[k] = list[0].input[k];
      for (const x of list) delete x.input[k];
    }
  }
  return done({ shared, drafts: list });
}

// Text with one line per draft: "c001 PASS" or "c002 FAIL: reason; reason" (optionally "c002:2" for touch 2).
export function verdicts(opts) {
  // The batch's ids are required: a verdict line for a draft the critic wasn't shown counts for nothing.
  need(opts, 'event', 'text', 'ids');
  if (/^\s*ERROR: no drafts provided/m.test(String(opts.text)))
    throw new Error('The critic says it was given no drafts. Paste the critic-batch JSON into its prompt and run it again.');
  // An empty list ("", spaces, a lone comma) says so: "no verdict lines" would send the user to the reply instead.
  if (!idList(opts.ids).length)
    throw new Error('--ids is empty: give the batch\'s ids as the critic step\'s `then` command has them (like "c001:1,c002:1").');
  const allowed = new Set(idList(opts.ids).map((x) => (x.includes(':') ? x : `${x}:1`)));
  const picked = new Map();
  const ignored = [];
  for (const line of String(opts.text).split(/\r?\n/)) {
    const m = /^\s*`?(c\d{3,})(?::(\d))?`?\s*[:\-]?\s*(PASS\b.*|FAIL.*)$/i.exec(line);
    if (!m) continue;
    const key = `${m[1].toLowerCase()}:${Number(m[2] || 1)}`;
    if (allowed && !allowed.has(key)) {
      ignored.push(key);
      continue;
    }
    const text = /^fail/i.test(m[3]) ? m[3].replace(/^fail/i, 'FAIL') : 'PASS';
    if (picked.has(key) && picked.get(key).startsWith('FAIL')) continue; // FAIL wins
    picked.set(key, text);
  }
  if (!picked.size) throw new Error('No verdict lines for this batch. Each line should look like "c001 PASS" or "c002 FAIL: reason".');
  const missing = allowed ? [...allowed].filter((k) => !picked.has(k)) : [];
  const c = ctxOf(opts.event, opts);
  // --hashes "c001:1=<hash>,…" (the critic step's command has them): each draft's fingerprint as its critic was shown
  // it. A draft rewritten since gets no verdict from this reply: it goes to the critic again as the text it is now.
  const shownHash = new Map();
  if (typeof opts.hashes === 'string')
    for (const part of idList(opts.hashes)) {
      const [k, h] = part.split('=');
      if (k && h) shownHash.set(k.includes(':') ? k : `${k}:1`, h);
    }
  const changed = [];
  const out = [];
  for (const [key, text] of picked.entries()) {
    const [id, t] = key.split(':');
    if (typeof opts.hashes === 'string' && shownHash.get(key) !== c.state[id]?.touches?.[t]?.hash) {
      changed.push(key);
      continue;
    }
    out.push(verdict({ ...opts, id, touch: Number(t), text, hash: undefined }, c));
  }
  if (!out.length && changed.length)
    throw new Error(
      `${changed.join(', ')} changed since the critic read ${changed.length === 1 ? 'it' : 'them'}, so this reply's verdicts aren't for the text as it is now: run flow next, and the critic reads it again.`
    );
  return {
    verdicts: out,
    ...(changed.length ? { changed_since_read: changed, note: 'No verdict saved for these: their text changed after the critic read it. flow next sends them to the critic again.' } : {}),
    ...(ignored.length ? { ignored_not_in_batch: ignored } : {}),
    ...(missing.length ? { missing_from_reply: missing } : {})
  };
}

// skip-review --event <slug> (--ids … | --all) --said "<the user's words>": when the critic can't run (the
// user's usage limit, no agents) and the user says in words to go on without it. Only drafts the critic
// hasn't read are skipped; the script checks still apply. The skip is logged with the user's words and
// every card shows "not reviewed".
export function skipReview(opts) {
  need(opts, 'event', 'said');
  const said = noteText(opts.said);
  if (said.length < 3) throw new Error('--said needs the user\'s own words, e.g. "skip the review, send them as they are".');
  const c = ctxOf(opts.event, opts);
  const t = readTodo(c, null);
  if (!t) throw new Error('Run "todo" first.');
  const want = opts.all ? null : new Set(idList(opts.ids || ''));
  if (want && !want.size) throw new Error('Give --ids or --all.');
  // --because: the user's reason, in their words, on one line.
  const because = typeof opts.because === 'string' ? noteText(opts.because, 200) : '';
  const noted = new Set();
  const done = [],
    refused = [];
  for (const j of t.jobs) {
    if (j.kind !== 'message' || (want && !want.has(j.id) && !want.has(`${j.id}:${j.touch}`))) continue;
    // Only a saved text the critic hasn't read, by the ledger: a working copy with its verdict cleared by hand
    // doesn't make a failed draft skippable.
    const d = savedDraft(c, j.id, j.touch, readJson(j.draft_file, null));
    if (!d || d.verdict) continue;
    const hash = hashOf(c, d);
    // A text the critic failed stays failed, even after a revise voided its verdict: only a rewrite, or the
    // user approving it by name, gets it past the gate.
    if ((c.entries || []).some((e) => e.type === 'critic' && e.id === j.id && (e.touch ?? 1) === j.touch && e.hash === hash && e.verdict === 'FAIL')) {
      refused.push(`${j.id}:${j.touch}`);
      continue;
    }
    writeJson(j.draft_file, { ...d, verdict: { verdict: 'SKIPPED', reasons: [], said, ...(because ? { because } : {}), at: c.now.toISOString(), hash } });
    led(c, { type: 'review_skipped', id: j.id, touch: j.touch, hash, said, ...(because ? { because } : {}) });
    // The reason, given for named drafts ("I was on that deal"), is also the user's note on the person.
    if (because && want && !noted.has(j.id)) {
      led(c, { type: 'note', who: 'user', id: j.id, text: because, said });
      noted.add(j.id);
    }
    done.push(`${j.id}:${j.touch}`);
  }
  return {
    skipped_review: done,
    ...(refused.length
      ? { not_skipped: refused, why_not: 'the critic failed this exact text: rewrite it, or approve it by name at the gate to send it anyway' }
      : {}),
    note: done.length
      ? 'These go to the gate unreviewed: their cards say so. The script checks still apply.'
      : 'Nothing to skip: every draft has been read by the critic, or none are saved.'
  };
}
