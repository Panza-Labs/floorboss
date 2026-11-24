// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The ledger: one append-only file per event (ledger.jsonl) that holds everything that happened and every
// decision anyone made. Every other file about an event is either an input the user gave (copied once), a
// draft's text (write-once, named by its hash), or derived from the ledger and safe to delete.
//
// Each line: { at, type, who, id?, touch?, why?, said?, ...payload }
//   who   user | floorboss | guard | mailbox | crm | calendar  (who caused it)
//   said  the user's own words, kept whenever who === 'user'
//
// fold(entries) turns the lines into one state object that the shortlist, the drafting list, the send list,
// the outbox and the guard all read. Nothing reads the lines in any other way.
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { emailBase, normPersonName, companyKey } from './normalize.mjs';
import { appendLine } from './jsonio.mjs';
import { movedNow } from './clock.mjs';

export const WHO = ['user', 'floorboss', 'guard', 'mailbox', 'crm', 'calendar'];

// What may be written, grouped by what it records. The payload keys are the ones fold() reads.
export const ENTRY_TYPES = {
  // people: who is on the list
  person: ['id', 'keys', 'name', 'company', 'email', 'lines'],
  person_merged: ['id', 'into', 'why'],
  channel: ['id', 'to'],
  note: ['id', 'text', 'known'],
  // The user asked for a note to the coworker who holds this person ("note <name>" at the shortlist).
  colleague_note: ['id'],
  // decisions: what the user settled
  mapping_confirmed: ['source', 'fingerprint'],
  decide: ['id', 'group', 'ref', 'because', 'seen_holds', 'answered_check', 'by_group'],
  keep: ['top', 'segments'],
  cap: ['company', 'value'],
  answered: ['ask', 'value'],
  // judgement: Claude's reading of the list
  // guess: the segment an unsure fit read (segment stays null), kept for when the user says to reach them.
  fit: ['id', 'segment', 'reason', 'score', 'unsure', 'guess', 'company_size'],
  // drafts and approvals
  drafted: [
    'id',
    'touch',
    'kind',
    'hash',
    'structure',
    'fact_source',
    'brief',
    'slot_ids',
    'planned_due',
    'planned_gap',
    'planned_from',
    'checks',
    'subject_preview',
    'booked_slot',
    'previous_hash',
    'before_hashes'
  ],
  critic: ['id', 'touch', 'hash', 'verdict', 'reasons'],
  batch_checked: ['touch', 'verdict', 'reasons'],
  // critic_override: the user approved by name a message the critic failed (a send reads it from here only).
  approved: ['id', 'touch', 'hash', 'to', 'via', 'where', 'critic_override'],
  dropped: ['id', 'touch', 'reason'],
  // A follow-up's planned day moved because the message before it was planned again (same text, same approval).
  replanned: ['id', 'touch', 'planned_due', 'planned_gap', 'planned_from'],
  // The user skipped this step of the route: the sequence goes on to the next one.
  step_skipped: ['id', 'touch', 'reason'],
  // The user chose other channels (reach_channels): an approved, unsent step whose place in the sequence changed is no
  // longer approved; it is written again for its new place, or not at all. A step that went is never touched.
  approval_withdrawn: ['id', 'touch', 'reason'],
  revise: ['id', 'touch', 'feedback', 'reason'],
  fresh_attempt: ['id', 'touch'],
  // The user's go-ahead to send a draft unreviewed: for that exact text (hash), so an edit goes to the critic.
  review_skipped: ['id', 'touch', 'hash', 'because'],
  // sends
  send_released: ['id', 'touch', 'hash', 'via', 'to', 'where'],
  sent: ['id', 'touch', 'via', 'date', 'message_id', 'thread_id', 'hash', 'channel', 'text', 'source', 'ext'],
  // A send the user recorded by mistake, taken back (record's "unsent"): that touch is unsent again.
  sent_undone: ['id', 'touch'],
  release_cleared: ['id', 'touch'],
  // A send the guard let through whose tool call failed or never answered: it may or may not have gone.
  send_unclear: ['id', 'touch', 'error'],
  // Auto-send (Codex, from the user's own ChatGPT cloud task: lib/autosend/): the user's second yes for one message,
  // bound to its text (hash) and address; the user's "stop auto-send" for a person; and the mark written (and pushed)
  // before the cloud run's send of a step, so it is never sent twice.
  autosend_approved: ['id', 'touch', 'hash', 'to', 'planned_due', 'digest'],
  autosend_revoked: ['id'],
  autosend_released: ['id', 'touch', 'hash', 'to', 'run'],
  // A release taken back by the run that made it, before the send step was ever shown to the model (the search went
  // stale, the hours closed, Claude Code's email sending came on): it never went, and the step stays due.
  autosend_withdrawn: ['id', 'touch', 'run'],
  // Auto-send through Gmail drafts (lib/autosend/drafts.mjs): a draft made, labelled and read back as approved (the
  // daily ChatGPT task sends it on its day), and a draft that couldn't be confirmed (the user was told to delete it).
  autosend_drafted: ['id', 'touch', 'hash', 'to', 'due', 'draft_id', 'message_id', 'thread_id', 'threaded', 'run'],
  autosend_draft_bad: ['id', 'touch', 'draft_id', 'why', 'run'],
  // A queued draft labelled floorboss/held-check after a stop on the laptop (a revoke, a reply, an opt-out, a booking).
  autosend_draft_held: ['id', 'touch', 'draft_id', 'run'],
  // A daily Claude routine's queued draft gone from Gmail after a stop on the laptop, as floorboss's guard read the
  // answer of delete_draft or get_draft (hooks/guard/autosend-drafts.mjs): the routine can no longer send it.
  autosend_draft_deleted: ['id', 'touch', 'draft_id', 'how'],
  // The other picks of the final approval (lib/autosend/pick.mjs): put in Gmail drafts, nothing sent (drafts_approved),
  // and "I'll send them myself" (send_choice), one line per message, for its text (hash).
  drafts_approved: ['id', 'touch', 'hash', 'to', 'planned_due', 'digest', 'pick'],
  send_choice: ['id', 'touch', 'hash', 'to', 'planned_due', 'digest', 'pick'],
  // What the event app's page said after a note was sent in the browser.
  app_result: ['id', 'touch', 'result', 'page_says'],
  round_approved: ['touch', 'ids'],
  staged: ['id', 'touch', 'draft_id', 'thread_id', 'message_id', 'tool', 'unattended', 'run'],
  // A draft the guard let into the mailbox in an unattended run (scripts/scheduled.mjs), before the call ran: it holds
  // that step as staged, so it is never put in twice, whether or not its receipt was saved.
  stage_released: ['id', 'touch', 'hash', 'to', 'thread_id', 'unattended', 'run'],
  // The user says an unattended draft the guard let through, whose result never came back, isn't in their drafts
  // folder: that step may go in again (once more for each time they say so).
  stage_cleared: ['id', 'touch'],
  // What the send or draft tool itself answered, read by the guard's PostToolUse hook for a call it let through: the
  // message's id and its thread (a draft's id too). It wins over the ids a receipt (outreach sent, outreach staged)
  // carries, which Claude writes: an unattended follow-up is threaded by these.
  call_result: ['id', 'touch', 'kind', 'message_id', 'thread_id', 'draft_id', 'tool'],
  // outcomes
  replied: ['id', 'source', 'ext', 'outcome', 'date', 'channel', 'text'],
  booked: ['id', 'slot', 'start', 'blocks', 'via', 'source'],
  unbooked: ['id', 'slot', 'blocks', 'source'],
  stop: ['id', 'source', 'ext'],
  met: ['id'],
  declined: ['id'],
  // What happened at a booked meeting, by the user's word: held or no_show, for the booking it names (slot, start).
  // A meeting moved or cancelled is the booked and unbooked lines themselves.
  meeting_outcome: ['id', 'outcome', 'slot', 'start'],
  // Someone who stopped by with no booked time: a person on the list (id), or a name and company off it.
  walkup: ['id', 'name', 'company', 'date'],
  // An out-of-office: the day they're back (event's zone). Shown to the user; follow-ups keep their days.
  paused: ['id', 'until'],
  // A message they sent on LinkedIn or in the event app, read in the browser: kept so it can go into the CRM.
  reply_received: ['id', 'source', 'ext', 'text'],
  // The calendar was read for meetings with people on the list (calendar-bookings).
  calendar_read: ['booked'],
  // Something a reply asks of the user: book a time, add someone they pointed to. Settled by reply_action_done.
  reply_action: ['id', 'action'],
  reply_action_done: ['id', 'ext', 'answer'],
  bounced: ['id', 'touch', 'new_email', 'old_email'],
  synced: ['id', 'touch', 'date', 'ext'],
  // checks
  reply_checked: ['id', 'source'],
  no_reply_said: ['ids', 'channel'],
  // copy
  voice_sample: ['source', 'message_id', 'hash'],
  copy_rating: ['id', 'touch', 'hash', 'rating', 'note'],
  // tasks in the user's CRM
  task_created: ['id', 'key', 'task_id', 'task_kind', 'touch', 'hash', 'day'],
  // A sent LinkedIn or event-app message logged as an activity in the CRM (connector, browser or the user).
  crm_logged: ['id', 'touch', 'via', 'crm_ref'],
  // The user's yes to log listed messages in the CRM's web app for 20 minutes (the guard reads it).
  crm_log_opened: ['until', 'keys', 'said'],
  crm_log_result: ['id', 'touch', 'result', 'page_says'],
  // A contact floorboss created in the CRM (only new contacts; existing records are never changed).
  crm_created: ['id', 'crm_ref'],
  // Empty fields floorboss filled on an existing contact (never one that had a value).
  crm_filled: ['id', 'fields'],
  crm_create_ok: ['ids', 'said'],
  // People looked up in the CRM after the user imported them (found ones get crm_created).
  crm_import_checked: ['ids'],
  crm_create_declined: ['ids', 'said'],
  task_done: ['id', 'key', 'date', 'unneeded'],
  // A finished message task floorboss can't tell was sent (its text or day changed, no close request yet): asked once.
  task_send_unclear: ['id', 'key', 'touch', 'date'],
  task_send_settled: ['id', 'key', 'went'],
  // The user passed the coordinate note to the colleague who holds this person (nothing went to the person).
  note_passed: ['id', 'channel'],
  outcome_unclear: ['id', 'key', 'why'],
  unclear_resolved: ['id', 'key'],
  // bookkeeping without a person
  sync_ran: ['source'],
  // A connected tool that failed, and the user saying it's back.
  tool_failed: ['task', 'error'],
  tool_back: ['task'],
  status_pasted: ['nothing_changed', 'paste_at'],
  tasks_read: [],
  browser_send_opened: ['items', 'until'],
  input_added: ['kind', 'file'],
  // The event's own site, which the browser may open during a run: written only by the flow's list_source
  // answer, from a link in the user's own words (said); the guard reads nothing else for it. Its url (the list
  // page) opens without asking; any other page on that host asks the user first.
  site_allowed: ['host', 'said'],
  // A hold floorboss saw on a person (a do-not-contact or opt-out match, a coworker's): a do-not-contact or
  // opt-out match keeps holding after the file stops naming them (crm-triage view.mjs pastHolds), and a send
  // or stage prompt says when one was cleared, and by what.
  hold_seen: ['id', 'rung', 'says'],
  // The user took a person off a do-not-contact or opt-out hold in their own words, after floorboss read it back
  // (crm-triage lift-hold): that hold, by its words, no longer stands for them here (resolve.mjs), nor at other events.
  hold_lifted: ['id', 'says', 'said']
};

