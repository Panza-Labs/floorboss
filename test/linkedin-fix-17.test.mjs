// Third review of 0.1.7 (item 2): with a CRM task for the message, the waiting-follow-up line also says the task works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';

const card = { kind: 'message', channel: 'paste', where: 'LinkedIn', id: 'c001', touch: 1, name: 'Ana Berg', company: 'Acme', title: 'COO', profile_url: 'https://www.linkedin.com/in/ana', body: 'Hi', slots: [], next_waits: true };
const page = (c) => renderOutbox({ event: { slug: 'ev', name: 'X' }, today: '2026-10-12', cards: [c], counts: {}, slots: [] });

test('with a CRM task: "or mark its task done in your CRM"', () => {
  assert.ok(page({ ...card, has_task: true }).includes("Tick Sent here once you've sent it, then press Copy status and paste it into the chat, or mark its task done in your CRM: floorboss lists the follow-up after that."));
});

test('without one: the line as before', () => {
  const html = page(card);
  assert.ok(html.includes("Tick Sent here once you've sent it, then press Copy status and paste it into the chat: floorboss lists the follow-up after that."));
  assert.doesNotMatch(html, /mark its task done/);
});
