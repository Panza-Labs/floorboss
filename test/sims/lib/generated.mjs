// A generated persona driven through `flow next`: its data from gen.mjs, its connected tools as stand-in MCP
// servers (with faults injected on cue), its answers in its own style, and the checks every run must pass,
// read from the truth gen.mjs kept. What a persona can't answer is answered with the first option and noted
// as friction, so one missing answer doesn't hide everything after it.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeHome, drive, simplePersona, ROOT } from './driver.mjs';
import { generate, writeFiles } from './gen.mjs';
import { readLedger, fold } from '../../../lib/ledger.mjs';
import { capFor } from '../../../skills/crm-triage/scripts/shortlist.mjs';

const lower = (s) => String(s || '').trim().toLowerCase();

// One call to a stand-in server, as Claude would make it. { ok, data } or { ok: false, error }.
export function mcp(H, server, tool, args) {
  const r = spawnSync('node', [join(ROOT, 'examples/standins/call.mjs'), server, 'call', tool, JSON.stringify(args)], { env: { ...H.env, FLOORBOSS_NOW: H.now, STANDIN_DATA: H.standin, STANDIN_FAULTS: H.faults, STANDIN_LOG: `${H.standin}.log` }, encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, error: String(r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 300) };
  try { return { ok: true, data: JSON.parse(r.stdout) }; } catch { return { ok: false, error: `not JSON: ${r.stdout.slice(0, 200)}` }; }
}

const RECIPES = {
  send: ['email.send', { server: 'gmail', tool: 'send_message', args: { to: '{to}', subject: '{subject}', body: '{body}', threadId: '{thread_id}' }, reading: 'the id and threadId it returns', tool_hash: 'b'.repeat(64), test_draft: { draft_id: 'm-test', user_confirmed: true } }],
  messages: ['email.messages', { server: 'gmail', tool: 'list_messages', args: { address: '{email}', since: '{since}' }, reading: 'messages', tool_hash: 'c'.repeat(64) }],
  history: ['email.history', { server: 'gmail', tool: 'search_threads', args: { query: '{email}' }, reading: 'threads and whether they replied', tool_hash: 'd'.repeat(64) }],
  crm: ['crm.lookup', { server: 'crm-a', tool: 'search_contacts', args: { query: '{email}' }, reading: 'results', tool_hash: 'e'.repeat(64) }],
  calendar: ['calendar.events', { server: 'calendar-a', tool: 'list_events', args: { timeMin: '{start}', timeMax: '{end}' }, reading: 'items with attendees', tool_hash: 'f'.repeat(64) }],
  enrich: ['enrich.person', { server: 'enrich-a', tool: 'people_match', args: { name: '{name}', organization_name: '{company}' }, reading: 'person.email and person.linkedin_url', tool_hash: 'a'.repeat(64) }],
  // Adding people the CRM doesn't have before their first email: set up with the CRM (its first record seen).
  crmCreate: ['crm.create_contact', { server: 'crm-a', tool: 'create_contact', args: { properties: { email: '{email}', firstname: '{first_name}', lastname: '{last_name}', company: '{company}', jobtitle: '{title}' } }, reading: 'the new contact id is "id"', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 'r-test', user_confirmed: true } }],
  tasks: ['crm.create_task', { server: 'crm-a', tool: 'create_task', args: { properties: { hs_task_subject: '{title}', hs_task_body: '{body}', hs_timestamp: '{due}', hs_task_status: 'NOT_STARTED' }, associations: [{ to: { id: '{contact_ref}' } }] }, reading: 'the id it returns', tool_hash: 'f'.repeat(64), test_draft: { draft_id: 't-test', user_confirmed: true } }],
};

// What an incoming message says, as Claude would read it (the stand-in for that judgement in the simulations).
function intentOf(t) {
  if (/Delivery Status|address not found/i.test(t)) return { intent: 'bounce' };
  const ooo = /out of office|away until (\d{4}-\d{2}-\d{2})/i.exec(t); if (ooo) return { intent: 'ooo', ...(/(\d{4}-\d{2}-\d{2})/.exec(t) ? { until: /(\d{4}-\d{2}-\d{2})/.exec(t)[1] } : {}) };
  if (/remove me|unsubscribe|don't contact/i.test(t)) return { intent: 'stop' };
  if (/no thanks|not a fit|not interested/i.test(t)) return { intent: 'decline' };
  const ref = /talk to ([A-Z][a-z]+ [A-Z][a-z]+) \(([^)]+)\), our ([^.]+)/i.exec(t); if (ref) return { intent: 'referral', referral: { name: ref[1], email: ref[2], title: ref[3] } };
  const time = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(t); if (time) return { intent: 'booked', time: time[1] };
  return { intent: 'reply' };
}

export function buildPersona(spec) {
  const g = generate({ seed: spec.seed, ...spec.gen, own: spec.own });
  const H = makeHome({ now: spec.now || '2026-10-10T12:00:00Z', context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'ctx' } });
  const data = writeFiles(g, join(H.HOME, 'inputs', 'gen'));
  H.standin = join(H.HOME, 'standin.json');
  H.faults = join(H.HOME, 'faults.json');
  // What the connected tools know: CRM records for the stand-in CRM, the mailbox's earlier threads.
  const standin = { mail: { address: spec.own.email, threads: [], history: (g.people.filter((p) => p.emailedBefore)).map((p) => ({ with: p.email, threads: 2, they_replied: true, last_at: '2026-08-01T10:00:00Z' })) }, crm: { records: g.crm.map((x, i) => ({ first_name: x.p.first, last_name: x.p.last, email: x.p.email, company: x.p.company, title: x.p.title, linkedin: x.p.linkedin && i % 2 ? x.p.linkedin : '', owner: x.owner, status: x.status, last_contact: x.last, opted_out: x.optout, notes: x.note })) } };
  // The event app (Meetwell), when this persona's event has one: everyone on the list, minus a few who left the
  // app, some with messages turned off.
  if (spec.app) {
    const r = (spec.seed || 1) * 7;
    let i = 0;
    standin.app = { name: 'Meetwell', slug: spec.app.slug || 'event', char_limit: spec.app.char_limit ?? 600, daily_limit: spec.app.daily_limit ?? 40, logged_in: spec.app.logged_in ?? true, inbox: [], slots: [],
      people: g.people.filter(() => (i++ * 37 + r) % 100 >= (spec.app.missing ?? 5)).map((p, k) => ({ pid: `p${k + 1}`, name: p.name, company: p.company, title: p.title, messages: (k * 53 + r) % 100 >= (spec.app.messages_off ?? 10) })) };
  }
  // LinkedIn, for personas whose list carries profile links: one profile per link, some already connected.
  if (spec.gen.linkedinShare) standin.linkedin = { logged_in: spec.linkedin?.logged_in ?? true, note_limit: spec.linkedin?.note_limit ?? 300, weekly_invites: spec.linkedin?.weekly_invites ?? 100, people: g.people.filter((p) => p.linkedin).map((p) => ({ slug: p.linkedin.split('/in/')[1], name: p.name, company: p.company, title: p.title, connected: p.connected })) };
  if (spec.crmWeb) standin.crm_web = spec.crmWeb;
  // A people-data tool (Apollo-like): it knows the work email of most people whose list row has none.
  if (spec.connected?.includes('enrich')) standin.enrich = { people: g.people.filter((p) => p.truthEmail || p.email).map((p, k) => ({ name: p.name, company: p.company, title: p.title, email: k % 5 === 4 ? null : (p.truthEmail || p.email), linkedin_url: null })) };
  writeFileSync(H.standin, JSON.stringify(standin));
  writeFileSync(H.faults, JSON.stringify(spec.faults || {}));
  // With a CRM connected, a create-contact tool comes with it, unless this persona adds people by import.
  const connectors = Object.fromEntries([...(spec.connected || []), ...(spec.connected?.includes('crm') && !spec.crmImport ? ['crmCreate'] : [])].map((k) => RECIPES[k]).filter(Boolean));
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ shared_domains: ['gmail.test'], connectors, ...(spec.channels ? { channels: spec.channels } : {}) }));
  const friction = [];
  const truthBy = new Map();
  for (const p of g.people) { if (p.email) truthBy.set(lower(p.email), p); truthBy.set(`${lower(p.name)}|${lower(p.company)}`, p); }
  const per = makePersona(spec, H, g, data, friction);
  return { H, g, per, friction, truthBy, spec };
}

