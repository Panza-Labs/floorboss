// A reply recorded with a time in it ("Wednesday works, can we do 10:30?") is said back as a time to book,
// and the flow's next question asks whether it's booked, as the README says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOW } from './fixtures/harness.mjs';
import { simplePersona } from './sims/lib/driver.mjs';
import { MOCK, envOf, run, loadMock, home, answer } from './fixtures/r2.mjs';
import { untilStep } from './fixtures/flow-until.mjs';
import { timeInReply } from '../skills/event-outreach/scripts/record.mjs';
import { weekdayOf } from '../lib/tz.mjs';

test('timeInReply: a weekday and a time on one event day is a time to book; a day alone only reads like one', () => {
  const days = ['2026-11-10', '2026-11-11', '2026-11-12'];
  assert.deepEqual(timeInReply('Wednesday works, can we do 10:30?', days), { at: '2026-11-11 10:30', words: 'Wednesday 10:30' });
  assert.deepEqual(timeInReply('Thu at 2pm?', days), { at: '2026-11-12 14:00', words: 'Thu 2pm' });
  assert.equal(timeInReply('Friday maybe', days).at, null);
  assert.equal(timeInReply('Thanks, not for us this year', days), null);
});

test('record replied with a time: the answer says it reads like a time, and the next step asks to book it', { timeout: 300000 }, () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const H = { HOME, now: NOW, env: envOf(HOME) };
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n') } });
  untilStep(H, per, 'gate');
  const ev = JSON.parse(readFileSync(join(HOME, 'events', MOCK, 'event.json'), 'utf8'));
  const day = weekdayOf(ev.start_date);
  const who = JSON.parse(readFileSync(join(HOME, 'events', MOCK, 'derived', 'shortlist.json'), 'utf8')).ranked[0];
  const f = join(HOME, 'work', 'report.json');
  writeFileSync(f, JSON.stringify({ items: [{ who, what: 'replied', said: `${day} works, can we do 10:30?` }] }));
  const r = run(HOME, 'event-outreach', ['record', '--event', MOCK, '--file', f]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.ok(r.notes.some((n) => n.includes(`that reads like a time (${day} 10:30): record it as booked with {"who":"${who}","what":"booked","time":"${ev.start_date} 10:30"} if it's confirmed`)), JSON.stringify(r.notes));
  const s = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.equal(s.step, 'reply_action', JSON.stringify(s).slice(0, 300));
  assert.equal(s.ask.person.id, who);
  assert.match(s.ask.question, new RegExp(`wrote back with ${ev.start_date} 10:30\\. Book it\\?`));
  const b = answer(HOME, 'reply_action', s.ask.answer_format.replace('"answer":"yes"|"no"|"<YYYY-MM-DD HH:MM>"', '"answer":"yes"'));
  assert.ok(!b.ERROR, b.ERROR);
  const led = readFileSync(join(HOME, 'events', MOCK, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(led.some((e) => e.type === 'booked' && e.id === who), 'booked from the answer');
});

test('record a reply with a time and its booking in one report: the booking answers it, so the flow doesn\'t ask', { timeout: 300000 }, () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const H = { HOME, now: NOW, env: envOf(HOME) };
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n') } });
  untilStep(H, per, 'gate');
  const ev = JSON.parse(readFileSync(join(HOME, 'events', MOCK, 'event.json'), 'utf8'));
  const day = weekdayOf(ev.start_date);
  const who = JSON.parse(readFileSync(join(HOME, 'events', MOCK, 'derived', 'shortlist.json'), 'utf8')).ranked[0];
  const f = join(HOME, 'work', 'report.json');
  writeFileSync(f, JSON.stringify({ items: [{ who, what: 'replied', said: `${day} at 10 works, see you there` }, { who, what: 'booked', time: `${ev.start_date} 10:00`, said: `${day} 10:00` }] }));
  const r = run(HOME, 'event-outreach', ['record', '--event', MOCK, '--file', f]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.ok(!r.notes.some((n) => /reads like a time/.test(n)), JSON.stringify(r.notes));
  const s = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.notEqual(s.step, 'reply_action', JSON.stringify(s).slice(0, 300));
});
