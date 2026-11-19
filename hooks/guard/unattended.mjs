// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Unattended email drafts, in the guard: the opt-in and the authorisation (each a prompt the user allows, recorded only
// by the PostToolUse hook once that call ran), the run's ticket (bound at a fresh startup of the session the launcher
// named), what the guard reads for itself in a mailbox or CRM answer, the model's CRM judgements, and the one decision
// that returns "allow": a draft of an authorised follow-up, put in the mailbox through the saved stage_draft recipe in a
// ticketed run, when every check holds. Outside a run with a token nothing here changes a decision.
import { join } from 'node:path';
import { readFileSync, unlinkSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { home, allowedPath, readChecked } from '../../lib/paths.mjs';
import { stampRun } from '../../lib/runlock.mjs';
import { loadEvent } from '../../lib/event.mjs';
import { addDays, todayKeyIn } from '../../lib/tz.mjs';
import { appendLine } from '../../lib/jsonio.mjs';
import { contactable, append as appendLedger } from '../../lib/ledger.mjs';
import { eventRecord, verifySend, eventDay, followupDueDay, approvalHash, addressBusyToday, busyWhy, personAddressKeys, addressKeys } from '../../lib/sendcheck.mjs';
import { withLocks } from '../../lib/lock.mjs';
import { SHARED_INBOX } from '../../lib/normalize.mjs';
import { sameServer } from '../../lib/security.mjs';
import { bareToolName } from '../../skills/connectors/scripts/tasks.mjs';
import { isOff, logLine, oneLine, followupsInstalledFile, platformFor, unattendedDir } from '../../lib/unattended.mjs';
import {
  DRAFTS_SENTENCE,
  normSentence,
  sha256,
  recipeFp,
  eventEndMs,
  hoursWhy,
  windowWhy,
  shortDay,
  optinFor,
  authorisable,
  authorisationFor,
  listHash,
  gapChangedWhy,
  handSentDraft,
  MAILBOX_ANCHOR_WHY,
  bindTicket,
  ticketed,
  stopped,
  stopRun,
  readWitness,
  writeWitness,
  fresh,
  criticPassed,
  earlierStepWhy,
  emailBefore,
  readSince,
  readValues,
  gmailReads,
  messageIdOf,
  crmUnreadableWhy,
  gmailSearchWhy,
  attendedDraftIn,
  olderDraftOf,
  olderDraftWhy,
  draftIdText,
  attendedDraftOpen,
  attendedOpenWhy,
  unclearDrafts,
  logEntries,
  readPrivate,
  writePrivate,
  createOnce,
  pendingFile,
  authorisedFile,
  WITNESS_MS
} from '../../lib/unattended-drafts.mjs';
import { readJsonStrict, leaves, fold } from './shared.mjs';
import { check } from './check.mjs';
import { listed, notRealEvent, fullText } from './sends.mjs';
import { promptPerson, promptLine } from './prompts.mjs';
import { shellWords } from './shell.mjs';
import { dayMarker, sendLocks, ownerOf, takeMarker, markerFree, dropMarkers, dayResetsOf } from './daymark.mjs';
import { mailWitness, mailFromWitness, crmWitness, rawValue, activityLine, YOU_WROTE, SEARCH_UNPROVEN } from './witness.mjs';
import { hasCallId, NO_CALL_ID } from './after-call.mjs';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PID = /^c\d+$/;
// An attended draft's call mark (asked about, its call not yet run) holds an unattended draft of the same step for
// lib/unattended-drafts.mjs ATTENDED_OPEN_MS (12 hours, as long as a session that ran floorboss keeps its limits):
// Claude Code's prompt can stay open that long, and its call still runs once allowed. The launcher waits for the same
// mark (scripts/scheduled.mjs followupsDue).
// Ledger entries that let a step's draft be taken again: each makes a new once mark. (A day marker is cleared by the
// day rule the attended send uses too: hooks/guard/daymark.mjs DAY_RESETS.)
export const RESETS = ['release_cleared', 'bounced', 'stage_cleared'];
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return null;
  }
})();
// The token the launcher put in this Claude Code process's environment, inherited by its hooks.
export const runToken = () => String(process.env.FLOORBOSS_UNATTENDED || '');
const flagOf = (words, k) => {
  const i = words.lastIndexOf(k);
  return i >= 0 ? words[i + 1] : undefined;
};
const callKey = (input) => String(input?.tool_use_id || `${input?.session_id || ''}:${input?.tool_name || ''}`);
const sameCallOf = (note, input) => (note?.call ? note.call === String(input?.tool_use_id || '') : note?.session === String(input?.session_id || '') && note?.tool === String(input?.tool_name || ''));
const recentMs = (at, nowMs, ms) => {
  const t = Date.parse(at);
  return Number.isFinite(t) && nowMs - t < ms && t - nowMs <= 60000;
};
const responseText = (r) => {
  try {
    return typeof r === 'string' ? r : JSON.stringify(r ?? '');
  } catch {
    return '';
  }
};
const settingsOf = (slug, config) => {
  try {
    return { ...loadEvent(slug).settings, connectors: config?.connectors || {} };
  } catch {
    return null;
  }
};
const own = (config, settings) => [config?.own_email, settings?.own_email].filter(Boolean);
// The message id the mailbox search must show for the email this follow-up answers.
const searchOwnId = (session, it, p) => {
  const prev = emailBefore(p, it.touch, it.to)?.x;
  if (!handSentDraft(prev)) return messageIdOf(prev);
  const mw = readWitness(session, it.event, it.id, 'mail');
  return mw?.readable && mw.own_last?.id ? String(mw.own_last.id) : null;
};
// What a held draft tells the user to do, when only they can.
export const SEND_IT_YOURSELF = 'send this follow-up yourself, from your mailbox';

// ---------- SessionStart ----------
// A fresh startup of the session the launcher named, with its token: the ticket is bound (once), and the session is
// held to a floorboss run from its first call (lib/runlock.mjs). Anything else with a token in the environment is
// logged and binds nothing: every call in it is refused.
export function sessionStart(input, nowMs = Date.now()) {
  const token = runToken();
  if (!token) return null;
  const session = String(input?.session_id || '');
  const r = bindTicket({ session, token, source: String(input?.source || ''), nowMs });
  try {
    if (r.ok) {
      stampRun({ session, transcript: input?.transcript_path });
      logLine('run_started', { session, items: r.ticket.items?.length || 0 });
    } else logLine('ticket_refused', { session: oneLine(session, 64), why: r.why });
  } catch {
    /* the binding stands or not on its own; the log is best effort */
  }
  return r;
}

// Is this call inside a ticketed run? { on: a token is in the environment, ok, why, ticket }.
export function unattendedSession(input, nowMs, subagent) {
  const token = runToken();
  if (!token) return { on: false };
  const t = ticketed({ session: String(input?.session_id || ''), token, subagent, nowMs });
  return { on: true, ...t };
}
// The first refusal, failure or unexpected answer in a run stops it: said once in the log, and every later call in it
// is refused (the follow-ups not reached wait for the next run, or for the user).
export function stopHere(session, why, extra = {}) {
  try {
    if (stopRun(session, why)) logLine('run_stopped', { session, why, ...extra });
  } catch {
    /* the refusal stands whether or not it could be noted */
  }
}

// ---------- the opt-in (step 2: the prompt) ----------
// crm: true (an activity reader is connected), false (no CRM at all), or "noreader" (a CRM with no activity reader:
// every draft waits, and crmNote says why and how to fix it).
export function optinReason({ name, slug, end, crm = false, crmNote = null }) {
  const reads = crm === true ? "your mailbox and your CRM's logged activity" : crm === 'noreader' ? 'your mailbox (and would read your CRM, but it has no activity reader connected: see the note)' : 'your mailbox (no CRM is connected, so only email is checked)';
  return `floorboss: turn on unattended drafts for ${promptLine(name)} (${slug}), until ${shortDay(end)} ${String(end).slice(0, 4)}, the event's last day. Once the schedule is installed from your own terminal, follow-ups you authorise can go into your mailbox's drafts folder on their day or the day after, on weekdays from 09:00 to 17:00 event time, with no prompt before each one. Nothing is sent: each draft waits for you to read it and press Send. Before each draft floorboss reads ${reads} for anything from that person since your last message, and holds the draft if anything came in or the read fails. It can't see replies on LinkedIn or in the event app.${crmNote ? ` Note: ${crmNote}.` : ''}\n\nAllow only if you typed "${DRAFTS_SENTENCE}" yourself, just now.`;
}
function optinCheck(words, config, nowMs) {
  const slug = String(flagOf(words, '--event') ?? '');
  if (!SLUG.test(slug)) return { refuse: 'unattended-on needs --event <the event\'s slug>.' };
  if (notRealEvent(slug)) return { refuse: `${slug} isn't a real event of yours (the mock event never runs on its own).` };
  if (platformFor() !== 'darwin') return { refuse: 'running on its own is macOS only for now. Linux (systemd timers) and Windows (Task Scheduler) are planned.' };
  let ev;
  try {
    ev = loadEvent(slug).event;
  } catch {
    return { refuse: `floorboss can't read ${slug}'s event file.` };
  }
  const endMs = eventEndMs(ev);
  if (!endMs) return { refuse: `floorboss can't read ${slug}'s dates.` };
  if (nowMs > endMs) return { refuse: `${ev.name || slug} is over: nothing goes in for it on its own.` };
  if (!config?.connectors?.stage_draft) return { refuse: 'unattended drafts need your draft tool connected (stage_draft): connect it in /floorboss:event-setup first.' };
  if (!config?.connectors?.['email.messages']) return { refuse: "unattended drafts need your mailbox reader connected (email.messages): floorboss reads it before each draft. Connect it in /floorboss:event-setup first." };
  if (!config?.own_email) return { refuse: 'unattended drafts need your own address saved (own_email): floorboss tells your messages from theirs by it.' };
  const said = flagOf(words, '--said-file');
  let text = '';
  try {
    text = readChecked(allowedPath(String(said ?? '')), 4096);
  } catch {
    return { refuse: "unattended-on needs --said-file with the user's own words, in floorboss's data folder or the temp folder." };
  }
  if (normSentence(text) !== normSentence(DRAFTS_SENTENCE)) return { refuse: `the words given aren't the sentence the user types to turn this on ("${DRAFTS_SENTENCE}"): nothing is turned on. Ask them to type it themselves.` };
  return { slug, ev, end: ev.end_date || ev.start_date, endMs, said: normSentence(text) };
}

