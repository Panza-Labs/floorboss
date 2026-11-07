// Tracking across channels: CRM tasks for event-app and LinkedIn messages, their outcomes, calendar bookings,
// and the tracker page. Runs against the stand-in CRM through the real CLIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, idOf, draftApprove, ROOT, NOW } from './fixtures/harness.mjs';
process.env.FLOORBOSS_NOW = NOW;
import { check } from '../hooks/guard.mjs';
import { readOutcome } from '../skills/event-outreach/scripts/tracking.mjs';

const call = (env, server, tool, args) => JSON.parse(execFileSync('node', [join(ROOT, 'examples/standins/call.mjs'), server, 'call', tool, JSON.stringify(args)], { env: { ...process.env, ...env }, encoding: 'utf8' }));

test('outcome notes: stop, replied, booked with an offered time, and anything else asks', () => {
  const labels = [{ id: 's1', label: 'Tue 10 Nov, 10:00 Rotterdam time' }, { id: 's2', label: 'Wed 11 Nov, 14:00 Rotterdam time' }];
  assert.equal(readOutcome('stop please', labels).kind, 'stop');
  assert.equal(readOutcome('replied, keen', labels).kind, 'replied');
  assert.deepEqual(readOutcome('booked Wed 11th 14:00', labels), { kind: 'booked', slot: 's2' });
  assert.equal(readOutcome('booked Thu 9:00', labels).kind, 'unclear');
  assert.equal(readOutcome('said maybe later', labels).kind, 'unclear');
});

