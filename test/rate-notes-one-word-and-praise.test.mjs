// The simulated tester's rating notes: "5: 4 generic" is a note (one word is enough), "plain, fine for a customer" is
// praise and never offered as a rule, and "only the ones I rated" sends back the rated drafts with a note,
// each to its own note, and says so in the question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOW } from './fixtures/harness.mjs';
import { simplePersona } from './sims/lib/driver.mjs';
import { MOCK, envOf, run, loadMock, home, answer } from './fixtures/r2.mjs';
import { untilStep } from './fixtures/flow-until.mjs';
import { asRule } from '../skills/event-outreach/scripts/sameness.mjs';

test('asRule: one word is a note; praise, even with a few words, is not', () => {
  for (const n of ['generic', 'too plain', 'the opener is a bit abstract', 'second sentence is a brochure', 'fine but too long', 'reads like a brochure']) assert.equal(asRule(n), true, n);
  for (const n of ['plain, fine for a customer', 'fine', 'good', 'plain', 'ok', 'works', 'works for me', 'clear and good']) assert.equal(asRule(n), false, n);
});

test('rated notes: praise left out of the rules; "only the ones I rated" sends back the drafts with a note', { timeout: 300000 }, () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const H = { HOME, now: NOW, env: envOf(HOME) };
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), voice_samples: 'skip' } });
  const at = untilStep(H, per, 'rate');
  run(HOME, 'event-outreach', at.last.run_first.slice(2));
  const key = JSON.parse(readFileSync(join(HOME, 'events', MOCK, 'derived', 'rate-key.json'), 'utf8'));
  assert.ok(key.length >= 4);
  const r = answer(HOME, 'rate', '1: 8\n2: 7 plain, fine for a customer\n3: 6 the opener is a bit abstract\n4: 4 generic');
  assert.ok(!r.ERROR, r.ERROR);
  let s = run(HOME, 'flow', ['next', '--event', MOCK]);
  for (let i = 0; i < 30 && s.step !== 'rate_notes' && !s.ask; i++) {
    if (s.judge?.then && s.step === 'draft') { const todo = JSON.parse(readFileSync(s.judge.read, 'utf8')); writeFileSync(s.judge.write, JSON.stringify(per.judge.draft(todo, s.judge.ids, []))); run(HOME, 'event-outreach', s.judge.then.slice(2)); }
    else if (s.agents) for (const ag of s.agents) { writeFileSync(ag.write, per.judge.critic(JSON.parse(readFileSync(ag.input_file, 'utf8')))); run(HOME, 'event-outreach', ag.then.slice(2)); }
    else if (s.run) run(HOME, 'event-outreach', s.run.slice(2));
    s = run(HOME, 'flow', ['next', '--event', MOCK]);
  }
  assert.equal(s.step, 'rate_notes', JSON.stringify(s).slice(0, 300));
  assert.deepEqual(s.ask.notes, ['the opener is a bit abstract', 'generic']);
  assert.match(s.ask.question, /each draft with a note is written again to its own note/);
  const a = answer(HOME, 'rate_notes', 'only the ones I rated');
  assert.ok(!a.ERROR, a.ERROR);
  assert.deepEqual(a.result.sent_back, [`${key[2].id}:${key[2].touch}`, `${key[3].id}:${key[3].touch}`]);
  const led = readFileSync(join(HOME, 'events', MOCK, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(led.some((e) => e.type === 'revise' && e.id === key[3].id && /generic/.test(e.feedback)));
  assert.ok(!led.some((e) => e.type === 'revise' && e.id === key[1].id), 'the praised draft stays as it is');
});
