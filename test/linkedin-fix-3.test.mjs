// Review of 0.1.7 (item 3): a LinkedIn follow-up's CRM task exists before the reply question is asked, so the check
// is in the task itself, at the top of its body. And on the page, its card offers no Copy and no Sent until the
// question is answered, as in Due today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskItems } from '../skills/event-outreach/scripts/tracking.mjs';
import { renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';
import { dayWords } from '../lib/tz.mjs';

const card = { kind: 'message', channel: 'paste', where: 'LinkedIn', id: 'c001', touch: 2, name: 'Ana Berg', company: 'Acme', title: 'COO', profile_url: 'https://www.linkedin.com/in/ana', body: 'Hi Ana, one more note.', due_on: '2026-10-19', prev_sent_on: '2026-10-12', slots: [] };
const args = { created: new Set(), event: { name: 'Test Expo', end_date: '2026-11-12' }, byId: {}, crmOf: () => null, today: '2026-10-13' };

test('a day is written as a person types it', () => {
  assert.equal(dayWords('2026-10-12'), 'Mon 12 Oct');
  assert.equal(dayWords('2026-10-27'), 'Tue 27 Oct');
});

test("the follow-up task opens with the reply check, naming the day message 1 went", () => {
  const [it] = taskItems({ ...args, cards: [card] });
  assert.ok(
    it.body.startsWith("Before you send: look in LinkedIn for a reply from Ana Berg since Mon 12 Oct. If they replied, don't send this; close the task and tell floorboss.\n\n"),
    it.body
  );
  assert.ok(it.body.includes(card.body));
  const [first] = taskItems({ ...args, cards: [{ ...card, touch: 1, due_on: undefined, prev_sent_on: undefined }] });
  assert.doesNotMatch(first.body, /Before you send/, 'not on message 1');
});

test('the card offers no Copy and no Sent until the LinkedIn reply question is answered', () => {
  const page = (c) => renderOutbox({ event: { slug: 'ev', name: 'X' }, today: '2026-10-19', cards: [c], counts: {}, slots: [] });
  const open = page(card);
  assert.match(open, /data-copy="c001-t2-body"/);
  assert.match(open, /data-tick="sent"/);
  const held = page({ ...card, li_reply_unchecked: true });
  assert.doesNotMatch(held, /data-copy=/);
  assert.doesNotMatch(held, /data-tick="sent"/);
  assert.doesNotMatch(held, /data-li="1"/, 'not in the LinkedIn queue either');
});
