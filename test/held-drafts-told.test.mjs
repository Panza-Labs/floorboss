// A draft that fails the critic twice is held for the user, and the first step after says so out loud (the
// ratings, or the approval when there are no ratings), naming it, the way stuck drafts are said.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOW } from './fixtures/harness.mjs';
import { drive, simplePersona } from './sims/lib/driver.mjs';
import { MOCK, envOf, loadMock, home } from './fixtures/r2.mjs';

function run({ ratedBefore }) {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  // No blind set this time: the ratings were answered before (so the approval is the first step after).
  if (ratedBefore) appendFileSync(join(HOME, 'events', MOCK, 'ledger.jsonl'), `${JSON.stringify({ at: '2026-10-12T07:00:00.000Z', type: 'answered', who: 'user', ask: 'rate', value: 'skipped', said: 'skip' })}\n`);
  const H = { HOME, now: NOW, env: envOf(HOME) };
  let target = null;
  const steps = [];
  const per = simplePersona({
    slug: MOCK,
    asks: { check_these: (s) => s.ask.people.map((x) => `${x.id} different-person`).join('\n'), voice_samples: 'skip' },
    judge: { critic: (batch) => (batch.drafts || batch).map((d) => { target ||= d.id; return `${d.id}:${d.touch} ${d.id === target ? 'FAIL: says the sender met them, which nothing backs' : 'PASS'}`; }).join('\n') },
  });
  drive(H, per, { maxSteps: 220, onStep: (s) => steps.push({ step: s.step, tell: s.tell_user || null }) });
  const name = JSON.parse(readFileSync(join(HOME, 'events', MOCK, 'derived', 'contacts.json'), 'utf8')).find((x) => x.id === target).name;
  return { steps, target, name };
}

test('held after two critic fails: the rating step names it; the approval step does not say it again', { timeout: 300000 }, () => {
  const { steps, target, name } = run({ ratedBefore: false });
  const rate = steps.find((x) => x.step === 'rate');
  assert.ok(rate, steps.map((x) => x.step).join(' '));
  assert.match(rate.tell || '', new RegExp(`One draft failed the critic twice, so it is held for you: ${name} \\(${target}\\): says the sender met them`));
  assert.match(rate.tell, /At approval you can edit it, drop it, or approve one by id/);
  const approve = steps.find((x) => x.step === 'approve');
  assert.doesNotMatch(approve.tell || '', /failed the critic twice/);
});

test('held after two critic fails, no ratings to ask: the approval step names it', { timeout: 300000 }, () => {
  const { steps, target, name } = run({ ratedBefore: true });
  assert.ok(!steps.some((x) => x.step === 'rate'));
  const approve = steps.find((x) => x.step === 'approve');
  assert.match(approve.tell || '', new RegExp(`held for you: ${name} \\(${target}\\)`));
});
