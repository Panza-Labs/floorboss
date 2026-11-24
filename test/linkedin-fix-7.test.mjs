// Review of 0.1.7 (item 7): the Due today heading names its day as a person types it, and a page opened on a later
// day says it is from that day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';

const card = { kind: 'message', channel: 'paste', where: 'LinkedIn', id: 'c001', touch: 1, name: 'Ana Berg', company: 'Acme', title: 'COO', profile_url: 'https://www.linkedin.com/in/ana', body: 'Hi', slots: [] };
const html = renderOutbox({ event: { slug: 'ev', name: 'X' }, today: '2026-10-27', cards: [card], counts: {}, slots: [] });

test('the heading says the day it is for', () => {
  assert.match(html, /<h2>Due today, Tue 27 Oct \(1\)<\/h2>/);
});

test('a line, shown by the page on a later day, says the list is from that day', () => {
  assert.match(html, /<p class="follow" id="dueStale" data-day="2026-10-27" data-zone="[^"]*" hidden>This page is from Tue 27 Oct: open floorboss for today's list\.<\/p>/);
  assert.match(html, /getElementById\('dueStale'\)/, 'the page script shows it when the day is past');
});