const ID = /^c\d+$/;
const DECIDE_GROUPS = ['reach', 'warm', 'skip', 'colleague', 'same-person', 'different-person', 'not-in-crm'];

// A line is refused before it's written when its shape is wrong: a wrong line in the ledger holds people (see
// fold), so it's better to fail loudly at the writer.
export function validateEntry(e) {
  const errors = [];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return ['an entry is an object'];
  if (!ENTRY_TYPES[e.type]) errors.push(`unknown entry type "${e.type}"`);
  if (!WHO.includes(e.who)) errors.push(`who must be one of ${WHO.join(', ')}`);
  if (e.id != null && !ID.test(String(e.id))) errors.push(`id "${e.id}" isn't a person id (c001…)`);
  if (e.touch != null && !(Number.isInteger(e.touch) && e.touch >= 0 && e.touch <= 10)) errors.push('touch is a whole number from 0 to 10');
  if (
    e.who === 'user' &&
    !['person', 'fit', 'answered', 'mapping_confirmed', 'input_added'].includes(e.type) &&
    !String(e.said || '').trim() &&
    !String(e.because || '').trim()
  )
    errors.push(`a ${e.type} by the user carries their words (said or because)`);
  if (e.type === 'decide' && !DECIDE_GROUPS.includes(e.group)) errors.push(`decide group must be one of ${DECIDE_GROUPS.join(', ')}`);
  if (['drafted', 'approved', 'send_released', 'critic', 'copy_rating', 'autosend_approved', 'autosend_released'].includes(e.type) && !/^[0-9a-f]{24}$/.test(String(e.hash || '')))
    errors.push(`${e.type} needs the draft hash`);
  if (
    [
      'person',
      'decide',
      'fit',
      'drafted',
      'critic',
      'approved',
      'send_released',
      'sent',
      'sent_undone',
      'replied',
      'booked',
      'stop',
      'bounced',
      'reply_checked',
      'copy_rating',
      'autosend_approved',
      'autosend_revoked',
      'autosend_released',
      'autosend_withdrawn',
      'autosend_drafted',
      'autosend_draft_bad',
      'autosend_draft_held',
      'autosend_draft_deleted',
      'drafts_approved',
      'send_choice'
    ].includes(e.type) &&
    e.id == null
  )
    errors.push(`${e.type} needs an id`);
  if (
    e.type === 'site_allowed' &&
    (e.who !== 'user' ||
      !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(String(e.host || '')) ||
      !String(e.said || '')
        .toLowerCase()
        .includes(String(e.host)))
  )
    errors.push("site_allowed is the user's, and names a host their own words (said) contain");
  if (e.type === 'copy_rating' && !(Number.isInteger(e.rating) && e.rating >= 1 && e.rating <= 10)) errors.push('rating is 1 to 10');
  return errors;
}

// A value a line uses to name a person, a step or a task (id, touch, key): never a name every object already has
// ("__proto__", "constructor", "toString"), which would reach every object instead of one person's record.
const safeName = (v) => v == null || ((typeof v === 'string' || typeof v === 'number') && !(String(v) in Object.prototype));
export const readableEntry = (e) => !!e && typeof e === 'object' && !Array.isArray(e) && safeName(e.id) && safeName(e.touch) && safeName(e.key);
// The line each entry was read from, for a reason that names it (fold, on an entry it can't take).
const LINE_OF = new WeakMap();

// A ledger's text, line by line: the entries, and the lines floorboss can't read (not JSON, not an object, or one
// that names a person, step or task with one of those names), which hold the person they name, or everyone.
// Every reader of a ledger reads it this way.
export function readLedgerText(text) {
  const entries = [],
    damaged = [];
  String(text)
    .split('\n')
    .forEach((line, i) => {
      if (!line.trim()) return;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        e = undefined;
      }
      if (readableEntry(e)) {
        LINE_OF.set(e, i + 1);
        entries.push(e);
      } else damaged.push({ line: i + 1, text: line.slice(0, 160) });
    });
  return { entries, damaged };
}