test('event-app messages become CRM tasks; done tasks and their outcomes come back; the calendar books', () => {
  // Three people without email (event-app messages), one LinkedIn, one email.
  const H = setup({ attendees: 'Name,Title,Company,Email,Profile URL\nAna Berg,COO,Acme,,\nBo Li,VP Ops,Globex,,\nCy Ng,VP Ops,Initech,,https://www.linkedin.com/in/cyng-example\nDi Ho,COO,Hooli,di@hooli.test,\n', event: { app_name: 'Brella' } });
  triage(H);
  draftApprove(H);
  const tl = cli(H, 'crm-triage', ['load', '--event', H.slug]) && cli(H, 'event-outreach', ['task-list', '--event', H.slug]);
  assert.equal(tl.by_kind.send, 3, JSON.stringify(tl));
  const items = JSON.parse(readFileSync(tl.file, 'utf8'));
  const cy = items.find((x) => x.id === idOf(H, 'Cy Ng'));
  assert.match(cy.title, /in LinkedIn/);
  assert.match(items.find((x) => x.id === idOf(H, 'Ana Berg')).title, /in Brella/);
  // The guard lets through exactly these tasks, nothing else.
  const config = { connectors: { 'crm.create_task': { server: 'crm-a', tool: 'create_task', reading: 'the id it returns', tool_hash: 'f'.repeat(64), test_draft: { draft_id: 't-test', user_confirmed: true }, args: { properties: { hs_task_subject: '{title}', hs_task_body: '{body}', hs_timestamp: '{due}', hs_task_status: 'NOT_STARTED' }, associations: [{ to: { id: '{contact_ref}' } }] } } } };
  const asCall = (it, o = {}) => ({ tool_name: 'mcp__crm-a__create_task', tool_input: { properties: { hs_task_subject: it.title, hs_task_body: it.body, hs_timestamp: it.due, hs_task_status: 'NOT_STARTED', ...o }, associations: [{ to: { id: it.contact_ref || '' } }] } });
  assert.equal(check(asCall(items[0]), { config, stageItems: [], taskItems: items }), null);
  assert.match(check(asCall({ ...items[0], body: 'Wire the money' }), { config, stageItems: [], taskItems: items }), /isn't one floorboss listed/);
  assert.match(check(asCall(items[0], { hubspot_owner_id: '9001' }), { config, stageItems: [], taskItems: items }), /isn't in floorboss's crm.create_task recipe/);
  // Create them in the stand-in CRM, as the recipe would.
  const env = { STANDIN_DATA: join(H.dir, 'standin.json') };
  writeFileSync(env.STANDIN_DATA, JSON.stringify({ crm: { records: [] } }));
  const receipts = items.map((it) => ({ key: it.key, task_id: call(env, 'crm-a', 'create_task', asCall(it).tool_input).id }));
  writeFileSync(join(H.dir, 'r.json'), JSON.stringify({ tasks: receipts }));
  assert.equal(cli(H, 'event-outreach', ['tasks-created', '--event', H.slug, '--file', join(H.dir, 'r.json')]).saved, items.length);
  assert.equal(cli(H, 'event-outreach', ['task-list', '--event', H.slug]).by_kind.send, undefined, 'never created twice');
  // The user does them in the CRM: Ana sent and booked, Bo sent and said stop, Cy sent with an odd note.
  const tasksFile = `${env.STANDIN_DATA}.tasks.json`;
  const all = JSON.parse(readFileSync(tasksFile, 'utf8'));
  const shortlist = JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'shortlist.json'), 'utf8'));
  const slotOf = (id) => JSON.parse(readFileSync(join(H.dir, 'slots.json'), 'utf8')).slots.find((s) => s.id === shortlist.assignments[id][0]);
  const anaSlot = slotOf(idOf(H, 'Ana Berg'));
  const label = new Date(anaSlot.start).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const outcomeFor = { [idOf(H, 'Ana Berg')]: `booked ${label}`, [idOf(H, 'Bo Li')]: 'stop', [idOf(H, 'Cy Ng')]: 'he sent a gif' };
  const keyToId = Object.fromEntries(items.map((it) => [it.key, it.id]));
  for (const t of all) { const r = receipts.find((x) => x.task_id === t.id); t.status = 'COMPLETED'; t.completed_at = '2026-10-12T09:00:00Z'; t.outcome = outcomeFor[keyToId[r.key]] || ''; }
  writeFileSync(tasksFile, JSON.stringify(all));
  const read = call(env, 'crm-a', 'search_tasks', { ids: receipts.map((r) => r.task_id) }).results.map((t) => ({ task_id: t.id, status: t.properties.hs_task_status === 'COMPLETED' ? 'done' : 'open', completed_at: t.properties.hs_task_completion_date, outcome: t.properties.hs_task_outcome }));
  writeFileSync(join(H.dir, 's.json'), JSON.stringify({ tasks: read }));
  const st = cli(H, 'event-outreach', ['task-status', '--event', H.slug, '--file', join(H.dir, 's.json')]);
  assert.ok(!st.errors, JSON.stringify(st));
  assert.equal(st.sent.length, 3);
  assert.deepEqual(st.stopped, [idOf(H, 'Bo Li')]);
  assert.deepEqual(st.booked, [idOf(H, 'Ana Berg')]);
  assert.deepEqual(st.unclear, [idOf(H, 'Cy Ng')]);
  // The unclear one and Bo's opt-out come back as tasks for the user.
  const next = cli(H, 'event-outreach', ['task-list', '--event', H.slug]);
  assert.ok(next.by_kind.review >= 1 && !next.by_kind.send, JSON.stringify(next));
  // Di (email) books in the calendar.
  const di = idOf(H, 'Di Ho');
  const diSlot = slotOf(di);
  writeFileSync(join(H.dir, 'ev.json'), JSON.stringify({ events: [{ start: diSlot.start, end: diSlot.end, summary: 'Coffee', self_response: 'accepted', attendees: [{ email: 'di@hooli.test', response: 'accepted' }], status: 'confirmed' }] }));
  const cb = cli(H, 'event-outreach', ['calendar-bookings', '--event', H.slug, '--file', join(H.dir, 'ev.json')]);
  assert.deepEqual(cb.booked.map((b) => b.id), [di]);
  // The tracker shows it all.
  const tr = cli(H, 'event-outreach', ['tracker', '--event', H.slug]);
  const html = readFileSync(tr.tracker, 'utf8');
  assert.ok(tr.counts.Booked === 2 && tr.counts.Stopped === 1, JSON.stringify(tr.counts));
  assert.match(html, /Ana Berg/);
  assert.match(html, /Content-Security-Policy/);
});