function makePersona(spec, H, g, data, friction) {
  const readReplies = (list) => {
    const people = [];
    for (const p of list) {
      if (!p.email) continue;
      const r = mcp(H, 'gmail', 'list_messages', { address: p.email, since: p.since });
      if (!r.ok) return { __tool_error: r.error, task: 'email.messages' };
      people.push({ id: p.id, messages: (r.data.messages || []).map((m) => { const out = lower(m.from) === lower(spec.own.email) || lower(m.from) === 'me@standin.example'; return { message_id: m.id, at: m.date, direction: out ? 'out' : 'in', subject: m.subject || null, auto: !!m.autoReply, ...(out ? {} : { from: lower(m.from), ...intentOf(m.snippet || '') }) }; }) });
    }
    return { people };
  };
  const slug = () => per.slug;
  const ev = () => join(H.HOME, 'events', slug(), 'derived');
  const truthOf = (person) => g.people.find((p) => lower(p.email) && lower(p.email) === lower(person.email)) || g.people.find((p) => lower(p.name) === lower(person.name) && lower(p.company) === lower(person.company));
  const style = spec.style || {};
  const asks = {
    event: undefined,
    attendee_list: join(data, 'attendees.csv'),
    crm_export: spec.gen.crm === false ? 'skip' : join(data, 'crm.csv'),
    // One question covers people and companies that must never be contacted.
    dnc: existsSync(join(data, 'accounts.csv')) ? { dnc: existsSync(join(data, 'dnc.txt')) ? join(data, 'dnc.txt') : 'none', accounts: join(data, 'accounts.csv') } : existsSync(join(data, 'dnc.txt')) ? join(data, 'dnc.txt') : 'none',
    accounts: existsSync(join(data, 'accounts.csv')) ? join(data, 'accounts.csv') : 'none',
    company: { own_company: spec.own.company, own_domains: [spec.own.domain] },
    colleagues: { colleagues: spec.own.colleagues || [] },
    crm_name: spec.own.user,
    team: (spec.own.colleagues || []).length ? 'my team too' : 'just me',
    coworker_contacts: spec.coworkers || 'leave them alone (recommended)',
    // The specs' expected groups were written for a 12-month lost-deal window.
    lost_deals: spec.lostDeals || '12 months',
    crm_log: spec.crmLog === 'browser' ? { mode: 'browser', crm_name: 'HubSpot' } : spec.crmLog || 'make a CRM task for each',
    crm_log_window: 'yes, log them now',
    crm_create_contacts: spec.crmCreate || 'no, just list them for me',
    crm_fill_blanks: spec.crmFill || 'no, don\'t change existing contacts',
    // People not in the CRM yet, with no create tool: the persona imports floorboss's CSV into the CRM (the
    // stand-in's own added contacts), then says so.
    crm_contacts: (st, H2, sl) => {
      const list = JSON.parse(readFileSync(join(H.HOME, 'events', sl, 'contact-list.json'), 'utf8'));
      const f = `${H.standin}.contacts.json`;
      const have = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
      writeFileSync(f, JSON.stringify([...have, ...list.map((x) => ({ email: x.email, first_name: x.first_name, last_name: x.last_name, company: x.company, title: x.title }))]));
      (per.imported ||= []).push(...list.map((x) => x.email));
      return 'imported';
    },
    crm_create_ok: (st) => ({ answer: spec.crmCreateOk === false ? 'no' : 'yes', ids: st.ask.ids }),
    sending: (() => { const ch = [...(spec.connected?.includes('send') ? ['email'] : []), ...(spec.app && spec.appSend !== false ? ['app'] : []), ...(spec.linkedin?.send ? ['linkedin'] : [])]; return ch.length ? { channels: ch } : 'none'; })(),
    linkedin_send: spec.linkedin?.send ? 'yes, I accept the risk' : 'no, I\'ll send LinkedIn messages myself',
    app: spec.app ? 'Meetwell' : 'not sure / none',
    contact_details: spec.app ? 'no, the app is enough' : 'decide after the shortlist',
    app_request_limit: spec.app ? '40, none used yet' : undefined,
    app_send_window: 'yes, send them now',
    app_outcome: (s) => ({ went: per.appSentTo?.(s.ask.person) ? 'yes' : 'no', said: per.appSentTo?.(s.ask.person) ? 'it is in the app\'s sent messages' : 'not there' }),
    send_setup: spec.connected?.includes('send') ? { own_email: spec.own.email, done: true } : undefined,
    followups_mode: spec.followups || 'scheduled: each goes on its day',
    crm_where: spec.connected?.includes('crm') ? 'a CRM connected here' : spec.gen.crm === false ? 'no CRM' : 'a CRM that isn\'t connected here',
    tools: { crm: spec.connected?.includes('crm') ? 'crm-a' : 'export', mailbox: !!spec.connected?.includes('history'), calendar: false },
    crm_use: spec.connected?.includes('crm') ? 'yes, look people up there' : 'I\'ll give you an export instead',
    mailbox_use: spec.connected?.includes('history') ? 'yes' : 'no',
    // Column mappings: a lazy user says ok; a careful one gives each status its meaning from what they know.
    map_columns_attendees: 'ok',
    map_columns_crm: style.mapping === 'careful' ? (s, H2, sl) => careful(H, sl, spec) : 'ok',
    crm_accounts: 'yes, apply it',
    inbox_read: spec.inbox || 'no, I\'ll tell you myself',
    reply_action: (s) => ({ id: s.ask.person.id, ext: s.ask.person.ext, action: s.ask.person.action, answer: 'yes', ...(s.ask.person.action === 'add_referral' ? { referral: s.ask.person.referral, company: 'Referral Bank' } : { time: s.ask.person.time }) }),
    // Check-these: answered from what the persona knows about each person.
    check_these: (s) => s.ask.people.map((p) => {
      const t = truthOf(p);
      const ref = (p.alternatives || []).find((a) => a.ref)?.ref;
      // Not checked against the CRM: the persona knows its own people (stand-in for opening the CRM by hand).
      if (/not checked against your CRM/.test(p.says || '')) return t?.truth === 'never' || t?.truth === 'colleague' ? `${p.id} skip because ${t.why[0] || 'leave them alone'}` : `${p.id} reach because I know them, fine to write`;
      // A coworker's contact under "ask me each time": the persona writes to people it was told it may (spec.coworkerYes).
      if (/write to them yourself, or leave them to/.test(p.says || '')) { const yes = (spec.coworkerYes || []).some((n) => (p.says || '').includes(n)); return `${p.id} ${yes ? 'reach because my coworker said fine' : 'skip because it is their account'}`; }
      // "Contact them?" questions (the customer rule, an unknown status) take reach, warm or skip.
      if (p.answers && !p.answers.includes('different-person')) return t?.truth === 'never' || t?.truth === 'colleague' ? `${p.id} skip because ${t.why[0] || 'leave them alone'}` : `${p.id} ${style.check === 'lazy' ? 'reach' : 'warm'} because ${style.check === 'lazy' ? 'sure' : 'a customer of ours'}`;
      if (t && t.truth === 'never') return `${p.id} skip because ${t.why[0] || 'leave them alone'}`;
      // The lookup gave no answer: the persona knows whether its CRM really has them (a record the lookup missed).
      if (p.answers.includes('not-in-crm')) return t && g.crm.some((x) => x.p === t) ? `${p.id} skip because they are in my CRM, the lookup missed them` : `${p.id} not-in-crm`;
      if (style.check === 'lazy') return `${p.id} different-person all`;
      if (ref && t && g.crm.some((x) => x.p === t)) return `${p.id} same-person ${ref}`;
      return `${p.id} different-person all`;
    }).join('\n'),
    gate: style.gate || 'ok',
    research_scale: 'none',
    profile: { name: 'ctx' },
    voice_samples: style.voice === 'paste' ? { samples: [{ subject: 'Quick one', body: 'Hi Jo,\n\nSaw your note on dock queues. Worth 20 minutes Tuesday?\n\nSam' }, { subject: 'Following up', body: 'Hi Ana,\n\nShort version: we cut detention fees for two 3PLs last quarter. Coffee at the show?\n\nSam' }] } : 'skip',
    rate: (s, H2, sl) => { const key = JSON.parse(readFileSync(join(H.HOME, 'events', sl, 'derived', 'rate-key.json'), 'utf8')); const f = style.rate || ((k) => `${k.n}: 7 fine`); return key.map(f).join('\n'); },
    approve: (st) => { (per.approveQs ||= []).push(st.ask.question); const v = style.approve || 'approve all'; return typeof v === 'function' ? v(st) : v; },
    // Looking in Sent: the stand-in's own record says whether it went.
    send_outcome: (s) => { const sentPath = `${H.standin}.sent.json`; const sent = existsSync(sentPath) ? JSON.parse(readFileSync(sentPath, 'utf8')) : []; const went = sent.some((m) => lower(m.to) === lower(s.ask.person.email)) && s.ask.person.touch <= 1 ? sent.filter((m) => lower(m.to) === lower(s.ask.person.email)).length >= s.ask.person.touch : false; return { id: s.ask.person.id, touch: s.ask.person.touch, went: went ? 'yes' : 'no', said: went ? 'it is in my Sent folder' : 'not in Sent' }; },
    crm_independent: spec.crmIndependent || 'go back (retry the CRM, or give an export)',
    tool_down: (s) => { const l = [].concat(spec.toolDown?.[s.ask.task] || ['retry', 'retry', 'retry', 'later']); per.downAsked = (per.downAsked || 0) + 1; const a = l[Math.min(per.downAsked - 1, l.length - 1)]; return { task: s.ask.task, answer: a === '<export>' ? join(data, 'crm.csv') : a }; },
    // Nothing connected can see replies: the persona checked their inbox. Replies are recorded at the per-send check below.
    replies_since: 'none',
    no_reply: (s) => s.ask.people ? { people: s.ask.people.map((p) => p.id), replied: s.ask.people.filter((p) => per.replied?.has(p.id)).map((p) => p.id), stopped: [], said: 'checked my inbox' } : ({ id: s.ask.person.id, answer: per.replied?.has(s.ask.person.id) ? 'they replied' : 'no reply', said: per.replied?.has(s.ask.person.id) ? 'they wrote back' : 'nothing from them' }),
    ...(spec.connected?.includes('enrich') ? { contact_details: 'yes, with enrich-a', enrich_ok: spec.enrichOk || 'only the top 3' } : {}),
    ...(spec.asks || {}),
  };
  // The tools in this session, as the scan sees them: the stand-ins for what this persona has connected.
  const TOOLS = { enrich: ['mcp__enrich-a__people_match', 'mcp__enrich-a__bulk_people_enrichment'], send: ['mcp__gmail__send_message', 'mcp__gmail__create_draft'], messages: ['mcp__gmail__list_messages', 'mcp__gmail__get_thread'], history: ['mcp__gmail__search_threads'], crm: ['mcp__crm-a__search_contacts', 'mcp__crm-a__get_owner', 'mcp__crm-a__create_task'], tasks: ['mcp__crm-a__create_task', 'mcp__crm-a__search_tasks'], browser: ['mcp__browser-app__navigate', 'mcp__browser-app__get_page_text', 'mcp__browser-app__read_page', 'mcp__browser-app__find', 'mcp__browser-app__form_input', 'mcp__browser-app__computer'] };
  const per = simplePersona({ event: spec.event, asks, judge: {
    // A run that uses the browser (LinkedIn or app sending, CRM logging there) has a browser tool in its scan.
    scan: () => ({ tools: [...new Set([...(spec.connected || []).flatMap((k) => TOOLS[k] || []), ...(spec.linkedin?.send || spec.app || spec.crmLog === 'browser' ? TOOLS.browser : [])])] }),
    fit: (rows) => rows.map((r) => { const t = truthOf(r); const fit = t ? t.fit : /head|vp|director|chief|cto|coo|cio/i.test(r.title || ''); return { id: r.id, segment: fit ? spec.segment || 'ops-leaders' : null, reason: `${r.title || 'no title'} at ${r.company}`, score: fit ? 80 : 20, ...(t?.band ? { company_size: t.band } : {}) }; }),
    prefilter: () => ({ about: 'buyers', keep_titles: spec.keepTitles || ['head', 'vp', 'director', 'chief', 'cto', 'coo', 'cio', 'officer', 'manager'], drop_titles: ['intern', 'student', 'assistant', 'receptionist'], keep_companies: [], drop_companies: [] }),
    // People-data lookups: each one through the guard first (it counts them against what the user agreed to),
    // then the stand-in. A refused call is recorded as friction and the person gets nulls.
    enrich_lookup: (rows) => {
      const people = [];
      for (const r of (Array.isArray(rows) ? rows : rows.records || [])) {
        const args = { name: r.full_name || r.name, organization_name: r.company };
        const g = spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__enrich-a__people_match', tool_input: args }), env: { ...H.env, FLOORBOSS_NOW: H.now }, encoding: 'utf8' });
        (per.enrichCalls ||= []).push({ id: r.floorboss_id, status: g.status, stderr: String(g.stderr || '').slice(0, 200) });
        if (g.status !== 0) { people.push({ floorboss_id: r.floorboss_id, email: null, linkedin_url: null }); continue; }
        const m = mcp(H, 'enrich-a', 'people_match', args);
        if (!m.ok) return { __tool_error: m.error, task: 'enrich.person' };
        people.push({ floorboss_id: r.floorboss_id, email: m.data.person?.email || null, email_status: m.data.person?.email_status || null, linkedin_url: m.data.person?.linkedin_url || null });
      }
      return { people };
    },
    // Connected tools, through the stand-ins. A failed call comes back as { __tool_error }.
    crm_lookup: (list) => {
      const records = [], not_found = [];
      for (const p of (list.people || list)) {
        const r = mcp(H, 'crm-a', 'search_contacts', { query: p.email || p.name });
        if (!r.ok) return { __tool_error: r.error, task: 'crm.lookup' };
        // HubSpot-shaped results keep their fields under properties.
        const hits = (r.data.results || []).map((x) => ({ id: x.id, ...(x.properties || {}), ...x })).filter((x) => lower(x.email) === lower(p.email));
        if (!hits.length) not_found.push(p.email || p.name);
        for (const x of hits) { if (x.hubspot_owner_id && !x.owner) { const o = mcp(H, 'crm-a', 'get_owner', { owner_id: x.hubspot_owner_id }); if (!o.ok) return { __tool_error: o.error, task: 'crm.lookup' }; x.owner = `${o.data.firstName} ${o.data.lastName}`.trim(); } }
        for (const x of hits) records.push({ name: `${x.first_name || x.firstname || ''} ${x.last_name || x.lastname || ''}`.trim() || x.name, email: x.email, company: x.company, title: x.title || x.jobtitle || '', holder: x.owner?.name || x.owner || x.hubspot_owner || '', status: x.status || x.lifecyclestage || '', last_contact: x.last_contact || (x.notes_last_contacted ? new Date(Number(x.notes_last_contacted)).toISOString().slice(0, 10) : null), opted_out: x.opted_out === true || String(x.hs_email_optout) === 'true', crm_id: String(x.id || ''), notes: x.notes || '', profile_url: '' });
      }
      return { records, not_found };
    },
    // After the import: each person looked up by email for their record id.
    crm_contact_ids: (list) => {
      const records = [];
      for (const p of list) {
        const r = mcp(H, 'crm-a', 'search_contacts', { query: p.email });
        if (!r.ok) return { __tool_error: r.error, task: 'crm.lookup' };
        const hit = (r.data.results || []).find((x) => lower(x.properties?.email) === lower(p.email));
        if (hit) records.push({ id: p.id, crm_id: String(hit.id) });
      }
      return { records };
    },
    mail_history: (list) => {
      const people = [];
      for (const item of (list.people || list)) {
        const p = typeof item === 'string' ? { email: item } : item;
        const r = mcp(H, 'gmail', 'search_threads', { query: p.email });
        if (!r.ok) return { __tool_error: r.error, task: 'email.history' };
        people.push({ email: p.email, threads: r.data.resultSizeEstimate || 0, they_replied: !!r.data.they_replied || (r.data.threads || []).some((t) => t.they_replied), last_at: r.data.threads?.[0]?.last_at || null });
      }
      return { people };
    },
    // One note in the event app, as Claude would do it in the browser: the people search by link, the
    // profile that matches, the note pasted (the guard asks), send (a click), then what the page says.
    app_send_one: (read, s) => {
      const q = s.judge.target;
      const base = `https://meetwell.test/e/${spec.app?.slug || 'event'}`;
      const b = (tool, args) => { const g = guardBrowser(H, per, tool, args, q); if (g.blocked) return { __tool_error: `the guard refused ${tool}: ${g.blocked}`, task: 'app.send' }; const r = mcp(H, 'browser-app', tool, args); return r.ok ? r.data : { __tool_error: r.error, task: 'app.send' }; };
      const liUrl = (/https:\/\/www\.linkedin\.com\/in\/[\w-]+/.exec(`${q.to || ''} ${q.profile_url || ''}`) || [])[0];
      if (liUrl) {
        let r = b('navigate', { url: liUrl }); if (r.__tool_error) return r;
        r = b('get_page_text', {}); if (r.__tool_error) return r;
        if (/sign in/i.test(r.text)) return { id: q.id, touch: q.touch, result: 'logged_out', page_says: 'Sign in to continue.' };
        if (/isn't available/.test(r.text)) return { id: q.id, touch: q.touch, result: 'not_found', page_says: r.text.split('\n').pop() };
        r = b('form_input', { ref: 'message', value: q.body }); if (r.__tool_error) return r;
        r = b('computer', { action: 'left_click', ref: 'send' }); if (r.__tool_error) return r;
        const said = String(r.page || '');
        return { id: q.id, touch: q.touch, result: /^(Message|Invitation) sent/.test(said) ? 'sent' : /too long/.test(said) ? 'too_long' : /limit/.test(said) ? 'limit' : 'failed', page_says: said };
      }
      let r = b('navigate', { url: `${base}/people?q=${encodeURIComponent(q.name)}` }); if (r.__tool_error) return r;
      r = b('get_page_text', {}); if (r.__tool_error) return r;
      if (/log in/i.test(r.text)) return { id: q.id, touch: q.touch, result: 'logged_out', page_says: 'Please log in to continue.' };
      const company = (/\(([^)]+)\)\s*$/.exec(q.to) || [])[1] || '';
      const line = r.text.split('\n').find((l) => lower(l).includes(lower(q.name)) && (!company || lower(l).includes(lower(company))));
      const link = line && (/\(profile: (\S+)\)/.exec(line) || [])[1];
      if (!link) return { id: q.id, touch: q.touch, result: 'not_found', page_says: r.text.split('\n').slice(1).join(' ').slice(0, 200) };
      r = b('navigate', { url: link }); if (r.__tool_error) return r;
      r = b('get_page_text', {}); if (r.__tool_error) return r;
      if (/turned off messages/i.test(r.text)) return { id: q.id, touch: q.touch, result: 'messages_off', page_says: r.text.split('\n').pop() };
      r = b('form_input', { ref: 'message', value: q.body }); if (r.__tool_error) return r;
      r = b('computer', { action: 'left_click', ref: 'send' }); if (r.__tool_error) return r;
      const said = String(r.page || '');
      const result = /^Message sent/.test(said) ? 'sent' : /too long/.test(said) ? 'too_long' : /limit/.test(said) ? 'limit' : 'failed';
      return { id: q.id, touch: q.touch, result, page_says: said };
    },
    // An unclear send: is it in the mailbox's sent messages since the release?
    crm_log: (list, s) => {
      const out = [];
      const b = (tool, args, it) => { const g = guardBrowser(H, per, tool, args, { id: it.id, touch: it.touch, log: true }); if (g.blocked) return { __tool_error: `the guard refused ${tool}: ${g.blocked}`, task: 'crm.log' }; const r = mcp(H, 'browser-app', tool, args); return r.ok ? r.data : { __tool_error: r.error, task: 'crm.log' }; };
      for (const it of list) {
        let r = b('navigate', { url: `https://app.hubspot.com/contacts/search?q=${encodeURIComponent(it.email || it.name)}` }, it); if (r.__tool_error) return r;
        r = b('get_page_text', {}, it); if (r.__tool_error) return r;
        if (/log in/i.test(r.text)) { out.push({ key: it.key, result: 'logged_out', page_says: 'Log in to continue.' }); continue; }
        let link = (/\(record: (\S+)\)/.exec(r.text) || [])[1];
        let created = false;
        if (!link && it.create) {
          // Not a contact yet and creating was allowed: a new contact with the listed fields only.
          r = b('navigate', { url: 'https://app.hubspot.com/contacts/new' }, it); if (r.__tool_error) return r;
          const [first, ...rest] = String(it.name).split(' ');
          for (const [ref, value] of [['first', first], ['last', rest.join(' ')], ['company', it.company || ''], ['title', it.title || ''], ['email', it.email || ''], ['linkedin', it.profile_url || '']]) { if (!value) continue; r = b('form_input', { ref, value }, it); if (r.__tool_error) return r; }
          r = b('computer', { action: 'left_click', ref: 'create' }, it); if (r.__tool_error) return r;
          link = (/\(record: (\S+)\)/.exec(String(r.page || '')) || [])[1];
          if (!link) { out.push({ key: it.key, result: 'failed', page_says: String(r.page || '') }); continue; }
          created = true;
        }
        if (!link) { out.push({ key: it.key, result: 'not_found', page_says: r.text.split('\n').pop() }); continue; }
        r = b('navigate', { url: link }, it); if (r.__tool_error) return r;
        // Fill empty fields only (the item's fill), then save; a field with a value is left alone.
        const filled = [];
        if (it.fill && !created) {
          r = b('get_page_text', {}, it); if (r.__tool_error) return r;
          for (const [key, ref, label] of [['linkedin', 'linkedin', 'LinkedIn URL'], ['title', 'jobtitle', 'Job title']]) {
            if (!it.fill[key]) continue;
            if (new RegExp(`${label}: \\(empty\\)`).test(r.text)) { const w = b('form_input', { ref, value: it.fill[key] }, it); if (w.__tool_error) return w; filled.push(key); }
          }
          if (filled.length) { const w = b('computer', { action: 'left_click', ref: 'save' }, it); if (w.__tool_error) return w; }
        }
        for (const [ref, value] of [['type', 'LinkedIn message'], ['message', it.body], ['date', it.sent_on]]) { r = b('form_input', { ref, value }, it); if (r.__tool_error) return r; }
        r = b('computer', { action: 'left_click', ref: 'log' }, it); if (r.__tool_error) return r;
        out.push({ key: it.key, result: /^Activity logged/.test(String(r.page || '')) ? (created ? 'created' : 'logged') : 'failed', page_says: String(r.page || ''), ...(created ? { ref: link.split('/').pop() } : {}), ...(filled.length ? { filled } : {}) });
      }
      return out;
    },
    check_sent: (read, s) => {
      const q = s.judge.target;
      const r = mcp(H, 'gmail', 'list_messages', { address: q.email, since: q.since });
      if (!r.ok) return { __tool_error: r.error, task: 'email.messages' };
      const m = (r.data.messages || []).find((x) => lower(x.to) === lower(q.email) && (lower(x.from) === lower(spec.own.email) || lower(x.from) === 'me@standin.example'));
      return m ? { id: q.id, touch: q.touch, went: 'yes', message_id: m.id, thread_id: m.threadId } : { id: q.id, touch: q.touch, went: 'no' };
    },
    check_replies: (list) => readReplies(list),
    // The inbox, read in the browser (through the guard), the way Claude would read the page.
    check_inbox: (list, s) => {
      const li = /LinkedIn/.test(s.why || '') || /linkedin/.test(s.judge.write || '');
      const url = li ? 'https://www.linkedin.com/messaging/' : `https://meetwell.test/e/${spec.app?.slug || 'event'}/inbox`;
      for (const [tool, args] of [['navigate', { url }], ['get_page_text', {}]]) { const g = guardBrowser(H, per, tool, args, { id: null, touch: null, log: true }); if (g.blocked) return { __tool_error: `the guard refused ${tool}: ${g.blocked}`, task: li ? 'inbox.linkedin' : 'inbox.app' }; }
      (per.inboxVisits ||= []).push(li ? 'linkedin' : 'app');
      mcp(H, 'browser-app', 'navigate', { url }); const r = mcp(H, 'browser-app', 'get_page_text', {}); const page = String(r.data?.text || '');
      if (/Sign in|Log in/.test(page)) return { __tool_error: 'the page asks to sign in', task: li ? 'inbox.linkedin' : 'inbox.app' };
      const lines = page.split('\n').map((l) => /^- (.+?) \(([^)]+)\): (.+)$/.exec(l)).filter(Boolean);
      return { people: list.map((p) => ({ id: p.id, messages: lines.filter((m) => lower(m[1]) === lower(p.name)).map((m, k) => ({ message_id: `${p.id}-${k}-${m[2]}`, direction: 'in', at: m[2], text: m[3], from: m[1], ...intentOf(m[3]) })) })) };
    },
    check_calendar: () => {
      const r = mcp(H, 'calendar-a', 'list_events', { timeMin: `${spec.event.start}T00:00:00Z`, timeMax: `${spec.event.end}T23:59:59Z` });
      if (!r.ok) return { __tool_error: r.error, task: 'calendar.events' };
      return { events: (r.data.items || []).map((i) => ({ start: i.start?.dateTime || i.start, end: i.end?.dateTime || i.end, summary: i.summary, organizer: i.organizer?.email || null, organizer_is_you: !!i.organizer?.self, self_response: i.organizer?.self ? null : (i.attendees || []).find((a) => a.self)?.responseStatus || null, attendees: (i.attendees || []).map((a) => ({ email: a.email, response: a.responseStatus || null })), status: i.status || 'confirmed' })) };
    },
    check_replies_one: (list) => readReplies(list),
  } });
  // The CRM records its mailbox sync can't read from here: the persona says so when asked to connect it.
  per.connect = (s) => (s.task === 'crm.activity' ? { task: 'crm.activity', answer: "my CRM doesn't log my email" } : null);
  per.call = (item, call) => {
    if (call.task === 'crm.create_contact') {
      const fill = (v) => (Array.isArray(v) ? v.map(fill) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : (/^\{(\w+)\}$/.exec(String(v)) ? (item[/^\{(\w+)\}$/.exec(String(v))[1]] ?? '') : v));
      const r = mcp(H, 'crm-a', 'create_contact', fill(call.recipe?.args || RECIPES.crmCreate[1].args));
      if (!r.ok) return { __tool_error: r.error, task: 'crm.create_contact' };
      (per.crmCreated ||= []).push(item.email);
      return { records: [{ id: item.id, crm_id: r.data.id }] };
    }
    if (call.task === 'crm.create_task') {
      const fill = (v) => (Array.isArray(v) ? v.map(fill) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : (/^\{(\w+)\}$/.exec(String(v)) ? (item[/^\{(\w+)\}$/.exec(String(v))[1]] ?? '') : v));
      const t = mcp(H, 'crm-a', 'create_task', fill(call.recipe?.args || RECIPES.tasks[1].args));
      if (!t.ok) return { __tool_error: t.error, task: 'crm.create_task' };
      return { tasks: [{ key: item.key, task_id: t.data.id }] };
    }
    const r = mcp(H, call.recipe?.server || 'gmail', call.recipe?.tool || 'send_message', fillArgs(call));
    if (!r.ok) return { __tool_error: r.error, task: 'email.send' };
    return { sends: [{ id: item.id, touch: item.touch, message_id: r.data.id, thread_id: r.data.threadId }] };
  };
  per.appSentTo = (person) => { const f = `${H.standin}.app-sent.json`; return existsSync(f) && JSON.parse(readFileSync(f, 'utf8')).some((m) => lower(m.to) === lower(person.name)); };
  per.fallback = (s) => { const v = s.ask.options?.[0] ?? 'skip'; friction.push({ step: s.step, ask: s.ask.id, question: s.ask.question.slice(0, 160), answered: v }); return v; };
  per.friction = friction;
  return per;
}

