// Review of 0.1.7 (item 5): a by-hand message whose day has passed says so on its card at once, also while it waits
// for the LinkedIn reply question (message 1 recorded late).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';

const card = { kind: 'message', channel: 'paste', where: 'LinkedIn', id: 'c001', touch: 2, name: 'Ana Berg', company: 'Acme', title: 'COO', profile_url: 'https://www.linkedin.com/in/ana', body: 'Hi', due_on: '2026-10-19', slots: [] };
const page = (c, today) => renderOutbox({ event: { slug: 'ev', name: 'X' }, today, cards: [c], counts: {}, slots: [] });
const art = (html) => /<article[\s\S]*?<\/article>/.exec(html)[0];

test('the card says "Overdue since" once its day has passed, before the reply answer too', () => {
  assert.match(art(page({ ...card, li_reply_unchecked: true }, '2026-10-21')), /Overdue since Mon 19 Oct\./);
  assert.match(art(page(card, '2026-10-21')), /Overdue since Mon 19 Oct\./);
  assert.doesNotMatch(art(page(card, '2026-10-19')), /Overdue/, 'not on its own day');
  assert.doesNotMatch(art(page({ ...card, channel: 'email' }, '2026-10-21')), /Overdue/, 'an email is not sent by hand here');
});
