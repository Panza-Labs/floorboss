// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Auto-send through Gmail drafts (2026-11-20 design, floorboss-design/2026-11-20-gmail-drafts-autosend-spec.md).
// After the user's exact second yes (approval.mjs: the readback and its hash), Codex on the laptop, with its own Gmail
// tools, is handed one step at a time:
//   profile       the connected account must be the approved sender
//   create_label  floorboss/due-YYYY-MM-DD, one per due day (the day in the event's time zone)
//   search, send  each first email due now: the reply check, then the existing send (sendrecord.mjs sendArgs), with
//                 the 0.1.4 gap between sends
//   draft         each other approved message, as a Gmail draft: a follow-up of a first email sent now goes in its
//                 thread (a reply to that message); a first email due on a later day, and its follow-ups, go unthreaded
//   label         the draft gets floorboss/due-<its day>
//   verify        the draft is read back and must match the approved recipient, subject and body (line endings
//                 only normalised); any mismatch or any answer floorboss can't read stops, naming the draft to delete
// One fixed-time daily ChatGPT task then sends the labelled drafts that are due (codex/daily-task.md).
// The Gmail tools' args for create_draft, labels and read_email were NOT seen live: each is built in one function
// below (draftArgs, createLabelArgs, labelArgs, readArgs), so the first live call can correct it in one place. Any
// answer that isn't strictly one of the shapes read here is a stop, never a go.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync, mkdirSync, lstatSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { writeJson } from '../jsonio.mjs';
import { append, contactable } from '../ledger.mjs';
import { eventStateAt } from '../sendcheck.mjs';
import { hoursWhy } from '../unattended-drafts.mjs';
import { plainAddress } from '../../skills/event-outreach/scripts/mailto.mjs';
import { eventDirOf, eventJson, ledgerOf, readEvent, draftOf, liveApproval, lastApproval, everReleased, claudeSendsEmail, FRESH_MS } from './common.mjs';
import { query, decide, profileEmail, sameAccount, apply, readAnswer, failedWhy, MAX_RESULTS } from './replycheck.mjs';
import { sendArgs, record, htmlBody, BODY_MIME } from './sendrecord.mjs';

export const MODE = 'drafts';
export const LABEL_PREFIX = 'floorboss/due-';
export const HELD_PREFIX = 'floorboss/held-';
export const dueLabel = (day) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw new Error(`a due day is YYYY-MM-DD (got ${String(day).slice(0, 20)})`);
  return `${LABEL_PREFIX}${day}`;
};

// The Codex Gmail tools (mcp__codex_apps__gmail_*), matched by name suffix. ChatGPT web names the same family
// mcp__Gmail__*; the daily task names them by their plain names.
const tools = (s) => Object.freeze([`mcp__codex_apps__gmail_${s}`, `gmail_${s}`]);
export const TOOLS = Object.freeze({
  profile: tools('get_profile'),
  search: tools('search_emails'),
  send: tools('send_email'),
  create_label: tools('create_label'),
  draft: tools('create_draft'),
  label: tools('apply_labels_to_emails'),
  verify: tools('read_email')
});

// ---- The args, each in one place (unconfirmed live: adjust here after the first call) ----
// create_draft: the same arg names as send_email in the same tool family (live: to, subject, payload, response_fields,
// reply_message_id), and the same HTML body as the send (the text/plain body was hard-wrapped by the tool, 0.1.4).
// reply_message_id only for a follow-up of a first email sent in this run: that makes it a reply in its thread.
export function draftArgs(item) {
  const reply = item.reply_to_message_id;
  return {
    to: item.to,
    subject: item.subject,
    payload: { mime_type: BODY_MIME, charset: 'UTF-8', body: { content: htmlBody(item.body) } },
    response_fields: ['id', 'message_id', 'thread_id'],
    ...(reply ? { reply_message_id: reply } : {})
  };
}
export const createLabelArgs = (name) => ({ name });
export const labelArgs = (emailId, name, labelId = null) => ({ email_ids: [emailId], label_names: [name], ...(labelId ? { label_ids: [labelId] } : {}) });
export const readArgs = (emailId) => ({ email_id: emailId });

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const ID = /^[\w-]{1,128}$/;
const nl = (s) => String(s ?? '').replace(/\r\n?/g, '\n');
// Line endings normalised, and trailing whitespace at the very end (Gmail adds a final newline).
const bodyNorm = (s) => nl(s).replace(/\s+$/, '');