// ---------- the authorisation (one prompt for the whole sequence) ----------
export function authoriseReason(ev, slug, items) {
  const people = [...new Set(items.map((x) => x.id))].length;
  const each = items
    .map(
      (x, n) =>
        `${n + 1}. ${promptPerson(x.name, x.id, x.to)}, follow-up ${x.touch - 1}, due ${x.due_day ? shortDay(x.due_day) : 'on its day'}, in the thread of ${x.thread_id ? `message ${x.thread_from}` : `message ${x.thread_from} once it has gone`}:\n${fullText(x.subject, x.body)}${x.older_draft ? `\n(Not on its own yet: ${olderDraftWhy(x.older_draft)}.)` : ''}`
    )
    .join('\n\n');
  return `floorboss: let these ${items.length} approved follow-up${items.length === 1 ? '' : 's'} to ${people} ${people === 1 ? 'person' : 'people'} at ${promptLine(ev.name || slug)} go into your drafts folder on their own, on their day (or the day after), with no prompt then. Each goes in only if nothing came in from that person since your last message (your mailbox, and your CRM if connected), only as written here, to the address here, in that thread. Nothing is sent: you press Send. A change to any text, address or thread after this means it waits for you again.\n\n${each}\n\nAllow only if every one of these may go into your drafts without you.`;
}

// ---------- Bash ----------
// A floorboss script call that this file decides about: { ask } (a prompt, with a note for the post hook), { refuse },
// { ok: true } (a judgement recorded), or null (nothing to say).
export function bashCall(input, call, { config, nowMs, un }) {
  const words = shellWords(input?.tool_input?.command);
  const session = String(input?.session_id || '');
  if (un.on) {
    // Turning things on and authorising them is the user's, with them there.
    if (call && ['unattended-on', 'authorise-unattended'].includes(call.sub)) return { refuse: `${call.sub} is done with you there, never in an unattended run.` };
    if (call?.skill === 'event-outreach' && call.sub === 'crm-judge') return judge(words, { session, nowMs });
    // (draft-missing in a run is refused as not one of the run's own steps.)
    return null;
  }
  if (call?.skill === 'event-outreach' && call.sub === 'draft-missing') return draftMissingAsk(words, input, { session, nowMs });
  if (call?.skill === 'connectors' && call.sub === 'unattended-on') {
    const c = optinCheck(words, config, nowMs);
    if (c.refuse) return c;
    const conns = config?.connectors || {};
    const crm = conns['crm.activity'] ? true : Object.keys(conns).some((k) => /^crm\./.test(k) && conns[k]) ? 'noreader' : false;
    const reason = optinReason({ name: c.ev.name || c.slug, slug: c.slug, end: c.end, crm, crmNote: crmUnreadableWhy(config) });
    writePrivate([], 'optin-pending.json', {
      event: c.slug,
      call: String(input?.tool_use_id || ''),
      session,
      tool: 'Bash',
      command: sha256(String(input?.tool_input?.command || '')),
      reason_sha: sha256(reason),
      said: c.said,
      expires: new Date(c.endMs).toISOString(),
      at: new Date(nowMs).toISOString()
    });
    return { ask: reason };
  }
  if (call?.skill === 'event-outreach' && call.sub === 'authorise-unattended') {
    const slug = String(flagOf(words, '--event') ?? '');
    if (!SLUG.test(slug) || notRealEvent(slug)) return { refuse: 'authorise-unattended needs --event <the slug of a real event of yours>.' };
    const o = optinFor(slug, nowMs);
    if (!o.ok) return { refuse: `${o.why}: turn unattended drafts on for it first (/floorboss:unattended on).` };
    const settings = settingsOf(slug, config);
    if (!settings) return { refuse: `floorboss can't read ${slug}'s settings.` };
    const { items } = authorisable(slug, { config, settings, nowMs });
    const fresh = items.filter((x) => !alreadyAuthorised(x));
    if (!fresh.length) return null;
    let ev = {};
    try {
      ev = loadEvent(slug).event;
    } catch {
      ev = {};
    }
    const reason = authoriseReason(ev, slug, fresh);
    writePrivate([], 'authorise-pending.json', {
      event: slug,
      call: String(input?.tool_use_id || ''),
      session,
      tool: 'Bash',
      command: sha256(String(input?.tool_input?.command || '')),
      list: listHash(fresh),
      keys: fresh.map((x) => `${x.id}:${x.touch}:${x.hash}`),
      at: new Date(nowMs).toISOString()
    });
    return { ask: reason };
  }
  return null;
}
// The same item, bound the same way, is in authorised.jsonl already (re-authorising it would ask for nothing new).
const alreadyAuthorised = (x) => {
  let lines = [];
  try {
    lines = String(readChecked(authorisedFile(), 32 * 1024 * 1024)).split('\n');
  } catch {
    return false;
  }
  const want = JSON.stringify([x.event, x.id, x.touch, x.hash, fold(x.to), x.thread_id || null, x.recipe_fp, x.read_fp]);
  return lines.some((l) => {
    try {
      const a = JSON.parse(l);
      // (One given with no day to bind counts only under the gap it was given under: after a change it may be given again.)
      return JSON.stringify([a.event, a.id, a.touch, a.hash, fold(a.to), a.thread_id || null, a.recipe_fp, a.read_fp]) === want && (!!a.due_day || ((a.gap_key ?? null) === (x.gap_key ?? null) && !(x.due_day && x.anchor_from_mailbox)));
    } catch {
      return false;
    }
  });
};