// A ledger's own lines only, with nothing carried from the other events: for a reader that looks at another event's
// record for what that event itself holds (lib/lent.mjs), never for whether a message may go.
export function readOwnLedger(path) {
  if (!existsSync(path)) return { entries: [], damaged: [] };
  return readLedgerText(readFileSync(path, 'utf8'));
}

// The ledger each list of entries was read from (readLedger), so the last check (contactable) can look at the user's
// other events for that one person itself, never trusting the index's word that no hold is there.
const PATH_OF = new WeakMap();

// Q1 (spec 0.1.7): the other events' unlifted hold-1 lines for one person, read from each ledger's own text: only the
// hold lines are parsed, then the person and channel lines of the people they name. In one process, a ledger is read
// again only when it changes. Throws when a ledger can't be read (the caller refuses).
const textHolds = new Map();
function holdsOfLedger(file) {
  const st = statSync(file);
  const k = `${file}|${st.size}|${st.mtimeMs}`;
  const have = textHolds.get(file);
  if (have?.k === k) return have.v;
  const lines = readFileSync(file, 'utf8').split('\n');
  const parse = (l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  };
  const lifted = new Set(),
    seen = new Map();
  for (const l of lines) {
    if (!l.includes('"hold_seen"') && !l.includes('"hold_lifted"')) continue;
    const e = parse(l);
    // A hold line that doesn't parse (a write cut short) may be a hold: nothing is taken as clear (R4).
    if (!e) throw Object.assign(new Error('a hold line at another event does not parse'), { code: 'HOLD_LINE' });
    if (!ID.test(String(e.id))) continue;
    if (e.type === 'hold_lifted') lifted.add(`${e.id}|${holdKey(e.says)}`);
    else if (e.type === 'hold_seen' && !e.carried && isHoldOne(e)) seen.set(`${e.id}|${holdKey(e.says)}`, e);
  }
  const held = [...seen].filter(([key]) => !lifted.has(key)).map(([, e]) => e);
  const ids = new Set(held.map((e) => e.id));
  const who = {};
  if (ids.size)
    for (const l of lines) {
      if (!l.includes('"person"') && !l.includes('"channel"')) continue;
      const m = /"id"\s*:\s*"(c\d+)"/.exec(l);
      if (!m || !ids.has(m[1])) continue;
      const e = parse(l);
      const w = e && whoIn([e])[e.id];
      if (w) who[e.id] = mergeWho(who[e.id], w);
    }
  const v = held.map((e) => ({ e, w: who[e.id] || { mails: new Set(), name: null, company: null } }));
  textHolds.set(file, { k, v });
  return v;
}
const mergeWho = (a, b) => ({ mails: new Set([...(a?.mails || []), ...(b?.mails || [])]), name: b?.name || a?.name || null, company: b?.company || a?.company || null });
const eventName = (d, slug) => {
  try {
    return String(JSON.parse(readFileSync(join(d, 'event.json'), 'utf8'))?.name || slug).slice(0, 80);
  } catch {
    return slug;
  }
};
// Whether an event folder is the mock event (its event.json says so), read again only when that file changes.
const mockMemo = new Map();
function isMockDir(d) {
  const f = join(d, 'event.json');
  let k = 'none';
  try {
    const st = statSync(f);
    k = `${st.size}|${st.mtimeMs}`;
  } catch {
    return false;
  }
  if (mockMemo.get(d)?.k === k) return mockMemo.get(d).v;
  let v = false;
  try {
    v = JSON.parse(readFileSync(f, 'utf8'))?.mock === true;
  } catch {
    v = false;
  }
  mockMemo.set(d, { k, v });
  return v;
}
// lifted: this event's own lifts for them (holdKey words): a hold carried from elsewhere that was lifted here is lifted (R3).
// Returns { says, rung, event } for the first unlifted one, or null.
export function recipientCarried(path, s, lifted = s?.lifted_holds || []) {
  if (!path || basename(path) !== 'ledger.jsonl') return null;
  const evDir = dirname(path);
  const root = dirname(evDir);
  if (basename(root) !== 'events' || !existsSync(root)) return null;
  if (isMockDir(evDir)) return null;
  const lowered = new Set(lifted.map(holdKey));
  lifted = [...lowered];
  const mails = new Set([s.email, s.email_override, ...(s.emails || []), ...(s.keys || []).filter((k) => typeof k === 'string' && k.startsWith('e:')).map((k) => k.slice(2)), ...(s.channel && /@/.test(s.channel) ? [s.channel] : [])].filter(Boolean).map(emailBase).filter(Boolean));
  const name = s.name ? normPersonName(s.name) : null;
  const company = s.company ? companyKey(s.company) : null;
  for (const slug of readdirSync(root)) {
    const d = join(root, slug);
    const f = join(d, 'ledger.jsonl');
    if (d === evDir || !existsSync(f) || isMockDir(d)) continue;
    let held;
    try {
      held = holdsOfLedger(f);
    } catch (err) {
      // Which event's record could not be read, for the hold's own words (crm-triage view.mjs confirmedHolds).
      if (err && typeof err === 'object' && err.code !== 'HOLD_LINE') err.slug = slug;
      throw err;
    }
    for (const { e, w } of held) {
      if (lifted.includes(holdKey(e.says))) continue;
      if ([...w.mails].some((m) => mails.has(m)) || (name && company && w.name === name && w.company === company))
        return { says: holdKey(e.says), rung: e.rung, event: eventName(d, slug) };
    }
  }
  return null;
}

export function readLedger(path) {
  if (!existsSync(path)) return { entries: [], damaged: [] };
  const r = readLedgerText(readFileSync(path, 'utf8'));
  PATH_OF.set(r.entries, path);
  // Hold 1 seen at another of the user's events stands here too (spec 0.1.7 N2): added after this ledger's own lines,
  // marked carried, never written. contactable, the last check and auto-send read them like this event's own. When
  // the other events' holds can't be read, nothing goes until they can (carry_unreadable, contactable).
  try {
    r.entries.push(...carriedHolds(path, r.entries));
  } catch (e) {
    r.entries.push({ type: 'carry_unreadable', why: plainReadError(e) });
  }
  return r;
}

const plainReadError = (e) =>
  e?.code === 'EACCES' || e?.code === 'EPERM' ? "floorboss can't read one of your other events' files" : e?.code === 'ENOENT' ? 'a file of another event went missing while floorboss read it' : "floorboss couldn't read your other events' holds";

// The people of a ledger as their lines name them: id → { mails, name, company }.
function whoIn(entries) {
  const who = {};
  for (const e of entries) {
    if (!e?.id || !ID.test(e.id)) continue;
    if (e.type === 'person') {
      const w = (who[e.id] ||= { mails: new Set(), name: null, company: null });
      if (e.email) w.mails.add(emailBase(e.email));
      // A merged person's other addresses (keys "e:<address>") count too (R2).
      for (const k of Array.isArray(e.keys) ? e.keys : []) if (typeof k === 'string' && k.startsWith('e:') && /@/.test(k)) w.mails.add(emailBase(k.slice(2)));
      if (e.name) w.name = normPersonName(e.name);
      if (e.company) w.company = companyKey(e.company);
    } else if (e.type === 'channel' && e.to && /@/.test(e.to)) (who[e.id] ||= { mails: new Set(), name: null, company: null }).mails.add(emailBase(e.to));
  }
  return who;
}