// A browser call goes through the guard first, as Claude Code would run it. Typing a listed note must make it
// ask; a click or a read passes. Returns { asked } or { blocked }.
function guardBrowser(H, per, tool, args, target) {
  const g = spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: `mcp__browser-app__${tool}`, tool_input: args }), env: { ...H.env, FLOORBOSS_NOW: H.now }, encoding: 'utf8' });
  const asked = /"permissionDecision":"ask"/.test(g.stdout || '');
  (per.browserCalls ||= []).push({ tool, id: target.id, touch: target.touch, status: g.status, asked, typedNote: tool === 'form_input' && !target.log });
  if (g.status !== 0) return { blocked: String(g.stderr || '').trim().slice(0, 200) };
  return { asked };
}

function fillArgs(call) {
  const it = call.item, out = {};
  for (const [k, v] of Object.entries(call.recipe?.args || {})) { const m = /^\{(\w+)\}$/.exec(String(v)); if (!m) out[k] = v; else if (it[m[1]] != null) out[k] = it[m[1]]; }
  return out;
}

// A careful user's mapping: the proposal with every status given the meaning the persona knows.
const MEANING = { 'Kein Kontakt erwünscht': 'do_not_contact', 'dont email': 'do_not_contact', 'said no': 'lost', Kunde: 'customer', client: 'customer', Verloren: 'lost', Partner: 'coordinate', Interessent: 'ignore', Angebot: 'warm', talking: 'warm', 'met at expo 2025': 'ignore', unsubscribed: 'do_not_contact' };
function careful(H, slug, spec) {
  const m = JSON.parse(readFileSync(join(H.HOME, 'events', slug, 'derived', 'mapping-crm.json'), 'utf8'));
  m.values ||= {}; m.values.status ||= {};
  for (const v of Object.keys(m.values.status)) if (MEANING[v]) m.values.status[v] = MEANING[v];
  for (const v of m.status_values || []) if (MEANING[v] && !m.values.status[v]) m.values.status[v] = MEANING[v];
  for (const [h, c] of Object.entries(m.columns)) { if (/kein newsletter|unsubscribed/i.test(h)) Object.assign(c, { field: 'opted_out', sense: 'optout' }); if (/^notiz|^notes?$|description/i.test(h)) c.field = 'notes'; }
  // No opt-out column in this export (the sheet keeps opt-outs as a status): say so.
  if (!Object.values(m.columns).some((c) => c.field === 'opted_out')) m.opt_out_none = true;
  return m;
}

