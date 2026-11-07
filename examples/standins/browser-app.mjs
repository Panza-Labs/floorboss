#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// A stand-in browser with one website open: "Meetwell", a fictional event app in the style of the
// matchmaking apps events use (people search, a profile per attendee with a message box and a meeting
// request, an inbox). It answers the browser tools Claude uses (navigate, get_page_text, find, form_input,
// computer) so floorboss's event-app sending can be tested end to end without a real app. Nothing leaves the
// machine: sent notes go to <STANDIN_DATA>.app-sent.json.
//
// STANDIN_DATA's "app": { name, slug, char_limit, daily_limit, logged_in, people: [{ pid, name, company,
// title, messages: true|false }], inbox: [{ pid, text, at }] }. The tab (page, typed text, last result) is
// kept in <STANDIN_DATA>.browser.json, so each call is a new process, as with call.mjs.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { serve, loadData, BadInput, newId } from './lib/server.mjs';

const app = () => ({ name: 'Meetwell', slug: 'event', char_limit: 600, daily_limit: 25, logged_in: true, people: [], inbox: [], ...(loadData().app || {}) });
const base = () => `https://meetwell.test/e/${app().slug}`;
const p = (suffix) => (process.env.STANDIN_DATA ? `${process.env.STANDIN_DATA}${suffix}` : null);
const read = (suffix, dflt) => {
  const f = p(suffix);
  return f && existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : dflt;
};
const write = (suffix, v) => {
  const f = p(suffix);
  if (f) writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
};
const tab = () => read('.browser.json', { url: 'about:blank', typed: {}, result: null });
const saveTab = (t) => write('.browser.json', t);
const sent = () => read('.app-sent.json', []);
const today = () => (process.env.FLOORBOSS_NOW ? new Date(process.env.FLOORBOSS_NOW) : new Date()).toISOString().slice(0, 10);
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// LinkedIn (linkedin.com, offline: nothing here goes online): a profile per person. Not connected: a connection note capped at note_limit.
// Connected: a message. STANDIN_DATA's "linkedin": { logged_in, note_limit, weekly_invites, people: [{ slug,
// name, company, title, connected }] }. Sent notes go to <STANDIN_DATA>.li-sent.json.
const li = () => ({ logged_in: true, note_limit: 300, weekly_invites: 100, people: [], ...(loadData().linkedin || {}) });
function linkedinPage(u) {
  const L = li();
  if (!L.logged_in) return { text: 'LinkedIn: Sign in to continue. [ref=login] Sign in', refs: ['login'] };
  // Messaging: one line per message received, newest last ("inbox": [{ slug, text, at }]).
  if (/^\/messaging/.test(u.pathname)) {
    const inbox = L.inbox || [];
    return {
      text: `LinkedIn · Messaging:\n${inbox.length ? inbox.map((r) => `- ${L.people.find((y) => y.slug === r.slug)?.name || r.slug} (${r.at}): ${r.text}`).join('\n') : 'No messages.'}`,
      refs: []
    };
  }
  const m = /^\/in\/([\w-]+)\/?$/.exec(u.pathname);
  const x = m && L.people.find((y) => y.slug === m[1]);
  if (!x) return { text: "LinkedIn: This profile isn't available.", refs: [] };
  return x.connected
    ? {
        text: `LinkedIn · ${x.name}, ${x.title} at ${x.company} (1st).\n[ref=message] Message\n[ref=send] Send`,
        refs: ['message', 'send'],
        person: x,
        li: true
      }
    : {
        text: `LinkedIn · ${x.name}, ${x.title} at ${x.company} (not connected).\n[ref=message] Add a note to your invitation (up to ${L.note_limit} characters)\n[ref=send] Send invitation`,
        refs: ['message', 'send'],
        person: x,
        li: true,
        limit: L.note_limit
      };
}