// ---------- draft-missing: the user says an unattended draft isn't in their drafts folder ----------
// Why this step can't be cleared, or null: only a step an unattended run let through (stage_released, unattended), or
// one with an attended draft of it, for any of its texts, with no receipt (lib/unattended-drafts.mjs attendedDraftIn),
// or a draft of an older text of it (olderDraftOf), with no draft recorded for its text now (no staged receipt) and
// not sent. The same rule as the script's (event-outreach draft-missing).
function draftMissingWhy(slug, id, touch) {
  let rec;
  try {
    rec = eventRecord(join(home(), 'events', slug));
  } catch {
    return `floorboss can't read ${slug}'s ledger.`;
  }
  const x = rec.folded.people?.[id]?.touches?.[touch];
  if (!x?.stage_released?.unattended && !attendedOf(slug, id, touch, rec) && !olderOf(rec, id, touch))
    return `${id} follow-up ${touch - 1} wasn't let into your drafts by an unattended run: nothing to clear (and no draft of it tried in a session with you there is without a receipt, and no draft of an older text of it is recorded).`;
  if (x?.staged) return `${id} follow-up ${touch - 1}'s draft went in (your mail tool gave its id): if you deleted it, it stays done; approve a new message to write to them again.`;
  if (x?.sent) return `${id} follow-up ${touch - 1} is recorded as sent: nothing to clear.`;
  return null;
}
// A draft of an older text of this step held as in the drafts folder (lib/unattended-drafts.mjs olderDraftOf), or null.
function olderOf(rec, id, touch) {
  return olderDraftOf(rec.entries, id, touch, rec.folded.people?.[id]?.touches?.[touch]?.hash ?? null);
}
// An attended draft of this step, for any of its texts, with no receipt and not cleared since, or null.
function attendedOf(slug, id, touch, rec) {
  try {
    return attendedDraftIn(join(home(), 'events', slug), id, touch, rec.entries);
  } catch {
    return null;
  }
}
// The prompt: the user, with the person and the step named, says it isn't there. The ledger line (stage_cleared) is
// written only by the PostToolUse hook for this same call, once it ran after they allowed it (afterBash).
function draftMissingAsk(words, input, { session, nowMs }) {
  const slug = String(flagOf(words, '--event') ?? '');
  const id = String(flagOf(words, '--id') ?? '');
  const touch = Number(flagOf(words, '--touch'));
  const said = String(flagOf(words, '--said') ?? '').trim();
  if (!SLUG.test(slug) || notRealEvent(slug) || !PID.test(id) || !Number.isInteger(touch) || touch < 2)
    return { refuse: 'draft-missing needs --event <the slug of a real event of yours> --id <person id> --touch <the step, 2 or more> --said "<the user\'s own words>".' };
  if (said.length < 3) return { refuse: "draft-missing needs --said with the user's own words (they looked in their drafts folder)." };
  const why = draftMissingWhy(slug, id, touch);
  if (why) return { refuse: why };
  let ev = {};
  let p = null;
  let attended = false;
  let older = null;
  try {
    ev = loadEvent(slug).event || {};
    const rec = eventRecord(join(home(), 'events', slug));
    p = rec.folded.people?.[id] || null;
    attended = !p?.touches?.[touch]?.stage_released?.unattended && !!attendedOf(slug, id, touch, rec);
    older = !p?.touches?.[touch]?.stage_released?.unattended && !attended ? olderOf(rec, id, touch) : null;
  } catch {
    /* named by id only */
  }
  const to = p?.touches?.[touch]?.approved?.to || null;
  const how = attended
    ? 'In a session with you there, a draft of it was tried (for its text now or an earlier one), and floorboss has no receipt for it.'
    : older
      ? `A draft of its text before you changed it went into your drafts folder${older.draft_id ? ` (draft ${draftIdText(older.draft_id)})` : ''}${older.count > 1 ? `, and ${older.count - 1} more before that` : ''}. Allow this only once you deleted ${older.count > 1 ? 'them' : 'it'}.`
      : 'An unattended run let it through, but floorboss never heard that it went in (the call failed, or its result never came back).';
  const reason = `floorboss: you say the draft of follow-up ${touch - 1} to ${promptPerson(p?.name || id, id, to)} at ${promptLine(ev.name || slug)} isn't in your drafts folder. ${how} If you allow this, that follow-up can go into your drafts once more: on its own, but not on the day the first draft was let through (and only on its due day or the day after), or with you there.\n\nYour words: ${promptLine(said)}\n\nAllow only if you looked in your drafts folder and it isn't there.`;
  writePrivate([], 'draft-missing-pending.json', {
    event: slug,
    id,
    touch,
    said: said.slice(0, 200),
    call: String(input?.tool_use_id || ''),
    session,
    tool: 'Bash',
    command: sha256(String(input?.tool_input?.command || '')),
    at: new Date(nowMs).toISOString()
  });
  return { ask: reason };
}

// The model's judgement of the CRM activity the guard listed and that didn't come from the contact: hold, or go with
// the already-approved text. Recorded for this run's session, for that person, against the latest CRM witness: every
// activity named must be one the witness listed as "other", the choice is "hold" or "go", and the reason is one short
// line. A "go" on an activity whose own text speaks to floorboss or Claude is recorded as a hold: CRM text is data.
function judge(words, { session, nowMs }) {
  const slug = String(flagOf(words, '--event') ?? '');
  const id = String(flagOf(words, '--id') ?? '');
  if (!SLUG.test(slug) || !PID.test(id)) return { refuse: 'crm-judge needs --event <slug> --id <person id> --file <judgements>.' };
  const w = readWitness(session, slug, id, 'crm');
  if (!w?.readable) return { refuse: `there is no CRM read of ${id} in this run to judge.` };
  let data;
  try {
    data = JSON.parse(readChecked(allowedPath(String(flagOf(words, '--file') ?? '')), 256 * 1024));
  } catch {
    return { refuse: 'crm-judge needs --file with {"judgements":[{"activity_id","decision","reason"}]}, in floorboss\'s data folder or the temp folder.' };
  }
  const list = Array.isArray(data?.judgements) ? data.judgements : null;
  if (!list || !list.length) return { refuse: 'the judgements file holds no judgements.' };
  const others = new Map((w.activities || []).filter((a) => a.kind === 'other').map((a) => [a.aid, a]));
  const was = readWitness(session, slug, id, 'judged') || { judgements: {} };
  const out = { ...was.judgements };
  const lines = [];
  for (const j of list) {
    const aid = String(j?.activity_id ?? '');
    const a = others.get(aid);
    if (!a) return { refuse: `activity ${oneLine(aid, 40)} isn't one floorboss listed for judgement in this run (only activities that didn't come from ${id}).` };
    if (!['hold', 'go'].includes(j?.decision)) return { refuse: 'a judgement is "hold" or "go", nothing else.' };
    // A hold, once recorded, stays for the run: only the user lets it go.
    if (was.judgements?.[aid]?.decision === 'hold' && j.decision !== 'hold') return { refuse: `activity ${oneLine(aid, 40)} was judged hold earlier in this run, and a hold stays for the run: only you can let it go.` };
    const reason = oneLine(j?.reason, 400);
    if (reason.length < 3 || reason.length > 200 || /[\r\n]/.test(String(j?.reason ?? ''))) return { refuse: 'each judgement needs a one-line reason, at most 200 characters.' };
    const forced = j.decision === 'go' && a.steers;
    const decision = forced ? 'hold' : j.decision;
    const why = !forced
      ? reason
      : a.steered_by?.line
        ? `held by floorboss: ${oneLine(a.steered_by.line, 160)}, so no go is taken from this answer (the model said go: ${reason})`
        : `held by floorboss: the activity's own text speaks to floorboss or Claude, so it can't be a reason to go (the model said go: ${reason})`;
    out[aid] = { decision, reason: oneLine(why, 400), ...(forced ? { forced: true } : {}), at: new Date(nowMs).toISOString() };
    lines.push({ aid, a, decision, reason: why });
  }
  writeWitness(session, slug, id, 'judged', { v: 1, session, event: slug, id, at: new Date(nowMs).toISOString(), judgements: out });
  for (const l of lines)
    logLine('judged', {
      session,
      event: slug,
      id,
      activity: activityLine(l.a),
      decision: l.decision,
      reason: l.reason
    });
  return { ok: true };
}

// ---------- PostToolUse for Bash: the opt-in and the authorisation, written only after their call ran ----------
export function afterBash(input, nowMs = Date.now()) {
  const out = {};
  const command = sha256(String(input?.tool_input?.command || ''));
  const said = responseText(input?.tool_response);
  {
    const p = readPrivate(pendingFile('optin'), null);
    if (p && sameCallOf(p, input)) {
      if (p.command === command && recentMs(p.at, nowMs, 10 * 60000) && said.includes(`FLOORBOSS-OPTIN-OK:${p.event}`)) {
        let ev = {};
        try {
          ev = loadEvent(p.event).event;
        } catch {
          ev = {};
        }
        writePrivate(['optin'], `${p.event}.json`, {
          v: 1,
          event: p.event,
          name: oneLine(ev.name || p.event, 120),
          mode: 'drafts',
          sentence: DRAFTS_SENTENCE,
          said: p.said,
          reason_sha: p.reason_sha,
          end_date: ev.end_date || ev.start_date || null,
          zone: ev.time_zone || null,
          expires: p.expires,
          at: new Date(nowMs).toISOString(),
          session: p.session
        });
        logLine('optin_on', { event: p.event, until: p.expires });
        out.optin = p.event;
      }
      try {
        unlinkSync(pendingFile('optin'));
      } catch {
        /* gone */
      }
    }
  }
  {
    const p = readPrivate(pendingFile('authorise'), null);
    if (p && sameCallOf(p, input)) {
      if (p.command === command && recentMs(p.at, nowMs, 10 * 60000) && said.includes(`FLOORBOSS-AUTHORISE-OK:${p.event}`)) {
        // Written only if the list is still the one the prompt showed.
        const config = readPrivate(join(home(), 'config.json'), {});
        const settings = settingsOf(p.event, config);
        const items = settings ? authorisable(p.event, { config, settings, nowMs }).items.filter((x) => (p.keys || []).includes(`${x.id}:${x.touch}:${x.hash}`)) : [];
        if (items.length && listHash(items) === p.list) {
          for (const x of items)
            appendLine(
              authorisedFile(),
              JSON.stringify({
                v: 1,
                at: new Date(nowMs).toISOString(),
                event: x.event,
                id: x.id,
                touch: x.touch,
                hash: x.hash,
                to: x.to,
                thread_id: x.thread_id,
                thread_from: x.thread_from,
                recipe_fp: x.recipe_fp,
                read_fp: x.read_fp,
                crm_id: x.crm_id ?? null,
                due_day: x.due_day,
                gap_key: x.gap_key ?? null,
                list: p.list,
                session: p.session
              })
            );
          logLine('authorised', { event: p.event, follow_ups: items.length, people: new Set(items.map((x) => x.id)).size });
          out.authorised = items.length;
        } else logLine('authorise_dropped', { event: p.event, why: 'the list changed between the prompt and the call' });
      }
      try {
        unlinkSync(pendingFile('authorise'));
      } catch {
        /* gone */
      }
    }
  }
  {
    // draft-missing: the step the prompt named, cleared once, only if it still can be.
    const p = readPrivate(pendingFile('draft-missing'), null);
    if (p && sameCallOf(p, input)) {
      if (
        p.command === command &&
        recentMs(p.at, nowMs, 10 * 60000) &&
        SLUG.test(String(p.event)) &&
        PID.test(String(p.id)) &&
        Number.isInteger(p.touch) &&
        said.includes(`FLOORBOSS-DRAFT-MISSING-OK:${p.event}:${p.id}:${p.touch}`) &&
        !draftMissingWhy(p.event, p.id, p.touch)
      ) {
        appendLedger(join(home(), 'events', p.event, 'ledger.jsonl'), { type: 'stage_cleared', who: 'user', id: p.id, touch: p.touch, said: oneLine(p.said, 200) }, new Date(nowMs));
        logLine('draft_missing', { event: p.event, id: p.id, touch: p.touch });
        out.cleared = `${p.id}:${p.touch}`;
      }
      try {
        unlinkSync(pendingFile('draft-missing'));
      } catch {
        /* gone */
      }
    }
  }
  return out;
}