// Does a first email (touch 1) planned for day go at approval? Its day is today (the event's zone) and the event's
// sending hours are open. Otherwise it waits as an unthreaded draft for the daily task. The readback says which.
export function sendsAtApproval(ev, plannedDay, today, nowMs) {
  return !!plannedDay && !!today && plannedDay <= today && !hoursWhy(ev?.time_zone, nowMs);
}

// What one run does for one event: every touch with a standing second yes, not sent, not let go, not drafted.
// { people: [{ id, to, sendNow, items: [Item] }], labels: [name], skipped: [{ id, why }] }.
export function draftPlan(evDir, slug, nowMs) {
  const ev = eventJson(evDir) || {};
  const { entries, folded } = readEvent(evDir);
  const es = eventStateAt(evDir, nowMs);
  if (es.state !== 'ok') return { blocked: es.why || "the event's dates can't be read", people: [], labels: [], skipped: [] };
  const drafted = new Set(entries.filter((e) => e?.type === 'autosend_drafted' || e?.type === 'autosend_draft_bad').map((e) => `${e.id}:${e.touch}`));
  const people = [];
  const skipped = [];
  const labels = new Set();
  for (const id of Object.keys(folded.people).sort()) {
    const p = folded.people[id];
    const ts = Object.keys(p.touches || {}).map(Number).filter((t) => t >= 1).sort((a, b) => a - b);
    const items = [];
    let bad = null;
    for (const t of ts) {
      const x = p.touches[t];
      const a = liveApproval(entries, id, t);
      if (!a) continue;
      if (x.sent || everReleased(entries, id, t) || drafted.has(`${id}:${t}`)) continue;
      const d = draftOf(evDir, a.hash);
      if (a.hash !== x.hash || !d || !plainAddress(a.to)) {
        bad = `message ${t} changed since its auto-send yes`;
        break;
      }
      const first = lastApproval(entries, id, 1);
      items.push({ slug, id, name: p.name || id, touch: t, to: a.to, from: a.from, subject: d.subject || '', body: d.body || '', hash: a.hash, due: a.planned_due, since_ms: Date.parse(first?.a?.at || a.at), followup: t > 1 });
    }
    if (!items.length) continue;
    if (bad) {
      skipped.push({ id, why: bad });
      continue;
    }
    const held = contactable(folded, id, 'message', es.today);
    if (held) {
      skipped.push({ id, why: held });
      continue;
    }
    if (items.some((i) => !/^\d{4}-\d{2}-\d{2}$/.test(String(i.due || '')))) {
      skipped.push({ id, why: 'a message has no planned day' });
      continue;
    }
    // Message 1 already went (earlier): its follow-ups go in its thread, from its recorded ids.
    const t1sent = p.touches?.[1]?.sent;
    const sentLine = [...entries].reverse().find((e) => e?.type === 'sent' && e.id === id && (e.touch ?? 1) === 1);
    const sendNow = items[0].touch === 1 && sendsAtApproval(ev, items[0].due, es.today, nowMs);
    for (const i of items) {
      if (i.touch === 1 && sendNow) continue;
      labels.add(dueLabel(i.due));
      if (t1sent && sentLine && ID.test(sentLine.message_id || '') && ID.test(sentLine.thread_id || '')) Object.assign(i, { reply_to_message_id: sentLine.message_id, thread_id: sentLine.thread_id });
    }
    people.push({ id, to: items[0].to, sendNow, items });
  }
  return { blocked: null, people, labels: [...labels].sort(), skipped };
}

