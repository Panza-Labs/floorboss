// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// A bare digit answer ("1", "3") to a question with choices is a numbered choice, not a number (sim run 1, 2026-11-21).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, drive, simplePersona, ROOT } from './sims/lib/driver.mjs';

const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n';
const CODEX = { CODEX_SESSION_ID: 'codex-sess', CODEX_THREAD_ID: 'codex-thread' };
function home() {
  const H = makeHome({ context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' }, attendees: LIST });
  H.env = { ...H.env, ...CODEX };
  delete H.env.CLAUDECODE;
  return H;
}
function until(H, per, stop) {
  const steps = [];
  const STOP = new Error('stop');
  let at = null;
  try {
    drive(H, per, { maxSteps: 160, onStep: (s) => { if (stop(s)) { at = s; throw STOP; } steps.push(s); } });
  } catch (e) {
    if (e !== STOP) throw e;
  }
  return { steps, at };
}
const persona = (asks) => simplePersona({ asks: { setup_level: 'standard', account_intake: 'none', ...asks } });
const ids = (steps) => steps.filter((s) => s.ask).map((s) => s.ask.id);

test('Codex: "3" for show_intake picks item 3 (a few names)', { timeout: 300000 }, () => {
  const H = home();
  const { steps, at } = until(H, persona({ show_intake: '3' }), (s) => s.ask?.id === 'intake_names');
  assert.ok(at, `names were asked: ${ids(steps).join(' ')}`);
  const ob = JSON.parse(readFileSync(join(H.HOME, 'onboarding.json'), 'utf8'));
  assert.ok(!JSON.stringify(ob.answers).includes('"show_intake":3'), JSON.stringify(ob.answers));
});

test('Codex: "1" for the send question is yes, auto-send on', { timeout: 300000 }, () => {
  const H = home();
  const { at } = until(H, persona({ show_intake: 'file', list_source: join(H.HOME, 'inputs', 'attendees.csv'), sending: '1' }), (s) => s.ask?.id === 'touches');
  assert.ok(at, 'the flow went on to touches');
  const ob = JSON.parse(readFileSync(join(H.HOME, 'onboarding.json'), 'utf8'));
  assert.notEqual(ob.answers.sending, 1);
  assert.notEqual(ob.answers.sending, '1');
  const cfg = JSON.parse(readFileSync(join(H.HOME, 'config.json'), 'utf8'));
  assert.ok(cfg.autosend || cfg.auto_send || JSON.stringify(ob.answers).match(/autosend|auto_send/), `auto-send saved: ${JSON.stringify(ob.answers)} ${JSON.stringify(cfg)}`);
});
