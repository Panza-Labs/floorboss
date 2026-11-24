// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The run after the final approval (pick.mjs), one step at a time like drafts.mjs:
//   - Claude Code, pick 1 (an event sending through a daily Claude routine, routine.mjs): message 1 to each person is
//     sent from the session through Claude Code's own send (the send list, the guard's send check and its prompt, the
//     receipt); then each follow-up becomes a Gmail draft in its thread, read back and checked. The drafts are the
//     routine's queue (autosend_drafted). No labels.
//   - Either host, pick 2 (put them all in Gmail drafts): each message becomes a Gmail draft, read back and checked,
//     recorded as in your drafts (staged). Nothing is sent. Message 1 is a new email; a follow-up goes in the thread of
//     message 1 once that went, so a follow-up of a message 1 not sent yet waits until this runs again after it.
// Steps: send (Claude Code, pick 1), profile (Codex), draft, verify. What each draft must be is worked out from the
// ledger at that moment (approvedDraftItem), the same way floorboss's guard checks the create_draft call in Claude Code
// (hooks/guard/autosend-drafts.mjs). Any answer that isn't strictly one of the shapes read here is a stop, never a go.
// Nothing here sends or calls Gmail.
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync, readdirSync, mkdirSync, lstatSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeJson } from '../jsonio.mjs';
import { append, contactable } from '../ledger.mjs';
import { eventStateAt, approvalHash } from '../sendcheck.mjs';
import { eventDirOf, eventJson, ledgerOf, readEvent, draftOf, liveApproval, lastApproval, listChangedSince, stepMark, routineDraftsLeft, ROUTINE } from './common.mjs';
import { decisionFor, standingPick } from './approval.mjs';
import { sendsAtApproval, draftArgs, draftIds, verifyDraft, readArgs, TOOLS as CODEX_TOOLS } from './drafts.mjs';
import { readAnswer, profileEmail, sameAccount } from './replycheck.mjs';
import { touchBefore } from '../route.mjs';

const FLOORBOSS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FLOW = 'approved';
// The claude.ai Gmail connector's tools: mcp__claude_ai_Gmail__* in Claude Code, mcp__Gmail__* in a routine.
const gmail = (s) => Object.freeze([`mcp__claude_ai_Gmail__${s}`, `mcp__Gmail__${s}`]);
export const CLAUDE_TOOLS = Object.freeze({ draft: gmail('create_draft'), verify: gmail('get_draft') });
// create_draft as the connector takes it (to[], subject, body, replyToMessageId: examples/standins/gmail-real.mjs).
export const claudeDraftArgs = (item) => ({ to: [item.to], subject: item.subject, body: item.body, ...(item.reply_to_message_id ? { replyToMessageId: item.reply_to_message_id } : {}) });

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const ID = /^[\w-]{1,128}$/;
const fold = (v) => String(v ?? '').trim().toLowerCase();
const iso = (ms) => new Date(ms).toISOString();
export const RUN_OPEN_MS = 60 * 60 * 1000;
export class Refused extends Error {}