// The index of unlifted hold-1 lines at every event (holds-index.json beside the events folder): for each event, its
// ledger's size and time, whether it is the mock, its name, and each hold with the person's addresses and name|company
// and the line it came from. An event whose ledger changed since is read again; the index file itself is trusted only
// while it matches its stamp (holds-index.json.stamp: its size and time when floorboss wrote it), so one edited by hand,
// damaged or missing is rebuilt from the ledgers. In one process, an event read once is not read again until it changes.
const evMemo = new Map();
function eventHolds(root, slug, st) {
  const k = `${slug}|${st.size}|${st.mtimeMs}`;
  if (evMemo.has(k)) return evMemo.get(k);
  const d = join(root, slug);
  let ev = null;
  try {
    ev = JSON.parse(readFileSync(join(d, 'event.json'), 'utf8'));
  } catch {
    ev = null;
  }
  const out = { size: st.size, mtimeMs: st.mtimeMs, mock: ev?.mock === true, name: String(ev?.name || slug).slice(0, 80), holds: [] };
  if (!out.mock) {
    const text = readFileSync(join(d, 'ledger.jsonl'), 'utf8');
    const { entries } = readLedgerText(text);
    const lifted = new Set(entries.filter((e) => e.type === 'hold_lifted').map((e) => `${e.id}|${holdKey(e.says)}`));
    const who = whoIn(entries);
    const seen = new Set();
    for (const e of entries) {
      if (e.type !== 'hold_seen' || e.carried || !isHoldOne(e) || !who[e.id]) continue;
      const key = `${e.id}|${holdKey(e.says)}`;
      if (lifted.has(key) || seen.has(key)) continue;
      seen.add(key);
      const w = who[e.id];
      out.holds.push({ id: e.id, rung: e.rung, says: holdKey(e.says), at: e.at, line: LINE_OF.get(e) || null, mails: [...w.mails].filter(Boolean), name: w.name, company: w.company });
    }
  }
  evMemo.set(k, out);
  return out;
}
// The index for a folder of events (crm-triage's view reads the carry from it too).
export const holdIndexOf = (root) => holdIndex(root);
let indexMemo = null;
const carryMemo = new Map();
// Beside the data folder, never in it: the data folder is the auto-send repo, which holds floorboss's data only
// (lib/autosend/sync.mjs DATA_RE). ~/.floorboss → ~/.floorboss-cache.
const cacheDirOf = (root) => {
  const homeDir = dirname(root);
  return join(dirname(homeDir), `${basename(homeDir)}-cache`);
};
// The holds index and its stamp for a folder of events: files a reader of the carry reads (the outbox page records them).
export const holdIndexFiles = (root) => {
  const file = join(cacheDirOf(root), 'holds-index.json');
  return [file, `${file}.stamp`];
};
function holdIndex(root) {
  const cdir = cacheDirOf(root);
  const [file, stampFile] = holdIndexFiles(root);
  // In one process, the index is read once while no ledger changes.
  const slugs0 = readdirSync(root).filter((x) => existsSync(join(root, x, 'ledger.jsonl')));
  const stats = new Map(slugs0.map((x) => [x, statSync(join(root, x, 'ledger.jsonl'))]));
  const sig = `${root}|${slugs0.map((x) => `${x}:${stats.get(x).size}:${stats.get(x).mtimeMs}`).join(',')}`;
  if (indexMemo?.sig === sig) return indexMemo.idx;
  let idx = null;
  try {
    const st = statSync(file);
    const stamp = JSON.parse(readFileSync(stampFile, 'utf8'));
    if (stamp.size === st.size && stamp.mtimeMs === st.mtimeMs) idx = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    idx = null;
  }
  if (!idx || typeof idx !== 'object' || idx.v !== 1 || !idx.events || typeof idx.events !== 'object') idx = { v: 1, events: {} };
  let changed = false;
  const slugs = slugs0;
  for (const slug of slugs) {
    const st = stats.get(slug);
    const have = idx.events[slug];
    if (have && have.size === st.size && have.mtimeMs === st.mtimeMs && Array.isArray(have.holds)) continue;
    idx.events[slug] = eventHolds(root, slug, st);
    changed = true;
  }
  for (const slug of Object.keys(idx.events))
    if (!slugs.includes(slug)) {
      delete idx.events[slug];
      changed = true;
    }
  if (changed)
    try {
      mkdirSync(cdir, { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(idx));
      renameSync(`${file}.tmp`, file);
      const st = statSync(file);
      writeFileSync(stampFile, JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs }));
    } catch {
      /* a home floorboss can't write to: the index read now still stands for this call */
    }
  indexMemo = { sig, idx };
  return idx;
}

// The other events' unlifted hold-1 lines, for the people of this ledger: matched as the carry is (the address as mail
// delivers it, or the same name at the same company). The mock and the real events never share them.
export function carriedHolds(path, entries) {
  if (basename(path) !== 'ledger.jsonl') return [];
  const evDir = dirname(path);
  const root = dirname(evDir);
  const slugHere = basename(evDir);
  if (basename(root) !== 'events' || !existsSync(root)) return [];
  const idx = holdIndex(root);
  if (idx.events[slugHere]?.mock) return [];
  // The same ledger, unchanged, with the same index: the same answer (a command reads its ledger many times).
  const memoKey = `${path}|${entries.length}|${indexMemo?.sig || ''}`;
  if (carryMemo.has(memoKey)) return carryMemo.get(memoKey).map((e) => ({ ...e }));
  const here = whoIn(entries);
  const byMail = new Map(),
    byName = new Map();
  for (const [id, w] of Object.entries(here)) {
    for (const m of w.mails) if (m) (byMail.get(m) || byMail.set(m, []).get(m)).push(id);
    if (w.name && w.company) (byName.get(`${w.name}|${w.company}`) || byName.set(`${w.name}|${w.company}`, []).get(`${w.name}|${w.company}`)).push(id);
  }
  const out = [];
  for (const [slug, ev] of Object.entries(idx.events)) {
    if (slug === slugHere || ev.mock) continue;
    for (const h of ev.holds || []) {
      const ids = new Set([...(h.mails || []).flatMap((m) => byMail.get(m) || []), ...(h.name && h.company ? byName.get(`${h.name}|${h.company}`) || [] : [])]);
      for (const id of ids) out.push({ at: h.at, type: 'hold_seen', who: 'floorboss', id, rung: h.rung, says: `${h.says} (at your event ${ev.name})`, carried: slug });
    }
  }
  carryMemo.set(memoKey, out);
  return out.map((e) => ({ ...e }));
}

// The ledgers this process wrote to: when a command ends, the outbox page of each is rebuilt (lib/args.mjs run),
// since a cut, a rewrite, a drop or a hold changes what the page may offer.
// path → the entry types written to it.
const written = new Map();
export const ledgersWritten = () => [...written].map(([path, types]) => ({ path, types: [...types] }));
const wrote = (path, type) => (written.get(path) || written.set(path, new Set()).get(path)).add(type);

export function append(path, entry, now = new Date()) {
  const e = { at: now.toISOString(), ...entry };
  const errors = validateEntry(e);
  if (errors.length) throw new Error(`Refused to write to the ledger: ${errors.join('; ')}.`);
  const buf = held.get(path);
  if (buf) {
    // floorboss's own tests make one entry fail mid-answer, to show nothing before it was written either.
    if (process.env.FLOORBOSS_TEST === '1' && process.env.FLOORBOSS_FAIL_ENTRY && process.env.FLOORBOSS_FAIL_ENTRY === `${e.type}:${e.id ?? ''}`)
      throw new Error(`(test) the entry ${e.type} ${e.id ?? ''} failed`);
    buf.push(JSON.stringify(e));
    (held.get(`${path}:types`) || []).push(e.type);
    return e;
  }
  appendLine(path, JSON.stringify(e));
  wrote(path, e.type);
  return e;
}

