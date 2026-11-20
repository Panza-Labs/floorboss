// U2 of auto-send (lib/autosend/plan.mjs): which messages may go now, with no model, and why every other one waits.
// Cases 2 to 7 of the design: one a day, hours and days, the follow-up on its day, a stop at another event, a text
// changed and approved for content only, a revoke; and what blocks every send (a lone release, an unclear send, a
// damaged line).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { world, addLines, approvedLines, PEOPLE, NOW } from './fixtures/autosend-world.mjs';
import { readback, approve, revoke } from '../lib/autosend/approval.mjs';
import { dueNow } from '../lib/autosend/plan.mjs';

const at = (iso) => Date.parse(iso);
// A world with every sequence approved for auto-send at NOW (Monday 12 October, 09:00 in Lisbon).
function approved(opts = {}) {
  const w = world({ touches: 2, ...opts });
  process.env.FLOORBOSS_HOME = w.HOME;
  const r = readback(w.evDir, at(NOW));
  approve(w.evDir, { digest: r.digest, said: 'auto-send these sequences' }, at(NOW));
  return w;
}
const sentLines = (id, touch, date, when) => [{ at: when, type: 'sent', who: 'floorboss', id, touch, via: 'email.send', channel: 'email', date, source: 'autosend', message_id: `m-${id}-${touch}`, thread_id: `t-${id}` }];
const waitOf = (r, id) => r.waits.find((w) => w.id === id)?.why || '';

test('on the planned day at 10:00 event time: every first message is due, exact text and address, one per person, sorted', () => {
  const { HOME } = approved();
  const r = dueNow(HOME, at('2026-10-12T09:00:00Z'));
  assert.equal(r.blocked, null);
  assert.deepEqual(r.due.map((x) => [x.slug, x.id, x.touch]), [['harbor-expo', 'c001', 1], ['harbor-expo', 'c002', 1], ['harbor-expo', 'c003', 1]]);
  const ana = r.due[0];
  assert.equal(ana.to, 'ana@north.example');
  assert.equal(ana.name, 'Ana Ito');
  assert.match(ana.subject, /At Harbor Expo, Ana/);
  assert.match(ana.body, /Message 1 for North/);
  assert.match(ana.hash, /^[0-9a-f]{24}$/);
  assert.equal(ana.since_ms, at(NOW), 'nothing went yet: from the second yes');
  assert.equal(ana.thread_id, null);
  assert.equal(ana.reply_to_message_id, null);
});

test('case 3: before 09:00, from 17:00, on a Saturday, two days late, and after the event, nothing is due, and waits say why', () => {
  const { HOME } = approved();
  const cases = [
    ['2026-10-12T07:59:00Z', /08:59 in Lisbon/],
    ['2026-10-12T16:00:00Z', /17:00 in Lisbon/],
    ['2026-10-17T10:00:00Z', /weekend/],
    ['2026-10-14T09:00:00Z', /more than a day ago/],
    ['2026-11-05T10:00:00Z', /over|ended|past/i]
  ];
  for (const [when, why] of cases) {
    const r = dueNow(HOME, at(when));
    assert.deepEqual(r.due, [], when);
    assert.equal(r.waits.length, 3, when);
    assert.match(waitOf(r, 'c001'), why, when);
  }
  // The day after the planned day is still in its window.
  assert.equal(dueNow(HOME, at('2026-10-13T09:00:00Z')).due.length, 3);
});