// ---- What one draft must be, now ----
// The approval it stands on, for this kind: pick 1's auto-send yes (live, the list unchanged since), or pick 2's.
// The latest pick wins (approval.mjs standingPick): a pick 1 after pick 2 is never drafted for pick 2, nor the other
// way round.
function standing(entries, id, touch, kind, hash) {
  const pick = standingPick(entries, id, touch, hash);
  if (kind === 'auto') {
    const a = liveApproval(entries, id, touch);
    return a && pick === 'auto' && !listChangedSince(entries, a, id) ? a : null;
  }
  const d = decisionFor(entries, id, touch, hash);
  return d?.type === 'drafts_approved' && pick === 'drafts' ? d : null;
}
// The ids of message 1 as sent. In Claude Code only the guard's own reading of the send tool's answer (the ledger's
// fold keeps nothing else); in Codex, the sent line's.
function firstSent(entries, folded, id, host) {
  const s = folded.people?.[id]?.touches?.[1]?.sent;
  if (!s) return null;
  if (host === 'claude-code') return ID.test(String(s.message_id || '')) && ID.test(String(s.thread_id || '')) ? { message_id: s.message_id, thread_id: s.thread_id } : null;
  const line = [...entries].reverse().find((e) => e?.type === 'sent' && e.id === id && (e.touch ?? 1) === 1);
  return line && ID.test(String(line.message_id || '')) && ID.test(String(line.thread_id || '')) ? { message_id: line.message_id, thread_id: line.thread_id } : null;
}
// { item } or { why }: the draft this step must be, from the ledger now. item: { id, touch, name, to, subject, body,
// hash, due, reply_to_message_id?, thread_id? }.
export function approvedDraftItem(evDir, id, touch, kind, nowMs, host = 'claude-code') {
  const { entries, folded } = readEvent(evDir);
  const p = folded.people?.[id];
  const x = p?.touches?.[touch];
  if (!x) return { why: `${id} has no message ${touch}` };
  if (x.sent) return { why: 'it was already sent' };
  const a = standing(entries, id, touch, kind, x.hash);
  if (!a) return { why: kind === 'auto' ? 'no standing yes to send it automatically (stopped, or the list changed since)' : 'no standing yes to put it in your drafts' };
  if (a.hash !== x.hash || x.approved?.hash !== a.hash || fold(x.approved?.to) !== fold(a.to)) return { why: 'it changed since the yes' };
  const d = draftOf(evDir, a.hash);
  if (!d || approvalHash(d, a.to) !== a.hash) return { why: "its approved text can't be read" };
  const held = contactable(folded, id, 'message', eventStateAt(evDir, nowMs).today);
  if (held) return { why: held };
  let reply = null;
  if (touch > 1 && touchBefore({ touches: p.touches }, touch) === 0) return { why: 'message 1 could not be delivered, so this first message waits for you to send it from the outbox' };
  if (touch > 1) {
    reply = firstSent(entries, folded, id, host);
    if (!reply) return { why: "message 1 isn't recorded sent with the ids Gmail gave it, so this can't go in its thread" };
  } else if (kind === 'auto') return { why: 'message 1 is sent at the approval, never drafted' };
  return { item: { id, touch, name: p.name || id, to: a.to, subject: d.subject || '', body: d.body || '', hash: a.hash, due: a.planned_due || null, ...(reply ? { reply_to_message_id: reply.message_id, thread_id: reply.thread_id } : {}) } };
}

// ---- The plan ----
const doneTypes = (kind) => (kind === 'auto' ? ['autosend_drafted', 'autosend_draft_bad'] : ['staged']);
export function approvedPlan(evDir, kind, host, nowMs) {
  const ev = eventJson(evDir) || {};
  const es = eventStateAt(evDir, nowMs);
  if (es.state !== 'ok') return { blocked: es.why || "the event's dates can't be read", queue: [], skipped: [] };
  const { entries, folded } = readEvent(evDir);
  // Done: drafted (or found bad) since the yes it stands on. A draft of an earlier yes, deleted since, is made again
  // for a fresh one (a new pick 1 after the list changed).
  const doneAt = new Map();
  entries.forEach((e, i) => {
    if (doneTypes(kind).includes(e?.type)) doneAt.set(`${e.id}:${e.touch ?? 1}`, i);
  });
  const yesAt = (id, t, hash) => (kind === 'auto' ? lastApproval(entries, id, t)?.at ?? -1 : entries.indexOf(decisionFor(entries, id, t, hash)));
  const done = { has: (k) => {
    const [id, t] = k.split(':');
    const at = doneAt.get(k);
    return at != null && at > yesAt(id, Number(t), folded.people?.[id]?.touches?.[t]?.hash);
  } };
  const queue = [];
  const skipped = [];
  for (const id of Object.keys(folded.people).sort()) {
    const p = folded.people[id];
    const ts = Object.keys(p.touches || {}).map(Number).filter((t) => t >= 1).sort((a, b) => a - b);
    // A Gmail draft the daily routine may still send (routineDraftsLeft) is never made a second time, by either kind.
    const mine = ts.filter((t) => !p.touches[t].sent && !p.touches[t].skipped && !done.has(`${id}:${t}`) && standing(entries, id, t, kind, p.touches[t].hash) && !routineDraftsLeft(entries, id, t).length);
    if (!mine.length) continue;
    const held = contactable(folded, id, 'message', es.today);
    if (held) {
      skipped.push({ id, why: held });
      continue;
    }
    if (mine[0] === 1) {
      if (kind === 'auto') {
        const a = liveApproval(entries, id, 1);
        if (stepMark(entries, id, 1)) {
          skipped.push({ id, why: "message 1 was let go before and isn't settled: check Sent and record it first" });
          continue;
        }
        if (!sendsAtApproval(ev, a?.planned_due, es.today, nowMs)) {
          skipped.push({ id, why: "message 1 can only go now, during sending hours (weekdays, 09:00 to 17:00 in the event's time zone): show the readback again then" });
          continue;
        }
        queue.push({ step: 'send', id, touch: 1 }, ...mine.slice(1).map((t) => ({ step: 'draft', id, touch: t })));
      } else {
        queue.push({ step: 'draft', id, touch: 1 });
        if (mine.length > 1) skipped.push({ id, why: `message${mine.length > 2 ? 's' : ''} ${mine.slice(1).join(', ')} go${mine.length > 2 ? '' : 'es'} in the thread of message 1, so ${mine.length > 2 ? 'they wait' : 'it waits'} until you send message 1: then run this again` });
      }
      continue;
    }
    // Every step before it was skipped (message 1 couldn't be delivered): it is their first message, and it waits for
    // the user to send it from the outbox; it is never drafted in a thread that doesn't exist.
    if (touchBefore({ touches: p.touches }, mine[0]) === 0) {
      skipped.push({ id, why: 'message 1 could not be delivered, so this first message waits for you to send it from the outbox' });
      continue;
    }
    if (!firstSent(entries, folded, id, host)) {
      skipped.push({ id, why: "message 1 isn't recorded sent with the ids Gmail gave it, so its follow-ups can't go in its thread" });
      continue;
    }
    queue.push(...mine.map((t) => ({ step: 'draft', id, touch: t })));
  }
  return { blocked: null, queue, skipped };
}