// ---- Reading the answers (strict) ----
// create_label: a label object back ({ id, name } at the top or under label), or an error saying it already exists.
export function labelCreated(answerText, name) {
  if (answerText == null) return { why: 'no answer from the create_label tool' };
  if (/already exists|label name exists|conflict/i.test(String(answerText))) return { ok: true, id: null };
  const a = readAnswer(answerText);
  if (!a.ok) return { why: a.why };
  let v = a.value;
  if (isObj(v?.label)) v = v.label;
  if (!isObj(v) || failedWhy(v)) return { why: failedWhy(v) || "the answer isn't an object" };
  if (v.name !== undefined && v.name !== name) return { why: `the label made is named ${String(v.name).slice(0, 60)}, not ${name}` };
  const id = typeof v.id === 'string' && ID.test(v.id) ? v.id : null;
  if (!id && v.name !== name) return { why: 'no label id or name in the answer' };
  return { ok: true, id };
}

// create_draft: its ids. The draft id (draft_id / draftId, or id beside a message object) and the message id
// (message_id / messageId / message.id, or id when nothing says it is a draft id); the thread id if there.
export function draftIds(answerText) {
  if (answerText == null) return { why: 'no answer from the create_draft tool' };
  const a = readAnswer(answerText);
  if (!a.ok) return { why: a.why };
  let v = a.value;
  if (isObj(v?.draft)) v = v.draft;
  if (!isObj(v)) return { why: "the answer isn't an object" };
  const f = failedWhy(v);
  if (f) return { why: f };
  const pick = (...xs) => xs.find((x) => typeof x === 'string' && ID.test(x)) || null;
  const msg = isObj(v.message) ? v.message : null;
  const draft_id = pick(v.draft_id, v.draftId, msg ? v.id : null);
  const message_id = pick(v.message_id, v.messageId, msg?.id, !msg && !v.draft_id && !v.draftId ? v.id : null);
  const thread_id = pick(v.thread_id, v.threadId, msg?.thread_id, msg?.threadId);
  if (!draft_id && !message_id) return { why: 'no draft or message id in the answer' };
  return { draft_id, message_id, thread_id, email_id: message_id || draft_id };
}

// apply_labels_to_emails: any readable answer that says nothing failed.
export function labelApplied(answerText) {
  if (answerText == null) return { why: 'no answer from the label tool' };
  const a = readAnswer(answerText);
  if (!a.ok) return { why: a.why };
  if (!isObj(a.value) && !Array.isArray(a.value)) return { why: "the answer isn't an object" };
  const f = failedWhy(a.value);
  if (f) return { why: f };
  return { ok: true };
}

