// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// What the guard reads for itself in a connected tool's raw answer (PostToolUse's tool_response), for an unattended
// run: who wrote in a mailbox answer, and what a CRM logged. Claude's report of the same answer never counts.
// Two mailbox shapes (Gmail-like: messages[] with from, or the claude.ai Gmail connector's sender, and date;
// Outlook-like: value[] with from.emailAddress and receivedDateTime), a thread search's (threads[] with messageCount
// and up to five messages each, or {} for none) and two CRM shapes (HubSpot-like engagements; Pipedrive-like mail
// messages), as the stand-ins in examples/standins/ answer (gmail-real.mjs: the claude.ai Gmail connector's). Anything else, an error, a page that says more follow, or a message the guard can't read
// whole is "unreadable": no witness, and the follow-up is held.

const ADDRESS = /^[^@\s<>"]+@[^@\s<>"]+$/;
// One address, or null. A text with more than one "<" or ">" ('"Me <me@x>" <bo@y>', "Me <me@x>, Bo <bo@y>") names more
// than one, and floorboss can't tell which is the sender: null, so the message is one it can't read.
export const addressOf = (v) => {
  const s = String(v ?? '').trim();
  if ((s.match(/</g) || []).length > 1 || (s.match(/>/g) || []).length > 1) return null;
  const inner = /<([^<>]+)>/.exec(s)?.[1] ?? s;
  const a = inner.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
  return ADDRESS.test(a) ? a : null;
};
// A time floorboss can place for sure, as ms, or null: epoch seconds or milliseconds, ISO 8601 with a zone, RFC 2822
// with a four-digit year and a zone, or Pipedrive's "2026-10-14 09:12:00" (UTC with no zone), and only from 2000 to
// 2099. Anything else ("Oct 12", "01/11/2026", "0", a year-1970 date) is no time: V8's own reading of such text guesses.
const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const RFC2822 = /^(?:[A-Za-z]{3},\s*)?\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[+-]\d{4}|GMT|UTC|UT|Z|[ECMP][SD]T)(?:\s*\([^()]{0,40}\))?$/i;
const YEARS = [Date.UTC(2000, 0, 1), Date.UTC(2100, 0, 1)];
const timeOf = (v) => {
  if (v == null || v === '') return null;
  let t = null;
  if (typeof v === 'number' || /^\d{10,14}$/.test(String(v))) {
    const n = Number(v);
    t = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : null;
  } else {
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) t = Date.parse(`${s.replace(' ', 'T')}Z`);
    else if (ISO_ZONED.test(s) || RFC2822.test(s)) t = Date.parse(s);
  }
  return Number.isFinite(t) && t >= YEARS[0] && t < YEARS[1] ? t : null;
};
const oneLine = (v, n) =>
  String(v ?? '')
    .replace(/\p{Cf}+/gu, '')
    .replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);

// Two values as the same data: the same JSON, whatever the order of an object's keys.
const canonJson = (v) => {
  const canon = (x) =>
    Array.isArray(x) ? x.map(canon) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x;
  try {
    return JSON.stringify(canon(v));
  } catch {
    return null;
  }
};
// The answer as one value: a JSON text in the content blocks an MCP tool returns, its structured content, or an object
// as it came. { ok: true, value, form } or { ok: false, why }. form: how it came, "text" (one text block, or a text as
// the whole answer), "structured" (structuredContent alone), "both" (structuredContent and one text block holding the
// same data) or "object" (a bare object, no tool-result wrapper). When an answer has both structuredContent and content
// blocks, they must be one text block holding exactly the same data: text and structured data that disagree (a search
// hit in the text beside an empty structuredContent, an error text beside {}) is an answer floorboss can't read.
export function rawValue(resp) {
  if (resp == null) return { ok: false, why: 'the tool gave no answer' };
  const blocks = Array.isArray(resp) ? resp : Array.isArray(resp?.content) ? resp.content : null;
  if (!Array.isArray(resp) && typeof resp === 'object' && (resp.isError === true || resp.is_error === true)) {
    const text = (blocks || []).map((b) => (typeof b?.text === 'string' ? b.text : '')).join(' ');
    return { ok: false, why: `the tool answered with an error${text ? `: ${oneLine(text, 160)}` : ''}`, error: true };
  }
  const oneText = () => {
    const texts = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text);
    if (texts.length !== 1 || blocks.length !== 1) return { ok: false, why: "the answer isn't one block of data floorboss can read" };
    try {
      return { ok: true, value: JSON.parse(texts[0]) };
    } catch {
      return { ok: false, why: "the answer isn't data floorboss can read" };
    }
  };
  if (!Array.isArray(resp) && resp && typeof resp === 'object' && resp.structuredContent != null) {
    const sc = resp.structuredContent;
    if (!sc || typeof sc !== 'object') return { ok: false, why: "the answer's structured data isn't data floorboss can read" };
    if (!('content' in resp)) return { ok: true, value: sc, form: 'structured' };
    if (!blocks) return { ok: false, why: "the answer's content isn't a list of blocks floorboss can read" };
    const t = oneText();
    if (!t.ok) return { ok: false, why: `the answer has structured data and text floorboss can't match (${t.why})` };
    if (canonJson(t.value) !== canonJson(sc)) return { ok: false, why: "the answer's text and its structured data don't say the same thing" };
    return { ok: true, value: sc, form: 'both' };
  }
  if (typeof resp === 'string') {
    try {
      return { ok: true, value: JSON.parse(resp), form: 'text' };
    } catch {
      return { ok: false, why: "the answer isn't data floorboss can read" };
    }
  }
  if (blocks) {
    const t = oneText();
    return t.ok ? { ...t, form: 'text' } : t;
  }
  if (typeof resp === 'object') return { ok: true, value: resp, form: 'object' };
  return { ok: false, why: "the answer isn't data floorboss can read" };
}

