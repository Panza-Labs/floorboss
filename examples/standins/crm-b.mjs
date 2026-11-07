#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Stand-in CRM, Pipedrive-like shape: nested items, DD.MM.YYYY dates, marketing_status for opt-out.
import { serve, loadData, str, BadInput, trap, newId } from './lib/server.mjs';
import { matchRecords, loadTasks, saveTask, withCreated, saveContact } from './lib/crm.mjs';

const records = withCreated(loadData().crm?.records || []);

const ddmmyyyy = (d) => (d ? d.split('-').reverse().join('.') : null);

function person(r) {
  return {
    result_score: 1,
    item: {
      id: r.index + 1,
      type: 'person',
      name: [r.first_name, r.last_name].filter(Boolean).join(' '),
      emails: r.email ? [{ value: r.email, primary: true }] : [],
      organization: r.company ? { name: r.company } : null,
      owner: r.owner ? { name: r.owner } : null,
      label: r.status || null,
      last_activity_date: ddmmyyyy(r.last_contact),
      marketing_status: r.opted_out ? 'unsubscribed' : 'subscribed'
    }
  };
}

serve('crm-b', {
  find_person: {
    description: 'Find persons by name, email or organization. The term must be at least 2 characters.',
    inputSchema: { type: 'object', properties: { term: { type: 'string' } }, required: ['term'] },
    run: (args) => {
      const term = str(args, 'term');
      if (term.trim().length < 2) throw new BadInput('"term" must be at least 2 characters.');
      return { success: true, data: { items: matchRecords(records, term).map(person) } };
    }
  },
  list_person_mail_messages: {
    description: "A person's linked mail messages: sent_flag 1 for mail you sent, 0 for mail they sent; calls and meetings are activities.",
    inputSchema: { type: 'object', properties: { person_id: { type: 'number' } }, required: ['person_id'] },
    run: (args) => {
      const at = Number(args.person_id) - 1;
      if (!Number.isInteger(at) || !records[at]) throw new BadInput(`No person with id "${args.person_id}".`);
      const r = { ...records[at], index: at };
      const data = (r.activities || [])
        .filter((a) => a.type === 'email')
        .map((a, i) => ({
          id: 7000 + r.index * 100 + i,
          subject: a.subject || '',
          snippet: a.body || '',
          from: [{ email_address: a.from || '' }],
          to: a.to ? [{ email_address: a.to }] : [],
          message_time: new Date(a.at).toISOString().replace('T', ' ').slice(0, 19),
          sent_flag: a.direction === 'in' ? 0 : 1
        }));
      return { success: true, data };
    }
  },
  add_person: {
    description: 'Add a person with a name and an email address. Nothing is sent.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, primary: { type: 'boolean' } } } }
      },
      required: ['name']
    },
    run: (args) => {
      const name = str(args, 'name');
      const email = String(args.email?.[0]?.value || '').toLowerCase();
      if (email && records.some((r) => (r.email || '').toLowerCase() === email)) throw new BadInput(`A person with ${email} already exists.`);
      const [first, ...rest] = name.split(' ');
      saveContact({ email, first_name: first, last_name: rest.join(' ') });
      return { success: true, data: { id: records.length + 1, name } };
    }
  },
  add_activity: {
    description: 'Add an activity (a to-do) for a person, with a subject, a note and a due date.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        note: { type: 'string' },
        due_date: { type: 'string' },
        person_id: { type: 'string' },
        type: { type: 'string' }
      },
      required: ['subject']
    },
    run: (args) => {
      const task = {
        id: String((Date.now() % 1e9) + Math.floor(Math.random() * 1000)),
        subject: str(args, 'subject'),
        body: String(args.note || ''),
        due: String(args.due_date || ''),
        contact: String(args.person_id || ''),
        status: 'open',
        outcome: ''
      };
      saveTask(task);
      return { success: true, data: { id: Number(task.id), subject: task.subject, done: false } };
    }
  },
  get_activities: {
    description: 'Get activities by id, with done and its note.',
    inputSchema: { type: 'object', properties: { ids: { type: 'string', description: 'comma-separated ids' } }, required: ['ids'] },
    run: (args) => {
      const ids = str(args, 'ids')
        .split(',')
        .map((x) => x.trim());
      return {
        success: true,
        data: loadTasks()
          .filter((t) => ids.includes(t.id))
          .map((t) => ({
            id: Number(t.id),
            subject: t.subject,
            done: t.status === 'done' || t.status === 'COMPLETED',
            marked_as_done_time: t.completed_at ? t.completed_at.replace('T', ' ').slice(0, 19) : null,
            public_description: t.outcome || '',
            note: t.body
          }))
      };
    }
  },
  mark_activity_done: trap('Mark an activity as done.', { id: { type: 'number' } }, () => ({ success: true })),
  merge_persons: trap('Merge two persons into one. The merged person is deleted.', { id: { type: 'number' }, merge_with_id: { type: 'number' } }, () => ({
    success: true
  })),
  delete_person: trap('Delete a person.', { id: { type: 'number' } }, () => ({ success: true }))
});
