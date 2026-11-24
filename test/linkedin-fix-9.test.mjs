// Review of 0.1.7 (item 9): the LinkedIn reply question names the one person it is about, says "since your last message
// to them" (the message before may have been an email), and the page writes days as a person types them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replyQuestion } from '../skills/flow/scripts/steps/channels.mjs';
import { renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';

test('one person: the question names them', () => {
  assert.equal(replyQuestion([{ id: 'c001', name: 'Ana Berg' }]), 'A LinkedIn follow-up is due today for Ana Berg. Did Ana Berg reply on LinkedIn? Say "no", or "yes".');
});

test('several: one question with a count (the owner\'s rule since: no names)', () => {
  const q = replyQuestion([{ id: 'c001', name: 'Ana Berg' }, { id: 'c002', name: 'Bo Li' }]);
  assert.equal(q, '2 LinkedIn follow-ups are due today. Did any of them reply on LinkedIn? Name them, say "none", or say "show me the list".');
  assert.doesNotMatch(q, /there\?/);
});

test('Due today writes the overdue day as a person types it, never as 2026-10-10', () => {
  const card = { kind: 'message', channel: 'paste', where: 'LinkedIn', id: 'c002', touch: 2, name: 'Bo Li', company: 'Globex', title: 'VP', profile_url: 'https://www.linkedin.com/in/bo', body: 'Hi', due_on: '2026-10-10', slots: [] };
  const html = renderOutbox({ event: { slug: 'ev', name: 'X' }, today: '2026-10-12', cards: [card], counts: {}, slots: [] });
  const due = /<section[^>]*id="dueToday"[\s\S]*?<\/section>/.exec(html)[0];
  assert.match(due, /overdue since Sat 10 Oct/);
  assert.doesNotMatch(due, /2026-10-10<|since 2026/);
});
