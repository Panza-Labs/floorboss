// Second review of 0.1.7 (item 1): closing a CRM task floorboss asked the user to close (a close or a changed review,
// made or only due to be made) records nothing as sent; an edited follow-up still gets its new task.
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

const S = { sending: { channels: ['email'], followups: 'scheduled' }, route: ['linkedin', 'linkedin'], linkedin_messages: true, crm_log: 'tasks' };
const PEOPLE = 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,,https://www.linkedin.com/in/ana\n';
function tasked() {
  const H = setup({ attendees: PEOPLE, settings: S });
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  made(H, list(H).filter((i) => i.kind === 'send'));
  add(H, { type: 'sent', id: ana, touch: 1, date: '2026-10-12', via: 'crm task', who: 'floorboss' }, NOW);
  const fu = list(H, later(1)).filter((i) => i.kind === 'send');
  assert.equal(fu.length, 1);
  made(H, fu, later(1));
  assert.deepEqual(list(H, later(1)), [], 'nothing more while nothing changed');
  return { H, ana, fu: fu[0] };
}
const page = (H, now) => {
  assert.ok(!cli(H, 'event-outreach', ['render', '--event', H.slug], now).ERROR);
  return readFileSync(join(H.dir, 'outbox.html'), 'utf8');
};
const LINE = 'This message changed after its task was made in your CRM: close that task. floorboss makes a new one.';

const finish = (H, key, now) => {
  const f = join(H.HOME, 'work', `ts-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify({ tasks: [{ task_id: `T-${key}`, status: 'done', completed_at: now }] }));
  const r = cli(H, 'event-outreach', ['task-status', '--event', H.slug, '--file', f], now);
  assert.ok(!r.ERROR && r.applied, JSON.stringify(r));
  return r;
};
const sentTouches = (H, id) =>
  readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'sent' && e.id === id).map((e) => e.touch);

test('edited follow-up: the old task closed before the new one exists records nothing, and the new task still comes', () => {
  const { H, ana, fu } = tasked();
  const draft = JSON.parse(readFileSync(join(H.dir, 'work', 'drafts', `${ana}-t2.json`), 'utf8'));
  const body = `${draft.body.split('\n')[0]} One more thought.\n\n${draft.body.split('\n').slice(2).join('\n')}`;
  cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', ana, '--touch', '2', '--said', 'use my text', '--json', JSON.stringify({ body, brief: draft.brief, structure: draft.structure, fact_source: draft.fact_source, ...(draft.insight ? { insight: draft.insight } : {}) })], later(2));
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', ana, '--touch', '2', '--text', 'PASS'], later(2));
  assert.ok(!cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all'], later(2)).ERROR);
  // The close review is made; the user closes the old task before the new task exists.
  made(H, list(H, later(2)).filter((i) => i.kind === 'review'), later(2));
  const r = finish(H, fu.key, later(2));
  assert.deepEqual(r.sent, []);
  assert.deepEqual(sentTouches(H, ana), [1]);
  const next = list(H, later(2)).filter((i) => i.kind === 'send');
  assert.equal(next.length, 1, 'the new task is still made');
  assert.ok(next[0].body.includes('One more thought.'));
});

test('a reply after the task: closing that task, as asked, records nothing as sent', () => {
  const { H, ana, fu } = tasked();
  add(H, { type: 'replied', id: ana }, later(2));
  made(H, list(H, later(2)), later(2));
  const r = finish(H, fu.key, later(3));
  assert.deepEqual(r.sent, []);
  assert.deepEqual(sentTouches(H, ana), [1]);
});
