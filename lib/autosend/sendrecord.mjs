// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// U4. The send record: a step is marked let go (autosend_released) before the send, and pushed to the user's repo
// before the model is asked to send; afterwards, what the send tool answered is recorded as sent (with its ids) or as
// unclear. An unclear send blocks every later run until the user settles it on the laptop, and is never retried.
import { dirname } from 'node:path';
import { inOneGo, append } from '../ledger.mjs';
import { REPLY_CHECK_SECONDS, eventStateAt } from '../sendcheck.mjs';
import { dueNow } from './plan.mjs';
import { readAnswer } from './replycheck.mjs';
import { ledgerOf, readEvent, stepMark, FRESH_MS } from './common.mjs';

// The send tool, as a live ChatGPT/Codex cloud run showed it (2026-11-20): mcp__codex_apps__gmail_send_email takes
// to (one address), subject, payload { mime_type, charset, body: { content } }, response_fields, and reply_message_id,
// which puts the email in the thread of that message. A follow-up replies to the message id auto-send recorded from
// that person's first message (lib/autosend/plan.mjs: reply_to_message_id); with none recorded it goes as a new email
// with its approved subject.

// The step as the planner gives it, the message it replies to included (sendArgs passes that id).
const sameItem = (a, b) => ['slug', 'id', 'touch', 'hash', 'to', 'subject', 'body', 'reply_to_message_id'].every((k) => a?.[k] === b?.[k]);

// Mark the step let go. Re-runs the planner for this one step (it must be due now, exactly as given) and the reply
// check's freshness: issuedMs, when the search was given to the model, at most FRESH_MS before now and not ahead of
// the clock (what the check is as fresh as); and the person's mailbox check recorded, not ahead of the clock.
export function release(evDir, item, runId, nowMs, { issuedMs } = {}) {
  if (!/^[\w-]{1,64}$/.test(String(runId || ''))) throw new Error('a run id is letters, digits, "-" and "_"');
  if (!Number.isFinite(issuedMs)) throw new Error(`no time for the search for ${item.id}: search again`);
  if (issuedMs - nowMs > 60000) throw new Error(`the search for ${item.id} is dated ahead of the clock`);
  if (nowMs - issuedMs > FRESH_MS) throw new Error(`the search for ${item.id} was given more than ${FRESH_MS / 60000} minutes ago: search again`);
  const home = dirname(dirname(evDir));
  const plan = dueNow(home, nowMs);
  if (plan.blocked) throw new Error(`nothing may go: ${plan.blocked}`);
  if (!plan.due.some((x) => sameItem(x, item))) {
    const w = plan.waits.find((x) => x.id === item.id && x.slug === item.slug);
    throw new Error(`${item.id} message ${item.touch} isn't due now, exactly as given${w ? ` (${w.why})` : ''}`);
  }
  const { folded } = readEvent(evDir);
  const chk = folded.reply_checks?.[item.id];
  const checkedAt = chk?.source === 'mailbox' ? Date.parse(chk.at) : NaN;
  if (!Number.isFinite(checkedAt)) throw new Error(`no reply check for ${item.id}: search first`);
  if (checkedAt - nowMs > 60000) throw new Error(`the reply check for ${item.id} is dated ahead of the clock`);
  if (nowMs - checkedAt > REPLY_CHECK_SECONDS * 1000) throw new Error(`the reply check for ${item.id} is more than ${REPLY_CHECK_SECONDS} seconds old: search again`);
  return append(ledgerOf(evDir), { type: 'autosend_released', who: 'floorboss', id: item.id, touch: item.touch, hash: item.hash, to: item.to, run: runId }, new Date(nowMs));
}