// ---------- MCP calls in a ticketed run ----------
const recipeTasks = (config, server, tool) =>
  Object.entries(config?.connectors || {})
    .filter(([, r]) => r && bareToolName(r.tool) === tool && (!r.server || sameServer(server, r.server)))
    .map(([t]) => t);
// The recipes an unattended run's call is held to, and which mailbox witness a mailbox read makes. With a Gmail-like
// mailbox reader (lib/unattended-drafts.mjs gmailReads), its two tools are held to the two fixed reads, and nothing
// else saved for them counts in a run: get_thread is the thread witness ("mail"), search_threads the from-them
// witness ("mailfrom"). Anything else: the saved recipes, and the one mailbox witness ("mail").
function runRecipes(config, server, tool) {
  const g = gmailReads(config);
  const fixed = g && [g.thread, g.from].find((b) => b.tool === tool && sameServer(server, b.server));
  if (!fixed) return { cfg: config, mailKind: 'mail' };
  const connectors = Object.fromEntries(Object.entries(config?.connectors || {}).filter(([, r]) => !(r && bareToolName(r.tool) === tool && (!r.server || sameServer(server, r.server)))));
  return { cfg: { ...config, connectors: { ...connectors, 'email.messages': fixed } }, mailKind: fixed === g.from ? 'mailfrom' : 'mail' };
}
const SEEN_WHAT = {
  mail: (w) => `${w.inbound} message${w.inbound === 1 ? '' : 's'} in from them or someone else in your mailbox`,
  mailfrom: (w) =>
    w.inbound > 0
      ? `${w.inbound} conversation${w.inbound === 1 ? '' : 's'} in your mailbox with something from them`
      : w.others > 0
        ? `${w.others} conversation${w.others === 1 ? '' : 's'} with them in your mailbox where someone else wrote`
        : 'an email you wrote to them yourself, since floorboss\'s last one',
  crm: (w) => `${w.from_contact} thing${w.from_contact === 1 ? '' : 's'} from them in your CRM`
};
// The values a call carries at one of its recipe's placeholders.
function valuesAt(input, recipe, ph) {
  const template = new Map();
  for (const [p, v] of leaves(recipe?.args || {})) template.set(p, [...(template.get(p) || []), v]);
  return leaves(input?.tool_input || {})
    .filter(([p]) => (template.get(p) || []).includes(ph))
    .map(([, v]) => String(v ?? '').trim());
}
// Why the draft call's address and thread (or reply-to) ids aren't exactly the listed ones, letter for letter, or why a
// placeholder of the recipe isn't given exactly as many times as the recipe has it (one address: never the same one
// twice), or null. check() trims and folds case, which is right for finding the listed item; what goes into the mailbox
// with nobody there is held to the letter. (Its subject and body are compared as check() compares them.)
function exactDraftWhy(input, recipe, it) {
  const want = { '{to}': it.to, '{reply_in_thread}': it.reply_in_thread, '{thread_id}': it.reply_in_thread, '{reply_to_message_id}': it.reply_to_message_id, '{subject}': null, '{body}': null };
  const template = leaves(recipe?.args || {});
  const call = leaves(input?.tool_input || {});
  for (const [ph, value] of Object.entries(want)) {
    const paths = template.filter(([, v]) => v === ph).map(([p]) => p);
    if (!paths.length) continue;
    const got = call.filter(([p]) => paths.includes(p));
    const name = ph.slice(1, -1);
    if (got.length !== paths.length) return `"${name}" is given ${got.length} time${got.length === 1 ? '' : 's'}, not ${paths.length}`;
    if (value != null && got.some(([, v]) => typeof v !== 'string' || v !== String(value))) return `its "${name}" isn't exactly the listed one, letter for letter`;
  }
  return null;
}
const canThread = (recipe) => leaves(recipe?.args || {}).some(([, v]) => v === '{reply_in_thread}' || v === '{thread_id}');
const repliesTo = (recipe) => leaves(recipe?.args || {}).some(([, v]) => v === '{reply_to_message_id}');
const PLACE = /\{[a-z_]+\}/;
// Every place in a value, its containers included, with what is there: "filter" -> object, "labelIds" -> list,
// "labelIds[]" -> value. leaves() sees only values, so a key whose value is an empty object or list is in no leaf.
// Iterative and capped like leaves(). The root itself has no path (null), so a top-level key "" is a place of its own.
function places(v) {
  const out = new Map();
  const stack = [[v, null, 0]];
  let n = 0;
  while (stack.length) {
    const [x, path, depth] = stack.pop();
    if (depth > 12) throw new Error('input nested too deep');
    if (++n > 4000) throw new Error('input too large');
    const kind = Array.isArray(x) ? 'list' : x && typeof x === 'object' ? 'object' : 'value';
    if (path !== null) out.set(path, new Set([...(out.get(path) || []), kind]));
    if (kind === 'list') x.forEach((y) => stack.push([y, `${path ?? ''}[]`, depth + 1]));
    else if (kind === 'object') for (const [k, y] of Object.entries(x)) stack.push([y, path === null ? k : `${path}.${k}`, depth + 1]);
  }
  return out;
}
// Why a call has a key the recipe has no place for (at any depth, an empty object or list included), or one where the
// recipe holds another kind of thing (a list for an object), or null.
export function extraPlaceWhy(input, recipe) {
  const want = places(recipe?.args || {});
  for (const [p, kinds] of places(input?.tool_input || {})) {
    const w = want.get(p);
    if (!w) return `"${oneLine(p, 60)}" isn't in floorboss's recipe`;
    for (const k of kinds) if (!w.has(k)) return `"${oneLine(p, 60)}" isn't the kind of value floorboss's recipe has there`;
  }
  return null;
}
// Why a read's arguments aren't exactly its recipe filled with these values, or null. Each leaf of the call must be a
// leaf of the recipe as filled (a placeholder by its value, a text with placeholders in it as that text filled, a
// literal as written), and each leaf of the recipe must be in the call: nothing added, left out or changed. A read the
// model narrowed (a later day, text after the day, another thread, a search of its own) could leave their answer out.
export function pinnedReadWhy(input, recipe, values) {
  // A key the recipe has no place for, even one holding an empty object or list (a filter, a folder list), could narrow
  // the read: refused before the values are compared.
  const extra = extraPlaceWhy(input, recipe);
  if (extra) return extra;
  const want = [];
  for (const [p, t] of leaves(recipe?.args || {})) {
    if (typeof t === 'string' && PLACE.test(t)) {
      let missing = null;
      const filled = t.replace(/\{([a-z_]+)\}/g, (m, k) => {
        if (values[k] == null || values[k] === '') {
          missing ??= k;
          return m;
        }
        return String(values[k]);
      });
      if (missing) return `its recipe needs {${missing}}, which an unattended run has no value for`;
      want.push([p, filled, true]);
    } else want.push([p, t, false]);
  }
  const left = [...want];
  for (const [p, v] of leaves(input?.tool_input || {})) {
    const i = left.findIndex(([q, w, filled]) => q === p && (filled ? (typeof v === 'string' || typeof v === 'number') && String(v) === w : v === w));
    if (i < 0) return `"${oneLine(p, 60)}" isn't as floorboss lists it`;
    left.splice(i, 1);
  }
  if (left.length) return `"${oneLine(left[0][0], 60)}" is left out`;
  return null;
}
// The ticket's items a read is for, and why not when it is for none: an item counts only when the call is its recipe
// filled exactly with that item's values (readValues), from the day before the email it answers (readSince).
function readItems(input, recipe, ticket, config) {
  const out = [];
  let why = null;
  const said = leaves(input?.tool_input || {}).map(([, v]) => fold(v));
  for (const it of ticket.items || []) {
    let folded;
    try {
      folded = eventRecord(join(home(), 'events', it.event)).folded;
    } catch {
      continue;
    }
    const s = readSince(folded.people?.[it.id], it.touch, it.to);
    const named = said.some((v) => v.includes(fold(it.to)) || (it.crm_id != null && v === fold(it.crm_id)) || (it.thread_id != null && v === fold(it.thread_id)));
    if (!s) {
      if (named) why ??= `floorboss has no send date for the message before ${it.id}'s follow-up`;
      continue;
    }
    const w = pinnedReadWhy(input, recipe, readValues(it, s, config));
    if (!w) out.push({ it, s });
    else if (named) why ??= `the read for ${it.id} isn't the one floorboss lists (${w}): it could miss their answer`;
  }
  return { items: out, why };
}