// A gate's answer is saved whole or not at all: while fn runs, the entries it writes to this ledger are held and
// go in as one append when it returns. If anything in it throws, none of them is written.
const held = new Map();
export function inOneGo(path, fn) {
  if (held.has(path)) return fn();
  const buf = [];
  const types = [];
  held.set(path, buf);
  held.set(`${path}:types`, types);
  let out;
  try {
    out = fn();
  } finally {
    held.delete(path);
    held.delete(`${path}:types`);
  }
  if (buf.length) {
    appendLine(path, buf.join('\n'));
    for (const t of types) wrote(path, t);
  }
  return out;
}

function person() {
  return {
    name: null,
    company: null,
    email: null,
    email_override: null,
    keys: [],
    lines: [],
    merged_into: null,
    decision: null,
    // The latest "reach" or "warm" the user said for this person: what it lifted (its seen_holds) stays lifted
    // when a later skip or hold-until replaces the decision. A skip lifts nothing.
    lift: null,
    matches: [],
    notes: [],
    known: false,
    channel: null,
    touches: {},
    replied: false,
    booked: null,
    booked_start: null,
    booked_blocks: null,
    // A booked meeting that was called off and not booked again since.
    cancelled: false,
    stopped: false,
    bounced: false,
    dropped: false,
    met: false,
    declined: false,
    unclear: [],
    tasks: {},
    ratings: [],
    ext: [],
    damaged: null,
    paused_until: null,
    // What happened at their meetings, by the user's word, oldest first: {outcome, slot, start, at}.
    meeting_outcomes: [],
    // The days they stopped by with no booked time.
    walkups: [],
    reply_actions: [],
    received: [],
    replies_said: [],
    replies_logged: {}
  };
}

