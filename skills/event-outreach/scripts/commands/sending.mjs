// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Sending: the list of approved messages due now, staged drafts, and recording what each send did.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { allowedPath, home } from '../../../../lib/paths.mjs';
import { need } from '../../../../lib/args.mjs';
import { readJson, writeJson } from '../../../../lib/jsonio.mjs';
import { noDayWhy, stateOf } from '../../../../lib/spacing.mjs';
import { readLedger, append } from '../../../../lib/ledger.mjs';
import { touchBefore } from '../../../../lib/route.mjs';
import { approvalHash, verifySend, readersOf, withFallbacks, userWordCounts, sentOrGoingToday, addressBusyToday, busyWhy, markerOnly, homeSends, IN_FLIGHT, CHANGED_ELSEWHERE } from '../../../../lib/sendcheck.mjs';
import { validateReceipts } from '../../../connectors/scripts/tasks.mjs';
import { loadConfig, saveConfig } from '../../../../lib/config.mjs';
import { earlierWith, writtenInApp, toOf, sendRoute, appLimitReached, whereAt, routeOf, wentBeforeAt } from './routes.mjs';
import { syncReach } from './reach.mjs';
import { crmPending, lastSentTouch, ctxOf, led, sendingOn, idList, takenTest } from './context.mjs';
import { draftFiles, savedDraft, readTodo, staleFor, followupDayOf } from './saved-drafts.mjs';
import { rebuildOutbox, allOutboxCards } from './cards.mjs';
import { othersMoved } from './page-inputs.mjs';
import { lentAbout } from '../../../../lib/lent.mjs';
import { routineHeld, pickHold } from '../../../../lib/autosend/common.mjs';

// floorboss's own tests only (FLOORBOSS_TEST=1): a record line (FLOORBOSS_LIST_APPEND: {"event": "<another event's
// slug>", "line": {...}}) written once to that event's record right after a list's first check of the other events'
// records, as a command there landing while the list is made.
function testWriteDuringList(c) {
  if (process.env.FLOORBOSS_TEST !== '1' || !process.env.FLOORBOSS_LIST_APPEND) return;
  const { event, line } = JSON.parse(process.env.FLOORBOSS_LIST_APPEND);
  delete process.env.FLOORBOSS_LIST_APPEND;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(event)) || event === c.event.slug || !line || typeof line !== 'object') return;
  append(join(home(), 'events', event, 'ledger.jsonl'), line, c.now);
}
import { ticketByToken, emailBefore, handSentDraft, gmailReads, readWitness } from '../../../../lib/unattended-drafts.mjs';

// Approved emails not yet staged and not sent: exactly what to put in the mailbox, from floorboss's files.
// Approved, not sent, not staged, and still allowed: removed, dropped and suppressed people are checked
// again here, because they can change after the gate.
// unattended: the list an unattended run stages from (stage-list --unattended, only inside a ticketed run): email
// follow-ups too when email sending is on, since that run puts them in the drafts instead of sending them. held: the
// people another event's message holds today, with why (said by stage-list).
function stageable(c, { unattended = false, held = [] } = {}) {
  const out = [];
  const today = c.today;
  // The event is over (today in its time past its last day), or its dates can't be read: nothing is put in the mailbox
  // for it (lib/spacing.mjs stateOf, the answer the guard gives too).
  if (stateOf(c).state !== 'ok') return out;
  const listed = new Set();
  const sends = homeSends();
  for (const card of allOutboxCards(c)) {
    if (!['message', 'confirmation'].includes(card.kind) || card.channel !== 'email' || !card.address) continue;
    // A follow-up is staged on its day, as everything else reads it (the one rule): not before, and not while it waits
    // for the message before it or has no day at all.
    if (card.due_on !== undefined && (!card.due_on || card.due_waits || card.due_on > today)) continue;
    // One message a day to one person: the earliest step goes today, the next another day.
    if (listed.has(card.id) || (card.touch !== 0 && sentOrGoingToday(c.entries, c.state[card.id] || {}, card, c.paths.dir, c.now.getTime()) != null)) continue;
    // With email sending on, floorboss sends the messages itself (send-list); only confirmations are staged.
    if (card.kind === 'message' && (c.settings.sending?.channels || []).includes('email') && !(unattended && card.touch > 1)) continue;
    const st = c.state[card.id] || {};
    if (c.blocked(card.id) || (card.kind !== 'confirmation' && (st.replied || st.booked))) continue;
    const tt = st.touches?.[card.touch] || {};
    if (tt.staged || tt.stage_released || st.sent?.[card.touch]) continue;
    // A draft goes into the mailbox only after the step before it went, a LinkedIn step that hasn't gone passed over:
    // the guard's staging rule (hooks/guard/sends.mjs stageRefusal).
    if (card.touch > 1 && wentBeforeAt(c, card.id, card.touch) > 0 && !st.sent?.[wentBeforeAt(c, card.id, card.touch)]) continue;
    if (card.touch === 1 && crmPending(c, card.id)) continue;
    // One message a day to a person across all your events, by address (the guard's rule for a draft too): held, and
    // said, while another event's message to that address went or is going today.
    if (card.touch !== 0) {
      const busy = addressBusyToday(c.paths.dir, card.address, c.now.getTime(), card.id, sends);
      if (busy) {
        held.push({ id: card.id, touch: card.touch, why: busyWhy(busy, c.byId[card.id]?.name || card.id, card.address) });
        continue;
      }
    }
    const lastSent = lastSentTouch(st);
    // A follow-up goes in the thread of the message before it: the draft of it that went in, or the send floorboss made.
    const prev = card.touch > 1 ? earlierWith(st, card.touch, 'staged') || earlierWith(st, card.touch, 'sent_msg') : card.touch === 0 && lastSent ? st.touches?.[lastSent]?.staged : null;
    // For a draft tool that threads by the message it replies to (Gmail's replyToMessageId): the email that went
    // before it, as sent (the send tool's own answer as the guard read it), else its draft's message as the guard read it.
    const prevSent = card.touch > 1 ? earlierWith(st, card.touch, 'sent_msg') : null;
    listed.add(card.id);
    out.push({
      id: card.id,
      touch: card.touch,
      to: card.address,
      subject: card.subject || '',
      body: card.body,
      reply_in_thread: prev?.thread_id || null,
      reply_to_message_id: prevSent?.message_id || prev?.message_id || null,
      replaces: tt.stale_staged
        ? {
            draft_id: tt.stale_staged.draft_id,
            note: 'The draft already in the mailbox for this message is out of date. Ask the user to delete it there; floorboss never deletes.'
          }
        : undefined
    });
  }
  return out;
}