const addrs = (v) => {
  if (v == null || v === '') return [];
  const list = Array.isArray(v) ? v : String(v).split(',');
  return list.map((x) => (isObj(x) ? x.email ?? x.address : x)).map((x) => String(x ?? '').trim()).filter(Boolean);
};
// An address as written in a header: "Name <a@b>" or a@b.
const bare = (s) => {
  const m = /<([^<>]+)>\s*$/.exec(s);
  return String(m ? m[1] : s).trim().toLowerCase();
};
// The HTML floorboss sent, back to its text: <p> blocks blank-line apart, <br> a line break, entities undone.
const htmlText = (h) =>
  nl(h)
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?p>/gi, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// read_email on the draft: the approved recipient (one To, no Cc or Bcc), subject and body, the due label, and for a
// threaded draft its thread. { ok } or { why }.
export function verifyDraft(item, answerText, { label, labelId = null, threadId = null } = {}) {
  if (answerText == null) return { why: 'no answer from the read tool' };
  const a = readAnswer(answerText);
  if (!a.ok) return { why: a.why };
  let v = a.value;
  if (isObj(v?.email)) v = v.email;
  else if (isObj(v?.message)) v = v.message;
  if (!isObj(v)) return { why: "the answer isn't an object" };
  const f = failedWhy(v);
  if (f) return { why: f };
  const to = addrs(v.to);
  if (to.length !== 1 || bare(to[0]) !== String(item.to).toLowerCase()) return { why: `its To is ${to.join(', ').slice(0, 120) || 'empty'}, not only ${item.to}` };
  if (addrs(v.cc).length || addrs(v.bcc).length) return { why: 'it has a Cc or Bcc' };
  if (typeof v.subject !== 'string' || v.subject !== item.subject) return { why: `its subject is "${String(v.subject ?? '').slice(0, 80)}", not the approved "${item.subject}"` };
  const texts = [v.body, v.body_text, v.text, v.plain_text, v.text_body, v.bodyText].filter((x) => typeof x === 'string');
  const htmls = [v.html, v.body_html, v.html_body, v.bodyHtml].filter((x) => typeof x === 'string');
  if (!texts.length && !htmls.length) return { why: 'the answer holds no body (a snippet is not enough)' };
  const want = bodyNorm(item.body);
  const wantHtml = bodyNorm(htmlBody(item.body));
  const match = texts.some((t) => bodyNorm(t) === want || bodyNorm(t) === wantHtml || bodyNorm(htmlText(t)) === want) || htmls.some((h) => bodyNorm(h) === wantHtml || bodyNorm(htmlText(h)) === want);
  if (!match) return { why: 'its body is not the approved text' };
  const labels = [v.labels, v.labelIds, v.label_ids, v.label_names].filter(Array.isArray).flat().map(String);
  if (!labels.length) return { why: 'the answer lists no labels, so the due label can\'t be seen' };
  if (!labels.includes(label) && !(labelId && labels.includes(labelId))) return { why: `it doesn't show the label ${label}` };
  if (threadId) {
    const t = v.thread_id ?? v.threadId;
    if (t !== threadId) return { why: `it is in thread ${String(t ?? 'none').slice(0, 60)}, not the first email's thread ${threadId}` };
  }
  return { ok: true };
}

// ---- The run (laptop, Codex): next / answer ----
const runsDir = (home) => join(home, 'autosend', 'drafts-runs');
const runFile = (home, run) => join(runsDir(home), `${run}.json`);
const answerDir = (run) => join(tmpdir(), 'floorboss-drafts', run);
const RUN_RE = /^[\w-]{1,64}$/;
const iso = (ms) => new Date(ms).toISOString();
export class Refused extends Error {}
const save = (home, r) => writeJson(runFile(home, r.run), r);
function load(home, run) {
  if (!RUN_RE.test(String(run || ''))) throw new Refused('--run is the run id the first step gave');
  const f = runFile(home, run);
  if (!existsSync(f)) throw new Refused(`no drafts run ${run}: start with drafts next --event <slug> --run new`);
  return JSON.parse(readFileSync(f, 'utf8'));
}

const WRITE_ALL = "Write the tool's whole result object as JSON (JSON.stringify of the full result, structuredContent included, an error too) to the write file, then run then.";
const deleteWords = (d, it) =>
  d?.draft_id || d?.email_id
    ? `Ask the user to delete the draft ${d.draft_id || d.email_id} (to ${it.to}, "${it.subject}") in Gmail's Drafts folder, now`
    : `Ask the user to look in Gmail's Drafts folder for a draft to ${it.to} ("${it.subject}") and delete it, now`;

function stop(home, r, why) {
  r.state = 'stopped';
  r.why = why;
  r.current = null;
  save(home, r);
  return { step: 'stop', why, drafted: r.drafted, sent: r.sent };
}

