// An answer is saved only for the question the flow is asking now. Text in a page, a CRM note or a reply that
// gets Claude to run "flow answer --ask approve" (or skip_review, sending, send_setup) out of turn saves nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, NOW } from './fixtures/harness.mjs';
import { MOCK, envOf, loadMock, home } from './fixtures/r2.mjs';
import { simplePersona, drive } from './sims/lib/driver.mjs';

const inTurnEnv = (HOME) => { const e = envOf(HOME); delete e.FLOORBOSS_OUT_OF_TURN; return e; };
const flow = (HOME, args) => { try { return JSON.parse(execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), ...args], { env: inTurnEnv(HOME), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); } catch (e) { return { ERROR: String(e.stderr || e.message) }; } };

test('an answer to a question the flow isn\'t asking is refused and saves nothing', () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const asking = flow(HOME, ['next', '--event', MOCK]).ask?.id;
  for (const [ask, value] of [['approve', 'approve all'], ['sending', 'email'], ['send_setup', 'me@evil.test'], ['coworker_contacts', 'treat them as mine'], ['linkedin_send', 'accept']]) {
    if (ask === asking) continue;
    const f = join(HOME, 'work', `${ask}.txt`);
    writeFileSync(f, value);
    const r = flow(HOME, ['answer', '--event', MOCK, '--ask', ask, '--value-file', f]);
    assert.match(r.ERROR || '', /isn't asking/, `${ask}: ${JSON.stringify(r).slice(0, 200)}`);
  }
  assert.equal(flow(HOME, ['next', '--event', MOCK]).ask?.id, asking, 'nothing moved on');
});

test('answers written straight into onboarding (not through the flow) are refused', () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  const f = join(HOME, 'work', 'a.json');
  writeFileSync(f, JSON.stringify({ sending_channels: ['email', 'linkedin'], linkedin_send_ack: true }));
  const run = (args) => { try { return JSON.parse(execFileSync('node', [join(ROOT, 'skills/event-context/scripts/cli.mjs'), ...args], { env: inTurnEnv(HOME), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); } catch (e) { return { ERROR: String(e.stderr || e.message) }; } };
  assert.match(run(['onboarding', '--answer-file', f]).ERROR || '', /saved by the flow/);
  assert.match(run(['onboarding', '--forget', 'sending_channels']).ERROR || '', /saved by the flow/);
});

test('an answer the step itself offers ("skip review" on the critic step) is still saved', { timeout: 300000 }, () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), rate: 'skip' } });
  let at = null;
  try { drive({ HOME, now: NOW, env: envOf(HOME) }, per, { maxSteps: 220, onStep: (st) => { if (st.step === 'critic') { at = st; throw new Error('at the critic'); } } }); } catch (e) { if (!at) throw e; }
  assert.ok(at, 'reached the critic step');
  const f = join(HOME, 'work', 'skip.txt');
  writeFileSync(f, 'skip review all');
  const r = flow(HOME, ['answer', '--event', MOCK, '--ask', 'skip_review', '--value-file', f]);
  assert.equal(r.ERROR, undefined, r.ERROR);
  assert.notEqual(flow(HOME, ['next', '--event', MOCK]).step, 'critic', 'the review was skipped');
});