// ---- The run ----
const runsDir = (home) => join(home, 'autosend', 'drafts-runs');
const runFile = (home, run) => join(runsDir(home), `${run}.json`);
const answerDir = (run) => join(tmpdir(), 'floorboss-drafts', run);
const RUN_RE = /^[\w-]{1,64}$/;
const save = (home, r) => writeJson(runFile(home, r.run), r);
export function loadRun(home, run) {
  if (!RUN_RE.test(String(run || ''))) throw new Refused('--run is the run id the first step gave');
  const f = runFile(home, run);
  if (!existsSync(f)) throw new Refused(`no drafts run ${run}: start with drafts next --event <slug> --run new`);
  return JSON.parse(readFileSync(f, 'utf8'));
}
// The open runs of this flow (the guard reads the current step of each).
export function openApprovedRuns(home, nowMs) {
  const dir = runsDir(home);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const o = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (o?.flow === FLOW && o.state === 'open' && nowMs - Date.parse(o.started_at) <= RUN_OPEN_MS) out.push(o);
    } catch {
      /* not a run */
    }
  }
  return out;
}
// The latest run of this flow for an event and kind (any state), or null: the flow reads a stop from it.
export function latestApprovedRun(home, slug, kind) {
  const dir = runsDir(home);
  if (!existsSync(dir)) return null;
  let last = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const o = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (o?.flow === FLOW && o.slug === slug && o.kind === kind && (!last || String(o.started_at) > String(last.started_at))) last = o;
    } catch {
      /* not a run */
    }
  }
  return last;
}

const WRITE_ALL = "Write the tool's whole result object as JSON (the full result, an error too) to the write file, then run then.";
const deleteWords = (d, it) =>
  d?.draft_id
    ? `Ask the user to delete the draft ${d.draft_id} (to ${it.to}, "${it.subject}") in Gmail's Drafts folder, now`
    : `Ask the user to look in Gmail's Drafts folder for a draft to ${it.to} ("${it.subject}") and delete it, now`;
function stop(home, r, why) {
  r.state = 'stopped';
  r.why = why;
  r.current = null;
  save(home, r);
  return { step: 'stop', why, drafted: r.drafted, sent: r.sent };
}
const outreach = (...a) => ['node', join(FLOORBOSS, 'skills', 'event-outreach', 'scripts', 'cli.mjs'), ...a];

