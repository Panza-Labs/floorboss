// The summary and the card agree on a follow-up after a sent note: the app's not_found holds it in both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, idOf, NOW } from './fixtures/harness.mjs';
import { append } from '../lib/ledger.mjs';

const NOTES = { app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false };
const later = (min) => new Date(Date.parse(NOW) + min * 6e4).toISOString();

test('after a confirmed send of note 1, a not_found for note 1 or note 2 keeps note 2 out of the waiting list', () => {
  for (const onTouch of [1, 2]) {
    const S = { sending: { channels: ['app'], followups: 'scheduled' }, route: ['app', 'app'], ...NOTES };
    const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\n', event: { app_name: 'Brella' }, settings: S });
    triage(H);
    draftApprove(H);
    const ana = idOf(H, 'Ana Berg');
    const log = join(H.dir, 'ledger.jsonl');
    append(log, { type: 'sent', who: 'user', id: ana, touch: 1, date: NOW.slice(0, 10), via: 'floorboss', channel: 'Brella', source: 'user', said: 'it went' }, new Date(later(5)));
    const before = cli(H, 'event-outreach', ['summary', '--event', H.slug], later(6));
    assert.ok((before.in_outbox_to_send || []).some((w) => w.id === ana && w.touch === 2), `note 2 waits first: ${JSON.stringify(before.in_outbox_to_send)}`);
    append(log, { type: 'app_result', who: 'floorboss', id: ana, touch: onTouch, result: 'not_found', page_says: 'gone' }, new Date(later(7)));
    const sum = cli(H, 'event-outreach', ['summary', '--event', H.slug], later(8));
    assert.ok(!(sum.in_outbox_to_send || []).some((w) => w.id === ana && w.touch === 2), `touch ${onTouch}: ${JSON.stringify(sum.in_outbox_to_send)}`);
  }
});
