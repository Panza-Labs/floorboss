// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// What came in between sessions, recorded by hand: an out-of-office isn't a reply and holds no follow-up; a cancellation that asks for another time is put to the user to agree a new one (nothing
// new goes to someone who replied); and recording what came in never makes the "anything new?" question come back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fold, readLedger, contactable } from '../lib/ledger.mjs';
import { wallParts } from '../lib/tz.mjs';
import { NOW } from './fixtures/harness.mjs';
import { simplePersona, drive } from './sims/lib/driver.mjs';
import { MOCK, envOf, run, loadMock, home, json, answer } from './fixtures/r2.mjs';

// contactable() reads floorboss's clock: the same moved day the scripts run on.
process.env.FLOORBOSS_NOW = NOW;

// The mock event driven to its outbox, every first message reported sent.
function sentHome() {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), rate: 'skip' } });
  const r = drive({ HOME, now: NOW, env: envOf(HOME) }, per, { maxSteps: 220 });
  assert.ok(r.last.done || r.last.step === 'waiting', r.trail.slice(-6).join(' '));
  const sent = (r.last.summary?.in_outbox_to_send || []).filter((x) => x.touch === 1).map((x) => x.id);
  assert.ok(sent.length > 2, JSON.stringify(r.last.summary).slice(0, 300));
  writeFileSync(join(HOME, 'work', 'sent.json'), JSON.stringify({ items: sent.map((who) => ({ who, what: 'sent', date: NOW.slice(0, 10) })) }));
  assert.ok(!run(HOME, 'event-outreach', ['record', '--event', MOCK, '--file', join(HOME, 'work', 'sent.json')]).ERROR);
  return { HOME, sent };
}
const record = (HOME, items) => {
  const f = join(HOME, 'work', 'report.json');
  writeFileSync(f, JSON.stringify({ items }));
  return run(HOME, 'event-outreach', ['record', '--event', MOCK, '--file', f]);
};
const stateOf = (HOME) => fold(readLedger(join(HOME, 'events', MOCK, 'ledger.jsonl')).entries);
const dayAfter = (n) => new Date(Date.parse(NOW) + n * 86400e3).toISOString().slice(0, 10);

test('an out-of-office is recorded as away until a day, not as a reply; the replies question takes "recorded" even when a reply raised a booking question first', { timeout: 300000 }, () => {
  const { HOME, sent } = sentHome();
  const [away, yes] = sent;
  run(HOME, 'flow', ['next', '--new-run']);
  const asked = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.equal(asked.step, 'replies_since', `${asked.step}: ${JSON.stringify(asked).slice(0, 300)}`);
  const r = record(HOME, [
    { who: away, what: 'away', until: dayAfter(5), said: 'auto-reply: out of office until then' },
    { who: yes, what: 'replied', said: 'Thursday 10:00 works for me' }
  ]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.ok(r.recorded.some((l) => /is away until/.test(l)), r.recorded.join(' | '));
  const st = stateOf(HOME);
  assert.equal(st.people[away].replied, false, 'an out-of-office is not a reply');
  assert.equal(contactable(st, away), null, 'follow-ups go on while they are away');
  // The reply with a time raises its own question first; the replies question is still answered there.
  const next = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.equal(next.step, 'reply_action', `${next.step}: ${JSON.stringify(next).slice(0, 300)}`);
  const ok = answer(HOME, 'replies_since', { answer: 'recorded', ledger_lines: asked.ask.ledger_lines });
  assert.ok(!ok.ERROR, ok.ERROR);
  assert.ok(!answer(HOME, 'reply_action', { ...next.ask.person, answer: 'not booked yet' }).ERROR);
  assert.notEqual(run(HOME, 'flow', ['next', '--event', MOCK]).step, 'replies_since', 'not asked again in this run');
  // "away" needs the day they're back.
  assert.match(record(HOME, [{ who: away, what: 'away' }]).ERROR || '', /needs "until"/);
});

test('a cancellation that asks for another time puts it to the user; nothing new goes to them, and a time agreed is booked', { timeout: 300000 }, () => {
  const { HOME, sent } = sentHome();
  const who = sent[0];
  const ev = json(join(HOME, 'events', MOCK, 'event.json'));
  const slot = json(join(HOME, 'events', MOCK, 'slots.json')).slots[0];
  const w = wallParts(new Date(slot.start), ev.time_zone);
  const p2 = (n) => String(n).padStart(2, '0');
  const time = `${w.y}-${p2(w.m)}-${p2(w.d)} ${p2(w.hh)}:${p2(w.mm)}`;
  // Booked from the calendar, with no reply recorded: the cancellation is their reply.
  assert.ok(!record(HOME, [{ who, what: 'booked', time, said: 'accepted the invite' }]).ERROR);
  const c = record(HOME, [{ who, what: 'cancelled', another_time: true, said: 'have to cancel, maybe Thursday morning?' }]);
  assert.ok(!c.ERROR, c.ERROR);
  assert.ok(c.recorded.some((l) => /asked for another time/.test(l)), c.recorded.join(' | '));
  assert.equal(contactable(stateOf(HOME), who), 'they replied', 'nothing new goes to someone who replied');
  run(HOME, 'flow', ['next', '--new-run']);
  const s = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.equal(s.step, 'reply_action', `${s.step}: ${JSON.stringify(s).slice(0, 300)}`);
  assert.match(s.ask.question, /cancelled and asked for another time\. Agree a new one with them/);
  assert.match(answer(HOME, 'reply_action', { ...s.ask.person, answer: 'yes' }).ERROR || '', /no time to book yet/, 'a yes with no time books nothing silently');
  assert.ok(!answer(HOME, 'reply_action', { ...s.ask.person, answer: `booked for: ${time}` }).ERROR, 'the time they agreed is booked, in the option\'s own words');
  const st = stateOf(HOME);
  assert.ok(st.people[who].booked, 'booked again');
  assert.equal(st.people[who].reply_actions.filter((a) => !a.done).length, 0, 'the question is settled');
});

test('an away person stays in the follow-up batch, before and after the day they are back', () => {
  const st = fold([
    { at: '2026-11-01T09:00:00Z', type: 'person', who: 'floorboss', id: 'c001', name: 'Ann' },
    { at: '2026-11-02T09:00:00Z', type: 'paused', who: 'user', id: 'c001', until: '2026-11-09', said: 'out of office' }
  ]);
  assert.equal(contactable(st, 'c001', 'message', '2026-11-08'), null, 'still away: a follow-up may go');
  assert.equal(contactable(st, 'c001', 'message', '2026-11-09'), null, 'back on the day');
  assert.equal(contactable(st, 'c001', 'confirmation', '2026-11-08'), null, 'a confirmation still goes');
});
