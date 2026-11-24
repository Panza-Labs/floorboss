// A step only the user can clear (people held for a damaged record line, the approval check failing) tells the agent
// to stop and show it, never to run flow next again; it keeps the CRM-log note the done step has. A draft the critic
// hasn't read says so in a sentence with what happens next. The critic-fail count said with a held draft counts what
// the hold counts (a rewrite saved back as the very text that failed is another fail).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, rmSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, NOW } from './fixtures/harness.mjs';
import { drive, simplePersona } from './sims/lib/driver.mjs';
import { MOCK, envOf, loadMock, home } from './fixtures/r2.mjs';

const SEND = { server: 'gmail', tool: 'send_message', args: { to: '{to}', subject: '{subject}', body: '{body}', threadId: '{thread_id}' }, reading: 'the id and threadId it returns', tool_hash: 'b'.repeat(64), test_draft: { draft_id: 'm-test', user_confirmed: true } };
let STATE = null;
// The mock event with whole sequences, at its first approval, unanswered.
function state() {
  if (STATE) return STATE;
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true, sending: { channels: ['email'], followups: 'scheduled' }, connectors: { 'email.send': SEND } }));
  loadMock(HOME);
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), voice_samples: 'skip', rate: 'skip' } });
  try {
    drive({ HOME, now: NOW, env: envOf(HOME) }, per, { maxSteps: 200, onStep: (s) => { if (s.step === 'approve') throw Object.assign(new Error('at the approval'), { stop: true }); } });
  } catch (e) {
    if (!e.stop) throw e;
  }
  STATE = HOME;
  return HOME;
}
const copy = () => {
  const H = mkdtempSync(join(tmpdir(), 'fb-stop-'));
  cpSync(state(), H, { recursive: true });
  return H;
};
const next = (H, extra = {}) => {
  const env = envOf(H, extra);
  delete env.FLOORBOSS_OUT_OF_TURN;
  return JSON.parse(execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'next', '--event', MOCK], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
};
const toldToStop = (s) => {
  assert.equal(s.stop, true, JSON.stringify(s).slice(0, 300));
  assert.doesNotMatch(String(s.loop || ''), /run flow next again/i, s.loop);
  assert.match(String(s.loop || ''), /^Stop here/);
};

test('a damaged record line: three runs in a row each tell the agent to stop and show the user, never to loop', { timeout: 600000 }, () => {
  const H = copy();
  try {
    appendFileSync(join(H, 'events', MOCK, 'ledger.jsonl'), '{"type":"stop","at":"2026-10-12T08:00:00.000Z","who":"user","id":\n');
    for (let i = 0; i < 3; i++) {
      const s = next(H);
      assert.equal(s.step, 'waiting');
      toldToStop(s);
      assert.match(s.tell_user, /ledger is damaged/);
    }
  } finally {
    rmSync(H, { recursive: true, force: true });
  }
});

test('the approval check failing tells the agent to stop and show the user', { timeout: 600000 }, () => {
  const H = copy();
  try {
    const s = next(H, { FLOORBOSS_FAIL_APPROVABLE: 'error' });
    assert.equal(s.step, 'waiting');
    toldToStop(s);
  } finally {
    rmSync(H, { recursive: true, force: true });
  }
});

test('the end of a run with people held keeps the CRM-log note the done step has', async () => {
  const { endStep } = await import('../skills/flow/scripts/steps/sending.mjs');
  const notLogged = { not_in_crm: ['Ana Berg (Acme)'], not_in_crm_note: 'Not in your CRM, so nothing was logged for them.' };
  const held = endStep({ heldMustNote: { tell_user: 'Ana Berg (c001) is held …', held_problem: true }, pickNote: {}, summary: {}, notLogged });
  assert.equal(held.step, 'waiting');
  assert.equal(held.stop, true);
  assert.deepEqual(held.crm_not_logged, notLogged.not_in_crm);
  assert.equal(held.crm_not_logged_note, notLogged.not_in_crm_note);
  const done = endStep({ heldMustNote: {}, pickNote: {}, summary: {}, notLogged });
  assert.equal(done.step, 'done');
  assert.deepEqual(done.crm_not_logged, notLogged.not_in_crm);
});

test('a draft the critic has not read: one plain sentence with what happens next', async () => {
  const { heldLines } = await import('../skills/flow/scripts/steps/approval.mjs');
  const refused = [{ id: 'c004', touch: 1, kind: 'message', reason: "its sequence isn't ready: follow-up 1 the critic hasn't read it", cause: 'unread', blocking: 'c004:2', blocking_kind: 'message', why: "the critic hasn't read it" }];
  const [line] = heldLines({ refused, offered: [], candidates: ['c004:1'], nameOf: () => 'Dee Ho', whole: true }).lines;
  assert.equal(line, "Dee Ho (c004) is held until the critic has read follow-up 1 (c004:2): floorboss sends it to the critic on its next run.");
});

test('the critic-fail count said with a held draft counts a rewrite saved back as the very text that failed', async () => {
  const { failCounts } = await import('../skills/flow/scripts/steps/counts.mjs');
  const e = (type, o = {}) => ({ type, id: 'c002', touch: 1, ...o });
  // One FAIL, then the same text saved back: the hold counts two (criticFails), so the line says two.
  assert.equal(failCounts([e('drafted', { hash: 'h1' }), e('critic', { hash: 'h1', verdict: 'FAIL' }), e('drafted', { hash: 'h1' })], 'c002', 1), '2 critic fails');
  // A real rewrite, then its FAIL: two as well; a FAIL read again with no save between is one.
  assert.equal(failCounts([e('drafted', { hash: 'h1' }), e('critic', { hash: 'h1', verdict: 'FAIL' }), e('drafted', { hash: 'h2' }), e('critic', { hash: 'h2', verdict: 'FAIL' })], 'c002', 1), '2 critic fails');
  assert.equal(failCounts([e('drafted', { hash: 'h1' }), e('critic', { hash: 'h1', verdict: 'FAIL' }), e('critic', { hash: 'h1', verdict: 'FAIL' })], 'c002', 1), '1 critic fail');
});
