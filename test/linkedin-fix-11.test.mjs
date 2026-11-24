// Second review of 0.1.7 (item 2): a bad due day on one card never stops the page from being built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';

test('a due day that is not a date: the page still builds, and no day is written for it', () => {
  const card = { kind: 'message', channel: 'paste', where: 'LinkedIn', id: 'c001', touch: 2, name: 'Ana Berg', company: 'Acme', title: 'COO', profile_url: 'https://www.linkedin.com/in/ana', body: 'Hi', due_on: '2026-1-5x', slots: [] };
  const html = renderOutbox({ event: { slug: 'ev', name: 'X' }, today: '2026-10-12', cards: [card], counts: {}, slots: [] });
  assert.match(html, /<\/html>/);
  assert.doesNotMatch(html, /overdue since/i);
});