test('case 2: a second run the same day sends nothing more (already sent; one a day)', () => {
  const { HOME, evDir } = approved();
  addLines(evDir, sentLines('c001', 1, '2026-10-12', '2026-10-12T09:01:00Z'));
  const r = dueNow(HOME, at('2026-10-12T10:00:00Z'));
  assert.deepEqual(r.due.map((x) => x.id), ['c002', 'c003']);
  assert.match(waitOf(r, 'c001'), /isn't due until|today/);
});

test('case 4 (plan side): the follow-up is due on its day, threaded from the first send, counted from it', () => {
  const { HOME, evDir } = approved();
  addLines(evDir, sentLines('c001', 1, '2026-10-12', '2026-10-12T09:01:00Z'));
  const early = dueNow(HOME, at('2026-10-16T09:00:00Z'));
  assert.ok(!early.due.some((x) => x.id === 'c001'));
  assert.match(waitOf(early, 'c001'), /isn't due until/);
  const r = dueNow(HOME, at('2026-10-19T09:00:00Z'));
  const ana = r.due.find((x) => x.id === 'c001');
  assert.equal(ana.touch, 2);
  assert.equal(ana.thread_id, 't-c001');
  assert.equal(ana.reply_to_message_id, 'm-c001-1');
  // From the start of the day it went (12 October in Lisbon, 23:00 UTC the day before), the earlier of that and when it
  // was recorded (round 6, finding 2).
  assert.equal(ana.since_ms, at('2026-10-11T23:00:00Z'));
  // The others' first messages were never sent and their window is gone: a follow-up never goes ahead of them.
  assert.match(waitOf(r, 'c002'), /more than a day ago/);
  assert.equal(r.waits.find((w) => w.id === 'c002').touch, 1);
});

test('a reply, a bounce or a stop recorded at this event: never due again', () => {
  const { HOME, evDir } = approved();
  addLines(evDir, [
    { at: NOW, type: 'replied', who: 'mailbox', id: 'c001', source: 'autosend', outcome: 'replied' },
    { at: NOW, type: 'bounced', who: 'mailbox', id: 'c002' },
    { at: NOW, type: 'stop', who: 'user', id: 'c003', said: 'stop' }
  ]);
  const r = dueNow(HOME, at('2026-10-12T09:00:00Z'));
  assert.deepEqual(r.due, []);
  assert.match(waitOf(r, 'c001'), /replied/);
  assert.match(waitOf(r, 'c002'), /bounced/);
  assert.match(waitOf(r, 'c003'), /stop/);
});

test('case 5: a stop for the same address at another event holds it; so does another event that wrote to them today', () => {
  const { HOME } = approved();
  const other = (slug, lines) => {
    const d = join(HOME, 'events', slug);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'event.json'), JSON.stringify({ slug, name: slug, city: 'Porto', time_zone: 'Europe/Lisbon', start_date: '2026-11-20', end_date: '2026-11-21', settings: {} }));
    writeFileSync(join(d, 'ledger.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  other('river-fair', [
    { at: NOW, type: 'person', who: 'floorboss', id: 'c010', name: 'Ana Ito', email: 'ANA@north.example', company: 'North' },
    { at: NOW, type: 'stop', who: 'user', id: 'c010', said: 'asked to stop' }
  ]);
  other('dock-days', [
    { at: NOW, type: 'person', who: 'floorboss', id: 'c020', name: 'Bo Li', email: 'bo@east.example', company: 'East' },
    { at: '2026-10-12T08:30:00Z', type: 'sent', who: 'user', id: 'c020', touch: 1, date: '2026-10-12', said: 'sent' }
  ]);
  const r = dueNow(HOME, at('2026-10-12T09:00:00Z'));
  assert.deepEqual(r.due.map((x) => x.id), ['c003']);
  assert.match(waitOf(r, 'c001'), /stop at another of your events/);
  assert.match(waitOf(r, 'c002'), /already went or is going today/);
});

test('case 6: a text edited and approved for content only (no second yes) is not due', () => {
  const { HOME, evDir } = approved();
  addLines(evDir, approvedLines(evDir, PEOPLE[0], 1, { extra: ' Edited.' }).lines);
  const r = dueNow(HOME, at('2026-10-12T09:00:00Z'));
  assert.ok(!r.due.some((x) => x.id === 'c001'));
  assert.match(waitOf(r, 'c001'), /changed since the auto-send yes/);
});

test('case 7: revoked is not due; the list cut after the yes holds everyone', () => {
  const { HOME, evDir } = approved();
  revoke(evDir, { ids: 'c002', said: 'stop auto-send for Bo' }, at(NOW));
  let r = dueNow(HOME, at('2026-10-12T09:00:00Z'));
  assert.deepEqual(r.due.map((x) => x.id), ['c001', 'c003']);
  assert.match(waitOf(r, 'c002'), /stopped/);
  addLines(evDir, [{ at: NOW, type: 'keep', who: 'user', top: 1, said: 'keep 1' }]);
  r = dueNow(HOME, at('2026-10-12T09:00:00Z'));
  assert.deepEqual(r.due, []);
  assert.match(waitOf(r, 'c001'), /list changed/);
});

test('blocked: a release with nothing after it, an unclear send, a damaged line; settled by "it went" or "it didn\'t go"', () => {
  const { HOME, evDir } = approved();
  const r0 = dueNow(HOME, at('2026-10-12T09:00:00Z'));
  const ana = r0.due[0];
  addLines(evDir, [{ at: '2026-10-12T09:00:01Z', type: 'autosend_released', who: 'floorboss', id: 'c001', touch: 1, hash: ana.hash, to: ana.to, run: 'r1' }]);
  let r = dueNow(HOME, at('2026-10-12T09:10:00Z'));
  assert.match(r.blocked, /c001/);
  assert.deepEqual(r.due, []);
  addLines(evDir, [{ at: '2026-10-12T09:00:02Z', type: 'send_unclear', who: 'floorboss', id: 'c001', touch: 1, error: 'no ids' }]);
  r = dueNow(HOME, at('2026-10-12T09:10:00Z'));
  assert.match(r.blocked, /unclear|may have gone/);
  // "it didn't go": settled, and never auto-sent again (rule 9): it goes back to hand-send.
  addLines(evDir, [{ at: '2026-10-12T10:00:00Z', type: 'release_cleared', who: 'user', id: 'c001', touch: 1, said: 'not in my sent folder' }]);
  r = dueNow(HOME, at('2026-10-12T10:10:00Z'));
  assert.equal(r.blocked, null);
  assert.deepEqual(r.due.map((x) => x.id), ['c002', 'c003']);
  assert.match(waitOf(r, 'c001'), /never sent again by auto-send/);
  appendFileSync(join(evDir, 'ledger.jsonl'), '{"at":"2026-10-12T10:11:00Z","type":"stop","who":"user","id":"c00\n');
  r = dueNow(HOME, at('2026-10-12T10:12:00Z'));
  assert.match(r.blocked, /can't be read/);
  assert.deepEqual(r.due, []);
});

test('only events set to auto-send are planned, and the data folder must be the one floorboss reads', () => {
  const { HOME, evDir } = approved();
  writeFileSync(join(evDir, 'event.json'), JSON.stringify({ slug: 'harbor-expo', name: 'Harbor Expo', city: 'Lisbon', time_zone: 'Europe/Lisbon', start_date: '2026-11-03', end_date: '2026-11-04', settings: {} }));
  assert.deepEqual(dueNow(HOME, at('2026-10-12T09:00:00Z')).due, []);
  assert.throws(() => dueNow('/nowhere/else', at('2026-10-12T09:00:00Z')), /FLOORBOSS_HOME/);
});

test('review H2, H3: "don\'t reach them", another channel, a corrected address, or away until a later day: not due', () => {
  const { HOME, evDir } = approved();
  addLines(evDir, sentLines('c001', 1, '2026-10-12', '2026-10-12T09:01:00Z'));
  addLines(evDir, [
    { at: NOW, type: 'paused', who: 'user', id: 'c001', until: '2026-10-23', said: 'away' },
    { at: NOW, type: 'channel', who: 'user', id: 'c002', to: 'none', said: "don't reach" },
    { at: NOW, type: 'person', who: 'floorboss', id: 'c003', email: 'cy.moss@west.example' }
  ]);
  const r = dueNow(HOME, at('2026-10-19T09:00:00Z'));
  assert.deepEqual(r.due, []);
  assert.match(waitOf(r, 'c001'), /away until 2026-10-23/);
  assert.match(waitOf(r, 'c002'), /channel/);
  assert.match(waitOf(r, 'c003'), /address/);
});
