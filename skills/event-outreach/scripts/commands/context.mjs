// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// What every command starts from: the event as loaded (ctxOf), writing to the ledger (led), and small
// helpers about people, ids and settings that several commands share.
import { companyKey } from '../../../../lib/normalize.mjs';
import { readJson } from '../../../../lib/jsonio.mjs';
import { loadEvent, contextFor, nowFrom } from '../../../../lib/event.mjs';
import { todayKeyIn } from '../../../../lib/tz.mjs';
import { eventDayState, zoneReadable } from '../../../../lib/spacing.mjs';
import { slotLabel } from '../../../slot-finder/scripts/slots.mjs';
import { parseSegments, parseProof } from '../../../event-context/scripts/context-check.mjs';
import { readLedger, fold, legacyState, append } from '../../../../lib/ledger.mjs';
import { viewOf, writeDerived, compatOf, inputFile } from '../../../crm-triage/scripts/view.mjs';
import { validateCrmRecords } from '../../../connectors/scripts/tasks.mjs';
import { loadConfig } from '../../../../lib/config.mjs';

// Names a draft must not mention: everyone else on the list, except the user's own company (the sender's
// own name in a signature isn't another attendee).
export function otherAttendees(c, id) {
  const own = new Set((c.settings.own_domains || []).map((d) => String(d).toLowerCase().replace(/^@/, '')));
  const ownKey = c.settings.own_company ? companyKey(c.settings.own_company) : null;
  // A named customer in the proof library may be quoted by name even if they're attending: the draft
  // names a client, not a fellow attendee.
  const proofText = parseProof(skillsOf(c).whatYouBring || '')
    .filter((p) => p.named)
    .map((p) => `${p.claim} ${p.source}`)
    .join(' ')
    .toLowerCase();
  return c.store.contacts
    .filter(
      (x) =>
        x.id !== id &&
        !(x.email && own.has(String(x.email).split('@')[1]?.toLowerCase())) &&
        !(ownKey && x.company_key === ownKey) &&
        !(proofText && proofText.includes(String(x.name).toLowerCase()))
    )
    .map((x) => x.name);
}

