// The confirmed findings of the scoped security audit (run-2, connector answers), each as the attack that worked
// then and must fail now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, idOf, draftApprove } from './fixtures/harness.mjs';
import { readLedger, fold, contactable, append } from '../lib/ledger.mjs';
import { bookingsFrom } from '../skills/event-outreach/scripts/tracking.mjs';

const st = (H) => fold(readLedger(join(H.dir, 'ledger.jsonl')).entries);
const w = (H, n, o) => {
  const f = join(H.dir, n);
  writeFileSync(f, JSON.stringify(o));
  return f;
};
const APP = 'Name,Title,Company,Email,Profile URL\nAna Berg,COO,Acme,,\nBo Li,VP Ops,Globex,,\n';

test('R2-C1: a cancelled calendar event someone else organised frees nothing and is asked about', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  triage(H);
  const ana = idOf(H, 'Ana Berg');
  cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', w(H, 'b.json', { items: [{ who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00' }] })]);
  assert.ok(st(H).people[ana].booked);
  const ev = { events: [{ start: '2026-11-10T09:00:00Z', end: '2026-11-10T09:30:00Z', summary: 'x', status: 'cancelled', organizer: 'stranger@evil.test', attendees: ['ana@acme.test'] }] };
  cli(H, 'event-outreach', ['calendar-bookings', '--event', H.slug, '--file', w(H, 'c.json', ev)]);
  const s = st(H).people[ana];
  assert.ok(s.booked, 'still booked');
  assert.ok(s.unclear.some((u) => /not you or them/.test(u.why)), 'and the user is asked');
  assert.equal(contactable(st(H), ana, 'message'), 'they booked');
  // Asked once, not on every calendar read, and not again after the user answered.
  cli(H, 'event-outreach', ['calendar-bookings', '--event', H.slug, '--file', w(H, 'c2.json', ev)]);
  assert.equal(st(H).people[ana].unclear.length, 1);
  cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', w(H, 'b2.json', { items: [{ who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00', said: 'still on' }] })]);
  const answered = st(H).people[ana].unclear.length;
  cli(H, 'event-outreach', ['calendar-bookings', '--event', H.slug, '--file', w(H, 'c3.json', ev)]);
  assert.equal(st(H).people[ana].unclear.length, answered, 'an answered question is not raised again');
  // Her own cancellation, but older than the booking: about an earlier meeting, asked, nothing freed.
  const old = { events: [{ ...ev.events[0], organizer: 'ana@acme.test', updated: '2026-10-01T00:00:00Z' }] };
  cli(H, 'event-outreach', ['calendar-bookings', '--event', H.slug, '--file', w(H, 'c4.json', old)]);
  assert.ok(st(H).people[ana].booked, 'a stale cancellation frees nothing');
  assert.ok(st(H).people[ana].unclear.some((u) => /before this booking was made/.test(u.why)));
  // Her own current cancellation frees it.
  const now = { events: [{ ...ev.events[0], organizer: 'ana@acme.test', start: '2026-11-10T09:00:00Z' }] };
  cli(H, 'event-outreach', ['calendar-bookings', '--event', H.slug, '--file', w(H, 'c5.json', now)]);
  assert.equal(st(H).people[ana].booked, null);
});

test("R2-NV: the user's own declined answer wins over a colleague's acceptance", () => {
  const mine = (e) => /@lanecraft\.example$/.test(e);
  const who = [{ id: 'c001', emails: ['ana@acme.test'] }];
  const ev = (o) => ({ start: '2026-11-10T10:00:00Z', end: '2026-11-10T10:30:00Z', status: 'confirmed', attendees: ['ana@acme.test', 'me@lanecraft.example', 'pat@lanecraft.example'], responses: { 'ana@acme.test': 'accepted', 'pat@lanecraft.example': 'accepted' }, organizer: 'stranger@evil.test', ...o });
  assert.equal(bookingsFrom([ev({ self_response: 'declined' })], who, { mine }).length, 0, 'declined by the user books nothing');
  assert.equal(bookingsFrom([ev({ self_response: 'declined', organizer: 'boss@lanecraft.example' })], who, { mine }).length, 0);
  assert.equal(bookingsFrom([ev({ self_response: 'accepted' })], who, { mine }).length, 1, 'accepted books');
  assert.equal(bookingsFrom([ev({})], who, { mine }).length, 1, 'with no answer of the user given, an own address that accepted still counts');
});

