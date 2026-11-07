// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// The only material the critic sees. Built from a whitelist; attendee notes are never included.
import { noteText, blockText } from '../../../lib/normalize.mjs';

// Strings (at any depth) flattened to one clean line each; null for nothing.
const oneLine = (v) =>
  v == null || v === ''
    ? null
    : typeof v === 'string'
      ? noteText(v, 4000)
      : Array.isArray(v)
        ? v.map(oneLine)
        : typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, oneLine(x)]))
          : v;

export function buildCriticInput({
  draft,
  insight,
  fitReason,
  userNote,
  accountNote,
  previousMessage,
  timesChanged,
  contact,
  profile,
  companyBrief,
  segment,
  event,
  goal,
  slotLabels,
  meetingPlace,
  crmSummary,
  whatYouBring,
  voiceSignoff,
  optout,
  appNote,
  voiceRules,
  languages,
  mailboxNote,
  structure,
  factSource,
  openingRule
}) {
  return {
    draft: { channel: draft.channel, subject: draft.subject || null, body: draft.body, touch: draft.touch ?? 1 },
    // Written by the user's own outbound skill or agent: its structure, proof and angle are the user's choice.
    ...(draft.drafted_by && draft.drafted_by !== 'floorboss' ? { written_by_their_own_skill: draft.drafted_by } : {}),
    // A follow-up sits in the same thread: the earlier message is part of what the reader has seen.
    ...(previousMessage ? { previous_message: blockText(previousMessage, 50000) } : {}),
    // What the sender's own mailbox shows about this person (an earlier email, no reply): the draft may refer to it.
    ...(mailboxNote ? { mailbox_note: blockText(mailboxNote, 50000) } : {}),
    // Times offered earlier that are gone now: a follow-up may say so, naming the old time.
    ...(timesChanged ? { times_changed: timesChanged } : {}),
    // The insight the draft says it leads with, or null for a question or proof angle. Left out for
    // drafts saved before drafts declared one.
    ...(insight === undefined ? {} : { declared_insight: insight || null }),
    // The structure the draft says it follows, and which fact about the reader it uses ('none': the plain form).
    ...(structure ? { declared_structure: structure } : {}),
    ...(factSource ? { declared_fact_source: factSource } : {}),
    // The user's voice rule about the opening, and the structures floorboss assigns for it: the structure is
    // chosen to meet the rule, so neither is failed for following the other.
    ...(openingRule ? { opening_rule: openingRule } : {}),
    // From the attendee list: one line each, nothing invisible.
    contact: { name: noteText(contact.name, 200), title: noteText(contact.title, 200), company: noteText(contact.company, 200) },
    segment: segment || null,
    event: { name: event.name, city: event.city, dates: `${event.start_date} to ${event.end_date}` },
    goal: goal || null,
    offered_times: slotLabels || [],
    meeting_place: meetingPlace || null,
    // CRM and research text is written by others too: one clean line per field, so none of it can pass for a
    // line of the critic's reply.
    crm_summary: oneLine(crmSummary),
    // What the user said about this person at triage ("met at last year's summit", "knows every operator").
    user_note: noteText(userNote, 500) || null,
    // "at your account X (Customer)": a fact the sender's records give; the draft may say they work with
    // the company, never that the sender knows this person.
    account_note: oneLine(accountNote),
    // Why the user's shortlist picked this person (from their title, company and profile).
    fit_reason: oneLine(fitReason),
    profile: profile ? blockText(profile, 50000) : null,
    // The verified company brief: what they sell, how they relate to the sender, what they'd want. The draft's
    // angle must fit it (no pitching a customer what they already use, no explaining their product to them).
    company_brief: companyBrief || null,
    what_you_bring: whatYouBring || null,
    sign_off: voiceSignoff || null,
    optout_sentence: optout || null,
    // An event-app note whose times live in the app's request: what the note itself must carry.
    ...(appNote ? { app_note: appNote } : {}),
    // Standing rules the user gave from earlier drafts ("plain over clever", "shorter").
    voice_rules: voiceRules || null,
    // The languages the sender can hold a meeting in; a draft in any other fails.
    languages: languages?.length ? languages : null
  };
}

// Parse the critic's reply: "PASS" or "FAIL: reason; reason".
export function parseVerdict(text) {
  const t = String(text ?? '').trim();
  const line = t.split(/\r?\n/).find((l) => /^(PASS|FAIL)\b/.test(l.trim()));
  if (!line) return { verdict: 'FAIL', reasons: ['critic reply was not PASS or FAIL'] };
  const l = line.trim();
  if (l.startsWith('PASS')) return { verdict: 'PASS', reasons: [] };
  const reasons = splitReasons(l.replace(/^FAIL:?\s*/, ''))
    .map((s) => s.trim())
    .filter(Boolean);
  return { verdict: 'FAIL', reasons: reasons.length ? reasons : ['no reason given'] };
}

// Reasons are split at ";" only outside brackets and quotes: "(a; b)" or "\"x; y\"" is one reason.
function splitReasons(text) {
  const out = [];
  let cur = '',
    depth = 0,
    quote = null;
  for (const ch of String(text)) {
    if (quote) {
      if (ch === quote || (quote === '“' && ch === '”')) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === '“') {
      quote = ch;
      cur += ch;
      continue;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}
