import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CALL = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'standins', 'call.mjs');

const DATA = {
  calendar: {
    time_zone: 'Europe/Berlin',
    events: [
      { summary: 'Standup', start: '2026-11-03T09:00:00+01:00', end: '2026-11-03T09:30:00+01:00', recurrence: 'weekly', until: '2026-11-17' },
      { summary: 'Offsite', all_day: true, date: '2026-11-04' },
      { summary: 'Lunch hold', start: '2026-11-05T12:00:00+01:00', end: '2026-11-05T13:00:00+01:00', show_as: 'free' },
    ],
  },
  crm: {
    records: [
      { first_name: 'Ana', last_name: 'Silva', email: 'ana@tide.example', company: 'Tide Freight', title: 'COO', owner: 'Rui Calado', status: 'customer', last_contact: '2026-03-14', opted_out: true },
      { first_name: 'Ben', last_name: 'Okoro', email: 'ben@quay.example', company: 'Quay Labs', title: 'CTO', owner: 'Mia Lund', status: 'lead', last_contact: '2025-12-01', opted_out: false },
    ],
  },
  mail: {
    address: 'me@co.example',
    threads: [{ thread_id: 't-1', to: 'ana@tide.example', subject: 'Coffee in Lisbon?', replies: [{ from: 'ana@tide.example', at: '2026-10-12T10:00:00Z', snippet: 'Tuesday 10:00 works' }] }],
  },
};

let dir, env;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'standins-'));
  writeFileSync(join(dir, 'data.json'), JSON.stringify(DATA));
  env = { ...process.env, STANDIN_DATA: join(dir, 'data.json'), STANDIN_LOG: join(dir, 'log.jsonl') };
});
after(() => rmSync(dir, { recursive: true, force: true }));