// The checks every run must pass. Returns { problems: [...], counts }.
export function checkRun(P) {
  const { H, g, per, truthBy, spec } = P;
  const slug = per.slug;
  const dir = join(H.HOME, 'events', slug);
  const problems = [];
  // Writing to a coworker's contact is what the user chose under warn or mine (or a yes when asked).
  const modeFor = (holder) => { const o = P.spec.coworkerOverrides || {}; return o[holder] || ({ 'write to them, but warn me before sending': 'warn', 'treat them as mine': 'mine', 'ask me each time': 'ask' })[P.spec.coworkers] || 'leave'; };
  const coworkerOk = (holder) => { const m = modeFor(holder); return m === 'warn' || m === 'mine' ? m : m === 'ask' && (P.spec.coworkerYes || []).includes(holder) ? 'ask' : false; };
  const st = fold(readLedger(join(dir, 'ledger.jsonl')).entries);
  const contacts = JSON.parse(readFileSync(join(dir, 'derived', 'contacts.json'), 'utf8'));
  const resolved = JSON.parse(readFileSync(join(dir, 'derived', 'resolved.json'), 'utf8'));
  const truthOfContact = (c) => (c.emails || [c.email]).map((e) => truthBy.get(lower(e))).find(Boolean) || truthBy.get(`${lower(c.name)}|${lower(c.company)}`);
  for (const c of contacts) {
    const t = truthOfContact(c);
    const grp = resolved[c.id]?.group;
    if (t?.truth === 'never' && ['reach', 'warm'].includes(grp)) problems.push(`${c.name} (${t.why.join('; ')}) is ${grp}: ${resolved[c.id].says}`);
    if (t?.truth === 'colleague' && ['reach', 'warm'].includes(grp) && !coworkerOk(t.holder)) problems.push(`${c.name} (held by ${t.holder}) is ${grp}: ${resolved[c.id].says}`);
    if (t?.truth === 'colleague' && ['reach', 'warm'].includes(grp) && coworkerOk(t.holder) === 'warn' && !resolved[c.id].coworker_warn && !(P.spec.coworkerYes || []).includes(t.holder)) problems.push(`${c.name} (${t.holder}'s) is ${grp} without the warning flag`);
  }
  // What really went out, from the stand-in's own record.
  const sentPath = `${H.standin}.sent.json`;
  const sent = existsSync(sentPath) ? JSON.parse(readFileSync(sentPath, 'utf8')) : [];
  for (const m of sent) {
    const t = truthBy.get(lower(m.to));
    if (t?.truth === 'never') problems.push(`SENT to ${m.to}, who is never to be contacted (${t.why.join('; ')})`);
    if (t?.truth === 'colleague' && !coworkerOk(t.holder)) problems.push(`SENT to ${m.to}, whom ${t.holder} holds`);
  }
  // The new-people sims (spec.crmCheck): whoever the lookup didn't find is in the CRM before their first email,
  // as the stand-in mailbox saw it go (not floorboss's own record), and only those people were added.
  if (spec.crmCheck) {
    const entries = readLedger(join(dir, 'ledger.jsonl')).entries;
    const recPath = join(dir, 'inputs', 'crm-records.json');
    const missed = existsSync(recPath) ? new Set((JSON.parse(readFileSync(recPath, 'utf8')).not_found || []).map(lower)) : new Set();
    const created = new Map(entries.filter((e) => e.type === 'crm_created').map((e) => [e.id, e.at]));
    const createdEmails = new Map([...created].map(([id, at]) => [lower(st.people[id]?.email_override || st.people[id]?.email), at]));
    for (const addr of new Set(sent.map((m) => lower(m.to)))) {
      const first = sent.filter((m) => lower(m.to) === addr).map((m) => m.at).sort()[0];
      if (missed.has(addr) && !(createdEmails.has(addr) && Date.parse(createdEmails.get(addr)) <= Date.parse(first))) problems.push(`FIRST EMAIL to ${addr} before they were in the CRM`);
    }
    for (const addr of createdEmails.keys()) if (!missed.has(addr)) problems.push(`ADDED ${addr} to the CRM though the lookup had them, or never looked`);
    if (!created.size) problems.push('nobody was added to the CRM: the new-people path never ran');
    if (!sent.length) problems.push('nothing was sent: the check saw no first emails');
  }
  // After a reply: nothing more to that address (an out-of-office: nothing before they're back).
  for (const [addr, rk] of Object.entries(P.per.replyKinds || {})) {
    const after = sent.filter((m) => lower(m.to) === addr && Date.parse(m.at) > Date.parse(rk.at));
    if (rk.kind === 'ooo') { if (after.some((m) => m.at.slice(0, 10) < '2027-10-19')) problems.push(`SENT to ${addr} while they were away (out of office until 2027-10-19)`); continue; }
    // After a booking, the confirmation is the one message that goes (in the same thread).
    const notOk = rk.kind === 'booked' ? after.filter((m) => !/^See you there|confirm/i.test(`${m.subject} ${m.body}`)) : after;
    if (notOk.length) problems.push(`SENT to ${addr} after they wrote back (${rk.kind})`);
    if (rk.kind === 'booked' && after.length > 1) problems.push(`${after.length} messages to ${addr} after they booked (only a confirmation should go)`);
    const st = rk.id ? fold(readLedger(join(H.HOME, 'events', P.per.slug, 'ledger.jsonl')).entries).people[rk.id] : null;
    if (st && rk.kind === 'stop' && !st.stopped) problems.push(`${addr} asked to stop, but isn't stopped`);
    if (st && rk.kind === 'decline' && !st.declined) problems.push(`${addr} said no, but isn't recorded as declined`);
    if (st && rk.kind === 'bounce' && !st.bounced) problems.push(`${addr} bounced, but isn't recorded as bounced`);
    if (st && rk.kind === 'booked' && !st.booked) problems.push(`${addr} accepted a time, but nothing is booked`);
    if (rk.kind === 'referral' && !JSON.parse(readFileSync(join(H.HOME, 'events', P.per.slug, 'derived', 'contacts.json'), 'utf8')).some((x) => lower(x.email) === 'rosa.quintero@referral.test')) problems.push(`${addr} pointed to Rosa Quintero, who wasn't added`);
  }
  // LinkedIn and app replies read in the browser: nothing more to them after a reply; logged when asked; never
  // read where the user didn't allow it.
  for (const [k, rk] of Object.entries(P.per.inboxKinds || {})) {
    const allowed = /yes/.test(P.spec.inbox || '') && (rk.where === 'linkedin' ? /LinkedIn|log/.test(P.spec.inbox) : /Meetwell|log/.test(P.spec.inbox));
    if (!allowed) continue;
    const st = rk.id ? fold(readLedger(join(H.HOME, 'events', P.per.slug, 'ledger.jsonl')).entries).people[rk.id] : null;
    if (st && rk.kind === 'stop' && !st.stopped) problems.push(`${k} asked to stop on ${rk.where}, but isn't stopped`);
    if (st && rk.kind !== 'ooo' && !st.replied && !st.stopped) problems.push(`${k} replied on ${rk.where}, but floorboss didn't see it`);
    // Automatic replies (out of office) aren't logged: they'd be noise on the record.
    if (/log/.test(P.spec.inbox) && P.spec.crmLog === 'browser' && rk.kind !== 'ooo') { const logged = existsSync(`${H.standin}.crm-log.json`) ? JSON.parse(readFileSync(`${H.standin}.crm-log.json`, 'utf8')) : []; if (!logged.some((x) => String(x.body || '').includes(rk.text.slice(0, 40)))) problems.push(`${k}'s ${rk.where} reply wasn't logged in the CRM`); }
  }
  if (!/yes/.test(P.spec.inbox || '') && (P.per.inboxVisits || []).length) problems.push(`floorboss read an inbox the user didn't allow (${P.per.inboxVisits.join(', ')})`);
  for (const [addr, start] of Object.entries(P.per.calendarAccepts || {})) {
    const c = JSON.parse(readFileSync(join(H.HOME, 'events', P.per.slug, 'derived', 'contacts.json'), 'utf8')).find((x) => lower(x.email) === addr);
    const st = c ? fold(readLedger(join(H.HOME, 'events', P.per.slug, 'ledger.jsonl')).entries).people[c.id] : null;
    if (st && !st.booked) problems.push(`${addr} accepted an invite (${start}), but isn't booked`);
    if (sent.some((m) => lower(m.to) === addr && Date.parse(m.at) > Date.parse('2027-10-19T00:00:00Z') && !/See you there|confirm/i.test(`${m.subject} ${m.body}`))) problems.push(`SENT a follow-up to ${addr} after they accepted the invite`);
  }
  // What went in the event app, from the app's own record: same rules, and every typed note asked first.
  const appSentPath = `${H.standin}.app-sent.json`;
  const appSent = existsSync(appSentPath) ? JSON.parse(readFileSync(appSentPath, 'utf8')) : [];
  for (const m of appSent) {
    const t = truthBy.get(`${lower(m.to)}|${lower(m.company)}`);
    if (t?.truth === 'never') problems.push(`APP NOTE to ${m.to}, who is never to be contacted (${t.why.join('; ')})`);
    if (t?.truth === 'colleague' && !coworkerOk(t.holder)) problems.push(`APP NOTE to ${m.to}, whom ${t.holder} holds`);
  }
  const liSentPath = `${H.standin}.li-sent.json`;
  const liSent = existsSync(liSentPath) ? JSON.parse(readFileSync(liSentPath, 'utf8')) : [];
  for (const m of liSent) {
    const t = truthBy.get(`${lower(m.to)}|${lower(m.company)}`);
    if (t?.truth === 'never') problems.push(`LINKEDIN to ${m.to}, who is never to be contacted (${t.why.join('; ')})`);
    if (t?.truth === 'colleague' && !coworkerOk(t.holder)) problems.push(`LINKEDIN to ${m.to}, whom ${t.holder} holds`);
  }
  const liBy = {}; for (const m of liSent) { const k = `${lower(m.to)}|${lower(m.text).slice(0, 60)}`; liBy[k] = (liBy[k] || 0) + 1; }
  for (const [k, n] of Object.entries(liBy)) if (n > 1) problems.push(`the LinkedIn note ${k} went ${n} times`);
  // UX: approved LinkedIn messages the user sends themselves must be in the outbox with the profile link and a Copy button.
  const outbox = join(dir, 'outbox.html');
  const pasteCards = Object.entries(st.people).filter(([, p]) => Object.values(p.touches).some((x) => x.approved && !x.sent)).map(([id]) => contacts.find((c) => c.id === id)).filter((c) => c?.profile_url && !c.email);
  if (pasteCards.length && !(P.spec.linkedin?.send)) {
    const html = existsSync(outbox) ? readFileSync(outbox, 'utf8') : '';
    if (!html) problems.push(`UX: ${pasteCards.length} approved LinkedIn messages but no outbox.html to copy them from`);
    else for (const c of pasteCards) if (!html.includes(c.profile_url)) problems.push(`UX: outbox has no profile link for ${c.name} (${c.profile_url})`);
  }
  // UX: a CRM task tool is connected but no task was ever made for the LinkedIn or app messages the user sends by hand.
  const tasksFile = `${H.standin}.tasks.json`;
  const tasksMade = existsSync(tasksFile) ? JSON.parse(readFileSync(tasksFile, 'utf8')).length : 0;
  if ((P.spec.connected || []).includes('tasks') && pasteCards.length && !tasksMade) problems.push(`UX: CRM task tool connected, ${pasteCards.length} LinkedIn/app messages to send by hand, 0 CRM tasks created`);
  // Warn mode: a coworker's contact was approved, so an approval question must have named coworkers.
  const warned = (per.approveQs || []).some((q) => /people your coworkers own/.test(q));
  const cwApproved = Object.entries(st.people).filter(([id, p]) => Object.values(p.touches).some((x) => x.approved)).map(([id]) => contacts.find((c) => c.id === id)).map((c) => c && truthOfContact(c)).filter((t) => t?.truth === 'colleague' && modeFor(t.holder) === 'warn');
  if (cwApproved.length && !warned) problems.push(`approved ${cwApproved.length} coworkers' contacts in warn mode, but no approval question warned about them`);
  const createdPath = `${H.standin}.crm-created.json`;
  const createdRecs = existsSync(createdPath) ? JSON.parse(readFileSync(createdPath, 'utf8')) : [];
  if (createdRecs.length && !P.spec.crmCreate) problems.push(`SAFETY: ${createdRecs.length} CRM contacts created though the user said no`);
  const createdKeys = createdRecs.map((x) => lower(`${x.first_name} ${x.last_name}|${x.company}`));
  if (new Set(createdKeys).size < createdKeys.length) problems.push('a CRM contact was created twice');
  const messagedKeys = new Set([...liSent, ...appSent].map((m) => lower(`${m.to}|${m.company}`)));
  for (const k of createdKeys) if (!messagedKeys.has(k)) problems.push(`a CRM contact was created for someone never messaged (${k})`);
  const overPath = `${H.standin}.crm-overwritten.json`;
  const overwritten = existsSync(overPath) ? JSON.parse(readFileSync(overPath, 'utf8')) : [];
  if (overwritten.length) problems.push(`SAFETY: ${overwritten.length} CRM fields that had a value were changed (e.g. ${overwritten[0].field} on ${overwritten[0].record})`);
  const fieldsPath = `${H.standin}.crm-fields.json`;
  const fieldEdits = existsSync(fieldsPath) ? Object.values(JSON.parse(readFileSync(fieldsPath, 'utf8'))).reduce((n, r) => n + Object.keys(r).length, 0) : 0;
  if (fieldEdits && !/^yes/i.test(P.spec.crmFill || '')) problems.push(`SAFETY: ${fieldEdits} CRM fields filled though the user said not to change contacts`);
  const delPath = `${H.standin}.crm-deleted.json`;
  if (existsSync(delPath) && JSON.parse(readFileSync(delPath, 'utf8')).length) problems.push('SAFETY: a CRM contact was deleted during logging');
  if (P.spec.crmLog === 'browser') {
    const logged = existsSync(`${H.standin}.crm-log.json`) ? JSON.parse(readFileSync(`${H.standin}.crm-log.json`, 'utf8')) : [];
    const crmEmails = new Set((JSON.parse(readFileSync(H.standin, 'utf8')).crm?.records || []).map((r) => lower(r.email)));
    const sentPeople = [...liSent.map((m) => truthBy.get(`${lower(m.to)}|${lower(m.company)}`)), ...appSent.map((m) => truthBy.get(`${lower(m.to)}|${lower(m.company)}`))].filter(Boolean);
    const inCrm = sentPeople.filter((t) => t.email && crmEmails.has(lower(t.email)));
    const loggedEmails = new Set(logged.map((x) => lower(x.email)));
    const missing = inCrm.filter((t) => !loggedEmails.has(lower(t.email)));
    // With creation allowed (and agreed), everyone messaged ends up logged, CRM contact before or not.
    const createOn = /^yes/i.test(P.spec.crmCreate || '') || (/ask/i.test(P.spec.crmCreate || '') && P.spec.crmCreateOk !== false);
    if (createOn && P.spec.crmWeb?.logged_in !== false) { const loggedNames = new Set(logged.map((x) => lower(x.name))); const notLogged = sentPeople.filter((t) => !loggedNames.has(lower(t.name))); if (notLogged.length) problems.push(`UX: creation on, but ${notLogged.length} people messaged have no logged activity (e.g. ${notLogged[0].name})`); }
    if (missing.length && P.spec.crmWeb?.logged_in !== false) problems.push(`UX: ${missing.length} LinkedIn/app messages to CRM contacts weren't logged in the CRM (e.g. ${missing[0].name})`);
    const dupe = logged.length - new Set(logged.map((x) => `${x.record}|${x.body.slice(0, 60)}`)).size;
    if (dupe > 0) problems.push(`${dupe} CRM activities were logged twice`);
  }
  const byNote = {};
  for (const m of appSent) { const k = `${lower(m.to)}|${lower(m.text).slice(0, 60)}`; byNote[k] = (byNote[k] || 0) + 1; }
  for (const [k, n] of Object.entries(byNote)) if (n > 1) problems.push(`the app note ${k} went ${n} times`);
  for (const bc of per.browserCalls || []) if (bc.typedNote && bc.status === 0 && !bc.asked) problems.push(`a note to ${bc.id} was typed without the prompt`);
  // People-data lookups: never more than the user agreed to, and at least one went (the path works).
  if (spec.connected?.includes('enrich')) {
    const went = (per.enrichCalls || []).filter((x) => x.status === 0).length;
    const agreed = Number((/(\d+)/.exec(spec.enrichOk || 'only the top 3') || [])[1] || Infinity);
    if (went > agreed) problems.push(`${went} people-data lookups ran, but the user agreed to ${agreed}`);
    if (!went) problems.push('no people-data lookup ran, though the user agreed to some');
  }
  const calls = per.guardCalls || [];
  if (calls.some((x) => x.step !== 'crm_task' && !/"permissionDecision":"ask"/.test(x.stdout || ''))) problems.push('a send went without the prompt');
  const keys = calls.filter((x) => x.status === 0).map((x) => `${x.item.id}:${x.item.touch}`);
  // Sent twice: the same person and message number in the stand-in's record.
  const bySent = {};
  // Follow-ups share their thread's subject ("Re: …"), so the text tells one message from another.
  for (const m of sent) { const k = `${lower(m.to)}|${lower(m.subject).replace(/^re:\s*/, '')}|${lower(m.body || m.text || '').replace(/\s+/g, ' ').slice(0, 80)}`; bySent[k] = (bySent[k] || 0) + 1; }
  for (const [k, n] of Object.entries(bySent)) if (n > 1 && !/one more thought/.test(k)) problems.push(`${k} was sent ${n} times`);
  // Everything the stand-in sent passed the guard first.
  if (sent.length > calls.filter((x) => x.status === 0).length) problems.push(`${sent.length} messages went out but the guard saw ${calls.length}`);
  for (const [id, p] of Object.entries(st.people)) for (const [t, x] of Object.entries(p.touches)) if (Number(t) > 1 && x.sent && x.sent.channel === 'email.send' && !x.sent.thread_id) problems.push(`${id} follow-up ${t} has no thread`);
  // No company hears from more people than its size allows (unless the user set a cap themselves).
  const userCapped = Object.keys(st.caps || {}).length > 0;
  if (!userCapped) {
    const shortlist = JSON.parse(readFileSync(join(dir, 'derived', 'shortlist.json'), 'utf8'));
    const settings = JSON.parse(readFileSync(join(H.HOME, 'config.json'), 'utf8'));
    const perCo = {};
    // People the user decided on themselves are never cut by a cap; they don't count here.
    for (const id of shortlist.ranked.filter((x) => !st.people[x]?.decision)) { const c = contacts.find((x) => x.id === id); const t = c && truthOfContact(c); if (t?.band) (perCo[t.company] ||= { band: t.band, n: 0 }).n++; }
    for (const [co, v] of Object.entries(perCo)) { const cap = capFor(co, settings, {}, v.band); if (v.n > cap) problems.push(`${co} (${v.band}) has ${v.n} shortlisted; its size allows ${cap}`); }
  }
  return { problems, counts: { crm_filled: fieldEdits, crm_created: createdRecs.length, crm_logged: existsSync(`${H.standin}.crm-log.json`) ? JSON.parse(readFileSync(`${H.standin}.crm-log.json`, 'utf8')).length : 0, li_sent: liSent.length, tasks: tasksMade, app_notes: appSent.length, contacts: contacts.length, shortlisted: Object.values(resolved).filter((r) => ['reach', 'warm'].includes(r.group)).length, sent: sent.length, guard_calls: calls.length, guard_refused: calls.filter((x) => x.status !== 0).length, friction: per.friction.length, keys: new Set(keys).size } };
}

