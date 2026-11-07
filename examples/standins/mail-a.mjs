#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Stand-in mail, Gmail-like shape: drafts with r-/m-/t- ids, threads by threadId.
import { serve, trap, loadData } from './lib/server.mjs';
import { mailbox, requireText } from './lib/mail.mjs';

const box = mailbox('mail-a');

serve('mail-a', {
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
      return { id, messages: box.thread(id).map((m) => ({ from: m.from, date: m.at, snippet: m.snippet })) };
    }
  },
  search_threads: {
    description: 'Search conversations by an address. Returns how many threads include it and when the latest message was.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'an email address' } }, required: ['query'] },
    run: (args) => {
      const q = requireText(args.query, 'query').trim().toLowerCase();
      const hist = (loadData().mail?.history || []).filter((h) => String(h.with || '').toLowerCase() === q);
      const threads = (loadData().mail?.threads || []).filter((t) => String(t.to || '').toLowerCase() === q);
      const all = [...hist.map((h) => h.last_at), ...threads.map((t) => t.sent_at)].filter(Boolean).sort();
      return {
        resultSizeEstimate: hist.length + threads.length,
        threads: [...hist, ...threads].map((h, i) => ({ id: `t-h${i}`, snippet: h.subject || '' })),
        latest: all.at(-1) || null
      };
    }
  },
  list_drafts: {
    description: 'List drafts.',
    inputSchema: { type: 'object', properties: {} },
    run: () => ({
      drafts: box.drafts
        .filter((d) => d.server === 'mail-a')
        .map((d) => ({ id: d.id, message: { id: d.message_id, threadId: d.thread_id }, to: d.to, subject: d.subject }))
    })
  },
  send_message: trap('Send an email immediately.', { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, () => ({
    id: 'm-sent',
    labelIds: ['SENT']
  })),
  send_draft: trap('Send an existing draft.', { id: { type: 'string' } }, () => ({ id: 'm-sent', labelIds: ['SENT'] })),
  delete_draft: trap('Delete a draft permanently.', { id: { type: 'string' } }, () => ({}))
});
