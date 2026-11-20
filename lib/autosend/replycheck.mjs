// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// U3. The reply check before an auto-sent message: the Gmail search floorboss asks the model to run, and the
// decision read from the tool's answer by code (go, stop this person, or stop the run). The model only runs the
// search and saves what came back. The shape read first is the real one, captured from a live ChatGPT/Codex cloud run
// (2026-11-20, test/fixtures/gmail-real.mjs): mcp__codex_apps__gmail_search_emails answers an MCP CallToolResult whose
// structuredContent is { emails: [{ id, thread_id, from_, to, subject, labels, email_ts, ... }], next_page_token }.
// The earlier likely shapes are still read; anything else stops the run. Nothing is guessed.
import { inOneGo, append, readLedger, fold } from '../ledger.mjs';
import { emailBase } from '../normalize.mjs';
import { plainAddress } from '../../skills/event-outreach/scripts/mailto.mjs';
import { ledgerOf } from './common.mjs';

// The usual subjects of a delivery failure notice, searched for and read as a bounce.
export const DSN_SUBJECTS = Object.freeze(['Delivery Status Notification', 'Undeliverable', 'Mail delivery failed', 'Returned mail']);
const DSN_SUBJECT = /^\s*(?:\w+:\s*)?(delivery status notification|undeliverable|mail delivery failed|returned mail)\b/i;

// How many results the search asks for: an answer with more, or a next page, isn't complete.
export const MAX_RESULTS = 20;

// The Gmail search for one person: everything from them anywhere (Spam aside, as Gmail leaves it out), and any bounce
// that names their address, since a day before the first email to them (or the second yes, before any).
export function query(item) {
  const to = plainAddress(item?.to);
  if (!to || to !== item.to) throw new Error('only a plain address goes into the search');
  const after = Math.floor(Number(item.since_ms) / 1000) - 86400;
  if (!Number.isFinite(after)) throw new Error('the search needs the time of the first email');
  // Gmail's +tags and dots: the exact address and its base (lib/normalize.mjs emailBase, what decide() reads as them)
  // are both asked for, from them and in a bounce.
  const base = emailBase(to);
  const both = base && base !== to && plainAddress(base) === base ? [to, base] : [to];
  return `in:anywhere after:${after} (${fromTerm(both)} OR ${bounceTerm(both)})`;
}
// The two halves of that search, also written into the daily ChatGPT task (dailytask.mjs), so both look for the same
// addresses and the same bounce subjects. addrs: the address and, when it differs, its base.
export const fromTerm = (addrs) => (addrs.length > 1 ? `from:(${addrs.join(' OR ')})` : `from:${addrs[0]}`);
// Bounces: from the usual bouncer addresses, or by the usual notice subjects (a server that sends from another
// address: Exchange, a hosted gateway), either way naming the address.
export const bounceTerm = (addrs) =>
  `((from:mailer-daemon OR from:postmaster OR subject:(${DSN_SUBJECTS.map((x) => `"${x}"`).join(' OR ')})) ${addrs.length > 1 ? `(${addrs.map((a) => `"${a}"`).join(' OR ')})` : `"${addrs[0]}"`})`;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// The tool's answer as saved: JSON, with one MCP CallToolResult taken off ({ content: [{ type: 'text', text }],