const ID = /^[\w-]{1,128}$/;
// The send tool's arguments: exactly the approved subject and body (the body as plain text, byte for byte: the
// approval hash covers d.body, and payload.body.content is that string), the one address, no cc, bcc or other sender,
// and the ids asked back. A recorded message id that isn't one is never passed: the follow-up goes as a new email.
export function sendArgs(item) {
  const reply = typeof item.reply_to_message_id === 'string' && ID.test(item.reply_to_message_id) ? item.reply_to_message_id : null;
  return {
    to: item.to,
    subject: item.subject,
    payload: { mime_type: 'text/plain', charset: 'UTF-8', body: { content: item.body } },
    response_fields: ['id', 'thread_id'],
    ...(reply ? { reply_message_id: reply } : {})
  };
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// The message id and thread id from the answer, or why not. The real answer is a CallToolResult whose
// structuredContent holds the response_fields asked for ({ id, thread_id }); readAnswer takes it off (isError: true is
// an error; with no structuredContent, the content text is read as JSON if it parses). Also accepted: { id |
// message_id | messageId, threadId | thread_id }, at the top or under "message". Anything with an error in it, or a
// single id missing or odd, is unclear: the user looks in Sent, and it is never retried.
function idsOf(answerText) {
  if (answerText == null) return { why: 'no answer from the send tool' };
  const a = readAnswer(answerText);
  if (!a.ok) return { why: a.why };
  let v = a.value;
  if (!isObj(v)) return { why: "the answer isn't an object" };
  if ('error' in v || 'errors' in v || v.isError === true) return { why: 'the answer holds an error' };
  if (isObj(v.message) && !('id' in v) && !('message_id' in v) && !('messageId' in v)) v = v.message;
  // An answer that says the message failed, or is still a draft, didn't send it: unclear (the user looks in Sent).
  const status = String(v.status ?? v.state ?? '').toLowerCase();
  if (/fail|error|reject|bounce|draft/.test(status)) return { why: `the answer's status is ${status.slice(0, 40)}` };
  const labels = [v.labelIds, v.label_ids, v.labels].filter(Array.isArray).flat();
  if (labels.some((l) => String(l).toUpperCase() === 'DRAFT')) return { why: 'the answer is labelled a draft' };
  const mid = v.id ?? v.message_id ?? v.messageId;
  const tid = v.threadId ?? v.thread_id;
  if (typeof mid !== 'string' || !ID.test(mid)) return { why: 'no message id in the answer' };
  if (typeof tid !== 'string' || !ID.test(tid)) return { why: 'no thread id in the answer' };
  return { message_id: mid, thread_id: tid };
}

// What the send tool said, recorded. Only for the step this run let go, with nothing recorded about it since.
export function record(evDir, item, answerText, runId, nowMs) {
  const { entries } = readEvent(evDir);
  const rel = [...entries].reverse().find((e) => e?.type === 'autosend_released' && e.id === item.id && (e.touch ?? 1) === item.touch);
  if (!rel || rel.run !== runId || rel.hash !== item.hash || rel.to !== item.to || stepMark(entries, item.id, item.touch) !== 'released')
    throw new Error(`${item.id} message ${item.touch} wasn't let go by this run, or is recorded already`);
  const led = ledgerOf(evDir);
  const at = new Date(nowMs);
  const ids = idsOf(answerText);
  if (ids.why) {
    append(led, { type: 'send_unclear', who: 'floorboss', id: item.id, touch: item.touch, error: `${ids.why}: ${String(answerText ?? '').slice(0, 200)}` }, at);
    return { unclear: ids.why };
  }
  const day = eventStateAt(evDir, nowMs).today || at.toISOString().slice(0, 10);
  // The ids go on the sent line only. A call_result line is the Claude Code guard's own reading of a tool's answer
  // (only its hooks write one: test/unattended-merge.test.mjs); auto-send's planner reads the ids from this line.
  inOneGo(led, () => {
    append(led, { type: 'sent', who: 'floorboss', id: item.id, touch: item.touch, via: 'email.send', channel: 'email', date: day, message_id: ids.message_id, thread_id: ids.thread_id, hash: item.hash, source: 'autosend' }, at);
  });
  return { sent: true, ...ids };
}