// The sign-off from the voice skill: the first quoted text if there is one ("Warm regards, Sam" (then
// "CEO, Acme")), else the line without quotes or a trailing note in brackets.
export function signoffOf(voice) {
  let line = (/^-?[ \t]*\**sign-?off:?\**:?[ \t]*(.+)$/im.exec(voice || '') || [])[1];
  // The template's own example ("<e.g. "Best, Sam">") is no sign-off: it was read as the user's own.
  if (!line || /<[^>]*>/.test(line)) return null;
  line = line.split(/\\n/)[0]; // a sign-off written with a literal "\n" ("Best,\nEmily")
  const q = /["“]([^"”]+)["”]/.exec(line);
  return (q ? q[1] : line.replace(/\s*\(.*\)\s*$/, '')).trim().replace(/^["'“”]+|["'“”]+$/g, '') || null;
}

export function ctxOf(slug, opts) {
  const loaded = loadEvent(slug);
  const now = nowFrom(opts);
  // Where the event stands (lib/spacing.mjs eventDayState), read from event.json as it is. An event whose dates or zone
  // can't be read sends nothing and says so (dayState); its times are drawn in UTC only so the page and the summary can
  // still be made, never a thrown "Invalid time zone".
  const dayState = eventDayState(loaded.event, now.getTime());
  const base = dayState.state === 'unreadable' && !zoneReadable(loaded.event?.time_zone) ? { ...loaded, event: { ...loaded.event, time_zone: 'UTC' } } : loaded;
  const { entries, damaged } = readLedger(base.paths.ledger);
  const folded = fold(entries, damaged);
  if (!Object.keys(folded.people).length) throw new Error(`${base.event.name} has no loaded list yet. Run /floorboss:start first.`);
  // Everything about everyone, computed from the inputs and the ledger right now (the triage view), in the
  // shapes this step reads: contacts, groups, the shortlist and the times offered.
  const tc = {
    event: base.event,
    config: base.config,
    settings: base.settings,
    paths: base.paths,
    now,
    today: dayState.today || todayKeyIn(base.event.time_zone, now),
    dayState,
    entries,
    state: folded,
    slug
  };
  const view = viewOf(tc);
  writeDerived(tc, view);
  const compat = compatOf(tc, view);
  const store = { contacts: compat.contacts, visit: view.visit };
  const slots = readJson(base.paths.slots, { slots: [] }).slots;
  const state = legacyState(folded);
  const byId = Object.fromEntries(store.contacts.map((x) => [x.id, x]));
  const c = {
    ...base,
    now,
    today: tc.today,
    dayState: tc.dayState,
    store,
    triage: compat.triage,
    short: compat.shortlist,
    slots,
    // Built on first use, so a command that never reads the times works with any slots.json.
    get slotById() {
      return (this._slotById ||= Object.fromEntries(this.slots.map((s) => [s.id, s])));
    },
    state,
    folded,
    entries,
    byId,
    logBlocked: folded.damaged_anyone?.line || null,
    view
  };
  c.blocked = (id, kind = 'message') => blockReason(c, id, kind);
  return c;
}

// Every line this step writes goes to the ledger, with who caused it. The older entry names map onto the
// ledger's; "outboxed" is no longer a thing of its own (approved is outboxed).
const USER_TYPES = new Set([
  'approved',
  'dropped',
  'revise',
  'fresh_attempt',
  'review_skipped',
  'round_approved',
  'browser_send_opened',
  'release_cleared',
  'no_reply_said',
  'user_says_no_reply',
  'status_pasted',
  'stop',
  'removed',
  'added',
  'met',
  'declined',
  'bounced',
  'unbooked'
]);
// A touch the user approved (outboxed: the approval matches the current draft).
export const isOut = (status) => status === 'approved' || status === 'outboxed';
// --ids "c1, c2:2": the items, and each as { id, touch } (touch 1 when there's no ":touch").
export const idList = (s) =>
  String(s)
    .split(/[\s,]+/)
    .filter(Boolean);
export const touchSpec = (x) => {
  const [id, t] = x.split(':');
  return { id, touch: Number(t ?? 1) };
};
// The user's context files (who to meet, what you bring, voice), read once per command: no command reads them
// again after writing one.
export const skillsOf = (c) => (c._skills ||= contextFor(c.settings, c.event));
// "Is this slot booked by someone other than id?" for the bookings as they stand (a stopped person's don't count).
export const takenTest = (c) => {
  const by = new Map(
    Object.entries(c.state)
      .filter(([, s]) => s.booked && !s.stopped)
      .map(([cid, s]) => [s.booked, cid])
  );
  return (slot, id) => by.has(slot) && by.get(slot) !== id;
};
// The highest message touch sent to this person (0 when none; the confirmation, touch 0, doesn't count).
export const lastSentTouch = (st) =>
  Math.max(
    0,
    ...Object.keys(st.sent || {})
      .map(Number)
      .filter((t) => t > 0)
  );
// A slot's label in the event's time (fb when the slot is gone: the id, or whatever the caller has).
export const labelOf = (c, id, fb = id) => (c.slotById[id] ? slotLabel(c.slotById[id], c.event.time_zone, null, c.event.city) : fb);
export function led(c, e) {
  const RENAME = { checked: 'reply_checked', user_says_no_reply: 'no_reply_said', outboxed: null, removed: 'decide', added: 'decide' };
  const type = e.type in RENAME ? RENAME[e.type] : e.type;
  if (type === null) return null;
  const who =
    e.who ||
    (USER_TYPES.has(e.type) || e.via === 'user'
      ? 'user'
      : e.source === 'mailbox'
        ? 'mailbox'
        : ['crm', 'tasks'].includes(e.source) || e.via === 'crm task'
          ? 'crm'
          : e.via === 'calendar'
            ? 'calendar'
            : 'floorboss');
  const out = { ...e, type, who };
  delete out.via_user;
  if (e.type === 'removed') Object.assign(out, { group: 'skip', because: e.said || 'cut by you', said: e.said || 'cut by you' });
  if (e.type === 'added') Object.assign(out, { group: 'reach', because: e.said || 'added by you', said: e.said || 'added by you' });
  if (who === 'user' && !out.said && !out.because) out.said = 'reported by the user';
  const written = append(c.paths.ledger, out, c.now);
  // Kept in step with the file, so what this run reads of the ledger (ledgerTouch) includes what it just wrote.
  if (Array.isArray(c.entries) && c.entries[c.entries.length - 1] !== written) c.entries.push(written);
  return written;
}

// One answer to "may we contact this person?", asked again at every exit (todo, gate, outbox, summary,
// staging): the inputs, the decisions and the outcomes can all change after the gate. Null means yes.
// A coordinate note goes to a colleague, not the person, so only removals and drops block it.
export function blockReason(c, id, kind) {
  const st = c.state[id] || {};
  if (c.logBlocked && kind !== 'coordinate')
    return `line ${c.logBlocked} of the ledger is damaged and doesn't say whose it is (it may hold a stop): look at it, fix or delete the line, then run again`;
  if (st.log_damaged)
    return `line ${st.log_damaged} of the ledger, which names them, is damaged: check it (it may hold a stop), fix or delete the line, then run again`;
  if (st.removed) return 'removed';
  if (st.dropped) return 'dropped';
  if (kind === 'coordinate') return null;
  if (st.stopped) return 'said stop';
  const ct = c.byId[id];
  const r = c.view.resolved[id];
  if (!ct || !r) return 'no longer on the attendee list';
  if (r.group === 'skip') return r.says || 'left alone';
  if (r.group === 'check') return `to check first (${r.says}); decide at the triage gate`;
  if (r.group === 'colleague') return `a colleague holds this relationship (${r.says})`;
  if (r.group === 'in_touch') return `already in touch (${r.says}); decide warm at the triage gate for a warm note`;
  // Cut from the shortlist since (keep <n>, a cap, a re-run of the gate): an unsent message must not go.
  // (Someone who booked keeps their confirmation even if the shortlist was cut since.)
  if (!(c.short.approved || []).includes(id) && !(c.short.coordinate || []).includes(id) && !(kind === 'confirmation' || st.booked))
    return 'no longer on the shortlist';
  return null;
}

// Sending is on for this event: the user chose at least one channel floorboss may send on itself.
export const sendingOn = (settings) => (settings.sending?.channels || []).length > 0;

// What a draft is checked against. For event-app and LinkedIn notes, the user's app-note settings decide
// whether the times, the event name and the opt-out line belong in the note. ownFacts: the only things the
// note may say about the user's own experience or views.
// Someone the user already knows: their final group is warm (a CRM relationship, a customer, an open deal, or the
// user's own word). Only the final group counts: someone first called known and then reached as cold keeps the line,
// and so does a stranger who is warm only because their company is a customer (no CRM record of their own).
export const knownReader = (c, id) => {
  const f = c.triage.final?.[id];
  if (f?.group !== 'warm') return false;
  return !(!f.crm && f.account_note && /^at a customer$/i.test(String(f.warm_because || '')));
};

// The person's record id in the CRM: the one triage found, or the one floorboss created (or found after an import).
// The same offered times, in any order.
export const sameSlots = (a, b) => [...(a || [])].sort().join() === [...(b || [])].sort().join();
export const crmIdOf = (c, id) => c.triage.pre?.[id]?.crm?.crm_id || c.folded.people[id]?.crm_id || null;

// Someone to add to the connected CRM before their first email: the CRM was looked up for them and said it has
// nobody by that address or name, none was added since, and the user didn't say to go on without. A CRM that was
// never asked (it failed, the user went on without it, they were added later) says nothing about who it has, so
// nobody is created then: that could duplicate a record. Their first email waits until they're in (contact-list,
// the flow's crm_contacts step), so the CRM files their replies where floorboss reads them.
export function crmPending(c, id) {
  c.config ||= loadConfig();
  if (!c.config.connectors?.['crm.lookup']) return false;
  const ct = c.byId[id];
  if (!ct?.email || crmIdOf(c, id) || c.triage.pre?.[id]?.crm) return false;
  if (!c._crmMissed) {
    const f = inputFile(c, 'crm-records');
    const r = f ? validateCrmRecords(readJson(f, {})) : null;
    c._crmMissed = new Set((r?.not_found || []).map((q) => String(q).trim().toLowerCase()));
  }
  const missed = [ct.email, ct.name, `${ct.name} ${ct.company}`].some((q) =>
    c._crmMissed.has(
      String(q || '')
        .trim()
        .toLowerCase()
    )
  );
  return missed && !c.entries.some((e) => e.type === 'crm_create_declined' && (e.ids || []).includes(id));
}

// When floorboss planned each shortlisted person: anything the mailbox or CRM shows after this is new.
export function sinceOf(c) {
  const since = {};
  const base = c.short.approved_at || c.event.created_at || new Date(0).toISOString();
  for (const id of c.short.approved || []) since[id] = base;
  for (const e of c.entries) if (e.type === 'added' && e.id && !(since[e.id] && since[e.id] < e.at)) since[e.id] = e.at;
  return since;
}

export function segmentInfo(ctxSkills, slug) {
  const seg = parseSegments(ctxSkills.whoToMeet || '').find((s) => s.slug === slug);
  return seg ? { slug: seg.slug, name: seg.name, ask: seg.ask, guidance: seg.body.trim() } : null;
}

// The colleague has the coordinate note: the user passed it on, or its CRM task is done.
export const colleagueTold = (st) => !!st.note_passed || Object.values(st.tasks || {}).some((t) => t.kind === 'coordinate' && t.done);

// Someone away (an out-of-office): noted beside the follow-ups, which keep their days.
export const awayNote = (until) => `away until ${until}: follow-ups go on as planned`;
