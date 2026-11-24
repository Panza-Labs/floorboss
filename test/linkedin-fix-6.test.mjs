// Review of 0.1.7 (item 6): a meeting confirmation on LinkedIn is held to the 300-character note limit too, when it is
// saved and at approval.
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


function booked() {
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,,https://www.linkedin.com/in/ana\n', settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: ['linkedin', 'linkedin'], linkedin_messages: true } });
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  add(H, { type: 'sent', id: ana, touch: 1, date: '2026-10-12', via: 'outbox', who: 'floorboss' }, NOW);
  add(H, { type: 'booked', id: ana, slot: 's20261110T1000', start: '2026-11-10T09:00:00Z', blocks: ['s20261110T1000'], said: 'Ana booked Tue 10:00' }, later(1));
  const r = cli(H, 'event-outreach', ['todo', '--event', H.slug], later(1));
  const job = JSON.parse(readFileSync(r.todo_file, 'utf8')).jobs.find((j) => j.kind === 'confirmation');
  assert.ok(job, 'a confirmation job');
  return { H, ana, job };
}
const save = (H, j, body) => cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', '0', '--json', JSON.stringify({ subject: 'Test Expo', body, brief: 'x, no research profile' })], later(1));
const conf = (j, pad = '') => `Hi Ana, confirming ${j.slot_labels.join('')}. See you at Test Expo.${pad}\n\nBest, Sam`;

test('a LinkedIn confirmation over 300 characters fails its checks when saved', () => {
  const { H, job } = booked();
  const body = conf(job, ' Looking forward to comparing warehouse-automation experiences, implementation-timelines, procurement-considerations, integration-challenges, maintenance-scheduling, documentation-requirements and staffing-arrangements.');
  assert.ok(body.length > 300, String(body.length));
  const r = save(H, job, body);
  assert.ok(Array.isArray(r.checks) && r.checks.some((p) => /limit is 300/.test(p)), JSON.stringify(r));
});

test('at approval, a LinkedIn confirmation longer than the limit is not approved', () => {
  const { H, ana, job } = booked();
  const body = conf(job);
  const r = save(H, job, body);
  assert.equal(r.checks, 'pass', JSON.stringify(r));
  const ev = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  ev.settings.linkedin_note_limit = body.length - 10;
  writeFileSync(join(H.dir, 'event.json'), JSON.stringify(ev));
  cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all'], later(1));
  const ledger = readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(!ledger.some((e) => e.type === 'approved' && e.id === ana && e.touch === 0), 'not approved');
});
