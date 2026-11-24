// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Unattended email drafts: what the guard, the launcher (scripts/scheduled.mjs followups) and floorboss's scripts share.
// Everything lives under FLOORBOSS_HOME/unattended/, written by the guard's hooks and floorboss's scripts only
// (lib/paths.mjs recordFile keeps Claude's file tools out):
//   optin/<event>.json       the opt-in, written by the PostToolUse hook after the user allowed its prompt
//   authorised.jsonl         one line per authorised follow-up, written by the PostToolUse hook after its prompt
//   tickets/<session>.json   a run's ticket, written by the launcher; .bound by the SessionStart hook; .ended by the launcher
//   witness/<session>/…      what the guard read itself in a mailbox or CRM answer, and the model's CRM judgements
//   stopped/<session>.json   a run that stopped at its first refusal, failure or unexpected answer
//   running.lock             the launcher's own one-run-at-a-time file
//   log.jsonl, summary-<day>.md, summary-told, summary-seen.json, off
// Nothing here starts a process or reads the network.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readdirSync, existsSync, lstatSync, writeFileSync } from 'node:fs';
import { home, readChecked } from './paths.mjs';
import { writeText, readJson } from './jsonio.mjs';
import { unattendedDir, privateSub, privateDir, oneLine, logTail, logFile } from './unattended.mjs';
import { wallParts, todayKeyIn, addDays, parseDateKey, zonedToUtc, weekdayOf, MONTHS } from './tz.mjs';
import { eventRecord, followupDueDay, approvalHash, otherChannelsBefore, REPLY_CHECK_SECONDS, stepBefore } from './sendcheck.mjs';
import { touchBefore } from './route.mjs';
import { gapKey } from './spacing.mjs';
import { SESSION_LOCK_HOURS } from './runlock.mjs';

export const DRAFTS_SENTENCE = 'put my approved follow-ups in my drafts without asking me';
// A ticket binds to its session only within this long of the launcher writing it.
export const TICKET_BIND_MS = 15 * 60 * 1000;
// How long a scheduled run may last: the launcher stops Claude Code after this, and a ticket counts no longer.
export const RUN_LIMIT_MS = 40 * 60 * 1000;
// A witness counts this long (the same 90 seconds as an attended reply check).
export const WITNESS_MS = REPLY_CHECK_SECONDS * 1000;
// Weekdays, from 09:00 to 17:00 in the event's time zone.
export const DAY_FROM = 9;
export const DAY_TO = 17;

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PID = /^c\d+$/;
export const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const fold = (v) =>
  String(v ?? '')
    .trim()
    .replace(/[A-Z]/g, (c) => c.toLowerCase());

// ---------- where things are ----------
export const optinFile = (slug) => join(unattendedDir(), 'optin', `${slug}.json`);
export const authorisedFile = () => join(unattendedDir(), 'authorised.jsonl');
export const pendingFile = (kind) => join(unattendedDir(), `${kind}-pending.json`);
export const ticketFile = (session) => join(unattendedDir(), 'tickets', `${session}.json`);
export const boundFile = (session) => join(unattendedDir(), 'tickets', `${session}.bound`);
export const endedFile = (session) => join(unattendedDir(), 'tickets', `${session}.ended`);
export const witnessFile = (session, slug, id, kind) => join(unattendedDir(), 'witness', session, `${slug}--${id}.${kind}.json`);
export const stoppedFile = (session) => join(unattendedDir(), 'stopped', `${session}.json`);
export const runFile = () => join(unattendedDir(), 'running.lock');
export const summaryFile = (day) => join(unattendedDir(), `summary-${day}.md`);
export const seenFile = () => join(unattendedDir(), 'summary-seen.json');
export const toldFile = () => join(unattendedDir(), 'summary-told');

// A private JSON file of floorboss's own: a plain file read without following a link, or the fallback when it is
// missing or can't be read (never a guess at what a damaged file meant).
export function readPrivate(p, fallback = null) {
  try {
    return readJson(p, fallback);
  } catch {
    return fallback;
  }
}
// Written in a private folder (0700), as a private file (0600), never through a link.
export function writePrivate(sub, name, value) {
  const dir = sub.length ? privateSub(...sub) : privateDir();
  writeText(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
  return join(dir, name);
}
// Created only if it isn't there (wx): of two hooks at once only one makes it. True when this call made it.
export function createOnce(sub, name, value) {
  const dir = sub.length ? privateSub(...sub) : privateDir();
  try {
    writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}
export const present = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// ---------- the typed sentence and the fingerprints ----------
export const normSentence = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!]+$/, '');
const canon = (v) =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canon(v[k])])
        )
      : v;
// A saved recipe as one value: its server, tool, arguments and the tool listing it was bound to. Re-saving it (another
// server, another tool, other arguments) makes another fingerprint.
export const recipeFp = (recipe) =>
  recipe && typeof recipe === 'object' ? sha256(JSON.stringify(canon({ server: recipe.server ?? null, tool: recipe.tool ?? null, args: recipe.args ?? null, tool_hash: recipe.tool_hash ?? null }))).slice(0, 32) : null;

// ---------- the event's day and hours ----------
// The last moment of the event's last day, in its own zone (ms).
export function eventEndMs(event) {
  const end = event?.end_date || event?.start_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(end || '')) || !event?.time_zone) return null;
  try {
    return zonedToUtc({ ...parseDateKey(addDays(end, 1)), hh: 0, mm: 0 }, event.time_zone).getTime() - 1;
  } catch {
    return null;
  }
}
// Why now is outside unattended hours in this zone, or null: weekdays, 09:00 to 17:00.
export function hoursWhy(zone, nowMs) {
  let w;
  try {
    w = wallParts(new Date(nowMs), zone);
  } catch {
    return "the event's time zone can't be read";
  }
  const place = String(zone).split('/').pop().replace(/_/g, ' ');
  if (w.weekday === 'Sat' || w.weekday === 'Sun') return `it's the weekend in ${place}: drafts go in on weekdays only`;
  if (w.hh < DAY_FROM || w.hh >= DAY_TO) return `it's ${String(w.hh).padStart(2, '0')}:${String(w.mm).padStart(2, '0')} in ${place}: drafts go in from 09:00 to 17:00 only`;
  return null;
}
// (The follow-up job runs every hour of the day on the machine's clock, so every event's 09:00 to 17:00 meets eight of
// its runs on a weekday, whatever the two zones: nothing to warn about.)
// Whether today is Saturday or Sunday in the event's zone (drafts go in on their own Monday to Friday there only).
export const weekendIn = (zone, nowMs) => /weekend/.test(hoursWhy(zone, nowMs) || '');
export const shortDay = (key) => {
  try {
    const { m, d } = parseDateKey(key);
    return `${weekdayOf(key)} ${d} ${MONTHS[m - 1]}`;
  } catch {
    return String(key).slice(0, 10);
  }
};
// Why the follow-up isn't in its window today, or null: its due day or the day after, never after the event.
export function windowWhy({ due, today, end }) {
  if (!due) return 'it has no day yet';
  if (end && today > end) return 'the event is over';
  if (today < due) return `it isn't due until ${shortDay(due)}`;
  if (today > addDays(due, 1)) return `it was due ${shortDay(due)}, more than a day ago: it waits for you`;
  return null;
}

