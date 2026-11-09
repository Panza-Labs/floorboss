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
import { readFileSync, existsSync } from 'node:fs';
import { appendLine } from './jsonio.mjs';
import { movedNow } from './clock.mjs';

export const WHO = ['user', 'floorboss', 'guard', 'mailbox', 'crm', 'calendar'];

// What may be written, grouped by what it records. The payload keys are the ones fold() reads.
export const ENTRY_TYPES = {
  // people: who is on the list
  person: ['id', 'keys', 'name', 'company', 'email', 'lines'],
  person_merged: ['id', 'into', 'why'],
  renamed: ['id', 'name'],
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
  fit: ['id', 'segment', 'reason', 'score', 'unsure', 'company_size'],
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
    'checks',
    'subject_preview',
    'booked_slot',
    'previous_hash'
  ],
  critic: ['id', 'touch', 'hash', 'verdict', 'reasons'],
  batch_checked: ['touch', 'verdict', 'reasons'],
  // critic_override: the user approved by name a message the critic failed (a send reads it from here only).
  approved: ['id', 'touch', 'hash', 'to', 'via', 'critic_override'],
  dropped: ['id', 'touch', 'reason'],
  // The user skipped this step of the route: the sequence goes on to the next one.
  step_skipped: ['id', 'touch'],
  revise: ['id', 'touch', 'feedback', 'reason'],
  fresh_attempt: ['id', 'touch'],
  // The user's go-ahead to send a draft unreviewed: for that exact text (hash), so an edit goes to the critic.
  review_skipped: ['id', 'touch', 'hash', 'because'],
  // sends
  send_released: ['id', 'touch', 'hash', 'via', 'to'],
  sent: ['id', 'touch', 'via', 'date', 'message_id', 'thread_id', 'hash', 'channel', 'text', 'source', 'ext'],
  // A send the user recorded by mistake, taken back (record's "unsent"): that touch is unsent again.
  sent_undone: ['id', 'touch'],
  release_cleared: ['id', 'touch'],
  // A send the guard let through whose tool call failed or never answered: it may or may not have gone.
  send_unclear: ['id', 'touch', 'error'],
  // What the event app's page said after a note was sent in the browser.
  app_result: ['id', 'touch', 'result', 'page_says'],
  round_approved: ['touch', 'ids'],
  staged: ['id', 'touch', 'draft_id', 'thread_id', 'message_id', 'tool'],
  // outcomes
  replied: ['id', 'source', 'ext', 'outcome', 'date', 'channel', 'text'],
  booked: ['id', 'slot', 'start', 'blocks', 'via', 'source'],
  unbooked: ['id', 'slot', 'blocks', 'source'],
  stop: ['id', 'source', 'ext'],
  met: ['id'],
  declined: ['id'],
  // An out-of-office: no follow-up before this day (event's zone).
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
  no_reply_said: ['ids'],
  // copy
  voice_sample: ['source', 'message_id', 'hash'],
  copy_rating: ['id', 'touch', 'hash', 'rating', 'note'],
  // tasks in the user's CRM
  task_created: ['id', 'key', 'task_id', 'task_kind', 'touch'],
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
  task_done: ['id', 'key', 'date'],
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
  thread_checked: ['threads'],
  browser_send_opened: ['items', 'until'],
  input_added: ['kind', 'file'],
  // The event's own site, which the browser may open during a run: written only by the flow's list_source
  // answer, from a link in the user's own words (said); the guard reads nothing else for it. Its url (the list
  // page) opens without asking; any other page on that host asks the user first.
  site_allowed: ['host', 'said'],
  // A hold floorboss saw on a person (a do-not-contact or opt-out match, a coworker's): a do-not-contact or
  // opt-out match keeps holding after the file stops naming them (crm-triage view.mjs pastHolds), and a send
  // or stage prompt says when one was cleared, and by what.
  hold_seen: ['id', 'rung', 'says']
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
    !['person', 'renamed', 'fit', 'answered', 'mapping_confirmed', 'input_added'].includes(e.type) &&
    !String(e.said || '').trim() &&
    !String(e.because || '').trim()
  )
    errors.push(`a ${e.type} by the user carries their words (said or because)`);
  if (e.type === 'decide' && !DECIDE_GROUPS.includes(e.group)) errors.push(`decide group must be one of ${DECIDE_GROUPS.join(', ')}`);
  if (['drafted', 'approved', 'send_released', 'critic', 'copy_rating'].includes(e.type) && !/^[0-9a-f]{24}$/.test(String(e.hash || '')))
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
      'copy_rating'
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

export function readLedger(path) {
  if (!existsSync(path)) return { entries: [], damaged: [] };
  const entries = [],
    damaged = [];
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (!line.trim()) return;
      try {
        entries.push(JSON.parse(line));
      } catch {
        damaged.push({ line: i + 1, text: line.slice(0, 160) });
      }
    });
  return { entries, damaged };
}