// After pick 1's run in Claude Code: the daily routine gets the new drafts (create it, or update it).
function doneNext(home, r, cli) {
  if (r.kind !== 'auto' || r.host !== 'claude-code') return { say: `Tell the user plainly: ${r.drafted.length} message${r.drafted.length === 1 ? ' is' : 's are'} in Gmail Drafts, nothing was sent, and why any person was skipped.` };
  const saved = existsSync(join(home, 'autosend', 'routines', `${r.slug}.json`));
  return {
    next: [...cli, 'routine-body', '--event', r.slug, ...(saved ? [] : ['--environment', '<env_...>'])],
    say: `Tell the user plainly what went (summary.sent), what waits in Gmail Drafts for the daily routine (summary.drafted, each with its day) and why anyone was skipped. Then run next${saved ? '' : ": the first time it needs the id of the user's Claude cloud environment (env_ and letters or digits): ask them for it (claude.ai/code shows their environments)"}, and do what it says: one RemoteTrigger call with exactly its remote_trigger (Claude Code asks the user first), then routine-saved with the id it answers.`
  };
}

function show(r, cli) {
  const c = r.current;
  const claude = r.host === 'claude-code';
  if (c.step === 'send') {
    return {
      step: 'send',
      run: r.run,
      person: { id: c.id, name: c.name, to: c.to },
      run_these: [outreach('send-list', '--event', r.slug, '--ids', c.id)],
      then: [...cli, 'drafts', 'next', '--run', r.run],
      say: `Send message 1 to ${c.name} (${c.to}) now, through Claude Code's own sending: run run_these, then send its one item with your email.send connection exactly as listed (Claude Code asks the user first), then record the receipt with outreach sent as the send list says. Then run then. If the send list doesn't list it, or the user declines, run then anyway: nothing of theirs is drafted.`
    };
  }
  const then = [...cli, 'drafts', 'answer', '--run', r.run, '--file', c.file];
  if (c.step === 'profile') return { step: 'profile', run: r.run, tool: CODEX_TOOLS.profile[0], tool_names: CODEX_TOOLS.profile, args: {}, write: c.file, then, say: `Call the Gmail tool ${CODEX_TOOLS.profile[0]} (or the one whose name ends in gmail_get_profile) once, with exactly these args. ${WRITE_ALL}` };
  const tools = claude ? CLAUDE_TOOLS : { draft: CODEX_TOOLS.draft, verify: CODEX_TOOLS.verify };
  const t = tools[c.step];
  if (c.step === 'draft') {
    const args = claude ? claudeDraftArgs(c.item) : draftArgs(c.item);
    return { step: 'draft', run: r.run, tool: t[0], tool_names: t, args, write: c.file, then, say: `Call the Gmail tool ${t[0]} (or the one whose name ends in ${t[0].split('__').pop()}) once, with exactly these args${claude ? ' (Claude Code asks the user first)' : ''}. ${WRITE_ALL} Never send it. Never call it again for this step.` };
  }
  const args = claude ? { draftId: c.ids.draft_id } : readArgs(c.ids.email_id);
  return { step: 'verify', run: r.run, tool: t[0], tool_names: t, args, write: c.file, then, say: `Call the Gmail tool ${t[0]} (or the one whose name ends in ${t[0].split('__').pop()}) once, with exactly these args. It only reads the draft back. ${WRITE_ALL}` };
}