// ---------- the opt-in ----------
export function optinFor(slug, nowMs) {
  if (!SLUG.test(String(slug))) return { ok: false, why: 'not an event floorboss knows' };
  const o = readPrivate(optinFile(slug), null);
  if (!o) return { ok: false, why: "unattended drafts aren't turned on for this event" };
  if (o.v !== 1 || o.mode !== 'drafts' || o.event !== slug) return { ok: false, why: "this event's opt-in isn't one floorboss wrote" };
  const until = Date.parse(o.expires);
  if (!Number.isFinite(until) || nowMs > until) return { ok: false, why: 'its opt-in ended with the event' };
  return { ok: true, optin: o };
}
export function liveOptins(nowMs) {
  let names = [];
  try {
    names = readdirSync(join(unattendedDir(), 'optin')).filter((f) => /\.json$/.test(f));
  } catch {
    names = [];
  }
  return names
    .map((f) => f.replace(/\.json$/, ''))
    .filter((s) => SLUG.test(s))
    .map((slug) => ({ slug, ...optinFor(slug, nowMs) }))
    .filter((x) => x.ok);
}

// ---------- a CRM the guard can't read for itself ----------
// The CRMs whose logged activity has no reader in an unattended run: the guard reads two shapes of answer for itself
// (hooks/guard/witness.mjs: HubSpot-like and Pipedrive-like), and these answer in others. Known by a whole word in the
// name of a saved CRM recipe's server or tool.
// (Close only by its server's name: "close" in a tool's name, closeTask on another CRM, is no sign of it.)
const UNREAD_CRMS = Object.freeze([
  ['salesforce', 'Salesforce', true],
  ['sfdc', 'Salesforce', true],
  ['close', 'Close', false],
  ['closecrm', 'Close', false],
  ['closeio', 'Close', false]
]);
const nameWords = (v) =>
  String(v ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
// Why no follow-up of any event can go in on its own while this CRM is connected, or null: a CRM floorboss can't read
// in an unattended run is connected (a reader of its activity, or its lookup), or a CRM is connected with no saved
// reader of its logged activity (crm.activity: only a lookup, or a task tool), so a reply logged there could never be
// seen. Responses logged in the CRM are always checked: only with no CRM connected at all is the email check alone
// enough. With no CRM connected, or one the guard reads through its activity reader, null.
export function crmUnreadableWhy(config) {
  const conns = config?.connectors || {};
  for (const [task, r] of Object.entries(conns)) {
    if (!/^crm\./.test(task) || !r || typeof r !== 'object') continue;
    const full = /^mcp__(.+?)__(.+)$/.exec(String(r.tool ?? ''));
    const server = [...nameWords(r.server), ...nameWords(full?.[1])];
    const tool = nameWords(full ? full[2] : r.tool);
    const hit = UNREAD_CRMS.find(([w, , byTool]) => server.includes(w) || (byTool && tool.includes(w)));
    if (hit)
      return `your CRM (${hit[1]}) is connected, but floorboss can't read its logged activity on its own (only HubSpot's and Pipedrive's), so it can't check there for a reply: every draft for this event waits for you`;
  }
  const crm = Object.entries(conns).filter(([task, r]) => /^crm\./.test(task) && r && typeof r === 'object');
  if (crm.length && !crm.some(([task]) => task === 'crm.activity'))
    return "your CRM is connected, but floorboss has no reader for its logged activity (crm.activity), so it can't check there for a reply: every draft for this event waits for you. To fix it, connect your CRM's activity reader in /floorboss:event-setup";
  return null;
}

// ---------- the CRM id the guard reads a CRM answer by ----------
// The record id triage found for this person, or the one floorboss created: both files only floorboss's scripts write.
export function crmIdFor(evDir, folded, id) {
  const t = readPrivate(join(evDir, 'derived', 'compat', 'triage.json'), null);
  const v = t?.pre?.[id]?.crm?.crm_id || folded?.people?.[id]?.crm_id || null;
  return v == null ? null : String(v).slice(0, 120);
}

// ---------- the reviewed text and the earlier step ----------
// The critic passed exactly this text: the latest verdict on this hash is PASS. A skipped review or an approval past a
// FAIL is never enough with nobody there.
export function criticPassed(entries, id, touch, hash) {
  const last = entries.filter((e) => e?.type === 'critic' && e.id === id && (e.touch ?? 1) === touch && e.hash === hash).pop();
  return last?.verdict === 'PASS';
}
// A floorboss draft you sent yourself: the step was put in your drafts, and its send is known only from your mailbox
// (no send tool answered for it). Gmail may give the sent message a new id, and its day is a mailbox file's.
export const handSentDraft = (x) => !!(x?.sent && x.staged && !x.send_result);
// A follow-up authorised before it had a day, after a send floorboss knows only from your mailbox (outside Gmail, where
// no read of the guard's own can date it).
export const MAILBOX_ANCHOR_WHY =
  'you authorised it before it had a day, and the day your last email to them went is known only from your mailbox: authorise it again, with its day shown, for it to go on its own';
export const threadOf = (x) => (x?.staged?.thread_id || x?.sent?.thread_id ? String(x.staged?.thread_id || x.sent?.thread_id) : null);
// The message id of an email that went: the send tool's own answer as the guard read it, else its draft's as the guard
// read it (a draft the user sent from the mail app: a receipt's or a mailbox file's id is never used). For a draft tool
// that threads by the message it replies to (Gmail's replyToMessageId).
export const messageIdOf = (x) => (x?.sent?.message_id || x?.staged?.message_id ? String(x.sent?.message_id || x.staged?.message_id) : null);
// The email this follow-up answers: the latest earlier step that went by email to this address, in a thread floorboss
// knows. A step on LinkedIn or in the event app between them doesn't change it (section 9 of the design: those people
// still get their email follow-up; the morning page names them). { touch, thread, x } or null.
export function emailBefore(person, touch, to) {
  for (let t = touch - 1; t >= 1; t--) {
    const x = person?.touches?.[t];
    if (x?.sent && !x.skipped && x.approved?.to && fold(x.approved.to) === fold(to) && threadOf(x)) return { touch: t, thread: threadOf(x), x };
  }
  return null;
}
// The values a read's recipe is filled with in an unattended run, for one item of its ticket: the same for the flow
// that lists the call and the guard that holds the call to it. Nothing here comes from the model.
// s: readSince's answer (or, from older callers, its day alone).
export const readValues = (it, s, config) => {
  const since = typeof s === 'string' ? s : s?.day ?? null;
  return {
    email: it.to,
    since,
    // For Gmail's search: the moment the read starts, in epoch seconds (after:<seconds> is exact, where after:YYYY/MM/DD
    // is midnight in a zone Gmail picks). A plain number, so the read's recipe check holds it as any other value.
    ...(s && typeof s === 'object' && Number.isFinite(s.from_s) ? { since_epoch: String(s.from_s) } : {}),
    thread_id: it.thread_id ?? null,
    crm_id: it.crm_id ?? null,
    me: config?.own_email ?? null,
    name: it.name ?? null
  };
};
// The mailbox reads of an unattended run on the claude.ai Gmail connector (its saved mailbox reader is get_thread or
// search_threads, on a server whose name has the word "gmail"). Its search answers show at most five messages a
// thread, so one read can't show a whole mailbox; two fixed reads, each pinned exactly (hooks/guard/unattended.mjs), do:
// - thread: the whole thread of your last email to them (get_thread, metadata only: who wrote and when, no text).
//   It shows your own email (the proof the read covers the time since) and anyone's reply in it.
// - from: anything from them or to them, in any folder (Spam and Trash too: in:anywhere), since shortly before that
//   email (search_threads "in:anywhere {from:<them> to:<them>} after:<epoch seconds>", up to 50 threads, metadata
//   only: THREAD_VIEW_METADATA_ONLY, so no subject or snippet reaches the run's model; {a b} is Gmail's "a or b"). It catches them writing in a new thread, and it must show
//   your own email to them, the proof the search covered the time since (hooks/guard/witness.mjs mailFromWitness).
// Both on the saved reader's server. null for any other mailbox reader (its one saved recipe is the read), a tool of
// those names on a server that isn't Gmail's included.
const GMAIL_READ_TOOLS = ['get_thread', 'search_threads'];
export function gmailReads(config) {
  const r = config?.connectors?.['email.messages'];
  if (!r || typeof r !== 'object') return null;
  const full = /^mcp__(.+?)__(.+)$/.exec(String(r.tool ?? ''));
  const tool = full ? full[2] : String(r.tool ?? '');
  const server = r.server || full?.[1] || null;
  if (!server || !GMAIL_READ_TOOLS.includes(tool) || !nameWords(server).includes('gmail')) return null;
  return {
    thread: { server, tool: 'get_thread', args: { threadId: '{thread_id}', messageFormat: 'METADATA_ONLY' } },
    from: { server, tool: 'search_threads', args: { query: 'in:anywhere {from:{email} to:{email}} after:{since_epoch}', pageSize: 50, view: 'THREAD_VIEW_METADATA_ONLY' } }
  };
}
// Why Gmail's from: search can't be trusted to find this address, or null: an address with anything but plain ASCII
// letters, digits and . _ % + - (an accented or non-Latin domain, a quote, a space) may be stored in another form than
// floorboss has it, and a search that can't match it would read as "nothing from them".
export const gmailSearchWhy = (to) =>
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z0-9-]+$/.test(String(to || ''))
    ? null
    : "floorboss can't search Gmail for this address exactly as it is written (only plain letters, digits and . _ % + - are searched for sure), so it can't tell whether anything came in from them";
