// Third review of 0.1.7 (item 1): "done" on a CRM message task means sent unless floorboss asked the user to close it,
// and that request still stands. The task's outcome text is always read; anything doubtful is asked once, yes or no.
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
    // The answer names the task it answers (its key), as the step's answer_format says.
    const f = join(H.HOME, 'work', `ans-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, JSON.stringify(value));
    return cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'task_sent', '--value-file', f], now);
  } finally {
    delete process.env.FLOORBOSS_OUT_OF_TURN;
  }
};

test('(a/c) the outcome says sent: the send is recorded with the text the task held, though the follow-up was edited that day', () => {
  const { H, ana, fu } = tasked();
  edit(H, ana, 7);
  made(H, list(H, later(7)).filter((i) => i.kind === 'review'), later(7));
  const r = finishWith(H, fu.key, later(7), 'sent');
  assert.deepEqual(r.sent, [ana]);
  const sent = ledgerOf(H).filter((e) => e.type === 'sent' && e.touch === 2);
  assert.equal(sent.length, 1);
  assert.deepEqual(list(H, later(7)).filter((i) => i.kind === 'send'), [], 'no new task for a message that went');
});

test('(b) a close review that still stands: done records nothing (round 2 case b)', () => {
  const { H, ana, fu } = tasked();
  add(H, { type: 'booked', id: ana, slot: 's20261110T1000', start: '2026-11-10T09:00:00Z', blocks: ['s20261110T1000'], said: 'booked' }, later(2));
  made(H, list(H, later(2)).filter((i) => i.kind === 'review'), later(2));
  assert.deepEqual(finishWith(H, fu.key, later(3)).sent, []);
});

test('(d) a booking cancelled after the close review: the task is live again, so done means sent', () => {
  const { H, ana, fu } = tasked();
  add(H, { type: 'booked', id: ana, slot: 's20261110T1000', start: '2026-11-10T09:00:00Z', blocks: ['s20261110T1000'], said: 'booked' }, later(2));
  made(H, list(H, later(2)).filter((i) => i.kind === 'review'), later(2));
  add(H, { type: 'unbooked', id: ana, slot: 's20261110T1000', blocks: ['s20261110T1000'], source: 'user', said: 'she cancelled' }, later(3));
  assert.deepEqual(finishWith(H, fu.key, later(7)).sent, [ana]);
});

test('(e) the day moved and no close review yet: done with no outcome is asked once, yes records the send', () => {
  const { H, ana, fu } = tasked();
  moveDay(H);
  const r = finishWith(H, fu.key, later(7));
  assert.deepEqual(r.sent, []);
  const s = stepAt(H, later(7));
  assert.equal(s.ask.id, 'task_sent');
  assert.equal(s.ask.question, 'Did you send the message in the task for Ana Berg?');
  assert.deepEqual(s.ask.options, ['yes', 'no']);
  assert.deepEqual(list(H, later(7)).filter((i) => i.kind === 'send'), [], 'no new task while it is asked');
  const a = answer(H, { key: fu.key, answer: 'yes' }, later(7));
  assert.ok(!a.ERROR, a.ERROR);
  const sent = ledgerOf(H).filter((e) => e.type === 'sent' && e.touch === 2);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].hash, fu.hash, 'the text the task held');
  assert.equal(stepAt(H, later(7)), null, 'asked once');
});

test('(c) changed text, no close review, no outcome: asked; no makes the new task', () => {
  const { H, ana, fu } = tasked();
  edit(H, ana, 7);
  assert.deepEqual(finishWith(H, fu.key, later(7)).sent, []);
  assert.equal(stepAt(H, later(7))?.ask?.id, 'task_sent');
  assert.ok(!answer(H, { key: fu.key, answer: 'no' }, later(7)).ERROR);
  assert.equal(ledgerOf(H).filter((e) => e.type === 'sent' && e.touch === 2).length, 0);
  const next = list(H, later(7)).filter((i) => i.kind === 'send');
  assert.equal(next.length, 1, 'the new task');
  assert.ok(next[0].body.includes('One more thought.'));
});
