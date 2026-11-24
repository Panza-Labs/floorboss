// Review of 0.1.7 (item 4): message 1, sent by hand, never ticked as sent: its follow-up has no card yet, so message
// 1's card says the follow-up waits for that tick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { setup, cli, triage, draftApprove, NOW } from './fixtures/harness.mjs';

const later = (d) => new Date(Date.parse(NOW) + d * 86400000).toISOString();
const LINE = "Tick Sent here once you've sent it, then press Copy status and paste it into the chat: floorboss lists the follow-up after that.";

test("message 1's card says the follow-up waits for its Sent tick", () => {
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,,https://www.linkedin.com/in/ana\n', settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: ['linkedin', 'linkedin'], linkedin_messages: true } });
  triage(H);
  draftApprove(H);
  assert.ok(!cli(H, 'event-outreach', ['render', '--event', H.slug], later(10)).ERROR);
  const page = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
  const card = /<article class="card" data-id="c001" data-touch="1"[\s\S]*?<\/article>/.exec(page)?.[0] || '';
  assert.ok(card.includes(LINE), card.slice(0, 400));
});

test('no such line with no follow-up approved', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,,https://www.linkedin.com/in/ana\n', settings: { route: ['linkedin'], linkedin_messages: true } });
  triage(H);
  draftApprove(H);
  assert.ok(!cli(H, 'event-outreach', ['render', '--event', H.slug]).ERROR);
  assert.ok(!readFileSync(join(H.dir, 'outbox.html'), 'utf8').includes(LINE));
});