// The step shown to the model for r.current.
function show(home, r, cli) {
  const c = r.current;
  const then = [...cli, 'drafts', 'answer', '--run', r.run, '--file', c.file];
  const base = { step: c.step, run: r.run, tool: TOOLS[c.step][0], tool_names: TOOLS[c.step], write: c.file, then };
  const one = (suffix) => `Call the Gmail tool ${TOOLS[c.step][0]} (or the one whose name ends in ${suffix}) once, with exactly these args. ${WRITE_ALL}`;
  if (c.step === 'profile') return { ...base, args: {}, say: one('gmail_get_profile') };
  if (c.step === 'create_label') return { ...base, args: createLabelArgs(c.label), say: `${one('gmail_create_label')} If the label already exists, write that answer too.` };
  if (c.step === 'search') return { ...base, args: { query: query(c.item), max_results: MAX_RESULTS }, say: one('gmail_search_emails') };
  if (c.step === 'send')
    return {
      ...base,
      args: sendArgs(c.item),
      expires_at: iso(c.expires_at),
      say: `Check the time first: if expires_at (${iso(c.expires_at)}) has passed, don't call the send tool; run then with no file written. Otherwise call ${TOOLS.send[0]} (or the one whose name ends in gmail_send_email) once, with exactly these args: no other recipient, no cc or bcc, no change to the subject or the body. ${WRITE_ALL} Never call it again for this step.`
    };
  if (c.step === 'draft') return { ...base, args: draftArgs(c.item), say: `${one('gmail_create_draft')} Never send it. Never call it again for this step.` };
  if (c.step === 'label') return { ...base, args: labelArgs(c.ids.email_id, c.label, r.labels[c.label] || null), say: one('gmail_apply_labels_to_emails') };
  if (c.step === 'verify') return { ...base, args: readArgs(c.ids.email_id), say: one('gmail_read_email') };
  throw new Error(`unknown step ${c.step}`);
}

// The queue: profile, the labels, then each person in turn.
function queueOf(plan) {
  const q = plan.labels.map((label) => ({ step: 'create_label', label }));
  for (const p of plan.people)
    for (const it of p.items) {
      if (it.touch === 1 && p.sendNow) q.push({ step: 'search', item: it }, { step: 'send', item: it });
      else q.push({ step: 'draft', item: it, threaded: p.sendNow || !!it.reply_to_message_id });
    }
  return q;
}