export function runPersona(spec, { maxSteps = 900 } = {}) {
  const P = buildPersona(spec);
  const out = { id: spec.id, stages: [] };
  const stage = (name, fn) => { try { const r = fn(); out.stages.push({ name, ok: true, last: r?.last?.step }); return true; } catch (e) { out.stages.push({ name, ok: false, error: String(e.message).slice(0, 600) }); return false; } };
  // Round trips by kind: what speed work has to bring down (mechanical runs, judgements, agents, questions, calls).
  out.steps = { run: 0, judge: 0, agent: 0, ask: 0, call: 0, other: 0, by_step: {} };
  out.trail = [];
  const onStep = (st) => { const k = st.ask ? 'ask' : st.judge ? 'judge' : (st.agent || st.agents) ? 'agent' : st.call ? 'call' : st.run ? 'run' : 'other'; out.steps[k]++; out.steps.by_step[st.step] = (out.steps.by_step[st.step] || 0) + 1; out.trail.push(st.step); };
  const ok1 = stage('first run', () => { const r = drive(P.H, P.per, { maxSteps, onStep }); P.per.slug = r.slug; return r; });
  if (ok1 && spec.later) {
    for (const [i, later] of spec.later.entries()) {
      P.H.now = later.now;
      if (later.faults) writeFileSync(P.H.faults, JSON.stringify(later.faults));
      if (later.replies) applyReplies(P, later.replies, later.logged !== false);
      if (later.replyKinds) applyReplyKinds(P, later.replyKinds, later.now);
      if (later.liReplyKinds) applyInboxKinds(P, later.liReplyKinds, 'linkedin');
      if (later.appReplyKinds) applyInboxKinds(P, later.appReplyKinds, 'app');
      if (later.calendarAccepts) applyCalendarAccepts(P, later.calendarAccepts);
      if (later.liLoggedOut) { const d = JSON.parse(readFileSync(P.H.standin, 'utf8')); d.linkedin.logged_in = false; writeFileSync(P.H.standin, JSON.stringify(d)); }
      if (later.appReplies) applyAppReplies(P, later.appReplies);
      stage(`later ${i + 1}`, () => drive(P.H, { ...P.per, slug: P.per.slug }, { maxSteps, onStep }));
    }
  }
  // Speed budget: from the shortlist's yes to the first approval request, at most 12 round trips.
  // Setup questions asked after the shortlist (free time, tone, sending) are counted apart: the budget is drafting's.
  const g = out.trail.lastIndexOf('gate'), ap = out.trail.indexOf('approve', g);
  const between = g >= 0 && ap > g ? out.trail.slice(g + 1, ap) : null;
  // Rewrites the user asked for in their rating notes are theirs, not drafting's: they get their own budget.
  const work = between ? between.filter((x) => !x.startsWith('onboarding:')) : null;
  const rn = work ? work.lastIndexOf('rate_notes') : -1;
  const drafting = work ? (rn >= 0 ? work.slice(0, rn + 1) : work) : null;
  const rewrites = work && rn >= 0 ? work.slice(rn + 1) : [];
  out.draft_trips = drafting ? drafting.length : null;
  out.rewrite_trips = rewrites.length;
  out.setup_after_gate = between ? between.filter((x) => x.startsWith('onboarding:')).length : null;
  out.questions_before_gate = g >= 0 ? out.trail.slice(0, g).filter((x) => x.startsWith('onboarding:') || ['attendee_list', 'check_these'].includes(x)).length : null;
  if (P.per.slug) { try { out.check = checkRun(P); } catch (e) { out.check = { problems: [`checks failed to run: ${e.message}`] }; } }
  if (out.draft_trips != null && out.draft_trips > 12) (out.check ||= { problems: [] }).problems.push(`SPEED: ${out.draft_trips} round trips from the shortlist to the first approval (budget 12): ${drafting.join(' ')}`);
  if (out.rewrite_trips > 8) (out.check ||= { problems: [] }).problems.push(`SPEED: ${out.rewrite_trips} round trips rewriting to the user's rating notes (budget 8): ${rewrites.join(' ')}`);
  out.friction = P.per.friction;
  out.home = P.H.HOME;
  return out;
}

