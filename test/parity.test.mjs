// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Claude Code parity (design note of 2026-11-21): one product in both hosts.
// 1. the touches answer wins over a saved route;
// 2. the send question is asked at every level, as a choice;
// 3. the review is in the chat (a sample and the user's own words), with no 1-to-10 rating step;
// 4. the touches question says "the show starts in N days", and handles a show already under way or over;
// 5. research is asked once;
// 6. the list question says you can type a few people.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, drive, simplePersona, ROOT } from './sims/lib/driver.mjs';
import { NODES } from '../skills/event-context/scripts/onboarding-tree.mjs';

const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Ng,Head of Ops,Initech,cy@initech.test\n';
function home(codex = false) {
  const H = makeHome({ context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' }, attendees: LIST });
  if (codex) {
    H.env = { ...H.env, CODEX_SESSION_ID: 'codex-sess', CODEX_THREAD_ID: 'codex-thread' };
    delete H.env.CLAUDECODE;
  } else H.env = { ...H.env, CLAUDECODE: '1' };
  return H;
}
function until(H, per, stop) {
  const steps = [];
  const STOP = new Error('stop');
  try {
    drive(H, per, { maxSteps: 200, onStep: (s) => { if (stop(s)) { steps.push(s); throw STOP; } steps.push(s); } });
  } catch (e) {
    if (e !== STOP) throw e;
  }
  return steps;
}
const persona = (asks = {}) =>
  simplePersona({ asks: { list_source: (s, H) => join(H.HOME, 'inputs', 'attendees.csv'), company_research: 'go', ...asks } });
const cfgOf = (H) => JSON.parse(readFileSync(join(H.HOME, 'config.json'), 'utf8'));

test('parity 1: at full setup, the touches answer wins over the route', { timeout: 300000 }, () => {
  const H = home();
  until(H, persona({ setup_level: 'full', message_route: 'email, app, linkedin, email', touches: '6' }), (s) => s.step === 'approve');
  const cfg = cfgOf(H);
  assert.equal(cfg.touches, 6);
  assert.equal((cfg.route || []).length || 6, 6, `the route has ${JSON.stringify(cfg.route)}`);
});

test('parity 2: the send question is asked at quick and standard too, as a choice', { timeout: 600000 }, () => {
  for (const level of ['quick', 'standard']) {
    const H = home();
    const steps = until(H, persona({ setup_level: level }), (s) => s.step === 'approve');
    const send = steps.find((s) => s.ask?.id === 'sending');
    assert.ok(send, `${level}: sending asked`);
    assert.ok(send.ask.choices?.length >= 2, `${level}: ${JSON.stringify(send.ask)}`);
  }
});

test('parity 3 and 5: Claude Code reviews in the chat, rates nothing 1 to 10, and starts research with a heads-up', { timeout: 300000 }, () => {
  const H = home();
  const steps = until(H, persona({ setup_level: 'standard' }), (s) => s.step === 'approve');
  assert.ok(!steps.some((s) => s.step === 'rate'), 'no 1-to-10 rating step');
  const ap = steps.find((s) => s.step === 'approve');
  assert.match(ap.run_first.join(' '), /flow\b.*\breview\b/);
  assert.ok(ap.accepts?.includes('review_feedback'));
  assert.match(ap.ask.question, /candid feedback/);
  // Research is a heads-up in both hosts, never a question.
  const research = steps.filter((s) => ['company_research', 'research_scale'].includes(s.ask?.id));
  assert.equal(research.length, 0, research.map((s) => s.ask.id).join(' '));
  assert.ok(steps.some((s) => s.step === 'company_briefs' && /Looking up/.test(s.tell_user || '')), 'the heads-up');
});

test('parity 4: the touches question says when the show starts, and handles one under way or over', () => {
  const touches = NODES.find((n) => n.id === 'touches');
  const s = (start, now) => ({ ans: { sending_asked: true }, cfg: {}, ev: { start_date: start, end_date: start, time_zone: 'UTC' }, now: new Date(now) });
  const soon = touches.ask(s('2026-11-21', '2026-11-10T09:00:00Z'));
  assert.match(soon, /the show starts in 11 days/i);
  const over = touches.ask(s('2026-11-01', '2026-11-10T09:00:00Z'));
  assert.doesNotMatch(over, /-\d+ days/);
  assert.match(over, /already (started|over)|under way/);
});

test('parity 6: the list question says a few people can be typed in', () => {
  const ls = NODES.find((n) => n.id === 'list_source');
  assert.match(ls.ask({ ans: {}, cfg: {}, ev: {} }), /type a few people/);
});
