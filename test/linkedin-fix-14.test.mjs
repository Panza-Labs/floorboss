// Second review of 0.1.7 (item 5): the follow-up's planned day on its card is written as a person types it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { setup, cli, triage, draftApprove, idOf, NOW } from './fixtures/harness.mjs';
import { append } from '../lib/ledger.mjs';

test('"planned for Mon 19 Oct", never 2026-10-19', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,,https://www.linkedin.com/in/ana\n', settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: ['linkedin', 'linkedin'], linkedin_messages: true } });
  triage(H);
  draftApprove(H);
  append(join(H.dir, 'ledger.jsonl'), { who: 'floorboss', type: 'sent', id: idOf(H, 'Ana Berg'), touch: 1, date: '2026-10-12', via: 'outbox' }, new Date(NOW));
  assert.ok(!cli(H, 'event-outreach', ['render', '--event', H.slug]).ERROR);
  const html = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
  const notes = html.match(/<p class="follow">[^<]*planned for[^<]*<\/p>/g) || [];
  assert.ok(notes.length, 'a planned-day note');
  for (const n of notes) {
    assert.doesNotMatch(n, /planned for \d{4}-\d{2}-\d{2}/, n);
    assert.match(n, /planned for (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2}/, n);
  }
});