test('stops in any phrasing, negations ask, long notes read whole, no double bookings, calendar only inside the event', async () => {
  const L = [{ id: 's1', label: 'Tue 10 Nov, 10:00 Rotterdam time' }];
  for (const t of ['replied: please never message me again', 'yes, unsubscribed me', 'replied - leave me alone', 'take me off your list']) assert.equal(readOutcome(t, L).kind, 'stop', t);
  for (const t of ['no reply yet', "didn't reply", 'not booked - Tue 10, 10:00 didn\'t work', 'booked?']) assert.equal(readOutcome(t, L).kind, 'unclear', t);
  const { validateTaskStatus } = await import('../skills/connectors/scripts/tasks.mjs');
  const long = `${'We had a long chat about routing and pallets and the new hub. '.repeat(4)}Then he said please stop messaging me.`;
  const v = validateTaskStatus({ tasks: [{ task_id: 't1', status: 'done', completed_at: null, outcome: long }] });
  assert.equal(readOutcome(v.tasks[0].outcome, L).kind, 'stop');
  const { bookingsFrom } = await import('../skills/event-outreach/scripts/tracking.mjs');
  const people = [{ id: 'c1', emails: ['di@x.test'] }];
  const slots = [{ id: 's1', start: '2026-11-10T09:00:00.000Z' }];
  const win = ['2026-11-09T10:00:00.000Z', '2026-11-13T14:00:00.000Z'];
  assert.deepEqual(bookingsFrom([{ start: '2026-09-01T09:00:00Z', attendees: ['di@x.test'], status: 'confirmed' }], people, { slots, window: win }), []);
  assert.deepEqual(bookingsFrom([{ start: '2026-11-10T09:00:00Z', attendees: ['di@x.test'], status: 'tentative' }], people, { slots, window: win }), []);
  assert.equal(bookingsFrom([{ start: '2026-11-10T09:00:00Z', attendees: ['di@x.test'], responses: { 'di@x.test': 'accepted' }, self_response: 'accepted', status: 'confirmed' }], people, { slots, window: win })[0].slot, 's1', 'a floorboss time, offered or not');
  // An invite anyone sends, listing the contact, books nothing: both sides have to have accepted.
  const unclear = [];
  assert.deepEqual(bookingsFrom([{ start: '2026-11-10T09:00:00Z', attendees: ['di@x.test'], status: 'confirmed' }], people, { slots, window: win, unclear }), []);
  assert.equal(unclear.length, 1);
  assert.deepEqual(bookingsFrom([{ start: '2026-11-10T09:00:00Z', attendees: ['di@x.test'], responses: { 'di@x.test': 'accepted' }, organizer: 'stranger@evil.test', status: 'confirmed' }], people, { slots, window: win }), [], 'they accepted, but the user never did');
  assert.equal(bookingsFrom([{ start: '2026-11-10T09:00:00Z', attendees: ['di@x.test'], responses: { 'di@x.test': 'accepted' }, organizer: 'me@lanecraft.example', status: 'confirmed' }], people, { slots, window: win, mine: (e) => e.endsWith('@lanecraft.example') }).length, 1, 'the user organised it and they accepted');
});