// next --event <slug> --run new|<id>
export function draftsNext(home, { event, run, nowMs, cli, gapOf }) {
  let r;
  if (run === 'new') {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(event || ''))) throw new Refused('--event is an event slug');
    const evDir = eventDirOf(home, event);
    const ev = eventJson(evDir);
    if (!ev || ev.autosend !== true || ev.autosend_mode !== MODE) throw new Refused(`"${event}" isn't set to auto-send through Gmail drafts (on --event ${event} --mode drafts)`);
    const cc = claudeSendsEmail(home, ev);
    if (cc) throw new Refused(cc);
    const plan = draftPlan(evDir, event, nowMs);
    if (plan.blocked) throw new Refused(plan.blocked);
    const id = `${iso(nowMs).slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}-${randomBytes(3).toString('hex')}`;
    r = { run: id, slug: event, own: ev.autosend_own, state: 'open', started_at: iso(nowMs), n: 0, queue: queueOf(plan), current: null, labels: {}, threads: {}, held: [], sent: [], drafted: [], skipped: plan.skipped };
    mkdirSync(answerDir(id), { recursive: true, mode: 0o700 });
    r.current = { step: 'profile', file: join(answerDir(id), '0-profile.json'), shown: true };
    save(home, r);
    return show(home, r, cli);
  }
  r = load(home, run);
  if (r.state === 'stopped') return { step: 'stop', why: r.why, drafted: r.drafted, sent: r.sent };
  if (r.state === 'done') return { step: 'done', summary: r.summary };
  // A step shown and not answered: a send or a draft may have happened. Never shown twice.
  if (r.current) {
    const c = r.current;
    if (c.step === 'send') {
      append(ledgerOf(eventDirOf(home, r.slug)), { type: 'send_unclear', who: 'floorboss', id: c.item.id, touch: c.item.touch, error: 'next was asked for before the send answer was recorded' }, new Date(nowMs));
      return stop(home, r, `${c.item.id} message 1: the send answer was never recorded, so it may have gone. Check Sent mail and settle it (autosend status)`);
    }
    if (c.step === 'draft') return stop(home, r, `the draft for ${c.item.id} message ${c.item.touch} was asked for and its answer never recorded. ${deleteWords(null, c.item)}`);
    return show(home, r, cli);
  }
  const evDir = eventDirOf(home, r.slug);
  for (;;) {
    const nx = r.queue[0];
    if (!nx) {
      r.state = 'done';
      r.summary = { sent: r.sent, drafted: r.drafted, held: r.held, skipped: r.skipped };
      save(home, r);
      return { step: 'done', summary: r.summary };
    }
    // A person stopped earlier in this run (a reply, a bounce, a held first send): none of their messages are made.
    if (nx.item && r.held.some((h) => h.id === nx.item.id)) {
      r.queue.shift();
      continue;
    }
    break;
  }
  const nx = r.queue[0];
  if (nx.step === 'search' && Number.isFinite(r.last_sent_at)) {
    const left = r.last_sent_at + gapOf(nx.item.id) - nowMs;
    if (left > 0) return { step: 'wait', run: r.run, seconds: Math.ceil(left / 1000), say: `Wait between sends: run \`sleep ${Math.ceil(left / 1000)}\`, then run next again. Call no Gmail tool for this step.` };
  }
  r.queue.shift();
  r.n += 1;
  const file = join(answerDir(r.run), `${r.n}-${nx.step}.json`);
  mkdirSync(answerDir(r.run), { recursive: true, mode: 0o700 });
  if (nx.step === 'search' && !sameAccount(nx.item.from, r.account)) return stop(home, r, `${nx.item.id}: the connected Gmail account (${r.account}) isn't the address it was approved from (${nx.item.from})`);
  if (nx.step === 'send') {
    // The search's go must be fresh; released before the step is shown (record() reads it).
    if (!(nowMs - r.searched_at <= FRESH_MS)) return stop(home, r, `the reply check for ${nx.item.id} is more than ${FRESH_MS / 60000} minutes old: nothing was sent. Run drafts next --run new again`);
    const ev = eventJson(evDir) || {};
    const late = hoursWhy(ev.time_zone, nowMs) || claudeSendsEmail(home, ev);
    if (late) return stop(home, r, `${nx.item.id}: ${late}: nothing was sent. Run drafts next --run new again`);
    append(ledgerOf(evDir), { type: 'autosend_released', who: 'floorboss', id: nx.item.id, touch: 1, hash: nx.item.hash, to: nx.item.to, run: r.run }, new Date(nowMs));
    r.current = { ...nx, file, shown: true, expires_at: r.searched_at + FRESH_MS };
    save(home, r);
    return show(home, r, cli);
  }
  if (nx.step === 'draft') {
    const it = { ...nx.item };
    const th = r.threads[it.id];
    if (nx.threaded && !it.reply_to_message_id) {
      if (!th) return stop(home, r, `${it.id} message ${it.touch}: its first email's ids weren't recorded, so it can't go in that thread: nothing more was drafted`);
      it.reply_to_message_id = th.message_id;
      it.thread_id = th.thread_id;
    }
    r.current = { step: 'draft', item: it, file, shown: true, label: dueLabel(it.due) };
    save(home, r);
    return show(home, r, cli);
  }
  r.current = { ...nx, file, shown: true, issued_at: nowMs };
  save(home, r);
  return show(home, r, cli);
}

function answerOf(r, file) {
  if (!r.current || String(file || '') !== r.current.file) throw new Refused(`that isn't the file the current step named (${r.current ? r.current.file : 'no step is open'})`);
  if (!existsSync(file)) return null;
  const st = lstatSync(file);
  if (!st.isFile() || st.size > 1024 * 1024) return '';
  return readFileSync(file, 'utf8');
}