// next --event <slug> --run new [--for drafts] | next --run <id>
export function approvedNext(home, { event, run, kind = 'auto', host, nowMs, cli }) {
  let r;
  if (run === 'new') {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(event || ''))) throw new Refused('--event is an event slug');
    if (!['auto', 'drafts'].includes(kind)) throw new Refused('--for is drafts, or left out');
    const evDir = eventDirOf(home, event);
    const ev = eventJson(evDir);
    if (!ev) throw new Refused(`no event "${event}"`);
    if (kind === 'auto' && (host !== 'claude-code' || ev.autosend !== true || ev.autosend_mode !== ROUTINE)) throw new Refused(`"${event}" isn't set to send through a daily Claude routine`);
    const open = openApprovedRuns(home, nowMs).find((o) => o.slug === event);
    if (open) throw new Refused(`run ${open.run} for "${event}" is already open (started ${open.started_at}): finish it with drafts next --run ${open.run}, or wait until it expires (${RUN_OPEN_MS / 60000} minutes after it started)`);
    const plan = approvedPlan(evDir, kind, host, nowMs);
    if (plan.blocked) throw new Refused(plan.blocked);
    if (!plan.queue.length) return { step: 'done', summary: { sent: [], drafted: [], skipped: plan.skipped } };
    const id = `${kind === 'auto' ? 'cc' : 'dr'}-${iso(nowMs).slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}-${randomBytes(3).toString('hex')}`;
    r = { run: id, flow: FLOW, kind, host, slug: event, own: ev.autosend_own || null, state: 'open', started_at: iso(nowMs), n: 0, queue: plan.queue, current: null, sent: [], drafted: [], skipped: plan.skipped, held: [] };
    mkdirSync(answerDir(id), { recursive: true, mode: 0o700 });
    // Codex has a profile tool: the connected account is checked first. (A Claude routine checks it on every run.)
    if (host !== 'claude-code' && ev.autosend_own) r.current = { step: 'profile', file: join(answerDir(id), '0-profile.json') };
    save(home, r);
    if (r.current) return show(r, cli);
  } else {
    r = loadRun(home, run);
    if (r.flow !== FLOW) throw new Refused(`run ${run} isn't one of these`);
  }
  if (r.state === 'stopped') return { step: 'stop', why: r.why, drafted: r.drafted, sent: r.sent };
  if (r.state === 'done') return { step: 'done', summary: r.summary, ...doneNext(home, r, cli) };
  const evDir = eventDirOf(home, r.slug);
  const led = ledgerOf(evDir);
  const at = new Date(nowMs);
  if (r.current) {
    const c = r.current;
    // Message 1 went through Claude Code's own send: what happened is in the ledger now.
    if (c.step === 'send') {
      const { entries, folded } = readEvent(evDir);
      const s = firstSent(entries, folded, c.id, r.host);
      const releasedByGuard = entries.slice(c.line).some((e) => e?.type === 'send_released' && e.id === c.id && (e.touch ?? 1) === 1);
      if (s) {
        r.sent.push({ id: c.id, touch: 1, to: c.to, message_id: s.message_id, thread_id: s.thread_id });
        r.current = null;
      } else if (folded.people?.[c.id]?.touches?.[1]?.sent) {
        return stop(home, r, `${c.id} message 1 is recorded sent, but without the ids the send tool answered, so its follow-ups can't go in its thread: nothing of theirs was drafted`);
      } else if (releasedByGuard) {
        return stop(home, r, `${c.id} message 1 was let through by the send check, and its receipt isn't recorded: it may have gone. Check Sent mail and record it (outreach sent, or send-outcome if it is unclear). Nothing of theirs was drafted`);
      } else {
        append(led, { type: 'autosend_withdrawn', who: 'floorboss', id: c.id, touch: 1, run: r.run }, at);
        r.skipped.push({ id: c.id, why: "message 1 wasn't sent (it wasn't on the send list, or the user declined): nothing of theirs was drafted" });
        r.queue = r.queue.filter((q) => q.id !== c.id);
        r.current = null;
      }
      save(home, r);
    } else return show(r, cli);
  }
  for (;;) {
    const nx = r.queue[0];
    if (!nx) {
      r.state = 'done';
      r.summary = { sent: r.sent, drafted: r.drafted, skipped: r.skipped };
      save(home, r);
      return { step: 'done', summary: r.summary, ...doneNext(home, r, cli) };
    }
    r.queue.shift();
    r.n += 1;
    if (nx.step === 'send') {
      const { entries, folded } = readEvent(evDir);
      const a = liveApproval(entries, nx.id, 1);
      const x = folded.people?.[nx.id]?.touches?.[1];
      const held = contactable(folded, nx.id, 'message', eventStateAt(evDir, nowMs).today);
      const why = !a || listChangedSince(entries, a, nx.id) || a.hash !== x?.hash ? 'its auto-send yes is no longer live (stopped, changed, or the list changed)' : x?.sent ? 'already sent' : held || (!sendsAtApproval(eventJson(evDir), a.planned_due, eventStateAt(evDir, nowMs).today, nowMs) ? 'sending hours are closed now' : null);
      if (why) {
        r.skipped.push({ id: nx.id, why: `message 1: ${why}` });
        r.queue = r.queue.filter((q) => q.id !== nx.id);
        save(home, r);
        continue;
      }
      // The release goes in before the send: the sent line that follows, with this text, is auto-send's own
      // (common.mjs handSentAfter), and Claude Code's send list lists this one step (common.mjs routineHeld).
      append(led, { type: 'autosend_released', who: 'floorboss', id: nx.id, touch: 1, hash: a.hash, to: a.to, run: r.run, host: 'claude-code' }, at);
      r.current = { step: 'send', id: nx.id, name: folded.people[nx.id].name || nx.id, to: a.to, line: readEvent(evDir).entries.length };
      save(home, r);
      return show(r, cli);
    }
    const got = approvedDraftItem(evDir, nx.id, nx.touch, r.kind, nowMs, r.host);
    if (got.why) {
      r.skipped.push({ id: nx.id, why: `message ${nx.touch}: ${got.why}` });
      r.queue = r.queue.filter((q) => q.id !== nx.id);
      save(home, r);
      continue;
    }
    mkdirSync(answerDir(r.run), { recursive: true, mode: 0o700 });
    r.current = { step: 'draft', item: got.item, file: join(answerDir(r.run), `${r.n}-draft.json`), line: readEvent(evDir).entries.length };
    save(home, r);
    return show(r, cli);
  }
}

