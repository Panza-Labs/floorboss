// The user can say to skip the critic, in their own words, and the flow takes it: "skip review all" at the
// critic step (or with the approval answer) sends those drafts on marked "not reviewed".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOW } from './fixtures/harness.mjs';
import { simplePersona } from './sims/lib/driver.mjs';
import { MOCK, envOf, run, loadMock, home, answer } from './fixtures/r2.mjs';
import { untilStep } from './fixtures/flow-until.mjs';

test('"skip review all" at the critic step: no critic runs, approval follows, the cards say not reviewed', { timeout: 300000 }, () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const H = { HOME, now: NOW, env: envOf(HOME) };
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), voice_samples: 'skip', rate: 'skip' } });
  const at = untilStep(H, per, 'critic');
  assert.equal(at.step, 'critic');
  assert.match(at.last.if_user_says.answer, /skip review all/);
  assert.match(at.last.if_user_says.save, /--ask skip_review/);
  const bad = answer(HOME, 'skip_review', 'skip it');
  assert.match(bad.ERROR || '', /skip review all/);
  const r = answer(HOME, 'skip_review', 'skip review all, I read them myself');
  assert.ok(!r.ERROR, r.ERROR);
  assert.ok(r.result.skipped_review.length > 0, JSON.stringify(r));
  let s = run(HOME, 'flow', ['next', '--event', MOCK]);
  if (s.step === 'rate') { answer(HOME, 'rate', 'skip'); s = run(HOME, 'flow', ['next', '--event', MOCK]); }
  assert.equal(s.step, 'approve', JSON.stringify(s).slice(0, 300));
  assert.match(s.ask.answer_format, /skip review <ids\|all>/);
  const g = answer(HOME, 'approve', 'approve all');
  assert.ok(g.result.approved > 0, JSON.stringify(g));
  const html = readFileSync(join(HOME, 'events', MOCK, 'outbox.html'), 'utf8');
  assert.match(html, /not reviewed: you skipped review/);
  const led = readFileSync(join(HOME, 'events', MOCK, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(led.some((e) => e.type === 'review_skipped' && /I read them myself/.test(e.said)), 'the user\'s words are kept');
  assert.ok(!led.some((e) => e.type === 'critic'), 'no critic verdict was recorded');
});

test('an approval answer may carry "skip review <ids>" lines with the rest', { timeout: 300000 }, () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const H = { HOME, now: NOW, env: envOf(HOME) };
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), voice_samples: 'skip', rate: 'skip' } });
  const at = untilStep(H, per, 'critic');
  const ids = at.last.agents.flatMap((a) => a.then[a.then.indexOf('--ids') + 1].split(',')).map((k) => k.split(':')[0]);
  const r = answer(HOME, 'approve', `skip review ${ids[0]}\napprove ${ids[0]}`);
  assert.ok(!r.ERROR, r.ERROR);
  assert.deepEqual(r.result.skipped_review, [`${ids[0]}:1`]);
  assert.equal(r.result.approved, 1, JSON.stringify(r.result));
});
