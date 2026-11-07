#!/usr/bin/env node
// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// A stand-in for a Gmail MCP that can send, built on the stand-in lib. Same read tools as
// mail-a (create_draft, get_thread, search_threads, list_drafts) plus a send_message that records what it
// "sent" to <STANDIN_DATA>.sent.json and returns a Gmail-like id and threadId, and list_messages (by address,
// since a date) so floorboss's email.messages sync can be tested. It never sends anything anywhere.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { serve, trap, loadData, newId, BadInput } from './lib/server.mjs';
import { mailbox, requireText } from './lib/mail.mjs';

const box = mailbox('gmail');
const sentPath = () => (process.env.STANDIN_DATA ? `${process.env.STANDIN_DATA}.sent.json` : null);
const loadSent = () => {
  const p = sentPath();
  return p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
};
const saveSent = (m) => {
  const p = sentPath();
  if (!p) return;
  const all = loadSent();
  all.push(m);
  writeFileSync(p, JSON.stringify(all, null, 2) + '\n');
};
const norm = (s) =>
  (s || '')
    .trim()
    .toLowerCase()
    .replace(/^(re|aw|sv):\s*/, '');
const me = () => loadData().mail?.address || 'me@standin.example';

// Replies in data that belong to a sent message: same thread_id, or same recipient and subject.
function repliesFor(sent) {
  const threads = loadData().mail?.threads || [];
  return threads
    .filter((t) => t.thread_id === sent.threadId || ((t.to || '').toLowerCase() === sent.to.toLowerCase() && norm(t.subject) === norm(sent.subject)))
    .flatMap((t) => t.replies || [])
    .map((r) => ({ from: r.from, at: r.at, snippet: r.snippet || '', auto: !!r.auto }));
}

serve('gmail', {
  create_draft: {
    description: 'Create a draft email. It is not sent.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
      required: ['to', 'subject', 'body']
    },
    run: (args) => {
      const d = box.createDraft({ to: requireText(args.to, 'to'), subject: requireText(args.subject, 'subject'), body: requireText(args.body, 'body') });
      return { id: d.id, message: { id: d.message_id, threadId: d.thread_id, labelIds: ['DRAFT'] } };
    }
  },
  get_thread: {
    description: 'Get the messages in a thread.',
    inputSchema: { type: 'object', properties: { threadId: { type: 'string' } }, required: ['threadId'] },
    run: (args) => {
      const id = requireText(args.threadId, 'threadId');
      const sent = loadSent().find((m) => m.threadId === id);
      if (sent)
        return {
          id,
          messages: [
            { id: sent.id, from: me(), to: sent.to, date: sent.at, subject: sent.subject, snippet: sent.body.slice(0, 120) },
            ...repliesFor(sent).map((r) => ({ from: r.from, date: r.at, snippet: r.snippet }))
          ]
        };
      return { id, messages: box.thread(id).map((m) => ({ from: m.from, date: m.at, snippet: m.snippet })) };
    }
  },
  search_threads: {
    description:
      'Search conversations by an address. Returns how many threads include it and when the latest message was, and whether the person ever wrote to you.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'an email address' } }, required: ['query'] },
    run: (args) => {
      const q = requireText(args.query, 'query').trim().toLowerCase();
      const data = loadData().mail || {};
      const hist = (data.history || []).filter((h) => String(h.with || '').toLowerCase() === q);
      const threads = (data.threads || []).filter((t) => String(t.to || '').toLowerCase() === q);
      const sent = loadSent().filter((m) => m.to.toLowerCase() === q);
      const all = [...hist.map((h) => h.last_at), ...threads.map((t) => t.sent_at), ...sent.map((m) => m.at)].filter(Boolean).sort();
      const theyReplied =
        hist.some((h) => h.they_replied) || threads.some((t) => (t.replies || []).some((r) => !r.auto)) || sent.some((m) => repliesFor(m).some((r) => !r.auto));
      return {
        resultSizeEstimate: hist.length + threads.length + sent.length,
        threads: [...hist, ...threads, ...sent].map((h, i) => ({ id: h.thread_id || h.threadId || `t-h${i}`, snippet: h.subject || '' })),
        latest: all.at(-1) || null,
        fromThem: theyReplied
      };
    }
  },
  list_messages: {
    description: 'List messages to or from an address since a date (any folder, sent mail included).',
    inputSchema: { type: 'object', properties: { address: { type: 'string' }, since: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['address'] },
    run: (args) => {
      const q = requireText(args.address, 'address').trim().toLowerCase();
      const since = args.since ? Date.parse(`${args.since}T00:00:00Z`) : 0;
      const data = loadData().mail || {};
      const out = [];
      for (const t of (data.threads || []).filter((t) => String(t.to || '').toLowerCase() === q)) {
        if (t.sent_at) out.push({ id: t.message_id || `${t.thread_id}-m0`, threadId: t.thread_id, from: me(), to: t.to, date: t.sent_at, subject: t.subject });
        for (const r of t.replies || [])
          out.push({
            id: r.message_id || `${t.thread_id}-r${out.length}`,
            threadId: t.thread_id,
            from: r.from,
            to: me(),
            date: r.at,
            subject: `Re: ${t.subject}`,
            snippet: r.snippet,
            autoReply: !!r.auto
          });
      }
      for (const m of loadSent().filter((m) => m.to.toLowerCase() === q)) {
        out.push({ id: m.id, threadId: m.threadId, from: me(), to: m.to, date: m.at, subject: m.subject });
        for (const r of repliesFor(m))
          out.push({
            id: `${m.threadId}-r${out.length}`,
            threadId: m.threadId,
            from: r.from,
            to: me(),
            date: r.at,
            subject: `Re: ${m.subject}`,
            snippet: r.snippet,
            autoReply: r.auto
          });
      }
      return { messages: out.filter((m) => Date.parse(m.date) >= since).sort((a, b) => String(a.date).localeCompare(String(b.date))) };
    }
  },
  list_drafts: {
    description: 'List drafts.',
    inputSchema: { type: 'object', properties: {} },
    run: () => ({
      drafts: box.drafts
        .filter((d) => d.server === 'gmail')
        .map((d) => ({ id: d.id, message: { id: d.message_id, threadId: d.thread_id }, to: d.to, subject: d.subject }))
    })
  },
  send_message: {
    description: 'Send an email immediately.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, threadId: { type: 'string' } },
      required: ['to', 'subject', 'body']
    },
    run: (args) => {
      const to = requireText(args.to, 'to'),
        subject = requireText(args.subject, 'subject'),
        body = requireText(args.body, 'body');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new BadInput(`"${to}" isn't an email address.`);
      const at = (process.env.FLOORBOSS_NOW ? new Date(process.env.FLOORBOSS_NOW) : new Date()).toISOString();
      const m = { id: newId('m'), threadId: args.threadId || newId('t'), to, subject, body, at };
      saveSent(m);
      return { id: m.id, threadId: m.threadId, labelIds: ['SENT'] };
    }
  },
  send_draft: trap('Send an existing draft.', { id: { type: 'string' } }, () => ({ id: 'm-sent', labelIds: ['SENT'] })),
  delete_draft: trap('Delete a draft permanently.', { id: { type: 'string' } }, () => ({})),
  batch_modify_messages: trap('Add or remove labels on many messages.', { ids: { type: 'array' }, addLabelIds: { type: 'array' } }, () => ({}))
});