const header = (m, name) => {
  const hs = m?.payload?.headers;
  if (!Array.isArray(hs)) return null;
  const h = hs.find((x) => String(x?.name || '').toLowerCase() === name);
  return h ? h.value : null;
};
// A sender as an answer gives it: a plain address, "Name <address>", or an object holding one (email, address,
// emailAddress.address, value). null when none of those is there.
const senderOf = (v) => {
  if (v == null) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return v.email ?? v.address ?? v.emailAddress?.address ?? v.value ?? null;
  return typeof v === 'string' ? v : null;
};
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// The addresses a message went to, as an answer gives them (the claude.ai Gmail connector's toRecipients, ccRecipients
// and bccRecipients; to, cc and bcc; Outlook's toRecipients of emailAddress objects), or null when it gives none, or
// one floorboss can't read as one address.
const recipientsOf = (m) => {
  const given = [m.toRecipients, m.ccRecipients, m.bccRecipients, m.to, m.cc, m.bcc].filter((v) => v != null);
  if (!given.length) return null;
  const out = [];
  for (const v of given.flatMap((x) => (Array.isArray(x) ? x : [x]))) {
    const a = addressOf(senderOf(v));
    if (!a) return null;
    out.push(a);
  }
  return out;
};
// A thread search's answer (Gmail's search_threads: threads[], each with its id, messageCount and up to five of its
// messages): every thread and the messages shown. { ok, threads: [{ id, count, messages }], paged } or { ok: false }.
// An empty object is the connector's way of saying "nothing matched" (zero threads), not an error.
export function threadsOf(value) {
  if (isPlainObject(value) && !Object.keys(value).length) return { ok: true, threads: [], paged: false };
  if (!isPlainObject(value) || !Array.isArray(value.threads)) return { ok: false, why: "floorboss can't read this thread search's shape" };
  if (value.threads.length > 500) return { ok: false, why: 'the thread search answered with too many threads for floorboss to read whole' };
  const threads = [];
  for (const t of value.threads) {
    if (!isPlainObject(t) || t.id == null || t.id === '') return { ok: false, why: "a thread in the answer isn't one floorboss can read" };
    const messages = t.messages == null ? [] : t.messages;
    if (!Array.isArray(messages)) return { ok: false, why: "a thread's messages in the answer aren't a list floorboss can read" };
    // A count is a whole number as the answer gives it: "", false, [] or true read as 0 or 1 by Number(), and would let
    // a thread that shows fewer messages than it holds read as whole.
    const count = t.messageCount == null ? null : t.messageCount;
    if (count != null && !(Number.isInteger(count) && count >= 0)) return { ok: false, why: "a thread's message count in the answer isn't a number" };
    threads.push({ id: String(t.id), count, messages });
  }
  return { ok: true, threads, paged: !!value.nextPageToken };
}
// A mailbox answer's messages: { ok, shape, messages: [{ from, at, thread, draft }] } or { ok: false, why }.
export function mailMessages(value) {
  let shape, list, partial;
  // A thread search (search_threads): read only when every thread shows all its messages and no page follows.
  if (isPlainObject(value) && (Array.isArray(value.threads) || !Object.keys(value).length)) {
    const t = threadsOf(value);
    if (!t.ok) return t;
    if (t.paged || t.threads.some((x) => x.count == null || x.count > x.messages.length))
      return { ok: false, why: 'the mailbox answered with only some of the messages (a thread shows fewer than it holds, or more pages follow): floorboss reads a whole answer only' };
    return mailMessages({ messages: t.threads.flatMap((x) => x.messages.map((m) => (isPlainObject(m) ? { threadId: x.id, ...m } : m))) });
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.messages)) {
    shape = 'gmail';
    list = value.messages;
    partial = !!value.nextPageToken || (Number.isFinite(Number(value.resultSizeEstimate)) && Number(value.resultSizeEstimate) > list.length);
  } else if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.value)) {
    shape = 'outlook';
    list = value.value;
    partial = !!value['@odata.nextLink'];
  } else return { ok: false, why: "floorboss can't read this mailbox answer's shape" };
  if (partial) return { ok: false, why: 'the mailbox answered with one page of several: floorboss reads a whole answer only' };
  if (list.length > 500) return { ok: false, why: 'the mailbox answer is too long for floorboss to read whole' };
  const messages = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') return { ok: false, why: "a message in the answer isn't one floorboss can read" };
    const draft = shape === 'gmail' ? (Array.isArray(m.labelIds) && m.labelIds.includes('DRAFT')) || m.isDraft === true : m.isDraft === true;
    // Gmail-like: "from" (a text or an object), the claude.ai Gmail connector's "sender" (a text or an object), or the
    // From header. A message that names two different senders is one floorboss can't read.
    const named = shape === 'gmail' ? [senderOf(m.from), senderOf(m.sender), header(m, 'from')].filter((x) => x != null && x !== '') : [];
    if (shape === 'gmail' && new Set(named.map((x) => addressOf(x) || x)).size > 1) return { ok: false, why: 'a message in the answer names two different senders' };
    const rawFrom = shape === 'gmail' ? named[0] ?? null : m.from?.emailAddress?.address ?? m.sender?.emailAddress?.address;
    // The latest of the times the answer gives: a Date header is the sender's to set, and one dated before the window
    // never hides a message the mailbox received inside it. A time given that floorboss can't place for sure makes the
    // message one it can't read (a reply dated "Oct 12" could be read as 2001, before the window).
    const given = (shape === 'gmail' ? [m.date, m.internalDate, header(m, 'date'), m.receivedAt] : [m.receivedDateTime, m.sentDateTime]).filter((v) => v != null && v !== '');
    const times = given.map(timeOf);
    if (!draft && times.some((t) => t == null)) return { ok: false, why: "a message in the answer has a date floorboss can't place for sure" };
    const from = addressOf(rawFrom);
    const placed = times.filter((t) => t != null);
    const at = placed.length ? Math.max(...placed) : null;
    if (!draft && (!from || at == null)) return { ok: false, why: 'a message in the answer has no sender or date floorboss can read' };
    const id = m.id ?? m.messageId ?? null;
    messages.push({ from, at, thread: String((shape === 'gmail' ? m.threadId ?? m.thread_id ?? value.id : m.conversationId) ?? '') || null, draft, auto: m.autoReply === true, id: id == null || id === '' ? null : String(id).slice(0, 200), to: recipientsOf(m) });
  }
  return { ok: true, shape, messages };
}