export function append(path, entry, now = new Date()) {
  const e = { at: now.toISOString(), ...entry };
  const errors = validateEntry(e);
  if (errors.length) throw new Error(`Refused to write to the ledger: ${errors.join('; ')}.`);
  appendLine(path, JSON.stringify(e));
  return e;
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
    renamed_to: null,
    decision: null,
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
    inputs: {}
  };
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
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const s = e.id != null ? get(e.id) : null;
    const t = e.touch ?? 1;
    if (s && e.ext) s.ext.push(e.ext);
    switch (e.type) {
      case 'person':
        Object.assign(s, {
          name: e.name ?? s.name,
          company: e.company ?? s.company,
          email: s.email_override || (e.email ?? s.email),
          keys: [...new Set([...s.keys, ...(e.keys || [])])],
          lines: [...s.lines, ...(e.lines || [])]
        });
        break;
      case 'person_merged':
        s.merged_into = e.into;
        break;
      case 'renamed':
        s.name = e.name;
        s.renamed_to = e.name;
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
        x.approved = { hash: e.hash, to: e.to, via: e.via, at: e.at };
        x.dropped = false;
        x.revising = false;
        break;
      }
      // A touch the user dropped or sent back for revision is no longer approved: nothing reads an old approval as live.
      case 'dropped':
        if (e.touch != null) {
          const x = touch(s, t);
          x.dropped = true;
          x.approved = null;
        } else s.dropped = true;
        break;
      case 'step_skipped': {
        const x = touch(s, t);
        x.skipped = true;
        x.approved = null;
        break;
      }
      case 'revise': {
        const x = touch(s, t);
        x.revising = true;
        x.approved = null;
        x.revise = { feedback: e.feedback || e.reason || null, at: e.at };
        break;
      }
      case 'fresh_attempt':
        touch(s, t).fresh_attempt = e.at;
        break;
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
        x.staged = { draft_id: e.draft_id, thread_id: e.thread_id || null, message_id: e.message_id || null, tool: e.tool || null };
        x.stale_staged = null;
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
          message_id: e.message_id || null,
          thread_id: e.thread_id || null,
          hash: e.hash || x.hash,
          text: e.text || null
        };
        x.sent_at = e.at;
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
        if (['mailbox', 'thread'].includes(e.source)) delete st.tool_failed['email.messages'];
        break;
      case 'no_reply_said':
        st.no_reply_said.push({ ids: e.ids || null, at: e.at, said: e.said });
        break;
      case 'voice_sample':
        st.voice_samples.push({ source: e.source, hash: e.hash, at: e.at });
        break;
      case 'copy_rating':
        s.ratings.push({ touch: t, hash: e.hash, rating: e.rating, note: e.note || null, at: e.at });
        break;
      case 'task_created':
        s.tasks[e.key] = { task_id: e.task_id, kind: e.task_kind || null, touch: e.touch ?? null, at: e.at || null };
        break;
      case 'task_done':
        if (s.tasks[e.key]) s.tasks[e.key].done = e.date || true;
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
  }
  for (const d of damaged) {
    const m = /"id"\s*:\s*"(c\d+)"/.exec(d.text || '');
    if (m) get(m[1]).damaged = d;
    else st.damaged_anyone = d;
  }
  return st;
}

const todayOf = (iso) => String(iso).slice(0, 10);
// The day someone who sent an out-of-office is back, while it is still to come; null once they're back. Until then
// no follow-up goes or is due (drafting, sending, the summary, the tracker and the export all read it here).
// today: the event's day (YYYY-MM-DD in its time zone), which that day is in; without it, UTC's.
export function awayUntil(s, today = null) {
  return s?.paused_until && todayOf(s.paused_until) > (today || todayOf(movedNow() || new Date().toISOString())) ? s.paused_until : null;
}

// May floorboss write to or send to this person now? null when yes, else the reason in plain words.
// kind: 'message' (a first message or follow-up) or 'confirmation' (goes to someone who booked).
// today: the event's day (YYYY-MM-DD in its time zone), which an out-of-office's day is in; without it, UTC's.
export function contactable(state, id, kind = 'message', today = null) {
  if (state.damaged_anyone)
    return `the ledger has a damaged line (line ${state.damaged_anyone.line}) that may be a stop or a booking: fix it before anything goes to anyone`;
  const s = state.people[id];
  if (!s) return 'not on the list';
  if (s.damaged) return `the ledger has a damaged line about them (line ${s.damaged.line}): check what it held`;
  if (s.merged_into) return `a duplicate of ${s.merged_into}`;
  if (s.stopped) return 'they said stop';
  if (s.decision?.group === 'skip') return `you said to leave them alone${s.decision.because ? ` (${s.decision.because})` : ''}`;
  if (s.decision?.group === 'colleague') return 'a colleague holds them';
  if (s.dropped) return 'dropped';
  if (s.bounced) return 'their email bounced and there is no new address';
  // A question about them still open (a cancellation that may be about this meeting): no confirmation on a guess.
  if (kind === 'confirmation' && s.unclear?.length) return `a question about them needs your answer first: ${s.unclear[0].why}`;
  if (kind !== 'confirmation' && awayUntil(s, today)) return `they're away until ${s.paused_until}`;
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
        stale_staged: x.stale_staged || undefined,
        sent_msg: x.sent && (x.sent.message_id || x.sent.thread_id) ? { message_id: x.sent.message_id, thread_id: x.sent.thread_id } : undefined,
        released: x.released,
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
        sent[t] = x.sent.date;
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
      note_passed: p.note_passed || null
    };
  }
  return out;
}