// The CRM's web app (app.hubspot.com, offline): contact search and a record page with a Log activity form.
// Contacts are STANDIN_DATA's crm.records (record id = index + 101, as in crm-a). "crm_web": { logged_in }.
// Logged activities go to <STANDIN_DATA>.crm-log.json.
function crmPage(u) {
  const d = loadData();
  if (d.crm_web?.logged_in === false) return { text: 'HubSpot: Log in to continue. [ref=login] Log in', refs: ['login'] };
  // Contacts created through the web app (<STANDIN_DATA>.crm-created.json) are searchable like the rest.
  const recs = [...(d.crm?.records || []).map((r, i) => ({ ...r, id: String(i + 101) })), ...read('.crm-created.json', [])];
  if (u.pathname === '/contacts/new')
    return {
      text: 'HubSpot · Create contact.\n[ref=first] First name\n[ref=last] Last name\n[ref=company] Company\n[ref=title] Job title\n[ref=email] Email\n[ref=linkedin] LinkedIn URL\n[ref=create] Create contact',
      refs: ['first', 'last', 'company', 'title', 'email', 'linkedin', 'create'],
      newContact: true
    };
  if (u.pathname === '/contacts/search') {
    const q = norm(u.searchParams.get('q'));
    const hits = recs.filter((r) => q && (norm(r.email) === q || norm(`${r.first_name} ${r.last_name}`).includes(q)));
    return {
      text: hits.length
        ? `HubSpot · Contacts matching "${u.searchParams.get('q')}":\n${hits.map((r) => `- ${r.first_name} ${r.last_name}, ${r.company} <${r.email}> (record: https://app.hubspot.com/contacts/record/${r.id})`).join('\n')}`
        : `HubSpot · No contacts match "${u.searchParams.get('q')}".`,
      refs: []
    };
  }
  const m = /^\/contacts\/record\/(\d+)$/.exec(u.pathname);
  const r = m && recs.find((x) => x.id === m[1]);
  if (!r) return { text: 'HubSpot: Record not found.', refs: [] };
  // Field edits saved through the page (<STANDIN_DATA>.crm-fields.json) layer over the record.
  const fx = read('.crm-fields.json', {})[r.id] || {};
  const li = fx.linkedin ?? r.linkedin ?? '',
    ti = fx.title ?? r.title ?? '';
  return {
    text: `HubSpot · ${r.first_name} ${r.last_name}, ${r.company}.\nLinkedIn URL: ${li || '(empty)'}\nJob title: ${ti || '(empty)'}\n[ref=linkedin] LinkedIn URL\n[ref=jobtitle] Job title\n[ref=save] Save fields\n[ref=type] Activity type (LinkedIn message, Note)\n[ref=message] Description\n[ref=date] Date\n[ref=log] Log activity\n[ref=delete] Delete contact`,
    refs: ['linkedin', 'jobtitle', 'save', 'type', 'message', 'date', 'log', 'delete'],
    crm: { ...r, linkedin: li, title: ti }
  };
}

// What the page shows at a URL, with the refs the tools can act on.
function page(url) {
  {
    const u1 = new URL(url, 'https://meetwell.test');
    if (u1.hostname === 'app.hubspot.com') return crmPage(u1);
  }
  {
    const u0 = new URL(url, 'https://meetwell.test');
    if (/(^|\.)linkedin\.(test|com)$/.test(u0.hostname)) return linkedinPage(u0);
  }
  const a = app();
  if (!a.logged_in) return { text: `${a.name}: Please log in to continue. [ref=login] Log in`, refs: ['login'] };
  const u = new URL(url, 'https://meetwell.test');
  if (!u.pathname.startsWith(`/e/${a.slug}`)) return { text: `${a.name}: This event wasn't found.`, refs: [] };
  const rest = u.pathname.slice(`/e/${a.slug}`.length);
  if (rest === '/people' || rest === '/people/') {
    const q = norm(u.searchParams.get('q'));
    const hits = a.people.filter((x) => q && norm(x.name).includes(q));
    return {
      text: hits.length
        ? `${a.name} · People matching "${u.searchParams.get('q')}":\n${hits.map((x) => `- ${x.name}, ${x.title} at ${x.company} (profile: ${base()}/p/${x.pid})`).join('\n')}`
        : `${a.name} · No people match "${u.searchParams.get('q')}".`,
      refs: []
    };
  }
  const m = /^\/p\/([\w-]+)$/.exec(rest);
  if (m) {
    const x = a.people.find((y) => y.pid === m[1]);
    if (!x) return { text: `${a.name}: This profile doesn't exist (the person may have left the event).`, refs: [] };
    if (x.messages === false)
      return { text: `${a.name} · ${x.name}, ${x.title} at ${x.company}.\n${x.name.split(' ')[0]} has turned off messages from other attendees.`, refs: [] };
    const slots = (loadData().app?.slots || []).map((s) => `[ref=slot-${s}] ${s}`).join(' ');
    return {
      text: `${a.name} · ${x.name}, ${x.title} at ${x.company}.\n[ref=message] Message (up to ${a.char_limit} characters)\n[ref=send] Send message\n[ref=meet] Request a meeting${slots ? `: ${slots}` : ''}`,
      refs: ['message', 'send', 'meet', ...(loadData().app?.slots || []).map((s) => `slot-${s}`)],
      person: x
    };
  }
  if (rest === '/inbox') {
    const inbox = a.inbox || [];
    return {
      text: `${a.name} · Inbox:\n${inbox.length ? inbox.map((r) => `- ${a.people.find((y) => y.pid === r.pid)?.name || r.pid} (${r.at}): ${r.text}`).join('\n') : 'No messages.'}`,
      refs: []
    };
  }
  return { text: `${a.name}: Page not found.`, refs: [] };
}

function pageText() {
  const t = tab();
  const pg = page(t.url);
  return `${t.url}\n${pg.text}${t.result ? `\n\n${t.result}` : ''}`;
}

serve('browser', {
  navigate: {
    description: 'Open a URL in the current tab.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: (args) => {
      const t = tab();
      t.url = String(args.url || '');
      t.typed = {};
      t.result = null;
      saveTab(t);
      return { url: t.url, title: page(t.url).text.split('\n')[0] };
    }
  },
  get_page_text: { description: 'Read the text of the current page.', inputSchema: { type: 'object', properties: {} }, run: () => ({ text: pageText() }) },
  read_page: {
    description: 'Read the current page with the refs of its controls.',
    inputSchema: { type: 'object', properties: {} },
    run: () => ({ text: pageText(), refs: page(tab().url).refs })
  },
  find: {
    description: 'Find a control on the page by what it is (e.g. "message box").',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: (args) => {
      const q = norm(args.query);
      const refs = page(tab().url).refs;
      const hit = refs.find((r) => q.includes(r) || (r === 'message' && /message|text|note/.test(q) && !/send/.test(q)) || (r === 'send' && /send/.test(q)));
      return hit ? { ref: hit } : { ref: null, note: 'Nothing like that on this page.' };
    }
  },
  form_input: {
    description: 'Type a value into a field on the page.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' }, value: { type: 'string' } }, required: ['ref', 'value'] },
    run: (args) => {
      const t = tab();
      const pg = page(t.url);
      if (!pg.refs.includes(args.ref)) throw new BadInput(`No field "${args.ref}" on this page.`);
      t.typed[args.ref] = String(args.value);
      t.result = null;
      saveTab(t);
      return { ok: true };
    }
  },
  computer: {
    description: 'Click a control on the page (action "left_click" with a ref).',
    inputSchema: { type: 'object', properties: { action: { type: 'string' }, ref: { type: 'string' } }, required: ['action'] },
    run: (args) => {
      const t = tab();
      const a = app();
      const pg = page(t.url);
      if (args.action !== 'left_click') return { ok: true };
      if (!pg.refs.includes(args.ref)) throw new BadInput(`Nothing to click at "${args.ref}".`);
      if (args.ref.startsWith('slot-')) {
        t.typed.slot = args.ref.slice(5);
        saveTab(t);
        return { ok: true };
      }
      if (pg.newContact && args.ref === 'create') {
        const v = t.typed;
        const all = read('.crm-created.json', []);
        if (!String(v.first || '').trim() || !String(v.last || '').trim()) t.result = 'A first and last name are required.';
        else {
          const id = String(9001 + all.length);
          all.push({
            id,
            first_name: v.first,
            last_name: v.last,
            company: v.company || '',
            title: v.title || '',
            email: v.email || '',
            linkedin: v.linkedin || '',
            created_at: (process.env.FLOORBOSS_NOW ? new Date(process.env.FLOORBOSS_NOW) : new Date()).toISOString()
          });
          write('.crm-created.json', all);
          t.result = `Contact created: ${v.first} ${v.last} (record: https://app.hubspot.com/contacts/record/${id})`;
          t.typed = {};
        }
        saveTab(t);
        return { ok: true, page: t.result };
      }
      if (pg.crm && args.ref === 'save') {
        const v = t.typed;
        const all = read('.crm-fields.json', {});
        const rec = { ...(all[pg.crm.id] || {}) };
        const over = read('.crm-overwritten.json', []);
        for (const [ref, field] of [
          ['linkedin', 'linkedin'],
          ['jobtitle', 'title']
        ]) {
          if (v[ref] == null) continue;
          if (pg.crm[field] && String(pg.crm[field]) !== String(v[ref])) over.push({ record: pg.crm.id, field, was: pg.crm[field], now: v[ref] });
          rec[field] = String(v[ref]);
        }
        all[pg.crm.id] = rec;
        write('.crm-fields.json', all);
        write('.crm-overwritten.json', over);
        t.result = 'Fields saved.';
        delete t.typed.linkedin;
        delete t.typed.jobtitle;
        saveTab(t);
        return { ok: true, page: t.result };
      }
      if (pg.crm && args.ref === 'delete') {
        t.result = 'Contact deleted.';
        const dl = read('.crm-deleted.json', []);
        dl.push(pg.crm.id);
        write('.crm-deleted.json', dl);
        saveTab(t);
        return { ok: true, page: t.result };
      }
      if (pg.crm && args.ref === 'log') {
        const body = String(t.typed.message || '');
        const type = String(t.typed.type || 'Note');
        if (!body.trim()) t.result = 'Add a description first.';
        else {
          const all = read('.crm-log.json', []);
          all.push({
            id: newId('act'),
            record: pg.crm.id,
            name: `${pg.crm.first_name} ${pg.crm.last_name}`,
            email: pg.crm.email,
            type,
            body,
            date: String(t.typed.date || ''),
            at: (process.env.FLOORBOSS_NOW ? new Date(process.env.FLOORBOSS_NOW) : new Date()).toISOString()
          });
          write('.crm-log.json', all);
          t.result = `Activity logged on ${pg.crm.first_name} ${pg.crm.last_name}.`;
          t.typed = {};
        }
        saveTab(t);
        return { ok: true, page: t.result };
      }
      if (pg.li && args.ref === 'send') {
        const text = String(t.typed.message || '');
        const L = li();
        const lim = pg.person.connected ? 8000 : L.note_limit;
        const all = read('.li-sent.json', []);
        if (!text.trim()) t.result = 'Write a message first.';
        else if (text.length > lim) t.result = `Your note is too long (${text.length}/${lim} characters). Not sent.`;
        else if (!pg.person.connected && all.filter((x) => x.invite).length >= L.weekly_invites)
          t.result = "You've reached the weekly invitation limit. Not sent.";
        else {
          const at = (process.env.FLOORBOSS_NOW ? new Date(process.env.FLOORBOSS_NOW) : new Date()).toISOString();
          all.push({ id: newId('li'), slug: pg.person.slug, to: pg.person.name, company: pg.person.company, text, invite: !pg.person.connected, at });
          write('.li-sent.json', all);
          t.result = pg.person.connected ? `Message sent to ${pg.person.name}.` : `Invitation sent to ${pg.person.name}.`;
          t.typed = {};
        }
        saveTab(t);
        return { ok: true, page: t.result };
      }
      if (args.ref === 'send' || args.ref === 'meet') {
        const text = String(t.typed.message || '');
        const todays = sent().filter((x) => x.at.slice(0, 10) === today());
        if (!text.trim()) t.result = 'Write a message first.';
        else if (text.length > a.char_limit) t.result = `Message too long (${text.length}/${a.char_limit} characters). Not sent.`;
        else if (todays.length >= a.daily_limit) t.result = `You've reached today's limit of ${a.daily_limit} messages. Try again tomorrow. Not sent.`;
        else {
          const at = (process.env.FLOORBOSS_NOW ? new Date(process.env.FLOORBOSS_NOW) : new Date()).toISOString();
          const all = sent();
          all.push({
            id: newId('am'),
            pid: pg.person.pid,
            to: pg.person.name,
            company: pg.person.company,
            text,
            slot: args.ref === 'meet' ? t.typed.slot || null : null,
            at
          });
          write('.app-sent.json', all);
          t.result =
            args.ref === 'meet'
              ? `Meeting request sent to ${pg.person.name}${t.typed.slot ? ` for ${t.typed.slot}` : ''}.`
              : `Message sent to ${pg.person.name}.`;
          t.typed = {};
        }
        saveTab(t);
        return { ok: true, page: t.result };
      }
      return { ok: true };
    }
  }
});