export function stageList(opts) {
  need(opts, 'event');
  syncReach(opts.event, opts);
  const c = ctxOf(opts.event, opts);
  const recipe = loadConfig().connectors?.stage_draft || null;
  // --unattended: only inside a scheduled run (its token names a ticket), never from an attended session.
  if (opts.unattended && !ticketByToken(process.env.FLOORBOSS_UNATTENDED))
    throw new Error('stage-list --unattended is for the scheduled run only (floorboss starts it with its own ticket).');
  // The other events' records as the view read them (ctxOf), checked before and after the items are listed, as
  // send-list does: each item records what the other events lend about its person (lib/lent.mjs), and the guard reads
  // it again when the draft is staged (hooks/guard/sends.mjs stageRefusal; for an unattended draft too,
  // hooks/guard/unattended.mjs), so a stop or a send recorded at another event since the list was made holds the
  // draft. A record that changed while the list was made holds every item.
  const othersChanged = othersMoved(c.paths.dir, c.inputsAt);
  testWriteDuringList(c);
  // listed_at: the guard stages an item only within 30 minutes of its listing (a stop or reply after that
  // can't be missed by a list made before it).
  const held = [];
  // In the scheduled run, on Gmail, after a floorboss draft you sent yourself: the follow-up replies to your email as
  // this run's own read of the thread showed it (Gmail may give the sent message a new id), never to an id from a
  // mailbox file. Nothing read yet: no reply id, and the run holds it.
  const session = opts.unattended ? ticketByToken(process.env.FLOORBOSS_UNATTENDED)?.session || null : null;
  const gmail = opts.unattended && !!gmailReads(loadConfig());
  const replyIdOf = (x) => {
    if (!gmail || !session || !(x.touch > 1) || !handSentDraft(emailBefore(c.folded.people?.[x.id], x.touch, x.to)?.x)) return x.reply_to_message_id;
    const mw = readWitness(session, opts.event, x.id, 'mail');
    return mw?.readable && mw.own_last?.id ? String(mw.own_last.id) : null;
  };
  // A step the daily Claude routine sends (common.mjs routineHeld) is never staged here as well.
  const listed = stageable(c, { unattended: !!opts.unattended, held }).filter((x) => {
    const r = routineHeld(c.event, c.entries, x.id, x.touch);
    if (r) held.push({ id: x.id, touch: x.touch, why: r });
    return !r;
  }).map((x) => ({
    ...x,
    reply_to_message_id: replyIdOf(x),
    listed_at: c.now.toISOString(),
    elsewhere: othersChanged ? CHANGED_ELSEWHERE : lentAbout(c.paths.dir, { ...(c.folded.people[x.id] || {}), emails: [x.to].filter((y) => /@/.test(String(y || ''))) })
  }));
  // Changed while the list was made: every item is marked so and kept in the file (so a later list still knows it was
  // listed), and the guard holds each one (lib/sendcheck.mjs lentChanged). None is to stage.
  const moved = othersChanged || (listed.length > 0 && othersMoved(c.paths.dir, c.inputsAt));
  const list = moved ? listed.map((x) => ({ ...x, elsewhere: CHANGED_ELSEWHERE })) : listed;
  const waiting = moved ? list.map((x) => ({ id: x.id, touch: x.touch, why: 'another of your events changed while this list was made: run stage-list again' })) : [];
  const file = join(c.paths.dir, 'stage-list.json');
  // Items listed before with no receipt may already be in the mailbox (a run that stopped halfway).
  const before = new Set(readJson(file, []).map((x) => `${x.id}:${x.touch}`));
  const again = list.filter((x) => before.has(`${x.id}:${x.touch}`)).map((x) => x.id);
  writeJson(file, list);
  return {
    to_stage: moved ? 0 : list.length,
    ...(waiting.length ? { waiting } : {}),
    file,
    connected: recipe ? `${recipe.server} · ${recipe.tool}` : null,
    listed_before: again.length ? again : undefined,
    listed_before_note: again.length
      ? 'These were listed in an earlier run with no receipt saved. Check the mailbox drafts for them before creating them again, and save receipts for any that exist.'
      : undefined,
    out_of_date_in_mailbox: list.filter((x) => x.replaces).map((x) => ({ id: x.id, draft_id: x.replaces.draft_id })),
    held: held.length ? held : undefined,
    // Over, or its dates can't be read: nothing is put in the mailbox for it, and it says why.
    note: stateOf(c).state !== 'ok' ? `Nothing is put in your drafts for ${c.event.name}: ${stateOf(c).why}.` : undefined,
    rule: 'Create one draft per item with the stage_draft recipe, using to, subject and body exactly as written in the file. Follow-ups with reply_in_thread go in that thread when the tool allows it. Never send.'
  };
}