// structuredContent?, isError? }, nothing else beside). { ok: true, value } or { ok: false, why }.
// isError: true is an error, whatever else it holds. structuredContent, when there (and not null), is the answer and
// the content text isn't read (the real tools' text is only "Action completed."). Without it, the content text is
// read as JSON.
// Recognised by its required fields: content (text blocks) with structuredContent or isError. Other keys may be there
// (_meta, as MCP allows); an outer error or a failed status is an error, and any other unknown key stops the read.
// envelope: true when it was this shape (the Codex tools' answers are, and then structuredContent must be there).
const RESULT_KEYS = new Set(['content', 'isError', 'structuredContent']);
const FAILED = /fail|error|reject|bounce|draft|denied|invalid/i;
// Why an object says it failed (isError, an error key, a failed status), or null.
export function failedWhy(v) {
  if (!isObj(v)) return null;
  if (v.isError === true) return 'the tool said it failed';
  if (v.isError !== undefined && v.isError !== false) return "the tool's isError isn't true or false";
  if ('error' in v || 'errors' in v) return 'the answer holds an error';
  for (const k of ['status', 'state']) if (v[k] != null && FAILED.test(String(v[k]))) return `the answer's ${k} is ${String(v[k]).slice(0, 40)}`;
  return null;
}
export function readAnswer(text) {
  let v;
  try {
    v = JSON.parse(String(text ?? ''));
  } catch {
    return { ok: false, why: "the answer isn't JSON" };
  }
  const textBlocks = (c) => Array.isArray(c) && c.every((x) => isObj(x) && x.type === 'text' && typeof x.text === 'string');
  if (isObj(v) && textBlocks(v.content) && ('structuredContent' in v || 'isError' in v)) {
    const f = failedWhy(v);
    if (f) return { ok: false, why: f };
    const odd = Object.keys(v).filter((k) => !RESULT_KEYS.has(k) && !k.startsWith('_') && k !== 'status' && k !== 'state');
    if (odd.length) return { ok: false, why: `the tool's answer has a key floorboss doesn't read (${odd[0].slice(0, 40)})` };
    if ('structuredContent' in v && v.structuredContent !== null) {
      if (!isObj(v.structuredContent)) return { ok: false, why: "the tool's structuredContent isn't an object" };
      return { ok: true, value: v.structuredContent, envelope: true };
    }
    // An envelope with no structuredContent: its text, read as JSON (an older tool).
    if (!v.content.length) return { ok: false, why: 'the tool answered nothing' };
    try {
      return { ok: true, value: JSON.parse(v.content.map((c) => c.text).join('')), envelope: false };
    } catch {
      return { ok: false, why: "the tool's text isn't JSON" };
    }
  }
  // An older wrapper: content text blocks only, the text read as JSON (one level).
  if (isObj(v) && textBlocks(v.content) && v.content.length && Object.keys(v).length === 1) {
    try {
      return { ok: true, value: JSON.parse(v.content.map((c) => c.text).join('')), envelope: false };
    } catch {
      return { ok: false, why: "the tool's text isn't JSON" };
    }
  }
  return { ok: true, value: v, envelope: false };
}

