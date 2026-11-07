// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Mail helpers shared by mail-a and mail-b: drafts kept in memory and on disk, replies matched from data.
import { loadData, loadDrafts, saveDraft, newId, BadInput } from './server.mjs';

// ids: prefixes for draft, message and thread ids, so each shape's ids look like its own.
export function mailbox(server, ids = { draft: 'r', message: 'm', thread: 't' }) {
  const mail = loadData().mail || {};
  const me = mail.address || 'me@standin.example';
  const drafts = loadDrafts();

  function createDraft({ to, subject, body }) {
    const d = {
      server,
      id: newId(ids.draft),
      message_id: newId(ids.message),
      thread_id: newId(ids.thread),
      to,
      subject,
      body,
      created_at: new Date().toISOString()
    };
    drafts.push(d);
    saveDraft(d);
    return d;
  }

  const norm = (s) =>
    (s || '')
      .trim()
      .toLowerCase()
      .replace(/^(re|aw|sv):\s*/, '');

  // The user's own message first, then replies from data, oldest first.
  function thread(threadId) {
    const draft = drafts.find((d) => d.thread_id === threadId);
    const data = (mail.threads || []).filter(
      (t) => t.thread_id === threadId || (draft && (t.to || '').toLowerCase() === draft.to.toLowerCase() && norm(t.subject) === norm(draft.subject))
    );
    if (!draft && !data.length) throw new BadInput(`No thread "${threadId}".`);
    const own = draft
      ? { from: me, at: draft.created_at, snippet: draft.body.slice(0, 120), isDraft: true, subject: draft.subject }
      : { from: me, at: data[0].sent_at || null, snippet: data[0].snippet || '', isDraft: false, subject: data[0].subject };
    const replies = data
      .flatMap((t) => t.replies || [])
      .map((r) => ({ from: r.from, at: r.at, snippet: r.snippet || '', isDraft: false }))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return [own, ...replies];
  }

  return { me, drafts, createDraft, thread };
}

export function requireText(value, key) {
  if (typeof value !== 'string' || !value.trim()) throw new BadInput(`"${key}" is required.`);
  return value;
}
