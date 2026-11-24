// Review of 0.1.7 (item 1): a booked person's meeting confirmation task is not "closed because they booked": a reply or
// a booking closes only an open message task (message 1 or later). A stop or a block still closes any task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { setup, cli, triage, draftApprove, idOf, NOW } from './fixtures/harness.mjs';
import { append } from '../lib/ledger.mjs';

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

const CASES = {
  LinkedIn: { people: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,,https://www.linkedin.com/in/ana\n', event: {}, route: ['linkedin', 'linkedin'] },
  'an event app': { people: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\n', event: { app_name: 'Grip' }, route: ['app', 'app'] }
};
for (const [where, k] of Object.entries(CASES))
  test(`in ${where}: a booked person's confirmation task gets no close review and no close line on the page`, () => {
    const H = setup({ attendees: k.people, event: k.event, settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: k.route, linkedin_messages: true, crm_log: 'tasks', app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false } });
    triage(H);
    draftApprove(H);
    const ana = idOf(H, 'Ana Berg');
    made(H, list(H).filter((i) => i.kind === 'send'));
    add(H, { type: 'sent', id: ana, touch: 1, date: '2026-10-12', via: 'crm task', who: 'floorboss' }, NOW);
    add(H, { type: 'booked', id: ana, slot: 's20261110T1000', start: '2026-11-10T09:00:00Z', blocks: ['s20261110T1000'], said: 'Ana booked Tue 10:00' }, later(1));
    draftApprove(H, later(1));
    const conf = list(H, later(1)).filter((i) => i.kind === 'send');
    assert.deepEqual(conf.map((i) => i.touch), [0], JSON.stringify(conf));
    made(H, conf, later(1));
    const after = list(H, later(1));
    assert.ok(!after.some((i) => i.kind === 'review' && /close that task/.test(i.reason || i.body)), JSON.stringify(after));
    assert.ok(!cli(H, 'event-outreach', ['render', '--event', H.slug], later(1)).ERROR);
    assert.doesNotMatch(readFileSync(join(H.dir, 'outbox.html'), 'utf8'), /close the task/);
  });
