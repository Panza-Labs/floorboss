// Review of 0.1.7 (item 2): a LinkedIn follow-up whose approved text or day changes after its CRM task was made gets one
// review task to close the old task, then a new task with the new text and day, and one line on its card.
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

test('the follow-up edited and approved again: close the old task, then a new task with the new text', () => {
  const { H, ana, fu } = tasked();
  const draft = JSON.parse(readFileSync(join(H.dir, 'work', 'drafts', `${ana}-t2.json`), 'utf8'));
  const body = `${draft.body.split('\n')[0]} One more thought.\n\n${draft.body.split('\n').slice(2).join('\n')}`;
  const sv = cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', ana, '--touch', '2', '--said', 'use my text', '--json', JSON.stringify({ body, brief: draft.brief, structure: draft.structure, fact_source: draft.fact_source, ...(draft.insight ? { insight: draft.insight } : {}) })], later(2));
  assert.equal(sv.checks, 'pass', JSON.stringify(sv));
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', ana, '--touch', '2', '--text', 'PASS'], later(2));
  assert.ok(!cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all'], later(2)).ERROR);
  assert.ok(page(H, later(2)).includes(LINE), 'the card says so');
  const items = list(H, later(2));
  const review = items.filter((i) => i.kind === 'review');
  assert.equal(review.length, 1, JSON.stringify(items));
  assert.equal(review[0].body, 'The message in the open task for Ana Berg changed: close that task; a new one follows.');
  const send = items.filter((i) => i.kind === 'send');
  assert.equal(send.length, 1);
  assert.notEqual(send[0].key, fu.key);
  assert.ok(send[0].body.includes('One more thought.'));
  made(H, items, later(2));
  assert.deepEqual(list(H, later(2)), [], 'once made, nothing more');
  assert.ok(!page(H, later(2)).includes(LINE), 'the line goes once the new task is made');
  // Closing the old task in the CRM records nothing: it was replaced.
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', 'ts.json');
  writeFileSync(f, JSON.stringify({ tasks: [{ task_id: `T-${fu.key}`, status: 'done', completed_at: later(2) }] }));
  const ts = cli(H, 'event-outreach', ['task-status', '--event', H.slug, '--file', f], later(2));
  assert.deepEqual(ts.sent, [], JSON.stringify(ts));
});

test("the follow-up's day moved: close the old task, then a new task due on the new day", () => {
  const { H, fu } = tasked();
  const ev = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  ev.settings.followup_gap = [2];
  writeFileSync(join(H.dir, 'event.json'), JSON.stringify(ev));
  const items = list(H, later(1));
  const send = items.filter((i) => i.kind === 'send');
  assert.equal(send.length, 1, JSON.stringify(items));
  assert.notEqual(send[0].due, fu.due, `${send[0].due} vs ${fu.due}`);
  assert.equal(items.filter((i) => i.kind === 'review' && /changed: close that task/.test(i.body)).length, 1);
  assert.ok(page(H, later(1)).includes(LINE));
});