// answer --run <id> --file <f>
export function draftsAnswer(home, { run, file, nowMs }) {
  const r = load(home, run);
  if (r.state !== 'open' || !r.current) throw new Refused('no step is open in this run: run next');
  const c = r.current;
  const text = answerOf(r, file);
  const evDir = eventDirOf(home, r.slug);
  const led = ledgerOf(evDir);
  const at = new Date(nowMs);
  const go = () => {
    r.current = null;
    save(home, r);
    return { answered: c.step, then: 'run next' };
  };
  if (c.step === 'profile') {
    const p = profileEmail(text);
    if (p.error) return stop(home, r, `the connected Gmail account can't be checked (${p.error}): nothing was drafted or sent`);
    if (!sameAccount(p.email, r.own)) return stop(home, r, `the connected Gmail account is ${p.email}, not ${r.own}, the address auto-send was approved to send from: nothing was drafted or sent`);
    r.account = p.email;
    return go();
  }
  if (c.step === 'create_label') {
    const l = labelCreated(text, c.label);
    if (!l.ok) return stop(home, r, `the label ${c.label} couldn't be confirmed (${l.why}): nothing more was drafted or sent`);
    r.labels[c.label] = l.id;
    return go();
  }
  if (c.step === 'search') {
    const it = c.item;
    const d = decide(it, text ?? 'no answer (the file was not written)', { own: it.from });
    if (d.error) return stop(home, r, `${it.id}: ${d.error}: nothing more was drafted or sent`);
    apply(evDir, it, d, nowMs);
    if (d.stop) {
      r.held.push({ id: it.id, why: d.stop });
      r.queue = r.queue.filter((q) => q.item?.id !== it.id);
      return go();
    }
    r.searched_at = c.issued_at;
    return go();
  }
  if (c.step === 'send') {
    const it = c.item;
    let late = null;
    if (text != null && lstatSync(file).mtimeMs - (Date.now() - nowMs) > c.expires_at) late = `the send answer was written after the step expired (${iso(c.expires_at)})`;
    if (text == null && nowMs > c.expires_at) {
      // Not written, and the step expired: the model was told not to send. Taken back: it stays for a fresh run.
      append(led, { type: 'autosend_withdrawn', who: 'floorboss', id: it.id, touch: 1, run: r.run }, at);
      return stop(home, r, `${it.id}: the send step expired before it was answered, so it was not sent: run drafts next --run new again`);
    }
    const out = record(evDir, it, text, r.run, nowMs, { late });
    if (!out.sent) return stop(home, r, `${it.id} message 1: the send answer was unclear (${out.unclear}). It may have gone: check Sent mail and settle it (autosend status). Nothing more was drafted for them`);
    r.threads[it.id] = { message_id: out.message_id, thread_id: out.thread_id };
    r.sent.push({ id: it.id, touch: 1, to: it.to, message_id: out.message_id, thread_id: out.thread_id });
    r.last_sent_at = nowMs;
    return go();
  }
  if (c.step === 'draft') {
    const ids = draftIds(text);
    if (ids.why) {
      append(led, { type: 'autosend_draft_bad', who: 'floorboss', id: c.item.id, touch: c.item.touch, draft_id: null, why: ids.why.slice(0, 200), run: r.run }, at);
      return stop(home, r, `the draft for ${c.item.id} message ${c.item.touch} can't be confirmed (${ids.why}). ${deleteWords(null, c.item)}. Nothing more was drafted`);
    }
    r.current = { step: 'label', item: c.item, label: c.label, ids, file: c.file.replace(/-draft\.json$/, '-label.json'), shown: true };
    save(home, r);
    return { answered: 'draft', then: 'run next' };
  }
  const bad = (why) => {
    append(led, { type: 'autosend_draft_bad', who: 'floorboss', id: c.item.id, touch: c.item.touch, draft_id: c.ids.draft_id || c.ids.email_id, why: why.slice(0, 200), run: r.run }, at);
    return stop(home, r, `the draft for ${c.item.id} message ${c.item.touch} ${why}. ${deleteWords(c.ids, c.item)}. Nothing more was drafted`);
  };
  if (c.step === 'label') {
    const l = labelApplied(text);
    if (!l.ok) return bad(`couldn't be labelled ${c.label} (${l.why})`);
    r.current = { ...c, step: 'verify', file: c.file.replace(/-label\.json$/, '-verify.json') };
    save(home, r);
    return { answered: 'label', then: 'run next' };
  }
  if (c.step === 'verify') {
    const v = verifyDraft(c.item, text, { label: c.label, labelId: r.labels[c.label] || null, threadId: c.item.thread_id || null });
    if (!v.ok) return bad(`doesn't match what was approved (${v.why})`);
    const threaded = !!c.item.thread_id;
    append(led, { type: 'autosend_drafted', who: 'floorboss', id: c.item.id, touch: c.item.touch, hash: c.item.hash, to: c.item.to, due: c.item.due, draft_id: c.ids.draft_id, message_id: c.ids.message_id, thread_id: c.ids.thread_id || c.item.thread_id || null, threaded, run: r.run }, at);
    r.drafted.push({ id: c.item.id, touch: c.item.touch, due: c.item.due, label: c.label, draft_id: c.ids.draft_id || c.ids.email_id, threaded });
    return go();
  }
  throw new Refused(`unknown step ${c.step}`);
}