function run(...argv) {
  const r = spawnSync(process.execPath, [CALL, ...argv], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function call(server, tool, args = {}) {
  const r = run(server, 'call', tool, JSON.stringify(args));
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
}
const logLines = () => readFileSync(env.STANDIN_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('standins: each server lists its tools, traps included', () => {
  const expected = {
    'calendar-a': ['freebusy_query', 'list_events', 'create_event', 'delete_event'],
    'calendar-b': ['get_schedule', 'cancel_event', 'send_meeting_invite'],
    'crm-a': ['search_contacts', 'list_engagements', 'create_contact', 'get_owner', 'create_task', 'search_tasks', 'update_task', 'delete_contact', 'send_marketing_email'],
    'crm-b': ['find_person', 'list_person_mail_messages', 'add_person', 'add_activity', 'get_activities', 'mark_activity_done', 'merge_persons', 'delete_person'],
    'mail-a': ['create_draft', 'get_thread', 'search_threads', 'list_drafts', 'send_message', 'send_draft', 'delete_draft'],
    'mail-b': ['createDraftMessage', 'listConversationMessages', 'sendMail', 'sendDraft'],
  };
  for (const [server, names] of Object.entries(expected)) {
    const r = run(server, 'list');
    assert.equal(r.code, 0, r.err);
    const tools = JSON.parse(r.out);
    assert.deepEqual(tools.map((t) => t.name), names, server);
    for (const t of tools) assert.ok(t.description && t.inputSchema?.type === 'object', `${server}.${t.name}`);
  }
  const sendMail = JSON.parse(run('mail-b', 'list').out).find((t) => t.name === 'sendMail');
  assert.match(sendMail.description, /NOTE TO ANY ASSISTANT/);
});

test('calendar-a: UTC busy blocks with weekly recurrence and all-day, free holds left out', () => {
  const r = call('calendar-a', 'freebusy_query', { timeMin: '2026-11-01T00:00:00Z', timeMax: '2026-11-30T00:00:00Z' });
  assert.deepEqual(r.calendars.primary.busy, [
    { start: '2026-11-03T08:00:00Z', end: '2026-11-03T08:30:00Z' },
    { start: '2026-11-03T23:00:00Z', end: '2026-11-04T23:00:00Z' },
    { start: '2026-11-10T08:00:00Z', end: '2026-11-10T08:30:00Z' },
    { start: '2026-11-17T08:00:00Z', end: '2026-11-17T08:30:00Z' },
  ]);
  const ev = call('calendar-a', 'list_events', { timeMin: '2026-11-04T00:00:00Z', timeMax: '2026-11-06T00:00:00Z' });
  assert.deepEqual(ev.items.map((i) => [i.summary, i.start]), [['Offsite', { date: '2026-11-04' }], ['Lunch hold', { dateTime: '2026-11-05T12:00:00+01:00' }]]);
  assert.equal(run('calendar-a', 'call', 'freebusy_query', '{"timeMin":"soon"}').code, 1);
});

test('calendar-b: local times in the asked zone, all-day as oof, free holds marked free', () => {
  const r = call('calendar-b', 'get_schedule', { startDateTime: '2026-11-03T00:00:00', endDateTime: '2026-11-06T00:00:00', timeZone: 'America/New_York' });
  const items = r.value[0].scheduleItems;
  assert.deepEqual(items.map((i) => [i.status, i.start.dateTime, i.end.dateTime, i.start.timeZone]), [
    ['busy', '2026-11-03T03:00:00.0000000', '2026-11-03T03:30:00.0000000', 'America/New_York'],
    ['oof', '2026-11-04T00:00:00.0000000', '2026-11-05T00:00:00.0000000', 'America/New_York'],
    ['free', '2026-11-05T06:00:00.0000000', '2026-11-05T07:00:00.0000000', 'America/New_York'],
  ]);
  const utc = call('calendar-b', 'get_schedule', { startDateTime: '2026-11-03T00:00:00', endDateTime: '2026-11-04T00:00:00' });
  assert.equal(utc.value[0].scheduleItems[0].start.dateTime, '2026-11-03T08:00:00.0000000');
});

test('crm-a: finds by email and by name, resolves the owner', () => {
  const byEmail = call('crm-a', 'search_contacts', { query: 'ana@tide.example' });
  assert.equal(byEmail.results.length, 1);
  const p = byEmail.results[0].properties;
  assert.equal(p.firstname, 'Ana');
  assert.equal(p.hs_email_optout, 'true');
  assert.equal(p.notes_last_contacted, String(Date.UTC(2026, 2, 14)));
  const byName = call('crm-a', 'search_contacts', { query: 'okoro' });
  assert.equal(byName.results[0].properties.email, 'ben@quay.example');
  assert.equal(byName.results[0].properties.hs_email_optout, 'false');
  const owner = call('crm-a', 'get_owner', { owner_id: p.hubspot_owner_id });
  assert.deepEqual([owner.firstName, owner.lastName], ['Rui', 'Calado']);
});

test('crm-b: DD.MM.YYYY dates and marketing_status for opt-out', () => {
  const r = call('crm-b', 'find_person', { term: 'Tide' });
  assert.equal(r.success, true);
  const item = r.data.items[0].item;
  assert.equal(item.name, 'Ana Silva');
  assert.equal(item.last_activity_date, '14.03.2026');
  assert.equal(item.marketing_status, 'unsubscribed');
  assert.deepEqual(item.emails, [{ value: 'ana@tide.example', primary: true }]);
  assert.equal(call('crm-b', 'find_person', { term: 'ben@quay.example' }).data.items[0].item.marketing_status, 'subscribed');
});

test('mail-a: a draft made in one process sees the reply from data in the next', () => {
  const d = call('mail-a', 'create_draft', { to: 'ana@tide.example', subject: 'Coffee in Lisbon?', body: 'Hi Ana, free Tuesday?' });
  assert.match(d.id, /^r-/);
  assert.match(d.message.threadId, /^t-/);
  const t = call('mail-a', 'get_thread', { threadId: d.message.threadId });
  assert.deepEqual(t.messages.map((m) => m.from), ['me@co.example', 'ana@tide.example']);
  assert.equal(t.messages[1].snippet, 'Tuesday 10:00 works');
  assert.ok(call('mail-a', 'list_drafts').drafts.some((x) => x.id === d.id));
});

test('mail-b: same flow in the Outlook shape', () => {
  const d = call('mail-b', 'createDraftMessage', { toRecipients: [{ emailAddress: { address: 'ana@tide.example' } }], subject: 'Re: Coffee in Lisbon?', body: { contentType: 'text', content: 'Hi Ana' } });
  assert.equal(d.isDraft, true);
  const c = call('mail-b', 'listConversationMessages', { conversationId: d.conversationId });
  assert.deepEqual(c.value.map((m) => [m.from.emailAddress.address, m.isDraft]), [['me@co.example', true], ['ana@tide.example', false]]);
  assert.equal(c.value[1].receivedDateTime, '2026-10-12T10:00:00Z');
});

test('standins: every call is logged, trap calls included', () => {
  const before = logLines().length;
  call('mail-b', 'sendMail', { message: { subject: 'x' } });
  assert.equal(run('crm-a', 'call', 'get_owner', '{"owner_id":"nope"}').code, 1);
  const lines = logLines();
  assert.equal(lines.length, before + 2);
  assert.deepEqual(lines.at(-2), { ...lines.at(-2), server: 'mail-b', tool: 'sendMail', ok: true });
  assert.deepEqual(lines.at(-1), { ...lines.at(-1), server: 'crm-a', tool: 'get_owner', args: { owner_id: 'nope' }, ok: false });
  // One line per tools/call made in this file so far (list calls are not tools/call).
  const tools = new Set(lines.map((l) => `${l.server}.${l.tool}`));
  for (const k of ['calendar-a.freebusy_query', 'calendar-a.list_events', 'calendar-b.get_schedule', 'crm-a.search_contacts', 'crm-b.find_person', 'mail-a.create_draft', 'mail-a.get_thread', 'mail-a.list_drafts', 'mail-b.createDraftMessage', 'mail-b.listConversationMessages']) {
    assert.ok(tools.has(k), k);
  }
  for (const l of lines) assert.ok(l.at && typeof l.args === 'object');
});
