// Review of 0.1.7 (item 8): the line asking to close a CRM task goes once the user ticks it on the page or marks the
// review task done; and that review task asks nothing to answer in floorboss.
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

import { renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';

function replied() {
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,,https://www.linkedin.com/in/ana\n', settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: ['linkedin', 'linkedin'], linkedin_messages: true, crm_log: 'tasks' } });
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  made(H, list(H).filter((i) => i.kind === 'send'));
  add(H, { type: 'sent', id: ana, touch: 1, date: '2026-10-12', via: 'crm task', who: 'floorboss' }, NOW);
  made(H, list(H, later(1)).filter((i) => i.kind === 'send'), later(1));
  add(H, { type: 'replied', id: ana }, later(2));
  return { H, ana };
}
const page = (H, now) => {
  assert.ok(!cli(H, 'event-outreach', ['render', '--event', H.slug], now).ERROR);
  return readFileSync(join(H.dir, 'outbox.html'), 'utf8');
};

test('the close review task asks nothing to answer in floorboss', () => {
  const { H } = replied();
  const r = list(H, later(2)).find((i) => i.kind === 'review');
  assert.ok(r, 'a close review task');
  assert.doesNotMatch(r.body, /Answer it in floorboss/);
  assert.match(r.body, /close that task/);
});

test('once that review task is marked done in the CRM, the line leaves the page', () => {
  const { H } = replied();
  const items = list(H, later(2));
  made(H, items, later(2));
  assert.match(page(H, later(2)), /close the task for this message/);
  const r = items.find((i) => i.kind === 'review');
  const f = join(H.HOME, 'work', 'ts.json');
  writeFileSync(f, JSON.stringify({ tasks: [{ task_id: `T-${r.key}`, status: 'done', completed_at: later(3) }] }));
  assert.ok(!cli(H, 'event-outreach', ['task-status', '--event', H.slug, '--file', f], later(3)).ERROR);
  assert.doesNotMatch(page(H, later(3)), /close the task for this message/);
});

test('on the page, the line has a tick that hides it', () => {
  const html = renderOutbox({ event: { slug: 'ev', name: 'X' }, today: '2026-10-14', cards: [], counts: {}, slots: [], close_tasks: [{ name: 'Ana Berg', why: 'replied', key: 'c001:2' }] });
  assert.match(html, /<p class="banner" data-close="c001:2">Ana Berg replied: close the task for this message in your CRM, and don't send it\. <label><input type="checkbox" data-closed> Closed<\/label><\/p>/);
  assert.match(html, /querySelectorAll\('\[data-close\]'\)/);
});