export function staged(opts) {
  need(opts, 'event', 'receipts-file');
  const c = ctxOf(opts.event, opts);
  const wanted = readJson(join(c.paths.dir, 'stage-list.json'), []);
  const r = validateReceipts(readJson(allowedPath(opts['receipts-file'])), wanted);
  if (r.errors.length) return { saved: false, errors: r.errors };
  const tool = loadConfig().connectors?.stage_draft?.tool || null;
  for (const x of r.receipts)
    led(c, { type: 'staged', id: x.id, touch: x.touch, draft_id: x.draft_id, thread_id: x.thread_id, message_id: x.message_id, tool });
  return { saved: true, staged: r.receipts.length, missing: wanted.length - r.receipts.length, outbox: rebuildOutbox(opts.event, opts, { force: true }).rebuilt };
}

// Why a step isn't an unclear send (null: it is one). An unclear send was let through with no outcome recorded since:
// its release in the ledger, or the guard's marker for it with no release, once no live guard can hold it (a guard
// stopped between the two may have let it go). A marker newer than that may be a call still going through: it isn't
// settled yet, so nothing can let the same message go a second time. Only the user's words settle one (send-list
// --resend, send-outcome).
function notUnclear(c, id, touch) {
  const x = c.folded.people[id]?.touches?.[touch];
  if (!x) return `there is no message ${touch} for ${id}`;
  if (x.sent || c.state[id]?.sent?.[touch]) return 'it was recorded as sent';
  if (x.released) return null;
  const mark = markerOnly(c.paths.dir, c.entries, id, touch);
  if (mark?.fresh) return IN_FLIGHT;
  if (mark) return null;
  if (c.entries.some((e) => e.type === 'send_released' && e.id === id && e.touch === touch))
    return 'it was already settled, by a bounce, send-outcome or an earlier resend: it is listed again on its own once it can go';
  return 'it was never let through';
}

