// 0.1.7: floorboss never sends on LinkedIn. With a CRM task tool, each LinkedIn message the user sends by hand is one
// task on the contact's record, made as soon as its day is known (at approval for the first message), due that day,
// holding the profile link and the text to copy. A follow-up's task is made only while they haven't replied, booked or
// stopped; one that comes after the task was made is told to the user, who is asked to close it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { setup, cli, triage, draftApprove, idOf, NOW } from './fixtures/harness.mjs';
import { append } from '../lib/ledger.mjs';
import { taskItems } from '../skills/event-outreach/scripts/tracking.mjs';

const URL_ = 'https://www.linkedin.com/in/ana';
const card = { kind: 'message', channel: 'paste', id: 'c001', touch: 2, name: 'Ana Berg', company: 'Acme', body: 'Hi Ana, a short note.', profile_url: URL_, where: 'LinkedIn' };
const args = { created: new Set(), event: { name: 'Test Expo', end_date: '2026-11-12' }, byId: {}, crmOf: (id) => ({ crm_id: `R-${id}` }), today: '2026-10-12' };

test('a LinkedIn follow-up whose day is known gets its task now, due on that day, on the contact, with the link and the text', () => {
  const items = taskItems({ ...args, cards: [{ ...card, due_on: '2026-10-19' }] });
  assert.equal(items.length, 1, 'made before its day, so the user has it in the CRM on the day');
  const [it] = items;
  assert.equal(it.due, '2026-10-19');
  assert.equal(it.contact_ref, 'R-c001');
  assert.ok(it.body.startsWith(card.body), 'the text, ready to copy');
  assert.ok(it.body.includes(URL_), 'the profile link');
});

test('a LinkedIn follow-up whose day is not known yet, or that has no day left, gets no task', () => {
  assert.equal(taskItems({ ...args, cards: [{ ...card, due_on: null, due_waits: true }] }).length, 0);
  assert.equal(taskItems({ ...args, cards: [{ ...card, due_on: null }] }).length, 0);
});

test('an event-app note keeps its task on its own day (unchanged)', () => {
  const app = { ...card, where: 'Grip', profile_url: undefined, due_on: '2026-10-19' };
  assert.equal(taskItems({ ...args, event: { ...args.event, app_name: 'Grip' }, cards: [app] }).length, 0);
});

// End to end through the CLIs.
const PEOPLE = 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,,https://www.linkedin.com/in/ana\n';
const mk = () => {
  const H = setup({ attendees: PEOPLE, settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: ['linkedin', 'linkedin'], linkedin_messages: true, crm_log: 'tasks' } });
  triage(H);
  assert.ok(!draftApprove(H).gate.ERROR);
  return H;
};
const later = (d) => new Date(Date.parse(NOW) + d * 86400000).toISOString();
const list = (H, now = NOW) => {
  const r = cli(H, 'event-outreach', ['task-list', '--event', H.slug], now);
  assert.ok(!r.ERROR, r.ERROR);
  return JSON.parse(readFileSync(r.file, 'utf8'));
};
const made = (H, items, now = NOW) => {
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', `tc-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify({ tasks: items.map((i) => ({ key: i.key, task_id: `T-${i.key}` })) }));
  const r = cli(H, 'event-outreach', ['tasks-created', '--event', H.slug, '--file', f], now);
  assert.ok(!r.ERROR && !r.errors, JSON.stringify(r));
};
const add = (H, e, now) => append(join(H.dir, 'ledger.jsonl'), { who: 'user', said: 'noted', ...e }, new Date(now));

test('the first LinkedIn message has its task at approval, due today; the follow-up has its own once message 1 went', () => {
  const H = mk();
  const ana = idOf(H, 'Ana Berg');
  const first = list(H).filter((i) => i.kind === 'send');
  assert.deepEqual(first.map((i) => [i.touch, i.due]), [[1, '2026-10-12']]);
  assert.ok(first[0].body.includes('https://www.linkedin.com/in/ana'));
  made(H, first);
  add(H, { type: 'sent', id: ana, touch: 1, date: '2026-10-12', via: 'crm task', who: 'floorboss' }, NOW);
  const next = list(H, later(1)).filter((i) => i.kind === 'send');
  assert.equal(next.length, 1, 'the follow-up task is made the day after, before its own day');
  assert.equal(next[0].touch, 2);
  assert.ok(next[0].due > '2026-10-13', `due on its own day: ${next[0].due}`);
});

test('no follow-up task for someone who replied; one already made is offered to close when they reply after', () => {
  const H = mk();
  const ana = idOf(H, 'Ana Berg');
  made(H, list(H).filter((i) => i.kind === 'send'));
  add(H, { type: 'sent', id: ana, touch: 1, date: '2026-10-12', via: 'crm task', who: 'floorboss' }, NOW);
  const fu = list(H, later(1)).filter((i) => i.kind === 'send');
  assert.equal(fu.length, 1);
  made(H, fu, later(1));
  add(H, { type: 'replied', id: ana }, later(2));
  const after = list(H, later(2));
  assert.equal(after.filter((i) => i.kind === 'send').length, 0, 'no new send task after a reply');
  const close = after.filter((i) => i.kind === 'review' && /close/i.test(i.body));
  assert.equal(close.length, 1, `the open follow-up task is offered to close: ${JSON.stringify(after)}`);
  assert.match(close[0].body, /replied/);
  // The outbox says so.
  assert.ok(!cli(H, 'event-outreach', ['render', '--event', H.slug], later(2)).ERROR);
  const page = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
  assert.match(page, /Ana Berg replied: close the task for this message in your CRM/);
});