function answerOf(r, file) {
  if (!r.current || String(file || '') !== r.current.file) throw new Refused(`that isn't the file the current step named (${r.current?.file || 'no step is open'})`);
  if (!existsSync(file)) return null;
  const st = lstatSync(file);
  if (!st.isFile() || st.size > 1024 * 1024) return '';
  return readFileSync(file, 'utf8');
}

// The ids create_draft answered, as the connector shapes them: { id (the draft's), messageId, threadId }.
export function claudeDraftIds(text) {
  if (text == null) return { why: 'no answer from the create_draft tool' };
  const a = readAnswer(text);
  if (!a.ok) return { why: a.why };
  const v = isObj(a.value?.draft) ? a.value.draft : a.value;
  if (!isObj(v)) return { why: "the answer isn't an object" };
  const pick = (...xs) => xs.find((x) => typeof x === 'string' && ID.test(x)) || null;
  const draft_id = pick(v.id, v.draftId, v.draft_id);
  const message_id = pick(v.messageId, v.message_id, v.message?.id);
  const thread_id = pick(v.threadId, v.thread_id, v.message?.threadId);
  if (!draft_id) return { why: 'no draft id in the answer' };
  return { draft_id, message_id, thread_id, email_id: draft_id };
}
// get_draft read back: the draft (its own id), with its message's To, Cc, Bcc, subject, body and thread checked as
// verifyDraft checks a Codex one.
export function claudeVerify(item, text, { draftId, threadId }) {
  if (text == null) return { why: 'no answer from the get_draft tool' };
  const a = readAnswer(text);
  if (!a.ok) return { why: a.why };
  let v = a.value;
  if (isObj(v?.draft)) v = v.draft;
  if (!isObj(v)) return { why: "the answer isn't a draft" };
  if (v.id != null && v.id !== draftId) return { why: `it is draft ${String(v.id).slice(0, 60)}, not ${draftId}` };
  const m = isObj(v.message) ? { ...v, ...v.message } : v;
  const list = (x) => (x == null ? x : (Array.isArray(x) ? x : [x]).map((y) => (isObj(y) ? y.email ?? y.emailAddress ?? y.address : y)));
  const flat = {
    to: list(m.to ?? m.toRecipients),
    cc: list(m.cc ?? m.ccRecipients),
    bcc: list(m.bcc ?? m.bccRecipients),
    subject: m.subject,
    ...(typeof (m.body ?? m.plaintextBody ?? m.textBody ?? m.text) === 'string' ? { body: m.body ?? m.plaintextBody ?? m.textBody ?? m.text } : {}),
    ...(typeof (m.htmlBody ?? m.html) === 'string' ? { html: m.htmlBody ?? m.html } : {}),
    thread_id: m.threadId ?? m.thread_id ?? v.threadId ?? null
  };
  return verifyDraft(item, JSON.stringify(flat), { label: null, threadId });
}