// A week on: some people replied (in the stand-in mailbox, and as the persona's answer when asked).
function applyReplies(P, n, logged = true) {
  const sentPath = `${P.H.standin}.sent.json`;
  const sent = existsSync(sentPath) ? JSON.parse(readFileSync(sentPath, 'utf8')) : [];
  const data = JSON.parse(readFileSync(P.H.standin, 'utf8'));
  P.per.replied ||= new Set();
  const contacts = JSON.parse(readFileSync(join(P.H.HOME, 'events', P.per.slug, 'derived', 'contacts.json'), 'utf8'));
  for (const m of sent.slice(0, n)) {
    if (logged && !data.mail.threads.some((t) => t.thread_id === m.threadId)) data.mail.threads.push({ thread_id: m.threadId, to: m.to, subject: m.subject, sent_at: m.at, replies: [{ from: m.to, at: new Date(Date.parse(m.at) + 864e5).toISOString(), snippet: 'Tuesday works' }] });
    const c = contacts.find((x) => lower(x.email) === lower(m.to));
    if (c) P.per.replied.add(c.id);
  }
  writeFileSync(P.H.standin, JSON.stringify(data));
}

// Replies of every kind, one per kind, to the first people sent to: what each says decides what floorboss must
// do (the judge below reads it the way Claude would). Kept per address with the time, for the checks.
const REPLY_TEXT = {
  reply: () => ({ snippet: 'Thanks, interesting. Let me think about it.' }),
  booked: (m) => ({ snippet: `Happy to meet. ${m.slot || '2027-10-21 10:00'} works for me.` }),
  decline: () => ({ snippet: 'No thanks, not a fit for us right now.' }),
  stop: () => ({ snippet: 'Please remove me from your list and don\'t contact me again.' }),
  referral: () => ({ snippet: 'Not my area. Talk to Rosa Quintero (rosa.quintero@referral.test), our Head of Operations.' }),
  ooo: () => ({ snippet: 'Out of office: I am away until 2027-10-19 with limited access to email.', auto: true }),
  bounce: () => ({ snippet: 'Delivery Status Notification (Failure): address not found.', auto: true, from: 'mailer-daemon@googlemail.test' }),
  newthread: () => ({ snippet: 'Saw your note, let\'s talk at the event.' }),
  assistant: (m) => ({ snippet: 'Replying for my boss: she would like to meet, Thursday is best.', from: `ea.${m.to.split('@')[0]}@${m.to.split('@')[1]}` }),
};
function applyReplyKinds(P, kinds, now) {
  const sent = existsSync(`${P.H.standin}.sent.json`) ? JSON.parse(readFileSync(`${P.H.standin}.sent.json`, 'utf8')) : [];
  const data = JSON.parse(readFileSync(P.H.standin, 'utf8'));
  P.per.replied ||= new Set(); P.per.replyKinds ||= {};
  const contacts = JSON.parse(readFileSync(join(P.H.HOME, 'events', P.per.slug, 'derived', 'contacts.json'), 'utf8'));
  const firsts = [...new Map(sent.map((m) => [lower(m.to), m])).values()];
  kinds.forEach((kind, i) => {
    const m = firsts[i]; if (!m) return;
    const r = REPLY_TEXT[kind](m);
    const at = new Date(Date.parse(m.at) + 3600e3).toISOString();
    if (kind === 'newthread') data.mail.threads.push({ thread_id: `t-new-${i}`, to: m.to, subject: 'Separate note', replies: [{ from: m.to, at, snippet: 'Saw your note, let\'s talk at the event.' }] });
    else data.mail.threads.push({ thread_id: m.threadId, to: m.to, subject: m.subject, replies: [{ from: r.from || m.to, at, snippet: r.snippet, ...(r.auto ? { auto: true } : {}) }] });
    const c = contacts.find((x) => lower(x.email) === lower(m.to));
    P.per.replyKinds[lower(m.to)] = { kind, at, id: c?.id };
    if (c && kind !== 'ooo') P.per.replied.add(c.id);
  });
  writeFileSync(P.H.standin, JSON.stringify(data));
}