// How much earlier than floorboss's own record of the send Gmail's search starts: the Mac's clock and Gmail's may
// differ a little.
const SEARCH_SKEW_MS = 15 * 60 * 1000;
// Where the reads before a follow-up start, as the run's flow passes it ({since}) and as the guard holds the read to it:
// the day before the earliest moment floorboss knows for the email this follow-up answers (the guard letting it
// through, its draft going in, its receipt, the day the receipt names), as YYYY-MM-DD in UTC; and that day's start in
// ms, which the guard counts messages from. A receipt saved days late never moves the start past the send, and a
// mailbox that reads the day in a zone east of UTC (or west of it) still starts before the send. null: no send date.
// from_s (Gmail's search, in epoch seconds): 15 minutes before the guard let that email or its draft through, when it
// did and that time can be the send's (exact: true); else the start of that day. An email from them the day before
// yours is then no reply to it.
export function readSince(person, touch, to) {
  const b = touchBefore({ touches: person?.touches || {} }, touch);
  // No earlier message (every step before it was skipped): never the meeting confirmation's slot, touch 0.
  const x = emailBefore(person, touch, to)?.x || (b > 0 ? person?.touches?.[b] : null);
  // A first message after skipped steps: its replies are read from the day the last of them was skipped (the app's
  // answer), the day before in UTC as for a send.
  if (!x && b === 0) {
    const at = Object.entries(person?.touches || {})
      .filter(([k, y]) => Number(k) >= 1 && Number(k) < touch && y?.skipped)
      .map(([, y]) => Date.parse(y.app_result?.at || y.skipped_at || ''))
      .filter(Number.isFinite)
      .sort((p, q) => q - p)[0];
    if (!Number.isFinite(at)) return null;
    const day = new Date(at - 864e5).toISOString().slice(0, 10);
    const ms = Date.parse(`${day}T00:00:00Z`);
    return { day, ms, exact: false, from_s: Math.floor(ms / 1000) };
  }
  if (!x?.sent || !/^\d{4}-\d{2}-\d{2}$/.test(String(x.sent.date || ''))) return null;
  const times = [x.released_at, x.stage_released?.at, x.sent_at, `${x.sent.date}T00:00:00Z`].map((v) => Date.parse(v)).filter(Number.isFinite);
  const day = new Date(Math.min(...times) - 864e5).toISOString().slice(0, 10);
  const ms = Date.parse(`${day}T00:00:00Z`);
  // The guard's own times: before the send itself, unless the release was written again after the send (let in again
  // after draft-missing, or after sent_undone). So the earliest of them counts only when it is no later than the
  // send's record (sent_at, the receipt's time, which can be days after the send but never before it) and no later
  // than the end of the send's day (sent.date, the event's own day: in UTC with one day's slack).
  const seen = [x.released_at, x.stage_released?.at].map((v) => Date.parse(v)).filter(Number.isFinite);
  const first = seen.length ? Math.min(...seen) : NaN;
  const sentAt = Date.parse(x.sent_at);
  const dayEnd = Date.parse(`${x.sent.date}T00:00:00Z`) + 2 * 864e5;
  const exact = Number.isFinite(first) && first - SEARCH_SKEW_MS > ms && Number.isFinite(sentAt) && first <= sentAt && first < dayEnd;
  return { day, ms, exact, from_s: Math.floor((exact ? first - SEARCH_SKEW_MS : ms) / 1000) };
}
// Why the earlier email doesn't anchor an unattended draft, or null: the step before this one went, the latest earlier
// email went to the same address, in the thread this draft goes in, and through a floorboss prompt the user allowed: a
// send (send_released by the guard, not unattended) or a draft put in the mailbox after the batch prompt (the guard's
// stage-<id>-<touch>-<batch> mark). An email that was itself an unattended draft counts once the user sent it from
// their mail app (it is recorded as sent), and only when the email before it holds by the same rule: the chain always
// starts at a prompt.
export function earlierStepWhy(evDir, entries, folded, item, depth = 0) {
  const p = folded.people?.[item.id];
  if (!p) return 'floorboss has no record of this person';
  // A LinkedIn step before it that hasn't gone is passed over (lib/sendcheck.mjs stepBefore): the email it answers is
  // the last one that went.
  const before = stepBefore(evDir, entries, { touches: p.touches }, item.id, item.touch);
  // Every step before it was skipped: it goes as a first message would (lib/sendcheck.mjs), with no earlier email.
  if (before === 0) return null;
  if (!p.touches?.[before]?.sent) return "the message before it hasn't gone";
  const e = emailBefore(p, item.touch, item.to);
  if (!e) return 'no earlier email to this address went in a thread floorboss knows, so this draft could not go in the same thread';
  if (String(item.thread || '') !== e.thread) return "it isn't listed in the thread of your last email to them";
  const sentPrompted = entries.some((x) => x?.type === 'send_released' && x.id === item.id && (x.touch ?? 1) === e.touch && x.unattended !== true && fold(x.to) === fold(item.to));
  let stagedPrompted = false;
  try {
    stagedPrompted = !!e.x.staged && !e.x.staged.unattended && readdirSync(join(evDir, 'released')).some((f) => f.startsWith(`stage-${item.id}-${e.touch}-`));
  } catch {
    stagedPrompted = false;
  }
  if (sentPrompted || stagedPrompted) return null;
  if (e.x.stage_released?.unattended && depth < 8 && e.touch > 1) {
    const why = earlierStepWhy(evDir, entries, folded, { id: item.id, touch: e.touch, to: item.to, thread: e.thread }, depth + 1);
    return why ? `your last email to them was an unattended draft, and ${why}` : null;
  }
  return "your last email to them didn't go through a floorboss prompt you allowed (a send, or a draft put in your mailbox after you said yes)";
}