test('R2-C2: a done review task settles only the question it asked', () => {
  const H = setup({ attendees: APP.split('\n').slice(0, 2).join('\n') + '\n', event: { app_name: 'Brella' } });
  triage(H); draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const items = JSON.parse(readFileSync(cli(H, 'event-outreach', ['task-list', '--event', H.slug]).file, 'utf8'));
  cli(H, 'event-outreach', ['tasks-created', '--event', H.slug, '--file', w(H, 'r1.json', { tasks: items.map((i, n) => ({ key: i.key, task_id: `T-send-${n}` })) })]);
  cli(H, 'event-outreach', ['task-status', '--event', H.slug, '--file', w(H, 's1.json', { tasks: [{ task_id: 'T-send-0', status: 'done', completed_at: '2026-10-12T07:00:00Z', outcome: 'he sent a gif' }] })]);
  const items2 = JSON.parse(readFileSync(cli(H, 'event-outreach', ['task-list', '--event', H.slug]).file, 'utf8'));
  const rev = items2.find((i) => i.kind === 'review' && i.id === ana);
  assert.ok(rev, 'a review task for the unclear outcome');
  cli(H, 'event-outreach', ['tasks-created', '--event', H.slug, '--file', w(H, 'r2.json', { tasks: [{ key: rev.key, task_id: 'T-rev-1' }] })]);
  append(join(H.dir, 'ledger.jsonl'), { type: 'outcome_unclear', id: ana, key: 'ext-9', why: 'someone (no sender shown) wrote to cancel the meeting with them: is it off, or still on?', source: 'mailbox', ext: 'ext-9', who: 'mailbox' });
  assert.equal(st(H).people[ana].unclear.length, 2);
  cli(H, 'event-outreach', ['task-status', '--event', H.slug, '--file', w(H, 's2.json', { tasks: [{ task_id: 'T-rev-1', status: 'done', completed_at: null, outcome: null }] })]);
  const left = st(H).people[ana].unclear;
  assert.deepEqual(left.map((u) => u.key), ['ext-9'], 'the later, unrelated question stays open');
  // The question still open keeps its one review task: no second task for it after the first was answered.
  const items3 = JSON.parse(readFileSync(cli(H, 'event-outreach', ['task-list', '--event', H.slug]).file, 'utf8'));
  const revs = items3.filter((i) => i.kind === 'review' && i.id === ana).map((i) => i.key);
  assert.equal(new Set(revs).size, revs.length);
  assert.ok(revs.every((k) => /unclear-ext-9$/.test(k)), JSON.stringify(revs));
});

test('R2-C3: one CRM task id belongs to one task', () => {
  const H = setup({ attendees: APP, event: { app_name: 'Brella' } });
  triage(H); draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const items = JSON.parse(readFileSync(cli(H, 'event-outreach', ['task-list', '--event', H.slug]).file, 'utf8'));
  assert.ok(items.length >= 2);
  const dup = cli(H, 'event-outreach', ['tasks-created', '--event', H.slug, '--file', w(H, 'r.json', { tasks: items.map((i) => ({ key: i.key, task_id: 'T1' })) })]);
  assert.equal(dup.saved, 0);
  assert.match(JSON.stringify(dup.errors), /already recorded for/);
  // Distinct ids go in, and a later receipt reusing one is refused too.
  const ok = cli(H, 'event-outreach', ['tasks-created', '--event', H.slug, '--file', w(H, 'r2.json', { tasks: [{ key: items[0].key, task_id: 'T1' }] })]);
  assert.equal(ok.saved, 1);
  const later = JSON.parse(readFileSync(cli(H, 'event-outreach', ['task-list', '--event', H.slug]).file, 'utf8')).find((i) => i.key === items[1].key);
  if (later) {
    const reuse = cli(H, 'event-outreach', ['tasks-created', '--event', H.slug, '--file', w(H, 'r3.json', { tasks: [{ key: later.key, task_id: 'T1' }] })]);
    assert.equal(reuse.saved, 0);
  }
  // A done date ahead of now counts as now (follow-ups aren't pushed out).
  cli(H, 'event-outreach', ['task-status', '--event', H.slug, '--file', w(H, 's.json', { tasks: [{ task_id: 'T1', status: 'done', completed_at: '2027-01-01T00:00:00Z', outcome: null }] })]);
  const sent = readLedger(join(H.dir, 'ledger.jsonl')).entries.filter((e) => e.type === 'sent' && e.id === items[0].id).pop();
  assert.ok(sent && sent.date < '2027-01-01', `sent on ${sent?.date}`);
  assert.equal(st(H).people[ana].stopped, false);
  // One task listed twice in a read is refused, not applied twice.
  const twice = cli(H, 'event-outreach', ['task-status', '--event', H.slug, '--file', w(H, 's2.json', { tasks: [{ task_id: 'T1', status: 'done' }, { task_id: 'T1', status: 'done' }] })]);
  assert.equal(twice.applied, false);
});

test('R2-extra: a cancellation email older than the booking frees nothing (the sync stale check now gets booked_at)', async () => {
  const { legacyState } = await import('../lib/ledger.mjs');
  const { planSync } = await import('../skills/event-outreach/scripts/sync.mjs');
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  triage(H);
  const ana = idOf(H, 'Ana Berg');
  cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', w(H, 'b.json', { items: [{ who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00' }] })]);
  const state = legacyState(st(H));
  assert.ok(state[ana].booked_at, 'the state sync reads carries when the booking was recorded');
  const items = [{ ext: 'm-old', kind: 'message', direction: 'in', at: '2026-10-05T09:00:00Z', subject: 'Re: x', from: 'ana@acme.test', intent: 'cancelled', auto: false }];
  const plan = planSync([{ id: ana, items }], { state, since: { [ana]: '2026-10-01T00:00:00Z' }, source: 'mailbox', now: new Date('2026-10-12T09:00:00Z'), byId: { [ana]: { name: 'Ana Berg', company: 'Acme', email: 'ana@acme.test' } } });
  const types = plan.entries.map((e) => e.type);
  assert.ok(!types.includes('unbooked'), JSON.stringify(types));
  assert.ok(types.includes('outcome_unclear'));
});