// The decision for an MCP call in a run with a token: { allow: reason } or { refuse: why }. Every refusal stops the run.
export function unattendedMcp(input, { config, run, nowMs, subagent }) {
  const session = String(input?.session_id || '');
  const un = unattendedSession(input, nowMs, subagent);
  const no = (why, extra) => {
    if (un.ok) stopHere(session, why, extra);
    return { refuse: why };
  };
  if (!un.ok) return { refuse: `this unattended run can't go on: ${un.why}. Nothing more happens in it.` };
  const st = stopped(session);
  if (st) return { refuse: `this unattended run stopped earlier (${oneLine(st.why, 160)}): nothing more happens in it.` };
  if (isOff()) return no('unattended runs are switched off');
  const m = /^mcp__(.+?)__(.+)$/.exec(String(input?.tool_name || ''));
  if (!m) return no('not a connected tool');
  const rr = runRecipes(config, m[1], m[2]);
  const tasks = recipeTasks(rr.cfg, m[1], m[2]);
  const staged = [];
  const why = check(input, { config: rr.cfg, stageItems: listed('stage-list.json', nowMs), active: run, staged, asks: [] });
  if (why) return no(why);
  if (tasks.includes('stage_draft') && staged[0]) {
    // Its post hook knows this call by Claude Code's id for it (the note below): with none, it isn't let through.
    if (!hasCallId(input)) return no(NO_CALL_ID);
    // check() compares values only: a key the recipe has no place for, holding an empty object or list, passes it.
    const extra = extraPlaceWhy(input, config.connectors.stage_draft);
    if (extra) return no(`the draft call isn't your saved draft tool's recipe: ${extra}`);
    return stageDecision(input, staged[0], { config, ticket: un.ticket, nowMs, session, no });
  }
  if (tasks.includes('email.messages') || tasks.includes('crm.activity')) {
    const kind = tasks.includes('email.messages') ? rr.mailKind : 'crm';
    const recipe = rr.cfg.connectors[kind === 'crm' ? 'crm.activity' : 'email.messages'];
    const { items, why: notThem } = readItems(input, recipe, un.ticket, config);
    if (!items.length) return no(notThem || `this ${kind === 'crm' ? 'CRM' : 'mailbox'} read isn't for anyone this run is for`);
    return { allow: `floorboss: an unattended run reads ${kind === 'crm' ? 'your CRM' : 'your mailbox'} for ${items.map(({ it }) => promptPerson(it.name, it.id, it.to)).join(', ')} before their draft. Nothing is written.` };
  }
  return no(`${m[2]} isn't one of the three calls an unattended run makes (the mailbox read, the CRM read and the draft)`);
}

