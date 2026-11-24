// The event app said a person left it (not_found) or has messages off: the outbox card says so, offers nothing to paste
// or send for that note, and the summary doesn't list it as waiting to go (sim run 3, F5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, idOf, NOW } from './fixtures/harness.mjs';
import { append } from '../lib/ledger.mjs';

const NOTES = { app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false };
const later = (min) => new Date(Date.parse(NOW) + min * 6e4).toISOString();

function appEvent() {
  const S = { sending: { channels: ['app'], followups: 'scheduled' }, route: ['app'], touches: 1, ...NOTES };
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\nBo Li,VP Ops,Globex,\nCy Ng,COO,Initech,\n', event: { app_name: 'Brella' }, settings: S });
  triage(H);
  draftApprove(H);
  return H;
}
const cardOf = (html, id) => {
  const i = html.indexOf(`data-id="${id}"`);
  assert.ok(i > 0, `no card for ${id}`);
  return html.slice(i, html.indexOf('</article>', i));
};

test('a person who left the app or turned messages off: the card says so, with nothing to paste, and is not waiting', () => {
  const H = appEvent();
  const [ana, bo, cy] = ['Ana Berg', 'Bo Li', 'Cy Ng'].map((n) => idOf(H, n));
  const log = join(H.dir, 'ledger.jsonl');
  append(log, { type: 'app_result', who: 'floorboss', id: ana, touch: 1, result: 'not_found', page_says: 'This person is no longer attending' }, new Date(later(5)));
  append(log, { type: 'app_result', who: 'floorboss', id: bo, touch: 1, result: 'messages_off', page_says: 'Messaging is turned off' }, new Date(later(6)));
  cli(H, 'event-outreach', ['render', '--event', H.slug], later(10));
  const html = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
  const a = cardOf(html, ana),
    b = cardOf(html, bo),
    c = cardOf(html, cy);
  assert.match(a, /left the app/i, a);
  assert.match(b, /messages (are )?(turned )?off/i, b);
  for (const x of [a, b]) {
    assert.match(x, /can't be delivered/i, x);
    assert.doesNotMatch(x, /paste it in Brella|Paste message/, x);
    assert.doesNotMatch(x, /class="copy"|data-copy|data-li=/, x);
  }
  assert.match(c, /paste it in Brella/, 'an ordinary app note is unchanged');
  const sum = cli(H, 'event-outreach', ['summary', '--event', H.slug], later(11));
  const waiting = (sum.in_outbox_to_send || []).map((w) => w.id);
  assert.ok(!waiting.includes(ana) && !waiting.includes(bo), JSON.stringify(sum.in_outbox_to_send));
  assert.ok(waiting.includes(cy), JSON.stringify(sum).slice(0, 400));
});

// Review: the app's answer holds for the person in that app, not only for the one note; and a step moved to email is
// still counted as waiting.
test('after the app says a person left, their later notes in the same app get the same card and are not waiting', () => {
  const S = { sending: { channels: ['app'], followups: 'scheduled' }, route: ['app', 'app'], ...NOTES };
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\nBo Li,VP Ops,Globex,\n', event: { app_name: 'Brella' }, settings: S });
  triage(H);
  draftApprove(H);
  const [ana, bo] = ['Ana Berg', 'Bo Li'].map((n) => idOf(H, n));
  const log = join(H.dir, 'ledger.jsonl');
  append(log, { type: 'app_result', who: 'floorboss', id: ana, touch: 1, result: 'not_found', page_says: 'gone' }, new Date(later(5)));
  append(log, { type: 'app_result', who: 'floorboss', id: bo, touch: 1, result: 'messages_off', page_says: 'off' }, new Date(later(5)));
  append(log, { type: 'app_result', who: 'floorboss', id: bo, touch: 1, result: 'sent', page_says: 'Message sent' }, new Date(later(6)));
  cli(H, 'event-outreach', ['render', '--event', H.slug], later(10));
  const html = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
  const cards = html.split('<article').filter((x) => x.includes(`data-id="${ana}"`));
  assert.ok(cards.length >= 1);
  for (const x of cards) assert.match(x, /left the app/i, x.slice(0, 300));
  for (const x of html.split('<article').filter((x) => x.includes(`data-id="${bo}"`))) assert.doesNotMatch(x, /messages are off/, 'a later result says otherwise');
  const sum = cli(H, 'event-outreach', ['summary', '--event', H.slug], later(11));
  assert.ok(!(sum.in_outbox_to_send || []).some((w) => w.id === ana), JSON.stringify(sum.in_outbox_to_send));
});

test('a note that goes by email is still waiting after the app said the person left', () => {
  const S = { sending: { channels: ['app'], followups: 'scheduled' }, route: ['app', 'email'], ...NOTES };
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', event: { app_name: 'Brella' }, settings: S });
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  const st = cli(H, 'event-outreach', ['summary', '--event', H.slug], later(1));
  const before = (st.in_outbox_to_send || []).filter((w) => w.id === ana).map((w) => w.touch);
  append(join(H.dir, 'ledger.jsonl'), { type: 'app_result', who: 'floorboss', id: ana, touch: 1, result: 'not_found', page_says: 'gone' }, new Date(later(5)));
  const sum = cli(H, 'event-outreach', ['summary', '--event', H.slug], later(11));
  const after = (sum.in_outbox_to_send || []).filter((w) => w.id === ana).map((w) => w.touch);
  assert.deepEqual(after, before.filter((t) => t !== 1), `before ${before} after ${after}`);
  assert.ok(before.includes(2), `the email step is waiting before: ${JSON.stringify(st.in_outbox_to_send)}`);
});

test('a send the user confirms in that app, after the app said not_found, clears the hold on their other notes', () => {
  const S = { sending: { channels: ['app'], followups: 'scheduled' }, route: ['app', 'app'], ...NOTES };
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\n', event: { app_name: 'Brella' }, settings: S });
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  const log = join(H.dir, 'ledger.jsonl');
  append(log, { type: 'app_result', who: 'floorboss', id: ana, touch: 1, result: 'not_found', page_says: 'gone' }, new Date(later(5)));
  append(log, { type: 'sent', who: 'user', id: ana, touch: 1, date: NOW.slice(0, 10), via: 'floorboss', channel: 'Brella', source: 'user', said: 'it went, I see it in Brella' }, new Date(later(6)));
  cli(H, 'event-outreach', ['render', '--event', H.slug], later(10));
  const html = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
  for (const x of html.split('<article').filter((x) => x.includes(`data-id="${ana}"`))) assert.doesNotMatch(x, /left the app/, x.slice(0, 300));
});