test('R2-C1b: a decline older than the booking frees nothing', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  triage(H);
  const ana = idOf(H, 'Ana Berg');
  cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', w(H, 'b.json', { items: [{ who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00' }] })]);
  const ev = { events: [{ start: '2026-11-10T09:00:00Z', end: '2026-11-10T09:30:00Z', summary: 'x', status: 'confirmed', organizer_is_you: true, attendees: [{ email: 'ana@acme.test', response: 'declined' }], updated: '2026-09-01T00:00:00Z' }] };
  cli(H, 'event-outreach', ['calendar-bookings', '--event', H.slug, '--file', w(H, 'c.json', ev)]);
  assert.ok(st(H).people[ana].booked, 'still booked');
  assert.ok(st(H).people[ana].unclear.some((u) => /before this booking was made/.test(u.why)));
});

test('R2-D1: a task receipt is taken only for a task the guard let through', () => {
  const H = setup({ attendees: APP, event: { app_name: 'Brella' } });
  H.realTaskMarks = true;
  triage(H); draftApprove(H);
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const items = JSON.parse(readFileSync(cli(H, 'event-outreach', ['task-list', '--event', H.slug]).file, 'utf8'));
  const r = cli(H, 'event-outreach', ['tasks-created', '--event', H.slug, '--file', w(H, 'r.json', { tasks: [{ key: items[0].key, task_id: 'T9' }] })]);
  assert.equal(r.saved, 0);
  assert.match(JSON.stringify(r.errors), /no record of this task being created through the guard/);
});

test('R2-D2: an open task is no reply check', () => {
  const H = setup({ attendees: APP, event: { app_name: 'Brella' } });
  triage(H); draftApprove(H);
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const items = JSON.parse(readFileSync(cli(H, 'event-outreach', ['task-list', '--event', H.slug]).file, 'utf8'));
  cli(H, 'event-outreach', ['tasks-created', '--event', H.slug, '--file', w(H, 'r.json', { tasks: items.map((i, n) => ({ key: i.key, task_id: `T${n}` })) })]);
  cli(H, 'event-outreach', ['task-status', '--event', H.slug, '--file', w(H, 's.json', { tasks: [{ task_id: 'T0', status: 'open' }] })]);
  const checks = readLedger(join(H.dir, 'ledger.jsonl')).entries.filter((e) => e.type === 'reply_checked' && e.source === 'tasks');
  assert.equal(checks.length, 0);
});

for (const [label, id, late] of [['R2-D3: the guard marks a listed CRM task once the call ran, and only then is its receipt taken', null, 0], ['R2-D4: the post hook marks the task the pre hook matched for that call, even when the yes came 40 minutes later', 'tu-task-1', 40]])
test(label, async () => {
  const { spawnSync } = await import('node:child_process');
  const { ROOT, NOW } = await import('./fixtures/harness.mjs');
  const H = setup({ attendees: APP, event: { app_name: 'Brella' } });
  H.realTaskMarks = true;
  const config = { connectors: { 'crm.create_task': { server: 'crm-a', tool: 'create_task', reading: 'the id it returns', tool_hash: 'f'.repeat(64), test_draft: { draft_id: 't-test', user_confirmed: true }, args: { properties: { hs_task_subject: '{title}', hs_task_body: '{body}', hs_timestamp: '{due}' }, associations: [{ to: { id: '{contact_ref}' } }] } } } };
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify(config));
  triage(H); draftApprove(H);
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const items = JSON.parse(readFileSync(cli(H, 'event-outreach', ['task-list', '--event', H.slug]).file, 'utf8'));
  const it = items[0];
  const input = { tool_name: 'mcp__crm-a__create_task', tool_input: { properties: { hs_task_subject: it.title, hs_task_body: it.body, hs_timestamp: it.due }, associations: [{ to: { id: it.contact_ref || '' } }] }, session_id: 's1', ...(id ? { tool_use_id: id } : {}) };
  const hook = (inp, args = [], now = NOW) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs'), ...args], { input: JSON.stringify(inp), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
  const pre = hook(input);
  assert.equal(pre.status, 0, pre.stderr);
  const receipt = () => cli(H, 'event-outreach', ['tasks-created', '--event', H.slug, '--file', w(H, 'r.json', { tasks: [{ key: it.key, task_id: 'T42' }] })]);
  assert.equal(receipt().saved, 0, 'asked but not yet run: no receipt');
  hook({ hook_event_name: 'PostToolUse', ...input, tool_response: { id: 'T42' } }, ['post'], new Date(Date.parse(NOW) + late * 60e3).toISOString());
  assert.equal(receipt().saved, 1, 'ran: the receipt is taken');
});