// The one call that is allowed with nobody there: this draft, of an authorised follow-up of this run's ticket.
function stageDecision(input, it, { config, ticket, nowMs, session, no }) {
  const slug = it._event;
  const evDir = join(home(), 'events', slug);
  const touch = it.touch ?? 1;
  let name = it.name || null;
  if (!name)
    try {
      name = eventRecord(evDir).folded.people?.[it.id]?.name || it.id;
    } catch {
      name = it.id;
    }
  // retry: a hold for timing only (a read older than 90 seconds, outside the event's hours, a prompt that may be open
  // in a session with the user there): the launcher puts them on the next hour's ticket again. Any other hold keeps
  // them off the tickets for the rest of the day (scripts/scheduled.mjs followupsDue).
  // The last day this follow-up can go in on its own (the day after its due day, or the event's last day if that is
  // sooner), in the event's zone, noted with a timing hold: the summary says floorboss tries again only while a day is
  // left. null when floorboss can't work it out.
  const lastDay = () => {
    try {
      const ev = JSON.parse(readFileSync(join(evDir, 'event.json'), 'utf8'));
      const { entries, state } = eventRecord(evDir);
      const due = followupDueDay(evDir, settingsOf(slug, config), entries, state[it.id] || {}, { id: it.id, touch }, nowMs);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(due?.day || ''))) return null;
      const end = ev.end_date || ev.start_date || null;
      const last = addDays(due.day, 1);
      return end && end < last ? end : last;
    } catch {
      return null;
    }
  };
  const held = (why, { retry = false } = {}) => {
    try {
      logLine('held', { session, event: slug, id: it.id, touch, name, to: it.to, why, ...(retry ? { retry: true, last_day: lastDay() } : {}) });
    } catch {
      /* the refusal stands */
    }
    return no(`the draft to ${promptPerson(name, it.id, it.to)} can't go in on its own: ${why}`);
  };
  const o = optinFor(slug, nowMs);
  if (!o.ok) return held(o.why);
  // A draft let through earlier in this run whose result never came back may be in the drafts folder or not: the run
  // goes no further (the summary says so, and the user says whether it went in).
  const open = unclearDrafts(logEntries().filter((e) => e.session === session));
  // (Not a hold on this person: the run stops, and they are tried again at the next run.)
  if (open.length) return no(`the draft to ${oneLine(open[0].id, 12)} earlier in this run was let through but its result never came back, so it may or may not be in your drafts: nothing more goes in until you look`);
  const inst = readPrivate(followupsInstalledFile(), null);
  if (!inst) return held('the schedule is not installed (install-followups, from your terminal)');
  if (!PLUGIN_VERSION || inst.version !== PLUGIN_VERSION) return held('floorboss was updated since the schedule was installed: run install-followups again from your terminal');
  if (touch < 2) return held('only a follow-up goes in on its own, never a first message');
  const { entries, state, folded } = eventRecord(evDir);
  const x = folded.people?.[it.id]?.touches?.[touch];
  const hash = x?.approved?.hash && x.approved.hash === x.hash ? x.approved.hash : null;
  if (!hash) return held('it has no current approval');
  if (!(ticket.items || []).some((t) => t.event === slug && t.id === it.id && t.touch === touch && t.hash === hash)) return held("it isn't one of the follow-ups this run was started for");
  const d = readJsonStrict(join(evDir, 'drafts', `${hash}.json`), null);
  if (!d || approvalHash(d, x.approved.to) !== hash) return held('its saved text no longer matches the approval');
  if (d.channel !== 'email' || !/^[^@\s]+@[^@\s]+$/.test(String(it.to))) return held('only an email goes in on its own');
  const stage = config.connectors?.stage_draft;
  const read = config.connectors?.['email.messages'];
  // In the thread of your last email to them: a draft tool that takes the thread (threadId), or one that threads a
  // draft by the message it replies to (Gmail's replyToMessageId), with that email's own message id.
  if (!canThread(stage) && !repliesTo(stage)) return held("your draft tool can't put a draft in a thread, so it couldn't go in the same thread as your last message");
  if (!it.reply_in_thread) return held('it must go in the thread of your last message to them, and floorboss knows no such thread');
  if (canThread(stage)) {
    const threadArg = [...valuesAt(input, stage, '{reply_in_thread}'), ...valuesAt(input, stage, '{thread_id}')];
    if (!threadArg.length || threadArg.some((t) => t !== String(it.reply_in_thread))) return held('it must go in the thread of your last message to them, and this call names no such thread');
  }
  let replyTo = null;
  // The email this follow-up answers, and whether it was a floorboss draft you sent yourself (its send is known only
  // from your mailbox: Gmail may give the sent message a new id, and its day is the mailbox file's).
  const prevE = emailBefore(folded.people?.[it.id], touch, it.to);
  const handSent = handSentDraft(prevE?.x);
  if (repliesTo(stage)) {
    let want = messageIdOf(prevE?.x);
    // On Gmail, a draft you sent yourself is replied to as the guard's own read of your thread shows it: your latest
    // email there (the checks below hold it to one dated since the draft went in).
    if (handSent && gmailReads(config)) {
      const mw = readWitness(session, slug, it.id, 'mail');
      want = mw?.readable && fresh(mw, nowMs, WITNESS_MS) && mw.own_last?.id ? String(mw.own_last.id) : null;
      if (!want) return held(`floorboss's own read of your thread with them doesn't show the email you sent from its draft, so this follow-up can't go in reply to it: ${SEND_IT_YOURSELF}`);
      it = { ...it, reply_to_message_id: want };
    }
    if (!want) return held("floorboss has no message id for your last email to them (its send's answer didn't give one), so this draft couldn't go in reply to it");
    const got = valuesAt(input, stage, '{reply_to_message_id}');
    if (!got.length || got.some((v) => v !== want) || String(it.reply_to_message_id || '') !== want) return held('it must go in reply to your last email to them, and this call names another message or none');
    replyTo = want;
  }
  {
    const exact = exactDraftWhy(input, stage, it);
    if (exact) return no(`the draft call isn't exactly as floorboss listed it: ${exact}`);
  }
  const auth = authorisationFor({ event: slug, id: it.id, touch, hash, to: it.to }, { stageFp: recipeFp(stage), readFp: recipeFp(read), thread: it.reply_in_thread });
  if (!auth) return held("it isn't authorised as it is now (its text, address, thread or mail tool changed since you authorised it, or you never did)");
  const early = earlierStepWhy(evDir, entries, folded, { id: it.id, touch, to: it.to, thread: it.reply_in_thread });
  if (early) return held(early);
  if (!criticPassed(entries, it.id, touch, hash)) return held("the critic didn't pass this exact text");
  // A draft of this step for an older text that may still be in the drafts folder: never a second draft of one step.
  {
    const older = olderDraftOf(entries, it.id, touch, hash);
    if (older) return held(olderDraftWhy(older));
  }
  // A CRM connected that floorboss can't read for itself (Salesforce, Close): a reply logged there could never be seen.
  {
    const gap = crmUnreadableWhy(config);
    if (gap) return held(gap);
  }
  // What the guard read itself, in this run, in the last 90 seconds.
  const mail = readWitness(session, slug, it.id, 'mail');
  if (!mail || !fresh(mail, nowMs, WITNESS_MS)) return held(`the mailbox wasn't read for them by this run in the last ${WITNESS_MS / 1000} seconds`, { retry: true });
  if (!mail.readable) return held(`the mailbox answer couldn't be read (${oneLine(mail.why, 120)})`);
  if (mail.inbound > 0) return held(`${mail.inbound} message${mail.inbound === 1 ? '' : 's'} came in from them or someone else since your last message: read it before anything else goes`);
  // A Gmail-like mailbox: the message this draft replies to is one of yours that the guard's own read of the thread
  // showed (an id another writer recorded could put it in someone else's conversation): your latest own message in it,
  // dated at or after the search's start (shortly before the guard let that email through, else the day before it), so
  // an id of an older message filed for a later step never threads a draft. And the search for anything from or to
  // them, in any thread, must prove it covered the time since (hooks/guard/witness.mjs mailFromWitness).
  if (gmailReads(config)) {
    const since = readSince(folded.people?.[it.id], touch, it.to);
    if (replyTo && !(Array.isArray(mail.own_ids) ? mail.own_ids : []).map(String).includes(replyTo))
      return held(`the message this draft would reply to isn't one of yours that floorboss's own read of your thread with them showed, so it could go into another conversation: ${SEND_IT_YOURSELF}`);
    if (replyTo && (String(mail.own_last?.id ?? '') !== replyTo || !since || !(Date.parse(mail.own_last?.at) >= since.from_s * 1000)))
      return held(`the message this draft would reply to isn't your latest email in your thread with them since floorboss let your last one through, so it may not be the email this follow-up answers: ${SEND_IT_YOURSELF}`);
    const unsearchable = gmailSearchWhy(it.to);
    if (unsearchable) return held(unsearchable);
    const from = readWitness(session, slug, it.id, 'mailfrom');
    if (!from || !fresh(from, nowMs, WITNESS_MS)) return held(`your mailbox wasn't searched for anything from them by this run in the last ${WITNESS_MS / 1000} seconds`, { retry: true });
    if (!from.readable) return held(from.plain ? oneLine(from.why, 200) : `the search of your mailbox couldn't be read (${oneLine(from.why, 120)})`);
    // (A witness that doesn't say the search showed your own email is no clean read.)
    if (from.covered !== true) return held(SEARCH_UNPROVEN);
    // The search starts shortly before your last email when floorboss saw it go, else the day before it.
    const sinceWords = since?.exact ? 'your last message' : 'the day before your last message';
    if (from.inbound > 0) return held(`your mailbox shows ${from.inbound} conversation${from.inbound === 1 ? '' : 's'} with something from them since ${sinceWords}: read it before anything else goes`);
    if (from.others > 0) return held(`your mailbox shows ${from.others} conversation${from.others === 1 ? '' : 's'} with them where someone else wrote since ${sinceWords}: read it before anything else goes`);
    if (from.own_after > 0) return held(YOU_WROTE);
  }
  if (config.connectors?.['crm.activity']) {
    const crm = readWitness(session, slug, it.id, 'crm');
    if (!crm || !fresh(crm, nowMs, WITNESS_MS)) return held(`your CRM wasn't read for them by this run in the last ${WITNESS_MS / 1000} seconds`, { retry: true });
    if (!crm.readable) return held(`your CRM's answer couldn't be read (${oneLine(crm.why, 120)})`);
    if (crm.from_contact > 0) return held(`your CRM shows ${crm.from_contact} thing${crm.from_contact === 1 ? '' : 's'} from them since your last message (a reply, a message, a call, a meeting, an opt-out or a bounce, or something floorboss can't tell isn't from them)`);
    const judged = readWitness(session, slug, it.id, 'judged')?.judgements || {};
    for (const a of (crm.activities || []).filter((y) => y.kind === 'other')) {
      const j = judged[a.aid];
      if (!j) return held(`activity ${a.aid} in your CRM has no judgement recorded in this run`);
      if (j.decision !== 'go') return held(`your CRM shows ${activityLine(a)}, judged hold: ${oneLine(j.reason, 160)}`);
    }
  }
  // Anything this run saw come in from them (a reply in the mailbox, something from them in the CRM) holds them for
  // the rest of the run: a later read whose answer doesn't show it never reads it away.
  {
    const seen = readWitness(session, slug, it.id, 'seen');
    if (seen) return held(`earlier in this run floorboss saw ${oneLine(seen.what, 160)}: it waits for you`);
  }
  // An attended draft of this same step whose prompt may still be open (its call marked, its result not yet in), or one
  // that went in or failed (for any text of the step) with no receipt saved since: two drafts of one step never go in.
  try {
    const went = attendedDraftIn(evDir, it.id, touch, entries);
    if (went) return held(went.why);
    // (A mark it can't date waits for the user: no hour later changes it.)
    const open = attendedDraftOpen(evDir, it.id, touch, nowMs);
    if (open) return held(attendedOpenWhy(open), { retry: !!open.at });
  } catch (e) {
    if (e?.code !== 'ENOENT') return held(`floorboss couldn't read its own marks for this follow-up (${oneLine(e?.message, 80)})`);
  }
  let ev = {};
  try {
    ev = JSON.parse(readFileSync(join(evDir, 'event.json'), 'utf8'));
  } catch {
    return held("the event's file can't be read");
  }
  const hw = hoursWhy(ev.time_zone, nowMs);
  if (hw) return held(hw, { retry: true });
  const settings = settingsOf(slug, config);
  if (!settings) return held("the event's settings can't be read");
  const due = followupDueDay(evDir, settings, entries, state[it.id] || {}, { id: it.id, touch }, nowMs, d);
  if (due.why) return held(due.why);
  // The day the authorisation prompt showed binds: never earlier (a gap changed since moves nothing forward).
  if (auth.due_day && due.day < auth.due_day) return held(`its day moved since you authorised it (you allowed it for ${shortDay(auth.due_day)}, it's due ${shortDay(due.day)} now)`);
  {
    const gw = gapChangedWhy(auth, settings);
    if (gw) return held(gw);
  }
  // Authorised with no day yet, after a send floorboss knows only from your mailbox (a draft you sent yourself, a send
  // you reported): its day is what a mailbox file Claude wrote says. On Gmail the day counts from the later of that and
  // the day the guard's own read of your thread shows your email went; elsewhere it waits for you to authorise it with
  // its day shown.
  if (!auth.due_day && prevE?.x?.sent && !prevE.x.send_result) {
    if (!gmailReads(config)) return held(MAILBOX_ANCHOR_WHY);
    const mw = readWitness(session, slug, it.id, 'mail');
    const at = Date.parse(mw?.own_last?.at || '');
    if (!Number.isFinite(at)) return held(`floorboss's own read of your thread with them doesn't show when your last email went: ${SEND_IT_YOURSELF}`);
    const seen = todayKeyIn(ev.time_zone || 'UTC', new Date(at));
    const st0 = state[it.id] || {};
    if (seen > String(prevE.x.sent.date || '')) {
      const due2 = followupDueDay(evDir, settings, entries, { ...st0, sent: { ...(st0.sent || {}), [prevE.touch]: seen } }, { id: it.id, touch }, nowMs, d);
      if (due2.why) return held(due2.why);
      if (due2.day > due2.today) return held(`counted from ${shortDay(seen)}, when your mailbox shows your last email to them went, it's due ${shortDay(due2.day)}`, { retry: true });
    }
  }
  const ww = windowWhy({ due: due.day, today: due.today, end: ev.end_date || ev.start_date });
  if (ww) return held(ww);
  // Every check a send has (a stop, a reply, a bounce, one message a day, its day, slots gone, the address, the text),
  // with the reply check left to the witnesses above, and with email counted as on for this one check: a draft goes
  // to the user, who sends it. (What your other events lend about them, lib/sendcheck.mjs lentChanged, was checked
  // already, with every other check an attended draft has when it is staged: check() above refuses a listed item whose
  // hooks/guard/sends.mjs stageRefusal says why not, so it is not read twice here.)
  const v = verifySend(
    { id: it.id, touch, via: 'email.send', to: it.to, subject: it.subject || '', body: it.body },
    {
      evDir,
      settings: { ...settings, sending: { ...(settings.sending || {}), channels: [...new Set([...(settings.sending?.channels || []), 'email'])] } },
      state,
      entries,
      folded,
      nowMs,
      replyCheck: false,
      lent: false
    }
  );
  if (!v.ok) return held(v.why);
  // Every event's ledger, this one's included, for anything that makes them not this event's to write to now.
  const prevEmail = emailBefore(folded.people?.[it.id], touch, it.to)?.x;
  const since = Math.min(...[Date.parse(auth.at), Date.parse(prevEmail?.sent_at)].filter(Number.isFinite), Infinity);
  const other = crossEventWhy({ slug, id: it.id, to: it.to, since: Number.isFinite(since) ? since : 0, nowMs });
  if (other) return held(other);
  // The note its post hook reads (which follow-up this call is), written before anything is taken: a note for a call
  // that never runs is read by nobody.
  writePrivate(['witness', session], `stage-${sha256(callKey(input)).slice(0, 32)}.json`, { event: slug, id: it.id, touch, hash, to: it.to, name, thread: String(it.reply_in_thread), at: new Date(nowMs).toISOString() });
  const taken = takeOnceAndRelease({ evDir, slug, id: it.id, touch, hash, to: it.to, name, thread: String(it.reply_in_thread), entries, session, nowMs });
  if (taken) return held(taken.why, { retry: !!taken.retry });
  logLine('draft_allowed', { event: slug, id: it.id, touch, name, to: it.to, hash, thread: String(it.reply_in_thread), session });
  return { allow: `floorboss: an unattended run puts the authorised follow-up ${touch - 1} to ${promptPerson(name, it.id, it.to)} in your drafts folder, in your thread with them. Nothing is sent.` };
}

