#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Stand-in mail for the unattended drafts' end-to-end test (test/e2e/unattended-headless.test.mjs): Gmail-like
// shapes, a create_draft that puts the draft in the thread it is given (threadId), and a list_messages that reads one
// address's messages since a day, the user's own and the replies in data alike. It never sends anything anywhere:
// its one send tool is a trap. Each call is written to STANDIN_LOG.
import { serve, trap, loadData, newId, saveDraft, BadInput } from './lib/server.mjs';
import { requireText } from './lib/mail.mjs';

const me = () => loadData().mail?.address || 'me@standin.example';
serve('mail-c', {
  create_draft: {
    description: 'Create a draft email, as a reply in a thread when threadId is given. It is not sent.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, threadId: { type: 'string' } },
      required: ['to', 'subject', 'body']
    },
    run: (args) => {
      const d = {
        server: 'mail-c',
        id: newId('r'),
        message_id: newId('m'),
        thread_id: typeof args.threadId === 'string' && args.threadId ? args.threadId : newId('t'),
        to: requireText(args.to, 'to'),
        subject: requireText(args.subject, 'subject'),
        body: requireText(args.body, 'body'),
        created_at: new Date().toISOString()
      };
      saveDraft(d);
      return { id: d.id, message: { id: d.message_id, threadId: d.thread_id, labelIds: ['DRAFT'] } };
    }
  },
  list_messages: {
    description: 'List messages to or from an address since a day (any folder, sent mail included).',
    inputSchema: { type: 'object', properties: { address: { type: 'string' }, since: { type: 'string' } }, required: ['address'] },
    run: (args) => {
      const q = requireText(args.address, 'address').trim().toLowerCase();
      if (args.since != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(args.since))) throw new BadInput('"since" is YYYY-MM-DD.');
      const from = args.since ? Date.parse(`${args.since}T00:00:00Z`) : 0;
      const out = [];
      for (const t of (loadData().mail?.threads || []).filter((x) => String(x.to || '').toLowerCase() === q)) {
        if (t.sent_at) out.push({ id: t.message_id || `${t.thread_id}-m0`, threadId: t.thread_id, from: me(), to: t.to, date: t.sent_at, subject: t.subject });
        for (const [i, r] of (t.replies || []).entries())
          out.push({ id: `${t.thread_id}-r${i}`, threadId: t.thread_id, from: r.from, to: me(), date: r.at, subject: `Re: ${t.subject}`, autoReply: !!r.auto });
      }
      return { messages: out.filter((m) => Date.parse(m.date) >= from).sort((a, b) => String(a.date).localeCompare(String(b.date))) };
    }
  },
  send_message: trap('Send an email immediately.', { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, () => ({ id: 'm-sent', labelIds: ['SENT'] }))
});