// ---- The overdue check (laptop): drafts whose due day went by and are still drafts, not held, mean the daily task
// isn't running (ChatGPT pauses a scheduled task that needs an approval, or whose chat was deleted or archived). ----
export const OVERDUE_HELD = Object.freeze(['replied', 'check', 'bounced']);
// The due days before today (the event's zone) of every draft this event's runs made.
export function overdueDays(evDir, nowMs) {
  const es = eventStateAt(evDir, nowMs);
  const today = es.today;
  if (!today) return [];
  const { entries } = readEvent(evDir);
  return [...new Set(entries.filter((e) => e?.type === 'autosend_drafted' && /^\d{4}-\d{2}-\d{2}$/.test(String(e.due || '')) && e.due < today).map((e) => e.due))].sort();
}
// Gmail's search names a label with "-" for "/".
const searchLabel = (name) => name.replace(/\//g, '-');
export function overdueQuery(days) {
  if (!days.length) return null;
  const due = days.map((d) => `label:${searchLabel(dueLabel(d))}`);
  return `in:drafts (${due.join(' OR ')}) ${OVERDUE_HELD.map((h) => `-label:${searchLabel(HELD_PREFIX + h)}`).join(' ')}`;
}
export const overdueWords = (n, more = false) => `Daily sending looks paused: ${n}${more ? ' or more' : ''} email${n === 1 && !more ? ' is' : 's are'} overdue. Open chatgpt.com, go to Scheduled, and resume 'floorboss daily sending'.`;
// The search answer: { overdue: n, say } (n 0: say null), or { why } when it can't be read.
export function overdueFrom(answerText) {
  if (answerText == null) return { why: 'no answer from the search tool' };
  const a = readAnswer(answerText);
  if (!a.ok) return { why: a.why };
  const v = a.value;
  if (!isObj(v) || !Array.isArray(v.emails) || failedWhy(v)) return { why: "the answer isn't a list of emails" };
  const held = (m) => [m.labels, m.labelIds].filter(Array.isArray).flat().some((l) => /^floorboss[/-]held/i.test(String(l)));
  const n = v.emails.filter((m) => isObj(m) && !held(m)).length;
  const more = v.next_page_token != null && v.next_page_token !== '';
  return { overdue: n, more, say: n ? overdueWords(n, more) : null };
}