// Replies are checked before a follow-up goes: the last mailbox or CRM sync or CRM task read
// must be recent, or nothing that could show a reply is connected and the user said so (--no-reply-check).
// send-list --event <slug> [--no-reply-check "<user's words>"]: the approved messages floorboss sends today,
// exactly as approved. First messages once approved; a follow-up on its day, if the one before it went, nobody
// replied, booked or said stop, its text is unchanged since approval, and (each_round) its round is approved.
export function sendList(opts) {
  need(opts, 'event');
  const changed = syncReach(opts.event, opts);
  const c = ctxOf(opts.event, opts);
  c.config = loadConfig();
  if (!sendingOn(c.settings)) throw new Error('Sending is off for this event: floorboss stages drafts for you to send. Turn it on in onboarding (sending).');
  const today = c.today;
  const roundOk = (id, t) =>
    c.settings.sending.followups === 'scheduled' || c.entries.some((e) => e.type === 'round_approved' && e.touch === t && (!e.ids || e.ids.includes(id)));
  const items = [],
    waiting = [],
    noReplyIds = [];
  const appUsed = writtenInApp(c);
  // A note in the send window the user opened keeps the reply check that let it in, for the window's life: the check
  // was asked once for the batch, and the window is short. Nothing outside the window is affected.
  const win = readJson(join(home(), 'browser-send.json'), null);
  const opened = win && !win.closed && win.event === c.event.slug && c.entries.filter((e) => e.type === 'browser_send_opened' && e.until === win.until && e.said).pop();
  const windowIds = opened && c.now.getTime() - Date.parse(opened.at) <= 20 * 60000 && Date.parse(win.until) > c.now.getTime() ? new Set(win.ids || []) : null;
  const only = opts.ids ? new Set(idList(opts.ids)) : null;
  // The other events' records as this command read them (the view, in ctxOf): unchanged since, or every item waits.
  // Checked again once every item is listed (below): a record written there in between is in the items' "elsewhere"
  // but not in the view they were judged by.
  const othersChanged = othersMoved(c.paths.dir, c.inputsAt);
  testWriteDuringList(c);
  // Every event's sends, looked at once for all the messages listed (lib/sendcheck.mjs addressBusyToday).
  const sends = homeSends();
  // --resend id:touch --said "<the user's words>": the user checked that a message let through earlier never
  // went, and says to send it again.
  if (opts.resend) {
    if (!opts.said || String(opts.said).trim().length < 3) throw new Error("--resend needs --said with the user's own words (they checked it didn't go).");
    // Only an unclear send can be sent again (the same check send-outcome makes): a step let through and not recorded
    // as sent, or one the guard was stopped on before its release was written (its marker with no release).
    const specs = idList(opts.resend).map((k) => k.split(':'));
    for (const [rid, rt] of specs) {
      const why = notUnclear(c, rid, Number(rt));
      if (why) throw new Error(`${rid} message ${rt} isn't waiting on an unclear send (${why}): nothing to send again.`);
    }
    for (const [rid, rt] of specs) led(c, { type: 'release_cleared', id: rid, touch: Number(rt), said: String(opts.said).slice(0, 200) });
    c.entries = readLedger(c.paths.ledger).entries;
  }
  for (const { file, id, t: tt } of draftFiles(c)) {
    const t = Number(tt);
    const st = c.state[id] || { sent: {}, touches: {} };
    if (st.touches?.[t]?.skipped) continue;
    // The kind, the booking, the plan and the thread are the ledger's (savedDraft) when the working copy is still
    // the saved text; one changed by hand fails the approval's fingerprint below.
    const raw = readJson(file, null);
    const d = raw && (savedDraft(c, id, t, raw) || { ...raw, kind: st.touches?.[t]?.kind || raw.kind });
    if (!d || !['message', 'confirmation'].includes(d.kind) || st.sent?.[t]) continue;
    if (only && !only.has(id) && !only.has(`${id}:${t}`)) continue;
    const appr = st.touches?.[t]?.approved;
    if (!appr) continue;
    // An event sending through a daily Claude routine: a step with a standing auto-send yes is the routine's (a Gmail
    // draft it sends on its day), never Claude Code's too; only message 1 its run let go now is listed here.
    {
      const r = routineHeld(c.event, c.entries, id, t, appr.hash);
      if (r) {
        waiting.push({ id, touch: t, why: r });
        continue;
      }
    }
    // The user's pick at the final approval (lib/autosend/pick.mjs) was Gmail drafts (2) or "I'll send them myself"
    // (3): floorboss never sends it, so it is never listed (and the guard has nothing of it to let through).
    // At an event sending through a daily Claude routine, an email no pick stands for waits for the final approval.
    {
      const why = pickHold(c.event, c.entries, id, t, appr.hash, appr.to);
      if (why) {
        waiting.push({ id, touch: t, why });
        continue;
      }
    }
    // Only an email waits: the CRM files mail, and contact-list lists only people emailed.
    if (t === 1 && /@/.test(appr.to || '') && crmPending(c, id)) {
      waiting.push({
        id,
        touch: t,
        why: "not in your CRM yet: they're added first (the crm_contacts step), so their replies are filed where floorboss reads them"
      });
      continue;
    }
    // A confirmation goes only while the booking it confirms stands.
    if (d.kind === 'confirmation' && (!st.booked || (d.booked_slot && d.booked_slot !== st.booked))) {
      waiting.push({ id, touch: t, why: 'the booking this confirms changed or was cancelled: redraft it' });
      continue;
    }
    if (!appr.hash || appr.hash !== approvalHash(d, toOf(c, { ...d, id, touch: t }))) {
      waiting.push({
        id,
        touch: t,
        why: 'its text, channel or recipient changed after you approved it (or it was approved before fingerprints): approve it again'
      });
      continue;
    }
    // A confirmation is for someone who booked; a reply or a booking stops everything else.
    const why =
      c.blocked(id) || (st.stopped ? 'they said stop' : d.kind === 'confirmation' ? null : st.replied ? 'they replied' : st.booked ? 'they booked' : null);
    // Said for every step, the first message too: an approved message never drops off the list unsaid.
    if (why) {
      waiting.push({ id, touch: t, why: `not sent: ${why}` });
      continue;
    }
    // With sending on, a first message goes only with its whole sequence approved: every planned follow-up in
    // todo is approved too (the gate approves them together; this holds if anything slipped past it).
    if (t === 1 && d.kind === 'message' && sendingOn(c.settings)) {
      const planned = (readTodo(c, null)?.jobs || []).filter((x) => x.id === id && x.kind === 'message' && x.touch > 1);
      // A follow-up the user dropped isn't part of the sequence any more.
      const open = planned
        .filter((x) => st.touches?.[x.touch]?.status !== 'dropped')
        .filter((x) => {
          return !st.touches?.[x.touch]?.approved || staleFor(c, x.id, x.touch, savedDraft(c, x.id, x.touch) || readJson(x.draft_file, null));
        });
      if (open.length) {
        waiting.push({ id, touch: t, why: `not sent: follow-up ${open.map((x) => x.touch - 1).join(', ')} of its sequence isn't approved yet` });
        continue;
      }
    }
    if (t > 1) {
      // A LinkedIn step before it that hasn't gone is passed over (the guard's rule, lib/sendcheck.mjs).
      const beforeT = wentBeforeAt(c, id, t);
      const prev = st.sent?.[beforeT];
      // Every step before it was skipped (beforeT 0): it goes as a first message would.
      if (!prev && beforeT > 0) continue;
      // Written for a first message that has changed since (and was approved again): written again first.
      if (staleFor(c, id, t, d)) {
        waiting.push({ id, touch: t, why: beforeT === 0 ? 'message 1 could not be delivered: this is now the first message, written again for your approval' : 'the message before it changed after it was written: it needs a new draft' });
        continue;
      }
      // The day it was planned and approved for, never sooner than its gap after the message before it actually went;
      // a follow-up drafted later, or planned with other gaps than the user's now, goes its gap after that send. The
      // outbox and the guard work it out the same way (lib/spacing.mjs followupDay).
      const r = followupDayOf(c, id, t, d);
      const due = r.day;
      if (!due) {
        waiting.push({ id, touch: t, why: noDayWhy(r) });
        continue;
      }
      if (due > today) continue;
      // Offering times that are gone (booked by someone else, or already past): redraft before it goes.
      const bookedByOther = takenTest(c);
      const { slotById } = c;
      const gone = (d.slot_ids || []).filter((x) => bookedByOther(x, id) || (slotById[x] && Date.parse(slotById[x].start) <= c.now.getTime()));
      if (gone.length) {
        waiting.push({ id, touch: t, why: `it offers times that are gone (${gone.join(', ')}): redraft it with new times and approve it again` });
        continue;
      }
      if (!roundOk(id, t)) {
        waiting.push({ id, touch: t, why: `follow-up ${t - 1} is due: approve the round (approve-round --touch ${t} --said "<their words>")` });
        continue;
      }
      // The user's own word that nobody replied counts only where nothing connected can look, and only for the
      // people listed now (and for 90 seconds, like any check).
      if (opts['no-reply-check']) {
        const email = d.channel === 'email';
        // The same rule as the guard's: the user's word counts only where nothing floorboss can read could see
        // their reply (a CRM read that showed it hasn't seen their email, or a reader the user answers for).
        const rdr = withFallbacks(readersOf({ connectors: c.config?.connectors || {} }), c.folded);
        const sentAtMs = Date.parse(st.sent_at?.[beforeT] || `${prev}T00:00:00Z`) || 0;
        const canCheck = !userWordCounts(c.entries, id, email ? 'email.send' : 'browser', rdr, sentAtMs);
        if (canCheck) {
          waiting.push({
            id,
            touch: t,
            why: `floorboss can look at their replies (${email ? 'mailbox or CRM' : 'CRM'}): check this person instead of saying nobody replied`
          });
          continue;
        }
        noReplyIds.push(id);
      }
    }
    const route = sendRoute(c, id, d.channel, t);
    if (route?.via === 'browser' && route.where !== 'LinkedIn' && t !== 0 && appLimitReached(c, id, appUsed)) {
      waiting.push({ id, touch: t, via: route.via, where: route.where, why: `the app's request limit (${c.settings.app_request_limit}) is used up: it stays here until someone else is cut` });
      continue;
    }
    if (!route || !route.to) {
      waiting.push({ id, touch: t, why: route?.why || (d.channel === 'paste' && (routeOf(c, id) ? routeOf(c, id)[t - 1] === 'linkedin' : whereAt(c, id, t) === 'LinkedIn') ? 'you send this one yourself on LinkedIn' : 'no way for floorboss to send it on this channel: it stays in the outbox for you') });
      continue;
    }
    // Said about the inbox this message goes to: it answers for that one only (lib/sendcheck.mjs lastReplyCheck).
    const channel = route.via === 'email.send' ? 'email' : route.via === 'browser' ? (route.where === 'LinkedIn' ? 'linkedin' : 'app') : null;
    if (
      noReplyIds.includes(id) &&
      !c.entries.some((e) => ['no_reply_said', 'user_says_no_reply'].includes(e.type) && e.ids?.includes(id) && (e.channel || null) === channel && c.now.getTime() - Date.parse(e.at) < 60000)
    ) {
      const e = led(c, { type: 'user_says_no_reply', ids: [id], ...(channel ? { channel } : {}), said: String(opts['no-reply-check']).slice(0, 200) });
      c.entries.push(e);
    }
    // The thread to reply in: the message before it (a confirmation: the last one that went).
    const prevMsg = t > 1 ? (d.channel === 'email' ? earlierWith(st, t, 'sent_msg') : st.touches?.[t - 1]?.sent_msg) : t === 0 ? st.touches?.[lastSentTouch(st)]?.sent_msg : null;
    const item = {
      id,
      touch: t,
      name: c.byId[id]?.name,
      via: route.via,
      where: route.where || undefined,
      to: route.to,
      subject: d.subject || '',
      body: d.body,
      thread_id: prevMsg?.thread_id || null,
      reply_to_message_id: prevMsg?.message_id || null,
      listed_at: c.now.toISOString(),
      // What the user's other events lend about this person, as this list read them (lib/lent.mjs): the send check reads
      // it again at the send. Changed while this command read them: the send waits until the list is made again.
      elsewhere: othersChanged ? CHANGED_ELSEWHERE : lentAbout(c.paths.dir, { ...(c.folded.people[id] || {}), emails: [route.to].filter((x) => /@/.test(String(x || ''))) })
    };
    const inWindow = item.via === 'browser' && !!windowIds?.has(`${id}:${t}`);
    const v = verifySend(item, { evDir: c.paths.dir, settings: c.settings, state: c.state, entries: c.entries, folded: c.folded, nowMs: c.now.getTime(), replyCheck: !inWindow, sends });
    if (!v.ok) {
      waiting.push({ id, touch: t, via: item.via, where: item.where || null, why: v.why, check: v.check });
      continue;
    }
    if (item.via === 'browser' && item.where !== 'LinkedIn' && t !== 0) appUsed.add(id);
    items.push(item);
  }
  // Another event's record written while the items were listed (after the check above, before their "elsewhere" was
  // taken): what an item lends may already hold it, while the view that judged the item didn't. Every item is marked so,
  // as a page built meanwhile is (page-inputs.mjs sealPageInputs), and waits: the send check refuses a marked item.
  if (!othersChanged && items.length && othersMoved(c.paths.dir, c.inputsAt))
    for (const x of items.splice(0)) {
      x.elsewhere = CHANGED_ELSEWHERE;
      const v = verifySend(x, { evDir: c.paths.dir, settings: c.settings, state: c.state, entries: c.entries, folded: c.folded, nowMs: c.now.getTime(), replyCheck: false });
      waiting.push({ id: x.id, touch: x.touch, via: x.via, where: x.where || null, why: v.ok ? 'another of your events changed while this list was made: make the list again' : v.why });
    }
  // One message a day to one person: the earliest step listed goes today; any other waits for another day.
  items.sort((a, b) => String(a.id).localeCompare(String(b.id)) || a.touch - b.touch);
  for (let i = items.length - 1; i >= 0; i--)
    if (items.findIndex((x) => x.id === items[i].id) !== i) {
      const [x] = items.splice(i, 1);
      waiting.push({ id: x.id, touch: x.touch, via: x.via, where: x.where || null, why: `another message to ${x.name || x.id} is listed today: this one goes on another day` });
    }

  writeJson(
    join(c.paths.derived, 'send-list.json'),
    items.filter((x) => x.via !== 'browser')
  );
  writeJson(
    join(c.paths.derived, 'browser-send-list.json'),
    items.filter((x) => x.via === 'browser')
  );
  return {
    ...(changed ? { channels_changed: changed } : {}),
    to_send: items.length,
    by_email: items.filter((x) => x.via === 'email.send').length,
    by_chat: items.filter((x) => x.via === 'chat.send').length,
    in_browser: items.filter((x) => x.via === 'browser').length,
    waiting,
    file: join(c.paths.derived, 'send-list.json'),
    browser_file: join(c.paths.derived, 'browser-send-list.json'),
    rule: "Send each item in send-list.json with its recipe (email.send or chat.send), using to, subject and body exactly as written, one call per item, then record the receipts with outreach sent. Follow-ups: check that one person's replies right before sending to them (sync just them, then send-list --ids <id>, then send): a check counts for 90 seconds. Claude Code asks the user before each send. For browser items, run browser-send first."
  };
}

