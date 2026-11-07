// After a booking, a plain "sent" for someone whose confirmation is waiting is that confirmation (touch 0), not
// a follow-up; "touch": 0 and "kind": "confirmation" say so outright; "unsent" takes a wrong record back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, idOf, draftApprove } from './fixtures/harness.mjs';
import { readLedger, fold } from '../lib/ledger.mjs';

const ATT = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n';
const LATER = '2026-10-20T08:00:00Z';

function booked() {
  const H = setup({ attendees: ATT });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const f = join(H.dir, 'fits.json');
  writeFileSync(f, JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment: 'ops-leaders', reason: `${r.title} at ${r.company}`, score: 80 }))));
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits-file', f]);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  draftApprove(H);
  rec(H, [{ who: 'Ana Berg', what: 'sent', date: '2026-10-12', said: 'sent Ana' }, { who: 'Bo Li', what: 'sent', date: '2026-10-12', said: 'sent Bo' }]);
  rec(H, [{ who: 'Ana Berg', what: 'replied', said: 'Tue 10 works' }, { who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00', said: 'booked her' }], [], LATER);
  // The confirmation is drafted and approved: it waits in the outbox.
  draftApprove(H, LATER);
  return H;
}
const rec = (H, items, extra = [], now = LATER) => { const f = join(H.dir, `report-${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify({ items })); return cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', f, ...extra], now); };
const people = (H) => { const { entries, damaged } = readLedger(join(H.dir, 'ledger.jsonl')); return fold(entries, damaged).people; };
const waiting = (H) => cli(H, 'event-outreach', ['summary', '--event', H.slug], LATER).in_outbox_to_send || [];

test('a plain "sent" after a booking is the confirmation that was waiting: recorded as touch 0, out of the outbox, in the agenda thread', () => {
  const H = booked();
  const ana = idOf(H, 'Ana Berg');
  assert.ok(waiting(H).some((x) => x.id === ana && x.touch === 0), `the confirmation waits first: ${JSON.stringify(waiting(H))}`);
  const r = rec(H, [{ who: 'Ana Berg', what: 'sent', said: 'sent the confirmation' }]);
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.match(r.recorded[0], /sent to Ana Berg \(Acme\) \(the meeting confirmation\)/);
  assert.ok(r.notes.some((n) => /taken as the meeting confirmation/.test(n)), JSON.stringify(r.notes));
  const p = people(H)[ana];
  assert.ok(p.touches[0].sent, 'touch 0 is sent');
  assert.ok(!p.touches[2]?.sent, 'no follow-up recorded');
  assert.ok(!waiting(H).some((x) => x.id === ana), 'nothing of Ana\'s left to send');
  const a = cli(H, 'event-outreach', ['agenda-data', '--event', H.slug], LATER);
  assert.ok(!a.ERROR, a.ERROR);
  const data = JSON.parse(readFileSync(a.file, 'utf8'));
  assert.deepEqual(data.meetings.find((m) => m.id === ana).thread.sent.map((x) => x.touch), [0, 1], 'the confirmation is in the thread');
});

test('"touch": 0 and "kind": "confirmation" are the confirmation; a touch past 10 is still refused', () => {
  const H = booked();
  const ana = idOf(H, 'Ana Berg');
  const r0 = rec(H, [{ who: 'Ana Berg', what: 'sent', touch: 0, said: 'that was the confirmation' }], ['--check']);
  assert.equal(r0.applied, false, JSON.stringify(r0));
  assert.match(r0.would_record[0], /the meeting confirmation/);
  assert.ok(!r0.notes.some((n) => /taken as/.test(n)), 'said outright: nothing to point out');
  const rk = rec(H, [{ who: 'Ana Berg', what: 'sent', kind: 'confirmation', said: 'confirmation out' }]);
  assert.equal(rk.applied, true, JSON.stringify(rk));
  assert.ok(people(H)[ana].touches[0].sent);
  const again = rec(H, [{ who: 'Ana Berg', what: 'sent', touch: 0, said: 'sent the confirmation' }]);
  assert.ok(again.notes.some((n) => /already recorded \(the meeting confirmation\)/.test(n)), JSON.stringify(again.notes));
  assert.match(rec(H, [{ who: 'Ana Berg', what: 'sent', touch: 11, said: 'x' }]).ERROR, /touch is a whole number from 0 \(the meeting confirmation\) to 10/);
});

test('no confirmation waiting: a plain "sent" is the next message, as before', () => {
  const H = booked();
  const r = rec(H, [{ who: 'Bo Li', what: 'sent', said: 'followed up with Bo' }]);
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.match(r.recorded[0], /sent to Bo Li \(Globex\) \(follow-up 1\)/);
  assert.ok(people(H)[idOf(H, 'Bo Li')].touches[2].sent);
});

test('"unsent" (or "undo") takes back the last recorded send with a sent_undone line; the message is due again', () => {
  const H = booked();
  const ana = idOf(H, 'Ana Berg');
  // Recorded as a follow-up by mistake, then fixed: undone, and recorded again as the confirmation.
  assert.equal(rec(H, [{ who: 'Ana Berg', what: 'sent', touch: 2, said: 'sent the confirmation' }]).applied, true);
  const u = rec(H, [{ who: 'Ana Berg', what: 'undo', said: 'that was the confirmation, not the follow-up' }, { who: 'Ana Berg', what: 'sent', touch: 0, said: 'that was the confirmation' }]);
  assert.equal(u.applied, true, JSON.stringify(u));
  assert.match(u.recorded[0], /undone: follow-up 1 to Ana Berg \(Acme\), recorded as sent on 2026-10-20/);
  const L = readLedger(join(H.dir, 'ledger.jsonl')).entries;
  assert.ok(L.some((e) => e.type === 'sent_undone' && e.id === ana && e.touch === 2 && e.who === 'user' && /not the follow-up/.test(e.said)));
  const p = people(H)[ana];
  assert.ok(!p.touches[2].sent && p.touches[0].sent && p.touches[1].sent);
  // Nothing more to undo for Bo after his one send is taken back.
  assert.equal(rec(H, [{ who: 'Bo Li', what: 'unsent', said: 'never went' }]).applied, true);
  assert.match(rec(H, [{ who: 'Bo Li', what: 'unsent', said: 'again' }]).ERROR, /Bo Li \(Globex\) has no recorded send to undo/);
});

test('a send floorboss made itself is not undone', () => {
  const H = booked();
  const bo = idOf(H, 'Bo Li');
  writeFileSync(join(H.dir, 'ledger.jsonl'), `${readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8')}${JSON.stringify({ at: LATER, type: 'sent', who: 'floorboss', id: bo, touch: 2, date: '2026-10-20', via: 'floorboss', channel: 'email' })}\n`);
  assert.match(rec(H, [{ who: 'Bo Li', what: 'unsent', said: 'undo' }]).ERROR, /was recorded as it went out through floorboss/);
});