// An attended draft of this step, for any text of it, with no receipt saved for it: the guard's PostToolUse hook saw its
// call run (the batch's went-in mark stage-<id>-<touch>-<batch>, or the call mark's .done), or saw it fail after it was
// let through (the call mark's .failed, from the PostToolUseFailure hook). It may or may not be in the drafts folder,
// so it holds this step's unattended draft, keyed by person and step only (never by the text it was for), until a
// receipt (staged) or the user's word that it isn't there (outreach draft-missing: stage_cleared) is recorded at or
// after the mark (any one, for a mark floorboss can't date). { mark, failed, why } or null. entries: the event's
// ledger (read here when not given).
export const ATTENDED_UNSURE_WHY =
  "a draft of this same follow-up was tried in a session with you there and floorboss has no receipt for it, so it may or may not be in your drafts folder: if it's there, save its receipt (outreach staged); if it isn't, or you deleted it, tell floorboss it isn't there (outreach draft-missing). Nothing more goes in on its own for it until then";
export function attendedDraftIn(evDir, id, touch, entries = null) {
  let names = [];
  try {
    names = readdirSync(join(evDir, 'released'));
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
  const marks = names.filter((f) => f.startsWith(`stage-${id}-${touch}-`) || (f.startsWith(`stage-call-${id}-${touch}-`) && /\.(done|failed)$/.test(f)));
  if (!marks.length) return null;
  const list = entries || eventRecord(evDir).entries;
  for (const f of marks) {
    let at = NaN;
    try {
      at = Date.parse(String(readChecked(join(evDir, 'released', f), 200)).trim());
    } catch {
      at = NaN;
    }
    const settled = list.some((e) => (e?.type === 'staged' || e?.type === 'stage_cleared') && e.id === id && (e.touch ?? 1) === touch && (!Number.isFinite(at) || Date.parse(e.at) >= at));
    if (!settled) return { mark: f, failed: f.endsWith('.failed'), why: ATTENDED_UNSURE_WHY };
  }
  return null;
}
// A draft of this step for an older text, held as in your drafts folder: one an unattended run let through
// (stage_released) or whose receipt was saved (staged), and then a new text of the step was written (drafted, another
// hash). The ledger's stale_staged keeps only a receipt's; this reads the lines themselves, so a release with no receipt
// counts too. It stays until the user says it isn't in their drafts folder (outreach draft-missing: stage_cleared after
// it). { at, hash, draft_id, count } (the latest such draft, and how many there are) or null. hash: the text approved
// now.
export function olderDraftOf(entries, id, touch, hash) {
  let cur = null;
  let inbox = null;
  let older = [];
  for (const e of entries || []) {
    if (e?.id !== id || (e.touch ?? 1) !== touch) continue;
    if (e.type === 'drafted') {
      cur = e.hash ?? null;
      if (inbox && inbox.hash !== cur) {
        older.push(inbox);
        inbox = null;
      }
    } else if (e.type === 'stage_released') inbox = { at: e.at ?? null, hash: e.hash ?? cur, draft_id: inbox?.draft_id ?? null };
    else if (e.type === 'staged') inbox = { at: e.at ?? null, hash: inbox?.hash ?? cur, draft_id: e.draft_id ?? null };
    else if (e.type === 'stage_cleared') {
      // (draft-missing writes it only for a step with no receipt for its current text.)
      older = [];
      if (inbox && !inbox.draft_id) inbox = null;
    }
  }
  if (inbox && hash != null && inbox.hash !== hash) older.push(inbox);
  return older.length ? { ...older[older.length - 1], count: older.length } : null;
}
// A draft id as floorboss says it (it comes from the mail tool's answer): letters, digits, _ and - only.
export const draftIdText = (v) => String(v ?? '').replace(/[^\w-]/g, '').slice(0, 40) || 'with no id';
export const olderDraftWhy = (older) =>
  `${older?.count > 1 ? `${older.count} older drafts` : 'an older draft'} of this follow-up${older?.draft_id ? ` (${older.count > 1 ? 'the latest: ' : ''}draft ${draftIdText(older.draft_id)})` : ''}, for its text before you changed it, may be in your drafts folder: delete ${older?.count > 1 ? 'them' : 'it'}, then tell floorboss ${older?.count > 1 ? "they're" : "it's"} gone (outreach draft-missing). Nothing goes in on its own for this follow-up until then, so two drafts of it never sit in your drafts folder`;
// How long an attended draft call that Claude Code asked about, and that hasn't run, holds an unattended draft of the
// same step: its prompt can stay open as long as a session that ran floorboss keeps its limits, and the call still
// runs once it is allowed.
export const ATTENDED_OPEN_MS = SESSION_LOCK_HOURS * 3600 * 1000;
export const ATTENDED_OPEN_WHY = `a draft of this same follow-up was started in a session with you there, and Claude Code's prompt for it may still be open: it doesn't go in on its own for ${SESSION_LOCK_HOURS} hours from then (if you allowed that prompt, the draft is in your drafts folder)`;
// A call mark floorboss can't date holds until the user is there (no 12 hours count from a time it doesn't have).
export const ATTENDED_UNDATED_WHY = "a draft of this same follow-up was started in a session with you there, and floorboss found a mark it can't date: run floorboss once with you there";
// The reason for attendedDraftOpen's answer.
export const attendedOpenWhy = (open) => (open?.at ? ATTENDED_OPEN_WHY : ATTENDED_UNDATED_WHY);
// An attended draft call of this step whose prompt may still be open: its call mark (stage-call-<id>-<touch>-…, written
// when the guard asked) with no .done (the post hook writes it once the call ran), made under ATTENDED_OPEN_MS ago (a
// mark floorboss can't date counts). { at, mark } or null. The launcher waits for it and the guard holds on it, so a
// prompt allowed hours later never puts a second draft of the step in.
export function attendedDraftOpen(evDir, id, touch, nowMs) {
  let names = [];
  try {
    names = readdirSync(join(evDir, 'released'));
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
  for (const f of names) {
    // (A call that ran, or that failed after it was let through, is no prompt still open: attendedDraftIn holds those.)
    if (!f.startsWith(`stage-call-${id}-${touch}-`) || /\.(done|failed)$/.test(f) || names.includes(`${f}.done`) || names.includes(`${f}.failed`)) continue;
    let at = NaN;
    try {
      at = Date.parse(String(readChecked(join(evDir, 'released', f), 200)).trim());
    } catch {
      at = NaN;
    }
    if (!Number.isFinite(at) || nowMs - at < ATTENDED_OPEN_MS) return { at: Number.isFinite(at) ? new Date(at).toISOString() : null, mark: f };
  }
  return null;
}

// ---------- what may be authorised ----------
// Every approved email follow-up of this event that could go into the drafts on its own, as the authorisation prompt
// shows it and authorised.jsonl keeps it: the person, the step, the approved text, the day it is due, and what it is
// bound to (approval hash, address, thread, the recipes' fingerprints). Nothing is written.
export function authorisable(slug, { config, settings, nowMs }) {
  const evDir = join(home(), 'events', slug);
  const { entries, state, folded } = eventRecord(evDir);
  const stage = config?.connectors?.stage_draft || null;
  const read = config?.connectors?.['email.messages'] || null;
  const items = [];
  const skipped = [];
  if (!stage) return { items, skipped, why: 'no stage_draft connection is saved: floorboss has nowhere to put a draft' };
  if (!read) return { items, skipped, why: 'no email.messages connection is saved: floorboss could not read the mailbox before a draft goes in' };
  const names = readPrivate(join(evDir, 'derived', 'contacts.json'), []);
  const nameOf = (id) => (Array.isArray(names) ? names.find((x) => x?.id === id)?.name : null) || folded.people?.[id]?.name || id;
  for (const [id, p] of Object.entries(folded.people || {})) {
    if (!PID.test(id) || p.merged_into || p.stopped || p.dropped || p.replied || p.booked) continue;
    for (const [tt, x] of Object.entries(p.touches || {})) {
      const touch = Number(tt);
      if (touch < 2 || x.sent || x.staged || x.stage_released || x.skipped || x.dropped || !x.approved?.hash || x.approved.hash !== x.hash) continue;
      const hash = x.approved.hash;
      const to = String(x.approved.to || '');
      const skip = (why) => skipped.push({ id, touch, name: nameOf(id), why });
      const d = readPrivate(join(evDir, 'drafts', `${hash}.json`), null);
      if (!d || approvalHash(d, to) !== hash) {
        skip('its saved text no longer matches the approval');
        continue;
      }
      if (d.channel !== 'email' || !/^[^@\s]+@[^@\s]+$/.test(to)) {
        skip('it is not an email');
        continue;
      }
      if (!criticPassed(entries, id, touch, hash)) {
        skip("the critic didn't pass this exact text (a skipped review or an approval past a fail never goes on its own)");
        continue;
      }
      // Every step before it was skipped: it is their first message (owner answer A1). Text written as a follow-up is
      // written again and approved again first; until then it is left out.
      if (touchBefore({ touches: p.touches }, touch) === 0) {
        const e = entries.filter((y) => y?.type === 'drafted' && y.id === id && (y.touch ?? 1) === touch && y.hash === hash).pop();
        const asFollowup = !!e && ((e.before_hashes && typeof e.before_hashes === 'object' && Object.values(e.before_hashes).some((v) => v != null)) || e.previous_hash != null);
        if (asFollowup) {
          skip('message 1 could not be delivered, so this is written again as a first message: it can go on its own once that is approved');
          continue;
        }
      }
      const st = state[id] || {};
      const due = followupDueDay(evDir, settings, entries, st, { id, touch }, nowMs, d);
      const prev = emailBefore(p, touch, to);
      // Once the step before it went, the guard's rule for the email it answers is known now: one it would refuse is
      // never offered (it could only stop every run it is on).
      const b0 = stepBefore(evDir, entries, { touches: p.touches }, id, touch, settings);
      if (b0 === 0 || p.touches?.[b0]?.sent) {
        const early = earlierStepWhy(evDir, entries, folded, { id, touch, to, thread: prev?.thread || null });
        if (early) {
          skip(early);
          continue;
        }
      }
      items.push({
        event: slug,
        id,
        touch,
        name: String(nameOf(id)).slice(0, 80),
        to,
        hash,
        subject: String(d.subject || ''),
        body: String(d.body || ''),
        due_day: due.day || p.touches?.[touch]?.planned_due || null,
        // The days between follow-ups the user authorised under: with no day to bind yet (due_day null), a gap changed
        // since would move the draft earlier, so the guard and the launcher hold it then (gapChangedWhy).
        gap_key: gapKey(settings),
        // Its day counts from a send known only from your mailbox, and no read of the guard's own can date it: an
        // authorisation given before it had a day doesn't cover it (offered again with the day shown).
        ...(prev?.x?.sent && !prev.x.send_result && !gmailReads(config) ? { anchor_from_mailbox: true } : {}),
        thread_id: prev?.thread || null,
        thread_from: prev?.touch || touchBefore({ touches: p.touches }, touch),
        recipe_fp: recipeFp(stage),
        read_fp: recipeFp(read),
        // The CRM record the run reads for them: bound here, so a record id written later never steers the read.
        crm_id: crmIdFor(evDir, folded, id),
        // A draft of this step for an older text that may still be in the drafts folder: the prompt names it (it holds
        // the step until the user says it's gone).
        older_draft: olderDraftOf(entries, id, touch, hash)
      });
    }
  }
  items.sort((a, b) => a.id.localeCompare(b.id) || a.touch - b.touch);
  return { items, skipped };
}
// The whole list as one value: the prompt is about exactly this list, and the post hook writes it only if it is still
// the same.
export const listHash = (items) =>
  sha256(JSON.stringify(items.map((x) => [x.event, x.id, x.touch, x.hash, fold(x.to), x.thread_id || null, x.thread_from, x.recipe_fp, x.read_fp, x.due_day || null, x.gap_key ?? null]))).slice(0, 32);
// An authorisation given with no day to show ("due on its day") binds the gap it was given under: a gap changed since
// (by anyone, at any step) holds the draft for the user, who may authorise it again under the new gap.
export const gapChangedWhy = (auth, settings) =>
  !auth.due_day && (auth.gap_key ?? null) !== gapKey(settings) ? 'the days between follow-ups changed since you authorised it, so it waits for you' : null;

export function authorisedLines() {
  // Read as a plain private file, line by line; a damaged line is no authorisation.
  return readLines(authorisedFile())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((x) => x && x.v === 1);
}
// The authorisation for this exact item, or null: the same event, person and step, the same approval hash, the same
// address, the same recipes, and the same thread (one known at authorisation must still be it; one not known yet must
// be the thread of the step before it now).
export function authorisationFor(item, { stageFp, readFp, thread }) {
  const hit = authorisedLines()
    .filter(
      (a) =>
        a.event === item.event &&
        a.id === item.id &&
        a.touch === item.touch &&
        a.hash === item.hash &&
        fold(a.to) === fold(item.to) &&
        a.recipe_fp === stageFp &&
        a.read_fp === readFp &&
        (a.thread_id ? String(a.thread_id) === String(thread || '') : !!thread)
    )
    .pop();
  return hit || null;
}

// ---------- tickets ----------
export function readTicket(session) {
  if (!SESSION_RE.test(String(session))) return null;
  const t = readPrivate(ticketFile(session), null);
  return t && t.v === 1 && t.session === session ? t : null;
}
// The SessionStart hook's binding: a fresh startup of the very session the launcher named, with its token, within 15
// minutes of the ticket, once. A resume, a compact or a fork never binds. Returns { ok, why }.
export function bindTicket({ session, token, source, nowMs }) {
  if (source !== 'startup') return { ok: false, why: `the session started as "${oneLine(source, 20)}", not a fresh startup` };
  const t = readTicket(session);
  if (!t) return { ok: false, why: 'no ticket for this session' };
  if (!token || sha256(token) !== t.token_sha256) return { ok: false, why: "the run's token doesn't match its ticket" };
  const at = Date.parse(t.at);
  if (!Number.isFinite(at) || nowMs - at > TICKET_BIND_MS || at - nowMs > 60000) return { ok: false, why: 'the ticket is older than 15 minutes' };
  if (present(endedFile(session))) return { ok: false, why: 'the ticket was used' };
  if (!createOnce(['tickets'], `${session}.bound`, { at: new Date(nowMs).toISOString(), source })) return { ok: false, why: 'the ticket was used' };
  return { ok: true, ticket: t };
}
// Whether this hook call is inside a ticketed run: the token in this Claude Code process's environment, the session's
// ticket, bound at its startup, not ended, not past the run's limit, and not a subagent. Returns { ok, why, ticket }.
export function ticketed({ session, token, subagent, nowMs }) {
  if (!token) return { ok: false, why: 'no run token' };
  if (subagent) return { ok: false, why: 'a subagent is never the scheduled run' };
  const t = readTicket(session);
  if (!t) return { ok: false, why: 'no ticket for this session' };
  if (sha256(token) !== t.token_sha256) return { ok: false, why: "the run's token doesn't match its ticket" };
  const bound = readPrivate(boundFile(session), null);
  if (!bound || bound.source !== 'startup') return { ok: false, why: 'the session was not bound to its ticket at a fresh startup' };
  if (present(endedFile(session))) return { ok: false, why: 'the run is over' };
  const at = Date.parse(t.at);
  if (!Number.isFinite(at) || nowMs - at > RUN_LIMIT_MS + 5 * 60000 || at - nowMs > 60000) return { ok: false, why: "the run is past its time limit" };
  return { ok: true, ticket: t };
}
// The ticket of the run a script is part of: the one whose token is in this process's environment. For floorboss's
// scripts, which can't see their session's id. Returns the ticket or null.
export function ticketByToken(token) {
  if (!token || !/^[0-9a-f]{64}$/.test(String(token))) return null;
  let names = [];
  try {
    names = readdirSync(join(unattendedDir(), 'tickets')).filter((f) => /\.json$/.test(f));
  } catch {
    return null;
  }
  const want = sha256(token);
  for (const f of names) {
    const t = readTicket(f.replace(/\.json$/, ''));
    if (t && t.token_sha256 === want) return t;
  }
  return null;
}
export const stopped = (session) => readPrivate(stoppedFile(session), null);
export function stopRun(session, why) {
  if (!SESSION_RE.test(String(session))) return false;
  return createOnce(['stopped'], `${session}.json`, { at: new Date().toISOString(), why: oneLine(why, 300) });
}

// ---------- witnesses ----------
export function readWitness(session, slug, id, kind) {
  if (!SESSION_RE.test(String(session)) || !SLUG.test(String(slug)) || !PID.test(String(id))) return null;
  return readPrivate(witnessFile(session, slug, id, kind), null);
}
export const fresh = (w, nowMs, ms = WITNESS_MS) => {
  const at = Date.parse(w?.at);
  return Number.isFinite(at) && nowMs - at < ms && at - nowMs <= 60000;
};
export function writeWitness(session, slug, id, kind, value) {
  return writePrivate(['witness', session], `${slug}--${id}.${kind}.json`, value);
}

// ---------- the log, read back ----------
// A plain file of this folder, line by line (never through a link, never a pipe or a device).
function readLines(path) {
  try {
    if (!lstatSync(path).isFile()) return [];
    return String(readChecked(path, 32 * 1024 * 1024))
      .split('\n')
      .filter((l) => l.trim());
  } catch {
    return [];
  }
}
export function logEntries() {
  return logTail(8 * 1024 * 1024)
    .lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((x) => x && typeof x === 'object' && typeof x.type === 'string');
}

// ---------- the day's summary, from the log only ----------
const localDay = (iso) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null;
};
// A time as the event's own clock shows it, with the place named ("10:00 Amsterdam time"): the hours rule is the
// event's, so the summary speaks in it. With no event to go by, in UTC, named.
const pad2 = (n) => String(n).padStart(2, '0');
function eventZone(slug) {
  if (!SLUG.test(String(slug || ''))) return null;
  try {
    return readJson(join(home(), 'events', slug, 'event.json'), null)?.time_zone || null;
  } catch {
    return null;
  }
}
// The event's own name, from its file, for the summary; null when it can't be read.
function eventName(slug) {
  if (!SLUG.test(String(slug || ''))) return null;
  try {
    return readJson(join(home(), 'events', slug, 'event.json'), null)?.name || null;
  } catch {
    return null;
  }
}
// Entries in groups of the same key, each group in log order, the groups in the order each first came.
function groupBy(list, key) {
  const m = new Map();
  for (const e of list) {
    const k = key(e);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(e);
  }
  return [...m.values()];
}
export function timeAt(iso, slug) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '--:--';
  const zone = eventZone(slug);
  if (zone)
    try {
      const w = wallParts(d, zone);
      return `${pad2(w.hh)}:${pad2(w.mm)} ${String(zone).split('/').pop().replace(/_/g, ' ')} time`;
    } catch {
      /* in UTC below */
    }
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}
const who = (e) => `"${oneLine(e.name || e.id, 60).replace(/["\\]/g, '')}" (${oneLine(e.id, 12)}${e.to ? `, ${oneLine(e.to, 120)}` : ''})`;
export const DISCLAIMER =
  "floorboss can't see replies on LinkedIn or in the event app in an unattended run. Check those inboxes regularly and tell floorboss or your CRM when one comes in.";
