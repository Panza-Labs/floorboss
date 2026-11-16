#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// A stand-in for the claude.ai Gmail connector, answering as real calls to it answered (15 Nov 2026, one test email):
// - a message (METADATA_ONLY): { addressDisplayNames: [{ displayName, emailAddress }], date (ISO 8601 with Z),
//   historyId, id, internalDate (epoch ms as a text), labelIds, sender (a bare address), sizeEstimate, threadId,
//   toRecipients, viewUrl }; MINIMAL adds subject and snippet (not seen in a real call).
// - get_thread(threadId, messageFormat): { id, messageCount, messages, viewUrl }. messageCount counts the thread's
//   drafts; messages leaves them out.
// - search_threads(query, pageSize <= 50, pageToken, view): { resultCountEstimate (a text, "1"), threads: [{ id,
//   messageCount (drafts counted), messages: up to five related messages, viewUrl }], nextPageToken? }, or {} for no
//   match. Drafts are left out of messages; sent mail is in.
// - get_message(messageId, messageFormat): one message, the same fields.
// - create_draft(to[], subject, body, replyToMessageId?): threads only by replyToMessageId; answers { id (the draft's,
//   "r" and digits), messageId, threadId, viewUrl }.
// - send_message(to[], subject, body, replyThreadId?, replyToMessageId?): records what it "sent" to
//   <STANDIN_DATA>.sent.json and answers { id, threadId, viewUrl }; a new email's id is its thread's id. It never sends
//   anything anywhere.
// - delete_draft(draftId): removes the stand-in's draft and answers {}.
// Other forms a test can ask for in the data file (mail.style), none of them the real connector's:
//   sender: "plain" (the real one, the default), "named" ("Ana Berg <ana@x>") or "object" ({ name, email });
//   date: "iso" (the real one, the default), "rfc2822" or "ms" (epoch milliseconds as a number).
// How a real connector may answer when something is off, also a choice in the data file (mail.answer: { <tool>: mode }),
// each the tool's whole result (call.mjs raw shows it as it is):
//   "is-error": isError with a sign-in message; "error-text": a plain error text beside structuredContent {}, no isError;
//   "rate-limit": { threads: [], error: "rateLimitExceeded" }; "disagree": the real answer in the text, {} as
//   structuredContent; "both": the real answer as text and as structuredContent.
// And a search word it doesn't know (mail.unread_words, below): read as text that matches nothing.
// Mail in data: mail.threads, as for the other mail stand-ins ({ thread_id, to, subject, sent_at, message_id,
// replies: [{ from, at, snippet, auto }] }). Traps: trash_message, send_draft.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { serve, trap, loadData, loadDrafts, saveDraft, deleteDraft, BadInput, RawResult } from './lib/server.mjs';
import { requireText } from './lib/mail.mjs';

const sentPath = () => (process.env.STANDIN_DATA ? `${process.env.STANDIN_DATA}.sent.json` : null);
const loadSent = () => {
  const p = sentPath();
  return p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
};
const saveSent = (m) => {
  const p = sentPath();
  if (!p) return;
  writeFileSync(p, JSON.stringify([...loadSent(), m], null, 2) + '\n');
};
const mail = () => loadData().mail || {};
const me = () => mail().address || 'me@standin.example';
const style = () => ({ sender: 'plain', date: 'iso', ...(mail().style || {}) });
const nameOf = (addr) => (addr === me() ? 'Me' : String(addr).split('@')[0].replace(/[._]/g, ' '));
const sender = (addr) => {
  const s = style().sender;
  return s === 'plain' ? addr : s === 'object' ? { name: nameOf(addr), email: addr } : `${nameOf(addr)} <${addr}>`;
};
const dateOf = (iso) => {
  const s = style().date;
  const t = Date.parse(iso);
  return s === 'ms' ? t : s === 'rfc2822' ? new Date(t).toUTCString().replace('GMT', '+0000') : new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
};
// Gmail's ids: 16 hex digits for a message or thread, "r" and 19 digits for a draft.
const hexId = () => Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const draftId = () => `r${Array.from({ length: 19 }, (_, i) => (i ? Math.floor(Math.random() * 10) : 1 + Math.floor(Math.random() * 9))).join('')}`;
// How many messages a thread holds as Gmail counts them: its drafts too.
const countOf = (tid, all) => all.filter((m) => m.threadId === tid).length + loadDrafts().filter((d) => d.server === 'gmail-real' && d.thread_id === tid).length;
// The time a send or draft is stamped with: STANDIN_NOW when a test sets it (its clock), else now.
const stamp = () => new Date(Date.parse(process.env.STANDIN_NOW || '') || Date.now()).toISOString();
const url = (kind, id) => `https://mail.google.com/mail/u/0/#${kind}/${id}`;
const toList = (v, key) => {
  const list = Array.isArray(v) ? v : null;
  if (!list || !list.length || list.some((x) => typeof x !== 'string' || !x.trim())) throw new BadInput(`"${key}" is a list of addresses.`);
  return list;
};