// answer --run <id> --file <f>
export function approvedAnswer(home, { run, file, nowMs }) {
  const r = loadRun(home, run);
  if (r.flow !== FLOW) throw new Refused(`run ${run} isn't one of these`);
  if (r.state !== 'open' || !r.current || r.current.step === 'send') throw new Refused('no step with an answer is open in this run: run next');
  const c = r.current;
  const text = answerOf(r, file);
  const evDir = eventDirOf(home, r.slug);
  const led = ledgerOf(evDir);
  const at = new Date(nowMs);
  const claude = r.host === 'claude-code';
  const go = () => {
    r.current = null;
    save(home, r);
    return { answered: c.step, then: 'run next' };
  };
  if (c.step === 'profile') {
    const p = profileEmail(text);
    if (p.error) return stop(home, r, `the connected Gmail account can't be checked (${p.error}): nothing was drafted`);
    if (!sameAccount(p.email, r.own)) return stop(home, r, `the connected Gmail account is ${p.email}, not ${r.own}: nothing was drafted`);
    return go();
  }
  const bad = (ids, why) => {
    if (r.kind === 'auto') append(led, { type: 'autosend_draft_bad', who: 'floorboss', id: c.item.id, touch: c.item.touch, draft_id: ids?.draft_id || null, why: why.slice(0, 200), run: r.run }, at);
  };
  if (c.step === 'draft') {
    let ids = claude ? claudeDraftIds(text) : draftIds(text);
    if (claude) {
      // The ids that count are the ones floorboss's guard read in the tool's own answer (call_result), never only the
      // answer file, which the session writes.
      const seen = readEvent(evDir).entries.slice(c.line).filter((e) => e?.type === 'call_result' && e.who === 'guard' && e.kind === 'draft' && e.id === c.item.id && (e.touch ?? 1) === c.item.touch).pop();
      if (!seen?.draft_id) ids = { why: "floorboss's guard didn't see this draft made" };
      else if (!ids.why && ids.draft_id !== seen.draft_id) ids = { why: `the answer names draft ${ids.draft_id}, and the tool made ${seen.draft_id}` };
      else ids = { draft_id: seen.draft_id, message_id: seen.message_id || null, thread_id: seen.thread_id || null, email_id: seen.draft_id };
    }
    if (ids.why) {
      bad(null, ids.why);
      return stop(home, r, `the draft for ${c.item.id} message ${c.item.touch} can't be confirmed (${ids.why}). ${deleteWords(null, c.item)}. Nothing more was drafted`);
    }
    r.current = { step: 'verify', item: c.item, ids, file: c.file.replace(/-draft\.json$/, '-verify.json') };
    save(home, r);
    return { answered: 'draft', then: 'run next' };
  }
  if (c.step === 'verify') {
    const v = claude ? claudeVerify(c.item, text, { draftId: c.ids.draft_id, threadId: c.item.thread_id || null }) : verifyDraft(c.item, text, { label: null, threadId: c.item.thread_id || null });
    if (!v.ok) {
      bad(c.ids, `doesn't match what was approved (${v.why})`);
      return stop(home, r, `the draft for ${c.item.id} message ${c.item.touch} doesn't match what was approved (${v.why}). ${r.kind === 'auto' ? 'It is not in the daily routine\'s list, so it is never sent. ' : ''}${deleteWords(c.ids, c.item)}. Nothing more was drafted`);
    }
    const thread_id = c.ids.thread_id || c.item.thread_id || null;
    if (r.kind === 'auto')
      append(led, { type: 'autosend_drafted', who: 'floorboss', id: c.item.id, touch: c.item.touch, hash: c.item.hash, to: c.item.to, due: c.item.due, draft_id: c.ids.draft_id, message_id: c.ids.message_id, thread_id, threaded: !!c.item.thread_id, run: r.run }, at);
    else append(led, { type: 'staged', who: 'floorboss', id: c.item.id, touch: c.item.touch, draft_id: c.ids.draft_id, thread_id, message_id: c.ids.message_id, tool: claude ? CLAUDE_TOOLS.draft[0] : CODEX_TOOLS.draft[0], run: r.run }, at);
    r.drafted.push({ id: c.item.id, touch: c.item.touch, due: c.item.due, draft_id: c.ids.draft_id, threaded: !!c.item.thread_id });
    return go();
  }
  throw new Refused(`unknown step ${c.step}`);
}

export function runFlowOf(home, run) {
  try {
    return loadRun(home, run).flow || null;
  } catch {
    return null;
  }
}