// sent --event <slug> --receipts-file <file>: what floorboss's sends returned ({"sends":[{id, touch, message_id}]}).
export function sentReceipts(opts) {
  need(opts, 'event', 'receipts-file');
  const c = ctxOf(opts.event, opts);
  const listed = [...readJson(join(c.paths.derived, 'send-list.json'), []), ...readJson(join(c.paths.derived, 'browser-send-list.json'), [])];
  const r = readJson(allowedPath(opts['receipts-file']));
  const list = Array.isArray(r) ? r : r?.sends;
  if (!Array.isArray(list)) throw new Error('expected {"sends":[{"id","touch","message_id"}]}');
  const today = c.today;
  const done = [],
    refused = [],
    dropped = [];
  for (const x of list) {
    // The list file is rewritten by every send-list call (--ids lists one person), so a receipt is matched
    // against the guard's release in the log first, and the list only as a fallback for browser items.
    const rel = [...c.entries].reverse().find((e) => e.type === 'send_released' && e.id === x?.id && e.touch === Number(x?.touch));
    const item = listed.find((i) => i.id === x?.id && i.touch === Number(x?.touch)) || (rel ? { id: rel.id, touch: rel.touch, via: rel.via, where: rel.where } : null);
    if (!item) {
      refused.push({ id: x?.id, touch: x?.touch, why: "the guard never let this send through, and it isn't on the send list" });
      continue;
    }
    // A receipt counts only for a send the guard actually let through (email, chat), or one made in a browser
    // window the user opened (app, LinkedIn): a receipt can't invent a send and start follow-ups.
    const released = c.entries.some((e) => e.type === 'send_released' && e.id === item.id && e.touch === item.touch);
    const inWindow = c.entries.some((e) => e.type === 'browser_send_opened' && (e.items || []).includes(`${item.id}:${item.touch}`));
    if (item.via === 'browser' ? !inWindow : !released) {
      refused.push({
        id: item.id,
        touch: item.touch,
        why: item.via === 'browser' ? 'no browser send window was opened for it' : 'the guard never let this send through'
      });
      continue;
    }
    if (item.via !== 'browser' && !x.message_id) {
      refused.push({ id: item.id, touch: item.touch, why: 'a send by email or chat needs the message id the tool returned' });
      continue;
    }
    if (c.state[item.id]?.sent?.[item.touch]) continue;
    // The ids that count are the guard's own reading of the send tool's answer (call_result). A receipt's id is kept
    // only where it is the guard's; one the guard didn't read (or read otherwise) is dropped, said so: a follow-up
    // never goes into a thread only a receipt names.
    const guardIds = [...c.entries].reverse().find((e) => e.type === 'call_result' && e.kind === 'send' && e.id === item.id && (e.touch ?? 1) === item.touch) || null;
    const keep = (k) => (x[k] && guardIds?.[k] != null && String(x[k]) === String(guardIds[k]) ? { [k]: String(x[k]).slice(0, 200) } : {});
    for (const k of ['message_id', 'thread_id'])
      if (x[k] && !keep(k)[k]) dropped.push({ id: item.id, touch: item.touch, [k]: String(x[k]).slice(0, 80), why: guardIds?.[k] ? "it isn't the one the send tool answered" : "the send tool's answer, as floorboss's guard read it, gave none" });
    led(c, {
      type: 'sent',
      id: item.id,
      touch: item.touch,
      date: today,
      via: 'floorboss',
      hash: rel?.hash || c.state[item.id]?.touches?.[item.touch]?.approved?.hash || undefined,
      channel: item.via === 'browser' ? item.where : item.via,
      ...keep('message_id'),
      ...keep('thread_id')
    });
    done.push(`${item.id}:${item.touch}`);
  }
  return { recorded: done, refused, ...(dropped.length ? { ids_not_kept: dropped } : {}) };
}

