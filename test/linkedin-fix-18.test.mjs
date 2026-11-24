// Open points after the third review of 0.1.7 (item 1): one message, two tasks in the CRM (an old one and its
// replacement): it is recorded as sent once, whichever is finished first, and the other is asked to be closed.
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

import { readLedger, fold } from '../lib/ledger.mjs';
import { loadEvent } from '../lib/event.mjs';
import { taskSentStep } from '../skills/flow/scripts/steps/channels.mjs';

const finishWith = (H, key, now, outcome) => {
  const f = join(H.HOME, 'work', `ts-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify({ tasks: [{ task_id: `T-${key}`, status: 'done', completed_at: now, ...(outcome ? { outcome } : {}) }] }));
  const r = cli(H, 'event-outreach', ['task-status', '--event', H.slug, '--file', f], now);
  assert.ok(!r.ERROR && r.applied, JSON.stringify(r));
  return r;
};
function edit(H, ana, d) {
  const draft = JSON.parse(readFileSync(join(H.dir, 'work', 'drafts', `${ana}-t2.json`), 'utf8'));
  const body = `${draft.body.split('\n')[0]} One more thought.\n\n${draft.body.split('\n').slice(2).join('\n')}`;
  cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', ana, '--touch', '2', '--said', 'use my text', '--json', JSON.stringify({ body, brief: draft.brief, structure: draft.structure, fact_source: draft.fact_source, ...(draft.insight ? { insight: draft.insight } : {}) })], later(d));
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', ana, '--touch', '2', '--text', 'PASS'], later(d));
  assert.ok(!cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all'], later(d)).ERROR);
}
const moveDay = (H) => {
  const ev = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  ev.settings.followup_gap = [2];
  writeFileSync(join(H.dir, 'event.json'), JSON.stringify(ev));
};
const ledgerOf = (H) => readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
function stepAt(H, now) {
  const prev = process.env.FLOORBOSS_HOME;
  process.env.FLOORBOSS_HOME = H.HOME;
  try {
    const ev = loadEvent(H.slug);
    const { entries } = readLedger(ev.paths.ledger);
    return taskSentStep({ now: new Date(now), home: H.HOME, cfg: {} }, { ...ev, entries, state: fold(entries), today: now.slice(0, 10) });
  } finally {
    if (prev === undefined) delete process.env.FLOORBOSS_HOME;
    else process.env.FLOORBOSS_HOME = prev;
  }
}
const answer = (H, value, now) => {
  process.env.FLOORBOSS_OUT_OF_TURN = '1';
  try {
    return cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'task_sent', '--value', value], now);
  } finally {
    delete process.env.FLOORBOSS_OUT_OF_TURN;
  }
};


function twoTasks() {
  const { H, ana, fu } = tasked();
  edit(H, ana, 3);
  const items = list(H, later(3));
  made(H, items, later(3));
  const neu = items.find((i) => i.kind === 'send');
  assert.ok(neu && neu.key !== fu.key);
  return { H, ana, fu, neu };
}
const sends2 = (H) => ledgerOf(H).filter((e) => e.type === 'sent' && e.touch === 2);
const WENT = "The message in the open task for Ana Berg already went: close that task, don't send it.";

test('old task finished as sent after the new one was made: one close review for the new task, and the message leaves the page', () => {
  const { H, ana, fu, neu } = twoTasks();
  assert.deepEqual(finishWith(H, fu.key, later(7), 'sent').sent, [ana]);
  const rv = list(H, later(7)).filter((i) => i.kind === 'review' && i.body.startsWith(WENT));
  assert.equal(rv.length, 1, JSON.stringify(list(H, later(7))));
  assert.ok(rv[0].key.includes(neu.key));
  assert.ok(!cli(H, 'event-outreach', ['render', '--event', H.slug], later(7)).ERROR);
  const html = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
  assert.doesNotMatch(html, new RegExp(`data-id="${ana}" data-touch="2"`));
  // Finishing the new task after closing it records no second send.
  finishWith(H, neu.key, later(8));
  assert.equal(sends2(H).length, 1);
});

test('the new task finished as sent first, then the old one with "sent": one send', () => {
  const { H, ana, fu, neu } = twoTasks();
  assert.deepEqual(finishWith(H, neu.key, later(7), 'sent').sent, [ana]);
  finishWith(H, fu.key, later(8), 'sent');
  assert.equal(sends2(H).length, 1);
});

test('both finished in one read: one send', () => {
  const { H, neu, fu } = twoTasks();
  const f = join(H.HOME, 'work', 'both.json');
  writeFileSync(f, JSON.stringify({ tasks: [neu, fu].map((x) => ({ task_id: `T-${x.key}`, status: 'done', completed_at: later(7), outcome: 'sent' })) }));
  assert.ok(!cli(H, 'event-outreach', ['task-status', '--event', H.slug, '--file', f], later(7)).ERROR);
  assert.equal(sends2(H).length, 1);
});
