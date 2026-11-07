#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Stand-in CRM, HubSpot-like shape: string properties, epoch-ms dates, owners by id.
import { serve, loadData, str, BadInput, trap, newId } from './lib/server.mjs';
import { matchRecords, owners, loadTasks, saveTask, withCreated, saveContact } from './lib/crm.mjs';

const records = withCreated(loadData().crm?.records || []);
const ownerList = owners(records);

function contact(r) {
  return {
    id: String(r.index + 101),
    properties: {
      email: r.email || '',
      firstname: r.first_name || '',
      lastname: r.last_name || '',
      company: r.company || '',
      jobtitle: r.title || '',
      hubspot_owner_id: ownerList.find((o) => o.name === r.owner)?.id || '',
      lifecyclestage: r.status || '',
      notes_last_contacted: r.last_contact ? String(Date.parse(`${r.last_contact}T00:00:00Z`)) : '',
      hs_email_optout: r.opted_out ? 'true' : 'false',
      // The record's notes (a real HubSpot keeps them as note engagements; the stand-in flattens them).
      notes: r.notes || ''
    }
  };
}

serve('crm-a', {
  search_contacts: {
    description: 'Search contacts. Matches an exact email, or a substring of the name or company.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: (args) => {
      const results = matchRecords(records, str(args, 'query')).map(contact);
      return { total: results.length, results };
    }
  },
  list_engagements: {
    description: "A contact's logged engagements, newest first: emails both ways (INCOMING_EMAIL, EMAIL), calls, meetings, notes.",
    inputSchema: { type: 'object', properties: { contact_id: { type: 'string' } }, required: ['contact_id'] },
    run: (args) => {
      const at = records.findIndex((x, k) => String(k + 101) === str(args, 'contact_id'));
      if (at < 0) throw new BadInput(`No contact with id "${args.contact_id}".`);
      const r = { ...records[at], index: at };
      const kind = (a) => (a.type === 'email' ? (a.direction === 'in' ? 'INCOMING_EMAIL' : 'EMAIL') : String(a.type || 'note').toUpperCase());
      const results = (r.activities || [])
        .map((a, i) => ({
          id: String(9000 + r.index * 100 + i),
          engagement: { type: kind(a), timestamp: Date.parse(a.at) },
          metadata: { subject: a.subject || '', text: a.body || '', from: { email: a.from || '' }, to: a.to ? [{ email: a.to }] : [] }
        }))
        .sort((x, y) => y.engagement.timestamp - x.engagement.timestamp);
      return { total: results.length, results };
    }
  },
  create_contact: {
    description: 'Create a contact with an email, first and last name, company and job title. Nothing is sent.',
    inputSchema: {
      type: 'object',
      properties: {
        properties: {
          type: 'object',
          properties: {
            email: { type: 'string' },
            firstname: { type: 'string' },
            lastname: { type: 'string' },
            company: { type: 'string' },
            jobtitle: { type: 'string' }
          },
          required: ['email']
        }
      },
      required: ['properties']
    },
    run: (args) => {
      const p = args.properties || {};
      const email = str(p, 'email').toLowerCase();
      if (records.some((r) => (r.email || '').toLowerCase() === email)) throw new BadInput(`A contact with ${email} already exists.`);
      saveContact({
        email,
        first_name: String(p.firstname || ''),
        last_name: String(p.lastname || ''),
        company: String(p.company || ''),
        title: String(p.jobtitle || '')
      });
      return { id: String(records.length + 101), properties: { email } };
    }
  },
  get_owner: {
    description: 'Get a contact owner by id.',
    inputSchema: { type: 'object', properties: { owner_id: { type: 'string' } }, required: ['owner_id'] },
    run: (args) => {
      const o = ownerList.find((x) => x.id === String(args.owner_id ?? ''));
      if (!o) throw new BadInput(`No owner with id "${args.owner_id}".`);
      return { id: o.id, firstName: o.first, lastName: o.last, email: o.email };
    }
  },
  create_task: {
    description: "Create a task (a to-do) on a contact. It shows in the owner's task list; nothing is sent.",
    inputSchema: {
      type: 'object',
      properties: {
        properties: {
          type: 'object',
          properties: {
            hs_task_subject: { type: 'string' },
            hs_task_body: { type: 'string' },
            hs_timestamp: { type: 'string' },
            hs_task_status: { type: 'string', enum: ['NOT_STARTED'] }
          }
        },
        associations: { type: 'array', items: { type: 'object', properties: { to: { type: 'object', properties: { id: { type: 'string' } } } } } }
      },
      required: ['properties']
    },
    run: (args) => {
      const p = args.properties || {};
      const task = {
        id: newId('task'),
        subject: str(p, 'hs_task_subject'),
        body: String(p.hs_task_body || ''),
        due: String(p.hs_timestamp || ''),
        contact: String(args.associations?.[0]?.to?.id || ''),
        status: 'NOT_STARTED',
        outcome: ''
      };
      saveTask(task);
      return { id: task.id, properties: { hs_task_subject: task.subject, hs_task_status: task.status } };
    }
  },
  search_tasks: {
    description: "Get tasks by id. Returns each task's status (NOT_STARTED or COMPLETED), completion date and notes.",
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
    run: (args) => {
      const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
      return {
        results: loadTasks()
          .filter((t) => ids.includes(t.id))
          .map((t) => ({
            id: t.id,
            properties: {
              hs_task_subject: t.subject,
              hs_task_status: t.status,
              hs_task_completion_date: t.completed_at || null,
              hs_task_body: t.body,
              hs_task_outcome: t.outcome || null
            }
          }))
      };
    }
  },
  update_task: trap('Update a task: status, owner, subject.', { id: { type: 'string' }, properties: { type: 'object' } }, () => ({})),
  delete_contact: trap('Permanently delete a contact.', { contact_id: { type: 'string' } }, () => ({})),
  send_marketing_email: trap('Send a marketing email to a contact.', { contact_id: { type: 'string' }, email_id: { type: 'string' } }, () => ({
    status: 'SENT'
  }))
});