// Drafts the guard let through whose result it never heard (the call failed, was denied, or the run was stopped in
// between): they may or may not be in the drafts folder. From the log only.
const stepKey = (e) => `${e.session}:${e.event}:${e.id}:${e.touch}`;
export function unclearDrafts(entries) {
  const results = new Set(entries.filter((e) => e.type === 'draft_result').map(stepKey));
  return entries.filter((e) => e.type === 'draft_allowed' && !results.has(stepKey(e)));
}
// The plain summary of one day (the machine's own day), built from log.jsonl and nothing else (and each event's time
// zone, to say the times in).
export function buildSummary(entries, day) {
  const today = entries.filter((e) => localDay(e.at) === day);
  const runs = today.filter((e) => e.type === 'run_started');
  const done = today.filter((e) => e.type === 'draft_result' && e.ok === true);
  const failed = today.filter((e) => e.type === 'draft_result' && e.ok !== true);
  const unclear = unclearDrafts(entries).filter((e) => localDay(e.at) === day);
  const allHeld = today.filter((e) => e.type === 'held');
  // A finished case (they replied or booked) is said apart, as over: nothing in it is for the user to act on.
  const over = allHeld.filter((e) => e.final === true);
  const held = allHeld.filter((e) => e.final !== true);
  const waiting = today.filter((e) => e.type === 'waiting');
  const judged = today.filter((e) => e.type === 'judged');
  const reads = today.filter((e) => e.type === 'read_witnessed');
  const stops = today.filter((e) => e.type === 'run_stopped');
  const off = entries.filter((e) => e.type === 'unattended_off' || e.type === 'unattended_on').pop();
  const eventOf = (e) => e.event || today.find((x) => x.session && x.session === e.session && x.event)?.event || null;
  const t = (e) => timeAt(e.at, eventOf(e));
  const lines = [`# floorboss on its own, ${shortDay(day)} ${day.slice(0, 4)}`, ''];
  if (!runs.length && !allHeld.length && !waiting.length) lines.push('No unattended run today.', '');
  lines.push(`Put in your drafts folder: ${done.length}`);
  for (const e of done) {
    const mail = reads.filter((r) => r.kind === 'mail' && r.event === e.event && r.id === e.id && r.at <= e.at).pop();
    const crm = reads.filter((r) => r.kind === 'crm' && r.event === e.event && r.id === e.id && r.at <= e.at).pop();
    const notes = judged.filter((j) => j.event === e.event && j.id === e.id && j.at <= e.at);
    lines.push(
      `- ${t(e)} to ${who(e)}, follow-up ${Number(e.touch) - 1}, in your thread with them.${mail ? ` Mailbox read at ${t(mail)}: nothing from them since your last message.` : ''}${crm ? ` CRM read at ${t(crm)}${crm.others ? `: ${crm.others} other ${crm.others === 1 ? 'activity' : 'activities'}, judged below.` : ': nothing logged since your last message.'}` : ''}`
    );
    for (const j of notes) lines.push(`  - ${oneLine(j.decision, 5)}: ${oneLine(j.activity, 160)}. Reason given: ${oneLine(j.reason, 200)}`);
  }
  // How the user lets a draft that isn't there go in again: their word in a floorboss session, which runs
  // `outreach draft-missing`, and Claude Code asks them to confirm it, naming the person and the follow-up.
  const goAgain = (e) =>
    `If it isn't there, tell floorboss in a session ("${oneLine(e.name || e.id, 60).replace(/["\\]/g, '')}'s draft isn't in my drafts"): it runs outreach draft-missing, Claude Code asks you to confirm, and that follow-up can go in again, on its own, but not on the day the first draft was let through. If it is there, send it when you're ready.`;
  const untilThen = "Nothing else goes in for them until you say it isn't there, or floorboss sees it sent.";
  // The event, named and by its slug (a session that runs draft-missing for this line passes the slug as --event).
  const at = (e) => (SLUG.test(String(e.event || '')) ? ` at ${oneLine(eventName(e.event) || e.event, 80).replace(/["\\]/g, '')} (${e.event})` : '');
  if (unclear.length) {
    lines.push('', `May or may not be in your drafts folder: ${unclear.length}`);
    for (const e of unclear)
      lines.push(`- ${t(e)} ${who(e)}${at(e)}, follow-up ${Number(e.touch) - 1}: floorboss let the draft call through but never heard back from your mail tool. Look in your drafts folder. ${goAgain(e)} ${untilThen}`);
  }
  if (failed.length) {
    lines.push('', `Tried and failed: ${failed.length}`);
    for (const e of failed)
      lines.push(
        e.in_drafts === true
          ? `- ${t(e)} ${who(e)}${at(e)}${e.touch ? `, follow-up ${Number(e.touch) - 1}` : ''}: ${oneLine(e.error || 'the mail tool gave no clear answer', 200)}. It is in your drafts folder: check which conversation it is in before you send it.`
          : `- ${t(e)} ${who(e)}${at(e)}${e.touch ? `, follow-up ${Number(e.touch) - 1}` : ''}: ${oneLine(e.error || 'the mail tool gave no clear answer', 200)}. Look in your drafts folder. ${goAgain(e)} ${untilThen}`
      );
  }
  // Each person, follow-up and reason once: a hold that came back at every hour's run is said once, with how many times
  // and when, and a hold for timing only says that floorboss tries again, unless that was the last day it could go in
  // on its own (last_day, which the guard notes with a timing hold, in the event's zone).
  const heldGroups = groupBy(held, (e) => `${e.event}:${e.id}:${e.touch}:${oneLine(e.why, 240)}`);
  const lastDayWas = (e) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.last_day || ''))) return false;
    try {
      return todayKeyIn(eventZone(e.event) || 'UTC', new Date(e.at)) >= e.last_day;
    } catch {
      return false;
    }
  };
  lines.push('', `Held for you: ${heldGroups.length}`);
  for (const g of heldGroups) {
    const e = g[g.length - 1];
    const times = g.length > 1 ? ` (held ${g.length} times today, ${t(g[0])} to ${t(e)})` : '';
    lines.push(`- ${who(e)}${e.touch ? `, follow-up ${Number(e.touch) - 1}` : ''}: ${oneLine(e.why, 240)}${times}.${e.retry === true && !lastDayWas(e) ? ' floorboss tries again at a later hour.' : ''}`);
    for (const j of judged.filter((x) => x.event === e.event && x.id === e.id && x.at <= e.at && !done.some((d) => d.event === e.event && d.id === e.id && d.at >= x.at)))
      lines.push(`  - ${oneLine(j.decision, 5)}: ${oneLine(j.activity, 160)}. Reason given: ${oneLine(j.reason, 200)}`);
  }
  if (waiting.length) {
    lines.push('', `Due, but waiting: ${waiting.length}`);
    for (const e of waiting) lines.push(`- ${who(e)}${e.touch ? `, follow-up ${Number(e.touch) - 1}` : ''}: ${oneLine(e.why, 280)}.`);
  }
  if (over.length) {
    lines.push('', 'No more follow-ups go on their own for:');
    for (const e of over) lines.push(`- ${who(e)}: ${oneLine(e.why, 240)}.`);
  }
  if (stops.length) {
    lines.push('', 'A run stopped early:');
    for (const g of groupBy(stops, (e) => oneLine(e.why, 240))) {
      const e = g[g.length - 1];
      lines.push(`- ${t(g[0])}${g.length > 1 ? ` to ${t(e)} (${g.length} runs)` : ''}: ${oneLine(e.why, 240)}. Anything after it waits for the next run or for you.`);
    }
  }
  lines.push(
    '',
    off?.type === 'unattended_off' ? 'Turned off: yes. Nothing runs on its own until you turn it on again from your terminal.' : 'Turned off: no. To stop it: /floorboss:unattended off',
    '',
    'Nothing was sent. Each draft waits in your drafts folder until you read it and press Send.',
    DISCLAIMER,
    ''
  );
  return lines.join('\n');
}
export function writeSummary(day, entries = logEntries()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return writePrivate([], `summary-${day}.md`, buildSummary(entries, day));
}
export const dayOf = localDay;
// What happened on its own since the user last saw it: the log entries after the seen mark that a person should hear
// about (drafts in, held, a run stopped, a failure).
export function unseen(entries = logEntries(), mark = readPrivate(seenFile(), null)) {
  const after = Date.parse(mark?.at || 0) || 0;
  return entries.filter((e) => ['draft_result', 'draft_unclear', 'held', 'waiting', 'run_stopped'].includes(e.type) && Date.parse(e.at) > after);
}