// The user's own addresses as a test: an address is theirs when it is one of them, or one of them with a "+tag" after
// the name (me+events@…, which their mailbox delivers as theirs). null when none is known.
export function ownTest(own = []) {
  const base = (a) => a.replace(/\+[^@]*@/, '@');
  const mine = new Set(own.map(addressOf).filter(Boolean).map(base));
  if (!mine.size) return null;
  return (a) => !!a && mine.has(base(a));
}
// The mailbox witness: how many messages came from anyone but the user since floorboss's last message to this person.
// Auto-replies and bounces count (with nobody there, an out-of-office waits for the user too). own: the user's own
// addresses. sinceMs: the start of the day floorboss's last message went (in UTC, a day early: never later than it).
// thread: the answer is one whole thread in its own order (Gmail's get_thread): a message from anyone but the user
// that comes after the user's first own message in the window counts too, whatever date it carries. own_ids: the ids of
// the user's own messages the answer showed (a draft that threads by the message it replies to must name one of them).
export function mailWitness(resp, { own = [], sinceMs, thread = false }) {
  const r = rawValue(resp);
  if (!r.ok) return { readable: false, why: r.why };
  const m = mailMessages(r.value);
  if (!m.ok) return { readable: false, why: m.why };
  // A whole thread (get_thread): its messageCount counts its drafts, which messages leaves out, so a count above the
  // messages shown is a draft (one of the follow-up's own, or yours), not part of the thread missing. A count that isn't
  // a whole number, or is below the messages shown, isn't an answer floorboss can read.
  if (thread && r.value && typeof r.value === 'object' && r.value.messageCount != null) {
    const c = r.value.messageCount;
    if (!(Number.isInteger(c) && c >= 0)) return { readable: false, why: "the thread's message count in the answer isn't a number" };
    if (c < m.messages.length) return { readable: false, why: `the thread shows ${m.messages.length} messages but counts ${c}` };
  }
  const isMine = ownTest(own);
  if (!isMine) return { readable: false, why: "floorboss doesn't know your own address (own_email), so it can't tell your messages from theirs" };
  const after = m.messages.filter((x) => !x.draft && x.at >= sinceMs);
  const firstOwn = thread ? m.messages.findIndex((x) => !x.draft && x.at >= sinceMs && isMine(x.from)) : -1;
  const inbound = m.messages.filter((x, i) => !x.draft && !isMine(x.from) && (x.at >= sinceMs || (firstOwn >= 0 && i > firstOwn)));
  // The user's own email this follow-up answers went in this window: an answer with nothing in it at all can't be
  // shown to cover the time since (a search that left sent mail out, or a narrower one). (Anything in from them holds
  // whether or not their own email is shown.)
  if (!after.length) return { readable: false, why: "the answer doesn't show your own last email to them, so floorboss can't tell the read covered the time since it (the mailbox read must include sent mail)" };
  const ownIds = [...new Set(m.messages.filter((x) => !x.draft && isMine(x.from) && x.id).map((x) => x.id))].slice(0, 50);
  // Your latest own message in the answer (the latest date; of two with one date, the later in the answer): a draft
  // that replies by message id must reply to this one (hooks/guard/unattended.mjs).
  const last = m.messages.reduce((best, x) => (!x.draft && isMine(x.from) && (!best || x.at >= best.at) ? x : best), null);
  return {
    readable: true,
    shape: m.shape,
    messages: m.messages.length,
    inbound: inbound.length,
    outbound: after.filter((x) => isMine(x.from)).length,
    own_ids: ownIds,
    own_last: last ? { id: last.id, at: new Date(last.at).toISOString() } : null,
    inbound_from: inbound.slice(0, 5).map((x) => ({ from: x.from, at: new Date(x.at).toISOString(), auto: !!x.auto }))
  };
}