test('the guard wants one contact, the listed one, on the recipe\'s own server; tasks-created refuses blocked and repeated tasks', () => {
  const config = { connectors: { 'crm.create_task': { server: 'crm-a', tool: 'create_task', reading: 'the id it returns', tool_hash: 'f'.repeat(64), test_draft: { draft_id: 't-test', user_confirmed: true }, args: { properties: { hs_task_subject: '{title}', hs_task_body: '{body}', hs_timestamp: '{due}' }, associations: [{ to: { id: '{contact_ref}' } }] } } } };
  const item = { key: 'c1:1', title: 'Message Ana', body: 'Hi', due: '2026-10-12', contact_ref: null, listed_at: NOW };
  const mk = (server, assoc) => ({ tool_name: `mcp__${server}__create_task`, tool_input: { properties: { hs_task_subject: 'Message Ana', hs_task_body: 'Hi', hs_timestamp: '2026-10-12' }, associations: assoc } });
  assert.equal(check(mk('crm-a', [{ to: { id: '' } }]), { config, stageItems: [], taskItems: [item] }), null);
  assert.ok(check(mk('crm-a', [{ to: { id: '999-CEO' } }]), { config, stageItems: [], taskItems: [item] }));
  assert.ok(check(mk('crm-a', [{ to: { id: '' } }, { to: { id: '2' } }]), { config, stageItems: [], taskItems: [item] }));
  assert.equal(check(mk('evil-crm-a', [{ to: { id: '' } }]), { config, stageItems: [], taskItems: [item] }), null, 'another server isn\'t the recipe: none of floorboss\'s business outside a run');
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\nBo Li,VP Ops,Globex,\n' });
  triage(H);
  draftApprove(H);
  const items = JSON.parse(readFileSync(cli(H, 'event-outreach', ['task-list', '--event', H.slug]).file, 'utf8'));
  // Bo is removed after the list was made.
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', `remove ${idOf(H, 'Bo Li')}`]);
  writeFileSync(join(H.dir, 'r.json'), JSON.stringify({ tasks: items.map((it, i) => ({ key: it.key, task_id: `T${i}` })) }));
  const r = cli(H, 'event-outreach', ['tasks-created', '--event', H.slug, '--file', join(H.dir, 'r.json')]);
  assert.equal(r.saved, 1);
  assert.equal(r.refused.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(H.dir, 'task-list.json'), 'utf8')), [], 'recorded tasks leave the list');
});

test('setup\'s test call passes the guard once; app bookings get a confirmation task; channel by person; "and" in gate names', async () => {
  const { testPasses } = await import('../hooks/guard.mjs');
  const pending = { task: 'stage_draft', server: 'mail-a', tool: 'create_draft', to: 'bram@stackwise.test', at: NOW };
  const now = Date.parse(NOW);
  assert.ok(testPasses({ tool_name: 'mcp__mail-a__create_draft', tool_input: { to: 'bram@stackwise.test', subject: 'test', body: 'test' } }, pending, now));
  assert.ok(!testPasses({ tool_name: 'mcp__mail-a__create_draft', tool_input: { to: 'someone@else.test', subject: 'test', body: 'test' } }, pending, now));
  assert.ok(!testPasses({ tool_name: 'mcp__mail-a__send_message', tool_input: { to: 'bram@stackwise.test' } }, { ...pending, tool: 'send_message' }, now));
  assert.ok(!testPasses({ tool_name: 'mcp__mail-a__create_draft', tool_input: { to: 'bram@stackwise.test' } }, pending, now + 20 * 60000));
  const { parseGate, namesToIds } = await import('../lib/gate.mjs');
  assert.deepEqual(parseGate(namesToIds('approve Ana and Bo', [{ id: 'c001', name: 'Ana Berg' }, { id: 'c002', name: 'Bo Li' }]), { kind: 'draft' }).actions[0].ids, ['c001', 'c002']);
  // Joris has an email but the user wants him in Brella; he books via the task, and his confirmation is a task.
  const H = setup({ attendees: 'Name,Title,Company,Email\nJoris Vos,COO,Acme,joris@acme.test\n', event: { app_name: 'Brella' } });
  triage(H);
  const joris = idOf(H, 'Joris Vos');
  cli(H, 'crm-triage', ['channel', '--event', H.slug, '--id', joris, '--to', 'app']);
  draftApprove(H);
  const items = JSON.parse(readFileSync(cli(H, 'event-outreach', ['task-list', '--event', H.slug]).file, 'utf8'));
  assert.match(items[0].title, /Message Joris Vos \(Acme\) in Brella/);
  writeFileSync(join(H.dir, 'r.json'), JSON.stringify({ tasks: [{ key: items[0].key, task_id: 'T1' }] }));
  cli(H, 'event-outreach', ['tasks-created', '--event', H.slug, '--file', join(H.dir, 'r.json')]);
  const slot = JSON.parse(readFileSync(join(H.dir, 'slots.json'), 'utf8')).slots.find((s) => s.id === JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'shortlist.json'), 'utf8')).assignments[joris][0]);
  const when = new Date(slot.start).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  writeFileSync(join(H.dir, 's.json'), JSON.stringify({ tasks: [{ task_id: 'T1', status: 'done', completed_at: NOW, outcome: `booked ${when}` }] }));
  assert.deepEqual(cli(H, 'event-outreach', ['task-status', '--event', H.slug, '--file', join(H.dir, 's.json')]).booked, [joris]);
  draftApprove(H);
  const next = JSON.parse(readFileSync(cli(H, 'event-outreach', ['task-list', '--event', H.slug]).file, 'utf8'));
  assert.ok(next.some((x) => x.id === joris && /Confirm the meeting/.test(x.title)), JSON.stringify(next.map((x) => x.title)));
});

