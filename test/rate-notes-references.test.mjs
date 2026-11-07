// Notes on the blind ratings: "same as 1" is a pointer, not a voice rule, and the draft it's on goes back to be
// written apart from the batch whatever its rating; only a real note (not praise, not a pointer) is offered as a rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOW } from './fixtures/harness.mjs';
import { simplePersona } from './sims/lib/driver.mjs';
import { MOCK, envOf, run, loadMock, home, answer } from './fixtures/r2.mjs';
import { untilStep } from './fixtures/flow-until.mjs';
import { asRule, SAMENESS_NOTE } from '../skills/event-outreach/scripts/sameness.mjs';

test('asRule: pointers and praise are not rules; a short note is', () => {
  for (const n of ['same as 1', 'same as 1 again', 'see 3', 'ditto', '2', 'fine', 'identical to the third one here']) assert.equal(asRule(n), false, n);
  for (const n of ['too long and too formal', 'open with their problem, not us', 'too long']) assert.equal(asRule(n), true, n);
  assert.ok(SAMENESS_NOTE.test('same as 1 again'));
  assert.ok(!SAMENESS_NOTE.test('the same tone as my own emails would be better'));
});

test('rating notes: "same as 1" sends that draft back (rated 5 or 7), and only the real note is offered as a rule', { timeout: 300000 }, () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const H = { HOME, now: NOW, env: envOf(HOME) };
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), voice_samples: 'skip' } });
  const at = untilStep(H, per, 'rate');
  assert.equal(at.step, 'rate');
  run(HOME, 'event-outreach', at.last.run_first.slice(2));
  const key = JSON.parse(readFileSync(join(HOME, 'events', MOCK, 'derived', 'rate-key.json'), 'utf8'));
  assert.ok(key.length >= 4);
  const r = answer(HOME, 'rate', '1: 7 fine\n2: 5 same as 1\n3: 7 same as 1 again\n4: 6 too long and too formal for me');
  assert.ok(!r.ERROR, r.ERROR);
  assert.deepEqual(r.result.rewritten_as_alike, [`${key[1].id}:${key[1].touch}`, `${key[2].id}:${key[2].touch}`]);
  const led = readFileSync(join(HOME, 'events', MOCK, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const rev = led.filter((e) => e.type === 'revise');
  assert.ok(rev.some((e) => e.id === key[2].id && /reads like another draft in this batch \(your note: "same as 1 again"\)/.test(e.feedback)), JSON.stringify(rev));
  assert.ok(!rev.some((e) => e.id === key[0].id), 'the draft rated 7 "fine" stays');
  // The next ask about notes offers only the real one.
  let s = run(HOME, 'flow', ['next', '--event', MOCK]);
  for (let i = 0; i < 30 && s.step !== 'rate_notes' && !s.ask; i++) {
    if (s.judge?.then && s.step === 'draft') { const todo = JSON.parse(readFileSync(s.judge.read, 'utf8')); writeFileSync(s.judge.write, JSON.stringify(per.judge.draft(todo, s.judge.ids, []))); run(HOME, 'event-outreach', s.judge.then.slice(2)); }
    else if (s.agents) for (const ag of s.agents) { writeFileSync(ag.write, per.judge.critic(JSON.parse(readFileSync(ag.input_file, 'utf8')))); run(HOME, 'event-outreach', ag.then.slice(2)); }
    else if (s.run) run(HOME, 'event-outreach', s.run.slice(2));
    s = run(HOME, 'flow', ['next', '--event', MOCK]);
  }
  assert.equal(s.step, 'rate_notes', JSON.stringify(s).slice(0, 300));
  assert.deepEqual(s.ask.notes, ['too long and too formal for me']);
});