// Fold the lines into state. Later lines win where they disagree; a damaged line holds the person it
// named (or everyone, when its id can't be read), because it may have been a stop or a booking.
export function fold(entries, damaged = []) {
  const st = {
    people: {},
    fits: {},
    keep: null,
    caps: {},
    answered: {},
    mappings: {},
    reply_checks: {},
    no_reply_said: [],
    rounds: [],
    voice_samples: [],
    tool_failed: {},
    last: { sync_at: null, status_at: null },
    damaged_anyone: null,
    // The lines fold couldn't take, whole (another event's check looks for an address in them).
    unread: [],
    inputs: {}
  };
  st.ledger_path = PATH_OF.get(entries) || null;
  const get = (id) => (st.people[id] ||= person());
  const touch = (s, t) =>
    (s.touches[t] ||= {
      hash: null,
      kind: 'message',
      structure: null,
      fact_source: null,
      slot_ids: [],
      planned_due: null,
      checks: [],
      critic: null,
      approved: null,
      released: false,
      release_cleared: false,
      sent: null,
      sent_at: null,
      staged: null,
      dropped: false,
      revising: false,
      review_skipped: false,
      drafted_at: null
    });
  // A line fold can't take (a hand edit with a field of the wrong kind) never stops the reading of the rest: it is
  // read as damaged, and holds the person it names, or everyone (contactable says so).
  const unreadable = (e, i) => {
    let text = '';
    try {
      text = JSON.stringify(e);
    } catch {}
    const d = { line: LINE_OF.get(e) ?? i + 1, text: text.slice(0, 160) };
    st.unread.push({ line: d.line, text });
    if (/^c\d+$/.test(String(e?.id))) get(e.id).damaged ||= d;
    else st.damaged_anyone ||= d;
  };
  for (const [i, e] of entries.entries()) {
    if (!e || typeof e !== 'object') continue;
    // (readLedgerText already keeps these out of the entries: an id, step or key with a name every object has.)
    if (!readableEntry(e)) {
      unreadable(e, i);
      continue;
    }
    try {
      const s = e.id != null ? get(e.id) : null;
      const t = e.touch ?? 1;
      if (s && e.ext) s.ext.push(e.ext);
      switch (e.type) {
        case 'person':
          Object.assign(s, {
            name: e.name ?? s.name,
            company: e.company ?? s.company,
            email: s.email_override || (e.email ?? s.email),
            keys: [...new Set([...s.keys, ...(Array.isArray(e.keys) ? e.keys : [])])],
            lines: [...s.lines, ...(Array.isArray(e.lines) ? e.lines : [])]
          });
          break;
        case 'person_merged':
          s.merged_into = e.into;
          break;
        case 'channel':
          s.channel = e.to;
          break;
        case 'colleague_note':
          s.colleague_note = true;
          break;
        case 'note':
          s.notes.push({ text: e.text, at: e.at, known: !!e.known });
          if (e.known) s.known = true;
          break;
        case 'mapping_confirmed':
          st.mappings[e.source] = e.fingerprint;
          break;
        // A match answer (same person / different person) settles one piece of evidence; it never replaces what
        // the user said about the person (a skip stays a skip).
        case 'decide':
          if (e.group === 'same-person' || e.group === 'different-person' || e.group === 'not-in-crm')
            s.matches.push({
              group: e.group,
              ref: e.ref || null,
              because: e.because || e.said || null,
              at: e.at,
              ...(e.email != null ? { email: e.email } : {})
            });
          // answered_check: the answer to a check-these question ("fine to reach"), not a pick that keep N never cuts.
          else
            s.decision = {
              group: e.group,
              ref: e.ref || null,
              because: e.because || e.said || null,
              at: e.at,
              seen_holds: Array.isArray(e.seen_holds) ? e.seen_holds : null,
              answered_check: !!e.answered_check,
              by_group: !!e.by_group
            };
          if (e.group === 'reach' || e.group === 'warm') s.lift = s.decision;
          break;
        case 'keep':
          st.keep = { top: e.top ?? null, segments: e.segments ?? null };
          break;
        case 'cap':
          st.caps[e.company] = e.value;
          break;
        case 'answered':
          st.answered[e.ask] = { value: e.value, at: e.at, ...(e.run ? { run: e.run } : {}), ...(e.task ? { task: e.task } : {}) };
          break;
        case 'input_added':
          st.inputs[e.kind] = e.file;
          break;
        case 'fit':
          st.fits[e.id] = {
            segment: e.segment ?? null,
            reason: e.reason || '',
            score: e.score ?? null,
            unsure: !!e.unsure,
            ...(e.guess ? { guess: e.guess } : {}),
            ...(e.company_size ? { company_size: e.company_size } : {})
          };
          break;
        case 'drafted': {
          const x = touch(s, t);
          // A new text replaces the old one: the critic's verdict and the approval were for the old hash.
          // A new text makes any mailbox draft of the old one out of date: remembered so the user can delete it.
          if (x.staged && x.hash && x.hash !== e.hash) {
            x.stale_staged = x.staged;
            x.staged = null;
          }
          // A draft an unattended run let in was for the old text too.
          if (x.stage_released && x.stage_released.hash && x.stage_released.hash !== e.hash) x.stage_released = null;
          // Skipping the critic was for the old text: an edited draft goes to the critic like any other.
          if (x.review_skipped && x.review_skipped_hash !== e.hash) {
            x.review_skipped = false;
            x.review_skipped_hash = null;
          }
          // user_edited: the user's own text (saved after "edit <id>"): floorboss never rewrites it.
          Object.assign(x, {
            hash: e.hash,
            kind: e.kind || 'message',
            structure: e.structure || null,
            fact_source: e.fact_source || null,
            before_hashes: e.before_hashes || null,
            previous_hash: e.previous_hash || null,
            slot_ids: e.slot_ids || x.slot_ids,
            planned_due: e.planned_due ?? x.planned_due,
            checks: e.checks || [],
            drafted_at: e.at,
            revising: false,
            dropped: false,
            user_edited: !!e.user_edited
          });
          break;
        }
        case 'critic': {
          const x = touch(s, t);
          x.critic = { hash: e.hash, verdict: e.verdict, reasons: e.reasons || [], at: e.at };
          break;
        }
        case 'batch_checked':
          (st.batch_checks ||= {})[t] = { touch: Number(t), verdict: e.verdict, reasons: e.reasons || [], at: e.at };
          break;
        case 'approved': {
          const x = touch(s, t);
          x.approved = { hash: e.hash, to: e.to, via: e.via, ...(e.where ? { where: e.where } : {}), at: e.at };
          x.dropped = false;
          x.revising = false;
          break;
        }
        // Its planned day moved with the message before it (same text, same approval).
        case 'replanned':
          if (e.touch != null) touch(s, t).planned_due = e.planned_due ?? null;
          break;
        // A touch the user dropped or sent back for revision is no longer approved: nothing reads an old approval as live.
        case 'dropped':
          if (e.touch != null) {
            const x = touch(s, t);
            x.dropped = true;
            x.approved = null;
          } else s.dropped = true;
          break;
        case 'approval_withdrawn': {
          const x = touch(s, t);
          // Kept, as for a fresh attempt or a revise: a send recorded later brings back the address it went to.
          if (!x.sent) {
            if (x.approved) x.approved_before = x.approved;
            x.approved = null;
          }
          break;
        }
        case 'step_skipped': {
          const x = touch(s, t);
          x.skipped = true;
          x.approved = null;
          break;
        }
        // A message already sent keeps its approval (the address it went to), as a fresh attempt and a withdrawn
        // approval do: nothing of a sent message is drafted again (the revise command refuses one).
        case 'revise': {
          const x = touch(s, t);
          if (x.sent) break;
          x.revising = true;
          if (x.approved) x.approved_before = x.approved;
          x.approved = null;
          x.revise = { feedback: e.feedback || e.reason || null, at: e.at };
          break;
        }
        // A fresh attempt is drafted again from scratch, as a revise is: until the new text is saved the message isn't
        // approved, and the critic reads the new text (a passing draft was otherwise never written again or read).
        // A message already sent keeps its approval (it marks the address the message went to, as approval_withdrawn
        // keeps it): nothing of a sent message is drafted again.
        case 'fresh_attempt': {
          const x = touch(s, t);
          x.fresh_attempt = e.at;
          if (!x.sent) {
            x.revising = true;
            if (x.approved) x.approved_before = x.approved;
            x.approved = null;
          }
          break;
        }
        // An older line without a hash was for the text saved at the time.
        case 'review_skipped': {
          const x = touch(s, t);
          x.review_skipped_hash = e.hash || x.hash;
          x.review_skipped = !x.hash || x.review_skipped_hash === x.hash;
          break;
        }
        case 'send_released': {
          const x = touch(s, t);
          x.released = true;
          x.release_cleared = false;
          x.released_at = e.at;
          x.released_via = e.via || null;
          x.released_where = e.where || null;
          // Kept when the release is cleared: a note let through once may have reached the app (the app's limit).
          if (e.via === 'browser') x.ever_released_where = e.where || x.ever_released_where || 'browser';
          break;
        }
        case 'release_cleared': {
          const x = touch(s, t);
          x.release_cleared = true;
          x.released = false;
          x.unclear_send = null;
          break;
        }
        case 'send_unclear': {
          const x = touch(s, t);
          x.unclear_send = { error: e.error || null, at: e.at };
          break;
        }
        case 'app_result': {
          const x = touch(s, t);
          x.app_result = { result: e.result, page_says: e.page_says || null, at: e.at };
          if (e.result === 'limit') st.app_limit_at = e.at;
          break;
        }
        case 'round_approved':
          st.rounds.push({ touch: e.touch, ids: e.ids || null, at: e.at });
          break;
        case 'staged': {
          const x = touch(s, t);
          // The thread and message ids are the guard's own reading of the draft tool's answer (call_result), or the
          // guard's own staged line (an unattended draft); never a receipt's, which Claude writes and could name
          // another conversation's thread.
          const own = e.who === 'guard';
          x.staged = {
            draft_id: e.draft_id,
            thread_id: x.stage_result?.thread_id || (own ? e.thread_id : null) || null,
            message_id: x.stage_result?.message_id || (own ? e.message_id : null) || null,
            tool: e.tool || null,
            ...(e.unattended ? { unattended: true } : {})
          };
          x.stale_staged = null;
          break;
        }
        case 'call_result': {
          const x = touch(s, t);
          const ids = { message_id: e.message_id || null, thread_id: e.thread_id || null, ...(e.draft_id ? { draft_id: e.draft_id } : {}) };
          if (e.kind === 'send') {
            x.send_result = ids;
            if (x.sent) Object.assign(x.sent, { message_id: ids.message_id, thread_id: ids.thread_id || x.sent.thread_id });
          } else if (e.kind === 'draft') {
            x.stage_result = ids;
            if (x.staged) Object.assign(x.staged, { message_id: ids.message_id || x.staged.message_id, thread_id: ids.thread_id || x.staged.thread_id });
          }
          break;
        }
        case 'stage_released': {
          const x = touch(s, t);
          x.stage_released = { at: e.at, hash: e.hash || null, thread_id: e.thread_id || null, unattended: e.unattended === true, run: e.run || null };
          break;
        }
        case 'stage_cleared': {
          const x = s.touches[t];
          if (x && !x.staged) x.stage_released = null;
          break;
        }
        // The mailbox shows a send the user reported: it went, so it is the mailbox's now (record's "unsent" never
        // takes it back).
        case 'synced': {
          const x = s.touches[t];
          if (x?.sent) {
            if (e.date) x.sent.date = e.date;
            x.sent.via = 'mailbox';
          }
          break;
        }
        case 'sent': {
          const x = touch(s, t);
          x.sent = {
            date: e.date,
            via: e.via || null,
            channel: e.channel || null,
            source: e.source || null,
            // Only what the guard read itself: the send tool's own answer (call_result), else, for a draft floorboss put
            // in the drafts folder that the user then sent, that draft's thread as the guard read it. A receipt's or a
            // mailbox file's ids are Claude's words and could name another conversation: the ledger keeps them as said,
            // and nothing uses them.
            message_id: x.send_result?.message_id || null,
            thread_id: x.send_result?.thread_id || x.staged?.thread_id || null,
            hash: e.hash || x.hash,
            text: e.text || null
          };
          x.sent_at = e.at;
          // Sent after a fresh attempt, a revise or a withdrawal cleared its approval (a send recorded late: the user's own
          // mail, the mailbox check): the address it went out to is kept apart, for the day mark (lib/sendcheck.mjs
          // sentMarks). Never as an approval: taken back ("unsent"), nothing of it could be sent again.
          x.sent_under = !x.approved && x.approved_before ? { to: x.approved_before.to ?? null, via: x.approved_before.via ?? null } : null;
          x.skipped = false;
          x.unclear_send = null;
          if (e.source !== 'user') delete st.tool_failed['email.send'];
          break;
        }
        case 'sent_undone': {
          const x = s.touches[t];
          if (x?.sent) {
            x.sent = null;
            x.sent_at = null;
            x.sent_under = null;
          }
          break;
        }
        // A reply the user reported in words ("Tue 10 works"): what they wrote, for the agenda's thread.
        case 'replied':
          s.replied = true;
          s.replied_at = e.at;
          if (e.outcome) s.outcome = e.outcome;
          if (e.who === 'user' && !e.outcome && String(e.text || e.said || '').trim())
            s.replies_said.push({ at: e.date || e.at, text: String(e.text || e.said), channel: e.channel || null, recorded: true });
          break;
        case 'met':
          s.replied = true;
          s.met = true;
          break;
        case 'declined':
          s.replied = true;
          s.declined = true;
          s.dropped = true;
          break;
        case 'meeting_outcome':
          if (s) s.meeting_outcomes.push({ outcome: e.outcome, slot: e.slot || null, start: e.start || null, at: e.at });
          break;
        case 'walkup':
          // Someone off the list has no person here: the report reads those lines itself.
          if (s) s.walkups.push({ date: e.date || null, at: e.at });
          break;
        case 'paused':
          if (!s.paused_until || e.until > s.paused_until) s.paused_until = e.until;
          break;
        case 'reply_action':
          s.reply_actions.push({
            action: e.action,
            time: e.time || null,
            referral: e.referral || null,
            why: e.why || null,
            ext: e.ext || null,
            at: e.at,
            done: false
          });
          break;
        case 'reply_action_done': {
          const a = s.reply_actions.find((x) => !x.done && (x.ext || null) === (e.ext || null));
          if (a) {
            a.done = true;
            a.answer = e.answer;
          }
          break;
        }
        // A booking answers the question a reply about a time asked (recorded with it, or after it): nothing to ask.
        case 'booked':
          s.booked = e.slot;
          s.booked_start = e.start || null;
          s.booked_blocks = e.blocks || [e.slot];
          s.booked_via = e.via || e.source || null;
          // When the booking was recorded: a cancellation sent before it is about an earlier meeting.
          s.booked_at = e.at || null;
          s.cancelled = false;
          for (const a of s.reply_actions)
            if (!a.done && a.action === 'book') {
              a.done = true;
              a.answer = `booked ${e.slot}`;
            }
          break;
        case 'unbooked':
          if (s.booked === e.slot) {
            s.booked = null;
            s.booked_start = null;
            s.booked_blocks = null;
            s.cancelled = true;
          }
          break;
        case 'stop':
          s.stopped = true;
          break;
        // Hold 1 (spec 0.1.7 §7): a do-not-contact or opt-out hold seen on them stands until the user lifts it through
        // the read-back (hold_lifted); contactable refuses them on every channel meanwhile.
        case 'hold_seen':
          if (isHoldOne(e) && !(s.lifted_holds || []).includes(holdKey(e.says))) (s.never_holds ||= {})[holdKey(e.says)] = String(e.says);
          break;
        case 'carry_unreadable':
          st.carry_unreadable = String(e.why || 'unreadable');
          break;
        case 'hold_lifted':
          (s.lifted_holds ||= []).push(holdKey(e.says));
          if (s.never_holds) delete s.never_holds[holdKey(e.says)];
          break;
        case 'bounced': {
          // The email never arrived: that touch is unsent. With a new address the person gets it, and anything
          // approved for the old address needs approving again (the approval names the address).
          // The release is spent too: a bounced send is settled (it went, and came back), not unclear.
          if (e.touch != null && s.touches[e.touch]) {
            const bt = s.touches[e.touch];
            bt.sent = null;
            bt.sent_at = null;
            bt.released = false;
            bt.release_cleared = true;
            bt.unclear_send = null;
            bt.bounced_at = e.at;
          }
          if (e.new_email) {
            s.email = String(e.new_email).toLowerCase();
            s.email_override = s.email;
            s.bounced = false;
            // Approvals name the old address: each unsent message goes back to be saved for the new one, read by
            // the critic and approved again.
            for (const x of Object.values(s.touches))
              if (!x.sent && x.approved && String(x.approved.to || '').toLowerCase() !== s.email) {
                x.approved = null;
                x.revising = true;
              }
          } else s.bounced = true;
          break;
        }
        case 'reply_checked':
          st.reply_checks[e.id] = { at: e.at, source: e.source };
          if (e.source === 'mailbox') delete st.tool_failed['email.messages'];
          break;
        case 'no_reply_said':
          st.no_reply_said.push({ ids: e.ids || null, at: e.at, said: e.said, channel: e.channel || null });
          break;
        case 'voice_sample':
          st.voice_samples.push({ source: e.source, hash: e.hash, at: e.at });
          break;
        case 'copy_rating':
          s.ratings.push({ touch: t, hash: e.hash, rating: e.rating, note: e.note || null, at: e.at });
          break;
        case 'task_created':
          s.tasks[e.key] = { task_id: e.task_id, kind: e.task_kind || null, touch: e.touch ?? null, at: e.at || null, ...(e.hash ? { hash: e.hash } : {}), ...(e.day ? { day: e.day } : {}) };
          break;
        case 'task_send_unclear':
          // The day the task was finished (or the question raised), for the send a yes records.
          if (s.tasks[e.key]) s.tasks[e.key].ask_sent = e.date || String(e.at || '').slice(0, 10) || true;
          break;
        case 'task_send_settled':
          if (s.tasks[e.key]) {
            delete s.tasks[e.key].ask_sent;
            if (e.went === 'no') s.tasks[e.key].unneeded = true;
          }
          break;
        case 'task_done':
          if (s.tasks[e.key]) {
            s.tasks[e.key].done = e.date || true;
            if (e.unneeded) s.tasks[e.key].unneeded = true;
          }
          break;
        case 'note_passed':
          s.note_passed = { at: e.at, channel: e.channel || null };
          break;
        case 'crm_logged':
          if (e.reply_ext) s.replies_logged[e.reply_ext] = { via: e.via || null, crm_ref: e.crm_ref || null, at: e.at };
          else (s.crm_logged ||= {})[e.touch ?? 1] = { via: e.via || null, crm_ref: e.crm_ref || null, at: e.at };
          break;
        // A record floorboss added to the CRM (or found there after the user imported them): its id is how the CRM's
        // logged mail is read for them.
        case 'crm_created':
          if (e.crm_ref) s.crm_id = String(e.crm_ref);
          break;
        case 'reply_received':
          s.received.push({ ext: e.ext, source: e.source, text: e.text || '', at: e.at_msg || e.at });
          break;
        case 'outcome_unclear':
          s.unclear.push({ key: e.key, why: e.why });
          break;
        case 'unclear_resolved':
          // With a key, only that question (a review task answers the one it asked); without, the user's own answer
          // (a status paste or a record) settles them all.
          s.unclear = e.key ? s.unclear.filter((u) => u.key !== e.key) : [];
          break;
        case 'calendar_read':
          st.last.calendar_at = e.at;
          break;
        // The mailbox and the CRM each keep the time and run of their last read: both are read again in every run.
        case 'sync_ran':
          if (['linkedin', 'app'].includes(e.source)) st.last[`sync_${e.source}`] = e.at;
          else if (e.source === 'crm') {
            // A read of everyone sets the run's CRM state; a read of one or a few people (right before a send) only
            // updates who among them the CRM can't see.
            const blind = Array.isArray(e.blind) ? e.blind : [];
            if (e.logs_inbound === true) st.last.crm_logs_inbound = true;
            if (e.partial) {
              const seen = new Set(Array.isArray(e.seen) ? e.seen : []);
              st.last.sync_crm_blind = [...(st.last.sync_crm_blind || []).filter((id) => !seen.has(id)), ...blind];
            } else {
              st.last.sync_crm = e.at;
              st.last.sync_crm_run = e.run || null;
              st.last.sync_crm_blind = blind;
            }
          } else {
            st.last.sync_at = e.at;
            st.last.sync_run = e.run || null;
          }
          break;
        // A failed tool stays failed until the user says it's back or the tool works again.
        case 'tool_failed':
          st.tool_failed[e.task] = { error: e.error || null, at: e.at, count: (st.tool_failed[e.task]?.count || 0) + 1 };
          break;
        case 'tool_back':
          delete st.tool_failed[e.task];
          break;
        case 'status_pasted':
          st.last.status_at = e.at;
          if (e.paste_at) st.last.paste_at = e.paste_at;
          break;
        case 'browser_send_opened':
          (st.browser_windows ||= []).push({ items: e.items || [], until: e.until, at: e.at, said: e.said });
          break;
        default:
          break;
      }
    } catch {
      unreadable(e, i);
    }
  }
  for (const d of damaged) {
    const m = /"id"\s*:\s*"(c\d+)"/.exec(d.text || '');
    if (m) get(m[1]).damaged = d;
    else st.damaged_anyone = d;
  }
  return st;
}