// Replies on LinkedIn or in the event app, one per kind, to the first people written to there.
function applyInboxKinds(P, kinds, where) {
  const f = `${P.H.standin}.${where === 'linkedin' ? 'li' : 'app'}-sent.json`;
  const sent = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
  const data = JSON.parse(readFileSync(P.H.standin, 'utf8'));
  P.per.inboxKinds ||= {}; P.per.replied ||= new Set();
  const contacts = JSON.parse(readFileSync(join(P.H.HOME, 'events', P.per.slug, 'derived', 'contacts.json'), 'utf8'));
  const firsts = [...new Map(sent.map((m) => [lower(m.to), m])).values()];
  kinds.forEach((kind, i) => {
    const m = firsts[i]; if (!m) return;
    const r = REPLY_TEXT[kind](m);
    const at = new Date(Date.parse(m.at) + 3600e3).toISOString();
    const c = contacts.find((x) => lower(x.name) === lower(m.to) && (!m.company || lower(x.company) === lower(m.company)));
    if (where === 'linkedin') { const person = (data.linkedin?.people || []).find((x) => lower(x.name) === lower(m.to)); (data.linkedin.inbox ||= []).push({ slug: person?.slug || m.to, text: r.snippet, at }); }
    else (data.app.inbox ||= []).push({ pid: m.pid, text: r.snippet, at });
    P.per.inboxKinds[`${where}:${lower(m.to)}`] = { kind, at, id: c?.id, text: r.snippet, where };
    if (c && kind !== 'ooo') P.per.replied.add(c.id);
  });
  writeFileSync(P.H.standin, JSON.stringify(data));
}
// Invites the first people emailed accepted, with no reply: the calendar has the meeting, with them in it.
function applyCalendarAccepts(P, n) {
  const sent = existsSync(`${P.H.standin}.sent.json`) ? JSON.parse(readFileSync(`${P.H.standin}.sent.json`, 'utf8')) : [];
  const data = JSON.parse(readFileSync(P.H.standin, 'utf8'));
  const slots = JSON.parse(readFileSync(join(P.H.HOME, 'events', P.per.slug, 'slots.json'), 'utf8')).slots || [];
  P.per.calendarAccepts ||= {};
  const firsts = [...new Map(sent.map((m) => [lower(m.to), m])).values()].slice(0, n);
  data.calendar ||= { time_zone: 'America/New_York', events: [] };
  firsts.forEach((m, i) => { const sl = slots[slots.length - 1 - i]; if (!sl) return; (data.calendar.events ||= []).push({ summary: `Meeting with ${m.to}`, start: sl.start, end: sl.end, attendees: [m.to] }); P.per.calendarAccepts[lower(m.to)] = sl.start; });
  writeFileSync(P.H.standin, JSON.stringify(data));
}

// Replies in the event app's inbox: nothing floorboss can read; the persona knows and says so when asked.
function applyAppReplies(P, n) {
  const f = `${P.H.standin}.app-sent.json`;
  const sent = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
  const data = JSON.parse(readFileSync(P.H.standin, 'utf8'));
  P.per.replied ||= new Set();
  const contacts = JSON.parse(readFileSync(join(P.H.HOME, 'events', P.per.slug, 'derived', 'contacts.json'), 'utf8'));
  for (const m of sent.slice(0, n)) {
    (data.app.inbox ||= []).push({ pid: m.pid, text: 'Happy to meet, Thursday works', at: new Date(Date.parse(m.at) + 36e5).toISOString() });
    const c = contacts.find((x) => lower(x.name) === lower(m.to) && lower(x.company) === lower(m.company));
    if (c) P.per.replied.add(c.id);
  }
  writeFileSync(P.H.standin, JSON.stringify(data));
}