// Every message in the mailbox (drafts aside), oldest first: what was "sent" here, then the data's threads (the user's
// message and the replies).
function allMessages() {
  const out = [];
  for (const s of loadSent()) out.push({ id: s.id, threadId: s.threadId, from: me(), to: s.to, at: s.at, subject: s.subject, snippet: s.body.slice(0, 120), labels: ['SENT'] });
  for (const t of mail().threads || []) {
    if (t.sent_at) out.push({ id: t.message_id || `${t.thread_id}-m0`, threadId: t.thread_id, from: me(), to: [t.to], at: t.sent_at, subject: t.subject, snippet: t.snippet || '', labels: ['SENT'] });
    for (const [i, r] of (t.replies || []).entries())
      out.push({ id: `${t.thread_id}-r${i}`, threadId: t.thread_id, from: r.from, to: [me()], at: r.at, subject: `Re: ${t.subject}`, snippet: r.snippet || '', labels: ['INBOX'] });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
const shape = (m, format) => ({
  addressDisplayNames: [{ displayName: nameOf(m.from), emailAddress: m.from }],
  date: dateOf(m.at),
  historyId: String(28000 + (Date.parse(m.at) % 1000)),
  id: m.id,
  internalDate: String(Date.parse(m.at)),
  labelIds: m.labels,
  sender: sender(m.from),
  sizeEstimate: 900 + String(m.snippet || '').length,
  threadId: m.threadId,
  toRecipients: m.to,
  viewUrl: url('all', m.id),
  ...(format === 'MINIMAL' ? { subject: m.subject, snippet: m.snippet } : {})
});

// Gmail's search words this stand-in knows: from:, to:, after: and before: as YYYY/MM/DD (that midnight, UTC here) or
// as epoch seconds (that second), in:sent, in:anywhere, a bare address (either way), and {a b}, Gmail's "a or b" (one
// level, no nesting). A word named in the data file's mail.unread_words (["after:", "in:anywhere"]) is read as plain
// text that matches nothing, as a connector that doesn't know that word may read it.
function term(w) {
  const [k, ...rest] = w.split(':');
  const v = rest.join(':').toLowerCase();
  if ((mail().unread_words || []).some((u) => String(w).toLowerCase().startsWith(String(u).toLowerCase()))) return () => false;
  const day = (x) => {
    if (/^\d{9,11}$/.test(x)) return Number(x) * 1000;
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(x)) throw new BadInput(`"${w}": a date is YYYY/MM/DD or epoch seconds.`);
    return Date.parse(`${x.replace(/\//g, '-')}T00:00:00Z`);
  };
  if (k === 'from' && v) return (m) => m.from.toLowerCase() === v;
  if (k === 'to' && v) return (m) => m.to.some((a) => a.toLowerCase() === v);
  if (k === 'after' && v) return ((t) => (m) => Date.parse(m.at) >= t)(day(v));
  if (k === 'before' && v) return ((t) => (m) => Date.parse(m.at) < t)(day(v));
  if (k === 'in' && v === 'sent') return (m) => m.labels.includes('SENT');
  if (k === 'in' && v === 'anywhere') return null;
  if (!rest.length && w.includes('@')) return (m) => m.from.toLowerCase() === w.toLowerCase() || m.to.some((a) => a.toLowerCase() === w.toLowerCase());
  throw new BadInput(`This stand-in doesn't know the search word "${w}".`);
}
function matcher(query) {
  const q = String(query || '');
  if ((q.match(/\{/g) || []).length !== (q.match(/\}/g) || []).length || /\{[^}]*\{/.test(q)) throw new BadInput('A search group is {a b}, closed, with no group inside it.');
  const tests = [];
  // Each {…} group: any of its words.
  const rest = q.replace(/\{([^{}]*)\}/g, (all, inner) => {
    const any = inner.trim().split(/\s+/).filter(Boolean).map(term).filter(Boolean);
    if (any.length) tests.push((m) => any.some((f) => f(m)));
    return ' ';
  });
  for (const w of rest.trim().split(/\s+/).filter(Boolean)) {
    const f = term(w);
    if (f) tests.push(f);
  }
  return (m) => tests.every((f) => f(m));
}

// The tool's answer in the data file's mode for it (mail.answer), or as it is.
function answer(tool, payload) {
  const mode = (mail().answer || {})[tool];
  const text = (v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }];
  if (!mode) return payload;
  if (mode === 'is-error') return new RawResult({ isError: true, content: text('Request had invalid authentication credentials. Sign in to Gmail again.') });
  if (mode === 'error-text') return new RawResult({ content: text('Error: your Google sign-in expired. Reconnect Gmail.'), structuredContent: {} });
  if (mode === 'rate-limit') return new RawResult({ content: text({ threads: [], error: 'rateLimitExceeded' }) });
  if (mode === 'disagree') return new RawResult({ content: text(payload), structuredContent: {} });
  if (mode === 'both') return new RawResult({ content: text(payload), structuredContent: payload });
  throw new BadInput(`This stand-in doesn't know the answer mode "${mode}".`);
}

serve('gmail-real', {
  get_thread: {
    description: 'Get a thread and its messages. Drafts in the thread are omitted from messages; messageCount counts them.',
    inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, messageFormat: { type: 'string', enum: ['MINIMAL', 'METADATA_ONLY', 'PLAIN_TEXT', 'FULL_CONTENT'] } }, required: ['threadId'] },
    run: (args) => {
      const id = requireText(args.threadId, 'threadId');
      const msgs = allMessages().filter((m) => m.threadId === id);
      if (!msgs.length) throw new BadInput(`Thread "${id}" not found.`);
      return answer('get_thread', { id, messageCount: countOf(id, allMessages()), messages: msgs.map((m) => shape(m, args.messageFormat || 'MINIMAL')), viewUrl: url('all', id) });
    }
  },
  search_threads: {
    description: 'Search threads with Gmail search syntax. Each thread shows up to 5 related messages. An empty JSON object {} represents zero matching items, not an error. Drafts are always excluded; archived and sent messages are included. in:anywhere includes Trash; spam is filtered out.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, pageSize: { type: 'number' }, pageToken: { type: 'string' }, view: { type: 'string' } }, required: ['query'] },
    run: (args) => {
      const size = Math.min(50, Number(args.pageSize) || 20);
      const all = allMessages();
      const hit = all.filter(matcher(requireText(args.query, 'query')));
      const ids = [...new Set(hit.map((m) => m.threadId))];
      const start = args.pageToken ? Number(String(args.pageToken).replace(/^p/, '')) || 0 : 0;
      const page = ids.slice(start, start + size);
      if (!page.length) return answer('search_threads', {});
      return answer('search_threads', {
        resultCountEstimate: String(ids.length),
        threads: page.map((tid) => ({
          id: tid,
          messageCount: countOf(tid, all),
          messages: hit.filter((m) => m.threadId === tid).slice(0, 5).map((m) => shape(m, 'METADATA_ONLY')),
          viewUrl: url('all', tid)
        })),
        ...(start + size < ids.length ? { nextPageToken: `p${start + size}` } : {})
      });
    }
  },
  get_message: {
    description: 'Get one message.',
    inputSchema: { type: 'object', properties: { messageId: { type: 'string' }, messageFormat: { type: 'string' } }, required: ['messageId'] },
    run: (args) => {
      const m = allMessages().find((x) => x.id === requireText(args.messageId, 'messageId'));
      if (!m) throw new BadInput(`Message "${args.messageId}" not found.`);
      return shape(m, args.messageFormat || 'MINIMAL');
    }
  },
  create_draft: {
    description: 'Create a draft email. It is not sent. To make it a reply in an existing thread, give replyToMessageId.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'array', items: { type: 'string' } }, subject: { type: 'string' }, body: { type: 'string' }, replyToMessageId: { type: 'string' } },
      required: ['to', 'subject', 'body']
    },
    run: (args) => {
      const to = toList(args.to, 'to');
      let threadId = null;
      if (args.replyToMessageId != null) {
        const m = allMessages().find((x) => x.id === String(args.replyToMessageId));
        if (!m) throw new BadInput(`Message "${args.replyToMessageId}" not found.`);
        threadId = m.threadId;
      }
      const messageId = hexId();
      const d = { server: 'gmail-real', id: draftId(), message_id: messageId, thread_id: threadId || messageId, to: to.join(','), subject: requireText(args.subject, 'subject'), body: requireText(args.body, 'body'), created_at: stamp() };
      saveDraft(d);
      return { id: d.id, messageId: d.message_id, threadId: d.thread_id, viewUrl: url('drafts', d.id) };
    }
  },
  send_message: {
    description: 'Send an email. To reply in an existing thread, give replyThreadId or replyToMessageId.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'array', items: { type: 'string' } }, subject: { type: 'string' }, body: { type: 'string' }, replyThreadId: { type: 'string' }, replyToMessageId: { type: 'string' } },
      required: ['to', 'subject', 'body']
    },
    run: (args) => {
      const to = toList(args.to, 'to');
      const prev = args.replyToMessageId != null ? allMessages().find((x) => x.id === String(args.replyToMessageId)) : null;
      if (args.replyToMessageId != null && !prev) throw new BadInput(`Message "${args.replyToMessageId}" not found.`);
      if (args.replyThreadId != null && !allMessages().some((x) => x.threadId === String(args.replyThreadId))) throw new BadInput(`Thread "${args.replyThreadId}" not found.`);
      if (prev && args.replyThreadId != null && prev.threadId !== String(args.replyThreadId)) throw new BadInput('replyToMessageId is not in the thread replyThreadId names.');
      const id = hexId();
      // A new email starts its own thread, under its own id.
      const m = { id, threadId: prev?.threadId || (args.replyThreadId != null ? String(args.replyThreadId) : null) || id, to, subject: requireText(args.subject, 'subject'), body: requireText(args.body, 'body'), at: stamp() };
      saveSent(m);
      return { id: m.id, threadId: m.threadId, viewUrl: url('sent', m.id) };
    }
  },
  list_drafts: {
    description: 'List draft emails.',
    inputSchema: { type: 'object', properties: {} },
    run: () => ({ drafts: loadDrafts().filter((d) => d.server === 'gmail-real').map((d) => ({ id: d.id, threadId: d.thread_id, viewUrl: url('drafts', d.id) })) })
  },
  delete_draft: {
    description: 'Delete a draft.',
    inputSchema: { type: 'object', properties: { draftId: { type: 'string' } }, required: ['draftId'] },
    run: (args) => {
      const id = requireText(args.draftId, 'draftId');
      if (!loadDrafts().some((d) => d.server === 'gmail-real' && d.id === id)) throw new BadInput(`Draft "${id}" not found.`);
      deleteDraft(id);
      return {};
    }
  },
  trash_message: trap('Move a message to the trash.', { messageId: { type: 'string' } }, () => ({ ok: true })),
  send_draft: trap('Send a draft.', { draftId: { type: 'string' } }, () => ({ id: 'm-sent', threadId: 't-sent' }))
});
