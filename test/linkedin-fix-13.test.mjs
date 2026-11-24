// Second review of 0.1.7 (item 4): the line on a by-hand message whose follow-up waits says what to do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';

test("the waiting follow-up's line tells the user the two steps", () => {
  const card = { kind: 'message', channel: 'paste', where: 'LinkedIn', id: 'c001', touch: 1, name: 'Ana Berg', company: 'Acme', title: 'COO', profile_url: 'https://www.linkedin.com/in/ana', body: 'Hi', slots: [], next_waits: true };
  const html = renderOutbox({ event: { slug: 'ev', name: 'X' }, today: '2026-10-12', cards: [card], counts: {}, slots: [] });
  assert.ok(html.includes("Tick Sent here once you've sent it, then press Copy status and paste it into the chat: floorboss lists the follow-up after that."));
  assert.doesNotMatch(html, /waits for you to tick/);
});