test('people the mailbox already writes to are held before first drafts', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nSanne Dijk,COO,Acme,sanne@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n' });
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const list = cli(H, 'crm-triage', ['mail-list', '--event', H.slug]);
  assert.equal(list.addresses, 2);
  const env = { STANDIN_DATA: join(H.dir, 'standin.json') };
  writeFileSync(env.STANDIN_DATA, JSON.stringify({ mail: { history: [{ with: 'sanne@acme.test', last_at: '2026-10-02T10:00:00Z', subject: 'Meeting at the event' }] } }));
  const people = JSON.parse(readFileSync(list.file, 'utf8')).map((email) => { const r = call(env, 'mail-a', 'search_threads', { query: email }); return { email, threads: r.resultSizeEstimate, last_at: r.latest }; });
  writeFileSync(join(H.dir, 'mh.json'), JSON.stringify({ people }));
  cli(H, 'crm-triage', ['load', '--event', H.slug, '--mail-history', join(H.dir, 'mh.json')]);
  const pre = JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'triage.json'), 'utf8')).pre;
  assert.equal(pre[idOf(H, 'Sanne Dijk')].group, 'in_touch');
  assert.match(pre[idOf(H, 'Sanne Dijk')].reason, /in your mailbox already \(last message 2026-10-02\)/);
  assert.equal(pre[idOf(H, 'Bo Li')].group, 'open');
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.equal(JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'triage.json'), 'utf8')).pre[idOf(H, 'Sanne Dijk')].group, 'in_touch', 'kept for later loads');
});

test('a cold email they never answered doesn\'t hold someone; a reply does', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nRachel Okafor,CRO,Merriton,rachel@merriton.test\nDaniel Herrera,COO,Merriton,daniel@merriton.test\n' });
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  writeFileSync(join(H.dir, 'mh.json'), JSON.stringify({ people: [{ email: 'rachel@merriton.test', threads: 1, they_replied: false, last_at: '2026-09-02T10:00:00Z' }, { email: 'daniel@merriton.test', threads: 4, they_replied: true, last_at: '2026-10-08T10:00:00Z' }] }));
  cli(H, 'crm-triage', ['load', '--event', H.slug, '--mail-history', join(H.dir, 'mh.json')]);
  const pre = JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'triage.json'), 'utf8')).pre;
  assert.equal(pre[idOf(H, 'Rachel Okafor')].group, 'open');
  assert.match(pre[idOf(H, 'Rachel Okafor')].mailbox_note, /didn't reply/);
  assert.equal(pre[idOf(H, 'Daniel Herrera')].group, 'in_touch');
});