// An address in a sender field: "Name <a@b>", "a@b", or { email }. The real address is the one in angle brackets;
// with none, the field is one plain address. A field read two ways (two bracketed addresses, an address in the display
// name other than the real one, two bare addresses) is UNCLEAR: a crafted From could pass for the user's own mail.
const UNCLEAR = Symbol('unclear sender');
function addressIn(v) {
  const s = isObj(v) ? v.email ?? v.address : v;
  if (typeof s !== 'string') return null;
  const ADDR = /[^\s<>"',;()]+@[^\s<>"',;()]+/g;
  const bracketed = [...s.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].map((m) => m[1].toLowerCase());
  if (bracketed.length > 1) return UNCLEAR;
  if (bracketed.length === 1) {
    const display = s.replace(/<[^<>]*>/g, ' ');
    if ((display.match(ADDR) || []).some((a) => a.toLowerCase() !== bracketed[0])) return UNCLEAR;
    return bracketed[0];
  }
  const bare = s.match(ADDR) || [];
  if (bare.length > 1) return UNCLEAR;
  return bare.length ? bare[0].toLowerCase() : null;
}
// A header's value, from { Name: value } or [{ name, value }].
function header(m, name) {
  const h = m?.headers ?? m?.payload?.headers;
  if (Array.isArray(h)) {
    const x = h.find((y) => isObj(y) && String(y.name || '').toLowerCase() === name.toLowerCase());
    return x ? x.value : undefined;
  }
  if (isObj(h)) {
    const k = Object.keys(h).find((y) => y.toLowerCase() === name.toLowerCase());
    return k ? h[k] : undefined;
  }
  return undefined;
}
// Every sender field read (from_ is the real tool's); two of them naming different people (by base address) read two ways too: a crafted
// { from: own, sender: them } never passes as the user's own mail.
const senderOf = (m) => {
  const all = [m.from_, m.from, m.sender, m.from_email, header(m, 'From')].map(addressIn).filter((a) => a != null);
  if (all.includes(UNCLEAR)) return UNCLEAR;
  if (new Set(all.map((a) => emailBase(a) || a)).size > 1) return UNCLEAR;
  return all[0] || null;
};
const subjectOf = (m) => String(m.subject ?? header(m, 'Subject') ?? '');
const dateOf = (m) => String(m.email_ts ?? m.date ?? m.internalDate ?? header(m, 'Date') ?? '');
const labelsOf = (m) => [m.labels, m.labelIds, m.tags].flatMap((x) => (Array.isArray(x) ? x : [])).map((x) => String(x).toLowerCase());

const AUTO_SUBJECT = /^\s*(automatic reply|out of (the )?office|auto:)/i;
const autoReply = (m) => {
  const as = header(m, 'Auto-Submitted');
  return AUTO_SUBJECT.test(subjectOf(m)) || (as != null && String(as).trim().toLowerCase() !== 'no') || labelsOf(m).some((l) => /auto.?(submitted|repl)/.test(l));
};
const BOUNCER = /^(mailer-daemon|postmaster)@/i;

// The messages in an accepted shape: { emails: [...], next_page_token } (the real one); a list; { messages | results |
// threads: [...] }; {} for no match. A
// thread with messages inside counts as its messages. null: not a shape floorboss reads.
// Next to the list, only these keys may be there (a paging key empty, a size estimate): any other (a status, a
// warning, has_more, truncated, total) may say the search failed or is partial, and stops the run.
const ALONGSIDE = new Set(['next_page_token', 'nextPageToken', 'resultSizeEstimate']);
function messagesOf(v) {
  let list;
  if (Array.isArray(v)) list = v;
  else if (isObj(v)) {
    const keys = ['messages', 'emails', 'results', 'threads'].filter((k) => k in v);
    // No list at all ({} included) is never read as an empty inbox: it may be a failed or empty-shaped answer.
    if (!keys.length) return null;
    if (keys.length > 1 || !Array.isArray(v[keys[0]])) return null;
    if (Object.keys(v).some((k) => k !== keys[0] && !ALONGSIDE.has(k))) return null;
    list = v[keys[0]];
  } else return null;
  if (!list.every(isObj)) return null;
  // A thread is read by its messages, whatever its own sender field says (often the one who started it).
  // A thread with an empty message list is read by its own sender fields.
  return list.flatMap((m) => (Array.isArray(m.messages) && m.messages.length ? m.messages : [m]));
}

// The decision: { go: true } | { stop: 'reply' | 'bounce' | 'auto_reply', evidence } | { error }.
// The Codex search answer's structuredContent: exactly { emails: [...], next_page_token }. Anything else (no emails
// list, a list under another name, another key beside it) isn't read: it stops the run.
function codexEmails(v) {
  if (!isObj(v) || !Array.isArray(v.emails)) return null;
  if (Object.keys(v).some((k) => k !== 'emails' && k !== 'next_page_token')) return null;
  return v.emails.every(isObj) ? v.emails : null;
}

export function decide(item, answerText, { own = null } = {}) {
  const a = readAnswer(answerText);
  if (!a.ok) return { error: `the search answer can't be read (${a.why})` };
  const v = a.value;
  if (isObj(v) && failedWhy(v)) return { error: `the search answer can't be read (${failedWhy(v)})` };
  // The Codex shape is read on its own, strictly; the older shapes (legacy) by messagesOf.
  const msgs = a.envelope ? codexEmails(v) : messagesOf(v);
  if (!msgs || !msgs.every(isObj)) return { error: "the search answer can't be read (not a list of messages)" };
  // The check must be complete: no next page, no more than asked for, no estimate above what came back.
  if (isObj(v) && ((v.next_page_token != null && v.next_page_token !== '') || (v.nextPageToken != null && v.nextPageToken !== '')))
    return { error: 'the search answer has more pages: the check is incomplete' };
  // A full page (as many as asked for, MAX_RESULTS, in the search's args) may have more behind it, whatever the answer
  // says about paging: the check is incomplete, and the run stops.
  if (msgs.length >= MAX_RESULTS) return { error: 'the search answer is a full page (as many results as asked for): the check is incomplete' };
  if (isObj(v) && Number.isFinite(v.resultSizeEstimate) && v.resultSizeEstimate > msgs.length) return { error: 'the search answer says there are more results: the check is incomplete' };
  const them = emailBase(item.to);
  const mine = own ? emailBase(own) : null;
  for (const m of msgs) {
    const from = senderOf(m);
    if (from === UNCLEAR) return { error: "the search answer can't be read (a sender field that reads two ways)" };
    if (!from) return { error: "the search answer can't be read (a message with no sender)" };
    const base = emailBase(from);
    if (mine && base === mine) continue;
    const kind = BOUNCER.test(from) || DSN_SUBJECT.test(subjectOf(m)) ? 'bounce' : base === them ? (autoReply(m) ? 'auto_reply' : 'reply') : null;
    // The query asks only for them and for bounces: any other sender means it wasn't run as given, or the answer
    // isn't what floorboss reads. Stop rather than guess.
    if (!kind) return { error: `the search answer has a message from someone else (${from}): the check can't be trusted` };
    return { stop: kind, evidence: `${from} ${dateOf(m)} ${subjectOf(m)}`.replace(/\s+/g, ' ').trim().slice(0, 200) };
  }
  return { go: true };
}

// The thread check before a follow-up: the thread of the person's earlier message, read with the thread tool. Its
// answer's shape wasn't captured from a live run: assumed to be structuredContent { messages | emails: [...] } (one of
// them), each item in the search's shape, with a thread id beside it at most; anything else stops the run.
// Every message in it from the user's own recorded address is theirs; any other (the person, a colleague who answered
// for them, an out-of-office, a bounce) stops that person. The thread must hold the user's own earlier message, and
// every message must be in the thread asked for.
export const THREAD_MAX = 50;
export const threadArgs = (item) => ({ thread_id: item.thread_id, max_messages: THREAD_MAX });
const THREAD_ALONGSIDE = new Set(['thread_id', 'id', 'next_page_token']);
export function decideThread(item, answerText, { own = null } = {}) {
  const a = readAnswer(answerText);
  if (!a.ok) return { error: `the thread answer can't be read (${a.why})` };
  if (!a.envelope) return { error: "the thread answer can't be read (not the thread tool's result)" };
  const v = a.value;
  const fw = failedWhy(v);
  if (fw) return { error: `the thread answer can't be read (${fw})` };
  const keys = ['messages', 'emails'].filter((k) => k in v);
  if (keys.length !== 1 || !Array.isArray(v[keys[0]]) || Object.keys(v).some((k) => k !== keys[0] && !THREAD_ALONGSIDE.has(k)))
    return { error: "the thread answer can't be read (not a list of the thread's messages)" };
  if (v.next_page_token != null && v.next_page_token !== '') return { error: 'the thread answer has more pages: the check is incomplete' };
  const msgs = v[keys[0]];
  if (!msgs.every(isObj)) return { error: "the thread answer can't be read (not a list of messages)" };
  if (msgs.length >= THREAD_MAX) return { error: 'the thread answer is as long as asked for: the check is incomplete' };
  const want = item.thread_id;
  if (typeof want !== 'string' || !want) return { error: 'no thread is recorded for the earlier message' };
  if ((v.thread_id != null && v.thread_id !== want) || msgs.some((m) => m.thread_id != null && m.thread_id !== want)) return { error: 'the thread answer holds another thread' };
  const mine = own ? emailBase(own) : null;
  if (!mine) return { error: 'no sending address is recorded' };
  let ownSeen = false;
  let stop = null;
  for (const m of msgs) {
    const from = senderOf(m);
    if (from === UNCLEAR) return { error: "the thread answer can't be read (a sender field that reads two ways)" };
    if (!from) return { error: "the thread answer can't be read (a message with no sender)" };
    if (emailBase(from) === mine) {
      ownSeen = true;
      continue;
    }
    if (!stop) {
      const kind = BOUNCER.test(from) || DSN_SUBJECT.test(subjectOf(m)) ? 'bounce' : autoReply(m) ? 'auto_reply' : 'reply';
      stop = { stop: kind, evidence: `${from} ${dateOf(m)} ${subjectOf(m)}`.replace(/\s+/g, ' ').trim().slice(0, 200) };
    }
  }
  if (!ownSeen) return { error: "the thread answer doesn't hold your earlier message: it isn't the thread floorboss asked for" };
  return stop || { go: true };
}

// The connected Gmail account, from the profile tool's answer (structuredContent.email): { email } or { error }.
export function profileEmail(answerText) {
  const a = readAnswer(answerText);
  if (!a.ok) return { error: `the profile answer can't be read (${a.why})` };
  if (!a.envelope) return { error: "the profile answer can't be read (not the profile tool's result)" };
  const fw = failedWhy(a.value);
  if (fw) return { error: `the profile answer can't be read (${fw})` };
  const e = typeof a.value.email === 'string' ? plainAddress(a.value.email.trim().toLowerCase()) : null;
  if (!e) return { error: "the profile answer holds no readable email address" };
  return { email: e };
}
// The same account: case aside, and as Gmail reads an address (dots in a gmail.com name, a +tag).
export const sameAccount = (a, b) => {
  const x = emailBase(String(a || '').trim().toLowerCase());
  return !!x && x === emailBase(String(b || '').trim().toLowerCase());
};

// What the decision writes: always reply_checked from the mailbox; a reply or an auto-reply stops them (replied), a
// bounce marks the address bounced. All at once. An error writes nothing: it stops the run.
export function apply(evDir, item, result, nowMs) {
  if (!result || result.error || !(result.go || ['reply', 'bounce', 'auto_reply'].includes(result.stop))) throw new Error(`the search couldn't be read: that stops the run (${result?.error || 'no decision'})`);
  const led = ledgerOf(evDir);
  const at = new Date(nowMs);
  // The bounce is for the last message that went to them (none yet: the address itself).
  const p = fold(readLedger(led).entries).people[item.id];
  const last = Math.max(0, ...Object.entries(p?.touches || {}).filter(([t, x]) => Number(t) > 0 && x.sent).map(([t]) => Number(t)));
  inOneGo(led, () => {
    append(led, { type: 'reply_checked', who: 'mailbox', id: item.id, source: 'mailbox' }, at);
    if (result.stop === 'reply' || result.stop === 'auto_reply')
      append(led, { type: 'replied', who: 'mailbox', id: item.id, source: 'autosend', outcome: result.stop === 'reply' ? 'replied' : 'auto_reply', text: String(result.evidence || '').slice(0, 200) }, at);
    if (result.stop === 'bounce') append(led, { type: 'bounced', who: 'mailbox', id: item.id, ...(last ? { touch: last } : {}), why: String(result.evidence || '').slice(0, 200) }, at);
  });
  return result;
}