// The search's two plain holds (said as they are, never as "couldn't be read").
export const SEARCH_UNPROVEN = "floorboss's search of your mailbox didn't find your own last email to them, so it can't trust that search";
export const YOU_WROTE = "you wrote to them yourself since floorboss's last email";
// The second mailbox witness for a Gmail-like connector (lib/unattended-drafts.mjs gmailReads): a search for anything
// from or to this person since shortly before your last email (search_threads "in:anywhere {from:<them> to:<them>}
// after:<epoch seconds>"). The search must prove it covered that time: a clean read is a successful call in the
// connector's documented shape ({ threads: [...] }, each thread with its messageCount, nothing beside them, in a tool
// result: a text block, structured data, or both saying the same) that shows your own last email to them (by its
// message id, ownId; only when no id is recorded, a message of yours dated at or after sinceMs), and every message of
// every thread it shows (only the thread of your last email, ownThread, which the thread read reads whole, may show
// fewer than it holds). An empty answer ({}) is never clean: it doesn't show your own email. Then: inbound, the
// conversations with something from them; others, those with something from anyone else but you (in ownThread only
// what is dated since sinceMs counts; in any other conversation the search matched, every message counts, whatever its
// date); own_after, the emails you wrote to them after your last floorboss one (by its date). Any of them holds.
// own: your addresses; contact: theirs.
export function mailFromWitness(resp, { own = [], contact = null, sinceMs = NaN, ownId = null, ownThread = null } = {}) {
  const r = rawValue(resp);
  if (!r.ok) return { readable: false, why: r.why };
  if (r.form === 'object') return { readable: false, why: "the search's answer didn't come as a tool result floorboss can read (a text block or structured data)" };
  const t = threadsOf(r.value);
  if (!t.ok) return { readable: false, why: t.why };
  if (t.paged) return { readable: false, why: 'the search answered with more pages: floorboss reads a whole answer only' };
  // Beside its conversations, the claude.ai Gmail connector gives its own guess of how many matched
  // (resultCountEstimate, a text such as "1"): allowed as that, never read. Any other key (omittedContent, which it
  // gives when it filtered something out, or one floorboss doesn't know) is unreadable.
  const extra = Object.keys(r.value).filter((k) => k !== 'threads' && !(k === 'resultCountEstimate' && (typeof r.value[k] === 'string' || typeof r.value[k] === 'number')));
  if (extra.length) return { readable: false, why: `the search answered with "${oneLine(extra[0], 40)}" beside its conversations, which isn't the connector's answer` };
  const isMine = ownTest(own);
  if (!isMine) return { readable: false, why: "floorboss doesn't know your own address (own_email), so it can't tell your messages from theirs" };
  const them = addressOf(contact);
  if (!them || !Number.isFinite(sinceMs)) return { readable: false, why: "floorboss doesn't know whose mail, or since when, this search was for" };
  const ownTh = String(ownThread ?? '');
  // Gmail's messageCount counts the thread's drafts, which it never shows. In the thread of your last email a count above
  // what is shown isn't a hold: get_thread reads that thread whole (its drafts left out too), and the search shows only
  // up to five related messages of it. In any other conversation a draft can't be told from a message not shown, so a
  // count above what is shown holds (a draft of yours to them in another conversation included).
  for (const th of t.threads) {
    if (th.count == null) return { readable: false, why: "a conversation in the search's answer gives no message count, so floorboss can't tell it shows all of it" };
    if (th.count > th.messages.length && th.id !== ownTh)
      return { readable: false, why: `the search shows ${th.messages.length} of the ${th.count} messages of a conversation with them, so floorboss can't tell what the rest say` };
    if (!th.messages.length && th.id !== ownTh) return { readable: false, why: "the search matched a conversation with them that shows none of its messages, so floorboss can't tell what in it is from them" };
  }
  // Each message is counted in the conversation the answer lists it under (its own threadId never moves it).
  const m = mailMessages({ messages: t.threads.flatMap((x) => x.messages.map((y) => (isPlainObject(y) ? { ...y, threadId: x.id } : y))) });
  if (!m.ok) return { readable: false, why: m.why };
  const mine = m.messages.filter((x) => !x.draft && isMine(x.from));
  // With floorboss's message id recorded, only that message proves the search covered the time since: an email of
  // yours that floorboss didn't send never stands in for it (it is one you wrote to them yourself). The earliest own
  // message dated since the start is the proof only when no id is recorded.
  const known = ownId != null && ownId !== '';
  const byId = known ? mine.find((x) => x.id === String(ownId)) : null;
  const fb = known ? byId || null : mine.filter((x) => x.at >= sinceMs).sort((a, b) => a.at - b.at)[0] || null;
  if (!fb) return { readable: false, plain: true, why: SEARCH_UNPROVEN };
  // What counts: in your thread with them (ownThread, which get_thread reads whole and in order), a message dated since
  // the start; in any other conversation the search matched, every message from anyone but you, whatever date it shows.
  // after: already kept the search to what came in since the start, and a date that reads older is no reason to trust
  // it (a message's date text is the sender's to set).
  const counted = m.messages.filter((x) => !x.draft && !isMine(x.from) && (x.thread !== ownTh || x.at >= sinceMs));
  const convs = (list) => new Set(list.map((x) => x.thread)).size;
  return {
    readable: true,
    shape: 'threads',
    covered: true,
    found_by: byId ? 'id' : 'date',
    threads: t.threads.length,
    inbound: convs(counted.filter((x) => x.from === them)),
    others: convs(counted.filter((x) => x.from !== them)),
    // An email of yours to them (or one whose recipients the answer doesn't give) after your last floorboss one.
    own_after: mine.filter((x) => x !== fb && (fb.id == null || x.id !== fb.id) && x.at >= fb.at && (x.to == null || x.to.includes(them))).length
  };
}