// The once mark, the day marker and the release, as one step, under the same locks a send takes (one per address the
// person has at this event, in one sorted order: hooks/guard/daymark.mjs sendLocks, lib/lock.mjs withLocks): a mark per
// step and text in the event's folder (wx: of two calls at once only one makes it, in any session or run); every event's
// ledger read again for a message to them today (lib/sendcheck.mjs addressBusyToday, which counts this release too once
// written); the person's day marker, as the send path takes it (never copied); then stage_released in the ledger,
// before the call runs, only while every lock is still this call's. Any refusal or throw gives back every mark this call
// took, so nothing is held as in the drafts that never went in. Returns null when all of it was taken, else { why,
// retry } (retry: another call held the lock, so the next run may try again).
// How old a send lock must be before it counts as left by a guard that died (hooks/guard.mjs SEND_LOCK_STALE_MS).
const SEND_LOCK_STALE_MS = 60 * 1000;
// Why this step can't be let through now, read from its ledger and marks as they are under the send locks, or null:
// its latest send release (send_released, not cleared or bounced since), a send recorded, a draft of it in your drafts
// (a receipt, or an unattended release not cleared since), or an attended draft of it whose call mark is there (its
// prompt may be open, or it ran with no receipt since).
function stepNowWhy(evDir, id, touch, nowMs) {
  const rec = eventRecord(evDir);
  const mine = rec.entries.filter((e) => e?.id === id && e.touch === touch && ['send_released', 'release_cleared', 'bounced'].includes(e.type));
  if (mine[mine.length - 1]?.type === 'send_released') return { why: 'a send of this same follow-up was let through a moment ago (it may have gone)' };
  const x = rec.folded?.people?.[id]?.touches?.[touch];
  if (x?.sent) return { why: 'it was already sent' };
  if (x?.staged) return { why: 'its draft is already in your drafts' };
  if (x?.stage_released) return { why: 'its draft already went into your drafts a moment ago' };
  const went = attendedDraftIn(evDir, id, touch, rec.entries);
  if (went) return { why: went.why };
  const open = attendedDraftOpen(evDir, id, touch, nowMs);
  if (open) return { why: attendedOpenWhy(open), retry: !!open.at };
  return null;
}
// The person's day marker an unattended draft of this step takes (hooks/guard/daymark.mjs): its path for today in the
// event's zone, the owner it is written with, and how many times a step's release was cleared since. Your word that the
// draft isn't in your drafts folder (stage_cleared) frees no day, so a draft of that step let through earlier today
// holds the day: it may go in again on a later day, never on the day the first one was let through. One rule for the
// guard (takeOnceAndRelease) and the launcher (dayTakenForDraft), so they can't drift.
export const DAY_TAKEN_WHY = 'another message to them already went or is going today (one a day)';
function draftDayMarker({ evDir, slug, id, touch, entries, nowMs }) {
  const day = eventDay(evDir, nowMs) || new Date(nowMs).toISOString().slice(0, 10);
  const cleared = (q) => dayResetsOf(eventRecord(join(home(), 'events', q.slug)).entries, q.id, q.touch);
  return { path: dayMarker(evDir, { id, touch }, day), owner: ownerOf(slug, { id, touch }, dayResetsOf(entries, id, touch)), cleared };
}
// Whether the guard would refuse an unattended draft of this step now for its day marker (read only).
export const dayTakenForDraft = (args) => {
  const m = draftDayMarker(args);
  return !markerFree(m.path, m.owner, m.cleared);
};
function takeOnceAndRelease({ evDir, slug, id, touch, hash, to, name, thread, entries, session, nowMs }) {
  const rdir = join(evDir, 'released');
  const resets = entries.filter((e) => e.id === id && e.touch === touch && RESETS.includes(e.type)).length;
  const took = [];
  // The once mark names how many times the user said this step's draft never went in (stage_cleared): each such word
  // lets it go in once more, never twice.
  const once = `ustage-${id}-${touch}-${hash}${resets ? `-${resets}` : ''}`;
  let why = null;
  try {
    why = withLocks(
      sendLocks(evDir, id, to),
      ({ owned }) => {
        if (!createOnceAt(rdir, once, new Date(nowMs).toISOString())) return { why: 'this draft already went in once on its own' };
        took.push(join(rdir, once));
        // This step read again under the locks: a send of it, or a draft of it, let through since the checks above (an
        // attended send waits on these same locks, and so does an attended draft's call mark) holds this one.
        const again = stepNowWhy(evDir, id, touch, nowMs);
        if (again) return again;
        // Read again under the locks: a send or an unattended draft to them at any event that got its release in first.
        const busy = addressBusyToday(evDir, to, nowMs, id);
        if (busy) return { why: `${busyWhy(busy, promptPerson(name, id), to)}. One message a day to one person, across all your events` };
        const m = draftDayMarker({ evDir, slug, id, touch, entries, nowMs });
        const got = takeMarker(m.path, m.owner, m.cleared);
        if (!got) return { why: DAY_TAKEN_WHY };
        took.push(got);
        // Every lock must still be this call's (lib/lock.mjs: a lock broken as stale under it is never given back).
        if (!owned()) return { why: 'another call to them was being checked at the same moment', retry: true };
        appendLine(join(evDir, 'ledger.jsonl'), JSON.stringify({ at: new Date(nowMs).toISOString(), type: 'stage_released', who: 'guard', id, touch, hash, to, thread_id: thread, unattended: true, run: session }));
        return null;
      },
      { staleMs: SEND_LOCK_STALE_MS }
    );
  } catch (e) {
    why = /^another floorboss process is busy with send-/.test(String(e?.message))
      ? { why: 'another call to them was being checked at this moment', retry: true }
      : { why: `floorboss couldn't record it (${oneLine(e?.message, 120)})` };
  }
  if (why) dropMarkers(took);
  return why;
}