// A hold_seen line of hold 1: a do-not-contact list entry, a "no" to contact on the event's list, or an opt-out or
// stop (not a bounce). Its key: the words without floorboss's "(seen …)", "(at your event …)" suffixes.
// The one definition of hold 1, by rung and words: the ledger, the triage (resolve.mjs isNeverHold) and the carry use it.
export const isHoldOne = (e) =>
  (e.rung === 'do_not_contact' && /^on your do-not-contact list|^said no to contact/.test(e.says || '')) || (e.rung === 'opted_out' && !/bounced/.test(e.says || ''));
export const holdKey = (says) =>
  String(says || '')
    .replace(/ \((seen |at your event |new since you said )[^()]*(\([^()]*\)[^()]*)*\)/g, '')
    .trim();
// Where a hold-1 line came from, in plain words.
const holdSaid = (says) =>
  /^on your do-not-contact list/.test(says) ? 'they are on your do-not-contact list' : /^said no to contact/.test(says) ? "they said no to contact on the event's list" : 'they opted out or asked not to be contacted';

const todayOf = (iso) => String(iso).slice(0, 10);
// The day someone who sent an out-of-office is back, while it is still to come; null once they're back. It's shown
// to the user (the summary, the export) and holds nothing: follow-ups keep their days.
// today: the event's day (YYYY-MM-DD in its time zone), which that day is in; without it, UTC's.
export function awayUntil(s, today = null) {
  return s?.paused_until && todayOf(s.paused_until) > (today || todayOf(movedNow() || new Date().toISOString())) ? s.paused_until : null;
}