// A CRM answer's activities: { ok, shape, activities: [{ aid, type, dir, from, at, subject, text }] } or { ok: false }.
export function crmActivities(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.results)) {
    const list = value.results;
    if (value.paging?.next || value.hasMore === true || (Number.isFinite(Number(value.total)) && Number(value.total) > list.length))
      return { ok: false, why: 'the CRM answered with one page of several: floorboss reads a whole answer only' };
    const out = [];
    for (const r of list) {
      const e = r?.engagement || {};
      const p = r?.properties || {};
      // A logged LinkedIn, SMS or WhatsApp message (HubSpot's communications) is said by its channel.
      const channel = String(p.hs_communication_channel_type ?? r?.metadata?.channelType ?? '').toUpperCase();
      const type = String(e.type ?? p.hs_engagement_type ?? r?.type ?? (channel ? 'COMMUNICATION' : '')).toUpperCase().replace(/^COMMUNICATIONS?$/, channel || 'COMMUNICATION');
      const aid = r?.id ?? e.id;
      const at = timeOf(e.timestamp ?? p.hs_timestamp ?? r?.createdAt);
      // An email's direction, and a call's (INBOUND: they called).
      const dirWord = String(p.hs_email_direction ?? p.hs_call_direction ?? r?.metadata?.direction ?? '').toUpperCase();
      const dir =
        type === 'INCOMING_EMAIL' || dirWord === 'INCOMING_EMAIL' || dirWord === 'INBOUND'
          ? 'in'
          : type === 'EMAIL' || dirWord === 'EMAIL' || dirWord === 'FORWARDED_EMAIL' || dirWord === 'OUTBOUND'
            ? 'out'
            : null;
      if (aid == null || aid === '' || at == null || !type) return { ok: false, why: "an activity in the CRM's answer has no id, kind or time floorboss can read" };
      out.push({
        aid: String(aid).slice(0, 120),
        type,
        dir,
        from: addressOf(r?.metadata?.from?.email ?? p.hs_email_from_email),
        at,
        // When it was logged: an activity logged since floorboss's last message counts even when it is dated before.
        logged: Math.max(at, ...[e.createdAt, r?.createdAt, p.hs_createdate].map(timeOf).filter((t) => t != null)),
        subject: oneLine(r?.metadata?.subject ?? p.hs_email_subject ?? p.hs_meeting_title ?? '', 160),
        text: oneLine(r?.metadata?.text ?? p.hs_body_preview ?? p.hs_note_body ?? '', 600)
      });
    }
    return { ok: true, shape: 'hubspot', activities: out };
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && 'success' in value && 'data' in value) {
    if (value.success !== true) return { ok: false, why: 'the CRM answered that the read did not succeed' };
    if (value.additional_data?.pagination?.more_items_in_collection === true) return { ok: false, why: 'the CRM answered with one page of several: floorboss reads a whole answer only' };
    const list = value.data == null ? [] : value.data;
    if (!Array.isArray(list)) return { ok: false, why: "floorboss can't read this CRM answer's shape" };
    const out = [];
    for (const r of list) {
      const at = timeOf(r?.message_time ?? r?.add_time);
      if (r?.id == null || at == null) return { ok: false, why: "an activity in the CRM's answer has no id or time floorboss can read" };
      out.push({
        aid: String(r.id).slice(0, 120),
        type: 'EMAIL',
        dir: r.sent_flag === 0 || r.sent_flag === '0' ? 'in' : r.sent_flag === 1 || r.sent_flag === '1' ? 'out' : null,
        from: addressOf(Array.isArray(r.from) ? r.from[0]?.email_address : r.from),
        at,
        logged: Math.max(at, ...[r?.add_time].map(timeOf).filter((t) => t != null)),
        subject: oneLine(r.subject ?? '', 160),
        text: oneLine(r.snippet ?? '', 600)
      });
    }
    return { ok: true, shape: 'pipedrive', activities: out };
  }
  return { ok: false, why: "floorboss can't read this CRM answer's shape" };
}