// ---------- every event's ledger ----------
// What, in any event's ledger in this home, makes this person not this event's to write to now, or null. A person is
// their address across events. At any other event that has that address: anything that holds them there at all (a
// stop, a skip, a colleague holding them, a reply, a booking, a bounce, a damaged line: lib/ledger.mjs contactable), and
// anything done about them there since this follow-up's authorisation or the email it answers, whichever came first
// (an approval, a send or a release, a draft put in, a hold floorboss saw, a decision of yours). In this event, a hold
// floorboss saw since then (the rest of this event's ledger is verifySend's). Read from the ledgers only, never from an
// outbox page or any other rendered view. A ledger that can't be read holds.
const ELSEWHERE = { approved: 'a message to them was approved', send_released: 'a message to them went or is going', sent: 'a message to them went', stage_released: 'a draft to them went into your drafts', staged: 'a draft to them went into your drafts', hold_seen: 'floorboss saw a hold on them', decide: 'you made a decision about them', bounced: 'an email to them bounced' };
export function crossEventWhy({ slug, id, to, since, nowMs }) {
  const dir = join(home(), 'events');
  let slugs = [];
  try {
    slugs = readdirSync(dir).filter((x) => SLUG.test(x));
  } catch {
    return "floorboss couldn't read its events folder";
  }
  // Who they are at another event, by main's rule (lib/sendcheck.mjs personAddressKeys): any address this event has for
  // them alone, or an inbox address (info@, hello@: lib/normalize.mjs SHARED_INBOX) only with the same name; and, as
  // before, the address this draft goes to written the same way, unless it is an inbox address, which on its own says
  // nothing about who someone is.
  const key = fold(to);
  const inbox = addressKeys(to).some((k) => SHARED_INBOX.test(k));
  let mineKeys = [];
  try {
    mineKeys = personAddressKeys(join(dir, slug), id, to).filter((k) => !(SHARED_INBOX.test(k) && !k.startsWith('n:')));
  } catch {
    return `the ledger of ${slug} can't be read`;
  }
  for (const s of slugs) {
    if (s !== slug && notRealEvent(s)) continue;
    let rec;
    try {
      rec = eventRecord(join(dir, s));
    } catch {
      return `the ledger of ${s} can't be read`;
    }
    const mine = s === slug;
    const ids = mine
      ? [id]
      : Object.entries(rec.folded.people || {})
          .filter(([pid, p]) => {
            if (p.merged_into) return false;
            if (!inbox && [p.email_override, p.email].some((x) => x && fold(x) === key)) return true;
            const theirs = personAddressKeys(join(dir, s), pid, null);
            return theirs.some((k) => mineKeys.includes(k));
          })
          .map(([pid]) => pid);
    for (const pid of ids) {
      if (!mine) {
        const why = contactable(rec.folded, pid, 'message', eventDay(join(dir, s), nowMs));
        if (why) return `at your event ${s}, ${why}`;
      }
      const e = rec.entries.find((x) => x?.id === pid && Date.parse(x.at) > since && (mine ? x.type === 'hold_seen' : Object.hasOwn(ELSEWHERE, x.type)));
      if (e) return `${mine ? 'in this event' : `at your event ${s}`}, ${ELSEWHERE[e.type]} (${String(e.at).slice(0, 16).replace('T', ' ')} UTC) since you authorised this follow-up: it waits for you`;
    }
  }
  return null;
}
// Made only if it isn't there (wx): of two calls at once only one makes it. True when this call made it.
function createOnceAt(dir, name, text) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(dir, name), text, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}
const stageNote = (session, input) => join(unattendedDir(), 'witness', session, `stage-${sha256(callKey(input)).slice(0, 32)}.json`);

// ---------- PostToolUse for MCP calls in a ticketed run: the witnesses and the draft's result ----------
export function afterMcp(input, nowMs = Date.now()) {
  const session = String(input?.session_id || '');
  const un = unattendedSession(input, nowMs, false);
  if (!un.ok) return {};
  const config = readPrivate(join(home(), 'config.json'), {});
  const m = /^mcp__(.+?)__(.+)$/.exec(String(input?.tool_name || ''));
  if (!m) return {};
  const rr = runRecipes(config, m[1], m[2]);
  const tasks = recipeTasks(rr.cfg, m[1], m[2]);
  // The draft: the note its pre hook left for this call says which follow-up it was.
  if (tasks.includes('stage_draft')) {
    const note = readPrivate(stageNote(session, input), null);
    if (!note) return {};
    const r = rawValue(input?.tool_response);
    const v = r.ok ? r.value : null;
    const draftId = v ? v.id ?? v.draft_id ?? v.draftId ?? null : null;
    const thread = v ? v.message?.threadId ?? v.threadId ?? v.thread_id ?? v.conversationId ?? null : null;
    // (The claude.ai Gmail connector answers { id: the draft's id, messageId, threadId, viewUrl }.)
    const messageId = v ? v.message?.id ?? v.message_id ?? v.messageId ?? null : null;
    const base = { session, event: note.event, id: note.id, touch: note.touch, name: note.name, to: note.to };
    if (!r.ok || draftId == null || draftId === '') {
      const why = r.ok ? "the draft tool's answer names no draft" : r.why;
      logLine('draft_result', { ...base, ok: false, error: why });
      stopHere(session, `the draft to ${note.id} may or may not have gone in (${why})`);
      return { failed: true };
    }
    if (thread != null && String(thread) !== String(note.thread)) {
      logLine('draft_result', { ...base, ok: false, in_drafts: true, error: `it went into another thread (${oneLine(thread, 60)}) than your last message's (${oneLine(note.thread, 60)})` });
      stopHere(session, `the draft to ${note.id} went into another thread than the one listed`);
    } else logLine('draft_result', { ...base, ok: true, draft_id: oneLine(draftId, 120) });
    try {
      appendLine(
        join(home(), 'events', note.event, 'ledger.jsonl'),
        JSON.stringify({
          at: new Date(nowMs).toISOString(),
          type: 'staged',
          who: 'guard',
          id: note.id,
          touch: note.touch,
          draft_id: String(draftId).slice(0, 200),
          thread_id: String(thread ?? note.thread).slice(0, 200),
          ...(messageId != null ? { message_id: String(messageId).slice(0, 200) } : {}),
          tool: m[2],
          unattended: true,
          run: session
        })
      );
    } catch {
      /* its stage_released already holds the step as in the drafts */
    }
    return { staged: note.id };
  }
  for (const [task, kind] of [
    ['email.messages', rr.mailKind],
    ['crm.activity', 'crm']
  ]) {
    if (!tasks.includes(task)) continue;
    // Only the items this exact read was for (the pre hook let it through for them, and only for them).
    const { items } = readItems(input, rr.cfg.connectors[task], un.ticket, config);
    for (const { it, s } of items) {
      const evDir = join(home(), 'events', it.event);
      const { folded } = eventRecord(evDir);
      const settings = settingsOf(it.event, config);
      const p = folded.people?.[it.id];
      // floorboss's own emails to them, as a CRM logs them: the day each went and its approved subject.
      const ours = Object.values(p?.touches || {})
        .filter((x) => x?.sent && /^\d{4}-\d{2}-\d{2}$/.test(String(x.sent.date || '')))
        .map((x) => ({ day: x.sent.date, subject: String(readJsonStrict(join(evDir, 'drafts', `${x.sent.hash || x.approved?.hash || x.hash}.json`), null)?.subject || '') }));
      const w =
        kind === 'mail'
          ? mailWitness(input?.tool_response, { own: own(config, settings), sinceMs: s.ms, thread: !!gmailReads(config) && m[2] === 'get_thread' })
          : kind === 'mailfrom'
            ? // From the search's own start (after:), with your last email to them by its message id, and its thread.
              // (After a floorboss draft you sent yourself, your email as this run's own read of the thread showed it.)
              mailFromWitness(input?.tool_response, { own: own(config, settings), contact: it.to, sinceMs: s.from_s * 1000, ownId: searchOwnId(session, it, p), ownThread: it.thread_id })
            : crmWitness(input?.tool_response, { contact: it.to, own: own(config, settings), sinceMs: s.ms, ours });
      writeWitness(session, it.event, it.id, kind, { v: 1, kind, session, event: it.event, id: it.id, touch: it.touch, at: new Date(nowMs).toISOString(), since: s.day, ...w });
      // What came in stays seen for the rest of the run (stageDecision holds on it), whatever a later read shows.
      const came = kind === 'crm' ? w.from_contact > 0 : kind === 'mailfrom' ? w.inbound > 0 || w.others > 0 || w.own_after > 0 : w.inbound > 0;
      if (w.readable && came) createOnce(['witness', session], `${it.event}--${it.id}.seen.json`, { at: new Date(nowMs).toISOString(), what: SEEN_WHAT[kind](w) });
      logLine('read_witnessed', {
        session,
        kind,
        event: it.event,
        id: it.id,
        name: it.name,
        readable: !!w.readable,
        ...(w.readable
          ? kind === 'crm'
            ? { from_contact: w.from_contact, others: w.others, activities: (w.activities || []).slice(0, 20).map(activityLine) }
            : kind === 'mailfrom'
              ? { inbound: w.inbound, others: w.others, own_after: w.own_after, found_by: w.found_by }
              : { inbound: w.inbound }
          : { why: w.why })
      });
      if (!w.readable) {
        // A plain hold (the search didn't show your own email) is said as it is.
        const said = w.plain ? oneLine(w.why, 200) : `${kind === 'crm' ? 'your CRM' : 'your mailbox'} couldn't be read (${oneLine(w.why, 160)})`;
        logLine('held', { session, event: it.event, id: it.id, touch: it.touch, name: it.name, to: it.to, why: said });
        stopHere(session, w.plain ? `${it.id}: ${oneLine(w.why, 200)}` : `${kind === 'crm' ? 'the CRM' : 'the mailbox'} couldn't be read for ${it.id} (${oneLine(w.why, 120)})`);
      }
    }
  }
  return {};
}
// PostToolUseFailure for an MCP call in a ticketed run (the call failed, or was stopped, after the guard let it
// through): read as an answer with that error, so a read is unreadable (held, the run stops) and a draft is a failed
// result (it may or may not be in the drafts folder; the run stops).
export function afterMcpFailure(input, nowMs = Date.now()) {
  const error = oneLine(typeof input?.error === 'string' ? input.error : JSON.stringify(input?.error ?? 'the call failed'), 200) || 'the call failed';
  return afterMcp({ ...input, tool_response: { isError: true, content: [{ type: 'text', text: `${input?.is_interrupt ? 'stopped before it finished: ' : ''}${error}` }] } }, nowMs);
}