// May floorboss write to or send to this person now? null when yes, else the reason in plain words.
// kind: 'message' (a first message or follow-up) or 'confirmation' (goes to someone who booked).
// today: the event's day (YYYY-MM-DD in its time zone).
export function contactable(state, id, kind = 'message', today = null) {
  if (state.damaged_anyone)
    return `the ledger has a damaged line (line ${state.damaged_anyone.line}) that may be a stop or a booking: fix it before anything goes to anyone`;
  if (state.carry_unreadable)
    return `${state.carry_unreadable}, so floorboss can't check its do-not-contact holds: nothing goes to anyone until it can, and nothing was sent`;
  const s = state.people[id];
  if (!s) return 'not on the list';
  if (s.damaged) return `the ledger has a damaged line about them (line ${s.damaged.line}): check what it held`;
  if (s.merged_into) return `a duplicate of ${s.merged_into}`;
  if (s.stopped) return 'they said stop';
  const never = Object.values(s.never_holds || {});
  if (never.length) return `${holdSaid(never[0])}: floorboss does not write to them on any channel, and nothing was sent`;
  // The last check never takes the index's word that no hold is there: the other events' own lines for this person.
  let carried = null;
  try {
    carried = recipientCarried(state.ledger_path, s);
  } catch (e) {
    if (e?.code === 'HOLD_LINE') return "floorboss can't check another event's do-not-contact holds: nothing was sent";
    return `${plainReadError(e)}, so floorboss can't check its do-not-contact holds for them: nothing was sent`;
  }
  if (carried) return `${holdSaid(carried.says)} at another of your events: floorboss does not write to them on any channel, and nothing was sent`;
  if (s.decision?.group === 'skip') return `you said to leave them alone${s.decision.because ? ` (${s.decision.because})` : ''}`;
  if (s.decision?.group === 'colleague') return 'a colleague holds them';
  if (s.dropped) return 'dropped';
  if (s.bounced) return 'their email bounced and there is no new address';
  // A question about them still open (a cancellation that may be about this meeting): no confirmation on a guess.
  if (kind === 'confirmation' && s.unclear?.length) return `a question about them needs your answer first: ${s.unclear[0].why}`;
  if (kind !== 'confirmation' && s.replied) return 'they replied';
  if (kind !== 'confirmation' && s.booked) return 'they booked';
  return null;
}

// The last message that went to this person, by touch number (0 for a confirmation is not counted).
export function lastSent(s) {
  return Math.max(
    0,
    ...Object.entries(s?.touches || {})
      .filter(([t, x]) => Number(t) > 0 && x.sent)
      .map(([t]) => Number(t))
  );
}

// The sent date kept for a send recorded with no date (see legacyState).
export const NO_SEND_DATE = 'no date';
// The per-contact shape the drafting step reads (touches with a status, sent dates by touch, flags), built
// from the fold. New code reads the fold; this keeps the older readers honest about one record meanwhile.
export function legacyState(st) {
  const out = {};
  for (const [id, p] of Object.entries(st.people)) {
    if (p.merged_into) continue;
    const touches = {};
    for (const [t, x] of Object.entries(p.touches)) {
      const status = x.dropped || x.skipped ? 'dropped' : x.revising ? 'revising' : x.approved && x.approved.hash === x.hash ? 'outboxed' : x.hash ? 'drafted' : null;
      touches[t] = {
        status,
        skipped: x.skipped || undefined,
        hash: x.hash,
        kind: x.kind,
        slot_ids: x.slot_ids,
        planned_due: x.planned_due,
        structure: x.structure,
        fact_source: x.fact_source,
        checks: x.checks,
        drafted: x.drafted_at ? { at: x.drafted_at } : undefined,
        approved: x.approved && x.approved.hash === x.hash ? x.approved : undefined,
        critic: x.critic || undefined,
        staged: x.staged || undefined,
        stage_released: x.stage_released || undefined,
        app_result: x.app_result || undefined,
        stale_staged: x.stale_staged || undefined,
        sent_msg: x.sent && (x.sent.message_id || x.sent.thread_id) ? { message_id: x.sent.message_id, thread_id: x.sent.thread_id } : undefined,
        released: x.released,
        released_at: x.released ? x.released_at : undefined,
        review_skipped: x.review_skipped,
        revise: x.revise,
        fresh_attempt: x.fresh_attempt
      };
    }
    const sent = {},
      sent_at = {},
      sent_text = {},
      sent_via = {};
    for (const [t, x] of Object.entries(p.touches))
      if (x.sent) {
        // A send recorded with no date (a hand-edited line: "", null, 0, false, no date at all) still went: it is kept
        // as sent, never read as unsent and sent again (NO_SEND_DATE: the step after it waits with a note, lib/spacing.mjs).
        sent[t] = x.sent.date || NO_SEND_DATE;
        sent_at[t] = x.sent_at;
        sent_via[t] = x.sent.via || null;
        if (x.sent.text) sent_text[t] = x.sent.text;
      }
    out[id] = {
      touches,
      removed: p.decision?.group === 'skip',
      added: p.decision?.group === 'reach' || p.decision?.group === 'warm',
      dropped: p.dropped,
      sent,
      sent_at,
      sent_text,
      sent_via,
      channel: Object.values(p.touches).find((x) => x.sent?.channel)?.sent.channel || null,
      replied: p.replied,
      booked: p.booked,
      booked_start: p.booked_start,
      booked_via: p.booked_via || null,
      booked_blocks: p.booked_blocks,
      // When the booking was recorded: a cancellation older than it (by email or in the calendar) is asked about.
      booked_at: p.booked_at || null,
      stopped: p.stopped,
      bounced: p.bounced ? true : p.email_override || false,
      tasks: p.tasks,
      unclear: p.unclear,
      ext: p.ext,
      log_damaged: p.damaged?.line || undefined,
      decision: p.decision,
      email: p.email,
      ratings: p.ratings,
      met: p.met,
      declined: p.declined,
      note_passed: p.note_passed || null,
      // What happened at their meetings, by the user's word (record.mjs reads the latest for a booking).
      meeting_outcomes: p.meeting_outcomes || []
    };
  }
  return out;
}