// send-failed --event <slug> --id <c…> --touch <n> --error <text>: the send call the guard let through failed
// or never answered. It may have gone, so nothing is sent to them again until someone has looked (send-outcome).
export function sendFailed(opts) {
  need(opts, 'event', 'id', 'touch');
  const c = ctxOf(opts.event, opts);
  const touch = Number(opts.touch);
  const x = c.folded.people[opts.id]?.touches?.[touch];
  if (!x?.released || x.sent) throw new Error(`${opts.id} message ${touch} wasn't let through without a receipt: nothing to mark.`);
  const error = String(opts.error || 'the tool gave no answer').slice(0, 300);
  led(c, { type: 'send_unclear', who: 'floorboss', id: opts.id, touch, error });
  led(c, { type: 'tool_failed', who: 'floorboss', task: 'email.send', error });
  return { unclear: `${opts.id}:${touch}`, next: 'Find out whether it went (the mailbox, or ask the user to look in Sent) before anything else is sent.' };
}

// send-outcome --event <slug> --id <c…> --touch <n> --went yes|no [--message-id --thread-id] [--said <words>]
// [--file <{went, message_id, thread_id, said}>]: whether an unclear send went. "yes" records it as sent (with
// the ids the mailbox shows, when it was checked there); "no" clears the release so it can be sent again,
// with the prompt again.
export function sendOutcome(opts) {
  need(opts, 'event');
  const f = opts.file ? readJson(allowedPath(opts.file)) : {};
  const id = opts.id || f.id,
    touch = Number(opts.touch ?? f.touch);
  const went = String(opts.went ?? f.went).toLowerCase();
  const c = ctxOf(opts.event, opts);
  const x = c.folded.people[id]?.touches?.[touch];
  {
    const why = notUnclear(c, id, touch);
    if (why) throw new Error(`${id} message ${touch} isn't waiting on an unclear send (${why}).`);
  }
  const said = String(opts.said || f.said || '').trim();
  const fromMailbox = !!(opts['message-id'] || f.message_id) || opts.from === 'mailbox' || f.source === 'mailbox';
  if (!fromMailbox && said.length < 2) throw new Error('Say what the user found, in their words (--said "it\'s in my Sent folder").');
  if (/^(yes|true|it went|went|sent)$/.test(went)) {
    // A note typed in LinkedIn or the event app went there: app-result records where, and here it would be recorded
    // as an email, so the inbox it went to would never be checked for their reply.
    if (x.released_via === 'browser' || (!x.released && x.approved?.via === 'browser'))
      throw new Error(`${id} message ${touch} was typed in the browser: record that it went with app-result --result sent and the user's words, not send-outcome.`);
    led(c, {
      type: 'sent',
      who: fromMailbox ? 'mailbox' : 'user',
      id,
      touch,
      date: c.today,
      via: 'floorboss',
      hash: x.approved?.hash || x.hash,
      channel: 'email',
      message_id: opts['message-id'] || f.message_id || null,
      thread_id: opts['thread-id'] || f.thread_id || null,
      source: fromMailbox ? 'mailbox' : 'user',
      ...(said ? { said } : {})
    });
    return { recorded: 'sent', thread: opts['thread-id'] || f.thread_id || null };
  }
  if (/^(no|false|did not go|didn't go|not sent)$/.test(went)) {
    // The mailbox not showing it isn't proof it didn't go (a call that timed out may not show in Sent yet):
    // the user looks before it can go again.
    if (fromMailbox && !said) {
      led(c, { type: 'answered', who: 'mailbox', ask: 'sent_check', value: `not found:${id}:${touch}` });
      return { recorded: 'not found in the mailbox', next: 'Ask the user to look in Sent before it can go again.' };
    }
    led(c, { type: 'release_cleared', who: fromMailbox ? 'mailbox' : 'user', id, touch, said: said || 'the mailbox shows no such message' });
    return { recorded: 'not sent', next: 'It can be sent again; Claude Code asks again before it goes.' };
  }
  throw new Error('--went is yes or no.');
}

// app-result --event <slug> --file <{id, touch, result, page_says}> (or --id --touch --result --page-says):
// what the event app's page said after a note was sent in the browser. sent: recorded as sent. not_found or
// messages_off: that app step is skipped (only an app step, typed in a send window opened for it), with the page's
// words kept quoted as data; the person's other steps keep their days. too_long: the note goes back to be
// shortened. limit: today's sending in the app stops. logged_out: the app needs the user to log in.
// failed (the page said nothing clear, or the browser call failed): the user looks in the app first.
const APP_RESULTS = ['sent', 'not_found', 'messages_off', 'too_long', 'limit', 'logged_out', 'failed'];
export function appResult(opts) {
  need(opts, 'event');
  const f = opts.file ? readJson(allowedPath(opts.file)) : {};
  const id = opts.id || f.id,
    touch = Number(opts.touch ?? f.touch);
  const result = String(opts.result || f.result || '');
  const page = String(opts['page-says'] || f.page_says || '').slice(0, 300);
  if (!APP_RESULTS.includes(result)) throw new Error(`result is one of ${APP_RESULTS.join(', ')}.`);
  const c = ctxOf(opts.event, opts);
  if (!c.folded.people[id]?.touches?.[touch]) throw new Error(`${id} has no message ${touch}.`);
  if (result === 'sent') {
    const inWindow = c.entries.some((e) => e.type === 'browser_send_opened' && (e.items || []).includes(`${id}:${touch}`));
    if (!inWindow) throw new Error("No browser send window was opened for this note: it can't be recorded as sent.");
    const said = String(opts.said || f.said || '').trim();
    if (!said && !/sent|delivered|request sent/i.test(page)) throw new Error("Give the page's own words saying it was sent (page_says), or the user's (said).");
    if (said) {
      led(c, {
        type: 'sent',
        who: 'user',
        id,
        touch,
        date: c.today,
        via: 'floorboss',
        channel: whereAt(c, id, touch) === 'LinkedIn' ? 'LinkedIn' : c.event.app_name || 'the event app',
        hash: c.folded.people[id].touches[touch].approved?.hash || undefined,
        source: 'user',
        said: said.slice(0, 200)
      });
      return { recorded: 'sent (the user saw it in the app)' };
    }
  }
  led(c, { type: 'app_result', who: 'floorboss', id, touch, result, page_says: page });
  // A note typed and let through that the page says didn't go is settled, or it could never be sent again: only a
  // browser release for a note in a window the user opened (an email's release waits for the mailbox or the user).
  const typed = c.folded.people[id].touches[touch];
  const windowed = c.entries.some((e) => e.type === 'browser_send_opened' && (e.items || []).includes(`${id}:${touch}`));
  if (result !== 'sent' && result !== 'failed' && typed.released && typed.released_via === 'browser' && windowed && !typed.sent && !typed.release_cleared)
    led(c, { type: 'release_cleared', who: 'floorboss', id, touch, said: page || `the app said ${result}` });
  // The app says this person can't be written to there: that step is skipped and the person's other steps (email,
  // LinkedIn) keep their days; nothing is written in its place. Only an event-app step, typed in a send window opened
  // for it, and never one that went or was let through some other way. The page's words are kept quoted, as data.
  const isApp = whereAt(c, id, touch) !== 'LinkedIn' && (routeOf(c, id)?.[touch - 1] === 'app' || (!!typed.approved?.where && typed.approved.where !== 'LinkedIn'));
  const otherRelease = typed.released && typed.released_via !== 'browser' && !typed.release_cleared;
  if (['not_found', 'messages_off'].includes(result) && isApp && windowed && !typed.sent && !otherRelease) {
    const words = page.replace(/["\u201c\u201d]/g, "'").replace(/\s+/g, ' ').trim().slice(0, 200);
    led(c, { type: 'step_skipped', who: 'floorboss', id, touch, reason: `${c.event.app_name || 'The event app'} said: "${words || (result === 'not_found' ? 'not found' : 'messages are turned off')}"` });
    withdrawFirstContact(c, id, touch);
  }
  if (result === 'sent')
    led(c, {
      type: 'sent',
      who: 'floorboss',
      id,
      touch,
      date: c.today,
      via: 'floorboss',
      channel: whereAt(c, id, touch) === 'LinkedIn' ? 'LinkedIn' : c.event.app_name || 'the event app',
      hash: c.folded.people[id].touches[touch].approved?.hash || undefined,
      source: 'app'
    });
  if (result === 'too_long') {
    // The page's own cap ("335/200 characters") becomes the limit, so the redraft fits instead of looping.
    const cap = Number((/\d+\s*\/\s*(\d+)\s*characters/i.exec(page) || [])[1]);
    const li = whereAt(c, id, touch) === 'LinkedIn';
    if (cap > 20) saveConfig(li ? { linkedin_note_limit: cap } : { paste_limit: cap });
    led(c, {
      type: 'revise',
      who: 'floorboss',
      id,
      touch,
      feedback: `${li ? 'LinkedIn' : 'the app'} refused it as too long (${page}): shorten it to ${cap > 20 ? `${cap} characters` : 'fit'}`
    });
  }
  if (result === 'logged_out') led(c, { type: 'tool_failed', who: 'floorboss', task: 'app.send', error: page || 'the app asks to log in' });
  return { recorded: result };
}

// tool-failed --event <slug> --task <task> --error <text>: a connected tool failed (a lookup, a reply check).
// tool-back --event <slug> --task <task> --said <words>: the user says it works again.
export function toolFailed(opts) {
  need(opts, 'event', 'task');
  const c = ctxOf(opts.event, opts);
  led(c, { type: 'tool_failed', who: 'floorboss', task: String(opts.task), error: String(opts.error || '').slice(0, 300) });
  return { recorded: true };
}
export function toolBack(opts) {
  need(opts, 'event', 'task', 'said');
  const c = ctxOf(opts.event, opts);
  led(c, { type: 'tool_back', who: 'user', task: String(opts.task), said: String(opts.said).slice(0, 200) });
  return { recorded: true };
}

// browser-send --event <slug>: opens a 20-minute window in which the guard lets the browser click and type,
// for the approved app and LinkedIn messages in browser-send-list.json only. Floorboss can't check what a
// click sends, so the window is short and named in the log; outside it the browser only reads during a run.
export function browserSendCmd(opts) {
  if (opts.close) {
    const p = join(home(), 'browser-send.json');
    if (existsSync(p)) writeJson(p, { closed: true });
    return { closed: true };
  }
  return browserSend(opts);
}

function browserSend(opts) {
  need(opts, 'event');
  const c = ctxOf(opts.event, opts);
  if (!opts.said || String(opts.said).trim().length < 3)
    throw new Error("browser-send needs --said with the user's own words (their go-ahead to send in the app now).");
  const items = readJson(join(c.paths.derived, 'browser-send-list.json'), []).filter(
    (x) => verifySend(x, { evDir: c.paths.dir, settings: c.settings, state: c.state, entries: c.entries, folded: c.folded, nowMs: c.now.getTime() }).ok
  );
  if (!items.length) throw new Error('Nothing approved to send in the browser: run send-list first.');
  const until = new Date(c.now.getTime() + 20 * 60000).toISOString();
  writeJson(join(home(), 'browser-send.json'), { event: c.event.slug, ids: items.map((x) => `${x.id}:${x.touch}`), until, opened_at: c.now.toISOString() });
  led(c, { type: 'browser_send_opened', items: items.map((x) => `${x.id}:${x.touch}`), until, said: String(opts.said).slice(0, 200) });
  return {
    open_until: until,
    items: items.length,
    rule: "In the user's browser, open each person in the app (or LinkedIn), paste the body exactly as listed, pick the listed time if the app asks, and send. Only these messages, to these people. Then record each with outreach sent, and run outreach browser-send --close."
  };
}

// Every step before the person's next one was skipped (their first message couldn't be delivered): that step becomes
// their first contact (owner answer A1). Its approval as a follow-up no longer counts: it is written again as a first
// message and approved in the next batch. A step that went or was let through is never touched.
export function withdrawFirstContact(c, id, skippedTouch) {
  const p = c.folded.people[id];
  const st = { touches: Object.fromEntries(Object.entries(p?.touches || {}).map(([k, x]) => [k, { ...x, skipped: x.skipped || Number(k) === skippedTouch }])) };
  for (let t = skippedTouch + 1; t <= 10; t++) {
    const x = p?.touches?.[t];
    if (!x) break;
    if (st.touches[t]?.skipped) continue;
    if (touchBefore(st, t) === 0 && x.approved && !x.sent && !x.released && !x.staged && !x.stage_released)
      led(c, { type: 'approval_withdrawn', who: 'floorboss', id, touch: t, reason: 'message 1 could not be delivered: this is now the first message' });
    break;
  }
}