// ---------- who the morning page names ----------
// People an unattended follow-up is due for today who were written to on LinkedIn or in the event app before it: the
// page names them, since floorboss can't read those inboxes in an unattended run.
// only(a): which authorised steps may be named (the morning page passes the launcher's own list for today).
export function otherChannelPeople(slug, { settings, nowMs, only = () => true }) {
  const evDir = join(home(), 'events', slug);
  const { entries, state, folded } = eventRecord(evDir);
  const out = [];
  for (const a of authorisedLines().filter((x) => x.event === slug)) {
    const p = folded.people?.[a.id];
    const x = p?.touches?.[a.touch];
    if (!p || !x || x.sent || x.staged || x.stage_released || p.stopped || p.replied || p.booked) continue;
    if (x.approved?.hash !== a.hash || !only(a)) continue;
    const due = followupDueDay(evDir, settings, entries, state[a.id] || {}, { id: a.id, touch: a.touch }, nowMs);
    const today = due.today || todayKeyIn(due.event?.time_zone || 'UTC', new Date(nowMs));
    if (windowWhy({ due: due.day, today, end: due.event?.end_date })) continue;
    // A weekend day in the event's zone: no draft goes in on its own today, so nobody is named for it.
    if (/weekend/.test(hoursWhy(due.event?.time_zone || 'UTC', nowMs) || '')) continue;
    const kinds = otherChannelsBefore(evDir, settings, p, a.id, a.touch);
    if (kinds.length && !out.some((o) => o.id === a.id)) out.push({ id: a.id, name: p.name || a.id, where: kinds });
  }
  return out;
}