// Text that speaks to the model reading it: a note like this can never be a reason to go on (CRM text is data), so a
// "go" on it is recorded as a hold.
export const STEERS = /\b(floorboss|claude|assistant|chatgpt|ai agent|ignore|disregard|instructions?|unrelated|go ahead|proceed|safe to send|send (it|the|this|anyway)|not a reply|judge|judg(e|ement)|hold|release)\b/i;

// What the model may judge (section 9.8 of the design): a note, a task, a deal, stage or property change, and an email
// or a call the CRM shows going out (a colleague's, or someone else's on a thread they were copied on). Everything
// else is held by code as from the contact, including what floorboss can't tell isn't from them: a logged LinkedIn,
// SMS, WhatsApp or chat message, a call with no direction, a kind it doesn't know. Unsure holds.
const JUDGED_KINDS = /^(NOTE|TASK)$|DEAL|STAGE|LIFECYCLE|PROPERTY|ENRICH|WORKFLOW/;
export function fromContact(a, them) {
  if (a.dir === 'in' || (!!them && a.from === them) || /INCOMING|MEETING|BOUNCE|UNSUB|OPT_?OUT/.test(a.type)) return true;
  if (JUDGED_KINDS.test(a.type)) return false;
  if (/EMAIL/.test(a.type)) return !(a.dir === 'out' || !!a.from);
  if (/CALL/.test(a.type)) return a.dir !== 'out';
  return true;
}
const subjectKey = (s) =>
  String(s ?? '')
    .replace(/^\s*((re|fwd?|aw|sv|wg)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
// The CRM witness: every activity logged since floorboss's last message to this person, sorted into what came from
// them (always holds, by code: fromContact), floorboss's own emails as the CRM logged them ("ours", nothing to judge),
// and the rest (for the model's judgement: hold, or go with the approved text). contact: their address; ours: the
// emails floorboss sent them, { day (YYYY-MM-DD), subject }. An outgoing email of the user's counts as ours only when it
// has one of those subjects, within a day of that send, and only one per send: anything else they wrote by hand is
// judged and shown.
export function crmWitness(resp, { contact, own = [], sinceMs, ours = [] }) {
  const r = rawValue(resp);
  if (!r.ok) return { readable: false, why: r.why };
  const c = crmActivities(r.value);
  if (!c.ok) return { readable: false, why: c.why };
  if (c.activities.length > 100) return { readable: false, why: 'the CRM logged more than 100 activities for this person: too many to judge with nobody there' };
  const isMine = ownTest(own) || (() => false);
  const them = addressOf(contact);
  const left = ours.filter((o) => /^\d{4}-\d{2}-\d{2}$/.test(String(o?.day || '')) && subjectKey(o.subject)).map((o) => ({ day: o.day, key: subjectKey(o.subject) }));
  const near = (at, day) => [-1, 0, 1].some((k) => new Date(at + k * 864e5).toISOString().slice(0, 10) === day);
  const seen = [];
  for (const a of [...c.activities].sort((x, y) => x.at - y.at)) {
    if (Math.max(a.at, a.logged ?? a.at) < sinceMs) continue;
    const fromThem = fromContact(a, them);
    let ours = false;
    if (!fromThem && /EMAIL/.test(a.type) && a.dir === 'out' && (!a.from || isMine(a.from))) {
      const i = left.findIndex((o) => o.key === subjectKey(a.subject) && near(a.at, o.day));
      if (i >= 0) {
        ours = true;
        left.splice(i, 1);
      }
    }
    seen.push({
      aid: a.aid,
      kind: fromThem ? 'from_contact' : ours ? 'ours' : 'other',
      type: a.type,
      at: new Date(a.at).toISOString(),
      from: a.from,
      subject: a.subject,
      steers: STEERS.test(`${a.subject} ${a.text}`)
    });
  }
  return {
    readable: true,
    shape: c.shape,
    activities: seen,
    from_contact: seen.filter((x) => x.kind === 'from_contact').length,
    others: seen.filter((x) => x.kind === 'other').length
  };
}
// One activity as the log, the summary and the judgement step say it: its kind, when, who from, its subject.
export const activityLine = (a) =>
  `${String(a.type || 'activity').toLowerCase().replace(/_/g, ' ')} ${String(a.at).slice(0, 16).replace('T', ' ')} UTC${a.from ? ` from ${a.from}` : ''}${a.subject ? `, "${oneLine(a.subject, 100).replace(/"/g, "'")}"` : ''}`;
